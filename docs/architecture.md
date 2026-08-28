# Architecture

Status: **Foundation, domain, D1 repository layer, the Telegram webhook
boundary, OpenAI translation, speaker memory, the command surface,
reliability/security hardening, Phase 8A deployment-preparation tooling,
a vendor-independent translation-provider router with a Cloudflare
Workers AI routine adapter (Phase 9.1A, now the default provider), and a
Gemini semantic-escalation adapter (Phase 9.1B) are implemented — all
locally/in CI only, not deployed; Gemini escalation is additionally
disabled by default (`GEMINI_ESCALATION_ENABLED=false`) even once
deployed.** See "Translation provider router (Phase 9.1A / Phase 9.1B)"
below for the router/adapter design; the rest of this document (written
before Phase 9.1A) still describes the underlying webhook/D1/command
architecture accurately, with "OpenAI" in the sections below now
specifically meaning the legacy `TRANSLATION_PROVIDER=openai` path unless
otherwise noted. `POST /telegram/webhook` verifies the
Secret header, parses the Update, detects a command (if any), gates on
the allowed-chat state and dedupe tables, applies the per-chat inbound
rate limit (see "Rate limiting and usage ceilings" below), and then
routes to one of two completely separate paths:

- **Command path** (Phase 6): reads speaker memory only for `/status`
  and `/profile`'s own display (never for a translation), mutates
  `speaker_preferences`/`translation_corrections`/`speaker_profiles`/
  `allowed_chats` as needed, and replies via
  `src/infrastructure/telegram/send-message.ts` — **never** calls
  OpenAI. See `src/commands/`, `src/application/execute-command.ts`, and
  "Command routing and chat state" below.
- **Translation path** (Phase 4/5, ordinary text only): reads speaker
  memory (`src/domain/speaker-memory.ts`,
  `src/infrastructure/d1/{speaker-profiles,speaker-preferences,translation-corrections}.ts`),
  calls OpenAI exactly once per message via
  `src/infrastructure/openai/translate.ts` (prompt built by
  `src/prompts/translation-v2.ts`), and — on a `translated` outcome —
  posts the reply and best-effort records the observed style. See
  `src/application/translate-and-reply.ts`.

Both paths are orchestrated from `src/handlers/telegram-webhook.ts`. A
third, completely separate endpoint — `POST /admin/bootstrap` — exists
for production setup only; see "Bootstrap endpoint" below. Every
OpenAI/Telegram call in tests is mocked; no real OpenAI/Telegram API call
has been made, and the Phase 5, Phase 6, and Phase 7 D1 migrations
(`migrations/0002_speaker_memory.sql`, `migrations/0003_commands.sql`,
`migrations/0004_reliability.sql`) have each been applied and tested only
locally, not against the remote database. No Telegram bot has been
created, no Secret is registered, no webhook is registered with
Telegram, and the Worker is not deployed — those four actions, plus the
remote migrations and the production admin/chat bootstrap itself, are
deferred to Phase 8B, each requiring its own separate explicit approval
(see docs/operations.md, "External action approval matrix"). See
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
        │                                   │     - processed-update-id check (dedupe)
        │                                   │     - speaker profile / preferences / corrections
        │                                   │       lookup (speaker memory read)
        │                                   │
        │                                   ├─▶ infrastructure/openai (OpenAI API)
        │                                   │     - one request: language detection +
        │                                   │       translation + low-risk style-feature
        │                                   │       extraction, informed by the speaker
        │                                   │       memory read above
        │                                   │
        │                                   ├─▶ infrastructure/telegram (Telegram Bot API)
        │                                   │     - post translation as a reply to the
        │                                   │       original message
        │                                   │
        │                                   └─▶ infrastructure/d1 (D1, binding "DB")
        │                                         - best-effort observed-style write
        │                                           (speaker memory write, after a
        │                                           successful reply only)
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
- **Speaker memory never adds a second OpenAI call.** Memory is read
  once, before the single translation call, and folded into that same
  call's prompt as a soft hint (style) or term data (corrections) — see
  `docs/implementation-plan.md` Phase 5. The style signals observed
  _from_ that same call's response are what gets written back afterward,
  not a separately-requested observation.
- **Explicit preference always outranks observed style, per axis.**
  `src/domain/speaker-memory.ts`'s `resolveEffectiveSpeakerMemory`
  resolves `tone` and `emojiUsage` independently — an explicit `tone`
  does not affect whether `emojiUsage` falls back to the observed value,
  and vice versa. Term corrections are a separate axis entirely, applied
  only when a correction's exact source term appears in the current
  message and its stated direction matches the language direction OpenAI
  determines — never based on style priority.
- **Speaker memory is scoped strictly to `(chat_id, user_id)`.** Never
  merged or shared across chats or users, and never inferred from a
  Telegram-wide profile — see `docs/data-model.md`.
- **Prompt v2 tone priority, unambiguous:** `src/prompts/translation-v2.ts`
  states this order explicitly, highest first: (1) accuracy and safety
  for the current message; (2) the message's own clearly expressed tone
  and communicative purpose — never overridden; (3) the speaker's
  resolved style preference (already explicit-over-observed — the prompt
  never sees two competing values, only the one
  `resolveEffectiveSpeakerMemory` already picked), used only to choose
  among multiple equally accurate, equally natural renderings; (4) a
  natural, everyday default for a private family chat, absent any
  preference. Earlier prompt text no longer hardcodes "always translate
  casually" — that instruction made an explicit `formal` preference
  structurally impossible to honor (Phase 5 review, Issue 2).
  `translation-v1.ts` is unchanged and still reflects the pre-Phase-5
  design.
- **A command message never invokes OpenAI.** `/help`, `/status`,
  `/profile`, `/remember`, `/forget`, `/forgetme`, `/correct`,
  `/enable`, and `/disable` are handled entirely by
  `src/application/execute-command.ts`, which has no OpenAI import and
  is never given an OpenAI boundary — see "Command routing and chat
  state" below. Command text is never sent to OpenAI as content to
  translate or as instructions.

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
  translation was never actually delivered. Phase 7 kept this trade-off
  as-is (out of the 5-pillar scope); a future phase may revisit it with a
  stronger idempotency mechanism.
