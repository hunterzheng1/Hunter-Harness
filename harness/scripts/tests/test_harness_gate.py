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
from typing import Any
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
# 解包器住在 finalizer（它定义了 legacy manifest 的 schema），gate 与 ledger 共用。
hpf = gate.hpf


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

    def test_uses_adjacent_installed_skills_root_when_flag_is_omitted(self) -> None:
        installed_root = self.project / ".codebuddy" / "skills"
        scripts_dir = installed_root / "scripts"
        scripts_dir.mkdir(parents=True)
        (installed_root / ".harness-build.json").write_text("{}\n", encoding="utf-8")

        with mock.patch.object(gate, "SCRIPTS_DIR", scripts_dir):
            self.assertEqual(
                gate.resolve_skills_root(None),
                installed_root.resolve(),
            )

    def test_foundation_gate_blocks_task_6_api012(self) -> None:
        blocked = gate.foundation_gate_blocks(6, self.change_dir)
        self.assertIsNotNone(blocked)
        assert blocked is not None
        self.assertEqual(blocked["code"], "FOUNDATION_GATE_PENDING")
        self.assertEqual(blocked["checkpointStatus"], "pending")

    def test_foundation_gate_allows_task_6_when_approved(self) -> None:
        self._write_checkpoints("approved")
        self.assertIsNone(gate.foundation_gate_blocks(6, self.change_dir))

    def test_gate_event_append_nudges_remote_sync_after_the_write(self) -> None:
        with mock.patch.object(gate.he, "nudge_remote_sync") as nudge:
            result = gate.append_phase_event(
                self.change_dir,
                phase="execute",
                type_="phase.end",
                status="OK",
                run_id="run-1",
            )

        self.assertTrue(result["ok"], result)
        nudge.assert_called_once_with(self.change_dir)

    def test_retry_never_uses_a_terminal_event_from_an_older_context_session(self) -> None:
        terminal = {
            "type": "phase.end",
            "phase": "execute",
            "timestamp": "2026-08-09T10:00:00+00:00",
        }
        with mock.patch.object(gate.hctx, "context_view", return_value={
            "ok": True,
            "current": {
                "phase": "execute",
                "preparedAt": "2026-08-09T11:00:00+00:00",
            },
        }):
            self.assertFalse(
                gate._terminal_matches_context_session(
                    self.project, "demo", "run", terminal
                )
            )

    def test_validate_ledger_for_phase_close_rejects_handwritten_ut026(self) -> None:
        self._handwritten_ledger()
        workflow = policy.load_policy(REPO_ROOT)
        result = gate.validate_ledger_for_phase_close(self.change_dir, "execute", workflow)
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
                "close", "--phase", "execute", "--change", "demo",
                "--status", "OK", "--run-id", "wrong-owner", "--task", "10",
                "--json",
            ]
        )
        holder = {"runId": "real-owner", "phase": "execute"}
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
                ["begin", "--phase", "execute", "--change", "demo", "--json"]
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
        begin_events = [
            json.loads(line)
            for line in (self.change_dir / "events.ndjson").read_text("utf-8").splitlines()
        ]
        review_run_id = next(
            item["run_id"] for item in begin_events if item["type"] == "phase.start"
        )
        review_reports = self.change_dir / "reports" / "review"
        review_reports.mkdir(parents=True, exist_ok=True)
        (review_reports / "review-findings.json").write_text(
            json.dumps({"schemaVersion": 1, "runId": review_run_id, "findings": []}) + "\n",
            encoding="utf-8",
        )
        (review_reports / "fixback-dispositions.json").write_text(
            json.dumps({"schemaVersion": 1, "runId": review_run_id, "dispositions": []}) + "\n",
            encoding="utf-8",
        )
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

    def test_post_run_harness_upgrade_is_reported_as_maintenance_only(self) -> None:
        plans = self.change_dir / "plans"
        plans.mkdir(parents=True, exist_ok=True)
        (plans / "demo-plan.md").write_text("risk: fast\n", encoding="utf-8")
        context_path = self.change_dir / "meta" / "change-context.json"
        context_path.parent.mkdir(parents=True, exist_ok=True)
        context_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 2,
                    "changeId": "demo",
                    "ownership": {
                        "productPaths": ["src/"],
                        "staticEvidencePaths": [".harness/changes/demo/"],
                        "excludedPaths": [".harness/state/"],
                    },
                }
            ),
            encoding="utf-8",
        )
        generated = self.project / ".cursor" / "skills" / "harness-execute" / "SKILL.md"
        generated.parent.mkdir(parents=True)
        generated.write_text("bundle 0.2.64\n", encoding="utf-8")
        (self.project / ".harness" / "context-index.json").write_text(
            "{}\n", encoding="utf-8"
        )

        result = gate.classify_risk(self.change_dir, "post-run")

        self.assertEqual(result["tier"], "fast")
        self.assertNotIn("production-code", result["signals"])
        self.assertEqual(
            result["workspaceBreakdown"]["harnessMaintenancePaths"],
            [".cursor/skills/harness-execute/SKILL.md", ".harness/context-index.json"],
        )
        self.assertEqual(result["workspaceBreakdown"]["productPaths"], [])

    def test_review_outputs_must_be_complete_and_bound_to_the_run(self) -> None:
        missing = gate.validate_review_outputs_for_close(
            self.change_dir, "review-run-1"
        )
        self.assertFalse(missing["ok"])
        self.assertEqual(missing["code"], "REVIEW_OUTPUTS_INCOMPLETE")

        review_dir = self.change_dir / "reports" / "review"
        review_dir.mkdir(parents=True)
        (review_dir / "review-findings.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "runId": "review-run-1",
                    "findings": [
                        {
                            "id": "f-one",
                            "dimension": "correctness",
                            "severity": "YELLOW",
                            "path": "src/timer.ts",
                            "line": 12,
                            "title": "避免魔法数",
                            "fixbackAction": "code",
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        (review_dir / "fixback-dispositions.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "runId": "review-run-1",
                    "dispositions": [
                        {"findingId": "f-one", "disposition": "OPEN"}
                    ],
                }
            ),
            encoding="utf-8",
        )

        valid = gate.validate_review_outputs_for_close(
            self.change_dir, "review-run-1"
        )
        self.assertTrue(valid["ok"], valid)

        findings_path = review_dir / "review-findings.json"
        findings_without_id = json.loads(findings_path.read_text(encoding="utf-8"))
        findings_without_id["findings"][0].pop("id")
        findings_path.write_text(
            json.dumps(findings_without_id), encoding="utf-8"
        )
        (review_dir / "fixback-dispositions.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "runId": "review-run-1",
                    "dispositions": [],
                }
            ),
            encoding="utf-8",
        )

        invalid = gate.validate_review_outputs_for_close(
            self.change_dir, "review-run-1"
        )
        self.assertFalse(invalid["ok"], invalid)
        self.assertEqual(invalid["code"], "REVIEW_OUTPUTS_INVALID")
        self.assertTrue(
            any("id" in problem for problem in invalid["problems"]), invalid
        )

    def test_risk_classification_uses_change_worktree_root(self) -> None:
        worktree = self.project / ".worktrees" / "demo"
        worktree.parent.mkdir()
        subprocess.run(
            ["git", "worktree", "add", "-b", "feature-demo", str(worktree)],
            cwd=self.project,
            check=True,
            capture_output=True,
        )
        meta = self.change_dir / "meta"
        meta.mkdir(exist_ok=True)
        (meta / "change-context.json").write_text(
            json.dumps({"worktreeRoot": ".worktrees"}) + "\n", encoding="utf-8"
        )
        self.assertEqual(gate.change_code_root(self.change_dir), worktree.resolve())
        (meta / "worktree.json").write_text(
            json.dumps({"path": ".worktrees/demo"}) + "\n", encoding="utf-8"
        )
        self.assertEqual(gate.change_code_root(self.change_dir), worktree.resolve())
        plans = self.change_dir / "plans"
        plans.mkdir(parents=True, exist_ok=True)
        (plans / "demo-plan.md").write_text("risk: fast\n", encoding="utf-8")
        changed = worktree / "src" / "auth" / "token-service.ts"
        changed.parent.mkdir(parents=True)
        changed.write_text("export const token = 'redacted';\n", encoding="utf-8")
        classified = gate.classify_risk(self.change_dir, "post-run")
        self.assertEqual(classified["tier"], "full")
        self.assertIn("auth", classified["signals"])

    def test_declared_foreign_worktree_fails_closed(self) -> None:
        foreign = Path(tempfile.mkdtemp(prefix="foreign-gate-repo-"))
        try:
            subprocess.run(["git", "init"], cwd=foreign, check=True, capture_output=True)
            meta = self.change_dir / "meta"
            meta.mkdir(exist_ok=True)
            (meta / "worktree.json").write_text(
                json.dumps({"worktreePath": str(foreign)}) + "\n", encoding="utf-8"
            )
            with self.assertRaisesRegex(ValueError, "EXECUTION_WORKTREE_INVALID"):
                gate.change_code_root(self.change_dir)
        finally:
            shutil.rmtree(foreign, ignore_errors=True)

    def test_lint_skills_flags_handwritten_ledger_pattern(self) -> None:
        skills_root = Path(tempfile.mkdtemp(prefix="skills-root-"))
        try:
            bad = skills_root / "harness-execute" / "SKILL.md"
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
                # execute 合并后关门要求 run∪test 并集；unitTestFull 不在本组
                # 用例的考察面内，给一条常态 OK 记录。
                "unitTestFull": self._v2_entry(
                    status="OK",
                    evidence="evidence/unit-full.log",
                ),
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
                "begin", "--phase", "execute", "--change", "demo",
                "--skills-root", str(skills_root), "--executor-tool", "codex", "--json",
            ])
            self.assertEqual(gate.cmd_begin(args), 0)

    def test_plan_handoff_rejects_modern_plan_without_receipt(self) -> None:
        plan = self.change_dir / "plans" / "demo-plan.md"
        plan.parent.mkdir(parents=True, exist_ok=True)
        plan.write_text(
            "---\nchange-name: demo\nstatus: approved\n---\n\n# Plan\n",
            encoding="utf-8",
        )

        result = gate.validate_plan_handoff(self.change_dir)

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "RECEIPT_MISSING")

    def test_plan_handoff_skips_synthetic_change_without_plan_artifacts(self) -> None:
        result = gate.validate_plan_handoff(self.change_dir)

        self.assertTrue(result["ok"])
        self.assertEqual(result["code"], "PLAN_HANDOFF_NOT_APPLICABLE")

    def test_run_begin_stops_before_lease_when_plan_handoff_is_invalid(self) -> None:
        args = gate.build_parser().parse_args([
            "begin", "--phase", "execute", "--change", "demo", "--task", "1",
            "--skills-root", str(self.project / ".agents" / "skills"), "--json",
        ])
        invalid = {
            "ok": False,
            "code": "SCENARIO_MANIFEST_EMPTY",
            "error": "scenario manifest is empty",
        }
        with mock.patch.object(
            gate.hc, "resolve_main_project_root", return_value=self.project
        ), mock.patch.object(
            gate.hc,
            "resolve_change",
            return_value={
                "ok": True,
                "changeId": "demo",
                "changeDir": str(self.change_dir),
            },
        ), mock.patch.object(
            gate, "validate_plan_handoff", return_value=invalid
        ), mock.patch.object(
            gate, "record_blocked_attempt"
        ) as record_blocked, mock.patch.object(
            gate.hc, "claim_lease"
        ) as claim_lease, mock.patch("sys.stderr"):
            code = gate.cmd_begin(args)

        self.assertEqual(code, 1)
        record_blocked.assert_not_called()
        claim_lease.assert_not_called()

    def test_gate_begin_rejects_a_phase_when_context_handoff_did_not_finish(self) -> None:
        args = gate.build_parser().parse_args([
            "begin", "--phase", "execute", "--change", "demo", "--json",
        ])
        resolved = {
            "ok": True,
            "changeId": "demo",
            "changeDir": str(self.change_dir),
        }
        with mock.patch.object(
            gate.hc, "resolve_main_project_root", return_value=self.project
        ), mock.patch.object(
            gate.hc, "resolve_change", return_value=resolved
        ), mock.patch.object(
            gate.hctx,
            "context_view",
            return_value={
                "ok": True,
                "currentPhase": "submit",
                "current": {"phase": "submit", "executor": "cursor"},
            },
        ), mock.patch.object(
            gate, "record_gate_blocked"
        ) as record_blocked, mock.patch.object(
            gate.hc, "claim_lease"
        ) as claim_lease, mock.patch("sys.stderr"):
            code = gate.cmd_begin(args)

        self.assertEqual(code, 1)
        claim_lease.assert_not_called()
        record_blocked.assert_called_once()
        self.assertEqual(
            record_blocked.call_args.kwargs["code"],
            "CONTEXT_HANDOFF_REQUIRED",
        )

    def test_successful_begin_records_recovery_after_a_context_block(self) -> None:
        self.change_dir.joinpath("events.ndjson").write_text(
            json.dumps({
                "schema_version": 3,
                "id": "evt-blocked",
                "timestamp": "2026-08-09T12:00:00+00:00",
                "phase": "execute",
                "type": "gate.blocked",
                "code": "CONTEXT_HANDOFF_REQUIRED",
                "run_id": "blocked-run",
                "attempt": 2,
            }) + "\n",
            encoding="utf-8",
        )

        with mock.patch.object(gate, "append_phase_event") as append_event:
            result = gate.record_gate_recovered(
                self.change_dir,
                phase="execute",
                run_id="active-run",
            )

        self.assertTrue(result["ok"])
        append_event.assert_called_once()
        self.assertEqual(append_event.call_args.kwargs["type_"], "gate.recovered")
        self.assertEqual(
            append_event.call_args.kwargs["code"],
            "CONTEXT_HANDOFF_REQUIRED",
        )

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
            "begin", "--phase", "execute", "--change", "demo", "--run-id", "capsule-run",
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

        capsule = gate.load_phase_capsule(self.change_dir, "execute", "capsule-run")
        self.assertEqual(capsule["stateRoot"], str(self.change_dir.resolve()))
        self.assertEqual(capsule["executionRoot"], str(execution.resolve()))
        self.assertEqual(capsule["skillsRoot"], str(skills_root.resolve()))

        resume_args = gate.build_parser().parse_args([
            "begin", "--phase", "execute", "--change", "demo", "--run-id", "capsule-run",
            "--skills-root", str(skills_root), "--json",
        ])
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value=resolved), \
             mock.patch.object(gate.hc, "inspect_lease", return_value={"runId": "capsule-run", "phase": "execute"}), \
             mock.patch.object(gate.hc, "claim_lease", return_value={"ok": True, "lease": {}}), \
             mock.patch.object(gate, "validate_identity", return_value=identity), \
             mock.patch.object(gate, "_phase_event_exists", return_value=True), \
             mock.patch.object(gate.htg, "begin", return_value={"ok": True}) as resumed_guard:
            self.assertEqual(gate.cmd_begin(resume_args), 0)
        resumed_guard.assert_not_called()

        close_args = gate.build_parser().parse_args([
            "close", "--phase", "execute", "--change", "demo", "--run-id", "capsule-run",
            "--status", "OK", "--json",
        ])
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value=resolved), \
             mock.patch.object(gate.hc, "inspect_lease", return_value={"runId": "capsule-run", "phase": "execute"}), \
             mock.patch.object(gate.hc, "release_lease", return_value={"ok": True}), \
             mock.patch.object(gate, "validate_ledger_for_phase_close", return_value={"ok": True, "code": "LEDGER_OK"}), \
             mock.patch.object(gate, "_phase_event_exists", return_value=False), \
             mock.patch.object(gate, "append_phase_event", return_value={"ok": True}), \
             mock.patch.object(gate.htg, "close", return_value={"ok": True}) as guard_close:
            self.assertEqual(gate.cmd_close(close_args), 0)
        guard_close.assert_called_once_with(execution.resolve(), self.change_dir)

    def test_begin_uses_inferred_skills_root_throughout_phase_capsule(self) -> None:
        self._write_checkpoints("approved")
        installed_root = self.project / ".codebuddy" / "skills"
        scripts_dir = installed_root / "scripts"
        scripts_dir.mkdir(parents=True)
        (installed_root / ".harness-build.json").write_text("{}\n", encoding="utf-8")
        resolved = {"ok": True, "changeId": "demo", "changeDir": str(self.change_dir)}
        identity = {"adapter": "codebuddy", "bundleHash": "sha256:" + "a" * 64}
        args = gate.build_parser().parse_args([
            "begin", "--phase", "execute", "--change", "demo", "--run-id", "inferred-root-run",
            "--json",
        ])

        with mock.patch.object(gate, "SCRIPTS_DIR", scripts_dir), \
             mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value=resolved), \
             mock.patch.object(gate.hc, "inspect_lease", return_value=None), \
             mock.patch.object(gate.hc, "claim_lease", return_value={"ok": True, "lease": {}}), \
             mock.patch.object(gate, "validate_identity", return_value=identity), \
             mock.patch.object(gate, "_phase_event_exists", return_value=False), \
             mock.patch.object(gate, "append_phase_event", return_value={"ok": True}), \
             mock.patch.object(gate.htg, "begin", return_value={"ok": True}):
            self.assertEqual(gate.cmd_begin(args), 0)

        capsule = gate.load_phase_capsule(self.change_dir, "execute", "inferred-root-run")
        self.assertEqual(capsule["skillsRoot"], str(installed_root.resolve()))

    def test_corrupt_phase_capsule_is_not_treated_as_absent(self) -> None:
        path = gate._phase_capsule_path(self.change_dir, "execute", "corrupt-run")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{not-json\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            gate.load_phase_capsule(self.change_dir, "execute", "corrupt-run")

    def test_phase_capsule_rejects_head_and_skills_root_drift(self) -> None:
        skills_root = (self.project / ".agents" / "skills").resolve()
        capsule = {
            "schemaVersion": 1,
            "changeId": "demo",
            "phase": "execute",
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
                phase="execute",
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
                phase="execute",
                run_id="identity-run",
                project=self.project,
                execution_root=self.project,
                skills_root=self.project / ".different-skills",
            )

    def test_submit_close_accepts_descendant_commit_from_same_run(self) -> None:
        self._write_checkpoints("approved")
        head = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.project, check=True,
            capture_output=True, text=True, encoding="utf-8",
        ).stdout.strip()
        run_id = "submit-commit"
        capsule = {
            "schemaVersion": 1,
            "changeId": "demo",
            "phase": "submit",
            "runId": run_id,
            "projectRoot": str(self.project.resolve()),
            "stateRoot": str(self.change_dir.resolve()),
            "executionRoot": str(self.project.resolve()),
            "skillsRoot": str((self.project / ".agents" / "skills").resolve()),
            "repositoryId": gate.hp.repository_identity(self.project),
            "baseCommit": head,
            "currentHead": head,
            "createdAt": gate.he.now_iso(),
        }
        gate.write_phase_capsule(self.change_dir, "submit", run_id, capsule)
        (self.project / "submitted.txt").write_text("submitted\n", encoding="utf-8")
        subprocess.run(
            ["git", "add", "submitted.txt"], cwd=self.project, check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "commit", "-m", "submit"], cwd=self.project, check=True,
            capture_output=True,
        )

        args = gate.build_parser().parse_args([
            "close", "--phase", "submit", "--change", "demo",
            "--run-id", run_id, "--status", "OK", "--json",
        ])
        resolved = {"ok": True, "changeId": "demo", "changeDir": str(self.change_dir)}
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value=resolved), \
             mock.patch.object(gate.hc, "inspect_lease", return_value={
                 "runId": run_id, "phase": "submit"
             }), \
             mock.patch.object(gate.hc, "release_lease", return_value={"ok": True}), \
             mock.patch.object(gate, "validate_ledger_for_phase_close", return_value={
                 "ok": True, "code": "LEDGER_OK"
             }), \
             mock.patch.object(gate, "_phase_event_exists", return_value=False), \
             mock.patch.object(gate, "append_phase_event", return_value={"ok": True}):
            self.assertEqual(gate.cmd_close(args), 0)

    def test_close_release_failure_persists_retryable_capsule(self) -> None:
        self._write_checkpoints("approved")
        head = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.project, check=True,
            capture_output=True, text=True,
        ).stdout.strip()
        capsule = {
            "schemaVersion": 1,
            "changeId": "demo",
            "phase": "execute",
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
        gate.write_phase_capsule(self.change_dir, "execute", "release-retry", capsule)
        args = gate.build_parser().parse_args([
            "close", "--phase", "execute", "--change", "demo",
            "--run-id", "release-retry", "--status", "OK", "--json",
        ])
        resolved = {"ok": True, "changeId": "demo", "changeDir": str(self.change_dir)}
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value=resolved), \
             mock.patch.object(gate.hc, "inspect_lease", return_value={
                 "runId": "release-retry", "phase": "execute"
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

    def _write_events(self, *events: dict) -> None:
        self.change_dir.joinpath("events.ndjson").write_text(
            "".join(json.dumps(event) + "\n" for event in events),
            encoding="utf-8",
        )

    def test_close_without_lease_reports_resume_run_id(self) -> None:
        """An expired lease must tell the caller how to resume, not just fail."""
        self._write_checkpoints("approved")
        self._write_events(
            {
                "schema_version": 3,
                "id": "evt-start",
                "timestamp": "2026-08-19T14:41:00+08:00",
                "phase": "execute",
                "type": "phase.start",
                "run_id": "run-long",
                "attempt": 1,
            },
        )
        args = gate.build_parser().parse_args([
            "close", "--phase", "execute", "--change", "demo", "--status", "OK", "--json",
        ])
        resolved = {"ok": True, "changeId": "demo", "changeDir": str(self.change_dir)}
        errors: list[str] = []
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value=resolved), \
             mock.patch.object(gate.hc, "inspect_lease", return_value=None), \
             mock.patch.object(gate.sys.stderr, "write", side_effect=errors.append):
            self.assertEqual(gate.cmd_close(args), 1)

        payload = json.loads(errors[-1])
        self.assertEqual(payload["code"], "LEASE_ABSENT")
        self.assertTrue(payload["retryable"])
        self.assertEqual(payload["resumeRunId"], "run-long")
        self.assertIn("harness_change.py claim", payload["recoveryAction"])
        self.assertIn("run-long", payload["recoveryAction"])

    def test_close_without_lease_ignores_already_closed_run_id(self) -> None:
        """A run that already recorded phase.end is not a resumable candidate."""
        self._write_checkpoints("approved")
        self._write_events(
            {
                "schema_version": 3, "id": "evt-s1",
                "timestamp": "2026-08-19T10:00:00+08:00",
                "phase": "execute", "type": "phase.start",
                "run_id": "run-done", "attempt": 1,
            },
            {
                "schema_version": 3, "id": "evt-e1",
                "timestamp": "2026-08-19T11:00:00+08:00",
                "phase": "execute", "type": "phase.end",
                "run_id": "run-done", "attempt": 1,
            },
        )
        args = gate.build_parser().parse_args([
            "close", "--phase", "execute", "--change", "demo", "--status", "OK", "--json",
        ])
        resolved = {"ok": True, "changeId": "demo", "changeDir": str(self.change_dir)}
        errors: list[str] = []
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value=resolved), \
             mock.patch.object(gate.hc, "inspect_lease", return_value=None), \
             mock.patch.object(gate.sys.stderr, "write", side_effect=errors.append):
            self.assertEqual(gate.cmd_close(args), 1)

        payload = json.loads(errors[-1])
        self.assertEqual(payload["code"], "LEASE_ABSENT")
        self.assertIsNone(payload["resumeRunId"])

    def _close_args(self, *extra: str) -> object:
        return gate.build_parser().parse_args([
            "close", "--phase", "execute", "--change", "demo",
            "--run-id", "run-1", "--status", "OK", "--json", *extra,
        ])

    def test_close_releases_lease_only_after_handoff(self) -> None:
        """handoff 失败时租约必须仍持有——重试同一命令即可恢复，不再需要人工 claim。

        2026-08-30 sales-insight-agent 实测：释放在前、handoff 在后，中途失败留下
        “phase.end 已写 + 租约已放 + 阶段没关上”的三不管状态。
        """
        self._write_checkpoints("approved")
        resolved = {"ok": True, "changeId": "demo", "changeDir": str(self.change_dir)}
        errors: list[str] = []
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value=resolved), \
             mock.patch.object(gate.hc, "inspect_lease", return_value={"runId": "run-1", "phase": "execute"}), \
             mock.patch.object(gate, "load_phase_capsule", return_value=None), \
             mock.patch.object(gate, "resolve_execution_root", return_value=self.project), \
             mock.patch.object(gate, "validate_ledger_for_phase_close", return_value={"ok": True}), \
             mock.patch.object(gate.htg, "close", return_value={"ok": True}), \
             mock.patch.object(gate, "append_phase_event", return_value={"ok": True}), \
             mock.patch.object(gate.hc, "release_lease", return_value={"ok": True}) as release, \
             mock.patch.object(gate.hctx, "close_transition", return_value={
                 "ok": False, "code": "TRANSITION_ILLEGAL", "allowedNextPhases": ["review"],
             }), \
             mock.patch.object(gate.hes, "auto_events_sync", return_value={"skipped": True}), \
             mock.patch.object(gate.sys.stderr, "write", side_effect=errors.append):
            code = gate.cmd_close(self._close_args("--to-phase", "review"))

        self.assertEqual(code, 1)
        payload = json.loads(errors[-1])
        self.assertEqual(payload["code"], "PHASE_HANDOFF_PENDING")
        self.assertTrue(payload["retryable"])
        # 关键不变量：handoff 失败时租约不得已释放
        release.assert_not_called()
        self.assertIn("无需重新 claim", payload["recoveryAction"])

        # 修复 handoff 后原样重跑：phase.end 幂等跳过，关门成功，租约此时才释放
        emitted: list[dict] = []
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value=resolved), \
             mock.patch.object(gate.hc, "inspect_lease", return_value={"runId": "run-1", "phase": "execute"}), \
             mock.patch.object(gate, "load_phase_capsule", return_value=None), \
             mock.patch.object(gate, "resolve_execution_root", return_value=self.project), \
             mock.patch.object(gate, "validate_ledger_for_phase_close", return_value={"ok": True}), \
             mock.patch.object(gate.htg, "close", return_value={"ok": True}), \
             mock.patch.object(gate, "append_phase_event", return_value={"ok": True}), \
             mock.patch.object(gate.hc, "release_lease", return_value={"ok": True}) as release2, \
             mock.patch.object(gate.hctx, "close_transition", return_value={
                 "ok": True, "code": "TRANSITION_CLOSED", "receipt": {},
             }), \
             mock.patch.object(gate.hes, "auto_events_sync", return_value={"skipped": True}), \
             mock.patch.object(gate, "emit", side_effect=lambda payload, **_kw: emitted.append(payload)):
            code = gate.cmd_close(self._close_args("--to-phase", "review"))

        self.assertEqual(code, 0)
        self.assertEqual(emitted[0]["code"], "PHASE_CLOSED")
        release2.assert_called_once()

    def test_close_without_to_phase_derives_unique_forward_successor(self) -> None:
        """P0-1：plain close 在上下文状态存在且计划后继唯一（排除 fixback 自环）时
        自动派生后继并交接——断链从根上消失，不再静默跳过。"""
        self._write_checkpoints("approved")
        resolved = {"ok": True, "changeId": "demo", "changeDir": str(self.change_dir)}
        emitted: list[dict] = []
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value=resolved), \
             mock.patch.object(gate.hc, "inspect_lease", return_value={"runId": "run-1", "phase": "execute"}), \
             mock.patch.object(gate, "load_phase_capsule", return_value=None), \
             mock.patch.object(gate, "resolve_execution_root", return_value=self.project), \
             mock.patch.object(gate, "validate_ledger_for_phase_close", return_value={"ok": True}), \
             mock.patch.object(gate.htg, "close", return_value={"ok": True}), \
             mock.patch.object(gate, "append_phase_event", return_value={"ok": True}), \
             mock.patch.object(gate.hc, "release_lease", return_value={"ok": True}), \
             mock.patch.object(gate.hctx, "context_view", return_value={
                 "ok": True, "current": {"phase": "execute"}, "transitions": [],
             }), \
             mock.patch.object(gate.hctx, "allowed_next_phases", return_value=["review", "execute"]), \
             mock.patch.object(gate.hctx, "close_transition", return_value={
                 "ok": True, "code": "TRANSITION_CLOSED", "receipt": {},
             }) as handoff, \
             mock.patch.object(gate.hes, "auto_events_sync", return_value={"skipped": True}), \
             mock.patch.object(gate, "emit", side_effect=lambda payload, **_kw: emitted.append(payload)):
            code = gate.cmd_close(self._close_args())

        self.assertEqual(code, 0)
        self.assertEqual(emitted[0]["code"], "PHASE_CLOSED")
        self.assertEqual(emitted[0]["derivedToPhase"], "review")
        self.assertEqual(handoff.call_args.kwargs["to_phase"], "review")

    def test_close_without_to_phase_stays_plain_when_no_context_state(self) -> None:
        """上下文跟踪从未启用（无 current context）时不凭空创建交接状态。"""
        self._write_checkpoints("approved")
        resolved = {"ok": True, "changeId": "demo", "changeDir": str(self.change_dir)}
        emitted: list[dict] = []
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value=resolved), \
             mock.patch.object(gate.hc, "inspect_lease", return_value={"runId": "run-1", "phase": "execute"}), \
             mock.patch.object(gate, "load_phase_capsule", return_value=None), \
             mock.patch.object(gate, "resolve_execution_root", return_value=self.project), \
             mock.patch.object(gate, "validate_ledger_for_phase_close", return_value={"ok": True}), \
             mock.patch.object(gate.htg, "close", return_value={"ok": True}), \
             mock.patch.object(gate, "append_phase_event", return_value={"ok": True}), \
             mock.patch.object(gate.hc, "release_lease", return_value={"ok": True}), \
             mock.patch.object(gate.hctx, "context_view", return_value={
                 "ok": True, "current": None, "transitions": [],
             }), \
             mock.patch.object(gate.hctx, "close_transition") as handoff, \
             mock.patch.object(gate.hes, "auto_events_sync", return_value={"skipped": True}), \
             mock.patch.object(gate, "emit", side_effect=lambda payload, **_kw: emitted.append(payload)):
            code = gate.cmd_close(self._close_args())

        self.assertEqual(code, 0)
        self.assertEqual(emitted[0]["code"], "PHASE_CLOSED")
        self.assertIsNone(emitted[0]["contextHandoff"])
        self.assertNotIn("derivedToPhase", emitted[0])
        handoff.assert_not_called()

    def _resume_mocks(self, *, transitions: list, candidates: list[str]):
        """lease 缺失 + phase.end 已写的中间态公共 mock 集。"""
        self._write_checkpoints("approved")
        self._write_events(
            {
                "schema_version": 3, "id": "evt-s1",
                "timestamp": "2026-08-30T10:00:00+08:00",
                "phase": "execute", "type": "phase.start",
                "run_id": "run-1", "attempt": 1,
            },
            {
                "schema_version": 3, "id": "evt-e1",
                "timestamp": "2026-08-30T11:00:00+08:00",
                "phase": "execute", "type": "phase.end",
                "run_id": "run-1", "attempt": 1, "status": "OK",
            },
        )
        return {
            "resolved": {"ok": True, "changeId": "demo", "changeDir": str(self.change_dir)},
            "view": {
                "ok": True,
                "current": {"phase": "execute", "preparedAt": "2026-08-30T09:00:00+08:00"},
                "transitions": transitions,
            },
            "candidates": candidates,
        }

    def test_close_resume_without_lease_derives_single_successor(self) -> None:
        """报告原场景：phase.end 已写+租约已放+交接没写，重跑 close（不带 --to-phase）
        必须幂等续跑并从计划派生唯一后继，而不是死偾 LEASE_ABSENT 逼人工 claim。"""
        ctx = self._resume_mocks(transitions=[], candidates=["review"])
        emitted: list[dict] = []
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value=ctx["resolved"]), \
             mock.patch.object(gate.hc, "inspect_lease", return_value=None), \
             mock.patch.object(gate.hc, "inspect_lease_state", return_value={"state": "absent", "lease": None}), \
             mock.patch.object(gate.hctx, "context_view", return_value=ctx["view"]), \
             mock.patch.object(gate.hctx, "allowed_next_phases", return_value=ctx["candidates"]), \
             mock.patch.object(gate.hctx, "close_transition", return_value={
                 "ok": True, "code": "TRANSITION_CLOSED", "receipt": {},
             }) as handoff, \
             mock.patch.object(gate.hc, "release_lease", return_value={"ok": True}) as release, \
             mock.patch.object(gate.hes, "auto_events_sync", return_value={"skipped": True}), \
             mock.patch.object(gate, "emit", side_effect=lambda payload, **_kw: emitted.append(payload)):
            code = gate.cmd_close(self._close_args())

        self.assertEqual(code, 0)
        self.assertEqual(emitted[0]["code"], "PHASE_CLOSE_RESUMED")
        self.assertTrue(emitted[0]["localCloseComplete"])
        # 唯一后继 review 被自动派生补跑交接
        self.assertEqual(handoff.call_args.kwargs["to_phase"], "review")
        # 租约早已释放——续跑绝不能再释放一次，更不该要求重新 claim
        release.assert_not_called()

    def test_close_resume_derives_forward_successor_over_fixback_loop(self) -> None:
        """execute 的候选含 fixback 自环（review/execute）时，自动派生非自身的
        唯一前驱后继 review——fixback 必须显式 --to-phase execute，不会被误选。"""
        ctx = self._resume_mocks(transitions=[], candidates=["review", "execute"])
        emitted: list[dict] = []
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value=ctx["resolved"]), \
             mock.patch.object(gate.hc, "inspect_lease", return_value=None), \
             mock.patch.object(gate.hc, "inspect_lease_state", return_value={"state": "absent", "lease": None}), \
             mock.patch.object(gate.hctx, "context_view", return_value=ctx["view"]), \
             mock.patch.object(gate.hctx, "allowed_next_phases", return_value=ctx["candidates"]), \
             mock.patch.object(gate.hctx, "close_transition", return_value={
                 "ok": True, "code": "TRANSITION_CLOSED", "receipt": {},
             }) as handoff, \
             mock.patch.object(gate.hes, "auto_events_sync", return_value={"skipped": True}), \
             mock.patch.object(gate, "emit", side_effect=lambda payload, **_kw: emitted.append(payload)):
            code = gate.cmd_close(self._close_args())

        self.assertEqual(code, 0)
        self.assertEqual(emitted[0]["code"], "PHASE_CLOSE_RESUMED")
        self.assertEqual(emitted[0]["derivedToPhase"], "review")
        self.assertEqual(handoff.call_args.kwargs["to_phase"], "review")

    def test_close_resume_asks_for_to_phase_when_successor_ambiguous(self) -> None:
        """非自身后继不唯一时给出候选与可执行恢复命令。"""
        ctx = self._resume_mocks(transitions=[], candidates=["review", "submit"])
        errors: list[str] = []
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value=ctx["resolved"]), \
             mock.patch.object(gate.hc, "inspect_lease", return_value=None), \
             mock.patch.object(gate.hc, "inspect_lease_state", return_value={"state": "absent", "lease": None}), \
             mock.patch.object(gate.hctx, "context_view", return_value=ctx["view"]), \
             mock.patch.object(gate.hctx, "allowed_next_phases", return_value=ctx["candidates"]), \
             mock.patch.object(gate.sys.stderr, "write", side_effect=errors.append):
            code = gate.cmd_close(self._close_args())

        self.assertEqual(code, 1)
        payload = json.loads(errors[-1])
        self.assertEqual(payload["code"], "PHASE_HANDOFF_PENDING")
        self.assertEqual(payload["candidateNextPhases"], ["review", "submit"])
        self.assertTrue(payload["retryable"])
        self.assertIn("--to-phase", payload["recoveryAction"])
        self.assertIn("不需要重新 claim", payload["recoveryAction"])

    def test_close_resume_skips_handoff_when_transition_already_recorded(self) -> None:
        """交接收据已在 transitions.ndjson 时不再重放，直接补齐收尾步骤。"""
        ctx = self._resume_mocks(
            transitions=[{"fromPhase": "execute", "toPhase": "review", "status": "OK"}],
            candidates=["review"],
        )
        emitted: list[dict] = []
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value=ctx["resolved"]), \
             mock.patch.object(gate.hc, "inspect_lease", return_value=None), \
             mock.patch.object(gate.hc, "inspect_lease_state", return_value={"state": "absent", "lease": None}), \
             mock.patch.object(gate.hctx, "context_view", return_value=ctx["view"]), \
             mock.patch.object(gate.hctx, "allowed_next_phases", return_value=ctx["candidates"]), \
             mock.patch.object(gate.hctx, "close_transition") as handoff, \
             mock.patch.object(gate.hes, "auto_events_sync", return_value={"skipped": True}), \
             mock.patch.object(gate, "emit", side_effect=lambda payload, **_kw: emitted.append(payload)):
            code = gate.cmd_close(self._close_args())

        self.assertEqual(code, 0)
        self.assertEqual(emitted[0]["code"], "PHASE_CLOSE_RESUMED")
        self.assertEqual(emitted[0]["contextHandoff"]["code"], "TRANSITION_ALREADY_CLOSED")
        handoff.assert_not_called()

    def test_emit_error_text_mode_prints_recovery_action(self) -> None:
        """--json 的 recoveryAction 一直在，文本模式此前完全丢失（报告建议 3）。"""
        errors: list[str] = []
        with mock.patch.object(gate.sys.stderr, "write", side_effect=errors.append):
            code = gate.emit_error(
                "LEASE_ABSENT",
                "no active lease for phase close",
                as_json=False,
                extra={"recoveryAction": "python harness_change.py claim ..."},
            )

        self.assertEqual(code, 1)
        self.assertIn("LEASE_ABSENT", errors[0])
        self.assertTrue(any("harness_change.py claim" in line for line in errors))

    def _expired_lease_close(
        self,
        *,
        lease: dict,
        run_id: str = "run-long",
        claim_result: dict | None = None,
    ):
        """Drive cmd_close with no active lease but an expired one on disk."""
        self._write_checkpoints("approved")
        args = gate.build_parser().parse_args([
            "close", "--phase", "execute", "--change", "demo",
            "--run-id", run_id, "--status", "OK", "--json",
        ])
        resolved = {"ok": True, "changeId": "demo", "changeDir": str(self.change_dir)}
        claimed = claim_result if claim_result is not None else {
            "ok": True,
            "code": "LEASE_REFRESHED",
            "lease": {
                "runId": run_id,
                "phase": "execute",
                "refreshedAt": "2026-08-20T09:00:00.000+08:00",
            },
        }
        errors: list[str] = []
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value=resolved), \
             mock.patch.object(gate.hc, "inspect_lease", return_value=None), \
             mock.patch.object(gate.hc, "inspect_lease_state", return_value=lease), \
             mock.patch.object(gate.hc, "claim_lease", return_value=claimed) as claim, \
             mock.patch.object(gate.hc, "release_lease", return_value={"ok": True}), \
             mock.patch.object(gate, "validate_ledger_for_phase_close", return_value={
                 "ok": True, "code": "LEDGER_OK"
             }), \
             mock.patch.object(gate, "load_phase_capsule", return_value=None), \
             mock.patch.object(gate, "resolve_execution_root", return_value=self.project), \
             mock.patch.object(gate.htg, "close", return_value={"ok": True}), \
             mock.patch.object(gate, "_phase_event_exists", return_value=False), \
             mock.patch.object(gate, "append_phase_event", return_value={"ok": True}), \
             mock.patch.object(gate.sys.stderr, "write", side_effect=errors.append), \
             mock.patch("sys.stdout") as stdout:
            code = gate.cmd_close(args)
        written = "".join(
            call.args[0] for call in stdout.write.call_args_list if call.args
        )
        return code, written, errors, claim

    def test_close_reacquires_an_expired_lease_from_the_same_run(self) -> None:
        """一个跑过 TTL 的阶段必须还能收尾，不该要求人先手工 claim 一遍。

        租约过期而 runId 还是本轮的，恰好证明没有第三方抢占过——抢占会重写
        租约文件把 runId 换掉。harness_context.close_transition 早就是这么
        推理的（只记 leaseLapsed 照常收尾），Gate 侧此前却把过期当成租约不存在。
        """
        code, written, _, claim = self._expired_lease_close(lease={
            "state": "expired",
            "lease": {
                "runId": "run-long",
                "phase": "execute",
                "acquiredAt": "2026-08-20T07:00:00.000+08:00",
                "expiresAt": "2026-08-20T08:00:00.000+08:00",
            },
        })

        self.assertEqual(code, 0)
        # 用原 run-id 重取，不是新开一次 attempt。
        self.assertEqual(claim.call_args.kwargs["run_id"], "run-long")
        payload = json.loads(written)
        self.assertEqual(payload["leaseLapsed"]["runId"], "run-long")
        # 超时的事实要记下来，不能悄悄抹掉。
        self.assertEqual(
            payload["leaseLapsed"]["expiresAt"], "2026-08-20T08:00:00.000+08:00"
        )

    def test_close_refuses_an_expired_lease_left_by_another_run(self) -> None:
        """自动重取只在能证明所有权时成立，换了 runId 就证明不了。"""
        code, _, errors, claim = self._expired_lease_close(
            run_id="run-mine",
            lease={
                "state": "expired",
                "lease": {"runId": "run-someone-else", "phase": "execute"},
            },
        )

        self.assertEqual(code, 1)
        claim.assert_not_called()
        self.assertEqual(json.loads(errors[-1])["code"], "LEASE_OWNER_MISMATCH")

    def test_close_refuses_an_expired_lease_for_another_phase(self) -> None:
        code, _, errors, claim = self._expired_lease_close(lease={
            "state": "expired",
            "lease": {"runId": "run-long", "phase": "review"},
        })

        self.assertEqual(code, 1)
        claim.assert_not_called()
        self.assertEqual(json.loads(errors[-1])["code"], "LEASE_OWNER_MISMATCH")

    def test_close_does_not_auto_recover_a_corrupt_lease(self) -> None:
        """损坏的租约什么都证明不了，包括"没人抢占过"——这正是自动重取的前提。"""
        code, _, errors, claim = self._expired_lease_close(lease={
            "state": "corrupt",
            "lease": None,
        })

        self.assertEqual(code, 1)
        claim.assert_not_called()
        payload = json.loads(errors[-1])
        self.assertEqual(payload["code"], "LEASE_INVALID")
        self.assertIn("harness_change.py claim", payload["recoveryAction"])

    def _seed_bundle_identity(self, agent: str = "codex") -> Path:
        """Lay down a self-consistent bundle: marker, context-index, installed state."""
        skills_root = self.project / ".agents" / "skills"
        skills_root.mkdir(parents=True, exist_ok=True)
        (skills_root / ".harness-build.json").write_text(
            json.dumps({
                "schemaVersion": 1,
                "agent": agent,
                "overlay": "none",
                "coreHash": "a" * 16,
            }) + "\n",
            encoding="utf-8",
        )
        context = {
            "schema_version": 2,
            "project": {"adapters": {agent: {"skills_root": ".agents/skills"}}},
            "skill_bundles": {
                agent: {"registry_version": "0.2.6", "bundle_hash": "sha256:" + "b" * 64}
            },
        }
        (self.project / ".harness" / "context-index.json").write_text(
            json.dumps(context) + "\n", encoding="utf-8"
        )
        installed = {
            "schema_version": 4,
            "profiles": {agent: "general"},
            "manifests": [{
                "adapter": agent, "profile": "general", "bundle_version": "0.2.6",
                "bundle_manifest_hash": "sha256:" + "b" * 64,
            }],
            "files": [{
                "owner": agent,
                "target_path": ".agents/skills/.harness-build.json",
                "sha256": gate._sha256_file(skills_root / ".harness-build.json"),
            }],
        }
        state = self.project / ".harness" / "state" / "local" / "installed-harness-bundle.json"
        state.parent.mkdir(parents=True, exist_ok=True)
        state.write_text(json.dumps(installed) + "\n", encoding="utf-8")
        return skills_root

    def test_identity_accepts_a_tool_that_differs_from_the_bundle_agent(self) -> None:
        """换工具接手不是 bundle 身份问题。

        "这个 bundle 可不可信"和"现在哪个工具在跑"是两件事。以前
        executor_tool != agent 直接 BUNDLE_IDENTITY_MISMATCH，于是 Codex 换
        CodeBuddy 接手同一个 change 会被当成供应链漂移挡下来。
        """
        skills_root = self._seed_bundle_identity(agent="codex")

        identity = gate.validate_identity(self.project, skills_root, "codebuddy")

        self.assertEqual(identity["adapter"], "codex")
        # 工具名降级为审计字段，随 phase.start 事件留痕，不再阻断。
        self.assertEqual(identity["executorTool"], "codebuddy")
        self.assertFalse(identity["executorMatchesBundle"])

    def test_identity_marks_a_matching_tool_as_such(self) -> None:
        skills_root = self._seed_bundle_identity(agent="codex")

        identity = gate.validate_identity(self.project, skills_root, "codex")

        self.assertTrue(identity["executorMatchesBundle"])

    def test_identity_still_blocks_a_drifted_build_marker(self) -> None:
        """解耦工具身份不能顺手放松 bundle 内容完整性。"""
        skills_root = self._seed_bundle_identity(agent="codex")
        # 装好之后被人改过：实盘哈希与 installed manifest 记录的不再一致。
        (skills_root / ".harness-build.json").write_text(
            json.dumps({
                "schemaVersion": 1,
                "agent": "codex",
                "overlay": "tampered",
                "coreHash": "a" * 16,
            }) + "\n",
            encoding="utf-8",
        )

        with self.assertRaises(ValueError) as raised:
            gate.validate_identity(self.project, skills_root, "codex")

        self.assertIn("BUNDLE_IDENTITY_MISMATCH", str(raised.exception))

    def test_identity_still_blocks_an_unconfigured_adapter(self) -> None:
        skills_root = self._seed_bundle_identity(agent="codex")
        context = json.loads(
            (self.project / ".harness" / "context-index.json").read_text(encoding="utf-8")
        )
        context["project"]["adapters"] = {"cursor": {"skills_root": ".cursor/skills"}}
        (self.project / ".harness" / "context-index.json").write_text(
            json.dumps(context) + "\n", encoding="utf-8"
        )

        with self.assertRaises(ValueError) as raised:
            gate.validate_identity(self.project, skills_root, "codex")

        self.assertIn("BUNDLE_IDENTITY_MISMATCH", str(raised.exception))

    def test_begin_conflict_flags_a_lease_left_by_a_closed_phase(self) -> None:
        """A lease held by a phase that already ended is leftover, and safe to release."""
        self._write_events(
            {
                "schema_version": 3, "id": "evt-plan-end",
                "timestamp": "2026-08-19T14:19:36+08:00",
                "phase": "plan", "type": "phase.end",
                "run_id": "plan-stale", "attempt": 1,
            },
        )
        holder = {"phase": "plan", "runId": "plan-stale", "expiresAt": "2026-08-19T15:21:00+08:00"}
        payload = self._begin_conflict_payload(holder)
        self.assertEqual(payload["code"], "LEASE_CONFLICT")
        self.assertTrue(payload["holderPhaseClosed"])
        self.assertIn("harness_change.py release", payload["recoveryAction"])
        self.assertIn("plan-stale", payload["recoveryAction"])

    def test_begin_conflict_withholds_release_advice_for_a_live_phase(self) -> None:
        """Without a phase.end the holder may still be running — never advise release."""
        self._write_events()
        holder = {"phase": "execute", "runId": "run-live", "expiresAt": "2026-08-19T15:21:00+08:00"}
        payload = self._begin_conflict_payload(holder)
        self.assertEqual(payload["code"], "LEASE_CONFLICT")
        self.assertFalse(payload["holderPhaseClosed"])
        self.assertNotIn("harness_change.py release", payload["recoveryAction"])
        self.assertIn("phase.end", payload["recoveryAction"])

    def _begin_conflict_payload(self, holder: dict) -> dict:
        self._write_checkpoints("approved")
        scripts_dir = self.project / ".codebuddy" / "skills" / "scripts"
        scripts_dir.mkdir(parents=True, exist_ok=True)
        (scripts_dir.parent / ".harness-build.json").write_text("{}\n", encoding="utf-8")
        args = gate.build_parser().parse_args([
            "begin", "--phase", "execute", "--change", "demo",
            "--run-id", "run-new", "--json",
        ])
        resolved = {"ok": True, "changeId": "demo", "changeDir": str(self.change_dir)}
        identity = {"adapter": "codebuddy", "bundleHash": "sha256:" + "a" * 64}
        errors: list[str] = []
        with mock.patch.object(gate, "SCRIPTS_DIR", scripts_dir), \
             mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value=resolved), \
             mock.patch.object(gate.hc, "inspect_lease", return_value=None), \
             mock.patch.object(gate, "validate_identity", return_value=identity), \
             mock.patch.object(gate.hc, "claim_lease", return_value={
                 "ok": False, "code": "LEASE_CONFLICT",
                 "message": "change lease held by another run",
                 "holder": holder,
             }), \
             mock.patch.object(gate.sys.stderr, "write", side_effect=errors.append):
            self.assertEqual(gate.cmd_begin(args), 1)
        return json.loads(errors[-1])

    def test_close_root_mismatch_persists_retryable_failure_capsule(self) -> None:
        self._write_checkpoints("approved")
        alternate_root = self.project / "alternate-worktree"
        alternate_root.mkdir()
        head = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.project, check=True,
            capture_output=True, text=True,
        ).stdout.strip()
        capsule = {
            "schemaVersion": 1,
            "changeId": "demo",
            "phase": "submit",
            "runId": "root-mismatch",
            "projectRoot": str(self.project.resolve()),
            "stateRoot": str(self.change_dir.resolve()),
            "executionRoot": str(self.project.resolve()),
            "skillsRoot": str((self.project / ".agents" / "skills").resolve()),
            "repositoryId": gate.hp.repository_identity(self.project),
            "baseCommit": head,
            "currentHead": head,
            "createdAt": gate.he.now_iso(),
        }
        gate.write_phase_capsule(
            self.change_dir, "submit", "root-mismatch", capsule
        )
        args = gate.build_parser().parse_args([
            "close", "--phase", "submit", "--change", "demo",
            "--run-id", "root-mismatch", "--status", "OK",
            "--project", str(alternate_root), "--json",
        ])
        resolved = {
            "ok": True,
            "changeId": "demo",
            "changeDir": str(self.change_dir),
        }

        def resolve_root(_project: Path, raw: str | None) -> Path:
            if raw == str(alternate_root):
                return alternate_root.resolve()
            return self.project.resolve()

        with mock.patch.object(
            gate.hc, "resolve_main_project_root", return_value=self.project
        ), mock.patch.object(
            gate.hc, "resolve_change", return_value=resolved
        ), mock.patch.object(
            gate.hc,
            "inspect_lease",
            return_value={"runId": "root-mismatch", "phase": "submit"},
        ), mock.patch.object(
            gate, "resolve_execution_root", side_effect=resolve_root
        ), mock.patch("sys.stderr"):
            self.assertEqual(gate.cmd_close(args), 1)

        updated = gate.load_phase_capsule(
            self.change_dir, "submit", "root-mismatch"
        )
        self.assertEqual(
            updated["closeTransaction"]["status"],
            "ROOT_VALIDATION_FAILED",
        )
        self.assertTrue(updated["closeTransaction"]["retryable"])
        self.assertNotIn("closeStatus", updated)
        self.assertNotIn("closedAt", updated)

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
        self.assertIn("dbCompatibility", persisted["requiredValidationsByPhase"]["execute"])

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
            "close", "--phase", "execute", "--change", "demo",
            "--run-id", "dag-close", "--status", "OK", "--task", "1", "--json",
        ])
        resolved = {"ok": True, "changeId": "demo", "changeDir": str(self.change_dir)}
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value=resolved), \
             mock.patch.object(gate.hc, "inspect_lease", return_value={
                 "runId": "dag-close", "phase": "execute"
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
        result = gate.validate_ledger_for_phase_close(self.change_dir, "execute", workflow)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], "LEDGER_OK_DEGRADED")
        self.assertIn("unitTest", result["degraded"])

        args = gate.build_parser().parse_args([
            "close", "--phase", "execute", "--change", "demo",
            "--status", "OK", "--run-id", "run-deg", "--task", "1", "--json",
        ])
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value={
                 "ok": True, "changeId": "demo", "changeDir": str(self.change_dir)
             }), \
             mock.patch.object(gate.hc, "inspect_lease", return_value={"runId": "run-deg", "phase": "execute"}), \
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
        result = gate.validate_ledger_for_phase_close(self.change_dir, "execute", workflow)
        self.assertFalse(result["ok"], result)
        self.assertIn(result["code"], {"MISSING_FIELDS", "MISSING_V2_FIELDS"})

    def test_plain_not_run_rejected_ut312(self) -> None:
        self._write_v2_ledger(unit_status="NOT_RUN", unit_evidence="skipped for now")
        workflow = policy.load_policy(REPO_ROOT)
        result = gate.validate_ledger_for_phase_close(self.change_dir, "execute", workflow)
        self.assertFalse(result["ok"], result)
        problems = result.get("problems") or []
        unit = next(p for p in problems if p["verification"] == "unitTest")
        # Retro §5.14: missing now carries the actual status value, not a
        # fixed "status=OK" string, so callers can distinguish FAIL/NOT_RUN.
        self.assertTrue(any(m.startswith("status=") for m in unit["missing"]))

    def test_all_ok_ledger_close_unchanged_ut313(self) -> None:
        self._write_v2_ledger(unit_status="OK", unit_evidence="evidence/unit.log")
        workflow = policy.load_policy(REPO_ROOT)
        result = gate.validate_ledger_for_phase_close(self.change_dir, "execute", workflow)
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
            "close", "--phase", "execute", "--change", "demo",
            "--status", "OK", "--run-id", "run-warn", "--task", "1", "--json",
        ])
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value={
                 "ok": True, "changeId": "demo", "changeDir": str(self.change_dir)
             }), \
             mock.patch.object(gate.hc, "inspect_lease", return_value={"runId": "run-warn", "phase": "execute"}), \
             mock.patch.object(gate.hc, "release_lease", return_value={"ok": True}), \
             mock.patch.object(gate.htg, "close", return_value={"ok": True}), \
             mock.patch("sys.stdout") as stdout:
            self.assertEqual(gate.cmd_close(args), 0)
        written = "".join(call.args[0] for call in stdout.write.call_args_list if call.args)
        payload = json.loads(written)
        self.assertEqual(payload["status"], "WARN")
        self.assertEqual(payload["code"], "CLOSED_DEGRADED")


