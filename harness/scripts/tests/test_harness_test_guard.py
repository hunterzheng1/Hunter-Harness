#!/usr/bin/env python3
"""Regression tests for exact force-tracking of touched test files."""

from __future__ import annotations

import importlib.util
import hashlib
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


def bounded_test_workers(requested: int) -> int:
    try:
        configured = int(os.environ.get("HARNESS_TEST_MAX_WORKERS", "2"))
    except ValueError:
        configured = 2
    return max(1, min(requested, configured, 2))


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

    def test_confirmed_blocker_begin_uses_common_profile_in_linked_worktree(
        self,
    ) -> None:
        profile = self.project / ".harness" / "config" / "build-profile.json"
        self._write(
            profile,
            json.dumps({"testTracking": {"paths": ["qa/python/**"]}}),
        )
        custom_test = self.project / "qa" / "python" / "test_custom_case.py"
        self._write(custom_test, "def test_custom_case():\n    assert True\n")
        self._git("add", profile.relative_to(self.project), custom_test.relative_to(self.project))
        self._git("commit", "-m", "custom python test profile")

        worktree = self.outside / "common-profile-worktree"
        self._git("worktree", "add", "-b", "feature-common-profile", str(worktree))
        try:
            (worktree / ".harness" / "config" / "build-profile.json").unlink()

            result = guard.begin(worktree, self.change)

            self.assertTrue(result["ok"], result)
            self.assertIn("qa/python/test_custom_case.py", result["files"])
            snapshot = json.loads(Path(result["snapshotPath"]).read_text("utf-8"))
            self.assertIn(
                "qa/python/test_custom_case.py",
                {item["path"] for item in snapshot["files"]},
            )
        finally:
            self._git("worktree", "remove", "--force", str(worktree))

    def test_confirmed_blocker_close_reconciles_incomplete_snapshot_and_v2_ownership(
        self,
    ) -> None:
        paths = {
            name: self.project / "src" / "test" / "java" / f"{name}Test.java"
            for name in (
                "Baseline",
                "Modified",
                "UnchangedCurrent",
                "UnchangedShared",
            )
        }
        for name, path in paths.items():
            self._write(path, f"class {name}Test {{}}\n")
        self._git(
            "add",
            "-f",
            *(path.relative_to(self.project) for path in paths.values()),
        )
        self._git("commit", "-m", "tracked test baseline")
        self._write(
            self.change / "meta" / "change-context.json",
            json.dumps(
                {
                    "schemaVersion": 2,
                    "changeId": "demo",
                    "lifecycle": {"status": "active"},
                }
            ),
        )

        recorded = guard.record(
            self.project,
            self.change,
            [
                str(paths["UnchangedCurrent"]),
                str(paths["UnchangedShared"]),
            ],
            "test-updated",
        )
        self.assertTrue(recorded["ok"], recorded)
        manifest_path = self.change / "evidence" / "test-tracking.json"
        manifest = json.loads(manifest_path.read_text("utf-8"))
        shared = next(
            item
            for item in manifest["files"]
            if item["path"].endswith("UnchangedSharedTest.java")
        )
        shared["introducedBy"] = "other-change"
        shared["touchedBy"] = ["other-change", "demo"]
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        baseline_rel = paths["Baseline"].relative_to(self.project).as_posix()
        baseline_digest = (
            "sha256:" + hashlib.sha256(paths["Baseline"].read_bytes()).hexdigest()
        )
        baseline_commit = self._git("rev-parse", "HEAD").stdout.strip()
        snapshot_path = self.change / "evidence" / "test-guard-snapshot.json"
        self._write(
            snapshot_path,
            json.dumps(
                {
                    "schemaVersion": 1,
                    "mode": "force-track-touched",
                    "projectRoot": str(self.project.resolve()),
                    "repositoryId": guard.harness_paths.repository_identity(
                        self.project
                    ),
                    "headCommit": baseline_commit,
                    "files": [
                        {
                            "path": baseline_rel,
                            "sha256": baseline_digest,
                            "ignored": True,
                        }
                    ],
                }
            ),
        )
        self._write(paths["Modified"], "class ModifiedTest { int changed; }\n")
        created = self.project / "src" / "test" / "java" / "CreatedTest.java"
        self._write(created, "class CreatedTest {}\n")

        close = guard.close(self.project, self.change)

        self.assertTrue(close["ok"], close)
        modified_rel = paths["Modified"].relative_to(self.project).as_posix()
        created_rel = created.relative_to(self.project).as_posix()
        self.assertEqual(set(close["files"]), {modified_rel, created_rel})
        self.assertEqual(close["recordedCount"], 2)

        reconciled = json.loads(manifest_path.read_text("utf-8"))
        by_path = {item["path"]: item for item in reconciled["files"]}
        self.assertEqual(by_path[modified_rel]["reason"], "test-updated")
        self.assertEqual(by_path[created_rel]["reason"], "tdd-created")
        current_only_rel = paths["UnchangedCurrent"].relative_to(
            self.project
        ).as_posix()
        self.assertNotIn(current_only_rel, by_path)
        shared_rel = paths["UnchangedShared"].relative_to(self.project).as_posix()
        self.assertEqual(by_path[shared_rel]["introducedBy"], "other-change")
        self.assertEqual(by_path[shared_rel]["touchedBy"], ["other-change"])
        self.assertEqual(by_path[shared_rel]["commitScope"], "foreign-change")

    def test_review_fixback_begin_rejects_invalid_local_profile_in_linked_worktree(
        self,
    ) -> None:
        tracked_test = self.project / "src" / "test" / "java" / "ProfileTest.java"
        self._write(tracked_test, "class ProfileTest {}\n")
        self._git("add", "-f", tracked_test.relative_to(self.project))
        self._git("commit", "-m", "tracked profile test")

        worktree = self.outside / "invalid-local-profile-worktree"
        self._git("worktree", "add", "-b", "feature-invalid-profile", str(worktree))
        invalid_profiles = {
            "malformed-json": "{",
            "invalid-structure": json.dumps(
                {"testTracking": {"paths": "src/test/**"}}
            ),
        }
        try:
            local_profile = (
                worktree / ".harness" / "config" / "build-profile.json"
            )
            for label, payload in invalid_profiles.items():
                with self.subTest(profile=label):
                    change = (
                        self.project
                        / ".harness"
                        / "changes"
                        / f"invalid-profile-{label}"
                    )
                    change.mkdir(parents=True)
                    self._write(local_profile, payload)

                    result = guard.begin(worktree, change)

                    self.assertFalse(result["ok"], result)
                    self.assertEqual(result["code"], "PROFILE_INVALID")
                    self.assertFalse(
                        (change / "evidence" / "test-guard-snapshot.json").exists()
                    )
        finally:
            self._git("worktree", "remove", "--force", str(worktree))

    def test_review_fixback_close_rebases_profile_without_manifest_drift(
        self,
    ) -> None:
        test_file = self.project / "src" / "test" / "java" / "ChangedTest.java"
        self._write(test_file, "class ChangedTest {}\n")
        self._git("add", "-f", test_file.relative_to(self.project))
        self._git("commit", "-m", "tracked test baseline")
        begin = guard.begin(self.project, self.change)
        self.assertTrue(begin["ok"], begin)

        self._write(test_file, "class ChangedTest { int changed; }\n")
        recorded = self._record(test_file, reason="test-updated")
        self.assertTrue(recorded["ok"], recorded)
        manifest_path = self.change / "evidence" / "test-tracking.json"
        manifest_before = manifest_path.read_bytes()
        self._write(
            self.project / ".harness" / "config" / "build-profile.json",
            json.dumps({"testTracking": {"paths": ["qa/**"]}}),
        )

        close = guard.close(self.project, self.change)

        self.assertTrue(close["ok"], close)
        self.assertTrue(close["profileChanged"])
        self.assertEqual(manifest_path.read_bytes(), manifest_before)

    def test_review_fixback_close_cleans_restored_current_change_provenance(
        self,
    ) -> None:
        test_file = self.project / "src" / "test" / "java" / "RestoredTest.java"
        baseline = "class RestoredTest {}\n"
        self._write(test_file, baseline)
        self._git("add", "-f", test_file.relative_to(self.project))
        self._git("commit", "-m", "tracked test baseline")
        self._write(
            self.change / "meta" / "change-context.json",
            json.dumps(
                {
                    "schemaVersion": 2,
                    "changeId": "demo",
                    "lifecycle": {"status": "active"},
                }
            ),
        )
        begin = guard.begin(self.project, self.change)
        self.assertTrue(begin["ok"], begin)

        self._write(test_file, "class RestoredTest { int changed; }\n")
        recorded = self._record(test_file, reason="test-updated")
        self.assertTrue(recorded["ok"], recorded)
        manifest_path = self.change / "evidence" / "test-tracking.json"
        recorded_manifest = json.loads(manifest_path.read_text("utf-8"))
        self.assertEqual(recorded_manifest["files"][0]["touchedBy"], ["demo"])
        self.assertEqual(
            recorded_manifest["files"][0]["commitScope"],
            "current-change",
        )

        self._write(test_file, baseline)
        close = guard.close(self.project, self.change)

        self.assertTrue(close["ok"], close)
        self.assertEqual(close["code"], "CLOSED")
        self.assertEqual(close["recordedCount"], 0)
        self.assertEqual(
            close["manifestReconciliation"]["removedCurrentTouches"],
            1,
        )
        self.assertEqual(close["manifestReconciliation"]["deletedEntries"], 1)
        self.assertFalse(manifest_path.exists())

    def test_review_yellow_1_close_rehashes_restored_foreign_entry(
        self,
    ) -> None:
        test_file = self.project / "src" / "test" / "java" / "SharedTest.java"
        baseline = "class SharedTest {}\n"
        self._write(test_file, baseline)
        self._git("add", "-f", test_file.relative_to(self.project))
        self._git("commit", "-m", "tracked shared test baseline")
        self._write(
            self.change / "meta" / "change-context.json",
            json.dumps(
                {
                    "schemaVersion": 2,
                    "changeId": "demo",
                    "lifecycle": {"status": "active"},
                }
            ),
        )
        begin = guard.begin(self.project, self.change)
        self.assertTrue(begin["ok"], begin)

        seeded = self._record(test_file, reason="test-updated")
        self.assertTrue(seeded["ok"], seeded)
        manifest_path = self.change / "evidence" / "test-tracking.json"
        foreign_manifest = json.loads(manifest_path.read_text("utf-8"))
        foreign_entry = foreign_manifest["files"][0]
        foreign_entry["introducedBy"] = "other-change"
        foreign_entry["touchedBy"] = ["other-change"]
        foreign_entry["commitScope"] = "foreign-change"
        guard._write_json(manifest_path, foreign_manifest)

        self._write(test_file, "class SharedTest { int changed; }\n")
        recorded = self._record(test_file, reason="test-updated")
        self.assertTrue(recorded["ok"], recorded)
        shared_manifest = json.loads(manifest_path.read_text("utf-8"))
        shared_entry = shared_manifest["files"][0]
        self.assertEqual(shared_entry["introducedBy"], "other-change")
        self.assertEqual(shared_entry["touchedBy"], ["other-change", "demo"])
        self.assertEqual(shared_entry["commitScope"], "current-change")
        modified_hash = shared_entry["logicalHash"]

        self._write(test_file, baseline)
        rel = test_file.relative_to(self.project).as_posix()
        baseline_hash = guard.logical_file_hash(self.project, rel)
        self.assertNotEqual(modified_hash, baseline_hash)
        close = guard.close(self.project, self.change)

        self.assertTrue(close["ok"], close)
        self.assertEqual(close["code"], "CLOSED")
        self.assertEqual(close["recordedCount"], 0)
        self.assertEqual(
            close["manifestReconciliation"]["removedCurrentTouches"],
            1,
        )
        self.assertEqual(
            close["manifestReconciliation"]["preservedForeignEntries"],
            1,
        )
        manifest_after = json.loads(manifest_path.read_text("utf-8"))
        self.assertEqual(len(manifest_after["files"]), 1)
        entry_after = manifest_after["files"][0]
        self.assertEqual(entry_after["introducedBy"], "other-change")
        self.assertEqual(entry_after["touchedBy"], ["other-change"])
        self.assertEqual(entry_after["commitScope"], "foreign-change")
        self.assertEqual(entry_after["logicalHash"], baseline_hash)
        self.assertEqual(
            entry_after["binaryHash"],
            None if baseline_hash.startswith("gitblob:") else baseline_hash,
        )
        validation_error, validated = guard._validate_existing_manifest_v2(
            self.project,
            manifest_after,
            require_files=False,
        )
        self.assertIsNone(validation_error)
        self.assertIn(rel, validated)

    def test_review_fixback_close_preserves_foreign_only_v2_manifest(
        self,
    ) -> None:
        test_file = self.project / "src" / "test" / "java" / "ForeignTest.java"
        self._write(test_file, "class ForeignTest {}\n")
        self._git("add", "-f", test_file.relative_to(self.project))
        self._git("commit", "-m", "tracked test baseline")
        self._write(
            self.change / "meta" / "change-context.json",
            json.dumps(
                {
                    "schemaVersion": 2,
                    "changeId": "demo",
                    "lifecycle": {"status": "active"},
                }
            ),
        )
        begin = guard.begin(self.project, self.change)
        self.assertTrue(begin["ok"], begin)

        recorded = self._record(test_file, reason="test-updated")
        self.assertTrue(recorded["ok"], recorded)
        manifest_path = self.change / "evidence" / "test-tracking.json"
        manifest_before = json.loads(manifest_path.read_text("utf-8"))
        foreign_entry = manifest_before["files"][0]
        foreign_entry["introducedBy"] = "other-change"
        foreign_entry["touchedBy"] = ["other-change"]
        foreign_entry["commitScope"] = "foreign-change"
        guard._write_json(manifest_path, manifest_before)

        close = guard.close(self.project, self.change)

        self.assertTrue(close["ok"], close)
        self.assertEqual(close["code"], "CLOSED")
        self.assertEqual(close["recordedCount"], 0)
        manifest_after = json.loads(manifest_path.read_text("utf-8"))
        self.assertEqual(manifest_after, manifest_before)

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
        with ThreadPoolExecutor(
            max_workers=bounded_test_workers(len(files))
        ) as executor:
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

    def test_begin_prunes_worktrees_and_nested_dependency_segments(self) -> None:
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
        sibling_worktree = (
            self.project / ".worktrees" / "feature" / "src" / "leak.test.js"
        )
        nested_dependency = (
            self.project / "vendor" / "node_modules" / "pkg" / "leak.test.js"
        )
        for path in (included, sibling_worktree, nested_dependency):
            self._write(path)

        result = guard.begin(self.project, self.change)

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["files"], ["src/included.test.js"])

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
            with ThreadPoolExecutor(
                max_workers=bounded_test_workers(2)
            ) as executor:
                stage_future = executor.submit(guard.stage, self.project, self.change)
                self.assertTrue(add_entered.wait(timeout=5))
                record_future = executor.submit(self._record, second)
                time.sleep(0.1)
                self.assertFalse(record_future.done(), "record escaped the manifest lock")
                allow_add.set()
                stage_result = stage_future.result(timeout=5)
                record_result = record_future.result(timeout=6)

        self.assertTrue(stage_result["ok"], stage_result)
        self.assertTrue(record_result["ok"], record_result)
        manifest = json.loads(
            (self.change / "evidence" / "test-tracking.json").read_text("utf-8")
        )
        self.assertEqual(
            [item["path"] for item in manifest["files"]],
            ["src/test/java/FirstTest.java", "src/test/java/SecondTest.java"],
        )

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

    def test_rebind_snapshot_moves_unchanged_baseline_to_descendant_worktree(self) -> None:
        baseline_test = self.project / "src" / "test" / "java" / "BaselineTest.java"
        self._write(baseline_test, "class BaselineTest {}\n")
        self._git("add", "-f", "src/test/java/BaselineTest.java")
        self._git("commit", "-m", "add baseline test")
        expected_base = self._git("rev-parse", "HEAD").stdout.strip()
        begin = guard.begin(self.project, self.change)
        self.assertTrue(begin["ok"], begin)

        feature = self.outside / "feature-rebind"
        self._git("worktree", "add", "-b", "feature/rebind", str(feature))
        try:
            new_test = feature / "src" / "test" / "java" / "NewTest.java"
            self._write(new_test, "class NewTest {}\n")
            subprocess.run(
                ["git", "-C", str(feature), "add", "-f", "src/test/java/NewTest.java"],
                check=True,
                capture_output=True,
            )
            subprocess.run(
                ["git", "-C", str(feature), "commit", "-m", "add new test"],
                check=True,
                capture_output=True,
            )
            recorded = guard.record(feature, self.change, [str(new_test)], "tdd-created")
            self.assertTrue(recorded["ok"], recorded)

            rebound = guard.rebind_snapshot(
                self.project, feature, self.change, expected_base
            )

            self.assertTrue(rebound["ok"], rebound)
            self.assertEqual(rebound["code"], "SNAPSHOT_REBOUND")
            snapshot = json.loads(
                (self.change / "evidence" / "test-guard-snapshot.json").read_text("utf-8")
            )
            self.assertEqual(snapshot["projectRoot"], str(feature.resolve()))
            self.assertEqual(snapshot["rebinds"][-1]["expectedBase"], expected_base)
            close = guard.close(feature, self.change)
            self.assertTrue(close["ok"], close)
            self.assertEqual(close["files"], ["src/test/java/NewTest.java"])
        finally:
            self._git("worktree", "remove", "--force", str(feature))

    def test_rebind_snapshot_rejects_source_drift_without_mutation(self) -> None:
        baseline_test = self.project / "src" / "test" / "java" / "BaselineTest.java"
        self._write(baseline_test, "before\n")
        self._git("add", "-f", "src/test/java/BaselineTest.java")
        self._git("commit", "-m", "add baseline test")
        expected_base = self._git("rev-parse", "HEAD").stdout.strip()
        begin = guard.begin(self.project, self.change)
        self.assertTrue(begin["ok"], begin)
        snapshot_path = self.change / "evidence" / "test-guard-snapshot.json"
        before = snapshot_path.read_bytes()

        feature = self.outside / "feature-rebind-drift"
        self._git("worktree", "add", "-b", "feature/rebind-drift", str(feature))
        try:
            self._write(baseline_test, "after\n")
            result = guard.rebind_snapshot(
                self.project, feature, self.change, expected_base
            )
            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "SOURCE_SNAPSHOT_DRIFT")
            self.assertEqual(snapshot_path.read_bytes(), before)
        finally:
            self._git("worktree", "remove", "--force", str(feature))

    def test_rebind_snapshot_reconciles_line_ending_only_manifest_entry(self) -> None:
        self._write(self.project / ".gitattributes", "*.java text eol=lf\n")
        baseline_test = self.project / "src" / "test" / "java" / "LineEndingTest.java"
        self._write(baseline_test, "line one\nline two\n")
        self._git("add", ".gitattributes")
        self._git("add", "-f", "src/test/java/LineEndingTest.java")
        self._git("commit", "-m", "add normalized baseline test")
        expected_base = self._git("rev-parse", "HEAD").stdout.strip()
        self.assertTrue(guard.begin(self.project, self.change)["ok"])

        feature = self.outside / "feature-rebind-line-endings"
        self._git("worktree", "add", "-b", "feature/rebind-line-endings", str(feature))
        try:
            target = feature / "src" / "test" / "java" / "LineEndingTest.java"
            target.write_bytes(b"line one\r\nline two\r\n")
            recorded = guard.record(feature, self.change, [str(target)], "test-updated")
            self.assertTrue(recorded["ok"], recorded)

            rebound = guard.rebind_snapshot(
                self.project, feature, self.change, expected_base
            )

            self.assertTrue(rebound["ok"], rebound)
            self.assertEqual(rebound["manifestEntriesRemoved"], 1)
            manifest = json.loads(
                (self.change / "evidence" / "test-tracking.json").read_text("utf-8")
            )
            self.assertEqual(manifest["files"], [])
            close = guard.close(feature, self.change)
            self.assertTrue(close["ok"], close)
            self.assertEqual(close["recordedCount"], 0)
        finally:
            self._git("worktree", "remove", "--force", str(feature))

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

    def test_checkpointed_manifest_can_track_and_stage_later_test_updates(self) -> None:
        tests = [
            self.project / "src" / "test" / "java" / f"Checkpoint{index}Test.java"
            for index in range(4)
        ]
        for path in tests:
            self._write(path, f"before {path.stem}\n")
        recorded = self._record(*tests)
        self.assertTrue(recorded["ok"], recorded)

        self._git("add", "-f", *(str(path.relative_to(self.project)) for path in tests))
        self._git("commit", "-m", "checkpoint tests")
        begin = guard.begin(self.project, self.change)
        self.assertTrue(begin["ok"], begin)

        for path in tests[:3]:
            self._write(path, f"after {path.stem}\n")
        close = guard.close(self.project, self.change)

        self.assertTrue(close["ok"], close)
        expected = [str(path.relative_to(self.project)).replace("\\", "/") for path in tests[:3]]
        self.assertEqual(close["files"], expected)
        manifest = json.loads(
            (self.change / "evidence" / "test-tracking.json").read_text("utf-8")
        )
        self.assertTrue(all(item["trackedBefore"] for item in manifest["files"]))

        staged = guard.stage(self.project, self.change)

        self.assertTrue(staged["ok"], staged)
        self.assertEqual(staged["files"], expected)
        self.assertEqual(self._git("diff", "--cached", "--name-only").stdout.splitlines(), expected)

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
        # Retro §5.10: a projectRoot mismatch is now EXECUTION_ROOT_MISMATCH,
        # not the generic SNAPSHOT_INVALID, so callers can distinguish wrong
        # root from corrupt snapshot.
        self.assertEqual(result["code"], "EXECUTION_ROOT_MISMATCH")

    def test_close_reconciles_build_profile_change_without_manual_snapshot_reset(self) -> None:
        target = self.project / "src" / "test" / "java" / "ProfileChangedTest.java"
        self._write(target, "before\n")
        self.assertTrue(guard.begin(self.project, self.change)["ok"])
        self._write(
            self.project / ".harness" / "config" / "build-profile.json",
            json.dumps({"testTracking": {"paths": ["src/test/**", "qa/**"]}}),
        )
        self._write(target, "after\n")

        result = guard.close(self.project, self.change)

        self.assertTrue(result["ok"], result)
        self.assertTrue(result["profileChanged"])
        self.assertIn("src/test/java/ProfileChangedTest.java", result["files"])

    def test_close_does_not_reject_unchanged_manifest_from_an_earlier_phase(self) -> None:
        target = self.project / "src" / "test" / "java" / "EarlierPhaseTest.java"
        self._write(target, "stable\n")
        self.assertTrue(self._record(target)["ok"])
        self.assertTrue(guard.begin(self.project, self.change)["ok"])

        result = guard.close(self.project, self.change)

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["recordedCount"], 0)


