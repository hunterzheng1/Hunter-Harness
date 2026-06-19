# Hunter Harness Local MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Implement the complete locally developable Hunter Harness MVP from the approved specification, including CLI, core protocols, Skill IR compilation, local server/Web implementation, tests, incremental commits, and server deployment documentation.

**Architecture:** Use an npm-workspaces TypeScript monorepo with shared contracts, a platform-neutral core, a thin CLI, a Fastify server, and a Next.js Web Console. PostgreSQL is the production metadata store behind repository interfaces; tests use deterministic in-memory repositories. Artifact storage is interface-driven with a local-filesystem MVP implementation and an S3/MinIO-compatible boundary.

**Tech Stack:** Node.js 24, TypeScript, npm workspaces, Vitest, Zod, YAML, Commander, Fastify, PostgreSQL, React/Next.js, OpenAPI 3.1.

---

### Task 1: Repository and toolchain baseline

**Files:**
- Create: package.json
- Create: tsconfig.base.json
- Create: vitest.workspace.ts
- Create: eslint.config.mjs
- Create: packages/contracts/package.json
- Create: packages/core/package.json
- Create: packages/cli/package.json
- Create: apps/server/package.json
- Create: apps/web/package.json
- Create: tests/smoke/workspace.test.ts

- [ ] Write a failing workspace smoke test that imports every package entry point.
- [ ] Run npm test -- tests/smoke/workspace.test.ts and verify module-resolution failure.
- [ ] Add workspace package manifests, TypeScript references, lint/build/test scripts, and empty typed entry points.
- [ ] Run npm install, npm run typecheck, npm test, and npm run build.
- [ ] Commit with message: chore: scaffold TypeScript monorepo.

### Task 2: Shared schemas, errors, and OpenAPI contract

**Files:**
- Create: packages/contracts/src/file-policy.ts
- Create: packages/contracts/src/project.ts
- Create: packages/contracts/src/protocol.ts
- Create: packages/contracts/src/knowledge.ts
- Create: packages/contracts/src/skill-ir.ts
- Create: packages/contracts/src/errors.ts
- Create: packages/contracts/src/index.ts
- Create: apps/server/openapi/hunter-harness-v1.yaml
- Create: packages/contracts/test/schemas.test.ts

- [ ] Write failing schema tests for offline project config, file kinds/policies, operations, tombstones, Skill IR, Knowledge frontmatter, API error envelopes, and unknown schema versions.
- [ ] Verify failures because schemas and canonical serializers do not exist.
- [ ] Implement Zod schemas, inferred TypeScript types, canonical JSON, UUID/hash validation, stable error codes, and the complete /api/v1 OpenAPI 3.1 document.
- [ ] Run contracts tests, typecheck, and an OpenAPI parse/route coverage test.
- [ ] Commit with message: feat: define shared protocol contracts.

### Task 3: Filesystem safety and file-policy engine

**Files:**
- Create: packages/core/src/fs/path-safety.ts
- Create: packages/core/src/fs/hash.ts
- Create: packages/core/src/policy/file-policy.ts
- Create: packages/core/src/managed/managed-block.ts
- Create: packages/core/test/path-safety.test.ts
- Create: packages/core/test/file-policy.test.ts
- Create: packages/core/test/managed-block.test.ts

- [ ] Write failing tests for path traversal, absolute paths, symlinks, case collisions, illegal Windows names, long paths, policy specificity, project-local confirmation, and managed-block preservation.
- [ ] Verify each test fails for the missing behavior.
- [ ] Implement safe relative-path normalization, SHA-256 helpers, the mutually exclusive file-policy matrix, and idempotent managed-block updates.
- [ ] Run focused tests and the full workspace checks.
- [ ] Commit with message: feat: enforce filesystem and file policies.

### Task 4: Protocol state, locks, and transaction rollback

**Files:**
- Create: packages/core/src/state/layout.ts
- Create: packages/core/src/state/baseline.ts
- Create: packages/core/src/state/locks.ts
- Create: packages/core/src/transaction/journal.ts
- Create: packages/core/src/transaction/transaction.ts
- Create: packages/core/src/transaction/recovery.ts
- Create: packages/core/test/transaction.test.ts
- Create: packages/core/test/recovery.test.ts

- [ ] Write failing tests for baseline-only protocol writes, active/stale locks, atomic add/modify/delete/rename, injected failures, interrupted recovery, rollback, retention, and cross-volume rejection.
- [ ] Verify byte-for-byte rollback tests fail before implementation.
- [ ] Implement the state layout, lock lease, same-volume staging, journal state machine, before/after manifests, recovery, rollback, and cleanup.
- [ ] Run transaction tests repeatedly with deterministic failure injection and then all tests.
- [ ] Commit with message: feat: add transactional update state.

### Task 5: Skill IR and Claude Code adapter compiler

