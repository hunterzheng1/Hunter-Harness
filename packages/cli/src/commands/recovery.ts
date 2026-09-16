import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  cleanupOldTransactions,
  diagnoseRecovery,
  inspectRecovery,
  loadBundle,
  pendingTransactions,
  PROJECTION_SURFACES,
  readRecoveryTargetBundleState,
  readDurableRecoveryIds,
  recoverTransaction,
  RecoveryPreconditionError,
  resolveRecoveryRoot,
  resumeTransaction,
  rollbackCommittedUpdate,
  rollbackLatestCommittedUpdate,
  sha256Bytes,
  type ProjectionSurface,
  type RecoveryInspection
} from "@hunter-harness/core";
import {
  canonicalJson,
  recoveryResultSchema,
  type RecoveryAction,
  type RecoveryResult
} from "@hunter-harness/contracts";

import type { CommandDependencies, ConfigureOptions } from "./configure.js";
import { detectProject } from "./refresh.js";
import { readCliVersion } from "../version.js";

export interface RecoveryCommandOptions {
  action?: string;
  json?: boolean;
  nonInteractive?: boolean;
  yes?: boolean;
  recoveryRoot?: string;
}

function recoveryCommand(recoveryId: string): string {
  return `npx hunter-harness resume ${recoveryId} --json`;
}

function emitRecoveryResult(
  result: RecoveryResult,
  json: boolean,
  dependencies: CommandDependencies
): void {
  const parsed = recoveryResultSchema.parse(result);
  dependencies.stdout(json
    ? JSON.stringify(parsed) + "\n"
    : `${parsed.status}: ${parsed.message ?? parsed.reasonCode ?? "完成"}\n`);
}

function selectedRecoveryRoot(
  options: RecoveryCommandOptions,
  dependencies: CommandDependencies
): string {
  return options.recoveryRoot ?? resolveRecoveryRoot(dependencies.env);
}

async function currentProjectIdentity(
  dependencies: CommandDependencies
): Promise<string | undefined> {
  const detection = await detectProject(dependencies.cwd);
  return detection.status === "valid"
    ? detection.config.project.local_project_key
    : undefined;
}

function recoveryErrorCode(error: unknown): string {
  return error instanceof Error && "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "RECOVERY_PRECONDITION_FAILED";
}

function emitRecoveryError(
  error: unknown,
  recoveryId: string | null,
  json: boolean,
  dependencies: CommandDependencies,
  inspection?: RecoveryInspection
): number {
  const reasonCode = recoveryErrorCode(error);
  emitRecoveryResult({
    schemaVersion: 1,
    status: "BLOCKED",
    reasonCode,
    recoveryId,
    mutationState: inspection?.mutationState ?? "NOT_STARTED",
    safeActions: inspection === undefined
      ? []
      : inspection.safeActions.filter((action) =>
        action === "inspect" || action === "diagnose"
      ),
    recommendedAction: inspection === undefined ? null : "inspect",
    resumeCommand: null,
    message: error instanceof Error ? error.message : String(error)
  }, json, dependencies);
  return reasonCode === "RECOVERY_NOT_FOUND" ||
    reasonCode === "RECOVERY_ID_INVALID" ? 3 : 5;
}

