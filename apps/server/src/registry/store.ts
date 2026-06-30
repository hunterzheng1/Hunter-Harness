import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
  aiConfigStateSchema,
  aiProviderConfigSchema,
  canonicalJson,
  draftStateSchema,
  registrySkillDetailSchema,
  registrySkillProposalSchema,
  registrySkillVersionSchema,
  registryProjectWorkflowBindingSchema,
  registryTagSchema,
  registryWorkflowMutationSchema,
  registryWorkflowSchema,
  skillIrSchema,
  skillUsageExampleSchema,
  type AiConfigState,
  type AiProviderConfig,
  type AgentSkillConfig,
  type DraftState,
  type FixPlan,
  type RegistryAgent,
  type RegistryArtifact,
  type RegistryProjectWorkflowBinding,
  type RegistrySkillDetail,
  type RegistrySkillProposal,
  type RegistrySkillVersion,
  type RegistryTag,
  type RegistryWorkflow,
  type RegistryWorkflowMutation,
  type SkillCheckResult,
  type SkillDiffFile,
  type SkillIr,
  type SkillUsageExample,
  type SourceFile
} from "@hunter-harness/contracts";
import {
  ADAPTERS,
  buildFixPatch,
  bumpPatch,
  checkSkill,
  compareSemver,
  compileSkill,
  computeDiff,
  findSkillIr,
  scanSensitiveFiles,
  sha256Bytes,
  type BootstrapBundle
} from "@hunter-harness/core";
import AdmZip from "adm-zip";

import { ServerDomainError } from "../repositories/interfaces.js";
import type { ArtifactStorage } from "../storage/interface.js";
import type { RegistryPersistence } from "./persistence.js";

// applyFixSuggestion 可写白名单（examples/allowed_capabilities/instructions/description）；
// tags/null 为展示型建议不可写 → 422。与 output-parser FIX_APPLIES_TO_WHITELIST（5 值含 tags，解析白名单）语义不同，不可合并。
const WRITABLE_APPLIES_TO = ["examples", "allowed_capabilities", "instructions", "description"] as const;

interface SkillState {
  detail: RegistrySkillDetail;
  versions: RegistrySkillVersion[];
}

interface ProposalState extends RegistrySkillProposal {
  requestedAgent: RegistryAgent;
  reviewedBy: string | null;
  reviewComment: string | null;
  publishedArtifacts: RegistryArtifact[];
}

function id(prefix: string): string {
  return prefix + randomUUID().replaceAll("-", "");
}

function agentsFor(ir: SkillIr, latestVersion: string | null): AgentSkillConfig[] {
  return Object.entries(ir.adapters)
    .filter(([, value]) => value.enabled)
    .map(([key]) => key)
    .filter((key): key is RegistryAgent =>
      key === "claude-code" || key === "codex" || key === "generic" || key === "mcp"
    )
    .map((agent) => ({
      agent,
      enabled: true,
      isDefault: agent === "claude-code",
      installTarget: ".claude/skills/" + ir.name,
      latestVersion: agent === "claude-code" ? latestVersion : null,
      draftVersion: null,
      sourcePackagePath: null
    }));
}

function defaultAgentOf(ir: SkillIr): RegistryAgent | null {
  return ir.adapters["claude-code"]?.enabled === true ? "claude-code" : null;
}

function migrateSkillDetail(raw: unknown): RegistrySkillDetail {
  const direct = registrySkillDetailSchema.safeParse(raw);
  if (direct.success) return direct.data;
  const obj = (raw ?? {}) as Record<string, unknown>;
  const adaptersArr: RegistryAgent[] = Array.isArray(obj.adapters)
    ? obj.adapters as RegistryAgent[]
    : (["claude-code"] as RegistryAgent[]);
  const slug = typeof obj.slug === "string" ? obj.slug : "";
  const latestVersion = typeof obj.latest_version === "string" ? obj.latest_version : null;
  const agents: AgentSkillConfig[] = adaptersArr.map((agent) => ({
    agent,
    enabled: true,
    isDefault: agent === "claude-code",
    installTarget: ".claude/skills/" + slug,
    latestVersion: agent === "claude-code" ? latestVersion : null,
    draftVersion: null,
    sourcePackagePath: null
  }));
  const defaultAgent = agents.some((a) => a.agent === "claude-code") ? "claude-code" : null;
  const cleaned: Record<string, unknown> = { ...obj };
  delete cleaned.category;
  delete cleaned.adapters;
  cleaned.agents = agents;
  cleaned.defaultAgent = defaultAgent;
  return registrySkillDetailSchema.parse(cleaned);
}

function migrateSkillVersion(raw: unknown): RegistrySkillVersion {
  const direct = registrySkillVersionSchema.safeParse(raw);
  if (direct.success) return direct.data;
  const obj = (raw ?? {}) as Record<string, unknown>;
  const cleaned: Record<string, unknown> = { ...obj };
  if (cleaned.changeNote === undefined) cleaned.changeNote = null;
  if (!Array.isArray(cleaned.sourceFiles)) cleaned.sourceFiles = [];
  if (!Array.isArray(cleaned.examples)) cleaned.examples = [];
  return registrySkillVersionSchema.parse(cleaned);
}

function migrateTag(raw: unknown): RegistryTag {
  const direct = registryTagSchema.safeParse(raw);
  if (direct.success) return direct.data;
  const obj = (raw ?? {}) as Record<string, unknown>;
  return registryTagSchema.parse({ ...obj, usageCount: 0 });
}

function requireForwardVersion(existing: SkillState | undefined, version: string): void {
  if (existing === undefined) return;
  const latest = existing.versions.reduce((current, item) =>
    compareSemver(item.version, current) > 0 ? item.version : current,
  existing.versions[0]?.version ?? "0.0.0");
  if (compareSemver(version, latest) <= 0) {
    throw new ServerDomainError(409, "SKILL_VERSION_NOT_FORWARD", "skill version must be greater than the latest published version", {
      latest_version: latest,
      proposed_version: version
    });
  }
}

interface BuiltArtifact {
  agent: RegistryAgent;
  bytes: Uint8Array;
}

// zip 内 hunter-skill.json manifest 的 schema 版本（zip 元数据，无 contracts schema 约束，skill-cli 不 parse 该字段；Y-8 去魔法值）
const MANIFEST_SCHEMA_VERSION = 2;

