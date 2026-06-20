import { fileURLToPath } from "node:url";

import { sha256Bytes, uuidV7 } from "@hunter-harness/core";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../src/repositories/migrate.js";
import { PostgresRepository } from "../src/repositories/postgres.js";

const databaseUrl = process.env.HUNTER_HARNESS_TEST_DATABASE_URL;
const postgresDescribe = databaseUrl === undefined ? describe.skip : describe;

postgresDescribe("PostgreSQL repository integration", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const repository = new PostgresRepository(pool);

  beforeAll(async () => {
    await runMigrations(
      pool,
      fileURLToPath(new URL("../migrations", import.meta.url))
    );
    await pool.query(`
      TRUNCATE TABLE
        idempotency_records, audit_events, reviews, artifacts, proposal_items,
        proposals, proposal_sessions, project_bindings, projects, api_tokens, actors
      CASCADE
    `);
    await repository.createActorWithToken({
      actorId: "actor_pg",
      token: "postgres-test-token"
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("persists binding, proposal review, artifact, audit, and idempotency", async () => {
    expect(await repository.authenticateToken("postgres-test-token")).toEqual({
      actorId: "actor_pg"
    });
    const resolved = await repository.resolveProject({
      actorId: "actor_pg",
      localProjectKey: uuidV7(),
      displayName: "postgres project",
      requestedProjectId: null
    });
    const content = "# pg rule\n";
    const session = await repository.createProposalSession({
      projectId: resolved.project.projectId,
      actorId: "actor_pg",
      baseProjectVersion: null,
      baseManifestHash: sha256Bytes("baseline"),
      operations: [{
        operation: "add",
        path: ".claude/rules/postgres.md",
        file_kind: "user_editable",
        content_sha256: sha256Bytes(content),
        size_bytes: Buffer.byteLength(content)
      }],
      scanOverrides: [],
      status: "open",
      expiresAt: "2099-01-01T00:00:00Z",
      maxChunkBytes: 1024
    });
    const proposal = await repository.createProposalFromSession(session);
    const review = await repository.reviewProposal({
      actorId: "actor_pg",
      proposalId: proposal.proposalId,
      decision: "approve",
      comment: "verified",
      targetScope: "project",
      splitGroups: []
    });
    expect(review.artifactId).toMatch(/^art_/);
    expect((await repository.getLatestArtifact(
      "actor_pg", resolved.project.projectId
    ))?.proposalId).toBe(proposal.proposalId);

    const audit = await repository.appendAudit({
      actorId: "actor_pg",
      projectId: resolved.project.projectId,
      action: "test.event",
      targetId: proposal.proposalId,
      requestId: uuidV7(),
      details: {}
    });
    await expect(pool.query(
      `UPDATE audit_events SET action = 'tampered' WHERE event_id = $1`,
      [audit.eventId]
    )).rejects.toThrow(/append-only/i);

    const lockInput = {
      actorId: "actor_pg",
      method: "POST",
      path: "/test",
      key: uuidV7()
    };
    const lock = await repository.acquireIdempotencyLock(lockInput);
    await repository.putIdempotency({
      ...lockInput,
      bodyHash: sha256Bytes("body"),
      statusCode: 201,
      response: { ok: true }
    });
    await lock.release();
    expect(await repository.getIdempotency(lockInput)).toMatchObject({
      statusCode: 201,
      response: { ok: true }
    });
  });
});
