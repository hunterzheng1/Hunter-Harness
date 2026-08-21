/**
 * capabilities 真实化探针：从真实仓库状态取 is_git / has_remote / uses_worktree。
 *
 * 此前 plan evidence-pack 把三者写死（is_git:true, has_remote:true,
 * uses_worktree:false），阶段 0.6 的 plannedPhases 与真实仓库状态被完全忽略。
 * 只用 node:child_process 的 execFile——三个布尔探针只需 3~4 条只读命令，
 * 不引入 simple-git 等新依赖（CLI 以 esbuild 打单文件 bundle）。
 *
 * 任一调用失败（git 不在 PATH、目录不是仓库）→ unavailable，三值全 false，
 * 满足 planCapabilitiesSchema 的 `!is_git ⇒ has_remote/uses_worktree 全 false` 约束。
 */

import { execFile } from "node:child_process";
import { resolve } from "node:path";

export interface GitCapabilitiesProbe {
  readonly is_git: boolean;
  readonly has_remote: boolean;
  readonly uses_worktree: boolean;
  readonly provenance: "probe" | "unavailable";
}

export type GitExec = (args: readonly string[], cwd: string) => Promise<string>;

/** 生产实现：同步语义包装成 Promise；测试注入假实现，不碰真实 git。 */
export function createGitExec(): GitExec {
  return (args, cwd) =>
    new Promise((resolvePromise, reject) => {
      execFile("git", [...args], { cwd, encoding: "utf8" }, (error, stdout) => {
        if (error) {
          reject(error);
        } else {
          resolvePromise(stdout);
        }
      });
    });
}

const UNAVAILABLE: GitCapabilitiesProbe = {
  is_git: false,
  has_remote: false,
  uses_worktree: false,
  provenance: "unavailable"
};

function resolveGitPath(cwd: string, gitPath: string): string {
  // --git-dir / --git-common-dir 可能返回相对路径（如 ".git"），先按 cwd resolve 再比。
  return gitPath.startsWith(".") ? resolve(cwd, gitPath) : gitPath;
}

export async function probeGitCapabilities(
  cwd: string,
  exec: GitExec = createGitExec()
): Promise<GitCapabilitiesProbe> {
  try {
    const inside = (await exec(["rev-parse", "--is-inside-work-tree"], cwd)).trim();
    if (inside !== "true") return UNAVAILABLE;
    const remotes = (await exec(["remote"], cwd)).trim();
    const gitDir = (await exec(["rev-parse", "--git-dir"], cwd)).trim();
    const commonDir = (await exec(["rev-parse", "--git-common-dir"], cwd)).trim();
    // worktree 的 --git-dir 指向 <common>/.git/worktrees/<name>，与 --git-common-dir 不同。
    const usesWorktree = resolveGitPath(cwd, gitDir) !== resolveGitPath(cwd, commonDir);
    return {
      is_git: true,
      has_remote: remotes.length > 0,
      uses_worktree: usesWorktree,
      provenance: "probe"
    };
  } catch {
    return UNAVAILABLE;
  }
}
