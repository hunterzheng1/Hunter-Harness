import type { CliExitCode } from "@hunter-harness/contracts";

export interface CliResult {
  schema_version: 1 | 2;
  command:
    | "configure"
    | "update"
    | "push"
    | "pull"
    | "refresh"
    | "cleanup"
    | "rules-sync"
  | "rules-review"
  | "connect"
  | "events-sync";
  request_id: string;
  dry_run: boolean;
  ok: boolean;
  exit_code: CliExitCode;
  project_id: string | null;
  summary: Record<string, number | string>;
  items: unknown[];
  warnings: unknown[];
  errors: unknown[];
  /** Stage 03 Push/Pull receipt binding. */
  preview_hash?: string;
  outcome?: string;
  /** Blocked sensitive findings with their locations, so a caller can act. */
  security_scan?: {
    scanner_version: string;
    blocked: boolean;
    hard_blocked: boolean;
    review_required: boolean;
    findings: ReadonlyArray<{
      path: string;
      line: number;
      column: number;
      rule_id: string;
      severity: string;
      overridable: boolean;
    }>;
  };
  /** Guarded local mutation contract. */
  plan_hash?: string;
  recovery_id?: string | null;
  /** refresh 专用：per-agent identity + freshness 六态（task 12/RET-29..33）。 */
  freshness?: unknown[];
}

export function serializeCliResult(result: CliResult): string {
  return JSON.stringify(result) + "\n";
}
