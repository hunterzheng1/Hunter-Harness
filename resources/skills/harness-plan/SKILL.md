---
name: harness-plan
description: Produce evidence-based designs, implementation plans, impact analysis, and test scenarios.
kind: workflow
triggers:
  - plan a change
  - design an implementation
inputs:
  - requirements
  - context_index
outputs:
  - design
  - implementation_plan
  - test_scenarios
forbidden_actions:
  - invent_evidence
  - expose_sensitive_data
  - automatic_source_control_write
required_context:
  - AGENTS.md
  - .harness/context-index.json
  - .harness/knowledge/index.json
version: "1.0.0"
---

# harness-plan

Produce evidence-based designs, implementation plans, impact analysis, and test scenarios.

## Triggers

- plan a change
- design an implementation

## Required context

- AGENTS.md
- .harness/context-index.json
- .harness/knowledge/index.json

## Instructions

- Inspect relevant Knowledge and codebase-map evidence before proposing changes.
- Separate assumptions from verified facts.
- Define exact files, tests, risks, and rollback points.

## Forbidden actions

- invent_evidence
- expose_sensitive_data
- automatic_source_control_write
