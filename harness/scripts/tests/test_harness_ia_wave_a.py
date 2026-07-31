#!/usr/bin/env python3
"""Wave-A IA hardening scenarios (UT-001..033) for 2026-07-23 retro."""

from __future__ import annotations

import datetime as dt
import contextlib
import io
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_archive as ha  # noqa: E402
import harness_environment as henv  # noqa: E402
import harness_events as he  # noqa: E402

from test_harness_archive import _seed_change_dir, _write, _write_json  # noqa: E402


def _write_product_ci(
    change_dir: Path,
    *,
    conclusion: str,
    commit: str = "bbbbbbbb",
    run_url: str = "https://ci.example/runs/1",
) -> None:
    _write_json(
        change_dir / "evidence" / "product-candidate-ci.json",
        {
            "schemaVersion": 1,
            "conclusion": conclusion,
            "commit": commit,
            "runUrl": run_url,
        },
    )


class ProductCiGateTests(unittest.TestCase):
    """UT-001 / UT-002 / INT-001 — product candidate CI hard gate."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="ia-ci-"))
        self.project = self.tmp / "proj"
        self.change = self.project / ".harness" / "changes" / "demo-change"
        self.change.mkdir(parents=True)
        _seed_change_dir(self.change)
        subprocess.run(["git", "init"], cwd=self.project, check=True, capture_output=True)
        subprocess.run(
            ["git", "config", "user.email", "tests@example.invalid"],
            cwd=self.project,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Harness Tests"],
            cwd=self.project,
            check=True,
            capture_output=True,
        )
        _write(self.project / "src" / "app.py", "print('candidate')\n")
        subprocess.run(
            ["git", "add", "src/app.py"],
            cwd=self.project,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "commit", "-m", "candidate"],
            cwd=self.project,
            check=True,
            capture_output=True,
        )
        self.product_commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=self.project,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_ut001_ci_failure_blocks_archive(self) -> None:
        _write_product_ci(self.change, conclusion="failure")
        status = ha.check_status(self.change)
        codes = {b.get("code") for b in status.get("blockers") or []}
        self.assertIn("PRODUCT_CI_NOT_GREEN", codes)
        self.assertFalse(status.get("archivable"))
        blocker = next(
            b for b in status["blockers"] if b.get("code") == "PRODUCT_CI_NOT_GREEN"
        )
        self.assertIn("https://ci.example/runs/1", blocker.get("message", ""))
        self.assertIn("bbbbbbbb", blocker.get("message", ""))

    def test_ut002_legacy_ci_success_is_record_only(self) -> None:
        _write_product_ci(self.change, conclusion="success", commit="bbbbbbbb")
        identity = ha.resolve_product_archive_identity(
            self.change,
            project=self.project,
            product_commit="bbbbbbbb",
            archive_commit="cccccccc",
        )
        self.assertEqual(identity.get("productCommit"), "bbbbbbbb")
        self.assertTrue(identity.get("productTreeHash"))
        self.assertEqual(identity.get("archiveCommit"), "cccccccc")
        status = ha.check_status(self.change)
        codes = {b.get("code") for b in status.get("blockers") or []}
        self.assertIn("PRODUCT_CANDIDATE_RECORD_ONLY", codes)
        self.assertFalse(status["releaseEligible"])

    def test_y1_ci_success_without_run_url_or_commit_not_green(self) -> None:
        """Review Y1: conclusion=success alone must not pass the CI gate."""
        _write_json(
            self.change / "evidence" / "product-candidate-ci.json",
            {
                "schemaVersion": 1,
                "conclusion": "success",
                "commit": "",
                "runUrl": "",
            },
        )
        gate = ha.evaluate_product_ci_gate(self.change)
        self.assertFalse(gate.get("ok"))
        self.assertEqual(gate.get("code"), "PRODUCT_CI_NOT_GREEN")
        self.assertIn("missing", gate.get("message", "").lower())

        _write_json(
            self.change / "evidence" / "product-candidate-ci.json",
            {
                "schemaVersion": 1,
                "conclusion": "success",
                "commit": "bbbbbbbb",
                "runUrl": "",
            },
        )
        gate_url = ha.evaluate_product_ci_gate(self.change)
        self.assertFalse(gate_url.get("ok"))
        self.assertEqual(gate_url.get("code"), "PRODUCT_CI_NOT_GREEN")

        _write_json(
            self.change / "evidence" / "product-candidate-ci.json",
            {
                "schemaVersion": 1,
                "conclusion": "success",
                "commit": "",
                "runUrl": "https://ci.example/runs/1",
            },
        )
        gate_commit = ha.evaluate_product_ci_gate(self.change)
        self.assertFalse(gate_commit.get("ok"))
        self.assertEqual(gate_commit.get("code"), "PRODUCT_CI_NOT_GREEN")

    def test_local_reproducible_candidate_evidence_passes_without_ci(self) -> None:
        (self.change / "evidence" / "product-candidate-ci.json").unlink()
        _write_json(
            self.change / "meta" / "gate-policy.json",
            {
                "schemaVersion": 1,
                "tier": "standard",
                "candidateVerification": {
                    "minimumAssurance": "local-reproducible",
                    "allowLocalRelease": True,
                },
            },
        )
        _write_json(
            self.change / "evidence" / "product-candidate-verification.json",
            {
                "schemaVersion": 2,
                "provider": "local-harness",
                "conclusion": "success",
                "assurance": "local-reproducible",
                "subject": {
                    "productCommit": "bbbbbbbb",
                    "productTreeHash": "sha256:" + "a" * 64,
                    "environmentHash": "sha256:" + "e" * 64,
                },
                "verification": {
                    "commandSetHash": "sha256:" + "b" * 64,
                    "ledgerHash": "sha256:" + "c" * 64,
                    "toolchainHashes": ["sha256:" + "d" * 64],
                    "environmentHashes": ["sha256:" + "e" * 64],
                    "dependencyHashes": ["sha256:" + "f" * 64],
                    "logHashes": ["sha256:" + "1" * 64],
                },
            },
        )

        gate = ha.evaluate_product_ci_gate(self.change)

        self.assertTrue(gate.get("ok"), gate)
        self.assertEqual(gate.get("code"), "PRODUCT_CANDIDATE_VERIFIED")
        self.assertEqual(gate.get("assurance"), "local-reproducible")

    def test_policy_can_require_remote_attestation(self) -> None:
        (self.change / "evidence" / "product-candidate-ci.json").unlink()
        _write_json(
            self.change / "evidence" / "product-candidate-verification.json",
            {
                "schemaVersion": 2,
                "provider": "local-harness",
                "conclusion": "success",
                "assurance": "local-reproducible",
                "subject": {
                    "productCommit": "bbbbbbbb",
                    "productTreeHash": "sha256:" + "a" * 64,
                    "environmentHash": "sha256:" + "e" * 64,
                },
                "verification": {
                    "commandSetHash": "sha256:" + "b" * 64,
                    "ledgerHash": "sha256:" + "c" * 64,
                    "toolchainHashes": ["sha256:" + "d" * 64],
                    "environmentHashes": ["sha256:" + "e" * 64],
                    "dependencyHashes": ["sha256:" + "f" * 64],
                    "logHashes": ["sha256:" + "1" * 64],
                },
            },
        )
        _write_json(
            self.change / "meta" / "gate-policy.json",
            {
                "schemaVersion": 1,
                "tier": "standard",
                "candidateVerification": {
                    "minimumAssurance": "remote-attested",
                },
            },
        )

        gate = ha.evaluate_product_ci_gate(self.change)

        self.assertFalse(gate.get("ok"))
        self.assertEqual(gate.get("code"), "PROJECT_RELEASE_POLICY_BLOCKED")
        self.assertIn("remote-attested", gate.get("message", ""))

    def test_remote_attested_receipt_requires_attestation_digest(self) -> None:
        (self.change / "evidence" / "product-candidate-ci.json").unlink()
        receipt = {
            "schemaVersion": 2,
            "provider": "remote-ci",
            "conclusion": "success",
            "assurance": "remote-attested",
            "subject": {
                "productCommit": "bbbbbbbb",
                "productTreeHash": "sha256:" + "a" * 64,
                "environmentHash": "sha256:" + "e" * 64,
            },
            "attestation": {
                "url": "https://ci.example/runs/attested",
                "providerRunDigest": "sha256:" + "f" * 64,
            },
            "verification": {"ledgerHash": "sha256:" + "c" * 64},
        }
        receipt_path = (
            self.change / "evidence" / "product-candidate-verification.json"
        )
        _write_json(receipt_path, receipt)

        missing_digest = ha.evaluate_product_ci_gate(self.change)
        self.assertFalse(missing_digest["ok"])
        self.assertIn("attestationDigest", missing_digest["message"])

        receipt["verification"]["attestationDigest"] = "sha256:" + "d" * 64
        _write_json(receipt_path, receipt)
        self.assertTrue(ha.evaluate_product_ci_gate(self.change)["ok"])

    def test_record_only_archive_does_not_claim_release_eligibility(self) -> None:
        (self.change / "evidence" / "product-candidate-ci.json").unlink()

        status = ha.check_status(self.change, archive_intent="record-only")

        codes = {b.get("code") for b in status.get("blockers") or []}
        warning_codes = {w.get("code") for w in status.get("warnings") or []}
        self.assertNotIn("PRODUCT_CI_NOT_GREEN", codes)
        self.assertNotIn("PRODUCT_CANDIDATE_NOT_VERIFIED", codes)
        self.assertIn("PRODUCT_CANDIDATE_NOT_VERIFIED", warning_codes)
        self.assertFalse(status.get("releaseEligible"))

    def test_certify_local_reuses_full_ledger_evidence_without_rerunning(self) -> None:
        (self.change / "evidence" / "product-candidate-ci.json").unlink()
        _write_json(
            self.change / "meta" / "gate-policy.json",
            {
                "schemaVersion": 1,
                "tier": "standard",
                "candidateVerification": {
                    "minimumAssurance": "local-reproducible",
                    "allowLocalRelease": True,
                },
            },
        )
        ledger_path = self.change / "evidence" / "verification-ledger.json"
        ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
        ledger["productCommit"] = self.product_commit
        ledger["validations"]["unitTestFull"] = {
            "status": "OK",
            "command": "python -m unittest discover",
            "evidence": {"run": 12, "failures": 0, "errors": 0},
            "inputsHash": "sha256:" + "e" * 64,
            "inputsFiles": ["src/app.py", "tests/test_app.py"],
            "toolchainHash": "sha256:" + "a" * 64,
            "environmentHash": "sha256:" + "b" * 64,
        }
        _write_json(ledger_path, ledger)

        receipt = ha.certify_local_candidate(self.change, project=self.project)

        self.assertEqual(receipt["provider"], "local-harness")
        self.assertEqual(receipt["assurance"], "local-reproducible")
        self.assertEqual(
            receipt["verification"]["reusedValidations"], ["unitTestFull"]
        )
        self.assertEqual(
            receipt["verification"]["toolchainHashes"],
            ["sha256:" + "a" * 64],
        )
        self.assertEqual(
            receipt["verification"]["environmentHashes"],
            ["sha256:" + "b" * 64],
        )
        self.assertEqual(
            receipt["subject"]["environmentHash"],
            "sha256:" + "b" * 64,
        )
        self.assertEqual(
            receipt["verification"]["dependencyHashes"],
            ["sha256:" + "e" * 64],
        )
        self.assertEqual(len(receipt["verification"]["logHashes"]), 1)
        self.assertTrue(
            (self.change / "evidence" / "product-candidate-verification.json").is_file()
        )
        self.assertTrue(ha.evaluate_product_ci_gate(self.change)["ok"])

    def test_local_reproducible_gate_rejects_missing_subject_environment(self) -> None:
        (self.change / "evidence" / "product-candidate-ci.json").unlink()
        _write_json(
            self.change / "meta" / "gate-policy.json",
            {
                "schemaVersion": 1,
                "tier": "standard",
                "candidateVerification": {
                    "minimumAssurance": "local-reproducible",
                    "allowLocalRelease": True,
                },
            },
        )
        _write_json(
            self.change / "evidence" / "product-candidate-verification.json",
            {
                "schemaVersion": 2,
                "provider": "local-harness",
                "conclusion": "success",
                "assurance": "local-reproducible",
                "subject": {
                    "productCommit": "bbbbbbbb",
                    "productTreeHash": "sha256:" + "a" * 64,
                },
                "verification": {
                    "commandSetHash": "sha256:" + "b" * 64,
                    "ledgerHash": "sha256:" + "c" * 64,
                    "toolchainHashes": ["sha256:" + "d" * 64],
                    "environmentHashes": ["sha256:" + "e" * 64],
                    "dependencyHashes": ["sha256:" + "f" * 64],
                    "logHashes": ["sha256:" + "1" * 64],
                },
            },
        )

        gate = ha.evaluate_product_ci_gate(self.change)

        self.assertFalse(gate["ok"])
        self.assertEqual(gate["code"], "PRODUCT_CANDIDATE_NOT_VERIFIED")
        self.assertIn("subject.environmentHash", gate["message"])

    def test_certify_local_rejects_missing_environment_identity(self) -> None:
        (self.change / "evidence" / "product-candidate-ci.json").unlink()
        ledger_path = self.change / "evidence" / "verification-ledger.json"
        ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
        ledger["productCommit"] = self.product_commit
        ledger["validations"]["unitTestFull"] = {
            "status": "OK",
            "command": "python -m unittest discover",
            "evidence": "tests.log",
            "inputsHash": "sha256:" + "e" * 64,
            "inputsFiles": ["src/app.py"],
            "toolchainHash": "sha256:" + "a" * 64,
        }
        _write_json(ledger_path, ledger)

        with self.assertRaisesRegex(ValueError, "environmentHash"):
            ha.certify_local_candidate(self.change, project=self.project)

    def test_certify_local_rejects_stale_product_tree_identity(self) -> None:
        (self.change / "evidence" / "product-candidate-ci.json").unlink()
        ledger_path = self.change / "evidence" / "verification-ledger.json"
        ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
        ledger["productCommit"] = self.product_commit
        ledger["productTreeHash"] = "sha256:" + "0" * 64
        ledger["validations"]["unitTestFull"] = {
            "status": "OK",
            "command": "python -m unittest discover",
            "evidence": "tests.log",
            "inputsHash": "sha256:" + "e" * 64,
            "inputsFiles": ["src/app.py"],
            "toolchainHash": "sha256:" + "a" * 64,
            "environmentHash": "sha256:" + "b" * 64,
        }
        _write_json(ledger_path, ledger)

        with self.assertRaisesRegex(ValueError, "product tree"):
            ha.certify_local_candidate(self.change, project=self.project)

    def test_remote_ci_history_cannot_silently_downgrade_to_local(self) -> None:
        _write_json(
            self.change / "evidence" / "product-candidate-verification.json",
            {
                "schemaVersion": 2,
                "provider": "local-harness",
                "conclusion": "success",
                "assurance": "local-reproducible",
                "subject": {
                    "productCommit": "bbbbbbbb",
                    "productTreeHash": "sha256:" + "a" * 64,
                },
                "verification": {
                    "commandSetHash": "sha256:" + "b" * 64,
                    "ledgerHash": "sha256:" + "c" * 64,
                    "toolchainHashes": ["sha256:" + "d" * 64],
                    "environmentHashes": ["sha256:" + "e" * 64],
                    "dependencyHashes": ["sha256:" + "f" * 64],
                    "logHashes": ["sha256:" + "1" * 64],
                },
            },
        )

        gate = ha.evaluate_product_ci_gate(self.change)

        self.assertFalse(gate["ok"])
        self.assertEqual(gate["code"], "REMOTE_CI_DOWNGRADE_REFUSED")

    def test_legacy_ci_can_be_migrated_to_remote_claimed_receipt(self) -> None:
        receipt = ha.migrate_legacy_candidate_evidence(
            self.change, project=self.project
        )

        self.assertEqual(receipt["schemaVersion"], 2)
        self.assertEqual(receipt["provider"], "remote-ci")
        self.assertEqual(receipt["assurance"], "remote-claimed")
        self.assertIn("legacyEvidenceHash", receipt["verification"])
        self.assertTrue(
            (self.change / "evidence" / "product-candidate-verification.json").is_file()
        )
        gate = ha.evaluate_product_ci_gate(self.change)
        self.assertFalse(gate["ok"])
        self.assertEqual(gate["code"], "PRODUCT_CANDIDATE_RECORD_ONLY")
        self.assertFalse(gate["releaseCapable"])


class ProductIdentityTests(unittest.TestCase):
    """UT-003 / UT-004 — productTreeHash relation + reopen."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="ia-id-"))
        self.project = self.tmp / "proj"
        self.project.mkdir(parents=True)
        (self.project / "src").mkdir()
        _write(self.project / "src" / "app.py", "print(1)\n")
        _write(self.project / ".harness" / "changes" / "x" / "note.txt", "gov\n")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_ut003_tree_hash_mismatch_fails(self) -> None:
        tree = ha.compute_product_tree_hash(self.project)
        result = ha.validate_product_identity(
            product_commit="deadbeef",
            product_tree_hash="0" * 64,
            archive_commit="cafe",
            project=self.project,
            expected_tree_hash=tree,
        )
        self.assertFalse(result.get("ok"))
        self.assertEqual(result.get("code"), "PRODUCT_TREE_HASH_MISMATCH")

    def test_ut004_product_input_change_reopens_archive_evidence(self) -> None:
        tree1 = ha.compute_product_tree_hash(self.project)
        archived = {
            "productCommit": "aaaa",
            "productTreeHash": tree1,
            "archiveCommit": "bbbb",
        }
        _write(self.project / "src" / "app.py", "print(2)\n")
        tree2 = ha.compute_product_tree_hash(self.project)
        self.assertNotEqual(tree1, tree2)
        verdict = ha.evaluate_release_evidence(archived, current_product_tree_hash=tree2)
        self.assertFalse(verdict.get("ok"))
        self.assertEqual(verdict.get("code"), "ARCHIVE_EVIDENCE_REOPEN_REQUIRED")

    def test_y3_tree_hash_detail_reports_truncation(self) -> None:
        """Review Y3: file_limit truncation must surface truncated=True + hash."""
        _write(self.project / "src" / "extra.py", "print('extra')\n")
        detail = ha.compute_product_tree_hash_detail(self.project, file_limit=1)
        self.assertTrue(detail.get("truncated"))
        self.assertEqual(detail.get("fileCount"), 1)
        self.assertEqual(detail.get("limit"), 1)
        digest = detail.get("hash")
        self.assertIsInstance(digest, str)
        self.assertEqual(len(digest), 64)
        # Wrapper still returns the hash string only.
        self.assertEqual(ha.compute_product_tree_hash(self.project, file_limit=1), digest)


