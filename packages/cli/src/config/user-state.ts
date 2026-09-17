import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * 用户级状态根：recovery/ 等跨项目状态的存放位置（Windows LOCALAPPDATA，
 * 其余 XDG state），可用 HUNTER_HARNESS_USER_STATE_ROOT 覆盖（测试接缝）。
 */
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
