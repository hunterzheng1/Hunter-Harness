#!/usr/bin/env python3
"""Regression tests for harness_change.py (UT-017, UT-019)."""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]


def load_module(name: str, filename: str):
    path = SCRIPTS_DIR / filename
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


change = load_module("harness_change", "harness_change.py")


class HarnessChangeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.project = Path(tempfile.mkdtemp(prefix="harness-change-project-"))
        self.changes = self.project / ".harness" / "changes"
        (self.changes / "alpha").mkdir(parents=True)
        (self.changes / "beta").mkdir(parents=True)
        self._git_init()

    def tearDown(self) -> None:
        shutil.rmtree(self.project, ignore_errors=True)

    def _git_init(self) -> None:
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
        subprocess.run(["git", "add", "README.md"], cwd=self.project, check=True, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "init"],
            cwd=self.project,
            check=True,
            capture_output=True,
        )

    def test_resolve_single_active_change_without_flag(self) -> None:
        shutil.rmtree(self.changes / "beta")
        payload = change.resolve_change(self.project, None)
        self.assertTrue(payload["ok"], payload)
        self.assertEqual(payload["changeId"], "alpha")
        self.assertTrue(payload.get("autoSelected"))

    def test_resolve_multiple_active_requires_selection_ut017(self) -> None:
        payload = change.resolve_change(self.project, None)
        self.assertFalse(payload["ok"], payload)
        self.assertEqual(payload["code"], "CHANGE_SELECTION_REQUIRED")
        ids = {item["changeId"] for item in payload["activeChanges"]}
        self.assertEqual(ids, {"alpha", "beta"})
        self.assertNotIn("autoSelected", payload)

    def test_resolve_missing_change_does_not_create_dir(self) -> None:
        missing = "ghost-change"
        payload = change.resolve_change(self.project, missing)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["code"], "CHANGE_NOT_FOUND")
        self.assertFalse((self.changes / missing).exists())

    def test_claim_conflict_same_change_ut019(self) -> None:
        first = change.claim_lease(
            self.project,
            change_id="alpha",
            phase="run",
            run_id="run-a",
            ttl_seconds=3600,
        )
        second = change.claim_lease(
            self.project,
            change_id="alpha",
            phase="run",
            run_id="run-b",
            ttl_seconds=3600,
        )
        self.assertTrue(first["ok"], first)
        self.assertFalse(second["ok"], second)
        self.assertEqual(second["code"], "LEASE_CONFLICT")

    def test_parallel_claim_different_changes(self) -> None:
        first = change.claim_lease(
            self.project,
            change_id="alpha",
            phase="run",
            run_id="run-a",
            ttl_seconds=3600,
        )
        second = change.claim_lease(
            self.project,
            change_id="beta",
            phase="run",
            run_id="run-b",
            ttl_seconds=3600,
        )
        self.assertTrue(first["ok"], first)
        self.assertTrue(second["ok"], second)

    def test_migrate_writes_checkpoints_without_touching_business_files(self) -> None:
        plan = self.changes / "alpha" / "plans" / "demo.md"
        plan.parent.mkdir(parents=True, exist_ok=True)
        plan.write_text("# unchanged plan\n", encoding="utf-8")
        before = plan.read_text(encoding="utf-8")
        payload = change.migrate_change(self.project, "alpha")
        self.assertTrue(payload["ok"], payload)
        checkpoints = self.changes / "alpha" / "meta" / "implementation-checkpoints.json"
        self.assertTrue(checkpoints.is_file())
        data = json.loads(checkpoints.read_text(encoding="utf-8"))
        self.assertEqual(data["checkpoints"][0]["id"], "foundation-gate")
        self.assertEqual(plan.read_text(encoding="utf-8"), before)

    def test_cli_help(self) -> None:
        proc = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "harness_change.py"), "--help"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("resolve", proc.stdout)


if __name__ == "__main__":
    unittest.main()
