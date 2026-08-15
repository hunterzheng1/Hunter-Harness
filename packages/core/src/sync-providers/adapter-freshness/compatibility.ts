import { deepFreeze } from "../../sync-maintenance/index.js";
import { isProxy } from "node:util/types";
import { normalizeAdapterFreshnessReport } from "./provider.js";
import type { AdapterFreshnessSyncProviderReadResult } from "./types.js";

const legacyStatuses = new Set(["OK", "ADVISORY", "WARN", "FAIL", "BLOCKED", "UNKNOWN"]);

function version(value: unknown): number | undefined {
  try {
    if (value === null || typeof value !== "object" || isProxy(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, "schema_version");
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "number"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

export function readAdapterFreshnessSyncProviderFixture(
  value: unknown
): AdapterFreshnessSyncProviderReadResult {
  const schemaVersion = version(value);
  if (schemaVersion === undefined) {
    return deepFreeze({ ok: false, reason_code: "ADAPTER_FRESHNESS_RECORD_INVALID" });
  }
  if (schemaVersion === 1) {
    const report = normalizeAdapterFreshnessReport(value);
    return report === undefined
      ? deepFreeze({ ok: false, reason_code: "ADAPTER_FRESHNESS_RECORD_INVALID" })
      : deepFreeze({ ok: true, source_schema_version: 1, report });
  }
  if (schemaVersion === 0) {
    let status: unknown;
    try {
      const descriptor = value !== null && typeof value === "object"
        ? Object.getOwnPropertyDescriptor(value, "status")
        : undefined;
      status = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
    } catch {
      status = undefined;
    }
    if (!legacyStatuses.has(status as string)) {
      return deepFreeze({ ok: false, reason_code: "ADAPTER_FRESHNESS_RECORD_INVALID" });
    }
    return deepFreeze({
      ok: true,
      source_schema_version: 0,
      readiness: "legacy_read_only",
      legacy: {
        status: status as "OK" | "ADVISORY" | "WARN" | "FAIL" | "BLOCKED" | "UNKNOWN",
        input_hash: null,
        report_path: null,
        report_sha256: null
      },
      reason_codes: ["ADAPTER_FRESHNESS_LEGACY_REINSPECTION_REQUIRED"]
    });
  }
  return deepFreeze({
    ok: false,
    reason_code: "ADAPTER_FRESHNESS_RECORD_VERSION_UNSUPPORTED"
  });
}
