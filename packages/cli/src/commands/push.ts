import { pushProject, PushWorkflowError, uuidV7 } from "@hunter-harness/core";

import type { CommandDependencies } from "./configure.js";
import { serializeCliResult, type CliResult } from "../output/json.js";

export interface PushOptions {
  serverUrl?: string;
  tokenEnv?: string;
  nonInteractive?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  json?: boolean;
}

export async function runPush(
  options: PushOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const requestId = uuidV7();
  if (options.nonInteractive === true && options.yes !== true &&
      options.dryRun !== true) {
    dependencies.stderr("non-interactive push requires --yes\n");
    return 2;
  }
  try {
    const result = await pushProject({
      projectRoot: dependencies.cwd,
      ...(options.serverUrl === undefined ? {} : { serverUrl: options.serverUrl }),
      ...(options.tokenEnv === undefined ? {} : { tokenEnv: options.tokenEnv }),
      env: dependencies.env,
      dryRun: options.dryRun === true,
      fetch: dependencies.fetch,
      ...(options.yes === true || options.nonInteractive === true
        ? {}
        : { confirmProposal: async () => {
          const answer = await dependencies.prompt("Create this proposal? [y/N]: ");
          return /^(?:y|yes)$/i.test(answer.trim());
        } })
    });
    if ("cancelled" in result && result.cancelled === true) {
      return 2;
    }
    const items = result.preview.operations.map((operation) => ({
      path: operation.operation === "rename" ? operation.to_path : operation.path,
      operation: operation.operation,
      file_kind: operation.file_kind,
      status: options.dryRun === true ? "planned" : "submitted",
      reason: null,
      size_bytes: "size_bytes" in operation ? operation.size_bytes : 0,
      content_sha256: "content_sha256" in operation
        ? operation.content_sha256
        : operation.tombstone.previous_sha256
    }));
    const output: CliResult = {
      schema_version: 1,
      command: "push",
      request_id: requestId,
      dry_run: options.dryRun === true,
      ok: true,
      exit_code: 0,
      project_id: result.projectId,
      summary: {
        planned: result.preview.operations.length,
        submitted: options.dryRun === true ? 0 : result.preview.operations.length,
        skipped: result.preview.skipped.length,
        findings: result.preview.security.findings.length
      },
      items,
      warnings: result.preview.skipped,
      errors: []
    };
    dependencies.stdout(options.json === true
      ? serializeCliResult(output)
      : options.dryRun === true
        ? "Push preview contains " + items.length + " operations.\n"
        : "Proposal " + result.proposalId + " created.\n");
    return 0;
  } catch (error) {
    const exitCode = error instanceof PushWorkflowError ? error.exitCode : 1;
    const message = error instanceof Error ? error.message : String(error);
    dependencies.stderr(message + "\n");
    if (options.json === true) {
      dependencies.stdout(serializeCliResult({
        schema_version: 1,
        command: "push",
        request_id: requestId,
        dry_run: options.dryRun === true,
        ok: false,
        exit_code: exitCode,
        project_id: null,
        summary: { planned: 0, submitted: 0 },
        items: [],
        warnings: [],
        errors: [{
          code: error instanceof PushWorkflowError ? error.code : "GENERAL_FAILURE",
          message
        }]
      }));
    }
    return exitCode;
  }
}
