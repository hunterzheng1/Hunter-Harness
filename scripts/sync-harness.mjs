import { createHash } from "node:crypto";
import { access, cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
const dataBundlesRoot = join(dataPackageRoot, "bundles");
const dataManifestRoot = join(dataPackageRoot, "manifests");
const migrationsSource = join(resourceRoot, "migrations");
const dataMigrationsRoot = join(dataPackageRoot, "migrations");
const syncStampPath = join(root, ".sync-staging", "harness-input-sha256");
const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");

const PROFILES = ["general", "java"];
const AGENTS = ["claude-code", "codex", "cursor", "codebuddy"];
const BUNDLE_VERSION = "0.2.15";

async function syncInputHash() {
  const inputs = [
    ...(await filesUnder(source))
      .filter((item) => !item.path.split("/").includes("__pycache__") && !item.path.endsWith(".pyc"))
      .map((item) => ({ ...item, key: `harness/${item.path}` })),
    ...(await filesUnder(migrationsSource)).map((item) => ({ ...item, key: `migrations/${item.path}` })),
    {
      key: "scripts/adapt-agent-bundle.mjs",
      full: join(root, "scripts", "adapt-agent-bundle.mjs")
    },
    {
      key: "scripts/sync-harness.mjs",
      full: fileURLToPath(import.meta.url)
    }
  ].sort((left, right) => left.key.localeCompare(right.key));
  const hash = createHash("sha256");
  for (const input of inputs) {
    hash.update(input.key);
    hash.update("\0");
    hash.update(await readFile(input.full));
    hash.update("\0");
  }
  return hash.digest("hex");
}

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

async function assertSupportFilesPresent(bundleDir) {
  // design §3.8 / cluster 7 point 4: every Skill's progressive-disclosure
  // "Read `xxx.md`" reference must resolve to a file present in the staged
  // bundle. A missing support file is a deploy failure (no runtime fallback).
  const entries = await readdir(bundleDir, { withFileTypes: true });
  const skills = entries
    .filter((e) => e.isDirectory() && e.name.startsWith("harness-"))
    .map((e) => e.name);
  for (const skill of skills) {
    const skillMd = await readFile(join(bundleDir, skill, "SKILL.md"), "utf8");
    const refs = new Set();
    for (const m of skillMd.matchAll(/Read\s+`?([a-zA-Z0-9_.-]+\.md)`?/g)) {
      refs.add(m[1]);
    }
    for (const ref of refs) {
      if (ref === "SKILL.md") continue;
      try {
        await access(join(bundleDir, skill, ref));
      } catch {
        throw new Error(
          `SUPPORT_FILE_MISSING: ${skill} references ${ref} but it is absent from the staged bundle (design §3.8)`
        );
      }
    }
  }
}

export async function atomicSwapDir(stage, target) {
  // §3.8 要点1 / INT-005: atomically replace target with the validated staging
  // dir. target is moved aside first, then staging is renamed into place; on
  // rename failure the original target is restored. The release tree is never
  // observed half-written.
  const backup = `${target}.swap-old-${process.pid}`;
  await rm(backup, { recursive: true, force: true });
  let hadTarget = true;
  try {
    await rename(target, backup);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    hadTarget = false;
  }
  try {
    await rename(stage, target);
  } catch (error) {
    if (hadTarget) await rename(backup, target);
    throw error;
  }
  await rm(backup, { recursive: true, force: true });
}

async function generate(profile, agent) {
  const out = join(dataBundlesRoot, profile, agent);
  await mkdir(dirname(out), { recursive: true });

  // §3.8 要点1 / INT-005: build entirely in a staging dir; out and dataOut are
  // untouched until staging is fully built, adapted, support-file-checked and
  // manifest-validated, then atomically swapped in.
  const stage = join(root, ".sync-staging", `${profile}-${agent}-${process.pid}`);
  await rm(stage, { recursive: true, force: true });
  // Only ensure the parent staging area exists; stage itself must NOT pre-exist
  // so harness_deploy.py build can swap its internal staging into place.
  await mkdir(dirname(stage), { recursive: true });
  const args = [
    deploy, "build",
    "--skills-root", source,
    "--out", stage,
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
  await adaptBundleDir(stage, agent);
  await assertSupportFilesPresent(stage);

  const files = [];
  for (const item of (await filesUnder(stage)).sort((a, b) => a.path.localeCompare(b.path))) {
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

  // §3.8 要点2: validate declared set == actual set (missing & extra both fail).
  const manifestTmp = join(root, ".sync-staging", `manifest-${profile}-${agent}.json`);
  await writeFile(manifestTmp, manifest);
  try {
    const vResult = spawnSync(
      python,
      [deploy, "validate-manifest", "--bundle", stage, "--manifest", manifestTmp, "--json"],
      { cwd: root, encoding: "utf8", shell: false }
    );
    if (vResult.status !== 0) {
      throw new Error(
        `Harness ${profile}/${agent} manifest validation failed\n${vResult.stdout ?? ""}\n${vResult.stderr ?? ""}`
      );
    }
  } finally {
    await rm(manifestTmp, { force: true });
  }

  // The ignored workflow-data tree is the only generated projection. Keeping
  // a second tracked resources/ mirror caused hundreds of noisy changes for
  // every canonical Skill edit without adding release safety.
  await atomicSwapDir(stage, out);

  const manifestDir = join(dataManifestRoot, profile);
  await mkdir(manifestDir, { recursive: true });
  await writeFile(join(manifestDir, `${agent}.json`), manifest);
}

async function copyMigrations() {
  await mkdir(dataMigrationsRoot, { recursive: true });
  for (const item of await filesUnder(migrationsSource)) {
    const target = join(dataMigrationsRoot, item.path);
    await mkdir(dirname(target), { recursive: true });
    await cp(item.full, target);
  }
}

// Mirrors packages/contracts/src/canonical-json.ts normalize()/canonicalJson() so this
// hash matches apps/server/src/npm/publisher.ts buildWorkflowFamilyManifest exactly.
function normalizeForCanonicalJson(value) {
  if (Array.isArray(value)) return value.map(normalizeForCanonicalJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeForCanonicalJson(item)])
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(normalizeForCanonicalJson(value));
}

function sha256Bytes(content) {
  return "sha256:" + createHash("sha256").update(content).digest("hex");
}

async function generatedProjectionIsCurrent(inputHash) {
  try {
    if ((await readFile(syncStampPath, "utf8")).trim() !== inputHash) return false;
    for (const profile of PROFILES) {
      for (const agent of AGENTS) {
        const bundleRoot = join(dataBundlesRoot, profile, agent);
        const manifest = JSON.parse(await readFile(
          join(dataManifestRoot, profile, `${agent}.json`),
          "utf8"
        ));
        const actual = await filesUnder(bundleRoot);
        if (actual.length !== manifest.files.length) return false;
        const expected = new Map(manifest.files.map((file) => [file.path, file.sha256]));
        for (const item of actual) {
          const digest = createHash("sha256").update(await readFile(item.full)).digest("hex");
          if (expected.get(item.path) !== digest) return false;
        }
        await assertSupportFilesPresent(bundleRoot);
      }
    }
    const familyManifestPath = join(root, "packages", "workflow-data-harness", "hunter-workflow-family.json");
    const familyManifest = JSON.parse(await readFile(familyManifestPath, "utf8"));
    const files = (await filesUnder(dataPackageRoot)).sort((a, b) => a.path.localeCompare(b.path));
    const withContent = [];
    for (const file of files) {
      withContent.push({ path: `harness/${file.path}`, content: await readFile(file.full, "utf8") });
    }
    return familyManifest.content_sha256 === sha256Bytes(canonicalJson(withContent));
  } catch {
    return false;
  }
}

async function writeWorkflowFamilyManifest() {
  const manifestPath = join(root, "packages", "workflow-data-harness", "hunter-workflow-family.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const files = (await filesUnder(dataPackageRoot))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((item) => ({ path: `harness/${item.path}` }));
  const withContent = [];
  for (const file of files) {
    const full = join(dataPackageRoot, file.path.slice("harness/".length));
    withContent.push({ path: file.path, content: await readFile(full, "utf8") });
  }
  manifest.bundle_version = BUNDLE_VERSION;
  manifest.content_sha256 = sha256Bytes(canonicalJson(withContent));
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

async function main() {
  const inputHash = await syncInputHash();
  if (!process.argv.includes("--force") && await generatedProjectionIsCurrent(inputHash)) {
    process.stdout.write("Harness Bundles are up to date (2 profiles × 4 agents)\n");
    return;
  }
  for (const profile of PROFILES) {
    for (const agent of AGENTS) {
      await generate(profile, agent);
      process.stdout.write(`generated ${profile}/${agent}\n`);
    }
  }
  await copyMigrations();
  await writeWorkflowFamilyManifest();
  await mkdir(dirname(syncStampPath), { recursive: true });
  await writeFile(syncStampPath, inputHash + "\n");
  process.stdout.write("generated 2 profiles × 4 agents Harness Bundles\n");
}

// Run only when executed directly (node scripts/sync-harness.mjs), not when
// imported by tests. Keeps atomicSwapDir unit-testable without triggering a
// full 8-bundle sync at import time.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exit(1);
  });
}
