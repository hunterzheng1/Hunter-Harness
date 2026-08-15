import { deepFreeze } from "../../sync-maintenance/index.js";
import { instructionSyncProviderInternals } from "./provider.js";
import type { InstructionSyncProviderReadResult } from "./types.js";

function ownDataRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable;
  });
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

export function readInstructionSyncProviderFixture(input: unknown): InstructionSyncProviderReadResult {
  if (!ownDataRecord(input)) {
    return deepFreeze({ ok: false, reason_code: "INSTRUCTION_SYNC_RECORD_INVALID" });
  }
  if (input.schema_version === 1) {
    try {
      const normalized = instructionSyncProviderInternals.normalizeSnapshot(input);
      return deepFreeze({
        ok: true,
        source_schema_version: 1,
        snapshot: normalized.snapshot
      });
    } catch {
      return deepFreeze({ ok: false, reason_code: "INSTRUCTION_SYNC_RECORD_INVALID" });
    }
  }
  if (input.schema_version !== 0) {
    return deepFreeze({
      ok: false,
      reason_code: "INSTRUCTION_SYNC_RECORD_VERSION_UNSUPPORTED"
    });
  }
  if (!exactKeys(input, [
    "schema_version", "component", "status", "reason_code", "input_hash",
    "report_path", "report_sha256"
  ]) || input.component !== "rules" || input.status !== "ADVISORY" ||
      input.reason_code !== "INSTRUCTION_AUDIT_REQUIRED" || input.input_hash !== null ||
      input.report_path !== null || input.report_sha256 !== null) {
    return deepFreeze({ ok: false, reason_code: "INSTRUCTION_SYNC_RECORD_INVALID" });
  }
  return deepFreeze({
    ok: true,
    source_schema_version: 0,
    readiness: "legacy_read_only",
    legacy: {
      status: "ADVISORY",
      input_hash: null,
      report_path: null,
      report_sha256: null
    },
    reason_codes: ["INSTRUCTION_LEGACY_REINSPECTION_REQUIRED"]
  });
}

