# Autoloop

This workspace uses the local `autoloop` CLI as the source of truth for autonomous experiment loops.

## Workspace root

E:\MyProject\AI Related\Hunter-Harness/

## Installed context

- This file: `program.md`
- State lives under `.autoloop/`
- Prefer `autoloop` CLI output with `--json` when a structured decision is needed
- The installed names like `autoloop-run` and `autoloop-init` are agent wrappers, not native `autoloop` CLI subcommands

## Primary workflow

- `autoloop-init` bootstraps autoloop in the repo and prepares `.autoloop/config.toml`.
- `autoloop-doctor` verifies or repairs `.autoloop/config.toml` when setup is incomplete or broken.
- `autoloop-baseline` records the baseline metric once config is healthy.
- `autoloop-run` is the main autonomous loop entrypoint.
- `autoloop-status` reports current or historical progress.
- `autoloop-learn` refreshes `.autoloop/learnings.md`.
- `autoloop-finalize` creates review branches from committed kept experiments.

## Rules

- Treat `autoloop-run` as permission to initialize autoloop, verify and repair config, record a baseline, run a bounded loop, end the session, and refresh learnings.
- Default bounded runs to 5 experiments when the user does not provide a different limit.
- Do not manually edit `.autoloop/state.json`, `.autoloop/last_eval.json`, or `.autoloop/experiments.jsonl`.
- Let `autoloop` own experiment bookkeeping, eval verdicts, keep/discard state, and finalize branches.
- Ask the user only when blocked by missing information, unsafe ambiguity, or a genuine external dependency.

## Autoloop Init

Use the local `autoloop` CLI as the source of truth for this workflow action.

These installed names are agent wrappers, not native `autoloop` CLI subcommands. A wrapper may call multiple `autoloop` commands and edit normal project files under the hood.

## Required action

1. Work from the current workspace root.
2. Use `autoloop` commands, preferring `--json` when structured output is needed.
3. Return important CLI output faithfully.
4. Do not manually edit `.autoloop/state.json`, `.autoloop/last_eval.json`, or `.autoloop/experiments.jsonl`.
5. If the `autoloop` executable is unavailable, stop and tell the user to install or build it.

## Shared contract reference

# Shared Action: `autoloop-init`

Bootstrap autoloop in the current project workspace with minimal user interaction.

## Inputs

- Current workspace root
- Existing repository files and tests
- Existing `.autoloop/` directory, if present

## Behavior

1. Check whether `.autoloop/` already exists.
2. If it does not exist, run `autoloop init --verify` from the workspace root.
3. If it already exists, run `autoloop doctor --json` before assuming setup is ready.
4. Treat setup as incomplete until config verification passes.
5. Infer the first usable config from the project itself:
   - choose one primary metric
   - choose the metric direction
   - configure an eval command the project can actually run
   - add one obvious pass/fail guardrail when the repo has a natural correctness command
6. Prefer this inference order:
   - existing test or validation command for the first pass/fail guardrail
   - existing benchmark, perf, or smoke command for the primary eval command
   - `metric_lines` output before regex or custom parsing when the command can be made to emit `METRIC name=value`
7. Keep the first config minimal and executable:
   - one metric
   - zero or one obvious pass/fail guardrail
   - no speculative extra guardrails unless the repo already exposes them
8. Prefer inferring a workable first config from the repo rather than asking the user immediately.
9. If `autoloop init --verify` or `autoloop doctor --json` reports an unhealthy config and a verified repair is available, run `autoloop doctor --fix --json`.
10. If the config is still unhealthy after repair, ask one short blocking question only when the next correction is not obvious.
11. Run `autoloop status --json` after setup to confirm autoloop is ready.

## Rules

- Use the local `autoloop` CLI as the source of truth.
- Do not edit `.autoloop/state.json`, `.autoloop/last_eval.json`, or `.autoloop/experiments.jsonl` by hand.
- Keep the initial config simple and executable; optimize for a reliable first loop, not perfect coverage.
- Treat `autoloop doctor` as the standard way to prove or repair config health.
- Do not invent extra wrapper scripts when an existing repo command is already good enough.


