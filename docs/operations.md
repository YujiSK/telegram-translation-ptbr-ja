# Operations

Status: **Planning only.** This describes the operating model this project
is heading toward — a web-only workflow with no local machine dependency.
As of Phase 0, most of the actions below cannot be performed yet because
the underlying resources (Cloudflare Worker deployment, D1 database,
Telegram webhook) don't exist. Each section says explicitly what's not
possible yet.

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

## Not yet possible (as of Phase 4)

- Deploying to Cloudflare (`wrangler deploy`) — no production Worker
  exists yet.
- Registering a Telegram webhook — no bot exists yet, and no Secret is
  registered to verify it with.
- Rotating a Secret — none registered yet (the remote D1 database exists
  since Phase 2, but `OPENAI_API_KEY`/`TELEGRAM_WEBHOOK_SECRET`/
  `TELEGRAM_BOT_TOKEN` are not).
- Running `/status` in a real Telegram chat — no bot exists yet.
- Exercising the webhook boundary or the OpenAI translation pipeline
  against real traffic — both are implemented and tested locally against
  mocked Telegram/OpenAI responses (Phases 3–4), but nothing external
  points at either yet, and no real OpenAI API call has been made.

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

Once implemented (Phase 6), `/status` is the primary in-Telegram
operational check: confirms the bot is enabled for the current chat and
surfaces basic non-sensitive state. Treat it as the first thing to run
when something looks wrong, once it exists.

## Incident triage order (future)

Once deployed, the suggested order for investigating a reported problem:

1. Cloudflare Dashboard → Worker → Logs/Observability for recent errors.
2. `/status` in the affected Telegram chat.
3. Cloudflare Dashboard → D1 → check `bot_settings` / `allowed_chats` for
   an unexpected disabled state.
4. OpenAI Platform usage dashboard, if translations are failing or slow.
5. Telegram webhook info (`getWebhookInfo`) if the bot appears completely
   unresponsive.

This list will be revised once real logging/observability (Phase 7)
exists — right now it's a placeholder for the intended shape.

## Secret rotation (future)

When Secrets exist, rotation is: register the new value with `wrangler
secret put <NAME>` (overwrites in place), verify the Worker picks it up
(new Secrets take effect on next deployment/isolate restart per
Cloudflare's Secret model), then revoke the old value at the source
(Telegram BotFather / OpenAI Platform). No code change is required to
rotate a Secret's value.

## Stopping usage (future)

Two levels, once implemented:

- **Per-chat:** `/disable` (Phase 6) — stops the bot for one chat without
  affecting others.
- **Full stop:** remove/rotate `TELEGRAM_WEBHOOK_SECRET` or delete the
  webhook registration, which stops all inbound traffic regardless of
  per-chat settings. This is the "something is actively wrong" lever.
