import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SemanticDocument } from "@hunter-harness/contracts";
import type { ProjectRecord, ServerRepository } from "../repositories/interfaces.js";
import { ServerDomainError } from "../repositories/interfaces.js";
import type { SemanticStore } from "../semantic/store.js";

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

async function listAccessibleProjects(
  repository: ServerRepository,
  actorId: string
): Promise<ProjectRecord[]> {
  const projects: ProjectRecord[] = [];
  let cursor: string | null = null;
  do {
    const page = await repository.listProjects({ actorId, limit: 100, cursor });
    projects.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return projects;
}

function documentType(document: SemanticDocument): unknown {
  return document.metadata.entry_type ?? document.metadata.knowledge_type ?? document.metadata.type;
}

function requireProjectId(project: string | undefined, projectId: string | undefined): string {
  const value = project ?? projectId;
  if (value === undefined || value === "") {
    throw new ServerDomainError(400, "VALIDATION_FAILED", "project is required");
  }
  return value;
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
      project: z.string().optional().describe("Optional project id to scope the search"),
      project_id: z.string().optional().describe("Deprecated alias for project"),
      status: z.string().optional().describe("Filter results by knowledge status (e.g. active, candidate, stale)"),
      type: z.string().optional().describe("Filter results by knowledge/entry type (e.g. decision, architecture)"),
      limit: z.number().int().min(1).max(100).optional().describe("Max items (default 20)")
    },
    async ({ query, project, project_id, status, type, limit }) => {
      const projectId = project ?? project_id;
      if (projectId !== undefined) {
        await assertProjectAccess(deps.repository, deps.actorId, projectId);
      }
      const documents = await deps.semanticStore.search(query, projectId);
      const filtered = documents.filter((document) => {
        if (status !== undefined && document.metadata.status !== status) return false;
        if (type !== undefined && documentType(document) !== type) return false;
        return true;
      });
      const capped = filtered.slice(0, limit ?? 20);
      const items = capped.map((document) => ({
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
      project: z.string().optional().describe("Project id"),
      project_id: z.string().optional().describe("Deprecated alias for project")
    },
    async ({ project, project_id }) => {
      const projectId = requireProjectId(project, project_id);
      await assertProjectAccess(deps.repository, deps.actorId, projectId);
      const overview = await deps.semanticStore.overview(projectId);
      return textResult(overview);
    }
  );

  server.tool(
    "get_knowledge_entry",
    "Fetch one knowledge document by id (matches document_id, metadata.entry_id, or metadata.knowledge_id) across accessible projects (read-only).",
    {
      id: z.string().min(1).describe("document_id, metadata.entry_id, or metadata.knowledge_id")
    },
    async ({ id }) => {
      const projects = await listAccessibleProjects(deps.repository, deps.actorId);
      for (const project of projects) {
        const documents = await deps.semanticStore.listByKinds(project.projectId, [
          "knowledge_entry",
          "knowledge_markdown"
        ]);
        const match = documents.find((document) =>
          document.document_id === id ||
          document.metadata.entry_id === id ||
          document.metadata.knowledge_id === id
        );
        if (match !== undefined) {
          return textResult({ document: match });
        }
      }
      throw new ServerDomainError(404, "NOT_FOUND", "knowledge entry not found", { id });
    }
  );

  server.tool(
    "list_recent_changes",
    "List archive change documents for a project (read-only).",
    {
      project: z.string().optional().describe("Project id"),
      project_id: z.string().optional().describe("Deprecated alias for project"),
      limit: z.number().int().min(1).max(100).optional().describe("Max items (default 20)")
    },
    async ({ project, project_id, limit }) => {
      const projectId = requireProjectId(project, project_id);
      await assertProjectAccess(deps.repository, deps.actorId, projectId);
      const items = await deps.semanticStore.listByKinds(projectId, ["archive_record"]);
      const capped = items.slice(0, limit ?? 20);
      return textResult({ items: capped });
    }
  );

  return server;
}
