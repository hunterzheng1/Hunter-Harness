import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import AdmZip from "adm-zip";

import {
  workflowBundleManifestSchema,
  workflowFamilyBundleArtifactSchema,
  workflowFamilyDraftStateSchema,
  workflowFamilySchema,
  workflowFamilyVersionSchema,
  SKILL_ERROR_CODE,
  type SkillCheckItem,
  type SkillCheckResult,
  type SkillDiffFile,
  type SourceFile,
  type WorkflowBundleManifest,
  type WorkflowFamily,
  type WorkflowFamilyDraftState,
  type WorkflowFamilyMutation,
  type WorkflowFamilyVersion
} from "@hunter-harness/contracts";
import { bumpPatch, compareSemver, computeDiff, scanSensitiveFiles, sha256Bytes } from "@hunter-harness/core";

import { ServerDomainError } from "../repositories/interfaces.js";
import type { ArtifactStorage } from "../storage/interface.js";

const DANGEROUS_PATH = /(^|[/\\])\.\.([/\\]|$)|^\/|^\\|^[a-zA-Z]:/i;

export interface WorkflowFamilyState {
  detail: WorkflowFamily;
  versions: WorkflowFamilyVersion[];
}

export interface WorkflowFamilyStoreDeps {
  storage: ArtifactStorage;
  families: Map<string, WorkflowFamilyState>;
  drafts: Map<string, WorkflowFamilyDraftState>;
  persist: () => Promise<void>;
  compilerVersion: () => string;
}

function buildBundleManifest(profile: string, sourceFiles: SourceFile[]): WorkflowBundleManifest {
  const files = [...sourceFiles]
    .filter((file) => file.path !== "bundle-manifest.json")
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => ({
      path: file.path,
      sha256: sha256Bytes(Buffer.from(file.content, "utf8"))
    }));
  return workflowBundleManifestSchema.parse({
    schema_version: 1,
    profile,
    files
  });
}

function verifyBundleManifest(manifest: WorkflowBundleManifest, sourceFiles: SourceFile[]): void {
  const fileMap = new Map(sourceFiles.map((file) => [file.path, file.content]));
  for (const entry of manifest.files) {
    const content = fileMap.get(entry.path);
    if (content === undefined) {
      throw new ServerDomainError(422, "WORKFLOW_BUNDLE_INCOMPLETE", "bundle manifest references a missing file", {
        path: entry.path
      });
    }
    const hash = sha256Bytes(Buffer.from(content, "utf8"));
    if (hash !== entry.sha256) {
      throw new ServerDomainError(422, "WORKFLOW_BUNDLE_HASH_MISMATCH", "bundle file hash mismatch", {
        path: entry.path
      });
    }
  }
}

export class WorkflowFamilyStore {
  constructor(private readonly deps: WorkflowFamilyStoreDeps) {}

  createFamily(input: WorkflowFamilyMutation): WorkflowFamily {
    if (this.deps.families.has(input.slug)) {
      throw new ServerDomainError(409, "WORKFLOW_FAMILY_EXISTS", "workflow family already exists", { slug: input.slug });
    }
    const now = new Date().toISOString();
    const detail = workflowFamilySchema.parse({
      family_id: this.id("wff_"),
      slug: input.slug,
      displayName: input.displayName,
      description: input.description,
      tags: input.tags ?? [],
      latest_version: null,
      required_profiles: input.required_profiles,
      revision: 1,
      npmReleases: [],
      created_at: now,
      updated_at: now
    });
    this.deps.families.set(input.slug, { detail, versions: [] });
    return structuredClone(detail);
  }

  listFamilies(): WorkflowFamily[] {
    return [...this.deps.families.values()].map((state) => structuredClone(state.detail));
  }

  getFamily(slug: string): WorkflowFamily {
    const state = this.deps.families.get(slug);
    if (state === undefined) {
      throw new ServerDomainError(404, "WORKFLOW_FAMILY_NOT_FOUND", "workflow family not found", { slug });
    }
    return structuredClone(state.detail);
  }

  ensureFamily(slug: string): WorkflowFamilyState {
    const state = this.deps.families.get(slug);
    if (state === undefined) {
      throw new ServerDomainError(404, "WORKFLOW_FAMILY_NOT_FOUND", "workflow family not found", { slug });
    }
    return state;
  }

