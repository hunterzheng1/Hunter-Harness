import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { promisify } from "node:util";

import {
  authorSkillBundleManifestSchema,
  canonicalJson,
  skillPackageManifestV3Schema,
  type RegistryAgent,
  type SourceFile,
  type WorkflowFamilyVersion
} from "@hunter-harness/contracts";
import { SKILL_TARGET_AGENTS, sha256Bytes } from "@hunter-harness/core";
import { publish as libnpmPublish } from "libnpmpublish";
import { parse as parseYaml } from "yaml";

import type { NpmPublishConfig } from "./config.js";
import { packageNameForSkill, packageNameForWorkflowFamily } from "./config.js";

const execFileAsync = promisify(execFile);
const MANIFEST_SCHEMA_VERSION = 3;
const RESERVED_PACKAGE_PATHS = new Set([
  ".npmrc",
  "hunter-skill.json",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "package.json"
]);

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
  status: "published" | "idempotent" | "failed" | "conflict";
  error: string | null;
  tarballHash: string;
}

export interface NpmPublisherDeps {
  packDirectory?: (directory: string) => Promise<Buffer>;
  publish?: (
    manifest: Record<string, unknown>,
    tarball: Buffer,
    options: { token: string; access: "public" }
  ) => Promise<unknown>;
  createTarballDigest?: (tarball: Buffer) => string;
  readRemotePackageDigest?: (packageName: string, version: string) => Promise<string | null>;
}

function buildHunterSkillManifest(
  slug: string,
  version: string,
  agent: RegistryAgent,
  sourceFiles: SourceFile[]
): Record<string, unknown> {
  for (const file of sourceFiles) {
    const normalized = file.path.replaceAll("\\", "/").toLowerCase();
    if (RESERVED_PACKAGE_PATHS.has(normalized)) {
      throw new Error(`reserved npm package path is not allowed: ${file.path}`);
    }
  }
  const sourceSha256 = sha256Bytes(canonicalJson(
    [...sourceFiles].sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => ({ path: f.path, content: f.content }))
  ));
  const authorManifestFile = sourceFiles.find((file) =>
    file.path === "hunter-skill.yaml" || file.path === "hunter-skill.yml"
  );
  const components = authorManifestFile === undefined
    ? [{ role: "skill" as const, source: "." as const }]
    : authorSkillBundleManifestSchema.parse(parseYaml(authorManifestFile.content)).components;
  const availableFiles = new Set(sourceFiles.map((file) => file.path));
  for (const component of components) {
    if (component.role === "skill") {
      const prefix = component.source === "." ? "" : component.source.replace(/\/$/, "") + "/";
      if (!availableFiles.has(prefix + "SKILL.md")) {
        throw new Error(`skill component is missing SKILL.md: ${component.source}`);
      }
      continue;
    }
    for (const sourcePath of Object.values(component.variants ?? {})) {
      if (!availableFiles.has(sourcePath)) {
        throw new Error(`subagent variant file is missing: ${sourcePath}`);
      }
    }
  }
  const manifest = skillPackageManifestV3Schema.parse({
    schema_version: MANIFEST_SCHEMA_VERSION,
    slug,
    version,
    files: [...sourceFiles]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({
        path: file.path,
        sha256: sha256Bytes(file.content),
        size: Buffer.byteLength(file.content, "utf8")
      })),
    components,
    variants: Object.fromEntries(SKILL_TARGET_AGENTS.map((targetAgent) => [targetAgent, {
      status: components.some((component) => component.role === "subagent" && component.variants?.[targetAgent] === undefined)
        ? "degraded"
        : "ready",
      adapterVersion: "1",
      buildHash: sourceSha256,
      components: components.flatMap((component) => component.role === "skill"
        ? [`skill:${component.source}`]
        : component.variants?.[targetAgent] === undefined ? [] : [`subagent:${component.name}`])
    }]))
  });
  // The source agent is retained by the Registry compatibility projection, but
  // package metadata deliberately models one version with all native variants.
  void agent;
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
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
}

export function validatePacklist(expected: readonly string[], actual: readonly string[]): void {
  const normalize = (items: readonly string[]): string[] => [...new Set(items)].sort();
  const expectedFiles = normalize(expected);
  const actualFiles = normalize(actual);
  if (canonicalJson(expectedFiles) !== canonicalJson(actualFiles)) {
    throw new Error("npm packlist does not match the declared package files");
  }
}

