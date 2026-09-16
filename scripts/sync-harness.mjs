#!/usr/bin/env node
// Regenerate the workflow data package (packages/workflow-data-harness).
//
// v1.0 单一规范 bundle：无 profile、无 agent 矩阵。从 harness/ 源树为两个
// 投影 surface（codex / codebuddy）构建内容相同、构建标记 agent 字段不同的
// bundle，拍平落在 harness/bundles/<surface>/，清单在 harness/manifests/<surface>.json。
//
// Usage:
//   node scripts/sync-harness.mjs          # full rebuild
//   node scripts/sync-harness.mjs --check  # verify bundles/manifests are in sync (CI)

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const HARNESS_SRC = join(ROOT, "harness");
const PKG = join(ROOT, "packages", "workflow-data-harness");
const PKG_HARNESS = join(PKG, "harness");
const BUNDLES_OUT = join(PKG_HARNESS, "bundles");
const MANIFESTS_OUT = join(PKG_HARNESS, "manifests");
// WI-1 §3.2：harness/contracts/risk-signals.json 是风险信号与档位映射的
// 单一权威，TS 侧常量由本脚本生成（消除双端移植漂移面）。
const RISK_SIGNALS_CONTRACT = join(HARNESS_SRC, "contracts", "risk-signals.json");
const RISK_SIGNALS_GENERATED = join(
  ROOT, "packages", "contracts", "src", "generated", "risk-signals.ts",
);

// 版本与门禁三字段随 1.0.0 毕业同步（见 docs/decisions；发版 SOP 四点之一）。
const BUNDLE_VERSION = "1.0.0";
const BUNDLE_SCHEMA_VERSION = 2;
const MINIMUM_CLI_VERSION = "1.0.0";
const WORKFLOW_PACKAGE_VERSION =
  require("../packages/workflow-data-harness/package.json").version;

// REQUIRED_CAPABILITIES 必须与 packages/cli/src/workflow-data/compatibility.ts
// 的 CLI_CAPABILITIES 完全一致（v1.0 硬切割：bundle 要求 CLI 全量能力）。
// 为避免再发生手工同步滞留（见 MEMORY.md 发布 SOP 教训），直接从源文件解析。
const CAPABILITIES_SOURCE = join(
  ROOT,
  "packages",
  "cli",
  "src",
  "workflow-data",
  "compatibility.ts",
);

function readCliCapabilities() {
  const source = readFileSync(CAPABILITIES_SOURCE, "utf8");
  const match = /CLI_CAPABILITIES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(source);
  if (match === null) {
    throw new Error("无法从 compatibility.ts 解析 CLI_CAPABILITIES");
  }
  const capabilities = [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  if (capabilities.length === 0) {
    throw new Error("CLI_CAPABILITIES 解析结果为空");
  }
  return capabilities;
}

const REQUIRED_CAPABILITIES = readCliCapabilities();

// v1.0 投影 surface：构建标记的 agent 字段取 surface 名（gate 按此匹配
// context-index 的 project.adapters[agent].skills_root）。
const PROJECTION_SURFACES = ["codex", "codebuddy"];
const CHECK_MODE = process.argv.includes("--check");
const GATES = ["init", "plan", "tasks", "execute", "review", "submit", "archive"];

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// check 模式专用：族清单中的 syncedAt 每次生成都不同，归一化后再比较。
function checkFingerprint(path) {
  if (basename(path) === "hunter-workflow-family.json") {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    parsed.syncedAt = "<normalized>";
    return createHash("sha256")
      .update(JSON.stringify(parsed, null, 2))
      .digest("hex");
  }
  return sha256File(path);
}

function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full));
    } else {
      out.push(full);
    }
  }
  return out.sort();
}