  async uploadProfileDraft(input: {
    slug: string;
    profile: string;
    files: SourceFile[];
    actorId: string;
  }): Promise<WorkflowFamilyDraftState> {
    const family = this.ensureFamily(input.slug);
    if (!family.detail.required_profiles.includes(input.profile)) {
      throw new ServerDomainError(422, "WORKFLOW_PROFILE_INVALID", "profile is not required for this family", {
        slug: input.slug,
        profile: input.profile
      });
    }
    const unsafe = input.files.find((file) => DANGEROUS_PATH.test(file.path));
    if (unsafe !== undefined) {
      throw new ServerDomainError(422, SKILL_ERROR_CODE.VALIDATION_FAILED, "unsafe file path: " + unsafe.path);
    }
    if (input.files.length === 0) {
      throw new ServerDomainError(422, "WORKFLOW_BUNDLE_EMPTY", "profile bundle must contain at least one file");
    }
    const fileMap: Record<string, string> = {};
    for (const file of input.files) fileMap[file.path] = file.content;
    const findings = scanSensitiveFiles(fileMap);
    if (findings.blocked) {
      throw new ServerDomainError(422, "SENSITIVE_CONTENT_BLOCKED", "workflow bundle contains sensitive content", {
        finding_count: findings.findings.length
      });
    }
    const bundleManifest = buildBundleManifest(input.profile, input.files);
    const latest = family.detail.latest_version;
    const existingDraft = this.deps.drafts.get(input.slug);
    const draftVersion = latest === null ? "0.1.0" : bumpPatch(latest);
    const now = new Date().toISOString();
    const otherProfiles = (existingDraft?.profiles ?? []).filter((entry) => entry.profile !== input.profile);
    const draft = workflowFamilyDraftStateSchema.parse({
      family_slug: input.slug,
      profiles: [...otherProfiles, { profile: input.profile, sourceFiles: input.files, bundle_manifest: bundleManifest }],
      required_profiles: family.detail.required_profiles,
      draftVersion,
      checks: null,
      releaseNote: existingDraft?.releaseNote ?? null,
      revision: existingDraft === undefined ? 1 : existingDraft.revision + 1,
      created_at: existingDraft?.created_at ?? now,
      updated_at: now
    });
    this.deps.drafts.set(input.slug, draft);
    await this.deps.persist();
    return structuredClone(draft);
  }

