# Architecture

Status: **Foundation, domain, D1 repository layer, and the Telegram webhook
boundary are implemented (Phase 3 complete).** `POST /telegram/webhook`
verifies the Secret header, parses the Update, and gates on the
allowlist/dedupe tables — see `src/handlers/telegram-webhook.ts`. A
mockable `sendMessage` client exists
(`src/infrastructure/telegram/send-message.ts`) but nothing calls it yet: no
reply is posted, no translation happens (that's Phase 4). No Telegram bot
has been created, no Secret is registered, no webhook is registered with
Telegram, and the Worker is not deployed — those four actions are deferred
to Phase 8, not Phase 3. See `docs/implementation-plan.md` for phasing.

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

## Error-time behavior (baseline)

These are the Phase 0 baseline expectations; later phases will make them
concrete in code.

- A webhook request that fails Secret verification is rejected before any
  processing (see `docs/security-and-privacy.md`).
- A message from a non-allowlisted chat is ignored (no OpenAI call, no
  reply).
- A duplicate Telegram `update_id` is ignored (no duplicate translation
  posted).
- If OpenAI fails after its limited retry budget (transient errors
  only — network failure, 429, 5xx), the bot does not post a partial or
  garbled translation — it fails silently from the group's perspective,
  and the failure is logged (without message text) for operator
  visibility. Exact behavior (e.g., an optional low-noise error reply) is
  decided in Phase 4/7, not here.
- A malformed or schema-invalid OpenAI response (JSON parse failure, or
  Structured Output that doesn't match the schema) is a permanent
  failure and is never retried, per `docs/project-rules.md` rule 7 — the
  bot never posts an unvalidated or partially-parsed translation.
- If D1 is unavailable, the request fails safe: no translation is posted
  with stale/guessed speaker settings silently substituted for explicit
  ones.

## What this Worker does _not_ do (see `docs/implementation-plan.md`)

Voice transcription, image OCR, sticker translation, video, full
conversation history, RAG/vector search, a web admin UI, multi-tenant SaaS
support. See the project brief and implementation plan for the full
out-of-scope list.