class TimingSealTests(unittest.TestCase):
    """UT-010 / UT-011 / UT-012 — unclosed attempt + timing object."""

    def test_overlapping_stage_spans_are_counted_as_interval_union(self) -> None:
        rows = [
            {"type": "phase.start", "phase": "run", "timestamp": "2026-07-23T09:00:00+00:00"},
            {"type": "phase.start", "phase": "test", "timestamp": "2026-07-23T09:30:00+00:00"},
            {"type": "phase.end", "phase": "run", "timestamp": "2026-07-23T10:00:00+00:00"},
            {"type": "phase.end", "phase": "test", "timestamp": "2026-07-23T10:30:00+00:00"},
        ]

        timing = ha.build_workflow_timing(rows)

        self.assertEqual(timing["workflowWallClockMs"], 90 * 60 * 1000)
        self.assertEqual(timing["stageWallClockSpanMs"], 90 * 60 * 1000)

    def test_ut010_unclosed_attempt_sealed_at_recovery_keeps_wall_clock(self) -> None:
        events = [
            {
                "type": "phase.start",
                "phase": "test",
                "attempt": 1,
                "timestamp": "2026-07-23T10:00:00+00:00",
            },
            {
                "type": "command",
                "phase": "test",
                "attempt": 1,
                "timestamp": "2026-07-23T10:05:00+00:00",
            },
            {
                "type": "recovery",
                "phase": "test",
                "attempt": 1,
                "timestamp": "2026-07-23T13:00:00+00:00",
                "note": "late recovery",
            },
        ]
        invocations = he.attempt_invocations(events, cutoff_ts="2026-07-23T13:00:00+00:00")
        self.assertEqual(len(invocations), 1)
        self.assertEqual(invocations[0]["status"], "RECOVERED")
        self.assertEqual(invocations[0]["durationMs"], 3 * 60 * 60 * 1000)
        timing = he.canonical_phase_timing(
            events, cutoff_ts="2026-07-23T13:00:00+00:00"
        )
        self.assertEqual(timing["wallClockSpanMs"], 3 * 60 * 60 * 1000)
        self.assertEqual(timing.get("unclosedAttemptCount") or 0, 0)

    def test_ut011_workflow_timing_fields_and_conservation(self) -> None:
        events = [
            {
                "type": "phase.start",
                "phase": "plan",
                "attempt": 1,
                "timestamp": "2026-07-23T09:00:00+00:00",
            },
            {
                "type": "phase.end",
                "phase": "plan",
                "attempt": 1,
                "status": "OK",
                "timestamp": "2026-07-23T09:10:00+00:00",
            },
            {
                "type": "phase.start",
                "phase": "test",
                "attempt": 1,
                "timestamp": "2026-07-23T09:20:00+00:00",
            },
            {
                "type": "phase.end",
                "phase": "test",
                "attempt": 1,
                "status": "OK",
                "timestamp": "2026-07-23T09:40:00+00:00",
            },
        ]
        timing = ha.build_workflow_timing(
            events, report_cutoff_at="2026-07-23T10:00:00+00:00"
        )
        for key in (
            "workflowStartedAt",
            "reportCutoffAt",
            "workflowWallClockMs",
            "stageActiveExecutionMs",
            "stageWallClockSpanMs",
            "externalWaitMs",
            "agentOrToolUnattributedMs",
            "unclosedAttemptCount",
            "postArchiveEventsExcluded",
        ):
            self.assertIn(key, timing)
        self.assertEqual(timing["reportCutoffAt"], "2026-07-23T10:00:00+00:00")
        self.assertGreaterEqual(
            timing["workflowWallClockMs"], timing["stageWallClockSpanMs"]
        )
        self.assertEqual(timing["stageActiveExecutionMs"], 30 * 60 * 1000)

    def test_ut012_active_sums_only_closed_attempts(self) -> None:
        events = [
            {
                "type": "phase.start",
                "attempt": 1,
                "timestamp": "2026-07-23T10:00:00+00:00",
            },
            {
                "type": "phase.end",
                "attempt": 1,
                "status": "OK",
                "timestamp": "2026-07-23T10:05:00+00:00",
            },
            {
                "type": "phase.start",
                "attempt": 2,
                "timestamp": "2026-07-23T10:10:00+00:00",
            },
        ]
        timing = he.canonical_phase_timing(
            events, cutoff_ts="2026-07-23T10:40:00+00:00"
        )
        self.assertEqual(timing["activeExecutionMs"], 5 * 60 * 1000)
        self.assertEqual(timing["wallClockSpanMs"], 40 * 60 * 1000)
        self.assertGreaterEqual(timing.get("unclosedAttemptCount") or 0, 1)


