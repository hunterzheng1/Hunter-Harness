import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type PythonRuntimeSource =
  | "environment"
  | "managed"
  | "uv"
  | "py-launcher"
  | "python3"
  | "python"
  | "unavailable";

export interface PythonProbeResult {
  ok: boolean;
  version: string;
  executable: string | null;
}

export interface PythonRuntimeResolution {
  available: boolean;
  source: PythonRuntimeSource;
  executable: string | null;
  argvPrefix: string[];
  version: string;
  attempts: Array<{
    source: Exclude<PythonRuntimeSource, "unavailable">;
    argv: string[];
  }>;
}

export interface ResolvePythonRuntimeOptions {
  projectRoot: string;
  env: Readonly<Record<string, string | undefined>>;
  probe?: (argv: readonly string[]) => Promise<PythonProbeResult>;
}

export async function probePythonRuntime(
  argv: readonly string[]
): Promise<PythonProbeResult> {
  const executable = argv[0];
  if (executable === undefined) {
    return { ok: false, version: "", executable: null };
  }
  try {
    const { stdout, stderr } = await execFileAsync(
      executable,
      [...argv.slice(1), "--version"],
      {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
        maxBuffer: 64 * 1024
      }
    );
    const version = String(stdout || stderr).trim().split(/\r?\n/, 1)[0] ?? "";
    return { ok: /^Python \d+\./.test(version), version, executable };
  } catch {
    return { ok: false, version: "", executable: null };
  }
}

async function existingManagedCandidates(projectRoot: string): Promise<string[]> {
  const root = resolve(projectRoot);
  const candidates = process.platform === "win32"
    ? [
      join(root, ".harness", "runtime", "python", "python.exe"),
      join(root, ".venv", "Scripts", "python.exe")
    ]
    : [
      join(root, ".harness", "runtime", "python", "bin", "python"),
      join(root, ".venv", "bin", "python")
    ];
  const existing: string[] = [];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      existing.push(candidate);
    } catch {
      // Continue through the ordered runtime candidates.
    }
  }
  return existing;
}

export async function resolvePythonRuntime(
  options: ResolvePythonRuntimeOptions
): Promise<PythonRuntimeResolution> {
  const probe = options.probe ?? probePythonRuntime;
  const candidates: Array<{
    source: Exclude<PythonRuntimeSource, "unavailable">;
    argv: string[];
  }> = [];
  const configured = options.env.HUNTER_HARNESS_PYTHON?.trim();
  if (configured !== undefined && configured !== "") {
    candidates.push({ source: "environment", argv: [configured] });
  }
  for (const managed of await existingManagedCandidates(options.projectRoot)) {
    candidates.push({ source: "managed", argv: [managed] });
  }
  candidates.push(
    { source: "uv", argv: ["uv", "run", "python"] },
    { source: "py-launcher", argv: ["py", "-3"] },
    { source: "python3", argv: ["python3"] },
    { source: "python", argv: ["python"] }
  );
  const attempts: PythonRuntimeResolution["attempts"] = [];
  for (const candidate of candidates) {
    attempts.push({ source: candidate.source, argv: [...candidate.argv] });
    const result = await probe(candidate.argv);
    if (!result.ok) continue;
    return {
      available: true,
      source: candidate.source,
      executable: result.executable ?? candidate.argv[0] ?? null,
      argvPrefix: [...candidate.argv],
      version: result.version,
      attempts
    };
  }
  return {
    available: false,
    source: "unavailable",
    executable: null,
    argvPrefix: [],
    version: "",
    attempts
  };
}
