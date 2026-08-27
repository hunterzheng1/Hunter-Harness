import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * 合成 mini bundle resourcesRoot：每 profile×agent 只投影 2-3 个文件，
 * 覆盖各用例断言的全部路径（harness-review/SKILL.md、agents/harness-reviewer.md、
 * java profile 追加 harness-apidoc/SKILL.md）。init/refresh/freshness 的布局、
 * 幂等、哈希与验证语义都和 bundle 文件数无关，文件越少 I/O 越少；
 * 真实 718 文件 bundle 的端到端保真由 initialize.test.ts 的
 * “installs all four agents”及 bundle-content-projection 等用例承担。
 */
const GENERAL_FILES: ReadonlyArray<readonly [string, string]> = [
  [
    "harness-review/SKILL.md",
    "---\nname: harness-review\ndescription: mini\n---\n# harness-review\n"
  ],
  ["agents/harness-reviewer.md", "# harness-reviewer\n"],
  ["agents/harness-explorer.md", "# harness-explorer\n"],
  // freshness 用例断言 coreHash 必须填充自 .harness-build.json marker
  [".harness-build.json", JSON.stringify({ coreHash: "mini-core-hash-0001" }) + "\n"]
];

const JAVA_FILES: ReadonlyArray<readonly [string, string]> = [
  ...GENERAL_FILES,
  [
    "harness-apidoc/SKILL.md",
    "---\nname: harness-apidoc\ndescription: mini\n---\n# harness-apidoc\n"
  ]
];

const MINI_AGENTS = ["claude-code", "codex", "cursor", "codebuddy", "pi"] as const;

let miniRoot: string | undefined;

export async function miniResources(): Promise<string> {
  if (miniRoot !== undefined) return miniRoot;
  const dir = await mkdtemp(join(tmpdir(), "hunter-mini-res-"));
  for (const profile of ["general", "java"] as const) {
    const files = profile === "java" ? JAVA_FILES : GENERAL_FILES;
    for (const agent of MINI_AGENTS) {
      const bundleDir = join(dir, "harness", "bundles", profile, agent);
      const manifestFiles: Array<{ path: string; sha256: string }> = [];
      for (const [path, content] of files) {
        await mkdir(dirname(join(bundleDir, path)), { recursive: true });
        await writeFile(join(bundleDir, path), content);
        manifestFiles.push({
          path,
          sha256: createHash("sha256").update(content).digest("hex")
        });
      }
      await mkdir(join(dir, "harness", "manifests", profile), { recursive: true });
      await writeFile(
        join(dir, "harness", "manifests", profile, `${agent}.json`),
        JSON.stringify(
          {
            schema_version: 2,
            profile,
            adapter: agent,
            bundle_version: "0.0.0-mini",
            generator: "harness_deploy.py",
            files: manifestFiles
          },
          null,
          2
        ) + "\n"
      );
    }
  }
  miniRoot = dir;
  return dir;
}
