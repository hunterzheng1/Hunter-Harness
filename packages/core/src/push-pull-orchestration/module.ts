import { canonicalJson } from "@hunter-harness/contracts";

import { sha256Bytes } from "../fs/hash.js";
import type {
  ConflictDecision,
  SourceRef,
  SyncConfirmation,
  SyncPreview,
  SyncReceipt,
  SyncScope
} from "../remote-sync/index.js";
import { PushPullOrchestrationError } from "./errors.js";
import {
  deepFreeze,
  ordinaryRequestInvariant,
  pushPullPreviewOutcome,
  pushPullReceiptStatus
} from "./stable.js";
import type {
  PushPullDecisionInput,
  PushPullDecisionResult,
  PushPullDirection,
  PushPullDisplay,
  PushPullExecutionReceipt,
  PushPullInteractionInput,
  PushPullOrchestration,
  PushPullPreview,
  RemoteSyncDependency,
  UserSyncScope
} from "./types.js";

interface StoredPreview {
  direction: PushPullDirection;
  scopes: readonly Exclude<SyncScope, "archive">[];
  source_ref: SourceRef;
  remote: SyncPreview;
  projection: PushPullPreview;
}

interface StoredConfirmation {
  direction: PushPullDirection;
  scopes: readonly Exclude<SyncScope, "archive">[];
  source_ref: SourceRef;
  confirmation: SyncConfirmation;
}

function requireNonempty(value: string, code: "PUSH_PULL_INPUT_INVALID", message: string): void {
  if (value.trim() === "") throw new PushPullOrchestrationError(code, message);
}

function validateInput(input: PushPullInteractionInput): void {
  if (input.schema_version !== 1 ||
      (input.source_mode !== "current" && input.source_mode !== "explicit")) {
    throw new PushPullOrchestrationError("PUSH_PULL_INPUT_INVALID", "Push/Pull 交互输入无效");
  }
  requireNonempty(input.source_ref.project_id, "PUSH_PULL_INPUT_INVALID", "项目身份不能为空");
  requireNonempty(input.source_ref.branch_name, "PUSH_PULL_INPUT_INVALID", "分支身份不能为空");
  requireNonempty(input.source_ref.commit_sha, "PUSH_PULL_INPUT_INVALID", "提交身份不能为空");
  requireNonempty(input.source_ref.client_id, "PUSH_PULL_INPUT_INVALID", "客户端身份不能为空");
}

function normalizeScopes(
  direction: PushPullDirection,
  sourceMode: PushPullInteractionInput["source_mode"],
  requested: readonly UserSyncScope[] | undefined
): readonly Exclude<SyncScope, "archive">[] {
  const invariant = ordinaryRequestInvariant(direction, sourceMode, requested);
  if (!invariant.ok && invariant.reason_code === "source_required") {
    throw new PushPullOrchestrationError(
      "PUSH_PULL_SOURCE_REQUIRED", "恢复分支文件必须显式指定来源分支"
    );
  }
  if (!invariant.ok) {
    throw new PushPullOrchestrationError(
      "PUSH_PULL_SCOPE_INVALID", "普通 Push/Pull 不支持该同步范围"
    );
  }
  return invariant.scopes;
}

function previewDisplay(direction: PushPullDirection, preview: SyncPreview): PushPullDisplay {
  const action = direction === "push" ? "上传到 Hunter Platform" : "从 Hunter Platform 下拉";
  return {
    heading: direction === "push" ? "Push 预览" : "Pull 预览",
    summary: `${action}：${preview.operations.length} 个变更，${preview.conflicts.length} 个冲突。`,
    detail_lines: [
      `来源分支：${preview.source_ref.branch_name}`,
      `来源提交：${preview.source_ref.commit_sha}`,
      `远端基线：${preview.base_version ?? "无"}`
    ]
  };
}

function decisionDisplay(status: PushPullDecisionResult["status"]): PushPullDisplay {
  const summary = status === "confirmed" ? "已确认，可执行。"
    : status === "no_changes" ? "没有变化，无需执行。"
      : status === "review_required" ? "已暂停，请先检查冲突与敏感项。"
        : "已取消，未执行任何写入。";
  return { heading: "Push/Pull 确认", summary, detail_lines: [] };
}

