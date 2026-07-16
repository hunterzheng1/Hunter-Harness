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


if __name__ == "__main__":
    unittest.main()
