import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
  aiConfigStateSchema,
  aiProviderConfigSchema,
  canonicalJson,
  draftStateSchema,
  externalSkillSchema,
  npmReleaseRecordSchema,
  registrySkillDetailSchema,
  registrySkillVersionSchema,
  registryProjectWorkflowBindingSchema,
  registryTagSchema,
  skillUsageExampleSchema,
  workflowFamilyDraftStateSchema,
  workflowFamilySchema,
  workflowFamilyVersionSchema,
  SKILL_ERROR_CODE,
  type AiConfigState,
  type AiProviderApiFormat,
  type AiProviderConfig,
  type AiQuotaUsage,
  type ProviderModel,
  type AgentSkillConfig,
  type DraftState,
  type ExternalSkill,
  type ExternalSkillSource,
  type FixPlan,
  type NpmReleaseRecord,
  type PublishSkillResponse,
  type RegistryAgent,
  type RegistryArtifact,
  type RegistryProjectWorkflowBinding,
  type RegistrySkillDetail,
  type RegistrySkillProposal,
  type RegistrySkillVersion,
  type RegistryTag,
  type SensitiveReviewEvidence,
  type SensitiveReviewSubmission,
  type SkillCheckResult,
  type SkillDiffFile,
  type SkillFrontmatter,
  type SkillUsageExample,
  type SourceFile,
  type WorkflowFamily,
  type WorkflowFamilyDraftState,
  type WorkflowFamilyMutation,
  type WorkflowFamilyVersion
} from "@hunter-harness/contracts";
import {
  AGENT_DESCRIPTORS,
  INSTALLABLE_AGENTS,
  SKILL_TARGET_AGENTS,
  buildFixPatch,
  bumpPatch,
  checkSkill,
  compareSemver,
  computeDiff,
  deriveSlug,
  findEntryFile,
  parseFrontmatter,
  scanSensitiveFiles,
  sha256Bytes,
  SkillEntryError
} from "@hunter-harness/core";
import AdmZip from "adm-zip";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { ServerDomainError, type TransactionRepository } from "../repositories/interfaces.js";
import type { ArtifactStorage } from "../storage/interface.js";
import type { RegistryPersistence } from "./persistence.js";
import type { NpmPublishAttemptResult, SkillNpmPackageInput, WorkflowFamilyNpmPackageInput } from "../npm/publisher.js";
import { layoutWorkflowFamilyNpmFiles, skillNpmPackageInput, workflowFamilyNpmPackageInput } from "../npm/publisher.js";
import type { NpmPublishConfig } from "../npm/config.js";
import {
  ExternalFetchError,
  fetchExternalSnapshot,
  type ExternalFetcherDeps
} from "../external/fetchers.js";
import { WorkflowFamilyStore, type WorkflowFamilyState } from "./workflow-family-store.js";

// applyFixSuggestion 可写白名单（examples/allowed_capabilities/instructions/description）；
// tags/null 为展示型建议不可写 → 422。与 output-parser FIX_APPLIES_TO_WHITELIST（5 值含 tags，解析白名单）语义不同，不可合并。
const WRITABLE_APPLIES_TO = ["examples", "instructions", "description"] as const;

export interface BootstrapSkill {
  slug: string;
  version: string;
  sourceFiles: SourceFile[];
}

export interface BootstrapBundle {
  registryVersion: string;
  compilerVersion: string;
  skills: BootstrapSkill[];
}

interface SkillState {
  detail: RegistrySkillDetail;
  versions: RegistrySkillVersion[];
  npmReleases: NpmReleaseRecord[];
}

interface ProposalState extends RegistrySkillProposal {
  requestedAgent: RegistryAgent;
  reviewedBy: string | null;
  reviewComment: string | null;
  publishedArtifacts: RegistryArtifact[];
  sourceFiles: SourceFile[];
  version: string;
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
// per-agent 独立版本：每个 enabled installable agent 持独立 latestVersion（从该 agent 的 version 序列取最大）；
// draftVersion 从该 agent 的 draft 取；isDefault 由 detail.defaultAgent 判定。
// fallback（§9 / UT-014）：agent 无专属版本且非默认 agent 且默认 agent 有版本 → 回退默认 agent latestVersion，
// sourcePackagePath 标注 "fallback:<defaultAgent>"；默认 agent 自身不 fallback。
// 新模型：agent 支持由上传存在性 + fallback 决定（去 ir.adapters 声明）；enabledAgents = installable 中（有 version ∪ 有 draft ∪ 默认 agent）。
function agentsFor(
  slug: string,
  defaultAgent: RegistryAgent | null,
  versions: RegistrySkillVersion[],
  draftsForSlug: Map<RegistryAgent, DraftState> | undefined
): AgentSkillConfig[] {
  const defaultLatest = defaultAgent === null ? null : maxVersionOf(versions.filter((v) => v.agent === defaultAgent));
  // 新模型：所有 installable agent 都支持（agent 支持由 fallback 决定；无 own version 的非默认 agent fallback default latestVersion）
  const enabledAgents = [...INSTALLABLE_AGENTS];
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
        installTarget: AGENT_DESCRIPTORS[agent].installTarget(slug),
        latestVersion: defaultLatest,
        draftVersion,
        sourcePackagePath: defaultLatest === null ? null : "fallback:" + defaultAgent
      };
    }
    return {
      agent,
      enabled: true,
      isDefault,
      installTarget: AGENT_DESCRIPTORS[agent].installTarget(slug),
      latestVersion: ownLatest,
      draftVersion,
      sourcePackagePath: null
    };
  });
}

// defaultAgentOf：优先 detail.defaultAgent（用户设定），否则 claude-code，否则首个有 version 的 installable agent，否则首个 installable，否则 null。
// 新模型：从 versions 推断（去 ir.adapters 依赖，评审 Y2）。
function defaultAgentOf(detail: RegistrySkillDetail | undefined, versions: RegistrySkillVersion[]): RegistryAgent | null {
  if (detail !== undefined && detail.defaultAgent !== null) return detail.defaultAgent;
  if (AGENT_DESCRIPTORS["claude-code"].installable) return "claude-code";
  for (const v of versions) {
    if (AGENT_DESCRIPTORS[v.agent]?.installable === true) return v.agent;
  }
  return INSTALLABLE_AGENTS[0] ?? null;
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
    installTarget: AGENT_DESCRIPTORS[agent]?.installTarget(slug) ?? ".claude/skills/" + slug + "/",
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

// 单 agent 制品构建（源文件驱动）：zip 全部 sourceFiles + hunter-skill.json manifest。
// installable 才构建；entry 缺失抛 422 SKILL_ENTRY_NOT_FOUND；agent 未 installable 返回 null（由调用方决定 422）。
// manifest source_sha256（取代旧 source_ir_sha256）= sourceFiles canonical sha256；target_path = installTarget(slug) 文件夹根（设计 §3.4）。
function buildArtifactFor(
  sourceFiles: SourceFile[],
  slug: string,
  version: string,
  agent: RegistryAgent
): BuiltArtifact | null {
  const descriptor = AGENT_DESCRIPTORS[agent];
  if (!descriptor.installable) return null;
  try {
    findEntryFile(sourceFiles, agent);
  } catch (error) {
    if (error instanceof SkillEntryError) {
      throw new ServerDomainError(422, SKILL_ERROR_CODE.ENTRY_NOT_FOUND, error.message, { agent });
    }
    throw error;
  }
  const sourceSha256 = sha256Bytes(canonicalJson(
    [...sourceFiles].sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => ({ path: f.path, content: f.content }))
  ));
  const targetPath = descriptor.installTarget(slug);
  const manifest: Record<string, unknown> = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    slug,
    version,
    agent,
    source_sha256: sourceSha256,
    target_path: targetPath,
    install_mode: descriptor.installMode
  };
  if (descriptor.blockId !== undefined) {
    manifest.block_id = descriptor.blockId(slug);
  }
  const zip = new AdmZip();
  for (const f of sourceFiles) {
    zip.addFile(f.path, Buffer.from(f.content, "utf8"));
  }
  zip.addFile("hunter-skill.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"));
  return { agent, bytes: zip.toBuffer() };
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

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

// YAML round-trip 重写 entry frontmatter（用于 applyFixSuggestion 改 description 等字段）。
function rewriteFrontmatter(content: string, mutate: (fm: Record<string, unknown>) => void): string {
  const match = FRONTMATTER_RE.exec(content);
  if (match === null) return content;
  const raw = match[1] ?? "";
  const body = match[2] ?? "";
  const fm = parseYaml(raw) as Record<string, unknown>;
  mutate(fm);
  return `---\n${stringifyYaml(fm)}---\n${body}`;
}