**Files:**
- Create: packages/core/src/skill-ir/normalize.ts
- Create: packages/core/src/skill-ir/overlay.ts
- Create: packages/core/src/skill-ir/compiler.ts
- Create: packages/core/src/skill-ir/adapters/claude-code.ts
- Create: resources/bootstrap-ir/manifest.json
- Create: resources/bootstrap-ir/skills/*.yaml
- Create: resources/bootstrap-ir/templates/claude-code-skill.md
- Create: packages/core/test/skill-compiler.test.ts

- [ ] Write failing tests for overlay precedence, forbidden-action union, capability intersection, deterministic output hash, provenance header, all-profile optimizer enablement, and Claude SKILL.md generation.
- [ ] Verify the compiler tests fail before the compiler and bootstrap bundle exist.
- [ ] Migrate validated Java/GSD/optimizer workflows into canonical IR without old paths, env skills, automatic Git writes, or broad tool grants.
- [ ] Implement deterministic IR normalization and the real Claude Code adapter compiler; add schema-only placeholder adapters for Codex/Generic/MCP.
- [ ] Run compiler tests, snapshot tests, and scans for forbidden legacy strings.
- [ ] Commit with message: feat: compile bootstrap Skill IR for Claude Code.

### Task 6: Offline initialization CLI

**Files:**
- Create: packages/cli/src/bin.ts
- Create: packages/cli/src/commands/configure.ts
- Create: packages/cli/src/config/init-config.ts
- Create: packages/cli/src/output/json.ts
- Create: packages/core/src/project/initialize.ts
- Create: packages/cli/test/init.test.ts

- [ ] Write failing CLI tests for interactive defaults, --adapter, --profile, highest-priority --config, --non-interactive failure, --yes, --dry-run, --json, token non-persistence, existing files, and offline initialization.
- [ ] Verify the tests fail because the command is absent.
- [ ] Implement the single public configure/init command, local_project_key, project_id=null, project.yaml, state directories, AGENTS.md, minimal CLAUDE.md, rules, context index, Knowledge layout, and compiled Claude skills.
- [ ] Verify dry-run writes nothing and repeated initialization is idempotent.
- [ ] Run CLI tests and full checks.
- [ ] Commit with message: feat: implement offline project initialization.

### Task 7: Knowledge, context index, and codebase-map support

**Files:**
- Create: packages/core/src/knowledge/frontmatter.ts
- Create: packages/core/src/knowledge/index.ts
- Create: packages/core/src/context/index.ts
- Create: packages/core/src/codebase/map.ts
- Create: packages/core/test/knowledge.test.ts
- Create: packages/core/test/codebase-map.test.ts

- [ ] Write failing tests for Knowledge states, duplicate IDs/content, supersedes cycles, stale/expiry, project-local exclusion, candidate promotion boundaries, index rebuilds, and generated-reviewable map outputs.
- [ ] Verify failures before implementation.
- [ ] Implement Markdown/frontmatter parsing, deterministic index generation, candidate checks, context-index generation, seven-map-document validation, and stale/missing recommendations without automatic mapping.
- [ ] Run focused and full tests.
- [ ] Commit with message: feat: add knowledge and context indexing.

### Task 8: Sensitive scanning and proposal diff generation

**Files:**
- Create: packages/core/src/security/scanner.ts
- Create: packages/core/src/security/entropy.ts
- Create: packages/core/src/security/allowlist.ts
- Create: packages/core/src/proposal/diff.ts
- Create: packages/core/src/proposal/preview.ts
- Create: packages/core/test/security-scanner.test.ts
- Create: packages/core/test/proposal-diff.test.ts

- [ ] Write failing tests for rules, entropy, private keys, tokens, medium/low overrides, immutable override evidence, add/modify/delete/rename, tombstones, project-local confirmation, and disallowed paths.
- [ ] Verify high-risk bypass attempts fail.
- [ ] Implement redacted findings, versioned scan rules, allowlist/ignore comments for medium/low risk only, manifest comparison, explicit tombstones, rename detection, and preview models.
- [ ] Run security and proposal tests plus all checks.
- [ ] Commit with message: feat: build secure proposal previews.

### Task 9: API client and push command

**Files:**
- Create: packages/core/src/api/client.ts
- Create: packages/core/src/api/retry.ts
- Create: packages/core/src/push/push.ts
- Create: packages/cli/src/commands/push.ts
- Create: packages/cli/test/push.test.ts
- Create: packages/core/test/api-client.test.ts

- [ ] Write failing tests for token_env, HTTPS, projects:resolve create/bind/conflict, idempotency replay, blob query, chunk retry/resume, finalize, dry-run, exit codes, and baseline non-advancement.
- [ ] Verify failures using a deterministic mock HTTP server.
- [ ] Implement the versioned API client, first-push binding transaction, resumable upload state, push preview/JSON output, and local push result.
- [ ] Run focused tests, then full checks.
- [ ] Commit with message: feat: implement proposal push workflow.

### Task 10: Update command and recovery menu

**Files:**
- Create: packages/core/src/update/update.ts
- Create: packages/core/src/update/conflicts.ts
- Create: packages/cli/src/commands/update.ts
- Create: packages/cli/src/commands/recovery.ts
- Create: packages/cli/test/update.test.ts
- Create: packages/cli/test/recovery-menu.test.ts

- [ ] Write failing tests for approved-only deltas, cache/hash validation, managed-block updates, dirty skill/rule/map skips, tombstone safety, eligible-set atomicity, partial-dirty exit code, interruption, rollback, and cleanup menu actions.
- [ ] Verify failures before implementation.
- [ ] Implement update-manifest/blob downloads, cache, dirty comparison, transactional apply, per-file baseline advancement, reports, and recovery/configuration menu actions.
- [ ] Run failure-injection tests and full checks.
- [ ] Commit with message: feat: implement transactional updates.

### Task 11: Server repositories, API, review, and artifacts

**Files:**
- Create: apps/server/src/app.ts
- Create: apps/server/src/config.ts
- Create: apps/server/src/auth/tokens.ts
- Create: apps/server/src/repositories/interfaces.ts
- Create: apps/server/src/repositories/memory.ts
- Create: apps/server/src/repositories/postgres.ts
- Create: apps/server/src/storage/interface.ts
- Create: apps/server/src/storage/local.ts
- Create: apps/server/src/routes/*.ts
- Create: apps/server/src/audit/audit.ts
- Create: apps/server/migrations/*.sql
- Create: apps/server/test/api.test.ts

- [ ] Write failing route-contract tests for every /api/v1 endpoint, authentication, ownership, owner self-review, append-only audit, limits, idempotency, pagination, blob integrity, split, reject, approve, and approved-only artifact access.
- [ ] Verify tests fail with no server.
- [ ] Implement repository/storage interfaces, deterministic in-memory tests, PostgreSQL production repository, local artifact storage, routes, review/version publisher, and audit.
- [ ] Run server tests against memory and a PostgreSQL integration profile.
- [ ] Commit with message: feat: implement governed server API.

### Task 12: Web Console

**Files:**
- Create: apps/web/app/layout.tsx
- Create: apps/web/app/page.tsx
- Create: apps/web/app/projects/page.tsx
- Create: apps/web/app/proposals/page.tsx
- Create: apps/web/app/proposals/[id]/page.tsx
- Create: apps/web/lib/api.ts
- Create: apps/web/test/web.test.tsx

- [ ] Write failing component tests for Dashboard, Project Registry, Review Queue, proposal details, approve/reject/split, artifact history, loading, auth failure, and redacted errors.
- [ ] Verify tests fail before pages exist.
- [ ] Implement the minimal Next.js UI backed exclusively by /api/v1.
- [ ] Run component tests, typecheck, and production build.
- [ ] Commit with message: feat: add review web console.

### Task 13: End-to-end validation and deployment documentation

**Files:**
- Create: tests/e2e/harness.e2e.test.ts
- Create: docker-compose.yml
- Create: apps/server/Dockerfile
- Create: apps/web/Dockerfile
- Create: .env.example
- Create: docs/SERVER-DEPLOYMENT.md
- Modify: README.md
- Modify: requirements/hunter-harness-complete-dev/docs/99-FINAL-AUDIT.md when implementation evidence supersedes documentation-only status.

- [ ] Write an end-to-end test for offline init -> first push resolve -> upload -> owner approve -> update -> dirty skip -> rollback.
- [ ] Run it before final wiring and confirm the missing integration fails.
- [ ] Add container builds, PostgreSQL migration startup, persistent artifact volume, health checks, reverse-proxy/TLS guidance, token bootstrap, backups, restore, retention, observability, upgrades, and rollback instructions.
- [ ] Run npm run lint, npm run typecheck, npm test, npm run build, container configuration validation, CLI help/smoke, and the full end-to-end test.
- [ ] Commit with message: docs: add production server deployment guide.

### Task 14: Final completion audit

**Files:**
- Modify: docs/SERVER-DEPLOYMENT.md if verification reveals gaps.
- Modify: README.md

- [ ] Map every approved specification requirement to implementation and test evidence.
- [ ] Verify only three public npx commands exist.
- [ ] Verify no token, old env skill, old path, automatic Git write, unmanaged CodeGraph content, or state/cache content enters proposals.
- [ ] Verify Git working tree is clean and list all milestone commits.
- [ ] Run the complete verification suite again from a clean install.
- [ ] Commit any final evidence-only corrections with message: chore: complete MVP verification audit.

