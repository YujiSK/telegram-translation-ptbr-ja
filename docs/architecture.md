# Architecture

Status: **Foundation, domain, D1 repository layer, the Telegram webhook
boundary, and OpenAI translation are implemented (Phase 4 complete).**
`POST /telegram/webhook` verifies the Secret header, parses the Update,
gates on the allowlist/dedupe tables, calls OpenAI exactly once per
message via `src/infrastructure/openai/translate.ts`, and — on a
`translated` outcome — posts the reply via
`src/infrastructure/telegram/send-message.ts`. See
`src/handlers/telegram-webhook.ts` and `src/application/translate-and-reply.ts`.
Every OpenAI/Telegram call in tests is mocked; no real OpenAI API call has
been made. No Telegram bot has been created, no Secret is registered, no
webhook is registered with Telegram, and the Worker is not deployed —
those four actions are deferred to Phase 8. See
`docs/implementation-plan.md` for phasing.

## Request flow (target design)

```text
Telegram group message
        │
        ▼
Telegram Bot API ── webhook POST ──▶ Cloudflare Worker (handlers/)
        │                                   │
        │                                   ├─▶ infrastructure/d1 (D1, binding "DB")
        │                                   │     - allowlist check
        │                                   │     - speaker profile / preferences / corrections lookup
        │                                   │     - processed-update-id check (dedupe)
        │                                   │
        │                                   ├─▶ infrastructure/openai (OpenAI API)
        │                                   │     - one request: language detection +
        │                                   │       translation + low-risk style-feature
        │                                   │       extraction
        │                                   │
        │                                   └─▶ infrastructure/telegram (Telegram Bot API)
        │                                         - post translation as a reply to the
        │                                           original message
        ▼
Telegram group (translation posted as a reply)
```

Everything else (commands, admin actions) follows the same shape: Telegram
webhook in, `handlers/` dispatches, `application/` orchestrates
`infrastructure/*`, response goes back out over the Telegram Bot API.

## Key design constraints

- **One OpenAI request per translated message.** Language detection,
  translation, and low-risk style-feature extraction happen in a single
  Structured Outputs request — not three separate calls.
- **Reply context is exactly one message.** If the source message is a
  reply, only the single message it replies to may be used as translation
  context. No broader thread or history is fetched or sent to OpenAI.
- **Untargeted languages are not translated.** For every candidate text
  message, the bot calls OpenAI exactly once — that single call performs
  both language detection and translation together (see the point above;
  there is no separate detection-only call). If the detected language is
  neither Japanese nor Brazilian Portuguese, no translation reply is
  posted to Telegram (see `docs/implementation-plan.md` Phase 4 for exact
  detection/skip rules).
- **No conversation history is persisted.** D1 stores speaker metadata and
  ID mappings (see `docs/data-model.md`), never message bodies. Reply
  context is read from the live Telegram API at request time, not from
  storage.
- **Single OpenAI model:** `gpt-4o-mini`, called via the Responses API
  with Structured Outputs (see `docs/implementation-plan.md` Phase 4).

## External dependency boundaries

| Boundary                   | Owns                                                                             | Never does                              |
| -------------------------- | -------------------------------------------------------------------------------- | --------------------------------------- |
| `infrastructure/telegram/` | Webhook payload parsing, Bot API calls (send/reply), text extraction             | Business logic, D1 access, OpenAI calls |
| `infrastructure/openai/`   | Prompt construction, Structured Outputs request/response handling, timeout/retry | Persisting anything, Telegram calls     |
| `infrastructure/d1/`       | All SQL, parameterized queries, D1 result → domain-type conversion               | Talking to Telegram or OpenAI           |

`domain/` and `application/` never import from `infrastructure/*` clients
directly in a way that leaks vendor types — see `docs/project-rules.md`
rule 2.

## Error-time behavior

- A webhook request that fails Secret verification is rejected (401)
  before any body read, JSON parse, or D1 access (see
  `docs/security-and-privacy.md`).
- A message from a non-allowlisted chat is ignored (200, no OpenAI call,
  no reply, no dedupe write).
- A duplicate Telegram `update_id` is ignored (200 `ignored:duplicate`,
  no OpenAI/Telegram call).
- A message longer than `MAX_TRANSLATABLE_MESSAGE_LENGTH` is skipped
  (200 `ignored:too-long`) before any OpenAI call — the ceiling exists to
  bound OpenAI cost/latency, not to reject the update.
- An OpenAI-detected "other" (untargeted) language is a normal, expected
  outcome (200 `ignored:untargeted-language`), not an error — no Telegram
  reply is posted.
