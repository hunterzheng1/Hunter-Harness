import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { canonicalJson } from "@hunter-harness/contracts";
import {
  createPlanQualityModule,
  createPlanStageVerifier,
  type PlanFinalizationExecutionContext,
  type StagedPublicationEvidence,
  type TrustedArtifactSetInput
} from "@hunter-harness/core";

import { emitPlanError, planErrorEnvelope, planStageForCode } from "./plan-error.js";
import type { CommandDependencies } from "./configure.js";

export interface PlanReviewRecordOptions {
  /** 证据包路径（plan evidence-pack 的产物） */
  input?: string;
  /** 收据草稿 JSON：{ reviewer_identity, review_mode?, findings?, completed_at? } */
  receipt?: string;
  /** 写回路径；缺省覆盖 --input */
  output?: string;
  /** 打印合法草稿骨架（P1-2：契约可发现，不再靠报错反推） */
  printTemplate?: boolean;
  /**
   * HP-17：续签模式——沿用证据包里的现有收据（reviewer_identity/findings 不动），
   * 只对重建后的 pack 重算 input_hash 并重绑。与 --receipt 互斥。
   * 语义：调用方（编排方）声明「原评审的 findings 对当前 pack 内容仍然成立」。
   * 重建后若语义门禁出现 blocking findings（原评审未覆盖的内容），续签被拒绝。
   */
  renew?: boolean;
}

/** 合法草稿骨架：findings 元素键集与校验器精确一致。 */
const REVIEW_RECEIPT_TEMPLATE = {
  reviewer_identity: "inline:<评审者标识，小写字母开头>",
  review_mode: "inline",
  findings: [
    {
      finding_id: "finding-1",
      category: "architecture",
      severity: "advisory",
      source_refs: ["<evidence_map_id>#<ref>"],
      message_zh: "<中文问题描述>",
      suggested_location: "<建议修改位置>"
    }
  ],
  completed_at: "<RFC3339 时间戳，缺省由本命令填当前时间>"
};

/**
 * `hunter-harness plan review-record --input <evidence.json> --receipt <draft.json>`
 *
 * HP-15：对抗评审收据的 input_hash 绑定 layer2/layer3 内部输出（产物 + 语义投影 +
 * capabilities + 高风险发现 + 透镜，全在 CLI 内部管线里），编排方无法预计算——
 * 0.4.7 及之前唯一的活路是先跑一次 finalize 读报错里的期望值再回填。
 * 本命令把这条路收进 CLI：内部跑 layer1/layer2/layer3（无评审端口）算出权威
 * input_hash，代算 findings_hash，把完整收据写回证据包顶层 `adversarial_review`。
 *
 * 时间锚说明：layer3 input_hash 不绑定墙钟（completed_at 只进运行期信封），
 * 因此本命令算出的哈希与之后任何时刻的 finalize 运行一致（plan-finalize-review
 * e2e 冻结该不变量）。但收据绑定的是**证据包内容**——写回后任何对 pack 的修改
 * （包括重跑 evidence-pack）都会使收据失效，必须重跑本命令；findings 未变的
 * 纯重建场景可用 `--renew` 续签（沿用 findings 重绑 input_hash，见 HP-17）。
 */

interface ReviewReceiptDraft {
  readonly reviewer_identity: string;
  readonly review_mode?: "inline" | "delegated";
  readonly findings?: readonly Record<string, unknown>[];
  readonly completed_at?: string;
}

interface PlanFinalizePackFile {
  trusted: TrustedArtifactSetInput;
  publication: StagedPublicationEvidence;
  context: PlanFinalizationExecutionContext;
  expected_baseline: unknown;
  adversarial_review?: unknown;
  readonly [key: string]: unknown;
}

