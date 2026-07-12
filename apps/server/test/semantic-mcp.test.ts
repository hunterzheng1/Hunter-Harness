import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { uuidV7 } from "@hunter-harness/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/app.js";
import { createSemanticMcpServer } from "../src/mcp/semantic-server.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { buildSemanticIndex } from "../src/semantic/indexer.js";
import { SemanticMemoryStore } from "../src/semantic/memory-store.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

describe("semantic MCP", () => {
  const token = "mcp-owner-token";
  let repository: MemoryRepository;
  let semanticStore: SemanticMemoryStore;
  let app: Awaited<ReturnType<typeof createServer>>;
  let projectId: string;

  beforeEach(async () => {
    repository = new MemoryRepository();
    semanticStore = new SemanticMemoryStore();
    await repository.createActorWithToken({ actorId: "actor_owner", token });
    const resolved = await repository.resolveProject({
      actorId: "actor_owner",
      localProjectKey: uuidV7(),
      displayName: "MCP Sample",
      requestedProjectId: null
    });
    projectId = resolved.project.projectId;
    await semanticStore.rebuild(buildSemanticIndex({
      projectId,
      artifactId: "art_mcp0001",
      files: {
        "CLAUDE.md": "# MCP sample\n",
        ".harness/knowledge/entries/active/decision.json": JSON.stringify({
          schemaVersion: 1,
          id: "sample.decision.aaaaaaaaaa",
          projectId: "sample",
          type: "decision",
          status: "active",
          title: "Reuse LlmClient",
          summary: "Reuse LlmClient for AI jobs.",
          body: "Reuse LlmClient for AI jobs without new provider abstractions.",
          keywords: ["llm"],
          source: {
            archive: ".harness/archive/2026-06-30-sample",
            summaryData: ".harness/archive/2026-06-30-sample/reports/final/summary-data.json",
            summarySha256: "abc",
            sourceCommit: "",
            baseCommit: "",
            changeName: "sample",
            finalStatus: "OK"
          },
          scope: { sourceFiles: ["apps/server/src/registry/store.ts"] },
          lifecycle: {
            createdAt: "2026-06-30T00:00:00+08:00",
            verifiedAt: "2026-06-30T00:00:00+08:00",
            lastCheckedAt: "2026-06-30T00:00:00+08:00",
            confidence: "medium",
            supersedes: [],
            supersededBy: null,
            conflictsWith: [],
            staleReasons: []
          }
        }),
        ".harness/archive/2026-06-30-sample/reports/final/summary-data.json": JSON.stringify({
          changeName: "sample",
          finalStatus: "OK"
        })
      }
    }));
    app = await createServer({
      repository,
      storage: new MemoryArtifactStorage(),
      semanticStore
    });
  });

  afterEach(async () => app.close());

  it("rejects unauthenticated MCP HTTP requests with 401", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("AUTH_REQUIRED");
  });

  it("exposes four read-only tools through an SDK client", async () => {
    const mcpServer = createSemanticMcpServer({
      semanticStore,
      repository,
      actorId: "actor_owner"
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "semantic-mcp-test", version: "1.0.0" });
    await mcpServer.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "get_knowledge_entry",
      "get_project_overview",
      "list_recent_changes",
      "search_knowledge"
    ]);

    const search = await client.callTool({
      name: "search_knowledge",
      arguments: { query: "LlmClient", project_id: projectId }
    });
    expect(search.isError).toBeFalsy();
    const searchText = (search.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(searchText).toContain("Reuse LlmClient");

    const overview = await client.callTool({
      name: "get_project_overview",
      arguments: { project_id: projectId }
    });
    const overviewText = (overview.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(overviewText).toContain(projectId);
    expect(overviewText).toContain("\"knowledge\": 1");

    const entry = await client.callTool({
      name: "get_knowledge_entry",
      arguments: {
        project_id: projectId,
        source_path: ".harness/knowledge/entries/active/decision.json"
      }
    });
    const entryText = (entry.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(entryText).toContain("Reuse LlmClient");

    const changes = await client.callTool({
      name: "list_recent_changes",
      arguments: { project_id: projectId, limit: 5 }
    });
    const changesText = (changes.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(changesText).toContain("sample");

    await client.close();
    await mcpServer.close();
  });
});
