#!/usr/bin/env python3
"""Contract tests for the normalized report fact model."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_report_model as model  # noqa: E402


class MeasurementStateTests(unittest.TestCase):
    def test_preserves_unknown_not_applicable_zero_and_known_states(self) -> None:
        self.assertEqual(model.measurement(None), {"state": "unknown", "value": None})
        self.assertEqual(
            model.measurement(None, applicable=False, reason="未运行性能测试"),
            {
                "state": "not_applicable",
                "value": None,
                "reason": "未运行性能测试",
            },
        )
        self.assertEqual(model.measurement(0), {"state": "zero", "value": 0})
        self.assertEqual(model.measurement(7), {"state": "known", "value": 7})

    def test_uncollected_cost_and_storage_zeroes_are_unknown(self) -> None:
        report = model.normalize_report(
            {
                "remoteCost": {
                    "available": False,
                    "totals": {"runnerMinutes": 0, "artifactBytes": 0},
                },
                "artifactStorage": {
                    "available": False,
                    "artifactCount": 0,
                    "bytesAdded": 0,
                },
            }
        )
        measurements = report["measurements"]
        self.assertEqual(
            measurements["remoteCost"]["totals"]["runnerMinutes"]["state"],
            "unknown",
        )
        self.assertEqual(
            measurements["artifactStorage"]["bytesAdded"]["state"],
            "unknown",
        )

    def test_collected_zero_storage_remains_zero(self) -> None:
        report = model.normalize_report(
            {
                "artifactStorage": {
                    "available": True,
                    "artifactCount": 0,
                    "bytesAdded": 0,
                }
            }
        )
        self.assertEqual(
            report["measurements"]["artifactStorage"]["bytesAdded"]["state"],
            "zero",
        )


class IdentityTests(unittest.TestCase):
    def test_canonical_identity_drives_every_legacy_mirror(self) -> None:
        summary = {
            "changeIdentity": {
                "baseCommit": "base",
                "productCommit": "product",
                "featureMergeHash": "merge",
                "releaseTipHash": "tip",
                "productTreeHash": "a" * 64,
                "environmentHash": "sha256:" + "b" * 64,
            },
            "productCommit": "stale",
            "productTreeHash": "sha256:stale",
            "gitFacts": {"featureMergeHash": "stale"},
        }
        identity = model.canonical_identity(summary)
        mirrored = model.apply_identity_mirrors(summary, identity)
        self.assertEqual(identity["productTreeHash"], "sha256:" + "a" * 64)
        self.assertEqual(mirrored["productCommit"], "product")
        self.assertEqual(mirrored["featureMergeHash"], "merge")
        self.assertEqual(mirrored["releaseTipHash"], "tip")
        self.assertEqual(mirrored["productTreeHash"], identity["productTreeHash"])
        self.assertEqual(mirrored["gitFacts"]["productCommit"], "product")

    def test_canonical_identity_preserves_the_checkpoint_to_release_chain(self) -> None:
        identity = model.canonical_identity(
            {
                "changeIdentity": {
                    "checkpointCommit": "checkpoint",
                    "productCommit": "product",
                    "featureTip": "feature",
                    "mergeCommit": "merge",
                    "releaseTip": "release",
                    "productTreeHash": "a" * 64,
                }
            }
        )

        self.assertEqual(identity["checkpointCommit"], "checkpoint")
        self.assertEqual(identity["productCommit"], "product")
        self.assertEqual(identity["featureTip"], "feature")
        self.assertEqual(identity["mergeCommit"], "merge")
        self.assertEqual(identity["releaseTip"], "release")
        self.assertEqual(identity["featureMergeHash"], "merge")
        self.assertEqual(identity["releaseTipHash"], "release")

    def test_latest_terminal_verification_matches_the_full_target_identity(self) -> None:
        target = {
            "target": "unitTestFull",
            "productCommit": "product",
            "productTreeHash": "sha256:" + "a" * 64,
            "environmentHash": "sha256:" + "b" * 64,
            "profile": "release",
        }
        records = [
            {
                **target,
                "status": "ok",
                "finishedAt": "2026-07-29T10:00:00+08:00",
                "evidence": "correct-old",
            },
            {
                **target,
                "productTreeHash": "sha256:" + "c" * 64,
                "status": "ok",
                "finishedAt": "2026-07-29T12:00:00+08:00",
                "evidence": "wrong-tree-newer",
            },
            {
                **target,
                "status": "running",
                "finishedAt": "2026-07-29T13:00:00+08:00",
                "evidence": "not-terminal",
            },
        ]
        selected = model.select_latest_terminal_verification(records, target)
        self.assertIsNotNone(selected)
        self.assertEqual(selected["evidence"], "correct-old")

    def test_terminal_selection_treats_commit_as_provenance_not_reuse_key(self) -> None:
        target = {
            "target": "unitTestFull",
            "productCommit": "merge-commit",
            "productTreeHash": "sha256:" + "a" * 64,
            "commandSetHash": "sha256:cmd",
            "environmentHash": "sha256:env",
            "toolchainHash": "sha256:tool",
            "lockHash": "sha256:lock",
        }
        feature_tip = {
            **target,
            "productCommit": "feature-tip",
            "status": "OK",
            "finishedAt": "2026-07-30T10:00:00+08:00",
            "evidence": "reusable feature evidence",
        }
        selected = model.select_latest_terminal_verification([feature_tip], target)
        self.assertEqual(selected["evidence"], "reusable feature evidence")

    def test_ledger_projection_ignores_newer_evidence_for_another_product(self) -> None:
        tree = "sha256:" + "a" * 64
        ledger = {
            "changeName": "demo",
            "currentHead": "product",
            "productTreeHash": tree,
            "environmentHash": "sha256:" + "b" * 64,
            "profile": "release",
            "validations": {"unitTestFull": {"status": "running"}},
            "verificationHistory": [
                {
                    "target": "unitTestFull",
                    "changeName": "demo",
                    "productCommit": "product",
                    "productTreeHash": tree,
                    "environmentHash": "sha256:" + "b" * 64,
                    "profile": "release",
                    "status": "ok",
                    "finishedAt": "2026-07-29T10:00:00+08:00",
                    "evidence": "current-product",
                },
                {
                    "target": "unitTestFull",
                    "changeName": "demo",
                    "productCommit": "other",
                    "productTreeHash": "sha256:" + "c" * 64,
                    "environmentHash": "sha256:" + "b" * 64,
                    "profile": "release",
                    "status": "ok",
                    "finishedAt": "2026-07-29T11:00:00+08:00",
                    "evidence": "other-product",
                },
            ],
        }
        projected = model.latest_terminal_validations(ledger)
        self.assertEqual(
            projected["unitTestFull"]["evidence"],
            "current-product",
        )

    def test_ledger_projection_reads_dynamic_verification_targets(self) -> None:
        tree = "sha256:" + "a" * 64
        ledger = {
            "changeName": "demo",
            "currentHead": "product",
            "productTreeHash": tree,
            "environmentHash": "sha256:" + "b" * 64,
            "profile": "release",
            "verificationTargets": {
                "target-id": {
                    "verification": "browserE2E",
                    "changeName": "demo",
                    "productCommit": "product",
                    "productTreeHash": tree,
                    "environmentHash": "sha256:" + "b" * 64,
                    "profile": "release",
                    "status": "OK",
                    "finishedAt": "2026-07-29T10:00:00+08:00",
                    "evidence": "dynamic-target",
                }
            },
        }
        projected = model.latest_terminal_validations(ledger)
        self.assertEqual(projected["browserE2E"]["evidence"], "dynamic-target")


class OutcomeAndFindingTests(unittest.TestCase):
    def test_normalized_report_separates_current_history_and_release(self) -> None:
        report = model.normalize_report(
            {
                "changeName": "demo",
                "finalStatus": "WARN",
                "finalStatusReasons": ["browser pending"],
                "stageStatus": {"run": "OK", "test": "WARN"},
                "timeline": [{"phase": "execute", "status": "OK"}],
                "releaseDecision": "DEFER",
                "releaseEligible": False,
                "candidateVerification": {"status": "FAIL"},
                "remoteCost": {"wallClockMs": 0, "billedTokens": None},
                "artifactStorage": {"artifactCount": 0},
            }
        )
        self.assertEqual(report["outcomes"]["current"]["status"], "WARN")
        self.assertEqual(report["outcomes"]["history"]["timeline"][0]["phase"], "execute")
        self.assertEqual(report["outcomes"]["release"]["decision"], "DEFER")

    def test_record_only_normalizes_release_as_not_requested(self) -> None:
        report = model.normalize_report(
            {
                "changeName": "record-only",
                "finalStatus": "OK",
                "archiveIntent": "record-only",
                "releaseDecision": {
                    "releaseEligible": False,
                    "code": "BLOCKED_NO_CANDIDATE",
                },
                "candidateVerification": {
                    "ok": False,
                    "code": "CANDIDATE_NOT_RUN",
                },
                "remoteCost": {"wallClockMs": 0, "billedTokens": None},
            }
        )
        release = report["outcomes"]["release"]
        self.assertEqual(release["decision"], "NOT_REQUESTED")
        self.assertFalse(release["eligible"])
        self.assertEqual(report["measurements"]["remoteCost"]["wallClockMs"]["state"], "zero")
        self.assertEqual(report["measurements"]["remoteCost"]["billedTokens"]["state"], "unknown")

    def test_only_unresolved_dispositions_are_current_risks(self) -> None:
        findings = [
            {"id": "a", "severity": "RED", "disposition": "FIXED"},
            {"id": "b", "severity": "RED", "disposition": "OPEN"},
            {"id": "c", "severity": "YELLOW", "disposition": "ACCEPTED_RISK"},
            {"id": "d", "severity": "YELLOW", "disposition": "NOT_APPLICABLE"},
        ]
        self.assertEqual(
            [item["id"] for item in model.current_findings(findings)],
            ["b", "c"],
        )

    def test_fixed_review_findings_do_not_resurface_as_legacy_known_risks(self) -> None:
        report = model.normalize_report(
            {
                "reviewFindings": [
                    {"id": "fixed", "disposition": "FIXED", "message": "done"}
                ],
                "knownRisks": [{"message": "stale mirror"}],
            }
        )
        current = report["outcomes"]["current"]
        self.assertEqual(current["findings"], [])
        self.assertEqual(current["knownRisks"], [])


if __name__ == "__main__":
    unittest.main()
