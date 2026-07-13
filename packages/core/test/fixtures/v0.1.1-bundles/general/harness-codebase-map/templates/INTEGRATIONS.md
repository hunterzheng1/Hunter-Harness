---
harness:
  origin: generated
  generator: harness-codebase-map
  file_kind: generated_reviewable
  push_policy: full-diff-proposal
  update_policy: skip-if-local-dirty
title: Codebase Integrations
document_type: integrations
profile: <profile-or-unknown>
mapped_at: <YYYY-MM-DD HH:mm>
last_mapped_commit: <sha-or-unknown>
path_scope: <full|fast|focus|paths>
status: active
---

# Codebase Integrations

**Analysis Date:** <YYYY-MM-DD>

## External Systems

| System | Evidence | Usage | Notes |
|---|---|---|---|
| <system> | `<path>` | <purpose> | <risk/notes> |

## Databases

- Type: <database>
- Config evidence: `<path>`
- Access layer: `<path>`

## Cache / Messaging / Search

- <component>: <usage and path evidence>

## HTTP / RPC Clients

- `<path>` — <external service or API>

## Auth / Security Integrations

- <auth mechanism, redacted if sensitive>

## Sensitive Information Handling

- Do not copy credentials.
- Mention only redacted config patterns.

## Notes for AI Agents

- <integration-specific cautions>