- If D1 is unavailable, the request fails safe (500): no translation is
  posted with stale/guessed speaker settings silently substituted for
  explicit ones. This includes a speaker-memory read failure: the
  webhook never proceeds to the OpenAI/Telegram call in that case. A
  **transient** D1 query/runtime failure (network hiccup, D1 outage,
  timeout) during the read releases the dedupe reservation, exactly like
  a transient OpenAI/Telegram failure, so a Telegram redelivery is
  retried rather than misclassified as a duplicate; a **permanent**
  failure — a malformed/data-corrupted row — keeps the reservation. See
  "Speaker memory read/write ordering" below.
- A speaker-memory **write** failure, after the Telegram reply already
  succeeded, is never treated as a request failure — the webhook still
  responds 200 `translated`, and the dedupe reservation is kept (not
  released), so Telegram never redelivers an update whose translation
  was already sent. See "Speaker memory read/write ordering" below.
- The bot never automatically posts an error-explanation message to the
  family group for any of the failures above — a failure is visible only
  as an absent reply plus a 500 response to Telegram, and (Phase 7) a
  single structured, field-allowlisted log entry with no message text or
  Secrets — see "Rate limiting and usage ceilings" and "Structured
  logging" below.
- **A per-chat inbound rate limit or an OpenAI usage limit is a safe,
  expected outcome, not an error.** Exceeding either responds 200 (never 500) and keeps the dedupe reservation, so a Telegram redelivery of the
  same update is processed as a plain `ignored:duplicate` instead of
  repeating the blocked work. See "Rate limiting and usage ceilings"
  below.

## Speaker memory read/write ordering

Speaker memory (Phase 5) is read once, before the OpenAI call, and
written back best-effort, after the Telegram reply — see
`src/application/translate-and-reply.ts`:

1. **Read** (`getSpeakerProfile`, `getSpeakerPreferences`,
   `listTranslationCorrections`, resolved by
   `resolveEffectiveSpeakerMemory`): a failure here propagates — the
   webhook responds 500 and never calls OpenAI or Telegram for this
   update. This is the same "fail safe, no guessed substitution" policy
   as any other D1 failure. These three repository functions classify
   the failure before it reaches the webhook (`runD1Query` in
   `src/infrastructure/d1/row-validation.ts`): a raw query/runtime
   failure (the D1 binding itself throwing — network hiccup, outage,
   timeout) becomes a `TransientUpstreamError`, so the webhook's existing
   `error instanceof TransientUpstreamError` check releases the dedupe
   reservation exactly as it already does for a transient OpenAI/Telegram
   failure — see "Dedupe and retry after a transient failure" below. A
   malformed row (data that fails the row parser's own validation —
   `invalidD1Row`) stays a `PermanentUpstreamError`, thrown _after_
   `runD1Query` returns successfully, so the reservation is kept: a real
   `CHECK`-constrained row can never actually be malformed, so this path
   only exists as defense against future schema drift or direct D1
   tampering, and there is no reason to expect a redelivery would ever
   succeed against it.
2. **Translate** and **reply**: unchanged from Phase 4 — a failure in
   either propagates and is never treated as success.
3. **Write** (`upsertObservedSpeakerStyle`, only when the outcome is
   `translated` and carries `styleSignals`): wrapped in a best-effort
   `try`/`catch` inside `translateAndReply` itself, so a write failure
   **never** propagates out of the use case. The webhook still responds
   200, and — critically — the dedupe reservation is **not** released for
   this failure (unlike a transient OpenAI/Telegram failure): the reply
   was already sent, so releasing the reservation would let a Telegram
   redelivery send a **second** reply for the same update. A lost
   observed-style update is an acceptable, low-severity outcome (the next
   message from the same speaker will simply be missing one style
   observation); a duplicate reply to the family group is not.

## Command routing and chat state

Phase 6 adds command detection to the webhook's early routing, before
any dedupe write:

1. `parseCommandMessage` (`src/commands/parse-command.ts`) is a pure,
   in-memory parse of `update.text` — no D1 access. It returns
   `not-a-command` (route to the translation path below),
   `unknown-command`, `usage-error`, or `parsed` (a typed `ParsedCommand`).
   Both `/status` and `/status@SomeBotName` parse identically — the `@`
   suffix is stripped without checking it against a specific bot
   username, since the Worker has no way to know its own username
   without an extra Telegram API call. `/help`, `/status`, `/profile`,
   `/enable`, and `/disable` take no arguments — a trailing argument
   (e.g. `/status extra`, `/enable garbage`) is a `usage-error`, never a
   `parsed` command with the extra text silently ignored (Phase 6
   review, Issue 2). This matters beyond input hygiene: it's what keeps
   `/enable garbage` out of the disabled-chat exception in step 2 below,
   since that exception checks specifically for a `parsed` `/enable`.
2. **Allowed-chat state** (`getAllowedChatState` in
   `src/infrastructure/d1/allowed-chats.ts`) resolves to `missing`,
   `disabled`, or `enabled` — a three-state read, unlike the older
   `isChatAllowed` (kept for backward compatibility), which collapses
   `missing` and `disabled` into a single `false`. The state and the
   parsed command together decide what happens next:
   - `missing`: always `ignored:not-allowlisted` — no command, including
     `/enable`, can self-allowlist an unknown chat. Initial allowlist
     provisioning stays a Phase 8 action.
   - `disabled` and the parsed command is **not** `/enable`: also
     `ignored:not-allowlisted` — this applies equally to ordinary text
     and to any other command (`/status`, `/help`, ...), matching the
     pre-Phase-6 behavior for plain text from a disabled chat.
   - `disabled` and the parsed command **is** `/enable` — specifically a
     `parsed` command of kind `enable`, never a `usage-error` (see step 1
     above): the one exception — routing continues to the dedupe
     reservation and then the command path, where admin authorization
     decides whether the chat actually gets re-enabled. `/enable garbage`
     is a `usage-error`, so it takes the same `ignored:not-allowlisted`
     path as any other disabled-chat message — no admin lookup, no D1
     mutation, no Telegram reply, no dedupe reservation (Phase 6 review,
     Issue 2).
   - `enabled`: routing continues normally for both commands and
     ordinary text.