export class RegistryStore {
  private readonly skills = new Map<string, SkillState>();
  private readonly proposals = new Map<string, ProposalState>();
  private readonly tags = new Map<string, RegistryTag>();
  private readonly projectBindings = new Map<string, RegistryProjectWorkflowBinding>();
  // per-agent 独立草稿：Map<slug, Map<agent, DraftState>>。每 agent 独立 draftVersion/revision/checks。
  private readonly drafts = new Map<string, Map<RegistryAgent, DraftState>>();
  private readonly sensitiveReviews = new Map<string, SensitiveReviewEvidence[]>();
  private readonly successfulPublishAttempts = new Map<string, PublishSkillResponse>();
  private readonly publishingSlugs = new Set<string>();
  private readonly workflowFamilies = new Map<string, WorkflowFamilyState>();
  private readonly workflowFamilyDrafts = new Map<string, WorkflowFamilyDraftState>();
  private readonly workflowFamilyStore: WorkflowFamilyStore;
  private readonly externalSkills = new Map<string, ExternalSkill>();
  private compilerVersion = "1.0.0";
  private tagUsageCache: Map<string, number> | null = null;
  private aiConfig: AiConfigState = { defaultProvider: null, providers: [], usage: [] };
  private externalFetcherDeps: ExternalFetcherDeps = {};

