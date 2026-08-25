import { execFile } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  ManagedBlockStructureError,
  parseManagedBlocks
} from "@hunter-harness/core";

import type { CommandDependencies } from "./configure.js";
import { resolvePythonRuntime } from "../runtime/python.js";

const execFileAsync = promisify(execFile);

export interface DoctorCommandOptions {
  runtime?: boolean;
  managedBlocks?: boolean;
  fix?: boolean;
  json?: boolean;
}

interface FixAction {
  action: string;
  target: string;
  ok: boolean;
  detail: string;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the deployed skills root from .harness/context-index.json. */
async function resolveSkillsRoot(root: string): Promise<string | null> {
  try {
    const raw = await readFile(join(root, ".harness", "context-index.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      adapters?: Record<string, { skills_root?: string }>;
    };
    for (const adapter of Object.values(parsed.adapters ?? {})) {
      const skillsRoot = adapter.skills_root;
      if (typeof skillsRoot === "string" && skillsRoot.trim() !== "") {
        const absolute = join(root, skillsRoot);
        if (await pathExists(absolute)) return absolute;
      }
    }
  } catch {
    // Fall through to conventional roots.
  }
  for (const candidate of [".claude/skills", ".cursor/skills", ".codebuddy/skills", ".pi/skills"]) {
    const absolute = join(root, candidate);
    if (await pathExists(absolute)) return absolute;
  }
  return null;
}

async function runPython(
  argvPrefix: readonly string[],
  args: readonly string[],
  cwd: string
): Promise<{ ok: boolean; detail: string }> {
  const executable = argvPrefix[0];
  if (executable === undefined) {
    return { ok: false, detail: "python runtime unavailable" };
  }
  try {
    const { stdout, stderr } = await execFileAsync(
      executable,
      [...argvPrefix.slice(1), ...args],
      {
        cwd,
        encoding: "utf8",
        timeout: 120_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024
      }
    );
    const output = (stdout || stderr).trim();
    return { ok: true, detail: output.split(/\r?\n/).slice(-1)[0] ?? "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: message.split(/\r?\n/, 1)[0] ?? "python invocation failed" };
  }
}

export interface DoctorWarning {
  path: string;
  code: string;
  message: string;
}

/** True when the project has the pi adapter enabled (context-index or deployed root). */
async function piAdapterInUse(root: string): Promise<boolean> {
  try {
    const raw = await readFile(join(root, ".harness", "context-index.json"), "utf8");
    const parsed = JSON.parse(raw) as { adapters?: Record<string, unknown> };
    if (Object.keys(parsed.adapters ?? {}).includes("pi")) return true;
  } catch {
    // Fall through to the deployed-root probe.
  }
  return pathExists(join(root, ".pi", "skills"));
}

/**
 * pi loads AGENTS.override.md instead of AGENTS.md in the same directory,
 * so a user-authored override silently shadows the harness-generated root
 * projection. Surface that as a warning (pi only reads AGENTS.md variants;
 * other agents are unaffected).
 */
async function collectPiWarnings(root: string): Promise<DoctorWarning[]> {
  if (!(await piAdapterInUse(root))) return [];
  if (!(await pathExists(join(root, "AGENTS.override.md")))) return [];
  return [{
    path: "AGENTS.override.md",
    code: "PI_AGENTS_OVERRIDE_SHADOWS_PROJECTION",
    message:
      "pi loads AGENTS.override.md instead of the harness-generated AGENTS.md; " +
      "projected instructions are ignored until the override is removed or reconciled"
  }];
}

/**
 * Rebuild regenerable local execution-log projections. Knowledge is remote
 * owned and is deliberately never repaired or indexed on the client.
 */
async function applyFixes(
  root: string,
  argvPrefix: readonly string[],
  fixes: FixAction[]
): Promise<void> {
  const skillsRoot = await resolveSkillsRoot(root);
  if (skillsRoot === null) {
    fixes.push({
      action: "resolve-skills-root",
      target: root,
      ok: false,
      detail: "no deployed harness skills root found; run hunter-harness sync first"
    });
    return;
  }

  const eventsScript = join(skillsRoot, "scripts", "harness_events.py");
  if (await pathExists(eventsScript)) {
    const changesRoot = join(root, ".harness", "changes");
    let changeNames: string[];
    try {
      changeNames = (await readdir(changesRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      changeNames = [];
    }
    for (const name of changeNames) {
      const changeDir = join(changesRoot, name);
      if (!(await pathExists(join(changeDir, "events.ndjson")))) continue;
      const result = await runPython(
        argvPrefix,
        [eventsScript, "render", "--change-dir", changeDir],
        root
      );
      fixes.push({
        action: "render-execution-log",
        target: changeDir,
        ok: result.ok,
        detail: result.detail
      });
    }
  }

}

export async function runDoctor(
  options: DoctorCommandOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const runtimeRequested = options.runtime === true ||
    options.fix === true ||
    options.managedBlocks !== true;
  const python = runtimeRequested
    ? await resolvePythonRuntime({
      projectRoot: dependencies.cwd,
      env: dependencies.env
    })
    : null;
  const findings: Array<{
    path: string;
    code: string;
    message: string;
    repairPreview: string;
  }> = [];
  if (options.managedBlocks === true) {
    for (const relativePath of ["AGENTS.md", "CLAUDE.md", "CODEBUDDY.md"]) {
      try {
        parseManagedBlocks(
          await readFile(join(dependencies.cwd, relativePath), "utf8")
        );
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          continue;
        }
        if (error instanceof ManagedBlockStructureError) {
          findings.push({
            path: relativePath,
            code: error.code,
            message: error.message,
            repairPreview:
              "Preserve user-authored content; repair marker pairs manually or apply a reviewed block-level artifact."
          });
          continue;
        }
        throw error;
      }
    }
  }
  const fixes: FixAction[] = [];
  if (options.fix === true && python !== null && python.available) {
    await applyFixes(dependencies.cwd, python.argvPrefix, fixes);
  }
  const warnings = await collectPiWarnings(dependencies.cwd);
  const runtimeFailed = python !== null && !python.available;
  const fixFailed = fixes.some((fix) => !fix.ok);
  const status = runtimeFailed
    ? "FAIL"
    : findings.length > 0 || fixFailed || warnings.length > 0
      ? "WARN"
      : "OK";
  const payload = {
    schemaVersion: 1,
    status,
    reasonCode: runtimeFailed
      ? "PYTHON_RUNTIME_UNAVAILABLE"
      : findings.length > 0
        ? "MANAGED_BLOCK_STRUCTURE_INVALID"
        : warnings.length > 0
          ? warnings[0]?.code
          : fixFailed
            ? "FIX_PARTIAL"
            : "OK",
    ...(python === null ? {} : { runtime: { python } }),
    managedBlocks: {
      checked: options.managedBlocks === true,
      findings
    },
    warnings,
    ...(options.fix === true ? { fixes } : {})
  };
  dependencies.stdout(JSON.stringify(payload) + "\n");
  return runtimeFailed ? 4 : findings.length > 0 || warnings.length > 0 ? 5 : 0;
}
