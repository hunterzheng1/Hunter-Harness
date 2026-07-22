#!/usr/bin/env python3
"""Tests for archive status preflight (C5/T16-T18, retro §5.31).

artifact events must distinguish file-backed from informational; archive
status must surface path problems before destructive finalize.
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_archive as ha  # noqa: E402
import harness_events as he  # noqa: E402


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _bootstrap_change(project: Path, change_id: str) -> Path:
    change_dir = project / ".harness" / "changes" / change_id
    (change_dir / "meta").mkdir(parents=True, exist_ok=True)
    (change_dir / "evidence").mkdir(parents=True, exist_ok=True)
    (change_dir / "logs").mkdir(parents=True, exist_ok=True)
    (change_dir / "reports").mkdir(parents=True, exist_ok=True)
    _write(change_dir / "meta" / "worktree.json", json.dumps({"requested": False}))
    return change_dir


class ArtifactKindTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-artifact-kind-"))
        self.project = self.tmp / "project"
        (self.project / ".harness" / "changes").mkdir(parents=True, exist_ok=True)
        self.change_dir = _bootstrap_change(self.project, "change-a")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_file_backed_artifact_without_path_rejected(self) -> None:
        result = he.append_event(
            self.change_dir,
            phase="run",
            type_="artifact",
            kind="file-backed",
            note="missing path",
            run_id="r1",
        )
        self.assertFalse(result.get("ok"))
        self.assertEqual(result.get("code"), "ARTIFACT_PATH_REQUIRED")

    def test_informational_artifact_without_path_rejected(self) -> None:
        # H-8: artifact always requires path; use issue/decision for notes.
        result = he.append_event(
            self.change_dir,
            phase="run",
            type_="artifact",
            kind="informational",
            note="preview without materialized file",
            run_id="r1",
        )
        self.assertFalse(result.get("ok"), result)
        self.assertEqual(result.get("code"), "ARTIFACT_PATH_REQUIRED")

    def test_file_backed_artifact_with_change_relative_path_accepted(self) -> None:
        _write(self.change_dir / "reports" / "test.md", "# report\n")
        result = he.append_event(
            self.change_dir,
            phase="run",
            type_="artifact",
            kind="file-backed",
            path="reports/test.md",
            note="test report",
            run_id="r1",
        )
        self.assertTrue(result.get("ok"), result)


class ArchiveStatusPreflightTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-archive-preflight-"))
        self.project = self.tmp / "project"
        (self.project / ".harness" / "changes").mkdir(parents=True, exist_ok=True)
        self.change_dir = _bootstrap_change(self.project, "change-a")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_status_classifies_missing_path_legacy_as_blocking(self) -> None:
        # COM-003 / H-8: legacy pathless artifact rows (bypass append validation)
        # must fail closed as blocking before finalize.
        events = self.change_dir / "events.ndjson"
        events.write_text(
            json.dumps(
                {
                    "schema_version": 3,
                    "id": "evt-legacy-pathless",
                    "timestamp": "2026-07-22T00:00:00.000+08:00",
                    "phase": "plan",
                    "type": "artifact",
                    "kind": "informational",
                    "note": "design preview",
                },
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )
        result = ha.artifact_preflight(self.change_dir)
        self.assertFalse(result.get("ok"))
        items = result.get("items", [])
        blocking = [i for i in items if i["category"] == "blocking"]
        self.assertTrue(blocking, f"expected blocking item: {items}")
        self.assertEqual(blocking[0].get("eventId"), "evt-legacy-pathless")

    def test_status_classifies_repo_relative_path_as_canonicalizable(self) -> None:
        # A file-backed artifact with a repo-relative path that includes the
        # change dir prefix — should be canonicalizable to change-relative.
        _write(self.change_dir / "reports" / "design.md", "# design\n")
        he.append_event(
            self.change_dir,
            phase="plan",
            type_="artifact",
            kind="file-backed",
            path=".harness/changes/change-a/reports/design.md",
            note="design with repo-relative path",
            run_id="r1",
        )
        result = ha.artifact_preflight(self.change_dir)
        items = result.get("items", [])
        canonical = [i for i in items if i["category"] == "canonicalizable"]
        self.assertTrue(canonical, f"expected canonicalizable item: {items}")

    def test_status_classifies_escape_path_as_blocking(self) -> None:
        he.append_event(
            self.change_dir,
            phase="plan",
            type_="artifact",
            kind="file-backed",
            path="../../etc/passwd",
            note="escape attempt",
            run_id="r1",
        )
        result = ha.artifact_preflight(self.change_dir)
        self.assertFalse(result.get("ok"))
        items = result.get("items", [])
        blocking = [i for i in items if i["category"] == "blocking"]
        self.assertTrue(blocking, f"expected blocking item: {items}")


if __name__ == "__main__":
    unittest.main()