// 簇8：遍历 installable 且 IR enabled 的 adapter，每 adapter compileSkill + zip（目标文件 + hunter-skill.json manifest）。
// 取交集（installable && ir.adapters[agent].enabled）：尊重 IR adapter 选择 + 向后兼容只 enable claude-code 的旧 skill（仍产 1 制品，现有 publish 测试不破坏）。
// mcp installable=false 跳过；未 enable 的 adapter 跳过。manifest schema_version:2 含 install_mode/block_id（zip 内元数据，无 contracts schema 约束，skill-cli 读不 parse schema）。
function buildArtifacts(ir: SkillIr, compilerVersion: string): BuiltArtifact[] {
  const profile = Object.entries(ir.profiles).find(([, value]) => value.enabled)?.[0];
  if (profile === undefined) {
    throw new ServerDomainError(422, "SKILL_VALIDATION_FAILED", "skill has no enabled profile");
  }
  const built: BuiltArtifact[] = [];
  for (const agent of Object.keys(ADAPTERS) as RegistryAgent[]) {
    const descriptor = ADAPTERS[agent];
    if (!descriptor.installable) continue;
    if (ir.adapters[agent]?.enabled !== true) continue;
    const output = compileSkill(ir, { adapter: agent, profile, compilerVersion });
    const filename = output.path.split("/").pop();
    if (filename === undefined || filename === "") {
      throw new ServerDomainError(500, "ARTIFACT_BUILD_FAILED", "compiled skill path has no filename");
    }
    const manifest: Record<string, unknown> = {
      schema_version: MANIFEST_SCHEMA_VERSION,
      slug: ir.name,
      version: ir.version,
      agent,
      source_ir_sha256: output.sourceIrHash,
      target_path: output.path,
      install_mode: descriptor.installMode
    };
    if (descriptor.blockId !== undefined) {
      manifest.block_id = descriptor.blockId(ir);
    }
    const zip = new AdmZip();
    zip.addFile(filename, Buffer.from(output.content, "utf8"));
    zip.addFile("hunter-skill.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"));
    built.push({ agent, bytes: zip.toBuffer() });
  }
  return built;
}

const DANGEROUS_PATH = /(^|[/\\])\.\.([/\\]|$)|^\/|^\\|^[a-zA-Z]:/;

function parseSuggestedStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new Error("suggestedContent must be a JSON array of non-empty strings");
  }
  for (const item of raw) {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error("suggestedContent array items must be non-empty strings");
    }
  }
  return raw as string[];
}

export class RegistryStore {
  private readonly skills = new Map<string, SkillState>();
  private readonly proposals = new Map<string, ProposalState>();
  private readonly tags = new Map<string, RegistryTag>();
  private readonly workflows = new Map<string, RegistryWorkflow>();
  private readonly projectBindings = new Map<string, RegistryProjectWorkflowBinding>();
  private readonly drafts = new Map<string, DraftState>();
  private compilerVersion = "1.0.0";
  private tagUsageCache: Map<string, number> | null = null;
  private aiConfig: AiConfigState = { defaultProvider: null, providers: [] };
  private aiUsage: { requests: number; tokens: number } = { requests: 0, tokens: 0 };

  constructor(
    private readonly storage: ArtifactStorage,
    private readonly persistence?: RegistryPersistence
  ) {}

  async initialize(bundle?: BootstrapBundle): Promise<void> {
    const snapshot = await this.persistence?.load();
    if (snapshot !== null && snapshot !== undefined) {
      const value = snapshot as {
        compilerVersion: string;
        skills: Array<[string, unknown]>;
        proposals: Array<[string, ProposalState]>;
        tags: Array<[string, unknown]>;
        workflows: Array<[string, RegistryWorkflow]>;
        projectBindings?: Array<[string, RegistryProjectWorkflowBinding]>;
        drafts?: Array<[string, unknown]>;
        aiConfig?: unknown;
        aiUsage?: unknown;
      };
      this.compilerVersion = value.compilerVersion;
      for (const [key, raw] of value.skills) {
        const state = this.migrateSkillState(raw);
        if (state !== null) this.skills.set(key, state);
      }
      for (const [key, state] of value.proposals) this.proposals.set(key, state);
      for (const [key, raw] of value.tags) this.tags.set(key, migrateTag(raw));
      for (const [key, state] of value.workflows) this.workflows.set(key, state);
      for (const [key, state] of value.projectBindings ?? []) this.projectBindings.set(key, state);
      for (const [key, raw] of value.drafts ?? []) {
        const parsed = draftStateSchema.safeParse(raw);
        if (parsed.success) this.drafts.set(key, parsed.data);
      }
      const aiCfg = aiConfigStateSchema.safeParse(value.aiConfig);
      this.aiConfig = aiCfg.success ? aiCfg.data : { defaultProvider: null, providers: [] };
      const usageRaw = value.aiUsage as { requests?: number; tokens?: number } | undefined;
      this.aiUsage = {
        requests: typeof usageRaw?.requests === "number" ? usageRaw.requests : 0,
        tokens: typeof usageRaw?.tokens === "number" ? usageRaw.tokens : 0
      };
      return;
    }
    if (bundle === undefined) return;
    this.compilerVersion = bundle.compilerVersion;
    for (const ir of bundle.skills) {
      if (this.skills.has(ir.name)) continue;
      await this.publishIr(ir, null, new Date().toISOString());
    }
    await this.persist();
  }

  async persist(): Promise<void> {
    await this.persistence?.save({
      schemaVersion: 2,
      compilerVersion: this.compilerVersion,
      skills: [...this.skills.entries()],
      proposals: [...this.proposals.entries()],
      tags: [...this.tags.entries()],
      workflows: [...this.workflows.entries()],
      projectBindings: [...this.projectBindings.entries()],
      drafts: [...this.drafts.entries()],
      aiConfig: this.aiConfig,
      aiUsage: this.aiUsage
    });
  }

  private migrateSkillState(raw: unknown): SkillState | null {
    try {
      const obj = (raw ?? {}) as Record<string, unknown>;
      const detail = migrateSkillDetail(obj.detail);
      const versions = Array.isArray(obj.versions) ? obj.versions.map(migrateSkillVersion) : [];
      return { detail, versions };
    } catch (error) {
      // 损坏 skill（如旧 snapshot 的 ir:null）无法迁移为合法 detail — 跳过该条目并记录警告，
      // 避免单个损坏条目阻塞整体 initialize（与旧数据兼容迁移的不报错语义一致）
      console.warn("[registry] skipping corrupt skill during migration:", (error as Error).message);
      return null;
    }
  }

