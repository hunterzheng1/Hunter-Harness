#!/usr/bin/env python3
"""Regression tests for the 2026-07-28 multi-day release hardening."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_archive as ha  # noqa: E402


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )


class MultiDayReleaseHardeningTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-multiday-release-"))
        self.project = self.tmp / "project"
        self.project.mkdir()
        self._git("init")
        self._git("config", "user.email", "tests@example.invalid")
        self._git("config", "user.name", "Harness Tests")
        (self.project / "src").mkdir()
        (self.project / "src" / "app.py").write_text(
            "print('v1')\n", encoding="utf-8", newline="\n"
        )
        self._git("add", "src/app.py")
        self._git("commit", "-m", "product v1")
        self.product_commit = self._git("rev-parse", "HEAD")
        self.product_tree_hash = (
            "sha256:"
            + ha.compute_product_tree_hash_for_commit(
                self.project, self.product_commit
            )["hash"]
        )
        self.change = self.project / ".harness" / "changes" / "demo"
        self.change.mkdir(parents=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _git(self, *args: str) -> str:
        result = subprocess.run(
            ["git", *args],
            cwd=self.project,
            check=True,
            capture_output=True,
            text=True,
        )
        return result.stdout.strip()

    def _receipt(
        self,
        *,
        assurance: str = "remote-attested",
        environment_hash: str | None = "sha256:" + "e" * 64,
        provider_run_digest: str | None = "sha256:" + "r" * 64,
    ) -> dict[str, object]:
        subject: dict[str, object] = {
            "productCommit": self.product_commit,
            "productTreeHash": self.product_tree_hash,
        }
        if environment_hash is not None:
            subject["environmentHash"] = environment_hash
        attestation: dict[str, object] = {
            "url": "https://ci.example/runs/42",
        }
        if provider_run_digest is not None:
            attestation["providerRunDigest"] = provider_run_digest
        return {
            "schemaVersion": 2,
            "provider": "remote-ci",
            "conclusion": "success",
            "assurance": assurance,
            "subject": subject,
            "attestation": attestation,
            "verification": {
                "attestationDigest": "sha256:" + "a" * 64,
            },
        }

    def _policy(self, **candidate_overrides: object) -> None:
        candidate = {
            "remoteRequired": True,
            "minimumAssurance": "remote-attested",
            "requiredCapabilities": [
                "subject-bound",
                "provider-verified",
                "immutable-run",
                "environment-bound",
            ],
        }
        candidate.update(candidate_overrides)
        _write_json(
            self.change / "meta" / "gate-policy.json",
            {
                "schemaVersion": 1,
                "tier": "full",
                "candidateVerification": candidate,
                "releasePolicy": {"allowedFinalStatuses": ["OK"]},
            },
        )

    def _summary(self, **overrides: object) -> dict[str, object]:
        summary: dict[str, object] = {
            "changeName": "demo",
            "finalStatus": "OK",
            "baseCommit": self.product_commit,
            "finalCommit": self.product_commit,
            "productCommit": self.product_commit,
            "productTreeHash": self.product_tree_hash,
            "archiveCommit": self.product_commit,
            "environmentHash": "sha256:" + "e" * 64,
            "diffStat": {"filesChanged": 0, "insertions": 0, "deletions": 0},
            "stageStatus": {"execute": "OK", "review": "OK", "submit": "OK"},
            "stageStatusFromEvents": {
                "test": "OK",
                "review": "OK",
                "submit": "OK",
            },
            "verification": {
                "unitTests": {"passed": 1, "failed": 0},
                "apiTests": {"status": "OK", "passed": 1, "failed": 0},
            },
            "timing": {
                "unclosedAttemptCount": 0,
                "attempts": [],
            },
        }
        summary.update(overrides)
        return summary

    def test_remote_claim_is_record_only_even_when_policy_uses_old_minimum(self) -> None:
        self._policy(minimumAssurance="local-reproducible")
        receipt = self._receipt(assurance="remote-claimed")
        receipt["verification"] = {
            "legacyEvidenceHash": "sha256:" + "1" * 64
        }
        receipt["attestation"] = {"url": "https://ci.example/runs/legacy"}
        _write_json(
            self.change / "evidence" / "product-candidate-verification.json",
            receipt,
        )

        gate = ha.evaluate_product_ci_gate(self.change)

        self.assertFalse(gate["ok"], gate)
        self.assertEqual(gate["code"], "PRODUCT_CANDIDATE_RECORD_ONLY")
        self.assertFalse(gate["releaseCapable"])

    def test_remote_attestation_requires_provider_run_and_environment_binding(self) -> None:
        self._policy()
        _write_json(
            self.change / "evidence" / "product-candidate-verification.json",
            self._receipt(provider_run_digest=None),
        )
        missing_run = ha.evaluate_product_ci_gate(self.change)
        self.assertFalse(missing_run["ok"], missing_run)
        self.assertIn("providerRunDigest", missing_run["message"])

        _write_json(
            self.change / "evidence" / "product-candidate-verification.json",
            self._receipt(environment_hash=None),
        )
        missing_environment = ha.evaluate_product_ci_gate(self.change)
        self.assertFalse(missing_environment["ok"], missing_environment)
        self.assertIn("environmentHash", missing_environment["message"])

    def test_report_adequacy_rejects_candidate_summary_tree_mismatch(self) -> None:
        receipt = self._receipt()
        receipt["subject"]["productTreeHash"] = "sha256:" + "0" * 64
        summary = self._summary(candidateVerification={"evidence": receipt})

        result = ha.validate_report_adequacy(summary)

        self.assertFalse(result["ok"], result)
        issue = next(
            item
            for item in result["issues"]
            if item["code"] == "CANDIDATE_SUMMARY_TREE_MISMATCH"
        )
        self.assertEqual(issue["expected"], self.product_tree_hash)
        self.assertEqual(issue["actual"], "sha256:" + "0" * 64)

    def test_product_identity_uses_commit_tree_not_working_tree(self) -> None:
        (self.project / "src" / "app.py").write_text(
            "print('working tree changed')\n", encoding="utf-8", newline="\n"
        )

        result = ha.validate_product_identity(
            product_commit=self.product_commit,
            product_tree_hash=self.product_tree_hash,
            archive_commit=self.product_commit,
            project=self.project,
        )

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["source"], "git-commit-tree")

    def test_archive_commit_must_descend_from_product_commit(self) -> None:
        self._git("checkout", "--orphan", "unrelated")
        self._git("rm", "-rf", ".")
        (self.project / "other.txt").write_text("other\n", encoding="utf-8")
        self._git("add", "other.txt")
        self._git("commit", "-m", "unrelated")
        unrelated = self._git("rev-parse", "HEAD")

        result = ha.validate_product_identity(
            product_commit=self.product_commit,
            product_tree_hash=self.product_tree_hash,
            archive_commit=unrelated,
            project=self.project,
        )

        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "ARCHIVE_COMMIT_UNRELATED")

    def test_release_formula_conjoins_every_required_gate(self) -> None:
        self.assertTrue(
            hasattr(ha, "evaluate_release_eligibility"),
            "single release eligibility function is missing",
        )
        self._policy()
        receipt = self._receipt()
        _write_json(
            self.change / "evidence" / "product-candidate-verification.json",
            receipt,
        )
        summary = self._summary(candidateVerification={"evidence": receipt})

        decision = ha.evaluate_release_eligibility(
            self.change,
            summary,
            archive_integrity={"ok": True},
            report_adequacy={"ok": True, "issues": []},
        )
        self.assertTrue(decision["releaseEligible"], decision)

        for failed_check in (
            "archiveIntegrity",
            "reportAdequacy",
            "candidateVerification",
            "candidateIdentity",
            "projectReleasePolicy",
            "terminalAttempts",
            "finalStatus",
        ):
            mutated = json.loads(json.dumps(decision["checks"]))
            mutated[failed_check]["ok"] = False
            replay = ha.compose_release_decision(mutated)
            self.assertFalse(replay["releaseEligible"], failed_check)

    def test_warn_final_status_is_not_release_eligible(self) -> None:
        self._policy()
        receipt = self._receipt()
        _write_json(
            self.change / "evidence" / "product-candidate-verification.json",
            receipt,
        )
        summary = self._summary(
            finalStatus="WARN",
            candidateVerification={"evidence": receipt},
        )

        decision = ha.evaluate_release_eligibility(
            self.change,
            summary,
            archive_integrity={"ok": True},
            report_adequacy={"ok": True, "issues": []},
        )

        self.assertFalse(decision["releaseEligible"], decision)
        self.assertFalse(decision["checks"]["finalStatus"]["ok"])


if __name__ == "__main__":
    unittest.main()
