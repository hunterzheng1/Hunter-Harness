---
name: harness-skill-optimizer
description: Create, optimize, and migrate platform-neutral Skill IR with adapter-safe outputs.
kind: migration
triggers:
  - create a skill
  - optimize a skill
  - migrate an agent skill
inputs:
  - skill_source
  - target_profiles
  - target_adapters
outputs:
  - skill_ir
  - validation_report
  - adapter_preview
forbidden_actions:
  - publish_canonical_skill
  - automatic_proposal_push
  - broaden_capabilities
  - automatic_source_control_write
required_context:
  - AGENTS.md
  - .harness/context-index.json
version: "1.0.0"
---

# harness-skill-optimizer

Create, optimize, and migrate platform-neutral Skill IR with adapter-safe outputs.

## Triggers

- create a skill
- optimize a skill
- migrate an agent skill

## Required context

- AGENTS.md
- .harness/context-index.json

## Instructions

- Convert source workflows and constraints into canonical Skill IR.
- Validate triggers, inputs, outputs, forbidden actions, and required context.
- Generate previews but never publish or push automatically.

## Forbidden actions

- publish_canonical_skill
- automatic_proposal_push
- broaden_capabilities
- automatic_source_control_write
