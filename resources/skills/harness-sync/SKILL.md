---
name: harness-sync
description: Check Harness context, Knowledge indexes, managed blocks, rules, and codebase-map freshness.
kind: workflow
triggers:
  - sync harness context
  - check project context
inputs:
  - project_root
  - context_index
outputs:
  - sync_report
  - refresh_recommendations
forbidden_actions:
  - automatic_codebase_map_execution
  - manage_codegraph
  - install_external_tools
required_context:
  - AGENTS.md
  - .harness/context-index.json
version: "1.0.0"
---

# harness-sync

Check Harness context, Knowledge indexes, managed blocks, rules, and codebase-map freshness.

## Triggers

- sync harness context
- check project context

## Required context

- AGENTS.md
- .harness/context-index.json

## Instructions

- Validate managed blocks and local Harness structure.
- Rebuild deterministic indexes when their sources changed.
- Recommend codebase-map refresh when stale, but wait for explicit user confirmation.

## Forbidden actions

- automatic_codebase_map_execution
- manage_codegraph
- install_external_tools