function receiptDisplay(direction: PushPullDirection, receipt: SyncReceipt): PushPullDisplay {
  const summary = receipt.no_changes ? "没有变化，未创建空版本。"
    : receipt.reason_code === "SYNC_CANCELLED" ? "操作已取消。"
      : receipt.retryable.length > 0 ? `有 ${receipt.retryable.length} 项可重试。`
        : `已处理 ${receipt.applied.length} 项，跳过 ${receipt.skipped.length} 项。`;
  return { heading: direction === "push" ? "Push 结果" : "Pull 结果", summary, detail_lines: [] };
}

function projectPreview(
  direction: PushPullDirection,
  scopes: readonly Exclude<SyncScope, "archive">[],
  preview: SyncPreview
): PushPullPreview {
  return deepFreeze({
    schema_version: 1,
    direction,
    preview_hash: preview.preview_hash,
    source_ref: structuredClone(preview.source_ref),
    scopes: [...scopes],
    outcome: pushPullPreviewOutcome(preview),
    base_version: preview.base_version,
    remote_version: preview.remote_version === undefined ? undefined : { ...preview.remote_version },
    operations: preview.operations.map((item) => ({ ...item })),
    conflicts: preview.conflicts.map((item) => ({ ...item })),
    security_scan: structuredClone(preview.security_scan),
    display_zh: previewDisplay(direction, preview)
  });
}

