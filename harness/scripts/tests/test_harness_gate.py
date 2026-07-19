#!/usr/bin/env python3
"""Regression tests for harness_gate.py (API-012, UT-026)."""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = SCRIPTS_DIR.parents[1]


def load_module(name: str, filename: str):
    path = SCRIPTS_DIR / filename
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


gate = load_module("harness_gate", "harness_gate.py")
change = load_module("harness_change_for_gate", "harness_change.py")
policy = load_module("harness_workflow_policy", "harness_workflow_policy.py")


class HarnessGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.project = Path(tempfile.mkdtemp(prefix="harness-gate-project-"))
        self.change_dir = self.project / ".harness" / "changes" / "demo"
        self.change_dir.mkdir(parents=True)
        self._write_checkpoints("pending")
        policy_target = self.project / "harness" / "contracts" / "workflow-policy.json"
        policy_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO_ROOT / "harness" / "contracts" / "workflow-policy.json", policy_target)
        subprocess.run(["git", "init"], cwd=self.project, check=True, capture_output=True)
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=self.project,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Test"],
            cwd=self.project,
            check=True,
            capture_output=True,
        )
        (self.project / "README.md").write_text("demo\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=self.project, check=True, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "init"],
            cwd=self.project,
            check=True,
            capture_output=True,
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.project, ignore_errors=True)

    def _write_checkpoints(self, status: str) -> None:
        payload = {
            "schemaVersion": 1,
            "changeName": "demo",
            "checkpoints": [
                {
                    "id": "foundation-gate",
                    "afterTasks": [1, 2, 3, 4],
                    "beforeTasks": [6, 7, 8, 9, 10],
                    "status": status,
                    "blocking": True,
                    "reviewerTool": "codex",
                    "requiredReport": "reports/review/foundation-gate-review.md",
                }
            ],
        }
        path = self.change_dir / "meta" / "implementation-checkpoints.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    def _handwritten_ledger(self) -> None:
        ledger = {
            "changeName": "demo",
            "validations": {
                "compile": {
                    "status": "OK",
                    "command": "mvn -q -DskipTests compile",
                    "evidence": "evidence/compile.log",
                    "inputsHash": "sha256:" + "a" * 64,
                    "inputsFiles": ["pom.xml"],
                },
                "unitTest": {
                    "status": "OK",
                    "command": "mvn -q test",
                    "evidence": "evidence/unit.log",
                    "inputsHash": "sha256:" + "b" * 64,
                    "inputsFiles": ["src/main/App.java"],
                    "scope": "AppTest",
                },
            },
        }
        path = self.change_dir / "evidence" / "verification-ledger.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(ledger, indent=2) + "\n", encoding="utf-8")

    def test_foundation_gate_blocks_task_6_api012(self) -> None:
        blocked = gate.foundation_gate_blocks(6, self.change_dir)
        self.assertIsNotNone(blocked)
        assert blocked is not None
        self.assertEqual(blocked["code"], "FOUNDATION_GATE_PENDING")
        self.assertEqual(blocked["checkpointStatus"], "pending")

    def test_foundation_gate_allows_task_6_when_approved(self) -> None:
        self._write_checkpoints("approved")
        self.assertIsNone(gate.foundation_gate_blocks(6, self.change_dir))

    def test_validate_ledger_for_phase_close_rejects_handwritten_ut026(self) -> None:
        self._handwritten_ledger()
        workflow = policy.load_policy(REPO_ROOT)
        result = gate.validate_ledger_for_phase_close(self.change_dir, "run", workflow)
        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "MISSING_V2_FIELDS")
        self.assertIn("natural-language override", result["detail"])

    def test_split_contract_rejects_stale_ledger_identity(self) -> None:
        context = {
            "schemaVersion": 2,
            "changeId": "demo",
            "stateOwnership": {
                "contractRoot": ".harness/changes/demo",
                "runtimeRoot": ".harness/state/changes/demo",
            },
            "ownership": {
                "productPaths": ["README.md"],
                "staticEvidencePaths": [".harness/changes/demo/"],
            },
        }
        (self.change_dir / "meta" / "change-context.json").write_text(
            json.dumps(context) + "\n", encoding="utf-8"
        )
        head = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.project, check=True,
            capture_output=True, text=True, encoding="utf-8",
        ).stdout.strip()
        ledger = {
            "schemaVersion": 3,
            "repositoryId": gate.hp.repository_identity(self.project),
            "changeName": "demo",
            "baseCommit": head,
            "currentHead": head,
            "diffHash": gate.hl.compute_ownership_diff(
                self.project, base=head, change_dir=self.change_dir
            )["diffHash"],
            "ownershipHash": gate.hl.ownership_hash(context),
            "validations": {
                "compile": self._v2_entry(command="python -m compileall"),
                "unitTest": self._v2_entry(),
            },
        }
        ledger_path = (
            self.project / ".harness" / "state" / "changes" / "demo"
            / "evidence" / "verification-ledger.json"
        )
        ledger_path.parent.mkdir(parents=True)
        ledger_path.write_text(json.dumps(ledger) + "\n", encoding="utf-8")
        (self.project / "README.md").write_text("changed after verification\n", encoding="utf-8")

        result = gate.validate_ledger_for_phase_close(
            self.change_dir, "run", policy.load_policy(REPO_ROOT),
            execution_root=self.project,
        )

        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "LEDGER_IDENTITY_MISMATCH")
        self.assertNotEqual(result["storedDiffHash"], result["currentDiffHash"])

    def test_begin_blocks_task_6_while_checkpoint_pending(self) -> None:
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project):
            with mock.patch.object(
                gate.hc,
                "resolve_change",
                return_value={
                    "ok": True,
                    "changeId": "demo",
                    "changeDir": str(self.change_dir),
                },
            ):
                args = gate.build_parser().parse_args(
                    [
                        "begin",
                        "--phase",
                        "plan",
                        "--change",
                        "demo",
                        "--task",
                        "6",
                        "--json",
                    ]
                )
                code = gate.cmd_begin(args)
                self.assertEqual(code, 1)

    def test_close_rejects_wrong_owner_before_mutating_test_guard(self) -> None:
        self._write_checkpoints("approved")
        args = gate.build_parser().parse_args(
            [
                "close", "--phase", "test", "--change", "demo",
                "--status", "OK", "--run-id", "wrong-owner", "--task", "10",
                "--json",
            ]
        )
        holder = {"runId": "real-owner", "phase": "test"}
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value={
                 "ok": True, "changeId": "demo", "changeDir": str(self.change_dir)
             }), \
             mock.patch.object(gate.hc, "inspect_lease", return_value=holder), \
             mock.patch.object(gate, "validate_ledger_for_phase_close", return_value={"ok": True}), \
             mock.patch.object(gate.htg, "close", return_value={"ok": True}) as close_guard:
            self.assertEqual(gate.cmd_close(args), 1)
        close_guard.assert_not_called()

    def test_begin_requires_task_number_while_foundation_is_pending(self) -> None:
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project):
            args = gate.build_parser().parse_args(
                ["begin", "--phase", "run", "--change", "demo", "--json"]
            )
            self.assertEqual(gate.cmd_begin(args), 1)

    def test_checkpoint_approve_requires_existing_report_and_expected_reviewer(self) -> None:
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project):
            missing = gate.build_parser().parse_args([
                "checkpoint", "approve", "--id", "foundation-gate",
                "--change", "demo", "--reviewer", "codex", "--json",
            ])
            self.assertEqual(gate.cmd_checkpoint(missing), 1)

            report = self.change_dir / "reports" / "review" / "foundation-gate-review.md"
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text("# reviewed\n\nfoundation-gate: approved\n", encoding="utf-8")
            wrong = gate.build_parser().parse_args([
                "checkpoint", "approve", "--id", "foundation-gate",
                "--change", "demo", "--reviewer", "claude-code", "--json",
            ])
            self.assertEqual(gate.cmd_checkpoint(wrong), 1)
            self.assertEqual(gate.checkpoint_status(gate.load_checkpoints(self.change_dir), "foundation-gate"), "pending")

            approved = gate.build_parser().parse_args([
                "checkpoint", "approve", "--id", "foundation-gate",
                "--change", "demo", "--reviewer", "codex", "--json",
            ])
            self.assertEqual(gate.cmd_checkpoint(approved), 0)
            self.assertEqual(gate.checkpoint_status(gate.load_checkpoints(self.change_dir), "foundation-gate"), "approved")

    def test_checkpoint_approve_rejects_unknown_id(self) -> None:
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project):
            args = gate.build_parser().parse_args([
                "checkpoint", "approve", "--id", "invented-gate",
                "--change", "demo", "--reviewer", "codex", "--json",
            ])
            self.assertEqual(gate.cmd_checkpoint(args), 1)

    def test_checkpoint_approve_reads_split_state_report(self) -> None:
        context_path = self.change_dir / "meta" / "change-context.json"
        context_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 2,
                    "changeId": "demo",
                    "stateOwnership": {
                        "contractRoot": ".harness/changes/demo",
                        "runtimeRoot": ".harness/state/changes/demo",
                    },
                }
            )
            + "\n",
            encoding="utf-8",
        )
        report = (
            self.project
            / ".harness"
            / "state"
            / "changes"
            / "demo"
            / "reports"
            / "review"
            / "foundation-gate-review.md"
        )
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text("foundation-gate: approved\n", encoding="utf-8")
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project):
            args = gate.build_parser().parse_args([
                "checkpoint", "approve", "--id", "foundation-gate",
                "--change", "demo", "--reviewer", "codex", "--json",
            ])
            self.assertEqual(gate.cmd_checkpoint(args), 0)
        self.assertEqual(
            gate.checkpoint_status(gate.load_checkpoints(self.change_dir), "foundation-gate"),
            "approved",
        )

    def test_begin_close_across_processes_reuses_run_id_and_writes_one_lifecycle(self) -> None:
        self._write_checkpoints("approved")
        skills_root = self.project / ".agents" / "skills"
        skills_root.mkdir(parents=True)
        (skills_root / ".harness-build.json").write_text(
            json.dumps({
                "schemaVersion": 1,
                "agent": "codex",
                "overlay": "none",
                "coreHash": "a" * 16,
            }) + "\n",
            encoding="utf-8",
        )
        context = {
            "schema_version": 2,
            "project": {"adapters": {"codex": {"skills_root": ".agents/skills"}}},
            "skill_bundles": {
                "codex": {"registry_version": "0.2.6", "bundle_hash": "sha256:" + "b" * 64}
            },
        }
        (self.project / ".harness" / "context-index.json").write_text(
            json.dumps(context) + "\n", encoding="utf-8"
        )
        build_hash = gate._sha256_file(skills_root / ".harness-build.json")
        installed = {
            "schema_version": 4,
            "profiles": {"codex": "general"},
            "manifests": [{
                "adapter": "codex", "profile": "general", "bundle_version": "0.2.6",
                "bundle_manifest_hash": "sha256:" + "b" * 64,
            }],
            "files": [{
                "owner": "codex", "target_path": ".agents/skills/.harness-build.json",
                "sha256": build_hash,
            }],
        }
        state = self.project / ".harness" / "state" / "local" / "installed-harness-bundle.json"
        state.parent.mkdir(parents=True, exist_ok=True)
        state.write_text(json.dumps(installed) + "\n", encoding="utf-8")

        common = [sys.executable, str(SCRIPTS_DIR / "harness_gate.py")]
        begin = subprocess.run(
            common + ["begin", "--phase", "review", "--change", "demo", "--task", "5",
                      "--skills-root", str(skills_root), "--executor-tool", "codex", "--json"],
            cwd=self.project, capture_output=True, text=True, encoding="utf-8", check=False,
        )
        self.assertEqual(begin.returncode, 0, begin.stderr)
        close = subprocess.run(
            common + ["close", "--phase", "review", "--change", "demo", "--task", "5",
                      "--status", "OK", "--json"],
            cwd=self.project, capture_output=True, text=True, encoding="utf-8", check=False,
        )
        self.assertEqual(close.returncode, 0, close.stderr)
        events = [json.loads(line) for line in (self.change_dir / "events.ndjson").read_text("utf-8").splitlines()]
        starts = [item for item in events if item["type"] == "phase.start"]
        ends = [item for item in events if item["type"] == "phase.end"]
        self.assertEqual(len(starts), 1)
        self.assertEqual(len(ends), 1)
        self.assertEqual(starts[0]["run_id"], ends[0]["run_id"])
        self.assertEqual(starts[0]["executor_tool"], "codex")
        self.assertFalse((self.project / ".harness" / "runtime" / "leases" / "demo.json").exists())
        (skills_root / ".harness-build.json").write_text(
            json.dumps({"schemaVersion": 1, "agent": "codex", "coreHash": "drifted"}) + "\n",
            encoding="utf-8",
        )
        with self.assertRaisesRegex(ValueError, "refresh required"):
            gate.validate_identity(self.project, skills_root, "codex")

    def test_policy_loader_rejects_unknown_fields(self) -> None:
        raw = json.loads((REPO_ROOT / "harness" / "contracts" / "workflow-policy.json").read_text("utf-8"))
        raw["unexpectedField"] = True
        with self.assertRaises(policy.PolicyValidationError):
            policy.validate_policy(raw)

    def test_post_run_risk_classification_only_upgrades(self) -> None:
        plans = self.change_dir / "plans"
        plans.mkdir(parents=True, exist_ok=True)
        (plans / "demo-plan.md").write_text("risk: fast\n", encoding="utf-8")
        initial = gate.classify_risk(self.change_dir, "plan")
        self.assertEqual(initial["tier"], "fast")

        source = self.project / "src" / "auth" / "token-service.ts"
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text("export const token = 'redacted';\n", encoding="utf-8")
        upgraded = gate.classify_risk(self.change_dir, "post-run")
        self.assertEqual(upgraded["tier"], "full")
        self.assertIn("auth", upgraded["signals"])
        persisted = json.loads(
            (self.change_dir / "meta" / "risk-classification.json").read_text("utf-8")
        )
        self.assertEqual(persisted["tier"], "full")
        self.assertIn("review", persisted["defaultPhases"])
        self.assertIn("apiTest", persisted["requiredValidations"])
        self.assertEqual(persisted["conditionalStages"], ["package", "apidoc"])
        self.assertTrue(persisted["stageDecisions"]["review"]["required"])
        self.assertFalse(persisted["stageDecisions"]["package"]["required"])
        self.assertFalse(persisted["stageDecisions"]["apidoc"]["required"])

    def test_post_run_docs_only_change_remains_fast(self) -> None:
        plans = self.change_dir / "plans"
        plans.mkdir(parents=True, exist_ok=True)
        (plans / "demo-plan.md").write_text("risk: fast\n", encoding="utf-8")
        (self.project / "notes.md").write_text("docs only\n", encoding="utf-8")
        result = gate.classify_risk(self.change_dir, "post-run")
        self.assertEqual(result["tier"], "fast")
        self.assertEqual(result["signals"], ["docs-only"])

    def test_risk_classification_uses_change_worktree_root(self) -> None:
        worktree = self.project / "feature-worktree"
        worktree.mkdir()
        meta = self.change_dir / "meta"
        meta.mkdir(exist_ok=True)
        (meta / "change-context.json").write_text(
            json.dumps({"worktreeRoot": str(worktree)}) + "\n", encoding="utf-8"
        )
        self.assertEqual(gate.change_code_root(self.change_dir), worktree.resolve())
        (meta / "change-context.json").write_text("{}\n", encoding="utf-8")
        (meta / "worktree.json").write_text(
            json.dumps({"worktreePath": str(worktree)}) + "\n", encoding="utf-8"
        )
        self.assertEqual(gate.change_code_root(self.change_dir), worktree.resolve())

    def test_lint_skills_flags_handwritten_ledger_pattern(self) -> None:
        skills_root = Path(tempfile.mkdtemp(prefix="skills-root-"))
        try:
            bad = skills_root / "harness-run" / "SKILL.md"
            bad.parent.mkdir(parents=True)
            bad.write_text("Do not Write verification-ledger.json by hand.\n", encoding="utf-8")
            payload = gate.lint_skill_tree(skills_root)
            self.assertFalse(payload["ok"])
            self.assertEqual(payload["code"], "SKILL_CONTRACT_VIOLATION")
        finally:
            shutil.rmtree(skills_root, ignore_errors=True)

    def test_canonical_skills_implement_policy_capabilities(self) -> None:
        payload = gate.lint_skill_tree(REPO_ROOT / "harness")
        self.assertTrue(payload["ok"], msg=json.dumps(payload, ensure_ascii=False, indent=2))

    def test_cli_help(self) -> None:
        proc = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "harness_gate.py"), "--help"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("checkpoint", proc.stdout)

    def _v2_entry(
        self,
        *,
        status: str = "OK",
        evidence: str = "evidence/unit.log",
        coverage: str = "module",
        command: str = "python -m unittest",
    ) -> dict:
        return {
            "algorithmVersion": "harness-ledger-2",
            "coverage": coverage,
            "inputsHash": "sha256:" + "c" * 64,
            "inputsFiles": ["harness/scripts/harness_gate.py"],
            "status": status,
            "command": command,
            "evidence": evidence,
        }

    def _write_v2_ledger(self, *, unit_status: str = "OK", unit_evidence: str = "evidence/unit.log") -> None:
        ledger = {
            "changeName": "demo",
            "validations": {
                "compile": self._v2_entry(
                    status="OK",
                    evidence="evidence/compile.log",
                    command="python -m compileall",
                ),
                "unitTest": self._v2_entry(status=unit_status, evidence=unit_evidence),
            },
        }
        path = self.change_dir / "evidence" / "verification-ledger.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(ledger, indent=2) + "\n", encoding="utf-8")

    # --- UT-301..305 foundation-gate missing scope ---

    def test_foundation_gate_missing_file_does_not_block_ut301(self) -> None:
        checkpoints = self.change_dir / "meta" / "implementation-checkpoints.json"
        checkpoints.unlink(missing_ok=True)
        self.assertIsNone(gate.foundation_gate_blocks(None, self.change_dir))
        self.assertIsNone(gate.foundation_gate_blocks(8, self.change_dir))

    def test_foundation_gate_missing_entry_does_not_block_ut302(self) -> None:
        path = self.change_dir / "meta" / "implementation-checkpoints.json"
        path.write_text(
            json.dumps({"schemaVersion": 1, "checkpoints": [{"id": "other", "status": "pending"}]}, indent=2)
            + "\n",
            encoding="utf-8",
        )
        self.assertIsNone(gate.foundation_gate_blocks(None, self.change_dir))

    def test_foundation_gate_pending_still_requires_task_ut303(self) -> None:
        blocked = gate.foundation_gate_blocks(None, self.change_dir)
        self.assertIsNotNone(blocked)
        assert blocked is not None
        self.assertEqual(blocked["code"], "TASK_NUMBER_REQUIRED")

    def test_begin_without_task_succeeds_when_checkpoints_missing_ut301(self) -> None:
        (self.change_dir / "meta" / "implementation-checkpoints.json").unlink(missing_ok=True)
        skills_root = self.project / ".agents" / "skills"
        skills_root.mkdir(parents=True)
        (skills_root / ".harness-build.json").write_text(
            json.dumps({"schemaVersion": 1, "agent": "codex", "overlay": "none", "coreHash": "a" * 16}) + "\n",
            encoding="utf-8",
        )
        context = {
            "schema_version": 2,
            "project": {"adapters": {"codex": {"skills_root": ".agents/skills"}}},
            "skill_bundles": {
                "codex": {"registry_version": "0.2.6", "bundle_hash": "sha256:" + "b" * 64}
            },
        }
        (self.project / ".harness" / "context-index.json").write_text(json.dumps(context) + "\n", encoding="utf-8")
        build_hash = gate._sha256_file(skills_root / ".harness-build.json")
        installed = {
            "schema_version": 4,
            "profiles": {"codex": "general"},
            "manifests": [{
                "adapter": "codex", "profile": "general", "bundle_version": "0.2.6",
                "bundle_manifest_hash": "sha256:" + "b" * 64,
            }],
            "files": [{
                "owner": "codex", "target_path": ".agents/skills/.harness-build.json",
                "sha256": build_hash,
            }],
        }
        state = self.project / ".harness" / "state" / "local" / "installed-harness-bundle.json"
        state.parent.mkdir(parents=True, exist_ok=True)
        state.write_text(json.dumps(installed) + "\n", encoding="utf-8")
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value={
                 "ok": True, "changeId": "demo", "changeDir": str(self.change_dir)
             }):
            args = gate.build_parser().parse_args([
                "begin", "--phase", "run", "--change", "demo",
                "--skills-root", str(skills_root), "--executor-tool", "codex", "--json",
            ])
            self.assertEqual(gate.cmd_begin(args), 0)

    def test_phase_capsule_persists_and_reuses_execution_root(self) -> None:
        self._write_checkpoints("approved")
        execution = self.project.parent / f"{self.project.name}-feature"
        subprocess.run(
            ["git", "worktree", "add", "-b", "feature/capsule", str(execution)],
            cwd=self.project, check=True, capture_output=True,
        )
        self.addCleanup(shutil.rmtree, execution, True)
        skills_root = self.project / ".agents" / "skills"
        skills_root.mkdir(parents=True)
        resolved = {"ok": True, "changeId": "demo", "changeDir": str(self.change_dir)}
        identity = {"adapter": "codex", "bundleHash": "sha256:" + "a" * 64}
        begin_args = gate.build_parser().parse_args([
            "begin", "--phase", "run", "--change", "demo", "--run-id", "capsule-run",
            "--project", str(execution), "--skills-root", str(skills_root), "--json",
        ])
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value=resolved), \
             mock.patch.object(gate.hc, "inspect_lease", return_value=None), \
             mock.patch.object(gate.hc, "claim_lease", return_value={"ok": True, "lease": {}}), \
             mock.patch.object(gate, "validate_identity", return_value=identity), \
             mock.patch.object(gate, "_phase_event_exists", return_value=False), \
             mock.patch.object(gate, "append_phase_event", return_value={"ok": True}), \
             mock.patch.object(gate.htg, "begin", return_value={"ok": True}) as guard_begin:
            self.assertEqual(gate.cmd_begin(begin_args), 0)
        guard_begin.assert_called_once_with(execution.resolve(), self.change_dir)

        capsule = gate.load_phase_capsule(self.change_dir, "run", "capsule-run")
        self.assertEqual(capsule["stateRoot"], str(self.change_dir.resolve()))
        self.assertEqual(capsule["executionRoot"], str(execution.resolve()))
        self.assertEqual(capsule["skillsRoot"], str(skills_root.resolve()))

        resume_args = gate.build_parser().parse_args([
            "begin", "--phase", "run", "--change", "demo", "--run-id", "capsule-run",
            "--skills-root", str(skills_root), "--json",
        ])
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value=resolved), \
             mock.patch.object(gate.hc, "inspect_lease", return_value={"runId": "capsule-run", "phase": "run"}), \
             mock.patch.object(gate.hc, "claim_lease", return_value={"ok": True, "lease": {}}), \
             mock.patch.object(gate, "validate_identity", return_value=identity), \
             mock.patch.object(gate, "_phase_event_exists", return_value=True), \
             mock.patch.object(gate.htg, "begin", return_value={"ok": True}) as resumed_guard:
            self.assertEqual(gate.cmd_begin(resume_args), 0)
        resumed_guard.assert_not_called()

        close_args = gate.build_parser().parse_args([
            "close", "--phase", "run", "--change", "demo", "--run-id", "capsule-run",
            "--status", "OK", "--json",
        ])
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value=resolved), \
             mock.patch.object(gate.hc, "inspect_lease", return_value={"runId": "capsule-run", "phase": "run"}), \
             mock.patch.object(gate.hc, "release_lease", return_value={"ok": True}), \
             mock.patch.object(gate, "validate_ledger_for_phase_close", return_value={"ok": True, "code": "LEDGER_OK"}), \
             mock.patch.object(gate, "_phase_event_exists", return_value=False), \
             mock.patch.object(gate, "append_phase_event", return_value={"ok": True}), \
             mock.patch.object(gate.htg, "close", return_value={"ok": True}) as guard_close:
            self.assertEqual(gate.cmd_close(close_args), 0)
        guard_close.assert_called_once_with(execution.resolve(), self.change_dir)

    def test_corrupt_phase_capsule_is_not_treated_as_absent(self) -> None:
        path = gate._phase_capsule_path(self.change_dir, "run", "corrupt-run")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{not-json\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            gate.load_phase_capsule(self.change_dir, "run", "corrupt-run")

    def test_phase_capsule_rejects_head_and_skills_root_drift(self) -> None:
        skills_root = (self.project / ".agents" / "skills").resolve()
        capsule = {
            "schemaVersion": 1,
            "changeId": "demo",
            "phase": "run",
            "runId": "identity-run",
            "projectRoot": str(self.project.resolve()),
            "stateRoot": str(self.change_dir.resolve()),
            "executionRoot": str(self.project.resolve()),
            "skillsRoot": str(skills_root),
            "repositoryId": gate.hp.repository_identity(self.project),
            "baseCommit": "0" * 40,
            "currentHead": "0" * 40,
        }
        with self.assertRaisesRegex(ValueError, "currentHead"):
            gate.validate_phase_capsule(
                capsule,
                change_dir=self.change_dir,
                change_id="demo",
                phase="run",
                run_id="identity-run",
                project=self.project,
                execution_root=self.project,
                skills_root=skills_root,
            )
        head = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.project, check=True,
            capture_output=True, text=True,
        ).stdout.strip()
        capsule["currentHead"] = head
        with self.assertRaisesRegex(ValueError, "skillsRoot"):
            gate.validate_phase_capsule(
                capsule,
                change_dir=self.change_dir,
                change_id="demo",
                phase="run",
                run_id="identity-run",
                project=self.project,
                execution_root=self.project,
                skills_root=self.project / ".different-skills",
            )

    def test_close_release_failure_persists_retryable_capsule(self) -> None:
        self._write_checkpoints("approved")
        head = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.project, check=True,
            capture_output=True, text=True,
        ).stdout.strip()
        capsule = {
            "schemaVersion": 1,
            "changeId": "demo",
            "phase": "run",
            "runId": "release-retry",
            "projectRoot": str(self.project.resolve()),
            "stateRoot": str(self.change_dir.resolve()),
            "executionRoot": str(self.project.resolve()),
            "skillsRoot": str((self.project / ".agents" / "skills").resolve()),
            "repositoryId": gate.hp.repository_identity(self.project),
            "baseCommit": head,
            "currentHead": head,
            "createdAt": gate.he.now_iso(),
        }
        gate.write_phase_capsule(self.change_dir, "run", "release-retry", capsule)
        args = gate.build_parser().parse_args([
            "close", "--phase", "run", "--change", "demo",
            "--run-id", "release-retry", "--status", "OK", "--json",
        ])
        resolved = {"ok": True, "changeId": "demo", "changeDir": str(self.change_dir)}
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value=resolved), \
             mock.patch.object(gate.hc, "inspect_lease", return_value={
                 "runId": "release-retry", "phase": "run"
             }), \
             mock.patch.object(gate.hc, "release_lease", return_value={
                 "ok": False, "code": "LEASE_IO_ERROR", "message": "busy"
             }), \
             mock.patch.object(gate, "validate_ledger_for_phase_close", return_value={
                 "ok": True, "code": "LEDGER_OK"
             }), \
             mock.patch.object(gate.htg, "close", return_value={"ok": True}), \
             mock.patch.object(gate, "_phase_event_exists", return_value=False), \
             mock.patch.object(gate, "append_phase_event", return_value={"ok": True}), \
             mock.patch("sys.stderr"):
            self.assertEqual(gate.cmd_close(args), 1)

        updated = gate.load_phase_capsule(
            self.change_dir, "run", "release-retry"
        )
        self.assertEqual(updated["closeTransaction"]["status"], "RELEASE_PENDING")
        self.assertTrue(updated["closeTransaction"]["guardClosed"])
        self.assertTrue(updated["closeTransaction"]["phaseEndRecorded"])
        self.assertTrue(updated["closeTransaction"]["retryable"])

    # --- UT-306..309 classify persistence / override ---

    def test_classify_persists_gate_policy_ut306(self) -> None:
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value={
                 "ok": True, "changeId": "demo", "changeDir": str(self.change_dir)
             }):
            args = gate.build_parser().parse_args(
                ["classify", "--change", "demo", "--stage", "plan", "--json"]
            )
            self.assertEqual(gate.cmd_classify(args), 0)
        policy_path = self.change_dir / "meta" / "gate-policy.json"
        self.assertTrue(policy_path.is_file())
        data = json.loads(policy_path.read_text(encoding="utf-8"))
        self.assertEqual(data["schemaVersion"], 1)
        self.assertIn(data["tier"], {"fast", "standard", "full"})
        self.assertIn("defaultPhases", data)
        self.assertIn("requiredValidations", data)
        self.assertIn("classifiedAt", data)
        self.assertIn("tierOverride", data)

    def test_capability_tags_build_required_gate_dag(self) -> None:
        spec_dir = self.change_dir / "spec"
        spec_dir.mkdir(parents=True, exist_ok=True)
        (spec_dir / "deployment-design.md").write_text(
            "---\n"
            "change-name: demo\n"
            "capabilities: [deployment, container, api, database]\n"
            "---\n"
            "# Deployment design\n",
            encoding="utf-8",
        )
        workflow = policy.load_policy(REPO_ROOT)

        payload = gate.classify_risk(self.change_dir, "plan", workflow=workflow)

        self.assertEqual(
            payload["capabilities"],
            ["api", "container", "database", "deployment"],
        )
        self.assertTrue({"package", "apiTest", "dbCompatibility"}.issubset(
            payload["requiredValidations"]
        ))
        self.assertTrue(payload["stageDecisions"]["package"]["required"])
        self.assertTrue(payload["stageDecisions"]["apidoc"]["required"])
        self.assertTrue({"stage:package", "stage:apidoc", "validation:apiTest",
                         "validation:dbCompatibility"}.issubset(
            {node["id"] for node in payload["requiredGateDag"]["nodes"]}
        ))

        persisted = gate.gate_policy_document(payload)
        self.assertEqual(persisted["capabilities"], payload["capabilities"])
        self.assertEqual(persisted["stageDecisions"], payload["stageDecisions"])
        self.assertEqual(persisted["requiredGateDag"], payload["requiredGateDag"])
        self.assertIn("dbCompatibility", persisted["requiredValidationsByPhase"]["test"])

    def test_close_uses_change_required_validations_by_phase(self) -> None:
        policy_path = self.change_dir / "meta" / "gate-policy.json"
        policy_path.parent.mkdir(parents=True, exist_ok=True)
        policy_path.write_text(json.dumps({
            "schemaVersion": 1,
            "requiredValidationsByPhase": {
                "test": ["unitTestFull", "apiTest", "dbCompatibility"]
            },
        }) + "\n", encoding="utf-8")
        args = gate.build_parser().parse_args([
            "close", "--phase", "test", "--change", "demo",
            "--run-id", "dag-close", "--status", "OK", "--task", "1", "--json",
        ])
        resolved = {"ok": True, "changeId": "demo", "changeDir": str(self.change_dir)}
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value=resolved), \
             mock.patch.object(gate.hc, "inspect_lease", return_value={
                 "runId": "dag-close", "phase": "test"
             }), \
             mock.patch.object(gate.hc, "release_lease", return_value={"ok": True}), \
             mock.patch.object(gate, "validate_ledger_for_phase_close", return_value={
                 "ok": True, "code": "LEDGER_OK"
             }) as validate, \
             mock.patch.object(gate, "_phase_event_exists", return_value=False), \
             mock.patch.object(gate, "append_phase_event", return_value={"ok": True}), \
             mock.patch.object(gate.htg, "close", return_value={"ok": True}):
            self.assertEqual(gate.cmd_close(args), 0)

        effective_policy = validate.call_args.args[2]
        self.assertEqual(
            effective_policy["requiredValidations"]["test"],
            ["unitTestFull", "apiTest", "dbCompatibility"],
        )

    def test_post_run_owned_diff_adds_gate_capabilities(self) -> None:
        changed = self.project / "deploy" / "Dockerfile"
        changed.parent.mkdir(parents=True, exist_ok=True)
        changed.write_text("FROM scratch\n", encoding="utf-8")
        migration = self.project / "db" / "migration" / "001.sql"
        migration.parent.mkdir(parents=True, exist_ok=True)
        migration.write_text("select 1;\n", encoding="utf-8")
        api = self.project / "src" / "api" / "controller.py"
        api.parent.mkdir(parents=True, exist_ok=True)
        api.write_text("# api\n", encoding="utf-8")

        payload = gate.classify_risk(
            self.change_dir, "post-run", workflow=policy.load_policy(REPO_ROOT)
        )

        self.assertTrue({"deployment", "container", "api", "database"}.issubset(
            payload["capabilities"]
        ))
        self.assertTrue(payload["stageDecisions"]["package"]["required"])
        self.assertTrue(payload["stageDecisions"]["apidoc"]["required"])

    def test_classify_missing_change_dir_ut307(self) -> None:
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value={
                 "ok": False, "code": "CHANGE_NOT_FOUND", "message": "change not found: no-such"
             }), \
             mock.patch("sys.stdout") as stdout:
            args = gate.build_parser().parse_args(
                ["classify", "--change", "no-such", "--stage", "plan", "--json"]
            )
            code = gate.cmd_classify(args)
        self.assertEqual(code, 0)
        written = "".join(call.args[0] for call in stdout.write.call_args_list if call.args)
        payload = json.loads(written)
        self.assertTrue(payload["ok"])
        self.assertFalse(payload.get("policyPersisted", True))
        self.assertIn("warning", payload)

    def test_classify_tier_override_ut308(self) -> None:
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value={
                 "ok": True, "changeId": "demo", "changeDir": str(self.change_dir)
             }), \
             mock.patch("sys.stdout") as stdout:
            args = gate.build_parser().parse_args([
                "classify", "--change", "demo", "--stage", "plan",
                "--tier-override", "standard", "--override-by", "user", "--json",
            ])
            self.assertEqual(gate.cmd_classify(args), 0)
        written = "".join(call.args[0] for call in stdout.write.call_args_list if call.args)
        payload = json.loads(written)
        self.assertEqual(payload["tier"], "standard")
        self.assertEqual(payload["source"], "override")
        self.assertEqual(payload["tierOverride"]["tier"], "standard")
        self.assertEqual(payload["tierOverride"]["by"], "user")
        self.assertIn("at", payload["tierOverride"])
        workflow = policy.load_policy(REPO_ROOT)
        self.assertEqual(
            payload["requiredValidations"],
            workflow["riskTiers"]["standard"]["requiredValidations"],
        )
        persisted = json.loads((self.change_dir / "meta" / "gate-policy.json").read_text("utf-8"))
        self.assertEqual(persisted["tier"], "standard")
        self.assertEqual(persisted["source"], "override")
        self.assertEqual(persisted["tierOverride"]["tier"], "standard")

    def test_classify_invalid_tier_override_ut309(self) -> None:
        with self.assertRaises(SystemExit) as ctx:
            gate.build_parser().parse_args([
                "classify", "--change", "demo", "--stage", "plan",
                "--tier-override", "extreme",
            ])
        self.assertNotEqual(ctx.exception.code, 0)

    # --- UT-310..314 DEGRADED ledger close ---

    def test_degraded_ledger_close_ut310(self) -> None:
        # setUp leaves foundation-gate pending; --task 1 is allowed without approve.
        self._write_v2_ledger(
            unit_status="NOT_RUN",
            unit_evidence="DEGRADED: sdk 无测试基础设施，已静态验证",
        )
        workflow = policy.load_policy(REPO_ROOT)
        result = gate.validate_ledger_for_phase_close(self.change_dir, "run", workflow)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], "LEDGER_OK_DEGRADED")
        self.assertIn("unitTest", result["degraded"])

        args = gate.build_parser().parse_args([
            "close", "--phase", "run", "--change", "demo",
            "--status", "OK", "--run-id", "run-deg", "--task", "1", "--json",
        ])
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value={
                 "ok": True, "changeId": "demo", "changeDir": str(self.change_dir)
             }), \
             mock.patch.object(gate.hc, "inspect_lease", return_value={"runId": "run-deg", "phase": "run"}), \
             mock.patch.object(gate.hc, "release_lease", return_value={"ok": True}), \
             mock.patch.object(gate.htg, "close", return_value={"ok": True}), \
             mock.patch("sys.stdout") as stdout:
            self.assertEqual(gate.cmd_close(args), 0)
        written = "".join(call.args[0] for call in stdout.write.call_args_list if call.args)
        payload = json.loads(written)
        self.assertEqual(payload["code"], "CLOSED_DEGRADED")
        self.assertEqual(payload["status"], "WARN")
        self.assertIn("unitTest", payload["ledger"]["degraded"])
        events = [
            json.loads(line)
            for line in (self.change_dir / "events.ndjson").read_text("utf-8").splitlines()
            if line.strip()
        ]
        ends = [item for item in events if item.get("type") == "phase.end"]
        self.assertEqual(ends[-1]["status"], "WARN")

    def test_degraded_prefix_without_reason_ut311(self) -> None:
        self._write_v2_ledger(unit_status="NOT_RUN", unit_evidence="DEGRADED:")
        workflow = policy.load_policy(REPO_ROOT)
        result = gate.validate_ledger_for_phase_close(self.change_dir, "run", workflow)
        self.assertFalse(result["ok"], result)
        self.assertIn(result["code"], {"MISSING_FIELDS", "MISSING_V2_FIELDS"})

    def test_plain_not_run_rejected_ut312(self) -> None:
        self._write_v2_ledger(unit_status="NOT_RUN", unit_evidence="skipped for now")
        workflow = policy.load_policy(REPO_ROOT)
        result = gate.validate_ledger_for_phase_close(self.change_dir, "run", workflow)
        self.assertFalse(result["ok"], result)
        problems = result.get("problems") or []
        unit = next(p for p in problems if p["verification"] == "unitTest")
        self.assertIn("status=OK", unit["missing"])

    def test_all_ok_ledger_close_unchanged_ut313(self) -> None:
        self._write_v2_ledger(unit_status="OK", unit_evidence="evidence/unit.log")
        workflow = policy.load_policy(REPO_ROOT)
        result = gate.validate_ledger_for_phase_close(self.change_dir, "run", workflow)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], "LEDGER_OK")
        self.assertEqual(result.get("degraded", []), [])

    def test_degraded_clamps_ok_to_warn_ut314(self) -> None:
        self._write_checkpoints("approved")
        self._write_v2_ledger(
            unit_status="NOT_RUN",
            unit_evidence="DEGRADED: env unavailable",
        )
        args = gate.build_parser().parse_args([
            "close", "--phase", "run", "--change", "demo",
            "--status", "OK", "--run-id", "run-warn", "--task", "1", "--json",
        ])
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value={
                 "ok": True, "changeId": "demo", "changeDir": str(self.change_dir)
             }), \
             mock.patch.object(gate.hc, "inspect_lease", return_value={"runId": "run-warn", "phase": "run"}), \
             mock.patch.object(gate.hc, "release_lease", return_value={"ok": True}), \
             mock.patch.object(gate.htg, "close", return_value={"ok": True}), \
             mock.patch("sys.stdout") as stdout:
            self.assertEqual(gate.cmd_close(args), 0)
        written = "".join(call.args[0] for call in stdout.write.call_args_list if call.args)
        payload = json.loads(written)
        self.assertEqual(payload["status"], "WARN")
        self.assertEqual(payload["code"], "CLOSED_DEGRADED")


if __name__ == "__main__":
    unittest.main()