class ScenarioCoverageTests(unittest.TestCase):
    """C9: gate close 校验 P0 场景都有 ledger entry。"""

    def setUp(self) -> None:
        self.project = Path(tempfile.mkdtemp(prefix="harness-gate-scen-"))
        self.change_dir = self.project / ".harness" / "changes" / "demo"
        self.change_dir.mkdir(parents=True)
        # checkpoints approved
        (self.change_dir / "meta").mkdir(parents=True, exist_ok=True)
        (self.change_dir / "meta" / "implementation-checkpoints.json").write_text(
            json.dumps({
                "schemaVersion": 1,
                "changeName": "demo",
                "checkpoints": [
                    {
                        "id": "foundation-gate",
                        "afterTasks": [1, 2, 3, 4],
                        "beforeTasks": [6, 7, 8, 9, 10],
                        "status": "approved",
                        "blocking": True,
                        "reviewerTool": "codex",
                        "requiredReport": "reports/review/foundation-gate-review.md",
                    }
                ],
            }) + "\n",
            encoding="utf-8",
        )
        # workflow policy
        policy_target = self.project / "harness" / "contracts" / "workflow-policy.json"
        policy_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(REPO_ROOT / "harness" / "contracts" / "workflow-policy.json", policy_target)
        subprocess.run(["git", "init"], cwd=self.project, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=self.project, check=True, capture_output=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=self.project, check=True, capture_output=True)
        subprocess.run(["git", "config", "commit.gpgsign", "false"], cwd=self.project, check=True, capture_output=True)
        (self.project / "README.md").write_text("demo\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=self.project, check=True, capture_output=True)
        subprocess.run(["git", "commit", "-m", "init"], cwd=self.project, check=True, capture_output=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.project, ignore_errors=True)

    def _write_manifest(
        self,
        scenarios: list[dict],
        *,
        schema_version: int = 1,
    ) -> None:
        (self.change_dir / "meta" / "scenario-manifest.json").write_text(
            json.dumps({
                "schemaVersion": schema_version,
                "changeName": "demo",
                "scenarios": scenarios,
            }) + "\n",
            encoding="utf-8",
        )

    def _write_ledger(self, scenario_ids: list[str]) -> None:
        (self.change_dir / "evidence").mkdir(parents=True, exist_ok=True)
        (self.change_dir / "evidence" / "verification-ledger.json").write_text(
            json.dumps({
                "changeName": "demo",
                "validations": {
                    "unitTest": {
                        "status": "OK",
                        "command": "pytest",
                        "evidence": "pass",
                        "inputsHash": "sha256:abc",
                        "inputsFiles": ["src/app.py"],
                        "algorithmVersion": "harness-ledger-2",
                        "coverage": "module",
                        "scope": "module",
                        "scenarioIds": scenario_ids,
                    }
                },
            }) + "\n",
            encoding="utf-8",
        )

    def _write_receipt_ledger(self, scenario_ids: list[str]) -> None:
        """Ledger whose entry carries a schema-v2 passing execution receipt."""
        self._write_ledger(scenario_ids)
        ledger_path = self.change_dir / "evidence" / "verification-ledger.json"
        ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
        executable = {
            "UT-001": ("unit::ut1", "tests/unit.spec.ts", "ut1"),
            "API-001": ("api::a1", "tests/api.spec.ts", "a1"),
        }
        entries = [executable[sid] for sid in scenario_ids]
        ledger["validations"]["unitTest"]["scenarioReceipt"] = {
            "schemaVersion": 1,
            "runner": {"name": "vitest", "version": "3.2.4"},
            "attempt": 1,
            "declared": [test_id for test_id, _, _ in entries],
            "selected": [test_id for test_id, _, _ in entries],
            "collected": [
                {"testId": test_id, "file": file, "title": title}
                for test_id, file, title in entries
            ],
            "executed": [
                {
                    "testId": test_id,
                    "file": file,
                    "title": title,
                    "attempt": 1,
                    "status": "PASSED",
                }
                for test_id, file, title in entries
            ],
        }
        ledger_path.write_text(json.dumps(ledger), encoding="utf-8")

    def _close_args(self) -> object:
        return gate.build_parser().parse_args([
            "close", "--phase", "execute", "--change", "demo",
            "--status", "OK", "--run-id", "run-1", "--task", "5",
            "--json",
        ])

    def test_close_fails_when_p0_scenario_missing(self) -> None:
        # ownerPhase=run so the scenarios are due at the run close under test.
        self._write_manifest([
            {"id": "C5-S1", "priority": "P0", "ownerPhase": "execute", "requiredEvidenceKind": "ledger"},
            {"id": "C5-S2", "priority": "P1", "ownerPhase": "execute", "requiredEvidenceKind": "ledger"},
        ])
        # ledger only covers C5-S2, missing C5-S1 (P0)
        self._write_ledger(["C5-S2"])

        args = self._close_args()
        with mock.patch.dict(
            gate.os.environ, {"HUNTER_HARNESS_GATE_MODE": "strict"}, clear=False
        ), mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value={
                 "ok": True, "changeId": "demo", "changeDir": str(self.change_dir)
             }), \
             mock.patch.object(gate.hc, "inspect_lease", return_value={"runId": "run-1", "phase": "execute"}), \
             mock.patch.object(gate, "validate_ledger_for_phase_close", return_value={"ok": True}), \
             mock.patch.object(gate, "load_phase_capsule", return_value=None), \
             mock.patch.object(gate, "resolve_execution_root", return_value=self.project), \
             mock.patch.object(gate.htg, "close", return_value={"ok": True}), \
             mock.patch.object(gate, "append_phase_event", return_value={"ok": True}), \
             mock.patch.object(gate.hc, "release_lease", return_value={"ok": True}):
            with mock.patch("sys.stderr"):
                code = gate.cmd_close(args)
        self.assertEqual(code, 1)

    def test_close_passes_when_all_p0_scenarios_covered(self) -> None:
        self._write_manifest([
            {"id": "C5-S1", "priority": "P0", "ownerPhase": "execute", "requiredEvidenceKind": "ledger"},
            {"id": "C5-S2", "priority": "P1", "ownerPhase": "execute", "requiredEvidenceKind": "ledger"},
        ])
        # ledger covers both P0 and P1
        self._write_ledger(["C5-S1", "C5-S2"])

        args = self._close_args()
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value={
                 "ok": True, "changeId": "demo", "changeDir": str(self.change_dir)
             }), \
             mock.patch.object(gate.hc, "inspect_lease", return_value={"runId": "run-1", "phase": "execute"}), \
             mock.patch.object(gate, "validate_ledger_for_phase_close", return_value={"ok": True}), \
             mock.patch.object(gate, "load_phase_capsule", return_value=None), \
             mock.patch.object(gate, "resolve_execution_root", return_value=self.project), \
             mock.patch.object(gate.htg, "close", return_value={"ok": True}), \
             mock.patch.object(gate, "append_phase_event", return_value={"ok": True}), \
             mock.patch.object(gate.hc, "release_lease", return_value={"ok": True}), \
             mock.patch("sys.stdout"):
            code = gate.cmd_close(args)
        self.assertEqual(code, 0)

    def test_empty_scenario_manifest_fails_closed(self) -> None:
        self._write_manifest([])

        result = gate._validate_scenario_coverage(self.change_dir)

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "SCENARIO_MANIFEST_EMPTY")

    def test_execute_close_defers_review_owned_scenarios(self) -> None:
        """execute close must not demand receipts for ownerPhase=review scenarios."""
        self._write_manifest(
            [
                {
                    "id": "UT-001",
                    "priority": "P1",
                    "ownerPhase": "execute",
                    "requiredEvidenceKind": "ledger",
                    "executableTestId": "unit::ut1",
                    "testFile": "tests/unit.spec.ts",
                    "testTitle": "ut1",
                },
                {
                    "id": "API-001",
                    "priority": "P1",
                    "ownerPhase": "review",
                    "requiredEvidenceKind": "ledger",
                    "executableTestId": "api::a1",
                    "testFile": "tests/api.spec.ts",
                    "testTitle": "a1",
                },
            ],
            schema_version=2,
        )
        self._write_receipt_ledger(["UT-001"])

        result = gate._validate_scenario_coverage(self.change_dir, "execute")

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], "SCENARIO_COVERAGE_OK")
        self.assertEqual(result["deferred"], ["API-001"])
        self.assertEqual(result["unexecuted"], [])

    def test_execute_close_still_requires_execute_owned_scenarios(self) -> None:
        """The same manifest must still block at execute close."""
        self._write_manifest(
            [
                {
                    "id": "UT-001",
                    "priority": "P1",
                    "ownerPhase": "execute",
                    "requiredEvidenceKind": "ledger",
                    "executableTestId": "unit::ut1",
                    "testFile": "tests/unit.spec.ts",
                    "testTitle": "ut1",
                },
                {
                    "id": "API-001",
                    "priority": "P1",
                    "ownerPhase": "execute",
                    "requiredEvidenceKind": "ledger",
                    "executableTestId": "api::a1",
                    "testFile": "tests/api.spec.ts",
                    "testTitle": "a1",
                },
            ],
            schema_version=2,
        )
        self._write_receipt_ledger(["UT-001"])

        result = gate._validate_scenario_coverage(self.change_dir, "execute")

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "REQUIRED_SCENARIO_NOT_EXECUTED")
        self.assertEqual(result["unexecuted"], ["API-001"])
        self.assertEqual(result["deferred"], [])

    def test_execute_close_ok_when_every_scenario_is_review_owned(self) -> None:
        self._write_manifest(
            [
                {
                    "id": "API-001",
                    "priority": "P0",
                    "ownerPhase": "review",
                    "requiredEvidenceKind": "ledger",
                    "executableTestId": "api::a1",
                    "testFile": "tests/api.spec.ts",
                    "testTitle": "a1",
                }
            ],
            schema_version=2,
        )
        self._write_ledger([])

        result = gate._validate_scenario_coverage(self.change_dir, "execute")

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], "SCENARIO_COVERAGE_DEFERRED")
        self.assertEqual(result["deferred"], ["API-001"])

    def test_scenario_without_owner_phase_stays_due(self) -> None:
        """Legacy manifests without ownerPhase keep the pre-scoping behaviour."""
        self._write_manifest([
            {"id": "LEGACY-1", "priority": "P0", "requiredEvidenceKind": "ledger"},
        ])
        self._write_ledger([])

        result = gate._validate_scenario_coverage(self.change_dir, "run")

        self.assertFalse(result["ok"])
        self.assertEqual(result["missing"], ["LEGACY-1"])

    def test_p1_ledger_scenario_must_be_covered(self) -> None:
        self._write_manifest([
            {
                "id": "UT-001",
                "priority": "P1",
                "ownerPhase": "execute",
                "requiredEvidenceKind": "ledger",
            }
        ])
        self._write_ledger([])

        result = gate._validate_scenario_coverage(self.change_dir)

        self.assertFalse(result["ok"])
        self.assertEqual(result["missing"], ["UT-001"])

    def test_p1_cannot_downgrade_required_evidence_to_advisory(self) -> None:
        self._write_manifest([
            {
                "id": "UT-ADVISORY",
                "priority": "P1",
                "ownerPhase": "execute",
                "requiredEvidenceKind": "advisory",
            }
        ])
        self._write_ledger([])

        result = gate._validate_scenario_coverage(self.change_dir)

        self.assertFalse(result["ok"])
        self.assertEqual(result["missing"], ["UT-ADVISORY"])

    def test_schema_v2_rejects_scenario_ids_without_execution_receipt(self) -> None:
        self._write_manifest(
            [
                {
                    "id": "UT-RECEIPT",
                    "priority": "P0",
                    "ownerPhase": "execute",
                    "requiredEvidenceKind": "ledger",
                    "executableTestId": "unit::receipt",
                    "testFile": "tests/unit.spec.ts",
                    "testTitle": "records exact execution",
                }
            ],
            schema_version=2,
        )
        self._write_ledger(["UT-RECEIPT"])

        result = gate._validate_scenario_coverage(self.change_dir)

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "REQUIRED_SCENARIO_NOT_EXECUTED")
        self.assertEqual(result["unexecuted"], ["UT-RECEIPT"])

    def test_schema_v2_accepts_exact_passed_execution_receipt(self) -> None:
        scenario = {
            "id": "UT-RECEIPT",
            "priority": "P0",
            "ownerPhase": "execute",
            "requiredEvidenceKind": "ledger",
            "executableTestId": "unit::receipt",
            "testFile": "tests/unit.spec.ts",
            "testTitle": "records exact execution",
        }
        self._write_manifest([scenario], schema_version=2)
        self._write_ledger(["UT-RECEIPT"])
        ledger_path = self.change_dir / "evidence" / "verification-ledger.json"
        ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
        ledger["validations"]["unitTest"]["scenarioReceipt"] = {
            "schemaVersion": 1,
            "runner": {"name": "vitest", "version": "3.2.4"},
            "attempt": 2,
            "declared": ["unit::receipt"],
            "selected": ["unit::receipt"],
            "collected": [
                {
                    "testId": "unit::receipt",
                    "file": "tests/unit.spec.ts",
                    "title": "records exact execution",
                }
            ],
            "executed": [
                {
                    "testId": "unit::receipt",
                    "file": "tests/unit.spec.ts",
                    "title": "records exact execution",
                    "attempt": 2,
                    "status": "PASSED",
                }
            ],
        }
        ledger_path.write_text(json.dumps(ledger), encoding="utf-8")

        result = gate._validate_scenario_coverage(self.change_dir)

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["passed"], ["UT-RECEIPT"])
        self.assertEqual(result["attempts"]["UT-RECEIPT"], [2])

    def test_schema_v2_requires_exact_file_and_title_identity(self) -> None:
        scenario = {
            "id": "UT-EXACT",
            "priority": "P0",
            "ownerPhase": "execute",
            "requiredEvidenceKind": "ledger",
            "executableTestId": "unit::exact",
            "testFile": "tests/expected.spec.ts",
            "testTitle": "same title",
        }
        self._write_manifest([scenario], schema_version=2)
        self._write_ledger(["UT-EXACT"])
        ledger_path = self.change_dir / "evidence" / "verification-ledger.json"
        ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
        ledger["validations"]["unitTest"]["scenarioReceipt"] = {
            "schemaVersion": 1,
            "runner": {"name": "vitest"},
            "attempt": 1,
            "declared": ["unit::exact"],
            "selected": ["unit::exact"],
            "collected": [
                {
                    "testId": "unit::exact",
                    "file": "tests/other.spec.ts",
                    "title": "same title",
                }
            ],
            "executed": [
                {
                    "testId": "unit::exact",
                    "file": "tests/other.spec.ts",
                    "title": "same title",
                    "attempt": 1,
                    "status": "PASSED",
                }
            ],
        }
        ledger_path.write_text(json.dumps(ledger), encoding="utf-8")

        result = gate._validate_scenario_coverage(self.change_dir)

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "REQUIRED_SCENARIO_NOT_EXECUTED")
        self.assertEqual(result["unexecuted"], ["UT-EXACT"])

    def test_scenario_coverage_uses_routed_ledger_loader(self) -> None:
        self._write_manifest([
            {
                "id": "UT-ROUTED",
                "priority": "P1",
                "ownerPhase": "execute",
                "requiredEvidenceKind": "ledger",
            }
        ])
        routed_ledger = {
            "validations": {
                "unitTest": {
                    "scenarioIds": ["UT-ROUTED"],
                }
            }
        }

        with mock.patch.object(
            gate.hl,
            "load_ledger",
            return_value=(
                routed_ledger,
                self.project
                / ".harness"
                / "state"
                / "changes"
                / "demo"
                / "evidence"
                / "verification-ledger.json",
            ),
        ) as load_ledger:
            result = gate._validate_scenario_coverage(self.change_dir)

        self.assertTrue(result["ok"], result)
        load_ledger.assert_called_once_with(self.change_dir)

    def test_close_skips_coverage_when_manifest_missing(self) -> None:
        # No scenario-manifest.json — skip coverage check (backward compat)
        self._write_ledger([])

        args = self._close_args()
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value={
                 "ok": True, "changeId": "demo", "changeDir": str(self.change_dir)
             }), \
             mock.patch.object(gate.hc, "inspect_lease", return_value={"runId": "run-1", "phase": "execute"}), \
             mock.patch.object(gate, "validate_ledger_for_phase_close", return_value={"ok": True}), \
             mock.patch.object(gate, "load_phase_capsule", return_value=None), \
             mock.patch.object(gate, "resolve_execution_root", return_value=self.project), \
             mock.patch.object(gate.htg, "close", return_value={"ok": True}), \
             mock.patch.object(gate, "append_phase_event", return_value={"ok": True}), \
             mock.patch.object(gate.hc, "release_lease", return_value={"ok": True}), \
             mock.patch("sys.stdout"):
            code = gate.cmd_close(args)
        self.assertEqual(code, 0)

    def test_close_finishes_handoff_and_remote_sync_in_one_command(self) -> None:
        args = gate.build_parser().parse_args([
            "close", "--phase", "execute", "--change", "demo",
            "--status", "OK", "--run-id", "run-1",
            "--to-phase", "execute", "--artifact", "evidence/verification-ledger.json",
            "--json",
        ])
        emitted: list[dict] = []
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value={
                 "ok": True, "changeId": "demo", "changeDir": str(self.change_dir)
             }), \
             mock.patch.object(gate.hc, "inspect_lease", return_value={"runId": "run-1", "phase": "execute"}), \
             mock.patch.object(gate, "validate_ledger_for_phase_close", return_value={"ok": True}), \
             mock.patch.object(gate, "load_phase_capsule", return_value=None), \
             mock.patch.object(gate, "resolve_execution_root", return_value=self.project), \
             mock.patch.object(gate.htg, "close", return_value={"ok": True}), \
             mock.patch.object(gate, "append_phase_event", return_value={"ok": True}), \
             mock.patch.object(gate.hc, "release_lease", return_value={"ok": True}), \
             mock.patch.object(gate.hctx, "close_transition", return_value={
                 "ok": True, "code": "TRANSITION_CLOSED", "receipt": {"receiptHash": "sha256:test"}
             }) as close_context, \
             mock.patch.object(gate.hes, "auto_events_sync", return_value={
                 "ok": True, "code": "EVENTS_SYNCED"
             }) as sync, \
             mock.patch.object(gate, "emit", side_effect=lambda payload, **_kwargs: emitted.append(payload)):
            code = gate.cmd_close(args)

        self.assertEqual(code, 0)
        close_context.assert_called_once_with(
            self.project,
            "demo",
            from_phase="execute",
            to_phase="execute",
            executor=None,
            artifacts=["evidence/verification-ledger.json"],
            status="OK",
        )
        sync.assert_called_once_with(self.project, self.change_dir)
        self.assertEqual(emitted[0]["contextHandoff"]["code"], "TRANSITION_CLOSED")
        self.assertEqual(emitted[0]["platformMonitor"]["code"], "EVENTS_SYNCED")


