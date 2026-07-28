import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

function probe(command, argsPrefix) {
  const result = spawnSync(
    command,
    [...argsPrefix, "--version"],
    {
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: 5_000
    }
  );
  const version = String(result.stdout || result.stderr || "").trim().split(/\r?\n/, 1)[0] ?? "";
  return result.status === 0 && /^Python \d+\./.test(version)
    ? { available: true, command, argsPrefix, version }
    : null;
}

export function resolvePythonRuntimeSync({
  projectRoot = process.cwd(),
  env = process.env
} = {}) {
  const configured = env.HUNTER_HARNESS_PYTHON?.trim();
  if (configured) {
    const result = probe(configured, []);
    if (result) return { ...result, source: "environment" };
  }
  // Keep legacy PYTHON as a compatibility alias while preferring the new,
  // product-specific environment variable.
  const legacyConfigured = env.PYTHON?.trim();
  if (legacyConfigured) {
    const result = probe(legacyConfigured, []);
    if (result) return { ...result, source: "legacy-environment" };
  }
  const root = resolve(projectRoot);
  const managed = process.platform === "win32"
    ? [
      join(root, ".harness", "runtime", "python", "python.exe"),
      join(root, ".venv", "Scripts", "python.exe")
    ]
    : [
      join(root, ".harness", "runtime", "python", "bin", "python"),
      join(root, ".venv", "bin", "python")
    ];
  for (const candidate of managed) {
    if (!existsSync(candidate)) continue;
    const result = probe(candidate, []);
    if (result) return { ...result, source: "managed" };
  }
  for (const candidate of [
    { command: "uv", argsPrefix: ["run", "python"], source: "uv" },
    { command: "py", argsPrefix: ["-3"], source: "py-launcher" },
    { command: "python3", argsPrefix: [], source: "python3" },
    { command: "python", argsPrefix: [], source: "python" }
  ]) {
    const result = probe(candidate.command, candidate.argsPrefix);
    if (result) return { ...result, source: candidate.source };
  }
  throw new Error(
    "PYTHON_RUNTIME_UNAVAILABLE: set HUNTER_HARNESS_PYTHON, install uv, " +
    "or provide py/python3/python on PATH"
  );
}
