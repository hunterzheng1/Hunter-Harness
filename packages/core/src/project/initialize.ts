import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

import {
  canonicalJson,
  baselineManifestSchema,
  initConfigSchema,
  projectConfigSchema,
  type InitConfig,
  type ProjectConfig,
  type SourceFile
} from "@hunter-harness/contracts";
import {
  parse as parseYaml,
  stringify as stringifyYaml
} from "yaml";

import { sha256Bytes } from "../fs/hash.js";
import { upsertManagedBlock } from "../managed/managed-block.js";
import type { TransactionOperation } from "../transaction/journal.js";
import { runTransaction } from "../transaction/transaction.js";
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

interface BundleManifest {
  schema_version: 1;
  registry_version: string;
  compiler_version: string;
  skills: string[];
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
  content: string
): Promise<TransactionOperation> {
  return await exists(join(root, path))
    ? { operation: "modify", path, content }
    : { operation: "add", path, content };
}

// 递归读取目录下所有文件，返回相对路径（正斜杠）+ 内容。用于复制 resources/skills/<name>/。
async function readDirFiles(dir: string, base: string = dir): Promise<SourceFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: SourceFile[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await readDirFiles(full, base));
    } else if (entry.isFile()) {
      const rel = relative(base, full).replace(/\\/g, "/");
      files.push({ path: rel, content: await readFile(full, "utf8") });
    }
  }
  return files;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * YAML round-trip 重写 SKILL.md frontmatter，写入 source_hash 字段（取代旧 source_ir_hash）。
 * source_hash = 上传/引导源文件的 canonical sha256，由 init 复制时计算并写入 entry frontmatter。
 * 无 frontmatter 则原样返回（不写 source_hash）。
 */
function writeSourceHash(content: string, sourceHash: string): string {
  const match = FRONTMATTER_RE.exec(content);
  if (match === null) return content;
  const raw = match[1] ?? "";
  const body = match[2] ?? "";
  const fm = parseYaml(raw) as Record<string, unknown>;
  fm["source_hash"] = sourceHash;
  return `---\n${stringifyYaml(fm)}---\n${body}`;
}

function computeSourceHash(files: SourceFile[]): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  return sha256Bytes(canonicalJson(sorted.map((f) => ({ path: f.path, content: f.content }))));
}

export async function initializeProject(
  options: InitializeProjectOptions
): Promise<InitializeProjectResult> {
  const root = resolve(options.projectRoot);
  const config = initConfigSchema.parse(options.config);
  const existing = await existingProjectConfig(root);

  // 读 bootstrap manifest（registry_version + compiler_version + skills 列表）。
  // 新模型下 resources/<root>/skills/<name>/ 是源文件夹（SKILL.md + references），不再走 IR 编译。
  const manifest = JSON.parse(
    await readFile(join(options.resourcesRoot, "manifest.json"), "utf8")
  ) as BundleManifest;
  if (manifest.schema_version !== 1) {
    throw new Error("unsupported bootstrap bundle schema version");
  }
  const bundleHash = sha256Bytes(canonicalJson({
    registry_version: manifest.registry_version,
    compiler_version: manifest.compiler_version,
    skills: manifest.skills
  }));

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

  const files = new Map<string, string>([
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
          registry_version: manifest.registry_version,
          bundle_hash: bundleHash,
          compiler_version: manifest.compiler_version
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

  // 复制 bootstrap skills（源文件模型，取代 IR 编译）。
  // 仅 claude-code adapter 支持：resources/skills/<name>/ → .claude/skills/<name>/，
  // entry SKILL.md frontmatter 写入 source_hash（取代旧 source_ir_hash + compiler_version）。
  // cursor/codex 等 adapter 的 .mdc 编译能力随 compileSkill 移除，暂不支持（任务 16 评估是否补轻量转换）。
  if (config.adapter !== "claude-code") {
    throw new Error(
      `adapter '${config.adapter}' is not yet supported in source-file init model (only claude-code)`
    );
  }
  for (const name of manifest.skills) {
    const skillFiles = await readDirFiles(join(options.resourcesRoot, "skills", name));
    if (skillFiles.length === 0) continue;
    const sourceHash = computeSourceHash(skillFiles);
    for (const f of skillFiles) {
      const targetPath = `.claude/skills/${name}/${f.path}`;
      const content = f.path === "SKILL.md"
        ? writeSourceHash(f.content, sourceHash)
        : f.content;
      files.set(targetPath, content);
    }
  }

  const paths = [...files.keys()].sort((left, right) => left.localeCompare(right));
  if (!options.dryRun) {
    const operations = await Promise.all(
      paths.map(async (path) => operationFor(root, path, files.get(path) ?? ""))
    );
    await runTransaction(root, operations);
  }
  return {
    projectConfig,
    paths,
    bundleHash,
    registryVersion: manifest.registry_version
  };
}
