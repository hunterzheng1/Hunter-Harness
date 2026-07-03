---
name: harness-knowledge-ingest
description: Validate, deduplicate, index, and propose project Knowledge without bypassing review.
kind: governance
triggers:
  - ingest knowledge
  - rebuild knowledge index
inputs:
  - knowledge_entries
  - candidate_entries
outputs:
  - knowledge_index
  - validation_report
forbidden_actions:
  - auto_promote_candidate_knowledge
  - include_project_local_by_default
  - erase_conflicts
required_context:
  - AGENTS.md
  - .harness/knowledge/index.json
version: "1.0.0"
---

# harness-knowledge-ingest

Validate, deduplicate, index, and propose project Knowledge without bypassing review.

## Triggers

- ingest knowledge
- rebuild knowledge index

## Required context

- AGENTS.md
- .harness/knowledge/index.json

## Instructions

- Validate frontmatter and lifecycle relationships.
- Detect duplicate IDs, duplicate content, and conflicting active facts.
- Keep project-local entries excluded unless explicitly selected.

## Forbidden actions

- auto_promote_candidate_knowledge
- include_project_local_by_default
- erase_conflicts
