#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  SKILL_ERROR_CODE,
  SKILL_NAME_REGEX,
  canonicalJson,
  skillPackageManifestV3Schema,
  type RegistryAgent,
  type SkillPackageManifestV3,
  type SkillTargetAgent,
  type SourceFile
} from "@hunter-harness/contracts";
import { planSkillInstall } from "@hunter-harness/core";
import AdmZip from "adm-zip";
import { Command, CommanderError } from "commander";

export interface SkillCliDependencies {
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  pacoteTarball?: (packageName: string) => Promise<Buffer>;
  pacoteExtract?: (packageName: string, destination: string) => Promise<void>;
  fetchNpmTarball?: (packageName: string) => Promise<Buffer>;
  userHome?: string;
  isTTY?: boolean;
  prompt?: (question: string) => Promise<string>;
}

interface ResolvedSkillCliDependencies {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof globalThis.fetch;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  pacoteTarball?: (packageName: string) => Promise<Buffer>;
  pacoteExtract?: (packageName: string, destination: string) => Promise<void>;
  fetchNpmTarball?: (packageName: string) => Promise<Buffer>;
  userHome: string;
  isTTY: boolean;
  prompt: (question: string) => Promise<string>;
}

interface CommonOptions {
  agent?: string | string[];
  serverUrl?: string;
  tokenEnv?: string;
  json?: boolean;
  force?: boolean;
  from?: string;
  npmScope?: string;
  scope?: string;
  project?: string;
  yes?: boolean;
}

interface InstallManifest {
  schema_version: 1;
  slug: string;
  version: string;
  agent: RegistryAgent;
  source_url: string;
  artifact_sha256: string;
  files: Record<string, string>;
  installed_at: string;
}

// skill-cli 独立 upload 白名单：建 per-agent draft（低风险），扩 codex/generic（#1 后有真 render + per-agent version）。
// mcp 仍不支持（installable=false，不参与 upload/install）。
const UPLOADABLE_AGENTS: ReadonlySet<RegistryAgent> = new Set(["claude-code", "cursor", "codex", "codebuddy"]);
// skill-cli 独立 install 白名单：install 链路 codex/generic 未验证，维持 claude-code/cursor。
const INSTALLABLE_AGENTS: ReadonlySet<SkillTargetAgent> = new Set(["claude-code", "cursor", "codex", "codebuddy"]);

interface LegacyArtifactMetadata {
  schema_version?: 1 | 2;
  slug: string;
  version: string;
  agent: string;
  target_path: string;
  source_sha256?: string;
  source_ir_sha256?: string;
  install_mode?: string;
}

interface MultiInstallManifest {
  schema_version: 2;
  slug: string;
  version: string;
  agent: SkillTargetAgent;
  scope: "project" | "user";
  source_url: string;
  artifact_sha256: string;
  files: Record<string, string>;
  installed_at: string;
}

class CliFailure extends Error {
  constructor(readonly exitCode: number, readonly code: string, message: string) {
    super(message);
  }
}

function sha256(value: Uint8Array): string {
  return "sha256:" + createHash("sha256").update(value).digest("hex");
}

function configuration(
  options: CommonOptions,
  env: Readonly<Record<string, string | undefined>>
): { serverUrl: string; token: string } {
  const serverUrl = options.serverUrl ?? env.HUNTER_HARNESS_SERVER_URL;
  if (serverUrl === undefined || serverUrl.trim() === "") {
    throw new CliFailure(3, "CONFIG_INVALID", "--server-url is required");
  }
  const tokenName = options.tokenEnv ?? "HUNTER_HARNESS_TOKEN";
  const token = env[tokenName];
  if (token === undefined || token.trim() === "") {
    throw new CliFailure(8, "AUTH_REQUIRED", `token environment variable ${tokenName} is empty`);
  }
  return { serverUrl: serverUrl.replace(/\/$/, ""), token };
}

async function request(
  fetch: typeof globalThis.fetch,
  url: string,
  token: string,
  init: RequestInit = {}
): Promise<Response> {
  // FormData body（multipart 上传）由 fetch 自动生成 boundary + content-type，不可手动设 application/json。
  const isFormData = init.body instanceof FormData;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        authorization: "Bearer " + token,
        "x-request-id": randomUUID(),
        ...(init.method === undefined || init.method === "GET" ? {} : {
          "idempotency-key": randomUUID(),
          ...(isFormData ? {} : { "content-type": "application/json" })
        }),
        ...init.headers
      }
    });
  } catch {
    throw new CliFailure(4, "NETWORK_ERROR", "server request failed");
  }
  if (!response.ok) {
    let code = response.status === 401 ? "AUTH_FAILED" : "SERVER_ERROR";
    let message = `server returned HTTP ${response.status}`;
    try {
      const body = await response.json() as { error?: { code?: string; message?: string } };
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // Keep the redacted status-only message.
    }
    throw new CliFailure(response.status === 401 ? 8 : 4, code, message);
  }
  return response;
}

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

