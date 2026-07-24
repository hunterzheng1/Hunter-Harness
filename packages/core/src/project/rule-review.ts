import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import type { RuleCandidate, RuleCandidateManifest } from "./rule-candidates.js";

const CANDIDATE_PATH = ".harness/knowledge/rule-candidates.json";
const DECISION_PATH = ".harness/knowledge/rule-decisions.json";
const RULES_ROOT = ".harness/rules";

export type RuleDisposition =
  | "public-rule"
  | "project-knowledge"
  | "regression-test"
  | "ci-task"
  | "harness-issue"
  | "defer"
  | "reject";

export interface RulePatch {
  target_path: string;
  expected_sha256: string | null;
  content: string;
}

export interface RuleReviewDecision {
  candidate_id: string;
  candidate_revision: string;
  dispositions: RuleDisposition[];
  reason: string;
  decided_at: string;
  review_after?: string;
  rule_patch?: RulePatch;
}

export interface RuleDecisionManifest {
  schema_version: 1;
  decisions: RuleReviewDecision[];
}

export interface RuleReviewQueueItem {
  candidate_id: string;
  candidate_revision: string;
  candidate: RuleCandidate;
}

export interface RuleReviewQueue {
  schema_version: 1;
  pending: RuleReviewQueueItem[];
  decided: number;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  const content = await readOptional(path);
  if (content === null) return fallback;
  return JSON.parse(content) as T;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

function candidateRevision(candidate: RuleCandidate): string {
  return sha256(JSON.stringify(candidate));
}

function portable(path: string): string {
  return path.replaceAll("\\", "/");
}

function ruleTarget(root: string, input: string): string {
  const portablePath = portable(input);
  if (!portablePath.startsWith(`${RULES_ROOT}/`) ||
      !portablePath.toLowerCase().endsWith(".md") ||
      basename(portablePath) === "") {
    throw new Error(`RULE_PATCH_PATH_INVALID: ${input}`);
  }
  const target = resolve(root, ...portablePath.split("/"));
  const rulesRoot = resolve(root, ...RULES_ROOT.split("/"));
  const relativePath = portable(relative(rulesRoot, target));
  if (relativePath === ".." || relativePath.startsWith("../")) {
    throw new Error(`RULE_PATCH_PATH_INVALID: ${input}`);
  }
  return target;
}

function validateDecision(
  decision: RuleReviewDecision,
  candidates: ReadonlyMap<string, RuleCandidate>
): RuleCandidate {
  const candidate = candidates.get(decision.candidate_id);
  if (candidate === undefined) {
    throw new Error(`RULE_CANDIDATE_UNKNOWN: ${decision.candidate_id}`);
  }
  if (candidateRevision(candidate) !== decision.candidate_revision) {
    throw new Error(`RULE_CANDIDATE_STALE: ${decision.candidate_id}`);
  }
  if (decision.dispositions.length === 0 || decision.reason.trim().length < 8) {
    throw new Error(`RULE_DECISION_INVALID: ${decision.candidate_id}`);
  }
  if (decision.dispositions.includes("defer") && decision.review_after === undefined) {
    throw new Error(`RULE_DECISION_REVIEW_AFTER_REQUIRED: ${decision.candidate_id}`);
  }
  if (decision.dispositions.includes("public-rule") !== (decision.rule_patch !== undefined)) {
    throw new Error(`RULE_PATCH_REQUIRED: ${decision.candidate_id}`);
  }
  return candidate;
}

async function readCandidates(root: string): Promise<RuleCandidateManifest> {
  return readJson<RuleCandidateManifest>(
    join(root, ...CANDIDATE_PATH.split("/")),
    { schema_version: 1, source_hashes: {}, candidates: [] }
  );
}

async function readDecisions(root: string): Promise<RuleDecisionManifest> {
  return readJson<RuleDecisionManifest>(
    join(root, ...DECISION_PATH.split("/")),
    { schema_version: 1, decisions: [] }
  );
}

export async function exportRuleReviewQueue(projectRoot: string): Promise<RuleReviewQueue> {
  const root = resolve(projectRoot);
  const candidates = await readCandidates(root);
  const decisions = await readDecisions(root);
  const decided = new Set(decisions.decisions.map((decision) =>
    `${decision.candidate_id}\0${decision.candidate_revision}`
  ));
  const pending = candidates.candidates.flatMap((candidate) => {
    const revision = candidateRevision(candidate);
    return decided.has(`${candidate.id}\0${revision}`)
      ? []
      : [{
          candidate_id: candidate.id,
          candidate_revision: revision,
          candidate
        }];
  });
  return {
    schema_version: 1,
    pending,
    decided: candidates.candidates.length - pending.length
  };
}

export async function applyRuleReviewDecisions(
  projectRoot: string,
  input: RuleDecisionManifest
): Promise<{ applied: number; recorded: number; path: string }> {
  if (input.schema_version !== 1 || !Array.isArray(input.decisions)) {
    throw new Error("RULE_DECISIONS_INVALID");
  }
  const root = resolve(projectRoot);
  const candidateManifest = await readCandidates(root);
  const candidates = new Map(candidateManifest.candidates.map((candidate) => [
    candidate.id,
    candidate
  ]));
  const plannedPatches: Array<{ path: string; content: string }> = [];
  for (const decision of input.decisions) {
    validateDecision(decision, candidates);
    if (decision.rule_patch === undefined) continue;
    const target = ruleTarget(root, decision.rule_patch.target_path);
    const current = await readOptional(target);
    const currentHash = current === null ? null : sha256(current);
    if (currentHash !== decision.rule_patch.expected_sha256) {
      throw new Error(`RULE_PATCH_STALE: ${decision.rule_patch.target_path}`);
    }
    plannedPatches.push({ path: target, content: decision.rule_patch.content });
  }

  const currentManifest = await readDecisions(root);
  const replacements = new Map(input.decisions.map((decision) => [
    `${decision.candidate_id}\0${decision.candidate_revision}`,
    decision
  ]));
  for (const decision of currentManifest.decisions) {
    const key = `${decision.candidate_id}\0${decision.candidate_revision}`;
    if (!replacements.has(key)) replacements.set(key, decision);
  }
  const next: RuleDecisionManifest = {
    schema_version: 1,
    decisions: [...replacements.values()].sort((left, right) =>
      left.candidate_id.localeCompare(right.candidate_id) ||
      left.candidate_revision.localeCompare(right.candidate_revision)
    )
  };

  for (const patch of plannedPatches) await atomicWrite(patch.path, patch.content);
  await atomicWrite(
    join(root, ...DECISION_PATH.split("/")),
    JSON.stringify(next, null, 2) + "\n"
  );
  return {
    applied: plannedPatches.length,
    recorded: input.decisions.length,
    path: DECISION_PATH
  };
}
