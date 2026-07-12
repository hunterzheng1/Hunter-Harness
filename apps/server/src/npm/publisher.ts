import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { promisify } from "node:util";

import {
  canonicalJson,
  type NpmReleaseStatus,
  type RegistryAgent,
  type SourceFile,
  type WorkflowFamilyVersion
} from "@hunter-harness/contracts";
import { AGENT_DESCRIPTORS, sha256Bytes } from "@hunter-harness/core";

import type { NpmPublishConfig } from "./config.js";
import { packageNameForSkill, packageNameForWorkflowFamily } from "./config.js";

const execFileAsync = promisify(execFile);
const MANIFEST_SCHEMA_VERSION = 2;

export interface SkillNpmPackageInput {
  packageName: string;
  version: string;
  slug: string;
  agent: RegistryAgent;
  description: string;
  sourceFiles: SourceFile[];
}

export interface SkillNpmPackageBuild {
  packageJson: Record<string, unknown>;
  hunterSkillManifest: Record<string, unknown>;
  tarball: Buffer;
}

export interface NpmPublishAttemptResult {
  status: NpmReleaseStatus;
  error: string | null;
}

export interface NpmPublisherDeps {
  packDirectory?: (directory: string) => Promise<Buffer>;
  publish?: (
    manifest: Record<string, unknown>,
    tarball: Buffer,
    options: { token: string }
  ) => Promise<unknown>;
}

function buildHunterSkillManifest(
  slug: string,
  version: string,
  agent: RegistryAgent,
  sourceFiles: SourceFile[]
): Record<string, unknown> {
  const descriptor = AGENT_DESCRIPTORS[agent];
  const sourceSha256 = sha256Bytes(canonicalJson(
    [...sourceFiles].sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => ({ path: f.path, content: f.content }))
  ));
  const manifest: Record<string, unknown> = {
    schema_version: MANIFEST_SCHEMA_VERSION,
    slug,
    version,
    agent,
    source_sha256: sourceSha256,
    target_path: descriptor.installTarget(slug),
    install_mode: descriptor.installMode
  };
  if (descriptor.blockId !== undefined) {
    manifest.block_id = descriptor.blockId(slug);
  }
  return manifest;
}

export function buildSkillNpmPackageJson(input: SkillNpmPackageInput): Record<string, unknown> {
  const files = [
    "hunter-skill.json",
    ...input.sourceFiles.map((f) => f.path).sort((a, b) => a.localeCompare(b))
  ];
  return {
    name: input.packageName,
    version: input.version,
    description: input.description,
    license: "UNLICENSED",
    files
  };
}

async function writePackageDirectory(
  directory: string,
  input: SkillNpmPackageInput,
  packageJson: Record<string, unknown>,
  hunterSkillManifest: Record<string, unknown>
): Promise<void> {
  await writeFile(join(directory, "package.json"), JSON.stringify(packageJson, null, 2) + "\n", "utf8");
  await writeFile(
    join(directory, "hunter-skill.json"),
    JSON.stringify(hunterSkillManifest, null, 2) + "\n",
    "utf8"
  );
  for (const file of input.sourceFiles) {
    const target = join(directory, file.path);
    await writeFile(target, file.content, "utf8");
  }
}

async function defaultPackDirectory(directory: string): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--json", "--pack-destination", directory],
    { cwd: directory }
  );
  const parsed = JSON.parse(stdout) as Array<{ filename: string }>;
  const filename = parsed[0]?.filename;
  if (filename === undefined) {
    throw new Error("npm pack did not return a tarball filename");
  }
  return readFile(join(directory, filename));
}

