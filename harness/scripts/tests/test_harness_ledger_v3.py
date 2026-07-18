#!/usr/bin/env python3
"""Ledger v3 tests (cluster B, task 6).

Covers:
- Forced top-level identity for v2-contract changes (schemaVersion/
  repositoryId/changeName/baseCommit/currentHead/diffHash/ownershipHash);
  missing unresolvable fields -> non-zero exit, no partial ledger.
- Atomic write: temp -> fsync -> replace; a failed replace leaves the prior
  ledger byte-identical.
- Typed metrics schemas (UT-005/RET-15, UT-006/RET-16).
- Applicability: NOT_APPLICABLE with scope reason is neither pass nor fail
  (UT-012/RET-24).
- Ownership-scoped diffHash: excludes .harness/state/** and foreign changes;
  reports ownedFileCount/excludedRuntimeCount/foreignPaths (COM-002/RET-18).
"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
from unittest import mock

SCRIPTS_DIR = Path(__file__).resolve().parents[1]


def load_module(name: str, filename: str):
    path = SCRIPTS_DIR / filename
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


paths = load_module("harness_paths", "harness_paths.py")
ledger = load_module("harness_ledger", "harness_ledger.py")


def git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=check,
    )


class LedgerV3Fixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-ledger3-"))
        self.project = self.tmp / "project"
        self.project.mkdir(parents=True)
        git(self.project, "init")
        git(self.project, "config", "user.email", "test@example.com")
        git(self.project, "config", "user.name", "Test")
        (self.project / "src").mkdir()
        (self.project / "src" / "app.py").write_text("print('v1')\n", encoding="utf-8")
        git(self.project, "add", "-A")
        git(self.project, "commit", "-m", "init")
        self.change_dir = self.project / ".harness" / "changes" / "demo"
        (self.change_dir / "meta").mkdir(parents=True)
        (self.change_dir / "meta" / "change-context.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 2,
                    "changeId": "demo",
                    "lifecycle": {"status": "active"},
                    "ownership": {
                        "productPaths": ["src/"],
                        "staticEvidencePaths": [".harness/changes/demo/spec"],
                        "excludedPaths": [".harness/state/"],
                    },
                    "stateOwnership": {
                        "contractRoot": ".harness/changes/demo",
                        "runtimeRoot": ".harness/state/changes/demo",
                    },
                }
            ),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_cli(self, argv: list[str]) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = ledger.main(argv)
        return code, out.getvalue(), err.getvalue()


class AtomicWriteTests(LedgerV3Fixture):
    def test_failed_replace_leaves_prior_ledger_intact(self) -> None:
        target = (
            self.project
            / ".harness"
            / "state"
            / "changes"
            / "demo"
            / "evidence"
            / "verification-ledger.json"
        )
        target.parent.mkdir(parents=True)
        original = '{"validations": {"unitTest": {"status": "OK"}}}\n'
        target.write_text(original, encoding="utf-8")

        with mock.patch.object(ledger.os, "replace", side_effect=OSError("boom")):
            with self.assertRaises(OSError):
                ledger.write_ledger(target, {"validations": {}})
        self.assertEqual(target.read_text(encoding="utf-8"), original)
        leftovers = list(target.parent.glob("*.tmp"))
        self.assertEqual(leftovers, [], leftovers)

    def test_write_produces_valid_content(self) -> None:
        target = self.tmp / "out" / "verification-ledger.json"
        ledger.write_ledger(target, {"schemaVersion": 3, "validations": {}})
        self.assertEqual(
            json.loads(target.read_text(encoding="utf-8")),
            {"schemaVersion": 3, "validations": {}},
        )


class IdentityEnforcementTests(LedgerV3Fixture):
    def test_record_v2_contract_writes_full_identity(self) -> None:
        code, out, err = self.run_cli(
            [
                "--json",
                "record",
                "--change-dir",
                str(self.change_dir),
                "--verification",
                "unitTest",
                "--status",
                "ok",
                "--command",
                "pytest -q",
                "--exit-code",
                "0",
                "--duration-ms",
                "100",
                "--evidence",
                "1 passed",
                "--scope",
                "module",
                "--files",
                str(self.project / "src" / "app.py"),
                "--diff-hash",
                "sha256:deadbeef",
            ]
        )
        self.assertEqual(code, 0, err)
        written = json.loads(
            (
                self.project
                / ".harness"
                / "state"
                / "changes"
                / "demo"
                / "evidence"
                / "verification-ledger.json"
            ).read_text(encoding="utf-8")
        )
        self.assertEqual(written["schemaVersion"], 3)
        self.assertTrue(str(written["repositoryId"]).startswith("sha256:"))
        self.assertEqual(written["changeName"], "demo")
        self.assertTrue(written["baseCommit"])
        self.assertTrue(written["currentHead"])
        self.assertEqual(written["diffHash"], "sha256:deadbeef")
        self.assertTrue(str(written["ownershipHash"]).startswith("sha256:"))

    def test_validate_identity_reports_missing(self) -> None:
        missing = ledger.validate_ledger_identity({"schemaVersion": 3})
        for field in (
            "repositoryId",
            "changeName",
            "baseCommit",
            "currentHead",
            "diffHash",
            "ownershipHash",
        ):
            self.assertIn(field, missing)

    def test_legacy_contract_record_keeps_v2_shape(self) -> None:
        legacy_dir = self.project / ".harness" / "changes" / "legacy"
        (legacy_dir / "meta").mkdir(parents=True)
        (legacy_dir / "meta" / "change-context.json").write_text(
            json.dumps({"schemaVersion": 1, "changeId": "legacy"}), encoding="utf-8"
        )
        code, out, err = self.run_cli(
            [
                "--json",
                "record",
                "--change-dir",
                str(legacy_dir),
                "--verification",
                "unitTest",
                "--status",
                "ok",
                "--command",
                "pytest -q",
                "--exit-code",
                "0",
                "--duration-ms",
                "100",
                "--evidence",
                "1 passed",
                "--scope",
                "module",
                "--files",
                str(self.project / "src" / "app.py"),
            ]
        )
        self.assertEqual(code, 0, err)
        written = json.loads(
            (legacy_dir / "evidence" / "verification-ledger.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertNotEqual(written.get("schemaVersion"), 3)


class TypedMetricsTests(LedgerV3Fixture):
    def test_unit_metrics_schema_ret15(self) -> None:
        metrics = {"total": 52, "passed": 52, "failed": 0, "errors": 0, "skipped": 0}
        problems = ledger.validate_metrics("unitTestFull", metrics)
        self.assertEqual(problems, [])

    def test_api_contract_and_browser_e2e_are_distinct_ret16(self) -> None:
        api = {"scenariosTotal": 7, "passed": 7, "failed": 0, "blocked": 0}
        e2e = {"total": 9, "passed": 9, "failed": 0, "skipped": 0, "retries": 0}
        self.assertEqual(ledger.validate_metrics("apiContract", api), [])
        self.assertEqual(ledger.validate_metrics("browserE2E", e2e), [])
        # Cross-type metrics must not validate:
        self.assertNotEqual(ledger.validate_metrics("apiContract", e2e), [])

    def test_db_compatibility_metrics(self) -> None:
        ok = {"applicability": "APPLICABLE", "status": "OK"}
        self.assertEqual(ledger.validate_metrics("dbCompatibility", ok), [])
        na = {"applicability": "NOT_APPLICABLE", "reason": "frontend-only change"}
        self.assertEqual(ledger.validate_metrics("dbCompatibility", na), [])

    def test_invalid_metrics_rejected(self) -> None:
        self.assertNotEqual(
            ledger.validate_metrics("unitTest", {"passed": "many"}), []
        )


class ApplicabilityTests(LedgerV3Fixture):
    def test_not_applicable_neither_pass_nor_fail_ret24(self) -> None:
        entry = ledger.build_applicability_entry(
            "NOT_APPLICABLE", reason="no database in scope"
        )
        self.assertEqual(entry["applicability"], "NOT_APPLICABLE")
        self.assertEqual(entry["reason"], "no database in scope")
        self.assertFalse(ledger.applicability_counts_as_success(entry))
        self.assertFalse(ledger.applicability_counts_as_failure(entry))

    def test_not_applicable_requires_reason(self) -> None:
        with self.assertRaises(ValueError):
            ledger.build_applicability_entry("NOT_APPLICABLE", reason="")

    def test_applicable_pass_through(self) -> None:
        entry = ledger.build_applicability_entry("APPLICABLE")
        self.assertTrue(ledger.applicability_counts_as_success(entry) is False)
        self.assertEqual(entry["applicability"], "APPLICABLE")


class OwnershipDiffTests(LedgerV3Fixture):
    def _commit_all(self, message: str) -> None:
        git(self.project, "add", "-A")
        git(self.project, "commit", "-m", message)

    def test_ownership_diff_excludes_runtime_and_foreign_ret18(self) -> None:
        base = git(self.project, "rev-parse", "HEAD").stdout.strip()
        # Owned product change.
        (self.project / "src" / "app.py").write_text("print('v2')\n", encoding="utf-8")
        # Dynamic runtime evidence (excluded).
        runtime = self.project / ".harness" / "state" / "changes" / "demo"
        runtime.mkdir(parents=True)
        (runtime / "events.ndjson").write_text('{"id":"e1"}\n', encoding="utf-8")
        # Foreign change contract (reported, not owned).
        foreign = self.project / ".harness" / "changes" / "other" / "meta"
        foreign.mkdir(parents=True)
        (foreign / "change-context.json").write_text(
            json.dumps({"schemaVersion": 1, "changeId": "other"}), encoding="utf-8"
        )
        # Own static contract (owned).
        (self.change_dir / "spec").mkdir(parents=True)
        (self.change_dir / "spec" / "demo-design.md").write_text(
            "# Design\n", encoding="utf-8"
        )
        unrelated = self.project / "docs" / "unrelated.md"
        unrelated.parent.mkdir(parents=True)
        unrelated.write_text("not part of demo\n", encoding="utf-8")
        self._commit_all("mixed changes")

        result = ledger.compute_ownership_diff(
            self.project, base=base, change_dir=self.change_dir
        )
        owned = set(result["files"])
        self.assertIn("src/app.py", owned)
        self.assertNotIn(".harness/changes/demo/spec/demo-design.md", owned)
        self.assertIn(
            ".harness/changes/demo/spec/demo-design.md",
            result["staticEvidenceFiles"],
        )
        self.assertNotIn(".harness/state/changes/demo/events.ndjson", owned)
        self.assertIn(".harness/changes/other/meta/change-context.json", result["foreignPaths"])
        self.assertIn("docs/unrelated.md", result["foreignPaths"])
        self.assertGreaterEqual(result["excludedRuntimeCount"], 1)
        self.assertEqual(result["ownedFileCount"], len(result["files"]))
        self.assertTrue(str(result["diffHash"]).startswith("sha256:"))

    def test_ownership_diff_is_stable(self) -> None:
        base = git(self.project, "rev-parse", "HEAD").stdout.strip()
        (self.project / "src" / "new.py").write_text("x = 1\n", encoding="utf-8")
        self._commit_all("add new")
        first = ledger.compute_ownership_diff(
            self.project, base=base, change_dir=self.change_dir
        )
        second = ledger.compute_ownership_diff(
            self.project, base=base, change_dir=self.change_dir
        )
        self.assertEqual(first["diffHash"], second["diffHash"])


if __name__ == "__main__":
    unittest.main()
