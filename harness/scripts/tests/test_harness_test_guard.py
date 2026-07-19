#!/usr/bin/env python3
"""Regression tests for exact force-tracking of touched test files."""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

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

    def _index_path(self) -> Path:
        value = self._git("rev-parse", "--git-path", "index").stdout.strip()
        path = Path(value)
        return path if path.is_absolute() else self.project / path

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

    def test_begin_allows_main_state_dir_from_linked_worktree(self) -> None:
        worktree = self.outside / "feature-worktree"
        self._git("worktree", "add", "-b", "feature-test-guard", str(worktree))
        try:
            result = guard.begin(worktree, self.change)
            self.assertTrue(result["ok"], result)
            self.assertEqual(result["code"], "SNAPSHOT_CAPTURED")
        finally:
            self._git("worktree", "remove", "--force", str(worktree))

    def test_record_empty_files_does_not_write_manifest(self) -> None:
        result = self._record()
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "EMPTY_FILES")
        self.assertFalse((self.change / "evidence" / "test-tracking.json").exists())

    def test_fallback_rejects_test_named_production_file(self) -> None:
        (self.project / ".harness" / "config" / "build-profile.json").unlink()
        production = self.project / "src" / "main" / "java" / "AppTest.java"
        self._write(production)
        result = self._record(production)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "TEST_PATH_NOT_ALLOWED")

    def test_record_is_idempotent(self) -> None:
        test_file = self.project / "src" / "test" / "java" / "AppTest.java"
        self._write(test_file)
        self.assertTrue(self._record(test_file)["ok"])
        self.assertTrue(self._record(test_file)["ok"])
        manifest = json.loads((self.change / "evidence" / "test-tracking.json").read_text("utf-8"))
        self.assertEqual(len(manifest["files"]), 1)

    def test_concurrent_record_keeps_every_entry(self) -> None:
        files = [
            self.project / "src" / "test" / "java" / f"Concurrent{i}Test.java"
            for i in range(8)
        ]
        for path in files:
            self._write(path)
        with ThreadPoolExecutor(max_workers=len(files)) as executor:
            results = list(executor.map(lambda path: self._record(path), files))
        self.assertTrue(all(result["ok"] for result in results), results)
        manifest = json.loads((self.change / "evidence" / "test-tracking.json").read_text("utf-8"))
        self.assertEqual(len(manifest["files"]), len(files))

    def test_exclusive_lock_retries_transient_windows_permission_error(self) -> None:
        lock_path = self.change / "evidence" / "transient.lock"
        real_open = guard.os.open
        attempts = 0

        def flaky_open(*args, **kwargs):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise PermissionError("Windows delete-pending lock file")
            return real_open(*args, **kwargs)

        with mock.patch.object(guard.os, "open", side_effect=flaky_open):
            with guard._exclusive_lock(lock_path, wait_seconds=0.2):
                self.assertTrue(lock_path.exists())
        self.assertEqual(attempts, 2)

    def test_record_rejects_tampered_existing_manifest(self) -> None:
        first = self.project / "src" / "test" / "java" / "FirstTest.java"
        second = self.project / "src" / "test" / "java" / "SecondTest.java"
        self._write(first)
        self._write(second)
        self.assertTrue(self._record(first)["ok"])
        manifest_path = self.change / "evidence" / "test-tracking.json"
        manifest = json.loads(manifest_path.read_text("utf-8"))
        manifest["schemaVersion"] = 99
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        result = self._record(second)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "MANIFEST_INVALID")

    def test_record_rejects_evidence_symlink_outside_project(self) -> None:
        evidence = self.change / "evidence"
        try:
            evidence.symlink_to(self.outside, target_is_directory=True)
        except OSError as exc:
            self.skipTest(f"directory symlink unavailable: {exc}")
        test_file = self.project / "src" / "test" / "java" / "AppTest.java"
        self._write(test_file)
        result = self._record(test_file)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "MANIFEST_PATH_OUTSIDE_PROJECT")
        self.assertFalse((self.outside / "test-tracking.json").exists())

    def test_record_rejects_evidence_symlink_to_other_change(self) -> None:
        other_evidence = self.project / ".harness" / "changes" / "other" / "evidence"
        other_evidence.mkdir(parents=True)
        evidence = self.change / "evidence"
        try:
            evidence.symlink_to(other_evidence, target_is_directory=True)
        except OSError as exc:
            self.skipTest(f"directory symlink unavailable: {exc}")
        test_file = self.project / "src" / "test" / "java" / "AppTest.java"
        self._write(test_file)
        result = self._record(test_file)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "MANIFEST_PATH_OUTSIDE_PROJECT")
        self.assertFalse((other_evidence / "test-tracking.json").exists())

    def test_profile_excluded_root_rejects_colocated_test_pattern(self) -> None:
        self._write(
            self.project / ".harness" / "config" / "build-profile.json",
            json.dumps(
                {
                    "excludedRoots": ["node_modules", ".git", ".harness", "build", "dist"],
                    "testTracking": {"paths": ["**/*.test.js"]},
                }
            ),
        )
        excluded_test = self.project / "node_modules" / "pkg" / "escape.test.js"
        self._write(excluded_test)
        result = self._record(excluded_test)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "TEST_PATH_NOT_ALLOWED")

    def test_begin_prunes_excluded_roots_before_recursive_hashing(self) -> None:
        self._write(
            self.project / ".harness" / "config" / "build-profile.json",
            json.dumps(
                {
                    "excludedRoots": ["node_modules", ".git", ".harness"],
                    "testTracking": {"paths": ["**/*.test.js"]},
                }
            ),
        )
        included = self.project / "src" / "included.test.js"
        excluded = self.project / "node_modules" / "pkg" / "excluded.test.js"
        self._write(included)
        self._write(excluded)
        hashed: list[Path] = []
        real_sha256 = guard._sha256

        def recording_sha256(path: Path) -> str:
            hashed.append(path)
            return real_sha256(path)

        with mock.patch.object(guard, "_sha256", side_effect=recording_sha256):
            result = guard.begin(self.project, self.change)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["files"], ["src/included.test.js"])
        self.assertIn(included.resolve(), hashed)
        self.assertNotIn(excluded.resolve(), hashed)

    @unittest.skipUnless(os.name == "nt", "Windows path comparison regression")
    def test_profile_excluded_root_rejects_case_variant_on_windows(self) -> None:
        self._write(
            self.project / ".harness" / "config" / "build-profile.json",
            json.dumps(
                {
                    "excludedRoots": ["node_modules"],
                    "testTracking": {"paths": ["**/*.test.js"]},
                }
            ),
        )
        excluded_test = self.project / "NODE_MODULES" / "pkg" / "secret.test.js"
        self._write(excluded_test)
        result = self._record(excluded_test)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "TEST_PATH_NOT_ALLOWED")
        self.assertFalse((self.change / "evidence" / "test-tracking.json").exists())

    def test_stage_blocks_hash_drift_without_staging_any_file(self) -> None:
        test_file = self.project / "src" / "test" / "java" / "AppTest.java"
        self._write(test_file, "before\n")
        self.assertTrue(self._record(test_file)["ok"])
        self._write(test_file, "after\n")
        result = guard.stage(self.project, self.change)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "HASH_DRIFT")
        self.assertEqual(self._git("diff", "--cached", "--name-only").stdout.strip(), "")

    def test_stage_respects_existing_git_index_lock(self) -> None:
        test_file = self.project / "src" / "test" / "java" / "AppTest.java"
        self._write(test_file)
        self.assertTrue(self._record(test_file)["ok"])
        index_path = self._index_path()
        before = index_path.read_bytes()
        lock_path = index_path.with_name(index_path.name + ".lock")
        lock_path.write_bytes(b"concurrent git operation")
        try:
            result = guard.stage(self.project, self.change)
        finally:
            lock_path.unlink(missing_ok=True)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "INDEX_LOCKED")
        self.assertEqual(index_path.read_bytes(), before)

    def test_stage_holds_manifest_lock_through_index_commit(self) -> None:
        first = self.project / "src" / "test" / "java" / "FirstTest.java"
        second = self.project / "src" / "test" / "java" / "SecondTest.java"
        self._write(first)
        self._write(second)
        self.assertTrue(self._record(first)["ok"])

        add_entered = threading.Event()
        allow_add = threading.Event()
        real_git = guard._git

        def paused_git(project, *args, **kwargs):
            if args and args[0] == "add" and kwargs.get("index_file") is not None:
                add_entered.set()
                self.assertTrue(allow_add.wait(timeout=5))
            return real_git(project, *args, **kwargs)

        with mock.patch.object(guard, "_git", side_effect=paused_git):
            with ThreadPoolExecutor(max_workers=2) as executor:
                stage_future = executor.submit(guard.stage, self.project, self.change)
                self.assertTrue(add_entered.wait(timeout=5))
                record_future = executor.submit(self._record, second)
                time.sleep(0.1)
                self.assertFalse(record_future.done(), "record escaped the manifest lock")
                allow_add.set()
                stage_result = stage_future.result(timeout=5)
                record_result = record_future.result(timeout=6)

        self.assertTrue(stage_result["ok"], stage_result)
        self.assertFalse(record_result["ok"], record_result)
        manifest = json.loads(
            (self.change / "evidence" / "test-tracking.json").read_text("utf-8")
        )
        self.assertEqual([item["path"] for item in manifest["files"]], ["src/test/java/FirstTest.java"])

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

    def test_stage_treats_magic_filename_as_literal_pathspec(self) -> None:
        selected = self.project / "src" / "test" / "java" / "Selected[Test].java"
        glob_match = self.project / "src" / "test" / "java" / "SelectedT.java"
        unrelated = self.project / "src" / "test" / "java" / "UnrelatedTest.java"
        for path in (selected, glob_match, unrelated):
            self._write(path)
        self.assertTrue(self._record(selected)["ok"])
        result = guard.stage(self.project, self.change)
        self.assertTrue(result["ok"], result)
        cached = self._git("diff", "--cached", "--name-only").stdout.splitlines()
        self.assertEqual(cached, ["src/test/java/Selected[Test].java"])

    def test_stage_rejects_malformed_manifest_without_changing_index(self) -> None:
        unrelated = self.project / "unrelated.txt"
        self._write(unrelated)
        self._git("add", "unrelated.txt")
        index_path = self._index_path()
        before = index_path.read_bytes()

        test_file = self.project / "src" / "test" / "java" / "AppTest.java"
        self._write(test_file)
        self.assertTrue(self._record(test_file)["ok"])
        manifest_path = self.change / "evidence" / "test-tracking.json"
        manifest = json.loads(manifest_path.read_text("utf-8"))
        manifest["files"][0]["reason"] = "not-allowed"
        manifest["files"][0]["ignored"] = "yes"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        result = guard.stage(self.project, self.change)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "MANIFEST_INVALID")
        self.assertEqual(index_path.read_bytes(), before)
        self.assertEqual(
            self._git("diff", "--cached", "--name-only").stdout.splitlines(),
            ["unrelated.txt"],
        )

    def test_begin_close_auto_tracks_new_ignored_test_ut027(self) -> None:
        preexisting = self.project / "src" / "test" / "java" / "ExistingTest.java"
        self._write(preexisting, "class Existing {}\n")
        begin = guard.begin(self.project, self.change)
        self.assertTrue(begin["ok"], begin)
        created = self.project / "src" / "test" / "java" / "NewTest.java"
        self._write(created, "class New {}\n")
        close = guard.close(self.project, self.change)
        self.assertTrue(close["ok"], close)
        self.assertIn("src/test/java/NewTest.java", close["files"])
        manifest = json.loads((self.change / "evidence" / "test-tracking.json").read_text("utf-8"))
        paths = {item["path"]: item["reason"] for item in manifest["files"]}
        self.assertEqual(paths["src/test/java/NewTest.java"], "tdd-created")
        self.assertNotIn("src/test/java/ExistingTest.java", paths)

    def test_begin_reuses_existing_snapshot_instead_of_recapturing(self) -> None:
        target = self.project / "src" / "test" / "java" / "StableTest.java"
        self._write(target, "before\n")
        first = guard.begin(self.project, self.change)
        self.assertTrue(first["ok"], first)
        snapshot_path = Path(first["snapshotPath"])
        before = snapshot_path.read_bytes()
        self._write(target, "after\n")

        second = guard.begin(self.project, self.change)

        self.assertTrue(second["ok"], second)
        self.assertEqual(second["code"], "SNAPSHOT_REUSED")
        self.assertEqual(snapshot_path.read_bytes(), before)

    def test_rehome_moves_manifest_after_tree_equivalent_merge(self) -> None:
        feature = self.outside / "feature-rehome"
        self._git("worktree", "add", "-b", "feature/rehome", str(feature))
        try:
            target = feature / "src" / "test" / "java" / "RehomeTest.java"
            self._write(target, "class RehomeTest {}\n")
            subprocess.run(
                ["git", "-C", str(feature), "add", "-f", "src/test/java/RehomeTest.java"],
                check=True, capture_output=True,
            )
            subprocess.run(
                ["git", "-C", str(feature), "commit", "-m", "add rehome test"],
                check=True, capture_output=True,
            )
            recorded = guard.record(feature, self.change, [str(target)], "tdd-created")
            self.assertTrue(recorded["ok"], recorded)
            self._git("merge", "--no-ff", "-m", "merge feature", "feature/rehome")
            expected_head = self._git("rev-parse", "HEAD").stdout.strip()

            result = guard.rehome(feature, self.project, self.change, expected_head)

            self.assertTrue(result["ok"], result)
            self.assertEqual(result["code"], "REHOMED")
            self.assertEqual(result["fromRoot"], str(feature.resolve()))
            self.assertEqual(result["toRoot"], str(self.project.resolve()))
            self.assertEqual(result["toHead"], expected_head)
            self.assertIn("manifestHashBefore", result)
            self.assertIn("manifestHashAfter", result)
            manifest = json.loads(
                (self.change / "evidence" / "test-tracking.json").read_text("utf-8")
            )
            self.assertEqual(manifest["projectRoot"], str(self.project.resolve()))
            self.assertEqual(manifest["handoffs"][-1]["toHead"], expected_head)
        finally:
            self._git("worktree", "remove", "--force", str(feature))

    def test_rehome_rejects_wrong_expected_head_without_manifest_drift(self) -> None:
        target = self.project / "src" / "test" / "java" / "RehomeTest.java"
        self._write(target, "class RehomeTest {}\n")
        recorded = self._record(target)
        self.assertTrue(recorded["ok"], recorded)
        manifest_path = self.change / "evidence" / "test-tracking.json"
        before = manifest_path.read_bytes()

        result = guard.rehome(
            self.project, self.project, self.change, "0" * 40
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "EXPECTED_HEAD_MISMATCH")
        self.assertEqual(manifest_path.read_bytes(), before)

    def test_begin_close_auto_tracks_modified_ignored_test_ut028(self) -> None:
        target = self.project / "src" / "test" / "java" / "MutableTest.java"
        self._write(target, "before\n")
        self.assertTrue(guard.begin(self.project, self.change)["ok"])
        self._write(target, "after\n")
        close = guard.close(self.project, self.change)
        self.assertTrue(close["ok"], close)
        manifest = json.loads((self.change / "evidence" / "test-tracking.json").read_text("utf-8"))
        self.assertEqual(len(manifest["files"]), 1)
        self.assertEqual(manifest["files"][0]["reason"], "test-updated")

    def test_preexisting_unchanged_ignored_test_not_tracked_ut030(self) -> None:
        preexisting = self.project / "src" / "test" / "java" / "StableTest.java"
        self._write(preexisting, "stable\n")
        self.assertTrue(guard.begin(self.project, self.change)["ok"])
        close = guard.close(self.project, self.change)
        self.assertTrue(close["ok"], close)
        self.assertEqual(close["recordedCount"], 0)
        self.assertFalse((self.change / "evidence" / "test-tracking.json").exists())

    def test_close_rejects_snapshot_project_mismatch(self) -> None:
        target = self.project / "src" / "test" / "java" / "StableTest.java"
        self._write(target, "stable\n")
        self.assertTrue(guard.begin(self.project, self.change)["ok"])
        snapshot_path = self.change / "evidence" / "test-guard-snapshot.json"
        snapshot = json.loads(snapshot_path.read_text("utf-8"))
        snapshot["projectRoot"] = str(self.outside)
        snapshot_path.write_text(json.dumps(snapshot), encoding="utf-8")
        result = guard.close(self.project, self.change)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "SNAPSHOT_INVALID")


if __name__ == "__main__":
    unittest.main()
