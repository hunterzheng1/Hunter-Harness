import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
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
  type AgentSkillConfig,
  type DraftState,
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
  type SourceFile
} from "@hunter-harness/contracts";
import {
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

function bumpPatch(version: string): string {
  const parts = version.split(".").map(Number);
  return (parts[0] ?? 0) + "." + (parts[1] ?? 0) + "." + ((parts[2] ?? 0) + 1);
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

function zipArtifact(ir: SkillIr, compilerVersion: string): Uint8Array {
  const profile = Object.entries(ir.profiles).find(([, value]) => value.enabled)?.[0];
  if (profile === undefined) {
    throw new ServerDomainError(422, "SKILL_VALIDATION_FAILED", "skill has no enabled profile");
  }
  const output = compileSkill(ir, {
    adapter: "claude-code",
    profile,
    compilerVersion
  });
  const zip = new AdmZip();
  zip.addFile("SKILL.md", Buffer.from(output.content, "utf8"));
  zip.addFile("hunter-skill.json", Buffer.from(JSON.stringify({
    schema_version: 1,
    slug: ir.name,
    version: ir.version,
    agent: "claude-code",
    source_ir_sha256: output.sourceIrHash,
    target_path: output.path
  }, null, 2) + "\n", "utf8"));
  return zip.toBuffer();
}

const DANGEROUS_PATH = /(^|[/\\])\.\.([/\\]|$)|^\/|^\\|^[a-zA-Z]:/;

export class RegistryStore {
  private readonly skills = new Map<string, SkillState>();
  private readonly proposals = new Map<string, ProposalState>();
  private readonly tags = new Map<string, RegistryTag>();
  private readonly workflows = new Map<string, RegistryWorkflow>();
  private readonly projectBindings = new Map<string, RegistryProjectWorkflowBinding>();
  private readonly drafts = new Map<string, DraftState>();
  private compilerVersion = "1.0.0";
  private tagUsageCache: Map<string, number> | null = null;

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
      drafts: [...this.drafts.entries()]
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
    const bytes = zipArtifact(ir, this.compilerVersion);
    const hash = sha256Bytes(bytes);
    await this.storage.putBlob(hash, bytes);
    const createdAt = new Date().toISOString();
    const artifact = {
      artifact_id: id("ska_"),
      skill_slug: input.slug,
      version: input.version,
      agent: "claude-code" as const,
      content_sha256: hash,
      size_bytes: bytes.byteLength,
      source_proposal_id: null,
      created_at: createdAt
    } satisfies RegistryArtifact;
    const version: RegistrySkillVersion = {
      skill_slug: input.slug,
      version: input.version,
      ir,
      artifacts: [artifact],
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
      zipArtifact(ir, this.compilerVersion);
      validation.claude_compilable = true;
    } catch (error) {
      throw new ServerDomainError(422, "SKILL_VALIDATION_FAILED", "Claude Code adapter validation failed", {
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
    const bytes = zipArtifact(ir, this.compilerVersion);
    const hash = sha256Bytes(bytes);
    await this.storage.putBlob(hash, bytes);
    const artifact = {
      artifact_id: id("ska_"),
      skill_slug: ir.name,
      version: ir.version,
      agent: "claude-code" as const,
      content_sha256: hash,
      size_bytes: bytes.byteLength,
      source_proposal_id: proposalId ?? "skp_bootstrap",
      created_at: createdAt
    } satisfies RegistryArtifact;
    const version: RegistrySkillVersion = {
      skill_slug: ir.name,
      version: ir.version,
      ir,
      artifacts: [artifact],
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
    return [artifact];
  }

  adapterPreview(slug: string, agent: RegistryAgent) {
    if (agent !== "claude-code") {
      throw new ServerDomainError(422, "ADAPTER_NOT_INSTALLABLE", "this adapter is contract-only in MVP");
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
