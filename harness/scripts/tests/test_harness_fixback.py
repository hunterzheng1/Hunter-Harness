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
    @staticmethod
    def _write_review_sidecars(
        change_dir: Path,
        *,
        action: str,
        disposition: str = "OPEN",
    ) -> None:
        review_dir = change_dir / "reports" / "review"
        review_dir.mkdir(parents=True, exist_ok=True)
        (review_dir / "review-findings.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "runId": "review-run-1",
                    "findings": [
                        {
                            "id": "f-one",
                            "dimension": "correctness",
                            "severity": "YELLOW",
                            "path": "src/timer.ts",
                            "line": 8,
                            "title": "处理计时边界",
                            "fixbackAction": action,
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        (review_dir / "fixback-dispositions.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "runId": "review-run-1",
                    "dispositions": [
                        {"findingId": "f-one", "disposition": disposition}
                    ],
                }
            ),
            encoding="utf-8",
        )

    def test_manual_review_advice_does_not_create_an_empty_batch(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            self._write_review_sidecars(change_dir, action="manual")

            result = module.review_fixback_plan(change_dir)

            self.assertTrue(result["ok"], result)
            self.assertEqual(result["code"], "FIXBACK_NOTHING_TO_APPLY")
            self.assertFalse((change_dir / "fixback").exists())

    def test_review_finding_without_persisted_id_is_rejected(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            self._write_review_sidecars(change_dir, action="code")
            findings_path = change_dir / "reports" / "review" / "review-findings.json"
            findings = json.loads(findings_path.read_text(encoding="utf-8"))
            findings["findings"][0].pop("id")
            findings_path.write_text(json.dumps(findings), encoding="utf-8")
            dispositions_path = (
                change_dir / "reports" / "review" / "fixback-dispositions.json"
            )
            dispositions = json.loads(dispositions_path.read_text(encoding="utf-8"))
            dispositions["dispositions"] = []
            dispositions_path.write_text(json.dumps(dispositions), encoding="utf-8")

            result = module.review_fixback_plan(change_dir)

            self.assertFalse(result["ok"], result)
            self.assertEqual(result["code"], "FIXBACK_REVIEW_OUTPUTS_INVALID")

    def test_code_review_issue_opens_an_already_populated_batch(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            self._write_review_sidecars(change_dir, action="code")
            plan = module.review_fixback_plan(change_dir)

            batch = module.open_review_batch(
                change_dir,
                plan=plan,
                batch_id="review-fixback-1",
                product_identity="sha256:before",
                run_id="run-fixback-2",
                attempt=2,
            )

            self.assertEqual(len(batch["issues"]), 1)
            self.assertEqual(batch["issues"][0]["issueId"], "f-one")
            self.assertEqual(batch["nextStep"], "resolve-issues")

    def test_one_command_prepares_gate_and_opens_populated_review_batch(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            change_dir = project / ".harness" / "changes" / "timer"
            change_dir.mkdir(parents=True)
            self._write_review_sidecars(change_dir, action="code")

            result = module.launch_review_fixback(
                project=project,
                change="timer",
                change_dir=change_dir,
                executor="cursor",
                skills_root=project / ".cursor" / "skills",
                product_identity="sha256:before",
                run_id="run-fixback-2",
                attempt=2,
                context_prepare=lambda **_kwargs: {"ok": True, "code": "CONTEXT_PREPARED"},
                context_begin=lambda **_kwargs: {"ok": True, "code": "TRANSITION_BEGUN"},
                gate_begin=lambda **_kwargs: {"ok": True, "code": "PHASE_BEGUN"},
                context_cancel=lambda **_kwargs: {"ok": True},
            )

            self.assertTrue(result["ok"], result)
            self.assertEqual(result["code"], "FIXBACK_STARTED")
            self.assertEqual(len(result["batch"]["issues"]), 1)
            events = module.he.load_events(change_dir / "events.ndjson")
            self.assertEqual(events[0]["type"], "phase.prepare.start")
            self.assertEqual(events[-1]["type"], "phase.prepare.end")
            self.assertEqual(events[-1]["status"], "STARTED")

    def test_gate_failure_cancels_target_context_and_never_creates_batch(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            change_dir = project / ".harness" / "changes" / "timer"
            change_dir.mkdir(parents=True)
            self._write_review_sidecars(change_dir, action="code")
            cancelled: list[dict[str, object]] = []

            result = module.launch_review_fixback(
                project=project,
                change="timer",
                change_dir=change_dir,
                executor="cursor",
                skills_root=project / ".cursor" / "skills",
                product_identity="sha256:before",
                run_id="run-fixback-2",
                attempt=2,
                context_prepare=lambda **_kwargs: {"ok": True, "code": "CONTEXT_PREPARED"},
                context_begin=lambda **_kwargs: {"ok": True, "code": "TRANSITION_BEGUN"},
                gate_begin=lambda **_kwargs: {
                    "ok": False,
                    "code": "CONTEXT_HANDOFF_REQUIRED",
                    "message": "阶段交接尚未完成，修复未启动。",
                },
                context_cancel=lambda **kwargs: cancelled.append(kwargs) or {"ok": True},
            )

            self.assertFalse(result["ok"], result)
            self.assertEqual(result["code"], "CONTEXT_HANDOFF_REQUIRED")
            self.assertEqual(len(cancelled), 1)
            self.assertFalse((change_dir / "fixback" / "batches").exists())
            events = module.he.load_events(change_dir / "events.ndjson")
            self.assertEqual(events[-1]["type"], "phase.prepare.end")
            self.assertEqual(events[-1]["status"], "BLOCKED")

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

    def test_close_batch_flips_fixback_session_to_closed(self) -> None:
        """F-5：批次关闭时托管会话必须同步 CLOSED，不再误拦后续 launch-review。"""
        self.assertTrue(SCRIPT.is_file(), "harness_fixback.py must be implemented")
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            module.open_batch(
                change_dir,
                batch_id="batch-1",
                product_identity="sha256:before",
                root_cause="shared collection contract",
            )
            module.add_issue(
                change_dir,
                batch_id="batch-1",
                issue_id="I-1",
                summary="问题一",
                risk_tags=[],
            )
            src = change_dir / "src"
            src.mkdir(parents=True, exist_ok=True)
            (src / "i1.ts").write_text("export {};\n", encoding="utf-8")
            module.resolve_issue(
                change_dir,
                batch_id="batch-1",
                issue_id="I-1",
                red_evidence=write_evidence(
                    change_dir,
                    "evidence/red-i1.json",
                    kind="red",
                    status="FAIL",
                    product_identity="sha256:before",
                    evidence_id="red-i1",
                ),
                green_evidence=write_evidence(
                    change_dir,
                    "evidence/green-i1.json",
                    kind="green",
                    status="PASS",
                    product_identity="sha256:after",
                    evidence_id="green-i1",
                ),
                changed_files=["src/i1.ts"],
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
            # 托管会话（launch-review 产物）：批次开着时 ACTIVE
            session_path = module._session_path(change_dir)
            session_path.parent.mkdir(parents=True, exist_ok=True)
            session_path.write_text(
                json.dumps({
                    "schemaVersion": 1,
                    "status": "ACTIVE",
                    "batchId": "batch-1",
                    "runId": "run-1",
                    "attempt": 1,
                    "nextStep": "resolve-issues",
                }),
                encoding="utf-8",
            )

            closed = module.close_batch(
                change_dir,
                batch_id="batch-1",
                final_product_identity="sha256:after",
                affected_receipt=affected,
                review_receipt=review,
            )
            self.assertEqual(closed["status"], "CLOSED")
            session = json.loads(session_path.read_text(encoding="utf-8"))
            self.assertEqual(session["status"], "CLOSED")
            self.assertEqual(session["nextStep"], "done")

    def test_evidence_template_out_with_change_dir_prefix_is_not_double_joined(self) -> None:
        """F-3：--out 已含 change-dir 前缀时按 cwd 解析，不拼出嵌套幽灵目录。"""
        import os
        self.assertTrue(SCRIPT.is_file(), "harness_fixback.py must be implemented")
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            change_dir = project / ".harness" / "changes" / "demo"
            change_dir.mkdir(parents=True)
            state_root = module._state_root(change_dir)
            review_dir = state_root / "reports" / "review"
            review_dir.mkdir(parents=True, exist_ok=True)
            (review_dir / "review-findings.json").write_text(
                json.dumps({"runId": "rev-1", "findings": []}),
                encoding="utf-8",
            )
            old_cwd = os.getcwd()
            os.chdir(project)
            try:
                result = module.evidence_template(
                    change_dir,
                    kind="review",
                    out=".harness/changes/demo/evidence/review-1.json",
                    evidence_id="review-1",
                    product_identity="sha256:x",
                )
            finally:
                os.chdir(old_cwd)
            self.assertTrue(result["ok"], result)
            self.assertTrue(
                (change_dir / "evidence" / "review-1.json").is_file(), result
            )
            self.assertFalse((change_dir / ".harness").exists())

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


def _write_findings_with_disposition(
    change_dir: Path,
    *,
    severity: str,
    disposition: str | None,
    finding_id: str = "f-one",
) -> Path:
    """审查 sidecar：findings 保留全部发现，dispositions 记录处置结论。"""
    review_dir = change_dir / "reports" / "review"
    review_dir.mkdir(parents=True, exist_ok=True)
    findings_path = review_dir / "review-findings.json"
    findings_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "runId": "review-run-1",
                "changeName": change_dir.name,
                "findings": [
                    {
                        "id": finding_id,
                        "dimension": "compatibility",
                        "severity": severity,
                        "path": "bin/cli.js",
                        "line": 13,
                        "title": "auth 静默落入 init",
                        "fixbackAction": "code",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    if disposition is not None:
        (review_dir / "fixback-dispositions.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "runId": "review-run-1",
                    "dispositions": [
                        {"findingId": finding_id, "disposition": disposition}
                    ],
                }
            ),
            encoding="utf-8",
        )
    return findings_path


def _review_evidence_for(change_dir: Path, findings_path: Path, relative: str) -> str:
    """按 review-findings.json 当前字节构造一份 review 证据文件。"""
    digest = "sha256:" + hashlib.sha256(findings_path.read_bytes()).hexdigest()
    path = change_dir / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "schemaVersion": 2,
                "kind": "review",
                "status": "OK",
                "productIdentity": "sha256:after",
                "evidenceId": "review-1",
                "passedGates": ["review"],
                "provenance": {
                    "type": "harness-review",
                    "reviewReportPath": str(findings_path),
                    "reviewRunId": "review-run-1",
                    "engine": "harness-review-6d",
                    "sourceDigest": digest,
                },
            }
        ),
        encoding="utf-8",
    )
    return relative


class ReviewReceiptRespectsDispositionsTests(unittest.TestCase):
    """close 的 review 收据此前只看 severity，逼调用方清空 findings 才能过关。

    2026-08-19 kld-sdd 执行记录：agent 为了让 close 通过，把 review-findings.json
    写成空列表，抹掉了 3 条原始发现 + 2 条复审发现的全部审计轨迹。门禁没有正规
    出路时，绕道就是唯一出路——这些测试把出路钉死在 dispositions 上。
    """

    def test_fixed_finding_no_longer_blocks_and_findings_survive(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            findings_path = _write_findings_with_disposition(
                change_dir, severity="YELLOW", disposition="FIXED"
            )
            before = findings_path.read_bytes()
            relative = _review_evidence_for(
                change_dir, findings_path, "runtime/review-evidence.json"
            )

            record = module.register_evidence(change_dir, relative)

            self.assertEqual(record["kind"], "review")
            # 关键回归：注册成功且发现记录一字未动。
            self.assertEqual(findings_path.read_bytes(), before)
            self.assertEqual(
                len(json.loads(findings_path.read_text(encoding="utf-8"))["findings"]),
                1,
            )

    def test_accepted_risk_passes_and_is_recorded_as_residual_risk(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            findings_path = _write_findings_with_disposition(
                change_dir, severity="YELLOW", disposition="ACCEPTED_RISK"
            )
            relative = _review_evidence_for(
                change_dir, findings_path, "runtime/review-evidence.json"
            )

            record = module.register_evidence(change_dir, relative)

            # 放行但必须留痕，不能让已接受的风险悄悄消失。
            self.assertEqual(
                [item["findingId"] for item in record["residualRisks"]], ["f-one"]
            )
            self.assertEqual(record["residualRisks"][0]["disposition"], "ACCEPTED_RISK")

    def test_open_finding_still_blocks_and_names_the_finding(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            findings_path = _write_findings_with_disposition(
                change_dir, severity="RED", disposition="OPEN"
            )
            relative = _review_evidence_for(
                change_dir, findings_path, "runtime/review-evidence.json"
            )

            with self.assertRaises(ValueError) as caught:
                module.register_evidence(change_dir, relative)

            message = str(caught.exception)
            self.assertIn("FIXBACK_REVIEW_PROVENANCE_INVALID", message)
            # 只回显错误码等于没说——必须点名是哪条发现还没处置。
            self.assertIn("f-one", message)

    def test_undispositioned_finding_still_blocks(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            findings_path = _write_findings_with_disposition(
                change_dir, severity="YELLOW", disposition=None
            )
            relative = _review_evidence_for(
                change_dir, findings_path, "runtime/review-evidence.json"
            )

            with self.assertRaisesRegex(
                ValueError, "FIXBACK_REVIEW_PROVENANCE_INVALID"
            ):
                module.register_evidence(change_dir, relative)


class EvidenceTemplateTests(unittest.TestCase):
    """手写证据 JSON 是 fixback 最贵的一段：schema 只存在于 Python 源码里。

    ledger 的 scenario-receipt-template 已经证明模板生成器能一次给对；fixback
    缺同类入口，于是 2026-08-19 那轮里 agent 反复 grep 源码、撞
    FIXBACK_RUN_PROVENANCE_INVALID、再补 sessionId/commandHash/resultDigest。
    """

    @staticmethod
    def _write_session(change_dir: Path, session_id: str, status: str) -> None:
        run_path = (
            change_dir / "runtime" / "run-sessions" / session_id / "session.json"
        )
        run_path.parent.mkdir(parents=True, exist_ok=True)
        run_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "sessionId": session_id,
                    "verification": "unitTest",
                    "status": status,
                    "testProcessStarted": True,
                    "productIdentity": "sha256:after",
                    "commandHash": "sha256:" + "a" * 64,
                    "resultDigest": "sha256:" + "b" * 64,
                    "endedAt": "2026-08-19T21:00:00+08:00",
                }
            ),
            encoding="utf-8",
        )

    def test_template_output_registers_without_hand_editing(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            self._write_session(change_dir, "run-red-1", "FAIL")

            result = module.evidence_template(
                change_dir,
                kind="red",
                session_id="run-red-1",
                out="runtime/fixback-red.json",
            )

            self.assertTrue(result["ok"], result)
            # 模板必须直接可注册——需要再手改一个字段就等于没解决问题。
            record = module.register_evidence(change_dir, result["path"])
            self.assertEqual(record["kind"], "red")
            self.assertEqual(record["status"], "FAIL")

    def test_template_rejects_a_session_whose_status_contradicts_the_kind(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            self._write_session(change_dir, "run-ok-1", "OK")

            result = module.evidence_template(
                change_dir,
                kind="red",
                session_id="run-ok-1",
                out="runtime/fixback-red.json",
            )

            self.assertFalse(result["ok"], result)
            self.assertEqual(result["code"], "FIXBACK_SESSION_STATUS_MISMATCH")
            # 要说清楚 RED 必须来自修复前的失败会话，而不是让人回退代码去凑。
            self.assertIn("FAIL", result["recoveryAction"])


class RunProvenanceDiagnosticsTests(unittest.TestCase):
    """FIXBACK_RUN_PROVENANCE_INVALID 此前只有码，调用方只能去读源码 debug。"""

    def test_field_mismatch_is_named_with_expected_and_actual(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            EvidenceTemplateTests._write_session(change_dir, "run-red-2", "FAIL")
            template = module.evidence_template(
                change_dir,
                kind="red",
                session_id="run-red-2",
                out="runtime/fixback-red.json",
            )
            path = change_dir / "runtime" / "fixback-red.json"
            payload = json.loads(path.read_text(encoding="utf-8"))
            payload["provenance"]["commandHash"] = "sha256:" + "c" * 64
            path.write_text(json.dumps(payload), encoding="utf-8")

            with self.assertRaises(ValueError) as caught:
                module.register_evidence(change_dir, template["path"])

            message = str(caught.exception)
            self.assertIn("FIXBACK_RUN_PROVENANCE_INVALID", message)
            self.assertIn("commandHash", message)


class ProductIdentityDefaultTests(unittest.TestCase):
    """--product-identity 必填却零文档，2026-08-19 那轮靠 8 次 grep 源码猜出来。"""

    def test_resolved_identity_is_derivable_and_stable(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            first = module.resolve_product_identity(change_dir)
            second = module.resolve_product_identity(change_dir)

            self.assertTrue(first.strip())
            # 同一产品状态两次推导必须一致，否则 close 的身份比对会无故失败。
            self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
