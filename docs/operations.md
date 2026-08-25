# Operations

Status: **Phase 8A — deployment preparation complete; every external
action below is still pending its own separate approval (Phase 8B).**
This document is now the deployment runbook's canonical source, not just
a plan — the procedures below are meant to be followed literally once
each step is approved, not re-derived at deploy time. As of Phase 8A,
none of the actions below have actually been performed, because the
underlying external resources (Worker deployment, Telegram bot,
registered webhook, registered Secrets) don't exist yet — only their
local-only code and D1 schema do. Each section says explicitly what's
not possible yet.

## External action approval matrix

Nine external actions, each its **own independent approval unit** —
approving one never authorizes any other, even when a later step in
"First deployment order" below depends on an earlier one having
happened:

| Unit | Action                                                                                        | Owning section below           |
| ---- | --------------------------------------------------------------------------------------------- | ------------------------------ |
| A    | Create the real Telegram bot via BotFather                                                    | "Telegram bot creation"        |
| B    | Register `OPENAI_API_KEY` as a Cloudflare Secret                                              | "Secret registration runbook"  |
| C    | Register `TELEGRAM_BOT_TOKEN` as a Cloudflare Secret                                          | "Secret registration runbook"  |
| D    | Register `TELEGRAM_WEBHOOK_SECRET` as a Cloudflare Secret                                     | "Secret registration runbook"  |
| E    | Register `SETUP_ADMIN_SECRET` as a Cloudflare Secret                                          | "Secret registration runbook"  |
| F    | Apply pending D1 migrations to the remote database (`0002`, `0003`, `0004`)                   | "Remote migration runbook"     |
| G    | Bootstrap the first real admin/chat via `POST /admin/bootstrap` against the remote deployment | "Bootstrap procedure"          |
| H    | Deploy the Worker (`wrangler deploy`)                                                         | "Worker deployment runbook"    |
| I    | Register the Telegram webhook (`setWebhook`)                                                  | "Webhook registration runbook" |

This table is the authoritative list — `docs/checkpoints/2026-08-21-phase7-review-complete.md`
records the same nine actions under "Phase 8 boundary"; this table is
its operational counterpart. No action in this document should ever be
performed without the human explicitly approving that specific unit by
letter, in the same conversation turn or an unambiguous follow-up to it.

## Toolchain (planned, web-based)

