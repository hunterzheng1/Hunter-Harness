import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  pendingTransactions,
  readBaseline,
  sha256Bytes,
  synchronizeProjectRules,
  updateProject,
  writeBaseline
} from "@hunter-harness/core";
import { canonicalJson, type BaselineManifest } from "@hunter-harness/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runCli } from "../src/bin.js";
import { recoveryEnv } from "./recovery-env.js";

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
      await mkdir(dirname(join(root, path)), { recursive: true });
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
      ".harness/rules/modify.md": "modify-old\n",
      ".harness/rules/delete.md": "delete-old\n",
      ".harness/rules/old-name.md": "rename-old\n"
    };
    await seedBaseline(before);
    const added = "added\n";
    const modified = "modify-new\n";
    const renamed = before[".harness/rules/old-name.md"];
    const manifest = artifact([
      {
        operation: "add",
        path: ".harness/rules/added.md",
        file_kind: "user_editable",
        content_sha256: sha256Bytes(added),
        size_bytes: Buffer.byteLength(added)
      },
      {
        operation: "modify",
        path: ".harness/rules/modify.md",
        file_kind: "user_editable",
        base_content_sha256: sha256Bytes(before[".harness/rules/modify.md"]),
        content_sha256: sha256Bytes(modified),
        size_bytes: Buffer.byteLength(modified)
      },
      {
        operation: "delete",
        path: ".harness/rules/delete.md",
        file_kind: "user_editable",
        base_content_sha256: sha256Bytes(before[".harness/rules/delete.md"]),
        tombstone: {
          deleted_at: "2026-06-20T00:00:00Z",
          reason: "approved removal",
          previous_sha256: sha256Bytes(before[".harness/rules/delete.md"])
        }
      },
      {
        operation: "rename",
        from_path: ".harness/rules/old-name.md",
        to_path: ".harness/rules/new-name.md",
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
      env: { TEST_HUNTER_TOKEN: "api-token", ...recoveryEnv },
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });
    expect(code).toBe(0);
    expect(await readFile(join(root, ".harness/rules/added.md"), "utf8")).toBe(added);
    expect(await readFile(join(root, ".harness/rules/modify.md"), "utf8")).toBe(modified);
    expect(await pathExists(join(root, ".harness/rules/delete.md"))).toBe(false);
    expect(await pathExists(join(root, ".harness/rules/old-name.md"))).toBe(false);
    expect(await readFile(join(root, ".harness/rules/new-name.md"), "utf8")).toBe(renamed);
    expect((await readBaseline(root)).complete_project_version).toBe("pv_1");
  });

  it("skips dirty files, applies eligible files, and leaves complete version unchanged", async () => {
    const rulePath = ".claude/rules/harness-general.md";
    const skillPath = ".claude/skills/harness-review/SKILL.md";
    const deletePath = ".harness/rules/dirty-delete.md";
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
      env: { TEST_HUNTER_TOKEN: "api-token", ...recoveryEnv },
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

  it("acknowledges remote deletes for managed rule projections and refreshes them locally", async () => {
    const canonicalPath = ".harness/rules/team.md";
    const projectionPath = ".claude/rules/team.md";
    const original = "shared v1\n";
    const updated = "shared v2\n";
    await mkdir(join(root, ".harness", "rules"), { recursive: true });
    await writeFile(join(root, canonicalPath), original, "utf8");
    await synchronizeProjectRules(root, ["claude-code"]);
    await seedBaseline({
      [canonicalPath]: original,
      [projectionPath]: original
    });
    const manifest = artifact([
      {
        operation: "modify",
        path: canonicalPath,
        file_kind: "user_editable",
        base_content_sha256: sha256Bytes(original),
        content_sha256: sha256Bytes(updated),
        size_bytes: Buffer.byteLength(updated)
      },
      {
        operation: "delete",
        path: projectionPath,
        file_kind: "user_editable",
        base_content_sha256: sha256Bytes(original),
        tombstone: {
          deleted_at: "2026-07-24T00:00:00Z",
          reason: "projection omitted from canonical artifact",
          previous_sha256: sha256Bytes(original)
        }
      }
    ]);

    const code = await runCli(["update", "--non-interactive", "--yes", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch: fetchFor(manifest, {
        [sha256Bytes(updated)]: updated
      }),
      env: { TEST_HUNTER_TOKEN: "api-token", ...recoveryEnv },
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });

    expect(code).toBe(0);
    expect(await readFile(join(root, canonicalPath), "utf8")).toBe(updated);
    expect(await readFile(join(root, projectionPath), "utf8")).toBe(updated);
    const payload = JSON.parse(stdout.join("")) as {
      items: Array<{ path: string; operation: string; status: string; reason: string | null }>;
    };
    expect(payload.items).toContainEqual(expect.objectContaining({
      path: projectionPath,
      operation: "delete",
      status: "acknowledged",
      reason: "protocol-only"
    }));
    expect((await readBaseline(root)).complete_project_version).toBe("pv_1");
  });

  it("preserves and reports locally modified managed rule projections", async () => {
    const canonicalPath = ".harness/rules/team.md";
    const projectionPath = ".claude/rules/team.md";
    const original = "shared v1\n";
    const updated = "shared v2\n";
    const local = "local customization\n";
    await mkdir(join(root, ".harness", "rules"), { recursive: true });
    await writeFile(join(root, canonicalPath), original, "utf8");
    await synchronizeProjectRules(root, ["claude-code"]);
    await seedBaseline({
      [canonicalPath]: original,
      [projectionPath]: original
    });
    await writeFile(join(root, projectionPath), local, "utf8");
    const manifest = artifact([{
      operation: "modify",
      path: canonicalPath,
      file_kind: "user_editable",
      base_content_sha256: sha256Bytes(original),
      content_sha256: sha256Bytes(updated),
      size_bytes: Buffer.byteLength(updated)
    }]);

    const code = await runCli(["update", "--non-interactive", "--yes", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch: fetchFor(manifest, {
        [sha256Bytes(updated)]: updated
      }),
      env: { TEST_HUNTER_TOKEN: "api-token", ...recoveryEnv },
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });

    expect(code).toBe(5);
    expect(await readFile(join(root, canonicalPath), "utf8")).toBe(updated);
    expect(await readFile(join(root, projectionPath), "utf8")).toBe(local);
    const payload = JSON.parse(stdout.join("")) as {
      warnings: Array<{ path: string; operation: string; reason: string }>;
    };
    expect(payload.warnings).toContainEqual({
      path: projectionPath,
      operation: "modify",
      reason: "local-dirty"
    });
  });

  it("preserves concurrent user guidance by reporting a full-document conflict", async () => {
    const path = "CLAUDE.md";
    const original = [
      "<!-- hunter-harness:start -->",
      "# Hunter Harness",
      "Legacy managed guidance.",
      "<!-- hunter-harness:end -->",
      ""
    ].join("\n");
    const baseline = await seedBaseline({ [path]: original });
    await writeBaseline(root, baseline);
    const local = "# User guidance\nKeep this.\n\n" + original;
    await writeFile(join(root, path), local);
    const incoming = "# Hunter Harness Updated\n\nRemote full document.\n";
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
      env: { TEST_HUNTER_TOKEN: "api-token", ...recoveryEnv },
      stdout: () => undefined,
      stderr: () => undefined
    });
    expect(code).toBe(5);
    expect(await readFile(join(root, path), "utf8")).toBe(local);
  });

  it("keeps dry-run write-free and rejects corrupt blobs", async () => {
    const content = "approved content\n";
    const path = ".harness/rules/dry.md";
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
      env: { TEST_HUNTER_TOKEN: "api-token", ...recoveryEnv },
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
      env: { TEST_HUNTER_TOKEN: "api-token", ...recoveryEnv },
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(4);
    expect(await pathExists(join(root, path))).toBe(false);
  });

  it("never downloads or applies a rename across a policy-never boundary", async () => {
    const source = ".harness/knowledge/project-local/secret.md";
    const target = ".harness/rules/restored.md";
    const content = "local-only secret\n";
    await seedBaseline({ [source]: content });
    const manifest = artifact([{
      operation: "rename",
      from_path: source,
      to_path: target,
      file_kind: "user_editable",
      base_content_sha256: sha256Bytes(content),
      content_sha256: sha256Bytes(content),
      size_bytes: Buffer.byteLength(content)
    }]);
    const fetch = fetchFor(manifest, { [sha256Bytes(content)]: content });

    expect(await runCli(["update", "--non-interactive", "--yes", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch,
      env: { TEST_HUNTER_TOKEN: "api-token", ...recoveryEnv },
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    })).toBe(0);

    expect(await readFile(join(root, source), "utf8")).toBe(content);
    expect(await pathExists(join(root, target))).toBe(false);
    expect(fetch.mock.calls.filter(([input]) =>
      new URL(typeof input === "string" ? input : input.toString()).pathname.includes("/blobs/")
    )).toHaveLength(0);
  });

  it("UT-015 recovers files and baseline byte-for-byte after transaction interruption", async () => {
    const content = "interrupted artifact\n";
    const path = ".harness/rules/interrupted.md";
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
      env: { TEST_HUNTER_TOKEN: "api-token", ...recoveryEnv },
      dryRun: false,
      fetch: fetchFor(manifest, { [sha256Bytes(content)]: content }),
      transactionOptions: { interruptAfterApply: 2 }
    })).rejects.toThrow(/interrupted/i);
    expect(await pathExists(join(root, path))).toBe(true);
    expect((await readBaseline(root)).complete_project_version).toBe("pv_interrupt");

    const pending = await pendingTransactions(root);
    const recoveryId = pending[0]?.recoveryId;
    expect(recoveryId).toBeDefined();
    expect(await runCli([
      "recover",
      recoveryId ?? "",
      "--action", "rollback",
      "--non-interactive",
      "--yes"
    ], {
      cwd: root,
      resourcesRoot,
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(0);
    expect(await pathExists(join(root, path))).toBe(false);
    expect(await readFile(
      join(root, ".harness/state/baseline/manifest.json"), "utf8"
    )).toBe(baselineBefore);
  });

  it("rejects legacy partial block operations for a full-document AGENTS.md", async () => {
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
      env: { TEST_HUNTER_TOKEN: "api-token", ...recoveryEnv },
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(5);
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(existing);
  });

  it("applies a marker-free AGENTS.md as an exact full document", async () => {
    const existing = "# Project agents\n\nexisting\n";
    await seedBaseline({ "AGENTS.md": existing });
    const blockBody = "# Project agents\n\nmanaged full-document content\n";
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
      env: { TEST_HUNTER_TOKEN: "api-token", ...recoveryEnv },
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(0);
    const result = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(result).toBe(blockBody);
    expect(result).not.toContain("hunter-harness:start");
  });

  it("applies multi-adapter artifacts to their target paths in one transaction (INT-004)", async () => {
    const agentsExisting = "# Project agents\n\nexisting\n";
    await seedBaseline({ "AGENTS.md": agentsExisting });
    const cursorBody = "---\nadapter: cursor\n---\ncursor body\n";
    const genericBody = "---\nadapter: generic\n---\ngeneric body\n";
    const agentsFull = "# Project agents\n\nexisting\n\n## Codex\n\ncodex skill body\n";
    const manifest = artifact([
      { operation: "add", path: ".cursor/rules/harness-review.mdc", file_kind: "user_editable", content_sha256: sha256Bytes(cursorBody), size_bytes: Buffer.byteLength(cursorBody) },
      { operation: "add", path: ".agent-skills/harness-review.md", file_kind: "user_editable", content_sha256: sha256Bytes(genericBody), size_bytes: Buffer.byteLength(genericBody) },
      { operation: "modify", path: "AGENTS.md", file_kind: "user_editable", base_content_sha256: sha256Bytes(agentsExisting), content_sha256: sha256Bytes(agentsFull), size_bytes: Buffer.byteLength(agentsFull) }
    ]);
    const fetch = fetchFor(manifest, {
      [sha256Bytes(cursorBody)]: cursorBody,
      [sha256Bytes(genericBody)]: genericBody,
      [sha256Bytes(agentsFull)]: agentsFull
    });
    expect(await runCli(["update", "--non-interactive", "--yes", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch,
      env: { TEST_HUNTER_TOKEN: "api-token", ...recoveryEnv },
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(0);
    expect(await readFile(join(root, ".cursor/rules/harness-review.mdc"), "utf8")).toBe(cursorBody);
    expect(await readFile(join(root, ".agent-skills/harness-review.md"), "utf8")).toBe(genericBody);
    const agents = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(agents).toBe(agentsFull);
    expect(agents).not.toContain("hunter-harness:start");
  });

  it("repeated full-document updates remain marker-free (INT-005)", async () => {
    const existing = "# Project agents\n\nexisting\n";
    await seedBaseline({ "AGENTS.md": existing });
    const bodyV1 = "# Project agents\n\nexisting\n\ncodex skill body v1\n";
    const manifest1 = artifact([{
      operation: "modify",
      path: "AGENTS.md",
      file_kind: "user_editable",
      base_content_sha256: sha256Bytes(existing),
      content_sha256: sha256Bytes(bodyV1),
      size_bytes: Buffer.byteLength(bodyV1)
    }], "pv_1", "art_1");
    await runCli(["update", "--non-interactive", "--yes", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch: fetchFor(manifest1, { [sha256Bytes(bodyV1)]: bodyV1 }),
      env: { TEST_HUNTER_TOKEN: "api-token", ...recoveryEnv },
      stdout: () => undefined,
      stderr: () => undefined
    });
    const afterFirst = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(afterFirst).toBe(bodyV1);
    expect(afterFirst).not.toContain("hunter-harness:start");
    const bodyV2 = "# Project agents\n\nexisting\n\ncodex skill body v2\n";
    const manifest2 = artifact([{
      operation: "modify",
      path: "AGENTS.md",
      file_kind: "user_editable",
      base_content_sha256: sha256Bytes(bodyV1),
      content_sha256: sha256Bytes(bodyV2),
      size_bytes: Buffer.byteLength(bodyV2)
    }], "pv_2", "art_2");
    expect(await runCli(["update", "--non-interactive", "--yes", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch: fetchFor(manifest2, { [sha256Bytes(bodyV2)]: bodyV2 }),
      env: { TEST_HUNTER_TOKEN: "api-token", ...recoveryEnv },
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(0);
    const afterSecond = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(afterSecond).toBe(bodyV2);
    expect(afterSecond).not.toContain("hunter-harness:start");
  });

  it("applies sequential full documents using the previous remote hash (INT-006)", async () => {
    const existing = "# Project agents\n\nexisting\n";
    await seedBaseline({ "AGENTS.md": existing });
    const bodyA = "# Project agents\n\nexisting\n\nskill A body\n";
    const manifestA = artifact([{
      operation: "modify",
      path: "AGENTS.md",
      file_kind: "user_editable",
      base_content_sha256: sha256Bytes(existing),
      content_sha256: sha256Bytes(bodyA),
      size_bytes: Buffer.byteLength(bodyA)
    }], "pv_1", "art_a");
    await runCli(["update", "--non-interactive", "--yes", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch: fetchFor(manifestA, { [sha256Bytes(bodyA)]: bodyA }),
      env: { TEST_HUNTER_TOKEN: "api-token", ...recoveryEnv },
      stdout: () => undefined,
      stderr: () => undefined
    });
    const bodyB = "# Project agents\n\nexisting\n\nskill A body\n\nskill B body\n";
    const manifestB = artifact([{
      operation: "modify",
      path: "AGENTS.md",
      file_kind: "user_editable",
      base_content_sha256: sha256Bytes(bodyA),
      content_sha256: sha256Bytes(bodyB),
      size_bytes: Buffer.byteLength(bodyB)
    }], "pv_2", "art_b");
    expect(await runCli(["update", "--non-interactive", "--yes", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch: fetchFor(manifestB, { [sha256Bytes(bodyB)]: bodyB }),
      env: { TEST_HUNTER_TOKEN: "api-token", ...recoveryEnv },
      stdout: () => undefined,
      stderr: () => undefined
    })).toBe(0);
    const result = await readFile(join(root, "AGENTS.md"), "utf8");
    expect(result).toBe(bodyB);
    expect(result).not.toContain("hunter-harness:start");
  });

  it("API-001 handles 146 applied plus 433 policy-never entries and advances baseline", async () => {
    const applyFiles = Array.from({ length: 146 }, (_, index) => ({
      path: `.harness/rules/applied-${index}.md`,
      local: `apply-old-${index}\n`,
      remote: `apply-new-${index}\n`
    }));
    const policyFiles = Array.from({ length: 433 }, (_, index) => ({
      path: index % 2 === 0
        ? `.harness/knowledge/project-local/ignored-${index}.md`
        : `.harness/archive/change-${index}/spec/core.md`,
      local: `local-${index}\n`,
      remote: `remote-${index}\n`
    }));
    await seedBaseline(Object.fromEntries([
      ...applyFiles.map((file) => [file.path, file.local]),
      ...policyFiles.map((file) => [file.path, file.local])
    ]));
    const manifest = artifact([
      ...applyFiles.map((file) => ({
        operation: "modify",
        path: file.path,
        file_kind: "user_editable",
        base_content_sha256: sha256Bytes(file.local),
        content_sha256: sha256Bytes(file.remote),
        size_bytes: Buffer.byteLength(file.remote)
      } as const)),
      ...policyFiles.map((file) => ({
        operation: "modify" as const,
        path: file.path,
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
    const fetch = fetchFor(manifest, blobs);
    const code = await runCli(["update", "--non-interactive", "--yes", "--json"], {
      cwd: root,
      resourcesRoot,
      fetch,
      env: { TEST_HUNTER_TOKEN: "api-token", ...recoveryEnv },
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value)
    });
    expect(code).toBe(0);
    const output = JSON.parse(stdout.join("")) as {
      summary: { applied: number; acknowledged: number; skipped: number };
    };
    expect(output.summary).toMatchObject({ applied: 146, acknowledged: 433, skipped: 0 });
    expect(fetch.mock.calls.filter(([input]) =>
      new URL(typeof input === "string" ? input : input.toString()).pathname.includes("/blobs/")
    )).toHaveLength(146);
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
      path: `.harness/rules/mixed-applied-${index}.md`,
      local: `old-${index}\n`, remote: `new-${index}\n`
    }));
    const ignored = Array.from({ length: 400 }, (_, index) => ({
      path: `.harness/knowledge/project-local/mixed-ignored-${index}.md`,
      local: `local-${index}\n`, remote: `server-${index}\n`
    }));
    const conflicts = Array.from({ length: 33 }, (_, index) => ({
      path: `.harness/rules/conflict-${index}.md`,
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
        env: { TEST_HUNTER_TOKEN: "api-token", ...recoveryEnv },
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