  getFamilyDraft(slug: string): WorkflowFamilyDraftState {
    const draft = this.deps.drafts.get(slug);
    if (draft === undefined) {
      throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "workflow family draft not found", { slug });
    }
    return structuredClone(draft);
  }

  async discardFamilyDraft(slug: string, revision: number): Promise<void> {
    const draft = this.deps.drafts.get(slug);
    if (draft === undefined) {
      throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "workflow family draft not found", { slug });
    }
    if (draft.revision !== revision) {
      throw new ServerDomainError(409, SKILL_ERROR_CODE.REVISION_CONFLICT, "draft revision is stale", {
        slug, expected: draft.revision, provided: revision
      });
    }
    this.deps.drafts.delete(slug);
    await this.deps.persist();
  }

  async runFamilyChecks(input: { slug: string; checkedAt: string }): Promise<SkillCheckResult> {
    const draft = this.deps.drafts.get(input.slug);
    if (draft === undefined) {
      throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "workflow family draft not found", { slug: input.slug });
    }
    const items: SkillCheckItem[] = [];
    for (const profile of draft.required_profiles) {
      const entry = draft.profiles.find((value) => value.profile === profile);
      if (entry === undefined) {
        items.push({
          id: "PROFILE_MISSING_" + profile,
          label: "Profile " + profile,
          status: "red",
          message: "required profile bundle is missing",
          filePath: null,
          fixable: false
        });
        continue;
      }
      try {
        verifyBundleManifest(entry.bundle_manifest, entry.sourceFiles);
        items.push({
          id: "PROFILE_OK_" + profile,
          label: "Profile " + profile,
          status: "green",
          message: "bundle manifest verified (" + entry.bundle_manifest.files.length + " files)",
          filePath: null,
          fixable: false
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "bundle verification failed";
        items.push({
          id: "PROFILE_BAD_" + profile,
          label: "Profile " + profile,
          status: "red",
          message,
          filePath: null,
          fixable: false
        });
      }
    }
    const summary = {
      green: items.filter((item) => item.status === "green").length,
      yellow: items.filter((item) => item.status === "yellow").length,
      red: items.filter((item) => item.status === "red").length
    };
    const result: SkillCheckResult = { items, summary, checkedAt: input.checkedAt };
    const updated: WorkflowFamilyDraftState = { ...draft, checks: result, updated_at: input.checkedAt };
    this.deps.drafts.set(input.slug, updated);
    await this.deps.persist();
    return structuredClone(result);
  }

  diffFamilyDraft(slug: string, profile?: string): SkillDiffFile[] {
    const draft = this.deps.drafts.get(slug);
    if (draft === undefined) {
      throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "workflow family draft not found", { slug });
    }
    const family = this.ensureFamily(slug);
    const latest = family.detail.latest_version;
    const targetProfile = profile ?? draft.profiles[0]?.profile;
    if (targetProfile === undefined) {
      return [];
    }
    const draftFiles = draft.profiles.find((entry) => entry.profile === targetProfile)?.sourceFiles ?? [];
    const published = family.versions.find((version) => version.version === latest);
    const publishedFiles = published?.profiles.find((entry) => entry.profile === targetProfile)?.sourceFiles ?? [];
    return computeDiff(publishedFiles, draftFiles);
  }

  async publishFamily(slug: string, input: {
    version: string;
    releaseNote?: string | null;
    actorId: string;
  }): Promise<WorkflowFamilyVersion> {
    const draft = this.deps.drafts.get(slug);
    if (draft === undefined) {
      throw new ServerDomainError(404, SKILL_ERROR_CODE.DRAFT_NOT_FOUND, "workflow family draft not found", { slug });
    }
    const familyState = this.ensureFamily(slug);
    const latest = familyState.detail.latest_version;
    if (latest !== null && compareSemver(input.version, latest) <= 0) {
      throw new ServerDomainError(409, "SKILL_VERSION_NOT_FORWARD", "workflow family version must be greater than the latest published version", {
        latest_version: latest,
        proposed_version: input.version
      });
    }
    for (const profile of draft.required_profiles) {
      if (!draft.profiles.some((entry) => entry.profile === profile)) {
        throw new ServerDomainError(422, "WORKFLOW_PROFILE_INCOMPLETE", "required profile bundle is missing before publish", {
          slug,
          profile
        });
      }
    }
    for (const entry of draft.profiles) {
      verifyBundleManifest(entry.bundle_manifest, entry.sourceFiles);
    }
    const createdAt = new Date().toISOString();
    const artifacts = [];
    const versionProfiles = [];
    for (const entry of draft.profiles) {
      const bytes = this.buildProfileArtifact(slug, entry.profile, input.version, entry.sourceFiles, entry.bundle_manifest);
      const hash = sha256Bytes(bytes);
      await this.deps.storage.putBlob(hash, bytes);
      const artifact = workflowFamilyBundleArtifactSchema.parse({
        artifact_id: this.id("wfb_"),
        family_slug: slug,
        profile: entry.profile,
        version: input.version,
        content_sha256: hash,
        size_bytes: bytes.byteLength,
        bundle_manifest: entry.bundle_manifest,
        created_at: createdAt
      });
      artifacts.push(artifact);
      versionProfiles.push({
        profile: entry.profile,
        bundle_manifest: entry.bundle_manifest,
        artifact_id: artifact.artifact_id,
        sourceFiles: entry.sourceFiles
      });
    }
    const version = workflowFamilyVersionSchema.parse({
      family_slug: slug,
      version: input.version,
      profiles: versionProfiles,
      artifacts,
      changeNote: input.releaseNote ?? null,
      created_at: createdAt
    });
    familyState.versions.push(version);
    familyState.detail = workflowFamilySchema.parse({
      ...familyState.detail,
      latest_version: input.version,
      revision: familyState.detail.revision + 1,
      updated_at: createdAt
    });
    this.deps.drafts.delete(slug);
    await this.deps.persist();
    return structuredClone(version);
  }

  listFamilyVersions(slug: string): WorkflowFamilyVersion[] {
    const state = this.ensureFamily(slug);
    return structuredClone(state.versions).sort((a, b) => compareSemver(b.version, a.version));
  }

  async getProfileArtifactBytes(slug: string, profile: string, version?: string): Promise<Uint8Array> {
    const artifact = this.latestProfileArtifact(slug, profile, version);
    const bytes = await this.deps.storage.getBlob(artifact.content_sha256);
    if (bytes === null) {
      throw new ServerDomainError(404, "WORKFLOW_FAMILY_ARTIFACT_NOT_FOUND", "published profile artifact blob not found", {
        slug,
        profile,
        version: version ?? this.ensureFamily(slug).detail.latest_version
      });
    }
    return bytes;
  }

  latestProfileArtifact(slug: string, profile: string, version?: string) {
    const state = this.ensureFamily(slug);
    const targetVersion = version ?? state.detail.latest_version;
    if (targetVersion === null) {
      throw new ServerDomainError(404, "WORKFLOW_FAMILY_ARTIFACT_NOT_FOUND", "published family version not found", { slug });
    }
    const record = state.versions.find((entry) => entry.version === targetVersion);
    const artifact = record?.artifacts.find((entry) => entry.profile === profile);
    if (artifact === undefined) {
      throw new ServerDomainError(404, "WORKFLOW_FAMILY_ARTIFACT_NOT_FOUND", "published profile artifact not found", {
        slug,
        profile,
        version: targetVersion
      });
    }
    return artifact;
  }

  private buildProfileArtifact(
    slug: string,
    profile: string,
    version: string,
    sourceFiles: SourceFile[],
    bundleManifest: WorkflowBundleManifest
  ): Uint8Array {
    const zip = new AdmZip();
    for (const file of sourceFiles) {
      zip.addFile(file.path, Buffer.from(file.content, "utf8"));
    }
    zip.addFile("bundle-manifest.json", Buffer.from(JSON.stringify(bundleManifest, null, 2) + "\n", "utf8"));
    zip.addFile("hunter-workflow-family.json", Buffer.from(JSON.stringify({
      schema_version: 1,
      family_slug: slug,
      profile,
      version,
      compiler_version: this.deps.compilerVersion()
    }, null, 2) + "\n", "utf8"));
    return zip.toBuffer();
  }

  private id(prefix: string): string {
    return prefix + randomUUID().replaceAll("-", "");
  }
}
