# Skill Source and Adapter Demo Design

## Goal

Demonstrate a lossless Skill package in the web Demo: `sap-field-mapper` retains its complete original directory while the Skill Center exposes its structured metadata, original files, and a small Codex-specific wording patch.

## Scope

The Demo is read-only and uses only `apps/web` mock data. It does not change the server Registry schema, PostgreSQL persistence, publishing API, package installer, or the production adapter compiler.

## Source package

The `sap-field-mapper` demo package contains the unchanged source files:

- `SKILL.md`
- `reference.md`
- `examples.md`
- `templates/output-template.md`

The source package is the authoritative content for this demo. Its file list and SHA-256 values form an in-memory manifest. The source files are copied into `apps/web/lib/demo-skills/sap-field-mapper/` so Demo mode has no dependency on the user's personal Obsidian path.

## Metadata and compatibility

The demo record has a small structured metadata layer used by the existing Registry UI: slug, description, category, tags, version, supported adapters, workflow profile, triggers, inputs, outputs, and declared capabilities.

The metadata does not replace the source files. It is an index for listing, filtering, and explaining compatibility. The demo declares Claude Code and Codex support. `network-api` and filesystem search are required capabilities; subagents and hooks are optional capabilities.

## Adapter composition

Claude Code's effective artifact is the original `SKILL.md` without a content rewrite.

Codex's effective artifact is the original `SKILL.md` plus an explicit, demo-only adapter patch. The patch documents wording substitutions for unsupported hooks and subagent delegation. It does not alter the SAP mapping workflow, T-table rules, API contract, examples, or templates.

The page shows the base source and the selected adapter's effective preview. It also exposes the patch summary so the difference is inspectable rather than implicit.

## UI

The existing Skill detail page receives a read-only `Source files` section when a demo Skill has a source package. It includes:

- a file list;
- the selected file's raw content;
- the selected adapter's effective `SKILL.md` preview;
- a compact adapter-difference summary.

Existing bootstrap skills retain their present detail layout, and production API clients remain unchanged.

## Test plan

Add focused web tests that assert:

1. Demo skill search/listing includes `sap-field-mapper`.
2. Its detail view displays the complete source file list and the original `SKILL.md` content.
3. Switching the preview from Claude Code to Codex displays the declared adapter-difference summary while retaining the core mapping workflow content.
4. Existing Registry tests remain green.

## Acceptance criteria

- Demo mode displays `sap-field-mapper` in the Skill Center.
- The original directory's four source files are present in the repository and selectable in the demo detail view.
- The Claude view is lossless for the original `SKILL.md`.
- The Codex view makes its limited adaptation explicit without duplicating the core workflow.
- No server, database, API, or installer behavior changes.