3. **Dedupe reservation** (`recordUpdateIfNew`) happens after the
   allowed-chat check, exactly as it already did pre-Phase-6 — a
   redelivered command update_id is dropped as `ignored:duplicate`
   before any mutation or reply is repeated.
4. **Command execution** (`src/application/execute-command.ts`, boundary
   -injected like `translateAndReply`) never imports or calls anything
   OpenAI-related, and never validates `OPENAI_API_KEY` — only
   `TELEGRAM_BOT_TOKEN` is required, since every command path ends in a
   Telegram reply. `/enable` and `/disable` call
   `src/infrastructure/d1/bot-admins.ts`'s `isBotAdmin` before mutating
   `allowed_chats` (`setAllowedChatEnabled`); every other caller gets a
   generic "This command is restricted to bot admins." reply with no
   detail about the authorization mechanism. See
   docs/security-and-privacy.md, "Admin command authorization", for why
   this table — not `SETUP_ADMIN_SECRET` — is the runtime authority.

### Command D1 error classification and dedupe

Every D1 call reachable from a command (`getSpeakerProfile`,
`getSpeakerPreferences`, `countTranslationCorrections`, `isBotAdmin`,
`upsertSpeakerPreference`, `deleteSpeakerPreference`,
`upsertTranslationCorrection`, `deleteTranslationCorrection`,
`forgetSpeakerData`, `setAllowedChatEnabled`) is wrapped in the same
`runD1Query` helper Phase 5 introduced for speaker-memory reads: a raw
D1 query/runtime failure becomes a `TransientUpstreamError` (releases
the dedupe reservation, so a redelivery retries the command), and a
malformed row stays a `PermanentUpstreamError` (keeps the reservation).
`forgetSpeakerData` (`src/infrastructure/d1/forget-me.ts`) additionally
uses `db.batch()` for `/forgetme confirm`'s three-table delete — per
[Cloudflare's D1 documentation](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch),
a batch is a single SQL transaction that rolls back entirely if any
statement fails, so the delete is genuinely all-or-nothing, not
best-effort per table.

Every command mutation is idempotent by design — `/remember` and
`/correct` upsert, `/forget`/`/forgetme confirm` delete-if-exists, and
`/enable`/`/disable` set an absolute boolean — so a Telegram redelivery
after a released reservation can safely repeat the mutation (and the
reply) without a different outcome than the first attempt.

**`/disable` reply-failure dedupe exception (Phase 6 review, Issue 1):**
the paragraph above — "a transient reply failure after a successful
mutation releases the reservation" — holds for every command **except**
`/disable`. Once `setChatEnabled(..., false)` succeeds, the chat is
disabled, and step 2 above then drops every further update for that chat
except a valid `parsed` `/enable`. A Telegram redelivery of _this same_
`/disable` update could therefore never reach the command path again to
retry the confirmation reply — releasing the reservation would strand it,
not make it retryable. `src/application/execute-command.ts`'s `disable`
branch (not `enable`, which has no such problem — a redelivery after a
successful _enable_ still routes normally, since the chat stays reachable)
catches a `TransientUpstreamError` thrown by the reply boundary **after**
the mutation has already succeeded, and rethrows it as a
`PermanentUpstreamError` with the same message and service, so the
webhook's `error instanceof TransientUpstreamError` check keeps the
reservation instead of releasing it. A transient failure in the `/disable`
_mutation itself_ (before the reply is attempted, or for a
non-admin-denied `/disable`) is unaffected and still releases normally,
per the general rule above — nothing irreversible has happened yet at
that point. A _permanent_ Telegram failure after a successful `/disable`
already kept the reservation before this change and is unaffected.

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
  translate-and-reply flow (or, Phase 6, the execute-command flow)
  throws a `TransientUpstreamError` — network failure, timeout, OpenAI
  429/5xx after retries are exhausted, a transient Telegram failure, a
  transient D1 failure while reading speaker memory (Phase 5, see
  "Speaker memory read/write ordering" above), or (Phase 6) a transient
  D1 failure during a command's read or mutation (see "Command D1 error
  classification and dedupe" above). A `PermanentUpstreamError`
  (malformed OpenAI response, a permanent Telegram rejection, a
  malformed speaker-memory or command-data row, or — Phase 6 review,
  Issue 1 — a Telegram reply failure after `/disable`'s mutation already
  succeeded, deliberately reclassified from transient to permanent, see
  "Command routing and chat state" above) or a configuration failure
  never releases the reservation.
- The release itself is best-effort: if the `DELETE` also fails, the
  webhook still responds 500 (the request already failed regardless), it
  just cannot guarantee the redelivery will be retry-able.

Net effect: a transient failure keeps Telegram's redelivery useful (the
second delivery is processed as if it were the first), while a permanent
failure bounds retries to exactly one doomed attempt instead of an
unbounded loop. This is an interim design scoped to Phase 4's existing
schema.

### Concurrent dedupe correctness (Phase 7)

`recordUpdateIfNew`'s atomicity — the property that exactly one of
several _simultaneous_ deliveries of the same `update_id` succeeds — was
designed in Phase 2 but not exercised under genuine concurrency until
Phase 7. `test/infrastructure/d1/repositories.test.ts` fires several
`recordUpdateIfNew` calls for the same `update_id` via `Promise.all` and
asserts exactly one `true`, the rest `false`, and exactly one resulting
row; a second test does the same for distinct `update_id`s and expects
every reservation to succeed independently. This is treated as the
authoritative concurrency check — a webhook-level end-to-end concurrency
test was considered but not added, since the test runtime does not
reliably reproduce genuinely simultaneous request handling at that
layer; the repository-level `Promise.all` test exercises the same D1
`INSERT`-with-`PRIMARY KEY`-conflict mechanism the webhook actually
depends on. No application-side mutex or in-memory lock is used
anywhere in this project — a module-global lock would not work across
Cloudflare's isolate model (concurrent requests can be handled by
different isolates with no shared memory), so D1's own atomic write is
the only correctness mechanism, unchanged in design from Phase 2.

