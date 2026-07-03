---
name: harness-review
description: Review changes across correctness, security, compatibility, tests, maintainability, and evidence.
kind: governance
triggers:
  - review a change
  - inspect implementation quality
inputs:
  - change_ref
  - context_index
outputs:
  - review_report
  - evidence_summary
forbidden_actions:
  - invent_findings
  - claim_unverified_success
  - mutate_reviewed_code_without_request
required_context:
  - AGENTS.md
  - .harness/context-index.json
  - .harness/knowledge/index.json
version: "1.0.0"
---

# harness-review

Review changes across correctness, security, compatibility, tests, maintainability, and evidence.

## Triggers

- review a change
- inspect implementation quality

## Required context

- AGENTS.md
- .harness/context-index.json
- .harness/knowledge/index.json

## Instructions

- Inspect the actual diff and relevant project evidence.
- Rank actionable findings by impact and cite precise locations.
- Distinguish verified defects from risks and questions.

## Forbidden actions

- invent_findings
- claim_unverified_success
- mutate_reviewed_code_without_request
