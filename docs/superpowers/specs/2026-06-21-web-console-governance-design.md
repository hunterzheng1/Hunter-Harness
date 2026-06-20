# Web Console Governance Design

## Scope

This change turns the existing list-only Web Console into a governance workspace without inventing server capabilities that do not exist. The console will render Bootstrap Skill IR as a read-only registry, and use the existing project/proposal/artifact API for all stateful project-file changes.

## Information architecture

The sidebar will expose Dashboard, Projects, Harness Workflows, Skills, Artifacts, and Review Queue. New detail routes are project-scoped, skill-scoped, and artifact-scoped. Each route keeps the token in browser session storage and calls only same-origin `/api/v1` endpoints.

## Data boundaries

- Workflows and Skills are built from the checked-in `resources/bootstrap-ir` registry. The UI identifies it as bootstrap/read-only rather than claiming it is a mutable server registry.
- Project files are reconstructed from the approved artifact chain. Only approved artifact manifests and blobs are read.
- Project-file edits create an actual proposal session, upload the declared UTF-8 blob, and finalize a proposal. No direct publish path is added.
- File policies are duplicated as an explicitly small Web projection of the server policy matrix. The projection labels internal state, caches, and external unmanaged files as unavailable before the API is called; the server remains the authoritative enforcement point.

## User flows

### Workflows and Skills

Profiles show ordered enabled skills, profile-specific additions, optionality, adapter coverage, and confirmation points. Skills support text/profile/adapter filters and a detail route with canonical IR, compiled Claude Code output preview, triggers, inputs, outputs, forbidden actions, and registry provenance.

### Projects

A project detail page shows project metadata, proposal history, artifact history, and a reconstructed managed-file tree. Selecting a file shows policy, hash, content, and an edit affordance only for policy-allowed paths. Add, modify, rename, and delete actions create a project proposal, never a direct write. `project-local` paths require an explicit confirmation.

### Artifacts

Artifact details show the immutable manifest, file operations, source proposal, hashes, text content, download data, and a human-readable line diff against the reconstructed predecessor state. Rollback is represented as a prefilled project-file proposal, not a direct artifact mutation.

## Failure and security behavior

API errors are redacted. Artifact blobs are fetched only after an authenticated manifest lookup. Draft editing remains in component state until the user creates a proposal. Internal-state, generated-cache, and external-unmanaged paths never expose an editable control. Existing server-side policy, sensitive-content scanning, idempotency, and review checks remain mandatory.

## Verification

Component tests cover navigation, registry discovery/filtering, policy-gated file controls, artifact content/diff rendering, and proposal submission. The production build and a browser smoke test confirm the new routes and responsive navigation render correctly.