## Rate limiting and usage ceilings (Phase 7)

Implemented entirely on the existing D1 `DB` binding — no new Cloudflare
Rate Limiting binding or other remote service this phase (a future
migration to Cloudflare-native Rate Limiting may be worth considering
once real usage data exists, but nothing about this design requires it).
Three independent, non-secret `wrangler.jsonc` vars, validated by
`validateReliabilityConfig()` (`src/config/reliability-config.ts`, kept
separate from `validateAppConfig()` so the command path still never
depends on OpenAI translation config — see "A command message never
invokes OpenAI" above):

| Var                                       | Default | Scope                                    |
| ----------------------------------------- | ------- | ---------------------------------------- |
| `MAX_HANDLED_UPDATES_PER_CHAT_PER_MINUTE` | 60      | Per allowlisted chat, per UTC minute     |
| `MAX_OPENAI_ATTEMPTS_PER_CHAT_PER_MINUTE` | 20      | Per chat, per UTC minute                 |
| `MAX_OPENAI_ATTEMPTS_PER_DAY`             | 300     | Global (all chats combined), per UTC day |

**Per-chat inbound handled-update limit.** Checked in
`src/handlers/telegram-webhook.ts` immediately **after** the dedupe
reservation and before the command/translation branch, so it applies
equally to commands and ordinary text, and — critically — a Telegram
redelivery of an already-reserved `update_id` never consumes the counter
a second time (dedupe always runs first). Backed by
`consumeChatHandledUpdateLimit`
(`src/infrastructure/d1/reliability-counters.ts`), scope `chat_updates`.
Exceeding it: HTTP 200, outcome `ignored:rate-limited`, dedupe
reservation **kept**, no command execution, no Telegram reply, no
speaker-memory read, no OpenAI call.

**Per-chat OpenAI attempt burst limit and the global daily OpenAI
ceiling.** Both count real OpenAI HTTP attempts — including the OpenAI
client's own internal transient-failure retries (`DEFAULT_OPENAI_MAX_ATTEMPTS`,
see `src/infrastructure/openai/client.ts`) — not logical translation
requests, since one logical translation can cost up to
`DEFAULT_OPENAI_MAX_ATTEMPTS` real attempts. `OpenAiApiCallOptions` gained
an optional `beforeAttempt(): Promise<void>` boundary, called at the top
of `callOpenAiResponses`'s retry loop immediately before **every**
attempt (not once per logical call), deliberately **outside** the
try/catch that classifies transient failures — so a budget rejection
propagates immediately, is never retried, and is never reclassified as a
transient upstream error. `infrastructure/openai/` never imports D1
directly (see "External dependency boundaries" above); the webhook
builds the actual guard as a closure capturing `chatId` and passes it in:

```
reserveOpenAiAttempt = async () => {
  chat-minute reserve (consumeChatOpenAiAttemptLimit, scope "chat_openai")
    → denied? throw RateLimitExceededError, skip the daily reserve entirely
  daily reserve (consumeDailyOpenAiAttemptLimit, singleton table)
    → denied? throw UsageLimitExceededError
  → both passed: return, and callOpenAiResponses proceeds to fetch
}
```

The ordering is deliberately asymmetric: the daily counter is only ever
incremented for an attempt that already passed its chat-minute check, so
an attempt blocked by the daily ceiling still costs the chat one unit of
its per-minute budget (counted as "the chat tried"), but the daily
counter never grows for an attempt that was already going to be blocked
for an unrelated reason. Worked retry example: attempt #1 reserves both
budgets, fetches, gets a transient 503; the retry loop's attempt #2 calls
`beforeAttempt` again — if the daily budget was exhausted in between (by
this chat or another), attempt #2's own reservation is denied and the
second fetch never happens, yielding a safe `ignored:usage-limit`
instead of a second real HTTP call. `DEFAULT_OPENAI_MAX_ATTEMPTS` is
unchanged by this phase — no retry loop is unbounded.

Exceeding the chat-minute limit: HTTP 200, outcome
`ignored:rate-limited`, `limitType: "chat-openai"`. Exceeding the daily
ceiling: HTTP 200, outcome `ignored:usage-limit`, `limitType:
"openai-daily"`. Both keep the dedupe reservation. Both are represented
by `RateLimitExceededError`/`UsageLimitExceededError`
(`src/shared/errors.ts`) — direct `AppError` subclasses, **not**
`UpstreamServiceError` subclasses, since they represent an expected,
safe control-flow outcome rather than an upstream failure; the webhook's
existing `error instanceof TransientUpstreamError` dedupe-release check
does not match them, so the reservation is kept by construction, not by
a special case.

**Commands never consume the OpenAI counters.** `src/application/execute-command.ts`
has no OpenAI import and is never given a `beforeAttempt` boundary — only
the translation path (`src/application/translate-and-reply.ts`) reserves
OpenAI attempts. Commands are still subject to the per-chat
handled-update limit above, since that limit counts all handled updates
regardless of path.

### Atomic counter storage

`migrations/0004_reliability.sql` adds two tables (see
`docs/data-model.md` for the full schema): `rate_limit_counters` (one row
per `(scope_type, scope_id)` — `scope_type` is `'chat_updates'` or
`'chat_openai'`, `scope_id` is the Telegram chat ID) and a singleton
`openai_daily_usage`. Neither table ever grows per-request — a window
(or day) rollover overwrites the existing row's `window_id`/`day_id` and
resets its count in place, via a single atomic
UPSERT-with-`RETURNING` statement
(`src/infrastructure/d1/reliability-counters.ts`): the same window
increments in place, a new window resets to 1, and the returned count is
compared against the limit in the same statement's result — never a
separate read-then-write. This was verified directly against local D1
(`wrangler d1 execute --local`) before being wired into the repository,
and is covered by `test/infrastructure/d1/reliability-counters.test.ts`
(allow-up-to-limit-then-block, blocked-requests-still-increment,
window/day-reset, and — explicitly — that the table never accumulates
more than one row per scope after many window rollovers). A blocked
request **still increments** the counter (an accepted trade-off, since
window rollover bounds growth regardless). `nowMs` (and the derived
minute/day window IDs, `src/shared/time-windows.ts`) is always passed in
by the caller, never read from `Date.now()` inside the repository, so
window-boundary behavior is deterministically unit-testable.