async function runRecoveryStatusUnchecked(
  options: RecoveryCommandOptions,
  dependencies: CommandDependencies
): Promise<number> {
  const recoveryRoot = selectedRecoveryRoot(options, dependencies);
  const projectIdentity = await currentProjectIdentity(dependencies);
  const pending = await pendingTransactions(dependencies.cwd);
  const known = new Set(pending.map((item) => item.recoveryId));
  for (const recoveryId of await readDurableRecoveryIds(
    dependencies.cwd,
    recoveryRoot,
    projectIdentity
  )) {
    if (known.has(recoveryId)) continue;
    let inspection: RecoveryInspection;
    try {
      inspection = await inspectRecovery(dependencies.cwd, recoveryId, {
        recoveryRoot,
        ...(projectIdentity === undefined ? {} : { projectIdentity })
      });
    } catch (error) {
      // 幻影索引条目（目录已被外部清理）不进入状态视图。
      if (error instanceof RecoveryPreconditionError && error.code === "RECOVERY_NOT_FOUND") {
        continue;
      }
      throw error;
    }
    if (inspection.state === "committed" || inspection.state === "rolled_back") {
      continue;
    }
    pending.push({
      transactionId: inspection.transactionId,
      recoveryId: inspection.recoveryId,
      kind: inspection.kind,
      state: inspection.state,
      mutationState: inspection.mutationState,
      appliedCount: 0,
      operationCount: 0,
      createdAt: inspection.createdAt
    });
  }
  pending.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const latest = pending[0];
  const latestInspection = latest === undefined
    ? null
    : await inspectRecovery(dependencies.cwd, latest.recoveryId, {
      recoveryRoot,
      ...(projectIdentity === undefined ? {} : { projectIdentity })
    });
  const latestSafeActions = latestInspection === null
    ? []
    : await safeActionsForCurrentEnvironment(
      latestInspection,
      dependencies,
      recoveryRoot
    );
  const mutationState = latest?.mutationState ?? "NOT_STARTED";
  emitRecoveryResult({
    schemaVersion: 1,
    status: pending.length > 0 ? "RECOVERY_REQUIRED" : "OK",
    reasonCode: pending.length > 0 ? "UNFINISHED_TRANSACTION" : null,
    recoveryId: latest?.recoveryId ?? null,
    mutationState,
    safeActions: latestSafeActions,
    recommendedAction: pending.length > 0 ? "inspect" : null,
    resumeCommand: latestInspection !== null &&
      latestSafeActions.includes("resume")
      ? recoveryCommand(latestInspection.recoveryId)
      : null,
    pending: pending.map((item) => ({
      transactionId: item.transactionId,
      recoveryId: item.recoveryId,
      kind: item.kind ?? null,
      state: item.state,
      mutationState: item.mutationState,
      createdAt: item.createdAt
    }))
  }, options.json === true, dependencies);
  return 0;
}

export async function runRecoveryStatus(
  options: RecoveryCommandOptions,
  dependencies: CommandDependencies
): Promise<number> {
  try {
    return await runRecoveryStatusUnchecked(options, dependencies);
  } catch (error) {
    return emitRecoveryError(
      error,
      null,
      options.json === true,
      dependencies
    );
  }
}

function parseRecoveryAction(value: string | undefined): RecoveryAction | null {
  if (value === "inspect" || value === "resume" || value === "rollback" ||
      value === "diagnose" || value === "preserve-project-overlay") {
    return value;
  }
  return null;
}

interface InstalledManifestIdentity {
  surface: ProjectionSurface;
  bundle_version: string;
  bundle_manifest_hash: string;
}

function parseProjectionSurface(value: unknown): ProjectionSurface | null {
  return typeof value === "string" &&
    (PROJECTION_SURFACES as readonly string[]).includes(value)
    ? (value as ProjectionSurface)
    : null;
}

