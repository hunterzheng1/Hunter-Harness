import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { emitPlanError, planErrorEnvelope, planStageForCode } from "./plan-error.js";
import { runPlanEvidencePack } from "./plan-evidence-pack.js";
import { runPlanFinalize } from "./plan-finalize.js";
import { runPlanReviewRecord } from "./plan-review-record.js";
import { deriveBaseline, lastKnownAttempt } from "../plan-evidence/publication-bookkeeping.js";
import type { CommandDependencies } from "./configure.js";

export interface PlanPublishOptions {
  /** 自然输入 JSON（plan-evidence-input.json） */
  input?: string;
  /** 证据包输出路径；缺省与输入同目录的 plan-evidence.json */
  output?: string;
  /** change 目录（默认 <cwd>/.harness/changes/<change_key>） */
  changeDir?: string;
  /** 评审收据过期且 findings 未变时自动续签（plan review-record --renew） */
  renewReview?: boolean;
  /** 测试/重放 seam：固定 finalize 的评审输入哈希时间锚（生产省略） */
  completedAt?: string;
}

/**
 * `hunter-harness plan publish --input <meta/plan-evidence-input.json>`
 *
 * HP-18：plan v2 的编排收口。此前编排方要手工维护三步链 + 两类记账：
 *   evidence-pack → （评审/续签）→ finalize
 *   重发布时还要自己把 expected_baseline 置 present（上次 manifest 哈希/generation）、
 *   attempt 递增——全是纯仪式，抄错一个就 fail closed 白跑一轮。
 * 本命令把编排收进 CLI：
 *   1. evidence-pack（输入即真相源）；
 *   2. 基线自动派生：扫描 meta/publication-journals 里 committed journal，
 *      取最大 generation 的 manifest 作为 expected_baseline；attempt 低于
 *      plan-events.ndjson 里已发布 attempt 时自动递增（显式给出更高值时尊重）；
 *   3. B2-2 收据保全：input 未透传 adversarial_review 但重建前磁盘 pack 有
 *      （编排方记录评审后忘写回输入的常见缺口）→ 旧收据写回新 pack 并自动
 *      续签（findings 未变时重绑 input_hash）；续签失败报
 *      PLAN_REVIEW_BINDING_FAILED 带恢复动作；
 *   4. 评审处理：finalize 报 PLAN_REVIEW_REQUIRED 时给出指引退出；
 *      报 PLAN_REVIEW_BINDING_FAILED（收据因重建过期）且 --renew-review 时
 *      自动续签后重试一次；
 *   5. finalize。
 * 中间产物（plan-evidence.json）仍落盘可审计，但编排方只拥有一份输入文件。
 * 门禁语义不变：所有质量门、fail-closed 行为都由原命令原样执行。
 */

interface PublishStepResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly [key: string]: unknown;
}

/** 捕获子命令的 stdout JSON（子命令约定恰好输出一条 JSON 信封）。 */
function captureStdout(dependencies: CommandDependencies): {
  readonly deps: CommandDependencies;
  readonly read: () => PublishStepResult;
} {
  const chunks: string[] = [];
  return {
    deps: { ...dependencies, stdout: (chunk: string) => { chunks.push(chunk); return true; } },
    read: () => {
      try {
        return JSON.parse(chunks.join("")) as PublishStepResult;
      } catch {
        return { ok: false, code: "PLAN_PUBLISH_STEP_OUTPUT_UNPARSEABLE", raw: chunks.join("") };
      }
    }
  };
}

