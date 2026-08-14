import { PermanentUpstreamError, TransientUpstreamError } from "../../shared/errors";

/**
 * Low-level Telegram Bot API request mechanics: URL/token handling,
 * timeout, HTTP-status and response-envelope classification. Per-method
 * request bodies and result shapes (e.g. sendMessage) live in their own
 * modules and call `callTelegramApi` — see ./send-message.ts.
 *
 * Response envelope per the Telegram Bot API docs: every response is
 * `{ ok: boolean, result?, error_code?: number, description?: string }`.
 * `ok: false` is never treated as success even when the HTTP status is
 * 200. Never logs or embeds the bot token or raw API response in an
 * error — the token lives only in the request URL and is never surfaced.
 */

const TELEGRAM_API_BASE = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface TelegramApiCallOptions {
  readonly botToken: string;
  /** Injectable for tests — defaults to the global `fetch`. Never called against the real Telegram API in tests. */
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export async function callTelegramApi(
  method: string,
  body: Record<string, unknown>,
  options: TelegramApiCallOptions,
): Promise<unknown> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${TELEGRAM_API_BASE}/bot${options.botToken}/${method}`;

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new TransientUpstreamError(`Telegram API request to ${method} timed out`, "telegram");
    }
    throw new TransientUpstreamError(
      `Telegram API request to ${method} failed before a response was received`,
      "telegram",
    );
  }

  if (isTransientStatus(response.status)) {
    throw new TransientUpstreamError(
      `Telegram API responded with HTTP ${response.status} for ${method}`,
      "telegram",
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new PermanentUpstreamError(
      `Telegram API returned a non-JSON response for ${method}`,
      "telegram",
    );
  }

  if (!isRecord(payload) || typeof payload.ok !== "boolean") {
    throw new PermanentUpstreamError(
      `Telegram API returned a malformed response for ${method}`,
      "telegram",
    );
  }

  if (!payload.ok) {
    const errorCode = typeof payload.error_code === "number" ? payload.error_code : response.status;
    if (isTransientStatus(errorCode)) {
      throw new TransientUpstreamError(
        `Telegram API rejected ${method} with a transient error`,
        "telegram",
      );
    }
    throw new PermanentUpstreamError(`Telegram API rejected ${method}`, "telegram");
  }

  return payload.result;
}
