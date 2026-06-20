import { sha256Bytes } from "../fs/hash.js";
import { normalizeManagedPath } from "../fs/path-safety.js";
import { parseInlineIgnores } from "./allowlist.js";
import { highEntropyCandidates } from "./entropy.js";

export const SENSITIVE_SCANNER_VERSION = "1.0.0";

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

const RULES: ReadonlyArray<{
  id: string;
  severity: FindingSeverity;
  pattern: RegExp;
  valueGroup?: number;
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
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s"']+/gi
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
      const relative = match[0].indexOf(value);
      findings.push({
        ruleId: rule.id,
        severity: rule.severity,
        offset: match.index + Math.max(0, relative),
        value
      });
    }
  }
  for (const candidate of highEntropyCandidates(content)) {
    findings.push({
      ruleId: "HH_HIGH_ENTROPY",
      severity: "high",
      offset: candidate.offset,
      value: candidate.value
    });
  }
  return findings;
}

export function scanSensitiveFiles(
  files: Readonly<Record<string, string>>,
  options: ScanOptions = {}
): {
  scanner_version: string;
  blocked: boolean;
  findings: SensitiveFinding[];
  override_evidence: ReadonlyArray<Readonly<OverrideEvidence>>;
} {
  const findings: SensitiveFinding[] = [];
  const evidence: Array<Readonly<OverrideEvidence>> = [];
  const recordedAt = (options.now ?? new Date()).toISOString();
  for (const [inputPath, content] of Object.entries(files).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const path = normalizeManagedPath(inputPath);
    const ignores = parseInlineIgnores(content);
    for (const raw of rawFindings(content)) {
      const position = location(content, raw.offset);
      const fingerprint = sha256Bytes([
        SENSITIVE_SCANNER_VERSION,
        raw.ruleId,
        path,
        String(position.line),
        String(position.column),
        sha256Bytes(raw.value)
      ].join("\0"));
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
    findings,
    override_evidence: Object.freeze(evidence)
  };
}
