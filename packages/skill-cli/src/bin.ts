#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { canonicalJson, type RegistryAgent, type SourceFile } from "@hunter-harness/contracts";
import AdmZip from "adm-zip";
import { Command, CommanderError } from "commander";

export interface SkillCliDependencies {
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof globalThis.fetch;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
}

interface CommonOptions {
  agent: string;
  serverUrl?: string;
  tokenEnv?: string;
  json?: boolean;
  force?: boolean;
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
const UPLOADABLE_AGENTS: ReadonlySet<RegistryAgent> = new Set(["claude-code", "cursor", "codex", "generic"]);
// skill-cli 独立 install 白名单：install 链路 codex/generic 未验证，维持 claude-code/cursor。
const INSTALLABLE_AGENTS: ReadonlySet<RegistryAgent> = new Set(["claude-code", "cursor"]);

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

async function runInstall(
  slug: string,
  options: CommonOptions,
  dependencies: Required<SkillCliDependencies>
): Promise<void> {
  if (!/^harness-[a-z0-9-]+$/.test(slug)) {
    throw new CliFailure(3, "SKILL_SLUG_INVALID", "skill slug is invalid");
  }
  if (!INSTALLABLE_AGENTS.has(options.agent as RegistryAgent)) {
    throw new CliFailure(3, "ADAPTER_UNSUPPORTED", "standalone install supports claude-code and cursor only");
  }
  const { serverUrl, token } = configuration(options, dependencies.env);
  const response = await request(
    dependencies.fetch,
    `${serverUrl}/api/v1/skills/${encodeURIComponent(slug)}/artifacts/${encodeURIComponent(options.agent)}/download`,
    token
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actualArtifactHash = sha256(bytes);
  const declaredHash = response.headers.get("x-content-sha256");
  if (declaredHash === null || declaredHash !== actualArtifactHash) {
    throw new CliFailure(7, "ARTIFACT_HASH_MISMATCH", "downloaded artifact failed SHA-256 verification");
  }
  const zip = new AdmZip(Buffer.from(bytes));
  const metadataEntry = zip.getEntry("hunter-skill.json");
  if (metadataEntry === null || metadataEntry.isDirectory) {
    throw new CliFailure(7, "ARTIFACT_SCHEMA_INVALID", "artifact is missing required files");
  }
  const metadata = JSON.parse(metadataEntry.getData().toString("utf8")) as {
    slug: string;
    version: string;
    agent: string;
    target_path: string;
    source_sha256?: string;
    source_ir_sha256?: string;
    install_mode?: string;
  };
  // identity 校验 agent 与请求一致；target_path 提供 install 目录（folder=文件夹根，file=文件路径）。
  if (
    metadata.slug !== slug ||
    metadata.agent !== options.agent ||
    typeof metadata.target_path !== "string" ||
    metadata.target_path.length === 0
  ) {
    throw new CliFailure(7, "ARTIFACT_SCHEMA_INVALID", "artifact identity does not match request");
  }
  // target_path 防逃逸：拦截绝对路径/驱动器前缀/.. 父段。folder 模式 target_path 以 / 结尾（如 .claude/skills/<slug>/）。
  // 按路径片段判断 ".."，避免误伤含 ".." 的合法文件名（如 notes..v1.md）。
  if (
    metadata.target_path.split(/[/\\]/).some((seg) => seg === "..") ||
    /^[a-zA-Z]:/.test(metadata.target_path) ||
    metadata.target_path.startsWith("/")
  ) {
    throw new CliFailure(7, "ARTIFACT_PATH_INVALID", "artifact target path is unsafe");
  }

  // 收集 zip 内全部源文件（hunter-skill.json 除外），保留相对目录结构。
  // folder 模式全部落地；file 模式只装 entry；zip-slip 防御与 server DANGEROUS_PATH 对齐。
  const sourceFiles: SourceFile[] = [];
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

  // source hash 校验：优先 source_sha256（新），回退 source_ir_sha256（旧 zip 兼容）；均缺则跳过（极旧 zip）。
  // 与 server buildArtifactFor / core computeSourceHash 同算法：sorted by path → canonicalJson → sha256。
  const computedSourceHash = sha256(Buffer.from(canonicalJson(
    [...sourceFiles].sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => ({ path: f.path, content: f.content }))
  ), "utf8"));
  const declaredSourceHash = metadata.source_sha256 ?? metadata.source_ir_sha256;
  if (declaredSourceHash !== undefined && declaredSourceHash !== computedSourceHash) {
    throw new CliFailure(7, "ARTIFACT_HASH_MISMATCH", "artifact source files failed SHA-256 verification");
  }

  // install mode：manifest 显式提供则用，否则按 target_path 尾部分隔符推断（folder=/结尾，file=其余）。
  const installMode = metadata.install_mode ??
    (/(?:[\\/])$/.test(metadata.target_path) ? "folder" : "file");

  // folder 模式：installRoot=target_path 文件夹根，装全部文件（保留目录结构，references/scripts 一起落地）；
  // file 模式：installRoot=dirname(target_path)，只装 entry（basename）。
  let installRoot: string;
  let filesToInstall: Array<{ name: string; bytes: Buffer }>;
  let manifestFiles: Record<string, string>;
  let primaryName: string | null = null; // file 模式 = filename（unmanaged 检查用）；folder 模式 = null
  if (installMode === "folder") {
    installRoot = join(dependencies.cwd, metadata.target_path);
    filesToInstall = sourceFiles.map((f) => ({ name: f.path, bytes: Buffer.from(f.content, "utf8") }));
    manifestFiles = Object.fromEntries(
      sourceFiles.map((f) => [f.path, sha256(Buffer.from(f.content, "utf8"))])
    );
  } else {
    const filename = metadata.target_path.split(/[/\\]/).at(-1);
    if (filename === undefined || filename === "") {
      throw new CliFailure(7, "ARTIFACT_PATH_INVALID", "artifact target path has no filename");
    }
    // file 模式 entry：优先精确匹配 basename，回退以 /<basename> 结尾（兼容 zip 内带前缀目录）。
    const entry = sourceFiles.find((f) => f.path === filename) ??
      sourceFiles.find((f) => f.path.endsWith("/" + filename));
    if (entry === undefined) {
      throw new CliFailure(7, "ARTIFACT_SCHEMA_INVALID", "artifact is missing required files");
    }
    installRoot = join(dependencies.cwd, dirname(metadata.target_path));
    filesToInstall = [{ name: filename, bytes: Buffer.from(entry.content, "utf8") }];
    manifestFiles = { [filename]: sha256(Buffer.from(entry.content, "utf8")) };
    primaryName = filename;
  }

  const manifestPath = join(
    dependencies.cwd, ".harness", "state", "local", "skill-installs", slug + ".json"
  );
  const existing = await readManifest(manifestPath);
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
    dependencies.stdout(JSON.stringify({ ok: true, action: "noop", slug, version: metadata.version }) + "\n");
    return;
  }
  await atomicInstall({ target: installRoot, files: filesToInstall });
  const manifest: InstallManifest = {
    schema_version: 1,
    slug,
    version: metadata.version,
    agent: options.agent as RegistryAgent,
    source_url: serverUrl,
    artifact_sha256: actualArtifactHash,
    files: manifestFiles,
    installed_at: new Date().toISOString()
  };
  await mkdir(dirname(manifestPath), { recursive: true });
  const manifestTemp = manifestPath + ".tmp-" + randomUUID();
  await writeFile(manifestTemp, JSON.stringify(manifest, null, 2) + "\n");
  await rename(manifestTemp, manifestPath);
  dependencies.stdout(JSON.stringify({ ok: true, action: existing === null ? "installed" : "updated", slug, version: metadata.version }) + "\n");
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
  dependencies: Required<SkillCliDependencies>
): Promise<void> {
  if (!UPLOADABLE_AGENTS.has(options.agent as RegistryAgent)) {
    throw new CliFailure(3, "ADAPTER_UNSUPPORTED", "upload supports claude-code, cursor, codex and generic only");
  }
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
    `${serverUrl}/api/v1/skills/draft?agent=${encodeURIComponent(options.agent)}`,
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
  const dependencies: Required<SkillCliDependencies> = {
    cwd: overrides.cwd ?? process.cwd(),
    env: overrides.env ?? process.env,
    fetch: overrides.fetch ?? globalThis.fetch,
    stdout: overrides.stdout ?? ((value) => process.stdout.write(value)),
    stderr: overrides.stderr ?? ((value) => process.stderr.write(value))
  };
  const program = new Command()
    .name("hunter-harness-skill")
    .description("Install or upload governed Hunter Harness skills")
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({ writeOut: dependencies.stdout, writeErr: dependencies.stderr });
  const addOptions = (command: Command) => command
    .requiredOption("--agent <agent>")
    .option("--server-url <url>")
    .option("--token-env <ENV_NAME>")
    .option("--json");
  addOptions(program.command("install <skill-slug>"))
    .option("--force", "confirm overwrite of a locally modified installed skill")
    .action(async (slug: string, options: CommonOptions) => runInstall(slug, options, dependencies));
  addOptions(program.command("upload <skill-directory-or-zip>"))
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
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await runSkillCli(process.argv);
}