// folder 模式 unmanaged 检查：目录已存在且非空（有未托管内容）时拒绝覆盖。
async function dirHasFiles(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function readManifest(path: string): Promise<InstallManifest | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as InstallManifest;
  } catch {
    return null;
  }
}

async function isDirty(root: string, manifest: InstallManifest): Promise<boolean> {
  for (const [name, expected] of Object.entries(manifest.files)) {
    try {
      if (sha256(await readFile(join(root, name))) !== expected) return true;
    } catch {
      return true;
    }
  }
  return false;
}

async function atomicInstall(input: {
  target: string;
  files: Array<{ name: string; bytes: Buffer }>;
}): Promise<void> {
  const parent = dirname(input.target);
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, "." + input.target.split(/[\\/]/).at(-1) + ".tmp-" + randomUUID());
  const backup = input.target + ".backup-" + randomUUID();
  await mkdir(temporary, { recursive: true });
  try {
    for (const file of input.files) {
      // 按路径片段判断 ".."，与 target_path 校验一致，避免误伤含 ".." 的合法文件名（如 notes..v1.md）。
      if (file.name.split(/[/\\]/).some((seg) => seg === "..") || file.name.startsWith("/") || file.name.includes("\\")) {
        throw new CliFailure(7, "ARTIFACT_PATH_INVALID", "artifact contains an unsafe path");
      }
      const destination = join(temporary, file.name);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.bytes);
    }
    const exists = await fileExists(input.target);
    if (exists) await rename(input.target, backup);
    try {
      await rename(temporary, input.target);
      if (exists) await rm(backup, { recursive: true, force: true });
    } catch (error) {
      if (exists && await fileExists(backup)) await rename(backup, input.target);
      throw error;
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function npmPackageName(
  slug: string,
  env: Readonly<Record<string, string | undefined>>,
  explicitScope?: string
): string {
  const scope = explicitScope ?? env.HUNTER_HARNESS_NPM_SCOPE;
  if (scope === undefined || scope.trim() === "") {
    throw new CliFailure(3, "CONFIG_INVALID", "--npm-scope or HUNTER_HARNESS_NPM_SCOPE is required for --from npm");
  }
  return `${scope.replace(/\/$/, "")}/${slug}`;
}

async function walkSourceFiles(root: string, relative = ""): Promise<SourceFile[]> {
  const files: SourceFile[] = [];
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    const relPath = relative === "" ? entry.name : relative + "/" + entry.name;
    if (entry.isDirectory()) {
      files.push(...await walkSourceFiles(root, relPath));
    } else if (relPath !== "package.json") {
      files.push({ path: relPath, content: await readFile(join(root, relPath), "utf8") });
    }
  }
  return files;
}

async function extractTarGzToDirectory(tarball: Buffer, destination: string): Promise<void> {
  const tarPath = join(destination, "package.tgz");
  const extractDir = join(destination, "extracted");
  await writeFile(tarPath, tarball);
  await mkdir(extractDir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    execFile("tar", ["-xzf", tarPath, "-C", extractDir], (error) => {
      if (error !== null) reject(error);
      else resolve();
    });
  });
  const packageDir = join(extractDir, "package");
  const entries = await readdir(packageDir, { withFileTypes: true });
  for (const entry of entries) {
    const source = join(packageDir, entry.name);
    const target = join(destination, entry.name);
    if (entry.isDirectory()) {
      await cp(source, target, { recursive: true });
    } else {
      await copyFile(source, target);
    }
  }
}

