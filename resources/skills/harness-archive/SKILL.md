---
name: harness-archive
description: Archive completed change evidence and extract unpromoted candidate Knowledge.
kind: workflow
triggers:
  - archive completed change
  - extract reusable knowledge
inputs:
  - change_documents
  - verification_evidence
outputs:
  - archive_summary
  - candidate_knowledge
forbidden_actions:
  - auto_promote_candidate_knowledge
  - discard_evidence
  - expose_sensitive_data
required_context:
  - AGENTS.md
  - .harness/context-index.json
version: "1.0.0"
---

# harness-archive

Archive completed change evidence and extract unpromoted candidate Knowledge.

## Triggers

- archive completed change
- extract reusable knowledge

## Required context

- AGENTS.md
- .harness/context-index.json

## Instructions

- Preserve the final summary and execution evidence.
- Extract reusable facts into the candidate area with source references.
- Never promote candidates to active Knowledge automatically.

## Forbidden actions

- auto_promote_candidate_knowledge
- discard_evidence
- expose_sensitive_data
