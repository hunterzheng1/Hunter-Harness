import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type { FreshnessReport } from "../src/project/refresh.js";
import {
  AdapterFreshnessSyncProviderError,
  createAdapterFreshnessSyncProvider,
  readAdapterFreshnessSyncProviderFixture
} from "../src/sync-providers/adapter-freshness/index.js";
import {
  createSyncContext,
  createSyncMaintenanceModule,
  stableHash
} from "../src/sync-maintenance/index.js";

const currentPath = new URL("./fixtures/adapter-freshness-sync-provider-v1-current.json", import.meta.url);
const legacyPath = new URL("./fixtures/adapter-freshness-sync-provider-v0-legacy.json", import.meta.url);

function context() {
  return createSyncContext({
    schema_version: 1,
    project_identity: "project:test",
    project_change_set: {
      schema_version: 1,
      baseline_available: false,
      dirty_paths: [],
      untracked_paths: []
    },
    enabled_agents: ["codex"],
    agent_profiles: { codex: "general" },
    feature_flags: {}
  });
}

async function current(): Promise<FreshnessReport> {
  return JSON.parse(await readFile(currentPath, "utf8")) as FreshnessReport;
}

function onlyAgent(report: FreshnessReport) {
  const agent = report.agents[0];
  if (agent === undefined) throw new Error("fixture must contain one agent");
  return agent;
}

function onlyFinding<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("expected one finding");
  return value;
}

function collector(value: FreshnessReport | (() => FreshnessReport | Promise<FreshnessReport>)) {
  return {
    collect: typeof value === "function" ? value : async () => value
  };
}

