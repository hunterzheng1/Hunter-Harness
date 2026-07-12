import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { authenticateRequest } from "../auth/tokens.js";
import type { ServerRepository } from "../repositories/interfaces.js";
import { ServerDomainError } from "../repositories/interfaces.js";
import type { SemanticStore } from "../semantic/store.js";
import { createSemanticMcpServer } from "./semantic-server.js";

export function registerSemanticMcpRoutes(
  app: FastifyInstance,
  deps: {
    repository: ServerRepository;
    semanticStore: SemanticStore;
  }
): void {
  const methodNotAllowed = async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.code(405).header("Allow", "POST").send({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed. Use POST /mcp." },
      id: null
    });
  };

  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  app.post("/mcp", async (request, reply) => {
    const actor = await authenticateRequest(request, deps.repository);
    const mcpServer = createSemanticMcpServer({
      semanticStore: deps.semanticStore,
      repository: deps.repository,
      actorId: actor.actorId
    });
    // Stateless Streamable HTTP: omit sessionIdGenerator so each request is independent.
    const transport = new StreamableHTTPServerTransport({});
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void mcpServer.close();
    });
    try {
      await mcpServer.connect(transport as Transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      if (!reply.raw.headersSent) {
        const status = error instanceof ServerDomainError ? error.status : 500;
        const message = error instanceof Error ? error.message : "Internal server error";
        reply.raw.statusCode = status;
        reply.raw.setHeader("content-type", "application/json");
        reply.raw.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message },
          id: null
        }));
      }
    }
  });
}