class V2ArtifactManifestTests(unittest.TestCase):
    """v2 plan finalize 写的 scenario-manifest 是 artifact 包装，键名与门禁消费的不同。

    包装体是 {artifact_type, content_hash, artifact_id, content:{scenarios, coverage}}。
    v2 场景契约补齐 priority/owner_phase/required_evidence_kind 之后，门禁改为
    **解包**成 legacy 形状再判定；字段不齐仍然 fail-closed。

    两个方向都要冻结：能消费的必须真能消费（否则 v2 计划永远走不完证据闭环），
    不能消费的必须点名缺口——既不能报含糊的 SCENARIO_MANIFEST_INVALID 把调用方
    推去读门禁源码，更不能因为 required_ids 算成空集而静默放行。
    """

    def setUp(self) -> None:
        self.project = Path(tempfile.mkdtemp(prefix="harness-gate-v2man-"))
        self.change_dir = self.project / ".harness" / "changes" / "demo"
        (self.change_dir / "meta").mkdir(parents=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.project, ignore_errors=True)

    @staticmethod
    def _scenario(scenario_id: str, **overrides: Any) -> dict:
        base = {
            "scenario_id": scenario_id,
            "coverage_dimension": "normal_path",
            "execution_level": "unit",
            "evidence_requirements": ["focused_test"],
            "risk_level": "medium",
            "priority": "P0",
            "owner_phase": "execute",
            "required_evidence_kind": "ledger",
            "executable_test_id": f"unit::{scenario_id}",
            "test_file": "tests/unit.spec.ts",
            "test_title": scenario_id,
            "task_refs": ["T1"],
            "requirement_refs": ["requirement:x"],
        }
        base.update(overrides)
        return {k: v for k, v in base.items() if v is not None}

    def _write_v2_manifest(self, *scenarios: dict) -> None:
        (self.change_dir / "meta" / "scenario-manifest.json").write_text(
            json.dumps({
                "artifact_type": "scenario_manifest",
                "content_hash": "sha256:" + "a" * 64,
                "artifact_id": "plan_artifact:scenario_manifest:" + "a" * 64,
                "content": {"scenarios": list(scenarios), "coverage": []},
            }) + "\n",
            encoding="utf-8",
        )

    def test_complete_v2_manifest_is_unpacked_and_consumed(self) -> None:
        """字段齐全的 v2 manifest 必须真能喂进门禁，而不是继续被拒。"""
        self._write_v2_manifest(self._scenario("UT-001"))

        result = gate._validate_scenario_coverage(self.change_dir, "run")

        # ledger 场景无收据 → 覆盖不足，但**不是**"格式不可消费"。
        self.assertNotEqual(result.get("code"), "SCENARIO_MANIFEST_V2_UNSUPPORTED")
        # 更要紧的是它没有被算成空集静默放行。
        self.assertNotEqual(result.get("code"), "NO_LEDGER_REQUIRED_SCENARIOS")
        self.assertFalse(result["ok"], result)

    def test_legacy_shaped_v2_manifest_defers_review_owned_scenarios(self) -> None:
        """解包后 ownerPhase 分区照常工作——这是 v2 契约真的接上了的证据。"""
        self._write_v2_manifest(self._scenario("UT-001", owner_phase="review"))

        result = gate._validate_scenario_coverage(self.change_dir, "execute")

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], "SCENARIO_COVERAGE_DEFERRED")

    def test_v2_manifest_without_the_new_fields_still_fails_closed(self) -> None:
        """旧 v2 产物（补字段之前发布的）必须继续点名缺口。"""
        self._write_v2_manifest(self._scenario(
            "UT-001", priority=None, owner_phase=None, required_evidence_kind=None,
        ))

        result = gate._validate_scenario_coverage(self.change_dir, "run")

        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "SCENARIO_MANIFEST_V2_UNSUPPORTED")
        for field in ("priority", "ownerPhase", "requiredEvidenceKind"):
            self.assertIn(field, result["missingFields"])

    def test_one_incomplete_scenario_fails_the_whole_manifest(self) -> None:
        """逐场景校验，不是取键的并集。

        并集只要有一条场景带了 priority 就算 present，其余缺 priority 的场景会
        静默落进非必需集，required_ids 随之缩水——那正是把证据门禁悄悄关掉。
        """
        self._write_v2_manifest(
            self._scenario("UT-001"),
            self._scenario("UT-002", priority=None),
        )

        result = gate._validate_scenario_coverage(self.change_dir, "run")

        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "SCENARIO_MANIFEST_V2_UNSUPPORTED")
        self.assertIn("priority", result["missingFields"])

    def test_missing_executable_triple_downgrades_instead_of_failing(self) -> None:
        """可执行三元是可选的：缺了只降到 schemaVersion 1，不是缺口。"""
        unpacked = hpf.unpack_v2_scenario_manifest({
            "artifact_type": "scenario_manifest",
            "content": {"scenarios": [self._scenario(
                "UT-001", executable_test_id=None, test_file=None, test_title=None,
            )], "coverage": []},
        })

        self.assertTrue(unpacked["ok"], unpacked)
        self.assertEqual(unpacked["manifest"]["schemaVersion"], 1)

    def test_complete_executable_triple_yields_schema_v2(self) -> None:
        unpacked = hpf.unpack_v2_scenario_manifest({
            "artifact_type": "scenario_manifest",
            "content": {"scenarios": [self._scenario("UT-001")], "coverage": []},
        })

        self.assertTrue(unpacked["ok"], unpacked)
        self.assertEqual(unpacked["manifest"]["schemaVersion"], 2)
        self.assertEqual(unpacked["manifest"]["scenarios"][0]["id"], "UT-001")

    def test_legacy_manifest_is_left_alone(self) -> None:
        self.assertIsNone(hpf.unpack_v2_scenario_manifest(
            {"schemaVersion": 2, "changeName": "demo", "scenarios": []}
        ))


