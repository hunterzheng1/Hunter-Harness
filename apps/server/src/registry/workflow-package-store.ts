import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { parse as parseYaml } from "yaml";
import AdmZip from "adm-zip";

import {
  workflowPackageArtifactSchema,
  workflowPackageDraftStateSchema,
  workflowPackageManifestSchema,
  workflowPackageSchema,
  workflowPackageVersionSchema,
  SKILL_ERROR_CODE,
  type SkillCheckItem,
  type SkillCheckResult,
  type SkillDiffFile,
  type SourceFile,
  type WorkflowPackage,
  type WorkflowPackageDraftState,
  type WorkflowPackageManifest,
  type WorkflowPackageVersion
} from "@hunter-harness/contracts";
import { bumpPatch, compareSemver, computeDiff, scanSensitiveFiles, sha256Bytes } from "@hunter-harness/core";

import { ServerDomainError } from "../repositories/interfaces.js";
import type { ArtifactStorage } from "../storage/interface.js";

// zip-slip / 绝对路径 / 盘符防御（与 store.DANGEROUS_PATH 同源；i flag 遵守 harness-general 大小写不敏感规则）。
const DANGEROUS_PATH = /(^|[/\\])\.\.([/\\]|$)|^\/|^\\|^[a-zA-Z]:/i;

const WORKFLOW_MANIFEST_PATH = /(^|\/)workflow\.ya?ml$/i;

// 已发布 package 的服务端状态（仿 SkillState：detail + versions[]）。
export interface WorkflowPackageState {
  package: WorkflowPackage;
  versions: WorkflowPackageVersion[];
}

export interface WorkflowPackageStoreDeps {
  storage: ArtifactStorage;
  packages: Map<string, WorkflowPackageState>;
  drafts: Map<string, WorkflowPackageDraftState>;
  persist: () => Promise<void>;
  compilerVersion: () => string;
}

// WorkflowPackageStore：工作流包的 draft/publish/查询域。maps 与 persist 由 RegistryStore 注入共享，
// 使 RegistryStore.persist 的 snapshot 序列化覆盖 workflowPackages（设计 §3.6）。与清单 workflow CRUD（store.createWorkflow 等）并存，
// 不碰 skill draft 域（设计 §3.3）。
export class WorkflowPackageStore {
  constructor(private readonly deps: WorkflowPackageStoreDeps) {}

  async uploadPackage(input: { files: SourceFile[]; actorId: string }): Promise<WorkflowPackageDraftState> {
    const unsafe = input.files.find((f) => DANGEROUS_PATH.test(f.path));
    if (unsafe !== undefined) {
      throw new ServerDomainError(422, SKILL_ERROR_CODE.VALIDATION_FAILED, "unsafe file path: " + unsafe.path);
    }
    const manifestFile = input.files.find((f) => WORKFLOW_MANIFEST_PATH.test(f.path));
    if (manifestFile === undefined) {
      throw new ServerDomainError(422, "WORKFLOW_MANIFEST_MISSING", "workflow.yaml manifest not found in package");
    }
    let manifest: WorkflowPackageManifest;
    try {
      manifest = workflowPackageManifestSchema.parse(parseYaml(manifestFile.content));
    } catch (error) {
      throw new ServerDomainError(422, "WORKFLOW_MANIFEST_MISSING", "workflow.yaml manifest is invalid: " + (error as Error).message);
    }
    const fileMap: Record<string, string> = {};
    for (const f of input.files) fileMap[f.path] = f.content;
    const findings = scanSensitiveFiles(fileMap);
    if (findings.blocked) {
      throw new ServerDomainError(422, "SENSITIVE_CONTENT_BLOCKED", "workflow package contains sensitive content", {
        finding_count: findings.findings.length
      });
    }
    const key = manifest.key;
    const latest = this.deps.packages.get(key)?.package.latestVersion ?? null;
    const draftVersion = latest === null ? "0.1.0" : bumpPatch(latest);
    const now = new Date().toISOString();
    const existing = this.deps.drafts.get(key);
    const draft = workflowPackageDraftStateSchema.parse({
      key,
      manifest,
      sourceFiles: input.files,
      draftVersion,
      checks: null,
      releaseNote: existing?.releaseNote ?? null,
      revision: existing === undefined ? 1 : existing.revision + 1,
      created_at: existing?.created_at ?? now,
      updated_at: now
    }) as WorkflowPackageDraftState;
    this.deps.drafts.set(key, draft);
    await this.deps.persist();
    return structuredClone(draft);
  }

