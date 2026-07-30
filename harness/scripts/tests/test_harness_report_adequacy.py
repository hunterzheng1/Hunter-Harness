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

    def test_distinguishes_db_evidence_missing_from_not_run(self) -> None:
        common = {
            "changeName": "demo",
            "finalStatus": "WARN",
            "verification": {
                "unitTests": {"passed": 1},
                "apiTests": {"status": "OK", "passed": 1},
            },
        }
        missing = ha.validate_report_adequacy(
            {
                **common,
                "verification": {
                    **common["verification"],
                    "dbCompatibility": "EVIDENCE_MISSING",
                },
            }
        )
        not_run = ha.validate_report_adequacy(
            {
                **common,
                "verification": {
                    **common["verification"],
                    "dbCompatibility": "NOT_RUN",
                },
            }
        )

        missing_issue = next(
            issue for issue in missing["issues"]
            if issue["code"] == "DB_COMPATIBILITY_EVIDENCE_MISSING"
        )
        not_run_issue = next(
            issue for issue in not_run["issues"]
            if issue["code"] == "DB_COMPATIBILITY_NOT_RUN"
        )
        self.assertEqual(missing_issue["severity"], "error")
        self.assertEqual(not_run_issue["severity"], "warning")

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

    def test_blocks_identity_mirror_timing_and_release_contradictions(self) -> None:
        summary = {
            "changeName": "demo",
            "finalStatus": "OK",
            "baseCommit": "base",
            "finalCommit": "product",
            "productCommit": "stale",
            "productTreeHash": "sha256:" + "c" * 64,
            "changeIdentity": {
                "baseCommit": "base",
                "productCommit": "product",
                "productTreeHash": "sha256:" + "a" * 64,
            },
            "verification": {
                "unitTests": {"passed": 10, "failed": 0, "skipped": 0, "passRate": "100%"},
                "apiTests": {"status": "OK", "passed": 8, "failed": 0},
            },
            "stageStatus": {"run": "OK", "test": "OK"},
            "stageStatusFromEvents": {"run": "OK", "test": "OK"},
            "diffStat": {"filesChanged": 5, "insertions": 100, "deletions": 10},
            "timing": {
                "workflowWallClockMs": 1000,
                "attributedStageUnionMs": 700,
                "externalWaitMs": 400,
                "pausedMs": 0,
                "agentOrToolUnattributedMs": 0,
                "conservationDeltaMs": -100,
            },
            "releaseEligible": True,
            "candidateVerification": {"ok": False, "status": "FAIL"},
        }
        result = ha.validate_report_adequacy(summary)
        codes = {issue["code"] for issue in result.get("issues", [])}
        self.assertIn("IDENTITY_MIRROR_MISMATCH", codes)
        self.assertIn("TIMING_CONSERVATION_MISMATCH", codes)
        self.assertIn("RELEASE_ELIGIBILITY_CONTRADICTION", codes)

    def test_arch_id_02_rejects_base_equals_feature_tip(self) -> None:
        tip = "0fc4e656742ab74c2ec7b80ecdd9ca613f9494e5"
        summary = {
            "changeName": "demo",
            "finalStatus": "OK",
            "baseCommit": tip,
            "finalCommit": "419bdb790a3865e305d21b3116d38262b856a33f",
            "productCommit": tip,
            "diffStat": {"filesChanged": 1, "insertions": 2, "deletions": 0},
            "changedFiles": ["README.md"],
            "verification": {
                "unitTests": {"passed": 1, "failed": 0, "skipped": 0, "passRate": "100%"},
                "apiTests": {"status": "OK", "passed": 1, "failed": 0},
            },
            "stageStatus": {"run": "OK", "test": "OK"},
            "stageStatusFromEvents": {"run": "OK", "test": "OK"},
        }
        result = ha.validate_report_adequacy(summary)
        self.assertFalse(result.get("ok"))
        codes = {issue["code"] for issue in result.get("issues", [])}
        self.assertIn("ARCHIVE_BASE_EQUALS_FEATURE_TIP", codes)

    def test_arch_id_02_rejects_internally_consistent_but_shrunk_diff(self) -> None:
        summary = {
            "changeName": "demo",
            "finalStatus": "OK",
            "baseCommit": "mergeparent0000000000000000000000000001",
            "finalCommit": "mergecommit0000000000000000000000000002",
            "productCommit": "featuretip0000000000000000000000000003",
            "diffStat": {"filesChanged": 1, "insertions": 2, "deletions": 0},
            "changedFiles": ["MERGE_NOTE.md"],
            "ownershipDiff": {
                "files": [f"src/file_{i}.py" for i in range(30)],
            },
            "mergeParents": [
                "mergeparent0000000000000000000000000001",
                "featuretip0000000000000000000000000003",
            ],
            "verification": {
                "unitTests": {"passed": 1, "failed": 0, "skipped": 0, "passRate": "100%"},
                "apiTests": {"status": "OK", "passed": 1, "failed": 0},
            },
            "stageStatus": {"run": "OK", "test": "OK"},
            "stageStatusFromEvents": {"run": "OK", "test": "OK"},
        }
        result = ha.validate_report_adequacy(summary)
        self.assertFalse(result.get("ok"))
        codes = {issue["code"] for issue in result.get("issues", [])}
        self.assertTrue(
            {"ARCHIVE_DIFF_SHRUNK_VS_OWNERSHIP", "ARCHIVE_NOFF_MERGE_DELTA_ONLY"}
            & codes
        )


if __name__ == "__main__":
    unittest.main()
