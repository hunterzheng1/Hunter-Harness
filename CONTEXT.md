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
The requirement that an installed Harness Bundle matches the files and bytes produced by the canonical Harness deployment process for its Installation Profile.
_Avoid_: same filenames, equivalent content

**Public Distribution**:
The public npm package that carries the CLI and both Harness Bundles to installation machines. It does not include or require access to the Harness Source.
_Avoid_: Harness server, Vault deployment
