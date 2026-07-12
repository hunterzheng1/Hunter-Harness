# Hunter Harness

Hunter Harness installs a selected, self-contained Harness workflow into an agent project.

## Language

**Installation Profile**:
The user-selected workflow family installed into a project. The supported profiles are `general` and `java`, and each profile has its own exact file set.
_Avoid_: mode, flavor, preset

**Harness Bundle**:
The complete, self-contained set of Skills, agents, scripts, protocols, templates, and supporting files belonging to one Installation Profile.
_Avoid_: partial skill pack, shared superset

**Harness Source**:
The maintained canonical Harness tree from which profile-specific Harness Bundles are produced.
_Avoid_: npm resources, installed copy

**Bundle Fidelity**:
The requirement that the Public Distribution contains every file and byte produced by the canonical Harness deployment process, and that every installed file preserves those bytes after being routed to its designated target.
_Avoid_: identical installation tree, same filenames, equivalent content

**Installation Projection**:
The deterministic routing from paths in a Harness Bundle to their runtime locations. Skills and supporting material are routed under `.claude/skills`, while agent definitions are routed only to `.claude/agents`.
_Avoid_: Bundle copy, content transformation

**Public Distribution**:
The set of public npm packages that carry Hunter Harness to installation machines: a thin CLI package containing only logic, plus one data-only package per Workflow Family carrying its Harness Bundles. Installation requires npm but never the Hunter Harness server or the Harness Source. Workflow data package versions map one-to-one to Workflow Family versions.
_Avoid_: bundled CLI, server-dependent install, Vault deployment

**Conservative Update**:
The default path when a project already has a Harness Project. It preserves user-owned content and changes only files that the update policy identifies as clean and managed.
_Avoid_: reinitialization, blind overwrite

**Profile Transition**:
A Conservative Update that changes an existing Harness Project from one Installation Profile to another after presenting the resulting managed-file additions and removals. Non-interactive execution requires explicit confirmation.
_Avoid_: fresh installation, silent profile replacement

**Managed File Conflict**:
A Harness-managed file whose current bytes no longer match the last installed Bundle. A Conservative Update preserves and skips it while continuing with non-conflicting files; explicit force is required to replace it.
_Avoid_: installation failure, unconditionally overwrite

**Direct Publish**:
Saving a Skill or finalizing a project push immediately produces a published version or artifact without human review. Project proposals are auto-approved by the server; safety comes from version history, diff, rollback, and the audit trail.
_Avoid_: proposal queue, review decision, manual approval

**Change History**:
The read-only record of published Skill versions and auto-approved project artifacts, replacing the former review queue as the console's timeline view.
_Avoid_: review queue, pending list

**Skill npm Distribution**:
Publishing one Skill as its own scoped npm package (one package per Skill slug), executed by the server with an operator-provided npm token. The package is data-only: published source files plus manifest, with no executable entry; installation is performed by the Skill CLI. The server registry remains the editing source of truth; npm is the public distribution channel.
_Avoid_: bundle package, self-installing package, manual npm publish

**First-Push Registration**:
The only way a project comes into existence on the server: the first CLI push resolves and binds it automatically from the committed `.harness/project.yaml`. The console can edit, annotate, and archive projects but never create them. Cloning the repository carries the binding to additional devices.
_Avoid_: web-created project, manual pairing, association code

**Stale Push Rejection**:
The optimistic concurrency guard on push: finalize carries the artifact identity the local baseline was built from, and the server rejects the push when it is no longer the latest, directing the developer to sync first. Devices synchronize through git; push is only a snapshot report.
_Avoid_: locking, server-side merge, last-write-wins

**Semantic Index**:
The server-side structured view derived from a project's latest artifact by parsing known managed-file kinds (knowledge documents, rules, harness records, agent instruction files). It is a rebuildable derivative, never a second source of truth; the graph, search, and MCP surfaces all read from it. CLI push is the only channel that feeds it.
_Avoid_: manual project upload, web-edited knowledge, second data source

**Semantic MCP**:
The read-only MCP surface built into the server (HTTP transport, API-token auth) that answers cross-project business-semantics queries from the Semantic Index. Within a single project, agents keep using the local knowledge MCP; writes always go through CLI push, never through MCP.
_Avoid_: write-capable MCP, local proxy package, per-project server MCP

**Workflow Family**:
The server-side registry entity for one workflow line (for example `harness`). A Family carries a single version number; each version contains one self-contained Harness Bundle per Installation Profile, built locally from the canonical source tree plus overlays and uploaded as final bytes. It replaces the former skill-binding workflow manifest.
_Avoid_: workflow manifest, skill binding list, per-profile versioning

**Bundle-Internal Skill**:
A Skill that ships inside a Harness Bundle (for example `harness-plan`). It is versioned and distributed only as part of its Workflow Family and never appears in the Skill Center.
_Avoid_: standalone skill, registry skill

**External Skill**:
A curated, display-only listing of a third-party skill or plugin, registered from an npm package name or GitHub repository URL. The server snapshots its public metadata and tracks upstream version changes, but never hosts, republishes, or installs its content; installation always follows the official channel.
_Avoid_: imported skill, mirrored skill, second-hand distribution

**Curation Note**:
The owner-written commentary attached to an External Skill explaining why it is worth using. It is never modified by automated refresh.
_Avoid_: auto-generated summary

**Upstream Refresh**:
The version check for External Skills, run by a daily server job and an on-demand console button. It compares upstream versions, flags updates with a badge, and touches nothing but the metadata snapshot.
_Avoid_: auto-upgrade, content sync

**npm Release Action**:
The explicit, per-Skill console action that publishes the latest published registry version to npm. It never runs automatically, never rolls back the registry on failure, and records its outcome (published, failed, version conflict) in the registry for display.
_Avoid_: auto-sync, force publish, re-publish
