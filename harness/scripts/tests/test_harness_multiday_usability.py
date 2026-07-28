#!/usr/bin/env python3
"""P2 usability, cost, and planning regressions from the multi-day retro."""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_archive as ha  # noqa: E402
import harness_gate as hg  # noqa: E402
import harness_plan_finalize as hpf  # noqa: E402


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def _markdown(change: str, title: str, extra: str = "") -> str:
    return (
        "---\n"
        f"change-name: {change}\n"
        "status: approved\n"
        f"{extra}"
        "---\n\n"
        f"# {title}\n"
    )


def _seed_staging(root: Path, plan_extra: str = "") -> None:
    _write(root / "spec" / "demo-design.md", _markdown("demo", "Design"))
    _write(
        root / "plans" / "demo-plan.md",
        _markdown("demo", "Plan", plan_extra),
    )
    _write(
        root / "plans" / "demo-implementation-detail.md",
        _markdown("demo", "Implementation"),
    )
    _write(
        root / "plans" / "demo-test-scenarios.md",
        _markdown("demo", "Scenarios"),
    )
    _write(root / "meta" / "gate-policy.json", '{"schemaVersion": 1}\n')
    _write(
        root / "meta" / "worktree.json",
        '{"requested": false, "agent": "codex"}\n',
    )


class MultiDayUsabilityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-multiday-usability-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_remote_cost_is_aggregated_by_candidate(self) -> None:
        result = ha.build_remote_cost_summary(
            {
                "schemaVersion": 1,
                "runs": [
                    {
                        "candidateId": "candidate-a",
                        "runnerMinutes": 4.5,
                        "queueWaitMs": 1_000,
                        "artifactBytes": 100,
                    },
                    {
                        "candidateId": "candidate-a",
                        "runnerMinutes": 2,
                        "queueWaitMs": 500,
                        "artifactBytes": 40,
                        "duplicateRunReason": "same-input-manual-retry",
                    },
                    {
                        "candidateId": "candidate-b",
                        "runnerMinutes": 1,
                        "queueWaitMs": 250,
                        "artifactBytes": 20,
                    },
                ],
            }
        )

        self.assertEqual(result["totals"]["runnerMinutes"], 7.5)
        self.assertEqual(result["totals"]["queueWaitMs"], 1_750)
        self.assertEqual(result["totals"]["artifactBytes"], 160)
        by_id = {item["candidateId"]: item for item in result["candidates"]}
        self.assertEqual(by_id["candidate-a"]["runCount"], 2)
        self.assertEqual(by_id["candidate-a"]["duplicateRunCount"], 1)

    def test_fallback_report_separates_release_claims_and_cost_quality(self) -> None:
        html = ha.render_fallback_html(
            {
                "changeName": "demo",
                "finalStatus": "WARN",
                "timing": {
                    "workflowWallClockMs": 40_000,
                    "attributedStageUnionMs": 15_000,
                    "externalWaitMs": 5_000,
                    "pausedMs": 10_000,
                    "agentOrToolUnattributedMs": 10_000,
                    "conservationDeltaMs": 0,
                    "attempts": [
                        {
                            "phase": "test",
                            "terminalStatus": "RECOVERED",
                            "durationMs": 12_000,
                        }
                    ],
                },
                "candidateVerification": {
                    "assurance": "remote-claimed",
                    "code": "REMOTE_CLAIMED_RECORD_ONLY",
                },
                "archiveIntegrity": {"ok": True, "code": "ARCHIVE_INTEGRITY_OK"},
                "releaseDecision": {
                    "releaseEligible": False,
                    "checks": {
                        "candidateVerification": {
                            "ok": False,
                            "code": "REMOTE_ATTESTATION_REQUIRED",
                        }
                    },
                },
                "artifactStorage": {
                    "bytesAdded": 100,
                    "bytesReused": 40,
                    "bytesPruned": 0,
                },
                "remoteCost": {
                    "totals": {
                        "runnerMinutes": 7.5,
                        "queueWaitMs": 1_750,
                        "artifactBytes": 160,
                        "duplicateRunCount": 1,
                    }
                },
                "projection": {
                    "mode": "fallback",
                    "code": "PROJECTION_DEGRADED_FALLBACK",
                    "remediation": "run update-harness",
                },
            }
        )

        for label in (
            "Current Outcome",
            "Candidate Claim / Attestation",
            "Archive Integrity",
            "Release Eligibility",
            "History Quality",
            "Remote Cost",
            "Artifact Storage",
            "Projection / Fallback",
            "conservationDeltaMs",
        ):
            self.assertIn(label, html)

    def test_slice_plan_requires_candidate_parent_reuse_and_budget(self) -> None:
        staging = self.tmp / "staging"
        _seed_staging(
            staging,
            "slice-plan: true\ncandidate-type: child-of-aggregate\n",
        )

        invalid = hpf.validate_staging(staging, "demo")
        self.assertFalse(invalid["ok"], invalid)
        self.assertEqual(invalid["code"], "SLICE_PLAN_CONTRACT_INVALID")

        _write(
            staging / "plans" / "demo-plan.md",
            _markdown(
                "demo",
                "Plan",
                "slice-plan: true\n"
                "candidate-type: child-of-aggregate\n"
                "aggregate-parent: integration-demo\n"
                "evidence-reuse: aggregate-candidate\n"
                "artifact-budget-bytes: 1048576\n",
            ),
        )
        valid = hpf.validate_staging(staging, "demo")
        self.assertTrue(valid["ok"], valid)
        self.assertEqual(
            valid["slicePlan"]["candidateType"],
            "child-of-aggregate",
        )

    def test_parallel_child_isolation_rejects_any_shared_resource(self) -> None:
        contract = {
            "schemaVersion": 1,
            "candidateScope": "aggregate",
            "aggregateChangeId": "parent",
            "coveredChildChanges": ["child-a", "child-b"],
            "childProductCommits": {
                "child-a": "1" * 40,
                "child-b": "2" * 40,
            },
            "integrationProductCommit": "3" * 40,
            "coverageProof": {
                "digest": "sha256:" + "4" * 64,
                "source": "integration-manifest",
            },
            "concurrencyMode": "isolated-multi-active",
            "childIsolation": {
                "child-a": {
                    "worktreeRoot": "E:/work/a",
                    "port": 3101,
                    "database": "db_a",
                    "tempRoot": "E:/tmp/a",
                    "writerLease": "lease-a",
                },
                "child-b": {
                    "worktreeRoot": "E:/work/b",
                    "port": 3101,
                    "database": "db_b",
                    "tempRoot": "E:/tmp/b",
                    "writerLease": "lease-b",
                },
            },
        }

        invalid = ha.validate_aggregate_candidate_contract(
            contract,
            candidate_subject={"productCommit": "3" * 40},
        )
        self.assertFalse(invalid["ok"], invalid)
        issue_codes = {item["code"] for item in invalid["issues"]}
        self.assertIn("PARALLEL_ISOLATION_COLLISION", issue_codes)

        contract["childIsolation"]["child-b"]["port"] = 3102
        valid = ha.validate_aggregate_candidate_contract(
            contract,
            candidate_subject={"productCommit": "3" * 40},
        )
        self.assertTrue(valid["ok"], valid)

    def test_begin_root_hint_uses_linked_worktree_git_root(self) -> None:
        project = self.tmp / "project"
        worktree = self.tmp / "worktree"
        project.mkdir()
        worktree.mkdir()
        with (
            mock.patch.object(hg, "_git_text", return_value=str(worktree)),
            mock.patch.object(
                hg.hp,
                "repository_identity",
                side_effect=lambda _root: "repo-identity",
            ),
        ):
            hint = hg.resolve_begin_execution_hint(
                project,
                requested=None,
                capsule=None,
                cwd=worktree,
            )

        self.assertEqual(Path(hint["executionRoot"]), worktree.resolve())
        self.assertEqual(hint["source"], "cwd-git-root")

    def test_retention_audit_reports_expired_runtime_and_staging(self) -> None:
        project = self.tmp / "project"
        change = project / ".harness" / "changes" / "demo"
        runtime = change / "runtime" / "old"
        staging = (
            project
            / ".harness"
            / "archive-operations"
            / "staging"
            / "old-operation"
        )
        _write(runtime / "a.bin", "runtime")
        _write(staging / "b.bin", "staging")
        old = time.time() - (10 * 24 * 60 * 60)
        os.utime(runtime, (old, old))
        os.utime(staging, (old, old))

        audit = ha.build_retention_audit(change)

        self.assertEqual(audit["expiredCount"], 2)
        self.assertGreater(audit["bytesPrunable"], 0)
        self.assertTrue(all(item["status"] == "EXPIRED" for item in audit["items"]))

    def test_tier_override_preserves_compiled_final_sequence(self) -> None:
        workflow = hg._load_workflow_policy()
        payload = hg.classify_defaults(
            workflow,
            change_id="demo",
            stage="pre-run",
        )
        payload["requiredGateDag"] = hg.compile_final_sequence_dag(
            payload["requiredGateDag"],
            ["complete-review", "code-freeze", "unitTestFull", "archive"],
        )
        payload["finalSequence"] = payload["requiredGateDag"]["finalSequence"]

        overridden = hg.apply_tier_override(
            payload,
            workflow,
            tier="standard",
            override_by="tester",
        )

        self.assertEqual(
            overridden["finalSequence"]["nodeIds"],
            [
                "sequence:complete-review",
                "sequence:code-freeze",
                "sequence:unit-test-full",
                "sequence:archive",
            ],
        )
        self.assertEqual(
            overridden["requiredGateDag"]["finalSequence"],
            overridden["finalSequence"],
        )


if __name__ == "__main__":
    unittest.main()
