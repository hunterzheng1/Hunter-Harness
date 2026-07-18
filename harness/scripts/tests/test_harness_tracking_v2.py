#!/usr/bin/env python3
"""test-tracking manifest v2 tests (cluster B, task 5).

Covers:
- UT-004/RET-10: text logical hash uses git blob (attribute-normalized)
  semantics — LF and CRLF spellings of one logical text hash identically;
  binary keeps byte hash.
- COM-001/RET-09: manifest written from a feature worktree validates from the
  main root when repositoryId matches; absolute roots never act as equality.
- Lifecycle: introducedBy/touchedBy/commitScope replace the trackedBefore flag.
- Legacy v1 manifests remain readable.
"""

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


paths = load_module("harness_paths", "harness_paths.py")
guard = load_module("harness_test_guard", "harness_test_guard.py")
ledger = load_module("harness_ledger", "harness_ledger.py")


def git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=check,
    )


class TrackingFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-track2-"))
        self.project = self.tmp / "project"
        self.project.mkdir(parents=True)
        git(self.project, "init")
        git(self.project, "config", "user.email", "test@example.com")
        git(self.project, "config", "user.name", "Test")
        git(self.project, "config", "core.autocrlf", "false")
        (self.project / ".gitattributes").write_text(
            "*.txt text eol=lf\n*.bin binary\n", encoding="utf-8"
        )
        (self.project / "README.md").write_text("demo\n", encoding="utf-8")
        git(self.project, "add", "-A")
        git(self.project, "commit", "-m", "init")
        self.change_dir = self.project / ".harness" / "changes" / "demo"
        (self.change_dir / "meta").mkdir(parents=True)
        (self.change_dir / "meta" / "change-context.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 2,
                    "changeId": "demo",
                    "lifecycle": {"status": "active"},
                    "stateOwnership": {
                        "contractRoot": ".harness/changes/demo",
                        "runtimeRoot": ".harness/state/changes/demo",
                    },
                }
            ),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)


class LogicalHashTests(TrackingFixture):
    def test_lf_crlf_same_logical_hash_ret10(self) -> None:
        lf = self.project / "lf.txt"
        crlf = self.project / "crlf.txt"
        lf.write_bytes(b"alpha\nbeta\ngamma\n")
        crlf.write_bytes(b"alpha\r\nbeta\r\ngamma\r\n")
        self.assertEqual(
            guard.logical_file_hash(self.project, "lf.txt"),
            guard.logical_file_hash(self.project, "crlf.txt"),
        )

    def test_logical_hash_uses_gitblob_prefix(self) -> None:
        (self.project / "a.txt").write_bytes(b"hello\n")
        digest = guard.logical_file_hash(self.project, "a.txt")
        self.assertTrue(digest.startswith("gitblob:"), digest)

    def test_binary_keeps_byte_hash(self) -> None:
        one = self.project / "one.bin"
        two = self.project / "two.bin"
        one.write_bytes(b"\x00\x01\x02\r\n")
        two.write_bytes(b"\x00\x01\x02\n")
        h1 = guard.logical_file_hash(self.project, "one.bin")
        h2 = guard.logical_file_hash(self.project, "two.bin")
        self.assertNotEqual(h1, h2, "binary files must hash bytewise")
        self.assertTrue(h1.startswith("sha256:"), h1)

    def test_distinct_text_differs(self) -> None:
        (self.project / "x.txt").write_bytes(b"x\n")
        (self.project / "y.txt").write_bytes(b"y\n")
        self.assertNotEqual(
            guard.logical_file_hash(self.project, "x.txt"),
            guard.logical_file_hash(self.project, "y.txt"),
        )


