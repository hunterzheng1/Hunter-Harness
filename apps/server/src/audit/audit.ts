import type { TransactionRepository } from "../repositories/interfaces.js";

export async function writeAudit(
  repository: TransactionRepository,
  input: {
    actorId: string;
    projectId: string | null;
    action: string;
    targetId: string;
    requestId: string;
    details?: Record<string, unknown>;
  }
): Promise<void> {
  await repository.appendAudit({
    actorId: input.actorId,
    projectId: input.projectId,
    action: input.action,
    targetId: input.targetId,
    requestId: input.requestId,
    details: input.details ?? {}
  });
}
