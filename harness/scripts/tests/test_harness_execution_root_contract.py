#!/usr/bin/env python3
"""Tests for execution-root contract (C3/T8-T11, retro §5.10/5.21).

close must cross-check snapshot, manifest, and git diff; manifest entries
with recordedCount=0 must fail closed instead of silently returning success.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_test_guard as htg  # noqa: E402


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _git(project: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(project), *args],
        capture_output=True,
        text=True,
        check=True,
    ).stdout


def _bootstrap_git_project(tmp: Path) -> Path:
    project = tmp / "project"
    project.mkdir()
    _git(project, "init")
    _write(project / ".gitignore", ".harness/\n")
    _write(project / "tests" / "test_a.py", "def test_a(): pass\n")
    _git(project, "add", ".")
    _git(project, "commit", "-m", "init")
    return project


def _bootstrap_change(project: Path, change_id: str) -> Path:
    change_dir = project / ".harness" / "changes" / change_id
    (change_dir / "meta").mkdir(parents=True, exist_ok=True)
    (change_dir / "evidence").mkdir(parents=True, exist_ok=True)
    (change_dir / "logs").mkdir(parents=True, exist_ok=True)
    _write(
        change_dir / "meta" / "build-profile.json",
        json.dumps({
            "schemaVersion": 2,
            "testTracking": {"include": ["tests/**/*.py"]}
        }),
    )
    return change_dir


class ExecutionRootCloseCrossCheckTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-exec-root-"))
        self.project = _bootstrap_git_project(self.tmp)
        self.change_dir = _bootstrap_change(self.project, "change-a")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_close_fails_closed_when_manifest_has_entries_but_recorded_zero(self) -> None:
        # Begin captures the baseline snapshot.
        htg.begin(self.project, self.change_dir)
        # Add a new test file and record it in the manifest.
        _write(self.project / "tests" / "test_new.py", "def test_new(): pass\n")
        record_result = htg.record(
            self.project,
            self.change_dir,
            [str(self.project / "tests" / "test_new.py")],
            "tdd-created",
        )
        self.assertTrue(record_result.get("ok"), record_result)
        # Tamper with the manifest: keep the recorded entry's reason field
        # but remove the file from the working tree so close's snapshot diff
        # computes recordedCount=0 while the manifest still has an active entry.
        manifest_path = self.change_dir / "evidence" / "test-tracking.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        # Simulate the retro §5.10 scenario: manifest has an active entry but
        # close on a divergent root would compute 0 recorded tests.
        # We remove the test file so snapshot diff no longer sees it as touched.
        (self.project / "tests" / "test_new.py").unlink()
        close_result = htg.close(self.project, self.change_dir)
        # close must not silently return success when the manifest has an
        # active entry but the snapshot diff shows 0 recorded tests.
        self.assertFalse(
            close_result.get("ok"),
            f"close must fail closed when manifest/snapshot diverge: {close_result}",
        )

    def test_close_returns_execution_root_mismatch_before_snapshot_invalid(self) -> None:
        # Begin captures snapshot with project root = main.
        htg.begin(self.project, self.change_dir)
        # Simulate calling close with a different project root (e.g. a
        # worktree path that doesn't match the snapshot's projectRoot).
        # Use a subdirectory of the real project so _change_dir doesn't
        # reject it outright, but the root differs from the snapshot.
        fake_root = self.project / "fake-worktree-root"
        fake_root.mkdir()
        close_result = htg.close(fake_root, self.change_dir)
        # Must return EXECUTION_ROOT_MISMATCH, not the generic SNAPSHOT_INVALID.
        self.assertFalse(close_result.get("ok"))
        self.assertEqual(close_result.get("code"), "EXECUTION_ROOT_MISMATCH")

    def test_close_worktree_to_main_detects_root_mismatch(self) -> None:
        # Linked worktree pattern: snapshot captured in main, close called
        # from a worktree root. The snapshot's projectRoot is main, so close
        # from a different root must detect EXECUTION_ROOT_MISMATCH.
        # We simulate by creating a second project root with its own
        # .harness/changes/change-a but pointing to the same snapshot file
        # (which records main as projectRoot).
        htg.begin(self.project, self.change_dir)
        # Create a second root that shares the change_dir via a copy.
        second_root = self.tmp / "second-root"
        second_root.mkdir()
        second_harness = second_root / ".harness"
        second_harness.mkdir()
        shutil.copytree(
            self.project / ".harness" / "changes",
            second_harness / "changes",
        )
        close_result = htg.close(second_root, second_harness / "changes" / "change-a")
        self.assertFalse(close_result.get("ok"))
        self.assertEqual(close_result.get("code"), "EXECUTION_ROOT_MISMATCH")


if __name__ == "__main__":
    unittest.main()
