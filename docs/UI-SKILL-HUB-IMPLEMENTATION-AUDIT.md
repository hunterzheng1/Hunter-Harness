# UI / Skill Hub Implementation Audit

This audit maps the approved optimization requirements to the implemented platform behavior. It is an engineering acceptance record, not a replacement for the product requirements.

## Scope delivered

| Requirement | Delivered behavior | Primary evidence |
|---|---|---|
| Real authenticated console | Production routes use one bearer-token API client and never fall back to mock data. Demo data requires `NEXT_PUBLIC_HUNTER_HARNESS_DEMO=true` and is globally labelled read-only. | `apps/web/lib/api.ts`, `apps/web/components/console.tsx`, `apps/web/components/client-layout.tsx` |
| Dark and Light UI | Shared semantic tokens cover both themes; first visit follows system preference and an explicit choice persists. Skill, Workflow, review and artifact views use the same information hierarchy in both themes. | `apps/web/app/globals.css`, `apps/web/lib/theme.tsx` |
| Canonical Skill Registry | Twelve bootstrap Skill IR records initialize the registry. List/detail/version, adapter preview, proposal, review, artifact and download APIs are versioned under `/api/v1`. | `apps/server/src/registry/store.ts`, `apps/server/src/app.ts`, OpenAPI contract |
| Skill review boundary | Upload and IR edits create a proposal. Only owner review can publish an immutable version and Claude Code ZIP artifact. Rejected proposals do not change canonical state. Versions must move forward. | `apps/server/src/registry/store.ts`, `apps/server/test/registry-api.test.ts` |
| Skill content and history | Skill detail shows canonical IR, contracts/security fields, provenance, adapter output, version history and JSON diff. | `apps/web/components/registry.tsx` |
| Skill download and command copy | Detail page selects an Agent, shows the exact `npx @hunter-harness/skill-cli install <slug> --agent <agent>` command, and downloads a published ZIP. Unsupported adapters remain contract-only. | `apps/web/components/registry.tsx`, registry artifact API |
| Independent Skill CLI | The npm package exposes only `install` and `upload`. Install verifies SHA-256 and ZIP identity, updates atomically, no-ops on an identical install and refuses dirty/unmanaged targets unless forced. Upload only creates a proposal. | `packages/skill-cli`, `scripts/smoke-pack.mjs` |
| Workflow direct maintenance | Workflow create/read/update/delete, enable/archive state and ordered Skill bindings are direct audited mutations with revision checks, validation and project-reference deletion protection. No proposal is created. | Registry store/API and Workflow workbench |
| Tag direct maintenance | Tags support create, rename, deactivate, merge and Skill bind/unbind as direct audited mutations. No proposal is created. | Registry store/API and Skill Center tag rail |
| Project integration | Project detail can view and directly bind its effective Workflow while project files remain governed by the existing push/review/update protocol. Project registry supports real search and role filtering. | `apps/web/components/project-workspace.tsx`, `apps/web/components/console.tsx` |
| Unified review and artifacts | Review queue combines project and Skill proposals while excluding Workflow/tag mutations. Artifact history combines project and Skill artifacts. | `apps/web/components/console.tsx` |
| Persistence and API contract | Registry state is persisted in PostgreSQL JSONB through migration `002_registry.sql`; every write route uses authentication, request IDs, idempotency and audit. OpenAPI documents every new route and shared error body. | persistence, migration, app routes, OpenAPI tests |
| Existing governance preserved | The project CLI still has exactly three public commands. Independent Skill install does not change project baseline or invoke Git. Existing file-policy, transaction and review flows remain intact. | root CLI/core tests plus Skill CLI smoke tests |

## Deliberate boundaries

- Claude Code is the only independently installable adapter in MVP. Codex, Generic and MCP remain visible contract targets until their compilers and target-path rules are verified.
- A Canonical Skill IR proposal is atomic, so item-level `split` is not offered for it. Existing project file proposals retain split review because they contain independently publishable operations.
- Dashboard trend, health and activity charts are not fabricated. Until aggregation endpoints exist, the dashboard limits itself to verifiable counts and navigation.
- Workflow is an ordered Skill profile, not a DAG runner or task scheduler.
- Registry persistence intentionally uses one versioned canonical JSONB snapshot for the MVP; the storage interface allows later normalized tables without changing public contracts.

## Verification gate

The change is acceptable only when all of the following complete successfully:

```text
npm run lint
npm run typecheck
npm test
npm run build
npm run smoke:pack
npm run test:postgres -w apps/server  # when HUNTER_HARNESS_TEST_DATABASE_URL is available
```

Browser acceptance additionally covers Dark/Light Skill Center, Skill detail, Workflow workbench, command copy/download affordances, explicit demo labelling, and desktop/mobile layouts. ## Executed verification — 2026-06-22

| Gate | Result | Evidence |
|---|---|---|
| Full quality gate | Passed | `npm run check`: ESLint, TypeScript, 29 test files passed, 124 tests passed; 1 file and 2 PostgreSQL-dependent tests were explicitly skipped because `HUNTER_HARNESS_TEST_DATABASE_URL` is not configured locally; production build and pack smoke also completed. |
| Focused UI regression | Passed | `npx vitest run apps/web/test/project-workspace.test.tsx apps/web/test/registry.test.tsx`: 2 files / 7 tests passed. |
| Publish-package smoke | Passed | `npm run smoke:pack`: both `hunter-harness` and `@hunter-harness/skill-cli` were packed and installed in clean temporary consumers; command-contract tests passed. |
| Compose static validation | Passed | `docker compose config --quiet`. |
| PostgreSQL integration execution | Environment unavailable | `npm run test:postgres -w apps/server` exited cleanly with its two integration tests skipped because no local PostgreSQL test URL is configured. This is not reported as a database integration pass. |
| Production UI build | Passed | Explicit demo production build with `NEXT_PUBLIC_HUNTER_HARNESS_DEMO=true` completed and generated all Console routes. |

The repository includes captured desktop Dark/Light Skill Center, mobile Skill Center and Light Workflow workbench evidence under `docs/assets/ui-qa/`. The current in-app browser client blocked a fresh loopback navigation with `ERR_BLOCKED_BY_CLIENT`; this does not change the test or production-build results above, but it means this release does not claim a new interactive-browser pass from this environment.