| Tool                                                   | Role                                                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| GitHub Codespaces                                      | Primary development environment (edit, run `npm run check`, run `wrangler dev` locally in-container) |
| GitHub Actions                                         | CI: `npm run check` on every push/PR (already active — see `.github/workflows/ci.yml`)               |
| Cloudflare Dashboard                                   | View Worker deployments, logs/observability, manage Secrets                                          |
| D1 Dashboard (part of Cloudflare Dashboard)            | Inspect the database, run ad hoc queries for debugging                                               |
| Cloudflare Secrets (`wrangler secret put` / Dashboard) | Register `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `SETUP_ADMIN_SECRET`     |
| Telegram BotFather                                     | Create the bot, obtain its token, set bot metadata                                                   |
| OpenAI Platform                                        | API key management, usage/cost monitoring                                                            |

## Not yet possible (as of Phase 8A)

- Deploying to Cloudflare (`wrangler deploy`) — no production Worker
  exists yet (approval unit H).
- Registering a Telegram webhook — no bot exists yet, and no Secret is
  registered to verify it with (approval unit I).
- Rotating a Secret — none registered yet (the remote D1 database exists
  since Phase 2, but `OPENAI_API_KEY`/`TELEGRAM_WEBHOOK_SECRET`/
  `TELEGRAM_BOT_TOKEN`/`SETUP_ADMIN_SECRET` are not — approval units B–E).
- Running `/status` (or any command) in a real Telegram chat — no bot
  exists yet; the command surface is implemented and tested only against
  mocked Telegram calls and local D1.
- Registering a real admin in `bot_admins` against the remote database —
  Phase 8A implements and tests `POST /admin/bootstrap`
  (`src/handlers/admin-bootstrap.ts`) against local D1 only; calling it
  against the remote database is approval unit G, and it requires the
  Worker to already be deployed (unit H) and `SETUP_ADMIN_SECRET`
  registered (unit E) — see "First deployment order" below.
- Applying `migrations/0002_speaker_memory.sql`,
  `migrations/0003_commands.sql`, or `migrations/0004_reliability.sql` to
  the remote database — all three verified with `--local` only; a
  `--remote` apply is approval unit F.
- Exercising the webhook boundary, the OpenAI translation pipeline,
  speaker memory, the command surface, the Phase 7 rate/usage limits, or
  the Phase 8A bootstrap endpoint against real traffic — all are
  implemented and tested locally against mocked Telegram/OpenAI
  responses and local D1 (Phases 3–8A), but nothing external points at
  any of it yet, and no real OpenAI/Telegram API call has been made.
  This means the initial rate/usage-limit values below are also untested
  against real usage patterns — see "Tuning the Phase 7 limits" below.

## GitHub Codespaces

Once a Codespace is opened on this repo: `npm install`, then `npm run
check` to confirm the environment is healthy, then `npm run dev` to run
the Worker locally (`wrangler dev`, no external calls in Phase 0). No
Cloudflare login is required for local `wrangler dev` against a Worker
with no remote bindings.

## GitHub Actions

`.github/workflows/ci.yml` runs `npm ci && npm run check` on every push
and pull request. It requires no Secrets and does not deploy anything —
by design, so contributors and forks can run CI without Cloudflare
credentials.

## First deployment order (Phase 8B, not yet performed)

Each numbered step below is a distinct approval unit (letters reference
the matrix above) or a verification step with no external side effect.
Steps 2–3 can happen in either order relative to each other, but both
must precede step 4 (a bot token and a webhook secret are both needed to
register a webhook, and the migrations must exist before the Worker that
queries them is deployed); step 6 (bootstrap) must follow step 5 (deploy)
because it calls the deployed Worker's own `/admin/bootstrap` route, and
must follow Secret registration (unit E) because that route is
`SETUP_ADMIN_SECRET`-gated. Step 8 (webhook registration) is deliberately
**after** bootstrap (step 6), not before: registering the webhook makes
the bot start receiving real Telegram traffic, and until bootstrap has
run, no chat is allowlisted and no admin exists yet — so ordering
webhook registration last means the very first real webhook delivery
already lands on a fully-provisioned bot instead of racing the bootstrap
step.

1. Confirm this repository's `main` is green: `git status`,
   `git rev-parse HEAD`, `npm ci`, `npm run check` — no external side
   effect, always safe to (re-)run.
2. **[Unit A]** Create the Telegram bot via BotFather — see "Telegram
   bot creation" below.
3. **[Units B, C, D, E]** Register all four Secrets — see "Secret
   registration runbook" and "Secret generation" below. These are four
   separate approvals, not one.
4. **[Unit F]** Apply the pending remote D1 migrations (`0002`, `0003`,
   `0004`) — see "Remote migration runbook" below.
5. **[Unit H]** Deploy the Worker — see "Worker deployment runbook"
   below.
6. Obtain/confirm the real `adminUserId` (Yuji's Telegram user ID) and
   the real initial `chatId` (the family group's chat ID) — see "Real
   Telegram ID acquisition" below. No external mutation; read-only.
7. **[Unit G]** Call `POST /admin/bootstrap` against the deployed Worker
   with those two real IDs — see "Bootstrap procedure" below.
8. Verify the bootstrap succeeded — see "Post-deploy smoke checks"
   below (the pre-webhook-registration subset).
9. **[Unit I]** Register the Telegram webhook — see "Webhook
   registration runbook" below.
10. Verify the webhook registration — `getWebhookInfo`, see "Post-deploy
    smoke checks" below.
11. Run `/status` in the real pilot chat — confirms the full stack
    end to end from a real Telegram client.
12. Hand off to Phase 9 (pilot) — this document's job ends here; pilot
    procedure is `docs/implementation-plan.md` Phase 9's own scope, not
    this operations runbook's.

## Telegram bot creation (approval unit A)

Performed once, manually, via Telegram's BotFather chat
(`https://t.me/BotFather`) — there is no API for bot creation itself:

1. Message BotFather: `/newbot`.
2. Choose a display name and a unique `@username` ending in `bot` when
   prompted.
3. BotFather returns the bot's token (`TELEGRAM_BOT_TOKEN`) — copy it
   directly into the Secret-registration step below; never paste it into
   a commit, an issue, a chat log, or any file in this repository.
4. Optional but recommended before going further: set a bot description/
   about text and profile picture via BotFather's `/setdescription`,
   `/setabouttext`, `/setuserpic` — cosmetic only, no security relevance.
5. Do **not** call `setWebhook` yet — that is a separate, later approval
   (unit I, "Webhook registration runbook" below), performed only after
   the Worker is deployed and bootstrapped.

## Secret registration runbook (approval units B–E)

Each Secret is registered with `wrangler secret put <NAME>`, which
prompts for the value interactively (or reads it from stdin) — **never**
pass a Secret value as a CLI argument or embed it in a script, since
CLI arguments can end up in shell history. Command templates below use
`<PLACEHOLDER>` only; no real value is ever written to this document, a
commit, or a terminal transcript kept anywhere in this repository.

### Phase 9.1A note: `AI` binding requires no Secret

`TRANSLATION_PROVIDER=workers-ai` mode (the code's default as of Phase
9.1A, implemented and tested locally/in CI only — not yet deployed) uses
the `AI` Worker binding (`wrangler.jsonc`), which needs no
`wrangler secret put` call and no API key — Workers AI billing/quota is
tied to the Cloudflare account itself, not a registered credential.
`OPENAI_API_KEY` (unit B below) remains required only if/when the
deployed Worker is configured with `TRANSLATION_PROVIDER=openai`
(legacy/compatibility mode). Deploying the Phase 9.1A code itself is a
separate, not-yet-approved external action — see `README.md`,
"Deployment state".

### `OPENAI_API_KEY` (unit B)

- **Source:** OpenAI Platform (`https://platform.openai.com/api-keys`) —
  create a project-scoped key dedicated to this bot, not a personal
  general-purpose key, so usage/cost tracking and revocation are
  unambiguous.