class ManifestV2WriteTests(TrackingFixture):
    def _write_test_file(self) -> Path:
        target = self.project / "tests" / "test_demo.py"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"def test_demo():\n    assert True\n")
        return target

    def test_record_writes_v2_manifest(self) -> None:
        target = self._write_test_file()
        result = guard.record(
            self.project, self.change_dir, [str(target)], "tdd-created"
        )
        self.assertTrue(result["ok"], result)
        manifest_path = (
            self.project
            / ".harness"
            / "state"
            / "changes"
            / "demo"
            / "evidence"
            / "test-tracking.json"
        )
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.assertEqual(manifest["schemaVersion"], 2)
        self.assertTrue(str(manifest["repositoryId"]).startswith("sha256:"))
        self.assertEqual(manifest["mode"], "force-track-touched")
        entry = manifest["files"][0]
        self.assertEqual(entry["path"], "tests/test_demo.py")
        self.assertTrue(entry["logicalHash"].startswith("gitblob:"))
        self.assertEqual(entry["introducedBy"], "demo")
        self.assertIn("demo", entry["touchedBy"])
        self.assertEqual(entry["commitScope"], "current-change")
        # v2 drops absolute-root equality:
        self.assertNotIn("projectRoot", manifest)
        # Retired boolean must not come back:
        self.assertNotIn("trackedBefore", entry)

    def test_record_touched_by_accumulates_changes(self) -> None:
        target = self._write_test_file()
        first = guard.record(
            self.project, self.change_dir, [str(target)], "tdd-created"
        )
        self.assertTrue(first["ok"], first)
        other_dir = self.project / ".harness" / "changes" / "other"
        (other_dir / "meta").mkdir(parents=True)
        (other_dir / "meta" / "change-context.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 2,
                    "changeId": "other",
                    "lifecycle": {"status": "active"},
                    "stateOwnership": {
                        "contractRoot": ".harness/changes/other",
                        "runtimeRoot": ".harness/state/changes/other",
                    },
                }
            ),
            encoding="utf-8",
        )
        second = guard.record(
            self.project, other_dir, [str(target)], "test-updated"
        )
        self.assertTrue(second["ok"], second)
        # Each change reads its own manifest; the shared file entry in the
        # second manifest records the toucher set visible to that change.
        manifest_path = (
            self.project
            / ".harness"
            / "state"
            / "changes"
            / "other"
            / "evidence"
            / "test-tracking.json"
        )
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        entry = manifest["files"][0]
        self.assertEqual(entry["introducedBy"], "other")
        self.assertEqual(entry["touchedBy"], ["other"])


class RootMigrationTests(TrackingFixture):
    def test_manifest_validates_across_roots_with_same_repository_id(self) -> None:
        """COM-001: write in linked worktree, validate from main root."""
        target = self.project / "tests" / "test_mig.py"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"def test_mig():\n    assert True\n")
        git(self.project, "add", "tests/test_mig.py")
        git(self.project, "commit", "-m", "add mig test")
        result = guard.record(
            self.project, self.change_dir, [str(target)], "tdd-created"
        )
        self.assertTrue(result["ok"], result)

        wt = self.tmp / "linked"
        git(self.project, "worktree", "add", str(wt), "-b", "mig")
        # Same file must exist in the linked worktree checkout.
        wt_file = wt / "tests" / "test_mig.py"
        self.assertTrue(wt_file.is_file())
        # Validate the same manifest content from the worktree root.
        contents, manifest_path = ledger._tracked_test_contents(wt, self.change_dir)
        self.assertIsNotNone(manifest_path)
        self.assertIn("tests/test_mig.py", contents)

    def test_repository_mismatch_rejected(self) -> None:
        target = self.project / "tests" / "test_mm.py"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"def test_mm():\n    assert True\n")
        result = guard.record(
            self.project, self.change_dir, [str(target)], "tdd-created"
        )
        self.assertTrue(result["ok"], result)
        other = self.tmp / "other"
        other.mkdir()
        git(other, "init")
        git(other, "config", "user.email", "test@example.com")
        git(other, "config", "user.name", "Test")
        (other / "R.md").write_text("r\n", encoding="utf-8")
        git(other, "add", "R.md")
        git(other, "commit", "-m", "other")
        (other / "tests").mkdir(exist_ok=True)
        (other / "tests" / "test_mm.py").write_bytes(
            b"def test_mm():\n    assert True\n"
        )
        with self.assertRaises(ValueError):
            ledger._tracked_test_contents(other, self.change_dir)


class LegacyV1ReadTests(TrackingFixture):
    def test_v1_manifest_still_readable(self) -> None:
        target = self.project / "tests" / "test_legacy.py"
        target.parent.mkdir(parents=True, exist_ok=True)
        content = b"def test_legacy():\n    assert True\n"
        target.write_bytes(content)
        import hashlib

        legacy_dir = self.project / ".harness" / "changes" / "legacy"
        (legacy_dir / "evidence").mkdir(parents=True)
        (legacy_dir / "evidence" / "test-tracking.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "mode": "force-track-touched",
                    "projectRoot": str(self.project.resolve()),
                    "files": [
                        {
                            "path": "tests/test_legacy.py",
                            "sha256": "sha256:"
                            + hashlib.sha256(content).hexdigest(),
                            "reason": "tdd-created",
                            "ignored": False,
                            "trackedBefore": False,
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        contents, manifest_path = ledger._tracked_test_contents(
            self.project, legacy_dir
        )
        self.assertIsNotNone(manifest_path)
        self.assertEqual(contents["tests/test_legacy.py"], content)


if __name__ == "__main__":
    unittest.main()