class CheckpointShapeTests(unittest.TestCase):
    """meta/implementation-checkpoints.json 有三个写入者，形状各不相同。

    harness_change.migrate 写 checkpoints[{id,status}]；legacy plan finalize 写顶层
    foundationGate；v2 plan finalize 写 artifact 包装体，状态在 content.foundation_gate。
    以前只认第一种，另外两种一律 "missing" ——checkpoint 状态对整条 v2 路径和
    legacy finalize 之后都是读不出来的。
    """

    def test_migrate_shape_is_read(self) -> None:
        doc = {"schemaVersion": 1, "checkpoints": [
            {"id": "foundation-gate", "status": "pending"}]}

        self.assertEqual(gate.checkpoint_status(doc, "foundation-gate"), "pending")

    def test_legacy_finalizer_shape_is_read(self) -> None:
        doc = {"schemaVersion": 1, "changeName": "demo", "tasks": [],
               "foundationGate": "approved"}

        self.assertEqual(gate.checkpoint_status(doc, "foundation-gate"), "approved")

    def test_v2_artifact_wrapper_is_read(self) -> None:
        doc = {
            "schema_version": 2,
            "artifact_type": "implementation_checkpoints",
            "content": {"tasks": [], "foundation_gate": "approved"},
        }

        self.assertEqual(gate.checkpoint_status(doc, "foundation-gate"), "approved")

    def test_a_pending_v2_wrapper_still_blocks(self) -> None:
        """这才是要紧的：包装体里状态不是 approved 时，门必须关着。"""
        doc = {
            "schema_version": 2,
            "artifact_type": "implementation_checkpoints",
            "content": {"tasks": [], "foundation_gate": "pending"},
        }

        self.assertEqual(gate.checkpoint_status(doc, "foundation-gate"), "pending")

    def test_an_explicit_checkpoints_list_wins_over_the_fallback(self) -> None:
        """有 checkpoints[] 时以它为准，不去看顶层回退字段。"""
        doc = {"schemaVersion": 1, "foundationGate": "approved",
               "checkpoints": [{"id": "foundation-gate", "status": "pending"}]}

        self.assertEqual(gate.checkpoint_status(doc, "foundation-gate"), "pending")

    def test_other_checkpoint_ids_do_not_borrow_the_foundation_fallback(self) -> None:
        doc = {"schemaVersion": 1, "foundationGate": "approved"}

        self.assertEqual(gate.checkpoint_status(doc, "some-other-gate"), "missing")

    def test_load_checkpoints_returns_the_document_verbatim(self) -> None:
        """归一化只能发生在只读路径上。

        cmd_checkpoint approve 会把 load_checkpoints 的返回值原样写回盘——返回
        合成结构会用它覆盖 v2 的哈希绑定产物，直接造成 ARTIFACT_HASH_DRIFT。
        """
        project = Path(tempfile.mkdtemp(prefix="harness-cp-shape-"))
        self.addCleanup(shutil.rmtree, project, True)
        change_dir = project / ".harness" / "changes" / "demo"
        (change_dir / "meta").mkdir(parents=True)
        wrapper = {
            "schema_version": 2,
            "artifact_type": "implementation_checkpoints",
            "content_hash": "sha256:" + "a" * 64,
            "content": {"tasks": [], "foundation_gate": "approved"},
        }
        (change_dir / gate.CHECKPOINTS_REL).write_text(
            json.dumps(wrapper), encoding="utf-8")

        loaded = gate.load_checkpoints(change_dir)

        self.assertEqual(loaded, wrapper)
        self.assertNotIn("checkpoints", loaded)