- **Registration:** `npx wrangler secret put OPENAI_API_KEY` (interactive
  prompt).
- **Verification:** after registration, `npx wrangler secret list`
  confirms the name is present (never the value — Cloudflare does not
  return Secret values). A real end-to-end check is a translation
  request in the pilot chat once deployed (Phase 9), not a standalone
  verification step here.
- **Rotation:** generate a new key on the OpenAI Platform, `wrangler
secret put OPENAI_API_KEY` again (overwrites in place), confirm the
  Worker is serving correctly (see "Post-deploy smoke checks"), then
  revoke the old key on the OpenAI Platform.
- **Revoke source:** OpenAI Platform → API keys → revoke.
- Never stored in this repository in any form, including `.dev.vars`
  (gitignored, but still never committed).

### `GEMINI_API_KEY` (Phase 9.1B — future, not yet an approved unit)

Implemented in source (`src/infrastructure/gemini/`,
`src/handlers/telegram-webhook.ts`) but genuinely not registered, and
not part of the nine-unit Phase 8B approval matrix above — registering
it, and separately enabling `GEMINI_ESCALATION_ENABLED` in production
config, are both distinct future actions requiring their own explicit
approval, only relevant once a Phase 9.1A/9.1B deploy is itself
approved.

- **Source:** Google AI Studio / the Gemini API console — create a
  project-scoped key for this bot.
- **Registration (future):** `npx wrangler secret put GEMINI_API_KEY`
  (interactive prompt) — same never-as-a-CLI-argument rule as every
  other Secret above.
- **Verification (future):** `npx wrangler secret list` confirms the
  name is present. A real end-to-end check requires
  `GEMINI_ESCALATION_ENABLED=true` and a genuinely ambiguous message in
  the pilot chat — not exercised until Phase 9.1B's live pilot step,
  which is not scheduled by this document.
- **Rotation (future):** generate a new key in the Gemini API console,
  `wrangler secret put GEMINI_API_KEY` again (overwrites in place),
  confirm the Worker is serving correctly, then revoke the old key.
