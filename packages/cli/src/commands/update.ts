import { updateProject, UpdateWorkflowError, uuidV7 } from "@hunter-harness/core";

import type { CommandDependencies } from "./configure.js";
import { serializeCliResult, type CliResult } from "../output/json.js";

export interface UpdateOptions {
  serverUrl?: string;
  tokenEnv?: string;
  nonInteractive?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export async function runUpdate(
  options: UpdateOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const requestId = uuidV7();
  if (options.nonInteractive === true && options.yes !== true &&
      options.dryRun !== true) {
    dependencies.stderr("non-interactive update requires --yes\n");
    return 2;
  }
  const execute = async (dryRun: boolean) => updateProject({
    projectRoot: dependencies.cwd,
    ...(options.serverUrl === undefined ? {} : { serverUrl: options.serverUrl }),
    ...(options.tokenEnv === undefined ? {} : { tokenEnv: options.tokenEnv }),
    env: dependencies.env,
    dryRun,
    fetch: dependencies.fetch
  });
  try {
    let result;
    if (options.dryRun !== true && options.yes !== true &&
        options.nonInteractive !== true) {
      const preview = await execute(true);
      const answer = await dependencies.prompt(
        "Apply " + preview.applied.length + " eligible update items? [y/N]: "
      );
      if (!/^(?:y|yes)$/i.test(answer.trim())) {
        return 2;
      }
      result = await execute(false);
    } else {
      result = await execute(options.dryRun === true);
    }
    const applied = new Set(result.applied);
    const skippedByPath = new Map(result.skipped.map((item) => [item.path, item]));
    const items = result.operations.map((operation) => {
      const path = operation.operation === "rename" ? operation.to_path : operation.path;
      const skipped = skippedByPath.get(path);
      return {
        path,
        operation: operation.operation,
        file_kind: operation.file_kind,
        policy: "update",
        status: skipped !== undefined
          ? "skipped"
          : applied.has(path)
            ? options.dryRun === true ? "planned" : "applied"
            : "already-applied",
        reason: skipped?.reason ?? null,
        size_bytes: "size_bytes" in operation ? operation.size_bytes : 0
      };
    });
    const exitCode = result.skipped.length > 0 ? 5 : 0;
    const output: CliResult = {
      schema_version: 1,
      command: "update",
      request_id: requestId,
      dry_run: options.dryRun === true,
      ok: exitCode === 0,
      exit_code: exitCode,
      project_id: result.projectId,
      summary: {
        discovered: result.operations.length,
        applied: options.dryRun === true ? 0 : result.applied.length,
        planned: options.dryRun === true ? result.applied.length : 0,
        skipped: result.skipped.length
      },
      items,
      warnings: result.skipped,
      errors: []
    };
    dependencies.stdout(options.json === true
      ? serializeCliResult(output)
      : result.artifactId === null
        ? "No approved updates are available.\n"
        : "Update applied " + result.applied.length + " items; skipped " +
          result.skipped.length + ".\n");
    return exitCode;
  } catch (error) {
    const exitCode = error instanceof UpdateWorkflowError ? error.exitCode : 1;
    const message = error instanceof Error ? error.message : String(error);
    dependencies.stderr(message + "\n");
    if (options.json === true) {
      dependencies.stdout(serializeCliResult({
        schema_version: 1,
        command: "update",
        request_id: requestId,
        dry_run: options.dryRun === true,
        ok: false,
        exit_code: exitCode,
        project_id: null,
        summary: { discovered: 0, applied: 0, skipped: 0 },
        items: [],
        warnings: [],
        errors: [{
          code: error instanceof UpdateWorkflowError ? error.code : "GENERAL_FAILURE",
          message
        }]
      }));
    }
    return exitCode;
  }
}