class PhaseGateRuleTableTests(unittest.TestCase):
    """每阶段在 begin/close 里额外做什么，集中声明在一张表里。

    以前这些是 cmd_begin / cmd_close 里散落的 `if args.phase == ...`——两个五百行
    的函数，想知道"test 关门时到底跑哪几项"要通读全文。
    """

    def test_the_table_covers_every_workflow_phase(self) -> None:
        """漏一个阶段就等于悄悄关掉它的门禁，而不是报错。"""
        self.assertEqual(
            set(gate.PHASE_GATE_RULES), set(gate.hp.WORKFLOW_PHASES)
        )

    def test_every_declared_rule_is_one_the_code_reads(self) -> None:
        """表里写了但没人读的开关是死规则，比缺规则更难发现。"""
        known = {
            "plan_handoff", "test_guard", "scenario_coverage", "ledger_blocking",
            "review_outputs", "head_may_advance", "projection_drift",
        }
        declared = set().union(*gate.PHASE_GATE_RULES.values())
        self.assertEqual(declared, known)

    def test_rules_match_the_behaviour_they_replaced(self) -> None:
        """逐条对齐重构前的内联条件，确认这是行为保持的改写。"""
        expected = {
            "plan_handoff": {"execute"},
            "test_guard": {"execute"},
            "scenario_coverage": {"execute"},
            "ledger_blocking": {"execute", "package"},
            "review_outputs": {"review"},
            "head_may_advance": {"execute", "submit", "merge"},
            "projection_drift": {"submit", "archive"},
        }
        for rule, phases in expected.items():
            actual = {
                phase for phase in gate.hp.WORKFLOW_PHASES
                if gate.phase_gate_rule(phase, rule)
            }
            self.assertEqual(actual, phases, rule)

    def test_release_and_deploy_still_count_as_projection_boundaries(self) -> None:
        """release/deploy 不在 WORKFLOW_PHASES 里，但 projection 门禁按发布阶段对待。"""
        for phase in ("release", "deploy"):
            self.assertTrue(gate.phase_gate_rule(phase, "projection_drift"), phase)

    def test_an_unknown_phase_enables_nothing(self) -> None:
        """未知阶段 fail-safe：不启用任何能力，而不是意外命中某一项。"""
        for rule in ("plan_handoff", "test_guard", "ledger_blocking", "review_outputs"):
            self.assertFalse(gate.phase_gate_rule("teleport", rule), rule)
            self.assertFalse(gate.phase_gate_rule(None, rule), rule)


