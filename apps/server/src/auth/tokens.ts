import type { FastifyRequest } from "fastify";

import type { Actor, ServerRepository } from "../repositories/interfaces.js";
import { ServerDomainError } from "../repositories/interfaces.js";

export async function authenticateRequest(
  request: FastifyRequest,
  repository: ServerRepository
): Promise<Actor> {
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    throw new ServerDomainError(401, "AUTH_REQUIRED", "Bearer authentication is required");
  }
  const token = authorization.slice("Bearer ".length);
  const actor = await repository.authenticateToken(token);
  if (actor === null) {
    throw new ServerDomainError(401, "TOKEN_INVALID", "API token is invalid");
  }
  return actor;
}
