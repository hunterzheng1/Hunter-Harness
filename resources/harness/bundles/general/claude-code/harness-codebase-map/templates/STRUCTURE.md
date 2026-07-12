---
harness:
  origin: generated
  generator: harness-codebase-map
  file_kind: generated_reviewable
  push_policy: full-diff-proposal
  update_policy: skip-if-local-dirty
title: Codebase Structure
document_type: structure
profile: <profile-or-unknown>
mapped_at: <YYYY-MM-DD HH:mm>
last_mapped_commit: <sha-or-unknown>
path_scope: <full|fast|focus|paths>
status: active
---

# Codebase Structure

**Analysis Date:** <YYYY-MM-DD>

## Directory Layout

```text
<project-root>/
├── <dir>/          # <purpose>
└── <file>          # <purpose>
```

## Directory Purposes

### `<dir>/`

- Purpose: <what lives here>
- Contains: <file types>
- Key files: `<path>`

## Key File Locations

### Entry Points

- `<path>` — <purpose>

### Configuration

- `<path>` — <purpose>

### Core Logic

- `<path>` — <purpose>

### Testing

- `<path>` — <purpose>

## Where to Add New Code

| Need | Location |
|---|---|
| New feature | `<path>` |
| New test | `<path>` |
| New config | `<path>` |

## Generated / Ignored Directories

- `<path>` — <generated/cache/internal/external>

## Notes for AI Agents

- <navigation guidance>
