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
The public npm package that carries the CLI and both Harness Bundles to installation machines. It does not include or require access to the Harness Source.
_Avoid_: Harness server, Vault deployment

**Conservative Update**:
The default path when a project already has a Harness Project. It preserves user-owned content and changes only files that the update policy identifies as clean and managed.
_Avoid_: reinitialization, blind overwrite

**Profile Transition**:
A Conservative Update that changes an existing Harness Project from one Installation Profile to another after presenting the resulting managed-file additions and removals. Non-interactive execution requires explicit confirmation.
_Avoid_: fresh installation, silent profile replacement

**Managed File Conflict**:
A Harness-managed file whose current bytes no longer match the last installed Bundle. A Conservative Update preserves and skips it while continuing with non-conflicting files; explicit force is required to replace it.
_Avoid_: installation failure, unconditionally overwrite