interface InputProblem {
  readonly field_path: string;
  readonly message?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const IDENTITY_PATTERN = /^[a-z][a-z0-9_.:-]{0,159}$/u;
const REVIEW_MODES = ["inline", "delegated"] as const;
const FINDING_KEYS = ["finding_id", "category", "severity", "source_refs", "message_zh",
  "suggested_location"] as const;
const DRAFT_KEYS = ["reviewer_identity", "review_mode", "findings", "completed_at"] as const;

/** 与 core validFinding 同源的形状校验（边界报定位，core 仍是最终权威）。 */
function collectFindingProblems(value: unknown, fieldPath: string,
  problems: InputProblem[]): void {
  if (!isRecord(value)) {
    problems.push({ field_path: fieldPath, message: "必须是对象" });
    return;
  }
  const present = Object.keys(value);
  const missing = FINDING_KEYS.filter((key) => !present.includes(key));
  const unexpected = present.filter((key) => !(FINDING_KEYS as readonly string[]).includes(key));
  if (missing.length > 0 || unexpected.length > 0) {
    problems.push({
      field_path: fieldPath,
      message: `键集必须是 ${FINDING_KEYS.join("/")}` +
        (missing.length > 0 ? `；缺 ${missing.join("/")}` : "") +
        (unexpected.length > 0 ? `；多 ${unexpected.join("/")}` : "")
    });
    return;
  }
  if (typeof value.finding_id !== "string" || !IDENTITY_PATTERN.test(value.finding_id)) {
    problems.push({ field_path: `${fieldPath}.finding_id`,
      message: "必须匹配 ^[a-z][a-z0-9_.:-]{0,159}$" });
  }
  if (typeof value.category !== "string" || value.category.trim() === "") {
    problems.push({ field_path: `${fieldPath}.category`, message: "必须是非空字符串" });
  }
  if (value.severity !== "advisory" && value.severity !== "blocking") {
    problems.push({ field_path: `${fieldPath}.severity`, message: "取值必须是 advisory | blocking" });
  }
  if (!Array.isArray(value.source_refs) || value.source_refs.length === 0 ||
    !value.source_refs.every((ref) => typeof ref === "string" && ref !== "")) {
    problems.push({ field_path: `${fieldPath}.source_refs`,
      message: "必须是至少一条非空字符串的数组" });
  }
  if (typeof value.message_zh !== "string" || value.message_zh.trim() === "") {
    problems.push({ field_path: `${fieldPath}.message_zh`, message: "必须是非空字符串" });
  }
  if (typeof value.suggested_location !== "string" || value.suggested_location.trim() === "") {
    problems.push({ field_path: `${fieldPath}.suggested_location`, message: "必须是非空字符串" });
  }
}

export async function runPlanReviewRecord(
  options: PlanReviewRecordOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const now = () => new Date().toISOString();
  if (options.printTemplate === true) {
    dependencies.stdout(`${JSON.stringify(REVIEW_RECEIPT_TEMPLATE, null, 2)}\n`);
    return 0;
  }
  if (options.input === undefined || (options.receipt === undefined && options.renew !== true)) {
    return emitPlanError(dependencies.stdout, planErrorEnvelope({
      code: "PLAN_REVIEW_RECORD_USAGE",
      stage: "boundary",
      field_path: "argv",
      message: "需要 --input <证据包> 加 --receipt <草稿>（新评审）或 --renew（续签现有收据）；" +
        "查看契约骨架：--print-template"
    }));
  }
  if (options.receipt !== undefined && options.renew === true) {
    return emitPlanError(dependencies.stdout, planErrorEnvelope({
      code: "PLAN_REVIEW_RECORD_USAGE",
      stage: "boundary",
      field_path: "argv",
      message: "--renew 与 --receipt 互斥：续签直接沿用证据包里的现有收据，不读草稿"
    }));
  }
  const inputPath = options.input;
  const receiptPath = options.receipt;
  try {
    const pack = JSON.parse(await readFile(inputPath, "utf8")) as PlanFinalizePackFile;
    if (!isRecord(pack) || !isRecord(pack.trusted) || !isRecord(pack.publication) ||
        !isRecord(pack.context)) {
      return emitPlanError(dependencies.stdout, planErrorEnvelope({
        code: "PLAN_REVIEW_RECORD_INPUT_INVALID",
        stage: "boundary",
        field_path: "input",
        message: "证据包必须含 trusted/publication/context（plan evidence-pack 的产物，不得手改）"
      }));
    }
    // 草稿只在非续签模式读取（续签沿用 pack 里的现有收据）
    const draft = options.renew === true
      ? undefined
      : JSON.parse(await readFile(receiptPath as string, "utf8")) as ReviewReceiptDraft;
    const problems: InputProblem[] = [];
    if (options.renew !== true) {
      if (!isRecord(draft)) {
        problems.push({ field_path: "receipt", message: "必须是对象" });
      } else {
      const unexpected = Object.keys(draft).filter((key) =>
        !(DRAFT_KEYS as readonly string[]).includes(key));
      if (unexpected.length > 0) {
        problems.push({ field_path: "receipt",
          message: `不支持的键：${unexpected.join("/")}；草稿只含 reviewer_identity/review_mode/findings/completed_at，` +
            "input_hash 与 findings_hash 由本命令代算" });
      }
      if (typeof draft.reviewer_identity !== "string" ||
          !IDENTITY_PATTERN.test(draft.reviewer_identity)) {
        problems.push({ field_path: "receipt.reviewer_identity",
          message: "必填，且必须匹配 ^[a-z][a-z0-9_.:-]{0,159}$（如 inline:<标识>）" });
      }
      if (draft.review_mode !== undefined &&
          !(REVIEW_MODES as readonly string[]).includes(draft.review_mode)) {
        problems.push({ field_path: "receipt.review_mode", message: "取值必须是 inline | delegated" });
      }
      if (draft.findings !== undefined) {
        if (!Array.isArray(draft.findings)) {
          problems.push({ field_path: "receipt.findings", message: "必须是数组" });
        } else {
          draft.findings.forEach((finding, index) =>
            collectFindingProblems(finding, `receipt.findings[${index}]`, problems));
        }
      }
      if (draft.completed_at !== undefined &&
          !Number.isFinite(Date.parse(String(draft.completed_at)))) {
        problems.push({ field_path: "receipt.completed_at", message: "必须是可解析的 ISO 8601 时间" });
      }
      }
    }
    const firstProblem = problems[0];
    if (options.renew !== true && (firstProblem !== undefined || !isRecord(draft))) {
      return emitPlanError(dependencies.stdout, planErrorEnvelope({
        code: "PLAN_REVIEW_RECORD_INPUT_INVALID",
        stage: "boundary",
        field_path: firstProblem?.field_path ?? "receipt",
        message: "评审收据草稿不符合契约；逐条修正 problems 后重跑",
        extra: { problems }
      }));
    }

    // 复跑质量门拿权威 input_hash：layer1（确定性门）→ layer2（语义投影）→
    // layer3 无评审端口（触发时 review_execution.input_hash 即绑定期望值）。
    // 三层输入全是 pack 内容 + 时间锚，而时间不进 input_hash → 结果可复现。
    const quality = createPlanQualityModule();
    const completedAt = now();
    const layer1 = quality.runDeterministicGates({
      trusted: pack.trusted,
      publication: pack.publication,
      stage_verifier_port: createPlanStageVerifier({ now }),
      completed_at: completedAt
    });
    if (layer1.status !== "passed") {
      dependencies.stdout(JSON.stringify({
        ok: false,
        code: "PLAN_REVIEW_RECORD_DETERMINISTIC_FAILED",
        message: "证据包未过确定性门，先修正规划产物再记录评审",
        findings: layer1.findings
      }) + "\n");
      return 1;
    }
    const layer2 = quality.runSemanticGates({ trusted: pack.trusted, completed_at: completedAt });
    const layer3 = quality.runAdversarialGates({
      trusted: pack.trusted,
      semantic: layer2,
      explicit_adversarial: false,
      prefer_delegated: false,
      completed_at: completedAt
    });

    // HP-17：续签分支——沿用现有收据的 reviewer_identity/review_mode/findings，
    // 只对当前 pack 重算 input_hash 重绑。前置条件全部 fail-closed：
    // ① pack 里必须已有收据；② 收据自身 findings_hash 必须自洽（防手改 findings）；
    // ③ 重建后的内容不得带语义门禁 blocking findings（原评审未覆盖这些内容）。
    if (options.renew === true) {
      const stale = pack.adversarial_review;
      if (!isRecord(stale)) {
        return emitPlanError(dependencies.stdout, planErrorEnvelope({
          code: "PLAN_REVIEW_RENEW_NO_RECEIPT",
          stage: "layer3",
          field_path: "adversarial_review",
          message: "证据包里没有可续签的对抗评审收据；首次评审请用 --receipt 草稿"
        }));
      }
      const staleFindings = Array.isArray(stale.findings)
        ? stale.findings as readonly Record<string, unknown>[]
        : undefined;
      const staleFindingsHash = staleFindings === undefined ? undefined :
        `sha256:${createHash("sha256").update(canonicalJson(staleFindings), "utf8").digest("hex")}`;
      if (staleFindings === undefined || stale.findings_hash !== staleFindingsHash ||
          typeof stale.reviewer_identity !== "string" || stale.reviewer_identity.trim() === "") {
        return emitPlanError(dependencies.stdout, planErrorEnvelope({
          code: "PLAN_REVIEW_RENEW_STALE_INVALID",
          stage: "layer3",
          field_path: "adversarial_review.findings_hash",
          message: "现有收据的 findings 与 findings_hash 不自洽（可能被手改过）；请用 --receipt 重新记录评审"
        }));
      }
      const semanticBlocking = layer2.findings.filter((finding) => finding.severity === "blocking");
      if (semanticBlocking.length > 0) {
        return emitPlanError(dependencies.stdout, planErrorEnvelope({
          code: "PLAN_REVIEW_RENEW_SEMANTIC_BLOCKED",
          stage: "layer2",
          message: "重建后的内容带语义门禁 blocking findings，原评审未覆盖；" +
            "先修正这些问题（或完成后用 --receipt 重新评审），再续签",
          findings: semanticBlocking
        }));
      }
      const renewedInputHash = layer3.review_execution.input_hash;
      const output = options.output ?? options.input;
      if (stale.input_hash === renewedInputHash) {
        dependencies.stdout(JSON.stringify({
          ok: true,
          code: "PLAN_REVIEW_RECEIPT_RENEWED",
          renewed: false,
          output,
          input_hash: renewedInputHash,
          findings_hash: staleFindingsHash,
          message: "input_hash 未变，现有收据仍然有效，无需续签"
        }) + "\n");
        return 0;
      }
      const renewedReceipt = {
        schema_version: 1 as const,
        reviewer_identity: stale.reviewer_identity,
        review_mode: stale.review_mode === "delegated" ? "delegated" as const : "inline" as const,
        input_hash: renewedInputHash,
        findings_hash: staleFindingsHash,
        findings: staleFindings,
        completed_at: completedAt
      };
      await writeFile(output, JSON.stringify({ ...pack, adversarial_review: renewedReceipt }));
      dependencies.stdout(JSON.stringify({
        ok: true,
        code: "PLAN_REVIEW_RECEIPT_RENEWED",
        renewed: true,
        output,
        previous_input_hash: stale.input_hash,
        input_hash: renewedInputHash,
        findings_hash: staleFindingsHash,
        review_required: layer3.status !== "skipped",
        layer3_status: layer3.status
      }) + "\n");
      return 0;
    }

    const findings = draft?.findings ?? [];
    // 非续签路径 draft 一定存在且已过校验（上面边界检查已拦截）
    const receiptDraft = draft as ReviewReceiptDraft;
    const receipt = {
      schema_version: 1 as const,
      reviewer_identity: receiptDraft.reviewer_identity,
      review_mode: receiptDraft.review_mode ?? "inline" as const,
      input_hash: layer3.review_execution.input_hash,
      findings_hash:
        `sha256:${createHash("sha256").update(canonicalJson(findings), "utf8").digest("hex")}`,
      findings,
      completed_at: receiptDraft.completed_at === undefined
        ? completedAt
        : new Date(Date.parse(String(receiptDraft.completed_at))).toISOString()
    };
    const output = options.output ?? options.input;
    await writeFile(output, JSON.stringify({ ...pack, adversarial_review: receipt }));
    dependencies.stdout(JSON.stringify({
      ok: true,
      code: "PLAN_REVIEW_RECEIPT_RECORDED",
      output,
      input_hash: receipt.input_hash,
      findings_hash: receipt.findings_hash,
      // skipped = 该 pack 未触发对抗评审（非 assurance 且无高风险），收据不会被 finalize 消费
      review_required: layer3.status !== "skipped",
      layer3_status: layer3.status
    }) + "\n");
    return 0;
  } catch (error) {
    const coreMessage = error instanceof Error ? error.message : String(error);
    const coreCode = /^PLAN[A-Z_]*$/u.test(coreMessage) ? coreMessage : undefined;
    return emitPlanError(dependencies.stdout, planErrorEnvelope({
      code: "PLAN_REVIEW_RECORD_FAILED",
      stage: coreCode === undefined ? "finalize" : planStageForCode(coreCode),
      reason_code: coreCode ?? "PLAN_REVIEW_RECORD_FAILED",
      message: coreMessage,
      extra: { error: coreMessage }
    }));
  }
}
