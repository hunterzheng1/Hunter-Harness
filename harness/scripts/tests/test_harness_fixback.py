import importlib.util
import hashlib
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "harness_fixback.py"


def load_module():
    spec = importlib.util.spec_from_file_location("harness_fixback_test", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_evidence(
    root: Path,
    relative: str,
    *,
    kind: str,
    status: str,
    product_identity: str,
    evidence_id: str,
    passed_gates: list[str] | None = None,
) -> str:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    if kind == "review":
        review_path = root / "reports" / "review" / "review-findings.json"
        review_path.parent.mkdir(parents=True, exist_ok=True)
        review_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "runId": evidence_id,
                    "changeName": root.name,
                    "findings": [],
                }
            ),
            encoding="utf-8",
        )
        source_digest = "sha256:" + hashlib.sha256(
            review_path.read_bytes()
        ).hexdigest()
        provenance = {
            "type": "harness-review",
            "reviewReportPath": str(review_path),
            "reviewRunId": evidence_id,
            "engine": "harness-review-6d",
            "sourceDigest": source_digest,
        }
    else:
        run_path = root / "runtime" / "run-sessions" / evidence_id / "session.json"
        run_path.parent.mkdir(parents=True, exist_ok=True)
        command_hash = "sha256:" + hashlib.sha256(
            ("command:" + evidence_id).encode()
        ).hexdigest()
        result_digest = "sha256:" + hashlib.sha256(
            ("result:" + evidence_id).encode()
        ).hexdigest()
        run_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "sessionId": evidence_id,
                    "verification": kind,
                    "status": "FAIL" if kind == "red" else "OK",
                    "testProcessStarted": True,
                    "productIdentity": product_identity,
                    "commandHash": command_hash,
                    "resultDigest": result_digest,
                    "endedAt": "2026-07-31T12:00:00+08:00",
                }
            ),
            encoding="utf-8",
        )
        provenance = {
            "type": "managed-run-session",
            "runReceiptPath": str(run_path),
            "sessionId": evidence_id,
            "commandHash": command_hash,
            "resultDigest": result_digest,
        }
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 2,
                "kind": kind,
                "status": status,
                "productIdentity": product_identity,
                "evidenceId": evidence_id,
                "passedGates": passed_gates or [],
                "provenance": provenance,
            }
        ),
        encoding="utf-8",
    )
    load_module().register_evidence(root, relative)
    return relative


