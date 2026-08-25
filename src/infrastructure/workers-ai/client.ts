import { PermanentUpstreamError, TransientUpstreamError } from "../../shared/errors";

/**
 * Low-level Workers AI binding call mechanics: timeout and error
 * normalization. Structured Output extraction and domain conversion
 * live in ./translate.ts, which calls `callWorkersAiChat`. Mirrors
 * `infrastructure/openai/client.ts`'s split between low-level call
 * mechanics and response parsing.
 *
 * Only the `run` method is required from the real `Ai` binding
 * (`env.AI`, declared in the generated `worker-configuration.d.ts`) —
 * this narrower interface is what test doubles implement, so
 * `env.AI.run()` is never actually invoked by any automated test (see
 * the module doc comment in test/infrastructure/workers-ai/client.test.ts).
 *
 * Error classification is best-effort: unlike `fetch`, the generated
 * `Ai.run()` binding type does not expose a structured error code/status
 * on what it throws (the ambient `InferenceUpstreamError`/`AiInternalError`
 * types in `worker-configuration.d.ts` are bare `Error` extensions with no
 * additional fields, and both are interfaces — not runtime classes — so
 * there is nothing to `instanceof`-check against). Cloudflare's own
 * documentation (https://developers.cloudflare.com/workers-ai/platform/errors/)
 * describes failure *categories* (timeout, daily-allocation-exhausted,
 * out-of-capacity, invalid model, paid-plan-required) without a typed
 * exception shape this module can pattern-match structurally. The
 * classifier below inspects the caught error's `.message` for the
 * documented HTTP-equivalent statuses/wording of a deterministic
 * request/config problem and classifies only those as permanent;
 * everything else — a documented transient signal, common
 * network/transport wording, or a genuinely unrecognized failure shape —
 * is treated as transient (Phase 9.1A review hardening: prefer
 * retryability for an ambiguous call-layer failure, since keeping the
 * dedupe reservation for a failure that was actually transient would
 * permanently drop the message on Telegram's redelivery — see
 * docs/architecture.md, "Dedupe and retry after a transient failure").
 * This is deliberately the opposite default from a fail-closed
 * boundary-input validator: here, *not* classifying decisively as
 * permanent is the safe direction, because the alternative (wrongly
 * permanent) is unrecoverable data loss, not a retried no-op. A
 * **malformed but successfully-returned** model output is a completely
 * separate, still-permanent code path — see `./translate.ts`'s
 * `malformed()` helper, which this classifier never touches. Revisit
 * this classifier if Workers AI ever exposes a structured error type.
 */

const DEFAULT_WORKERS_AI_TIMEOUT_MS = 15_000;

/** The subset of the real `Ai` binding this module needs — see the module doc comment for why this is narrower than the full generated `Ai` class. */
export interface WorkersAiBinding {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<unknown>;
}

export interface WorkersAiApiCallOptions {
  readonly binding: WorkersAiBinding;
  readonly model: string;
  readonly timeoutMs?: number;
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/**
 * Cloudflare-documented permanent signals only — everything else falls
 * through to transient (see the module doc comment above for why). Two
 * complementary patterns: numeric HTTP-equivalent/internal codes, and
 * common wording for the same deterministic problem categories when a
 * code isn't present in the message. Documented codes: bad request
 * (400), unauthorized/forbidden (401/403 — includes paid-plan-required),
 * not found (404 — includes invalid/unknown model), unprocessable
 * request (422).
 */
const PERMANENT_SIGNAL_PATTERN = /\b(400|401|403|404|422)\b/;
const PERMANENT_WORDING_PATTERN =
  /invalid model|model not found|unauthoriz|unauthenticat|authentication failed|\bforbidden\b|invalid request|bad request|unsupported (request|model)|does not exist/i;

function classifyWorkersAiError(error: unknown): TransientUpstreamError | PermanentUpstreamError {
  if (isAbortLikeError(error)) {
    return new TransientUpstreamError("Workers AI request timed out", "workers-ai");
  }
  const message = error instanceof Error ? error.message : "";
  if (PERMANENT_SIGNAL_PATTERN.test(message) || PERMANENT_WORDING_PATTERN.test(message)) {
    return new PermanentUpstreamError("Workers AI rejected the request", "workers-ai");
  }
  // Everything else: a documented transient signal (408/429/5xx/3036/3040),
  // common network/transport/service-unavailable wording, or a failure
  // shape this module doesn't recognize at all (including a non-`Error`
  // thrown value, where `message` is empty) — all treated as transient,
  // per the module doc comment's "prefer retryability" policy.
  return new TransientUpstreamError("Workers AI responded with a transient error", "workers-ai");
}

/**
 * Calls the Workers AI binding once, bounded by a real `AbortSignal`
 * timeout (the binding's `AiOptions.signal`, the same mechanism `fetch`
 * uses — see docs/project-rules.md rule 6). This bounds the Worker
 * request's own latency; it does not itself claim to cancel
 * already-started provider-side compute. No retry here — Phase 9.1A
 * makes at most one logical Workers AI attempt per Telegram delivery,
 * since Telegram redelivery plus dedupe-release already provides a
 * retry layer for a transient failure (docs/architecture.md, "Dedupe
 * and retry after a transient failure").
 */
export async function callWorkersAiChat(
  inputs: Record<string, unknown>,
  options: WorkersAiApiCallOptions,
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKERS_AI_TIMEOUT_MS;

  try {
    return await options.binding.run(options.model, inputs, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw classifyWorkersAiError(error);
  }
}
