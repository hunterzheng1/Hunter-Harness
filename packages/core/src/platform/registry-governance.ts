import { createHash } from "node:crypto";

export interface RegistryCapacityInput {
  currentVersionCount: number;
  plannedAdditions: number;
  quota: number;
  warningRatio?: number;
}

export interface RegistryCapacityAssessment {
  status: "OK" | "WARN" | "BLOCKED";
  reasonCode:
    | "OK"
    | "REGISTRY_VERSION_QUOTA_WARNING"
    | "REGISTRY_VERSION_QUOTA_FULL";
  currentVersionCount: number;
  plannedAdditions: number;
  quota: number;
  remainingBefore: number;
  remainingAfter: number;
  utilizationAfter: number;
}

export function assessRegistryCapacity(
  input: RegistryCapacityInput
): RegistryCapacityAssessment {
  const currentVersionCount = Math.max(0, Math.trunc(input.currentVersionCount));
  const plannedAdditions = Math.max(0, Math.trunc(input.plannedAdditions));
  const quota = Math.max(1, Math.trunc(input.quota));
  const warningRatio = Math.min(1, Math.max(0, input.warningRatio ?? 0.9));
  const remainingBefore = quota - currentVersionCount;
  const remainingAfter = quota - currentVersionCount - plannedAdditions;
  const utilizationAfter = (currentVersionCount + plannedAdditions) / quota;
  const status = remainingAfter < 0
    ? "BLOCKED"
    : utilizationAfter >= warningRatio
      ? "WARN"
      : "OK";
  return {
    status,
    reasonCode: status === "BLOCKED"
      ? "REGISTRY_VERSION_QUOTA_FULL"
      : status === "WARN"
        ? "REGISTRY_VERSION_QUOTA_WARNING"
        : "OK",
    currentVersionCount,
    plannedAdditions,
    quota,
    remainingBefore,
    remainingAfter,
    utilizationAfter
  };
}

export interface RegistryVersion {
  tag: string;
  digest: string;
  createdAt: string;
}

export interface RegistryCleanupInput {
  versions: readonly RegistryVersion[];
  protectedTags: readonly string[];
  protectedDigests: readonly string[];
  pinnedTags?: readonly string[];
  retainVersionCount: number;
}

export interface RegistryCleanupPlan {
  schemaVersion: 1;
  dryRun: true;
  status: "READY" | "BLOCKED";
  reasonCode: "OK" | "PROTECTED_VERSIONS_EXCEED_TARGET";
  policyIdentity: string;
  beforeVersionCount: number;
  afterVersionCount: number;
  retainVersionCount: number;
  protectedTags: string[];
  protectedDigests: string[];
  deleteTags: string[];
  deleteDigests: string[];
}

function canonicalPolicyIdentity(value: unknown): string {
  return "sha256:" + createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

export function planRegistryCleanup(
  input: RegistryCleanupInput
): RegistryCleanupPlan {
  const versions = [...input.versions]
    .filter((version) => version.tag.trim() !== "" && version.digest.trim() !== "");
  const protectedTagSet = new Set([
    ...input.protectedTags,
    ...(input.pinnedTags ?? [])
  ]);
  const protectedDigestSet = new Set(input.protectedDigests);
  for (const version of versions) {
    if (protectedTagSet.has(version.tag)) {
      protectedDigestSet.add(version.digest);
    }
  }
  for (const version of versions) {
    if (protectedDigestSet.has(version.digest)) {
      protectedTagSet.add(version.tag);
    }
  }

  const retainVersionCount = Math.max(0, Math.trunc(input.retainVersionCount));
  const deleteNeeded = Math.max(0, versions.length - retainVersionCount);
  const candidates = versions
    .filter((version) =>
      !protectedTagSet.has(version.tag) &&
      !protectedDigestSet.has(version.digest)
    )
    .sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.tag.localeCompare(right.tag)
    );
  const deletions = candidates.slice(0, deleteNeeded);
  const afterVersionCount = versions.length - deletions.length;
  const status = afterVersionCount > retainVersionCount ? "BLOCKED" : "READY";
  const policy = {
    protectedTags: [...protectedTagSet].sort(),
    protectedDigests: [...protectedDigestSet].sort(),
    retainVersionCount
  };
  return {
    schemaVersion: 1,
    dryRun: true,
    status,
    reasonCode: status === "READY" ? "OK" : "PROTECTED_VERSIONS_EXCEED_TARGET",
    policyIdentity: canonicalPolicyIdentity(policy),
    beforeVersionCount: versions.length,
    afterVersionCount,
    retainVersionCount,
    protectedTags: policy.protectedTags,
    protectedDigests: policy.protectedDigests,
    deleteTags: deletions.map((version) => version.tag),
    deleteDigests: [...new Set(deletions.map((version) => version.digest))].sort()
  };
}
