import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "@hunter-harness/contracts";
import { readBaseline, sha256Bytes, uuidV7 } from "@hunter-harness/core";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

import { createServer } from "../../apps/server/src/app.js";
import { MemoryRepository } from "../../apps/server/src/repositories/memory.js";
import { MemoryArtifactStorage } from "../../apps/server/src/storage/memory.js";
import { runCli } from "../../packages/cli/src/bin.js";

const resourcesRoot = fileURLToPath(
  new URL("../../resources", import.meta.url)
);

describe("Hunter Harness end-to-end governance", () => {
  it("runs offline init through review, update, dirty skip, and rollback", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-e2e-"));
    const repository = new MemoryRepository();
    const storage = new MemoryArtifactStorage();
    const token = "e2e-api-token";
    await repository.createActorWithToken({ actorId: "actor_e2e", token });
    const app = await createServer({ repository, storage });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const body = init?.body;
      let payload: string | Buffer | undefined;
      if (typeof body === "string") {
        payload = body;
      } else if (body instanceof Uint8Array) {
        payload = Buffer.from(body);
      }
      const response = await app.inject({
        method: (init?.method ?? "GET") as "GET",
        url: url.pathname + url.search,
        headers,
        ...(payload === undefined ? {} : { payload })
      });
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value !== undefined) {
          responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : String(value));
        }
      }
      return new Response(response.rawPayload, {
        status: response.statusCode,
        headers: responseHeaders
      });
    };
    const env = { E2E_HUNTER_TOKEN: token };
    const silent = { stdout: () => undefined, stderr: () => undefined };

    try {
      expect(await runCli([
        "--profile", "java",
        "--non-interactive", "--yes"
      ], { cwd: root, resourcesRoot, env, ...silent })).toBe(0);
      const offlineProject = parseYaml(await readFile(
        join(root, ".harness/project.yaml"), "utf8"
      )) as { project: { project_id: null }; server: { url: null } };
      expect(offlineProject.project.project_id).toBeNull();
      expect(offlineProject.server.url).toBeNull();

      expect(await runCli([
        "push", "--server-url", "https://e2e.example.test",
        "--token-env", "E2E_HUNTER_TOKEN", "--non-interactive", "--yes"
      ], { cwd: root, resourcesRoot, fetch, env, ...silent })).toBe(0);
      const boundProject = parseYaml(await readFile(
        join(root, ".harness/project.yaml"), "utf8"
      )) as { project: { project_id: string } };
      const projectId = boundProject.project.project_id;
      const [firstProposal] = (await repository.listProposals({
        actorId: "actor_e2e",
        projectId,
        limit: 10,
        cursor: null,
        status: "pending_review"
      })).items;
      if (firstProposal === undefined) throw new Error("first proposal was not created");
      const firstReview = await app.inject({
        method: "POST",
        url: `/api/v1/proposals/${firstProposal.proposalId}/review-decisions`,
        headers: {
          authorization: "Bearer " + token,
          "x-request-id": uuidV7(),
          "idempotency-key": uuidV7()
        },
        payload: {
          schema_version: 1,
          decision: "approve",
          comment: "e2e owner approval",
          target_scope: "project",
          split_groups: []
        }
      });
      expect(firstReview.statusCode).toBe(201);

      expect(await runCli([
        "update", "--server-url", "https://e2e.example.test",
        "--token-env", "E2E_HUNTER_TOKEN", "--non-interactive", "--yes"
      ], { cwd: root, resourcesRoot, fetch, env, ...silent })).toBe(0);
      const firstBaseline = await readBaseline(root);
      expect(firstBaseline.complete_project_version).toMatch(/^pv_/);

      const rulePath = ".claude/rules/harness-general.md";
      const ruleBaseline = firstBaseline.files[rulePath];
      if (ruleBaseline?.baseline_hash === null || ruleBaseline === undefined) {
        throw new Error("rule baseline is missing");
      }
      const ruleCurrent = await readFile(join(root, rulePath), "utf8");
      const serverRule = ruleCurrent + "\n- Server-reviewed rule.\n";
      const knowledgePath = ".harness/knowledge/architecture/e2e.md";
      const knowledge = "---\nid: knowledge.architecture.e2e\n---\n\nE2E knowledge.\n";
      const operations = [
        {
          operation: "modify" as const,
          path: rulePath,
          file_kind: "user_editable" as const,
          base_content_sha256: ruleBaseline.baseline_hash,
          content_sha256: sha256Bytes(serverRule),
          size_bytes: Buffer.byteLength(serverRule)
        },
        {
          operation: "add" as const,
          path: knowledgePath,
          file_kind: "user_editable" as const,
          content_sha256: sha256Bytes(knowledge),
          size_bytes: Buffer.byteLength(knowledge)
        }
      ];
      await storage.putBlob(sha256Bytes(serverRule), Buffer.from(serverRule));
      await storage.putBlob(sha256Bytes(knowledge), Buffer.from(knowledge));
      const secondSession = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/proposal-sessions`,
        headers: {
          authorization: "Bearer " + token,
          "x-request-id": uuidV7(),
          "idempotency-key": uuidV7()
        },
        payload: {
          schema_version: 1,
          request_id: uuidV7(),
          client_id: "cli_e2e",
          base_project_version: firstBaseline.complete_project_version,
          base_manifest_hash: sha256Bytes(canonicalJson(firstBaseline)),
          proposal_manifest: { files: operations },
          artifact_manifest: { schema_version: 1, files: operations }
        }
      });
      expect(secondSession.statusCode).toBe(201);
      const secondFinalize = await app.inject({
        method: "POST",
        url: `/api/v1/proposal-sessions/${secondSession.json().session_id}:finalize`,
        headers: {
          authorization: "Bearer " + token,
          "x-request-id": uuidV7(),
          "idempotency-key": uuidV7()
        },
        payload: {
          schema_version: 1,
          manifest_sha256: sha256Bytes(canonicalJson(operations))
        }
      });
      expect(secondFinalize.statusCode).toBe(201);
      const secondReview = await app.inject({
        method: "POST",
        url: `/api/v1/proposals/${secondFinalize.json().proposal_id}/review-decisions`,
        headers: {
          authorization: "Bearer " + token,
          "x-request-id": uuidV7(),
          "idempotency-key": uuidV7()
        },
        payload: {
          schema_version: 1,
          decision: "approve",
          comment: "approve mixed dirty/eligible artifact",
          target_scope: "project",
          split_groups: []
        }
      });
      expect(secondReview.statusCode).toBe(201);
      await writeFile(join(root, rulePath), ruleCurrent + "\n- Local unpushed edit.\n");

      expect(await runCli([
        "update", "--server-url", "https://e2e.example.test",
        "--token-env", "E2E_HUNTER_TOKEN", "--non-interactive", "--yes"
      ], { cwd: root, resourcesRoot, fetch, env, ...silent })).toBe(5);
      expect(await readFile(join(root, knowledgePath), "utf8")).toBe(knowledge);
      expect(await readFile(join(root, rulePath), "utf8")).toContain("Local unpushed edit");

      const answers = ["2"];
      expect(await runCli([], {
        cwd: root,
        resourcesRoot,
        fetch,
        env,
        prompt: async () => answers.shift() ?? "",
        ...silent
      })).toBe(0);
      await expect(stat(join(root, knowledgePath))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(root, rulePath), "utf8")).toContain("Local unpushed edit");
    } finally {
      await app.close();
    }
  }, 20_000);
});