export function createPushPullOrchestration(remoteSync: RemoteSyncDependency): PushPullOrchestration {
  const previews = new Map<string, StoredPreview>();
  const confirmations = new Map<string, StoredConfirmation>();

  async function build(
    direction: PushPullDirection,
    input: PushPullInteractionInput
  ): Promise<PushPullPreview> {
    validateInput(input);
    const scopes = normalizeScopes(direction, input.source_mode, input.scopes);
    const remote = direction === "push"
      ? await remoteSync.previewPush(scopes, input.source_ref)
      : await remoteSync.previewPull(scopes, input.source_ref);
    const projection = projectPreview(direction, scopes, remote);
    previews.set(projection.preview_hash, {
      direction,
      scopes,
      source_ref: structuredClone(input.source_ref),
      remote: structuredClone(remote),
      projection
    });
    return projection;
  }

  function decide(
    direction: PushPullDirection,
    preview_hash: string,
    input: PushPullDecisionInput
  ): PushPullDecisionResult {
    const stored = previews.get(preview_hash);
    if (stored === undefined || stored.direction !== direction) {
      throw new PushPullOrchestrationError("PUSH_PULL_PREVIEW_NOT_FOUND", "找不到对应方向的可信预览");
    }
    if (stored.projection.outcome === "no_changes") {
      return deepFreeze({
        schema_version: 1, status: "no_changes", direction, preview_hash,
        display_zh: decisionDisplay("no_changes")
      });
    }
    if (input.action === "review" || input.action === "stop") {
      const status = input.action === "review" ? "review_required" : "cancelled";
      return deepFreeze({
        schema_version: 1, status, direction, preview_hash, display_zh: decisionDisplay(status)
      });
    }
    requireNonempty(input.idempotency_key, "PUSH_PULL_INPUT_INVALID", "幂等键不能为空");
    if (stored.remote.security_scan.blocked && input.scan_overrides === undefined) {
      throw new PushPullOrchestrationError(
        "PUSH_PULL_SENSITIVE_CONFIRMATION_REQUIRED", "敏感项需要绑定当前预览的明确确认"
      );
    }
    const eligible = new Set([
      ...stored.remote.conflicts.map((item) => item.path),
      ...stored.remote.operations.filter((item) => item.action === "restore").map((item) => item.path)
    ]);
    const choices = new Map<string, PushPullDecisionInput["conflict_decisions"][number]>();
    for (const choice of input.conflict_decisions) {
      if (!eligible.has(choice.path) || choices.has(choice.path) ||
          !["keep_local", "accept_remote", "skip"].includes(choice.resolution)) {
        throw new PushPullOrchestrationError("PUSH_PULL_DECISION_REQUIRED", "冲突决策无效或重复");
      }
      choices.set(choice.path, choice);
    }
    if (stored.remote.conflicts.some((item) => !choices.has(item.path))) {
      throw new PushPullOrchestrationError("PUSH_PULL_DECISION_REQUIRED", "每个冲突都需要明确决策");
    }
    const decisions: ConflictDecision[] = input.conflict_decisions.map((choice) => {
      const restore = stored.remote.operations.some((item) =>
        item.action === "restore" && item.path === choice.path
      );
      if (restore && choice.resolution === "accept_remote" &&
          (choice.source_artifact_id === undefined || choice.source_project_version === undefined ||
           choice.source_artifact_id !== stored.remote.remote_version?.artifact_id ||
           choice.source_project_version !== stored.remote.remote_version?.project_version)) {
        throw new PushPullOrchestrationError(
          "PUSH_PULL_RESTORE_SOURCE_REQUIRED", "恢复必须绑定预览中的 artifact 和项目版本"
        );
      }
      return {
        path: choice.path,
        resolution: choice.resolution,
        expected_preview_hash: preview_hash,
        ...(choice.source_artifact_id === undefined ? {} : {
          source_artifact_id: choice.source_artifact_id
        }),
        ...(choice.source_project_version === undefined ? {} : {
          source_project_version: choice.source_project_version
        })
      };
    });
    const confirmation: SyncConfirmation = {
      preview_hash,
      idempotency_key: input.idempotency_key,
      conflict_decisions: decisions,
      ...(input.scan_overrides === undefined ? {} : {
        scan_confirmation: {
          expected_preview_hash: preview_hash,
          overrides: input.scan_overrides.map((item) => ({ ...item }))
        }
      })
    };
    const confirmation_id = `confirmation:${sha256Bytes(canonicalJson({
      direction, scopes: stored.scopes, source_ref: stored.source_ref, confirmation
    })).slice("sha256:".length)}`;
    confirmations.set(confirmation_id, {
      direction,
      scopes: stored.scopes,
      source_ref: stored.source_ref,
      confirmation
    });
    return deepFreeze({
      schema_version: 1,
      status: "confirmed",
      direction,
      preview_hash,
      confirmation_id,
      display_zh: decisionDisplay("confirmed")
    });
  }

  async function execute(
    direction: PushPullDirection,
    confirmation_id: string
  ): Promise<PushPullExecutionReceipt> {
    const stored = confirmations.get(confirmation_id);
    if (stored === undefined) {
      throw new PushPullOrchestrationError("PUSH_PULL_NOT_CONFIRMED", "执行前需要可信确认");
    }
    if (stored.direction !== direction) {
      throw new PushPullOrchestrationError("PUSH_PULL_DIRECTION_MISMATCH", "确认方向与执行方向不一致");
    }
    const receipt = direction === "push"
      ? await remoteSync.push(stored.scopes, stored.source_ref, stored.confirmation)
      : await remoteSync.pull(stored.scopes, stored.source_ref, stored.confirmation);
    if (receipt.preview_hash !== stored.confirmation.preview_hash) {
      throw new PushPullOrchestrationError(
        "PUSH_PULL_RECEIPT_INVALID", "执行收据与已确认预览不匹配"
      );
    }
    return deepFreeze({
      schema_version: 1,
      direction,
      preview_hash: receipt.preview_hash,
      status: pushPullReceiptStatus(receipt),
      sync_receipt: structuredClone(receipt),
      display_zh: receiptDisplay(direction, receipt)
    });
  }

  return {
    buildPushPreview: (input) => build("push", input),
    confirmPush: (preview_hash, decision) => decide("push", preview_hash, decision),
    executePush: (confirmation_id) => execute("push", confirmation_id),
    buildPullPreview: (input) => build("pull", input),
    resolvePull: (preview_hash, decision) => decide("pull", preview_hash, decision),
    executePull: (confirmation_id) => execute("pull", confirmation_id)
  };
}
