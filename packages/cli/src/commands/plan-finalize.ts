import { readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
import { emitPlanError, planErrorEnvelope, planStageForCode } from "./plan-error.js";
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
    // HP-10：--change-dir 真正参与路径解析——必须位于 <projectRoot>/.harness/changes/<change_key>
    // 且 change_key 与输入一致；解析 realpath 拒绝 symlink/reparse 冒充
    let projectRoot = dependencies.cwd;
    let changeDir: string;
    if (options.changeDir === undefined) {
      changeDir = join(projectRoot, ".harness", "changes", input.context.change_key);
    } else {
      let resolved: string;
      try {
        resolved = await realpath(options.changeDir);
      } catch {
        return emitPlanError(dependencies.stdout, planErrorEnvelope({
          code: "PLAN_CHANGE_DIR_INVALID",
          field_path: "changeDir",
          message: "--change-dir 路径不存在或不可解析"
        }));
      }
      const parts = resolved.split(/[\\/]/u).filter((part) => part.length > 0);
      const keyIndex = parts.length - 1;
      if (parts.length < 4 || parts[keyIndex] !== input.context.change_key ||
          parts[keyIndex - 1] !== "changes" || parts[keyIndex - 2] !== ".harness") {
        return emitPlanError(dependencies.stdout, planErrorEnvelope({
          code: "PLAN_CHANGE_DIR_INVALID",
          field_path: "changeDir",
          message: "--change-dir 必须解析为 <projectRoot>/.harness/changes/<change_key> 且与输入 change_key 一致"
        }));
      }
      // POSIX 修复：split+join 会丢前导斜杠（"" 段被 filter 掉后 "tmp/..." 变成相对路径，
      // 发布物落到进程 cwd 下——Linux CI 的 HP-10/publish 假 ENOENT 根因）。用 dirname 保持绝对性。
      projectRoot = dirname(dirname(dirname(resolved)));
      changeDir = resolved;
    }
    const context = {
      schema_version: 1 as const,
      project_id: input.context.project_id,
      change_key: input.context.change_key,
      run_id: input.context.run_id,
      branch_name: input.context.branch_name,
      attempt: input.context.attempt,
      phase: (input.phase ?? "plan") as never,
      root_authority: buildFsPublicationAuthority({ projectRoot, projectId: input.context.project_id }, input.context.change_key)
    };
    const portOptions = { projectRoot, projectId: context.project_id, now };

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
      // HP-15：绑定哈希外部不可预计算，报错时由校验器自曝期望值（公开契约）。
      // 编排方两条路：①`plan review-record --input <pack> --receipt <draft>` 让 CLI
      // 代算 input_hash/findings_hash 并写回；②手工构造收据时从这里取
      // expected_review.input_hash，findings_hash = 本端 findings 的 canonical JSON
      // 的 sha256。时间锚不进 input_hash，期望值不随墙钟漂移。
      let expectedReview: { readonly input_hash: string } | undefined;
      try {
        const probe = quality.runAdversarialGates({
          trusted: input.trusted,
          semantic: layer2,
          explicit_adversarial: input.explicit_adversarial === true,
          prefer_delegated: false,
          completed_at: completedAt
        });
        expectedReview = { input_hash: probe.review_execution.input_hash };
      } catch {
        expectedReview = undefined;
      }
      return emitPlanError(dependencies.stdout, planErrorEnvelope({
        code: "PLAN_REVIEW_REQUIRED",
        message: "assurance/高风险计划需要对抗评审收据（adversarial_review 字段）；缺失时 fail closed。" +
          "推荐用 plan review-record 由 CLI 代算绑定哈希写回证据包；手工构造时用 expected_review.input_hash",
        extra: { ...(expectedReview === undefined ? {} : { expected_review: expectedReview }) }
      }));
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
      dependencies.stdout(JSON.stringify(planErrorEnvelope({
        code: "PLAN_REVIEW_BINDING_FAILED",
        message: "评审收据与当前产物/发现/透镜的 input_hash 或 findings_hash 绑定失败；" +
          "review_execution.input_hash 是权威期望值（findings_hash 由你端 findings 的 canonical JSON 自算）；" +
          "重跑评审或用 plan review-record 重新签发收据",
        extra: { review_execution: layer3.review_execution }
      })) + "\n");
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

    // HP-16：receipt blocked 时三层 findings 已在内存，直接写进错误信封——
    // 不再把裸 operation_id 丢给编排方去逆向排障（2026-09 实测该类排障 25min）。
    // 事务层对 blocked receipt 的同名短码返回保留兼容；编排方正常路径不再到达那里。
    if (finalized.receipt.status === "blocked") {
      const blockingFindings = [...layer1.findings, ...layer2.findings, ...layer3.findings]
        .filter((finding, index, all) => finding.severity === "blocking" &&
          all.findIndex((other) => other.finding_id === finding.finding_id) === index);
      const blockedStage: "layer2" | "layer3" =
        layer2.findings.every((finding) => finding.severity !== "blocking") ? "layer3" : "layer2";
      return emitPlanError(dependencies.stdout, planErrorEnvelope({
        code: "PLAN_FINALIZATION_QUALITY_INVALID",
        stage: blockedStage,
        message: "计划质量门禁 blocked；findings 逐条给出 blocking 原因与建议位置，" +
          "修正 meta/plan-evidence-input.json 对应字段后重跑 evidence-pack + finalize",
        findings: blockingFindings,
        extra: {
          status: "blocked",
          layers: [
            { layer: "layer1_deterministic", status: layer1.status, findings: layer1.findings },
            { layer: "layer2_semantic", status: layer2.status, findings: layer2.findings },
            { layer: "layer3_adversarial", status: layer3.status, findings: layer3.findings }
          ]
        }
      }));
    }

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

    // A-1：finalize 成功后把 plan 的 ownership 派生进 change-context.json
    //（归档的 ownership diff 读它）。派生失败不阻断 finalize 结果。
    let ownershipProjection: { applied: boolean; productPaths: string[] } = {
      applied: false, productPaths: []
    };
    if (result.ok) {
      try {
        ownershipProjection = await deriveOwnershipProductPaths(
          changeDir,
          input.trusted.human_input.structured_input
        );
      } catch {
        ownershipProjection = { applied: false, productPaths: [] };
      }
    }

    dependencies.stdout(JSON.stringify({
      ok: result.ok,
      code: result.ok ? "PLAN_FINALIZED" : (result.reason_code ?? "PLAN_FINALIZE_FAILED"),
      operation_id: result.operation_id,
      status: result.status,
      publication_receipt: result.publication_receipt,
      event_outbox_id: result.event_outbox?.outbox_id ?? null,
      ownership_projection: ownershipProjection,
      change_dir: changeDir
    }) + "\n");
    return result.ok ? 0 : 1;
  } catch (error) {
    // HP-08：结构化信封——reason_code 取 core 稳定码，error 字段保留原 message；
    // stage 按 core 码推导（信封码 PLAN_FINALIZE_FAILED 只会落到 finalize，误导定位）
    const coreMessage = error instanceof Error ? error.message : String(error);
    const coreCode = /^PLAN[A-Z_]*$/u.test(coreMessage) ? coreMessage : undefined;
    return emitPlanError(dependencies.stdout, planErrorEnvelope({
      code: "PLAN_FINALIZE_FAILED",
      stage: coreCode === undefined ? "finalize" : planStageForCode(coreCode),
      reason_code: coreCode ?? "PLAN_FINALIZE_FAILED",
      message: coreMessage,
      extra: { error: coreMessage }
    }));
  }
}

