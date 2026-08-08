import {
  auditProjectInstructions,
  InstructionProposalError,
  uuidV7
} from "@hunter-harness/core";

import type { CommandDependencies } from "./configure.js";
import { serializeCliResult, type CliResult } from "../output/json.js";

/**
 * Backward-compatible command surface. Rule synchronization is now a
 * read-only audit that asks the server for a Chinese proposal. Project files
 * are changed only by the separate `instructions apply` confirmation step.
 */
export interface RulesSyncCommandOptions {
  agents?: string;
  codebuddySurface?: string;
  json?: boolean;
  learn?: boolean;
  serverUrl?: string;
  tokenEnv?: string;
}

export async function runRulesSync(
  options: RulesSyncCommandOptions,
  dependencies: CommandDependencies
): Promise<number> {
  try {
    const result = await auditProjectInstructions({
      projectRoot: dependencies.cwd,
      ...(options.serverUrl === undefined ? {} : { serverUrl: options.serverUrl }),
      ...(options.tokenEnv === undefined ? {} : { tokenEnv: options.tokenEnv }),
      env: dependencies.env,
      fetch: dependencies.fetch
    });
    const payload: CliResult = {
      schema_version: 1,
      command: "rules-sync",
      request_id: result.proposal.request_id || uuidV7(),
      dry_run: true,
      ok: true,
      exit_code: 0,
      project_id: result.proposal.project_id,
      summary: {
        mode: "audit-propose",
        language: result.proposal.language,
        proposal_id: result.proposal.proposal_id,
        proposal_path: result.proposalPath,
        proposed_files: result.proposal.files.length,
        findings: result.proposal.findings.length,
        rule_candidates: result.proposal.rule_candidates.length,
        applied: 0
      },
      items: result.proposal.files.map((file) => ({
        path: file.path,
        status: file.operation,
        content_sha256: file.content_sha256
      })),
      warnings: [
        "rules-sync 已改为兼容入口：只生成远端中文提案，不再注入标记块或直接改写规则。",
        `审阅后运行 hunter-harness instructions apply --proposal "${result.proposalPath}" --yes`
      ],
      errors: []
    };
    if (options.json === true) {
      dependencies.stdout(serializeCliResult(payload));
    } else {
      dependencies.stdout(
        `已生成中文规则与文档提案 ${result.proposal.proposal_id}：${result.proposalPath}\n` +
        `未修改项目文件；审阅后使用 instructions apply。\n`
      );
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof InstructionProposalError
      ? error.code
      : "INSTRUCTION_AUDIT_FAILED";
    const exitCode = error instanceof InstructionProposalError ? error.exitCode : 1;
    dependencies.stderr(message + "\n");
    if (options.json === true) {
      dependencies.stdout(serializeCliResult({
        schema_version: 1,
        command: "rules-sync",
        request_id: uuidV7(),
        dry_run: true,
        ok: false,
        exit_code: exitCode,
        project_id: null,
        summary: { mode: "audit-propose", applied: 0 },
        items: [],
        warnings: [],
        errors: [{ code, message }]
      }));
    }
    return exitCode;
  }
}
