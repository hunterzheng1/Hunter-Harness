import { cleanupProject, uuidV7 } from "@hunter-harness/core";

import type { CommandDependencies } from "./configure.js";
import { serializeCliResult, type CliResult } from "../output/json.js";

export interface CleanupCommandOptions {
  nonInteractive?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export async function runCleanup(
  options: CleanupCommandOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const requestId = uuidV7();
  const dryRun = options.dryRun === true;
  if (options.nonInteractive === true && options.yes !== true && !dryRun) {
    dependencies.stderr("non-interactive cleanup requires --yes\n");
    return 2;
  }
  try {
    const result = await cleanupProject({ projectRoot: dependencies.cwd, dryRun });
    const output: CliResult = {
      schema_version: 1,
      command: "cleanup",
      request_id: requestId,
      dry_run: result.dry_run,
      ok: true,
      exit_code: 0,
      project_id: null,
      summary: {
        pruned_transactions: result.pruned_transactions.length,
        removed_cache: result.removed_cache.length
      },
      items: [
        ...result.pruned_transactions.map((id) => ({ path: id, status: "pruned" })),
        ...result.removed_cache.map((id) => ({ path: id, status: "removed" }))
      ],
      warnings: [],
      errors: []
    };
    if (options.json === true) {
      dependencies.stdout(serializeCliResult(output));
    } else {
      dependencies.stdout(
        `Harness cleanup: pruned ${result.pruned_transactions.length} transaction(s), ` +
        `removed ${result.removed_cache.length} cache entr(ies).\n`
      );
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.stderr(message + "\n");
    if (options.json === true) {
      dependencies.stdout(serializeCliResult({
        schema_version: 1,
        command: "cleanup",
        request_id: requestId,
        dry_run: dryRun,
        ok: false,
        exit_code: 1,
        project_id: null,
        summary: { pruned_transactions: 0, removed_cache: 0 },
        items: [],
        warnings: [],
        errors: [{ message }]
      }));
    }
    return 1;
  }
}
