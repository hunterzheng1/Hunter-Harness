/**
 * risk_signals 推断层：把"agent 在自然输入里手填的信号"升级为
 * "命令推断为底、手填与推断取并集"，逐条标注来源。
 *
 * 移植 harness/scripts/harness_gate.py classify 的 marker 表（:1458-1478）。
 * 扫描源：① structured_input.tasks[].affected_paths（计划触达面，主源）；
 * ② `git status --porcelain --untracked-files=all` 的路径（已开工残留，次源，
 * 解析规则与 Python 一致：引号、` -> ` 改名、反斜杠归一）。
 *
 * 并集语义是安全地板：reference.md 明说纯手填等于让 agent 自声明低风险跳门禁，
 * 所以推断项不允许被手填删除（declared ∪ inferred，永不取差集）。反向冲突
 * （declared=docs_only 且 inferred=production_code）取并集后落 standard，是安全方向。
 */

import type { PlanRiskSignal } from "@hunter-harness/core";

export interface SignalProvenance {
  readonly signal: PlanRiskSignal;
  readonly source: "declared" | "inferred" | "declared+inferred";
}

export interface InferredRiskSignals {
  readonly effective: readonly PlanRiskSignal[];
  readonly provenance: readonly SignalProvenance[];
}

/** 与 harness_gate.py:1468-1476 同一 marker 表（TS 枚举为 snake_case）。 */
const FULL_MARKERS: Partial<Record<PlanRiskSignal, readonly string[]>> = {
  auth: ["auth", "token", "credential", "permission"],
  security: ["security", "secret", "crypto"],
  migration: ["migration", "migrate", "/sql/", ".sql"],
  concurrency: ["concurr", "lock", "lease", "transaction"],
  artifact_protocol: ["artifact", "protocol", "manifest", "baseline"],
  shared_state: ["shared", "state/", "workflow-policy"],
  delete: ["delete", "purge", "archive"]
};

const DOC_SUFFIXES = [".md", ".txt", ".rst"] as const;

/** `git status --porcelain` 行解析：引号、` -> ` 改名取新名、反斜杠归一。 */
export function parsePorcelainPaths(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    let raw = line.slice(3).trim();
    if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
    raw = raw.replace(/\\/g, "/");
    if (!raw) continue;
    if (raw.includes(" -> ")) {
      raw = raw.split(" -> ").at(-1)?.trim() ?? "";
      if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
    }
    if (raw) paths.push(raw);
  }
  return paths;
}

function inferFromPaths(paths: readonly string[]): PlanRiskSignal[] {
  const lowered = paths.map((path) => path.toLowerCase()).join("\n");
  const signals: PlanRiskSignal[] = [];
  for (const [signal, markers] of Object.entries(FULL_MARKERS)) {
    if (markers !== undefined && markers.some((marker) => lowered.includes(marker))) {
      signals.push(signal as PlanRiskSignal);
    }
  }
  if (paths.length === 0) return signals;
  // docs-only 判定与 Python 一致：全部路径以 .md/.txt/.rst 结尾或位于 docs/ 下。
  const docsOnly = paths.every((path) => {
    const lower = path.toLowerCase();
    return DOC_SUFFIXES.some((suffix) => lower.endsWith(suffix)) || lower.startsWith("docs/");
  });
  if (docsOnly) {
    signals.push("docs_only");
  } else {
    signals.push("production_code");
  }
  return signals;
}

export function inferRiskSignals(input: {
  readonly declared: readonly PlanRiskSignal[];
  readonly affectedPaths: readonly string[];
  readonly gitStatusPaths?: readonly string[] | undefined;
}): InferredRiskSignals {
  const inferred = inferFromPaths([
    ...input.affectedPaths,
    ...(input.gitStatusPaths ?? [])
  ]);
  const declaredSet = new Set(input.declared);
  const inferredSet = new Set(inferred);
  const effective = [...new Set([...input.declared, ...inferred])].sort();
  const provenance: SignalProvenance[] = effective.map((signal) => ({
    signal,
    source: declaredSet.has(signal) && inferredSet.has(signal)
      ? "declared+inferred"
      : declaredSet.has(signal)
        ? "declared"
        : "inferred"
  }));
  return { effective, provenance };
}
