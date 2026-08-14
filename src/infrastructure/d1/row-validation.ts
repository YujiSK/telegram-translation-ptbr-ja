import { PermanentUpstreamError } from "../../shared/errors";

export function invalidD1Row(entity: string): PermanentUpstreamError {
  return new PermanentUpstreamError(`D1 returned an invalid ${entity} row`, "d1");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