## Autoloop Baseline

Use the local `autoloop` CLI as the source of truth for this workflow action.

These installed names are agent wrappers, not native `autoloop` CLI subcommands. A wrapper may call multiple `autoloop` commands and edit normal project files under the hood.

## Required action

1. Work from the current workspace root.
2. Use `autoloop` commands, preferring `--json` when structured output is needed.
3. Return important CLI output faithfully.
4. Do not manually edit `.autoloop/state.json`, `.autoloop/last_eval.json`, or `.autoloop/experiments.jsonl`.
5. If the `autoloop` executable is unavailable, stop and tell the user to install or build it.

## Shared contract reference

# Shared Action: `autoloop-baseline`

Record a baseline metric once autoloop is configured.

## Inputs

- Current workspace root
- `.autoloop/config.toml`

## Behavior

1. Confirm autoloop is initialized.
2. Run `autoloop doctor --json` before baselining.
3. If doctor reports an unhealthy config and a verified repair is available, run `autoloop doctor --fix --json`.
4. Only continue when doctor reports a healthy config.
5. Run `autoloop baseline`.
6. If baseline fails because parsing or formatting is obviously wrong, rerun `autoloop doctor --json`, apply `--fix` when safe, and retry baseline once.
7. Return the CLI output faithfully, including the recorded metric.
8. If baseline still fails and the next correction is not obvious, ask one short blocking question.

## Rules

- Prefer a deterministic baseline over a noisy or flaky one.
- Do not continue into autonomous looping until baseline succeeds.
- Do not treat a failed baseline as acceptable setup completion.
- Do not skip doctor when the config is new, inferred, or recently repaired.


## Autoloop Doctor

Use the local `autoloop` CLI as the source of truth for this workflow action.

These installed names are agent wrappers, not native `autoloop` CLI subcommands. A wrapper may call multiple `autoloop` commands and edit normal project files under the hood.

## Required action

1. Work from the current workspace root.
2. Use `autoloop` commands, preferring `--json` when structured output is needed.
3. Return important CLI output faithfully.
4. Do not manually edit `.autoloop/state.json`, `.autoloop/last_eval.json`, or `.autoloop/experiments.jsonl`.
5. If the `autoloop` executable is unavailable, stop and tell the user to install or build it.

## Shared contract reference

# Shared Action: `autoloop-doctor`

Verify and, when safe, repair the current autoloop config.

## Inputs

- Current workspace root
- Existing `.autoloop/config.toml`

## Behavior

1. Confirm autoloop is initialized.
2. Run `autoloop doctor --json` from the workspace root.
3. If the report is healthy, return the result faithfully and stop.
4. If the report is unhealthy and a verified inferred repair is available, run `autoloop doctor --fix --json`.
5. If repair succeeds, return the repaired verification result faithfully.
6. If the config is still unhealthy after repair, summarize the specific failing command or parsing issue.
7. Ask the user one short blocking question only when the next correction is not obvious.

## Rules

- Prefer `--json` for decision-making.
- Do not overwrite `.autoloop/config.toml` unless `autoloop doctor --fix` reports a verified repair.
- Do not continue into baseline or autonomous looping while doctor still reports an unhealthy config.


## Autoloop Run

Use the local `autoloop` CLI as the source of truth for this workflow action.

These installed names are agent wrappers, not native `autoloop` CLI subcommands. A wrapper may call multiple `autoloop` commands and edit normal project files under the hood.

## Required action

1. Work from the current workspace root.
2. Use `autoloop` commands, preferring `--json` when structured output is needed.
3. Return important CLI output faithfully.
4. Do not manually edit `.autoloop/state.json`, `.autoloop/last_eval.json`, or `.autoloop/experiments.jsonl`.
5. If the `autoloop` executable is unavailable, stop and tell the user to install or build it.

## Shared contract reference

# Shared Action: `autoloop-run`

Run an autonomous autoloop session for a bounded number of experiments with minimal user interaction.

## Inputs

