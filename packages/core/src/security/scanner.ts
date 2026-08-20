import { sha256Bytes } from "../fs/hash.js";
import { normalizeManagedPath } from "../fs/path-safety.js";
import { parseInlineIgnores } from "./allowlist.js";
import { highEntropyCandidates } from "./entropy.js";

export const SENSITIVE_SCANNER_VERSION = "1.1.0";

export type FindingSeverity = "high" | "medium" | "low";

export interface SensitiveFinding {
  rule_id: string;
  severity: FindingSeverity;
  path: string;
  line: number;
  column: number;
  fingerprint: string;
  redacted_preview: string;
  overridable: boolean;
  disposition: "blocked" | "overridden";
}

export interface FindingOverride {
  finding_fingerprint: string;
  actor: string;
  reason: string;
}

export interface OverrideEvidence {
  finding_fingerprint: string;
  rule_id: string;
  path: string;
  actor: string;
  reason: string;
  source: "explicit-confirmation" | "inline-annotation";
  scanner_version: string;
  recorded_at: string;
}

/**
 * How a *publication gate* reacts to findings. This only governs gates that
 * decide "may these bytes leave the machine" (push/pull, archive upload); the
 * evidence-filtering callers that use `blocked` to keep secrets out of an
 * uploaded proposal always scan at full strength and ignore the policy.
 *
 * - `block` — historical behaviour: any blocked finding stops the operation.
 * - `warn`  — findings are still computed and reported, but never stop it.
 * - `off`   — no scan at all; no findings are produced.
 */
export type SensitiveScanPolicy = "off" | "warn" | "block";

export const SENSITIVE_SCAN_POLICY_ENV = "HUNTER_HARNESS_SENSITIVE_SCAN";
export const DEFAULT_SENSITIVE_SCAN_POLICY: SensitiveScanPolicy = "warn";

/** Resolve the publication-gate policy from the environment (default `warn`). */
export function resolveSensitiveScanPolicy(
  env: Readonly<Record<string, string | undefined>> = {}
): SensitiveScanPolicy {
  const raw = (env[SENSITIVE_SCAN_POLICY_ENV] ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "false" || raw === "0" || raw === "disabled") return "off";
  if (raw === "warn" || raw === "advisory") return "warn";
  if (raw === "block" || raw === "true" || raw === "1" || raw === "enforce") return "block";
  return DEFAULT_SENSITIVE_SCAN_POLICY;
}

export interface ScanOptions {
  overrides?: readonly FindingOverride[];
  now?: Date;
}

interface RawFinding {
  ruleId: string;
  severity: FindingSeverity;
  offset: number;
  value: string;
}

function compareCodepoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * A connection string only leaks a credential when it carries one. Bare
 * `jdbc:mysql://host:3306/db` lines are ordinary documentation and used to be
 * scored `high`, which made them permanently unpushable.
 */
