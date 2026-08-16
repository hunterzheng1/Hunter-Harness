import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

import {
  createDurablePlanPublicationModule,
  createPlanFinalizationTransactionModule,
  createPlanQualityModule,
  createPlanStageVerifier,
  type PlanFinalizationEvidence,
  type TrustedArtifactSetInput,
  type StagedPublicationEvidence,
  type PlanFinalizationExecutionContext
} from "@hunter-harness/core";

import { createFsPlanPublicationPort, buildFsPublicationAuthority } from "../plan-finalization/fs-publication-port.js";
import { createFsPlanEventOutboxPort } from "../plan-finalization/fs-event-outbox-port.js";
import { createFsDurablePublicationPort } from "../plan-finalization/fs-durable-publication-port.js";
import {
  createAdversarialReviewPort,
  createPlanFinalizationQualityVerifier,
  createPlanFinalizationRenderer
} from "../plan-finalization/production-ports.js";
import type { CommandDependencies } from "./configure.js";

export interface PlanFinalizeOptions {
  input: string;
  changeDir?: string;
  json?: boolean;
  /** 测试/重放 seam：固定评审输入哈希的时间锚（生产省略） */
  completedAt?: string;
}

interface PlanFinalizeInputFile {
  trusted: TrustedArtifactSetInput;
  publication: StagedPublicationEvidence;
  context: PlanFinalizationExecutionContext;
  expected_baseline: { state: "absent"; manifest_hash: null; generation: 0 } |
    { state: "present"; manifest_hash: string; generation: number };
  operation_id?: string;
  idempotency_key?: string;
  explicit_adversarial?: boolean;
  phase?: string;
  /** HP-01：对抗评审收据（inline 评审的可验证绑定），缺失时 assurance/高风险 fail closed */
  adversarial_review?: {
    readonly schema_version: 1;
    readonly reviewer_identity: string;
    readonly review_mode: "inline" | "delegated";
    readonly input_hash: string;
    readonly findings_hash: string;
    readonly findings: readonly Record<string, unknown>[];
    readonly completed_at: string;
  };
}

const canonicalHash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");

/**
 * `hunter-harness plan finalize --input <evidence.json>`
 * v2 Plan 全链路：L1 确定性门（含生产 StageVerifier）→ L2/L3 内联裁决 →
 * finalizeQuality（receipt+events）→ finalization-transaction（FS 发布 + 事件 outbox）。
 * 输入为编排方（skill）产出的结构化证据包；Python finalizer 暂不受影响（T0-2 过渡）。
 */
