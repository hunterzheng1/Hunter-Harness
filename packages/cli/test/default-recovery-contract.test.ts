import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadAgentBundle,
  sha256Bytes,
  runTransaction,
  stateLayout
} from "@hunter-harness/core";
import { canonicalJson } from "@hunter-harness/contracts";
import { describe, expect, it } from "vitest";

import { runCli } from "../src/bin.js";

const resourcesRoot = fileURLToPath(
  new URL("../../workflow-data-harness", import.meta.url)
);

function outputCapture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    dependencies: {
      resourcesRoot,
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value)
    }
  };
}

describe("guarded default and recovery command contract", () => {
  it("status reports an interrupted transaction without mutating project files", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-status-contract-"));
    const init = outputCapture();
    expect(await runCli(["--profile", "general", "--non-interactive", "--yes"], {
      cwd: root,
      ...init.dependencies
    }), init.stderr.join("")).toBe(0);
    const target = join(root, "status.md");
    await writeFile(target, "before\n");
    await expect(runTransaction(root, [{
      operation: "modify",
      path: "status.md",
      content: "after\n"
    }], {
      id: "tx_status_contract",
      kind: "update",
      interruptAfterApply: 1
    })).rejects.toThrow(/interrupted/i);
    const beforeStatus = await readFile(target, "utf8");

    const status = outputCapture();
    expect(await runCli(["status", "--json"], {
      cwd: root,
      ...status.dependencies
    })).toBe(0);
    expect(JSON.parse(status.stdout.join(""))).toMatchObject({
      schemaVersion: 1,
      status: "RECOVERY_REQUIRED",
      mutationState: "APPLIED_PARTIAL",
      pending: [{
        transactionId: "tx_status_contract",
        recoveryId: "tx_status_contract"
      }]
    });
    expect(await readFile(target, "utf8")).toBe(beforeStatus);
  });

  it("resume can explicitly roll back an interrupted transaction in non-interactive mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-resume-contract-"));
    const init = outputCapture();
    expect(await runCli(["--profile", "general", "--non-interactive", "--yes"], {
      cwd: root,
      ...init.dependencies
    }), init.stderr.join("")).toBe(0);
    const target = join(root, "resume.md");
    await writeFile(target, "before\n");
    await expect(runTransaction(root, [{
      operation: "modify",
      path: "resume.md",
      content: "after\n"
    }], {
      id: "tx_resume_contract",
      kind: "update",
      interruptAfterApply: 1
    })).rejects.toThrow(/interrupted/i);

    const resume = outputCapture();
    expect(await runCli([
      "resume",
      "tx_resume_contract",
      "--action",
      "rollback",
      "--non-interactive",
      "--yes",
      "--json"
    ], {
      cwd: root,
      ...resume.dependencies
    })).toBe(0);
    expect(JSON.parse(resume.stdout.join(""))).toMatchObject({
      schemaVersion: 1,
      status: "ROLLED_BACK",
      recoveryId: "tx_resume_contract",
      mutationState: "ROLLED_BACK"
    });
    expect(await readFile(target, "utf8")).toBe("before\n");
  });

  it("resume continues only pending work and emits one JSON document", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-cli-resume-"));
    const recoveryRoot = await mkdtemp(join(tmpdir(), "hunter-cli-recovery-"));
    const initialized = outputCapture();
    expect(await runCli([
      "--profile", "general", "--non-interactive", "--yes"
    ], {
      cwd: root,
      ...initialized.dependencies
    }), initialized.stderr.join("")).toBe(0);
    const transactionNames = await readdir(stateLayout(root).transactions);
    const initJournal = JSON.parse(await readFile(join(
      stateLayout(root).transactions,
      transactionNames[0] ?? "",
      "journal.json"
    ), "utf8"));
    const installed = JSON.parse(await readFile(join(
      root,
      ".harness",
      "state",
      "local",
      "installed-harness-bundle.json"
    ), "utf8"));
    await writeFile(join(root, "one.md"), "before");
    await expect(runTransaction(root, [
      { operation: "modify", path: "one.md", content: "after" },
      { operation: "add", path: "two.md", content: "new" }
    ], {
      id: "tx_cli_resume",
      kind: "update",
      interruptAfterApply: 1,
      recoveryStore: {
        root: recoveryRoot,
        managedPaths: ["one.md", "two.md"]
      },
      projectIdentity: initJournal.project_identity,
      cliVersion: initJournal.cli_version,
      targetBundleVersion: installed.manifests
        .map((item: { bundle_version: string }) => item.bundle_version)
        .sort()
        .join("+"),
      ownershipManifestHash: sha256Bytes(canonicalJson(installed.manifests))
    })).rejects.toThrow(/interrupted/i);

    const output = outputCapture();
    expect(await runCli([
      "resume",
      "tx_cli_resume",
      "--non-interactive",
      "--yes",
      "--recovery-root",
      recoveryRoot,
      "--json"
    ], {
      cwd: root,
      ...output.dependencies
    })).toBe(0);
    expect(JSON.parse(output.stdout.join(""))).toMatchObject({
      status: "COMMITTED",
      recoveryId: "tx_cli_resume",
      mutationState: "COMMITTED"
    });
    expect(await readFile(join(root, "one.md"), "utf8")).toBe("after");
    expect(await readFile(join(root, "two.md"), "utf8")).toBe("new");
  });

  it("resumes an init transaction before project and installed state exist", async () => {
    const source = await mkdtemp(join(tmpdir(), "hunter-early-init-source-"));
    const root = await mkdtemp(join(tmpdir(), "hunter-early-init-target-"));
    const initialized = outputCapture();
    expect(await runCli([
      "--profile", "general", "--non-interactive", "--yes"
    ], {
      cwd: source,
      ...initialized.dependencies
    }), initialized.stderr.join("")).toBe(0);
    const sourceTransaction = (await readdir(stateLayout(source).transactions))[0];
    const sourceJournal = JSON.parse(await readFile(join(
      stateLayout(source).transactions,
      sourceTransaction ?? "",
      "journal.json"
    ), "utf8"));
    const projectConfig = await readFile(join(
      source,
      ".harness",
      "project.yaml"
    ));
    const installedState = await readFile(join(
      source,
      ".harness",
      "state",
      "local",
      "installed-harness-bundle.json"
    ));
    await expect(runTransaction(root, [
      {
        operation: "add",
        path: ".harness/project.yaml",
        content: projectConfig
      },
      {
        operation: "add",
        path: ".harness/state/local/installed-harness-bundle.json",
        content: installedState
      }
    ], {
      id: "tx_early_init",
      kind: "init",
      projectIdentity: sourceJournal.project_identity,
      cliVersion: sourceJournal.cli_version,
      targetBundleVersion: sourceJournal.target_bundle_version,
      ownershipManifestHash: sourceJournal.ownership_manifest_hash,
      pauseBeforeApply: async () => {
        throw new Error("injected stop before first apply");
      }
    })).rejects.toThrow(/injected stop/i);

    const status = outputCapture();
    expect(await runCli(["status", "--json"], {
      cwd: root,
      ...status.dependencies
    })).toBe(0);
    expect(JSON.parse(status.stdout.join(""))).toMatchObject({
      status: "RECOVERY_REQUIRED",
      recoveryId: "tx_early_init",
      safeActions: expect.arrayContaining(["resume", "rollback"])
    });

    const output = outputCapture();
    expect(await runCli([
      "resume",
      "tx_early_init",
      "--non-interactive",
      "--yes",
      "--json"
    ], {
      cwd: root,
      ...output.dependencies
    }), output.stdout.join("")).toBe(0);
    expect(JSON.parse(output.stdout.join(""))).toMatchObject({
      status: "COMMITTED",
      recoveryId: "tx_early_init"
    });
    expect(JSON.parse(await readFile(join(
      root,
      ".harness",
      "state",
      "local",
      "installed-harness-bundle.json"
    ), "utf8"))).toMatchObject({ schema_version: 4 });
  });

  it("resumes a profile transition before target installed state is applied", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-transition-resume-"));
    const initialized = outputCapture();
    expect(await runCli([
      "--profile", "general", "--non-interactive", "--yes"
    ], {
      cwd: root,
      ...initialized.dependencies
    }), initialized.stderr.join("")).toBe(0);
    const initTransaction = (await readdir(stateLayout(root).transactions))[0];
    const initJournal = JSON.parse(await readFile(join(
      stateLayout(root).transactions,
      initTransaction ?? "",
      "journal.json"
    ), "utf8"));
    const installedPath = join(
      root,
      ".harness",
      "state",
      "local",
      "installed-harness-bundle.json"
    );
    const projectPath = join(root, ".harness", "project.yaml");
    const currentProject = await readFile(projectPath, "utf8");
    const targetProject = currentProject.replace(
      /(^|\r?\n)(\s*)- general(\r?\n|$)/,
      "$1$2- java$3"
    );
    expect(targetProject).not.toBe(currentProject);
    const installed = JSON.parse(await readFile(installedPath, "utf8")) as {
      adapters: string[];
      manifests: Array<{ adapter: string }>;
      profiles: Record<string, string>;
      [key: string]: unknown;
    };
    const targetManifests = [];
    for (const item of installed.manifests) {
      const bundle = await loadAgentBundle(
        resourcesRoot,
        "java",
        item.adapter as "claude-code" | "codex" | "cursor" | "codebuddy"
      );
      targetManifests.push({
        adapter: item.adapter,
        profile: "java",
        bundle_version: bundle.manifest.bundle_version,
        bundle_manifest_hash: sha256Bytes(canonicalJson(bundle.manifest.files))
      });
    }
    targetManifests.sort((left, right) =>
      left.adapter.localeCompare(right.adapter)
    );
    const targetInstalled = {
      ...installed,
      profiles: Object.fromEntries(
        installed.adapters.map((adapter) => [adapter, "java"])
      ),
      manifests: targetManifests
    };
    await expect(runTransaction(root, [
      {
        operation: "add",
        path: "transition-marker.md",
        content: "applied\n"
      },
      {
        operation: "modify",
        path: ".harness/project.yaml",
        content: targetProject
      },
      {
        operation: "modify",
        path: ".harness/state/local/installed-harness-bundle.json",
        content: JSON.stringify(targetInstalled, null, 2) + "\n"
      }
    ], {
      id: "tx_profile_transition",
      kind: "refresh",
      interruptAfterApply: 1,
      projectIdentity: initJournal.project_identity,
      cliVersion: initJournal.cli_version,
      targetBundleVersion: targetManifests
        .map((item) => item.bundle_version)
        .sort()
        .join("+"),
      ownershipManifestHash: sha256Bytes(canonicalJson(targetManifests))
    })).rejects.toThrow(/interrupted/i);

    const output = outputCapture();
    expect(await runCli([
      "resume",
      "tx_profile_transition",
      "--non-interactive",
      "--yes",
      "--json"
    ], {
      cwd: root,
      ...output.dependencies
    }), output.stdout.join("")).toBe(0);
    expect(JSON.parse(output.stdout.join(""))).toMatchObject({
      status: "COMMITTED",
      recoveryId: "tx_profile_transition"
    });
    expect(JSON.parse(await readFile(installedPath, "utf8")))
      .toMatchObject({
        profiles: Object.fromEntries(
          installed.adapters.map((adapter) => [adapter, "java"])
        )
      });
  });

  it("blocks early-init resume when staged project identity drifts", async () => {
    const source = await mkdtemp(join(tmpdir(), "hunter-identity-source-"));
    const root = await mkdtemp(join(tmpdir(), "hunter-identity-target-"));
    const initialized = outputCapture();
    expect(await runCli([
      "--profile", "general", "--non-interactive", "--yes"
    ], {
      cwd: source,
      ...initialized.dependencies
    }), initialized.stderr.join("")).toBe(0);
    const sourceTransaction = (await readdir(stateLayout(source).transactions))[0];
    const sourceJournal = JSON.parse(await readFile(join(
      stateLayout(source).transactions,
      sourceTransaction ?? "",
      "journal.json"
    ), "utf8"));
    const sourceProject = await readFile(join(
      source,
      ".harness",
      "project.yaml"
    ), "utf8");
    const mismatchedProject = sourceProject.replace(
      sourceJournal.project_identity,
      "01900000-0000-7000-8000-000000000001"
    );
    expect(mismatchedProject).not.toBe(sourceProject);
    const installedState = await readFile(join(
      source,
      ".harness",
      "state",
      "local",
      "installed-harness-bundle.json"
    ));
    await expect(runTransaction(root, [
      {
        operation: "add",
        path: ".harness/project.yaml",
        content: mismatchedProject
      },
      {
        operation: "add",
        path: ".harness/state/local/installed-harness-bundle.json",
        content: installedState
      }
    ], {
      id: "tx_project_identity_drift",
      kind: "init",
      projectIdentity: sourceJournal.project_identity,
      cliVersion: sourceJournal.cli_version,
      targetBundleVersion: sourceJournal.target_bundle_version,
      ownershipManifestHash: sourceJournal.ownership_manifest_hash,
      pauseBeforeApply: async () => {
        throw new Error("injected target identity drift");
      }
    })).rejects.toThrow(/identity drift/i);

    const status = outputCapture();
    expect(await runCli(["status", "--json"], {
      cwd: root,
      ...status.dependencies
    })).toBe(0);
    expect(JSON.parse(status.stdout.join("")).safeActions)
      .not.toContain("resume");

    const output = outputCapture();
    expect(await runCli([
      "resume",
      "tx_project_identity_drift",
      "--non-interactive",
      "--yes",
      "--json"
    ], {
      cwd: root,
      ...output.dependencies
    })).toBe(5);
    await expect(readFile(join(root, ".harness", "project.yaml")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks resume when staged ownership metadata is inconsistent", async () => {
    const source = await mkdtemp(join(tmpdir(), "hunter-ownership-source-"));
    const root = await mkdtemp(join(tmpdir(), "hunter-ownership-target-"));
    const initialized = outputCapture();
    expect(await runCli([
      "--profile", "general", "--non-interactive", "--yes"
    ], {
      cwd: source,
      ...initialized.dependencies
    }), initialized.stderr.join("")).toBe(0);
    const sourceTransaction = (await readdir(stateLayout(source).transactions))[0];
    const sourceJournal = JSON.parse(await readFile(join(
      stateLayout(source).transactions,
      sourceTransaction ?? "",
      "journal.json"
    ), "utf8"));
    const projectConfig = await readFile(join(
      source,
      ".harness",
      "project.yaml"
    ));
    const installed = JSON.parse(await readFile(join(
      source,
      ".harness",
      "state",
      "local",
      "installed-harness-bundle.json"
    ), "utf8")) as {
      adapters: string[];
      profiles: Record<string, string>;
      manifests: Array<{
        adapter: string;
        profile: string;
        bundle_version: string;
        bundle_manifest_hash: string;
      }>;
      [key: string]: unknown;
    };
    const firstAdapter = installed.adapters[0] ?? "";
    const inconsistentInstalled = {
      ...installed,
      profiles: {
        ...installed.profiles,
        [firstAdapter]: "java"
      },
      manifests: installed.manifests.map((manifest, index) => index === 0
        ? {
          ...manifest,
          bundle_manifest_hash: `sha256:${"0".repeat(64)}`
        }
        : manifest)
    };
    await expect(runTransaction(root, [
      {
        operation: "add",
        path: ".harness/project.yaml",
        content: projectConfig
      },
      {
        operation: "add",
        path: ".harness/state/local/installed-harness-bundle.json",
        content: JSON.stringify(inconsistentInstalled, null, 2) + "\n"
      }
    ], {
      id: "tx_ownership_metadata_drift",
      kind: "init",
      projectIdentity: sourceJournal.project_identity,
      cliVersion: sourceJournal.cli_version,
      targetBundleVersion: sourceJournal.target_bundle_version,
      ownershipManifestHash: sourceJournal.ownership_manifest_hash,
      pauseBeforeApply: async () => {
        throw new Error("injected ownership metadata drift");
      }
    })).rejects.toThrow(/metadata drift/i);

    const status = outputCapture();
    expect(await runCli(["status", "--json"], {
      cwd: root,
      ...status.dependencies
    })).toBe(0);
    expect(JSON.parse(status.stdout.join("")).safeActions)
      .not.toContain("resume");

    const output = outputCapture();
    expect(await runCli([
      "resume",
      "tx_ownership_metadata_drift",
      "--non-interactive",
      "--yes",
      "--json"
    ], {
      cwd: root,
      ...output.dependencies
    })).toBe(5);
    await expect(readFile(join(root, ".harness", "project.yaml")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not advertise resume when staged Bundle metadata differs from local resources", async () => {
    const source = await mkdtemp(join(tmpdir(), "hunter-bundle-drift-source-"));
    const root = await mkdtemp(join(tmpdir(), "hunter-bundle-drift-target-"));
    const initialized = outputCapture();
    expect(await runCli([
      "--profile", "general", "--non-interactive", "--yes"
    ], {
      cwd: source,
      ...initialized.dependencies
    }), initialized.stderr.join("")).toBe(0);
    const sourceTransaction = (await readdir(stateLayout(source).transactions))[0];
    const sourceJournal = JSON.parse(await readFile(join(
      stateLayout(source).transactions,
      sourceTransaction ?? "",
      "journal.json"
    ), "utf8"));
    const projectConfig = await readFile(join(
      source,
      ".harness",
      "project.yaml"
    ));
    const installed = JSON.parse(await readFile(join(
      source,
      ".harness",
      "state",
      "local",
      "installed-harness-bundle.json"
    ), "utf8")) as {
      manifests: Array<{
        adapter: string;
        profile: string;
        bundle_version: string;
        bundle_manifest_hash: string;
      }>;
      [key: string]: unknown;
    };
    const mismatchedInstalled = {
      ...installed,
      manifests: installed.manifests.map((manifest, index) => index === 0
        ? {
          ...manifest,
          bundle_manifest_hash: `sha256:${"0".repeat(64)}`
        }
        : manifest)
    };
    await expect(runTransaction(root, [
      {
        operation: "add",
        path: ".harness/project.yaml",
        content: projectConfig
      },
      {
        operation: "add",
        path: ".harness/state/local/installed-harness-bundle.json",
        content: JSON.stringify(mismatchedInstalled, null, 2) + "\n"
      }
    ], {
      id: "tx_bundle_resource_drift",
      kind: "init",
      projectIdentity: sourceJournal.project_identity,
      cliVersion: sourceJournal.cli_version,
      targetBundleVersion: sourceJournal.target_bundle_version,
      ownershipManifestHash: sourceJournal.ownership_manifest_hash,
      pauseBeforeApply: async () => {
        throw new Error("injected Bundle resource drift");
      }
    })).rejects.toThrow(/resource drift/i);

    const status = outputCapture();
    expect(await runCli(["status", "--json"], {
      cwd: root,
      ...status.dependencies
    })).toBe(0);
    const statusResult = JSON.parse(status.stdout.join(""));
    expect(statusResult.safeActions).not.toContain("resume");
    expect(statusResult.resumeCommand).toBeNull();

    const inspect = outputCapture();
    expect(await runCli([
      "recover",
      "tx_bundle_resource_drift",
      "--action",
      "inspect",
      "--json"
    ], {
      cwd: root,
      ...inspect.dependencies
    })).toBe(0);
    const inspectResult = JSON.parse(inspect.stdout.join(""));
    expect(inspectResult.safeActions).not.toContain("resume");
    expect(inspectResult.resumeCommand).toBeNull();

    const output = outputCapture();
    expect(await runCli([
      "resume",
      "tx_bundle_resource_drift",
      "--non-interactive",
      "--yes",
      "--json"
    ], {
      cwd: root,
      ...output.dependencies
    })).toBe(5);
    await expect(readFile(join(root, ".harness", "project.yaml")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("status finds a durable recovery after project-local state is removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-cli-durable-"));
    const recoveryRoot = await mkdtemp(join(tmpdir(), "hunter-cli-recovery-"));
    await expect(runTransaction(root, [
      { operation: "add", path: "one.md", content: "one" },
      { operation: "add", path: "two.md", content: "two" }
    ], {
      id: "tx_cli_durable",
      kind: "update",
      interruptAfterApply: 1,
      recoveryStore: {
        root: recoveryRoot,
        managedPaths: ["one.md", "two.md"]
      },
      projectIdentity: "sha256:cli-project",
      cliVersion: "0.2.44",
      targetBundleVersion: "0.2.45",
      ownershipManifestHash: "sha256:ownership"
    })).rejects.toThrow(/interrupted/i);
    await rm(join(root, ".harness"), { recursive: true, force: true });

    const output = outputCapture();
    expect(await runCli([
      "status",
      "--recovery-root",
      recoveryRoot,
      "--json"
    ], {
      cwd: root,
      ...output.dependencies
    })).toBe(0);
    expect(JSON.parse(output.stdout.join(""))).toMatchObject({
      status: "RECOVERY_REQUIRED",
      pending: [{
        recoveryId: "tx_cli_durable",
        mutationState: "APPLIED_PARTIAL"
      }]
    });

    const bare = outputCapture();
    expect(await runCli([
      "--non-interactive",
      "--yes",
      "--recovery-root",
      recoveryRoot,
      "--json"
    ], {
      cwd: root,
      ...bare.dependencies
    })).toBe(5);
    expect(JSON.parse(bare.stdout.join(""))).toMatchObject({
      status: "RECOVERY_REQUIRED",
      reasonCode: "RECOVERY_ACTION_REQUIRED",
      recoveryId: "tx_cli_durable"
    });
    await expect(readFile(join(root, ".harness", "project.yaml")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("diagnose returns secret-safe metadata only", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-cli-diagnose-"));
    await expect(runTransaction(root, [
      { operation: "add", path: "one.md", content: "one" },
      { operation: "add", path: "two.md", content: "two" }
    ], {
      id: "tx_cli_diagnose",
      kind: "update",
      interruptAfterApply: 1,
      projectIdentity: "sha256:cli-project",
      cliVersion: "0.2.44",
      targetBundleVersion: "0.2.45",
      ownershipManifestHash: "sha256:ownership"
    })).rejects.toThrow(/interrupted/i);
    const journalPath = join(
      stateLayout(root).transactions,
      "tx_cli_diagnose",
      "journal.json"
    );
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    const sensitive = "Authorization: Bearer cli-diagnose-token-1234567890";
    journal.failure = sensitive;
    await writeFile(journalPath, JSON.stringify(journal));

    const output = outputCapture();
    expect(await runCli([
      "recover",
      "tx_cli_diagnose",
      "--action",
      "diagnose",
      "--json"
    ], {
      cwd: root,
      ...output.dependencies
    })).toBe(0);
    const raw = output.stdout.join("");
    expect(JSON.parse(raw)).toMatchObject({
      diagnosis: {
        recoveryId: "tx_cli_diagnose",
        scanPassed: true
      }
    });
    expect(raw).not.toContain(sensitive);
    expect(raw).not.toContain(root);
  });

  it("returns one stable JSON document when rollback preconditions fail", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-cli-rollback-blocked-"));
    await writeFile(join(root, "one.md"), "before");
    await expect(runTransaction(root, [
      { operation: "modify", path: "one.md", content: "after" },
      { operation: "add", path: "two.md", content: "pending" }
    ], {
      id: "tx_cli_rollback_blocked",
      kind: "update",
      interruptAfterApply: 1,
      projectIdentity: "sha256:cli-project",
      cliVersion: "0.2.44",
      targetBundleVersion: "0.2.45",
      ownershipManifestHash: "sha256:ownership"
    })).rejects.toThrow(/interrupted/i);
    const transactionRoot = join(
      stateLayout(root).transactions,
      "tx_cli_rollback_blocked"
    );
    const journal = JSON.parse(await readFile(
      join(transactionRoot, "journal.json"),
      "utf8"
    ));
    const snapshotName = journal.snapshots.find(
      (item: { path: string }) => item.path === "one.md"
    ).snapshot_name;
    await writeFile(join(transactionRoot, "before", snapshotName), "corrupt");

    const output = outputCapture();
    expect(await runCli([
      "recover",
      "tx_cli_rollback_blocked",
      "--action",
      "rollback",
      "--non-interactive",
      "--yes",
      "--json"
    ], {
      cwd: root,
      ...output.dependencies
    })).toBe(5);
    expect(output.stdout).toHaveLength(1);
    expect(JSON.parse(output.stdout[0] ?? "")).toMatchObject({
      status: "BLOCKED",
      reasonCode: "RECOVERY_PRECONDITION_FAILED",
      recoveryId: "tx_cli_rollback_blocked"
    });
    expect(await readFile(join(root, "one.md"), "utf8")).toBe("after");
  });

  it("derives status actions from legacy recovery capabilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-cli-legacy-status-"));
    const transactionRoot = join(
      stateLayout(root).transactions,
      "tx_cli_legacy"
    );
    await mkdir(join(transactionRoot, "before"), { recursive: true });
    await writeFile(join(transactionRoot, "journal.json"), JSON.stringify({
      schema_version: 2,
      transaction_id: "tx_cli_legacy",
      state: "interrupted",
      created_at: new Date().toISOString(),
      operations: [],
      snapshots: [],
      applied_count: 0,
      failure: "legacy"
    }));
    const output = outputCapture();

    expect(await runCli(["status", "--json"], {
      cwd: root,
      ...output.dependencies
    })).toBe(0);
    const parsed = JSON.parse(output.stdout.join(""));
    expect(parsed.safeActions).not.toContain("resume");
    expect(parsed.resumeCommand).toBeNull();
  });

  it("returns stable JSON for an invalid recovery id", async () => {
    const root = await mkdtemp(join(tmpdir(), "hunter-cli-invalid-recovery-"));
    const output = outputCapture();

    expect(await runCli([
      "recover",
      "../escape",
      "--action",
      "inspect",
      "--json"
    ], {
      cwd: root,
      ...output.dependencies
    })).toBe(3);
    expect(output.stdout).toHaveLength(1);
    expect(JSON.parse(output.stdout[0] ?? "")).toMatchObject({
      status: "BLOCKED",
      reasonCode: "RECOVERY_ID_INVALID",
      recoveryId: "../escape"
    });
  });
});
