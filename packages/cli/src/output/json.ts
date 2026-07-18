import type { CliExitCode } from "@hunter-harness/contracts";

export interface CliResult {
  schema_version: 1 | 2;
  command: "configure" | "update" | "push" | "refresh" | "cleanup";
  request_id: string;
  dry_run: boolean;
  ok: boolean;
  exit_code: CliExitCode;
  project_id: string | null;
  summary: Record<string, number>;
  items: unknown[];
  warnings: unknown[];
  errors: unknown[];
  /** refresh 专用：per-agent identity + freshness 六态（task 12/RET-29..33）。 */
  freshness?: unknown[];
}

export function serializeCliResult(result: CliResult): string {
  return JSON.stringify(result) + "\n";
}
