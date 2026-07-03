---
name: harness-package
description: Validate and prepare a reproducible project package without publishing it.
kind: workflow
triggers:
  - prepare package
  - validate package output
inputs:
  - project_root
  - build_configuration
outputs:
  - package_report
  - package_artifacts
forbidden_actions:
  - publish_artifact
  - expose_secrets
  - claim_unverified_build
required_context:
  - AGENTS.md
  - .harness/context-index.json
version: "1.0.0"
---

# harness-package

Validate and prepare a reproducible project package without publishing it.

## Triggers

- prepare package
- validate package output

## Required context

- AGENTS.md
- .harness/context-index.json

## Instructions

- Validate the configured build and its required tests.
- Record exact artifact hashes and build evidence.
- Do not publish or upload package artifacts.

## Forbidden actions

- publish_artifact
- expose_secrets
- claim_unverified_build
