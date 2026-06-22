import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import {
  canonicalJson,
  registrySkillDetailSchema,
  registrySkillProposalSchema,
  registryProjectWorkflowBindingSchema,
  registryTagSchema,
  registryWorkflowMutationSchema,
  registryWorkflowSchema,
  skillIrSchema,
  type RegistryAgent,
  type RegistryArtifact,
  type RegistryProjectWorkflowBinding,
  type RegistrySkillDetail,
  type RegistrySkillProposal,
  type RegistrySkillVersion,
  type RegistryTag,
  type RegistryWorkflow,
  type RegistryWorkflowMutation,
  type SkillIr
} from "@hunter-harness/contracts";
import {
  compileSkill,
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

function adapters(ir: SkillIr): RegistryAgent[] {
  return Object.entries(ir.adapters)
    .filter(([, value]) => value.enabled)
    .map(([key]) => key)
    .filter((key): key is RegistryAgent =>
      key === "claude-code" || key === "codex" || key === "generic" || key === "mcp"
    );
}

function category(ir: SkillIr): RegistrySkillDetail["category"] {
  return ir.kind;
}

function compareSemver(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
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

export class RegistryStore {
  private readonly skills = new Map<string, SkillState>();
  private readonly proposals = new Map<string, ProposalState>();
  private readonly tags = new Map<string, RegistryTag>();
  private readonly workflows = new Map<string, RegistryWorkflow>();
  private readonly projectBindings = new Map<string, RegistryProjectWorkflowBinding>();
  private compilerVersion = "1.0.0";

  constructor(
    private readonly storage: ArtifactStorage,
    private readonly persistence?: RegistryPersistence
  ) {}

  async initialize(bundle?: BootstrapBundle): Promise<void> {
    const snapshot = await this.persistence?.load();
    if (snapshot !== null && snapshot !== undefined) {
      const value = snapshot as {
        compilerVersion: string;
        skills: Array<[string, SkillState]>;
        proposals: Array<[string, ProposalState]>;
        tags: Array<[string, RegistryTag]>;
        workflows: Array<[string, RegistryWorkflow]>;
        projectBindings?: Array<[string, RegistryProjectWorkflowBinding]>;
      };
      this.compilerVersion = value.compilerVersion;
      for (const [key, state] of value.skills) this.skills.set(key, state);
      for (const [key, state] of value.proposals) this.proposals.set(key, state);
      for (const [key, state] of value.tags) this.tags.set(key, state);
      for (const [key, state] of value.workflows) this.workflows.set(key, state);
      for (const [key, state] of value.projectBindings ?? []) this.projectBindings.set(key, state);
      return;
    }
    if (bundle === undefined) return;
    this.compilerVersion = bundle.compilerVersion;
    for (const ir of bundle.skills) {
      if (this.skills.has(ir.name)) continue;
      await this.publish(ir, null, new Date().toISOString());
    }
    await this.persist();
  }

  async persist(): Promise<void> {
    await this.persistence?.save({
      schemaVersion: 1,
      compilerVersion: this.compilerVersion,
      skills: [...this.skills.entries()],
      proposals: [...this.proposals.entries()],
      tags: [...this.tags.entries()],
      workflows: [...this.workflows.entries()],
      projectBindings: [...this.projectBindings.entries()]
    });
  }

  listSkills(query: {
    search?: string | undefined;
    category?: string | undefined;
    tag?: string | undefined;
    agent?: string | undefined;
    status?: string | undefined;
  } = {}): RegistrySkillDetail[] {
    const search = query.search?.trim().toLowerCase() ?? "";
    return [...this.skills.values()].map((state) => structuredClone(state.detail))
      .filter((skill) => search === "" ||
        skill.slug.includes(search) || skill.name.toLowerCase().includes(search) ||
        skill.description.toLowerCase().includes(search))
      .filter((skill) => query.category === undefined || skill.category === query.category)
      .filter((skill) => query.tag === undefined || skill.tags.includes(query.tag))
      .filter((skill) => query.agent === undefined || skill.adapters.includes(query.agent as RegistryAgent))
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
      ? await this.publish(proposal.proposed_ir, proposal.proposal_id, reviewedAt)
      : [];
    proposal.status = input.decision === "approve" ? "approved" : "rejected";
    proposal.reviewed_at = reviewedAt;
    proposal.reviewedBy = input.actorId;
    proposal.reviewComment = input.comment;
    proposal.publishedArtifacts = artifacts;
    return structuredClone(proposal);
  }

  private async publish(
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
      created_at: createdAt
    };
    if (existing === undefined) {
      const detail = registrySkillDetailSchema.parse({
        skill_id: id("skl_"),
        slug: ir.name,
        name: ir.name,
        description: ir.description,
        category: category(ir),
        tags: [],
        status: "published",
        latest_version: ir.version,
        adapters: adapters(ir),
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
        category: category(ir),
        status: "published",
        latest_version: ir.version,
        adapters: adapters(ir),
        revision: existing.detail.revision + 1,
        updated_at: createdAt,
        ir
      });
    }
    return [artifact];
  }

  adapterPreview(slug: string, agent: RegistryAgent) {
    if (agent !== "claude-code") {
      throw new ServerDomainError(422, "ADAPTER_NOT_INSTALLABLE", "this adapter is contract-only in MVP");
    }
    const ir = this.getSkill(slug).ir;
    if (ir === null) throw new ServerDomainError(404, "SKILL_NOT_FOUND", "published Skill IR is unavailable");
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
      revision: 1, created_at: now, updated_at: now
    });
    this.tags.set(tag.tag_id, tag);
    return structuredClone(tag);
  }

  listTags(): RegistryTag[] {
    return [...this.tags.values()].map((tag) => structuredClone(tag));
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
      if (!skill.adapters.includes(workflow.default_agent)) {
        throw new ServerDomainError(422, "WORKFLOW_ADAPTER_INCOMPATIBLE", "skill does not support workflow agent", { slug });
      }
      if (skill.ir?.profiles[workflow.profile]?.enabled !== true) {
        throw new ServerDomainError(422, "WORKFLOW_PROFILE_INCOMPATIBLE", "skill does not support workflow profile", { slug });
      }
    }
  }
}
