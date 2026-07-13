import { cp, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "@hunter-harness/contracts";
import { sha256Bytes } from "@hunter-harness/core";

export class WorkflowDataResolutionError extends Error {
  readonly code: string;
  readonly exitCode: 4 | 7;

  constructor(message: string, code = "WORKFLOW_DATA_UNAVAILABLE", exitCode: 4 | 7 = 4) {
    super(message);
    this.name = "WorkflowDataResolutionError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export interface ResolveWorkflowDataOptions {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  override?: string | undefined;
  workflowFamily?: string | undefined;
  workflowVersion?: string | undefined;
  /** 测试注入：覆盖 pacote.extract */
  pacoteExtract?: (spec: string, destination: string) => Promise<void>;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function readOption(argv: readonly string[], name: string): string | undefined {
  const flag = `--${name}`;
  const index = argv.indexOf(flag);
  if (index >= 0) return argv[index + 1];
  const prefixed = argv.find((value) => value.startsWith(`${flag}=`));
  if (prefixed !== undefined) return prefixed.slice(flag.length + 1);
  return undefined;
}

export function workflowPackageName(
  family: string,
  env: Readonly<Record<string, string | undefined>>
): string {
  const scope = (env.HUNTER_HARNESS_NPM_SCOPE ?? "@hunter-harness").replace(/\/$/, "");
  if (family === "harness") return `${scope}/workflow-harness`;
  return `${scope}/workflow-${family}`;
}

async function listFilesRecursive(root: string, base = root): Promise<Array<{ path: string; content: string }>> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: Array<{ path: string; content: string }> = [];
  for (const entry of entries) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(absolute, base));
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = relative(base, absolute).replaceAll("\\", "/");
    files.push({ path: rel, content: await readFile(absolute, "utf8") });
  }
  return files;
}

function sha256Canonical(files: Array<{ path: string; content: string }>): string {
  return sha256Bytes(canonicalJson(
    [...files]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({ path: file.path, content: file.content }))
  ));
}

/** 校验 hunter-workflow-family.json 中的 content_sha256（若存在）。 */
export async function verifyWorkflowPackageIntegrity(resourcesRoot: string): Promise<void> {
  const manifest = await readWorkflowFamilyManifest(resourcesRoot);
  const expected = manifest.content_sha256;
  if (typeof expected !== "string" || expected.length === 0) return;
  const harnessRoot = join(resourcesRoot, "harness");
  if (!(await pathExists(harnessRoot))) {
    throw new WorkflowDataResolutionError(
      "工作流数据包缺少 harness/，无法校验 SHA-256",
      "WORKFLOW_DATA_INTEGRITY",
      7
    );
  }
  const files = await listFilesRecursive(harnessRoot, resourcesRoot);
  const actual = sha256Canonical(files);
  if (actual !== expected) {
    throw new WorkflowDataResolutionError(
      `工作流数据包 SHA-256 校验失败（期望 ${expected}，实际 ${actual}）`,
      "WORKFLOW_DATA_INTEGRITY",
      7
    );
  }
}

async function monorepoResourcesRoot(): Promise<string | null> {
  const candidates = [
    fileURLToPath(new URL("../../../resources", import.meta.url)),
    fileURLToPath(new URL("../../../workflow-data-harness", import.meta.url)),
    fileURLToPath(new URL("../../../../resources", import.meta.url))
  ];
  for (const candidate of candidates) {
    if (await pathExists(join(candidate, "harness", "manifests"))) return candidate;
  }
  return null;
}

async function siblingWorkflowPackage(cwd: string): Promise<string | null> {
  const candidates = [
    join(cwd, "node_modules", "@hunter-harness", "workflow-harness"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "workflow-data-harness")
  ];
  for (const candidate of candidates) {
    if (await pathExists(join(candidate, "harness", "manifests"))) return candidate;
  }
  return null;
}