async function currentResumeIdentity(
  inspection: RecoveryInspection,
  dependencies: CommandDependencies,
  recoveryRoot: string
): Promise<{
  projectIdentity: string;
  cliVersion: string;
  targetBundleVersion: string;
  ownershipManifestHash: string;
}> {
  const detection = await detectProject(dependencies.cwd);
  const plannedState = await readRecoveryTargetBundleState(
    dependencies.cwd,
    inspection.recoveryId,
    {
      recoveryRoot,
      ...(detection.status === "valid"
        ? { projectIdentity: detection.config.project.local_project_key }
        : {})
    }
  );
  // v1.0：投影面固定，唯一需要与恢复计划比对的可变维度是项目身份
  // （planned project 与 journal 的一致性由 core 侧读取时校验）。
  let projectIdentity: string;
  if (detection.status === "valid") {
    projectIdentity = detection.config.project.local_project_key;
    if (inspection.projectIdentity !== null &&
        inspection.projectIdentity !== projectIdentity) {
      throw Object.assign(new Error(
        "current project identity does not match the recovery plan"
      ), { code: "RECOVERY_PRECONDITION_FAILED" });
    }
  } else if (inspection.kind === "init" &&
      inspection.projectIdentity !== null &&
      plannedState !== null &&
      plannedState.projectIdentity === inspection.projectIdentity) {
    projectIdentity = inspection.projectIdentity;
  } else {
    throw Object.assign(new Error(
      "current project identity is unavailable; inspect or rollback instead"
    ), { code: "RECOVERY_PRECONDITION_FAILED" });
  }

  let manifestCandidates: unknown[];
  let expectedSurfaceValues: unknown[];
  if (plannedState !== null) {
    manifestCandidates = plannedState.manifests.map((manifest) => ({
      surface: manifest.surface,
      bundle_version: manifest.bundleVersion,
      bundle_manifest_hash: manifest.bundleManifestHash
    }));
    expectedSurfaceValues = plannedState.surfaces;
  } else {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(
        dependencies.cwd,
        ".harness",
        "state",
        "local",
        "installed-harness-bundle.json"
      ), "utf8"));
    } catch {
      throw Object.assign(new Error(
        "current installed Bundle identity is unavailable"
      ), { code: "RECOVERY_PRECONDITION_FAILED" });
    }
    const record = raw as {
      schema_version?: unknown;
      surfaces?: unknown;
      manifests?: unknown;
    };
    if (record.schema_version !== 5 ||
        !Array.isArray(record.surfaces) ||
        !Array.isArray(record.manifests) ||
        record.manifests.length === 0) {
      throw Object.assign(new Error(
        "current installed Bundle identity is invalid"
      ), { code: "RECOVERY_PRECONDITION_FAILED" });
    }
    manifestCandidates = record.manifests;
    expectedSurfaceValues = record.surfaces;
  }

  const manifests: InstalledManifestIdentity[] = [];
  const recordedManifests: InstalledManifestIdentity[] = [];
  for (const candidate of manifestCandidates) {
    const item = candidate as Partial<InstalledManifestIdentity>;
    const surface = parseProjectionSurface(item.surface);
    if (surface === null ||
        typeof item.bundle_version !== "string" ||
        typeof item.bundle_manifest_hash !== "string") {
      throw Object.assign(new Error(
        "current installed Bundle manifest is invalid"
      ), { code: "RECOVERY_PRECONDITION_FAILED" });
    }
    recordedManifests.push({
      surface,
      bundle_version: item.bundle_version,
      bundle_manifest_hash: item.bundle_manifest_hash
    });
    const bundle = await loadBundle(dependencies.resourcesRoot, surface);
    manifests.push({
      surface,
      bundle_version: bundle.manifest.bundle_version,
      bundle_manifest_hash: sha256Bytes(canonicalJson(bundle.manifest.files))
    });
  }
  manifests.sort((left, right) => left.surface.localeCompare(right.surface));
  recordedManifests.sort(
    (left, right) => left.surface.localeCompare(right.surface)
  );
  if (canonicalJson(manifests) !== canonicalJson(recordedManifests)) {
    throw Object.assign(new Error(
      "installed Bundle metadata does not match the local Bundle resources"
    ), { code: "RECOVERY_PRECONDITION_FAILED" });
  }
  const expectedSurfaces = expectedSurfaceValues.flatMap((value) => {
    const parsed = parseProjectionSurface(value);
    return parsed === null ? [] : [parsed];
  });
  if (expectedSurfaces.length !== expectedSurfaceValues.length) {
    throw Object.assign(new Error(
      "installed Bundle surfaces are invalid"
    ), { code: "RECOVERY_PRECONDITION_FAILED" });
  }
  if (canonicalJson(manifests.map((item) => item.surface).sort()) !==
      canonicalJson([...expectedSurfaces].sort())) {
    throw Object.assign(new Error(
      "installed Bundle surfaces do not match the current project"
    ), { code: "RECOVERY_PRECONDITION_FAILED" });
  }
  // 身份派生必须与 initialize/refresh 的事务身份逐字节一致：
  // init 取 codex 主投影面；refresh 取 surface 排序后的版本聚合与清单哈希。
  const primary = manifests.find((item) => item.surface === "codex");
  const targetBundleVersion = inspection.kind === "init"
    ? primary?.bundle_version
    : manifests.map((item) => item.bundle_version).sort().join("+");
  const ownershipManifestHash = inspection.kind === "init"
    ? primary?.bundle_manifest_hash
    : sha256Bytes(canonicalJson(manifests));
  if (targetBundleVersion === undefined ||
      ownershipManifestHash === undefined) {
    throw Object.assign(new Error(
      "current Bundle identity cannot be derived"
    ), { code: "RECOVERY_PRECONDITION_FAILED" });
  }
  return {
    projectIdentity,
    cliVersion: await readCliVersion(),
    targetBundleVersion,
    ownershipManifestHash
  };
}