export async function runPlanFinalize(
  options: PlanFinalizeOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const now = () => new Date().toISOString();
  try {
    const input = JSON.parse(await readFile(options.input, "utf8")) as PlanFinalizeInputFile;
    const context = {
      schema_version: 1 as const,
      project_id: input.context.project_id,
      change_key: input.context.change_key,
      run_id: input.context.run_id,
      branch_name: input.context.branch_name,
      attempt: input.context.attempt,
      phase: (input.phase ?? "plan") as never,
      root_authority: buildFsPublicationAuthority({ projectRoot: dependencies.cwd, projectId: input.context.project_id }, input.context.change_key)
    };
    const projectRoot = dependencies.cwd;
    const portOptions = { projectRoot, projectId: context.project_id, now };
    const changeDir = options.changeDir ?? join(projectRoot, ".harness", "changes", context.change_key);

    const quality = createPlanQualityModule();
    const stageVerifier = createPlanStageVerifier({ now });
    const completedAt = options.completedAt ?? now();

    const layer1 = quality.runDeterministicGates({
      trusted: input.trusted,
      publication: input.publication,
      stage_verifier_port: stageVerifier,
      completed_at: completedAt
    });
    if (layer1.status !== "passed") {
      dependencies.stdout(JSON.stringify({
        ok: false,
        code: "PLAN_FINALIZE_DETERMINISTIC_FAILED",
        findings: layer1.findings
      }) + "\n");
      return 1;
    }
    const layer2 = quality.runSemanticGates({ trusted: input.trusted, completed_at: completedAt });
    // HP-01：assurance/高风险触发时必须有可验证评审收据；缺失→PLAN_REVIEW_REQUIRED
    const reviewRequired = input.trusted.human_input.profile.mode === "assurance" ||
      input.explicit_adversarial === true ||
      input.trusted.human.test_scenarios.content.scenarios.some((scenario) => scenario.risk_level === "high") ||
      layer2.findings.some((finding) => finding.severity === "blocking");
    if (reviewRequired && input.adversarial_review === undefined) {
      dependencies.stdout(JSON.stringify({
        ok: false,
        code: "PLAN_REVIEW_REQUIRED",
        reason_code: "PLAN_REVIEW_REQUIRED",
        message: "assurance/高风险计划需要对抗评审收据（adversarial_review 字段）；缺失时 fail closed"
      }) + "\n");
      return 1;
    }
    const reviewerPort = input.adversarial_review === undefined
      ? undefined
      : createAdversarialReviewPort(input.adversarial_review);
    const layer3 = quality.runAdversarialGates({
      trusted: input.trusted,
      semantic: layer2,
      explicit_adversarial: input.explicit_adversarial === true,
      prefer_delegated: false,
      ...(reviewerPort === undefined ? {} : { reviewer_port: reviewerPort as never }),
      completed_at: completedAt
    });
    if (layer3.status === "blocked" &&
        layer3.review_execution.reviewer_identity === "review_unavailable") {
      dependencies.stdout(JSON.stringify({
        ok: false,
        code: "PLAN_REVIEW_BINDING_FAILED",
        reason_code: "PLAN_REVIEW_BINDING_FAILED",
        message: "评审收据与当前产物/发现/透镜的 input_hash 或 findings_hash 绑定失败；请重跑评审",
        review_execution: layer3.review_execution
      }) + "\n");
      return 1;
    }
    const finalized = quality.finalizeQuality({
      trusted: input.trusted,
      layer1,
      layer2,
      layer3,
      trusted_stage_verification: layer1.stage_verification,
      trusted_semantic_projection: {
        input_hash: layer2.input_hash,
        evaluator_invoked: layer2.evaluator_invoked,
        findings: layer2.findings,
        status: layer2.status,
        completed_at: layer2.completed_at
      },
      trusted_review_execution: layer3.review_execution,
      publication: input.publication,
      run_id: context.run_id,
      attempt: context.attempt,
      phase: (input.phase ?? "plan") as never,
      completed_at: completedAt
    });

    const operationId = input.operation_id ?? `plan_finalize:${context.change_key}:${finalized.receipt.receipt_hash.slice(7, 23)}`;
    const idempotencyKey = input.idempotency_key ?? `plan_finalize:${canonicalHash({ change_key: context.change_key, receipt_hash: finalized.receipt.receipt_hash })}`;
    const finalization = Object.freeze({
      schema_version: 1 as const,
      branch_name: context.branch_name,
      receipt: finalized.receipt,
      events: finalized.events,
      quality_verification_input: { trusted: input.trusted },
      layer_receipts: Object.freeze([layer1, layer2, layer3]) as readonly [
        typeof layer1, typeof layer2, typeof layer3
      ]
    }) as PlanFinalizationEvidence;

    const transaction = createPlanFinalizationTransactionModule({
      filesystem: createFsPlanPublicationPort(portOptions),
      publication: createDurablePlanPublicationModule(createFsDurablePublicationPort(portOptions)),
      event_outbox: createFsPlanEventOutboxPort(portOptions),
      renderer: createPlanFinalizationRenderer(),
      quality_verifier: createPlanFinalizationQualityVerifier(),
      clock: now
    });
    const result = await transaction.finalize({
      schema_version: 1,
      operation_id: operationId,
      idempotency_key: idempotencyKey,
      context,
      finalization,
      expected_baseline: input.expected_baseline as never,
      recovery_token: `plan_recovery:${canonicalHash(`${operationId}${idempotencyKey}`)}` as `plan_recovery:${string}`
    });

    dependencies.stdout(JSON.stringify({
      ok: result.ok,
      code: result.ok ? "PLAN_FINALIZED" : (result.reason_code ?? "PLAN_FINALIZE_FAILED"),
      operation_id: result.operation_id,
      status: result.status,
      publication_receipt: result.publication_receipt,
      event_outbox_id: result.event_outbox?.outbox_id ?? null,
      change_dir: changeDir
    }) + "\n");
    return result.ok ? 0 : 1;
  } catch (error) {
    dependencies.stdout(JSON.stringify({
      ok: false,
      code: "PLAN_FINALIZE_FAILED",
      error: error instanceof Error ? error.message : String(error)
    }) + "\n");
    return 1;
  }
}

export { buildFsPublicationAuthority };
