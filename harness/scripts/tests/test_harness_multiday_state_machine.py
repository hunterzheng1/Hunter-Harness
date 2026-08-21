#!/usr/bin/env python3
"""Regression coverage for the multi-day final-sequence state machine."""

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
import harness_gate as hg  # noqa: E402
import harness_phase as hp  # noqa: E402


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )


class MultiDayStateMachineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-multiday-state-"))
        self.change = self.tmp / ".harness" / "changes" / "demo"
        self.change.mkdir(parents=True)
        self.base_dag = {
            "schemaVersion": 1,
            "nodes": [
                {
                    "id": "validation:unitTest",
                    "kind": "validation",
                    "phase": "execute",
                    "dependsOn": [],
                }
            ],
            "edges": [],
        }
        self.sequence = [
            "complete-review",
            "code-freeze",
            "unitTestFull",
            "delta-review",
            "submit-reuse",
            "remote-candidate-ci",
            "archive",
        ]
        self.subject = {
            "productCommit": "a" * 40,
            "productTreeHash": "sha256:" + "b" * 64,
            "environmentHash": "sha256:" + "c" * 64,
        }

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _persist_policy(self) -> dict[str, object]:
        dag = hg.compile_final_sequence_dag(self.base_dag, self.sequence)
        policy = {
            "schemaVersion": 2,
            "requiredGateDag": dag,
            "finalSequence": dag["finalSequence"],
        }
        _write_json(self.change / "meta" / "gate-policy.json", policy)
        return policy

    def _record_full(self) -> dict[str, object]:
        for stage in ("prepare", "verify"):
            environment = hp.record_environment_attempt(
                self.change,
                self.subject,
                stage=stage,
                status="OK",
                duration_ms=10,
            )
            self.assertTrue(environment["ok"], environment)
        full = hp.record_full_test_execution(
            self.change,
            self.subject,
            status="OK",
            prepare_ms=10,
            test_ms=20,
            cleanup_ms=5,
            result_digest="sha256:" + "e" * 64,
        )
        self.assertTrue(full["ok"], full)
        return full

    def test_final_sequence_compiles_to_versioned_dependency_chain(self) -> None:
        dag = hg.compile_final_sequence_dag(self.base_dag, self.sequence)

        self.assertEqual(dag["schemaVersion"], 2)
        self.assertEqual(dag["finalSequence"]["schemaVersion"], 1)
        sequence_nodes = [
            node for node in dag["nodes"] if node["kind"] == "sequence"
        ]
        self.assertEqual(
            [node["id"] for node in sequence_nodes],
            [
                "sequence:complete-review",
                "sequence:code-freeze",
                "sequence:unit-test-full",
                "sequence:delta-review",
                "sequence:submit-reuse",
                "sequence:remote-candidate-ci",
                "sequence:archive",
            ],
        )
        self.assertIn(
            "sequence:code-freeze",
            sequence_nodes[2]["dependsOn"],
        )

    def test_full_suite_before_code_freeze_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "code-freeze"):
            hg.compile_final_sequence_dag(
                self.base_dag,
                ["complete-review", "unitTestFull", "code-freeze", "archive"],
            )

    def test_sequence_receipt_requires_predecessor_and_frozen_subject(self) -> None:
        self._persist_policy()

        early = hp.record_sequence_receipt(
            self.change,
            "sequence:unit-test-full",
            self.subject,
        )
        self.assertFalse(early["ok"], early)
        self.assertEqual(early["code"], "SEQUENCE_PREDECESSOR_MISSING")

        for node_id in (
            "sequence:complete-review",
            "sequence:code-freeze",
        ):
            result = hp.record_sequence_receipt(self.change, node_id, self.subject)
            self.assertTrue(result["ok"], result)
        self._record_full()

        changed_subject = dict(self.subject)
        changed_subject["productTreeHash"] = "sha256:" + "d" * 64
        changed = hp.record_sequence_receipt(
            self.change,
            "sequence:delta-review",
            changed_subject,
        )
        self.assertFalse(changed["ok"], changed)
        self.assertEqual(changed["code"], "SEQUENCE_SUBJECT_CHANGED")

    def test_final_sequence_evaluation_requires_all_pre_archive_receipts(self) -> None:
        self._persist_policy()
        required = (
            "sequence:complete-review",
            "sequence:code-freeze",
            "sequence:unit-test-full",
            "sequence:delta-review",
            "sequence:submit-reuse",
            "sequence:remote-candidate-ci",
        )
        for node_id in required:
            result = (
                self._record_full()["sequenceReceipt"]
                if node_id == "sequence:unit-test-full"
                else hp.record_sequence_receipt(
                    self.change,
                    node_id,
                    self.subject,
                )
            )
            self.assertTrue(result["ok"], result)

        complete = hp.evaluate_final_sequence(
            self.change,
            self.subject,
            exclude_nodes={"sequence:archive"},
        )
        self.assertTrue(complete["ok"], complete)

        receipts_path = self.change / "evidence" / "final-sequence-receipts.json"
        receipts = json.loads(receipts_path.read_text(encoding="utf-8"))
        del receipts["receipts"]["sequence:delta-review"]
        _write_json(receipts_path, receipts)
        incomplete = hp.evaluate_final_sequence(
            self.change,
            self.subject,
            exclude_nodes={"sequence:archive"},
        )
        self.assertFalse(incomplete["ok"], incomplete)
        self.assertIn("sequence:delta-review", incomplete["missing"])

    def test_full_sequence_step_requires_assertion_bearing_execution(self) -> None:
        self._persist_policy()
        for node_id in (
            "sequence:complete-review",
            "sequence:code-freeze",
        ):
            result = hp.record_sequence_receipt(
                self.change,
                node_id,
                self.subject,
            )
            self.assertTrue(result["ok"], result)

        bypass = hp.record_sequence_receipt(
            self.change,
            "sequence:unit-test-full",
            self.subject,
        )
        self.assertFalse(bypass["ok"], bypass)
        self.assertEqual(
            bypass["code"],
            "FULL_EXECUTION_EVIDENCE_REQUIRED",
        )

        full = self._record_full()
        self.assertTrue(full["sequenceReceipt"]["ok"], full)

    def test_aggregate_candidate_requires_exact_child_membership(self) -> None:
        contract = {
            "schemaVersion": 1,
            "candidateScope": "aggregate",
            "aggregateChangeId": "parent",
            "coveredChildChanges": ["child-a", "child-b", "child-c"],
            "childProductCommits": {
                "child-a": "1" * 40,
                "child-b": "2" * 40,
                "child-c": "3" * 40,
            },
            "integrationProductCommit": "4" * 40,
            "coverageProof": {
                "digest": "sha256:" + "5" * 64,
                "source": "integration-manifest",
            },
        }

        valid = ha.validate_aggregate_candidate_contract(
            contract,
            candidate_subject={"productCommit": "4" * 40},
        )
        self.assertTrue(valid["ok"], valid)

        del contract["childProductCommits"]["child-b"]
        invalid = ha.validate_aggregate_candidate_contract(
            contract,
            candidate_subject={"productCommit": "4" * 40},
        )
        self.assertFalse(invalid["ok"], invalid)
        self.assertEqual(invalid["code"], "AGGREGATE_CHILD_MEMBERSHIP_MISMATCH")


if __name__ == "__main__":
    unittest.main()
