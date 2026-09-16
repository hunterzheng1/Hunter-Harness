import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { upsertManagedBlockById } from "../managed/managed-block.js";
import {
  AGENTS_LEARNED_RULES_BLOCK_ID,
  renderLearnedRulesBlock
} from "./managed-content.js";

// v1.0：规则学习去人工评审化。归档证据中提取的高置信候选由 refreshLearnedRules
// 幂等刷新进 AGENTS.md 的 harness-learned-rules 受管段；不再有候选清单文件、
// 没有 rules-review 队列（设计见 docs/decisions 与 plan：归档后自动学习）。

export interface RuleCandidateEvidenceRef {
  archive: string;
  path: string;
  evidence_id: string;
}

export interface RuleCandidate {
  rule_key: string;
  text: string;
  confidence: "high" | "medium";
  evidence: RuleCandidateEvidenceRef[];
  occurrences: number;
  latest_seen_at: string;
}

export interface RuleCandidateScanResult {
  scanned_archives: number;
  rejected_untrusted: number;
  files: Array<{
    archive: string;
    path: string;
    kind: "review-findings" | "test-report" | "summary";
    payload: unknown;
  }>;
}

const DEFAULT_EVIDENCE_FILES = [
  "review-findings.json",
  "review-findings-input.json",
  "test-report.json",
  "summary-data.json"
] as const;