async function extractNpmSkillPackage(
  packageName: string,
  dependencies: ResolvedSkillCliDependencies
): Promise<{ bytes: Buffer; metadata: unknown; sourceFiles: SourceFile[] }> {
  const directory = await mkdtemp(join(tmpdir(), "hunter-skill-npm-install-"));
  try {
    if (dependencies.pacoteExtract !== undefined) {
      await dependencies.pacoteExtract(packageName, directory);
    } else if (dependencies.fetchNpmTarball !== undefined || dependencies.pacoteTarball !== undefined) {
      const tarball = dependencies.fetchNpmTarball !== undefined
        ? await dependencies.fetchNpmTarball(packageName)
        : dependencies.pacoteTarball !== undefined
          ? await dependencies.pacoteTarball(packageName)
          : Buffer.alloc(0);
      await extractTarGzToDirectory(tarball, directory);
    } else {
      const pacote = await import("pacote");
      await pacote.default.extract(packageName, directory);
    }
    const bytes = dependencies.pacoteTarball !== undefined
      ? await dependencies.pacoteTarball(packageName)
      : dependencies.fetchNpmTarball !== undefined
        ? await dependencies.fetchNpmTarball(packageName)
        : await (await import("pacote")).default.tarball(packageName);
    const manifestRaw = await readFile(join(directory, "hunter-skill.json"), "utf8");
    const metadata: unknown = JSON.parse(manifestRaw);
    const sourceFiles = (await walkSourceFiles(directory))
      .filter((file) => file.path !== "hunter-skill.json");
    if (sourceFiles.length === 0) {
      throw new CliFailure(7, "ARTIFACT_SCHEMA_INVALID", "npm package is missing skill source files");
    }
    return { bytes, metadata, sourceFiles };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function optionAgents(value: CommonOptions["agent"]): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

async function resolveInstallChoices(
  options: CommonOptions,
  dependencies: ResolvedSkillCliDependencies
): Promise<{ agents: SkillTargetAgent[]; scope: "project" | "user"; root: string }> {
  let requested = optionAgents(options.agent);
  if (requested.length === 0 && dependencies.isTTY) {
    requested = (await dependencies.prompt(
      "Install for which agents? (claude-code,codex,cursor,codebuddy): "
    )).split(",").map((value) => value.trim()).filter(Boolean);
  }
  if (requested.length === 0) {
    throw new CliFailure(3, "CONFIG_INVALID", "at least one --agent is required");
  }
  const invalid = requested.find((agent) => !INSTALLABLE_AGENTS.has(agent as SkillTargetAgent));
  if (invalid !== undefined) {
    throw new CliFailure(3, "ADAPTER_UNSUPPORTED", `unsupported install agent: ${invalid}`);
  }
  const agents = [...new Set(requested)] as SkillTargetAgent[];

  let scope = options.scope;
  if (scope === undefined && dependencies.isTTY) {
    scope = (await dependencies.prompt("Install scope? (project/user): ")).trim().toLowerCase();
  }
  scope ??= "project";
  if (scope !== "project" && scope !== "user") {
    throw new CliFailure(3, "CONFIG_INVALID", "--scope must be 'project' or 'user'");
  }
  const root = scope === "project" ? resolve(options.project ?? dependencies.cwd) : resolve(dependencies.userHome);
  return { agents, scope, root };
}

function verifyV3Package(
  slug: string,
  manifest: SkillPackageManifestV3,
  sourceFiles: readonly SourceFile[]
): void {
  if (manifest.slug !== slug) {
    throw new CliFailure(7, "ARTIFACT_SCHEMA_INVALID", "package identity does not match request");
  }
  const actual = new Map(sourceFiles.map((file) => [file.path, file]));
  if (actual.size !== manifest.files.length) {
    throw new CliFailure(7, "ARTIFACT_SCHEMA_INVALID", "package file list does not match its manifest");
  }
  for (const declared of manifest.files) {
    const file = actual.get(declared.path);
    if (file === undefined || Buffer.byteLength(file.content, "utf8") !== declared.size ||
        sha256(Buffer.from(file.content, "utf8")) !== declared.sha256) {
      throw new CliFailure(7, "ARTIFACT_HASH_MISMATCH", `package file verification failed: ${declared.path}`);
    }
  }
}

async function isMultiInstallDirty(manifest: MultiInstallManifest): Promise<boolean> {
  for (const [path, expected] of Object.entries(manifest.files)) {
    try {
      if (sha256(await readFile(path)) !== expected) return true;
    } catch {
      return true;
    }
  }
  return false;
}

async function assertSafeInstallPath(root: string, path: string): Promise<void> {
  const rootPath = resolve(root);
  const targetPath = resolve(path);
  const remainder = relative(rootPath, targetPath);
  if (remainder.startsWith("..") || isAbsolute(remainder)) {
    throw new CliFailure(7, "INSTALL_PATH_UNSAFE", `install target escapes the selected scope: ${path}`);
  }
  const rootReal = await realpath(rootPath);
  let existing = rootPath;
  for (const segment of remainder.split(/[\\/]/).filter(Boolean)) {
    const candidate = join(existing, segment);
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink()) {
        throw new CliFailure(7, "INSTALL_PATH_UNSAFE", `install target traverses a symbolic link or junction: ${candidate}`);
      }
      existing = candidate;
    } catch (error) {
      if (error instanceof CliFailure) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  const existingReal = await realpath(existing);
  const realRemainder = relative(rootReal, existingReal);
  if (realRemainder.startsWith("..") || isAbsolute(realRemainder)) {
    throw new CliFailure(7, "INSTALL_PATH_UNSAFE", `install target resolves outside the selected scope: ${path}`);
  }
}

async function writeFileAtomically(root: string, path: string, bytes: Buffer): Promise<void> {
  await assertSafeInstallPath(root, path);
  await mkdir(dirname(path), { recursive: true });
  await assertSafeInstallPath(root, path);
  const temporary = path + ".tmp-" + randomUUID();
  const backup = path + ".bak-" + randomUUID();
  await writeFile(temporary, bytes, { flag: "wx" });
  let movedExisting = false;
  try {
    if (await fileExists(path)) {
      await rename(path, backup);
      movedExisting = true;
    }
    await rename(temporary, path);
    if (movedExisting) await rm(backup, { force: true });
  } catch (error) {
    if (movedExisting && !await fileExists(path) && await fileExists(backup)) await rename(backup, path);
    throw error;
  } finally {
    await rm(temporary, { force: true });
    await rm(backup, { force: true });
  }
}

async function installV3Package(input: {
  slug: string;
  manifest: SkillPackageManifestV3;
  sourceFiles: SourceFile[];
  artifactHash: string;
  sourceUrl: string;
  choices: Awaited<ReturnType<typeof resolveInstallChoices>>;
  options: CommonOptions;
  dependencies: ResolvedSkillCliDependencies;
}): Promise<void> {
  verifyV3Package(input.slug, input.manifest, input.sourceFiles);
  const authorManifest = {
    apiVersion: "hunter-harness/v1" as const,
    kind: "SkillBundle" as const,
    components: input.manifest.components
  };
  let plan;
  try {
    plan = planSkillInstall({
      slug: input.slug,
      agents: input.choices.agents,
      scope: input.choices.scope,
      ...(input.choices.scope === "project" ? { projectRoot: input.choices.root } : { userHome: input.choices.root }),
      files: input.sourceFiles.map((file) => file.path),
      manifest: authorManifest
    });
  } catch (error) {
    throw new CliFailure(7, "ARTIFACT_SCHEMA_INVALID", error instanceof Error ? error.message : "invalid install plan");
  }
  const byPath = new Map(input.sourceFiles.map((file) => [file.path, Buffer.from(file.content, "utf8")]));
  const stateRoot = input.choices.scope === "project"
    ? join(input.choices.root, ".harness", "state", "local", "skill-installs")
    : join(input.choices.root, ".hunter-harness", "state", "skill-installs");
  const statePaths = new Map(input.choices.agents.map((agent) => [
    agent, join(stateRoot, agent, input.slug + ".json")
  ]));
  const existingManifests = new Map<SkillTargetAgent, MultiInstallManifest>();

  for (const variant of plan.variants) {
    const statePath = statePaths.get(variant.agent) as string;
    const existing = await readManifest(statePath) as MultiInstallManifest | null;
    if (existing !== null && existing.schema_version === 2) existingManifests.set(variant.agent, existing);
    if (existing === null && input.options.force !== true) {
      const occupied = await Promise.all(variant.operations.map((operation) => fileExists(operation.destinationPath)));
      if (occupied.some(Boolean)) {
        throw new CliFailure(5, "LOCAL_SKILL_UNMANAGED", `${variant.agent} target contains unmanaged files; use --force to overwrite`);
      }
    }
    if (existing !== null && await isMultiInstallDirty(existing) && input.options.force !== true) {
      throw new CliFailure(5, "LOCAL_SKILL_DIRTY", `${variant.agent} installation has local edits; use --force to overwrite`);
    }
  }

  input.dependencies.stdout(JSON.stringify({
    ok: true,
    action: "install-preview",
    slug: input.slug,
    version: input.manifest.version,
    scope: input.choices.scope,
    variants: plan.variants.map((variant) => ({
      agent: variant.agent,
      status: variant.status,
      warnings: variant.warnings,
      targets: variant.operations.map((operation) => operation.destinationPath)
    }))
  }) + "\n");
  if (input.options.yes !== true && input.dependencies.isTTY) {
    const answer = (await input.dependencies.prompt("Proceed with this install? (y/N): ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      throw new CliFailure(6, "INSTALL_CANCELLED", "installation cancelled");
    }
  }

  const snapshots = new Map<string, Buffer | null>();
  const obsoleteTargets = [...existingManifests.entries()].flatMap(([agent, manifest]) => {
    const variant = plan.variants.find((candidate) => candidate.agent === agent);
    const next = new Set(variant?.operations.map((operation) => operation.destinationPath) ?? []);
    return Object.keys(manifest.files).filter((path) => !next.has(path));
  });
  const allTargets = [
    ...new Set(plan.operations.map((operation) => operation.destinationPath)),
    ...obsoleteTargets,
    ...statePaths.values()
  ];
  for (const path of allTargets) {
    await assertSafeInstallPath(input.choices.root, path);
    snapshots.set(path, await readFile(path).catch(() => null));
  }
  try {
    for (const path of obsoleteTargets) await rm(path, { force: true });
    for (const operation of plan.operations) {
      const bytes = byPath.get(operation.sourcePath);
      if (bytes === undefined) throw new Error(`missing planned source: ${operation.sourcePath}`);
      await writeFileAtomically(input.choices.root, operation.destinationPath, bytes);
    }
    for (const variant of plan.variants) {
      const files = Object.fromEntries(variant.operations.map((operation) => {
        const bytes = byPath.get(operation.sourcePath) as Buffer;
        return [operation.destinationPath, sha256(bytes)];
      }));
      const state: MultiInstallManifest = {
        schema_version: 2,
        slug: input.slug,
        version: input.manifest.version,
        agent: variant.agent,
        scope: input.choices.scope,
        source_url: input.sourceUrl,
        artifact_sha256: input.artifactHash,
        files,
        installed_at: new Date().toISOString()
      };
      await writeFileAtomically(input.choices.root, statePaths.get(variant.agent) as string, Buffer.from(JSON.stringify(state, null, 2) + "\n"));
    }
  } catch (error) {
    for (const [path, previous] of [...snapshots.entries()].reverse()) {
      if (previous === null) await rm(path, { force: true });
      else await writeFileAtomically(input.choices.root, path, previous);
    }
    throw error;
  }
  input.dependencies.stdout(JSON.stringify({
    ok: true, action: "installed", slug: input.slug, version: input.manifest.version,
    agents: input.choices.agents, scope: input.choices.scope
  }) + "\n");
}

async function runInstall(
  slug: string,
  options: CommonOptions,
  dependencies: ResolvedSkillCliDependencies
): Promise<void> {
  if (!SKILL_NAME_REGEX.test(slug)) {
    throw new CliFailure(3, SKILL_ERROR_CODE.SLUG_INVALID, "skill slug is invalid: must match ^[a-z0-9]+(-[a-z0-9]+)*$ (lowercase alphanumeric with single hyphens, at most 64 chars)");
  }
  const choices = await resolveInstallChoices(options, dependencies);

  const installFrom = options.from ?? "server";
  let bytes: Uint8Array;
  let metadata: unknown;
  let sourceFiles: SourceFile[];
  let sourceUrl: string;

  if (installFrom === "npm") {
    const packageName = npmPackageName(slug, dependencies.env, options.npmScope);
    const npmPackage = await extractNpmSkillPackage(packageName, dependencies);
    bytes = npmPackage.bytes;
    metadata = npmPackage.metadata;
    sourceFiles = npmPackage.sourceFiles;
    sourceUrl = `npm:${packageName}`;
  } else if (installFrom === "server") {
    if (choices.agents.length !== 1) {
      throw new CliFailure(3, "CONFIG_INVALID", "multi-agent installation requires --from npm");
    }
    const { serverUrl, token } = configuration(options, dependencies.env);
    const response = await request(
      dependencies.fetch,
      `${serverUrl}/api/v1/skills/${encodeURIComponent(slug)}/artifacts/${encodeURIComponent(choices.agents[0] as SkillTargetAgent)}/download`,
      token
    );
    bytes = new Uint8Array(await response.arrayBuffer());
    sourceUrl = serverUrl;
    const declaredHash = response.headers.get("x-content-sha256");
    const actualArtifactHash = sha256(bytes);
    if (declaredHash === null || declaredHash !== actualArtifactHash) {
      throw new CliFailure(7, "ARTIFACT_HASH_MISMATCH", "downloaded artifact failed SHA-256 verification");
    }
    const zip = new AdmZip(Buffer.from(bytes));
    const metadataEntry = zip.getEntry("hunter-skill.json");
    if (metadataEntry === null || metadataEntry.isDirectory) {
      throw new CliFailure(7, "ARTIFACT_SCHEMA_INVALID", "artifact is missing required files");
    }
    metadata = JSON.parse(metadataEntry.getData().toString("utf8")) as unknown;
    sourceFiles = [];
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory || entry.entryName === "hunter-skill.json") continue;
      if (/(^|[/\\])\.\.([/\\]|$)|^\/|^\\|^[a-zA-Z]:/.test(entry.entryName)) {
        throw new CliFailure(7, "ARTIFACT_PATH_INVALID", "artifact contains an unsafe path: " + entry.entryName);
      }
      sourceFiles.push({ path: entry.entryName, content: entry.getData().toString("utf8") });
    }
    if (sourceFiles.length === 0) {
      throw new CliFailure(7, "ARTIFACT_SCHEMA_INVALID", "artifact is missing required files");
    }
  } else {
    throw new CliFailure(3, "CONFIG_INVALID", "--from must be 'server' or 'npm'");
  }

  const actualArtifactHash = sha256(bytes);
  const parsedV3 = skillPackageManifestV3Schema.safeParse(metadata);
  if (parsedV3.success) {
    await installV3Package({
      slug,
      manifest: parsedV3.data,
      sourceFiles,
      artifactHash: actualArtifactHash,
      sourceUrl,
      choices,
      options,
      dependencies
    });
    return;
  }
  if (choices.agents.length !== 1) {
    throw new CliFailure(7, "ARTIFACT_SCHEMA_INVALID", "legacy packages support exactly one agent");
  }
  const legacy = metadata as LegacyArtifactMetadata;
  // identity 校验 agent 与请求一致；target_path 提供 install 目录（folder=文件夹根，file=文件路径）。
  if (
    legacy.slug !== slug ||
    legacy.agent !== choices.agents[0] ||
    typeof legacy.target_path !== "string" ||
    legacy.target_path.length === 0
  ) {
    throw new CliFailure(7, "ARTIFACT_SCHEMA_INVALID", "artifact identity does not match request");
  }
  // target_path 防逃逸：拦截绝对路径/驱动器前缀/.. 父段。folder 模式 target_path 以 / 结尾（如 .claude/skills/<slug>/）。
  // 按路径片段判断 ".."，避免误伤含 ".." 的合法文件名（如 notes..v1.md）。
  if (
    legacy.target_path.split(/[/\\]/).some((seg) => seg === "..") ||
    /^[a-zA-Z]:/.test(legacy.target_path) ||
    legacy.target_path.startsWith("/")
  ) {
    throw new CliFailure(7, "ARTIFACT_PATH_INVALID", "artifact target path is unsafe");
  }

  // source hash 校验：优先 source_sha256（新），回退 source_ir_sha256（旧 zip 兼容）；均缺则跳过（极旧 zip）。
  // 与 server buildArtifactFor / core computeSourceHash 同算法：sorted by path → canonicalJson → sha256。
  const computedSourceHash = sha256(Buffer.from(canonicalJson(
    [...sourceFiles].sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => ({ path: f.path, content: f.content }))
  ), "utf8"));
  const declaredSourceHash = legacy.source_sha256 ?? legacy.source_ir_sha256;
  if (declaredSourceHash !== undefined && declaredSourceHash !== computedSourceHash) {
    throw new CliFailure(7, "ARTIFACT_HASH_MISMATCH", "artifact source files failed SHA-256 verification");
  }

  // install mode：manifest 显式提供则用，否则按 target_path 尾部分隔符推断（folder=/结尾，file=其余）。
  const installMode = legacy.install_mode ??
    (/(?:[\\/])$/.test(legacy.target_path) ? "folder" : "file");

  // folder 模式：installRoot=target_path 文件夹根，装全部文件（保留目录结构，references/scripts 一起落地）；
  // file 模式：installRoot=dirname(target_path)，只装 entry（basename）。
  let installRoot: string;
  let filesToInstall: Array<{ name: string; bytes: Buffer }>;
  let manifestFiles: Record<string, string>;
  let primaryName: string | null = null; // file 模式 = filename（unmanaged 检查用）；folder 模式 = null
  if (installMode === "folder") {
    installRoot = join(choices.root, legacy.target_path);
    filesToInstall = sourceFiles.map((f) => ({ name: f.path, bytes: Buffer.from(f.content, "utf8") }));
    manifestFiles = Object.fromEntries(
      sourceFiles.map((f) => [f.path, sha256(Buffer.from(f.content, "utf8"))])
    );
  } else {
    const filename = legacy.target_path.split(/[/\\]/).at(-1);
    if (filename === undefined || filename === "") {
      throw new CliFailure(7, "ARTIFACT_PATH_INVALID", "artifact target path has no filename");
    }
    // file 模式 entry：优先精确匹配 basename，回退以 /<basename> 结尾（兼容 zip 内带前缀目录）。
    const entry = sourceFiles.find((f) => f.path === filename) ??
      sourceFiles.find((f) => f.path.endsWith("/" + filename));
    if (entry === undefined) {
      throw new CliFailure(7, "ARTIFACT_SCHEMA_INVALID", "artifact is missing required files");
    }
    installRoot = join(choices.root, dirname(legacy.target_path));
    filesToInstall = [{ name: filename, bytes: Buffer.from(entry.content, "utf8") }];
    manifestFiles = { [filename]: sha256(Buffer.from(entry.content, "utf8")) };
    primaryName = filename;
  }

  const stateRoot = choices.scope === "project"
    ? join(choices.root, ".harness", "state", "local", "skill-installs")
    : join(choices.root, ".hunter-harness", "state", "skill-installs");
  const manifestPath = join(stateRoot, choices.agents[0], slug + ".json");
  const legacyManifestPath = join(dependencies.cwd, ".harness", "state", "local", "skill-installs", slug + ".json");
  const existing = await readManifest(manifestPath) ?? await readManifest(legacyManifestPath);
  // unmanaged：无 manifest 且目标已存在内容（folder=目录有文件，file=目标文件存在）。
  if (existing === null && options.force !== true) {
    const occupied = primaryName === null
      ? await dirHasFiles(installRoot)
      : await fileExists(join(installRoot, primaryName));
    if (occupied) {
      throw new CliFailure(5, "LOCAL_SKILL_UNMANAGED", primaryName === null
        ? "target skill directory already exists without a trusted install manifest; use --force to confirm overwrite"
        : "target skill already exists without a trusted install manifest; use --force to confirm overwrite");
    }
  }
  if (existing !== null && await isDirty(installRoot, existing) && options.force !== true) {
    throw new CliFailure(5, "LOCAL_SKILL_DIRTY", "local skill has uncommitted edits; use --force to confirm overwrite");
  }
  if (existing?.artifact_sha256 === actualArtifactHash && !(await isDirty(installRoot, existing))) {
    dependencies.stdout(JSON.stringify({ ok: true, action: "noop", slug, version: legacy.version }) + "\n");
    return;
  }
  await atomicInstall({ target: installRoot, files: filesToInstall });
  const manifest: InstallManifest = {
    schema_version: 1,
    slug,
    version: legacy.version,
    agent: choices.agents[0] as RegistryAgent,
    source_url: sourceUrl,
    artifact_sha256: actualArtifactHash,
    files: manifestFiles,
    installed_at: new Date().toISOString()
  };
  await mkdir(dirname(manifestPath), { recursive: true });
  const manifestTemp = manifestPath + ".tmp-" + randomUUID();
  await writeFile(manifestTemp, JSON.stringify(manifest, null, 2) + "\n");
  await rename(manifestTemp, manifestPath);
  dependencies.stdout(JSON.stringify({ ok: true, action: existing === null ? "installed" : "updated", slug, version: legacy.version }) + "\n");
}

