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
 * on what it throws — Cloudflare's own documentation
 * (https://developers.cloudflare.com/workers-ai/platform/errors/)
 * describes failure *categories* (timeout, daily-allocation-exhausted,
 * out-of-capacity, invalid model, paid-plan-required) without a typed
 * exception shape this module can pattern-match structurally. The
 * classifier below inspects the caught error's `.message` for the
 * documented HTTP-equivalent statuses and internal codes; an
 * unrecognized failure shape is treated as permanent (fail closed —
 * see docs/project-rules.md's fail-safe philosophy) rather than guessed
 * to be safely retryable. Revisit this classifier if Workers AI ever
 * exposes a structured error type.
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

/** Cloudflare-documented transient signals: request timeout (408-equivalent), rate limiting/out-of-capacity (429), the daily-free-allocation-exhausted and out-of-capacity internal codes, and generic 5xx. */
const TRANSIENT_SIGNAL_PATTERN = /\b(408|429|500|502|503|504|3036|3040)\b/;
/** Cloudflare-documented permanent signals: bad request / invalid model / forbidden (paid-plan-required) / not found. */
const PERMANENT_SIGNAL_PATTERN = /\b(400|401|403|404|422)\b/;

function classifyWorkersAiError(error: unknown): TransientUpstreamError | PermanentUpstreamError {
  if (isAbortLikeError(error)) {
    return new TransientUpstreamError("Workers AI request timed out", "workers-ai");
  }
  const message = error instanceof Error ? error.message : "";
  if (TRANSIENT_SIGNAL_PATTERN.test(message)) {
    return new TransientUpstreamError("Workers AI responded with a transient error", "workers-ai");
  }
  if (PERMANENT_SIGNAL_PATTERN.test(message)) {
    return new PermanentUpstreamError("Workers AI rejected the request", "workers-ai");
  }
  return new PermanentUpstreamError(
    "Workers AI request failed with an unrecognized error",
    "workers-ai",
  );
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