// 粗粒度注入过滤：候选来自历史归档文本，不能让它把指令形态的内容注入 AGENTS.md。
const BLOCKED_PATTERNS: RegExp[] = [
  /ignore\s+(all|any|previous|prior)\s+instructions?/i,
  /system\s+prompt/i,
  /开发者模式|越狱/,
  /```/,
  /<script/i,
  /\bcurl\b.*\|\s*(?:sh|bash)/i,
  /\b(?:rm\s+-rf|del\s+\/f)\b/i
];

function normalizeRuleText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function slugifyRuleKey(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "rule";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasBlockedPattern(text: string): boolean {
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(text));
}

async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function collectEvidenceFiles(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > 4) {
    return;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectEvidenceFiles(full, depth + 1, out);
      continue;
    }
    if ((DEFAULT_EVIDENCE_FILES as readonly string[]).includes(entry.name)) {
      out.push(full);
    }
  }
}

function evidenceKind(fileName: string): "review-findings" | "test-report" | "summary" {
  if (fileName.startsWith("review-findings")) {
    return "review-findings";
  }
  if (fileName === "test-report.json") {
    return "test-report";
  }
  return "summary";
}

export interface ExtractRuleCandidatesOptions {
  archiveDir?: string;
}

export async function scanRuleCandidateEvidence(
  projectRoot: string,
  options?: ExtractRuleCandidatesOptions
): Promise<RuleCandidateScanResult> {
  const archiveDir = options?.archiveDir ?? join(projectRoot, ".harness", "archive");
  const files: string[] = [];
  await collectEvidenceFiles(archiveDir, 0, files);
  const result: RuleCandidateScanResult = {
    scanned_archives: 0,
    rejected_untrusted: 0,
    files: []
  };
  const archives = new Set<string>();
  for (const file of files.sort()) {
    const payload = await readJsonFile(file);
    if (payload === null) {
      result.rejected_untrusted += 1;
      continue;
    }
    const relative = file.slice(archiveDir.length).replace(/\\/g, "/").replace(/^\//, "");
    const archive = relative.split("/")[0] ?? "";
    archives.add(archive);
    result.files.push({
      archive,
      path: relative,
      kind: evidenceKind(file.split(/[\\/]/).pop() ?? ""),
      payload
    });
  }
  result.scanned_archives = archives.size;
  return result;
}

function asRuleText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = normalizeRuleText(value);
  if (normalized.length < 12 || normalized.length > 220) {
    return null;
  }
  if (hasBlockedPattern(normalized)) {
    return null;
  }
  return normalized;
}

function pushCandidate(
  map: Map<string, RuleCandidate>,
  text: string,
  confidence: "high" | "medium",
  ref: RuleCandidateEvidenceRef
): void {
  const key = slugifyRuleKey(text);
  const existing = map.get(key);
  if (existing !== undefined) {
    existing.occurrences += 1;
    existing.evidence.push(ref);
    if (confidence === "high") {
      existing.confidence = "high";
    }
    return;
  }
  map.set(key, {
    rule_key: key,
    text,
    confidence,
    evidence: [ref],
    occurrences: 1,
    latest_seen_at: ref.archive
  });
}

function extractFromReviewFindings(
  file: RuleCandidateScanResult["files"][number],
  map: Map<string, RuleCandidate>
): void {
  if (!isPlainObject(file.payload) || !Array.isArray(file.payload.findings)) {
    return;
  }
  for (const finding of file.payload.findings) {
    if (!isPlainObject(finding)) {
      continue;
    }
    const suggestion = asRuleText(finding.suggestion ?? finding.recommendation);
    if (suggestion === null) {
      continue;
    }
    const severity = typeof finding.severity === "string" ? finding.severity.toUpperCase() : "";
    pushCandidate(map, suggestion, severity === "RED" ? "high" : "medium", {
      archive: file.archive,
      path: file.path,
      evidence_id: typeof finding.id === "string" ? finding.id : file.path
    });
  }
}

function extractFromTestReport(
  file: RuleCandidateScanResult["files"][number],
  map: Map<string, RuleCandidate>
): void {
  if (!isPlainObject(file.payload)) {
    return;
  }
  const failures = file.payload.failures;
  if (!Array.isArray(failures)) {
    return;
  }
  for (const failure of failures) {
    if (!isPlainObject(failure)) {
      continue;
    }
    const lesson = asRuleText(failure.lesson ?? failure.prevention);
    if (lesson === null) {
      continue;
    }
    pushCandidate(map, lesson, "medium", {
      archive: file.archive,
      path: file.path,
      evidence_id: typeof failure.id === "string" ? failure.id : file.path
    });
  }
}

function extractFromSummary(
  file: RuleCandidateScanResult["files"][number],
  map: Map<string, RuleCandidate>
): void {
  if (!isPlainObject(file.payload)) {
    return;
  }
  const pipeline = file.payload.reportPipeline;
  if (!isPlainObject(pipeline)) {
    return;
  }
  const issues = pipeline.validationIssues;
  if (!Array.isArray(issues)) {
    return;
  }
  for (const issue of issues) {
    if (!isPlainObject(issue)) {
      continue;
    }
    if (issue.type !== "structured_output_validation_failed") {
      continue;
    }
    const details = isPlainObject(issue.details) ? issue.details : {};
    const errors = Array.isArray(details.errors) ? details.errors.length : 0;
    const warnings = Array.isArray(details.warnings) ? details.warnings.length : 0;
    const text = asRuleText(
      `结构化输出校验失败 ${errors + warnings} 次：交付前必须按 schema 校验报告字段。`
    );
    if (text === null) {
      continue;
    }
    pushCandidate(map, text, "high", {
      archive: file.archive,
      path: file.path,
      evidence_id: typeof issue.stage === "string" ? issue.stage : file.path
    });
  }
}

export function extractRuleCandidates(scan: RuleCandidateScanResult): {
  candidates: RuleCandidate[];
  rejected_untrusted: number;
} {
  const map = new Map<string, RuleCandidate>();
  let rejected = scan.rejected_untrusted;
  for (const file of scan.files) {
    const before = map.size;
    if (file.kind === "review-findings") {
      extractFromReviewFindings(file, map);
    } else if (file.kind === "test-report") {
      extractFromTestReport(file, map);
    } else {
      extractFromSummary(file, map);
    }
    if (map.size === before && !isPlainObject(file.payload)) {
      rejected += 1;
    }
  }
  for (const candidate of map.values()) {
    if (candidate.occurrences >= 2 && candidate.confidence === "medium") {
      candidate.confidence = "high";
    }
  }
  return {
    candidates: [...map.values()].sort((left, right) => left.rule_key.localeCompare(right.rule_key)),
    rejected_untrusted: rejected
  };
}

// 受管段容量护栏：AGENTS.md 是每轮对话都注入的指令文件，学习段必须有限。
export const MAX_LEARNED_RULES = 20;

// v0 评审流遗留的本机状态文件（v1.0 起不再写入，refresh 时顺手清掉）。
const LEGACY_RULE_STATE_FILES = [
  "rule-candidates.json",
  "rule-review-queue.json"
] as const;

export interface LearnedRulesRefreshResult {
  changed: boolean;
  dry_run: boolean;
  agents_md_present: boolean;
  conflict: boolean;
  learned_rules: string[];
  candidates_total: number;
  candidates_high: number;
  scanned_archives: number;
  rejected_untrusted: number;
  removed_legacy_state: string[];
}

export interface RefreshLearnedRulesOptions extends ExtractRuleCandidatesOptions {
  dryRun?: boolean;
}

/**
 * 归档后自动规则学习：扫描 .harness/archive 证据，提取通过注入过滤的高置信
 * 候选，幂等刷新 AGENTS.md 的 harness-learned-rules 受管段（与用户手写内容
 * 隔离；候选集合不变时不产生任何写入）。
 *
 * 排序策略：先按出现次数降序、再按 rule_key 字典序，保证同一归档集合渲染出
 * 字节级稳定的块内容（幂等性的前提）；超过 MAX_LEARNED_RULES 截断。
 */
export async function refreshLearnedRules(
  projectRoot: string,
  options?: RefreshLearnedRulesOptions
): Promise<LearnedRulesRefreshResult> {
  const dryRun = options?.dryRun === true;
  const scan = await scanRuleCandidateEvidence(projectRoot, options);
  const extracted = extractRuleCandidates(scan);
  const highConfidence = extracted.candidates.filter((candidate) => candidate.confidence === "high");
  const ranked = [...highConfidence].sort((left, right) =>
    right.occurrences - left.occurrences || left.rule_key.localeCompare(right.rule_key)
  );
  const rules = ranked.slice(0, MAX_LEARNED_RULES).map((candidate) => candidate.text);

  const result: LearnedRulesRefreshResult = {
    changed: false,
    dry_run: dryRun,
    agents_md_present: true,
    conflict: false,
    learned_rules: rules,
    candidates_total: extracted.candidates.length,
    candidates_high: highConfidence.length,
    scanned_archives: scan.scanned_archives,
    rejected_untrusted: extracted.rejected_untrusted,
    removed_legacy_state: []
  };

  const agentsPath = join(projectRoot, "AGENTS.md");
  let original: string;
  try {
    original = await readFile(agentsPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      // 未初始化（或被用户删除）的项目不学规则：refresh/uninstall 等路径会遇到。
      result.agents_md_present = false;
      return result;
    }
    throw error;
  }

  const next = upsertManagedBlockById(
    original,
    AGENTS_LEARNED_RULES_BLOCK_ID,
    renderLearnedRulesBlock(rules)
  );
  result.changed = next !== original;

  if (!dryRun) {
    if (result.changed) {
      await writeFile(agentsPath, next, "utf8");
    }
    const legacyDir = join(projectRoot, ".harness", "state", "local");
    for (const file of LEGACY_RULE_STATE_FILES) {
      try {
        await rm(join(legacyDir, file), { force: true });
        result.removed_legacy_state.push(`.harness/state/local/${file}`);
      } catch {
        // 清理遗留状态是 best-effort：失败不影响学习主流程。
      }
    }
  }
  return result;
}