- User goal or optimization target
- Current workspace root
- Existing `.autoloop/` state, if present
- Optional experiment or time bounds from the user

## Behavior

1. Treat this action as permission to run the full loop without asking for confirmation between setup steps or experiments.
2. Determine the run bound:
   - use the user-specified experiment limit when present
   - otherwise use the user-specified time limit when present
   - otherwise default to 5 experiments
3. Ensure autoloop is initialized. If not, run `autoloop init --verify`.
4. Before baseline or iteration, run `autoloop doctor --json`.
5. If doctor reports an unhealthy config and a verified repair is available, run `autoloop doctor --fix --json`, then recheck health.
6. If the config is still unhealthy after repair, stop and ask one short blocking question instead of forcing the loop forward.
7. Ensure a baseline exists. If not, perform the `autoloop-baseline` behavior first.
8. Inspect `git status --short` before starting the loop.
9. If the repo is dirty only because of setup artifacts created by AutoLoop integration or initialization, treat that state as pre-existing setup rather than as an experiment:
   - examples: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.agents/`, `.claude/`, `.cursor/`, `.opencode/`, `.gemini/`, or a `.gitignore` entry for `.autoloop/`
   - in throwaway or fixture repos, it is acceptable to commit those setup-only files before the session so the loop starts clean
   - otherwise leave them alone and rely on `autoloop pre` to snapshot experiment changes relative to the current state
10. Clean obvious generated cache noise before interpreting dirty state:
   - examples: `__pycache__/`, `*.pyc`, `.pytest_cache/`, or other transient runtime caches
   - do not treat generated caches as experiments
11. If other unrelated dirty files already exist, leave them untouched and do not sweep them into experiment descriptions, keep commits, or discard reverts.
12. Start a session if none is active.
13. If an unresolved pending eval already exists, resolve it before starting a new experiment:
   - keep it with `autoloop keep --description "..." --commit` when the recorded verdict and worktree state support keeping it
   - otherwise discard it with `autoloop discard --description "..." --reason "..." --revert`
14. Read `.autoloop/learnings.md` when it exists.
15. Read `autoloop status --json --all` to understand the current history.
16. Run a bounded optimization loop:
   - propose one small, concrete experiment aligned with the user goal
   - run `autoloop pre --json --description "..."` before making the change
   - if history strongly suggests avoiding the idea, pick a different experiment instead of forcing it
   - make one focused, attributable change
   - run `autoloop eval --json`
   - never leave a pending eval unresolved: immediately keep with `--commit` or discard with `--revert`
   - periodically refresh `autoloop learn --json --session`
17. Stop when any stop condition is reached:
   - the experiment limit is reached
   - the time limit is reached
   - repeated blocked or crashed experiments suggest the loop is not progressing
   - no credible next experiments remain
18. Always end the session with `autoloop session end`.
19. Always run `autoloop learn --json --session` before finishing so `.autoloop/learnings.md` is refreshed by the CLI.
20. Return a concise summary of what was tried, what improved, and what branches or follow-up actions are recommended.

## Rules

- Prefer `--json` for decision-making.
- Keep each experiment small and attributable.
- Default to at most 5 experiments when the user does not specify a bound.
- Treat healthy doctor output as a prerequisite for baseline and autonomous looping.
- Use `autoloop keep --commit` for wins and `autoloop discard --revert` for losses whenever the workspace state allows it.
- Do not edit `.git/info/exclude` or global git ignore files just to hide AutoLoop wrapper files from experiments.
- Treat setup-only dirt separately from experiment dirt; do not let wrapper installation become the first experiment.
- Do not ask the user between experiments unless blocked by missing information, unsafe ambiguity, or repeated hard failures.
- Do not manually edit `.autoloop/state.json`, `.autoloop/last_eval.json`, or `.autoloop/experiments.jsonl`.
- Bound the run. Never interpret this action as permission to loop forever unless the user explicitly requests that.


## Autoloop Status

Use the local `autoloop` CLI as the source of truth for this workflow action.

These installed names are agent wrappers, not native `autoloop` CLI subcommands. A wrapper may call multiple `autoloop` commands and edit normal project files under the hood.

## Required action

1. Work from the current workspace root.
2. Use `autoloop` commands, preferring `--json` when structured output is needed.
3. Return important CLI output faithfully.
4. Do not manually edit `.autoloop/state.json`, `.autoloop/last_eval.json`, or `.autoloop/experiments.jsonl`.
5. If the `autoloop` executable is unavailable, stop and tell the user to install or build it.

## Shared contract reference

# Shared Action: `autoloop-status`

Inspect the current autoloop state and summarize it for the user.

## Inputs

- Current workspace root
- Optional request for current-session scope or all-history scope

## Behavior

1. Run `autoloop status`, using `--json` when structured output is useful.
2. Explain the most important current state:
   - active session
   - baseline presence
   - pending eval
   - kept/discarded/crashed counts
   - current streak and best improvement
3. If there is a pending eval, tell the user whether the next action is effectively keep or discard.

## Rules

- Do not mutate autoloop state from this action.


## Autoloop Learn

Use the local `autoloop` CLI as the source of truth for this workflow action.

These installed names are agent wrappers, not native `autoloop` CLI subcommands. A wrapper may call multiple `autoloop` commands and edit normal project files under the hood.

## Required action

1. Work from the current workspace root.
2. Use `autoloop` commands, preferring `--json` when structured output is needed.
3. Return important CLI output faithfully.
4. Do not manually edit `.autoloop/state.json`, `.autoloop/last_eval.json`, or `.autoloop/experiments.jsonl`.
5. If the `autoloop` executable is unavailable, stop and tell the user to install or build it.

## Shared contract reference

# Shared Action: `autoloop-learn`

Refresh cross-session learnings from experiment history.

## Inputs

- Current workspace root
- Existing `.autoloop/learnings.md`

## Behavior

1. Run `autoloop learn --json --session` for end-of-run updates, or `autoloop learn --json --all` when cross-session history is requested.
2. Interpret the report into a concise update for `.autoloop/learnings.md`.
3. Preserve useful existing learnings that still match the current evidence and delete stale unsupported claims.
4. Use this structure when writing or refreshing the file:
   - `## What Helped`
   - `## What Failed`
   - `## Watchouts`
   - `## Next Ideas`