function databaseUrlSeverity(value: string): FindingSeverity {
  const authority = /:\/\/([^/?#]*)/.exec(value)?.[1] ?? "";
  const userinfo = authority.includes("@") ? authority.slice(0, authority.lastIndexOf("@")) : "";
  return userinfo.includes(":") ? "high" : "low";
}

const RULES: ReadonlyArray<{
  id: string;
  severity: FindingSeverity;
  pattern: RegExp;
  valueGroup?: number;
  severityFor?: (value: string) => FindingSeverity;
}> = [
  {
    id: "HH_PRIVATE_KEY",
    severity: "high",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g
  },
  {
    id: "HH_GITHUB_TOKEN",
    severity: "high",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g
  },
  {
    id: "HH_AWS_ACCESS_KEY",
    severity: "high",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g
  },
  {
    id: "HH_AUTHORIZATION_BEARER",
    severity: "high",
    pattern: /Authorization\s*:\s*Bearer\s+([A-Za-z0-9._~+/-]{12,})/gi,
    valueGroup: 1
  },
  {
    id: "HH_DATABASE_URL",
    severity: "high",
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"']+/gi,
    severityFor: databaseUrlSeverity
  },
  {
    id: "HH_PASSWORD_VALUE",
    severity: "medium",
    pattern: /(?:password|passwd|pwd)\s*[:=]\s*["']?([^\s"'<>]{8,})/gi,
    valueGroup: 1
  },
  {
    id: "HH_INTERNAL_ADDRESS",
    severity: "medium",
    pattern: /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.(?:\d{1,3}\.)\d{1,3})\b/g
  },
  {
    id: "HH_WINDOWS_ABSOLUTE_PATH",
    severity: "low",
    pattern: /\b[A-Za-z]:\\(?:[^\s<>:"|?*]+\\)*[^\s<>:"|?*]*/g
  }
];

function location(content: string, offset: number): { line: number; column: number } {
  const prefix = content.slice(0, offset);
  const lines = prefix.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function rawFindings(content: string): RawFinding[] {
  const findings: RawFinding[] = [];
  for (const rule of RULES) {
    for (const match of content.matchAll(rule.pattern)) {
      const value = match[rule.valueGroup ?? 0] ?? match[0];
      if (rule.id === "HH_PASSWORD_VALUE" && isObviousPlaceholder(value)) {
        continue;
      }
      const relative = match[0].indexOf(value);
      findings.push({
        ruleId: rule.id,
        severity: rule.severityFor?.(match[0]) ?? rule.severity,
        offset: match.index + Math.max(0, relative),
        value
      });
    }
  }
  for (const candidate of highEntropyCandidates(content)) {
    if (!hasSensitiveLexicalContext(content, candidate.offset)) continue;
    findings.push({
      ruleId: "HH_HIGH_ENTROPY",
      severity: "high",
      offset: candidate.offset,
      value: candidate.value
    });
  }
  return findings;
}

function isObviousPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return /^\$\([^)]+\)$/.test(trimmed) ||
    /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(trimmed) ||
    /^\{\{[^{}]+\}\}$/.test(trimmed) ||
    /^<[^<>]+>$/.test(trimmed) ||
    /^(?:example|placeholder|your[-_][a-z0-9_-]+)$/i.test(trimmed);
}

function hasSensitiveLexicalContext(content: string, offset: number): boolean {
  const lineStart = content.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  const nextLineBreak = content.indexOf("\n", offset);
  const lineEnd = nextLineBreak === -1 ? content.length : nextLineBreak;
  const line = content.slice(lineStart, lineEnd);
  return /(?:secret|token|password|passwd|pwd|api[_-]?key|credential|authorization|bearer)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{8,}/i
    .test(line);
}

export function scanSensitiveFiles(
  files: Readonly<Record<string, string>>,
  options: ScanOptions = {}
): {
  scanner_version: string;
  blocked: boolean;
  hard_blocked: boolean;
  review_required: boolean;
  findings: SensitiveFinding[];
  override_evidence: ReadonlyArray<Readonly<OverrideEvidence>>;
} {
  const findings: SensitiveFinding[] = [];
  const evidence: Array<Readonly<OverrideEvidence>> = [];
  const recordedAt = (options.now ?? new Date()).toISOString();
  for (const [inputPath, content] of Object.entries(files).sort(([a], [b]) =>
    compareCodepoint(a, b)
  )) {
    const path = normalizeManagedPath(inputPath);
    const ignores = parseInlineIgnores(content);
    const knowledgeMetadata = path === ".harness/knowledge" ||
      path.startsWith(".harness/knowledge/");
    const archiveMetadata = path === ".harness/archive" ||
      path.startsWith(".harness/archive/");
    for (const raw of rawFindings(content)) {
      // Knowledge/archive index files routinely record local projectRoot paths; that is
      // metadata, not a credential leak worth blocking push.
      if ((knowledgeMetadata || archiveMetadata) &&
          raw.ruleId === "HH_WINDOWS_ABSOLUTE_PATH") {
        continue;
      }
      const position = location(content, raw.offset);
      const fingerprint = sha256Bytes([
        SENSITIVE_SCANNER_VERSION,
        raw.ruleId,
        path,
        String(position.line),
        String(position.column),
        sha256Bytes(raw.value)
      ].join("\0"));
      // A `high` finding stays non-overridable per finding. The sanctioned exit
      // for a gate that is wrong about a whole project is the scan policy
      // (`HUNTER_HARNESS_SENSITIVE_SCAN`), not a per-finding waiver on leaked
      // key material.
      const overridable = raw.severity !== "high";
      const explicit = options.overrides?.find(
        (item) => item.finding_fingerprint === fingerprint
      );
      const inline = ignores.find((item) => item.ruleId === raw.ruleId);
      const override = overridable ? explicit ?? (inline === undefined ? undefined : {
        finding_fingerprint: fingerprint,
        actor: "inline-annotation",
        reason: inline.reason
      }) : undefined;
      if (override !== undefined) {
        evidence.push(Object.freeze({
          finding_fingerprint: fingerprint,
          rule_id: raw.ruleId,
          path,
          actor: override.actor,
          reason: override.reason,
          source: explicit === undefined ? "inline-annotation" : "explicit-confirmation",
          scanner_version: SENSITIVE_SCANNER_VERSION,
          recorded_at: recordedAt
        }));
      }
      findings.push({
        rule_id: raw.ruleId,
        severity: raw.severity,
        path,
        line: position.line,
        column: position.column,
        fingerprint,
        redacted_preview: "[REDACTED:" + raw.ruleId + "]",
        overridable,
        disposition: override === undefined ? "blocked" : "overridden"
      });
    }
  }
  return {
    scanner_version: SENSITIVE_SCANNER_VERSION,
    blocked: findings.some((finding) => finding.disposition === "blocked"),
    hard_blocked: findings.some((finding) =>
      finding.disposition === "blocked" && finding.severity === "high"
    ),
    review_required: findings.some((finding) =>
      finding.disposition === "blocked" && finding.severity !== "high"
    ),
    findings,
    override_evidence: Object.freeze(evidence)
  };
}

export interface SensitiveScanResult {
  scan_performed?: boolean;
  scanner_version: string;
  blocked: boolean;
  hard_blocked: boolean;
  review_required: boolean;
  findings: SensitiveFinding[];
  override_evidence: ReadonlyArray<Readonly<OverrideEvidence>>;
}

/**
 * Scan for a publication gate under the given policy.
 *
 * `warn` keeps the findings, so the operator still sees exactly which path,
 * line and rule tripped, but clears every blocking flag: the gate reports and
 * proceeds. `off` skips the scan entirely. `block` is the historical behaviour.
 */
export function scanSensitiveFilesForPublication(
  files: Readonly<Record<string, string>>,
  policy: SensitiveScanPolicy,
  options: ScanOptions = {}
): SensitiveScanResult {
  if (policy === "off") {
    return {
      scan_performed: false,
      scanner_version: SENSITIVE_SCANNER_VERSION,
      blocked: false,
      hard_blocked: false,
      review_required: false,
      findings: [],
      override_evidence: Object.freeze([])
    };
  }
  const result = scanSensitiveFiles(files, options);
  if (policy === "block") return result;
  return {
    scan_performed: true,
    ...result,
    blocked: false,
    hard_blocked: false,
    review_required: false
  };
}
