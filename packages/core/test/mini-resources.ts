import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * 合成 mini bundle resourcesRoot（v1.0 扁平布局）：每个 projection surface
 * 只投影 3 个文件，覆盖各用例断言的全部路径（harness-review/SKILL.md、
 * harness-explorer/SKILL.md、.harness-build.json 的 coreHash marker）。
 * init/refresh/freshness 的布局、幂等、哈希与验证语义都和 bundle 文件数无关，
 * 文件越少 I/O 越少；真实 bundle 的端到端保真由 initialize.test.ts 的
 * 真实资源用例及 bundle-content-projection 等用例承担。
 */
const SURFACE_FILES: ReadonlyArray<readonly [string, string]> = [
  [
    "harness-review/SKILL.md",
    "---\nname: harness-review\ndescription: mini\n---\n# harness-review\n"
  ],
  [
    "harness-explorer/SKILL.md",
    "---\nname: harness-explorer\ndescription: mini\n---\n# harness-explorer\n"
  ],
  // freshness 用例断言 coreHash 必须填充自 .harness-build.json marker
  [".harness-build.json", JSON.stringify({ coreHash: "mini-core-hash-0001" }) + "\n"]
];

const MINI_SURFACES = ["codex", "codebuddy"] as const;

let miniRoot: string | undefined;

export async function miniResources(): Promise<string> {
  if (miniRoot !== undefined) return miniRoot;
  const dir = await mkdtemp(join(tmpdir(), "hunter-mini-res-"));
  await mkdir(join(dir, "harness", "manifests"), { recursive: true });
  for (const surface of MINI_SURFACES) {
    const bundleDir = join(dir, "harness", "bundles", surface);
    const manifestFiles: Array<{ path: string; sha256: string }> = [];
    for (const [path, content] of SURFACE_FILES) {
      await mkdir(dirname(join(bundleDir, path)), { recursive: true });
      await writeFile(join(bundleDir, path), content);
      manifestFiles.push({
        path,
        sha256: createHash("sha256").update(content).digest("hex")
      });
    }
    await writeFile(
      join(dir, "harness", "manifests", `${surface}.json`),
      JSON.stringify(
        {
          schema_version: 2,
          profile: "general",
          adapter: surface,
          bundle_version: "0.0.0-mini",
          generator: "harness_deploy.py",
          files: manifestFiles
        },
        null,
        2
      ) + "\n"
    );
  }
  miniRoot = dir;
  return dir;
}
