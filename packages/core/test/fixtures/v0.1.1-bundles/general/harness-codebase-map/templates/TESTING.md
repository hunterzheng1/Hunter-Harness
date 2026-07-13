---
harness:
  origin: generated
  generator: harness-codebase-map
  file_kind: generated_reviewable
  push_policy: full-diff-proposal
  update_policy: skip-if-local-dirty
title: Testing Patterns
document_type: testing
profile: <profile-or-unknown>
mapped_at: <YYYY-MM-DD HH:mm>
last_mapped_commit: <sha-or-unknown>
path_scope: <full|fast|focus|paths>
status: active
---

# Testing Patterns

**Analysis Date:** <YYYY-MM-DD>

## Test Framework

- Runner: <framework>
- Config: `<path>`

## Test Commands

```bash
<test command>
<single test command if known>
<coverage command if known>
```

## Test File Organization

- Location: `<path or pattern>`
- Naming: <pattern>

## Unit Tests

- Scope: <observed pattern>
- Example path: `<path>`

## Integration / API Tests

- Scope: <observed pattern>
- Example path: `<path>`

## Mocking / Fixtures

- <mock strategy>
- Fixture location: `<path>`

## Coverage / Quality Gates

- <coverage rule or unknown>

## Testing Gaps

- <module or path lacking tests>

## Notes for AI Agents

- <how harness-test should use this map>