export async function buildSkillNpmTarball(
  input: SkillNpmPackageInput,
  deps: NpmPublisherDeps = {}
): Promise<SkillNpmPackageBuild> {
  const packageJson = buildSkillNpmPackageJson(input);
  const hunterSkillManifest = buildHunterSkillManifest(
    input.slug,
    input.version,
    input.agent,
    input.sourceFiles
  );
  const directory = await mkdtemp(join(tmpdir(), "hunter-skill-npm-"));
  try {
    await writePackageDirectory(directory, input, packageJson, hunterSkillManifest);
    const packDirectory = deps.packDirectory ?? defaultPackDirectory;
    const tarball = await packDirectory(directory);
    return { packageJson, hunterSkillManifest, tarball };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function isNpmConflictError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { statusCode?: number; code?: string; message?: string };
  return value.statusCode === 409
    || value.code === "E409"
    || (typeof value.message === "string" && value.message.toLowerCase().includes("cannot publish over"));
}

async function defaultPublish(
  manifest: Record<string, unknown>,
  tarball: Buffer,
  options: { token: string }
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "hunter-skill-npm-publish-"));
  const packageName = String(manifest.name ?? "package");
  const version = String(manifest.version ?? "0.0.0");
  const tarballPath = join(directory, `${packageName.replace("@", "").replace("/", "-")}-${version}.tgz`);
  try {
    await writeFile(tarballPath, tarball);
    await execFileAsync("npm", ["publish", tarballPath], {
      env: {
        ...process.env,
        NPM_TOKEN: options.token,
        NPM_CONFIG_TOKEN: options.token
      }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function publishSkillNpmPackage(
  input: SkillNpmPackageInput,
  config: NpmPublishConfig,
  deps: NpmPublisherDeps = {}
): Promise<NpmPublishAttemptResult> {
  const publishFn = deps.publish ?? defaultPublish;
  const built = await buildSkillNpmTarball(input, deps);
  const token = config.token;
  if (token === null || token === "") {
    return { status: "failed", error: "npm token is not configured" };
  }
  try {
    await publishFn(built.packageJson, built.tarball, { token });
    return { status: "published", error: null };
  } catch (error) {
    if (isNpmConflictError(error)) {
      return {
        status: "conflict",
        error: "npm registry already has this package version; publish a newer registry version first"
      };
    }
    const message = error instanceof Error ? error.message : "npm publish failed";
    return { status: "failed", error: message };
  }
}

export interface WorkflowFamilyNpmPackageInput {
  packageName: string;
  version: string;
  familySlug: string;
  description: string;
  requiredProfiles: string[];
  files: SourceFile[];
}

export interface WorkflowFamilyNpmPackageBuild {
  packageJson: Record<string, unknown>;
  hunterWorkflowManifest: Record<string, unknown>;
  tarball: Buffer;
}

export function layoutWorkflowFamilyNpmFiles(
  version: WorkflowFamilyVersion,
  extraFiles: SourceFile[] = []
): SourceFile[] {
  const files: SourceFile[] = [];
  const seen = new Set<string>();
  const add = (path: string, content: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    files.push({ path, content });
  };
  for (const profile of version.profiles) {
    for (const file of profile.sourceFiles) {
      let path = file.path;
      if (path.startsWith(`${profile.profile}/`)) {
        path = `harness/bundles/${path}`;
      } else if (path.startsWith("manifests/")) {
        path = `harness/manifests/${profile.profile}/${path.slice("manifests/".length)}`;
      } else if (!path.startsWith("harness/")) {
        path = `harness/bundles/${profile.profile}/${path}`;
      }
      add(path, file.content);
    }
  }
  for (const file of extraFiles) add(file.path, file.content);
  return files;
}

export function buildWorkflowFamilyNpmPackageJson(input: WorkflowFamilyNpmPackageInput): Record<string, unknown> {
  const files = [
    "hunter-workflow-family.json",
    ...input.files.map((file) => file.path).sort((a, b) => a.localeCompare(b))
  ];
  return {
    name: input.packageName,
    version: input.version,
    description: input.description,
    license: "MIT",
    files
  };
}

export function buildWorkflowFamilyManifest(input: WorkflowFamilyNpmPackageInput): Record<string, unknown> {
  return {
    schema_version: 1,
    family_slug: input.familySlug,
    version: input.version,
    required_profiles: input.requiredProfiles
  };
}

export async function buildWorkflowFamilyNpmTarball(
  input: WorkflowFamilyNpmPackageInput,
  deps: NpmPublisherDeps = {}
): Promise<WorkflowFamilyNpmPackageBuild> {
  const packageJson = buildWorkflowFamilyNpmPackageJson(input);
  const hunterWorkflowManifest = buildWorkflowFamilyManifest(input);
  const directory = await mkdtemp(join(tmpdir(), "hunter-workflow-family-npm-"));
  try {
    await writeFile(join(directory, "package.json"), JSON.stringify(packageJson, null, 2) + "\n", "utf8");
    await writeFile(
      join(directory, "hunter-workflow-family.json"),
      JSON.stringify(hunterWorkflowManifest, null, 2) + "\n",
      "utf8"
    );
    for (const file of input.files) {
      const target = join(directory, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }
    const packDirectory = deps.packDirectory ?? defaultPackDirectory;
    const tarball = await packDirectory(directory);
    return { packageJson, hunterWorkflowManifest, tarball };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function publishWorkflowFamilyNpmPackage(
  input: WorkflowFamilyNpmPackageInput,
  config: NpmPublishConfig,
  deps: NpmPublisherDeps = {}
): Promise<NpmPublishAttemptResult> {
  const publishFn = deps.publish ?? defaultPublish;
  const built = await buildWorkflowFamilyNpmTarball(input, deps);
  const token = config.token;
  if (token === null || token === "") {
    return { status: "failed", error: "npm token is not configured" };
  }
  try {
    await publishFn(built.packageJson, built.tarball, { token });
    return { status: "published", error: null };
  } catch (error) {
    if (isNpmConflictError(error)) {
      return {
        status: "conflict",
        error: "npm registry already has this package version; publish a newer family version first"
      };
    }
    const message = error instanceof Error ? error.message : "npm publish failed";
    return { status: "failed", error: message };
  }
}

export function workflowFamilyNpmPackageInput(
  config: NpmPublishConfig,
  input: {
    familySlug: string;
    version: string;
    description: string;
    requiredProfiles: string[];
    files: SourceFile[];
  }
): WorkflowFamilyNpmPackageInput {
  return {
    packageName: packageNameForWorkflowFamily(config, input.familySlug),
    version: input.version,
    familySlug: input.familySlug,
    description: input.description,
    requiredProfiles: input.requiredProfiles,
    files: input.files
  };
}

export function skillNpmPackageInput(
  config: NpmPublishConfig,
  input: {
    slug: string;
    version: string;
    description: string;
    agent: RegistryAgent;
    sourceFiles: SourceFile[];
  }
): SkillNpmPackageInput {
  return {
    packageName: packageNameForSkill(config, input.slug),
    version: input.version,
    slug: input.slug,
    agent: input.agent,
    description: input.description,
    sourceFiles: input.sourceFiles
  };
}
