#!/usr/bin/env python3
"""Tests for archive report adequacy gate (C6/T19-T23, retro §5.32).

finalize must not return all-green when the final summary is factually
incomplete: base/diff=0 with a non-empty commit, typed metrics missing
despite test reports, or stageStatus contradicting the event reducer.
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


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


class ReportAdequacyGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-adequacy-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_blocks_when_diff_zero_but_commit_non_empty(self) -> None:
        summary = {
            "changeName": "demo",
            "finalStatus": "OK",
            "verification": {
                "unitTests": {"passed": 10, "failed": 0, "skipped": 0, "passRate": "100%"},
                "apiTests": {"status": "OK", "passed": 8, "failed": 0},
            },
            "stageStatus": {"run": "OK", "test": "OK"},
            "gitFacts": {
                "baseCommit": "abc1234",
                "finalCommit": "def5678",
                "filesChanged": 0,
                "insertions": 0,
                "deletions": 0,
            },
        }
        result = ha.validate_report_adequacy(summary)
        self.assertFalse(result.get("ok"))
        codes = {issue["code"] for issue in result.get("issues", [])}
        self.assertIn("DIFF_ZERO_WITH_NONEMPTY_COMMIT", codes)

    def test_blocks_when_typed_metrics_missing_despite_test_reports(self) -> None:
        summary = {
            "changeName": "demo",
            "finalStatus": "OK",
            "verification": {
                "unitTests": {"passed": 0, "failed": 0, "skipped": 0, "passRate": "not_available"},
                "apiTests": {"status": "not_available"},
            },
            "stageStatus": {"run": "OK", "test": "OK"},
            "gitFacts": {
                "baseCommit": "abc1234",
                "finalCommit": "def5678",
                "filesChanged": 5,
                "insertions": 100,
                "deletions": 10,
            },
            "artifacts": [
                {"path": "reports/test/test-report.md", "kind": "file-backed"}
            ],
        }
        result = ha.validate_report_adequacy(summary)
        self.assertFalse(result.get("ok"))
        codes = {issue["code"] for issue in result.get("issues", [])}
        self.assertIn("TYPED_METRICS_MISSING", codes)

    def test_blocks_when_stage_status_contradicts_event_reducer(self) -> None:
        summary = {
            "changeName": "demo",
            "finalStatus": "OK",
            "verification": {
                "unitTests": {"passed": 10, "failed": 0, "skipped": 0, "passRate": "100%"},
                "apiTests": {"status": "OK", "passed": 8, "failed": 0},
            },
            "stageStatus": {"test": "WARN"},
            "stageStatusFromEvents": {"test": "OK"},
            "gitFacts": {
                "baseCommit": "abc1234",
                "finalCommit": "def5678",
                "filesChanged": 5,
                "insertions": 100,
                "deletions": 10,
            },
        }
        result = ha.validate_report_adequacy(summary)
        self.assertFalse(result.get("ok"))
        codes = {issue["code"] for issue in result.get("issues", [])}
        self.assertIn("STAGE_STATUS_CONTRADICTION", codes)

    def test_passes_when_summary_is_factually_complete(self) -> None:
        summary = {
            "changeName": "demo",
            "finalStatus": "OK",
            "verification": {
                "unitTests": {"passed": 10, "failed": 0, "skipped": 0, "passRate": "100%"},
                "apiTests": {"status": "OK", "passed": 8, "failed": 0},
            },
            "stageStatus": {"run": "OK", "test": "OK"},
            "stageStatusFromEvents": {"run": "OK", "test": "OK"},
            "gitFacts": {
                "baseCommit": "abc1234",
                "finalCommit": "def5678",
                "filesChanged": 5,
                "insertions": 100,
                "deletions": 10,
            },
        }
        result = ha.validate_report_adequacy(summary)
        self.assertTrue(result.get("ok"), result)


if __name__ == "__main__":
    unittest.main()