/** plan-events.ndjson 里已出现的最大 attempt（用于重发布时自动递增）。 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export async function runPlanPublish(
  options: PlanPublishOptions,
  dependencies: CommandDependencies
): Promise<number> {
  if (options.input === undefined) {
    return emitPlanError(dependencies.stdout, planErrorEnvelope({
      code: "PLAN_PUBLISH_USAGE",
      stage: "boundary",
      field_path: "argv",
      message: "需要 --input <plan-evidence-input.json>；结构骨架见 plan evidence-pack --print-template"
    }));
  }
  const inputPath = options.input;
  try {
    const naturalInput = JSON.parse(await readFile(inputPath, "utf8")) as Record<string, unknown>;
    const changeKey = typeof naturalInput.change_key === "string" ? naturalInput.change_key : undefined;
    if (changeKey === undefined || changeKey === "") {
      return emitPlanError(dependencies.stdout, planErrorEnvelope({
        code: "PLAN_PUBLISH_USAGE",
        stage: "boundary",
        field_path: "change_key",
        message: "输入缺少 change_key（顶层字段）"
      }));
    }
    // changeDir 统一走 realpath：finalize 内部按 realpath 解析 projectRoot 并发布到解析后
    // 位置；publish 的基线派生（journal 扫描）必须读同一个位置，否则在 tmpdir 被别名化的
    // 环境（CI 的 8.3 短名/软链）里读到空目录、把重发布误当首发
    let changeDir = options.changeDir ??
      join(dependencies.cwd, ".harness", "changes", changeKey);
    try {
      changeDir = await realpath(changeDir);
    } catch {
      // 目录尚不存在（首发布前未 prepare）时用字面路径，finalize 会再校验
    }
    const packPath = options.output ?? join(dirname(inputPath), "plan-evidence.json");
    const steps: Record<string, unknown> = {};

    // B2-2：收据保全——input 未透传 adversarial_review 但重建前磁盘 pack 有时，
    // 旧收据在 evidence-pack 重建后必然失效（input_hash 绑定 pack 内容）。先捕获，
    // 重建后写回并自动续签，编排方不再需要"记录评审后把收据抄回输入"的纯仪式。
    const declaredReview = naturalInput.adversarial_review;
    let rescuedReceipt: Record<string, unknown> | undefined;
    if (declaredReview === undefined) {
      try {
        const previous = JSON.parse(await readFile(packPath, "utf8")) as Record<string, unknown>;
        if (isRecord(previous.adversarial_review)) {
          rescuedReceipt = previous.adversarial_review;
        }
      } catch {
        // 磁盘无旧 pack（首发）或不可读——无收据可保全
      }
    }

    // 步骤 1：evidence-pack
    const packCapture = captureStdout(dependencies);
    const packExit = await runPlanEvidencePack(
      { input: inputPath, output: packPath }, packCapture.deps);
    const packResult = packCapture.read();
    steps.evidence_pack = packResult;
    if (packExit !== 0) {
      dependencies.stdout(JSON.stringify({
        ok: false, code: packResult.code ?? "PLAN_EVIDENCE_INPUT_INVALID",
        failed_step: "evidence-pack", steps
      }) + "\n");
      return 1;
    }

    // 步骤 2：基线与 attempt 记账——只在输入自己没声明时派生；显式声明的尊重原值
    const pack = JSON.parse(await readFile(packPath, "utf8")) as Record<string, unknown>;
    const declaredBaseline = naturalInput.expected_baseline as { state?: unknown } | undefined;
    const derivedBaseline = await deriveBaseline(changeDir);
    let baselineAdjusted = false;
    if (derivedBaseline !== undefined && declaredBaseline?.state !== "present") {
      pack.expected_baseline = {
        state: "present",
        manifest_hash: derivedBaseline.manifest_hash,
        generation: derivedBaseline.generation
      };
      baselineAdjusted = true;
    }
    const context = pack.context as Record<string, unknown> | undefined;
    const lastAttempt = await lastKnownAttempt(changeDir);
    let attemptAdjusted: { from: number; to: number } | undefined;
    if (isRecord(context) && typeof context.attempt === "number" &&
        Number.isSafeInteger(context.attempt) && context.attempt <= lastAttempt && lastAttempt > 0) {
      attemptAdjusted = { from: context.attempt, to: lastAttempt + 1 };
      context.attempt = lastAttempt + 1;
    }
    if (baselineAdjusted || attemptAdjusted !== undefined) {
      await writeFile(packPath, JSON.stringify(pack));
      steps.bookkeeping = {
        baseline: baselineAdjusted ? { state: "present", ...derivedBaseline } : "declared",
        attempt_adjusted: attemptAdjusted ?? null
      };
    }

    // B2-2：收据保全——重建后的 pack 缺 adversarial_review 但磁盘旧 pack 有。
    // 写回旧收据（此时 input_hash 必然过期）并立即用 review-record --renew 续签：
    // findings 未变时重绑 input_hash，findings 变化（语义门禁 blocking）时
    // 续签 fail closed，报 PLAN_REVIEW_BINDING_FAILED 带恢复动作。
    if (rescuedReceipt !== undefined && pack.adversarial_review === undefined) {
      pack.adversarial_review = rescuedReceipt;
      await writeFile(packPath, JSON.stringify(pack));
      const renewCapture = captureStdout(dependencies);
      const renewExit = await runPlanReviewRecord(
        { input: packPath, renew: true }, renewCapture.deps);
      const renewResult = renewCapture.read();
      steps.review_rescue = renewResult;
      if (renewExit !== 0) {
        dependencies.stdout(JSON.stringify({
          ok: false,
          code: "PLAN_REVIEW_BINDING_FAILED",
          failed_step: "review-rescue",
          steps,
          recovery_action: "磁盘旧 pack 的评审收据因内容变化无法续签（findings 已变或收据不自洽）；" +
            "用 plan review-record --input <pack> --receipt <draft> 重新评审，" +
            "或把最新收据写回 --input 的 adversarial_review 字段后重跑 publish"
        }) + "\n");
        return 1;
      }
    }

    // 步骤 3+4：finalize；收据过期且允许续签时自动续签后重试一次
    const finalizeCapture = captureStdout(dependencies);
    let finalizeExit = await runPlanFinalize(
      { input: packPath, changeDir, ...(options.completedAt === undefined ? {} : { completedAt: options.completedAt }) },
      finalizeCapture.deps);
    let finalizeResult = finalizeCapture.read();

    if (finalizeExit !== 0 && finalizeResult.code === "PLAN_REVIEW_BINDING_FAILED" &&
        options.renewReview === true) {
      const renewCapture = captureStdout(dependencies);
      const renewExit = await runPlanReviewRecord(
        { input: packPath, renew: true }, renewCapture.deps);
      const renewResult = renewCapture.read();
      steps.review_renew = renewResult;
      if (renewExit !== 0) {
        dependencies.stdout(JSON.stringify({
          ok: false, code: renewResult.code ?? "PLAN_REVIEW_RENEW_FAILED",
          failed_step: "review-renew", steps,
          finalize_before_renew: finalizeResult
        }) + "\n");
        return 1;
      }
      const retryCapture = captureStdout(dependencies);
      finalizeExit = await runPlanFinalize(
        { input: packPath, changeDir, ...(options.completedAt === undefined ? {} : { completedAt: options.completedAt }) },
        retryCapture.deps);
      finalizeResult = retryCapture.read();
    }
    steps.finalize = finalizeResult;

    if (finalizeExit !== 0) {
      const guidance: Record<string, string> = {};
      if (finalizeResult.code === "PLAN_REVIEW_REQUIRED") {
        guidance.review = "需要对抗评审：plan review-record --input <pack> --receipt <draft> " +
          "（--print-template 看草稿骨架）后重跑 publish";
      } else if (finalizeResult.code === "PLAN_REVIEW_BINDING_FAILED") {
        guidance.review = "评审收据因 pack 重建而过期：findings 未变时用 " +
          "plan review-record --input <pack> --renew 续签，或重跑 publish --renew-review";
      }
      dependencies.stdout(JSON.stringify({
        ok: false, code: finalizeResult.code ?? "PLAN_FINALIZE_FAILED",
        failed_step: "finalize", steps,
        ...(Object.keys(guidance).length > 0 ? { guidance } : {})
      }) + "\n");
      return 1;
    }

    dependencies.stdout(JSON.stringify({
      ok: true,
      code: "PLAN_PUBLISHED",
      change_key: changeKey,
      pack: packPath,
      steps
    }) + "\n");
    return 0;
  } catch (error) {
    const coreMessage = error instanceof Error ? error.message : String(error);
    const coreCode = /^PLAN[A-Z_]*$/u.test(coreMessage) ? coreMessage : undefined;
    return emitPlanError(dependencies.stdout, planErrorEnvelope({
      code: "PLAN_PUBLISH_FAILED",
      stage: coreCode === undefined ? "finalize" : planStageForCode(coreCode),
      reason_code: coreCode ?? "PLAN_PUBLISH_FAILED",
      message: coreMessage,
      extra: { error: coreMessage }
    }));
  }
}