describe("Adapter freshness sync Provider", () => {
  it("projects a current formal FreshnessReport without actions or writes", async () => {
    const source = vi.fn(async () => current());
    const provider = createAdapterFreshnessSyncProvider({ freshness_collector: collector(source) });
    const applicability = await provider.applicable(context());
    const findings = await provider.inspect(context());

    expect(applicability).toEqual({
      applicability: "applicable",
      reason_code: "ADAPTER_FRESHNESS_APPLICABLE"
    });
    expect(findings).toEqual([expect.objectContaining({
      finding_id: "adapter_freshness:codex",
      provider_id: "adapter_freshness",
      status: "OK",
      urgency: "none",
      reason_code: "ADAPTER_CURRENT",
      evidence: expect.objectContaining({ source: "adapter_freshness_v1" })
    })]);
    expect(await provider.plan(context(), findings.map((item) => item.finding_id))).toEqual([]);
    expect(source).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["VERSION_BEHIND", "WARN", "recommended", "ADAPTER_VERSION_BEHIND"],
    ["MISSING", "WARN", "recommended", "ADAPTER_MANAGED_FILES_MISSING"],
    ["PROFILE_MISMATCH", "WARN", "recommended", "ADAPTER_PROFILE_MISMATCH"],
    ["UNVERIFIABLE", "UNKNOWN", "none", "ADAPTER_FRESHNESS_UNVERIFIABLE"],
    ["LOCALLY_MODIFIED", "BLOCKED", "required", "ADAPTER_LOCAL_MODIFICATION_CONFLICT"]
  ] as const)("maps %s without pretending it is a repair action", async (
    freshnessStatus,
    status,
    urgency,
    reasonCode
  ) => {
    const report = await current();
    const agent = onlyAgent(report);
    agent.status = freshnessStatus;
    if (freshnessStatus === "VERSION_BEHIND") {
      agent.identity.installedBundleVersion = "0.2.69";
    }
    if (freshnessStatus === "LOCALLY_MODIFIED") {
      agent.driftedFiles = [".codex/skills/harness/SKILL.md"];
      agent.identity.verificationStatus = "degraded";
      agent.identity.mismatchDetails = [{
        relpath: ".codex/skills/harness/SKILL.md",
        expected: "a".repeat(64),
        actual: "b".repeat(64)
      }];
      agent.identity.installedAdapterHash = "f".repeat(64);
    }
    if (freshnessStatus === "MISSING") {
      agent.missingFiles = [".codex/skills/harness/SKILL.md"];
      agent.identity.verificationStatus = "degraded";
      agent.identity.mismatchDetails = [{
        relpath: ".codex/skills/harness/SKILL.md",
        expected: "a".repeat(64),
        actual: "<missing>"
      }];
      agent.identity.installedAdapterHash = "f".repeat(64);
    }
    if (freshnessStatus === "PROFILE_MISMATCH") {
      agent.profile = "java";
    }
    if (freshnessStatus === "UNVERIFIABLE") {
      agent.identity.installedContentHash = null;
      agent.identity.verificationStatus = "unknown";
    }
    const provider = createAdapterFreshnessSyncProvider({ freshness_collector: collector(report) });
    const findings = await provider.inspect(context());
    expect(findings[0]).toMatchObject({ status, urgency, reason_code: reasonCode });
    expect(await provider.plan(context(), ["adapter_freshness:codex"])).toEqual([]);
  });

  it.each([
    ["CURRENT", { installedBundleVersion: "0.2.69" }, "ADAPTER_VERSION_BEHIND"],
    ["VERSION_BEHIND", {}, "ADAPTER_CURRENT"],
    ["CURRENT", { installedManifestHash: "f".repeat(64) }, "ADAPTER_VERSION_BEHIND"],
    ["CURRENT", { installedCoreHash: "f".repeat(64) }, "ADAPTER_VERSION_BEHIND"],
    ["CURRENT", { installedAdapterHash: "f".repeat(64) }, "ADAPTER_LOCAL_MODIFICATION_CONFLICT"],
    ["CURRENT", { installedContentHash: null }, "ADAPTER_FRESHNESS_UNVERIFIABLE"]
  ] as const)("derives facts instead of trusting contradictory %s status", async (
    claimedStatus,
    identityChanges,
    expectedReason
  ) => {
    const report = await current();
    const agent = onlyAgent(report);
    agent.status = claimedStatus;
    Object.assign(agent.identity, identityChanges);
    if (expectedReason === "ADAPTER_LOCAL_MODIFICATION_CONFLICT") {
      agent.driftedFiles = [".codex/skills/harness/SKILL.md"];
      agent.identity.verificationStatus = "degraded";
      agent.identity.mismatchDetails = [{
        relpath: ".codex/skills/harness/SKILL.md",
        expected: "a".repeat(64),
        actual: "b".repeat(64)
      }];
    }
    if (expectedReason === "ADAPTER_FRESHNESS_UNVERIFIABLE") {
      agent.identity.verificationStatus = "unknown";
    }
    const finding = onlyFinding(await createAdapterFreshnessSyncProvider({ freshness_collector: collector(report) })
      .inspect(context()));
    expect(finding.reason_code).toBe(expectedReason);
  });

  it("canonicalizes equivalent file evidence order to the same finding hash", async () => {
    const first = await current();
    const agent = onlyAgent(first);
    agent.status = "LOCALLY_MODIFIED";
    agent.identity.verificationStatus = "degraded";
    agent.driftedFiles = ["z.md", "a.md"];
    agent.identity.mismatchDetails = [
      { relpath: "z.md", expected: "a".repeat(64), actual: "b".repeat(64) },
      { relpath: "a.md", expected: "c".repeat(64), actual: "d".repeat(64) }
    ];
    agent.identity.installedAdapterHash = "f".repeat(64);
    const second = structuredClone(first);
    onlyAgent(second).driftedFiles.reverse();
    onlyAgent(second).identity.mismatchDetails.reverse();
    const firstFinding = onlyFinding(await createAdapterFreshnessSyncProvider({ freshness_collector: collector(first) })
      .inspect(context()));
    const secondFinding = onlyFinding(await createAdapterFreshnessSyncProvider({ freshness_collector: collector(second) })
      .inspect(context()));
    expect(firstFinding).toEqual(secondFinding);
  });

  it.each([
    "duplicate_path",
    "invented_detail",
    "missing_without_detail",
    "wrong_missing_actual",
    "overlapping_path",
    "verified_mismatch",
    "aggregate_claims_equal"
  ] as const)("rejects inconsistent per-file evidence: %s", async (mode) => {
    const report = await current();
    const agent = onlyAgent(report);
    agent.status = "LOCALLY_MODIFIED";
    agent.identity.verificationStatus = "degraded";
    const detail = { relpath: "a.md", expected: "a".repeat(64), actual: "b".repeat(64) };
    agent.driftedFiles = mode === "duplicate_path" ? ["a.md", "a.md"] : ["a.md"];
    agent.missingFiles = mode === "overlapping_path" ? ["a.md"] : [];
    agent.identity.mismatchDetails = mode === "invented_detail"
      ? [detail, { ...detail, relpath: "invented.md" }]
      : mode === "missing_without_detail"
        ? []
        : mode === "wrong_missing_actual" || mode === "overlapping_path"
          ? [{ ...detail, actual: "<missing>" }]
          : [detail];
    if (mode === "wrong_missing_actual") {
      agent.driftedFiles = [];
      agent.missingFiles = ["a.md"];
      agent.identity.mismatchDetails = [{ ...detail, actual: "b".repeat(64) }];
    }
    if (mode === "verified_mismatch") agent.identity.verificationStatus = "verified";
    if (mode === "aggregate_claims_equal") {
      agent.identity.installedAdapterHash = agent.identity.adapterHash;
    }
    const provider = createAdapterFreshnessSyncProvider({ freshness_collector: collector(report) });
    await expect(provider.inspect(context())).rejects.toMatchObject({
      code: "ADAPTER_FRESHNESS_REPORT_INVALID"
    });
  });

  it("is not applicable when the formal report proves no Adapter installation", async () => {
    const report = await current();
    const installedAgent = onlyAgent(report);
    report.agents[0] = {
      ...installedAgent,
      profile: null,
      status: "UNVERIFIABLE",
      identity: {
        ...installedAgent.identity,
        installedBundleVersion: null,
        installedManifestHash: null,
        installedCoreHash: null,
        installedAdapterHash: null,
        installedContentHash: null,
        verifiedAt: null,
        verificationStatus: "unknown"
      }
    };
    const provider = createAdapterFreshnessSyncProvider({ freshness_collector: collector(report) });
    expect(await provider.applicable(context())).toEqual({
      applicability: "not_applicable",
      reason_code: "ADAPTER_NOT_INSTALLED"
    });
    expect(await provider.inspect(context())).toEqual([]);
  });

  it("reports UNKNOWN rather than not_applicable when installation exists but Profile evidence is missing", async () => {
    const report = await current();
    onlyAgent(report).profile = null;
    const provider = createAdapterFreshnessSyncProvider({ freshness_collector: collector(report) });
    expect(await provider.applicable(context())).toMatchObject({ applicability: "applicable" });
    expect(onlyFinding(await provider.inspect(context()))).toMatchObject({
      status: "UNKNOWN",
      urgency: "none",
      reason_code: "ADAPTER_FRESHNESS_UNVERIFIABLE"
    });
  });

  it("derives profile drift and rejects context-agent drift plus hostile reports before accessors", async () => {
    const profileDrift = await current();
    onlyAgent(profileDrift).profile = "java";
    const driftProvider = createAdapterFreshnessSyncProvider({ freshness_collector: collector(profileDrift) });
    expect(onlyFinding(await driftProvider.inspect(context()))).toMatchObject({
      reason_code: "ADAPTER_PROFILE_MISMATCH"
    });

    const missingAgent = await current();
    missingAgent.agents = [];
    await expect(createAdapterFreshnessSyncProvider({ freshness_collector: collector(missingAgent) })
      .inspect(context())).rejects.toMatchObject({ code: "ADAPTER_FRESHNESS_CONTEXT_MISMATCH" });

    const getter = vi.fn(() => 1);
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(hostile, "schema_version", { enumerable: true, get: getter });
    const hostileProvider = createAdapterFreshnessSyncProvider({
      freshness_collector: collector(hostile as FreshnessReport)
    });
    await expect(hostileProvider.inspect(context())).rejects.toMatchObject({
      code: "ADAPTER_FRESHNESS_REPORT_INVALID"
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it("does not invoke a callable field hidden in a hostile report", async () => {
    const execute = vi.fn();
    const report = await current() as FreshnessReport & { execute?: () => void };
    report.execute = execute;
    const provider = createAdapterFreshnessSyncProvider({ freshness_collector: collector(report) });
    await expect(provider.inspect(context())).rejects.toMatchObject({
      code: "ADAPTER_FRESHNESS_REPORT_INVALID"
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects transparent root and nested report Proxies without executing their traps", async () => {
    const report = await current();
    const rootTrap = vi.fn((target: FreshnessReport, key: PropertyKey) => Reflect.get(target, key));
    const rootProxy = new Proxy(report, { get: rootTrap });
    await expect(createAdapterFreshnessSyncProvider({ freshness_collector: { collect: () => rootProxy } })
      .inspect(context())).rejects.toMatchObject({ code: "ADAPTER_FRESHNESS_REPORT_INVALID" });
    expect(rootTrap).not.toHaveBeenCalled();

    const nested = await current();
    const identityTrap = vi.fn((target: object, key: PropertyKey) => Reflect.get(target, key));
    onlyAgent(nested).identity = new Proxy(onlyAgent(nested).identity, { get: identityTrap });
    await expect(createAdapterFreshnessSyncProvider({ freshness_collector: collector(nested) })
      .inspect(context())).rejects.toMatchObject({ code: "ADAPTER_FRESHNESS_REPORT_INVALID" });
    expect(identityTrap).not.toHaveBeenCalled();
  });

  it("rejects an ordinary thenable report without Promise assimilation", async () => {
    const getter = vi.fn(() => { throw new Error("then getter must not run"); });
    const thenable = await current() as FreshnessReport & { then?: unknown };
    Object.defineProperty(thenable, "then", { enumerable: true, get: getter });
    const provider = createAdapterFreshnessSyncProvider({
      freshness_collector: { collect: () => thenable } as never
    });

    await expect(provider.inspect(context())).rejects.toMatchObject({
      code: "ADAPTER_FRESHNESS_REPORT_INVALID"
    });
    expect(getter).not.toHaveBeenCalled();
  });

  it("canonicalizes equivalent raw and prefixed SHA-256 identities", async () => {
    const raw = await current();
    const prefixed = structuredClone(raw);
    const identity = onlyAgent(prefixed).identity;
    for (const key of ["manifestHash", "installedManifestHash", "coreHash", "installedCoreHash",
      "adapterHash", "installedAdapterHash", "installedContentHash"] as const) {
      const value = identity[key];
      if (value !== null) identity[key] = `sha256:${value}`;
    }
    const rawFinding = onlyFinding(await createAdapterFreshnessSyncProvider({
      freshness_collector: collector(raw)
    }).inspect(context()));
    const prefixedFinding = onlyFinding(await createAdapterFreshnessSyncProvider({
      freshness_collector: collector(prefixed)
    }).inspect(context()));
    expect(prefixedFinding).toEqual(rawFinding);
    expect(rawFinding.evidence.observed_hash).toBe(`sha256:${"d".repeat(64)}`);
  });

  it.each([
    "2026-02-30T08:00:00.000Z",
    "2026-08-14T08:00:00Z",
    "2026-08-14T08:00:00.00Z"
  ])("rejects non-canonical or impossible verification timestamp %s", async (timestamp) => {
    const report = await current();
    onlyAgent(report).identity.verifiedAt = timestamp;
    const provider = createAdapterFreshnessSyncProvider({ freshness_collector: collector(report) });
    await expect(provider.inspect(context())).rejects.toMatchObject({
      code: "ADAPTER_FRESHNESS_REPORT_INVALID"
    });
  });

  it("rejects a hostile collector Proxy without executing any callable", () => {
    const execute = vi.fn();
    const hostile = new Proxy({ collect: execute }, {
      getOwnPropertyDescriptor() { throw new Error("collector trap"); },
      getPrototypeOf() { throw new Error("collector prototype trap"); }
    });
    expect(() => createAdapterFreshnessSyncProvider({ freshness_collector: hostile }))
      .toThrow(expect.objectContaining({ code: "ADAPTER_FRESHNESS_COLLECTOR_INVALID" }));
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an accessor Provider input without invoking its getter", () => {
    const getter = vi.fn(() => collector(async () => current()));
    const input = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(input, "freshness_collector", { enumerable: true, get: getter });
    expect(() => createAdapterFreshnessSyncProvider(input as never))
      .toThrow(expect.objectContaining({ code: "ADAPTER_FRESHNESS_COLLECTOR_INVALID" }));
    expect(getter).not.toHaveBeenCalled();
  });

  it("produces stable state evidence across collection timestamps and repeated runs", async () => {
    const first = await current();
    const second = structuredClone(first);
    second.generated_at = "2026-08-14T09:00:00.000Z";
    onlyAgent(second).identity.verifiedAt = "2026-08-14T09:00:00.000Z";
    const firstFinding = onlyFinding(await createAdapterFreshnessSyncProvider({ freshness_collector: collector(first) })
      .inspect(context()));
    const secondFinding = onlyFinding(await createAdapterFreshnessSyncProvider({ freshness_collector: collector(second) })
      .inspect(context()));
    expect(firstFinding).toEqual(secondFinding);
    expect(firstFinding.evidence.input_hash).toBe(stableHash({
      agent: "codex",
      profile: "general",
      status: "CURRENT",
      identity: {
        adapter: "codex",
        bundleVersion: "0.2.70",
        installedBundleVersion: "0.2.70",
        manifestHash: "sha256:" + "a".repeat(64),
        installedManifestHash: "sha256:" + "a".repeat(64),
        coreHash: "sha256:" + "b".repeat(64),
        installedCoreHash: "sha256:" + "b".repeat(64),
        adapterHash: "sha256:" + "c".repeat(64),
        installedAdapterHash: "sha256:" + "c".repeat(64),
        installedContentHash: "sha256:" + "d".repeat(64),
        verificationStatus: "verified",
        mismatchDetails: []
      },
      driftedFiles: [],
      missingFiles: []
    }));
  });

  it("has no effectful path without a formal protected refresh Port", async () => {
    const provider = createAdapterFreshnessSyncProvider({ freshness_collector: collector(await current()) });
    const fake = {} as never;
    await expect(provider.apply(fake, fake)).rejects.toBeInstanceOf(AdapterFreshnessSyncProviderError);
    await expect(provider.verify(fake)).rejects.toMatchObject({ code: "ADAPTER_FRESHNESS_READ_ONLY" });
    await expect(provider.rollback(fake, fake)).rejects.toMatchObject({
      code: "ADAPTER_FRESHNESS_READ_ONLY"
    });
  });

  it("preserves BLOCKED and UNKNOWN semantics through the 04A Module with no actions", async () => {
    const blocked = await current();
    const blockedAgent = onlyAgent(blocked);
    blockedAgent.status = "LOCALLY_MODIFIED";
    blockedAgent.driftedFiles = [".codex/skills/harness/SKILL.md"];
    blockedAgent.identity.verificationStatus = "degraded";
    blockedAgent.identity.mismatchDetails = [{
      relpath: ".codex/skills/harness/SKILL.md",
      expected: "sha256:" + "a".repeat(64),
      actual: "sha256:" + "b".repeat(64)
    }];
    blockedAgent.identity.installedAdapterHash = "f".repeat(64);
    const blockedPlan = await createSyncMaintenanceModule({
      providers: [createAdapterFreshnessSyncProvider({ freshness_collector: collector(blocked) })]
    }).inspect(context());
    expect(blockedPlan.provider_results[0]).toMatchObject({
      applicability: "applicable",
      status: "BLOCKED",
      urgency: "required"
    });
    expect(blockedPlan.summary.status_counts).toMatchObject({ BLOCKED: 1 });
    expect(blockedPlan.actions).toEqual([]);

    const unknown = await current();
    const unknownAgent = onlyAgent(unknown);
    unknownAgent.status = "UNVERIFIABLE";
    unknownAgent.identity.verificationStatus = "unknown";
    const unknownPlan = await createSyncMaintenanceModule({
      providers: [createAdapterFreshnessSyncProvider({ freshness_collector: collector(unknown) })]
    }).inspect(context());
    expect(unknownPlan.provider_results[0]).toMatchObject({ status: "UNKNOWN", urgency: "none" });
    expect(unknownPlan.actions).toEqual([]);
  });

  it("reads v1 strictly and exposes v0 only as frozen migration evidence", async () => {
    const v1 = readAdapterFreshnessSyncProviderFixture(JSON.parse(await readFile(currentPath, "utf8")));
    expect(v1).toMatchObject({ ok: true, source_schema_version: 1 });
    expect(Object.isFrozen(v1)).toBe(true);
    const legacy = readAdapterFreshnessSyncProviderFixture(JSON.parse(await readFile(legacyPath, "utf8")));
    expect(legacy).toEqual({
      ok: true,
      source_schema_version: 0,
      readiness: "legacy_read_only",
      legacy: {
        status: "WARN",
        input_hash: null,
        report_path: null,
        report_sha256: null
      },
      reason_codes: ["ADAPTER_FRESHNESS_LEGACY_REINSPECTION_REQUIRED"]
    });
    expect(Object.isFrozen(legacy)).toBe(true);
    expect(readAdapterFreshnessSyncProviderFixture({ schema_version: 8 })).toEqual({
      ok: false,
      reason_code: "ADAPTER_FRESHNESS_RECORD_VERSION_UNSUPPORTED"
    });
  });
});