class FixbackBatchTests(unittest.TestCase):
    def test_resume_is_idempotent_and_returns_the_existing_open_batch(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            first = module.resume_batch(
                change_dir,
                batch_id="batch-resume",
                product_identity="sha256:before",
                root_cause="同一组评审建议",
                run_id="run-fixback-2",
                attempt=2,
            )
            second = module.resume_batch(
                change_dir,
                batch_id="ignored-new-id",
                product_identity="sha256:before",
                root_cause="同一组评审建议",
                run_id="another-run",
                attempt=3,
            )

            self.assertEqual(first["batchId"], "batch-resume")
            self.assertEqual(second["batchId"], "batch-resume")
            self.assertEqual(second["runId"], "run-fixback-2")
            self.assertEqual(second["attempt"], 2)
            self.assertTrue(second["resumed"])
            self.assertEqual(second["nextStep"], "add-issues")
            self.assertEqual(len(module._all_batches(change_dir)), 1)

    def test_resolving_an_issue_invalidates_only_verifications_using_changed_files(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            source = change_dir / "src" / "engine.ts"
            source.parent.mkdir(parents=True)
            source.write_text("export {}\n", encoding="utf-8")
            ledger_path = change_dir / "evidence" / "verification-ledger.json"
            ledger_path.parent.mkdir(parents=True)
            ledger_path.write_text(
                json.dumps({
                    "verificationTargets": {
                        "unit": {
                            "verification": "unitTestFull",
                            "inputsFiles": ["src/engine.ts", "src/engine.test.ts"],
                            "reusable": True,
                        },
                        "api": {
                            "verification": "apiTest",
                            "inputsFiles": ["src/api.ts"],
                            "reusable": True,
                        },
                    },
                    "validations": {
                        "unitTestFull": {
                            "inputsFiles": ["src/engine.ts", "src/engine.test.ts"],
                            "reusable": True,
                        },
                        "apiTest": {
                            "inputsFiles": ["src/api.ts"],
                            "reusable": True,
                        },
                    },
                }),
                encoding="utf-8",
            )
            module.open_batch(
                change_dir,
                batch_id="batch-targeted",
                product_identity="sha256:before",
                root_cause="快照返回可变引用",
            )
            module.add_issue(
                change_dir,
                batch_id="batch-targeted",
                issue_id="I-1",
                summary="复制快照",
                risk_tags=[],
            )
            module.resolve_issue(
                change_dir,
                batch_id="batch-targeted",
                issue_id="I-1",
                red_evidence=write_evidence(
                    change_dir,
                    "evidence/red-targeted.json",
                    kind="red",
                    status="FAIL",
                    product_identity="sha256:before",
                    evidence_id="red-targeted",
                ),
                green_evidence=write_evidence(
                    change_dir,
                    "evidence/green-targeted.json",
                    kind="green",
                    status="PASS",
                    product_identity="sha256:after",
                    evidence_id="green-targeted",
                ),
                changed_files=["src/engine.ts"],
            )

            ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
            self.assertFalse(ledger["verificationTargets"]["unit"]["reusable"])
            self.assertTrue(ledger["verificationTargets"]["api"]["reusable"])
            self.assertFalse(ledger["validations"]["unitTestFull"]["reusable"])
            self.assertTrue(ledger["validations"]["apiTest"]["reusable"])

    def test_related_issues_close_with_one_affected_and_review_receipt(self) -> None:
        self.assertTrue(SCRIPT.is_file(), "harness_fixback.py must be implemented")
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            opened = module.open_batch(
                change_dir,
                batch_id="batch-1",
                product_identity="sha256:before",
                root_cause="shared collection contract",
            )
            self.assertEqual(opened["status"], "OPEN")
            for issue_id in ("I-1", "I-2", "I-3"):
                changed_file = change_dir / "src" / f"{issue_id}.ts"
                changed_file.parent.mkdir(parents=True, exist_ok=True)
                changed_file.write_text("export {};\n", encoding="utf-8")
                module.add_issue(
                    change_dir,
                    batch_id="batch-1",
                    issue_id=issue_id,
                    summary=f"issue {issue_id}",
                    risk_tags=[],
                )
                module.resolve_issue(
                    change_dir,
                    batch_id="batch-1",
                    issue_id=issue_id,
                    red_evidence=write_evidence(
                        change_dir,
                        f"evidence/red-{issue_id}.json",
                        kind="red",
                        status="FAIL",
                        product_identity="sha256:before",
                        evidence_id=f"red-{issue_id}",
                    ),
                    green_evidence=write_evidence(
                        change_dir,
                        f"evidence/green-{issue_id}.json",
                        kind="green",
                        status="PASS",
                        product_identity="sha256:after",
                        evidence_id=f"green-{issue_id}",
                    ),
                    changed_files=[f"src/{issue_id}.ts"],
                )
            affected = write_evidence(
                change_dir,
                "evidence/affected.json",
                kind="verification",
                status="PASS",
                product_identity="sha256:after",
                evidence_id="affected-1",
                passed_gates=["affected"],
            )
            review = write_evidence(
                change_dir,
                "reports/review.json",
                kind="review",
                status="PASS",
                product_identity="sha256:after",
                evidence_id="review-1",
                passed_gates=["review"],
            )
            closed = module.close_batch(
                change_dir,
                batch_id="batch-1",
                final_product_identity="sha256:after",
                affected_receipt=affected,
                review_receipt=review,
            )
            self.assertEqual(closed["status"], "CLOSED")
            self.assertEqual(len(closed["issues"]), 3)
            self.assertEqual(closed["verificationRuns"]["affected"], 1)
            self.assertEqual(closed["verificationRuns"]["review"], 1)
            readiness = module.freeze_readiness(
                change_dir,
                product_identity="sha256:after",
            )
            self.assertTrue(readiness["ok"])

    def test_open_batch_blocks_freeze_and_security_risk_expands_gates(self) -> None:
        self.assertTrue(SCRIPT.is_file(), "harness_fixback.py must be implemented")
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            module.open_batch(
                change_dir,
                batch_id="batch-risk",
                product_identity="sha256:before",
                root_cause="authorization boundary",
            )
            module.add_issue(
                change_dir,
                batch_id="batch-risk",
                issue_id="SEC-1",
                summary="missing authorization check",
                risk_tags=["security"],
            )
            status = module.batch_status(change_dir, "batch-risk")
            self.assertIn("security", status["requiredVerifications"])
            self.assertIn("unitTestFull", status["requiredVerifications"])
            readiness = module.freeze_readiness(
                change_dir,
                product_identity="sha256:before",
            )
            self.assertFalse(readiness["ok"])
            self.assertEqual(readiness["code"], "FIXBACK_BATCH_OPEN")

    def test_close_requires_individual_red_green_evidence(self) -> None:
        self.assertTrue(SCRIPT.is_file(), "harness_fixback.py must be implemented")
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            module.open_batch(
                change_dir,
                batch_id="batch-incomplete",
                product_identity="sha256:before",
                root_cause="one root cause",
            )
            module.add_issue(
                change_dir,
                batch_id="batch-incomplete",
                issue_id="I-1",
                summary="unresolved",
                risk_tags=[],
            )
            with self.assertRaisesRegex(ValueError, "FIXBACK_ISSUES_UNRESOLVED"):
                module.close_batch(
                    change_dir,
                    batch_id="batch-incomplete",
                    final_product_identity="sha256:after",
                    affected_receipt="affected.json",
                    review_receipt="review.json",
                )

    def test_resolve_rejects_missing_or_identity_mismatched_evidence(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            module.open_batch(
                change_dir,
                batch_id="batch-evidence",
                product_identity="sha256:before",
                root_cause="evidence trust",
            )
            module.add_issue(
                change_dir,
                batch_id="batch-evidence",
                issue_id="I-1",
                summary="untrusted path",
                risk_tags=[],
            )
            with self.assertRaisesRegex(ValueError, "FIXBACK_EVIDENCE_MISSING"):
                module.resolve_issue(
                    change_dir,
                    batch_id="batch-evidence",
                    issue_id="I-1",
                    red_evidence="missing-red.json",
                    green_evidence="missing-green.json",
                    changed_files=[],
                )

    def test_unregistered_handwritten_evidence_cannot_close_batch(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            module.open_batch(
                change_dir,
                batch_id="batch-untrusted",
                product_identity="sha256:before",
                root_cause="untrusted evidence",
            )
            module.add_issue(
                change_dir,
                batch_id="batch-untrusted",
                issue_id="I-1",
                summary="untrusted",
                risk_tags=[],
            )
            changed = change_dir / "changed.ts"
            changed.write_text("export {};\n", encoding="utf-8")
            red = write_evidence(
                change_dir,
                "evidence/red.json",
                kind="red",
                status="FAIL",
                product_identity="sha256:before",
                evidence_id="red-trusted",
            )
            green = write_evidence(
                change_dir,
                "evidence/green.json",
                kind="green",
                status="PASS",
                product_identity="sha256:after",
                evidence_id="green-trusted",
            )
            module.resolve_issue(
                change_dir,
                batch_id="batch-untrusted",
                issue_id="I-1",
                red_evidence=red,
                green_evidence=green,
                changed_files=["changed.ts"],
            )
            fake = change_dir / "evidence" / "fake-affected.json"
            fake.write_text(
                json.dumps(
                    {
                        "schemaVersion": 2,
                        "kind": "verification",
                        "status": "PASS",
                        "productIdentity": "sha256:after",
                        "evidenceId": "fake",
                        "passedGates": ["affected"],
                        "provenance": {},
                    }
                ),
                encoding="utf-8",
            )
            review = write_evidence(
                change_dir,
                "reports/review.json",
                kind="review",
                status="PASS",
                product_identity="sha256:after",
                evidence_id="review-trusted",
                passed_gates=["review"],
            )
            with self.assertRaisesRegex(ValueError, "FIXBACK_EVIDENCE_UNREGISTERED"):
                module.close_batch(
                    change_dir,
                    batch_id="batch-untrusted",
                    final_product_identity="sha256:after",
                    affected_receipt=str(fake),
                    review_receipt=review,
                )


if __name__ == "__main__":
    unittest.main()