A raw D1 query/runtime failure while consuming a counter becomes a
`TransientUpstreamError(service: "d1")` via the same `runD1Query` helper
Phase 5/6 use for every other D1 call — 500, dedupe reservation
**released**, no OpenAI/Telegram call. A malformed/negative returned
count (never producible by the real `CHECK`-constrained schema, only by
direct tampering or future schema drift) becomes a
`PermanentUpstreamError` — 500, dedupe reservation **kept** — matching
the same defense-in-depth pattern used for a malformed speaker-memory row
(see "Speaker memory read/write ordering" above).

## Structured logging (Phase 7)

`src/shared/structured-log.ts` is the sole place `console.log` is called
from application code (one `eslint-disable-next-line no-console`,
documenting that this is the intentional boundary, not a scattered
pattern). `LogFields` is a strict allowlisted-field type — `event`,
`outcome`, `status`, `durationMs`, `updateId`, `chatId`, `errorClass`,
`service`, `limitType`, `attempt`, `retryCount` — so a field outside this
list cannot be logged even by accident; there is no "extra data" escape
hatch. `classifyError(error)` is the sanctioned way to turn a caught
`unknown` into safe fields: it extracts only `error.name` (never
`.message` or `.stack`), plus `service` via a proper `isUpstreamService`
type guard (never an unchecked cast) when the error carries one.
**Never logged, by construction:** source message text, translated text,
reply-context text, command text, correction source/target terms,
display names, OpenAI prompts, raw OpenAI/Telegram responses, Secret
values, and raw `Error.message`/stack traces —
`test/shared/structured-log.test.ts` and
`test/handlers/telegram-webhook-security.test.ts` assert this directly,
using identifiable synthetic strings that must never appear in captured
log output.

`src/handlers/telegram-webhook.ts`'s `finish(response, startedAt,
fields)` helper wraps every response-returning exit point, so exactly
one structured log line is emitted per request — covering the 401
Secret-rejection, every `400`/`ignored:*` outcome, `translated`, every
`command:*` outcome, and the classified 500 — rather than multiple log
lines per request. `status` and `durationMs` are computed automatically
inside `finish`, never passed in by each call site.

## Error classification matrix

| Category           | Example                                                                                                                                                | HTTP status                  | Dedupe reservation       | Continues to OpenAI/Telegram?                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- | ------------------------ | ------------------------------------------------------- |
| Validation/input   | Malformed JSON, invalid Update shape                                                                                                                   | 400                          | n/a (before reservation) | No                                                      |
| Configuration      | Missing/invalid required config (fails closed)                                                                                                         | 500                          | Kept                     | No                                                      |
| Rate limit         | Per-chat handled-update or OpenAI-minute limit exceeded                                                                                                | 200 (`ignored:rate-limited`) | Kept                     | No                                                      |
| Usage limit        | Global daily OpenAI attempt ceiling exceeded                                                                                                           | 200 (`ignored:usage-limit`)  | Kept                     | No                                                      |
| Transient upstream | Network/timeout/429/5xx from OpenAI, Telegram, or D1, after retries exhausted                                                                          | 500                          | Released                 | No (the failing call itself already happened/exhausted) |
| Permanent upstream | Malformed OpenAI response, permanent Telegram rejection, malformed D1 row, `/disable` reply-failure-after-mutation-succeeded (Phase 6 review, Issue 1) | 500                          | Kept                     | No                                                      |

This table is unchanged in substance from the per-case rules already
documented above (Error-time behavior, Speaker memory read/write
ordering, Command routing and chat state, Dedupe and retry) — it exists
as a single consolidated reference, added by the Phase 7 security
regression pass, and every row is cross-checked against those sections by
name so the two never drift silently out of sync.

## Bootstrap endpoint (Phase 8A)

`POST /admin/bootstrap` exists to solve a genuine gap: `/enable` can only
flip an _existing_ `allowed_chats` row, no in-Telegram command can
self-allowlist an unknown chat, and `bot_admins` has no Phase 6/7 write
path at all (see "Command routing and chat state" above and
`docs/security-and-privacy.md`, "Admin command authorization"). Without
this endpoint, a fresh deploy would have no way to create its first admin
or its first allowlisted chat except a direct D1 `INSERT` run by hand
against the remote database. Phase 8A implements and tests this endpoint
entirely against local D1; Phase 8B is what actually calls it against the
remote database, after separate explicit approval (approval unit G,
docs/operations.md).

**Complete separation from the Telegram webhook flow.** `/admin/bootstrap`
is routed, authenticated, and processed independently of
`/telegram/webhook` (`src/index.ts`) — it never touches
`processed_updates`, the Phase 7 `rate_limit_counters`/
`openai_daily_usage` tables, or any Telegram/OpenAI boundary. This is
deliberate: it is a pure authenticated D1 setup operation, not a
message-processing one, and mixing it into the webhook's dedupe/rate-limit
machinery would gain nothing while adding an unrelated failure mode to
both paths.

**Three separated responsibilities**, each its own small module rather
than one large handler function:

- `src/infrastructure/admin/setup-secret.ts` — Secret verification only.
  Checks a dedicated `X-Setup-Admin-Secret` header (not `Authorization:
Bearer`, so this Secret's request shape never depends on or gets
  confused with a future Authorization-based scheme) against
  `SETUP_ADMIN_SECRET`, before any body read or D1 access — fail-closed
  on a missing/empty Secret, exactly like the Telegram webhook Secret
  check. The constant-time comparison itself lives in
  `src/shared/secret-compare.ts` (`timingSafeEqualStrings`), extracted
  out of `src/infrastructure/telegram/webhook-secret.ts` in this phase so
  both Secret checks share one audited implementation instead of two
  independently-maintained copies.
- `src/domain/bootstrap.ts` — `parseBootstrapRequest`, a pure parser
  (raw `unknown` JSON in, a validated `{ adminUserId, chatId }` or a
  `ValidationError` out) mirroring
  `src/infrastructure/telegram/parse-update.ts`'s style: `adminUserId`
  must be a positive safe integer (a Telegram user ID), `chatId` must be
  a non-zero safe integer (never constrained to positive, since Telegram
  group chat IDs are negative). Extra fields on the request body are
  ignored, not rejected — the same philosophy `validateAppConfig`/
  `validateReliabilityConfig` already use for their inputs.
- `src/infrastructure/d1/bootstrap.ts` — `bootstrapAdminAndChat`, the
  single atomic mutation, via `db.batch()` (the same transactional
  primitive `forget-me.ts` uses for `/forgetme confirm`'s multi-table
  delete — per Cloudflare's D1 documentation, a batch is one SQL
  transaction that rolls back entirely if any statement fails):
  `INSERT INTO bot_admins ... ON CONFLICT (user_id) DO NOTHING` and
  `INSERT INTO allowed_chats (chat_id, enabled) VALUES (..., 1) ON
CONFLICT (chat_id) DO UPDATE SET enabled = 1, ...`. Both statements
  were verified directly against local D1 (`wrangler d1 execute