- **Revoke source:** the Gemini API console.
- **Before registering this Secret at all:** the Gemini Free Tier
  data-treatment implications (docs/security-and-privacy.md, "Data sent
  to Gemini") must be explicitly reviewed and accepted — registering the
  key is not itself that review.
- Never stored in this repository in any form, including `.dev.vars`.

### `TELEGRAM_BOT_TOKEN` (unit C)

- **Source:** BotFather, from "Telegram bot creation" above (or
  BotFather's `/token` command to re-fetch it later).
- **Registration:** `npx wrangler secret put TELEGRAM_BOT_TOKEN`.
- **Verification:** `npx wrangler secret list`; a real check is
  `getWebhookInfo` or `/status` responding once the webhook is
  registered (later steps).
- **Rotation:** BotFather's `/revoke` (or `/token` to regenerate) issues
  a new token; `wrangler secret put TELEGRAM_BOT_TOKEN` with the new
  value; the _old_ token stops working immediately once BotFather issues
  the new one, so this rotation is not overwrite-then-revoke like
  `OPENAI_API_KEY` — the old token is already dead the moment the new one
  is issued. Re-run "Webhook registration runbook" only if BotFather's
  rotation invalidated the existing webhook registration (it typically
  does not, but verify with `getWebhookInfo` after rotating).
- **Revoke source:** BotFather (`/revoke`).

### `TELEGRAM_WEBHOOK_SECRET` (unit D)

- **Source:** generated locally by the operator, not obtained from any
  external service — see "Secret generation" below for the generation
  requirement.
- **Registration:** `npx wrangler secret put TELEGRAM_WEBHOOK_SECRET`.
- **Verification:** a forged-secret request should be rejected 401 (see
  `docs/security-and-privacy.md`, "Telegram Webhook Secret
  verification") — this is already covered by this repository's test
  suite against a synthetic value; a live check is that Telegram's own
  webhook deliveries succeed once `setWebhook` is called with the same
  value in `secret_token`.
- **Rotation ordering matters, unlike the other three Secrets:** the
  Worker Secret and the value Telegram sends back must always match, so
  rotating this one is: (1) generate a new value, (2) `wrangler secret
put TELEGRAM_WEBHOOK_SECRET` with the new value, (3) immediately
  re-run `setWebhook` with the new value in `secret_token` — a real
  Telegram delivery arriving between steps 2 and 3 would be rejected
  (401) until step 3 completes. This is an acceptable brief gap (a
  rejected delivery is retried by Telegram), never a security problem —
  fail-closed is the safe direction here.
- **Revoke source:** none external — simply stop using the old value
  (there is nothing to "revoke" for a self-generated Secret).

### `SETUP_ADMIN_SECRET` (unit E)

- **Source:** generated locally by the operator — see "Secret
  generation" below.
- **Registration:** `npx wrangler secret put SETUP_ADMIN_SECRET`.
- **Verification:** a request to `POST /admin/bootstrap` with the
  correct value in `X-Setup-Admin-Secret` succeeds; without it, 401 —
  already covered by `test/handlers/admin-bootstrap.test.ts` against a
  synthetic value.
- **Rotation:** `wrangler secret put SETUP_ADMIN_SECRET` with a newly
  generated value. No coordination needed with any other system (unlike
  `TELEGRAM_WEBHOOK_SECRET`) — `/admin/bootstrap` is only ever called
  manually by an operator who already has the new value in hand.
- **Revoke source:** none external — Cloudflare Secret only.
- Used exclusively to authenticate `POST /admin/bootstrap`
  (`src/infrastructure/admin/setup-secret.ts`) — never used for anything
  else, including the webhook-setup step (see
  `docs/security-and-privacy.md`, "Webhook registration strategy").

## Secret generation (approval units D, E — values not yet generated)

Phase 8A generates no real Secret value; this section documents the
_condition_ each self-generated Secret must satisfy once it is actually
generated, in Phase 8B.

- **`TELEGRAM_WEBHOOK_SECRET`:** cryptographically random, and must fit
  Telegram's `secret_token` constraint for `setWebhook` — 1 to 256
  characters from `A-Z`, `a-z`, `0-9`, `_`, `-` (see
  `src/infrastructure/telegram/webhook-secret.ts`'s doc comment, which
  cites the same constraint). A reasonable generation method: a
  cryptographically random byte string encoded into that character set
  at a length comfortably above any realistic guessing budget (e.g. 32+
  bytes' worth of entropy).
- **`SETUP_ADMIN_SECRET`:** cryptographically random, sufficient entropy
  (e.g. 32+ random bytes, base64/hex-encoded) — no format constraint
  from any external service, since this Secret is never sent to
  Telegram or OpenAI, only compared against the `X-Setup-Admin-Secret`
  header this repository's own code checks.
- Neither value is generated, registered, or written anywhere by Phase
  8A — this section exists so Phase 8B's generation step has a
  documented requirement to satisfy rather than inventing one at deploy
  time. Generate with a real CSPRNG (e.g. `openssl rand -hex 32`, or an
  equivalent Cloudflare Dashboard / password-manager generator) — never
  a value typed by hand or reused from another system.

## Remote migration runbook (approval unit F)

Pending: `0002_speaker_memory.sql`, `0003_commands.sql`,
`0004_reliability.sql`. Already applied remotely: `0001_initial.sql`
(2026-08-14). `--remote` migration apply is **not performed by Phase
8A** — this section documents the procedure for Phase 8B.

1. **Read-only status check:** `npx wrangler d1 migrations list
<database-name> --remote` — confirms the exact pending set matches
   the expected `0002`, `0003`, `0004` (and nothing else) before
   proceeding.
2. **Confirm the expected pending set** against this document and
   `docs/data-model.md`'s "Migration policy" — if the remote ledger shows
   anything unexpected (a migration already applied that shouldn't be,
   or a gap), stop and investigate before applying anything.
3. **Present a short pre-apply summary and wait for explicit approval**
   before running `--remote`: the pending migrations, their expected
   schema changes (new columns on `speaker_profiles`, new
   `speaker_preferences`/`translation_corrections`/`bot_admins`/
   `rate_limit_counters`/`openai_daily_usage` tables — see
   `docs/data-model.md`), that none of the three is destructive (no
   `DROP`/`ALTER ... DROP COLUMN` in any of them — confirmed by reading
   each `.sql` file directly), and that rollback is not a simple reverse
   command (SQLite/D1 migrations are forward-only in this project's
   tooling — see "Migration rollback" below) — plus, per "Remote data
   backup/recovery check" below, an explicit confirmation that the
   remote database holds no real family data yet.
4. **Apply, only after that explicit approval:** `npx wrangler d1
migrations apply <database-name> --remote`, one migration file at a
   time or all pending at once per Wrangler's own batching — either is
   acceptable since none of the three depends on external state beyond
   the schema itself.
5. **Verify the remote migration ledger:** `npx wrangler d1 migrations
list <database-name> --remote` again — confirms `0002`, `0003`, `0004`
   now show as applied and nothing shows as pending.
6. **Schema verification:** a read-only `wrangler d1 execute
<database-name> --remote --command "SELECT name FROM sqlite_master
WHERE type='table'"` (or the D1 Dashboard) confirms
   `speaker_preferences`, `translation_corrections`, `bot_admins`,
   `rate_limit_counters`, and `openai_daily_usage` all exist remotely,
   matching the local schema exactly.

### Migration rollback

D1/SQLite migrations in this project are **forward-only** — there is no
"undo" command for an applied migration. If a problem is discovered
after applying:

- Before applying: review each pending migration's SQL directly (already
  done in step 3 above) to confirm no destructive statement exists — all
  three pending migrations are additive only (new tables, or new
  nullable columns with a `CHECK`), never a `DROP`, per
  `docs/data-model.md`.
- If a genuine problem is found after applying: write and apply a new
  **forward-fix migration** (`0005_*.sql` or later) rather than trying to
  hand-edit or reverse-apply an already-applied one — this matches
  `docs/data-model.md`, "Migration policy".
- **Remote data backup/recovery check:** as of Phase 8A/8B, the remote
  database holds no real family data — Phase 9 (pilot) is the first time
  any exists. This must be **confirmed at the time of the actual
  `--remote` apply**, not assumed from this document, since state can
  change between when this runbook was written and when it's followed —
  a quick read-only row count against `speaker_profiles`/
  `translation_corrections`/`allowed_chats` before applying is
  sufficient. Once Phase 9 has real data, this runbook must be revisited
  to add an explicit backup/export step before any future remote
  migration — not designed yet, since it isn't needed until then.

## Worker deployment runbook (approval unit H)

**Predeploy checks**, all read-only/local, run immediately before
`wrangler deploy`:

1. `git status` — confirm a clean tree on `main` (no uncommitted
   changes, nothing accidentally staged).
2. `git rev-parse HEAD` — record the exact commit being deployed.
3. `npm ci` — reproducible dependency install.
4. `npm run check` — format, lint, typecheck, and the full local test
   suite all green.
5. `wrangler.jsonc` review — confirm the `d1_databases` binding points
   at the real `database_id` (already configured since Phase 2) and that
   no Secret value or Secret key name has been added to `vars` (Secrets
   never belong there — see `docs/security-and-privacy.md`).
6. Migration status — confirm "Remote migration runbook" above has
   already completed successfully (unit F) before deploying; a Worker
   whose code expects `rate_limit_counters`/`bot_admins`/etc. to exist
   remotely must not be deployed against a database that doesn't have
   them yet.
7. Secret registration status — confirm all four Secrets (units B–E)
   are already registered; the Worker fails closed (500, or 401 for the
   two Secret-gated entry points) on every request path that needs a
   missing one, so deploying before Secrets are registered doesn't
   crash the Worker, but it also serves no real traffic usefully.
8. Bootstrap-endpoint readiness — confirm `POST /admin/bootstrap` is
   present in the code being deployed (`src/index.ts` routes it) and
   that `SETUP_ADMIN_SECRET` is registered (unit E), since step 7 of
   "First deployment order" above calls it immediately after this
   deploy.

**Deploy:** `npx wrangler deploy` — **not performed by Phase 8A.**

## Real Telegram ID acquisition (for approval unit G)

The bootstrap endpoint needs two real IDs before it can be called: the
initial admin's Telegram user ID (Yuji's own) and the initial pilot
chat's Telegram chat ID.

- **Preferred method — Telegram's own API:** once the bot is created
  (unit A) and its token registered (unit C), a real admin can message
  the bot directly, and the resulting Update's `message.from.id` (for
  the admin's user ID) and `message.chat.id` (for a group chat's ID, if
  messaged from within the target group) are the authoritative real
  values — read via a single manual `getUpdates` call against the
  Telegram Bot API (or, once the webhook is registered, from a Workers
  Logs entry — though per this repository's log-minimization rules,
  Telegram IDs are only visible there if a future log field is
  explicitly added for that purpose, which this repository does not do
  by default).
- **Not recommended by default:** routing real family-group information
  (chat IDs, member IDs) through a third-party bot or service other than
  Telegram's own API to "look up" an ID — this needlessly exposes real
  identifiers to an unrelated system. Telegram's own API, called
  directly by the operator, is the default recommended path.
- **Never committed:** the real `adminUserId`/`chatId` values are used
  only as the `POST /admin/bootstrap` request body at the moment of
  bootstrapping (approval unit G) — never written into this repository,
  a commit, an issue, or any documentation file. Every ID in this
  repository's code, tests, and docs remains an obviously synthetic
  placeholder, permanently.
- Actually calling any Telegram API to acquire these IDs is itself real
  external API usage and is covered by the same "no live API call"
  constraint as every other Phase 8A guardrail — this acquisition step
  happens only as part of Phase 8B, not Phase 8A.

## Bootstrap procedure (approval unit G)

Performed once per deployment (or again, harmlessly, per the endpoint's
idempotency — see `docs/data-model.md`, "Phase 8A bootstrap-endpoint
design decisions" — if a repeat is ever needed for an additional admin
or chat), after the Worker is deployed (unit H) and `SETUP_ADMIN_SECRET`
is registered (unit E):

```sh
curl -X POST "https://<WORKER_URL>/admin/bootstrap" \
  -H "X-Setup-Admin-Secret: <SETUP_ADMIN_SECRET_VALUE>" \
  -H "Content-Type: application/json" \
  -d '{"adminUserId": <REAL_ADMIN_TELEGRAM_USER_ID>, "chatId": <REAL_CHAT_ID>}'
```

A successful call returns `{"status":"ok","result":"bootstrap-complete"}`
with HTTP 200. Verify via the D1 Dashboard or a read-only `wrangler d1
execute --remote` query that `bot_admins` now contains the admin's
`user_id` and `allowed_chats` now has the chat `enabled = 1` — see
"Post-deploy smoke checks" below. Never paste the real
`SETUP_ADMIN_SECRET_VALUE`, `REAL_ADMIN_TELEGRAM_USER_ID`, or
`REAL_CHAT_ID` into this document, a commit, an issue, or a shared
terminal transcript — the command above is a template, filled in only
at the moment of actual use.

### Bootstrap endpoint lifecycle decision

`POST /admin/bootstrap` is **kept deployed indefinitely by default**,
not disabled or removed after the initial bootstrap — it stays safe to
leave reachable because it is strongly Secret-gated, performs no
destructive action, is idempotent, and is limited to exactly one
admin+chat upsert (see `docs/security-and-privacy.md`, "Bootstrap
endpoint threat model"). Leaving it deployed also means a legitimate
future need (e.g. bootstrapping a second admin, or a second pilot chat)
never requires a redeploy just to re-enable a removed route. This is a
deliberate choice, not an oversight: a one-time-disable mechanism (a
flag, a second Secret, a time-boxed window) was considered and
**not** built in Phase 8A, since it would add complexity for a
capability (disabling the route) that generic Secret rotation already
provides — rotating `SETUP_ADMIN_SECRET` to a value nobody has yet is
equivalent to disabling the endpoint, without any new code. If, after
the Phase 9 pilot, the operator judges the endpoint's attack surface not
worth keeping indefinitely, removing the route (deleting
`src/handlers/admin-bootstrap.ts`'s registration in `src/index.ts`) is a
small, explicit future change — noted here as a real option, not
designed further now, since it isn't needed yet.

## Webhook registration runbook (approval unit I)

**Not implemented as a runtime endpoint in this Worker** — see
`docs/security-and-privacy.md`, "Webhook registration strategy" for why.
Performed as a single manual, operator-run Telegram Bot API call, after
the Worker is deployed (unit H), Secrets are registered (units C, D),
and bootstrap has completed (unit G):

```sh
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<WORKER_URL>/telegram/webhook",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET_VALUE>",
    "allowed_updates": ["message"],
    "drop_pending_updates": true
  }'
```

- **`url`:** the deployed Worker's `/telegram/webhook` path — matches
  `src/index.ts`'s route exactly.
- **`secret_token`:** must exactly match the registered
  `TELEGRAM_WEBHOOK_SECRET` value, or every real delivery will be
  rejected 401 by `src/infrastructure/telegram/webhook-secret.ts`.
- **`allowed_updates: ["message"]`:** scopes Telegram's deliveries to
  the update type this bot's parser actually handles
  (`src/infrastructure/telegram/parse-update.ts` treats `channel_post`/
  `callback_query`/anything else as `unsupported` or drops it) — this
  reduces wasted webhook deliveries for update kinds the bot would
  immediately ignore anyway, without changing behavior (an unsupported
  update was already handled safely).
- **`drop_pending_updates: true` for this initial registration —
  recommended and used here.** Rationale: between bot creation (unit A)
  and this registration step, the bot could theoretically have received
  messages with no webhook yet configured to receive them (e.g. a
  stray message sent to it during setup, or Telegram's own internal
  retry queue from a misconfigured earlier attempt); dropping pending
  updates at the moment registration finally happens ensures the bot's
  very first real processed update is a message sent _after_ the bot is
  fully live, not a stale one processed out of context. This decision
  should be re-confirmed against Telegram's current `setWebhook`
  documentation at the time of actual registration (Phase 8B), since API
  behavior can evolve — if current behavior differs from this
  description, follow the current official documentation and update
  this section to match.
- No real request is sent by Phase 8A — this is a documented template
  only, to be filled in and run manually during Phase 8B, after its own
  explicit approval.

**Verification:** `curl
"https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"` —
confirms `url` matches the deployed Worker and `last_error_message` is
absent/empty. See "Post-deploy smoke checks" below for the full
post-registration check sequence.

## Post-deploy smoke checks

Run in this order, split by what's possible before vs. after webhook
registration (step numbers reference "First deployment order" above).
None of these are performed by Phase 8A — this section is the checklist
for Phase 8B/9.

**Before webhook registration (after steps 5, 7 — deploy and bootstrap):**

1. `GET https://<WORKER_URL>/health` → 200 with the documented JSON body
   — confirms the deploy itself succeeded.
2. `POST /admin/bootstrap` (already run in step 7) → 200
   `{"status":"ok","result":"bootstrap-complete"}`.
3. D1 (Dashboard or a read-only `wrangler d1 execute --remote`): the
   bootstrapped admin's `user_id` is present in `bot_admins`; the
   bootstrapped chat's row in `allowed_chats` has `enabled = 1`.
4. D1: `wrangler d1 migrations list <database-name> --remote` shows
   `0001`–`0004` all applied, nothing pending.

**After webhook registration (step 9):**

5. `GET
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo` →
   `url` matches the deployed Worker's `/telegram/webhook`, and
   `last_error_message` is absent/empty.
6. `/status` in the real pilot chat → the expected bot response,
   confirming the full webhook → allowlist → command-path round trip.
7. A JA message in the pilot chat → a PT-BR translation reply.
8. A PT-BR message in the pilot chat → a JA translation reply.
9. A message in a third, untargeted language → no reply (a safe,
   silent skip — `ignored:untargeted-language`), confirming the
   skip-if-untargeted behavior works against real Telegram/OpenAI
   traffic, not just mocks.
10. Any command (e.g. `/help`) → confirm, via the OpenAI Platform usage
    dashboard or the D1 `rate_limit_counters` `chat_openai` scope, that
    it did **not** increase OpenAI usage — the command/translation
    isolation this repository's tests already assert, now confirmed
    against real traffic once, per `docs/architecture.md`, "A command
    message never invokes OpenAI".

Steps 7–10 are real, live OpenAI/Telegram traffic and real (small)
OpenAI cost — they are Phase 9 pilot activity, not something to automate
or repeat routinely; a single pass after each of the (rare) redeploys
that touch the translation or command path is enough.

## `/status`

**Implemented (Phase 6):** `/status` is the primary in-Telegram
operational check: confirms the bot is enabled for the current chat and
surfaces the caller's own effective settings and a correction count —
see `src/commands/responses.ts` `formatStatusReply`. Not runnable
against a real chat yet (no bot is deployed); treat it as the first
thing to run once it is (see "Post-deploy smoke checks" above, step 6).

## Incident triage order (future)

Once deployed, the suggested order for investigating a reported problem:

1. Cloudflare Dashboard → Worker → Logs/Observability for recent errors —
   each request logs exactly one structured JSON line (Phase 7, see
   "Reliability and rate/usage limits" below) with `event`, `outcome`,
   `status`, `durationMs`, and (when relevant) `chatId`/`errorClass`/
   `limitType` — never message text or Secrets, so it's safe to read
   directly in the dashboard without redaction. The bootstrap endpoint's
   own log lines never include `chatId`/`adminUserId` even here — see
   `docs/security-and-privacy.md`, "Log minimization".
2. `/status` in the affected Telegram chat.
3. Cloudflare Dashboard → D1 → check `allowed_chats` for an unexpected
   disabled state, `bot_admins` for an unexpected authorization denial,
   or `rate_limit_counters`/`openai_daily_usage` for an unexpected
   rate/usage block (see "Reliability and rate/usage limits" below).
4. OpenAI Platform usage dashboard, if translations are failing or slow.
5. Telegram webhook info (`getWebhookInfo`) if the bot appears completely
   unresponsive.

This list still can't be exercised against real traffic (no Worker is
deployed yet) — right now it's a placeholder for the intended shape, now
backed by real structured logging and D1 counter tables once Phase 8B
deploys them.

## Reliability and rate/usage limits (Phase 7)

**Implemented, not yet operable against real traffic** (same caveat as
the rest of this document — no Worker is deployed).

**Config values**, all non-secret `wrangler.jsonc` `vars` (never
Secrets — they're operational tuning knobs, not credentials):

| Var                                       | Default | What it limits                                                                           |
| ----------------------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| `MAX_HANDLED_UPDATES_PER_CHAT_PER_MINUTE` | 60      | Commands + ordinary text combined, per allowlisted chat, per UTC minute                  |
| `MAX_OPENAI_ATTEMPTS_PER_CHAT_PER_MINUTE` | 20      | Real OpenAI HTTP attempts (incl. retries), per chat, per UTC minute                      |
| `MAX_OPENAI_ATTEMPTS_PER_DAY`             | 300     | Real OpenAI HTTP attempts (incl. retries), whole bot, per UTC day                        |
| `MAX_GEMINI_ATTEMPTS_PER_MINUTE`          | 12      | Real Gemini HTTP attempts, whole bot (global, not per-chat), per UTC minute (Phase 9.1B) |
| `MAX_GEMINI_ATTEMPTS_PER_DAY`             | 450     | Real Gemini HTTP attempts, whole bot, per UTC day (Phase 9.1B)                           |

These were chosen as family-scale-appropriate safe defaults without any
real production usage data (Phase 9's pilot is the first time real usage
patterns will exist) — see `docs/implementation-plan.md` Phase 7. The
two Gemini ceilings (Phase 9.1B) are additionally chosen to sit below
the project's observed 15 RPM / 500 RPD free-tier Gemini quota on
2026-08-25 (`docs/phase9-provider-plan.md`), leaving headroom rather
than claiming a billing guarantee — moot until `GEMINI_ESCALATION_ENABLED`
is ever set to `true` in production, which it is not.

**Ceiling behavior:** exceeding any of the three responds 200 to
Telegram (never a visible error to the family group — no reply is sent
either way) and keeps the update's dedupe reservation, so nothing is
silently lost: a Telegram redelivery of the same update is just a
duplicate, and the _next_ distinct message from that chat is evaluated
against the limit fresh. The per-minute limits recover automatically
within a minute; the daily ceiling recovers at the next UTC day boundary
— there is no manual "reset the counter" operation, but see "Tuning"
below for changing the limit itself.

**What's visible in Workers Logs:** only the structured, field-
allowlisted log line described in `docs/architecture.md`, "Structured
logging" — for a rate/usage block specifically: `event`, `outcome`
(`ignored:rate-limited`, `ignored:usage-limit`, or — for an exhausted
Gemini budget, Phase 9.1B — `ignored:escalation-unavailable`),
`status: 200`, `limitType` (`chat-updates`, `chat-openai`,
`openai-daily`, or — Phase 9.1B — `gemini-minute`/`gemini-daily`), and
`chatId` when the limit is per-chat (Gemini's limits are global, so no
`chatId` is logged for them). Never message text, never which specific
command or translation was blocked beyond that.

**Operator behavior when a ceiling is hit:** for the per-chat limits, no
action is normally needed — they're designed to recover within a minute
on their own. If `openai-daily` is being hit repeatedly (visible as
repeated `ignored:usage-limit` log lines, or by querying
`openai_daily_usage` in the D1 dashboard), that's a signal the daily
ceiling may be too low for actual usage (or, conversely, that something
is generating unexpectedly high traffic and the ceiling is doing its
job) — inspect which chat(s) are driving it via `rate_limit_counters`'
`chat_openai` scope before deciding whether to raise the ceiling or
investigate the traffic source.

**Tuning the Phase 7 limits:** change the relevant value in
`wrangler.jsonc`'s `vars` and deploy (`wrangler deploy`) — no D1
migration, no code change, no Secret rotation. Since these vars are
validated by `validateReliabilityConfig()`
(`src/config/reliability-config.ts`) as positive integers, an invalid
edit fails closed (500 on every request) rather than silently defaulting
— test any change against local `wrangler dev` first. Do this only after
Phase 9's pilot produces real usage data to tune against; there is no
reason to change the initial defaults before then.

## Secret rotation (summary)

Every Secret's specific rotation procedure is documented per-Secret in
"Secret registration runbook" above (their revoke sources and any
ordering constraints differ — `TELEGRAM_WEBHOOK_SECRET` in particular
must be rotated together with a `setWebhook` re-call, unlike the other
three). Common to all four: rotation never requires a code change — only
`wrangler secret put <NAME>` with the new value, and (for
`TELEGRAM_WEBHOOK_SECRET`) the matching `setWebhook` re-call.

## Emergency stop

Three levels, from narrowest to broadest blast radius — pick the
narrowest one that actually addresses the problem:

- **Per-chat (narrowest):** `/disable` (**implemented, Phase 6** —
  admin-only, `src/application/execute-command.ts`) sets
  `allowed_chats.enabled = 0` for one chat via `setAllowedChatEnabled`,
  without affecting any other chat. Use this when the problem is
  isolated to one group (e.g. unexpected/unwanted usage in that chat
  specifically). Not runnable against a real chat yet (no bot is
  deployed).
- **Full inbound stop (broadest, fastest to take effect):** delete the
  Telegram webhook registration —
  `curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/deleteWebhook"`
  — this is the single fastest way to stop **all** inbound Telegram
  traffic to the Worker, regardless of per-chat `allowed_chats` state,
  since Telegram simply stops delivering updates at all. Use this for
  "something is actively wrong and I need it to stop right now" —
  e.g. runaway cost, a suspected bug causing bad replies, or a Secret
  suspected compromised. Re-registering afterward is "Webhook
  registration runbook" above, run again.
- **Alternative full-stop lever — rotate/remove `TELEGRAM_WEBHOOK_SECRET`:**
  rotating the Secret to a new value the Worker has but Telegram's
  webhook registration doesn't yet (i.e. rotating the Worker's Secret
  _without_ immediately re-calling `setWebhook`, deliberately breaking
  the usual same-turn rotation ordering in "Secret registration
  runbook") also stops all inbound traffic, since every real delivery
  then fails the 401 check. `deleteWebhook` above is preferred — it's a
  single explicit action with an unambiguous state (`getWebhookInfo`
  shows no URL), rather than a Secret mismatch that has to be
  remembered and later reconciled.
- **Data removal is a separate, distinct operation** — none of the three
  levers above deletes any stored data (`speaker_profiles`,
  `speaker_preferences`, `translation_corrections`); they only stop
  future processing. Deleting a specific user's data uses `/forgetme
confirm` (already implemented, Phase 6) or a direct D1 operation for
  chat-wide/admin-initiated removal — neither is triggered automatically
  by an emergency stop.

## Auto-deploy (not implemented; documented for the future)

A GitHub → Cloudflare auto-deploy workflow (deploy on every push to
`main`, or on a tag) is **not implemented**, per
`docs/implementation-plan.md` Phase 8's "design only, or implement if
explicitly approved" framing. Reasoning: before Phase 9's pilot, a push
to `main` must never silently become a production deploy — this
repository develops directly on `main`
(`docs/project-rules.md`, "Git workflow"), so an auto-deploy workflow
would turn every routine commit into a deploy. Manual `wrangler deploy`
(approval unit H, run explicitly per "Worker deployment runbook" above)
is the only deploy path through at least Phase 9. `.github/workflows/ci.yml`
continues to run only `npm ci && npm run check` — no Cloudflare
credentials, no deploy step (see "GitHub Actions" above) — and no
Cloudflare Secret has been added to this repository's GitHub Actions
configuration. If auto-deploy is revisited after the pilot, it should be
scoped to a deliberate trigger (e.g. a release tag, not every `main`
push) and proposed as its own explicit-approval change at that time —
not implemented speculatively now.
