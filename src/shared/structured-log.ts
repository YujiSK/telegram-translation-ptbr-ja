import type { EscalationReason, UpstreamService } from "./errors";

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

export type LogLimitType = "chat-updates" | "chat-openai" | "openai-daily";

/** Phase 9.1A: which translation provider handled (or was selected for) this request — a fixed enum, never a model ID or wire-format detail. */
export type LogProvider = "workers-ai" | "openai";

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

function isUpstreamService(value: unknown): value is UpstreamService {
  return value === "telegram" || value === "openai" || value === "d1";
}

/**
 * The only sanctioned way to turn a caught `unknown` error into loggable
 * fields — returns a stable class name, never `error.message` or a
 * stack trace (docs/project-rules.md rule 9). `service` is included only
 * for an `UpstreamServiceError` (`TransientUpstreamError`/
 * `PermanentUpstreamError`), which is the only error family that carries
 * one.
 */
export function classifyError(error: unknown): { errorClass: string; service?: UpstreamService } {
  if (!(error instanceof Error)) {
    return { errorClass: "UnknownError" };
  }
  const service = "service" in error ? error.service : undefined;
  return isUpstreamService(service)
    ? { errorClass: error.name, service }
    : { errorClass: error.name };
}
