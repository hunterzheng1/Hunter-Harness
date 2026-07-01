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
  workflowPackageDraftStateSchema,
  workflowPackageSchema,
  workflowPackageVersionSchema,
  type AiConfigState,
  type AiProviderConfig,
  type AiQuotaUsage,
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
  type SourceFile,
  type WorkflowPackage,
  type WorkflowPackageDraftState,
  type WorkflowPackageVersion
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

import { ServerDomainError, type TransactionRepository } from "../repositories/interfaces.js";
import type { ArtifactStorage } from "../storage/interface.js";
import type { RegistryPersistence } from "./persistence.js";
import { WorkflowPackageStore, type WorkflowPackageState } from "./workflow-package-store.js";

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

// 返回给定 version 序列中的最大 semver；空序列返回 null（per-agent latestVersion 计算基础）
function maxVersionOf(versions: RegistrySkillVersion[]): string | null {
  if (versions.length === 0) return null;
  let best: string | undefined;
  for (const v of versions) {
    if (best === undefined || compareSemver(v.version, best) > 0) best = v.version;
  }
  return best ?? null;
}

// per-agent 独立版本：每个 enabled installable agent 持独立 latestVersion（从该 agent 的 version 序列取最大）；
// draftVersion 从该 agent 的 draft 取；isDefault 由 detail.defaultAgent 判定（不再硬编码 claude-code）。
// fallback（§9 / UT-014）：agent 无专属版本且非默认 agent 且默认 agent 有版本 → 回退默认 agent latestVersion，
// sourcePackagePath 标注 "fallback:<defaultAgent>"；默认 agent 自身不 fallback。
function agentsFor(
  ir: SkillIr,
  defaultAgent: RegistryAgent | null,
  versions: RegistrySkillVersion[],
  draftsForSlug: Map<RegistryAgent, DraftState> | undefined
): AgentSkillConfig[] {
  const enabledAgents = (Object.keys(ADAPTERS) as RegistryAgent[])
    .filter((agent) => ADAPTERS[agent].installable && ir.adapters[agent]?.enabled === true);
  const defaultLatest = defaultAgent === null ? null : maxVersionOf(versions.filter((v) => v.agent === defaultAgent));
  return enabledAgents.map((agent) => {
    const ownLatest = maxVersionOf(versions.filter((v) => v.agent === agent));
    const isDefault = agent === defaultAgent;
    const draftVersion = draftsForSlug?.get(agent)?.draftVersion ?? null;
    if (ownLatest === null && defaultAgent !== null && agent !== defaultAgent) {
      // fallback：回退默认 agent 的 latestVersion；默认无版本则无可回退（null + 不标 fallback）
      return {
        agent,
        enabled: true,
        isDefault,
        installTarget: ADAPTERS[agent].targetPath(ir),
        latestVersion: defaultLatest,
        draftVersion,
        sourcePackagePath: defaultLatest === null ? null : "fallback:" + defaultAgent
      };
    }
    return {
      agent,
      enabled: true,
      isDefault,
      installTarget: ADAPTERS[agent].targetPath(ir),
      latestVersion: ownLatest,
      draftVersion,
      sourcePackagePath: null
    };
  });
}

// defaultAgentOf：优先 detail.defaultAgent（用户设定），否则自动推断（优先 claude-code，否则首个 installable+enabled，否则 null）。
function defaultAgentOf(detail: RegistrySkillDetail | undefined, ir: SkillIr): RegistryAgent | null {
  if (detail !== undefined && detail.defaultAgent !== null) return detail.defaultAgent;
  if (ir.adapters["claude-code"]?.enabled === true) return "claude-code";
  for (const agent of Object.keys(ADAPTERS) as RegistryAgent[]) {
    if (ADAPTERS[agent].installable && ir.adapters[agent]?.enabled === true) return agent;
  }
  return null;
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
  // 旧 adapters 数组 → agents；latestVersion 在 migrateSkillState 中按 per-agent version 序列重算
  const agents: AgentSkillConfig[] = adaptersArr.map((agent) => ({
    agent,
    enabled: true,
    isDefault: agent === "claude-code",
    installTarget: ADAPTERS[agent]?.targetPath({ name: slug } as SkillIr) ?? ".claude/skills/" + slug,
    latestVersion: agent === "claude-code" ? latestVersion : null,
    draftVersion: null,
    sourcePackagePath: null
  }));
  const defaultAgent = adaptersArr.includes("claude-code") ? "claude-code" : (adaptersArr[0] ?? null);
  const cleaned: Record<string, unknown> = { ...obj };
  delete cleaned.category;
  delete cleaned.adapters;
  cleaned.agents = agents;
  cleaned.defaultAgent = defaultAgent;
  return registrySkillDetailSchema.parse(cleaned);
}