function cleanDir(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function run(command, args) {
  execFileSync(command, args, { cwd: ROOT, stdio: "inherit" });
}

function buildOneBundle(surface, stagingDir) {
  run("python", [
    join(HARNESS_SRC, "scripts", "harness_deploy.py"),
    "build",
    "--skills-root",
    HARNESS_SRC,
    "--out",
    stagingDir,
    "--surface",
    surface,
  ]);
}

function verifyBundle(bundleDir, label) {
  const markerPath = join(bundleDir, ".harness-build.json");
  if (!existsSync(markerPath)) {
    throw new Error(`[${label}] build marker 缺失`);
  }
  for (const file of collectFiles(bundleDir)) {
    const rel = relative(bundleDir, file).replaceAll("\\", "/");
    if (rel.includes(".claude/")) {
      throw new Error(`[${label}] bundle 内不允许出现 .claude/ 路径: ${rel}`);
    }
    if (rel.startsWith("agents/")) {
      throw new Error(`[${label}] bundle 内不允许出现 agents/ 目录: ${rel}`);
    }
  }
  const harnessSkills = readdirSync(bundleDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("harness-"))
    .map((entry) => entry.name);
  for (const skill of harnessSkills) {
    if (!existsSync(join(bundleDir, skill, "SKILL.md"))) {
      throw new Error(`[${label}] skill ${skill} 缺 SKILL.md`);
    }
  }
}

function writeManifest(surface, bundleDir) {
  // bundle 内容清单：构建标记与清单自身不参与 hash（门禁按 agent 字段匹配 surface）。
  const excluded = new Set([".harness-build.json", "bundle-manifest.json"]);
  const files = [];
  for (const file of collectFiles(bundleDir)) {
    const rel = relative(bundleDir, file).replaceAll("\\", "/");
    if (excluded.has(rel)) continue;
    files.push({ path: rel, sha256: sha256File(file) });
  }
  const manifest = {
    schema_version: BUNDLE_SCHEMA_VERSION,
    profile: "general",
    adapter: surface,
    bundle_version: BUNDLE_VERSION,
    generator: "harness_deploy.py",
    files,
  };
  writeFileSync(
    join(MANIFESTS_OUT, `${surface}.json`),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return manifest;
}

function computeBundleHash(manifests) {
  const payload = manifests.map((manifest) => ({
    adapter: manifest.adapter,
    profile: manifest.profile,
    files: manifest.files,
  }));
  return createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 12);
}

// 生成物 git 跟踪（clean clone 可直接 typecheck/test），新鲜度由
// tier-mode-parity 契约测试与 --check 漂移检测双重守护。
function kebabToSnake(value) {
  return value.replaceAll("-", "_");
}

function riskSignalsContractValidation(contract) {
  const problems = [];
  if (contract.schemaVersion !== 1) problems.push("schemaVersion must be 1");
  for (const key of ["fullMarkers", "assuranceSignals", "standardSignals", "quickSignals"]) {
    if (contract[key] === undefined) problems.push(`missing key: ${key}`);
  }
  if (contract.tierModeMap === undefined) problems.push("missing key: tierModeMap");
  if (contract.contractSchemaPaths === undefined) problems.push("missing key: contractSchemaPaths");
  // B3-2：档位派生字段投影（evidence-pack 重算 gate overlay 的输入）
  if (contract.riskTiers === undefined) problems.push("missing key: riskTiers");
  if (contract.validationPhases === undefined) problems.push("missing key: validationPhases");
  if (contract.validationDependencies === undefined) problems.push("missing key: validationDependencies");
  if (Array.isArray(contract.riskTiers)) {
    problems.push("riskTiers must be an object");
  } else if (contract.riskTiers !== undefined) {
    for (const [tier, policy] of Object.entries(contract.riskTiers)) {
      if (typeof policy !== "object" || policy === null) {
        problems.push(`riskTiers.${tier} must be an object`);
        continue;
      }
      if (!Array.isArray(policy.defaultPhases)) problems.push(`riskTiers.${tier}.defaultPhases must be an array`);
      if (!Array.isArray(policy.requiredValidations)) problems.push(`riskTiers.${tier}.requiredValidations must be an array`);
    }
    const tiers = Object.keys(contract.riskTiers);
    for (const tier of Object.keys(contract.tierModeMap ?? {})) {
      if (!tiers.includes(tier)) problems.push(`tierModeMap references unknown tier: ${tier}`);
    }
  }
  if (contract.validationPhases !== undefined && typeof contract.validationPhases !== "object") {
    problems.push("validationPhases must be an object");
  }
  if (contract.validationDependencies !== undefined && typeof contract.validationDependencies !== "object") {
    problems.push("validationDependencies must be an object");
  }
  return problems;
}

function generateRiskSignalsContract() {
  const contract = JSON.parse(readFileSync(RISK_SIGNALS_CONTRACT, "utf8"));
  const problems = riskSignalsContractValidation(contract);
  if (problems.length > 0) {
    throw new Error(`risk-signals.json contract invalid: ${problems.join("; ")}`);
  }
  const fullMarkers = Object.entries(contract.fullMarkers)
    .map(([signal, markers]) => `  ${kebabToSnake(signal)}: [${markers.map((m) => JSON.stringify(m)).join(", ")}]`);
  const signalList = (values) => values.map((v) => JSON.stringify(kebabToSnake(v))).join(", ");
  const tierModeEntries = Object.entries(contract.tierModeMap)
    .map(([tier, mode]) => `  ${JSON.stringify(tier)}: ${JSON.stringify(mode)}`);
  const schemaPaths = contract.contractSchemaPaths.map((p) => JSON.stringify(p)).join(", ");
  const content = `// @generated by scripts/sync-harness.mjs — DO NOT EDIT.
// 权威来源：harness/contracts/risk-signals.json（WI-1 单一权威）。
// 重新生成：npm run sync:harness。键名已从 kebab-case 转为 snake_case（对齐 PlanRiskSignal）。

/** 契约信号名（snake_case 形）。core 的 PlanRiskSignal 是其子集校验目标。 */
export type ContractRiskSignal =
${contract.assuranceSignals.concat(contract.standardSignals, contract.quickSignals)
    .map((s) => `  | ${JSON.stringify(kebabToSnake(s))}`)
    .join("\n")};

/** full 档 marker 表（与 Python harness_gate.py classify 同源）。 */
export const FULL_RISK_MARKERS: Partial<Readonly<Record<ContractRiskSignal, readonly string[]>>> = {
${fullMarkers.join(",\n")}
};

/** assurance 档信号集（任一命中即 assurance）。 */
export const ASSURANCE_RISK_SIGNALS: readonly ContractRiskSignal[] = [
  ${signalList(contract.assuranceSignals)}
];

/** standard 档信号集（无 assurance 命中时任一命中即 standard）。 */
export const STANDARD_RISK_SIGNALS: readonly ContractRiskSignal[] = [
  ${signalList(contract.standardSignals)}
];

/** quick 档信号集（正向低风险证据）。 */
export const QUICK_RISK_SIGNALS: readonly ContractRiskSignal[] = [
  ${signalList(contract.quickSignals)}
];

/** Python tier（fast/standard/full）→ TS mode（quick/standard/assurance）。 */
export const TIER_MODE_MAP: Readonly<Record<string, string>> = {
${tierModeEntries.join(",\n")}
};

/** TIER_MODE_MAP 的反转（mode → tier）。WI-1 方案 A：evidence-pack 由 mode 派生 tier。 */
export const MODE_TIER_MAP: Readonly<Record<string, string>> = {
${Object.entries(contract.tierModeMap).map(([tier, mode]) => `  ${JSON.stringify(mode)}: ${JSON.stringify(tier)}`).join(",\n")}
};

/** 契约 schema 路径：改这些文件 = 契约变更，应升 full 档评审。 */
export const CONTRACT_SCHEMA_PATHS: readonly string[] = [
  ${schemaPaths}
];

/** 档位政策投影（B3-2）：evidence-pack 按 tier 重算 gate overlay 的输入。
 *  值冻结自 workflow-policy.json riskTiers（defaultPhases/requiredValidations）。 */
export const RISK_TIERS: Readonly<Record<string, {
  readonly defaultPhases: readonly string[];
  readonly requiredValidations: readonly string[];
}>> = {
${Object.entries(contract.riskTiers).map(([tier, policy]) =>
    `  ${JSON.stringify(tier)}: {\n    defaultPhases: [${policy.defaultPhases.map((p) => JSON.stringify(p)).join(", ")}],\n    requiredValidations: [${policy.requiredValidations.map((v) => JSON.stringify(v)).join(", ")}]\n  }`).join(",\n")}
};

/** 验证 → 阶段映射（B3-2）：required_validations_by_phase 的构建输入。 */
export const VALIDATION_PHASES: Readonly<Record<string, string>> = {
${Object.entries(contract.validationPhases).map(([v, phase]) => `  ${JSON.stringify(v)}: ${JSON.stringify(phase)}`).join(",\n")}
};

/** 验证依赖表（B3-2）：required_gate_dag 的边构建输入。 */
export const VALIDATION_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
${Object.entries(contract.validationDependencies).map(([v, deps]) => `  ${JSON.stringify(v)}: [${deps.map((d) => JSON.stringify(d)).join(", ")}]`).join(",\n")}
};
`;
  mkdirSync(dirname(RISK_SIGNALS_GENERATED), { recursive: true });
  // 内容比对写入：无变化时不触碰 mtime，避免无关 churn。
  let current = null;
  try {
    current = readFileSync(RISK_SIGNALS_GENERATED, "utf8");
  } catch {
    // first generation
  }
  if (current !== content) {
    writeFileSync(RISK_SIGNALS_GENERATED, content);
    process.stdout.write("generated packages/contracts/src/generated/risk-signals.ts\n");
  }
}

function copyHarnessSupportDirs() {
  for (const name of ["contracts", "protocols"]) {
    const src = join(HARNESS_SRC, name);
    if (existsSync(src)) {
      cpSync(src, join(PKG_HARNESS, name), { recursive: true });
    }
  }
  const templatesSrc = join(HARNESS_SRC, "templates");
  if (existsSync(templatesSrc)) {
    cpSync(templatesSrc, join(PKG_HARNESS, "templates"), { recursive: true });
    rmSync(join(PKG_HARNESS, "templates", "__pycache__"), {
      recursive: true,
      force: true,
    });
  }
  const gateTemplateSrc = join(HARNESS_SRC, "templates", "harness_gate.py");
  if (existsSync(gateTemplateSrc)) {
    mkdirSync(join(PKG_HARNESS, "templates"), { recursive: true });
    cpSync(gateTemplateSrc, join(PKG_HARNESS, "templates", "harness_gate.py"));
  }
}

function writeFamilyJson(bundleHash, cliVersion) {
  const requirements = {
    minimumCliVersion: MINIMUM_CLI_VERSION,
    capabilities: REQUIRED_CAPABILITIES,
  };
  const family = {
    schema_version: 1,
    family_id: "hunter-harness",
    bundle_version: BUNDLE_VERSION,
    minimumCliVersion: MINIMUM_CLI_VERSION,
    workflowPackage: "@hunter-harness/workflow-harness",
    workflowPackageVersion: WORKFLOW_PACKAGE_VERSION,
    bundleHash,
    releaseTrain: "v1",
    projectionLayout: {
      mode: "files",
      canonicalRoot: "harness",
      bundlesRoot: "harness/bundles",
      manifestsRoot: "harness/manifests",
    },
    requires: requirements,
    capabilities: requirements.capabilities,
    compatibilityPolicy: {
      mode: "gate",
      reasonCode: "BLOCKED_CAPABILITY_MISMATCH",
      message: "workflow bundle requires newer hunter-harness CLI",
    },
    gates: GATES,
    cliVersion,
    syncedAt: new Date().toISOString(),
  };
  // 幂等：除 syncedAt 外内容无变化时保留原文件（含原时间戳），
  // 保证 smoke-pack 的 prepack 守卫与 git 工作区不被时间戳 churn 污染。
  const target = join(PKG, "hunter-workflow-family.json");
  try {
    const existing = JSON.parse(readFileSync(target, "utf8"));
    if (JSON.stringify({ ...existing, syncedAt: null }) ===
        JSON.stringify({ ...family, syncedAt: null })) {
      return;
    }
  } catch {
    // 文件缺失或损坏：照常重写。
  }
  writeFileSync(target, JSON.stringify(family, null, 2) + "\n");
}

async function sync() {
  console.log("[sync-harness] 清理输出目录");
  cleanDir(BUNDLES_OUT);
  cleanDir(MANIFESTS_OUT);

  const cliVersion = JSON.parse(
    await readFile(join(ROOT, "packages", "cli", "package.json"), "utf8"),
  ).version;

  const manifests = [];
  const tempRoots = [];
  for (const surface of PROJECTION_SURFACES) {
    // 单 surface 构建：内容对两个 surface 一致，差异仅在 .harness-build.json
    // 的 agent 字段（门禁按 agent 匹配该 surface 的 skills_root）。
    const stagingDir = join(BUNDLES_OUT, `.tmp-${surface}-${process.pid}`);
    tempRoots.push(stagingDir);
    console.log(`[sync-harness] build ${surface}`);
    buildOneBundle(surface, stagingDir);
    verifyBundle(stagingDir, surface);

    const dest = join(BUNDLES_OUT, surface);
    mkdirSync(dirname(dest), { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    cpSync(stagingDir, dest, { recursive: true });
    manifests.push(writeManifest(surface, dest));
    console.log(
      `[sync-harness] ${surface}: ${manifests[manifests.length - 1].files.length} files`,
    );
  }

  for (const dir of tempRoots) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  console.log("[sync-harness] 同步 contracts/protocols/templates");
  copyHarnessSupportDirs();

  console.log("[sync-harness] 生成 risk-signals TS 常量");
  generateRiskSignalsContract();

  const bundleHash = computeBundleHash(manifests);
  console.log(`[sync-harness] bundleHash=${bundleHash}`);
  writeFamilyJson(bundleHash, cliVersion);

  console.log(
    `[sync-harness] 完成：bundle_version=${BUNDLE_VERSION} workflowPackageVersion=${WORKFLOW_PACKAGE_VERSION} minimumCliVersion=${MINIMUM_CLI_VERSION}`,
  );
}

async function check() {
  const snapshot = new Map();
  for (const dir of [BUNDLES_OUT, MANIFESTS_OUT]) {
    if (!existsSync(dir)) continue;
    for (const file of collectFiles(dir)) {
      snapshot.set(file, checkFingerprint(file));
    }
  }
  const familyPath = join(PKG, "hunter-workflow-family.json");
  if (existsSync(familyPath)) {
    snapshot.set(familyPath, checkFingerprint(familyPath));
  }
  // 生成物也纳入漂移检测：改了 risk-signals.json 忘跑 sync 会被 --check 抓住。
  if (existsSync(RISK_SIGNALS_GENERATED)) {
    snapshot.set(RISK_SIGNALS_GENERATED, checkFingerprint(RISK_SIGNALS_GENERATED));
  }

  await sync();

  const after = new Map();
  for (const dir of [BUNDLES_OUT, MANIFESTS_OUT]) {
    if (!existsSync(dir)) continue;
    for (const file of collectFiles(dir)) {
      after.set(file, checkFingerprint(file));
    }
  }
  if (existsSync(familyPath)) {
    after.set(familyPath, checkFingerprint(familyPath));
  }
  if (existsSync(RISK_SIGNALS_GENERATED)) {
    after.set(RISK_SIGNALS_GENERATED, checkFingerprint(RISK_SIGNALS_GENERATED));
  }

  const drift = [];
  for (const [file, hash] of after) {
    if (snapshot.get(file) !== hash) drift.push(file);
  }
  for (const file of snapshot.keys()) {
    if (!after.has(file)) drift.push(file);
  }
  if (drift.length > 0) {
    console.error(
      `[sync-harness] --check 失败：${drift.length} 个文件与 harness/ 源树不同步`,
    );
    for (const file of drift.slice(0, 20)) {
      console.error(`  ${relative(ROOT, file)}`);
    }
    process.exit(1);
  }
  console.log("[sync-harness] --check 通过：数据包与 harness/ 源树一致");
}

const mode = CHECK_MODE ? check() : sync();
mode.catch((error) => {
  console.error(`[sync-harness] 失败：${error.message}`);
  process.exit(1);
});
