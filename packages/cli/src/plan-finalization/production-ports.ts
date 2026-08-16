import { createHash } from "node:crypto";

import { canonicalJson, readPlanAttemptEventBundle } from "@hunter-harness/contracts";
import {
  planArtifactPublication,
  planDurablePublicationTargetPaths,
  type PlanArtifactPublicationPlan,
  type PlanDurablePublicationSha256,
  type PlanFinalizationQualityVerificationInput,
  type PlanFinalizationQualityVerificationProof,
  type PlanFinalizationQualityVerifierPort,
  type PlanFinalizationRendererPort,
  type PlanPublicationPathAuthorityPort,
  type TrustedPlanArtifactSet
} from "@hunter-harness/core";

const sha256 = (value: string): PlanDurablePublicationSha256 =>
  `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

const canonicalHash = (value: unknown): PlanDurablePublicationSha256 => sha256(canonicalJson(value));

/** 发布路径权威：ownership 必须恰为八 target 精确集合（T0-2）。 */
export function createPlanPublicationPathAuthority(): PlanPublicationPathAuthorityPort {
  return Object.freeze({
    verify(input: { change_key: string; paths: readonly string[] }): boolean {
      return input.paths.length === 8 && planDurablePublicationTargetPaths(input.change_key)
        .every((path, index) => input.paths[index] === path);
    }
  });
}

/** 生产 renderer：从 finalization evidence 的 quality_verification_input 取出可信产物集，
 * 委托冻结的 planArtifactPublication（纯 Module），路径权威为八 target 精确集合。
 *
 * 语义接缝说明（已记录偏离）：planArtifactPublication 的 plan.ownership_paths 携带
 * 任务级产品归属（affected_paths），而 finalization-transaction 与 FS 契约把
 * ownership_paths 定义为"本次发布拥有的八 target 精确集合"。适配器在 plan 层重写为
 * 八 target（manifest 内容不动，manifest_hash 稳定；plan_hash 由事务层一致推导）。 */
export function createPlanFinalizationRenderer(): PlanFinalizationRendererPort {
  const authority = createPlanPublicationPathAuthority();
  return Object.freeze({
    render(input: Parameters<PlanFinalizationRendererPort["render"]>[0]): PlanArtifactPublicationPlan {
      const verifierInput = input.finalization.quality_verification_input as { trusted?: TrustedPlanArtifactSet } | undefined;
      if (verifierInput?.trusted === undefined) {
        throw new Error("PLAN_ARTIFACT_PUBLICATION_INPUT_INVALID");
      }
      const result = planArtifactPublication(
        { schema_version: 1, change_key: input.context.change_key, trusted: verifierInput.trusted },
        authority
      );
      if (!result.ok || result.mode !== "current") {
        throw new Error(result.ok ? "PLAN_ARTIFACT_PUBLICATION_LEGACY_READ_ONLY" : result.reason_code);
      }
      // 事务层 plan 归一化：ownership（plan 与 manifest 同步）= 排序后的八 target 精确集合；
      // manifest_hash 与 publication_intent_id 随之重算（契约要求三层一致）。
      const targetPaths = [...planDurablePublicationTargetPaths(input.context.change_key)]
        .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
      const manifest = Object.freeze({
        ...result.plan.manifest,
        ownership_paths: targetPaths
      });
      const manifestHash = canonicalHash(manifest);
      return Object.freeze({
        ...result.plan,
        ownership_paths: targetPaths,
        manifest,
        manifest_hash: manifestHash,
        publication_intent_id: `plan_publication:${manifestHash.slice(7)}`
      });
    }
  });
}

/**
 * 生产 quality verifier：重新验证事件 bundle（冻结的 readPlanEventBundle 全量校验），
 * 通过后签发与冻结语义一致的证明（proof_hash = canonical hash of proof body）。
 */
export function createPlanFinalizationQualityVerifier(): PlanFinalizationQualityVerifierPort {
  return Object.freeze({
    async verify(input: PlanFinalizationQualityVerificationInput): Promise<PlanFinalizationQualityVerificationProof | { valid: false; reason_code?: string }> {
      // HP-02：finalization 事件包是 PlanAttemptEventBundle（单 attempt），
      // 完整生命周期聚合校验归 durable outbox/监控层（PlanEventBundle）
      const bundleBody = {
        schema_version: 1 as const,
        lifecycle_kind: "change" as const,
        run_id: input.context.run_id,
        change_key: input.context.change_key,
        attempt: input.context.attempt,
        events: input.finalization.events
      };
      const bundleRead = await readPlanAttemptEventBundle(JSON.stringify({
        ...bundleBody,
        bundle_hash: sha256(canonicalJson(bundleBody))
      }), { sha256 });
      if (!bundleRead.ok) {
        return { valid: false, reason_code: bundleRead.reason_code };
      }
      // proof_hash = canonical hash of 完整证明体（含 schema_version/valid，
      // 与事务层 validQualityProof 的 body-minus-proof_hash 语义一致）
      const body = {
        schema_version: 1 as const,
        valid: true as const,
        receipt_hash: input.finalization.receipt.receipt_hash as PlanDurablePublicationSha256,
        plan_hash: input.plan_hash,
        layer_receipt_hashes: input.finalization.receipt.layer_receipt_hashes as readonly [PlanDurablePublicationSha256, PlanDurablePublicationSha256, PlanDurablePublicationSha256],
        event_bundle_hash: input.event_bundle_hash
      };
      return Object.freeze({ ...body, proof_hash: canonicalHash(body) });
    }
  });
}