// readSourceFiles：读 skill 源（目录递归 / ZIP 解包 / 单文件）为 SourceFile[]（{path, content}）。
// path 用相对路径（目录/ZIP 内，正斜杠），与 Web buildUploadFormData 的 filename 协议对齐——server part.filename 取此。
// entry 定位交给 server uploadDraft（store 内 deriveSlug + findEntryFile），CLI 不重复解析，避免与 server schema 双重维护。
async function readSourceFiles(source: string): Promise<SourceFile[]> {
  const sourceStat = await stat(source).catch(() => null);
  if (sourceStat === null) throw new CliFailure(3, "SOURCE_NOT_FOUND", "skill source does not exist");
  if (sourceStat.isDirectory()) {
    const files: SourceFile[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        const relPath = rel === "" ? entry.name : rel + "/" + entry.name;
        if (entry.isDirectory()) {
          await walk(full, relPath);
        } else {
          files.push({ path: relPath, content: await readFile(full, "utf8") });
        }
      }
    };
    await walk(source, "");
    if (files.length === 0) throw new CliFailure(7, "SKILL_IR_MISSING", "directory has no skill files");
    return files;
  }
  if (extname(source).toLowerCase() === ".zip") {
    const zip = new AdmZip(source);
    const files: SourceFile[] = [];
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      // zip-slip 防御：与 server resolveUploadFiles DANGEROUS_PATH 对齐（.. / 绝对路径 / UNC 前缀）
      if (/(^|[/\\])\.\.([/\\]|$)|^\/|^\\|^[a-zA-Z]:/.test(entry.entryName)) {
        throw new CliFailure(7, "SKILL_IR_INVALID", "zip contains unsafe path: " + entry.entryName);
      }
      files.push({ path: entry.entryName, content: entry.getData().toString("utf8") });
    }
    if (files.length === 0) throw new CliFailure(7, "SKILL_IR_MISSING", "zip has no files");
    return files;
  }
  return [{ path: basename(source), content: await readFile(source, "utf8") }];
}

