---
name: harness-submit
description: Prepare a submission summary, suggested message, and verification checklist without changing source control.
kind: workflow
triggers:
  - prepare submission
  - summarize completed change
inputs:
  - change_ref
  - verification_evidence
outputs:
  - submission_summary
  - suggested_message
  - submission_checklist
forbidden_actions:
  - source_control_write_without_explicit_confirmation
  - publish_without_review
required_context:
  - AGENTS.md
  - .harness/context-index.json
version: "1.0.0"
---

# harness-submit

Prepare a submission summary, suggested message, and verification checklist without changing source control.

## Triggers

- prepare submission
- summarize completed change

## Required context

- AGENTS.md
- .harness/context-index.json

## Instructions

- Summarize verified changes and remaining risks.
- Produce a suggested message and final checklist only.
- Require explicit user confirmation before any source-control mutation.

## Forbidden actions

- source_control_write_without_explicit_confirmation
- publish_without_review
