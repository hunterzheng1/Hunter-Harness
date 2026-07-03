---
name: harness-codebase-map
description: Generate seven evidence-based codebase-map documents under the Harness workspace.
kind: workflow
triggers:
  - map the codebase
  - refresh codebase map
inputs:
  - project_root
  - optional_paths
outputs:
  - stack_map
  - integration_map
  - architecture_map
  - structure_map
  - convention_map
  - testing_map
  - concern_map
forbidden_actions:
  - copy_source_code_wholesale
  - manage_codegraph
  - automatic_execution_from_sync
required_context:
  - AGENTS.md
  - .harness/context-index.json
version: "1.0.0"
---

# harness-codebase-map

Generate seven evidence-based codebase-map documents under the Harness workspace.

## Triggers

- map the codebase
- refresh codebase map

## Required context

- AGENTS.md
- .harness/context-index.json

## Instructions

- Analyze the requested scope using isolated mapper focuses.
- Write STACK, INTEGRATIONS, ARCHITECTURE, STRUCTURE, CONVENTIONS, TESTING, and CONCERNS.
- Record evidence, scan scope, time, and source revision without embedding source files.

## Forbidden actions

- copy_source_code_wholesale
- manage_codegraph
- automatic_execution_from_sync
