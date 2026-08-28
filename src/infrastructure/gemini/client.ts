import { PermanentUpstreamError, TransientUpstreamError } from "../../shared/errors";

/**
 * Low-level Gemini Interactions API request mechanics: URL/auth
 * handling, timeout, and HTTP-status/response-envelope classification.
 * Structured Output extraction and domain conversion live in
 * ./translate.ts, which calls `callGeminiInteraction`. Mirrors
 * `infrastructure/openai/client.ts`'s split between low-level call
 * mechanics and response parsing, but — per the Phase 9.1B task's
 * explicit scope — makes exactly **one** HTTP attempt per semantic
 * escalation, with no in-request retry: Telegram redelivery plus the
 * dedupe-release policy already provides a retry layer for a transient
 * failure (docs/architecture.md, "Dedupe and retry after a transient
 * failure"), same reasoning as the Workers AI adapter
 * (`src/infrastructure/workers-ai/client.ts`).
 *
 * Endpoint/request shape (Phase 9.1B implementation note — re-verify
 * against current official Google documentation before any live use;
 * outbound access to ai.google.dev was blocked in this sandboxed
 * implementation environment, so this could not be re-confirmed against
 * live docs at implementation time — see docs/phase9-provider-plan.md):
 * `POST https://generativelanguage.googleapis.com/v1/interactions`,
 * authenticated via the `x-goog-api-key` header (never a query
 * parameter), with a JSON body carrying `model`, `system_instruction`,
 * `input`, `response_format`, and — mandatorily, on every request, with
 * no exception — `store: false` (this Worker never uses Interactions API
 * server-side conversation state, `previous_interaction_id`, background
 * mode, streaming, tools, or grounding). `store: false` is enforced here
 * in the client itself, not merely by convention in the caller — see
 * below.
 */

/** Safe to log (a fixed literal, never derived from a response) — see docs/security-and-privacy.md, "Log minimization". */
export const GEMINI_API_VERSION = "v1";
const GEMINI_API_BASE = `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}`;
export const DEFAULT_GEMINI_TIMEOUT_MS = 15_000;

export interface GeminiApiCallOptions {
  readonly apiKey: string;
  /** Injectable for tests — defaults to the global `fetch`. Never called against the real Gemini API in tests. */
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** Cloudflare/Phase-9.1A-review-hardening-style transient classification: a request-timeout-equivalent (408), rate limiting (429), or any 5xx. */
function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Calls the Gemini Interactions API once, bounded by a real
 * `AbortSignal` timeout. `store: false` is force-set here — spread
 * *after* the caller's own body — so it is structurally impossible for
 * any caller (including a future one) to accidentally omit or override
 * it (Phase 9.1B, "Critical privacy requirement": "No exception").
 */
export async function callGeminiInteraction(
  body: Record<string, unknown>,
  options: GeminiApiCallOptions,
): Promise<unknown> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GEMINI_TIMEOUT_MS;
  const requestBody = { ...body, store: false };

  let response: Response;
  try {
    response = await fetchFn(`${GEMINI_API_BASE}/interactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": options.apiKey,
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isAbortLikeError(error)) {
      throw new TransientUpstreamError("Gemini Interactions API request timed out", "gemini", {
        stage: "request",
      });
    }
    // Phase 9.1A review-hardening reliability principle, applied here
    // from the start rather than retrofitted: an ambiguous network/
    // runtime failure before any response was received is never
    // positively identifiable as deterministic, so it defaults
    // transient — only a definite HTTP status below is ever permanent.
    throw new TransientUpstreamError(
      "Gemini Interactions API request failed before a response was received",
      "gemini",
      { stage: "request" },
    );
  }

  if (isTransientStatus(response.status)) {
    throw new TransientUpstreamError(
      `Gemini Interactions API responded with HTTP ${response.status}`,
      "gemini",
      { stage: "http", httpStatus: response.status },
    );
  }

  if (!response.ok) {
    // Every other non-2xx status — documented deterministic problems:
    // 400 invalid request/schema, 401 invalid key/authentication, 403
    // permission/billing/config issue, 404 invalid/missing model, 422 a
    // deterministic request-contract issue — never retryable.
    throw new PermanentUpstreamError(
      `Gemini Interactions API rejected the request with HTTP ${response.status}`,
      "gemini",
      { stage: "http", httpStatus: response.status },
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new PermanentUpstreamError(
      "Gemini Interactions API returned a non-JSON response",
      "gemini",
      { stage: "response-envelope", httpStatus: response.status },
    );
  }

  return payload;
}
