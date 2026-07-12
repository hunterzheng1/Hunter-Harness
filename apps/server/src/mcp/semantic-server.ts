import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SemanticStore } from "../semantic/store.js";
import type { ServerRepository } from "../repositories/interfaces.js";
import { ServerDomainError } from "../repositories/interfaces.js";

export interface SemanticMcpDeps {
  semanticStore: SemanticStore;
  repository: ServerRepository;
  actorId: string;
}

function textResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
  };
}

async function assertProjectAccess(
  repository: ServerRepository,
  actorId: string,
  projectId: string
): Promise<void> {
  await repository.getProject(actorId, projectId);
}

export function createSemanticMcpServer(deps: SemanticMcpDeps): McpServer {
  const server = new McpServer({
    name: "hunter-harness-semantic",
    version: "0.1.0"
  });

  server.tool(
    "search_knowledge",
    "Search semantic knowledge documents across projects or within one project (read-only).",
    {
      query: z.string().min(1).describe("Search query text"),
      project_id: z.string().optional().describe("Optional project id to scope the search")
    },
    async ({ query, project_id }) => {
      if (project_id !== undefined) {
        await assertProjectAccess(deps.repository, deps.actorId, project_id);
      }
      const documents = await deps.semanticStore.search(query, project_id);
      const items = documents.map((document) => ({
        document,
        project_id: document.project_id
      }));
      return textResult({ items });
    }
  );

  server.tool(
    "get_project_overview",
    "Get semantic index overview counts for a project (read-only).",
    {
      project_id: z.string().min(1).describe("Project id")
    },
    async ({ project_id }) => {
      await assertProjectAccess(deps.repository, deps.actorId, project_id);
      const overview = await deps.semanticStore.overview(project_id);
      return textResult(overview);
    }
  );

  server.tool(
    "get_knowledge_entry",
    "Fetch one knowledge document by document_id or source_path within a project (read-only).",
    {
      project_id: z.string().min(1).describe("Project id"),
      document_id: z.string().optional().describe("Semantic document id"),
      source_path: z.string().optional().describe("Managed file path under the project artifact")
    },
    async ({ project_id, document_id, source_path }) => {
      await assertProjectAccess(deps.repository, deps.actorId, project_id);
      if ((document_id === undefined || document_id === "") &&
          (source_path === undefined || source_path === "")) {
        throw new ServerDomainError(
          400,
          "VALIDATION_FAILED",
          "document_id or source_path is required"
        );
      }
      const documents = await deps.semanticStore.listByKinds(project_id, [
        "knowledge_entry",
        "knowledge_markdown"
      ]);
      const match = documents.find((document) =>
        (document_id !== undefined && document.document_id === document_id) ||
        (source_path !== undefined && document.source_path === source_path)
      );
      if (match === undefined) {
        throw new ServerDomainError(404, "NOT_FOUND", "knowledge entry not found", {
          project_id,
          document_id: document_id ?? null,
          source_path: source_path ?? null
        });
      }
      return textResult({ document: match });
    }
  );

  server.tool(
    "list_recent_changes",
    "List archive change documents for a project (read-only).",
    {
      project_id: z.string().min(1).describe("Project id"),
      limit: z.number().int().min(1).max(100).optional().describe("Max items (default 20)")
    },
    async ({ project_id, limit }) => {
      await assertProjectAccess(deps.repository, deps.actorId, project_id);
      const items = await deps.semanticStore.listByKinds(project_id, ["archive_record"]);
      const capped = items.slice(0, limit ?? 20);
      return textResult({ items: capped });
    }
  );

  return server;
}
