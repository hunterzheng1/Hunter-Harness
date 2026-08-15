import { HARNESS_AGENT_ORDER, type HarnessAgent } from "@hunter-harness/contracts";
import { isProxy } from "node:util/types";

import type { AgentFreshness, FreshnessIdentity, FreshnessReport } from "../../project/refresh.js";
import { discriminateTrustedAsyncResult } from "../../trusted-async-result/index.js";
import {
  compareCodepoint,
  deepFreeze,
  stableHash,
  type ProviderApplicability,
  type SyncActionPlan,
  type SyncActionProvider,
  type SyncActionReceipt,
  type SyncApplyConfirmation,
  type SyncContext,
  type SyncFinding,
  type SyncRollbackReceipt,
  type SyncSha256,
  type SyncVerification
} from "../../sync-maintenance/index.js";
import { AdapterFreshnessSyncProviderError } from "./errors.js";
import type { AdapterFreshnessSyncProviderInput } from "./types.js";

const PROVIDER_ID = "adapter_freshness";
const REPORT_KEYS = ["schema_version", "generated_at", "agents"] as const;
const AGENT_KEYS = ["agent", "profile", "status", "identity", "driftedFiles", "missingFiles"] as const;
const IDENTITY_KEYS = [
  "adapter", "bundleVersion", "installedBundleVersion", "manifestHash", "installedManifestHash",
  "coreHash", "installedCoreHash", "adapterHash", "installedAdapterHash", "installedContentHash",
  "verifiedAt", "verificationStatus", "mismatchDetails"
] as const;
const MISMATCH_KEYS = ["relpath", "expected", "actual"] as const;
const freshnessStatuses = new Set([
  "CURRENT", "LOCALLY_MODIFIED", "MISSING", "VERSION_BEHIND", "PROFILE_MISMATCH", "UNVERIFIABLE"
]);
const verificationStatuses = new Set(["verified", "stale", "degraded", "unknown"]);
const digestPattern = /^(?:sha256:)?[a-f0-9]{64}$/u;
const profiles = new Set(["general", "java"]);
const agents = new Set<string>(HARNESS_AGENT_ORDER);

function dataRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  try {
    if (value === null || typeof value !== "object" || isProxy(value) || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  try {
    const actual = Object.keys(value).sort(compareCodepoint);
    const expected = [...keys].sort(compareCodepoint);
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  } catch {
    return false;
  }
}

function denseArray(value: unknown, maximum = 256): value is readonly unknown[] {
  try {
    if (value === null || typeof value !== "object" || isProxy(value) ||
        !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > maximum) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || keys[keys.length - 1] !== "length") return false;
    return Array.from({ length: value.length }, (_, index) => String(index)).every((key, index) => {
      if (keys[index] !== key) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

function text(value: unknown, maximum = 1024): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value === value.trim() && value === value.normalize("NFC") &&
    ![...value].some((character) => (character.codePointAt(0) ?? 0) <= 31);
}

function nullableText(value: unknown): value is string | null {
  return value === null || text(value);
}

function nullableDigest(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && digestPattern.test(value));
}

function canonicalDigest(value: string | null): string | null {
  return value === null ? null : value.startsWith("sha256:") ? value : `sha256:${value}`;
}

function canonicalPath(value: unknown): value is string {
  if (!text(value, 512) || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/u.test(value)) {
    return false;
  }
  return !value.split("/").some((segment) => segment === "" || segment === "." || segment === ".." ||
    segment.startsWith(".env") || segment === "credentials.local" ||
    segment.startsWith("credentials.local."));
}

function stringArray(value: unknown, paths = false): readonly string[] | undefined {
  if (!denseArray(value)) return undefined;
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(value, String(index))?.value;
    if (!(paths ? canonicalPath(item) : text(item))) return undefined;
    result.push(item as string);
  }
  if (new Set(result).size !== result.length) return undefined;
  return result;
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function mismatch(value: unknown): FreshnessIdentity["mismatchDetails"][number] | undefined {
  if (!dataRecord(value) || !exactKeys(value, MISMATCH_KEYS) || !canonicalPath(value.relpath) ||
      typeof value.expected !== "string" || !digestPattern.test(value.expected) ||
      !(value.actual === "<missing>" ||
        (typeof value.actual === "string" && digestPattern.test(value.actual)))) return undefined;
  return {
    relpath: value.relpath,
    expected: canonicalDigest(value.expected) as string,
    actual: value.actual === "<missing>" ? value.actual : canonicalDigest(value.actual) as string
  };
}

function identity(value: unknown, agent: HarnessAgent): FreshnessIdentity | undefined {
  if (!dataRecord(value) || !exactKeys(value, IDENTITY_KEYS) || value.adapter !== agent ||
      !nullableText(value.bundleVersion) || !nullableText(value.installedBundleVersion) ||
      !nullableDigest(value.manifestHash) || !nullableDigest(value.installedManifestHash) ||
      !nullableDigest(value.coreHash) || !nullableDigest(value.installedCoreHash) ||
      !nullableDigest(value.adapterHash) || !nullableDigest(value.installedAdapterHash) ||
      !nullableDigest(value.installedContentHash) ||
      !(value.verifiedAt === null || validTimestamp(value.verifiedAt)) ||
      !verificationStatuses.has(value.verificationStatus as string) || !denseArray(value.mismatchDetails)) {
    return undefined;
  }
  const mismatchDetails: FreshnessIdentity["mismatchDetails"][number][] = [];
  for (let index = 0; index < value.mismatchDetails.length; index += 1) {
    const detail = mismatch(Object.getOwnPropertyDescriptor(value.mismatchDetails, String(index))?.value);
    if (detail === undefined) return undefined;
    mismatchDetails.push(detail);
  }
  return {
    adapter: agent,
    bundleVersion: value.bundleVersion as string | null,
    installedBundleVersion: value.installedBundleVersion as string | null,
    manifestHash: canonicalDigest(value.manifestHash as string | null),
    installedManifestHash: canonicalDigest(value.installedManifestHash as string | null),
    coreHash: canonicalDigest(value.coreHash as string | null),
    installedCoreHash: canonicalDigest(value.installedCoreHash as string | null),
    adapterHash: canonicalDigest(value.adapterHash as string | null),
    installedAdapterHash: canonicalDigest(value.installedAdapterHash as string | null),
    installedContentHash: canonicalDigest(value.installedContentHash as string | null),
    verifiedAt: value.verifiedAt as string | null,
    verificationStatus: value.verificationStatus as FreshnessIdentity["verificationStatus"],
    mismatchDetails
  };
}

function agentSnapshot(value: unknown): AgentFreshness | undefined {
  if (!dataRecord(value) || !exactKeys(value, AGENT_KEYS) || !agents.has(value.agent as string) ||
      !(value.profile === null || profiles.has(value.profile as string)) ||
      !freshnessStatuses.has(value.status as string)) return undefined;
  const agent = value.agent as HarnessAgent;
  const driftedFiles = stringArray(value.driftedFiles, true);
  const missingFiles = stringArray(value.missingFiles, true);
  const identitySnapshot = identity(value.identity, agent);
  if (driftedFiles === undefined || missingFiles === undefined || identitySnapshot === undefined) return undefined;
  const pathSet = new Set([...driftedFiles, ...missingFiles]);
  if (pathSet.size !== driftedFiles.length + missingFiles.length ||
      identitySnapshot.mismatchDetails.length !== pathSet.size) return undefined;
  const details = [...identitySnapshot.mismatchDetails].sort((left, right) =>
    compareCodepoint(left.relpath, right.relpath));
  if (new Set(details.map((detail) => detail.relpath)).size !== details.length ||
      details.some((detail) => !pathSet.has(detail.relpath) ||
        (missingFiles.includes(detail.relpath)
          ? detail.actual !== "<missing>"
          : detail.actual === "<missing>"))) return undefined;
  if ((pathSet.size > 0 && identitySnapshot.verificationStatus !== "degraded") ||
      (pathSet.size === 0 && identitySnapshot.verificationStatus === "degraded") ||
      (pathSet.size > 0 && identitySnapshot.adapterHash === identitySnapshot.installedAdapterHash) ||
      (pathSet.size === 0 && identitySnapshot.adapterHash !== null &&
        identitySnapshot.installedAdapterHash !== null &&
        identitySnapshot.adapterHash !== identitySnapshot.installedAdapterHash)) return undefined;
  return {
    agent,
    profile: value.profile as AgentFreshness["profile"],
    status: value.status as AgentFreshness["status"],
    identity: {
      ...identitySnapshot,
      mismatchDetails: details.map((detail) => ({ ...detail }))
    },
    driftedFiles: [...driftedFiles].sort(compareCodepoint),
    missingFiles: [...missingFiles].sort(compareCodepoint)
  };
}

export function normalizeAdapterFreshnessReport(value: unknown): FreshnessReport | undefined {
  if (!dataRecord(value) || !exactKeys(value, REPORT_KEYS) || value.schema_version !== 1 ||
      !validTimestamp(value.generated_at) || !denseArray(value.agents, 32)) return undefined;
  const snapshots: AgentFreshness[] = [];
  for (let index = 0; index < value.agents.length; index += 1) {
    const snapshot = agentSnapshot(Object.getOwnPropertyDescriptor(value.agents, String(index))?.value);
    if (snapshot === undefined) return undefined;
    snapshots.push(snapshot);
  }
  if (new Set(snapshots.map((item) => item.agent)).size !== snapshots.length) return undefined;
  snapshots.sort((left, right) => compareCodepoint(left.agent, right.agent));
  return deepFreeze({ schema_version: 1, generated_at: value.generated_at, agents: snapshots });
}

function stateIdentity(snapshot: AgentFreshness): unknown {
  const { verifiedAt: ignored, ...identityWithoutTimestamp } = snapshot.identity;
  void ignored;
  return {
    agent: snapshot.agent,
    profile: snapshot.profile,
    status: snapshot.status,
    identity: identityWithoutTimestamp,
    driftedFiles: snapshot.driftedFiles,
    missingFiles: snapshot.missingFiles
  };
}

function installed(snapshot: AgentFreshness): boolean {
  const identity = snapshot.identity;
  return [
    identity.installedBundleVersion,
    identity.installedManifestHash,
    identity.installedCoreHash,
    identity.installedAdapterHash,
    identity.installedContentHash
  ].some((value) => value !== null);
}

function completeIdentity(identity: FreshnessIdentity): boolean {
  return identity.bundleVersion !== null && identity.installedBundleVersion !== null &&
    identity.manifestHash !== null && identity.installedManifestHash !== null &&
    identity.coreHash !== null && identity.installedCoreHash !== null &&
    identity.adapterHash !== null && identity.installedAdapterHash !== null &&
    identity.installedContentHash !== null && identity.verifiedAt !== null;
}

function deriveStatus(snapshot: AgentFreshness, expectedProfile: string): AgentFreshness["status"] {
  const identity = snapshot.identity;
  if (snapshot.profile === null || !completeIdentity(identity)) return "UNVERIFIABLE";
  if (snapshot.profile !== expectedProfile) return "PROFILE_MISMATCH";
  if (identity.bundleVersion !== identity.installedBundleVersion ||
      identity.manifestHash !== identity.installedManifestHash ||
      identity.coreHash !== identity.installedCoreHash) return "VERSION_BEHIND";
  if (snapshot.missingFiles.length > 0) return "MISSING";
  if (snapshot.driftedFiles.length > 0 || identity.adapterHash !== identity.installedAdapterHash) {
    return "LOCALLY_MODIFIED";
  }
  if (identity.verificationStatus === "verified" && identity.mismatchDetails.length === 0) {
    return "CURRENT";
  }
  return "UNVERIFIABLE";
}

function syncDigest(value: string): SyncSha256 {
  return (value.startsWith("sha256:") ? value : `sha256:${value}`) as SyncSha256;
}

function presentation(snapshot: AgentFreshness): Pick<SyncFinding,
"status" | "urgency" | "reason_code" | "display_title_zh" | "display_message_zh"> {
  switch (snapshot.status) {
    case "CURRENT": return {
      status: "OK", urgency: "none", reason_code: "ADAPTER_CURRENT",
      display_title_zh: `${snapshot.agent} Adapter 已是最新`,
      display_message_zh: "正式 Bundle 身份与已安装投影内容一致，无需刷新。"
    };
    case "VERSION_BEHIND": return {
      status: "WARN", urgency: "recommended", reason_code: "ADAPTER_VERSION_BEHIND",
      display_title_zh: `${snapshot.agent} Adapter 版本落后`,
      display_message_zh: "已安装 Bundle 与当前正式 Bundle 身份不同；本只读检查不会自动刷新。"
    };
    case "LOCALLY_MODIFIED": return {
      status: "BLOCKED", urgency: "required", reason_code: "ADAPTER_LOCAL_MODIFICATION_CONFLICT",
      display_title_zh: `${snapshot.agent} Adapter 存在本地修改`,
      display_message_zh: "受管投影已被本地修改，必须先处理冲突；检查不会覆盖这些文件。"
    };
    case "MISSING": return {
      status: "WARN", urgency: "recommended", reason_code: "ADAPTER_MANAGED_FILES_MISSING",
      display_title_zh: `${snapshot.agent} Adapter 文件缺失`,
      display_message_zh: "已安装 Bundle 的受管投影不完整；本只读检查不会补写文件。"
    };
    case "PROFILE_MISMATCH": return {
      status: "WARN", urgency: "recommended", reason_code: "ADAPTER_PROFILE_MISMATCH",
      display_title_zh: `${snapshot.agent} Adapter Profile 不一致`,
      display_message_zh: "请求 Profile 与已安装 Profile 不一致；未选择迁移动作时保持原配置。"
    };
    case "UNVERIFIABLE": return {
      status: "UNKNOWN", urgency: "none", reason_code: "ADAPTER_FRESHNESS_UNVERIFIABLE",
      display_title_zh: `${snapshot.agent} Adapter 新鲜度无法验证`,
      display_message_zh: "当前证据不足，不能宣称已是最新，也不会生成修复动作。"
    };
  }
}

type DependencyMethod = (...args: unknown[]) => unknown;

function dependencyMethod(value: unknown, name: string): DependencyMethod | undefined {
  if (value === null || typeof value !== "object" || isProxy(value)) return undefined;
  try {
    let owner: object | null = value;
    for (let depth = 0; owner !== null && depth < 8; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      if (descriptor !== undefined) {
        return "value" in descriptor && typeof descriptor.value === "function"
          ? descriptor.value as DependencyMethod
          : undefined;
      }
      owner = Object.getPrototypeOf(owner) as object | null;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function createAdapterFreshnessSyncProvider(
  input: AdapterFreshnessSyncProviderInput
): SyncActionProvider {
  if (!dataRecord(input) || !exactKeys(input, ["freshness_collector"])) {
    throw new AdapterFreshnessSyncProviderError("ADAPTER_FRESHNESS_COLLECTOR_INVALID");
  }
  const collectorDescriptor = Object.getOwnPropertyDescriptor(input, "freshness_collector");
  const freshnessCollector = collectorDescriptor !== undefined && "value" in collectorDescriptor
    ? collectorDescriptor.value
    : undefined;
  const collectMethod = dependencyMethod(freshnessCollector, "collect");
  if (collectMethod === undefined) {
    throw new AdapterFreshnessSyncProviderError("ADAPTER_FRESHNESS_COLLECTOR_INVALID");
  }
  const collect = collectMethod;
  async function report(context: SyncContext): Promise<FreshnessReport> {
    let raw: unknown;
    try {
      const collected = collect.call(freshnessCollector, context);
      const trusted = discriminateTrustedAsyncResult(collected);
      if (trusted === undefined) {
        throw new AdapterFreshnessSyncProviderError("ADAPTER_FRESHNESS_REPORT_INVALID");
      }
      raw = trusted.kind === "promise" ? await trusted.promise : trusted.value;
    } catch (error) {
      if (error instanceof AdapterFreshnessSyncProviderError) throw error;
      throw new AdapterFreshnessSyncProviderError("ADAPTER_FRESHNESS_REPORT_INVALID");
    }
    const normalized = normalizeAdapterFreshnessReport(raw);
    if (normalized === undefined) {
      throw new AdapterFreshnessSyncProviderError("ADAPTER_FRESHNESS_REPORT_INVALID");
    }
    const enabled = [...context.enabled_agents].sort(compareCodepoint);
    const observed = normalized.agents.map((item) => item.agent).sort(compareCodepoint);
    if (enabled.length !== observed.length || enabled.some((agent, index) => agent !== observed[index])) {
      throw new AdapterFreshnessSyncProviderError("ADAPTER_FRESHNESS_CONTEXT_MISMATCH");
    }
    return deepFreeze({
      ...normalized,
      agents: normalized.agents.map((snapshot) => ({
        ...snapshot,
        status: deriveStatus(snapshot, context.agent_profiles[snapshot.agent] ?? "")
      }))
    });
  }

  function readOnly(): never {
    throw new AdapterFreshnessSyncProviderError("ADAPTER_FRESHNESS_READ_ONLY");
  }

  return Object.freeze({
    provider_id: PROVIDER_ID,
    async applicable(context: SyncContext): Promise<ProviderApplicability> {
      const snapshots = await report(context);
      return deepFreeze(snapshots.agents.some(installed)
        ? { applicability: "applicable", reason_code: "ADAPTER_FRESHNESS_APPLICABLE" }
        : { applicability: "not_applicable", reason_code: "ADAPTER_NOT_INSTALLED" });
    },
    async inspect(context: SyncContext): Promise<readonly SyncFinding[]> {
      const snapshots = await report(context);
      if (!snapshots.agents.some(installed)) return deepFreeze([]);
      return deepFreeze(snapshots.agents.filter(installed).map((snapshot) => ({
        schema_version: 1 as const,
        finding_id: `adapter_freshness:${snapshot.agent}`,
        provider_id: PROVIDER_ID,
        ...presentation(snapshot),
        evidence: {
          source: "adapter_freshness_v1",
          input_hash: stableHash(stateIdentity(snapshot)),
          ...(snapshot.identity.installedContentHash === null
            ? {}
            : { observed_hash: syncDigest(snapshot.identity.installedContentHash) })
        }
      })));
    },
    async plan(_context: SyncContext, _finding_ids: readonly string[]): Promise<readonly SyncActionPlan[]> {
      void _context;
      void _finding_ids;
      return deepFreeze([]);
    },
    async apply(_action: SyncActionPlan, _confirmation: SyncApplyConfirmation): Promise<SyncActionReceipt> {
      void _action;
      void _confirmation;
      return readOnly();
    },
    async verify(_receipt: SyncActionReceipt): Promise<SyncVerification> {
      void _receipt;
      return readOnly();
    },
    async rollback(_action: SyncActionPlan, _receipt: SyncActionReceipt): Promise<SyncRollbackReceipt> {
      void _action;
      void _receipt;
      return readOnly();
    }
  });
}

export const adapterFreshnessSyncProviderInternals = Object.freeze({
  normalizeAdapterFreshnessReport
});
