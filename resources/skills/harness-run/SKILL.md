---
name: harness-run
description: Execute an approved implementation plan with test-first evidence and an execution log.
kind: workflow
triggers:
  - implement the plan
  - run approved tasks
inputs:
  - implementation_plan
  - test_scenarios
outputs:
  - implementation_changes
  - execution_log
forbidden_actions:
  - skip_red_green_verification
  - claim_unverified_success
  - automatic_source_control_write
required_context:
  - AGENTS.md
  - .harness/context-index.json
version: "1.0.0"
---

# harness-run

Execute an approved implementation plan with test-first evidence and an execution log.

## Triggers

- implement the plan
- run approved tasks

## Required context

- AGENTS.md
- .harness/context-index.json

## Instructions

- Execute one bounded task at a time.
- Record real command output and distinguish it from static inspection.
- Stop on unsafe or unexplained failures.

## Forbidden actions

- skip_red_green_verification
- claim_unverified_success
- automatic_source_control_write