class ManifestHonestyTests(unittest.TestCase):
    """UT-020 / UT-021 — checksum must not false-green after post-write."""

    def test_ut020_verify_coverage_matches_on_disk(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write(root / "a.txt", "hello\n")
            manifest_path = root / "evidence" / "archive-manifest-after.json"
            manifest = ha.generate_manifest(root, manifest_path)
            result = ha.verify_manifest_byte_coverage(root, manifest)
            self.assertTrue(result.get("ok"))
            self.assertEqual(result.get("checksumStatus"), "OK")

    def test_ut021_post_write_without_exclusion_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root / "reports" / "final" / "summary-data.json"
            _write_json(target, {"v": 1})
            manifest_path = root / "evidence" / "archive-manifest-after.json"
            manifest = ha.generate_manifest(root, manifest_path)
            _write_json(target, {"v": 2, "drift": True})
            result = ha.verify_manifest_byte_coverage(root, manifest)
            self.assertFalse(result.get("ok"))
            self.assertEqual(result.get("checksumStatus"), "FAIL")
            excluded = ha.verify_manifest_byte_coverage(
                root,
                manifest,
                exclude_paths=["reports/final/summary-data.json"],
                exclusion_reasons={
                    "reports/final/summary-data.json": "written after manifest"
                },
            )
            # Honest path: coverage ok only when exclusions are explicit (never silent OK).
            self.assertTrue(excluded.get("ok"))
            self.assertTrue(excluded.get("exclusionReasons"))
            self.assertEqual(excluded.get("checksumStatus"), "OK_WITH_EXCLUSIONS")


class EnvironmentManagerTests(unittest.TestCase):
    """UT-030 / UT-031 / UT-032 — fingerprint + lease."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="ia-env-"))
        self.project = self.tmp / "proj"
        self.project.mkdir()
        _write(self.project / "package-lock.json", '{"lockfileVersion": 3}\n')
        _write(self.project / ".nvmrc", "24\n")
        self.leases = self.project / ".harness" / "runtime" / "env-leases"

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_ut030_same_inputs_same_hash(self) -> None:
        a = henv.compute_environment_hash(self.project)
        b = henv.compute_environment_hash(self.project)
        self.assertEqual(a, b)
        _write(self.project / "package-lock.json", '{"lockfileVersion": 3, "x": 1}\n')
        c = henv.compute_environment_hash(self.project)
        self.assertNotEqual(a, c)

    def test_ut031_writable_stack_requires_lease(self) -> None:
        result = henv.require_writable_lease(
            self.project,
            change_id="change-a",
            stack_id="db-main",
            lease_root=self.leases,
        )
        self.assertFalse(result.get("ok"))
        self.assertEqual(result.get("code"), "ENVIRONMENT_LEASE_REQUIRED")

    def test_ut032_cross_change_writable_share_rejected(self) -> None:
        env_hash = henv.compute_environment_hash(self.project)
        acquired = henv.acquire_lease(
            self.project,
            change_id="change-a",
            stack_id="db-main",
            environment_hash=env_hash,
            lease_root=self.leases,
            writable_volumes=["/data/pg"],
        )
        self.assertTrue(acquired.get("ok"))
        conflict = henv.acquire_lease(
            self.project,
            change_id="change-b",
            stack_id="db-other",
            environment_hash=env_hash,
            lease_root=self.leases,
            writable_volumes=["/data/pg"],
        )
        self.assertFalse(conflict.get("ok"))
        self.assertEqual(conflict.get("code"), "ENVIRONMENT_LEASE_CROSS_CHANGE")

    def test_y2_expired_lease_returns_lease_expired(self) -> None:
        """Review Y2: past expiresAt must yield ENVIRONMENT_LEASE_EXPIRED."""
        self.leases.mkdir(parents=True, exist_ok=True)
        past = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)).isoformat(
            timespec="seconds"
        )
        _write_json(
            self.leases / "db-main.json",
            {
                "schemaVersion": 1,
                "changeId": "change-a",
                "stackId": "db-main",
                "environmentHash": "deadbeef",
                "writableVolumes": ["/data/pg"],
                "acquiredAt": past,
                "expiresAt": past,
                "projectRoot": str(self.project.resolve()),
            },
        )
        result = henv.require_writable_lease(
            self.project,
            change_id="change-a",
            stack_id="db-main",
            lease_root=self.leases,
        )
        self.assertFalse(result.get("ok"))
        self.assertEqual(result.get("code"), "ENVIRONMENT_LEASE_EXPIRED")
        self.assertNotEqual(result.get("code"), "LEASE_HELD")

    def test_environment_receipt_fingerprints_content_without_persisting_secrets(
        self,
    ) -> None:
        receipt = henv.create_environment_receipt(
            self.project,
            stack_id="db-main",
            content_evidence={
                "instanceId": "postgis-1",
                "instanceStartedAt": "2026-07-31T12:00:00Z",
                "migrationHead": "005_ready",
                "seedVersion": "seed-v4",
                "canaries": [
                    {"name": "table:users", "status": "PASS", "identity": "users-v1"},
                    {"name": "redis:ping", "status": "PASS", "identity": "PONG"},
                ],
            },
            environment_values={
                "DATABASE_URL": "postgres://secret@localhost/db",
                "REDIS_URL": "redis://:secret@localhost:6380/4",
            },
            powershell={"edition": "Core", "version": "7.5.2"},
        )

        serialized = json.dumps(receipt)
        self.assertNotIn("postgres://secret", serialized)
        self.assertNotIn("redis://:secret", serialized)
        self.assertEqual(receipt["powershell"]["edition"], "Core")
        self.assertTrue(receipt["contentFingerprint"].startswith("sha256:"))
        self.assertEqual(
            sorted(receipt["environmentFields"]),
            ["DATABASE_URL", "REDIS_URL"],
        )

    def test_prepare_cli_refuses_incomplete_content_evidence(self) -> None:
        evidence = self.tmp / "content-evidence.json"
        output = self.tmp / "environment-receipt.json"
        _write_json(
            evidence,
            {
                "instanceId": "postgis-1",
                "canaries": [{"name": "db", "status": "PASS"}],
            },
        )
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = henv.main(
                [
                    "prepare",
                    "--project",
                    str(self.project),
                    "--stack-id",
                    "db-main",
                    "--content-evidence-file",
                    str(evidence),
                    "--output",
                    str(output),
                ]
            )
        payload = json.loads(stdout.getvalue())
        self.assertEqual(code, 1)
        self.assertEqual(
            payload["code"],
            "ENVIRONMENT_CONTENT_EVIDENCE_INCOMPLETE",
        )
        self.assertIn("migrationHead", payload["missing"])
        self.assertFalse(output.exists())

    def test_content_change_marks_lease_stale_instead_of_reusing(self) -> None:
        first = henv.create_environment_receipt(
            self.project,
            stack_id="db-main",
            content_evidence={
                "instanceId": "postgis-1",
                "instanceStartedAt": "2026-07-31T12:00:00Z",
                "migrationHead": "005_ready",
                "canaries": [
                    {"name": "table:users", "status": "PASS", "identity": "users-v1"}
                ],
            },
        )
        acquired = henv.acquire_lease(
            self.project,
            change_id="change-a",
            stack_id="db-main",
            environment_hash=henv.compute_environment_hash(self.project),
            environment_receipt=first,
            lease_root=self.leases,
        )
        self.assertTrue(acquired["ok"], acquired)
        after_restart = henv.create_environment_receipt(
            self.project,
            stack_id="db-main",
            content_evidence={
                "instanceId": "postgis-1",
                "instanceStartedAt": "2026-07-31T13:00:00Z",
                "migrationHead": "005_ready",
                "canaries": [
                    {
                        "name": "table:users",
                        "status": "FAIL",
                        "identity": "missing",
                    }
                ],
            },
        )

        result = henv.require_writable_lease(
            self.project,
            change_id="change-a",
            stack_id="db-main",
            lease_root=self.leases,
            environment_receipt=after_restart,
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "STALE_CONTENT")
        stored = json.loads(
            (self.leases / "db-main.json").read_text(encoding="utf-8")
        )
        self.assertEqual(stored["status"], "STALE_CONTENT")

    def test_change_session_reuses_matching_content_and_emits_receipt(self) -> None:
        receipt = henv.create_environment_receipt(
            self.project,
            stack_id="db-main",
            content_evidence={
                "instanceId": "postgis-1",
                "instanceStartedAt": "2026-07-31T12:00:00Z",
                "migrationHead": "005_ready",
                "canaries": [{"name": "db", "status": "PASS"}],
            },
        )
        first = henv.acquire_lease(
            self.project,
            change_id="change-a",
            stack_id="db-main",
            environment_hash=henv.compute_environment_hash(self.project),
            environment_receipt=receipt,
            lease_root=self.leases,
            mode="change-session",
        )
        second = henv.acquire_lease(
            self.project,
            change_id="change-a",
            stack_id="db-main",
            environment_hash=henv.compute_environment_hash(self.project),
            environment_receipt=receipt,
            lease_root=self.leases,
            mode="change-session",
        )

        self.assertEqual(first["code"], "LEASE_ACQUIRED")
        self.assertEqual(second["code"], "LEASE_REUSED")
        self.assertEqual(second["lease"]["reuseCount"], 1)
        self.assertEqual(second["lease"]["mode"], "change-session")
        self.assertEqual(Path(second["receiptPath"]).parent.name, "environment-receipts")

    def test_ephemeral_session_resets_instead_of_reusing(self) -> None:
        env_hash = henv.compute_environment_hash(self.project)
        first = henv.acquire_lease(
            self.project,
            change_id="change-a",
            stack_id="db-main",
            environment_hash=env_hash,
            lease_root=self.leases,
            mode="ephemeral",
        )
        second = henv.acquire_lease(
            self.project,
            change_id="change-a",
            stack_id="db-main",
            environment_hash=env_hash,
            lease_root=self.leases,
            mode="ephemeral",
        )
        self.assertFalse(second["ok"])
        self.assertEqual(second["code"], "ENVIRONMENT_RESET_REQUIRED")
        reset_evidence = henv.execute_provider_operation(
            self.project,
            change_id="change-a",
            stack_id="db-main",
            operation="reset",
            argv=[sys.executable, "-c", "print('reset complete')"],
            lease_root=self.leases,
        )
        second = henv.acquire_lease(
            self.project,
            change_id="change-a",
            stack_id="db-main",
            environment_hash=env_hash,
            lease_root=self.leases,
            mode="ephemeral",
            reset_evidence=reset_evidence,
        )

        self.assertEqual(first["code"], "LEASE_ACQUIRED")
        self.assertEqual(second["code"], "LEASE_RESET")
        self.assertNotEqual(first["lease"]["sessionId"], second["lease"]["sessionId"])
        self.assertEqual(second["lease"]["resetCount"], 1)

    def test_release_does_not_claim_provider_cleanup_without_evidence(self) -> None:
        henv.acquire_lease(
            self.project,
            change_id="change-a",
            stack_id="db-main",
            environment_hash=henv.compute_environment_hash(self.project),
            lease_root=self.leases,
        )
        released = henv.release_lease(
            self.project,
            change_id="change-a",
            stack_id="db-main",
            lease_root=self.leases,
        )

        self.assertEqual(released["code"], "LEASE_RELEASED")
        self.assertTrue(Path(released["receiptPath"]).is_file())
        cleanup = json.loads(Path(released["receiptPath"]).read_text(encoding="utf-8"))
        self.assertEqual(cleanup["action"], "release")
        self.assertEqual(cleanup["changeId"], "change-a")

    def test_release_records_cleanup_only_with_matching_provider_evidence(self) -> None:
        env_hash = henv.compute_environment_hash(self.project)
        henv.acquire_lease(
            self.project,
            change_id="change-a",
            stack_id="db-main",
            environment_hash=env_hash,
            lease_root=self.leases,
        )
        cleanup_evidence = henv.execute_provider_operation(
            self.project,
            change_id="change-a",
            stack_id="db-main",
            operation="cleanup",
            argv=[sys.executable, "-c", "print('cleanup complete')"],
            lease_root=self.leases,
        )

        released = henv.release_lease(
            self.project,
            change_id="change-a",
            stack_id="db-main",
            lease_root=self.leases,
            cleanup_evidence=cleanup_evidence,
        )

        self.assertTrue(released["ok"], released)
        receipt = json.loads(Path(released["receiptPath"]).read_text(encoding="utf-8"))
        self.assertEqual(receipt["action"], "cleanup")
        self.assertEqual(
            receipt["operationEvidence"]["operationId"],
            cleanup_evidence["operationId"],
        )

    def test_forged_provider_evidence_and_tampered_content_receipt_fail_closed(
        self,
    ) -> None:
        env_hash = henv.compute_environment_hash(self.project)
        receipt = henv.create_environment_receipt(
            self.project,
            stack_id="db-main",
            content_evidence={
                "instanceId": "postgis-1",
                "instanceStartedAt": "2026-07-31T12:00:00Z",
                "migrationHead": "005_ready",
                "canaries": [{"name": "db", "status": "PASS"}],
            },
        )
        forged = dict(receipt)
        forged["content"]["instanceId"] = "forged"
        acquired = henv.acquire_lease(
            self.project,
            change_id="change-a",
            stack_id="db-main",
            environment_hash=env_hash,
            environment_receipt=forged,
            lease_root=self.leases,
        )
        self.assertFalse(acquired["ok"])
        self.assertEqual(acquired["code"], "ENVIRONMENT_RECEIPT_INVALID")

        first = henv.acquire_lease(
            self.project,
            change_id="change-a",
            stack_id="db-main",
            environment_hash=env_hash,
            lease_root=self.leases,
            mode="ephemeral",
        )
        self.assertTrue(first["ok"], first)
        reset = henv.acquire_lease(
            self.project,
            change_id="change-a",
            stack_id="db-main",
            environment_hash=env_hash,
            lease_root=self.leases,
            mode="ephemeral",
            reset_evidence={
                "schemaVersion": 2,
                "operation": "reset",
                "status": "OK",
                "operationId": "forged",
                "stackId": "db-main",
                "environmentHash": env_hash,
            },
        )
        self.assertFalse(reset["ok"])
        self.assertEqual(reset["code"], "ENVIRONMENT_RESET_REQUIRED")

    def test_change_session_without_content_evidence_is_not_reusable(self) -> None:
        env_hash = henv.compute_environment_hash(self.project)
        first = henv.acquire_lease(
            self.project,
            change_id="change-a",
            stack_id="db-main",
            environment_hash=env_hash,
            lease_root=self.leases,
        )
        second = henv.acquire_lease(
            self.project,
            change_id="change-a",
            stack_id="db-main",
            environment_hash=env_hash,
            lease_root=self.leases,
        )

        self.assertTrue(first["ok"], first)
        self.assertFalse(second["ok"], second)
        self.assertEqual(second["code"], "ENVIRONMENT_RESET_REQUIRED")

    def test_parallel_stack_acquire_has_one_winner(self) -> None:
        env_hash = henv.compute_environment_hash(self.project)

        def acquire(_: int) -> dict:
            return henv.acquire_lease(
                self.project,
                change_id="change-a",
                stack_id="db-main",
                environment_hash=env_hash,
                lease_root=self.leases,
            )

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(acquire, range(2)))

        winners = [result for result in results if result.get("ok")]
        self.assertEqual(len(winners), 1, results)
        self.assertEqual(
            {result.get("code") for result in results if not result.get("ok")},
            {"ENVIRONMENT_RESET_REQUIRED"},
        )

    def test_verification_environment_fails_before_run_when_field_missing(
        self,
    ) -> None:
        receipt = henv.create_environment_receipt(
            self.project,
            stack_id="db-main",
            content_evidence={
                "instanceId": "postgis-1",
                "instanceStartedAt": "2026-07-31T12:00:00Z",
                "migrationHead": "005_ready",
                "canaries": [],
            },
            environment_values={"DATABASE_URL": "postgres://local/db"},
        )

        result = henv.resolve_verification_environment(
            receipt,
            required_fields=["DATABASE_URL", "REDIS_URL"],
            source_environment={"DATABASE_URL": "postgres://local/db"},
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "VERIFICATION_ENVIRONMENT_INCOMPLETE")
        self.assertEqual(result["missing"], ["REDIS_URL"])

    def test_expired_dead_owner_lease_is_classified_then_safely_reaped(self) -> None:
        self.leases.mkdir(parents=True, exist_ok=True)
        past = (
            dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)
        ).isoformat(timespec="seconds")
        _write_json(
            self.leases / "db-main.json",
            {
                "schemaVersion": 2,
                "changeId": "change-a",
                "stackId": "db-main",
                "environmentHash": "sha256:env",
                "status": "ACTIVE",
                "acquiredAt": past,
                "heartbeatAt": past,
                "expiresAt": past,
                "owner": {
                    "pid": 99999999,
                    "executable": sys.executable,
                    "startedAt": past,
                },
            },
        )

        classified = henv.classify_leases(self.leases)
        reaped = henv.reap_expired_leases(self.leases)

        self.assertEqual(classified[0]["classification"], "RECLAIMABLE")
        self.assertEqual(reaped["reaped"], ["db-main"])
        self.assertFalse((self.leases / "db-main.json").exists())
        self.assertTrue(Path(reaped["receiptPath"]).is_file())

    def test_unexpired_lease_with_definitely_dead_owner_is_safely_reaped(self) -> None:
        self.leases.mkdir(parents=True, exist_ok=True)
        now = dt.datetime.now(dt.timezone.utc)
        _write_json(
            self.leases / "db-main.json",
            {
                "schemaVersion": 3,
                "changeId": "change-a",
                "stackId": "db-main",
                "environmentHash": "sha256:env",
                "status": "ACTIVE",
                "acquiredAt": now.isoformat(timespec="seconds"),
                "heartbeatAt": now.isoformat(timespec="seconds"),
                "expiresAt": (now + dt.timedelta(hours=1)).isoformat(
                    timespec="seconds"
                ),
                "owner": {
                    "pid": 99999999,
                    "executable": sys.executable,
                    "startedAt": "2000-01-01T00:00:00+00:00",
                },
            },
        )

        classified = henv.classify_leases(self.leases)
        reaped = henv.reap_expired_leases(self.leases)

        self.assertEqual(classified[0]["classification"], "RECLAIMABLE")
        self.assertEqual(reaped["reaped"], ["db-main"])

    def test_expired_lease_with_incomplete_owner_is_report_only(self) -> None:
        self.leases.mkdir(parents=True, exist_ok=True)
        past = (
            dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=2)
        ).isoformat(timespec="seconds")
        _write_json(
            self.leases / "db-main.json",
            {
                "schemaVersion": 1,
                "changeId": "change-a",
                "stackId": "db-main",
                "expiresAt": past,
            },
        )

        reaped = henv.reap_expired_leases(self.leases)

        self.assertEqual(reaped["reaped"], [])
        self.assertEqual(
            reaped["leases"][0]["classification"],
            "OWNER_IDENTITY_INCOMPLETE",
        )
        self.assertTrue((self.leases / "db-main.json").is_file())


class FallbackHtmlTimingTests(unittest.TestCase):
    def test_html_shows_three_duration_columns_and_cutoff(self) -> None:
        html = ha.render_fallback_html(
            {
                "changeName": "demo",
                "finalStatus": "OK",
                "finalStatusReasons": [],
                "timing": {
                    "workflowWallClockMs": 3_600_000,
                    "stageActiveExecutionMs": 600_000,
                    "stageWallClockSpanMs": 1_800_000,
                    "reportCutoffAt": "2026-07-23T12:00:00+00:00",
                },
                "durations": {
                    "totalLabel": "active-only",
                    "totalMinutes": 10,
                    "stages": [],
                },
                "verification": {},
                "changedFiles": [],
                "archiveManifest": {"checksumStatus": "OK", "totalArchiveFiles": 1},
                "reportPipeline": {"commands": []},
            }
        )
        self.assertIn("workflowWallClock", html)
        self.assertIn("stageActiveExecution", html)
        self.assertIn("stageWallClockSpan", html)
        self.assertIn("reportCutoffAt", html)
        self.assertIn("2026-07-23T12:00:00+00:00", html)


if __name__ == "__main__":
    unittest.main()