- If OpenAI fails after its limited retry budget (transient errors
  only — network failure, timeout, 429, 5xx; `DEFAULT_OPENAI_MAX_ATTEMPTS`
  attempts total, see `src/infrastructure/openai/client.ts`), the webhook
  responds 500 and the bot never posts a partial or garbled translation.
  See "Dedupe and retry after a transient failure" below for what happens
  to the `update_id` in this case.
- A malformed or schema-invalid OpenAI response (JSON parse failure, a
  Structured Output that fails the JSON Schema, or one that fails the
  cross-field logical-consistency check in
  `src/infrastructure/openai/translate.ts` — e.g. a `targetLanguage` that
  doesn't match `detectedLanguage`) is a **permanent** failure and is
  never retried, per `docs/project-rules.md` rule 7. The webhook responds
  500; the bot never posts an unvalidated or partially-parsed
  translation. Because it's permanent, the dedupe reservation is kept
  (not released) — see below — so a Telegram redelivery of the same
  update does not repeat the same doomed OpenAI call forever. This is the
  project's anti-infinite-retry design for a permanently malformed
  response: it fails once, visibly (500, no reply), and then goes quiet
  on redelivery instead of retrying indefinitely.
- A Telegram `sendMessage` failure is never treated as success, even when
  OpenAI's translation already succeeded — the webhook still responds 500. A **permanent** Telegram failure (e.g. chat not found) keeps the
  dedupe reservation, so a redelivery is a harmless `ignored:duplicate`
  and OpenAI is not billed a second time for a reply that could never
  have been delivered anyway. A **transient** Telegram failure (429/5xx)
  releases the dedupe reservation instead, so a redelivery retries the
  whole translate-and-reply flow — this accepts a small
  duplicate-reply risk (if the original `sendMessage` actually succeeded
  server-side but the success response was lost before the Worker could
  observe it) in exchange for not silently dropping a message whose
  translation was never actually delivered. Phase 7 may revisit this
  trade-off with a stronger idempotency mechanism.
- If D1 is unavailable, the request fails safe (500): no translation is
  posted with stale/guessed speaker settings silently substituted for
  explicit ones.
- The bot never automatically posts an error-explanation message to the
  family group for any of the failures above — a failure is visible only
  as an absent reply plus a 500 response to Telegram (and, once Phase 7
  adds structured logging, an operator-visible log entry without message
  text).

## Dedupe and retry after a transient failure

`processed_updates` (see `docs/data-model.md`) records an `update_id`
**before** the OpenAI/Telegram work runs, so that two concurrent
deliveries of the same update can't both start processing it. This
creates a tension: if the OpenAI/Telegram work then fails, a bare "always
keep the reservation" policy would make Telegram's automatic redelivery
useless — the redelivery would be classified as a duplicate and dropped,
even though nothing was ever actually sent.

Phase 4 resolves this with a **reservation-and-release** policy,
requiring no schema change:

- `recordUpdateIfNew` (unchanged since Phase 2) atomically reserves the
  `update_id` via `INSERT OR IGNORE`.
- `releaseProcessedUpdate` (new in Phase 4,
  `src/infrastructure/d1/processed-updates.ts`) removes that reservation
  via a parameterized `DELETE ... WHERE update_id = ?1`.
- The webhook handler calls `releaseProcessedUpdate` **only** when the
  translate-and-reply flow throws a `TransientUpstreamError` — network
  failure, timeout, OpenAI 429/5xx after retries are exhausted, or a
  transient Telegram failure. A `PermanentUpstreamError` (malformed
  OpenAI response, a permanent Telegram rejection) or a configuration
  failure never releases the reservation.
- The release itself is best-effort: if the `DELETE` also fails, the
  webhook still responds 500 (the request already failed regardless), it
  just cannot guarantee the redelivery will be retry-able.

Net effect: a transient failure keeps Telegram's redelivery useful (the
second delivery is processed as if it were the first), while a permanent
failure bounds retries to exactly one doomed attempt instead of an
unbounded loop. This is an interim design scoped to Phase 4's existing
schema; Phase 7 ("Reliability and security") is expected to revisit
concurrency correctness under real load more rigorously (e.g. a
reservation TTL/lease instead of a release-on-error signal).

## What this Worker does _not_ do (see `docs/implementation-plan.md`)

Voice transcription, image OCR, sticker translation, video, full
conversation history, RAG/vector search, a web admin UI, multi-tenant SaaS
support. See the project brief and implementation plan for the full
out-of-scope list.
