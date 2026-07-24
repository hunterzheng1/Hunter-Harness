import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

const ARCHIVE_ROOT = ".harness/archive";
const CANDIDATE_PATH = ".harness/knowledge/rule-candidates.json";
const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const EVIDENCE_NAMES = [
  /^review-findings.*\.json$/i,
  /^test-(?:report|results?|failures?).*\.json$/i,
  /^summary-data\.json$/i
];

export interface RuleCandidateEvidence {
  archive: string;
  path: string;
  kind: "review" | "test" | "validation";
  record_id: string | null;
}

export interface RuleCandidate {
  id: string;
  status: "candidate";
  title: string;
  proposed_rule: string;
  confidence: "medium" | "high";
  severity: string;
  occurrences: number;
  evidence: RuleCandidateEvidence[];
}

export interface RuleCandidateManifest {
  schema_version: 1;
  source_hashes: Record<string, string>;
  candidates: RuleCandidate[];
}

export interface RuleCandidateSyncResult {
  path: string;
  scanned: number;
  candidates: number;
  changed: boolean;
  rejected_untrusted: number;
}

interface CandidateObservation {
  title: string;
  proposedRule: string;
  severity: string;
  evidence: RuleCandidateEvidence;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function portable(path: string): string {
  return path.replaceAll("\\", "/");
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function safeText(value: unknown, limit = 500): string | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeText(value).slice(0, limit);
  if (normalized.length < 8) return null;
  if (/(?:ignore|disregard)\s+(?:all\s+)?previous|system\s+prompt|developer\s+message/i.test(normalized)) {
    return null;
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{20,}|(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\//i.test(normalized)) {
    return null;
  }
  return normalized;
}

function stringField(record: Record<string, unknown>, names: readonly string[]): string | null {
  for (const name of names) {
    const value = safeText(record[name]);
    if (value !== null) return value;
  }
  return null;
}

function severityOf(record: Record<string, unknown>): string {
  const value = record.severity ?? record.level ?? record.priority ?? "unknown";
  return typeof value === "string" ? value.toLowerCase() : "unknown";
}

function highSeverity(severity: string): boolean {
  return /^(?:red|critical|high|error|blocker|p0|p1)$/.test(severity);
}

function evidenceKind(path: string): RuleCandidateEvidence["kind"] {
  const name = basename(path).toLowerCase();
  if (name.startsWith("review-")) return "review";
  if (name.startsWith("test-")) return "test";
  return "validation";
}

function observationFrom(
  record: Record<string, unknown>,
  path: string,
  archive: string
): CandidateObservation | null {
  const severity = severityOf(record);
  const suggestion = stringField(record, [
    "proposed_rule", "proposedRule", "suggestion", "recommendation", "remediation"
  ]);
  const issue = stringField(record, ["issue", "message", "error", "failure"]);
  const title = stringField(record, ["title", "name", "id", "code"]) ?? issue;
  let proposedRule = suggestion;
  if (proposedRule === null && issue !== null && highSeverity(severity)) {
    proposedRule = `必须增加可重复验证，防止以下问题再次出现：${issue}`;
  }
  if (proposedRule === null || title === null) return null;
  const recordId = record.id ?? record.code ?? record.name ?? null;
  return {
    title,
    proposedRule,
    severity,
    evidence: {
      archive,
      path,
      kind: evidenceKind(path),
      record_id: typeof recordId === "string" ? recordId.slice(0, 120) : null
    }
  };
}

function collectObservations(
  value: unknown,
  path: string,
  archive: string,
  output: CandidateObservation[],
  rejected: { count: number }
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectObservations(item, path, archive, output, rejected);
    return;
  }
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const candidate = observationFrom(record, path, archive);
  if (candidate !== null) output.push(candidate);
  else if (Object.keys(record).some((key) =>
    ["suggestion", "recommendation", "proposed_rule", "proposedRule"].includes(key)
  )) rejected.count += 1;
  for (const nested of Object.values(record)) {
    if (nested !== null && typeof nested === "object") {
      collectObservations(nested, path, archive, output, rejected);
    }
  }
}

async function evidenceFiles(root: string): Promise<string[]> {
  const archiveRoot = join(root, ...ARCHIVE_ROOT.split("/"));
  const output: string[] = [];
  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && EVIDENCE_NAMES.some((pattern) => pattern.test(entry.name))) {
        if ((await stat(path)).size <= MAX_EVIDENCE_BYTES) output.push(path);
      }
    }
  }
  await walk(archiveRoot);
  return output.sort();
}

function candidateKey(rule: string): string {
  return normalizeText(rule).toLocaleLowerCase();
}

function buildCandidates(observations: CandidateObservation[]): RuleCandidate[] {
  const grouped = new Map<string, CandidateObservation[]>();
  for (const observation of observations) {
    const key = candidateKey(observation.proposedRule);
    const values = grouped.get(key) ?? [];
    values.push(observation);
    grouped.set(key, values);
  }
  const candidates: RuleCandidate[] = [];
  for (const [key, values] of grouped) {
    const archives = new Set(values.map((value) => value.evidence.archive));
    const highest = values.find((value) => highSeverity(value.severity));
    if (archives.size < 2 && highest === undefined) continue;
    const representative = highest ?? values.at(0);
    if (representative === undefined) continue;
    const evidence = [...new Map(values.map((value) => [
      `${value.evidence.path}\0${value.evidence.record_id ?? ""}`,
      value.evidence
    ])).values()].sort((a, b) => a.path.localeCompare(b.path));
    candidates.push({
      id: `rule_${sha256(key).slice(0, 16)}`,
      status: "candidate",
      title: representative.title,
      proposed_rule: representative.proposedRule,
      confidence: archives.size >= 2 && highest !== undefined ? "high" : "medium",
      severity: representative.severity,
      occurrences: evidence.length,
      evidence
    });
  }
  return candidates.sort((a, b) => a.id.localeCompare(b.id));
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

export async function synchronizeRuleCandidates(
  projectRoot: string,
  options: { dryRun?: boolean } = {}
): Promise<RuleCandidateSyncResult> {
  const root = resolve(projectRoot);
  const files = await evidenceFiles(root);
  const sourceHashes: Record<string, string> = {};
  const observations: CandidateObservation[] = [];
  const rejected = { count: 0 };
  for (const path of files) {
    const relativePath = portable(relative(root, path));
    const content = await readFile(path, "utf8");
    sourceHashes[relativePath] = sha256(content);
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      continue;
    }
    const archive = relativePath.split("/")[2] ?? "unknown";
    collectObservations(parsed, relativePath, archive, observations, rejected);
  }
  const manifest: RuleCandidateManifest = {
    schema_version: 1,
    source_hashes: sourceHashes,
    candidates: buildCandidates(observations)
  };
  const content = JSON.stringify(manifest, null, 2) + "\n";
  const destination = join(root, ...CANDIDATE_PATH.split("/"));
  let current: string | null = null;
  try {
    current = await readFile(destination, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const changed = current !== content;
  if (changed && options.dryRun !== true) await atomicWrite(destination, content);
  return {
    path: CANDIDATE_PATH,
    scanned: files.length,
    candidates: manifest.candidates.length,
    changed,
    rejected_untrusted: rejected.count
  };
}
