#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { skillIrSchema, type SkillIr } from "@hunter-harness/contracts";
import AdmZip from "adm-zip";
import { Command, CommanderError } from "commander";
import { parse as parseYaml } from "yaml";

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
  agent: "claude-code";
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
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        authorization: "Bearer " + token,
        "x-request-id": randomUUID(),
        ...(init.method === undefined || init.method === "GET" ? {} : {
          "idempotency-key": randomUUID(),
          "content-type": "application/json"
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
      if (file.name.includes("..") || file.name.startsWith("/") || file.name.includes("\\")) {
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
  if (options.agent !== "claude-code") {
    throw new CliFailure(3, "ADAPTER_UNSUPPORTED", "standalone install currently supports claude-code only");
  }
  const { serverUrl, token } = configuration(options, dependencies.env);
  const response = await request(
    dependencies.fetch,
    `${serverUrl}/api/v1/skills/${encodeURIComponent(slug)}/artifacts/claude-code/download`,
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
  const skillEntry = zip.getEntry("SKILL.md");
  if (metadataEntry === null || skillEntry === null || metadataEntry.isDirectory || skillEntry.isDirectory) {
    throw new CliFailure(7, "ARTIFACT_SCHEMA_INVALID", "artifact is missing required files");
  }
  const metadata = JSON.parse(metadataEntry.getData().toString("utf8")) as {
    slug: string; version: string; agent: string;
  };
  if (metadata.slug !== slug || metadata.agent !== "claude-code") {
    throw new CliFailure(7, "ARTIFACT_SCHEMA_INVALID", "artifact identity does not match request");
  }
  const target = join(dependencies.cwd, ".claude", "skills", slug);
  const manifestPath = join(
    dependencies.cwd, ".harness", "state", "local", "skill-installs", slug + ".json"
  );
  const existing = await readManifest(manifestPath);
  if (existing === null && await fileExists(target) && options.force !== true) {
    throw new CliFailure(5, "LOCAL_SKILL_UNMANAGED", "target skill already exists without a trusted install manifest; use --force to confirm overwrite");
  }
  if (existing !== null && await isDirty(target, existing) && options.force !== true) {
    throw new CliFailure(5, "LOCAL_SKILL_DIRTY", "local skill has uncommitted edits; use --force to confirm overwrite");
  }
  if (existing?.artifact_sha256 === actualArtifactHash && !(await isDirty(target, existing))) {
    dependencies.stdout(JSON.stringify({ ok: true, action: "noop", slug, version: metadata.version }) + "\n");
    return;
  }
  const skillBytes = skillEntry.getData();
  await atomicInstall({ target, files: [{ name: "SKILL.md", bytes: skillBytes }] });
  const manifest: InstallManifest = {
    schema_version: 1,
    slug,
    version: metadata.version,
    agent: "claude-code",
    source_url: serverUrl,
    artifact_sha256: actualArtifactHash,
    files: { "SKILL.md": sha256(skillBytes) },
    installed_at: new Date().toISOString()
  };
  await mkdir(dirname(manifestPath), { recursive: true });
  const manifestTemp = manifestPath + ".tmp-" + randomUUID();
  await writeFile(manifestTemp, JSON.stringify(manifest, null, 2) + "\n");
  await rename(manifestTemp, manifestPath);
  dependencies.stdout(JSON.stringify({ ok: true, action: existing === null ? "installed" : "updated", slug, version: metadata.version }) + "\n");
}

async function findSkillIr(source: string): Promise<SkillIr> {
  const sourceStat = await stat(source).catch(() => null);
  if (sourceStat === null) throw new CliFailure(3, "SOURCE_NOT_FOUND", "skill source does not exist");
  let content: string;
  let extension: string;
  if (sourceStat.isDirectory()) {
    const candidates = ["skill.yaml", "skill.yml", "skill.json", "hunter-skill-ir.json"];
    const found = (await Promise.all(candidates.map(async (name) =>
      await fileExists(join(source, name)) ? join(source, name) : null
    ))).find((value) => value !== null);
    if (found === undefined) throw new CliFailure(7, "SKILL_IR_MISSING", "directory has no canonical Skill IR file");
    content = await readFile(found, "utf8");
    extension = extname(found);
  } else if (extname(source).toLowerCase() === ".zip") {
    const zip = new AdmZip(source);
    const entry = zip.getEntries().find((item) =>
      !item.isDirectory && /(^|\/)(skill\.ya?ml|skill\.json|hunter-skill-ir\.json)$/i.test(item.entryName)
    );
    if (entry === undefined || entry.entryName.includes("..")) {
      throw new CliFailure(7, "SKILL_IR_MISSING", "ZIP has no safe canonical Skill IR file");
    }
    content = entry.getData().toString("utf8");
    extension = extname(entry.entryName);
  } else {
    content = await readFile(source, "utf8");
    extension = extname(source);
  }
  try {
    return skillIrSchema.parse(extension.toLowerCase() === ".json" ? JSON.parse(content) : parseYaml(content));
  } catch {
    throw new CliFailure(7, "SKILL_IR_INVALID", "canonical Skill IR failed schema validation");
  }
}

async function runUpload(
  sourceValue: string,
  options: CommonOptions,
  dependencies: Required<SkillCliDependencies>
): Promise<void> {
  if (options.agent !== "claude-code") {
    throw new CliFailure(3, "ADAPTER_UNSUPPORTED", "upload validation currently targets claude-code only");
  }
  const { serverUrl, token } = configuration(options, dependencies.env);
  const ir = await findSkillIr(resolve(dependencies.cwd, sourceValue));
  const response = await request(dependencies.fetch, `${serverUrl}/api/v1/skill-proposals`, token, {
    method: "POST",
    body: JSON.stringify({ schema_version: 1, skill_ir: ir, agent: options.agent })
  });
  const body = await response.json() as Record<string, unknown>;
  dependencies.stdout(JSON.stringify({ ok: true, action: "proposal-created", ...body }) + "\n");
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
