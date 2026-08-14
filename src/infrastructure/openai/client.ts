import { PermanentUpstreamError, TransientUpstreamError } from "../../shared/errors";

/**
 * Low-level OpenAI Responses API request mechanics: URL/auth handling,
 * timeout, capped transient-only retry, and HTTP-status/response-envelope
 * classification. Structured Output extraction and domain conversion
 * live in ./translate.ts, which calls `callOpenAiResponses`.
 *
 * Response envelope per the current OpenAI API reference: a successful
 * call returns a JSON object with (among other fields) an `output`
 * array; an unsuccessful call returns a non-2xx HTTP status with a JSON
 * body shaped `{ error: { message, type, code, ... } }`. Never logs or
 * embeds the API key, prompt, or raw response body in an error — the
 * key lives only in the Authorization header and is never surfaced.
 *
 * Retry/timeout values are named constants here, not scattered magic
 * numbers, and are all overridable per call via `OpenAiApiCallOptions`.
 */

const OPENAI_API_BASE = "https://api.openai.com/v1";
export const DEFAULT_OPENAI_TIMEOUT_MS = 15_000;
/** Initial attempt + 1 retry, per docs/implementation-plan.md Phase 4. */
export const DEFAULT_OPENAI_MAX_ATTEMPTS = 2;
export const DEFAULT_OPENAI_RETRY_DELAY_MS = 250;

export interface OpenAiApiCallOptions {
  readonly apiKey: string;
  /** Injectable for tests — defaults to the global `fetch`. Never called against the real OpenAI API in tests. */
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  /** Injectable retry-delay wait function so tests never actually sleep. Defaults to a real delay. */
  readonly waitFn?: (ms: number) => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

async function defaultWait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function performResponsesRequest(
  body: Record<string, unknown>,
  options: OpenAiApiCallOptions,
): Promise<unknown> {
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPENAI_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetchFn(`${OPENAI_API_BASE}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new TransientUpstreamError("OpenAI Responses API request timed out", "openai");
    }
    throw new TransientUpstreamError(
      "OpenAI Responses API request failed before a response was received",
      "openai",
    );
  }

  if (isTransientStatus(response.status)) {
    throw new TransientUpstreamError(
      `OpenAI Responses API responded with HTTP ${response.status}`,
      "openai",
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new PermanentUpstreamError("OpenAI Responses API returned a non-JSON response", "openai");
  }

  if (!response.ok) {
    throw new PermanentUpstreamError(
      `OpenAI Responses API rejected the request with HTTP ${response.status}`,
      "openai",
    );
  }

  if (!isRecord(payload)) {
    throw new PermanentUpstreamError(
      "OpenAI Responses API returned a malformed response",
      "openai",
    );
  }

  return payload;
}

/**
 * Calls the OpenAI Responses API with a bounded timeout and a capped,
 * transient-error-only retry (network failure, timeout, HTTP 429/5xx —
 * never a 4xx other than 429, never a JSON-parse or schema failure, per
 * docs/project-rules.md rule 7). A retried attempt is still the same
 * logical translation request, not a second one.
 */
export async function callOpenAiResponses(
  body: Record<string, unknown>,
  options: OpenAiApiCallOptions,
): Promise<unknown> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_OPENAI_MAX_ATTEMPTS;
  const waitFn = options.waitFn ?? defaultWait;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await performResponsesRequest(body, options);
    } catch (error) {
      const isLastAttempt = attempt >= maxAttempts;
      if (isLastAttempt || !(error instanceof TransientUpstreamError)) {
        throw error;
      }
      await waitFn(DEFAULT_OPENAI_RETRY_DELAY_MS);
    }
  }

  // Unreachable for maxAttempts >= 1 (every iteration returns or throws) —
  // satisfies TypeScript's control-flow analysis for the function's return type.
  throw new TransientUpstreamError("OpenAI Responses API retry loop exited unexpectedly", "openai");
}