--local`) before being wired into the repository, matching the Phase 7
  practice for the reliability-counter UPSERTs. Idempotent by
  construction: repeating the same `(adminUserId, chatId)` request never
  creates a duplicate `bot_admins` row and never fails — it simply
  confirms the same end state. A pre-existing **disabled** chat is
  unconditionally re-enabled, since bootstrapping a chat is itself an
  explicit statement that it should be active.

`src/handlers/admin-bootstrap.ts` composes these three, in the same
order as `telegram-webhook.ts`: Secret verification → JSON parse →
request-shape validation → the one atomic D1 mutation → a single
structured log line → response. No new migration was needed — the
mutation writes only to `bot_admins` and `allowed_chats`, both already
present since Phase 2/6.

**No new schema.** Bootstrap deliberately never touches
`speaker_profiles`, `speaker_preferences`, `translation_corrections`,
`processed_updates`, or either Phase 7 reliability-counter table — see
docs/data-model.md.

**Response minimization.** A successful bootstrap returns a fixed
`{ status: "ok", result: "bootstrap-complete" }` — never an echo of the
submitted `adminUserId`/`chatId`. Every error response is one of three
fixed, generic bodies (401 `UNAUTHORIZED`, 400
`INVALID_BOOTSTRAP_REQUEST`/`MALFORMED_JSON`, 500 `INTERNAL_ERROR`) —
never a raw D1 error message. The structured log line for this endpoint
(`event: "admin_bootstrap"`) never includes `adminUserId` or `chatId` —
`LogFields`' `chatId` field is for a Telegram chat ID surfaced by the
webhook path; the bootstrap handler's own `finish()` helper is typed to
exclude it and `updateId` entirely, so passing either would be a compile
error, not a runtime discipline problem. See
docs/security-and-privacy.md, "Bootstrap endpoint threat model".

**Routing.** `src/index.ts` matches `POST /admin/bootstrap` only — any
other method to that path (or any unmatched path) falls through to the
existing generic 404, exactly like every other route in this Worker; no
new 405 behavior was introduced, to keep routing behavior uniform across
the whole Worker.

## Translation provider router (Phase 9.1A / Phase 9.1B)

**Implemented, local/CI-only — not deployed.** `src/handlers/telegram-webhook.ts`
no longer calls `src/infrastructure/openai/translate.ts` directly for the
translation path; it builds a `TranslateBoundary` via
`createTranslationRouter` (`src/infrastructure/translation/router.ts`),
selected by the non-secret `TRANSLATION_PROVIDER` config var
(`workers-ai` | `openai`, `src/config/app-config.ts`). The router's
public contract (`TranslateBoundary.translate(request):
Promise<TranslationOutcome>`) is unchanged from Phase 4/5 — `domain/` and
`application/translate-and-reply.ts` see the same vendor-independent
shape regardless of which provider is selected.

- **`workers-ai` mode (implemented, now the default):** calls
  `src/infrastructure/workers-ai/translate.ts`'s
  `createWorkersAiTranslationProvider`, which in turn calls
  `env.AI.run()` through `src/infrastructure/workers-ai/client.ts`'s
  `callWorkersAiChat` — exactly once per message, never OpenAI. The
  Workers AI adapter returns an infrastructure-only
  `ProviderTranslationCandidate` (`src/infrastructure/translation/provider.ts`):
  `{ outcome, needsEscalation, escalationReason }`. When
  `needsEscalation` is `false`, the router unwraps `outcome` unchanged.
  When it is `true`: if a `gemini` boundary was supplied to the router
  (Phase 9.1B, `GEMINI_ESCALATION_ENABLED=true`), the router calls
  Gemini exactly once with the **original** request — see "Gemini
  semantic escalation adapter" below; otherwise (Phase 9.1A behavior,
  still the default — `GEMINI_ESCALATION_ENABLED=false`) it throws
  `EscalationRequiredError` (`src/shared/errors.ts`) instead of
  surfacing the provisional `outcome`. There is no automatic Workers AI
  → OpenAI fallback in either case, by design (see
  `docs/phase9-provider-plan.md`, "bounded fan-out policy") — "is
  `gemini` configured" is the router's only escalation-availability
  signal, so the router itself never reads config.
- **`openai` mode (implemented, legacy/compatibility path):** calls the
  existing Phase 4/5 `src/infrastructure/openai/translate.ts` boundary
  unchanged — behavior, tests, and prompt (`translation-v2.ts`) are
  identical to before this phase. Never calls Workers AI or Gemini.
- **No mode calls more than 2 providers per message.** `workers-ai` mode
  calls at most Workers AI, then optionally Gemini; `openai` mode calls
  exactly OpenAI. `test/infrastructure/translation/router.test.ts`
  asserts this directly for both modes, including the escalation-required
  and semantic-escalation-to-Gemini cases, and a dedicated "maximum
  logical providers per message is 2" test.

### Workers AI adapter

`src/infrastructure/workers-ai/client.ts`'s `callWorkersAiChat` calls
`env.AI.run(model, inputs, { signal })` through a narrow
`WorkersAiBinding` interface (`{ run(model, inputs, options?): Promise<unknown> }`)
rather than the full generated `Ai` type, so every test can inject a
synthetic fake instead of the real binding — **no test in this
repository ever performs a real `env.AI.run()` call**; `vitest.config.ts`
also sets `remoteBindings: false` so the test pool itself never attempts
a live Cloudflare connection for the `AI` binding. The model
(`@cf/zai-org/glm-4.7-flash`) is passed in from `WORKERS_AI_MODEL`
config — never hard-coded into `provider.ts`, `translate.ts`, or any
domain/application type. A real `AbortSignal`-based timeout bounds each
call; there is no automatic retry beyond the one logical Workers AI
attempt per Telegram delivery (matching `docs/project-rules.md` rules
7–8 — the existing OpenAI retry budget is unrelated and unchanged).

**Error classification** (`classifyWorkersAiError`, best-effort — the
generated Workers AI binding type exposes no structured error shape, only
`Error.message` text): a documented client-error code (`400`, `401`,
`403`, `404`, `422`) or matching wording for the same deterministic
problem (e.g. "invalid model", "unauthorized", "model not found")
classifies as `PermanentUpstreamError(service: "workers-ai")` — a
redelivery would fail identically, so keeping the dedupe reservation is
correct. **Every other call-layer failure is transient** (Phase 9.1A
review hardening): a documented transient code (`429`, `500`, `502`,
`503`, `504`, `408`, `3036`, `3040`), common network/transport wording
with no code attached (e.g. "network error", "service unavailable"), or
a genuinely unrecognized failure shape (including a non-`Error` thrown
value) all classify as `TransientUpstreamError`. This default was
originally fail-closed-to-permanent; the review flipped it, since a
wrongly-permanent classification permanently drops the message (the
dedupe reservation is kept, so Telegram's redelivery is just a
duplicate), while a wrongly-transient classification only costs one
avoidable redelivery attempt — the safer default runs the other way than
a boundary-input validator's. An `AbortError`/`TimeoutError` from the
timeout itself is always transient. A **malformed but
successfully-returned** model response is unaffected by any of this — it
is a separate, still-permanent path (`translate.ts`'s `malformed()`
helper, never routed through `classifyWorkersAiError`). The public error
message is a fixed string, never the caught error's own `.message` —
`test/infrastructure/workers-ai/client.test.ts` asserts an identifiable
synthetic detail never reaches `publicMessage`.

**Direct-binding contract verification (Phase 9.1A review hardening):**
both the request shape (`response_format: { type: "json_schema",
json_schema: { name, schema, strict } }`) and the response envelope
(`choices[0].message.content`) were checked against this repo's actual
generated `worker-configuration.d.ts` types
(`Base_Ai_Cf_Zai_Org_Glm_4_7_Flash`'s `ChatCompletionsMessagesInput`/
`ChatCompletionsOutput`) rather than assumed from OpenAI compatibility —
confirmed to already match. The request's `response_format` value is now
explicitly annotated with the generated `ResponseFormatJSONSchema` type
in `translate.ts`, so `npm run typecheck` fails if this ever drifts;
`test/infrastructure/workers-ai/translate.test.ts` adds a matching
runtime assertion on the exact object sent to `binding.run()`. The
generated `ChatCompletionMessageParam` type accepts `developer`, but
live inference showed that `@cf/zai-org/glm-4.7-flash` did not reliably
apply control instructions from that role. The adapter therefore uses
`system` for Workers AI control instructions; a live synthetic check on
2026-08-28 confirmed the same prompt then preserved the intended
JA<->PT-BR routing.

**Structured output validation** (`src/infrastructure/workers-ai/translate.ts`)
mirrors the existing OpenAI adapter's defense-in-depth manual validation:
the chat-completions-shaped response's `choices[0].message.content` is
JSON-parsed, checked against the same structural/cross-field rules as
`translation-v2.ts`'s schema (detected-language/action/targetLanguage
consistency, non-empty `translatedText` on a translate action, a valid
`styleSignals` tone/emojiUsage pair, and — new for this adapter — that
`needsEscalation`/`escalationReason` agree: `escalationReason` is
`"none"` if and only if `needsEscalation` is `false`, and any other value
must be one of the six fixed `EscalationReason` enum members). No `any`,
no `as unknown as X` — see `test/infrastructure/workers-ai/translate.test.ts`.

**Shared prompt content.** `src/prompts/translation-shared.ts` extracts
the provider-neutral instructional text and user-content-line building
logic verbatim from the pre-existing OpenAI prompt, reused byte-identically
by both `translation-v2.ts` (OpenAI) and the new
`translation-workers-ai.ts` (Workers AI) — a semantic-parity test asserts
identical output for identical input. `translation-workers-ai.ts` adds
its own JSON Schema (`WORKERS_AI_JSON_SCHEMA`), extending the v1 schema
with `needsEscalation`/`escalationReason`, and its own prompt version
constant (`TRANSLATION_WORKERS_AI_PROMPT_VERSION`), independent of the
OpenAI prompt's versioning.

### Gemini semantic escalation adapter (Phase 9.1B)

**Implemented, local/CI-only — not deployed; disabled by default
(`GEMINI_ESCALATION_ENABLED=false`).** `src/infrastructure/gemini/client.ts`'s
`callGeminiInteraction` makes a single `fetch` call to the Gemini
Interactions API (`POST https://generativelanguage.googleapis.com/v1/interactions`,
`x-goog-api-key` header, never a query parameter), bounded by a real
`AbortSignal` timeout, with no automatic retry — mirroring the Workers
AI/OpenAI adapters' one-logical-attempt-per-delivery discipline. Unlike
the Workers AI adapter, this project has no generated Cloudflare type
for Gemini's contract, and outbound access to `ai.google.dev` was
blocked in the environment this was implemented in — the exact request/
response shape (`system_instruction`/`input` as plain strings,
`response_format: { type: "text", mime_type: "application/json", schema
}`, and extracting model output from `steps[].content[].text`) is a
documented best-effort interpretation of the task's own stated
operational facts, flagged for re-verification against live Google
documentation before any real Gemini call. `callGeminiInteraction`
unconditionally force-sets `store: false` on every request body — after
the caller's own body is spread in, so no caller (including a future
one) can omit or override it — since the Interactions API stores
interactions by default and this bot is intentionally stateless at the
provider level: no `previous_interaction_id`, no background mode, no
streaming, no tools/grounding.