async function safeActionsForCurrentEnvironment(
  inspection: RecoveryInspection,
  dependencies: CommandDependencies,
  recoveryRoot: string
): Promise<RecoveryAction[]> {
  if (!inspection.safeActions.includes("resume")) {
    return [...inspection.safeActions];
  }
  try {
    await currentResumeIdentity(inspection, dependencies, recoveryRoot);
    return [...inspection.safeActions];
  } catch {
    return inspection.safeActions.filter((action) => action !== "resume");
  }
}

/** durable 索引是近似结构：跳过目录已被外部清理的幻影候选，返回首个仍可定位的条目。 */
async function firstLocatableDurableId(
  dependencies: CommandDependencies,
  durableIds: readonly string[],
  recoveryRoot: string,
  projectIdentity: string | undefined
): Promise<string | undefined> {
  for (const candidate of durableIds) {
    try {
      await inspectRecovery(dependencies.cwd, candidate, {
        recoveryRoot,
        ...(projectIdentity === undefined ? {} : { projectIdentity })
      });
      return candidate;
    } catch (error) {
      if (error instanceof RecoveryPreconditionError && error.code === "RECOVERY_NOT_FOUND") {
        continue;
      }
      throw error;
    }
  }
  return undefined;
}

async function runRecoveryCommandUnchecked(
  recoveryId: string | undefined,
  options: RecoveryCommandOptions,
  dependencies: CommandDependencies,
  defaultAction?: RecoveryAction
): Promise<number> {
  const recoveryRoot = selectedRecoveryRoot(options, dependencies);
  const projectIdentity = await currentProjectIdentity(dependencies);
  const pending = await pendingTransactions(dependencies.cwd);
  const durableIds = await readDurableRecoveryIds(
    dependencies.cwd,
    recoveryRoot,
    projectIdentity
  );
  const selectedId = recoveryId ?? pending[0]?.recoveryId ??
    await firstLocatableDurableId(dependencies, durableIds, recoveryRoot, projectIdentity);
  if (selectedId === undefined) {
    return emitRecoveryError(
      Object.assign(new Error("没有可恢复的事务"), {
        code: "RECOVERY_NOT_FOUND"
      }),
      null,
      options.json === true,
      dependencies
    );
  }
  let inspection: RecoveryInspection;
  try {
    inspection = await inspectRecovery(dependencies.cwd, selectedId, {
      recoveryRoot,
      ...(projectIdentity === undefined ? {} : { projectIdentity })
    });
  } catch (error) {
    return emitRecoveryError(
      error,
      selectedId,
      options.json === true,
      dependencies
    );
  }
  const displaySafeActions = await safeActionsForCurrentEnvironment(
    inspection,
    dependencies,
    recoveryRoot
  );
  let action = parseRecoveryAction(options.action) ?? defaultAction ?? null;
  if (options.action !== undefined &&
      parseRecoveryAction(options.action) === null) {
    dependencies.stderr(
      "RECOVERY_ACTION_INVALID: unsupported recovery action " +
      options.action + "\n"
    );
    emitRecoveryResult({
      schemaVersion: 1,
      status: "BLOCKED",
      reasonCode: "RECOVERY_ACTION_INVALID",
      recoveryId: selectedId,
      mutationState: inspection.mutationState,
      safeActions: displaySafeActions,
      recommendedAction: "inspect",
      resumeCommand: null
    }, options.json === true, dependencies);
    return 2;
  }
  if (action === null && options.nonInteractive !== true) {
    const answer = await dependencies.prompt(
      "恢复动作：1. inspect 2. resume 3. rollback 4. diagnose [1]："
    );
    action = ({ "": "inspect", "1": "inspect", "2": "resume", "3": "rollback",
      "4": "diagnose" } as const)[answer.trim()] ?? null;
  }
  if (action === null) {
    emitRecoveryResult({
      schemaVersion: 1,
      status: "RECOVERY_REQUIRED",
      reasonCode: "RECOVERY_ACTION_REQUIRED",
      recoveryId: selectedId,
      mutationState: inspection.mutationState,
      safeActions: displaySafeActions,
      recommendedAction: "inspect",
      resumeCommand: displaySafeActions.includes("resume")
        ? recoveryCommand(selectedId)
        : null
    }, options.json === true, dependencies);
    return 5;
  }
  if (action === "inspect") {
    emitRecoveryResult({
      schemaVersion: 1,
      status: inspection.state === "committed" ? "COMMITTED" :
        inspection.state === "rolled_back" ? "ROLLED_BACK" : "RECOVERY_REQUIRED",
      reasonCode: inspection.state === "committed" ||
        inspection.state === "rolled_back"
        ? null : "UNFINISHED_TRANSACTION",
      recoveryId: inspection.recoveryId,
      mutationState: inspection.mutationState,
      safeActions: displaySafeActions,
      recommendedAction: inspection.state === "committed" ||
        inspection.state === "rolled_back"
        ? null
        : displaySafeActions.includes("resume")
          ? "resume"
          : displaySafeActions.includes("rollback")
            ? "rollback"
            : "inspect",
      resumeCommand: displaySafeActions.includes("resume")
        ? recoveryCommand(inspection.recoveryId)
        : null,
      affectedPaths: inspection.affectedPaths
    }, options.json === true, dependencies);
    return 0;
  }
  if (action === "rollback") {
    if (options.nonInteractive === true && options.yes !== true) {
      if (options.json === true) {
        emitRecoveryResult({
          schemaVersion: 1,
          status: "BLOCKED",
          reasonCode: "RECOVERY_CONFIRMATION_REQUIRED",
          recoveryId: selectedId,
          mutationState: inspection.mutationState,
          safeActions: displaySafeActions,
          recommendedAction: "inspect",
          resumeCommand: null
        }, true, dependencies);
      } else {
        dependencies.stderr("非交互恢复写入需要 --yes。\n");
      }
      return 2;
    }
    const result = inspection.state === "committed" &&
      inspection.kind === "update"
      ? await rollbackCommittedUpdate(dependencies.cwd, selectedId)
      : await recoverTransaction(dependencies.cwd, selectedId, {
          recoveryRoot,
          ...(projectIdentity === undefined ? {} : { projectIdentity })
        });
    emitRecoveryResult({
      schemaVersion: 1,
      status: result.status === "rolled_back" ? "ROLLED_BACK" : "COMMITTED",
      reasonCode: null,
      recoveryId: result.recoveryId,
      mutationState: result.status === "rolled_back" ? "ROLLED_BACK" : "COMMITTED",
      safeActions: ["inspect", "diagnose"],
      recommendedAction: null,
      resumeCommand: null
    }, options.json === true, dependencies);
    return 0;
  }

  if (action === "resume") {
    if (options.nonInteractive === true && options.yes !== true) {
      if (options.json === true) {
        emitRecoveryResult({
          schemaVersion: 1,
          status: "BLOCKED",
          reasonCode: "RECOVERY_CONFIRMATION_REQUIRED",
          recoveryId: selectedId,
          mutationState: inspection.mutationState,
          safeActions: displaySafeActions,
          recommendedAction: "inspect",
          resumeCommand: null
        }, true, dependencies);
      } else {
        dependencies.stderr("非交互恢复写入需要 --yes。\n");
      }
      return 2;
    }
    try {
      const currentIdentity = await currentResumeIdentity(
        inspection,
        dependencies,
        recoveryRoot
      );
      const result = await resumeTransaction(dependencies.cwd, selectedId, {
        recoveryRoot,
        ...currentIdentity
      });
      emitRecoveryResult({
        schemaVersion: 1,
        status: result.status === "committed" ? "COMMITTED" : "ROLLED_BACK",
        reasonCode: null,
        recoveryId: result.recoveryId,
        mutationState: result.status === "committed" ? "COMMITTED" : "ROLLED_BACK",
        safeActions: ["inspect", "diagnose"],
        recommendedAction: null,
        resumeCommand: null
      }, options.json === true, dependencies);
      return 0;
    } catch (error) {
      const reasonCode = error instanceof Error && "code" in error &&
        typeof error.code === "string"
        ? error.code
        : "RECOVERY_PRECONDITION_FAILED";
      emitRecoveryResult({
        schemaVersion: 1,
        status: "BLOCKED",
        reasonCode,
        recoveryId: selectedId,
        mutationState: inspection.mutationState,
        safeActions: inspection.safeActions.filter((candidate) =>
          candidate !== "resume"
        ),
        recommendedAction: "inspect",
        resumeCommand: null
      }, options.json === true, dependencies);
      return 5;
    }
  }

  if (action === "diagnose") {
    const diagnosis = await diagnoseRecovery(dependencies.cwd, selectedId, {
      recoveryRoot,
      ...(projectIdentity === undefined ? {} : { projectIdentity })
    });
    emitRecoveryResult({
      schemaVersion: 1,
      status: inspection.state === "committed" ? "COMMITTED" :
        inspection.state === "rolled_back" ? "ROLLED_BACK" : "RECOVERY_REQUIRED",
      reasonCode: diagnosis.reasonCode,
      recoveryId: diagnosis.recoveryId,
      mutationState: diagnosis.mutationState,
      safeActions: inspection.safeActions,
      recommendedAction: inspection.state === "committed" ||
        inspection.state === "rolled_back" ? null : "inspect",
      resumeCommand: inspection.safeActions.includes("resume")
        ? recoveryCommand(selectedId)
        : null,
      diagnosis
    }, options.json === true, dependencies);
    return diagnosis.scanPassed ? 0 : 5;
  }

  emitRecoveryResult({
    schemaVersion: 1,
    status: "BLOCKED",
    reasonCode: "RECOVERY_ACTION_UNSUPPORTED",
    recoveryId: selectedId,
    mutationState: inspection.mutationState,
    safeActions: ["inspect", "rollback"],
    recommendedAction: "inspect",
    resumeCommand: recoveryCommand(selectedId)
  }, options.json === true, dependencies);
  return 5;
}

