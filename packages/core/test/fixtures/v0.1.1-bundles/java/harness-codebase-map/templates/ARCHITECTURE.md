---
harness:
  origin: generated
  generator: harness-codebase-map
  file_kind: generated_reviewable
  push_policy: full-diff-proposal
  update_policy: skip-if-local-dirty
title: Codebase Architecture
document_type: architecture
profile: <profile-or-unknown>
mapped_at: <YYYY-MM-DD HH:mm>
last_mapped_commit: <sha-or-unknown>
path_scope: <full|fast|focus|paths>
status: active
---

# Codebase Architecture

**Analysis Date:** <YYYY-MM-DD>

## Architecture Style

- <layered / modular / microservice / monolith / plugin / etc.>

## Main Modules

| Module | Path | Responsibility |
|---|---|---|
| <module> | `<path>` | <responsibility> |

## Layering and Dependencies

```text
<layer or module dependency diagram>
```

## Request / Data Flow

1. <entry>
2. <service>
3. <persistence/integration>

## Key Entry Points

- `<path>` — <purpose>

## Extension Points

- `<path>` — <how to add new feature>

## Architectural Constraints

- <constraint>

## Notes for AI Agents

- <how future skills should navigate architecture>
