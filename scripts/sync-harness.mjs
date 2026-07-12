import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { adaptBundleDir } from "./adapt-agent-bundle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "harness");
const deploy = join(source, "scripts", "harness_deploy.py");
const resourceRoot = join(root, "resources", "harness");
const dataPackageRoot = join(root, "packages", "workflow-data-harness", "harness");
const bundlesRoot = join(resourceRoot, "bundles");
const manifestRoot = join(resourceRoot, "manifests");
const dataBundlesRoot = join(dataPackageRoot, "bundles");
const dataManifestRoot = join(dataPackageRoot, "manifests");
const migrationsSource = join(resourceRoot, "migrations");
const dataMigrationsRoot = join(dataPackageRoot, "migrations");
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
  const dataOut = join(dataBundlesRoot, profile, agent);
  await rm(out, { recursive: true, force: true });
  await rm(dataOut, { recursive: true, force: true });
  await mkdir(dirname(out), { recursive: true });
  await mkdir(dirname(dataOut), { recursive: true });
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
  await cp(out, dataOut, { recursive: true });
  const files = [];
  for (const item of (await filesUnder(out)).sort((a, b) => a.path.localeCompare(b.path))) {
    const bytes = await readFile(item.full);
    files.push({ path: item.path, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const manifest = JSON.stringify({
    schema_version: 2,
    profile,
    adapter: agent,
    bundle_version: BUNDLE_VERSION,
    generator: "harness_deploy.py",
    files
  }, null, 2) + "\n";
  for (const manifestDir of [join(manifestRoot, profile), join(dataManifestRoot, profile)]) {
    await mkdir(manifestDir, { recursive: true });
    await writeFile(join(manifestDir, `${agent}.json`), manifest);
  }
}

async function copyMigrations() {
  await mkdir(dataMigrationsRoot, { recursive: true });
  for (const item of await filesUnder(migrationsSource)) {
    const target = join(dataMigrationsRoot, item.path);
    await mkdir(dirname(target), { recursive: true });
    await cp(item.full, target);
  }
}

for (const profile of PROFILES) {
  for (const agent of AGENTS) {
    await generate(profile, agent);
    process.stdout.write(`generated ${profile}/${agent}\n`);
  }
}
await copyMigrations();
process.stdout.write("generated 2 profiles × 4 agents Harness Bundles\n");