async function runUpload(
  sourceValue: string,
  options: CommonOptions,
  dependencies: ResolvedSkillCliDependencies
): Promise<void> {
  const agents = optionAgents(options.agent);
  if (agents.length !== 1 || !UPLOADABLE_AGENTS.has(agents[0] as RegistryAgent)) {
    throw new CliFailure(3, "ADAPTER_UNSUPPORTED", "upload supports one of claude-code, codex, cursor or codebuddy");
  }
  const agent = agents[0] as string;
  const { serverUrl, token } = configuration(options, dependencies.env);
  const files = await readSourceFiles(resolve(dependencies.cwd, sourceValue));
  // multipart：每文件一个 "file" part，filename=相对路径；agent 走 query param。
  // 与 Web buildUploadFormData + server POST /api/v1/skills/draft?agent=<agent> 协议对齐。
  // slug 不在 URL——server uploadDraft 内部从 ir.name 取并在响应 DraftState 返回。
  const form = new FormData();
  for (const file of files) {
    form.append("file", new Blob([file.content]), file.path);
  }
  const response = await request(
    dependencies.fetch,
    `${serverUrl}/api/v1/skills/draft?agent=${encodeURIComponent(agent)}`,
    token,
    { method: "POST", body: form }
  );
  const draft = await response.json() as {
    slug: string; agent: string; draftVersion: string | null; revision: number;
  };
  dependencies.stdout(JSON.stringify({
    ok: true, action: "draft-created",
    slug: draft.slug, agent: draft.agent,
    draftVersion: draft.draftVersion, revision: draft.revision
  }) + "\n");
}

