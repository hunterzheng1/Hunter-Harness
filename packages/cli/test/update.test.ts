import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
  new URL("../../workflow-data-harness", import.meta.url)
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
        const baseVersion = url.searchParams.get("base_project_version");
        if (baseVersion === manifest.project_version) {
          return json({
            schema_version: 1,
            project_id: "prj_update",
            observed_project_version: manifest.project_version,
            artifact_id: null,
            artifact_manifest_url: null,
            delta_available: false,
            request_id: "req"
          });
        }
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

  it("UT-015 recovers files and baseline byte-for-byte after transaction interruption", async () => {
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
    const blockBody = "<!-- harness: adapter=codex source_hash=sha256:abc compiler_version=1.0.0 -->\n# harness-review\ncodex skill body";
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

  it("applies multi-adapter artifacts to their target paths in one transaction (INT-004)", async () => {
    const agentsExisting = "# Project agents\n\nexisting\n";
    await seedBaseline({ "AGENTS.md": agentsExisting });
    const cursorBody = "---\nadapter: cursor\n---\ncursor body\n";
    const genericBody = "---\nadapter: generic\n---\ngeneric body\n";
    const codexBlock = "<!-- harness: adapter=codex source_hash=sha256:abc compiler_version=1.0.0 -->\ncodex skill body";
    const manifest = artifact([
      { operation: "add", path: ".cursor/rules/harness-review.mdc", file_kind: "user_editable", content_sha256: sha256Bytes(cursorBody), size_bytes: Buffer.byteLength(cursorBody) },
      { operation: "add", path: ".agent-skills/harness-review.md", file_kind: "user_editable", content_sha256: sha256Bytes(genericBody), size_bytes: Buffer.byteLength(genericBody) },
      { operation: "modify", path: "AGENTS.md", file_kind: "user_editable", base_content_sha256: sha256Bytes(agentsExisting), content_sha256: sha256Bytes(codexBlock), size_bytes: Buffer.byteLength(codexBlock), block_id: "harness-skill-harness-review" }
    ]);
    const fetch = fetchFor(manifest, {
      [sha256Bytes(cursorBody)]: cursorBody,
      [sha256Bytes(genericBody)]: genericBody,
      [sha256Bytes(codexBlock)]: codexBlock
    });
    expect(await runCli(["update", "--non-interactive", "--yes", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch,
      env: { TEST_HUNTER_TOKEN: "api-token" },
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(0);
    expect(await readFile(join(root, ".cursor/rules/harness-review.mdc"), "utf8")).toBe(cursorBody);
    expect(await readFile(join(root, ".agent-skills/harness-review.md"), "utf8")).toBe(genericBody);
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(agents).toContain("harness-skill-harness-review");
    expect(agents).toContain("codex skill body");
    expect(agents).toContain("# Project agents");
  });

  it("repeated managed-block modify with same block id replaces without duplication (INT-005)", async () => {
    const existing = "# Project agents\n\nexisting\n";
    await seedBaseline({ "AGENTS.md": existing });
    const bodyV1 = "codex skill body v1";
    const manifest1 = artifact([{
      operation: "modify",
      path: "AGENTS.md",
      file_kind: "user_editable",
      base_content_sha256: sha256Bytes(existing),
      content_sha256: sha256Bytes(bodyV1),
      size_bytes: Buffer.byteLength(bodyV1),
      block_id: "harness-skill-harness-review"
    }], "pv_1", "art_1");
    await runCli(["update", "--non-interactive", "--yes", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch: fetchFor(manifest1, { [sha256Bytes(bodyV1)]: bodyV1 }),
      env: { TEST_HUNTER_TOKEN: "api-token" },
      stdout: () => undefined,
      stderr: () => undefined
    });
    const afterFirst = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(afterFirst.match(/hunter-harness:start id=harness-skill-harness-review/g)).toHaveLength(1);
    const bodyV2 = "codex skill body v2";
    const manifest2 = artifact([{
      operation: "modify",
      path: "AGENTS.md",
      file_kind: "user_editable",
      base_content_sha256: sha256Bytes(bodyV1),
      content_sha256: sha256Bytes(bodyV2),
      size_bytes: Buffer.byteLength(bodyV2),
      block_id: "harness-skill-harness-review"
    }], "pv_2", "art_2");
    expect(await runCli(["update", "--non-interactive", "--yes", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch: fetchFor(manifest2, { [sha256Bytes(bodyV2)]: bodyV2 }),
      env: { TEST_HUNTER_TOKEN: "api-token" },
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(0);
    const afterSecond = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(afterSecond.match(/hunter-harness:start id=harness-skill-harness-review/g)).toHaveLength(1);
    expect(afterSecond).toContain("v2");
    expect(afterSecond).not.toContain("v1");
  });

  it("applies two managed-block ops with different block ids to the same AGENTS.md (INT-006)", async () => {
    const existing = "# Project agents\n\nexisting\n";
    await seedBaseline({ "AGENTS.md": existing });
    const bodyA = "skill A body";
    const manifestA = artifact([{
      operation: "modify",
      path: "AGENTS.md",
      file_kind: "user_editable",
      base_content_sha256: sha256Bytes(existing),
      content_sha256: sha256Bytes(bodyA),
      size_bytes: Buffer.byteLength(bodyA),
      block_id: "harness-skill-skill-a"
    }], "pv_1", "art_a");
    await runCli(["update", "--non-interactive", "--yes", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch: fetchFor(manifestA, { [sha256Bytes(bodyA)]: bodyA }),
      env: { TEST_HUNTER_TOKEN: "api-token" },
      stdout: () => undefined,
      stderr: () => undefined
    });
    const bodyB = "skill B body";
    const manifestB = artifact([{
      operation: "modify",
      path: "AGENTS.md",
      file_kind: "user_editable",
      base_content_sha256: sha256Bytes(bodyA),
      content_sha256: sha256Bytes(bodyB),
      size_bytes: Buffer.byteLength(bodyB),
      block_id: "harness-skill-skill-b"
    }], "pv_2", "art_b");
    expect(await runCli(["update", "--non-interactive", "--yes", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch: fetchFor(manifestB, { [sha256Bytes(bodyB)]: bodyB }),
      env: { TEST_HUNTER_TOKEN: "api-token" },
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(0);
    const result = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(result).toContain("harness-skill-skill-a");
    expect(result).toContain("harness-skill-skill-b");
    expect(result).toContain("skill A body");
    expect(result).toContain("skill B body");
    expect(result).toContain("# Project agents");
    expect(result.match(/hunter-harness:start id=harness-skill/g)).toHaveLength(2);
  });

  it("API-001 handles 146 applied plus 433 policy-never entries and advances baseline", async () => {
    const applyFiles = Array.from({ length: 146 }, (_, index) => ({
      path: `.harness/knowledge/applied-${index}.md`,
      local: `apply-old-${index}\n`,
      remote: `apply-new-${index}\n`
    }));
    const policyFiles = Array.from({ length: 433 }, (_, index) => ({
      path: `.harness/knowledge/project-local/ignored-${index}.md`,
      local: `local-${index}\n`,
      remote: `remote-${index}\n`
    }));
    await mkdir(join(root, ".harness", "knowledge", "project-local"), { recursive: true });
    await seedBaseline(Object.fromEntries([
      ...applyFiles.map((file) => [file.path, file.local]),
      ...policyFiles.map((file) => [file.path, file.local])
    ]));
    for (const file of policyFiles) {
      const dir = join(root, ".harness", "knowledge", "project-local");
      await mkdir(dir, { recursive: true });
      await writeFile(join(root, file.path), file.local);
    }
    const manifest = artifact([
      ...applyFiles.map((file) => ({
        operation: "modify",
        path: file.path,
        file_kind: "user_editable",
        base_content_sha256: sha256Bytes(file.local),
        content_sha256: sha256Bytes(file.remote),
        size_bytes: Buffer.byteLength(file.remote)
      } as const)),
      ...policyFiles.map((file, index) => ({
        operation: "modify" as const,
        path: `.harness/knowledge/project-local/ignored-${index}.md`,
        file_kind: "user_editable" as const,
        base_content_sha256: sha256Bytes(file.local),
        content_sha256: sha256Bytes(file.remote),
        size_bytes: Buffer.byteLength(file.remote)
      }))
    ]);
    const blobs: Record<string, string> = {};
    for (const file of [...applyFiles, ...policyFiles]) {
      blobs[sha256Bytes(file.remote)] = file.remote;
    }
    const code = await runCli(["update", "--non-interactive", "--yes", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch: fetchFor(manifest, blobs),
      env: { TEST_HUNTER_TOKEN: "api-token" },
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });
    expect(code).toBe(0);
    const output = JSON.parse(stdout.join("")) as {
      summary: { applied: number; acknowledged: number; skipped: number };
    };
    expect(output.summary).toMatchObject({ applied: 146, acknowledged: 433, skipped: 0 });
    for (const file of applyFiles) {
      expect(await readFile(join(root, file.path), "utf8")).toBe(file.remote);
    }
    for (const file of policyFiles) {
      expect(await readFile(join(root, file.path), "utf8")).toBe(file.local);
    }
    const baseline = await readBaseline(root);
    expect(baseline.complete_project_version).toBe("pv_1");
    expect(baseline.files[policyFiles[0]?.path ?? ""]?.baseline_hash).toBe(
      sha256Bytes(policyFiles[0]?.remote ?? "")
    );
  }, 120000);

  it("API-002 applies 146, acknowledges 400, and reports only 33 real conflicts", async () => {
    const applyFiles = Array.from({ length: 146 }, (_, index) => ({
      path: `.harness/knowledge/mixed-applied-${index}.md`,
      local: `old-${index}\n`, remote: `new-${index}\n`
    }));
    const ignored = Array.from({ length: 400 }, (_, index) => ({
      path: `.harness/knowledge/project-local/mixed-ignored-${index}.md`,
      local: `local-${index}\n`, remote: `server-${index}\n`
    }));
    const conflicts = Array.from({ length: 33 }, (_, index) => ({
      path: `.harness/knowledge/conflict-${index}.md`,
      local: `base-${index}\n`, dirty: `dirty-${index}\n`, remote: `remote-${index}\n`
    }));
    await mkdir(join(root, ".harness", "knowledge", "project-local"), { recursive: true });
    await seedBaseline(Object.fromEntries([
      ...applyFiles.map((file) => [file.path, file.local]),
      ...ignored.map((file) => [file.path, file.local]),
      ...conflicts.map((file) => [file.path, file.local])
    ]));
    for (const file of conflicts) await writeFile(join(root, file.path), file.dirty);
    const all = [...applyFiles, ...ignored, ...conflicts];
    const manifest = artifact(all.map((file) => ({
      operation: "modify" as const,
      path: file.path,
      file_kind: "user_editable" as const,
      base_content_sha256: sha256Bytes(file.local),
      content_sha256: sha256Bytes(file.remote),
      size_bytes: Buffer.byteLength(file.remote)
    })), "pv_mixed", "art_mixed");
    const blobs = Object.fromEntries(all.map((file) => [sha256Bytes(file.remote), file.remote]));
    const run = async () => {
      stdout = [];
      stderr = [];
      const code = await runCli(["update", "--non-interactive", "--yes", "--json"], {
        cwd: root, resourcesRoot, fetch: fetchFor(manifest, blobs),
        env: { TEST_HUNTER_TOKEN: "api-token" },
        stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value)
      });
      return { code, output: JSON.parse(stdout.join("")) as {
        summary: { applied: number; acknowledged: number; skipped: number };
      } };
    };
    const first = await run();
    expect(first.code).toBe(5);
    expect(first.output.summary).toMatchObject({ applied: 146, acknowledged: 400, skipped: 33 });
    expect((await readBaseline(root)).complete_project_version).toBe("pv_0");
    const second = await run();
    expect(second.code).toBe(5);
    expect(second.output.summary).toMatchObject({ applied: 0, acknowledged: 0, skipped: 33 });
  }, 120000);
});
