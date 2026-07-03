---
name: harness-apidoc
description: Analyze API changes and produce evidence-based documentation impact updates.
kind: workflow
triggers:
  - update API documentation
  - inspect API compatibility
inputs:
  - change_ref
  - api_contract
outputs:
  - api_impact_report
  - documentation_updates
forbidden_actions:
  - invent_api_behavior
  - hide_breaking_changes
  - publish_without_review
required_context:
  - AGENTS.md
  - .harness/context-index.json
  - .harness/knowledge/api
version: "1.0.0"
---

# harness-apidoc

Analyze API changes and produce evidence-based documentation impact updates.

## Triggers

- update API documentation
- inspect API compatibility

## Required context

- AGENTS.md
- .harness/context-index.json
- .harness/knowledge/api

## Instructions

- Compare implementation and declared API contracts.
- Classify compatibility and documentation impact.
- Update only evidence-supported documentation.

## Forbidden actions

- invent_api_behavior
- hide_breaking_changes
- publish_without_review
