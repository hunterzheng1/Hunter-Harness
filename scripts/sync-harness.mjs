import { createHash } from "node:crypto";
import { readdir, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { adaptBundleDir } from "./adapt-agent-bundle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "harness");
const deploy = join(source, "scripts", "harness_deploy.py");
const resourceRoot = join(root, "resources", "harness");
const bundlesRoot = join(resourceRoot, "bundles");
const manifestRoot = join(resourceRoot, "manifests");
const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");

const PROFILES = ["general", "java"];
const AGENTS = ["claude-code", "codex", "cursor", "codebuddy"];
const BUNDLE_VERSION = "0.2.0";

async function filesUnder(directory, base = directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(full, base));
    if (entry.isFile()) result.push({
      path: relative(base, full).replaceAll("\\", "/"),
      full
    });
  }
  return result;
}

async function generate(profile, agent) {
  const out = join(bundlesRoot, profile, agent);
  await rm(out, { recursive: true, force: true });
  await mkdir(dirname(out), { recursive: true });
  const args = [
    deploy, "build",
    "--skills-root", source,
    "--out", out,
    "--agent", agent,
    "--json"
  ];
  if (profile === "java") {
    args.splice(2, 0, "--overlay", "java");
  }
  const result = spawnSync(python, args, { cwd: root, encoding: "utf8", shell: false });
  if (result.status !== 0) {
    throw new Error(
      `Harness ${profile}/${agent} build failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`
    );
  }
  await adaptBundleDir(out, agent);
  const files = [];
  for (const item of (await filesUnder(out)).sort((a, b) => a.path.localeCompare(b.path))) {
    const bytes = await readFile(item.full);
    files.push({ path: item.path, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const manifestDir = join(manifestRoot, profile);
  await mkdir(manifestDir, { recursive: true });
  await writeFile(join(manifestDir, `${agent}.json`), JSON.stringify({
    schema_version: 2,
    profile,
    adapter: agent,
    bundle_version: BUNDLE_VERSION,
    generator: "harness_deploy.py",
    files
  }, null, 2) + "\n");
}

for (const profile of PROFILES) {
  for (const agent of AGENTS) {
    await generate(profile, agent);
    process.stdout.write(`generated ${profile}/${agent}\n`);
  }
}
process.stdout.write("generated 2 profiles × 4 agents Harness Bundles\n");