async function defaultPackDirectory(directory: string): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", directory],
    { cwd: directory }
  );
  const parsed = JSON.parse(stdout) as Array<{
    filename: string;
    files?: Array<{ path: string }>;
  }>;
  const filename = parsed[0]?.filename;
  if (filename === undefined) {
    throw new Error("npm pack did not return a tarball filename");
  }
  const packageJson = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
    files?: string[];
  };
  validatePacklist(
    ["package.json", ...(packageJson.files ?? [])],
    parsed[0]?.files?.map((file) => file.path) ?? []
  );
  return readFile(join(directory, filename));
}

async function defaultReadRemotePackageDigest(
  packageName: string,
  version: string,
  token: string
): Promise<string | null> {
  const registry = (process.env.npm_config_registry ?? "https://registry.npmjs.org").replace(/\/$/, "");
  const metadataResponse = await fetch(`${registry}/${encodeURIComponent(packageName)}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (metadataResponse.status === 404) return null;
  if (!metadataResponse.ok) return null;
  const metadata = await metadataResponse.json() as {
    versions?: Record<string, { dist?: { tarball?: string } }>;
  };
  const tarballUrl = metadata.versions?.[version]?.dist?.tarball;
  if (tarballUrl === undefined) return null;
  const tarballResponse = await fetch(tarballUrl, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!tarballResponse.ok) return null;
  return sha256Bytes(new Uint8Array(await tarballResponse.arrayBuffer()));
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
  options: { token: string; access: "public" }
): Promise<void> {
  await libnpmPublish(manifest as Parameters<typeof libnpmPublish>[0], tarball, {
    token: options.token,
    forceAuth: { token: options.token },
    access: options.access
  });
}

export async function publishSkillNpmPackage(
  input: SkillNpmPackageInput,
  config: NpmPublishConfig,
  deps: NpmPublisherDeps = {}
): Promise<NpmPublishAttemptResult> {
  const publishFn = deps.publish ?? defaultPublish;
  const built = await buildSkillNpmTarball(input, deps);
  const tarballHash = (deps.createTarballDigest ?? sha256Bytes)(built.tarball);
  const token = config.token;
  if (token === null || token === "") {
    return { status: "failed", error: "npm token is not configured", tarballHash };
  }
  try {
    await publishFn(built.packageJson, built.tarball, { token, access: "public" });
    return { status: "published", error: null, tarballHash };
  } catch (error) {
    if (isNpmConflictError(error)) {
      const remoteDigest = await (deps.readRemotePackageDigest === undefined
        ? defaultReadRemotePackageDigest(input.packageName, input.version, token)
        : deps.readRemotePackageDigest(input.packageName, input.version));
      if (remoteDigest !== undefined && remoteDigest !== null && remoteDigest === tarballHash) {
        return { status: "idempotent", error: null, tarballHash };
      }
      return {
        status: "conflict",
        error: "npm registry already has this package version with different content; publish a newer registry version first",
        tarballHash
      };
    }
    const message = error instanceof Error ? error.message : "npm publish failed";
    return { status: "failed", error: message, tarballHash };
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
  const contentSha256 = sha256Bytes(canonicalJson(
    [...input.files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({ path: file.path, content: file.content }))
  ));
  return {
    schema_version: 1,
    family_slug: input.familySlug,
    version: input.version,
    required_profiles: input.requiredProfiles,
    content_sha256: contentSha256
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
  const tarballHash = (deps.createTarballDigest ?? sha256Bytes)(built.tarball);
  const token = config.token;
  if (token === null || token === "") {
    return { status: "failed", error: "npm token is not configured", tarballHash };
  }
  try {
    await publishFn(built.packageJson, built.tarball, { token, access: "public" });
    return { status: "published", error: null, tarballHash };
  } catch (error) {
    if (isNpmConflictError(error)) {
      return {
        status: "conflict",
        error: "npm registry already has this package version; publish a newer family version first",
        tarballHash
      };
    }
    const message = error instanceof Error ? error.message : "npm publish failed";
    return { status: "failed", error: message, tarballHash };
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
