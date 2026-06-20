import type { FilePolicy } from "@hunter-harness/contracts";

import { normalizeManagedPath } from "../fs/path-safety.js";

const USER_MANAGED_BLOCK: FilePolicy = {
  file_kind: "user_editable",
  edit_policy: "managed-block-only",
  push_policy: "diff-proposal",
  update_policy: "managed-block-only",
  conflict_policy: "managed-block-skip"
};

const USER_DIFF: FilePolicy = {
  file_kind: "user_editable",
  edit_policy: "allow",
  push_policy: "diff-proposal",
  update_policy: "skip-if-local-dirty",
  conflict_policy: "skip-and-report"
};

const USER_FULL: FilePolicy = {
  file_kind: "user_editable",
  edit_policy: "allow",
  push_policy: "full-diff-proposal",
  update_policy: "skip-if-local-dirty",
  conflict_policy: "skip-and-report"
};

const PROJECT_LOCAL: FilePolicy = {
  file_kind: "user_editable",
  edit_policy: "allow",
  push_policy: "confirm-before-proposal",
  update_policy: "never",
  conflict_policy: "ignore"
};

const GENERATED_REVIEWABLE: FilePolicy = {
  file_kind: "generated_reviewable",
  edit_policy: "discourage",
  push_policy: "full-diff-proposal",
  update_policy: "skip-if-local-dirty",
  conflict_policy: "skip-and-report"
};

const CONTEXT_INDEX: FilePolicy = {
  file_kind: "generated_reviewable",
  edit_policy: "discourage",
  push_policy: "diff-proposal",
  update_policy: "replace-if-baseline-clean",
  conflict_policy: "skip-and-report"
};

const INTERNAL_STATE: FilePolicy = {
  file_kind: "internal_state",
  edit_policy: "protocol-only",
  push_policy: "never",
  update_policy: "protocol-only",
  conflict_policy: "protocol-recover"
};

const GENERATED_CACHE: FilePolicy = {
  file_kind: "generated_cache",
  edit_policy: "protocol-only",
  push_policy: "never",
  update_policy: "protocol-rebuild-only",
  conflict_policy: "protocol-recover"
};

const REPORT_CACHE: FilePolicy = {
  file_kind: "generated_cache",
  edit_policy: "discourage",
  push_policy: "never",
  update_policy: "never",
  conflict_policy: "ignore"
};

const EXTERNAL: FilePolicy = {
  file_kind: "external_unmanaged",
  edit_policy: "external",
  push_policy: "never",
  update_policy: "never",
  conflict_policy: "ignore"
};

function under(path: string, prefix: string): boolean {
  return path === prefix.slice(0, -1) || path.startsWith(prefix);
}

export function classifyFile(input: string): FilePolicy {
  const path = normalizeManagedPath(input);
  if (path === "CLAUDE.md" || path === "AGENTS.md") {
    return USER_MANAGED_BLOCK;
  }
  if (under(path, ".claude/rules/") || under(path, ".claude/skills/harness-")) {
    return USER_DIFF;
  }
  if (under(path, ".harness/knowledge/project-local/")) {
    return PROJECT_LOCAL;
  }
  if (under(path, ".harness/knowledge/")) {
    return USER_FULL;
  }
  if (
    under(path, ".harness/codebase/map/") ||
    path === ".harness/codebase/map-summary.md" ||
    path === ".harness/codebase/map-manifest.json"
  ) {
    return GENERATED_REVIEWABLE;
  }
  if (path === ".harness/context-index.json") {
    return CONTEXT_INDEX;
  }
  if (under(path, ".harness/reports/")) {
    return REPORT_CACHE;
  }
  if (under(path, ".harness/state/") || under(path, ".harness/rules/")) {
    return INTERNAL_STATE;
  }
  if (under(path, ".harness/generated/") || under(path, ".harness/cache/")) {
    return GENERATED_CACHE;
  }
  if (path === ".harness/project.yaml") {
    return USER_DIFF;
  }
  return EXTERNAL;
}

export type PushDecision =
  | { include: true }
  | { include: false; reason: "confirmation-required" | "policy-never" };

export function decidePush(
  policy: FilePolicy,
  confirmed: boolean
): PushDecision {
  if (policy.push_policy === "never") {
    return { include: false, reason: "policy-never" };
  }
  if (policy.push_policy === "confirm-before-proposal" && !confirmed) {
    return { include: false, reason: "confirmation-required" };
  }
  return { include: true };
}

export type UpdateDecision =
  | { apply: true }
  | { apply: false; reason: "local-dirty" | "policy-never" | "protocol-only" };

export function decideUpdate(
  policy: FilePolicy,
  dirty: boolean
): UpdateDecision {
  if (policy.update_policy === "never") {
    return { apply: false, reason: "policy-never" };
  }
  if (
    policy.update_policy === "protocol-only" ||
    policy.update_policy === "protocol-rebuild-only"
  ) {
    return { apply: false, reason: "protocol-only" };
  }
  if (dirty) {
    return { apply: false, reason: "local-dirty" };
  }
  return { apply: true };
}
