# Skill Source and Adapter Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only `sap-field-mapper` Skill Center demo that preserves its complete source directory and exposes a small, explicit Codex adapter difference.

**Architecture:** Keep source-package data inside `apps/web` and expose it through the existing `MockApiClient`, without changing Registry contracts or production API behavior. Extend the detail view only when the selected demo Skill has source-package data; adapter previews are sourced from the package rather than generated from the canonical IR.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, Testing Library.

---

## File structure

- Create: `apps/web/lib/demo-skills/types.ts` — source-package and adapter-patch types plus deterministic preview composition.
- Create: `apps/web/lib/demo-skills/sap-field-mapper/SKILL.md` — unchanged primary source file.
- Create: `apps/web/lib/demo-skills/sap-field-mapper/reference.md` — unchanged supporting reference.
- Create: `apps/web/lib/demo-skills/sap-field-mapper/examples.md` — unchanged examples.
- Create: `apps/web/lib/demo-skills/sap-field-mapper/templates/output-template.md` — unchanged output template.
- Create: `apps/web/lib/demo-skills/sap-field-mapper.ts` — metadata, file manifest, adapter patches, and adapter preview lookup for the demo package.
- Modify: `apps/web/lib/mock-api.ts` — append the source-backed demo Skill to mock registry data and return its effective adapter previews.
- Modify: `apps/web/components/registry.tsx` — render a read-only source-files section for source-backed demo Skills.
- Modify: `apps/web/test/registry.test.tsx` — cover the source-backed Skill listing and detail/adapter rendering.

### Task 1: Source package model and source fixtures

**Files:**
- Create: `apps/web/lib/demo-skills/types.ts`
- Create: `apps/web/lib/demo-skills/sap-field-mapper/SKILL.md`
- Create: `apps/web/lib/demo-skills/sap-field-mapper/reference.md`
- Create: `apps/web/lib/demo-skills/sap-field-mapper/examples.md`
- Create: `apps/web/lib/demo-skills/sap-field-mapper/templates/output-template.md`
- Create: `apps/web/lib/demo-skills/sap-field-mapper.ts`
- Test: `apps/web/test/demo-skills.test.ts`

- [ ] **Step 1: Write the failing source-package test**

```ts
import { describe, expect, it } from "vitest";
import { sapFieldMapper } from "../lib/demo-skills/sap-field-mapper";

describe("sap-field-mapper demo source package", () => {
  it("preserves every source file and leaves the Claude entrypoint unchanged", () => {
    expect(sapFieldMapper.source.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "examples.md",
      "reference.md",
      "templates/output-template.md"
    ]);
    expect(sapFieldMapper.preview("claude-code")).toBe(sapFieldMapper.source.entrypoint.content);
  });

  it("applies only the declared Codex patch while retaining the mapping workflow", () => {
    const preview = sapFieldMapper.preview("codex");
    expect(preview).toContain("SAP/S4");
    expect(preview).toContain("Codex adaptation");
    expect(sapFieldMapper.adapters.codex.patchSummary).toContain("hook");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/web/test/demo-skills.test.ts`

Expected: failure because `../lib/demo-skills/sap-field-mapper` does not exist.

- [ ] **Step 3: Copy the original source directory without altering file contents**

Copy the four files from `C:\Users\WINDOWS\Documents\Obsidian Vault\工作日志\Projects\SDD工具\tools\sap-field-mapper` to `apps/web/lib/demo-skills/sap-field-mapper/`, preserving paths and UTF-8 content.

- [ ] **Step 4: Implement the minimal source package module**

Define `DemoSourceFile`, `DemoSourcePackage`, `DemoAdapterPatch`, and `DemoSourceSkill` in `types.ts`. In `sap-field-mapper.ts`, import the four source assets as raw strings, expose sorted source files, set `entrypoint` to `SKILL.md`, and implement `preview(agent)` so `claude-code` returns the entrypoint byte-for-byte while `codex` appends an explicit adaptation note covering hook and subagent substitution.

- [ ] **Step 5: Run the source-package test to verify it passes**

Run: `npx vitest run apps/web/test/demo-skills.test.ts`

Expected: 2 passing tests.

### Task 2: Mock registry integration

