import { uuidV7 } from "@hunter-harness/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createServer } from "../src/app.js";
import { MemoryRepository } from "../src/repositories/memory.js";
import { SemanticMemoryStore } from "../src/semantic/memory-store.js";
import { buildSemanticIndex } from "../src/semantic/indexer.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

describe("/api/v1 semantic query routes", () => {
  const token = "semantic-owner-token";
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
      displayName: "Semantic Sample",
      requestedProjectId: null
    });
    projectId = resolved.project.projectId;
    await semanticStore.rebuild(buildSemanticIndex({
      projectId,
      artifactId: "art_semantic1",
      files: {
        "CLAUDE.md": "# Sample project\n",
        ".claude/rules/harness-general.md": "general rule\n",
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

  function headers(): Record<string, string> {
    return {
      authorization: "Bearer " + token,
      "x-request-id": uuidV7(),
      "idempotency-key": uuidV7()
    };
  }

  it("returns overview, knowledge, rules, changes, graph, and search hits", async () => {
    const overview = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/semantic/overview`,
      headers: headers()
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      project_id: projectId,
      artifact_id: "art_semantic1",
      counts: {
        documents: 4,
        knowledge: 1,
        rules: 1,
        changes: 1,
        agent_instructions: 1
      }
    });

    const knowledge = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/semantic/knowledge`,
      headers: headers()
    });
    expect(knowledge.statusCode).toBe(200);
    expect(knowledge.json().items).toHaveLength(1);
    expect(knowledge.json().items[0].title).toBe("Reuse LlmClient");

    const rules = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/semantic/rules`,
      headers: headers()
    });
    expect(rules.statusCode).toBe(200);
    expect(rules.json().items).toHaveLength(1);

    const changes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/semantic/changes`,
      headers: headers()
    });
    expect(changes.statusCode).toBe(200);
    expect(changes.json().items[0].title).toBe("sample");

    const graph = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/semantic/graph`,
      headers: headers()
    });
    expect(graph.statusCode).toBe(200);
    expect(graph.json()).toMatchObject({
      nodes: [],
      edges: [],
      relation_status: "no_relations",
      indexed_documents: 4
    });

    const knowledgeDocumentId = knowledge.json().items[0].document_id as string;
    const focusedGraph = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/semantic/graph?focus_document_id=${encodeURIComponent(knowledgeDocumentId)}`,
      headers: headers()
    });
    expect(focusedGraph.statusCode).toBe(200);
    expect(focusedGraph.json()).toMatchObject({
      focus_document_id: knowledgeDocumentId,
      relation_status: "no_relations"
    });
    expect(focusedGraph.json().nodes).toHaveLength(1);

    const search = await app.inject({
      method: "GET",
      url: `/api/v1/semantic/search?q=LlmClient&project_id=${encodeURIComponent(projectId)}`,
      headers: headers()
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().items).toHaveLength(1);
    expect(search.json().items[0].project_id).toBe(projectId);
  });

  it("rejects empty search query", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/semantic/search?q=",
      headers: headers()
    });
    expect(response.statusCode).toBe(400);
  });
});
