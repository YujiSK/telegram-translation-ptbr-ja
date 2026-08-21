# Operations

Status: **Planning only.** This describes the operating model this project
is heading toward — a web-only workflow with no local machine dependency.
As of Phase 7, most of the actions below still cannot be performed
against real traffic, because the underlying external resources (Worker
deployment, Telegram bot, registered webhook) don't exist yet — only
their local-only code and D1 schema do. Each section says explicitly
what's not possible yet.

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

## Not yet possible (as of Phase 7)

- Deploying to Cloudflare (`wrangler deploy`) — no production Worker
  exists yet.
- Registering a Telegram webhook — no bot exists yet, and no Secret is
  registered to verify it with.
- Rotating a Secret — none registered yet (the remote D1 database exists
  since Phase 2, but `OPENAI_API_KEY`/`TELEGRAM_WEBHOOK_SECRET`/
  `TELEGRAM_BOT_TOKEN` are not).
- Running `/status` (or any command) in a real Telegram chat — no bot
  exists yet; the command surface is implemented and tested only against
  mocked Telegram calls and local D1.
- Registering a real admin in `bot_admins` — Phase 6 implements only the
  read path (`isBotAdmin`); there is no bootstrap route yet (Phase 8).
- Applying `migrations/0002_speaker_memory.sql`,
  `migrations/0003_commands.sql`, or `migrations/0004_reliability.sql` to
  the remote database — all three verified with `--local` only; a
  `--remote` apply is a Phase 8 action.
- Exercising the webhook boundary, the OpenAI translation pipeline,
  speaker memory, the command surface, or the Phase 7 rate/usage limits
  against real traffic — all are implemented and tested locally against
  mocked Telegram/OpenAI responses and local D1 (Phases 3–7), but nothing
  external points at any of it yet, and no real OpenAI/Telegram API call
  has been made. This means the initial rate/usage-limit values below are
  also untested against real usage patterns — see "Tuning the Phase 7
  limits" below.

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

## Webhook initial setup (future — Phase 8, not done)

When implemented, webhook registration will be a deliberate, explicit
step (likely a one-time authenticated setup endpoint or a manual
`setWebhook` call), gated behind `SETUP_ADMIN_SECRET`, and will not happen
automatically as part of deployment. This document will be updated with
the exact procedure when Phase 8 is implemented.

## `/status`

**Implemented (Phase 6):** `/status` is the primary in-Telegram
operational check: confirms the bot is enabled for the current chat and
surfaces the caller's own effective settings and a correction count —
see `src/commands/responses.ts` `formatStatusReply`. Not runnable
against a real chat yet (no bot is deployed); treat it as the first
thing to run once it is.

## Incident triage order (future)

Once deployed, the suggested order for investigating a reported problem:

1. Cloudflare Dashboard → Worker → Logs/Observability for recent errors —
   each request logs exactly one structured JSON line (Phase 7, see
   "Reliability and rate/usage limits" below) with `event`, `outcome`,
   `status`, `durationMs`, and (when relevant) `chatId`/`errorClass`/
   `limitType` — never message text or Secrets, so it's safe to read
   directly in the dashboard without redaction.
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
backed by real structured logging and D1 counter tables once Phase 8
deploys them.

## Reliability and rate/usage limits (Phase 7)

**Implemented, not yet operable against real traffic** (same caveat as
the rest of this document — no Worker is deployed).

**Config values**, all non-secret `wrangler.jsonc` `vars` (never
Secrets — they're operational tuning knobs, not credentials):

| Var                                       | Default | What it limits                                                          |
| ----------------------------------------- | ------- | ----------------------------------------------------------------------- |
| `MAX_HANDLED_UPDATES_PER_CHAT_PER_MINUTE` | 60      | Commands + ordinary text combined, per allowlisted chat, per UTC minute |
| `MAX_OPENAI_ATTEMPTS_PER_CHAT_PER_MINUTE` | 20      | Real OpenAI HTTP attempts (incl. retries), per chat, per UTC minute     |
| `MAX_OPENAI_ATTEMPTS_PER_DAY`             | 300     | Real OpenAI HTTP attempts (incl. retries), whole bot, per UTC day       |

These were chosen as family-scale-appropriate safe defaults without any
real production usage data (Phase 9's pilot is the first time real usage
patterns will exist) — see `docs/implementation-plan.md` Phase 7.

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
(`ignored:rate-limited` or `ignored:usage-limit`), `status: 200`,
`limitType` (`chat-updates`, `chat-openai`, or `openai-daily`), and
`chatId` when the limit is per-chat. Never message text, never which
specific command or translation was blocked beyond that.

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

## Secret rotation (future)

When Secrets exist, rotation is: register the new value with `wrangler
secret put <NAME>` (overwrites in place), verify the Worker picks it up
(new Secrets take effect on next deployment/isolate restart per
Cloudflare's Secret model), then revoke the old value at the source
(Telegram BotFather / OpenAI Platform). No code change is required to
rotate a Secret's value.

## Stopping usage

Two levels:

- **Per-chat:** `/disable` (**implemented, Phase 6** — admin-only,
  `src/application/execute-command.ts`) sets `allowed_chats.enabled = 0`
  for one chat via `setAllowedChatEnabled`, without affecting others.
  Not runnable against a real chat yet (no bot is deployed).
- **Full stop (future, Phase 8):** remove/rotate
  `TELEGRAM_WEBHOOK_SECRET` or delete the webhook registration, which
  stops all inbound traffic regardless of per-chat settings. This is the
  "something is actively wrong" lever.