**Files:**
- Modify: `apps/web/lib/mock-api.ts`
- Test: `apps/web/test/registry.test.tsx`

- [ ] **Step 1: Write the failing mock-registry test**

```tsx
it("lists the source-backed sap-field-mapper demo Skill", async () => {
  const { mockApi } = await import("../lib/mock-api");
  const skills = await mockApi.listSkills?.();
  expect(skills?.find((item) => item.slug === "sap-field-mapper")).toMatchObject({
    name: "sap-field-mapper",
    adapters: ["claude-code", "codex"]
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/web/test/registry.test.tsx`

Expected: failure because the mock registry has no `sap-field-mapper` record.

- [ ] **Step 3: Add the source-backed mock registry record**

In `mock-api.ts`, build one `RegistrySkillDetail` from the `sapFieldMapper` metadata. Use `tooling`, `general`, adapters `claude-code` and `codex`, a `sap` tag, and a `1.0.0-demo` display version only if contracts permit; otherwise use schema-valid `1.0.0`. Keep the existing bootstrap skills unchanged.

- [ ] **Step 4: Route source-backed adapter previews through the source package**

In `MockApiClient.getSkillAdapterPreview`, first look up the requested source-backed demo skill. Return the package preview content, its entrypoint path, a deterministic demo hash, and adapter id for Claude Code and Codex. Preserve the current contract-only behavior for unsupported adapters and bootstrap skills.

- [ ] **Step 5: Run the registry test to verify it passes**

Run: `npx vitest run apps/web/test/registry.test.tsx`

Expected: all Registry tests pass, including the new mock-registry assertion.

### Task 3: Source-files detail panel

**Files:**
- Modify: `apps/web/components/registry.tsx`
- Modify: `apps/web/app/globals.css`
- Test: `apps/web/test/registry.test.tsx`

- [ ] **Step 1: Write the failing detail-view test**

```tsx
it("renders source files and makes the Codex adaptation explicit for the demo Skill", async () => {
  const { mockApi } = await import("../lib/mock-api");
  render(<SkillDetail api={mockApi} skillId="sap-field-mapper" />);
  expect(await screen.findByText("Source files")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "SKILL.md" })).toBeInTheDocument();
  expect(screen.getByText(/SAP\/S4/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(/Target Agent/i), { target: { value: "codex" } });
  expect(await screen.findByText("Codex adaptation")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/web/test/registry.test.tsx`

Expected: failure because the detail view has no source-files panel.

- [ ] **Step 3: Add a demo-only source package accessor and panel**

Add a small `findDemoSourceSkill(slug)` accessor in `apps/web/lib/demo-skills/sap-field-mapper.ts` or a dedicated index module. In `SkillDetail`, use it only when Demo mode is enabled. Render a `Source files` panel with button-based file selection, a raw `pre.code-view` body, and the selected adapter's patch summary. Do not render this panel for normal API data or existing bootstrap skills.

- [ ] **Step 4: Add minimal styles**

In `apps/web/app/globals.css`, add narrowly scoped styles for a compact source-file list beside the selected raw file content. Reuse panel, button, and code-view tokens; do not introduce a new color system.

- [ ] **Step 5: Run the detail-view test to verify it passes**

Run: `npx vitest run apps/web/test/registry.test.tsx`

Expected: all Registry tests pass and the new test observes the original source file plus the Codex adaptation label.

### Task 4: Regression verification

**Files:**
- Modify: `docs/superpowers/specs/2026-06-25-skill-source-adapter-demo-design.md` only if implementation clarifies an acceptance criterion.

- [ ] **Step 1: Typecheck the web application**

Run: `npm run typecheck -w apps/web`

Expected: exit code 0.

- [ ] **Step 2: Run all web tests**

Run: `npx vitest run apps/web/test`

Expected: all web test files pass.

- [ ] **Step 3: Run the full repository test suite**

Run: `npm test`

Expected: exit code 0.

- [ ] **Step 4: Review the diff and source-file preservation**

Run: `git diff --check && git diff -- apps/web/lib/demo-skills`

Expected: no whitespace errors; the four copied source files retain the source package contents and only the separately declared Codex patch changes tool-specific wording.
