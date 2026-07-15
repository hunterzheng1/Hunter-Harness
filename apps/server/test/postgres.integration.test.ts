import { fileURLToPath } from "node:url";

import { sha256Bytes, uuidV7 } from "@hunter-harness/core";
import type { SourceFile } from "@hunter-harness/contracts";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../src/repositories/migrate.js";
import { PostgresRepository } from "../src/repositories/postgres.js";
import { PostgresRegistryPersistence } from "../src/registry/persistence.js";
import { RegistryStore } from "../src/registry/store.js";
import { MemoryArtifactStorage } from "../src/storage/memory.js";

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
        semantic_edges, semantic_documents, project_files_current,
        registry_state, idempotency_records, audit_events, reviews, artifacts, proposal_items,
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

  it("serializes restore against permanent purge and releases purged bindings", async () => {
    const concurrent = await repository.resolveProject({
      actorId: "actor_pg",
      localProjectKey: uuidV7(),
      displayName: "concurrent lifecycle",
      requestedProjectId: null
    });
    await repository.archiveProject("actor_pg", concurrent.project.projectId, new Date().toISOString());
    const outcomes = await Promise.allSettled([
      repository.restoreProject("actor_pg", concurrent.project.projectId),
      repository.purgeProject("actor_pg", concurrent.project.projectId, new Date().toISOString())
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);

    const localProjectKey = uuidV7();
    const original = await repository.resolveProject({
      actorId: "actor_pg",
      localProjectKey,
      displayName: "binding replacement",
      requestedProjectId: null
    });
    await repository.archiveProject("actor_pg", original.project.projectId, new Date().toISOString());
    await repository.purgeProject("actor_pg", original.project.projectId, new Date().toISOString());
    const replacement = await repository.resolveProject({
      actorId: "actor_pg",
      localProjectKey,
      displayName: "binding replacement 2",
      requestedProjectId: null
    });
    expect(replacement.project.projectId).not.toBe(original.project.projectId);
  });

  it("persists the canonical registry snapshot across process instances", async () => {
    const persistence = new PostgresRegistryPersistence(pool);
    const snapshot = {
      schemaVersion: 1,
      compilerVersion: "1.0.0",
      skills: [["harness-sync", { latestVersion: "1.0.0" }]],
      proposals: [],
      tags: [],
      workflows: [],
      projectBindings: []
    };
    await persistence.save(snapshot);
    await expect(new PostgresRegistryPersistence(pool).load()).resolves.toEqual(snapshot);
  });

  // 簇C INT-005：PG 路径 store.initialize 反序列化——publish 多 agent skill → PG save → 新 store initialize →
  // artifacts metadata + per-agent latestVersion 一致。artifact blob 不在 PG（memory storage 跨实例不共享），
  // 仅验 metadata 数量/agent；latestVersion 来自 snapshot.detail.agents（agentsFor 写入）。
  // per-agent publish：每个 agent 各 upsertDraft + publish 1.0.0（独立版本序列），各产 1 version 记录(artifacts[1])。
  it("INT-005: publish multi-agent skill → PG save → reload initialize preserves artifacts + per-agent latestVersion", async () => {
    const ir = {
      name: "harness-pg-multi", kind: "tooling", description: "pg multi-agent",
      triggers: ["run"], inputs: [], outputs: ["out"],
      forbidden_actions: [], required_context: [],
      profiles: { general: { enabled: true } },
      adapters: { "claude-code": { enabled: true }, cursor: { enabled: true }, codex: { enabled: true } },
      version: "1.0.0"
    };
    const files: SourceFile[] = [{ path: "skill.yaml", content: [
      "name: harness-pg-multi", "kind: tooling", "description: pg multi-agent",
      'triggers: ["run"]', "inputs: []", 'outputs: ["out"]',
      "forbidden_actions: [automatic_git_write]", "required_context: [AGENTS.md]",
      "profiles: { general: { enabled: true } }",
      "adapters: { claude-code: { enabled: true }, cursor: { enabled: true }, codex: { enabled: true } }",
      'version: "1.0.0"'
    ].join("\n") }];
    const persistence = new PostgresRegistryPersistence(pool);
    const store = new RegistryStore(new MemoryArtifactStorage(), persistence);
    for (const agent of ["claude-code", "cursor", "codex"] as const) {
      await store.upsertDraft({ slug: "harness-pg-multi", agent, sourceFiles: files, ir, draftVersion: "0.1.0" });
      await store.publish({ slug: "harness-pg-multi", agent, version: "1.0.0", actorId: "actor_pg" });
    }
    const store2 = new RegistryStore(new MemoryArtifactStorage(), persistence);
    await store2.initialize();
    const skill = store2.getSkill("harness-pg-multi");
    expect(skill.latest_version).toBe("1.0.0");
    expect(skill.agents.find((a) => a.agent === "cursor")?.latestVersion).toBe("1.0.0");
    expect(skill.agents.find((a) => a.agent === "codex")?.latestVersion).toBe("1.0.0");
    const versions = store2.listVersions("harness-pg-multi");
    // per-agent：3 个 agent 各 1 version 记录（artifacts[1]），共 3 artifact
    expect(versions.length).toBe(3);
    expect(versions.flatMap((v) => v.artifacts).map((a) => a.agent).sort()).toEqual(["claude-code", "codex", "cursor"]);
  });

  // 簇C COM-002/003：PG 路径旧 snapshot（schemaVersion:1，无 aiConfig/aiUsage，adapters 为字符串数组即 agents 无 draftVersion）
  // 经 migrateSkillDetail 兜底不崩 + 默认值正确。memory 路径同逻辑已由 store.test.ts 覆盖，此处验 PG jsonb 往返 + migrate。
  it("COM-002/003: legacy PG snapshot (no aiConfig, string adapters) initialize without crash + defaults", async () => {
    const legacySnapshot = {
      schemaVersion: 1,
      compilerVersion: "1.0.0",
      skills: [["harness-pg-legacy", {
        detail: {
          skill_id: "skl_pg_legacy", slug: "harness-pg-legacy", name: "harness-pg-legacy", description: "legacy",
          category: "governance", tags: [], status: "published", latest_version: "1.0.0",
          adapters: ["claude-code"], revision: 1,
          created_at: "2026-06-20T00:00:00Z", updated_at: "2026-06-20T00:00:00Z",
          ir: {
            name: "harness-pg-legacy", kind: "tooling", description: "legacy",
            triggers: ["run"], inputs: [], outputs: ["out"],
            forbidden_actions: [], required_context: [],
            profiles: { general: { enabled: true } },
            adapters: { "claude-code": { enabled: true } },
            version: "1.0.0"
          }
        },
        versions: []
      }]],
      proposals: [], tags: [], workflows: [], projectBindings: []
    };
    const persistence = new PostgresRegistryPersistence(pool);
    await persistence.save(legacySnapshot);
    const store = new RegistryStore(new MemoryArtifactStorage(), persistence);
    await store.initialize();
    const skill = store.getSkill("harness-pg-legacy");
    expect(skill.latest_version).toBe("1.0.0");
    expect(skill.agents).toHaveLength(1);
    expect(skill.agents[0]?.agent).toBe("claude-code");
    expect(skill.agents[0]?.latestVersion).toBe("1.0.0");
    expect(skill).not.toHaveProperty("category");
  });

  // COM-004: per-agent nested drafts (v3 snapshot) PG jsonb round-trip。
  // UT-031 验 memory 路径 drafts[slug][agent] 嵌套序列化结构；此用例验 PG jsonb 持久化 + 新 store initialize 保持嵌套。
  it("COM-004: per-agent nested drafts (v3 snapshot) round-trip through PG jsonb", async () => {
    const ir = {
      name: "harness-pg-drafts", kind: "tooling", description: "pg drafts nested",
      triggers: ["run"], inputs: [], outputs: ["out"],
      forbidden_actions: [], required_context: [],
      profiles: { general: { enabled: true } },
      adapters: { "claude-code": { enabled: true }, cursor: { enabled: true } },
      version: "1.0.0"
    };
    const files: SourceFile[] = [{ path: "skill.yaml", content: [
      "name: harness-pg-drafts", "kind: tooling", "description: pg drafts nested",
      'triggers: ["run"]', "inputs: []", 'outputs: ["out"]',
      "forbidden_actions: [automatic_git_write]", "required_context: [AGENTS.md]",
      "profiles: { general: { enabled: true } }",
      "adapters: { claude-code: { enabled: true }, cursor: { enabled: true } }",
      'version: "1.0.0"'
    ].join("\n") }];
    const persistence = new PostgresRegistryPersistence(pool);
    const store = new RegistryStore(new MemoryArtifactStorage(), persistence);
    // 建 per-agent drafts（不 publish）— drafts[slug][agent] 嵌套结构
    await store.upsertDraft({ slug: "harness-pg-drafts", agent: "claude-code", sourceFiles: files, ir, draftVersion: "0.1.0" });
    await store.upsertDraft({ slug: "harness-pg-drafts", agent: "cursor", sourceFiles: files, ir, draftVersion: "0.2.0" });
    // reload：新 store 实例从 PG 加载 snapshot
    const store2 = new RegistryStore(new MemoryArtifactStorage(), persistence);
    await store2.initialize();
    // 验证 drafts[slug][agent] 嵌套结构 round-trip 保留
    const ccDraft = store2.getDraft("harness-pg-drafts", "claude-code");
    const cursorDraft = store2.getDraft("harness-pg-drafts", "cursor");
    expect(ccDraft).toBeDefined();
    expect(ccDraft?.agent).toBe("claude-code");
    expect(ccDraft?.draftVersion).toBe("0.1.0");
    expect(cursorDraft).toBeDefined();
    expect(cursorDraft?.agent).toBe("cursor");
    expect(cursorDraft?.draftVersion).toBe("0.2.0");
  });
});
