import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";
import { URL } from "node:url";

const root = new URL("../", import.meta.url);
const temporary = await mkdtemp(join(tmpdir(), "hunter-pack-smoke-"));
const npmCli = process.env.npm_execpath;
if (npmCli === undefined) {
  throw new Error("npm_execpath is required to run the package smoke test");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    shell: false
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
    );
  }
  return result.stdout ?? "";
}

try {
  run(process.execPath, [
    npmCli,
    "pack",
    "-w",
    "packages/cli",
    "--pack-destination",
    temporary
  ]);
  const archive = (await readdir(temporary)).find((name) => name.endsWith(".tgz"));
  if (archive === undefined) throw new Error("npm pack did not create an archive");
  run(process.execPath, [
    npmCli,
    "install",
    "--prefix",
    temporary,
    "--ignore-scripts",
    join(temporary, archive)
  ]);
  const bin = join(
    temporary,
    "node_modules",
    "hunter-harness",
    "dist",
    "bin.js"
  );
  const preview = run(process.execPath, [bin,
    "--adapter", "claude-code",
    "--profile", "java",
    "--non-interactive",
    "--dry-run",
    "--json"
  ], { cwd: temporary, capture: true });
  const result = JSON.parse(preview.trim());
  if (result.ok !== true || result.dry_run !== true) {
    throw new Error("packaged CLI dry-run output is invalid");
  }
  await stat(join(temporary, ".harness")).then(
    () => { throw new Error("packaged CLI dry-run wrote project state"); },
    () => undefined
  );
  run(process.execPath, [bin,
    "--adapter", "claude-code",
    "--profile", "java",
    "--non-interactive",
    "--yes"
  ], { cwd: temporary, capture: true });
  await stat(join(
    temporary,
    ".claude",
    "skills",
    "harness-review",
    "SKILL.md"
  ));
  process.stdout.write("packaged CLI smoke test passed\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