  constructor(
    private readonly storage: ArtifactStorage,
    private readonly persistence?: RegistryPersistence
  ) {
    // 在构造函数体初始化（非 field initializer）：依赖参数属性 this.storage，须在参数属性赋值后（esbuild field init 先于参数属性会导致 this.storage undefined）。
    this.workflowFamilyStore = new WorkflowFamilyStore({
      storage: this.storage,
      families: this.workflowFamilies,
      drafts: this.workflowFamilyDrafts,
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

  private reviewMatches(slug: string, agent: RegistryAgent, fingerprints: readonly string[]): boolean {
    const accepted = this.sensitiveReviews.get(`${slug}\0${agent}`)
      ?.flatMap((review) => review.finding_fingerprints)
      .sort() ?? [];
    return canonicalJson(accepted) === canonicalJson([...fingerprints].sort());
  }

  async initialize(bundle?: BootstrapBundle): Promise<void> {
    const snapshot = await this.persistence?.load();
    if (snapshot !== null && snapshot !== undefined) {
      const value = snapshot as {
        schemaVersion?: number;
        compilerVersion: string;
        skills: Array<[string, unknown]>;
        proposals: Array<[string, ProposalState]>;
        tags: Array<[string, unknown]>;
        projectBindings?: Array<[string, unknown]>;
        drafts?: Array<[string, unknown]>;
        workflowFamilies?: Array<[string, unknown]>;
        workflowFamilyDrafts?: Array<[string, unknown]>;
        externalSkills?: Array<[string, unknown]>;
        aiConfig?: unknown;
        aiUsage?: unknown;
        sensitiveReviews?: Array<[string, SensitiveReviewEvidence[]]>;
        successfulPublishAttempts?: Array<[string, PublishSkillResponse]>;
      };
      this.compilerVersion = value.compilerVersion;
      for (const [key, raw] of value.skills) {
        const state = this.migrateSkillState(raw);
        if (state !== null) this.skills.set(key, state);
      }
      for (const [key, state] of value.proposals) this.proposals.set(key, state);
      // skill-proposal 轨已删除：旧快照 proposals 可读但不保留业务状态（兼容读后清空）
      this.proposals.clear();
      for (const [key, raw] of value.tags) this.tags.set(key, migrateTag(raw));
      for (const [key, raw] of value.projectBindings ?? []) {
        const parsed = registryProjectWorkflowBindingSchema.safeParse(raw);
        if (parsed.success) this.projectBindings.set(key, parsed.data);
      }
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
          // 旧 slug-only 格式：DraftState 无 agent → 迁默认 agent（claude-code）；无 installable agent 则丢弃
          const obj = raw as { agent?: RegistryAgent } | null;
          const agent: RegistryAgent | null = obj?.agent ?? defaultAgentOf(undefined, []);
          if (agent === null) {
            console.warn("[registry] discarding draft with no installable agent:", key);
            continue;
          }
          const parsed = draftStateSchema.safeParse({ ...obj, agent });
          if (parsed.success) this.setDraftState(key, agent, parsed.data);
        }
      }
      for (const [key, reviews] of value.sensitiveReviews ?? []) {
        if (Array.isArray(reviews)) this.sensitiveReviews.set(key, structuredClone(reviews));
      }
      for (const [key, attempt] of value.successfulPublishAttempts ?? []) {
        this.successfulPublishAttempts.set(key, structuredClone(attempt));
      }
      // 草稿加载完成后重算各 skill 的 agents：draftVersion 字段需反映已加载草稿（migrateSkillState 迁移时 drafts 尚未加载，传 undefined）
      for (const [slug, state] of this.skills) {
        const defaultAgent = state.detail.defaultAgent ?? defaultAgentOf(state.detail, state.versions);
        state.detail = registrySkillDetailSchema.parse({
          ...state.detail,
          defaultAgent,
          agents: agentsFor(slug, defaultAgent, state.versions, this.drafts.get(slug))
        });
      }
      for (const [key, raw] of value.workflowFamilies ?? []) {
        const state = raw as { detail: unknown; versions: unknown[] };
        const detail = workflowFamilySchema.safeParse(state.detail);
        if (!detail.success) continue;
        const versions: WorkflowFamilyVersion[] = [];
        for (const v of Array.isArray(state.versions) ? state.versions : []) {
          const parsed = workflowFamilyVersionSchema.safeParse(v);
          if (parsed.success) versions.push(parsed.data);
        }
        this.workflowFamilies.set(key, { detail: detail.data, versions });
      }
      for (const [key, raw] of value.workflowFamilyDrafts ?? []) {
        const parsed = workflowFamilyDraftStateSchema.safeParse(raw);
        if (parsed.success) this.workflowFamilyDrafts.set(key, parsed.data);
      }
      for (const [key, raw] of value.externalSkills ?? []) {
        const parsed = externalSkillSchema.safeParse(raw);
        if (parsed.success) this.externalSkills.set(key, parsed.data);
      }
      // AI config 反序列化：schemaVersion < 4 时 migrate 每个 provider（旧单 model → models[] + selected_model_id）
      const aiCfgRaw = value.aiConfig as { providers?: unknown[]; defaultProvider?: string | null; usage?: unknown[] } | undefined;
      if (aiCfgRaw !== undefined && (value.schemaVersion ?? 0) < 4) {
        const providersRaw = Array.isArray(aiCfgRaw.providers) ? aiCfgRaw.providers : [];
        aiCfgRaw.providers = providersRaw.map((p, idx) => this.migrateProvider(p, idx));
      }
      const aiCfg = aiConfigStateSchema.safeParse(aiCfgRaw);
      this.aiConfig = aiCfg.success ? aiCfg.data : { defaultProvider: null, providers: [], usage: [] };
      // COM-001：旧全局 aiUsage {requests,tokens} 迁移到默认 provider 当日条目（仅当 usage 为空且 defaultProvider 存在；已有 usage 不重复迁移）
      const usageRaw = value.aiUsage as { requests?: number; tokens?: number } | undefined;
      const legacyRequests = typeof usageRaw?.requests === "number" ? usageRaw.requests : 0;
      const legacyTokens = typeof usageRaw?.tokens === "number" ? usageRaw.tokens : 0;
      if (this.aiConfig.usage.length === 0 && (legacyRequests > 0 || legacyTokens > 0) && this.aiConfig.defaultProvider !== null) {
        this.aiConfig.usage.push({
          provider_id: this.aiConfig.defaultProvider,
          date: new Date().toISOString().slice(0, 10),
          model: "",
          requests: legacyRequests,
          tokens: legacyTokens,
          input_tokens: 0,
          output_tokens: 0,
          cache_hit_tokens: 0,
          cache_create_tokens: 0,
          cost: 0
        });
      }
      return;
    }
    if (bundle === undefined) return;
    this.compilerVersion = bundle.compilerVersion;
    for (const skill of bundle.skills) {
      if (this.skills.has(skill.slug)) continue;
      const agent = defaultAgentOf(undefined, []);
      if (agent === null) continue; // 无 installable agent，跳过 bootstrap 发布
      await this.publishIr(skill.sourceFiles, skill.slug, skill.version, null, new Date().toISOString(), agent);
    }
    await this.persist();
  }

  async persist(tx?: TransactionRepository): Promise<void> {
    await this.persistence?.save({
      schemaVersion: 4,
      compilerVersion: this.compilerVersion,
      skills: [...this.skills.entries()],
      proposals: [],
      tags: [...this.tags.entries()],
      projectBindings: [...this.projectBindings.entries()],
      // 嵌套 drafts：[[slug, [[agent, DraftState]]]]（UT-031）
      drafts: [...this.drafts.entries()].map(([slug, m]) => [slug, [...m.entries()]] as [string, [RegistryAgent, DraftState][]]),
      workflowFamilies: [...this.workflowFamilies.entries()].map(([slug, state]) => [slug, { detail: state.detail, versions: state.versions }]),
      workflowFamilyDrafts: [...this.workflowFamilyDrafts.entries()],
      externalSkills: [...this.externalSkills.entries()],
      aiConfig: this.aiConfig
      ,sensitiveReviews: [...this.sensitiveReviews.entries()]
      ,successfulPublishAttempts: [...this.successfulPublishAttempts.entries()]
    }, tx);
  }

  setExternalFetcherDeps(deps: ExternalFetcherDeps): void {
    this.externalFetcherDeps = deps;
  }

  private migrateSkillState(raw: unknown): SkillState | null {
    try {
      const obj = (raw ?? {}) as Record<string, unknown>;
      const detail = migrateSkillDetail(obj.detail);
      const rawVersions = Array.isArray(obj.versions) ? obj.versions : [];
      const versions = rawVersions.map((v) => migrateSkillVersion(v, detail.defaultAgent));
      // defaultAgent：优先 detail.defaultAgent，否则从 versions 推断（去 ir 依赖，评审 Y2）
      const defaultAgent = detail.defaultAgent ?? defaultAgentOf(detail, versions);
      // 重算 agents：per-agent latestVersion 从迁移后 versions 取；旧 v2 同步版本由此拆为 per-agent 独立（COM-003）
      const recomputedAgents = agentsFor(detail.slug, defaultAgent, versions, undefined);
      const latestVersion = maxVersionOf(versions);
      const detailFinal = registrySkillDetailSchema.parse({
        ...detail,
        defaultAgent,
        agents: recomputedAgents,
        latest_version: latestVersion,
        npmReleases: Array.isArray(obj.npmReleases)
          ? obj.npmReleases.map((entry) => npmReleaseRecordSchema.parse(entry))
          : Array.isArray((obj.detail as { npmReleases?: unknown } | undefined)?.npmReleases)
            ? ((obj.detail as { npmReleases: unknown[] }).npmReleases)
              .map((entry) => npmReleaseRecordSchema.parse(entry))
            : []
      });
      return {
        detail: detailFinal,
        versions,
        npmReleases: detailFinal.npmReleases
      };
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
    if (state === undefined) throw new ServerDomainError(404, SKILL_ERROR_CODE.NOT_FOUND, "skill not found");
    return registrySkillDetailSchema.parse({
      ...structuredClone(state.detail),
      npmReleases: structuredClone(state.npmReleases)
    });
  }

  listVersions(slug: string, agent?: RegistryAgent): RegistrySkillVersion[] {
    const state = this.skills.get(slug);
    if (state === undefined) throw new ServerDomainError(404, SKILL_ERROR_CODE.NOT_FOUND, "skill not found");
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
    draftVersion: string | null;
  }): Promise<DraftState> {
    const now = new Date().toISOString();
    const existing = this.getDraftState(input.slug, input.agent);
    const draft = draftStateSchema.parse({
      slug: input.slug,
      agent: input.agent,
      sourceFiles: input.sourceFiles,
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
      throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "skill draft not found", { slug, agent });
    }
    if (draft.revision !== revision) {
      throw new ServerDomainError(409, SKILL_ERROR_CODE.REVISION_CONFLICT, "draft revision is stale", {
        slug, agent, expected: draft.revision, provided: revision
      });
    }
    this.deleteDraftState(slug, agent);
    await this.persist();
  }

  async uploadDraft(input: {
    files: SourceFile[];
    actorId: string;
    agent: RegistryAgent;
    review?: SensitiveReviewSubmission | undefined;
  }): Promise<DraftState> {
    const paths = input.files.map((f) => f.path);
    const hasWorkflow = paths.some((p) => /(^|\/)workflow\.ya?ml$/i.test(p));
    const hasSkillsDir = paths.some((p) => /(^|\/)skills\//i.test(p));
    const hasAgentsDir = paths.some((p) => /(^|\/)agents\//i.test(p));
    const hasProtocolsDir = paths.some((p) => /(^|\/)protocols\//i.test(p));
    const hasTemplatesDir = paths.some((p) => /(^|\/)templates\//i.test(p));
    if (hasWorkflow && (hasSkillsDir || hasAgentsDir || hasProtocolsDir || hasTemplatesDir)) {
      throw new ServerDomainError(422, SKILL_ERROR_CODE.WORKFLOW_PACKAGE_REDIRECT, "workflow bundles must use the workflow family center", { redirect: "workflow-families" });
    }
    const unsafe = input.files.find((f) => DANGEROUS_PATH.test(f.path));
    if (unsafe !== undefined) {
      throw new ServerDomainError(422, SKILL_ERROR_CODE.VALIDATION_FAILED, "unsafe file path: " + unsafe.path);
    }
    let slug: string;
    try {
      slug = deriveSlug(input.files, input.agent);
    } catch (error) {
      if (error instanceof SkillEntryError) {
        if (error.code === SKILL_ERROR_CODE.ENTRY_NOT_FOUND) {
          throw new ServerDomainError(422, SKILL_ERROR_CODE.ENTRY_NOT_FOUND, error.message, { agent: input.agent });
        }
        throw new ServerDomainError(422, SKILL_ERROR_CODE.VALIDATION_FAILED, error.message);
      }
      throw error;
    }
    const fileMap: Record<string, string> = {};
    for (const f of input.files) fileMap[f.path] = f.content;
    const findings = scanSensitiveFiles(fileMap);
    const safeFindings = findings.findings.map(({ disposition, ...finding }) => {
      void disposition;
      return finding;
    });
    if (findings.hard_blocked) {
      throw new ServerDomainError(422, "SENSITIVE_CONTENT_BLOCKED", "skill contains sensitive content", {
        scanner_version: findings.scanner_version,
        finding_count: findings.findings.length,
        findings: safeFindings
      });
    }
    if (findings.review_required) {
      if (input.review === undefined) {
        throw new ServerDomainError(422, "SENSITIVE_CONTENT_REVIEW_REQUIRED", "skill contains content that requires explicit review", {
          scanner_version: findings.scanner_version,
          finding_count: findings.findings.length,
          findings: safeFindings
        });
      }
      const expected = findings.findings.map((finding) => finding.fingerprint).sort();
      const provided = [...input.review.finding_fingerprints].sort();
      if (input.review.scanner_version !== findings.scanner_version || canonicalJson(expected) !== canonicalJson(provided)) {
        throw new ServerDomainError(409, "SENSITIVE_REVIEW_STALE", "sensitive review no longer matches the uploaded files", {
          scanner_version: findings.scanner_version,
          findings: safeFindings
        });
      }
      const acceptedAt = new Date().toISOString();
      this.sensitiveReviews.set(`${slug}\0${input.agent}`, expected.map((fingerprint) => ({
        scanner_version: findings.scanner_version,
        finding_fingerprints: [fingerprint],
        reason: input.review?.reason ?? "",
        actor: input.actorId,
        accepted_at: acceptedAt
      })));
    } else {
      this.sensitiveReviews.delete(`${slug}\0${input.agent}`);
    }
    // A Skill owns one semver across all target agents. The source agent only
    // selects the uploaded variant; the candidate always advances global latest.
    const skillState = this.skills.get(slug);
    const latest = skillState?.detail.latest_version ?? maxVersionOf(skillState?.versions ?? []);
    const draftVersion = latest === null ? "0.1.0" : bumpPatch(latest);
    return this.upsertDraft({ slug, agent: input.agent, sourceFiles: input.files, draftVersion });
  }

  async runChecks(input: { slug: string; agent: RegistryAgent; checkedAt: string }): Promise<SkillCheckResult> {
    const draft = this.getDraftState(input.slug, input.agent);
    if (draft === undefined) {
      throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "skill draft not found", { slug: input.slug, agent: input.agent });
    }
    const latest = this.skills.get(input.slug)?.detail.latest_version ?? null;
    const result = checkSkill({
      sourceFiles: draft.sourceFiles,
      agent: input.agent,
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
      throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "skill draft not found", { slug: input.slug, agent: input.agent });
    }
    const updated: DraftState = { ...draft, aiChecks: input.aiChecks, updated_at: input.checkedAt };
    this.setDraftState(input.slug, input.agent, updated);
    await this.persist();
    return structuredClone(updated);
  }

  async buildDraftFix(slug: string, agent: RegistryAgent, checkIds: string[] | null): Promise<FixPlan> {
    const draft = this.getDraftState(slug, agent);
    if (draft === undefined) {
      throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "skill draft not found", { slug, agent });
    }
    const latestVersion = this.skills.get(slug)?.detail.latest_version ?? null;
    return buildFixPatch({
      sourceFiles: draft.sourceFiles,
      agent,
      checks: draft.checks,
      aiChecks: draft.aiChecks,
      latestVersion,
      checkIds
    });
  }

  async applyDraftFix(slug: string, agent: RegistryAgent, checkIds: string[] | null): Promise<DraftState> {
    const draft = this.getDraftState(slug, agent);
    if (draft === undefined) {
      throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "skill draft not found", { slug, agent });
    }
    const latestVersion = this.skills.get(slug)?.detail.latest_version ?? null;
    const { mergedFiles } = buildFixPatch({
      sourceFiles: draft.sourceFiles,
      agent,
      checks: draft.checks,
      aiChecks: draft.aiChecks,
      latestVersion,
      checkIds
    });
    // mergedFiles 反映源文件改写；应用到 draft.sourceFiles（覆盖改动文件，删除 removed）
    const fileMap: Record<string, string> = {};
    for (const f of draft.sourceFiles) fileMap[f.path] = f.content;
    for (const d of mergedFiles) {
      if (d.draftContent !== null) {
        fileMap[d.path] = d.draftContent;
      } else {
        Reflect.deleteProperty(fileMap, d.path);
      }
    }
    const findings = scanSensitiveFiles(fileMap);
    if (findings.blocked) {
      throw new ServerDomainError(422, "SENSITIVE_CONTENT_BLOCKED", "fixed source contains sensitive content", { finding_count: findings.findings.length });
    }
    const updatedSourceFiles: SourceFile[] = Object.entries(fileMap).map(([path, content]) => ({ path, content }));
    const now = new Date().toISOString();
    const cleared = draftStateSchema.parse({
      ...draft,
      agent,
      sourceFiles: updatedSourceFiles,
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
      throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "skill draft not found", { slug: input.slug, agent: input.agent });
    }
    const updated: DraftState = { ...draft, releaseNote: input.releaseNote, updated_at: input.generatedAt };
    this.setDraftState(input.slug, input.agent, updated);
    await this.persist();
    return structuredClone(updated);
  }

  // 采纳 AI 修复建议：按 appliesTo 白名单写入 draft.sourceFiles / draft.examples 对应字段，
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
      throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "skill draft not found", { slug: input.slug, agent: input.agent });
    }
    if (input.appliesTo === null || !(WRITABLE_APPLIES_TO as readonly string[]).includes(input.appliesTo)) {
      throw new ServerDomainError(422, SKILL_ERROR_CODE.VALIDATION_FAILED, "appliesTo is not a writable target", { appliesTo: input.appliesTo });
    }
    const target = input.appliesTo as typeof WRITABLE_APPLIES_TO[number];
    let fixedExamples: SkillUsageExample[] = structuredClone(draft.examples);
    const fileMap: Record<string, string> = {};
    for (const f of draft.sourceFiles) fileMap[f.path] = f.content;
    if (target === "description") {
      if (input.suggestedContent.length === 0) {
        throw new ServerDomainError(422, SKILL_ERROR_CODE.VALIDATION_FAILED, "suggestedContent for description must be non-empty", { appliesTo: target });
      }
      try {
        const entry = findEntryFile(draft.sourceFiles, input.agent);
        fileMap[entry.path] = rewriteFrontmatter(entry.content, (fm) => {
          fm["description"] = input.suggestedContent;
        });
      } catch (error) {
        if (error instanceof SkillEntryError) {
          throw new ServerDomainError(422, SKILL_ERROR_CODE.VALIDATION_FAILED, error.message);
        }
        throw error;
      }
    } else if (target === "examples") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.suggestedContent);
      } catch {
        throw new ServerDomainError(422, SKILL_ERROR_CODE.VALIDATION_FAILED, "suggestedContent for examples must be a JSON array of usage examples", { appliesTo: target });
      }
      const result = skillUsageExampleSchema.array().safeParse(parsed);
      if (!result.success) {
        throw new ServerDomainError(422, SKILL_ERROR_CODE.VALIDATION_FAILED, "suggestedContent for examples must be a JSON array of usage examples", { appliesTo: target });
      }
      if (result.data.length === 0) {
        throw new ServerDomainError(422, SKILL_ERROR_CODE.VALIDATION_FAILED, "suggestedContent for examples must be a non-empty array", { appliesTo: target });
      }
      fixedExamples = result.data;
    } else {
      // instructions → entry body 追加段（array of strings）；allowed_capabilities 已从白名单移除（新模型无此字段）
      let parsed: unknown;
      try {
        parsed = JSON.parse(input.suggestedContent);
      } catch {
        throw new ServerDomainError(422, SKILL_ERROR_CODE.VALIDATION_FAILED, `suggestedContent for ${target} must be a JSON array of strings`, { appliesTo: target });
      }
      let arr: string[];
      try {
        arr = parseSuggestedStringArray(parsed);
      } catch (error) {
        throw new ServerDomainError(422, SKILL_ERROR_CODE.VALIDATION_FAILED, (error as Error).message, { appliesTo: target });
      }
      if (arr.length === 0) {
        throw new ServerDomainError(422, SKILL_ERROR_CODE.VALIDATION_FAILED, `suggestedContent for ${target} must be a non-empty array of strings`, { appliesTo: target });
      }
      try {
        const entry = findEntryFile(draft.sourceFiles, input.agent);
        fileMap[entry.path] = entry.content + "\n\n## Instructions\n\n" + arr.map((i) => "- " + i).join("\n") + "\n";
      } catch (error) {
        if (error instanceof SkillEntryError) {
          throw new ServerDomainError(422, SKILL_ERROR_CODE.VALIDATION_FAILED, error.message);
        }
        throw error;
      }
    }
    const findings = scanSensitiveFiles(fileMap);
    if (findings.blocked) {
      throw new ServerDomainError(422, "SENSITIVE_CONTENT_BLOCKED", "applied suggestion contains sensitive content", { finding_count: findings.findings.length });
    }
    const updatedSourceFiles: SourceFile[] = Object.entries(fileMap).map(([path, content]) => ({ path, content }));
    const now = new Date().toISOString();
    const cleared = draftStateSchema.parse({
      ...draft,
      agent: input.agent,
      sourceFiles: updatedSourceFiles,
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
      throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "skill draft not found", { slug: input.slug, agent: input.agent });
    }
    const existing = this.skills.get(input.slug);
    requireForwardVersion(existing, input.agent, input.version);
    let meta: SkillFrontmatter;
    try {
      const entry = findEntryFile(draft.sourceFiles, input.agent);
      meta = parseFrontmatter(entry.content);
    } catch (error) {
      if (error instanceof SkillEntryError) {
        throw new ServerDomainError(422, SKILL_ERROR_CODE.VALIDATION_FAILED, error.message);
      }
      throw error;
    }
    const fileMap: Record<string, string> = {};
    for (const f of draft.sourceFiles) fileMap[f.path] = f.content;
    const findings = scanSensitiveFiles(fileMap);
    if (findings.hard_blocked || (findings.review_required && !this.reviewMatches(
      input.slug,
      input.agent,
      findings.findings.map((finding) => finding.fingerprint)
    ))) {
      throw new ServerDomainError(422, "SENSITIVE_CONTENT_BLOCKED", "skill contains sensitive content", {
        finding_count: findings.findings.length
      });
    }
    const built = buildArtifactFor(draft.sourceFiles, input.slug, input.version, input.agent);
    if (built === null) {
      // agent 未 installable 时拒绝发布（避免静默发布 0 制品 version）
      throw new ServerDomainError(422, SKILL_ERROR_CODE.VALIDATION_FAILED, "skill has no enabled installable adapter");
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
      artifacts: [artifact],
      source_proposal_id: null,
      sourceFiles: draft.sourceFiles,
      examples: draft.examples,
      changeNote: input.releaseNote ?? null,
      created_at: createdAt
    };
    const defaultAgent = existing === undefined
      ? defaultAgentOf(undefined, [])
      : (existing.detail.defaultAgent ?? defaultAgentOf(existing.detail, existing.versions));
    // 先删该 agent draft，再重算 agents（draftVersion 反映发布后状态）
    this.deleteDraftState(input.slug, input.agent);
    if (existing === undefined) {
      const versions = [version];
      const detail = registrySkillDetailSchema.parse({
        skill_id: id("skl_"),
        slug: input.slug,
        name: meta.name,
        description: meta.description,
        kind: meta.kind ?? null,
        tags: [],
        status: "published",
        latest_version: maxVersionOf(versions),
        defaultAgent,
        agents: agentsFor(input.slug, defaultAgent, versions, this.drafts.get(input.slug)),
        revision: 1,
        created_at: createdAt,
        updated_at: createdAt
      });
      this.skills.set(input.slug, { detail, versions, npmReleases: [] });
    } else {
      existing.versions.push(version);
      const latestVersion = maxVersionOf(existing.versions);
      existing.detail = registrySkillDetailSchema.parse({
        ...existing.detail,
        description: meta.description,
        kind: meta.kind ?? null,
        status: "published",
        latest_version: latestVersion,
        defaultAgent,
        agents: agentsFor(input.slug, defaultAgent, existing.versions, this.drafts.get(input.slug)),
        revision: existing.detail.revision + 1,
        updated_at: createdAt
      });
    }
    this.invalidateTagUsageCache();
    await this.persist(tx);
    return structuredClone(version);
  }

  async publishUnified(
    input: {
      slug: string;
      version: string;
      sourceAgent: RegistryAgent;
      draftRevision: number;
      releaseNote?: string | null;
      actorId: string;
    },
    config: NpmPublishConfig,
    publishNpm: (input: SkillNpmPackageInput) => Promise<NpmPublishAttemptResult>
  ): Promise<PublishSkillResponse> {
    if (this.publishingSlugs.has(input.slug)) {
      throw new ServerDomainError(409, "SKILL_PUBLISH_IN_PROGRESS", "another publish is already in progress for this skill", {
        slug: input.slug
      });
    }
    this.publishingSlugs.add(input.slug);
    try {
      return await this.publishUnifiedLocked(input, config, publishNpm);
    } finally {
      this.publishingSlugs.delete(input.slug);
    }
  }

  private async publishUnifiedLocked(
    input: {
      slug: string;
      version: string;
      sourceAgent: RegistryAgent;
      draftRevision: number;
      releaseNote?: string | null;
      actorId: string;
    },
    config: NpmPublishConfig,
    publishNpm: (input: SkillNpmPackageInput) => Promise<NpmPublishAttemptResult>
  ): Promise<PublishSkillResponse> {
    const attemptKey = `${input.slug}\0${input.sourceAgent}\0${input.version}\0${input.draftRevision}`;
    const completed = this.successfulPublishAttempts.get(attemptKey);
    if (completed !== undefined) {
      return structuredClone({
        ...completed,
        npmRelease: { ...completed.npmRelease, status: "idempotent" }
      });
    }

    const draft = this.getDraftState(input.slug, input.sourceAgent);
    if (draft === undefined || draft.revision !== input.draftRevision) {
      throw new ServerDomainError(409, "SKILL_DRAFT_STALE", "skill draft revision is stale", {
        slug: input.slug,
        sourceAgent: input.sourceAgent,
        provided: input.draftRevision
      });
    }
    const sourceAgent = input.sourceAgent;
    const existing = this.skills.get(input.slug);
    const latest = existing?.detail.latest_version ?? maxVersionOf(existing?.versions ?? []);
    if (latest !== null && compareSemver(input.version, latest) <= 0) {
      throw new ServerDomainError(409, "SKILL_VERSION_CONFLICT", "skill version must be greater than the global latest version", {
        latest_version: latest,
        proposed_version: input.version
      });
    }

    let sourceFiles = structuredClone(draft.sourceFiles);
    if (!sourceFiles.some((file) => file.path === "SKILL.md")) {
      const legacyEntry = findEntryFile(sourceFiles, sourceAgent);
      sourceFiles = [{ path: "SKILL.md", content: legacyEntry.content }, ...sourceFiles];
    }
    const fileMap = Object.fromEntries(sourceFiles.map((file) => [file.path, file.content]));
    const sensitive = scanSensitiveFiles(fileMap);
    if (sensitive.hard_blocked) {
      throw new ServerDomainError(422, "SENSITIVE_CONTENT_BLOCKED", "skill contains sensitive content", {
        finding_count: sensitive.findings.length
      });
    }
    if (sensitive.review_required && !this.reviewMatches(
      input.slug,
      sourceAgent,
      sensitive.findings.map((finding) => finding.fingerprint)
    )) {
      throw new ServerDomainError(422, "SENSITIVE_CONTENT_REVIEW_REQUIRED", "skill review is missing or stale", {
        finding_count: sensitive.findings.length,
        scanner_version: sensitive.scanner_version
      });
    }
    const meta = parseFrontmatter(findEntryFile(sourceFiles, sourceAgent).content);
    const createdAt = new Date().toISOString();
    const builtArtifacts: Array<{ version: RegistrySkillVersion; bytes: Uint8Array; hash: string }> = [];
    for (const targetAgent of SKILL_TARGET_AGENTS) {
      const built = buildArtifactFor(sourceFiles, input.slug, input.version, targetAgent);
      if (built === null) {
        throw new ServerDomainError(422, SKILL_ERROR_CODE.VALIDATION_FAILED, `skill variant is not installable: ${targetAgent}`);
      }
      const hash = sha256Bytes(built.bytes);
      const artifact: RegistryArtifact = {
        artifact_id: id("ska_"),
        skill_slug: input.slug,
        version: input.version,
        agent: targetAgent,
        content_sha256: hash,
        size_bytes: built.bytes.byteLength,
        source_proposal_id: null,
        created_at: createdAt
      };
      builtArtifacts.push({
        bytes: built.bytes,
        hash,
        version: {
          skill_slug: input.slug,
          version: input.version,
          agent: targetAgent,
          artifacts: [artifact],
          source_proposal_id: null,
          sourceFiles: structuredClone(sourceFiles),
          examples: structuredClone(draft.examples),
          changeNote: input.releaseNote ?? null,
          created_at: createdAt
        }
      });
    }
    // Blob writes are content-addressed and safe to retry. Complete every local
    // validation and blob write before the irreversible npm side effect.
    for (const built of builtArtifacts) await this.storage.putBlob(built.hash, built.bytes);

    const npmInput = skillNpmPackageInput(config, {
      slug: input.slug,
      version: input.version,
      description: meta.description,
      agent: sourceAgent,
      sourceFiles
    });
    const npmResult = await publishNpm(npmInput);
    if (npmResult.status === "failed") {
      throw new ServerDomainError(502, "NPM_PUBLISH_FAILED", npmResult.error ?? "npm publish failed", {
        slug: input.slug,
        version: input.version
      });
    }
    if (npmResult.status === "conflict") {
      throw new ServerDomainError(409, "NPM_PUBLISH_CONFLICT", npmResult.error ?? "npm package version conflicts with remote content", {
        slug: input.slug,
        version: input.version
      });
    }

    const versions = [...(existing?.versions ?? []), ...builtArtifacts.map((built) => built.version)];
    const defaultAgent = existing?.detail.defaultAgent ?? sourceAgent;
    const detail = registrySkillDetailSchema.parse({
      ...(existing?.detail ?? {
        skill_id: id("skl_"),
        slug: input.slug,
        name: meta.name,
        tags: [],
        created_at: createdAt
      }),
      name: meta.name,
      description: meta.description,
      kind: meta.kind ?? null,
      status: "published",
      latest_version: input.version,
      defaultAgent,
      agents: agentsFor(input.slug, defaultAgent, versions, undefined),
      revision: (existing?.detail.revision ?? 0) + 1,
      updated_at: createdAt
    });
    const npmRecord = npmReleaseRecordSchema.parse({
      version: input.version,
      packageName: npmInput.packageName,
      status: "published",
      publishedAt: createdAt,
      error: null
    });
    const npmReleases = [...(existing?.npmReleases ?? []), npmRecord];
    const nextState: SkillState = {
      detail: registrySkillDetailSchema.parse({ ...detail, npmReleases }),
      versions,
      npmReleases
    };
    const response: PublishSkillResponse = {
      release: { slug: input.slug, version: input.version },
      npmRelease: {
        status: npmResult.status,
        packageName: npmInput.packageName,
        version: input.version,
        tarballHash: npmResult.tarballHash
      }
    };
    const previousDrafts = this.drafts.get(input.slug);
    this.skills.set(input.slug, nextState);
    this.drafts.delete(input.slug);
    this.successfulPublishAttempts.set(attemptKey, structuredClone(response));
    try {
      await this.persist();
    } catch (error) {
      if (existing === undefined) this.skills.delete(input.slug);
      else this.skills.set(input.slug, existing);
      if (previousDrafts !== undefined) this.drafts.set(input.slug, previousDrafts);
      this.successfulPublishAttempts.delete(attemptKey);
      throw error;
    }
    return response;
  }

  diffDraft(slug: string, agent: RegistryAgent): SkillDiffFile[] {
    const draft = this.getDraftState(slug, agent);
    if (draft === undefined) {
      throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "skill draft not found", { slug, agent });
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
      throw new ServerDomainError(404, SKILL_ERROR_CODE.NOT_FOUND, "skill not found", { slug: input.slug });
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
      throw new ServerDomainError(404, SKILL_ERROR_CODE.NOT_FOUND, "skill not found", { slug });
    }
    const agentConfig = state.detail.agents.find((a) => a.agent === agent);
    if (agentConfig === undefined || !agentConfig.enabled) {
      throw new ServerDomainError(422, "AGENT_NOT_ENABLED", "agent is not enabled for this skill", { slug, agent });
    }
    if (state.detail.revision !== revision) {
      throw new ServerDomainError(409, SKILL_ERROR_CODE.REVISION_CONFLICT, "skill revision is stale", {
        slug, expected: state.detail.revision, provided: revision
      });
    }
    const now = new Date().toISOString();
    state.detail = registrySkillDetailSchema.parse({
      ...state.detail,
      defaultAgent: agent,
      // 重算 agents：isDefault 按新默认，fallback 来源切到新默认
      agents: agentsFor(slug, agent, state.versions, this.drafts.get(slug)),
      revision: state.detail.revision + 1,
      updated_at: now
    });
    await this.persist();
    return structuredClone(state.detail);
  }

  // ---- Workflow family 委派 ----
  createWorkflowFamily(input: WorkflowFamilyMutation): WorkflowFamily {
    return this.workflowFamilyStore.createFamily(input);
  }
  listWorkflowFamilies(): WorkflowFamily[] {
    return this.workflowFamilyStore.listFamilies();
  }
  getWorkflowFamily(slug: string): WorkflowFamily {
    return this.workflowFamilyStore.getFamily(slug);
  }
  async uploadWorkflowFamilyProfileDraft(input: {
    slug: string;
    profile: string;
    files: SourceFile[];
    actorId: string;
  }): Promise<WorkflowFamilyDraftState> {
    return this.workflowFamilyStore.uploadProfileDraft(input);
  }
  getWorkflowFamilyDraft(slug: string): WorkflowFamilyDraftState {
    return this.workflowFamilyStore.getFamilyDraft(slug);
  }
  async discardWorkflowFamilyDraft(slug: string, revision: number): Promise<void> {
    return this.workflowFamilyStore.discardFamilyDraft(slug, revision);
  }
  async runWorkflowFamilyChecks(input: { slug: string; checkedAt: string }): Promise<SkillCheckResult> {
    return this.workflowFamilyStore.runFamilyChecks(input);
  }
  diffWorkflowFamilyDraft(slug: string, profile?: string): SkillDiffFile[] {
    return this.workflowFamilyStore.diffFamilyDraft(slug, profile);
  }
  async publishWorkflowFamily(slug: string, input: {
    version: string;
    releaseNote?: string | null;
    actorId: string;
  }): Promise<WorkflowFamilyVersion> {
    return this.workflowFamilyStore.publishFamily(slug, input);
  }
  listWorkflowFamilyVersions(slug: string): WorkflowFamilyVersion[] {
    return this.workflowFamilyStore.listFamilyVersions(slug);
  }
  async getWorkflowFamilyProfileArtifactBytes(slug: string, profile: string, version?: string): Promise<Uint8Array> {
    return this.workflowFamilyStore.getProfileArtifactBytes(slug, profile, version);
  }

  // ---- AI provider 配置（§12.9；key 不进 store，只存 provider 元数据 + 用量）----

  listProviders(): AiProviderConfig[] {
    return structuredClone([...this.aiConfig.providers].sort((a, b) => a.sort_order - b.sort_order));
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
    models?: ProviderModel[];
    api_format?: AiProviderApiFormat;
    note?: string;
    website?: string;
    selected_model_id?: string | null;
    sort_order?: number;
  }): Promise<AiProviderConfig> {
    const now = new Date().toISOString();
    const existing = this.aiConfig.providers.find((item) => item.provider_id === input.provider_id);
    const extra = {
      ...(input.models !== undefined ? { models: input.models } : {}),
      ...(input.api_format !== undefined ? { api_format: input.api_format } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.website !== undefined ? { website: input.website } : {}),
      ...(input.selected_model_id !== undefined ? { selected_model_id: input.selected_model_id } : {}),
      ...(input.sort_order !== undefined ? { sort_order: input.sort_order } : {})
    };
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
        updated_at: now,
        ...extra
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
        updated_at: now,
        ...extra
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
    patch: Partial<Pick<AiProviderConfig, "label" | "base_url" | "model" | "enabled" | "api_key_env" | "daily_request_limit" | "daily_token_limit" | "models" | "api_format" | "note" | "website" | "selected_model_id" | "sort_order">>
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
      throw new ServerDomainError(409, SKILL_ERROR_CODE.REVISION_CONFLICT, "ai provider revision is stale", {
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

  // per-provider per-model per-day 累加；cost 基于 provider.models 成本 × tokens；前置 checkQuota 超限抛 429 QUOTA_EXCEEDED（不累加）。
  // 向后兼容：model/input_tokens/output_tokens/cache_hit_tokens 可选（旧调用传 tokens 总数，model="" cost=0）；
  // 新调用（app.ts）传 per-model 拆分以算精确 cost。tokens 缺省时 = input_tokens + output_tokens。
  async recordUsage(input: {
    provider_id: string;
    model?: string;
    requests: number;
    tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    cache_hit_tokens?: number;
    cache_create_tokens?: number;
  }): Promise<void> {
    const model = input.model ?? "";
    const inputTokens = input.input_tokens ?? 0;
    const outputTokens = input.output_tokens ?? 0;
    const cacheHitTokens = input.cache_hit_tokens ?? 0;
    const cacheCreateTokens = input.cache_create_tokens ?? 0;
    const tokens = input.tokens ?? (inputTokens + outputTokens);
    this.checkQuota({ provider_id: input.provider_id, requests: input.requests, tokens });
    const today = new Date().toISOString().slice(0, 10);
    const provider = this.aiConfig.providers.find((p) => p.provider_id === input.provider_id);
    const modelCfg = model !== "" ? provider?.models.find((m) => m.request_model === model) : undefined;
    if (model !== "" && modelCfg === undefined) {
      console.warn("[registry] recordUsage model not found in provider.models, cost=0:", model);
    }
    const cost = modelCfg
      ? (inputTokens / 1e6) * modelCfg.input_cost
        + (outputTokens / 1e6) * modelCfg.output_cost
        + (cacheHitTokens / 1e6) * modelCfg.cache_hit_cost
        + (cacheCreateTokens / 1e6) * modelCfg.cache_create_cost
      : 0;
    const entry = this.aiConfig.usage.find(
      (u) => u.provider_id === input.provider_id && u.model === model && u.date === today
    );
    if (entry === undefined) {
      this.aiConfig.usage.push({
        provider_id: input.provider_id,
        date: today,
        model,
        requests: input.requests,
        tokens,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_hit_tokens: cacheHitTokens,
        cache_create_tokens: cacheCreateTokens,
        cost
      });
    } else {
      entry.requests += input.requests;
      entry.tokens += tokens;
      entry.input_tokens += inputTokens;
      entry.output_tokens += outputTokens;
      entry.cache_hit_tokens += cacheHitTokens;
      entry.cache_create_tokens += cacheCreateTokens;
      entry.cost += cost;
    }
    await this.persist();
  }

  checkQuota(input: { provider_id: string; requests: number; tokens: number }): void {
    const provider = this.aiConfig.providers.find((p) => p.provider_id === input.provider_id);
    if (provider === undefined) {
      throw new ServerDomainError(404, "PROVIDER_NOT_FOUND", "ai provider not found", { provider_id: input.provider_id });
    }
    const today = new Date().toISOString().slice(0, 10);
    // 配额 per-provider：聚合当日所有 model 条目（per-model usage → provider 维度限额）
    const entries = this.aiConfig.usage.filter((u) => u.provider_id === input.provider_id && u.date === today);
    const usedRequests = entries.reduce((sum, u) => sum + u.requests, 0);
    const usedTokens = entries.reduce((sum, u) => sum + u.tokens, 0);
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

  // 拖拽重排 providers：providerIds 必须覆盖所有现有 providers（不多不少），否则 422 VALIDATION_FAILED；更新 sort_order = index。
  async reorderProviders(providerIds: string[]): Promise<void> {
    const existingIds = this.aiConfig.providers.map((p) => p.provider_id);
    const idSet = new Set(providerIds);
    if (providerIds.length !== existingIds.length || existingIds.some((id) => !idSet.has(id))) {
      throw new ServerDomainError(422, "VALIDATION_FAILED", "provider_ids must cover all providers exactly", {
        provided: providerIds.length, existing: existingIds.length
      });
    }
    const byId = new Map(this.aiConfig.providers.map((p) => [p.provider_id, p]));
    this.aiConfig.providers = providerIds.map((id, idx) => {
      const p = byId.get(id);
      if (p === undefined) throw new ServerDomainError(422, "VALIDATION_FAILED", "unknown provider_id: " + id);
      return { ...p, sort_order: idx };
    });
    await this.persist();
  }

  // enabled 单选互斥：该 provider enabled=true，其他 enabled=false（一次 persist 保证原子；API-04 单选语义）。
  async setEnabledExclusive(providerId: string): Promise<void> {
    const exists = this.aiConfig.providers.some((p) => p.provider_id === providerId);
    if (!exists) {
      throw new ServerDomainError(404, "PROVIDER_NOT_FOUND", "ai provider not found", { provider_id: providerId });
    }
    for (const p of this.aiConfig.providers) {
      p.enabled = p.provider_id === providerId;
    }
    await this.persist();
  }

  // 旧 snapshot（schemaVersion < 4）单 model provider 迁移到 models[]：从 model 生成 models[0] + selected_model_id。
  // 已有 models 的 provider 不重复迁移（D-03）。返回未 parse 对象，由 aiConfigStateSchema 统一校验。
  private migrateProvider(raw: unknown, index: number): unknown {
    if (raw === null || typeof raw !== "object") return raw;
    const p = raw as Record<string, unknown>;
    if (p.models !== undefined) return p;
    const model = typeof p.model === "string" ? p.model : "";
    const providerId = typeof p.provider_id === "string" ? p.provider_id : "unknown";
    const id = providerId + "_m0";
    return {
      ...p,
      models: [{ id, display_model: model, request_model: model, input_cost: 0, output_cost: 0, cache_hit_cost: 0, cache_create_cost: 0 }],
      api_format: "openai",
      note: "",
      website: "",
      selected_model_id: id,
      sort_order: index
    };
  }

  createProposal(_input: { sourceFiles: SourceFile[]; slug: string; version: string; actorId: string; agent: RegistryAgent }): ProposalState {
    void _input;
    throw new ServerDomainError(410, "SKILL_PROPOSAL_REMOVED", "skill proposal track was removed; use draft publish");
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

  async reviewProposal(_input: {
    proposalId: string;
    actorId: string;
    decision: "approve" | "reject";
    comment: string | null;
  }): Promise<ProposalState> {
    void _input;
    throw new ServerDomainError(410, "SKILL_PROPOSAL_REMOVED", "skill proposal track was removed; use draft publish");
  }

  // per-agent publishIr：按指定 agent 产 1 制品 + 写 version（含 agent）+ 前进该 agent latestVersion。
  // 其他 agent 不动；detail.agents 经 agentsFor 重算（fallback 按新 latestVersion 状态）。
  // 改 public 便于未来 proposal 路径事务化（prod-readiness-2）；本次 draft→publish 路由不直接调（用 publish）。
  async publishIr(
    sourceFiles: SourceFile[],
    slug: string,
    version: string,
    proposalId: string | null,
    createdAt: string,
    agent: RegistryAgent
  ): Promise<RegistryArtifact[]> {
    const existing = this.skills.get(slug);
    requireForwardVersion(existing, agent, version);
    let meta: SkillFrontmatter;
    try {
      const entry = findEntryFile(sourceFiles, agent);
      meta = parseFrontmatter(entry.content);
    } catch (error) {
      if (error instanceof SkillEntryError) {
        throw new ServerDomainError(422, SKILL_ERROR_CODE.VALIDATION_FAILED, error.message);
      }
      throw error;
    }
    const built = buildArtifactFor(sourceFiles, slug, version, agent);
    if (built === null) {
      throw new ServerDomainError(422, SKILL_ERROR_CODE.VALIDATION_FAILED, "skill has no enabled installable adapter");
    }
    const hash = sha256Bytes(built.bytes);
    await this.storage.putBlob(hash, built.bytes);
    const artifact: RegistryArtifact = {
      artifact_id: id("ska_"),
      skill_slug: slug,
      version,
      agent,
      content_sha256: hash,
      size_bytes: built.bytes.byteLength,
      source_proposal_id: proposalId ?? "skp_bootstrap",
      created_at: createdAt
    };
    const versionRecord: RegistrySkillVersion = {
      skill_slug: slug,
      version,
      agent,
      artifacts: [artifact],
      source_proposal_id: proposalId,
      sourceFiles,
      examples: [],
      changeNote: null,
      created_at: createdAt
    };
    const defaultAgent = existing === undefined
      ? defaultAgentOf(undefined, [])
      : (existing.detail.defaultAgent ?? defaultAgentOf(existing.detail, existing.versions));
    if (existing === undefined) {
      const versions = [versionRecord];
      const detail = registrySkillDetailSchema.parse({
        skill_id: id("skl_"),
        slug,
        name: meta.name,
        description: meta.description,
        kind: meta.kind ?? null,
        tags: [],
        status: "published",
        latest_version: maxVersionOf(versions),
        defaultAgent,
        agents: agentsFor(slug, defaultAgent, versions, this.drafts.get(slug)),
        revision: 1,
        created_at: createdAt,
        updated_at: createdAt
      });
      this.skills.set(slug, { detail, versions, npmReleases: [] });
    } else {
      existing.versions.push(versionRecord);
      const latestVersion = maxVersionOf(existing.versions);
      existing.detail = registrySkillDetailSchema.parse({
        ...existing.detail,
        description: meta.description,
        kind: meta.kind ?? null,
        status: "published",
        latest_version: latestVersion,
        defaultAgent,
        agents: agentsFor(slug, defaultAgent, existing.versions, this.drafts.get(slug)),
        revision: existing.detail.revision + 1,
        updated_at: createdAt
      });
    }
    this.invalidateTagUsageCache();
    return [artifact];
  }

  adapterPreview(slug: string, agent: RegistryAgent) {
    if (!AGENT_DESCRIPTORS[agent].installable) {
      throw new ServerDomainError(422, "ADAPTER_NOT_IMPLEMENTED", `adapter ${agent} is not yet implemented`);
    }
    const state = this.skills.get(slug);
    if (state === undefined) throw new ServerDomainError(404, SKILL_ERROR_CODE.NOT_FOUND, "skill not found");
    // 新模型：安装 = 上传源文件，无编译预览；返回该 agent 最新 version 的 sourceFiles + installTarget
    const versions = state.versions.filter((v) => v.agent === agent);
    const latest = versions[0];
    if (latest === undefined || latest.sourceFiles.length === 0) {
      throw new ServerDomainError(404, "SKILL_ARTIFACT_NOT_FOUND", "no source files for agent");
    }
    return {
      agent,
      sourceFiles: structuredClone(latest.sourceFiles),
      installTarget: AGENT_DESCRIPTORS[agent].installTarget(slug)
    };
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

  referencedBlobHashes(): Set<string> {
    return new Set([
      ...[...this.skills.values()].flatMap((state) => state.versions.flatMap((version) =>
        version.artifacts.map((artifact) => artifact.content_sha256)
      )),
      ...[...this.workflowFamilies.values()].flatMap((state) => state.versions.flatMap((version) =>
        version.artifacts.map((artifact) => artifact.content_sha256)
      ))
    ]);
  }

  async releaseSkillToNpm(
    slug: string,
    config: NpmPublishConfig,
    publish: (input: SkillNpmPackageInput) => Promise<NpmPublishAttemptResult>
  ): Promise<NpmReleaseRecord> {
    const state = this.skills.get(slug);
    if (state === undefined) {
      throw new ServerDomainError(404, SKILL_ERROR_CODE.NOT_FOUND, "skill not found");
    }
    if (state.detail.status !== "published" || state.detail.latest_version === null) {
      throw new ServerDomainError(422, "NPM_PUBLISH_NOT_PUBLISHED", "skill has no published version to release");
    }
    const version = state.detail.latest_version;
    const existing = state.npmReleases.find((entry) => entry.version === version);
    if (existing !== undefined) {
      if (existing.status === "published") return structuredClone(existing);
      if (existing.status === "conflict") {
        throw new ServerDomainError(
          409,
          "NPM_PUBLISH_CONFLICT",
          existing.error ?? "npm registry already has this package version",
          { release: existing }
        );
      }
    }

    const defaultAgent = state.detail.defaultAgent ?? defaultAgentOf(state.detail, state.versions);
    if (defaultAgent === null) {
      throw new ServerDomainError(422, SKILL_ERROR_CODE.ADAPTER_NOT_INSTALLABLE, "skill has no installable agent");
    }
    const versionRecord = state.versions.find((entry) => entry.version === version && entry.agent === defaultAgent)
      ?? state.versions.find((entry) => entry.version === version);
    if (versionRecord === undefined || versionRecord.sourceFiles.length === 0) {
      throw new ServerDomainError(422, "NPM_PUBLISH_NOT_PUBLISHED", "published version source files not found");
    }

    const packageInput = skillNpmPackageInput(config, {
      slug,
      version,
      description: state.detail.description,
      agent: versionRecord.agent,
      sourceFiles: versionRecord.sourceFiles
    });
    const result = await publish(packageInput);
    const record = npmReleaseRecordSchema.parse({
      version,
      packageName: packageInput.packageName,
      status: result.status === "idempotent" ? "published" : result.status,
      publishedAt: new Date().toISOString(),
      error: result.error
    });
    const index = state.npmReleases.findIndex((entry) => entry.version === version);
    if (index >= 0) state.npmReleases[index] = record;
    else state.npmReleases.push(record);
    await this.persist();
    return structuredClone(record);
  }

  async releaseFamilyToNpm(
    slug: string,
    config: NpmPublishConfig,
    publish: (input: WorkflowFamilyNpmPackageInput) => Promise<NpmPublishAttemptResult>,
    extraFiles: SourceFile[] = []
  ): Promise<NpmReleaseRecord> {
    const family = this.workflowFamilyStore.getFamily(slug);
    if (family.latest_version === null) {
      throw new ServerDomainError(422, "NPM_PUBLISH_NOT_PUBLISHED", "workflow family has no published version to release");
    }
    const version = family.latest_version;
    const state = this.workflowFamilies.get(slug);
    const versionRecord = state?.versions.find((entry) => entry.version === version);
    if (versionRecord === undefined) {
      throw new ServerDomainError(422, "NPM_PUBLISH_NOT_PUBLISHED", "published family version not found");
    }
    const existing = family.npmReleases.find((entry) => entry.version === version);
    if (existing !== undefined) {
      if (existing.status === "published") return structuredClone(existing);
      if (existing.status === "conflict") {
        throw new ServerDomainError(
          409,
          "NPM_PUBLISH_CONFLICT",
          existing.error ?? "npm registry already has this package version",
          { release: existing }
        );
      }
    }
    const packageInput = workflowFamilyNpmPackageInput(config, {
      familySlug: slug,
      version,
      description: family.description,
      requiredProfiles: family.required_profiles,
      files: layoutWorkflowFamilyNpmFiles(versionRecord, extraFiles)
    });
    const result = await publish(packageInput);
    const record = npmReleaseRecordSchema.parse({
      version,
      packageName: packageInput.packageName,
      status: result.status === "idempotent" ? "published" : result.status,
      publishedAt: new Date().toISOString(),
      error: result.error
    });
    const detail = this.workflowFamilies.get(slug)?.detail;
    if (detail !== undefined) {
      const releases = [...detail.npmReleases];
      const index = releases.findIndex((entry) => entry.version === version);
      if (index >= 0) releases[index] = record;
      else releases.push(record);
      this.workflowFamilies.set(slug, {
        detail: workflowFamilySchema.parse({ ...detail, npmReleases: releases }),
        versions: state?.versions ?? []
      });
    }
    await this.persist();
    return structuredClone(record);
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
    if (tag.revision !== input.revision) throw new ServerDomainError(409, SKILL_ERROR_CODE.REVISION_CONFLICT, "tag revision is stale");
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
      throw new ServerDomainError(409, SKILL_ERROR_CODE.REVISION_CONFLICT, "tag revision is stale");
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
    if (state === undefined) throw new ServerDomainError(404, SKILL_ERROR_CODE.NOT_FOUND, "skill not found");
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

  getProjectBinding(projectId: string): RegistryProjectWorkflowBinding | null {
    return structuredClone(this.projectBindings.get(projectId) ?? null);
  }

  bindProjectWorkflowFamily(input: {
    projectId: string;
    familySlug: string;
    profile: string;
    version?: string | null;
    revision: number | null;
  }): RegistryProjectWorkflowBinding {
    const family = this.workflowFamilyStore.getFamily(input.familySlug);
    if (!family.required_profiles.includes(input.profile)) {
      throw new ServerDomainError(422, "WORKFLOW_PROFILE_INVALID", "profile is not required for this family", {
        slug: input.familySlug,
        profile: input.profile
      });
    }
    if (input.version !== undefined && input.version !== null) {
      const versions = this.workflowFamilyStore.listFamilyVersions(input.familySlug);
      if (!versions.some((entry) => entry.version === input.version)) {
        throw new ServerDomainError(404, "WORKFLOW_FAMILY_VERSION_NOT_FOUND", "workflow family version not found", {
          slug: input.familySlug,
          version: input.version
        });
      }
    }
    const current = this.projectBindings.get(input.projectId);
    if (current !== undefined && current.revision !== input.revision) {
      throw new ServerDomainError(409, SKILL_ERROR_CODE.REVISION_CONFLICT, "project workflow binding revision is stale");
    }
    if (current === undefined && input.revision !== null) {
      throw new ServerDomainError(409, SKILL_ERROR_CODE.REVISION_CONFLICT, "project workflow binding does not exist");
    }
    const binding = registryProjectWorkflowBindingSchema.parse({
      project_id: input.projectId,
      family_slug: input.familySlug,
      profile: input.profile,
      version: input.version ?? null,
      revision: (current?.revision ?? 0) + 1,
      updated_at: new Date().toISOString()
    });
    this.projectBindings.set(input.projectId, binding);
    return structuredClone(binding);
  }

  listExternalSkills(query: { search?: string; sourceType?: string } = {}): ExternalSkill[] {
    const search = query.search?.trim().toLowerCase() ?? "";
    return [...this.externalSkills.values()]
      .map((item) => structuredClone(item))
      .filter((item) => query.sourceType === undefined || item.source.type === query.sourceType)
      .filter((item) => search === ""
        || item.snapshot.name.toLowerCase().includes(search)
        || item.snapshot.description.toLowerCase().includes(search)
        || item.source.ref.toLowerCase().includes(search)
        || item.curationNote.toLowerCase().includes(search)
        || item.tags.some((tag) => tag.toLowerCase().includes(search)))
      .sort((left, right) => left.snapshot.name.localeCompare(right.snapshot.name));
  }

  getExternalSkill(id: string): ExternalSkill {
    const item = this.externalSkills.get(id);
    if (item === undefined) {
      throw new ServerDomainError(404, "EXTERNAL_SKILL_NOT_FOUND", "external skill not found", { id });
    }
    return structuredClone(item);
  }

  async createExternalSkill(input: {
    source: ExternalSkillSource;
    curationNote?: string;
    tags?: string[];
  }): Promise<ExternalSkill> {
    let fetched: Awaited<ReturnType<typeof fetchExternalSnapshot>>;
    try {
      fetched = await fetchExternalSnapshot(input.source, this.externalFetcherDeps);
    } catch (error) {
      this.rethrowExternalFetch(error);
    }
    const duplicate = [...this.externalSkills.values()].find(
      (item) => item.source.type === fetched.source.type && item.source.ref === fetched.source.ref
    );
    if (duplicate !== undefined) {
      throw new ServerDomainError(409, "EXTERNAL_SKILL_EXISTS", "external skill already registered", {
        id: duplicate.id,
        source: duplicate.source
      });
    }
    const now = fetched.snapshot.fetchedAt;
    const skill = externalSkillSchema.parse({
      id: id("ext_"),
      source: fetched.source,
      snapshot: fetched.snapshot,
      curationNote: input.curationNote ?? "",
      tags: [...(input.tags ?? [])].sort(),
      updateAvailable: false,
      lastCheckedAt: now,
      revision: 1,
      created_at: now,
      updated_at: now
    });
    this.externalSkills.set(skill.id, skill);
    await this.persist();
    return structuredClone(skill);
  }

  async patchExternalSkill(input: {
    id: string;
    revision: number;
    curationNote?: string;
    tags?: string[];
    acknowledgeUpdate?: boolean;
  }): Promise<ExternalSkill> {
    const existing = this.externalSkills.get(input.id);
    if (existing === undefined) {
      throw new ServerDomainError(404, "EXTERNAL_SKILL_NOT_FOUND", "external skill not found", { id: input.id });
    }
    if (existing.revision !== input.revision) {
      throw new ServerDomainError(409, "REVISION_CONFLICT", "external skill revision is stale", {
        id: input.id,
        expected: existing.revision,
        provided: input.revision
      });
    }
    const now = new Date().toISOString();
    const next = externalSkillSchema.parse({
      ...existing,
      curationNote: input.curationNote ?? existing.curationNote,
      tags: input.tags !== undefined ? [...input.tags].sort() : existing.tags,
      updateAvailable: input.acknowledgeUpdate === true ? false : existing.updateAvailable,
      revision: existing.revision + 1,
      updated_at: now
    });
    this.externalSkills.set(next.id, next);
    await this.persist();
    return structuredClone(next);
  }

  async deleteExternalSkill(id: string): Promise<{ id: string; deleted: boolean }> {
    if (!this.externalSkills.has(id)) {
      throw new ServerDomainError(404, "EXTERNAL_SKILL_NOT_FOUND", "external skill not found", { id });
    }
    this.externalSkills.delete(id);
    await this.persist();
    return { id, deleted: true };
  }

  async refreshExternalSkill(id: string): Promise<ExternalSkill> {
    const existing = this.externalSkills.get(id);
    if (existing === undefined) {
      throw new ServerDomainError(404, "EXTERNAL_SKILL_NOT_FOUND", "external skill not found", { id });
    }
    const previousNote = existing.curationNote;
    let fetched: Awaited<ReturnType<typeof fetchExternalSnapshot>>;
    try {
      fetched = await fetchExternalSnapshot(existing.source, this.externalFetcherDeps);
    } catch (error) {
      this.rethrowExternalFetch(error);
    }
    const versionChanged = fetched.snapshot.version !== existing.snapshot.version;
    const now = fetched.snapshot.fetchedAt;
    const next = externalSkillSchema.parse({
      ...existing,
      snapshot: fetched.snapshot,
      curationNote: previousNote,
      updateAvailable: versionChanged ? true : existing.updateAvailable,
      lastCheckedAt: now,
      revision: existing.revision + 1,
      updated_at: now
    });
    this.externalSkills.set(next.id, next);
    await this.persist();
    return structuredClone(next);
  }

  async refreshAllExternalSkills(): Promise<{ refreshed: number; failed: number }> {
    let refreshed = 0;
    let failed = 0;
    for (const id of [...this.externalSkills.keys()]) {
      try {
        await this.refreshExternalSkill(id);
        refreshed += 1;
      } catch {
        failed += 1;
      }
    }
    return { refreshed, failed };
  }

  private rethrowExternalFetch(error: unknown): never {
    if (error instanceof ExternalFetchError) {
      throw new ServerDomainError(error.statusCode, error.code, error.message);
    }
    throw error;
  }
}