export async function runRecoveryCommand(
  recoveryId: string | undefined,
  options: RecoveryCommandOptions,
  dependencies: CommandDependencies,
  defaultAction?: RecoveryAction
): Promise<number> {
  try {
    return await runRecoveryCommandUnchecked(
      recoveryId,
      options,
      dependencies,
      defaultAction
    );
  } catch (error) {
    let inspection: RecoveryInspection | undefined;
    if (recoveryId !== undefined) {
      inspection = await inspectRecovery(dependencies.cwd, recoveryId, {
        recoveryRoot: selectedRecoveryRoot(options, dependencies)
      }).catch(() => undefined);
    }
    return emitRecoveryError(
      error,
      recoveryId ?? null,
      options.json === true,
      dependencies,
      inspection
    );
  }
}

export async function runRecoveryMenuIfApplicable(
  options: ConfigureOptions,
  dependencies: CommandDependencies
): Promise<number | null> {
  const pending = await pendingTransactions(dependencies.cwd);
  const recoveryRoot = options.recoveryRoot ??
    resolveRecoveryRoot(dependencies.env);
  const projectIdentity = await currentProjectIdentity(dependencies);
  const durablePendingIds: string[] = [];
  for (const recoveryId of await readDurableRecoveryIds(
    dependencies.cwd,
    recoveryRoot,
    projectIdentity
  )) {
    if (pending.some((item) => item.recoveryId === recoveryId)) continue;
    let inspection: RecoveryInspection;
    try {
      inspection = await inspectRecovery(dependencies.cwd, recoveryId, {
        recoveryRoot,
        ...(projectIdentity === undefined ? {} : { projectIdentity })
      });
    } catch (error) {
      // 索引是近似定位结构（投影可能滞后于事务目录的实际清理）：
      // 目录已不存在的幻影候选直接跳过，不能让 bare 启动崩在过期条目上。
      if (error instanceof RecoveryPreconditionError && error.code === "RECOVERY_NOT_FOUND") {
        continue;
      }
      throw error;
    }
    if (inspection.state !== "committed" && inspection.state !== "rolled_back") {
      durablePendingIds.push(recoveryId);
    }
  }
  const selectedRecoveryId = pending[0]?.recoveryId ?? durablePendingIds[0];
  if (selectedRecoveryId !== undefined) {
    if (options.nonInteractive === true) {
      return runRecoveryCommand(selectedRecoveryId, {
        nonInteractive: true,
        ...(options.yes === undefined ? {} : { yes: options.yes }),
        ...(options.json === undefined ? {} : { json: options.json }),
        recoveryRoot
      }, dependencies);
    }
    const answer = await dependencies.prompt([
      "检测到未完成的 Hunter Harness 事务。",
      "1. 恢复最近一次失败的更新",
      "2. 回滚最近一次已提交的更新",
      "3. 查看事务状态",
      "4. 清理旧事务",
      "请选择 [1-4]："
    ].join("\n"));
    try {
      if (answer.trim() === "1") {
        return runRecoveryCommand(selectedRecoveryId, {
          action: "resume",
          recoveryRoot
        }, dependencies);
      }
      if (answer.trim() === "2") {
        const result = await rollbackLatestCommittedUpdate(dependencies.cwd);
        dependencies.stdout("回滚完成：" + result.status + "。\n");
        return 0;
      }
      if (answer.trim() === "3") {
        return runRecoveryCommand(selectedRecoveryId, {
          action: "inspect",
          recoveryRoot
        }, dependencies);
      }
      if (answer.trim() === "4") {
        const removed = await cleanupOldTransactions(dependencies.cwd);
        dependencies.stdout("已清理 " + removed.length + " 个旧事务。\n");
        return 0;
      }
      return 2;
    } catch (error) {
      dependencies.stderr((error instanceof Error ? error.message : String(error)) + "\n");
      return 5;
    }
  }

  // Healthy initialized projects use the interactive home menu in configure /
  // project-menu (one-click refresh, tools, platform, transactions). This
  // function only intercepts when recovery work is pending (handled above).
  return null;
}
