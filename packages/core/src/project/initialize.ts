import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  canonicalJson,
  baselineManifestSchema,
  initConfigSchema,
  projectConfigSchema,
  type InitConfig,
  type ProjectConfig
} from "@hunter-harness/contracts";
import {
  parse as parseYaml,
  stringify as stringifyYaml
} from "yaml";

import { sha256Bytes } from "../fs/hash.js";
import { upsertManagedBlock } from "../managed/managed-block.js";
import type { TransactionOperation } from "../transaction/journal.js";
import { runTransaction } from "../transaction/transaction.js";
import {
  bundleTargetContents,
  loadProfileBundle,
  managedBundleTargets,
  parseHarnessProfile,
  type HarnessProfile
} from "./profile-bundle.js";
import { uuidV7 } from "./uuid-v7.js";

export interface InitializeProjectOptions {
  projectRoot: string;
  resourcesRoot: string;
  config: InitConfig;
  dryRun: boolean;
}

export interface InitializeProjectResult {
  projectConfig: ProjectConfig;
  paths: string[];
  bundleHash: string;
  registryVersion: string;
}

interface InstalledBundleManifest {
  schema_version: 1;
  profile: "general" | "java";
  files: string[];
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function existingProjectConfig(root: string): Promise<ProjectConfig | null> {
  const path = join(root, ".harness", "project.yaml");
  const content = await readOptional(path);
  return content === "" ? null : projectConfigSchema.parse(parseYaml(content));
}

async function operationFor(
  root: string,
  path: string,
  content: string | Uint8Array
): Promise<TransactionOperation> {
  return await exists(join(root, path))
    ? { operation: "modify", path, content }
    : { operation: "add", path, content };
}

// 读取选中 profile 的 Harness Bundle：校验外部 manifest 的 SHA-256，以 Uint8Array 保留原始字节。
// 不注入 source_hash、不重新序列化，确保安装结果与 harness_deploy.py 输出逐字节一致。
// Bundle 相对路径 → 目标安装路径：任意路径 → .claude/skills/<rel>；
// agents/<name>.md 额外复制到 .claude/agents/<name>.md（与 harness_deploy.py install 一致）。
const INSTALLED_BUNDLE_PATH = ".harness/state/local/installed-harness-bundle.json";

async function previousInstalledProfile(root: string): Promise<HarnessProfile | null> {
  const content = await readOptional(join(root, INSTALLED_BUNDLE_PATH));
  if (content === "") return null;
  try {
    const parsed = JSON.parse(content) as InstalledBundleManifest;
    return parsed.schema_version === 1 ? parseHarnessProfile(parsed.profile) : null;
  } catch {
    return null;
  }
}

export async function initializeProject(
  options: InitializeProjectOptions
): Promise<InitializeProjectResult> {
  const root = resolve(options.projectRoot);
  const config = initConfigSchema.parse(options.config);
  const existing = await existingProjectConfig(root);

  const profile = config.profile as HarnessProfile;
  const bundle = await loadProfileBundle(options.resourcesRoot, profile);
  const bundleFiles = bundleTargetContents(bundle);
  const bundleHash = sha256Bytes(canonicalJson(bundle.manifest.files));

  const projectConfig = projectConfigSchema.parse({
    harness: { name: "hunter-harness", schema_version: 1 },
    project: {
      name: existing?.project.name ?? basename(root),
      root: ".",
      local_project_key: existing?.project.local_project_key ?? uuidV7(),
      project_id: config.project_id ?? existing?.project.project_id ?? null,
      profiles: [config.profile]
    },
    server: {
      url: config.server_url ?? existing?.server.url ?? null,
      token_env: config.token_env ?? existing?.server.token_env ??
        "HUNTER_HARNESS_TOKEN"
    },
    adapters: { enabled: [config.adapter] }
  });

  const baseline = baselineManifestSchema.parse({
    schema_version: 1,
    project_id: projectConfig.project.project_id,
    complete_project_version: null,
    artifact_manifest_hash: null,
    files: {}
  });
  const agentsContent = upsertManagedBlock(
    await readOptional(join(root, "AGENTS.md")),
    [
      "# Hunter Harness",
      "",
      "Use .harness/context-index.json to route rules, Knowledge, and codebase maps.",
      "Treat .claude/skills/harness-* as editable adapter working copies.",
      "Do not modify .harness/state or .harness/cache directly."
    ].join("\n")
  );
  const claudeContent = upsertManagedBlock(
    await readOptional(join(root, "CLAUDE.md")),
    [
      "@AGENTS.md",
      "",
      "# Hunter Harness",
      "",
      "- Rules: .claude/rules/",
      "- Skills: .claude/skills/harness-*/",
      "- Knowledge: .harness/knowledge/",
      "- Codebase map: .harness/codebase/map/"
    ].join("\n")
  );

  const files = new Map<string, string | Uint8Array>([
    [
      ".harness/project.yaml",
      stringifyYaml(projectConfig, { sortMapEntries: true })
    ],
    [
      ".harness/state/baseline/manifest.json",
      JSON.stringify(baseline, null, 2) + "\n"
    ],
    [
      ".harness/context-index.json",
      JSON.stringify({
        schema_version: 1,
        project: { claude_md: "CLAUDE.md", agents_md: "AGENTS.md" },
        rules: [".claude/rules/harness-general.md"],
        knowledge: { index: ".harness/knowledge/index.json" },
        codebase: { map: ".harness/codebase/map", status: "missing" },
        skill_bundle: {
          registry_version: bundle.manifest.bundle_version,
          bundle_hash: bundleHash
        }
      }, null, 2) + "\n"
    ],
    [
      ".harness/knowledge/index.json",
      JSON.stringify({ schema_version: 1, generated_at: null, entries: [] }, null, 2) +
        "\n"
    ],
    [".harness/knowledge/_candidates/.gitkeep", ""],
    [".harness/knowledge/project-local/.gitkeep", ""],
    [".harness/codebase/map/.gitkeep", ""],
    [".harness/state/local/.gitkeep", ""],
    [".harness/cache/server-artifacts/.gitkeep", ""],
    [".harness/reports/.gitkeep", ""],
    [
      ".harness/README.md",
      "# Hunter Harness\n\nUse npx hunter-harness, update, and push.\n"
    ],
    ["AGENTS.md", agentsContent],
    ["CLAUDE.md", claudeContent],
    [
      ".claude/rules/harness-general.md",
      "# Hunter Harness Rules\n\n- Report evidence honestly.\n- Do not execute destructive actions without confirmation.\n"
    ]
  ]);
  if (config.profile === "java") {
    files.set(
      ".claude/rules/harness-profile-java.md",
      "# Java Profile\n\n- Verify builds and tests with the project build tool.\n"
    );
  }

  // 安装选中 profile 的 Harness Bundle：字节原样写入，不注入 source_hash、不重新序列化。
  // Bundle 路径 → .claude/skills/<rel>；agents/<name>.md 额外复制到 .claude/agents/<name>.md。
  for (const [targetPath, bytes] of bundleFiles) {
    files.set(targetPath, bytes);
  }

  // 记录本次安装的受管文件清单，供下次 profile 切换时计算需删除的旧 profile 独有文件。
  const installedFileList = [...bundleFiles.keys()].sort();
  if (profile === "java") installedFileList.push(".claude/rules/harness-profile-java.md");
  const installedManifest: InstalledBundleManifest = {
    schema_version: 1,
    profile,
    files: installedFileList.sort()
  };
  files.set(INSTALLED_BUNDLE_PATH, JSON.stringify(installedManifest, null, 2) + "\n");
  const newManaged = await managedBundleTargets(options.resourcesRoot, profile);
  const oldProfile = await previousInstalledProfile(root);
  const oldManaged = oldProfile === null
    ? new Set<string>()
    : await managedBundleTargets(options.resourcesRoot, oldProfile);
  const deleteOperations: TransactionOperation[] = [...oldManaged]
    .filter((path) => !newManaged.has(path))
    .map((path) => ({ operation: "delete", path }));
  const paths = [...files.keys()].sort((left, right) => left.localeCompare(right));
  if (!options.dryRun) {
    const writeOperations = await Promise.all(
      [...files.entries()].map(async ([path, content]) => operationFor(root, path, content))
    );
    await runTransaction(root, [...deleteOperations, ...writeOperations], { kind: "init" });
  }
  return {
    projectConfig,
    paths,
    bundleHash,
    registryVersion: bundle.manifest.bundle_version
  };
}
