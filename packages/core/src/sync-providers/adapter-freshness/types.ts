import type { FreshnessReport } from "../../project/refresh.js";
import type { SyncContext } from "../../sync-maintenance/index.js";

/** Trusted read-only seam around the canonical `collectFreshness()` reader. */
export interface AdapterFreshnessCollectorPort {
  collect(context: SyncContext): FreshnessReport | Promise<FreshnessReport>;
}

export interface AdapterFreshnessSyncProviderInput {
  readonly freshness_collector: AdapterFreshnessCollectorPort;
}

export type AdapterFreshnessSyncProviderReadResult =
  | { readonly ok: true; readonly source_schema_version: 1; readonly report: FreshnessReport }
  | {
    readonly ok: true;
    readonly source_schema_version: 0;
    readonly readiness: "legacy_read_only";
    readonly legacy: {
      readonly status: "OK" | "ADVISORY" | "WARN" | "FAIL" | "BLOCKED" | "UNKNOWN";
      readonly input_hash: null;
      readonly report_path: null;
      readonly report_sha256: null;
    };
    readonly reason_codes: readonly ["ADAPTER_FRESHNESS_LEGACY_REINSPECTION_REQUIRED"];
  }
  | {
    readonly ok: false;
    readonly reason_code:
      | "ADAPTER_FRESHNESS_RECORD_INVALID"
      | "ADAPTER_FRESHNESS_RECORD_VERSION_UNSUPPORTED";
  };
