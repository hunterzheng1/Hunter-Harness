import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { isAllowedServerUrl } from "@hunter-harness/contracts";

/**
 * 用户级平台偏好：记住最近一次成功 connect 的平台地址，作为下次绑定提示的
 * 默认值（回车即采用）。存储位置与恢复存储同一约定（Windows LOCALAPPDATA，
 * 其余 XDG state），可用 HUNTER_HARNESS_USER_STATE_ROOT 覆盖（测试接缝）。
 * 读取/写入失败一律静默——这是体验优化，不得影响主流程。
 */

const FILE_NAME = "last-server.json";

export function resolveUserStateRoot(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform = process.platform,
  userHome = homedir()
): string {
  const override = env.HUNTER_HARNESS_USER_STATE_ROOT?.trim();
  if (override !== undefined && override !== "") return resolve(override);
  if (platform === "win32") {
    return join(
      env.LOCALAPPDATA?.trim() || join(userHome, "AppData", "Local"),
      "HunterHarness"
    );
  }
  return join(
    env.XDG_STATE_HOME?.trim() || join(userHome, ".local", "state"),
    "hunter-harness"
  );
}

export async function readLastServerUrl(
  env: Readonly<Record<string, string | undefined>>
): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(join(resolveUserStateRoot(env), FILE_NAME), "utf8")
    ) as { server_url?: unknown };
    const url = parsed?.server_url;
    return typeof url === "string" && isAllowedServerUrl(url) ? url : undefined;
  } catch {
    return undefined;
  }
}

export async function writeLastServerUrl(
  serverUrl: string,
  env: Readonly<Record<string, string | undefined>>
): Promise<void> {
  try {
    if (!isAllowedServerUrl(serverUrl)) return;
    const root = resolveUserStateRoot(env);
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, FILE_NAME),
      JSON.stringify({ schema_version: 1, server_url: serverUrl }, null, 2) + "\n",
      "utf8"
    );
  } catch {
    // 偏好持久化失败不影响 connect 主流程。
  }
}
