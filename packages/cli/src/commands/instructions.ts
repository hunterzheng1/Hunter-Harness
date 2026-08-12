import {
  applyInstructionProposal,
  auditProjectInstructions,
  InstructionProposalError,
  pushProject,
  PushWorkflowError
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
    let remoteSync: {
      status: "uploaded" | "unchanged" | "deferred";
      submitted: number;
      reason_code: string | null;
    };
    try {
      const pushed = await pushProject({
        projectRoot: dependencies.cwd,
        resourcesRoot: dependencies.resourcesRoot,
        env: dependencies.env,
        dryRun: false,
        fetch: dependencies.fetch
      });
      remoteSync = {
        status: "noChanges" in pushed && pushed.noChanges ? "unchanged" : "uploaded",
        submitted: pushed.preview.operations.length,
        reason_code: null
      };
    } catch (error) {
      remoteSync = {
        status: "deferred",
        submitted: 0,
        reason_code: error instanceof PushWorkflowError
          ? error.code
          : "MANAGED_SNAPSHOT_UPLOAD_FAILED"
      };
    }
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
      rule_candidates_applied: false,
      remote_sync: remoteSync
    };
    dependencies.stdout(options.json === true
      ? JSON.stringify(output) + "\n"
      : `已应用文档提案 ${result.proposal.proposal_id}，规则候选仍待人工评审。\n` +
        (remoteSync.status === "uploaded"
          ? `已同步 ${remoteSync.submitted} 个受控文档到平台。\n`
          : remoteSync.status === "unchanged"
            ? "平台上的受控文档已经是最新版本。\n"
            : `平台同步待重试（${remoteSync.reason_code ?? "未知原因"}）；本地应用结果不受影响。\n`));
    return 0;
  } catch (error) {
    return failure("instructions apply", error, options.json === true, dependencies);
  }
}