// 迁移旧 version：补 agent（fallbackAgent = skill defaultAgent）；补 changeNote/sourceFiles/examples 默认值。
function migrateSkillVersion(raw: unknown, fallbackAgent: RegistryAgent | null): RegistrySkillVersion {
  const direct = registrySkillVersionSchema.safeParse(raw);
  if (direct.success) return direct.data;
  const obj = (raw ?? {}) as Record<string, unknown>;
  const cleaned: Record<string, unknown> = { ...obj };
  if (cleaned.changeNote === undefined) cleaned.changeNote = null;
  if (!Array.isArray(cleaned.sourceFiles)) cleaned.sourceFiles = [];
  if (!Array.isArray(cleaned.examples)) cleaned.examples = [];
  if (cleaned.agent === undefined && fallbackAgent !== null) cleaned.agent = fallbackAgent;
  return registrySkillVersionSchema.parse(cleaned);
}

function migrateTag(raw: unknown): RegistryTag {
  const direct = registryTagSchema.safeParse(raw);
  if (direct.success) return direct.data;
  const obj = (raw ?? {}) as Record<string, unknown>;
  return registryTagSchema.parse({ ...obj, usageCount: 0 });
}

// per-agent 前进校验：与该 agent 已有 version 序列比较（非 skill 级全部 version）。
// 不前进 → 409 SKILL_VERSION_NOT_FORWARD（含 agent 字段，便于路由层定位）。
function requireForwardVersion(existing: SkillState | undefined, agent: RegistryAgent, version: string): void {
  if (existing === undefined) return;
  const latest = maxVersionOf(existing.versions.filter((v) => v.agent === agent));
  if (latest !== null && compareSemver(version, latest) <= 0) {
    throw new ServerDomainError(409, "SKILL_VERSION_NOT_FORWARD", "skill version must be greater than the latest published version for this agent", {
      latest_version: latest,
      proposed_version: version,
      agent
    });
  }
}

interface BuiltArtifact {
  agent: RegistryAgent;
  bytes: Uint8Array;
}

// zip 内 hunter-skill.json manifest 的 schema 版本（zip 元数据，无 contracts schema 约束，skill-cli 不 parse 该字段；Y-8 去魔法值）
const MANIFEST_SCHEMA_VERSION = 2;

// 单 agent 制品构建（从 buildArtifacts 抽出的 per-agent 路径）：compileSkill + zip（目标文件 + hunter-skill.json manifest）。
// installable+enabled 才构建；无 enabled profile 抛 422；agent 未 installable/enabled 返回 null（由调用方决定 422）。
function buildArtifactFor(ir: SkillIr, agent: RegistryAgent, compilerVersion: string): BuiltArtifact | null {
  const profile = Object.entries(ir.profiles).find(([, value]) => value.enabled)?.[0];
  if (profile === undefined) {
    throw new ServerDomainError(422, "SKILL_VALIDATION_FAILED", "skill has no enabled profile");
  }
  const descriptor = ADAPTERS[agent];
  if (!descriptor.installable || ir.adapters[agent]?.enabled !== true) return null;
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
  return { agent, bytes: zip.toBuffer() };
}

