---
harness:
  origin: generated
  generator: harness-codebase-map
  file_kind: generated_reviewable
  push_policy: full-diff-proposal
  update_policy: skip-if-local-dirty
title: Codebase Stack
document_type: stack
profile: <profile-or-unknown>
mapped_at: <YYYY-MM-DD HH:mm>
last_mapped_commit: <sha-or-unknown>
path_scope: <full|fast|focus|paths>
status: active
---

# Codebase Stack

**Analysis Date:** <YYYY-MM-DD>

## Runtime and Language

- Language: <language and version>
- Runtime: <runtime and version>
- Package manager / build tool: <tool>

## Frameworks

- <framework>: <purpose>

## Build and Run

```bash
<build command>
<run command>
<test command>
```

## Key Dependencies

| Dependency | Evidence | Purpose |
|---|---|---|
| `<name>` | `<path>` | <why it matters> |

## Configuration Files

- `<path>` — <purpose>

## Deployment / Runtime Environment

- <container, server, cloud, local runtime notes>

## Notes for AI Agents

- <practical guidance for future plan/run/review>
