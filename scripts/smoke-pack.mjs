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
  for (const legacyResource of ["bootstrap-ir", "skills"]) {
    await stat(join(temporary, "node_modules", "hunter-harness", "resources", legacyResource)).then(
      () => { throw new Error(`packaged CLI must not contain legacy resource: ${legacyResource}`); },
      () => undefined
    );
  }
  const bin = join(
    temporary,
    "node_modules",
    "hunter-harness",
    "dist",
    "bin.js"
  );
  const preview = run(process.execPath, [bin,
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
  for (const profile of ["general", "java"]) {
    const project = await mkdtemp(join(tmpdir(), "hunter-pack-smoke-"));
    try {
      run(process.execPath, [bin,
        "--profile", profile,
        "--non-interactive",
        "--yes"
      ], { cwd: project, capture: true });
      await stat(join(project, ".claude", "skills", "harness-review", "SKILL.md"));
      const apidoc = join(project, ".claude", "skills", "harness-apidoc", "SKILL.md");
      if (profile === "java") {
        await stat(apidoc);
      } else {
        await stat(apidoc).then(
          () => { throw new Error("general bundle must not install harness-apidoc"); },
          () => undefined
        );
      }
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  }
  run(process.execPath, [
    npmCli,
    "pack",
    "-w",
    "packages/skill-cli",
    "--pack-destination",
    temporary
  ]);
  const skillArchive = (await readdir(temporary)).find((name) =>
    name.startsWith("hunter-harness-skill-cli-") && name.endsWith(".tgz")
  );
  if (skillArchive === undefined) throw new Error("npm pack did not create the Skill CLI archive");
  run(process.execPath, [
    npmCli,
    "install",
    "--prefix",
    temporary,
    "--ignore-scripts",
    join(temporary, skillArchive)
  ]);
  const skillBin = join(
    temporary,
    "node_modules",
    "@hunter-harness",
    "skill-cli",
    "dist",
    "bin.js"
  );
  const skillHelp = run(process.execPath, [skillBin, "--help"], {
    cwd: temporary,
    capture: true
  });
  if (!skillHelp.includes("install") || !skillHelp.includes("upload") ||
      /\b(search|download|update|uninstall|publish)\b/.test(skillHelp)) {
    throw new Error("packaged Skill CLI command surface is invalid");
  }
  process.stdout.write("packaged project CLI and Skill CLI smoke tests passed\n");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
