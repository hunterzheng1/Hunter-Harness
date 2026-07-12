import { execFile } from "node:child_process";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  fetch?: typeof globalThis.fetch;
  fetchWorkflowTarball?: (packageSpec: string) => Promise<Buffer>;
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

async function extractTarGzToDirectory(tarball: Buffer, destination: string): Promise<void> {
  const tarPath = join(destination, "package.tgz");
  const extractDir = join(destination, "extracted");
  await mkdir(extractDir, { recursive: true });
  await writeFile(tarPath, tarball);
  await new Promise<void>((resolve, reject) => {
    execFile("tar", ["-xzf", tarPath, "-C", extractDir], (error) => {
      if (error !== null) reject(error);
      else resolve();
    });
  });
  const packageDir = join(extractDir, "package");
  if (!(await pathExists(packageDir))) {
    throw new WorkflowDataResolutionError("工作流数据包结构无效：缺少 package/ 根目录", "WORKFLOW_DATA_INVALID", 7);
  }
  await cp(packageDir, destination, { recursive: true });
}

async function fetchNpmTarball(
  packageName: string,
  version: string,
  fetchImpl: typeof globalThis.fetch
): Promise<Buffer> {
  const metaResponse = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`);
  if (!metaResponse.ok) {
    throw new WorkflowDataResolutionError(
      `无法从 npm 获取工作流数据包 ${packageName}（registry 返回 ${metaResponse.status}）`,
      "WORKFLOW_DATA_NOT_FOUND"
    );
  }
  const packument = await metaResponse.json() as {
    "dist-tags"?: { latest?: string };
    versions?: Record<string, { dist?: { tarball?: string } }>;
  };
  const resolvedVersion = version === "latest"
    ? packument["dist-tags"]?.latest
    : version;
  if (resolvedVersion === undefined) {
    throw new WorkflowDataResolutionError(
      `工作流数据包 ${packageName} 没有可用版本`,
      "WORKFLOW_DATA_NOT_FOUND"
    );
  }
  const tarballUrl = packument.versions?.[resolvedVersion]?.dist?.tarball;
  if (tarballUrl === undefined) {
    throw new WorkflowDataResolutionError(
      `工作流数据包 ${packageName}@${resolvedVersion} 缺少 tarball`,
      "WORKFLOW_DATA_NOT_FOUND"
    );
  }
  const tarballResponse = await fetchImpl(tarballUrl);
  if (!tarballResponse.ok) {
    throw new WorkflowDataResolutionError(
      `下载工作流数据包失败：${packageName}@${resolvedVersion}`,
      "WORKFLOW_DATA_NETWORK"
    );
  }
  return Buffer.from(await tarballResponse.arrayBuffer());
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
  if (sibling !== null) return sibling;

  const monorepo = await monorepoResourcesRoot();
  if (monorepo !== null) return monorepo;

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
  if (await pathExists(join(cacheRoot, "harness", "manifests"))) return cacheRoot;

  const fetchImpl = options.fetch ?? globalThis.fetch;
  try {
    const tarball = options.fetchWorkflowTarball !== undefined
      ? await options.fetchWorkflowTarball(packageSpec)
      : await fetchNpmTarball(packageName, version, fetchImpl);
    await mkdir(cacheRoot, { recursive: true });
    await extractTarGzToDirectory(tarball, cacheRoot);
    if (!(await pathExists(join(cacheRoot, "harness", "manifests")))) {
      throw new WorkflowDataResolutionError(
        "工作流数据包内容无效：缺少 harness/manifests",
        "WORKFLOW_DATA_INVALID",
        7
      );
    }
    return cacheRoot;
  } catch (error) {
    if (error instanceof WorkflowDataResolutionError) throw error;
    throw new WorkflowDataResolutionError(
      "无法获取工作流数据包：无网络且本地缓存不存在。请先在有网络的环境运行 hunter-harness，或设置 HUNTER_HARNESS_RESOURCES_ROOT 指向含 harness/ 的目录。",
      "WORKFLOW_DATA_UNAVAILABLE"
    );
  }
}

export async function readWorkflowFamilyManifest(resourcesRoot: string): Promise<Record<string, unknown>> {
  const manifestPath = join(resourcesRoot, "hunter-workflow-family.json");
  if (!(await pathExists(manifestPath))) return {};
  return JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
}