export async function resolveWorkflowResourcesRoot(
  options: ResolveWorkflowDataOptions,
  argv: readonly string[] = []
): Promise<string> {
  if (options.override !== undefined) return options.override;

  const envRoot = options.env.HUNTER_HARNESS_RESOURCES_ROOT?.trim();
  if (envRoot !== undefined && envRoot.length > 0) return envRoot;

  const sibling = await siblingWorkflowPackage(options.cwd);
  if (sibling !== null) {
    await verifyWorkflowPackageIntegrity(sibling);
    return sibling;
  }

  const monorepo = await monorepoResourcesRoot();
  if (monorepo !== null) {
    await verifyWorkflowPackageIntegrity(monorepo);
    return monorepo;
  }

  const family = options.workflowFamily
    ?? readOption(argv, "workflow-family")
    ?? options.env.HUNTER_HARNESS_WORKFLOW_FAMILY
    ?? "harness";
  const version = options.workflowVersion
    ?? readOption(argv, "workflow-version")
    ?? options.env.HUNTER_HARNESS_WORKFLOW_VERSION
    ?? "latest";
  const packageName = workflowPackageName(family, options.env);
  const packageSpec = version === "latest" ? packageName : `${packageName}@${version}`;
  const cacheKey = packageSpec.replace("/", "+");
  const cacheRoot = join(options.cwd, ".harness", "cache", "workflow-packages", cacheKey);
  if (await pathExists(join(cacheRoot, "harness", "manifests"))) {
    await verifyWorkflowPackageIntegrity(cacheRoot);
    return cacheRoot;
  }

  try {
    await mkdir(cacheRoot, { recursive: true });
    const extract = options.pacoteExtract ?? (async (spec: string, destination: string) => {
      const pacote = await import("pacote");
      await pacote.default.extract(spec, destination);
    });
    const staging = join(cacheRoot, ".extract");
    await mkdir(staging, { recursive: true });
    await extract(packageSpec, staging);
    // pacote 解压到 destination，内容在根或 package/ 下
    const packageDir = (await pathExists(join(staging, "harness", "manifests")))
      ? staging
      : join(staging, "package");
    if (!(await pathExists(join(packageDir, "harness", "manifests")))) {
      throw new WorkflowDataResolutionError(
        "工作流数据包内容无效：缺少 harness/manifests",
        "WORKFLOW_DATA_INVALID",
        7
      );
    }
    await cp(packageDir, cacheRoot, { recursive: true });
    await verifyWorkflowPackageIntegrity(cacheRoot);
    return cacheRoot;
  } catch (error) {
    if (error instanceof WorkflowDataResolutionError) throw error;
    throw new WorkflowDataResolutionError(
      describeWorkflowDataFetchFailure(error, packageSpec),
      "WORKFLOW_DATA_UNAVAILABLE"
    );
  }
}

/** 将 pacote/网络等底层失败转成可读中文说明（不再笼统写成「无网络」）。 */
export function describeWorkflowDataFetchFailure(error: unknown, packageSpec: string): string {
  const detailRaw = error instanceof Error ? error.message : String(error);
  const detail = detailRaw.length > 240 ? detailRaw.slice(0, 240) + "…" : detailRaw;
  const code = error !== null && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
  const hintRoot = "设置 HUNTER_HARNESS_RESOURCES_ROOT 指向含 harness/ 的目录";

  if (
    code === "ERR_MODULE_NOT_FOUND" ||
    /Cannot find package ['"]pacote['"]/i.test(detailRaw)
  ) {
    return (
      `无法获取工作流数据包 ${packageSpec}：缺少可选依赖 pacote（npx/npm 安装 CLI 时未装上）。` +
      `请重装 hunter-harness，或${hintRoot}。原因：${detail}`
    );
  }

  if (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "ECONNREFUSED" ||
    /ECONNRESET|ETIMEDOUT|socket disconnected|TLS connection/i.test(detailRaw)
  ) {
    return (
      `无法获取工作流数据包 ${packageSpec}：从 npm 下载失败（网络/TLS）。` +
      `可先设置 NODE_OPTIONS=--dns-result-order=ipv4first 后重试，或${hintRoot}。` +
      `原因：${code !== "" ? code + " " : ""}${detail}`
    );
  }

  if (code === "E404" || /\b404\b|Not Found/i.test(detailRaw)) {
    return (
      `无法获取工作流数据包 ${packageSpec}：npm 上找不到该包或无权访问。` +
      `请确认已发布对应 scope 的 workflow 数据包，或${hintRoot}。原因：${detail}`
    );
  }

  return (
    `无法获取工作流数据包 ${packageSpec}：本地缓存不存在且获取失败。可${hintRoot}。` +
    `原因：${code !== "" ? code + " " : ""}${detail}`
  );
}

export async function readWorkflowFamilyManifest(resourcesRoot: string): Promise<Record<string, unknown>> {
  const manifestPath = join(resourcesRoot, "hunter-workflow-family.json");
  if (!(await pathExists(manifestPath))) return {};
  return JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
}