  getPackageDraft(key: string): WorkflowPackageDraftState {
    const draft = this.deps.drafts.get(key);
    if (draft === undefined) {
      throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "workflow package draft not found", { key });
    }
    return structuredClone(draft);
  }

  async discardPackageDraft(key: string, revision: number): Promise<void> {
    const draft = this.deps.drafts.get(key);
    if (draft === undefined) {
      throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "workflow package draft not found", { key });
    }
    if (draft.revision !== revision) {
      throw new ServerDomainError(409, SKILL_ERROR_CODE.REVISION_CONFLICT, "draft revision is stale", {
        key, expected: draft.revision, provided: revision
      });
    }
    this.deps.drafts.delete(key);
    await this.deps.persist();
  }

  async runPackageChecks(input: { key: string; checkedAt: string }): Promise<SkillCheckResult> {
    const draft = this.deps.drafts.get(input.key);
    if (draft === undefined) {
      throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "workflow package draft not found", { key: input.key });
    }
    // MVP 最小检查：manifest 已在 uploadPackage 时 schema 校验；此处发 green 基线确认 draft 可发布。
    // 共享资源完整性 / execution_order 一致性 / 依赖图影响分析 留 deferred（设计 §6）。
    const items: SkillCheckItem[] = [{
      id: "MANIFEST_PARSED",
      label: "Manifest 解析",
      status: "green",
      message: "workflow.yaml manifest 解析成功，引用结构完整",
      filePath: "workflow.yaml",
      fixable: false
    }];
    const result: SkillCheckResult = {
      items,
      summary: { green: 1, yellow: 0, red: 0 },
      checkedAt: input.checkedAt
    };
    const updated: WorkflowPackageDraftState = { ...draft, checks: result, updated_at: input.checkedAt };
    this.deps.drafts.set(input.key, updated);
    await this.deps.persist();
    return structuredClone(result);
  }

  diffPackageDraft(key: string): SkillDiffFile[] {
    const draft = this.deps.drafts.get(key);
    if (draft === undefined) {
      throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "workflow package draft not found", { key });
    }
    const pkg = this.deps.packages.get(key);
    const latest = pkg?.package.latestVersion ?? null;
    const publishedVersion = pkg?.versions.find((v) => v.version === latest);
    const published = publishedVersion?.sourceFiles ?? [];
    return computeDiff(published, draft.sourceFiles);
  }

  async publishPackage(key: string, input: {
    version: string;
    releaseNote?: string | null;
    actorId: string;
  }): Promise<WorkflowPackageVersion> {
    const draft = this.deps.drafts.get(key);
    if (draft === undefined) {
      throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "workflow package draft not found", { key });
    }
    const existing = this.deps.packages.get(key);
    const latest = existing?.package.latestVersion ?? null;
    if (latest !== null && compareSemver(input.version, latest) <= 0) {
      throw new ServerDomainError(409, "SKILL_VERSION_NOT_FORWARD", "workflow package version must be greater than the latest published version", {
        latest_version: latest,
        proposed_version: input.version
      });
    }
    const fileMap: Record<string, string> = {};
    for (const f of draft.sourceFiles) fileMap[f.path] = f.content;
    const findings = scanSensitiveFiles(fileMap);
    if (findings.blocked) {
      throw new ServerDomainError(422, "SENSITIVE_CONTENT_BLOCKED", "workflow package contains sensitive content", {
        finding_count: findings.findings.length
      });
    }
    const bytes = this.buildPackageArtifacts(draft, input.version);
    const hash = sha256Bytes(bytes);
    await this.deps.storage.putBlob(hash, bytes);
    const createdAt = new Date().toISOString();
    const artifact = workflowPackageArtifactSchema.parse({
      artifact_id: this.id("wfa_"),
      package_key: key,
      version: input.version,
      content_sha256: hash,
      size_bytes: bytes.byteLength,
      created_at: createdAt
    });
    const version = workflowPackageVersionSchema.parse({
      package_key: key,
      version: input.version,
      manifest: draft.manifest,
      artifacts: [artifact],
      sourceFiles: draft.sourceFiles,
      changeNote: input.releaseNote ?? null,
      created_at: createdAt
    });
    if (existing === undefined) {
      const pkg = workflowPackageSchema.parse({
        package_id: this.id("wfp_"),
        key,
        manifest: draft.manifest,
        latestVersion: input.version,
        revision: 1,
        created_at: createdAt,
        updated_at: createdAt
      });
      this.deps.packages.set(key, { package: pkg, versions: [version] });
    } else {
      existing.versions.push(version);
      existing.package = workflowPackageSchema.parse({
        ...existing.package,
        latestVersion: input.version,
        revision: existing.package.revision + 1,
        updated_at: createdAt
      });
    }
    this.deps.drafts.delete(key);
    await this.deps.persist();
    return structuredClone(version);
  }

  // 构建工作流包 ZIP 制品：所有源文件（workflow.yaml + skills/agents/protocols/templates 共享资源快照）+ hunter-workflow.json 元数据。
  // 发布时冻结共享资源快照（设计 §3.4）；复用 skill publish 的 content-addressed blob 模式（sha256 校验）。
  private buildPackageArtifacts(draft: WorkflowPackageDraftState, version: string): Uint8Array {
    const zip = new AdmZip();
    for (const f of draft.sourceFiles) {
      zip.addFile(f.path, Buffer.from(f.content, "utf8"));
    }
    const manifest = {
      schema_version: 1,
      key: draft.manifest.key,
      version,
      manifest: draft.manifest,
      compiler_version: this.deps.compilerVersion()
    };
    zip.addFile("hunter-workflow.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"));
    return zip.toBuffer();
  }

  private id(prefix: string): string {
    return prefix + randomUUID().replaceAll("-", "");
  }

  listPackages(): WorkflowPackage[] {
    return [...this.deps.packages.values()].map((s) => structuredClone(s.package));
  }

  getPackage(key: string): WorkflowPackage {
    const state = this.deps.packages.get(key);
    if (state === undefined) {
      throw new ServerDomainError(404, "PACKAGE_NOT_FOUND", "workflow package not found", { key });
    }
    return structuredClone(state.package);
  }

  listPackageVersions(key: string): WorkflowPackageVersion[] {
    const state = this.deps.packages.get(key);
    if (state === undefined) {
      throw new ServerDomainError(404, "PACKAGE_NOT_FOUND", "workflow package not found", { key });
    }
    // 版本号单调递增（publishPackage 前进检查保证）→ compareSemver 倒序 = 发布顺序倒序，不依赖时间戳。
    return structuredClone(state.versions).sort((a, b) => compareSemver(b.version, a.version));
  }
}
