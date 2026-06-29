import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractManagedBlock,
  readBaseline,
  sha256Bytes,
  updateProject,
  writeBaseline
} from "@hunter-harness/core";
import { canonicalJson, type BaselineManifest } from "@hunter-harness/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/bin.js";

const resourcesRoot = fileURLToPath(
  new URL("../../../resources/bootstrap-ir", import.meta.url)
);

function artifact(
  files: unknown[],
  projectVersion = "pv_1",
  artifactId = "art_1"
) {
  const payload = {
    schema_version: 1,
    project_id: "prj_update",
    project_version: projectVersion,
    artifact_id: artifactId,
    files
  };
  return { ...payload, manifest_sha256: sha256Bytes(canonicalJson(payload)) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("hunter-harness update", () => {
  let root: string;
  let stdout: string[];
  let stderr: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hunter-update-"));
    stdout = [];
    stderr = [];
    const configPath = join(root, "init.json");
    await writeFile(configPath, JSON.stringify({
      adapter: "claude-code",
      profile: "java",
      server_url: "https://server.example.test",
      token_env: "TEST_HUNTER_TOKEN",
      project_id: "prj_update"
    }));
    expect(await runCli([
      "--config", configPath, "--non-interactive", "--yes"
    ], {
      cwd: root,
      resourcesRoot,
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(0);
  });

  async function pathExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  function fetchFor(manifest: ReturnType<typeof artifact>, blobs: Record<string, string>) {
    return vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname.endsWith("/update-manifest")) {
        return json({
          schema_version: 1,
          project_id: "prj_update",
          observed_project_version: manifest.project_version,
          artifact_id: manifest.artifact_id,
          artifact_manifest_url: "/api/v1/artifacts/" + manifest.artifact_id + "/manifest",
          delta_available: true,
          request_id: "req"
        });
      }
      if (url.pathname.endsWith("/manifest")) {
        return json(manifest);
      }
      if (url.pathname.includes("/blobs/")) {
        const hash = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
        const content = blobs[hash] ?? "";
        return new Response(content, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "X-Content-SHA256": hash,
            "X-Request-Id": "req"
          }
        });
      }
      throw new Error("unexpected URL " + url);
    });
  }

  async function seedBaseline(contents: Record<string, string>): Promise<BaselineManifest> {
    const baseline = await readBaseline(root);
    for (const [path, content] of Object.entries(contents)) {
      await writeFile(join(root, path), content);
      baseline.files[path] = {
        baseline_hash: sha256Bytes(content),
        local_hash_at_apply: sha256Bytes(content),
        file_kind: path.includes("codebase/map")
          ? "generated_reviewable"
          : "user_editable",
        last_applied_version: "pv_0",
        deleted: false
      };
    }
    baseline.complete_project_version = "pv_0";
    await writeBaseline(root, baseline);
    return baseline;
  }

  it("applies mixed add, modify, delete, and rename in one transaction", async () => {
    const before = {
      ".harness/knowledge/modify.md": "modify-old\n",
      ".harness/knowledge/delete.md": "delete-old\n",
      ".harness/knowledge/old-name.md": "rename-old\n"
    };
    await seedBaseline(before);
    const added = "added\n";
    const modified = "modify-new\n";
    const renamed = before[".harness/knowledge/old-name.md"];
    const manifest = artifact([
      {
        operation: "add",
        path: ".harness/knowledge/added.md",
        file_kind: "user_editable",
        content_sha256: sha256Bytes(added),
        size_bytes: Buffer.byteLength(added)
      },
      {
        operation: "modify",
        path: ".harness/knowledge/modify.md",
        file_kind: "user_editable",
        base_content_sha256: sha256Bytes(before[".harness/knowledge/modify.md"]),
        content_sha256: sha256Bytes(modified),
        size_bytes: Buffer.byteLength(modified)
      },
      {
        operation: "delete",
        path: ".harness/knowledge/delete.md",
        file_kind: "user_editable",
        base_content_sha256: sha256Bytes(before[".harness/knowledge/delete.md"]),
        tombstone: {
          deleted_at: "2026-06-20T00:00:00Z",
          reason: "approved removal",
          previous_sha256: sha256Bytes(before[".harness/knowledge/delete.md"])
        }
      },
      {
        operation: "rename",
        from_path: ".harness/knowledge/old-name.md",
        to_path: ".harness/knowledge/new-name.md",
        file_kind: "user_editable",
        base_content_sha256: sha256Bytes(renamed),
        content_sha256: sha256Bytes(renamed),
        size_bytes: Buffer.byteLength(renamed)
      }
    ]);
    const fetch = fetchFor(manifest, {
      [sha256Bytes(added)]: added,
      [sha256Bytes(modified)]: modified,
      [sha256Bytes(renamed)]: renamed
    });
    const code = await runCli(["update", "--non-interactive", "--yes", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch,
      env: { TEST_HUNTER_TOKEN: "api-token" },
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });
    expect(code).toBe(0);
    expect(await readFile(join(root, ".harness/knowledge/added.md"), "utf8")).toBe(added);
    expect(await readFile(join(root, ".harness/knowledge/modify.md"), "utf8")).toBe(modified);
    expect(await pathExists(join(root, ".harness/knowledge/delete.md"))).toBe(false);
    expect(await pathExists(join(root, ".harness/knowledge/old-name.md"))).toBe(false);
    expect(await readFile(join(root, ".harness/knowledge/new-name.md"), "utf8")).toBe(renamed);
    expect((await readBaseline(root)).complete_project_version).toBe("pv_1");
  });

  it("skips dirty files, applies eligible files, and leaves complete version unchanged", async () => {
    const rulePath = ".claude/rules/harness-general.md";
    const skillPath = ".claude/skills/harness-review/SKILL.md";
    const deletePath = ".harness/knowledge/dirty-delete.md";
    const originalRule = await readFile(join(root, rulePath), "utf8");
    const originalSkill = await readFile(join(root, skillPath), "utf8");
    const originalDelete = "delete baseline\n";
    await seedBaseline({
      [rulePath]: originalRule,
      [skillPath]: originalSkill,
      [deletePath]: originalDelete
    });
    await writeFile(join(root, rulePath), originalRule + "local edit\n");
    await writeFile(join(root, deletePath), originalDelete + "local edit\n");
    const serverRule = originalRule + "server edit\n";
    const serverSkill = originalSkill + "server edit\n";
    const manifest = artifact([rulePath, skillPath].map((path) => ({
      operation: "modify",
      path,
      file_kind: "user_editable",
      base_content_sha256: sha256Bytes(path === rulePath ? originalRule : originalSkill),
      content_sha256: sha256Bytes(path === rulePath ? serverRule : serverSkill),
      size_bytes: Buffer.byteLength(path === rulePath ? serverRule : serverSkill)
    })).concat([{
      operation: "delete",
      path: deletePath,
      file_kind: "user_editable",
      base_content_sha256: sha256Bytes(originalDelete),
      tombstone: {
        deleted_at: "2026-06-20T00:00:00Z",
        reason: "approved removal",
        previous_sha256: sha256Bytes(originalDelete)
      }
    }]));
    const code = await runCli(["update", "--non-interactive", "--yes", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch: fetchFor(manifest, {
        [sha256Bytes(serverRule)]: serverRule,
        [sha256Bytes(serverSkill)]: serverSkill
      }),
      env: { TEST_HUNTER_TOKEN: "api-token" },
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });
    expect(code).toBe(5);
    expect(await readFile(join(root, rulePath), "utf8")).toContain("local edit");
    expect(await readFile(join(root, deletePath), "utf8")).toContain("local edit");
    expect(await readFile(join(root, skillPath), "utf8")).toBe(serverSkill);
    const baseline = await readBaseline(root);
    expect(baseline.complete_project_version).toBe("pv_0");
    expect(baseline.files[rulePath]?.baseline_hash).toBe(sha256Bytes(originalRule));
    expect(baseline.files[skillPath]?.baseline_hash).toBe(sha256Bytes(serverSkill));
  });

  it("updates only the managed block and preserves user-authored guidance", async () => {
    const path = "CLAUDE.md";
    const original = await readFile(join(root, path), "utf8");
    const baseline = await seedBaseline({ [path]: original });
    const block = extractManagedBlock(original) ?? "";
    const baselineEntry = baseline.files[path];
    if (baselineEntry === undefined) {
      throw new Error("test baseline entry was not created");
    }
    baseline.files[path] = {
      ...baselineEntry,
      managed_block_hash: sha256Bytes(block)
    };
    await writeBaseline(root, baseline);
    await writeFile(join(root, path), "# User guidance\nKeep this.\n\n" + original);
    const incoming = original.replace("# Hunter Harness", "# Hunter Harness Updated");
    const manifest = artifact([{
      operation: "modify",
      path,
      file_kind: "user_editable",
      base_content_sha256: sha256Bytes(original),
      content_sha256: sha256Bytes(incoming),
      size_bytes: Buffer.byteLength(incoming)
    }]);
    const code = await runCli(["update", "--non-interactive", "--yes"], {
      cwd: root,
      resourcesRoot,
      fetch: fetchFor(manifest, { [sha256Bytes(incoming)]: incoming }),
      env: { TEST_HUNTER_TOKEN: "api-token" },
      stdout: () => undefined,
      stderr: () => undefined
    });
    expect(code).toBe(0);
    const result = await readFile(join(root, path), "utf8");
    expect(result).toContain("# User guidance\nKeep this.");
    expect(result).toContain("# Hunter Harness Updated");
  });

  it("keeps dry-run write-free and rejects corrupt blobs", async () => {
    const content = "approved content\n";
    const path = ".harness/knowledge/dry.md";
    const manifest = artifact([{
      operation: "add",
      path,
      file_kind: "user_editable",
      content_sha256: sha256Bytes(content),
      size_bytes: Buffer.byteLength(content)
    }]);
    const fetch = fetchFor(manifest, { [sha256Bytes(content)]: content });
    expect(await runCli(["update", "--dry-run", "--non-interactive"], {
      cwd: root,
      resourcesRoot,
      fetch,
      env: { TEST_HUNTER_TOKEN: "api-token" },
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(0);
    expect(await pathExists(join(root, path))).toBe(false);
    expect(await pathExists(join(
      root, ".harness/cache/server-artifacts/art_1/manifest.json"
    ))).toBe(false);

    const corruptFetch = fetchFor(manifest, { [sha256Bytes(content)]: "corrupt" });
    expect(await runCli(["update", "--non-interactive", "--yes"], {
      cwd: root,
      resourcesRoot,
      fetch: corruptFetch,
      env: { TEST_HUNTER_TOKEN: "api-token" },
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(4);
    expect(await pathExists(join(root, path))).toBe(false);
  });

  it("recovers byte-for-byte when interrupted after baseline write", async () => {
    const content = "interrupted artifact\n";
    const path = ".harness/knowledge/interrupted.md";
    const manifest = artifact([{
      operation: "add",
      path,
      file_kind: "user_editable",
      content_sha256: sha256Bytes(content),
      size_bytes: Buffer.byteLength(content)
    }], "pv_interrupt", "art_interrupt");
    const baselineBefore = await readFile(
      join(root, ".harness/state/baseline/manifest.json"), "utf8"
    );
    await expect(updateProject({
      projectRoot: root,
      env: { TEST_HUNTER_TOKEN: "api-token" },
      dryRun: false,
      fetch: fetchFor(manifest, { [sha256Bytes(content)]: content }),
      transactionOptions: { interruptAfterApply: 2 }
    })).rejects.toThrow(/interrupted/i);
    expect(await pathExists(join(root, path))).toBe(true);
    expect((await readBaseline(root)).complete_project_version).toBe("pv_interrupt");

    const answers = ["1"];
    expect(await runCli([], {
      cwd: root,
      resourcesRoot,
      prompt: async () => answers.shift() ?? "",
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(0);
    expect(await pathExists(join(root, path))).toBe(false);
    expect(await readFile(
      join(root, ".harness/state/baseline/manifest.json"), "utf8"
    )).toBe(baselineBefore);
  });

  it("applies managed-block modify with block_id to AGENTS.md as per-id block (T11)", async () => {
    const existing = "# Project agents\n\nexisting content\n";
    await seedBaseline({ "AGENTS.md": existing });
    const blockBody = "<!-- harness: adapter=codex source_ir_hash=sha256:abc compiler_version=1.0.0 -->\n# harness-review\ncodex skill body";
    const manifest = artifact([{
      operation: "modify",
      path: "AGENTS.md",
      file_kind: "user_editable",
      base_content_sha256: sha256Bytes(existing),
      content_sha256: sha256Bytes(blockBody),
      size_bytes: Buffer.byteLength(blockBody),
      block_id: "harness-skill-harness-review"
    }]);
    const fetch = fetchFor(manifest, { [sha256Bytes(blockBody)]: blockBody });
    expect(await runCli(["update", "--non-interactive", "--yes", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch,
      env: { TEST_HUNTER_TOKEN: "api-token" },
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(0);
    const result = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(result).toContain("<!-- hunter-harness:start id=harness-skill-harness-review -->");
    expect(result).toContain("<!-- hunter-harness:end id=harness-skill-harness-review -->");
    expect(result).toContain("# Project agents");
    expect(result).toContain("codex skill body");
  });

  it("applies managed-block modify without block_id using legacy marker (T11)", async () => {
    const existing = "# Project agents\n\nexisting\n";
    await seedBaseline({ "AGENTS.md": existing });
    const blockBody = "managed block content";
    const manifest = artifact([{
      operation: "modify",
      path: "AGENTS.md",
      file_kind: "user_editable",
      base_content_sha256: sha256Bytes(existing),
      content_sha256: sha256Bytes(blockBody),
      size_bytes: Buffer.byteLength(blockBody)
    }]);
    const fetch = fetchFor(manifest, { [sha256Bytes(blockBody)]: blockBody });
    expect(await runCli(["update", "--non-interactive", "--yes", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch,
      env: { TEST_HUNTER_TOKEN: "api-token" },
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(0);
    const result = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(result).toContain("<!-- hunter-harness:start -->");
    expect(result).toContain("<!-- hunter-harness:end -->");
    expect(result).not.toContain("id=harness-skill");
    expect(result).toContain("# Project agents");
  });
});
