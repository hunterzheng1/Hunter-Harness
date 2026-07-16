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
  conflictStrategy?: "manual" | "keep-local" | "accept-remote";
  /** Repeatable `--resolve path=keep-local|accept-remote` */
  resolve?: string[];
}

function parseResolveOverrides(
  entries: readonly string[] | undefined
): Map<string, "keep-local" | "accept-remote"> {
  const map = new Map<string, "keep-local" | "accept-remote">();
  for (const entry of entries ?? []) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      throw new UpdateWorkflowError(
        "invalid --resolve value; expected path=keep-local|accept-remote",
        3,
        "RESOLVE_OPTION_INVALID"
      );
    }
    const path = entry.slice(0, eq).trim();
    const strategy = entry.slice(eq + 1).trim();
    if (path.length === 0 ||
        (strategy !== "keep-local" && strategy !== "accept-remote")) {
      throw new UpdateWorkflowError(
        "invalid --resolve value; expected path=keep-local|accept-remote",
        3,
        "RESOLVE_OPTION_INVALID"
      );
    }
    map.set(path, strategy);
  }
  return map;
}

export async function runUpdate(
  options: UpdateOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const requestId = uuidV7();
  if (options.nonInteractive === true && options.yes !== true &&
      options.dryRun !== true) {
    dependencies.stderr("非交互模式更新需要 --yes\n");
    return 2;
  }
  const resolveOverrides = parseResolveOverrides(options.resolve);
  const execute = async (dryRun: boolean) => updateProject({
    projectRoot: dependencies.cwd,
    ...(options.serverUrl === undefined ? {} : { serverUrl: options.serverUrl }),
    ...(options.tokenEnv === undefined ? {} : { tokenEnv: options.tokenEnv }),
    env: dependencies.env,
    dryRun,
    fetch: dependencies.fetch,
    ...(options.conflictStrategy === undefined
      ? {}
      : { conflictStrategy: options.conflictStrategy }),
    ...(resolveOverrides.size === 0 ? {} : { resolveOverrides })
  });
  try {
    let result;
    if (options.dryRun !== true && options.yes !== true &&
        options.nonInteractive !== true) {
      const preview = await execute(true);
      const answer = await dependencies.prompt(
        "应用 " + preview.applied.length + " 个可更新条目？[y/N]："
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
    const acknowledgedByPath = new Map(result.acknowledged.map((item) => [item.path, item]));
    const items = result.operations.map((operation) => {
      const path = operation.operation === "rename" ? operation.to_path : operation.path;
      const skipped = skippedByPath.get(path);
      const acknowledged = acknowledgedByPath.get(path);
      return {
        path,
        operation: operation.operation,
        file_kind: operation.file_kind,
        policy: "update",
        status: skipped !== undefined
          ? "skipped"
          : acknowledged !== undefined
            ? "acknowledged"
            : applied.has(path)
              ? options.dryRun === true ? "planned" : "applied"
              : "already-applied",
        reason: skipped?.reason ?? acknowledged?.reason ?? null,
        size_bytes: "size_bytes" in operation ? operation.size_bytes : 0
      };
    });
    const exitCode = result.conflicts.length > 0 ? 5 : 0;
    const output: CliResult = {
      schema_version: 2,
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
        acknowledged: result.acknowledged.length,
        resolved: result.resolvedKeepLocal.length + result.resolvedAcceptRemote.length,
        skipped: result.skipped.length
      },
      items,
      warnings: [...result.acknowledged, ...result.skipped],
      errors: []
    };
    dependencies.stdout(options.json === true
      ? serializeCliResult(output)
      : result.artifactId === null
        ? "没有可应用的已批准更新。\n"
        : "更新完成：已应用 " + result.applied.length + " 个条目，已确认 " +
          result.acknowledged.length + " 个，冲突 " + result.conflicts.length + " 个。\n");
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
