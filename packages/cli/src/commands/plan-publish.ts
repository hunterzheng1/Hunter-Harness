import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { emitPlanError, planErrorEnvelope, planStageForCode } from "./plan-error.js";
import { runPlanEvidencePack } from "./plan-evidence-pack.js";
import { runPlanFinalize } from "./plan-finalize.js";
import { runPlanReviewRecord } from "./plan-review-record.js";
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
 *   3. 评审处理：finalize 报 PLAN_REVIEW_REQUIRED 时给出指引退出；
 *      报 PLAN_REVIEW_BINDING_FAILED（收据因重建过期）且 --renew-review 时
 *      自动续签后重试一次；
 *   4. finalize。
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

/** 从 committed journal 派生上次发布基线（manifest_hash + generation）。 */
async function deriveBaseline(
  changeDir: string
): Promise<{ readonly manifest_hash: string; readonly generation: number } | undefined> {
  const journalsDir = join(changeDir, "meta", "publication-journals");
  let files: string[];
  try {
    files = await readdir(journalsDir);
  } catch {
    return undefined;
  }
  let best: { manifest_hash: string; generation: number } | undefined;
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const journal = JSON.parse(await readFile(join(journalsDir, file), "utf8")) as {
        state?: unknown;
        binding?: {
          new_manifest_hash?: unknown;
          expected_baseline?: { state?: unknown; generation?: unknown };
        };
      };
      if (journal.state !== "committed" ||
          typeof journal.binding?.new_manifest_hash !== "string") continue;
      const baseline = journal.binding.expected_baseline;
      const generation = baseline?.state === "present" && typeof baseline.generation === "number"
        ? baseline.generation + 1
        : 1;
      if (best === undefined || generation > best.generation) {
        best = { manifest_hash: journal.binding.new_manifest_hash, generation };
      }
    } catch {
      // 单个 journal 损坏不阻断基线派生
    }
  }
  return best;
}

/** plan-events.ndjson 里已出现的最大 attempt（用于重发布时自动递增）。 */
async function lastKnownAttempt(changeDir: string): Promise<number> {
  let ndjson: string;
  try {
    ndjson = await readFile(join(changeDir, "meta", "plan-events.ndjson"), "utf8");
  } catch {
    return 0;
  }
  let max = 0;
  for (const line of ndjson.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const event = JSON.parse(line) as { attempt?: unknown };
      if (typeof event.attempt === "number" && Number.isSafeInteger(event.attempt) &&
          event.attempt > max) {
        max = event.attempt;
      }
    } catch {
      // 单行损坏不阻断
    }
  }
  return max;
}

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
    const changeDir = options.changeDir ??
      join(dependencies.cwd, ".harness", "changes", changeKey);
    const packPath = options.output ?? join(dirname(inputPath), "plan-evidence.json");
    const steps: Record<string, unknown> = {};

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
