#!/usr/bin/env python3
"""Regression tests for exact force-tracking of touched test files."""

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
MODULE_PATH = SCRIPTS_DIR / "harness_test_guard.py"


def load_module():
    spec = importlib.util.spec_from_file_location("harness_test_guard", MODULE_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["harness_test_guard"] = mod
    spec.loader.exec_module(mod)
    return mod


guard = load_module()


class TestGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.project = Path(tempfile.mkdtemp(prefix="test-guard-project-"))
        self.outside = Path(tempfile.mkdtemp(prefix="test-guard-outside-"))
        self.change = self.project / ".harness" / "changes" / "demo"
        self.change.mkdir(parents=True)
        self._write(self.project / ".gitignore", "src/test/\nignored-secret.txt\n")
        self._write(
            self.project / ".harness" / "config" / "build-profile.json",
            json.dumps({"testTracking": {"paths": ["src/test/**"]}}),
        )
        self._git("init")
        self._git("config", "user.email", "test@example.com")
        self._git("config", "user.name", "Test")
        self._git("add", ".gitignore", ".harness/config/build-profile.json")
        self._git("commit", "-m", "baseline")

    def tearDown(self) -> None:
        shutil.rmtree(self.project, ignore_errors=True)
        shutil.rmtree(self.outside, ignore_errors=True)

    @staticmethod
    def _write(path: Path, text: str = "x\n") -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def _git(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["git", "-C", str(self.project), *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
        )

    def _record(self, *files: Path, reason: str = "tdd-created") -> dict:
        return guard.record(
            self.project,
            self.change,
            [str(path) for path in files],
            reason,
        )

    def test_record_ignored_java_test(self) -> None:
        test_file = self.project / "src" / "test" / "java" / "AppTest.java"
        self._write(test_file, "class AppTest {}\n")
        result = self._record(test_file)
        self.assertTrue(result["ok"], result)
        manifest = json.loads((self.change / "evidence" / "test-tracking.json").read_text("utf-8"))
        self.assertEqual(manifest["schemaVersion"], 1)
        self.assertEqual(manifest["mode"], "force-track-touched")
        self.assertEqual(manifest["projectRoot"], str(self.project.resolve()))
        self.assertEqual(manifest["files"][0]["path"], "src/test/java/AppTest.java")
        self.assertTrue(manifest["files"][0]["sha256"].startswith("sha256:"))
        self.assertTrue(manifest["files"][0]["ignored"])
        self.assertFalse(manifest["files"][0]["trackedBefore"])

    def test_record_rejects_production_file(self) -> None:
        production = self.project / "src" / "main" / "java" / "App.java"
        self._write(production)
        result = self._record(production)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "TEST_PATH_NOT_ALLOWED")

    def test_record_rejects_path_outside_project(self) -> None:
        outside = self.outside / "OutsideTest.java"
        self._write(outside)
        result = self._record(outside)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "PATH_OUTSIDE_PROJECT")

    def test_record_is_idempotent(self) -> None:
        test_file = self.project / "src" / "test" / "java" / "AppTest.java"
        self._write(test_file)
        self.assertTrue(self._record(test_file)["ok"])
        self.assertTrue(self._record(test_file)["ok"])
        manifest = json.loads((self.change / "evidence" / "test-tracking.json").read_text("utf-8"))
        self.assertEqual(len(manifest["files"]), 1)

    def test_stage_blocks_hash_drift_without_staging_any_file(self) -> None:
        test_file = self.project / "src" / "test" / "java" / "AppTest.java"
        self._write(test_file, "before\n")
        self.assertTrue(self._record(test_file)["ok"])
        self._write(test_file, "after\n")
        result = guard.stage(self.project, self.change)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "HASH_DRIFT")
        self.assertEqual(self._git("diff", "--cached", "--name-only").stdout.strip(), "")

    def test_stage_force_adds_only_manifest_test_file(self) -> None:
        selected = self.project / "src" / "test" / "java" / "SelectedTest.java"
        other = self.project / "src" / "test" / "java" / "OtherTest.java"
        secret = self.project / "ignored-secret.txt"
        for path in (selected, other, secret):
            self._write(path)
        self.assertTrue(self._record(selected)["ok"])
        result = guard.stage(self.project, self.change)
        self.assertTrue(result["ok"], result)
        cached = self._git("diff", "--cached", "--name-only").stdout.splitlines()
        self.assertEqual(cached, ["src/test/java/SelectedTest.java"])


if __name__ == "__main__":
    unittest.main()