**Semantic escalation vs. infrastructure failure.** Gemini is called
only when Workers AI's structured output _itself_ reports
`needsEscalation: true` — a successful, validated Workers AI response
that just needs a stronger second opinion. It is never called as a
fallback for a Workers AI infrastructure/availability failure (timeout,
network error, 429/5xx, invalid model, malformed output) — those all
throw before the router ever reads `needsEscalation` (see
`src/infrastructure/translation/router.ts`, `translateViaWorkersAi`),
so Gemini sees zero calls in every one of those cases.
`src/infrastructure/gemini/translate.ts` receives the **original**
`TranslationRequest` — never Workers AI's provisional `translatedText`,
outcome, or free-form reasoning — so Gemini forms an independent second
opinion rather than anchoring to a low-confidence first attempt. Its
output contract has no escalation concept of its own: it reuses
`translation-v1.ts`'s `TRANSLATION_JSON_SCHEMA` directly (via
`src/prompts/translation-gemini.ts`, which also reuses
`translation-shared.ts`'s provider-neutral instructional text) and
returns a plain `TranslationOutcome`, exactly like the OpenAI adapter —
the router treats Gemini as the final semantic-quality layer, not
another `TranslationProvider` that could itself request further
escalation.

**Error classification** mirrors the Workers AI adapter's reworked
policy directly, but with real HTTP status codes available (no
message-text pattern-matching needed): `400`/`401`/`403`/`404`/`422` is
`PermanentUpstreamError(service: "gemini")`; `408`/`429`/5xx and any
network/runtime failure before a response was received is
`TransientUpstreamError`; a successful HTTP response with a non-JSON or
otherwise malformed body is permanent. A malformed-but-successfully-
returned structured output (missing `steps[].content[].text`, invalid
JSON, a cross-field-inconsistent payload) is validated exactly like the
OpenAI/Workers AI adapters and is likewise always permanent, never
retried.

**App-side attempt budget.** `src/infrastructure/d1/provider-usage-counters.ts`
(`migrations/0005_provider_usage.sql`) tracks a global (not per-chat)
Gemini minute/day attempt count, mirroring Phase 7's
`rate_limit_counters`/`openai_daily_usage` atomic-UPSERT pattern
exactly. The webhook's `reserveGeminiAttempt` closure — captured so
`infrastructure/translation/router.ts` never imports D1 — checks
`GEMINI_API_KEY` presence first (before any D1 access), then reserves
the minute budget, then the daily budget, throwing
`RateLimitExceededError`/`UsageLimitExceededError` if either is
exhausted; the router calls this closure via `beforeGeminiAttempt`,
strictly before calling Gemini, so a missing key or exhausted budget
means Gemini is never actually called. Because this check is lazy
(invoked only when Workers AI actually requests escalation, not
whenever escalation is merely enabled), a routine, non-escalating
Workers AI translation never requires `GEMINI_API_KEY` — even with
`GEMINI_ESCALATION_ENABLED=true` and Gemini setup incomplete.

### Webhook integration

`src/handlers/telegram-webhook.ts`'s provider-conditional branch moves
the existing `reserveOpenAiAttempt` closure and the `OPENAI_API_KEY`
presence check entirely inside the `openai`-mode branch — `workers-ai`
mode never requires `OPENAI_API_KEY` and never consumes the Phase 7
OpenAI-specific `rate_limit_counters`/`openai_daily_usage` counters (it
is still subject to the provider-agnostic per-chat handled-update limit,
same as any other message). A `catch (error instanceof
EscalationRequiredError)` branch responds 200, outcome
`ignored:escalation-unavailable`, and **keeps** the dedupe reservation
(this is a safe, expected outcome, not a transient failure — a
redelivery of the same update would reach the same escalation-required
result again, so releasing the reservation would gain nothing) — reached
when Gemini escalation is disabled or not configured. Phase 9.1B: in
`workers-ai` mode, a `RateLimitExceededError`/`UsageLimitExceededError`
from the Gemini budget closure is unambiguous (the OpenAI reservation
closure is never constructed in this mode) and is likewise mapped to
200 `ignored:escalation-unavailable` (dedupe kept), logged with
`provider: "gemini"` and `limitType: "gemini-minute"`/`"gemini-daily"` —
distinct from the legacy `openai`-mode `ignored:rate-limited`/
`ignored:usage-limit` outcomes, which are unaffected. Dedupe and
speaker-memory read/write ordering are otherwise unchanged from Phase
4–7 regardless of provider — including on a Gemini-escalated success,
where the best-effort observed-style write uses Gemini's final
`styleSignals`, never Workers AI's provisional ones (`translateAndReply`
itself needed no change — it only ever sees the router's single final
`TranslationOutcome`). The success log line's `provider` field reflects
the **actual final provider** (`workers-ai`, `openai`, or `gemini` on a
semantic escalation) via the router's `onFinalProviderSelected`
callback — never a raw model ID or other provider-identifying detail
(see `docs/security-and-privacy.md`, "Log minimization").

## What this Worker does _not_ do (see `docs/implementation-plan.md`)

Voice transcription, image OCR, sticker translation, video, full
conversation history, RAG/vector search, a web admin UI, multi-tenant SaaS
support. See the project brief and implementation plan for the full
out-of-scope list.