// 多 agent 制品构建（createProposal/publishIr 验证闸门保留）：遍历 installable+enabled adapter 各 compileSkill+zip。
// per-agent publish 路径用 buildArtifactFor（单 agent）；此处保留用于 createProposal "至少 1 制品可编译" 校验。
function buildArtifacts(ir: SkillIr, compilerVersion: string): BuiltArtifact[] {
  const built: BuiltArtifact[] = [];
  for (const agent of Object.keys(ADAPTERS) as RegistryAgent[]) {
    const artifact = buildArtifactFor(ir, agent, compilerVersion);
    if (artifact !== null) built.push(artifact);
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
  // per-agent 独立草稿：Map<slug, Map<agent, DraftState>>。每 agent 独立 draftVersion/revision/checks。
  private readonly drafts = new Map<string, Map<RegistryAgent, DraftState>>();
  private readonly workflowPackages = new Map<string, WorkflowPackageState>();
  private readonly workflowPackageDrafts = new Map<string, WorkflowPackageDraftState>();
  private readonly workflowPackageStore: WorkflowPackageStore;
  private compilerVersion = "1.0.0";
  private tagUsageCache: Map<string, number> | null = null;
  private aiConfig: AiConfigState = { defaultProvider: null, providers: [], usage: [] };

  constructor(
    private readonly storage: ArtifactStorage,
    private readonly persistence?: RegistryPersistence
  ) {
    // 在构造函数体初始化（非 field initializer）：依赖参数属性 this.storage，须在参数属性赋值后（esbuild field init 先于参数属性会导致 this.storage undefined）。
    this.workflowPackageStore = new WorkflowPackageStore({
      storage: this.storage,
      packages: this.workflowPackages,
      drafts: this.workflowPackageDrafts,
      persist: () => this.persist(),
      compilerVersion: () => this.compilerVersion
    });
  }

  // ---- per-agent draft Map 读写助手 ----
  private getDraftState(slug: string, agent: RegistryAgent): DraftState | undefined {
    return this.drafts.get(slug)?.get(agent);
  }

  private setDraftState(slug: string, agent: RegistryAgent, draft: DraftState): void {
    let inner = this.drafts.get(slug);
    if (inner === undefined) {
      inner = new Map<RegistryAgent, DraftState>();
      this.drafts.set(slug, inner);
    }
    inner.set(agent, draft);
  }

  private deleteDraftState(slug: string, agent: RegistryAgent): void {
    const inner = this.drafts.get(slug);
    if (inner === undefined) return;
    inner.delete(agent);
    if (inner.size === 0) this.drafts.delete(slug);
  }

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
        workflowPackages?: Array<[string, unknown]>;
        workflowPackageDrafts?: Array<[string, unknown]>;
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
      // drafts 兼容两种格式：旧 [[slug, DraftState-without-agent]] 与 新 [[slug, [[agent, DraftState]]]]。
      for (const [key, raw] of value.drafts ?? []) {
        if (Array.isArray(raw)) {
          // 新嵌套格式：[[agent, DraftState], ...]
          for (const entry of raw) {
            if (!Array.isArray(entry)) continue;
            const [agent, draftRaw] = entry as [RegistryAgent, unknown];
            const parsed = draftStateSchema.safeParse(draftRaw);
            if (parsed.success) this.setDraftState(key, agent, parsed.data);
          }
        } else {
          // 旧 slug-only 格式：DraftState 无 agent → 迁默认 agent（UT-020）；无 enabled installable agent 则丢弃（UT-022）
          const obj = raw as { ir?: SkillIr } | null;
          const draftIr = obj?.ir;
          if (draftIr === undefined) {
            console.warn("[registry] discarding legacy draft with missing ir:", key);
            continue;
          }
          const agent = defaultAgentOf(undefined, draftIr);
          if (agent === null) {
            console.warn("[registry] discarding draft with no enabled installable agent:", key);
            continue;
          }
          const parsed = draftStateSchema.safeParse({ ...obj, agent });
          if (parsed.success) this.setDraftState(key, agent, parsed.data);
        }
      }
      // 草稿加载完成后重算各 skill 的 agents：draftVersion 字段需反映已加载草稿（migrateSkillState 迁移时 drafts 尚未加载，传 undefined）
      for (const [slug, state] of this.skills) {
        const defaultAgent = state.detail.defaultAgent ?? defaultAgentOf(undefined, state.detail.ir);
        state.detail = registrySkillDetailSchema.parse({
          ...state.detail,
          defaultAgent,
          agents: agentsFor(state.detail.ir, defaultAgent, state.versions, this.drafts.get(slug))
        });
      }
      for (const [key, raw] of value.workflowPackages ?? []) {
        const state = raw as { package: unknown; versions: unknown[] };
        const pkg = workflowPackageSchema.safeParse(state.package);
        if (!pkg.success) continue;
        const versions: WorkflowPackageVersion[] = [];
        for (const v of Array.isArray(state.versions) ? state.versions : []) {
          const r = workflowPackageVersionSchema.safeParse(v);
          if (r.success) versions.push(r.data);
        }
        this.workflowPackages.set(key, { package: pkg.data, versions });
      }
      for (const [key, raw] of value.workflowPackageDrafts ?? []) {
        const parsed = workflowPackageDraftStateSchema.safeParse(raw);
        if (parsed.success) this.workflowPackageDrafts.set(key, parsed.data);
      }
      const aiCfg = aiConfigStateSchema.safeParse(value.aiConfig);
      this.aiConfig = aiCfg.success ? aiCfg.data : { defaultProvider: null, providers: [], usage: [] };
      // COM-001：旧全局 aiUsage {requests,tokens} 迁移到默认 provider 当日条目（仅当 usage 为空且 defaultProvider 存在；已有 usage 不重复迁移）
      const usageRaw = value.aiUsage as { requests?: number; tokens?: number } | undefined;
      const legacyRequests = typeof usageRaw?.requests === "number" ? usageRaw.requests : 0;
      const legacyTokens = typeof usageRaw?.tokens === "number" ? usageRaw.tokens : 0;
      if (this.aiConfig.usage.length === 0 && (legacyRequests > 0 || legacyTokens > 0) && this.aiConfig.defaultProvider !== null) {
        this.aiConfig.usage.push({
          provider_id: this.aiConfig.defaultProvider,
          date: new Date().toISOString().slice(0, 10),
          requests: legacyRequests,
          tokens: legacyTokens
        });
      }
      return;
    }
    if (bundle === undefined) return;
    this.compilerVersion = bundle.compilerVersion;
    for (const ir of bundle.skills) {
      if (this.skills.has(ir.name)) continue;
      const agent = defaultAgentOf(undefined, ir);
      if (agent === null) continue; // 无 installable agent，跳过 bootstrap 发布
      await this.publishIr(ir, null, new Date().toISOString(), agent);
    }
    await this.persist();
  }

  async persist(tx?: TransactionRepository): Promise<void> {
    await this.persistence?.save({
      schemaVersion: 3,
      compilerVersion: this.compilerVersion,
      skills: [...this.skills.entries()],
      proposals: [...this.proposals.entries()],
      tags: [...this.tags.entries()],
      workflows: [...this.workflows.entries()],
      projectBindings: [...this.projectBindings.entries()],
      // 嵌套 drafts：[[slug, [[agent, DraftState]]]]（UT-031）
      drafts: [...this.drafts.entries()].map(([slug, m]) => [slug, [...m.entries()]] as [string, [RegistryAgent, DraftState][]]),
      workflowPackages: [...this.workflowPackages.entries()].map(([key, state]) => [key, { package: state.package, versions: state.versions }]),
      workflowPackageDrafts: [...this.workflowPackageDrafts.entries()],
      aiConfig: this.aiConfig
    }, tx);
  }

  private migrateSkillState(raw: unknown): SkillState | null {
    try {
      const obj = (raw ?? {}) as Record<string, unknown>;
      const detail = migrateSkillDetail(obj.detail);
      // defaultAgent：优先 detail.defaultAgent，否则按 ir 推断（确保 fallback 有目标）
      const defaultAgent = detail.defaultAgent ?? defaultAgentOf(undefined, detail.ir);
      const rawVersions = Array.isArray(obj.versions) ? obj.versions : [];
      const versions = rawVersions.map((v) => migrateSkillVersion(v, defaultAgent));
      // 重算 agents：per-agent latestVersion 从迁移后 versions 取；旧 v2 同步版本由此拆为 per-agent 独立（COM-003）
      const recomputedAgents = agentsFor(detail.ir, defaultAgent, versions, undefined);
      const latestVersion = maxVersionOf(versions);
      const detailFinal = registrySkillDetailSchema.parse({
        ...detail,
        defaultAgent,
        agents: recomputedAgents,
        latest_version: latestVersion
      });
      return { detail: detailFinal, versions };
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

  listVersions(slug: string, agent?: RegistryAgent): RegistrySkillVersion[] {
    const state = this.skills.get(slug);
    if (state === undefined) throw new ServerDomainError(404, "SKILL_NOT_FOUND", "skill not found");
    const versions = agent === undefined ? state.versions : state.versions.filter((v) => v.agent === agent);
    return structuredClone(versions).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  getDraft(slug: string, agent: RegistryAgent): DraftState | undefined {
    const draft = this.getDraftState(slug, agent);
    return draft === undefined ? undefined : structuredClone(draft);
  }

  async upsertDraft(input: {
    slug: string;
    agent: RegistryAgent;
    sourceFiles: SourceFile[];
    ir: SkillIr;
    draftVersion: string | null;
  }): Promise<DraftState> {
    const now = new Date().toISOString();
    const existing = this.getDraftState(input.slug, input.agent);
    const draft = draftStateSchema.parse({
      slug: input.slug,
      agent: input.agent,
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
    this.setDraftState(input.slug, input.agent, draft);
    await this.persist();
    return structuredClone(draft);
  }

  async deleteDraft(slug: string, agent: RegistryAgent, revision: number): Promise<void> {
    const draft = this.getDraftState(slug, agent);
    if (draft === undefined) {
      throw new ServerDomainError(404, "DRAFT_NOT_FOUND", "skill draft not found", { slug, agent });
    }
    if (draft.revision !== revision) {
      throw new ServerDomainError(409, "REVISION_CONFLICT", "draft revision is stale", {
        slug, agent, expected: draft.revision, provided: revision
      });
    }
    this.deleteDraftState(slug, agent);
    await this.persist();
  }

  async uploadDraft(input: { files: SourceFile[]; actorId: string; agent: RegistryAgent }): Promise<DraftState> {
    const paths = input.files.map((f) => f.path);
    const hasWorkflow = paths.some((p) => /(^|\/)workflow\.ya?ml$/i.test(p));
    const hasSkillsDir = paths.some((p) => /(^|\/)skills\//i.test(p));
    const hasAgentsDir = paths.some((p) => /(^|\/)agents\//i.test(p));
    const hasProtocolsDir = paths.some((p) => /(^|\/)protocols\//i.test(p));
    const hasTemplatesDir = paths.some((p) => /(^|\/)templates\//i.test(p));
    if (hasWorkflow && (hasSkillsDir || hasAgentsDir || hasProtocolsDir || hasTemplatesDir)) {
      throw new ServerDomainError(422, "WORKFLOW_PACKAGE_REDIRECT", "workflow packages must use the workflow center", { redirect: "workflow-packages" });
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
    // per-agent draftVersion：从该 agent 自有 version 序列取最大，无则 0.1.0
    const skillState = this.skills.get(slug);
    const ownVersions = skillState?.versions.filter((v) => v.agent === input.agent) ?? [];
    const agentLatest = maxVersionOf(ownVersions);
    const draftVersion = agentLatest === null ? "0.1.0" : bumpPatch(agentLatest);
    return this.upsertDraft({ slug, agent: input.agent, sourceFiles: input.files, ir, draftVersion });
  }

  async runChecks(input: { slug: string; agent: RegistryAgent; checkedAt: string }): Promise<SkillCheckResult> {
    const draft = this.getDraftState(input.slug, input.agent);
    if (draft === undefined) {
      throw new ServerDomainError(404, "DRAFT_NOT_FOUND", "skill draft not found", { slug: input.slug, agent: input.agent });
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
    this.setDraftState(input.slug, input.agent, updated);
    await this.persist();
    return structuredClone(result);
  }

  // 写 AI 检查结果到 draft.aiChecks（§6.3；与程序 checks 分离，组合时合并展示）
  async setDraftAiChecks(input: {
    slug: string;
    agent: RegistryAgent;
    aiChecks: SkillCheckResult;
    checkedAt: string;
  }): Promise<DraftState> {
    const draft = this.getDraftState(input.slug, input.agent);
    if (draft === undefined) {
      throw new ServerDomainError(404, "DRAFT_NOT_FOUND", "skill draft not found", { slug: input.slug, agent: input.agent });
    }
    const updated: DraftState = { ...draft, aiChecks: input.aiChecks, updated_at: input.checkedAt };
    this.setDraftState(input.slug, input.agent, updated);
    await this.persist();
    return structuredClone(updated);
  }

  async buildDraftFix(slug: string, agent: RegistryAgent, checkIds: string[] | null): Promise<FixPlan & { fixedIr: SkillIr }> {
    const draft = this.getDraftState(slug, agent);
    if (draft === undefined) {
      throw new ServerDomainError(404, "DRAFT_NOT_FOUND", "skill draft not found", { slug, agent });
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

  async applyDraftFix(slug: string, agent: RegistryAgent, checkIds: string[] | null): Promise<DraftState> {
    const draft = this.getDraftState(slug, agent);
    if (draft === undefined) {
      throw new ServerDomainError(404, "DRAFT_NOT_FOUND", "skill draft not found", { slug, agent });
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
      agent,
      ir: fixedIr,
      checks: null,
      aiChecks: null,
      revision: draft.revision + 1,
      updated_at: now
    }) as DraftState;
    this.setDraftState(slug, agent, cleared);
    await this.persist();
    return structuredClone(cleared);
  }

  // 持久化 AI 生成的发布变更信息到 draft.releaseNote（§5.3；AI 生成有成本，持久化避免刷新丢失）
  async setDraftReleaseNote(input: {
    slug: string;
    agent: RegistryAgent;
    releaseNote: string;
    generatedAt: string;
  }): Promise<DraftState> {
    const draft = this.getDraftState(input.slug, input.agent);
    if (draft === undefined) {
      throw new ServerDomainError(404, "DRAFT_NOT_FOUND", "skill draft not found", { slug: input.slug, agent: input.agent });
    }
    const updated: DraftState = { ...draft, releaseNote: input.releaseNote, updated_at: input.generatedAt };
    this.setDraftState(input.slug, input.agent, updated);
    await this.persist();
    return structuredClone(updated);
  }

  // 采纳 AI 修复建议：按 appliesTo 白名单写入 draft.ir / draft.examples 对应字段，
  // 校验写入后内容不含敏感信息，清 aiChecks（建议已采纳，待重新 check），revision+1（§6.3 第4步/§3.6）。
  // 可写白名单：examples(→draft.examples) / allowed_capabilities / instructions / description(→ir 字段)。
  // tags 与 null 为展示型建议（无对应可写 draft 字段，tag 绑定走 bindTag 独立流程），不可采纳 → 422。
  async applyFixSuggestion(input: {
    slug: string;
    agent: RegistryAgent;
    checkId: string;
    suggestedContent: string;
    appliesTo: string | null;
    actorId: string;
  }): Promise<DraftState> {
    const draft = this.getDraftState(input.slug, input.agent);
    if (draft === undefined) {
      throw new ServerDomainError(404, "DRAFT_NOT_FOUND", "skill draft not found", { slug: input.slug, agent: input.agent });
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
      agent: input.agent,
      ir: fixedIr,
      examples: fixedExamples,
      aiChecks: null,
      revision: draft.revision + 1,
      updated_at: now
    }) as DraftState;
    this.setDraftState(input.slug, input.agent, cleared);
    await this.persist();
    return structuredClone(cleared);
  }

  // per-agent publish：只产当前 agent 的 1 个 artifact，只前进该 agent 的 latestVersion，其他 agent 不动。
  async publish(input: {
    slug: string;
    agent: RegistryAgent;
    version: string;
    releaseNote?: string | null;
    actorId: string;
  }, tx?: TransactionRepository): Promise<RegistrySkillVersion> {
    const draft = this.getDraftState(input.slug, input.agent);
    if (draft === undefined) {
      throw new ServerDomainError(404, "DRAFT_NOT_FOUND", "skill draft not found", { slug: input.slug, agent: input.agent });
    }
    const existing = this.skills.get(input.slug);
    requireForwardVersion(existing, input.agent, input.version);
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
    const built = buildArtifactFor(ir, input.agent, this.compilerVersion);
    if (built === null) {
      // Y-3：与 createProposal 一致——IR 无该 agent 的 enabled installable adapter（如仅 mcp）时拒绝发布，
      // 避免静默发布 0 制品 version（不可安装）。
      throw new ServerDomainError(422, "SKILL_VALIDATION_FAILED", "skill has no enabled installable adapter");
    }
    const hash = sha256Bytes(built.bytes);
    await this.storage.putBlob(hash, built.bytes);
    const createdAt = new Date().toISOString();
    const artifact: RegistryArtifact = {
      artifact_id: id("ska_"),
      skill_slug: input.slug,
      version: input.version,
      agent: input.agent,
      content_sha256: hash,
      size_bytes: built.bytes.byteLength,
      source_proposal_id: null,
      created_at: createdAt
    };
    const version: RegistrySkillVersion = {
      skill_slug: input.slug,
      version: input.version,
      agent: input.agent,
      ir,
      artifacts: [artifact],
      source_proposal_id: null,
      sourceFiles: draft.sourceFiles,
      examples: draft.examples,
      changeNote: input.releaseNote ?? null,
      created_at: createdAt
    };
    const defaultAgent = existing === undefined
      ? defaultAgentOf(undefined, ir)
      : (existing.detail.defaultAgent ?? defaultAgentOf(undefined, ir));
    // 先删该 agent draft，再重算 agents（draftVersion 反映发布后状态）
    this.deleteDraftState(input.slug, input.agent);
    if (existing === undefined) {
      const versions = [version];
      const detail = registrySkillDetailSchema.parse({
        skill_id: id("skl_"),
        slug: input.slug,
        name: ir.name,
        description: ir.description,
        tags: [],
        status: "published",
        latest_version: maxVersionOf(versions),
        defaultAgent,
        agents: agentsFor(ir, defaultAgent, versions, this.drafts.get(input.slug)),
        revision: 1,
        created_at: createdAt,
        updated_at: createdAt,
        ir
      });
      this.skills.set(input.slug, { detail, versions });
    } else {
      existing.versions.push(version);
      const latestVersion = maxVersionOf(existing.versions);
      existing.detail = registrySkillDetailSchema.parse({
        ...existing.detail,
        description: ir.description,
        status: "published",
        latest_version: latestVersion,
        defaultAgent,
        agents: agentsFor(ir, defaultAgent, existing.versions, this.drafts.get(input.slug)),
        revision: existing.detail.revision + 1,
        updated_at: createdAt,
        ir
      });
    }
    this.invalidateTagUsageCache();
    await this.persist(tx);
    return structuredClone(version);
  }

  diffDraft(slug: string, agent: RegistryAgent): SkillDiffFile[] {
    const draft = this.getDraftState(slug, agent);
    if (draft === undefined) {
      throw new ServerDomainError(404, "DRAFT_NOT_FOUND", "skill draft not found", { slug, agent });
    }
    const skill = this.skills.get(slug);
    const ownVersions = skill?.versions.filter((v) => v.agent === agent) ?? [];
    const agentLatest = maxVersionOf(ownVersions);
    const publishedVersion = skill?.versions.find((v) => v.agent === agent && v.version === agentLatest);
    const published = publishedVersion?.sourceFiles ?? [];
    return computeDiff(published, draft.sourceFiles);
  }

  async deleteSkill(input: { slug: string; actorId: string }): Promise<void> {
    const state = this.skills.get(input.slug);
    const draftsInner = this.drafts.get(input.slug);
    if (state === undefined && draftsInner === undefined) {
      throw new ServerDomainError(404, "SKILL_NOT_FOUND", "skill not found", { slug: input.slug });
    }
    if (state !== undefined) this.skills.delete(input.slug);
    if (draftsInner !== undefined) this.drafts.delete(input.slug); // 删该 slug 全部 agent 草稿
    this.invalidateTagUsageCache();
    await this.persist();
  }

  // 切换默认 agent（§3.4）：校验 agent enabled → 更新 detail.defaultAgent → revision 乐观并发 → 重算 agents（isDefault/fallback）。
  // 审计事件 skill.default-agent.changed 由路由层 mutation 四件套写（与 publish 一致；store 不直接写 audit）。
  async setDefaultAgent(slug: string, agent: RegistryAgent, revision: number): Promise<RegistrySkillDetail> {
    const state = this.skills.get(slug);
    if (state === undefined) {
      throw new ServerDomainError(404, "SKILL_NOT_FOUND", "skill not found", { slug });
    }
    const agentConfig = state.detail.agents.find((a) => a.agent === agent);
    if (agentConfig === undefined || !agentConfig.enabled) {
      throw new ServerDomainError(422, "AGENT_NOT_ENABLED", "agent is not enabled for this skill", { slug, agent });
    }
    if (state.detail.revision !== revision) {
      throw new ServerDomainError(409, "REVISION_CONFLICT", "skill revision is stale", {
        slug, expected: state.detail.revision, provided: revision
      });
    }
    const now = new Date().toISOString();
    state.detail = registrySkillDetailSchema.parse({
      ...state.detail,
      defaultAgent: agent,
      // 重算 agents：isDefault 按新默认，fallback 来源切到新默认
      agents: agentsFor(state.detail.ir, agent, state.versions, this.drafts.get(slug)),
      revision: state.detail.revision + 1,
      updated_at: now
    });
    await this.persist();
    return structuredClone(state.detail);
  }

  // ---- Workflow package 委派（T9；独立域，不碰 skill/workflow 清单 CRUD；maps 与 persist 共享，snapshot 序列化在 persist）----
  async uploadWorkflowPackage(input: { files: SourceFile[]; actorId: string }): Promise<WorkflowPackageDraftState> {
    return this.workflowPackageStore.uploadPackage(input);
  }
  getWorkflowPackageDraft(key: string): WorkflowPackageDraftState {
    return this.workflowPackageStore.getPackageDraft(key);
  }
  async discardWorkflowPackageDraft(key: string, revision: number): Promise<void> {
    return this.workflowPackageStore.discardPackageDraft(key, revision);
  }
  async runWorkflowPackageChecks(input: { key: string; checkedAt: string }): Promise<SkillCheckResult> {
    return this.workflowPackageStore.runPackageChecks(input);
  }
  diffWorkflowPackageDraft(key: string): SkillDiffFile[] {
    return this.workflowPackageStore.diffPackageDraft(key);
  }
  async publishWorkflowPackage(key: string, input: { version: string; releaseNote?: string | null; actorId: string }): Promise<WorkflowPackageVersion> {
    return this.workflowPackageStore.publishPackage(key, input);
  }
  listWorkflowPackages(): WorkflowPackage[] {
    return this.workflowPackageStore.listPackages();
  }
  getWorkflowPackage(key: string): WorkflowPackage {
    return this.workflowPackageStore.getPackage(key);
  }
  listWorkflowPackageVersions(key: string): WorkflowPackageVersion[] {
    return this.workflowPackageStore.listPackageVersions(key);
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
    daily_request_limit?: number | null;
    daily_token_limit?: number | null;
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
        daily_request_limit: input.daily_request_limit ?? null,
        daily_token_limit: input.daily_token_limit ?? null,
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
        daily_request_limit: input.daily_request_limit !== undefined ? input.daily_request_limit : existing.daily_request_limit,
        daily_token_limit: input.daily_token_limit !== undefined ? input.daily_token_limit : existing.daily_token_limit,
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
    patch: Partial<Pick<AiProviderConfig, "label" | "base_url" | "model" | "enabled" | "api_key_env" | "daily_request_limit" | "daily_token_limit">>
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

  getUsage(): AiQuotaUsage[] {
    return structuredClone(this.aiConfig.usage);
  }

  // per-provider per-day 累加，前置 checkQuota 超限抛 429 QUOTA_EXCEEDED（不累加）。
  async recordUsage(input: { provider_id: string; requests: number; tokens: number }): Promise<void> {
    this.checkQuota(input);
    const today = new Date().toISOString().slice(0, 10);
    const entry = this.aiConfig.usage.find((u) => u.provider_id === input.provider_id && u.date === today);
    if (entry === undefined) {
      this.aiConfig.usage.push({
        provider_id: input.provider_id,
        date: today,
        requests: input.requests,
        tokens: input.tokens
      });
    } else {
      entry.requests += input.requests;
      entry.tokens += input.tokens;
    }
    await this.persist();
  }

  checkQuota(input: { provider_id: string; requests: number; tokens: number }): void {
    const provider = this.aiConfig.providers.find((p) => p.provider_id === input.provider_id);
    if (provider === undefined) {
      throw new ServerDomainError(404, "PROVIDER_NOT_FOUND", "ai provider not found", { provider_id: input.provider_id });
    }
    const today = new Date().toISOString().slice(0, 10);
    const entry = this.aiConfig.usage.find((u) => u.provider_id === input.provider_id && u.date === today);
    const usedRequests = entry?.requests ?? 0;
    const usedTokens = entry?.tokens ?? 0;
    if (provider.daily_request_limit !== null && usedRequests + input.requests > provider.daily_request_limit) {
      throw new ServerDomainError(429, "QUOTA_EXCEEDED", "daily request limit exceeded", {
        provider_id: input.provider_id, used: usedRequests, limit: provider.daily_request_limit, requested: input.requests
      });
    }
    if (provider.daily_token_limit !== null && usedTokens + input.tokens > provider.daily_token_limit) {
      throw new ServerDomainError(429, "QUOTA_EXCEEDED", "daily token limit exceeded", {
        provider_id: input.provider_id, used: usedTokens, limit: provider.daily_token_limit, requested: input.tokens
      });
    }
  }

  createProposal(input: { ir: SkillIr; actorId: string; agent: RegistryAgent }): ProposalState {
    // 簇A：放开 claude-code 硬编码 gate → installable && IR enabled 白名单。
    // cursor/codex/generic installable=true 且 IR enabled → 通过；mcp installable=false → 422；
    // agent 在 IR 未 enable → 422（避免为未启用 agent 建 proposal）。
    if (!ADAPTERS[input.agent].installable || input.ir.adapters[input.agent]?.enabled !== true) {
      throw new ServerDomainError(422, "ADAPTER_NOT_INSTALLABLE", "agent is not installable or not enabled for this skill");
    }
    const ir = skillIrSchema.parse(input.ir);
    const existing = this.skills.get(ir.name);
    requireForwardVersion(existing, input.agent, ir.version);
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
      // 验证闸门：至少一个 installable adapter enabled 且 compileSkill 成功（buildArtifacts 多制品路径保留）
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
    // approve → 按 proposal.requestedAgent 发布（per-agent，只产该 agent 制品）
    const artifacts = input.decision === "approve"
      ? await this.publishIr(proposal.proposed_ir, proposal.proposal_id, reviewedAt, proposal.requestedAgent)
      : [];
    proposal.status = input.decision === "approve" ? "approved" : "rejected";
    proposal.reviewed_at = reviewedAt;
    proposal.reviewedBy = input.actorId;
    proposal.reviewComment = input.comment;
    proposal.publishedArtifacts = artifacts;
    return structuredClone(proposal);
  }

  // per-agent publishIr：按指定 agent 产 1 制品 + 写 version（含 agent）+ 前进该 agent latestVersion。
  // 其他 agent 不动；detail.agents 经 agentsFor 重算（fallback 按新 latestVersion 状态）。
  // 改 public 便于未来 proposal 路径事务化（prod-readiness-2）；本次 draft→publish 路由不直接调（用 publish）。
  async publishIr(
    ir: SkillIr,
    proposalId: string | null,
    createdAt: string,
    agent: RegistryAgent
  ): Promise<RegistryArtifact[]> {
    const existing = this.skills.get(ir.name);
    requireForwardVersion(existing, agent, ir.version);
    const built = buildArtifactFor(ir, agent, this.compilerVersion);
    if (built === null) {
      // Y-3：与 createProposal/publish 一致——IR 无该 agent 的 enabled installable adapter 时拒绝发布。
      throw new ServerDomainError(422, "SKILL_VALIDATION_FAILED", "skill has no enabled installable adapter");
    }
    const hash = sha256Bytes(built.bytes);
    await this.storage.putBlob(hash, built.bytes);
    const artifact: RegistryArtifact = {
      artifact_id: id("ska_"),
      skill_slug: ir.name,
      version: ir.version,
      agent,
      content_sha256: hash,
      size_bytes: built.bytes.byteLength,
      source_proposal_id: proposalId ?? "skp_bootstrap",
      created_at: createdAt
    };
    const version: RegistrySkillVersion = {
      skill_slug: ir.name,
      version: ir.version,
      agent,
      ir,
      artifacts: [artifact],
      source_proposal_id: proposalId,
      sourceFiles: [],
      examples: [],
      changeNote: null,
      created_at: createdAt
    };
    const defaultAgent = existing === undefined
      ? defaultAgentOf(undefined, ir)
      : (existing.detail.defaultAgent ?? defaultAgentOf(undefined, ir));
    if (existing === undefined) {
      const versions = [version];
      const detail = registrySkillDetailSchema.parse({
        skill_id: id("skl_"),
        slug: ir.name,
        name: ir.name,
        description: ir.description,
        tags: [],
        status: "published",
        latest_version: maxVersionOf(versions),
        defaultAgent,
        agents: agentsFor(ir, defaultAgent, versions, this.drafts.get(ir.name)),
        revision: 1,
        created_at: createdAt,
        updated_at: createdAt,
        ir
      });
      this.skills.set(ir.name, { detail, versions });
    } else {
      existing.versions.push(version);
      const latestVersion = maxVersionOf(existing.versions);
      existing.detail = registrySkillDetailSchema.parse({
        ...existing.detail,
        description: ir.description,
        status: "published",
        latest_version: latestVersion,
        defaultAgent,
        agents: agentsFor(ir, defaultAgent, existing.versions, this.drafts.get(ir.name)),
        revision: existing.detail.revision + 1,
        updated_at: createdAt,
        ir
      });
    }
    this.invalidateTagUsageCache();
    return [artifact];
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

  // per-agent：取该 agent 最新 version 的 artifact（listVersions 按 agent 过滤后取首）
  latestArtifact(slug: string, agent: RegistryAgent): RegistryArtifact {
    const versions = this.listVersions(slug, agent);
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