  listSkills(query: {
    search?: string | undefined;
    tag?: string | undefined;
    agent?: string | undefined;
    status?: string | undefined;
  } = {}): RegistrySkillDetail[] {
    const search = query.search?.trim().toLowerCase() ?? "";
    return [...this.skills.values()].map((state) => structuredClone(state.detail))
      .filter((skill) => search === "" ||
        skill.slug.includes(search) || skill.name.toLowerCase().includes(search) ||
        skill.description.toLowerCase().includes(search))
      .filter((skill) => query.tag === undefined || skill.tags.includes(query.tag))
      .filter((skill) => query.agent === undefined ||
        skill.agents.some((a) => a.agent === (query.agent as RegistryAgent)))
      .filter((skill) => query.status === undefined || skill.status === query.status)
      .sort((left, right) => left.slug.localeCompare(right.slug));
  }

  getSkill(slug: string): RegistrySkillDetail {
    const state = this.skills.get(slug);
    if (state === undefined) throw new ServerDomainError(404, "SKILL_NOT_FOUND", "skill not found");
    return structuredClone(state.detail);
  }

  listVersions(slug: string): RegistrySkillVersion[] {
    const state = this.skills.get(slug);
    if (state === undefined) throw new ServerDomainError(404, "SKILL_NOT_FOUND", "skill not found");
    return structuredClone(state.versions).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  getDraft(slug: string): DraftState | undefined {
    const draft = this.drafts.get(slug);
    return draft === undefined ? undefined : structuredClone(draft);
  }

  async upsertDraft(input: {
    slug: string;
    sourceFiles: SourceFile[];
    ir: SkillIr;
    draftVersion: string | null;
  }): Promise<DraftState> {
    const now = new Date().toISOString();
    const existing = this.drafts.get(input.slug);
    const draft = draftStateSchema.parse({
      slug: input.slug,
      sourceFiles: input.sourceFiles,
      ir: input.ir,
      examples: existing?.examples ?? [],
      draftVersion: input.draftVersion,
      checks: null,
      releaseNote: existing?.releaseNote ?? null,
      revision: existing === undefined ? 1 : existing.revision + 1,
      created_at: existing?.created_at ?? now,
      updated_at: now
    }) as DraftState;
    this.drafts.set(input.slug, draft);
    await this.persist();
    return structuredClone(draft);
  }

  async deleteDraft(slug: string, revision: number): Promise<void> {
    const draft = this.drafts.get(slug);
    if (draft === undefined) {
      throw new ServerDomainError(404, "DRAFT_NOT_FOUND", "skill draft not found", { slug });
    }
    if (draft.revision !== revision) {
      throw new ServerDomainError(409, "REVISION_CONFLICT", "draft revision is stale", {
        slug, expected: draft.revision, provided: revision
      });
    }
    this.drafts.delete(slug);
    await this.persist();
  }

  async uploadDraft(input: { files: SourceFile[]; actorId: string }): Promise<DraftState> {
    const paths = input.files.map((f) => f.path);
    const hasWorkflow = paths.some((p) => /(^|\/)workflow\.ya?ml$/i.test(p));
    const hasSkillsDir = paths.some((p) => /(^|\/)skills\//.test(p));
    const hasAgentsDir = paths.some((p) => /(^|\/)agents\//.test(p));
    if (hasWorkflow && (hasSkillsDir || hasAgentsDir)) {
      throw new ServerDomainError(422, "WORKFLOW_PACKAGE_NOT_SUPPORTED", "workflow packages must use the workflow center");
    }
    const unsafe = input.files.find((f) => DANGEROUS_PATH.test(f.path));
    if (unsafe !== undefined) {
      throw new ServerDomainError(422, "SKILL_VALIDATION_FAILED", "unsafe file path: " + unsafe.path);
    }
    let ir: SkillIr;
    try {
      ir = findSkillIr(input.files);
    } catch (error) {
      throw new ServerDomainError(422, "SKILL_VALIDATION_FAILED", (error as Error).message);
    }
    const fileMap: Record<string, string> = {};
    for (const f of input.files) fileMap[f.path] = f.content;
    fileMap["skill-ir.json"] = canonicalJson(ir);
    const findings = scanSensitiveFiles(fileMap);
    if (findings.blocked) {
      throw new ServerDomainError(422, "SENSITIVE_CONTENT_BLOCKED", "skill contains sensitive content", {
        finding_count: findings.findings.length
      });
    }
    const slug = ir.name;
    const latest = this.skills.get(slug)?.detail.latest_version ?? null;
    const draftVersion = latest === null ? "0.1.0" : bumpPatch(latest);
    return this.upsertDraft({ slug, sourceFiles: input.files, ir, draftVersion });
  }

  async runChecks(input: { slug: string; checkedAt: string }): Promise<SkillCheckResult> {
    const draft = this.drafts.get(input.slug);
    if (draft === undefined) {
      throw new ServerDomainError(404, "DRAFT_NOT_FOUND", "skill draft not found", { slug: input.slug });
    }
    const latest = this.skills.get(input.slug)?.detail.latest_version ?? null;
    const result = checkSkill({
      ir: draft.ir,
      sourceFiles: draft.sourceFiles,
      latestVersion: latest,
      compilerVersion: this.compilerVersion,
      checkedAt: input.checkedAt
    });
    const updated: DraftState = { ...draft, checks: result, updated_at: input.checkedAt };
    this.drafts.set(input.slug, updated);
    await this.persist();
    return structuredClone(result);
  }

  // 写 AI 检查结果到 draft.aiChecks（§6.3；与程序 checks 分离，组合时合并展示）
  async setDraftAiChecks(input: {
    slug: string;
    aiChecks: SkillCheckResult;
    checkedAt: string;
  }): Promise<DraftState> {
    const draft = this.drafts.get(input.slug);
    if (draft === undefined) {
      throw new ServerDomainError(404, "DRAFT_NOT_FOUND", "skill draft not found", { slug: input.slug });
    }
    const updated: DraftState = { ...draft, aiChecks: input.aiChecks, updated_at: input.checkedAt };
    this.drafts.set(input.slug, updated);
    await this.persist();
    return structuredClone(updated);
  }

  async buildDraftFix(slug: string, checkIds: string[] | null): Promise<FixPlan & { fixedIr: SkillIr }> {
    const draft = this.drafts.get(slug);
    if (draft === undefined) {
      throw new ServerDomainError(404, "DRAFT_NOT_FOUND", "skill draft not found", { slug });
    }
    const latestVersion = this.skills.get(slug)?.detail.latest_version ?? null;
    const { items, mergedFiles, summary, fixedIr } = buildFixPatch({
      ir: draft.ir,
      checks: draft.checks,
      aiChecks: draft.aiChecks,
      latestVersion,
      checkIds
    });
    return { items, mergedFiles, summary, fixedIr };
  }

  async applyDraftFix(slug: string, checkIds: string[] | null): Promise<DraftState> {
    const draft = this.drafts.get(slug);
    if (draft === undefined) {
      throw new ServerDomainError(404, "DRAFT_NOT_FOUND", "skill draft not found", { slug });
    }
    const latestVersion = this.skills.get(slug)?.detail.latest_version ?? null;
    const { fixedIr } = buildFixPatch({
      ir: draft.ir,
      checks: draft.checks,
      aiChecks: draft.aiChecks,
      latestVersion,
      checkIds
    });
    const fileMap: Record<string, string> = {};
    for (const f of draft.sourceFiles) fileMap[f.path] = f.content;
    fileMap["skill-ir.json"] = canonicalJson(fixedIr);
    const findings = scanSensitiveFiles(fileMap);
    if (findings.blocked) {
      throw new ServerDomainError(422, "SENSITIVE_CONTENT_BLOCKED", "fixed ir contains sensitive content", { finding_count: findings.findings.length });
    }
    const now = new Date().toISOString();
    const cleared = draftStateSchema.parse({
      ...draft,
      ir: fixedIr,
      checks: null,
      aiChecks: null,
      revision: draft.revision + 1,
      updated_at: now
    }) as DraftState;
    this.drafts.set(slug, cleared);
    await this.persist();
    return structuredClone(cleared);
  }

  // 持久化 AI 生成的发布变更信息到 draft.releaseNote（§5.3；AI 生成有成本，持久化避免刷新丢失）
  async setDraftReleaseNote(input: {
    slug: string;
    releaseNote: string;
    generatedAt: string;
  }): Promise<DraftState> {
    const draft = this.drafts.get(input.slug);
    if (draft === undefined) {
      throw new ServerDomainError(404, "DRAFT_NOT_FOUND", "skill draft not found", { slug: input.slug });
    }
    const updated: DraftState = { ...draft, releaseNote: input.releaseNote, updated_at: input.generatedAt };
    this.drafts.set(input.slug, updated);
    await this.persist();
    return structuredClone(updated);
  }

  // 采纳 AI 修复建议：按 appliesTo 白名单写入 draft.ir / draft.examples 对应字段，
  // 校验写入后内容不含敏感信息，清 aiChecks（建议已采纳，待重新 check），revision+1（§6.3 第4步/§3.6）。
  // 可写白名单：examples(→draft.examples) / allowed_capabilities / instructions / description(→ir 字段)。
  // tags 与 null 为展示型建议（无对应可写 draft 字段，tag 绑定走 bindTag 独立流程），不可采纳 → 422。
  async applyFixSuggestion(input: {
    slug: string;
    checkId: string;
    suggestedContent: string;
    appliesTo: string | null;
    actorId: string;
  }): Promise<DraftState> {
    const draft = this.drafts.get(input.slug);
    if (draft === undefined) {
      throw new ServerDomainError(404, "DRAFT_NOT_FOUND", "skill draft not found", { slug: input.slug });
    }
    if (input.appliesTo === null || !(WRITABLE_APPLIES_TO as readonly string[]).includes(input.appliesTo)) {
      throw new ServerDomainError(422, "SKILL_VALIDATION_FAILED", "appliesTo is not a writable target", { appliesTo: input.appliesTo });
    }
    const target = input.appliesTo as typeof WRITABLE_APPLIES_TO[number];
    const fixedIr: SkillIr = structuredClone(draft.ir);
    let fixedExamples: SkillUsageExample[] = structuredClone(draft.examples);
    if (target === "description") {
      if (input.suggestedContent.length === 0) {
        throw new ServerDomainError(422, "SKILL_VALIDATION_FAILED", "suggestedContent for description must be non-empty", { appliesTo: target });
      }
      fixedIr.description = input.suggestedContent;
    } else if (target === "examples") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.suggestedContent);
      } catch {
        throw new ServerDomainError(422, "SKILL_VALIDATION_FAILED", "suggestedContent for examples must be a JSON array of usage examples", { appliesTo: target });
      }
      const result = skillUsageExampleSchema.array().safeParse(parsed);
      if (!result.success) {
        throw new ServerDomainError(422, "SKILL_VALIDATION_FAILED", "suggestedContent for examples must be a JSON array of usage examples", { appliesTo: target });
      }
      if (result.data.length === 0) {
        throw new ServerDomainError(422, "SKILL_VALIDATION_FAILED", "suggestedContent for examples must be a non-empty array", { appliesTo: target });
      }
      fixedExamples = result.data;
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.suggestedContent);
      } catch {
        throw new ServerDomainError(422, "SKILL_VALIDATION_FAILED", `suggestedContent for ${target} must be a JSON array of strings`, { appliesTo: target });
      }
      let arr: string[];
      try {
        arr = parseSuggestedStringArray(parsed);
      } catch (error) {
        throw new ServerDomainError(422, "SKILL_VALIDATION_FAILED", (error as Error).message, { appliesTo: target });
      }
      if (arr.length === 0) {
        throw new ServerDomainError(422, "SKILL_VALIDATION_FAILED", `suggestedContent for ${target} must be a non-empty array of strings`, { appliesTo: target });
      }
      if (target === "instructions") {
        fixedIr.instructions = arr;
      } else {
        fixedIr.allowed_capabilities = arr;
      }
    }
    const fileMap: Record<string, string> = {};
    for (const f of draft.sourceFiles) fileMap[f.path] = f.content;
    fileMap["skill-ir.json"] = canonicalJson(fixedIr);
    fileMap["examples.json"] = JSON.stringify(fixedExamples);
    const findings = scanSensitiveFiles(fileMap);
    if (findings.blocked) {
      throw new ServerDomainError(422, "SENSITIVE_CONTENT_BLOCKED", "applied suggestion contains sensitive content", { finding_count: findings.findings.length });
    }
    const now = new Date().toISOString();
    const cleared = draftStateSchema.parse({
      ...draft,
      ir: fixedIr,
      examples: fixedExamples,
      aiChecks: null,
      revision: draft.revision + 1,
      updated_at: now
    }) as DraftState;
    this.drafts.set(input.slug, cleared);
    await this.persist();
    return structuredClone(cleared);
  }

  async publish(input: {
    slug: string;
    version: string;
    releaseNote?: string | null;
    actorId: string;
  }): Promise<RegistrySkillVersion> {
    const draft = this.drafts.get(input.slug);
    if (draft === undefined) {
      throw new ServerDomainError(404, "DRAFT_NOT_FOUND", "skill draft not found", { slug: input.slug });
    }
    const existing = this.skills.get(input.slug);
    const latest = existing?.detail.latest_version ?? null;
    if (latest !== null && compareSemver(input.version, latest) <= 0) {
      throw new ServerDomainError(422, "VERSION_NOT_FORWARD", "skill version must be greater than the latest published version", {
        latest_version: latest,
        proposed_version: input.version
      });
    }
    const ir = draft.ir;
    skillIrSchema.parse(ir);
    const fileMap: Record<string, string> = {};
    for (const f of draft.sourceFiles) fileMap[f.path] = f.content;
    fileMap["skill-ir.json"] = canonicalJson(ir);
    const findings = scanSensitiveFiles(fileMap);
    if (findings.blocked) {
      throw new ServerDomainError(422, "SENSITIVE_CONTENT_BLOCKED", "skill contains sensitive content", {
        finding_count: findings.findings.length
      });
    }
    const built = buildArtifacts(ir, this.compilerVersion);
    if (built.length === 0) {
      // Y-3：与 createProposal 一致——IR 无任何 installable adapter enabled（如仅 mcp）时拒绝发布，
      // 避免静默发布 0 制品 version（不可安装）。
      throw new ServerDomainError(422, "SKILL_VALIDATION_FAILED", "skill has no enabled installable adapter");
    }
    const createdAt = new Date().toISOString();
    const artifacts: RegistryArtifact[] = [];
    // Y-2：多制品 blob 按 content_sha256 写入 ArtifactStorage（memory/local，content-addressed，无 PG blob 实现）；
    // 任一 putBlob 失败则抛出 → version 不入 skills Map、persist() 不执行，孤立 blob 可 GC（无数据损坏）。
    // 元数据持久化走 persist() 的单条 snapshot save（PG: 单行 jsonb ON CONFLICT，天然原子），不经逐条 SQL 事务。
    for (const item of built) {
      const hash = sha256Bytes(item.bytes);
      await this.storage.putBlob(hash, item.bytes);
      artifacts.push({
        artifact_id: id("ska_"),
        skill_slug: input.slug,
        version: input.version,
        agent: item.agent,
        content_sha256: hash,
        size_bytes: item.bytes.byteLength,
        source_proposal_id: null,
        created_at: createdAt
      } satisfies RegistryArtifact);
    }
    const version: RegistrySkillVersion = {
      skill_slug: input.slug,
      version: input.version,
      ir,
      artifacts,
      source_proposal_id: null,
      sourceFiles: draft.sourceFiles,
      examples: draft.examples,
      changeNote: input.releaseNote ?? null,
      created_at: createdAt
    };
    if (existing === undefined) {
      const detail = registrySkillDetailSchema.parse({
        skill_id: id("skl_"),
        slug: input.slug,
        name: ir.name,
        description: ir.description,
        tags: [],
        status: "published",
        latest_version: input.version,
        defaultAgent: defaultAgentOf(ir),
        agents: agentsFor(ir, input.version),
        revision: 1,
        created_at: createdAt,
        updated_at: createdAt,
        ir
      });
      this.skills.set(input.slug, { detail, versions: [version] });
    } else {
      existing.versions.push(version);
      existing.detail = registrySkillDetailSchema.parse({
        ...existing.detail,
        description: ir.description,
        status: "published",
        latest_version: input.version,
        defaultAgent: defaultAgentOf(ir),
        agents: agentsFor(ir, input.version),
        revision: existing.detail.revision + 1,
        updated_at: createdAt,
        ir
      });
    }
    this.invalidateTagUsageCache();
    this.drafts.delete(input.slug);
    await this.persist();
    return structuredClone(version);
  }

  diffDraft(slug: string): SkillDiffFile[] {
    const draft = this.drafts.get(slug);
    if (draft === undefined) {
      throw new ServerDomainError(404, "DRAFT_NOT_FOUND", "skill draft not found", { slug });
    }
    const skill = this.skills.get(slug);
    const latest = skill?.detail.latest_version ?? null;
    const publishedVersion = skill?.versions.find((v) => v.version === latest);
    const published = publishedVersion?.sourceFiles ?? [];
    return computeDiff(published, draft.sourceFiles);
  }

  async deleteSkill(input: { slug: string; actorId: string }): Promise<void> {
    const state = this.skills.get(input.slug);
    const draft = this.drafts.get(input.slug);
    if (state === undefined && draft === undefined) {
      throw new ServerDomainError(404, "SKILL_NOT_FOUND", "skill not found", { slug: input.slug });
    }
    if (state !== undefined) this.skills.delete(input.slug);
    if (draft !== undefined) this.drafts.delete(input.slug);
    this.invalidateTagUsageCache();
    await this.persist();
  }

  // ---- AI provider 配置（§12.9；key 不进 store，只存 provider 元数据 + 用量）----

  listProviders(): AiProviderConfig[] {
    return structuredClone(this.aiConfig.providers);
  }

  getProvider(providerId: string): AiProviderConfig | undefined {
    const p = this.aiConfig.providers.find((item) => item.provider_id === providerId);
    return p === undefined ? undefined : structuredClone(p);
  }

  getDefaultProvider(): AiProviderConfig | null {
    if (this.aiConfig.defaultProvider === null) return null;
    return this.getProvider(this.aiConfig.defaultProvider) ?? null;
  }

  async upsertProvider(input: {
    provider_id: string;
    label: string;
    base_url: string;
    model: string;
    enabled: boolean;
    api_key_env: string;
    is_default?: boolean;
  }): Promise<AiProviderConfig> {
    const now = new Date().toISOString();
    const existing = this.aiConfig.providers.find((item) => item.provider_id === input.provider_id);
    let provider: AiProviderConfig;
    if (existing === undefined) {
      provider = aiProviderConfigSchema.parse({
        provider_id: input.provider_id,
        label: input.label,
        base_url: input.base_url,
        model: input.model,
        enabled: input.enabled,
        is_default: false,
        api_key_env: input.api_key_env,
        revision: 1,
        created_at: now,
        updated_at: now
      });
      this.aiConfig.providers.push(provider);
    } else {
      provider = aiProviderConfigSchema.parse({
        ...existing,
        label: input.label,
        base_url: input.base_url,
        model: input.model,
        enabled: input.enabled,
        api_key_env: input.api_key_env,
        revision: existing.revision + 1,
        updated_at: now
      });
      const idx = this.aiConfig.providers.findIndex((item) => item.provider_id === input.provider_id);
      if (idx !== -1) this.aiConfig.providers[idx] = provider;
    }
    if (input.is_default === true) {
      this.applyDefault(input.provider_id);
    }
    await this.persist();
    return structuredClone(provider);
  }

  async updateProvider(
    providerId: string,
    revision: number,
    patch: Partial<Pick<AiProviderConfig, "label" | "base_url" | "model" | "enabled" | "api_key_env">>
  ): Promise<AiProviderConfig> {
    const idx = this.aiConfig.providers.findIndex((item) => item.provider_id === providerId);
    if (idx === -1) {
      throw new ServerDomainError(404, "PROVIDER_NOT_FOUND", "ai provider not found", { provider_id: providerId });
    }
    const existing = this.aiConfig.providers[idx];
    if (existing === undefined) {
      throw new ServerDomainError(404, "PROVIDER_NOT_FOUND", "ai provider not found", { provider_id: providerId });
    }
    if (existing.revision !== revision) {
      throw new ServerDomainError(409, "REVISION_CONFLICT", "ai provider revision is stale", {
        provider_id: providerId, expected: existing.revision, provided: revision
      });
    }
    const updated = aiProviderConfigSchema.parse({
      ...existing,
      ...patch,
      revision: existing.revision + 1,
      updated_at: new Date().toISOString()
    });
    this.aiConfig.providers[idx] = updated;
    await this.persist();
    return structuredClone(updated);
  }

  async deleteProvider(providerId: string): Promise<void> {
    const idx = this.aiConfig.providers.findIndex((item) => item.provider_id === providerId);
    if (idx === -1) {
      throw new ServerDomainError(404, "PROVIDER_NOT_FOUND", "ai provider not found", { provider_id: providerId });
    }
    this.aiConfig.providers.splice(idx, 1);
    if (this.aiConfig.defaultProvider === providerId) {
      this.aiConfig.defaultProvider = null;
    }
    await this.persist();
  }

  async setDefault(providerId: string): Promise<void> {
    this.applyDefault(providerId);
    await this.persist();
  }

  private applyDefault(providerId: string): void {
    const exists = this.aiConfig.providers.some((item) => item.provider_id === providerId);
    if (!exists) {
      throw new ServerDomainError(404, "PROVIDER_NOT_FOUND", "ai provider not found", { provider_id: providerId });
    }
    this.aiConfig.defaultProvider = providerId;
    for (const p of this.aiConfig.providers) {
      p.is_default = p.provider_id === providerId;
    }
  }

  getUsage(): { requests: number; tokens: number } {
    return { ...this.aiUsage };
  }

  async recordUsage(usage: { requests: number; tokens: number }): Promise<void> {
    this.aiUsage.requests += usage.requests;
    this.aiUsage.tokens += usage.tokens;
    await this.persist();
  }

  createProposal(input: { ir: SkillIr; actorId: string; agent: RegistryAgent }): ProposalState {
    if (input.agent !== "claude-code") {
      throw new ServerDomainError(422, "ADAPTER_NOT_INSTALLABLE", "only the verified Claude Code adapter can be published in MVP");
    }
    const ir = skillIrSchema.parse(input.ir);
    const existing = this.skills.get(ir.name);
    requireForwardVersion(existing, ir.version);
    const findings = scanSensitiveFiles({ "skill-ir.json": canonicalJson(ir) });
    const validation = {
      schema_valid: true,
      sensitive_findings: findings.findings.length,
      claude_compilable: false
    };
    if (findings.blocked) {
      throw new ServerDomainError(422, "SENSITIVE_CONTENT_BLOCKED", "skill contains sensitive content", {
        finding_count: findings.findings.length
      });
    }
    try {
      // 簇8：zipArtifact→buildArtifacts 适配；多 adapter 模型下"可编译"= 至少一个 installable adapter enabled 且 compileSkill 成功
      const built = buildArtifacts(ir, this.compilerVersion);
      if (built.length === 0) {
        throw new Error("skill has no enabled installable adapter");
      }
      validation.claude_compilable = true;
    } catch (error) {
      throw new ServerDomainError(422, "SKILL_VALIDATION_FAILED", "skill adapter validation failed", {
        reason: error instanceof Error ? error.message : "unknown"
      });
    }
    const proposal = registrySkillProposalSchema.parse({
      proposal_id: id("skp_"),
      skill_slug: ir.name,
      proposed_ir: ir,
      status: "pending_review",
      created_by: input.actorId,
      validation,
      created_at: new Date().toISOString(),
      reviewed_at: null
    });
    const state: ProposalState = {
      ...proposal,
      requestedAgent: input.agent,
      reviewedBy: null,
      reviewComment: null,
      publishedArtifacts: []
    };
    this.proposals.set(state.proposal_id, state);
    return structuredClone(state);
  }

  listProposals(status?: string): ProposalState[] {
    return [...this.proposals.values()]
      .filter((proposal) => status === undefined || proposal.status === status)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((value) => structuredClone(value));
  }

  getProposal(proposalId: string): ProposalState {
    const proposal = this.proposals.get(proposalId);
    if (proposal === undefined) {
      throw new ServerDomainError(404, "SKILL_PROPOSAL_NOT_FOUND", "skill proposal not found");
    }
    return structuredClone(proposal);
  }

  async reviewProposal(input: {
    proposalId: string;
    actorId: string;
    decision: "approve" | "reject";
    comment: string | null;
  }): Promise<ProposalState> {
    const proposal = this.proposals.get(input.proposalId);
    if (proposal === undefined) {
      throw new ServerDomainError(404, "SKILL_PROPOSAL_NOT_FOUND", "skill proposal not found");
    }
    if (proposal.status !== "pending_review") {
      throw new ServerDomainError(409, "SKILL_PROPOSAL_NOT_REVIEWABLE", "skill proposal is not pending review");
    }
    const reviewedAt = new Date().toISOString();
    const artifacts = input.decision === "approve"
      ? await this.publishIr(proposal.proposed_ir, proposal.proposal_id, reviewedAt)
      : [];
    proposal.status = input.decision === "approve" ? "approved" : "rejected";
    proposal.reviewed_at = reviewedAt;
    proposal.reviewedBy = input.actorId;
    proposal.reviewComment = input.comment;
    proposal.publishedArtifacts = artifacts;
    return structuredClone(proposal);
  }

  private async publishIr(
    ir: SkillIr,
    proposalId: string | null,
    createdAt: string
  ): Promise<RegistryArtifact[]> {
    const existing = this.skills.get(ir.name);
    requireForwardVersion(existing, ir.version);
    const built = buildArtifacts(ir, this.compilerVersion);
    if (built.length === 0) {
      // Y-3：与 createProposal/publish 一致——IR 无任何 installable adapter enabled 时拒绝发布。
      throw new ServerDomainError(422, "SKILL_VALIDATION_FAILED", "skill has no enabled installable adapter");
    }
    const artifacts: RegistryArtifact[] = [];
    // Y-2：多制品 blob 按 content_sha256 写入 ArtifactStorage（content-addressed，无 PG blob 实现）；
    // 任一 putBlob 失败则抛出 → version 不入 skills Map、persist() 不执行，孤立 blob 可 GC。persist() 单条 snapshot save 原子。
    for (const item of built) {
      const hash = sha256Bytes(item.bytes);
      await this.storage.putBlob(hash, item.bytes);
      artifacts.push({
        artifact_id: id("ska_"),
        skill_slug: ir.name,
        version: ir.version,
        agent: item.agent,
        content_sha256: hash,
        size_bytes: item.bytes.byteLength,
        source_proposal_id: proposalId ?? "skp_bootstrap",
        created_at: createdAt
      } satisfies RegistryArtifact);
    }
    const version: RegistrySkillVersion = {
      skill_slug: ir.name,
      version: ir.version,
      ir,
      artifacts,
      source_proposal_id: proposalId,
      sourceFiles: [],
      examples: [],
      changeNote: null,
      created_at: createdAt
    };
    if (existing === undefined) {
      const detail = registrySkillDetailSchema.parse({
        skill_id: id("skl_"),
        slug: ir.name,
        name: ir.name,
        description: ir.description,
        tags: [],
        status: "published",
        latest_version: ir.version,
        defaultAgent: defaultAgentOf(ir),
        agents: agentsFor(ir, ir.version),
        revision: 1,
        created_at: createdAt,
        updated_at: createdAt,
        ir
      });
      this.skills.set(ir.name, { detail, versions: [version] });
    } else {
      existing.versions.push(version);
      existing.detail = registrySkillDetailSchema.parse({
        ...existing.detail,
        description: ir.description,
        status: "published",
        latest_version: ir.version,
        defaultAgent: defaultAgentOf(ir),
        agents: agentsFor(ir, ir.version),
        revision: existing.detail.revision + 1,
        updated_at: createdAt,
        ir
      });
    }
    this.invalidateTagUsageCache();
    return artifacts;
  }

  adapterPreview(slug: string, agent: RegistryAgent) {
    // 簇8：去 claude-code 硬闸门，改按 ADAPTERS[agent].installable 判定；mcp installable=false → 422 ADAPTER_NOT_IMPLEMENTED
    if (!ADAPTERS[agent].installable) {
      throw new ServerDomainError(422, "ADAPTER_NOT_IMPLEMENTED", `adapter ${agent} is not yet implemented`);
    }
    const ir = this.getSkill(slug).ir;
    const profile = Object.entries(ir.profiles).find(([, value]) => value.enabled)?.[0];
    if (profile === undefined) throw new ServerDomainError(422, "SKILL_VALIDATION_FAILED", "skill has no enabled profile");
    return compileSkill(ir, {
      adapter: agent,
      profile,
      compilerVersion: this.compilerVersion
    });
  }

  latestArtifact(slug: string, agent: RegistryAgent): RegistryArtifact {
    const versions = this.listVersions(slug);
    const artifact = versions[0]?.artifacts.find((item) => item.agent === agent);
    if (artifact === undefined) {
      throw new ServerDomainError(404, "SKILL_ARTIFACT_NOT_FOUND", "published adapter artifact not found");
    }
    return artifact;
  }

  listArtifacts(): RegistryArtifact[] {
    return [...this.skills.values()]
      .flatMap((state) => state.versions.flatMap((version) => version.artifacts))
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .map((artifact) => structuredClone(artifact));
  }

  async artifactBytes(artifact: RegistryArtifact): Promise<Uint8Array> {
    return this.storage.getBlob(artifact.content_sha256);
  }

  createTag(input: { slug: string; label: string }): RegistryTag {
    if ([...this.tags.values()].some((tag) => tag.slug === input.slug)) {
      throw new ServerDomainError(409, "TAG_EXISTS", "tag already exists");
    }
    const now = new Date().toISOString();
    const tag = registryTagSchema.parse({
      tag_id: id("tag_"), slug: input.slug, label: input.label, active: true,
      revision: 1, usageCount: 0, created_at: now, updated_at: now
    });
    this.tags.set(tag.tag_id, tag);
    return structuredClone(tag);
  }

  private invalidateTagUsageCache(): void {
    this.tagUsageCache = null;
  }

  private ensureTagUsageCache(): Map<string, number> {
    if (this.tagUsageCache === null) {
      const usageBySlug = new Map<string, number>();
      for (const state of this.skills.values()) {
        for (const slug of state.detail.tags) {
          usageBySlug.set(slug, (usageBySlug.get(slug) ?? 0) + 1);
        }
      }
      this.tagUsageCache = usageBySlug;
    }
    return this.tagUsageCache;
  }

  listTags(): RegistryTag[] {
    const usageBySlug = this.ensureTagUsageCache();
    return [...this.tags.values()].map((tag) => structuredClone({
      ...tag,
      usageCount: usageBySlug.get(tag.slug) ?? 0
    }));
  }

  updateTag(tagId: string, input: {
    revision: number;
    label?: string | undefined;
    active?: boolean | undefined;
  }): RegistryTag {
    const tag = this.tags.get(tagId);
    if (tag === undefined) throw new ServerDomainError(404, "TAG_NOT_FOUND", "tag not found");
    if (tag.revision !== input.revision) throw new ServerDomainError(409, "REVISION_CONFLICT", "tag revision is stale");
    const updated = registryTagSchema.parse({
      ...tag,
      ...(input.label === undefined ? {} : { label: input.label }),
      ...(input.active === undefined ? {} : { active: input.active }),
      revision: tag.revision + 1,
      updated_at: new Date().toISOString()
    });
    this.tags.set(tagId, updated);
    return structuredClone(updated);
  }

  mergeTag(tagId: string, targetTagId: string, revision: number): RegistryTag {
    const source = this.tags.get(tagId);
    const target = this.tags.get(targetTagId);
    if (source === undefined || target === undefined || !target.active || source.tag_id === target.tag_id) {
      throw new ServerDomainError(422, "TAG_MERGE_INVALID", "tag merge target is invalid");
    }
    if (source.revision !== revision) {
      throw new ServerDomainError(409, "REVISION_CONFLICT", "tag revision is stale");
    }
    for (const state of this.skills.values()) {
      if (!state.detail.tags.includes(source.slug)) continue;
      state.detail = registrySkillDetailSchema.parse({
        ...state.detail,
        tags: [...new Set(state.detail.tags.filter((slug) => slug !== source.slug).concat(target.slug))].sort(),
        revision: state.detail.revision + 1,
        updated_at: new Date().toISOString()
      });
    }
    this.invalidateTagUsageCache();
    return this.updateTag(tagId, { revision, active: false });
  }

  bindTag(slug: string, tagId: string, remove = false): RegistrySkillDetail {
    const state = this.skills.get(slug);
    if (state === undefined) throw new ServerDomainError(404, "SKILL_NOT_FOUND", "skill not found");
    const tag = this.tags.get(tagId);
    if (tag === undefined || !tag.active) throw new ServerDomainError(404, "TAG_NOT_FOUND", "active tag not found");
    const set = new Set(state.detail.tags);
    if (remove) set.delete(tag.slug); else set.add(tag.slug);
    state.detail = registrySkillDetailSchema.parse({
      ...state.detail,
      tags: [...set].sort(),
      revision: state.detail.revision + 1,
      updated_at: new Date().toISOString()
    });
    this.invalidateTagUsageCache();
    return structuredClone(state.detail);
  }

  createWorkflow(input: RegistryWorkflowMutation): RegistryWorkflow {
    const value = registryWorkflowMutationSchema.parse(input);
    this.validateWorkflowSkills(value);
    if ([...this.workflows.values()].some((workflow) => workflow.key === value.key)) {
      throw new ServerDomainError(409, "WORKFLOW_EXISTS", "workflow already exists");
    }
    const now = new Date().toISOString();
    const workflow = registryWorkflowSchema.parse({
      ...value,
      workflow_id: id("wf_"), revision: 1, created_at: now, updated_at: now
    });
    this.workflows.set(workflow.workflow_id, workflow);
    return structuredClone(workflow);
  }

  listWorkflows(): RegistryWorkflow[] {
    return [...this.workflows.values()].map((value) => structuredClone(value));
  }

  getWorkflow(workflowId: string): RegistryWorkflow {
    const workflow = this.workflows.get(workflowId);
    if (workflow === undefined) throw new ServerDomainError(404, "WORKFLOW_NOT_FOUND", "workflow not found");
    return structuredClone(workflow);
  }

  updateWorkflow(
    workflowId: string,
    input: {
      revision: number;
      key?: string | undefined;
      name?: string | undefined;
      description?: string | undefined;
      profile?: string | undefined;
      default_agent?: RegistryAgent | undefined;
      enabled?: boolean | undefined;
      skill_slugs?: string[] | undefined;
    }
  ): RegistryWorkflow {
    const current = this.getWorkflow(workflowId);
    if (current.revision !== input.revision) {
      throw new ServerDomainError(409, "REVISION_CONFLICT", "workflow revision is stale");
    }
    const merged = registryWorkflowMutationSchema.parse({
      key: input.key ?? current.key,
      name: input.name ?? current.name,
      description: input.description ?? current.description,
      profile: input.profile ?? current.profile,
      default_agent: input.default_agent ?? current.default_agent,
      enabled: input.enabled ?? current.enabled,
      skill_slugs: input.skill_slugs ?? current.skill_slugs
    });
    this.validateWorkflowSkills(merged);
    const updated = registryWorkflowSchema.parse({
      ...current, ...merged, revision: current.revision + 1, updated_at: new Date().toISOString()
    });
    this.workflows.set(workflowId, updated);
    return structuredClone(updated);
  }

  deleteWorkflow(workflowId: string, revision: number): void {
    const current = this.getWorkflow(workflowId);
    if (current.revision !== revision) {
      throw new ServerDomainError(409, "REVISION_CONFLICT", "workflow revision is stale");
    }
    if ([...this.projectBindings.values()].some((binding) => binding.workflow_id === workflowId)) {
      throw new ServerDomainError(409, "WORKFLOW_IN_USE", "workflow is still bound to a project");
    }
    this.workflows.delete(workflowId);
  }

  getProjectBinding(projectId: string): RegistryProjectWorkflowBinding | null {
    return structuredClone(this.projectBindings.get(projectId) ?? null);
  }

  bindProjectWorkflow(input: {
    projectId: string;
    workflowId: string;
    revision: number | null;
  }): RegistryProjectWorkflowBinding {
    this.getWorkflow(input.workflowId);
    const current = this.projectBindings.get(input.projectId);
    if (current !== undefined && current.revision !== input.revision) {
      throw new ServerDomainError(409, "REVISION_CONFLICT", "project workflow binding revision is stale");
    }
    if (current === undefined && input.revision !== null) {
      throw new ServerDomainError(409, "REVISION_CONFLICT", "project workflow binding does not exist");
    }
    const binding = registryProjectWorkflowBindingSchema.parse({
      project_id: input.projectId,
      workflow_id: input.workflowId,
      revision: (current?.revision ?? 0) + 1,
      updated_at: new Date().toISOString()
    });
    this.projectBindings.set(input.projectId, binding);
    return structuredClone(binding);
  }

  private validateWorkflowSkills(workflow: RegistryWorkflowMutation): void {
    if (new Set(workflow.skill_slugs).size !== workflow.skill_slugs.length) {
      throw new ServerDomainError(422, "WORKFLOW_SKILL_DUPLICATE", "workflow contains duplicate skills");
    }
    for (const slug of workflow.skill_slugs) {
      const skill = this.skills.get(slug)?.detail;
      if (skill === undefined || skill.status !== "published") {
        throw new ServerDomainError(422, "WORKFLOW_SKILL_INVALID", "workflow references an unpublished skill", { slug });
      }
      if (!skill.agents.some((a) => a.agent === workflow.default_agent)) {
        throw new ServerDomainError(422, "WORKFLOW_ADAPTER_INCOMPATIBLE", "skill does not support workflow agent", { slug });
      }
      if (skill.ir.profiles[workflow.profile]?.enabled !== true) {
        throw new ServerDomainError(422, "WORKFLOW_PROFILE_INCOMPATIBLE", "skill does not support workflow profile", { slug });
      }
    }
  }
}