export { buildFsPublicationAuthority };

/** A-1：finalize 成功时把 plan 的 ownership 派生进 change-context.json。
 *
 * plan v2 的 structured_input 明确定义了 ownership/affected_paths，但归档读的
 * 是 change-context.json 的 ownership.productPaths——两端之间此前没有任何写入方，
 * 只能靠人肉 declare-ownership，必漏（2026-08-31 demo-datasource 实测补了 9 条）。
 * 已显式声明过 productPaths 的从不动；目录内 ≥2 个文件归并为目录前缀。
 */
async function deriveOwnershipProductPaths(
  changeDir: string,
  structuredInput: {
    readonly ownership?: readonly { readonly path: string }[];
    readonly tasks: readonly { readonly affected_paths: readonly string[] }[];
  }
): Promise<{ applied: boolean; productPaths: string[] }> {
  const none = { applied: false, productPaths: [] as string[] };
  const contextPath = join(changeDir, "meta", "change-context.json");
  let context: Record<string, unknown>;
  try {
    context = JSON.parse(
      (await readFile(contextPath, "utf8")).replace(/^\uFEFF/, "")
    ) as Record<string, unknown>;
  } catch {
    return none;
  }
  const ownership = context.ownership;
  const existing = typeof ownership === "object" && ownership !== null
    ? (ownership as { productPaths?: unknown }).productPaths
    : undefined;
  if (Array.isArray(existing) && existing.length > 0) return none;

  const explicit = (structuredInput.ownership ?? []).map((item) => item.path);
  const fromTasks = structuredInput.tasks.flatMap((task) => [...task.affected_paths]);
  const paths = [...new Set((explicit.length > 0 ? explicit : fromTasks)
    .map((path) => path.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, ""))
    .filter((path) => path !== "" && !/[*?[\]]/.test(path)))];
  if (paths.length === 0) return none;

  const byDir = new Map<string, string[]>();
  for (const path of paths) {
    const idx = path.lastIndexOf("/");
    const dir = idx < 0 ? "" : path.slice(0, idx);
    byDir.set(dir, [...(byDir.get(dir) ?? []), path]);
  }
  const productPaths = [...byDir.entries()]
    .map(([dir, files]) => (dir !== "" && files.length > 1 ? `${dir}/` : (files[0] ?? dir)))
    .sort();

  const next = {
    ...context,
    ownership: {
      ...(typeof ownership === "object" && ownership !== null
        ? ownership as Record<string, unknown>
        : {}),
      productPaths,
      derivedFrom: "plan-finalize"
    }
  };
  const tmp = `${contextPath}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  await rename(tmp, contextPath);
  return { applied: true, productPaths };
}