5. Focus on:
   - categories that reliably help
   - dead ends and repeated failures
   - file or subsystem patterns
   - the best recent improvements
6. Keep each section short, concrete, and evidence-backed.
7. Write the updated `.autoloop/learnings.md`.
8. Return a concise summary of what changed in the learnings file.

## Rules

- Treat the CLI output as the source of truth for statistics.
- Keep the learnings file compact, concrete, and operational.
- Do not invent counts, confidence, or success rates that are not supported by the CLI report.


## Autoloop Finalize

Use the local `autoloop` CLI as the source of truth for this workflow action.

These installed names are agent wrappers, not native `autoloop` CLI subcommands. A wrapper may call multiple `autoloop` commands and edit normal project files under the hood.

## Required action

1. Work from the current workspace root.
2. Use `autoloop` commands, preferring `--json` when structured output is needed.
3. Return important CLI output faithfully.
4. Do not manually edit `.autoloop/state.json`, `.autoloop/last_eval.json`, or `.autoloop/experiments.jsonl`.
5. If the `autoloop` executable is unavailable, stop and tell the user to install or build it.

## Shared contract reference

# Shared Action: `autoloop-finalize`

Create clean review branches from committed kept experiments.

## Inputs

- Current workspace root
- Optional session or all-history scope

## Behavior

1. Confirm the working tree is clean before finalizing.
2. Run `autoloop finalize`, using `--json` when structured output is useful.
3. Present the created review branches and any skipped experiments.
4. If experiments were skipped because they were kept without `--commit`, say so plainly and recommend rerunning future keeps with commits enabled.

## Rules

- Do not manually build review branches outside the CLI when autoloop can do it.
- Treat skipped experiments as a workflow gap, not as silent success.

