import type {
  EscalationReason,
  GeminiInteractionStatusForLog,
  UpstreamDiagnosticStage,
  UpstreamService,
} from "./errors";

/**
 * Phase 7 structured logging: a strict field allowlist, one JSON line per
 * call, and an injectable sink so tests can capture and assert on log
 * output instead of console output. Uses Cloudflare Workers' existing
 * `console.*` → Workers Logs pipeline (docs/operations.md) — no new
 * external logging service.
 *
 * Hard rule, no exceptions (docs/security-and-privacy.md, "Log
 * minimization"): `LogFields` has no field for message text, translated
 * text, reply-context text, command text, correction terms, display
 * names, prompts, raw OpenAI/Telegram responses, or Secret values — so
 * accidentally passing one is a type error, not a runtime discipline
 * problem. `errorClass` is a stable class name (e.g.
 * `"TransientUpstreamError"`), never `error.message` or a stack trace —
 * see `classifyError` below, which is the only sanctioned way to turn a
 * caught `unknown` into loggable fields.
 */

export type LogLimitType =
  "chat-updates" | "chat-openai" | "openai-daily" | "gemini-minute" | "gemini-daily";

/** Phase 9.1A/9.1B: which translation provider actually produced (or was selected for) this request's final outcome — a fixed enum, never a model ID or wire-format detail. For a Gemini-escalated translation this is "gemini", not "workers-ai" — see src/infrastructure/translation/router.ts's onFinalProviderSelected. */
export type LogProvider = "workers-ai" | "openai" | "gemini";

export interface LogFields {
  readonly event: string;
  readonly outcome?: string;
  readonly status: number;
  readonly durationMs: number;
  readonly updateId?: number;
  readonly chatId?: number;
  readonly errorClass?: string;
  readonly service?: UpstreamService;
  readonly limitType?: LogLimitType;
  readonly attempt?: number;
  readonly retryCount?: number;
  readonly provider?: LogProvider;
  /** Only ever a fixed enum reason (see EscalationReason) — never the model's own explanation text. */
  readonly escalationReason?: EscalationReason;
  /** Phase 9 (pilot incident diagnostics): which stage of an upstream call failed — see UpstreamDiagnosticStage. Never response content. */
  readonly stage?: UpstreamDiagnosticStage;
  /** A bare HTTP status code — never the response body. */
  readonly httpStatus?: number;
  /** Gemini's top-level interaction `status` — always one of the closed set in GeminiInteractionStatusForLog, never an arbitrary/unvalidated string. */
  readonly interactionStatus?: GeminiInteractionStatusForLog;
  /** A fixed literal identifying which API version path was called (e.g. "v1") — never a full URL. */
  readonly endpointVersion?: string;
  /** The configured, non-secret provider model id (e.g. GEMINI_MODEL's value) — never a model-generated string. */
  readonly model?: string;
}

export type LogSink = (line: string) => void;

function defaultSink(line: string): void {
  // eslint-disable-next-line no-console -- the sanctioned Workers Logs sink; every other call site must go through logStructuredEvent.
  console.log(line);
}

/** One JSON line per call — never message text, prompts, raw responses, or Secrets (see the module doc comment). */
export function logStructuredEvent(fields: LogFields, sink: LogSink = defaultSink): void {
  sink(JSON.stringify(fields));
}

/**
 * Phase 9.1B review note: this guard previously omitted "workers-ai"
 * (added to `UpstreamService` in Phase 9.1A but never added here), which
 * meant a Workers AI upstream error's `service` field silently never
 * reached the log. Fixed here alongside adding "gemini" for the same
 * reason — both are real `UpstreamService` members.
 */
function isUpstreamService(value: unknown): value is UpstreamService {
  return (
    value === "telegram" ||
    value === "openai" ||
    value === "d1" ||
    value === "workers-ai" ||
    value === "gemini"
  );
}

function isUpstreamDiagnosticStage(value: unknown): value is UpstreamDiagnosticStage {
  return (
    value === "request" ||
    value === "http" ||
    value === "interaction-status" ||
    value === "response-envelope" ||
    value === "structured-output" ||
    value === "logical-validation"
  );
}

function isGeminiInteractionStatusForLog(value: unknown): value is GeminiInteractionStatusForLog {
  return (
    value === "completed" ||
    value === "in_progress" ||
    value === "requires_action" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "incomplete" ||
    value === "missing" ||
    value === "unrecognized"
  );
}

/**
 * The only sanctioned way to turn a caught `unknown` error into loggable
 * fields — returns a stable class name, never `error.message` or a
 * stack trace (docs/project-rules.md rule 9). `service` is included only
 * for an `UpstreamServiceError` (`TransientUpstreamError`/
 * `PermanentUpstreamError`), which is the only error family that carries
 * one.
 */
export function classifyError(error: unknown): {
  errorClass: string;
  service?: UpstreamService;
  stage?: UpstreamDiagnosticStage;
  httpStatus?: number;
  interactionStatus?: GeminiInteractionStatusForLog;
} {
  if (!(error instanceof Error)) {
    return { errorClass: "UnknownError" };
  }
  const service = "service" in error ? error.service : undefined;
  if (!isUpstreamService(service)) {
    return { errorClass: error.name };
  }
  const stage =
    "stage" in error && isUpstreamDiagnosticStage(error.stage) ? error.stage : undefined;
  const httpStatus =
    "httpStatus" in error && typeof error.httpStatus === "number" ? error.httpStatus : undefined;
  const interactionStatus =
    "interactionStatus" in error && isGeminiInteractionStatusForLog(error.interactionStatus)
      ? error.interactionStatus
      : undefined;
  return {
    errorClass: error.name,
    service,
    ...(stage !== undefined ? { stage } : {}),
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(interactionStatus !== undefined ? { interactionStatus } : {}),
  };
}
