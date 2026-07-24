export type WebFileKind =
  | "user_editable"
  | "generated_reviewable"
  | "internal_state"
  | "generated_cache"
  | "external_unmanaged";

export interface WebFilePolicy {
  file_kind: WebFileKind;
  edit_policy: "allow" | "managed-block-only" | "discourage" | "protocol-only" | "external";
  push_policy: "diff-proposal" | "full-diff-proposal" | "confirm-before-proposal" | "never";
  update_policy: "managed-block-only" | "skip-if-local-dirty" | "replace-if-baseline-clean" | "protocol-only" | "protocol-rebuild-only" | "never";
  conflict_policy: "skip-and-report" | "managed-block-skip" | "transactional-replace" | "protocol-recover" | "ignore";
}

const managedBlock: WebFilePolicy = {
  file_kind: "user_editable",
  edit_policy: "managed-block-only",
  push_policy: "diff-proposal",
  update_policy: "managed-block-only",
  conflict_policy: "managed-block-skip"
};
const userDiff: WebFilePolicy = {
  file_kind: "user_editable",
  edit_policy: "allow",
  push_policy: "diff-proposal",
  update_policy: "skip-if-local-dirty",
  conflict_policy: "skip-and-report"
};
const projectLocal: WebFilePolicy = {
  file_kind: "user_editable",
  edit_policy: "allow",
  push_policy: "confirm-before-proposal",
  update_policy: "never",
  conflict_policy: "ignore"
};
const generatedReviewable: WebFilePolicy = {
  file_kind: "generated_reviewable",
  edit_policy: "discourage",
  push_policy: "full-diff-proposal",
  update_policy: "skip-if-local-dirty",
  conflict_policy: "skip-and-report"
};
const contextIndex: WebFilePolicy = {
  file_kind: "generated_reviewable",
  edit_policy: "discourage",
  push_policy: "diff-proposal",
  update_policy: "replace-if-baseline-clean",
  conflict_policy: "skip-and-report"
};
const internalState: WebFilePolicy = {
  file_kind: "internal_state",
  edit_policy: "protocol-only",
  push_policy: "never",
  update_policy: "protocol-only",
  conflict_policy: "protocol-recover"
};
const generatedCache: WebFilePolicy = {
  file_kind: "generated_cache",
  edit_policy: "protocol-only",
  push_policy: "never",
  update_policy: "protocol-rebuild-only",
  conflict_policy: "protocol-recover"
};
const external: WebFilePolicy = {
  file_kind: "external_unmanaged",
  edit_policy: "external",
  push_policy: "never",
  update_policy: "never",
  conflict_policy: "ignore"
};

function under(path: string, prefix: string): boolean {
  return path === prefix.slice(0, -1) || path.startsWith(prefix);
}

export function classifyManagedFile(input: string): WebFilePolicy {
  const path = input.replaceAll("\\", "/").replace(/^\.\//, "");
  if (path === "CLAUDE.md" || path === "AGENTS.md") return managedBlock;
  if (under(path, ".claude/rules/") || under(path, ".claude/skills/harness-")) return userDiff;
  if (under(path, ".harness/knowledge/project-local/")) return projectLocal;
  if (under(path, ".harness/knowledge/")) return userDiff;
  if (under(path, ".harness/rules/")) return userDiff;
  if (under(path, ".harness/codebase/map/") ||
      path === ".harness/codebase/map-summary.md" ||
      path === ".harness/codebase/map-manifest.json") return generatedReviewable;
  if (path === ".harness/context-index.json") return contextIndex;
  if (under(path, ".harness/state/")) return internalState;
  if (under(path, ".harness/generated/") || under(path, ".harness/cache/") ||
      under(path, ".harness/reports/")) return generatedCache;
  if (path === ".harness/project.yaml") return userDiff;
  return external;
}

export function isProposalEditable(policy: WebFilePolicy): boolean {
  // The console submits complete file operations. It cannot safely construct a
  // managed-block-only patch for CLAUDE.md or AGENTS.md, so those remain
  // inspectable until a block-aware editor exists.
  return policy.edit_policy === "allow" || policy.edit_policy === "discourage";
}