class FixbackSignalTests(unittest.TestCase):
    """fixback 曾经靠嗅探 note 文本判定，而真正的启动路径根本不写那个词。

    harness_fixback._default_gate_begin 传的 note 是
    "开始处理评审中确认需要修改的代码问题。"——一个 "fixback" 字都没有，于是
    fixback 的 run 事件从来没被打上 trigger/from_phase。
    """

    def test_the_real_launcher_passes_an_explicit_flag(self) -> None:
        import harness_fixback  # noqa: PLC0415

        source = Path(harness_fixback.__file__).read_text(encoding="utf-8")
        launcher = source.split("def _default_gate_begin")[1].split("def ")[0]
        self.assertIn('"--fixback"', launcher)

    def test_the_launcher_note_would_not_survive_text_sniffing(self) -> None:
        """锁住这条 note 里没有 "fixback" ——这正是嗅探判定失效的原因。"""
        import harness_fixback  # noqa: PLC0415

        source = Path(harness_fixback.__file__).read_text(encoding="utf-8")
        launcher = source.split("def _default_gate_begin")[1].split("def ")[0]
        note_line = next(
            line for line in launcher.splitlines()
            if "开始处理评审中确认需要修改的代码问题" in line
        )
        self.assertNotIn("fixback", note_line.lower())

    def test_both_lifecycle_commands_accept_the_flag(self) -> None:
        for phase, extra in (("execute", ["--status", "OK"]), ("execute", [])):
            command = "close" if extra else "begin"
            args = gate.build_parser().parse_args(
                [command, "--phase", phase, "--change", "demo", "--fixback", *extra]
            )
            self.assertTrue(args.fixback)
        # 旧名入参也被接受（归一到 execute）。
        args = gate.build_parser().parse_args(
            ["begin", "--phase", "run", "--change", "demo", "--fixback"]
        )
        self.assertTrue(args.fixback)

    def test_the_flag_is_off_by_default(self) -> None:
        args = gate.build_parser().parse_args(
            ["begin", "--phase", "execute", "--change", "demo"]
        )
        self.assertFalse(args.fixback)


