import { planningContextSchema } from "./schemas.js";
import { deepFreeze } from "./stable.js";
import type { PlanningContextReadResult } from "./types.js";

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

export function normalizePlanningContextRecord(input: unknown): PlanningContextReadResult {
  if (!record(input)) return { ok: false, reason_code: "PLANNING_CONTEXT_RECORD_INVALID" };
  if (input.schema_version === 0) {
    return Object.keys(input).length === 2 && typeof input.context_ref === "string" &&
      input.context_ref.length > 0
      ? deepFreeze({ ok: true, source_schema_version: 0, readiness: "legacy_read_only", legacy_ref: input.context_ref })
      : { ok: false, reason_code: "PLANNING_CONTEXT_RECORD_INVALID" };
  }
  if (input.schema_version !== 1) {
    return { ok: false, reason_code: input.schema_version === undefined
      ? "PLANNING_CONTEXT_RECORD_INVALID" : "PLANNING_CONTEXT_VERSION_UNSUPPORTED" };
  }
  const parsed = planningContextSchema.safeParse(input);
  return parsed.success
    ? deepFreeze({
      ok: true,
      source_schema_version: 1,
      readiness: "current",
      context: parsed.data
    })
    : { ok: false, reason_code: "PLANNING_CONTEXT_RECORD_INVALID" };
}
