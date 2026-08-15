export type AdapterFreshnessSyncProviderErrorCode =
  | "ADAPTER_FRESHNESS_REPORT_INVALID"
  | "ADAPTER_FRESHNESS_COLLECTOR_INVALID"
  | "ADAPTER_FRESHNESS_CONTEXT_MISMATCH"
  | "ADAPTER_FRESHNESS_READ_ONLY";

export class AdapterFreshnessSyncProviderError extends Error {
  readonly code: AdapterFreshnessSyncProviderErrorCode;

  constructor(code: AdapterFreshnessSyncProviderErrorCode) {
    super(code);
    this.name = "AdapterFreshnessSyncProviderError";
    this.code = code;
  }
}