class GateProjectArgumentTests(unittest.TestCase):
    """classify/checkpoint 此前只按 CWD 解析项目根，不接受 --project。

    其他 harness 脚本（doctor/prepare/capture）都把 --project 列为必填，调用方
    按惯例给 gate 传 --project 会被 argparse 直接拒掉——日志里连撞两次才试出来
    要去掉它。begin/close 的 --project 是另一层语义（本阶段执行根/worktree），
    这里不动它们。
    """

    def test_classify_accepts_project_argument(self) -> None:
        parser = gate.build_parser()
        args = parser.parse_args(
            ["classify", "--project", ".", "--change", "demo", "--stage", "plan", "--json"]
        )
        self.assertEqual(args.stage, "plan")
        self.assertEqual(str(args.project), ".")

    def test_checkpoint_accepts_project_argument(self) -> None:
        parser = gate.build_parser()
        args = parser.parse_args(
            ["checkpoint", "status", "--project", ".", "--id", "foundation-gate"]
        )
        self.assertEqual(str(args.project), ".")

    def test_project_argument_stays_optional(self) -> None:
        parser = gate.build_parser()
        args = parser.parse_args(["classify", "--change", "demo", "--stage", "plan"])
        self.assertIsNone(getattr(args, "project", None))

    def test_classify_uses_the_given_project_root(self) -> None:
        project = Path(tempfile.mkdtemp(prefix="harness-gate-proj-"))
        try:
            (project / ".harness" / "changes" / "demo").mkdir(parents=True)
            args = gate.build_parser().parse_args(
                ["classify", "--project", str(project), "--change", "demo", "--stage", "plan"]
            )
            self.assertEqual(gate._resolve_project(args), project.resolve())
        finally:
            shutil.rmtree(project, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
