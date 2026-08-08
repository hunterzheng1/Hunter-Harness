import {
  applyInstructionProposal,
  auditProjectInstructions,
  InstructionProposalError
} from "@hunter-harness/core";

import type { CommandDependencies } from "./configure.js";

export interface InstructionAuditOptions {
  serverUrl?: string;
  tokenEnv?: string;
  json?: boolean;
}

export interface InstructionApplyOptions {
  proposal: string;
  yes?: boolean;
  json?: boolean;
}

function failure(
  command: string,
  error: unknown,
  json: boolean,
  dependencies: CommandDependencies
): number {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof InstructionProposalError
    ? error.code
    : "INSTRUCTION_OPERATION_FAILED";
  const exitCode = error instanceof InstructionProposalError ? error.exitCode : 1;
  dependencies.stderr(message + "\n");
  if (json) {
    dependencies.stdout(JSON.stringify({
      schema_version: 1,
      command,
      ok: false,
      exit_code: exitCode,
      errors: [{ code, message }],
      warnings: []
    }) + "\n");
  }
  return exitCode;
}

export async function runInstructionAudit(
  options: InstructionAuditOptions,
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
    const output = {
      schema_version: 1,
      command: "instructions audit",
      ok: true,
      exit_code: 0,
      proposal_id: result.proposal.proposal_id,
      proposal_path: result.proposalPath,
      language: result.proposal.language,
      applied: false,
      finding_count: result.proposal.findings.length,
      file_count: result.proposal.files.length,
      rule_candidate_count: result.proposal.rule_candidates.length,
      files: result.proposal.files.map((file) => ({
        path: file.path,
        operation: file.operation,
        base_content_sha256: file.base_content_sha256,
        content_sha256: file.content_sha256
      })),
      findings: result.proposal.findings,
      rule_candidates: result.proposal.rule_candidates,
      basis: result.proposal.basis,
      request_id: result.proposal.request_id
    };
    dependencies.stdout(options.json === true
      ? JSON.stringify(output) + "\n"
      : `已生成中文文档提案 ${result.proposal.proposal_id}：${result.proposalPath}\n` +
        `预览后运行 hunter-harness instructions apply --proposal "${result.proposalPath}" --yes\n`);
    return 0;
  } catch (error) {
    return failure("instructions audit", error, options.json === true, dependencies);
  }
}

export async function runInstructionApply(
  options: InstructionApplyOptions,
  dependencies: CommandDependencies
): Promise<number> {
  if (options.yes !== true) {
    dependencies.stderr("应用文档提案需要 --yes；请先审阅提案内容。\n");
    return 2;
  }
  try {
    const result = await applyInstructionProposal({
      projectRoot: dependencies.cwd,
      proposalPath: options.proposal
    });
    const output = {
      schema_version: 1,
      command: "instructions apply",
      ok: true,
      exit_code: 0,
      proposal_id: result.proposal.proposal_id,
      language: result.proposal.language,
      applied: true,
      receipt_path: result.receiptPath,
      transaction_id: result.transaction.transactionId,
      files: result.proposal.files.map((file) => file.path),
      rule_candidates_applied: false
    };
    dependencies.stdout(options.json === true
      ? JSON.stringify(output) + "\n"
      : `已应用文档提案 ${result.proposal.proposal_id}，规则候选仍待人工评审。\n`);
    return 0;
  } catch (error) {
    return failure("instructions apply", error, options.json === true, dependencies);
  }
}
