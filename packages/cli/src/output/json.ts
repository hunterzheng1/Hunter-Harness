import type { CliExitCode } from "@hunter-harness/contracts";

export interface CliResult {
  schema_version: 1;
  command: "configure" | "update" | "push";
  request_id: string;
  dry_run: boolean;
  ok: boolean;
  exit_code: CliExitCode;
  project_id: string | null;
  summary: Record<string, number>;
  items: unknown[];
  warnings: unknown[];
  errors: unknown[];
}

export function serializeCliResult(result: CliResult): string {
  return JSON.stringify(result) + "\n";
}
