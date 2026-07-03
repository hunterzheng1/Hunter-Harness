---
name: harness-test
description: Validate changes with real tests, explicit degradation reporting, and reproducible evidence.
kind: workflow
triggers:
  - test the change
  - validate behavior
inputs:
  - test_scenarios
  - change_ref
outputs:
  - test_report
  - evidence_summary
forbidden_actions:
  - claim_unrun_tests_pass
  - hide_test_failures
  - confuse_static_checks_with_tests
required_context:
  - AGENTS.md
  - .harness/context-index.json
  - .harness/knowledge/pitfalls
version: "1.0.0"
---

# harness-test

Validate changes with real tests, explicit degradation reporting, and reproducible evidence.

## Triggers

- test the change
- validate behavior

## Required context

- AGENTS.md
- .harness/context-index.json
- .harness/knowledge/pitfalls

## Instructions

- Derive test cases from requirements and changed behavior.
- Run the narrow test first, then the complete relevant suite.
- Report skipped infrastructure and degraded validation explicitly.

## Forbidden actions

- claim_unrun_tests_pass
- hide_test_failures
- confuse_static_checks_with_tests