class ProjectRootArgumentTests(unittest.TestCase):
    """A project *name* in --project must not masquerade as a missing snapshot."""

    def test_close_rejects_project_name_instead_of_path(self) -> None:
        result = guard.close("definitely-not-a-real-dir", ".harness/changes/demo")

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "PROJECT_ROOT_INVALID")
        self.assertIn("resolvedProject", result)

    def test_begin_stage_record_reject_project_name(self) -> None:
        for action, call in (
            ("begin", lambda: guard.begin("nope-dir", ".harness/changes/demo")),
            ("stage", lambda: guard.stage("nope-dir", ".harness/changes/demo")),
            (
                "record",
                lambda: guard.record(
                    "nope-dir", ".harness/changes/demo", ["a.java"], "tdd-created"
                ),
            ),
        ):
            with self.subTest(action=action):
                result = call()
                self.assertFalse(result["ok"])
                self.assertEqual(result["code"], "PROJECT_ROOT_INVALID")

    def test_missing_snapshot_names_the_expected_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            change = project / ".harness" / "changes" / "demo"
            change.mkdir(parents=True, exist_ok=True)

            result = guard.close(project, change)

            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "SNAPSHOT_MISSING")
            self.assertIn("test-guard-snapshot.json", result["expectedSnapshot"])


if __name__ == "__main__":
    unittest.main()
