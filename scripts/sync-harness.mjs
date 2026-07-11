import { createHash } from "node:crypto";
import { readdir, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "harness");
const deploy = join(source, "scripts", "harness_deploy.py");
const resourceRoot = join(root, "resources", "harness");
const manifestRoot = join(resourceRoot, "manifests");
const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");

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

async function generate(profile) {
  const out = join(resourceRoot, profile);
  await rm(out, { recursive: true, force: true });
  const args = [deploy, "build", "--skills-root", source, "--out", out, "--json"];
  if (profile === "java") args.splice(2, 0, "--overlay", "java");
  const result = spawnSync(python, args, { cwd: root, encoding: "utf8", shell: false });
  if (result.status !== 0) {
    throw new Error(`Harness ${profile} build failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  const files = [];
  for (const item of (await filesUnder(out)).sort((a, b) => a.path.localeCompare(b.path))) {
    const bytes = await readFile(item.full);
    files.push({ path: item.path, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  await mkdir(manifestRoot, { recursive: true });
  await writeFile(join(manifestRoot, `${profile}.json`), JSON.stringify({
    schema_version: 1,
    profile,
    bundle_version: "0.1.0",
    generator: "harness_deploy.py",
    files
  }, null, 2) + "\n");
}

await generate("general");
await generate("java");
process.stdout.write("generated general and java Harness Bundles\n");
