import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { scanSensitiveFiles, SENSITIVE_SCANNER_VERSION } from "@hunter-harness/core";

import type { CommandDependencies } from "./configure.js";

export interface ScanSensitiveOptions {
  readonly files?: readonly string[] | undefined;
  readonly root?: string | undefined;
  readonly json?: boolean | undefined;
}

/**
 * A finding the caller can act on: which rule, which line, and whether the
 * sanctioned inline waiver applies to it.
 */
interface ReportedFinding {
  readonly rule_id: string;
  readonly severity: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly fingerprint: string;
  readonly redacted_preview: string;
  readonly overridable: boolean;
  readonly disposition: string;
  readonly recovery_action: string;
}

function recoveryAction(ruleId: string, overridable: boolean, path: string, line: number): string {
  if (!overridable) {
    return (
      `${path}:${line} 命中 ${ruleId}（high）。这类内容不提供豁免：真正脱敏后重新打包。`
    );
  }
  return (
    `${path}:${line} 命中 ${ruleId}。若确属设计固有内容，在该行附近加行内标注后重新打包：` +
    `hunter-harness-ignore: ${ruleId} reason=<简短理由>`
  );
}

/**
 * Scan files with the *same* rule set the publication path uses.
 *
 * The archive gate previously ran its own pattern list over the whole change
 * tree, which is neither what gets published nor the rules the server applies —
 * so a scratch diff could block the archive while a real internal address in a
 * design doc sailed through to a 422 on upload. This command exists so the
 * Python archive path can pre-check the exact package members against the
 * canonical scanner instead of guessing.
 */
export async function runScanSensitive(
  options: ScanSensitiveOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const root = options.root === undefined ? process.cwd() : resolve(options.root);
  const requested = options.files ?? [];
  if (requested.length === 0) {
    dependencies.stdout(JSON.stringify({
      schema_version: 1,
      ok: false,
      reason_code: "SCAN_SENSITIVE_NO_INPUT",
      message: "至少需要一个 --file <相对路径>",
      scanner_version: SENSITIVE_SCANNER_VERSION
    }) + "\n");
    return 2;
  }

  const files: Record<string, string> = {};
  const unreadable: { path: string; error: string }[] = [];
  for (const relative of requested) {
    try {
      files[relative] = await readFile(resolve(root, relative), "utf8");
    } catch (error) {
      unreadable.push({
        path: relative,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const result = scanSensitiveFiles(files);
  const findings: ReportedFinding[] = result.findings.map((finding) => ({
    rule_id: finding.rule_id,
    severity: finding.severity,
    path: finding.path,
    line: finding.line,
    column: finding.column,
    fingerprint: finding.fingerprint,
    redacted_preview: finding.redacted_preview,
    overridable: finding.overridable,
    disposition: finding.disposition,
    recovery_action: recoveryAction(
      finding.rule_id,
      finding.overridable,
      finding.path,
      finding.line
    )
  }));

  dependencies.stdout(JSON.stringify({
    schema_version: 1,
    ok: unreadable.length === 0,
    scanner_version: result.scanner_version,
    scanned_count: Object.keys(files).length,
    blocked: result.blocked,
    hard_blocked: result.hard_blocked,
    review_required: result.review_required,
    findings,
    unreadable
  }) + "\n");
  return unreadable.length === 0 ? 0 : 1;
}
