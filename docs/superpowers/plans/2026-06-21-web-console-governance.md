# Web Console Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Web Console a usable governance workspace for bootstrap workflows, skills, project files, artifacts, and proposal review.

**Architecture:** A typed browser API client exposes the existing project, artifact-manifest, blob, and proposal-session contract. The UI derives an approved project workspace from artifact history and renders an explicit Web projection of the file policy matrix. Bootstrap Skill IR is packaged as a read-only catalogue because the server does not expose mutable registry endpoints.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, Testing Library, existing Fastify `/api/v1` server.

---

### Task 1: Add governance models and API operations

**Files:**
- Create: `apps/web/lib/catalog.ts`
- Create: `apps/web/lib/file-policy.ts`
- Create: `apps/web/lib/workspace.ts`
- Modify: `apps/web/lib/api.ts`
- Test: `apps/web/test/api.test.ts`

- [ ] **Step 1: Write failing API and workspace tests**

Test manifest loading, artifact blob decoding, current-file reconstruction, deterministic policy classification, and proposal-session request sequencing with a fake `fetch` implementation.

- [ ] **Step 2: Run the focused API tests and verify they fail**

Run: `npx vitest run apps/web/test/api.test.ts`

Expected: FAIL because the catalogue, workspace helpers, and proposal APIs do not exist.

- [ ] **Step 3: Implement typed models and API operations**

Add `getProject`, `getArtifactManifest`, `getArtifactText`, and `createProjectFileProposal` to `HunterApi`. The proposal operation must create a session, upload each missing blob with a SHA-256 chunk header, and finalize using the canonical operation hash. Add pure workspace and policy helpers used by UI components.

- [ ] **Step 4: Run the focused API tests and verify they pass**

Run: `npx vitest run apps/web/test/api.test.ts`

Expected: PASS.

### Task 2: Add workflow and skill registry views

**Files:**
- Create: `apps/web/components/registry.tsx`
- Create: `apps/web/app/workflows/page.tsx`
- Create: `apps/web/app/skills/page.tsx`
- Create: `apps/web/app/skills/[id]/page.tsx`
- Modify: `apps/web/app/layout.tsx`
- Modify: `apps/web/app/globals.css`
- Test: `apps/web/test/registry.test.tsx`

- [ ] **Step 1: Write failing registry interaction tests**

Assert that profile selection renders ordered skills and that name/profile/adapter filters change the displayed Skills list. Assert a Skill detail displays canonical IR and compiled Claude Code output preview.

- [ ] **Step 2: Run registry tests and verify they fail**

Run: `npx vitest run apps/web/test/registry.test.tsx`

Expected: FAIL because the routes and registry components do not exist.

- [ ] **Step 3: Implement bootstrap registry components and routes**

Render the 12 bootstrap skills and documented profile overlays with explicit read-only/provenance labels. Add sidebar links and accessible filters.

- [ ] **Step 4: Run registry tests and verify they pass**

Run: `npx vitest run apps/web/test/registry.test.tsx`

Expected: PASS.

### Task 3: Add project workspace and governed file proposal UI

**Files:**
- Create: `apps/web/components/project-workspace.tsx`
- Create: `apps/web/app/projects/[id]/page.tsx`
- Modify: `apps/web/components/console.tsx`
- Modify: `apps/web/app/globals.css`
- Test: `apps/web/test/project-workspace.test.tsx`

- [ ] **Step 1: Write failing project workspace tests**

Assert that an approved artifact chain renders a file tree and selected file content, displays policy fields, disables internal state editing, requires project-local confirmation, and calls `createProjectFileProposal` rather than a direct publish operation.

- [ ] **Step 2: Run project workspace tests and verify they fail**

Run: `npx vitest run apps/web/test/project-workspace.test.tsx`

Expected: FAIL because the project workspace does not exist.

- [ ] **Step 3: Implement project workspace and proposal composer**

Add project links from the registry. Reconstruct approved files, render metadata and policy badges, and provide add/edit/rename/delete draft controls that create a proposal only after explicit confirmation.

- [ ] **Step 4: Run project workspace tests and verify they pass**

Run: `npx vitest run apps/web/test/project-workspace.test.tsx`

Expected: PASS.

### Task 4: Add Artifact details, content, and diff views

**Files:**
- Create: `apps/web/components/artifact-detail.tsx`
- Create: `apps/web/app/artifacts/[id]/page.tsx`
- Modify: `apps/web/components/console.tsx`
- Modify: `apps/web/app/globals.css`
- Test: `apps/web/test/artifact-detail.test.tsx`

- [ ] **Step 1: Write failing artifact detail tests**

Assert that an artifact route renders manifest metadata, operation list, text content, policy values, source proposal link, and a line-oriented predecessor diff.

- [ ] **Step 2: Run artifact detail tests and verify they fail**

Run: `npx vitest run apps/web/test/artifact-detail.test.tsx`

Expected: FAIL because artifact detail does not exist.

- [ ] **Step 3: Implement artifact detail and comparison components**

Add artifact links from history. Fetch manifests and authenticated text blobs, render metadata and operation records, and derive a safe text diff from predecessor state.

- [ ] **Step 4: Run artifact detail tests and verify they pass**

Run: `npx vitest run apps/web/test/artifact-detail.test.tsx`

Expected: PASS.

### Task 5: Verify and commit the governance console

**Files:**
- Modify: `apps/web/test/web.test.tsx`
- Modify: `README.md`

- [ ] **Step 1: Extend route and accessibility coverage**

Assert all sidebar routes are present and no internal-state edit control is rendered.

- [ ] **Step 2: Run the full verification suite**

Run: `npm run check`

Expected: lint, type checks, all tests, production build, and package smoke test pass.

- [ ] **Step 3: Run browser smoke verification**

Run the Next development server and confirm every new route renders without browser console errors.

- [ ] **Step 4: Commit completed work**

Run: `git add apps/web README.md docs/superpowers && git commit -m "feat: expand web console governance views"`
