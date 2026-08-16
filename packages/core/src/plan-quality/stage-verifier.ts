import { createHash } from "node:crypto";

import { canonicalJson } from "@hunter-harness/contracts";

import type {
  PlanStageVerifierPort,
  StageVerificationEvidence,
  StagedPublicationEvidence
} from "./types.js";

/**
 * PlanStageVerifierPort 的生产实现（纯函数，无 IO）：
 * - 复核 input_hash 与 files_hash（防调用方篡改输入）；
 * - 逐个解析 staged 文件（markdown frontmatter + JSON body / 纯 JSON），
 *   重算 content_hash = sha256(canonicalJson({artifact_type, content}))，
 *   与文件内声明及 expected_content_hashes 三方一致才放行（fail closed）；
 * - readback_hash 语义按 plan-quality 模块冻结：等于 files_hash。
 */
export function createPlanStageVerifier(options: { now?: () => string } = {}): PlanStageVerifierPort {
  const now = options.now ?? (() => new Date().toISOString());

  const sha256 = (value: string): string => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
  const canonicalHash = (value: unknown): string => sha256(canonicalJson(value));

  function parseStagedFile(file: StagedPublicationEvidence["files"][number]): { artifact_type: string; content_hash: string; content: unknown } {
    if (file.format === "json") {
      const artifact = JSON.parse(file.serialized_content) as { artifact_type?: string; content_hash?: string; content?: unknown };
      if (typeof artifact.artifact_type !== "string" || typeof artifact.content_hash !== "string") {
        throw new Error("PLAN_STAGE_VERIFICATION_FILE_INVALID");
      }
      return { artifact_type: artifact.artifact_type, content_hash: artifact.content_hash, content: artifact.content };
    }
    const lines = file.serialized_content.split("\n");
    if (lines.length < 6 || lines[0] !== "---" || lines[4] !== "---" ||
        lines[1] !== "schema_version: 2" || !lines[2]?.startsWith("artifact_type: ") ||
        !lines[3]?.startsWith("content_hash: sha256:")) {
      throw new Error("PLAN_STAGE_VERIFICATION_FILE_INVALID");
    }
    const artifact = JSON.parse(lines.slice(5).join("\n")) as { artifact_type?: string; content_hash?: string; content?: unknown };
    if (lines[2] !== `artifact_type: ${String(artifact.artifact_type)}` ||
        lines[3] !== `content_hash: ${String(artifact.content_hash)}`) {
      throw new Error("PLAN_STAGE_VERIFICATION_FILE_INVALID");
    }
    return {
      artifact_type: String(artifact.artifact_type),
      content_hash: String(artifact.content_hash),
      content: artifact.content
    };
  }

  return Object.freeze({
    verify(input: Parameters<PlanStageVerifierPort["verify"]>[0]): StageVerificationEvidence {
      // 1) files_hash 复核
      const filesHash = canonicalHash(input.files);
      if (filesHash !== input.files_hash) throw new Error("PLAN_STAGE_VERIFICATION_INPUT_MISMATCH");
      // 2) 逐文件重算 content_hash，三方一致（重算 = 声明 = 期望）
      const expectedPaths = Object.keys(input.expected_content_hashes).sort();
      const stagedPaths = input.files.map((file) => file.path).sort();
      if (JSON.stringify(stagedPaths) !== JSON.stringify(expectedPaths)) {
        throw new Error("PLAN_STAGE_VERIFICATION_CONTENT_MISMATCH");
      }
      const contentHashes: Record<string, string> = {};
      for (const file of input.files) {
        const parsed = parseStagedFile(file);
        const recomputed = canonicalHash({ artifact_type: parsed.artifact_type, content: parsed.content });
        if (recomputed !== parsed.content_hash || recomputed !== input.expected_content_hashes[file.path]) {
          throw new Error("PLAN_STAGE_VERIFICATION_CONTENT_MISMATCH");
        }
        contentHashes[file.path] = recomputed;
      }
      // 3) 证据组装（readback_hash 语义 = files_hash，与模块冻结的校验一致）
      const body = {
        schema_version: 1 as const,
        stage_id: input.stage_id,
        input_hash: input.input_hash,
        files_hash: filesHash,
        content_hashes: contentHashes,
        approval_receipt_ref: input.approval_receipt_ref,
        artifact_derivation_receipt_refs: [...input.artifact_derivation_receipt_refs],
        atomic_publish_receipt: canonicalHash({ stage_id: input.stage_id, publication_intent_id: input.publication_intent_id, files_hash: filesHash }),
        readback_hash: filesHash,
        verified_at: now()
      };
      return Object.freeze({ ...body, evidence_hash: canonicalHash(body) });
    }
  });
}