export async function runSkillCli(
  argv: readonly string[],
  overrides: SkillCliDependencies = {}
): Promise<number> {
  const dependencies: ResolvedSkillCliDependencies = {
    cwd: overrides.cwd ?? process.cwd(),
    env: overrides.env ?? process.env,
    fetch: overrides.fetch ?? globalThis.fetch,
    stdout: overrides.stdout ?? ((value) => process.stdout.write(value)),
    stderr: overrides.stderr ?? ((value) => process.stderr.write(value)),
    userHome: overrides.userHome ?? homedir(),
    isTTY: overrides.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
    prompt: overrides.prompt ?? (async (question) => {
      const { createInterface } = await import("node:readline/promises");
      const interface_ = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await interface_.question(question);
      } finally {
        interface_.close();
      }
    }),
    ...(overrides.pacoteTarball !== undefined ? { pacoteTarball: overrides.pacoteTarball } : {}),
    ...(overrides.pacoteExtract !== undefined ? { pacoteExtract: overrides.pacoteExtract } : {}),
    ...(overrides.fetchNpmTarball !== undefined ? { fetchNpmTarball: overrides.fetchNpmTarball } : {})
  };
  const program = new Command()
    .name("hunter-harness-skill")
    .description("Install or upload governed Hunter Harness skills")
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({ writeOut: dependencies.stdout, writeErr: dependencies.stderr });
  const addNetworkOptions = (command: Command) => command
    .option("--server-url <url>")
    .option("--token-env <ENV_NAME>")
    .option("--json");
  addNetworkOptions(program.command("install <skill-slug>"))
    .option("--agent <agent>", "target agent; repeat to install multiple variants", (value, previous: string[]) => [...previous, value], [])
    .option("--scope <scope>", "installation scope: project or user")
    .option("--project <path>", "project root for project-scoped installation")
    .option("--yes", "approve the displayed installation plan")
    .option("--from <source>", "install source: server or npm", "server")
    .option("--npm-scope <scope>", "npm scope for --from npm (default: HUNTER_HARNESS_NPM_SCOPE)")
    .option("--force", "confirm overwrite of a locally modified installed skill")
    .action(async (slug: string, options: CommonOptions) => runInstall(slug, options, dependencies));
  addNetworkOptions(program.command("upload <skill-directory-or-zip>"))
    .requiredOption("--agent <agent>")
    .action(async (source: string, options: CommonOptions) => runUpload(source, options, dependencies));
  try {
    await program.parseAsync([...argv], { from: "node" });
    return 0;
  } catch (error) {
    if (error instanceof CliFailure) {
      dependencies.stderr(JSON.stringify({ ok: false, error: { code: error.code, message: error.message } }) + "\n");
      return error.exitCode;
    }
    if (error instanceof CommanderError) return error.code === "commander.helpDisplayed" ? 0 : 3;
    dependencies.stderr(JSON.stringify({ ok: false, error: { code: "GENERAL_FAILURE", message: "operation failed" } }) + "\n");
    return 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined) {
  let isEntrypoint: boolean;
  try {
    isEntrypoint = import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    isEntrypoint = import.meta.url === pathToFileURL(entry).href;
  }
  if (isEntrypoint) {
    process.exitCode = await runSkillCli(process.argv);
  }
}
