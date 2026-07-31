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

    def test_record_recomputes_implicit_diff_hash_after_worktree_changes(self) -> None:
        argv = [
            "--json", "record",
            "--change-dir", str(self.change_dir),
            "--project", str(self.project),
            "--verification", "unitTest",
            "--status", "ok",
            "--command", "pytest -q",
            "--exit-code", "0",
            "--duration-ms", "100",
            "--evidence", "1 passed",
            "--scope", "module",
            "--files", "src/app.py",
        ]
        ledger_path = (
            self.project / ".harness" / "state" / "changes" / "demo"
            / "evidence" / "verification-ledger.json"
        )

        code, _, err = self.run_cli(argv)
        self.assertEqual(code, 0, err)
        before = json.loads(ledger_path.read_text(encoding="utf-8"))["diffHash"]
        (self.project / "src" / "app.py").write_text("print('v2')\n", encoding="utf-8")

        code, _, err = self.run_cli(argv)
        self.assertEqual(code, 0, err)
        written = json.loads(ledger_path.read_text(encoding="utf-8"))

        self.assertNotEqual(written["diffHash"], before)
        self.assertEqual(
            written["diffHash"],
            ledger.compute_ownership_diff(
                self.project,
                base=written["baseCommit"],
                change_dir=self.change_dir,
            )["diffHash"],
        )

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

    def test_legacy_ledger_migrates_explicit_identity_without_changing_evidence(
        self,
    ) -> None:
        legacy_dir = self.project / ".harness" / "changes" / "legacy-explicit"
        (legacy_dir / "meta").mkdir(parents=True)
        (legacy_dir / "meta" / "change-context.json").write_text(
            json.dumps({"schemaVersion": 1, "changeId": "legacy-explicit"}),
            encoding="utf-8",
        )
        ledger_path = legacy_dir / "evidence" / "verification-ledger.json"
        ledger_path.parent.mkdir(parents=True)
        existing_compile = {
            "status": "OK",
            "command": "python -m compileall src",
            "evidence": "legacy compile passed",
            "inputsHash": "sha256:legacy-evidence",
        }
        ledger_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 2,
                    "changeName": "legacy-explicit",
                    "validations": {"compile": existing_compile},
                }
            ),
            encoding="utf-8",
        )
        code, out, err = self.run_cli(
            [
                "--json", "record",
                "--change-dir", str(legacy_dir),
                "--verification", "unitTest",
                "--status", "ok",
                "--command", "pytest -q",
                "--exit-code", "0",
                "--duration-ms", "100",
                "--evidence", "1 passed",
                "--scope", "module",
                "--files", str(self.project / "src" / "app.py"),
                "--diff-hash", "sha256:deadbeef",
                "--verbose",
            ]
        )
        self.assertEqual(code, 0, err)
        written = json.loads(ledger_path.read_text(encoding="utf-8"))
        self.assertEqual(written["schemaVersion"], 3)
        self.assertEqual(written["diffHash"], "sha256:deadbeef")
        self.assertEqual(written["validations"]["compile"], existing_compile)
        receipt = written["migrationHistory"][-1]
        self.assertEqual(receipt["originalSchemaVersion"], 2)
        self.assertEqual(receipt["targetSchemaVersion"], 3)
        self.assertEqual(
            receipt["evidenceIdentityBefore"],
            receipt["evidenceIdentityAfter"],
        )
        payload = json.loads(out)
        self.assertEqual(payload["migrationReceipt"]["receiptId"], receipt["receiptId"])

    def test_migration_failure_preserves_legacy_ledger_and_gives_rerecord_command(
        self,
    ) -> None:
        legacy_dir = self.project / ".harness" / "changes" / "legacy-failure"
        (legacy_dir / "meta").mkdir(parents=True)
        (legacy_dir / "meta" / "change-context.json").write_text(
            json.dumps({"schemaVersion": 1, "changeId": "legacy-failure"}),
            encoding="utf-8",
        )
        ledger_path = legacy_dir / "evidence" / "verification-ledger.json"
        ledger_path.parent.mkdir(parents=True)
        original = json.dumps(
            {
                "schemaVersion": 2,
                "changeName": "legacy-failure",
                "validations": {"compile": {"status": "OK"}},
            }
        )
        ledger_path.write_text(original, encoding="utf-8")
        with mock.patch.object(ledger, "_git_text", return_value=None):
            code, out, err = self.run_cli(
                [
                    "--json", "record",
                    "--change-dir", str(legacy_dir),
                    "--verification", "unitTest",
                    "--status", "ok",
                    "--command", "pytest -q",
                    "--exit-code", "0",
                    "--duration-ms", "100",
                    "--evidence", "1 passed",
                    "--scope", "module",
                    "--files", str(self.project / "src" / "app.py"),
                    "--diff-hash", "sha256:deadbeef",
                ]
            )
        self.assertNotEqual(code, 0)
        payload = json.loads(err)
        self.assertEqual(payload["code"], "LEDGER_MIGRATION_REQUIRED")
        self.assertIsInstance(payload["rerecordCommand"], list)
        self.assertIn("record", payload["rerecordCommand"])
        self.assertEqual(ledger_path.read_text(encoding="utf-8"), original)

    def test_record_resolves_relative_files_against_explicit_project(self) -> None:
        code, out, err = self.run_cli(
            [
                "--json", "record",
                "--change-dir", str(self.change_dir),
                "--project", str(self.project),
                "--verification", "unitTest",
                "--status", "ok",
                "--command", "pytest -q",
                "--exit-code", "0",
                "--duration-ms", "100",
                "--evidence", "1 passed",
                "--scope", "module",
                "--files", "src/app.py",
                "--verbose",
            ]
        )
        self.assertEqual(code, 0, err)
        payload = json.loads(out)
        self.assertEqual(
            payload["resolvedProjectRoot"], str(self.project.resolve())
        )
        self.assertEqual(
            payload["inputsFiles"],
            ["src/app.py"],
        )

    def test_record_supports_utf8_files_and_metrics_files(self) -> None:
        files_manifest = self.tmp / "files.txt"
        files_manifest.write_text("src/app.py\n", encoding="utf-8")
        metrics_file = self.tmp / "metrics.json"
        metrics_file.write_text(
            json.dumps({
                "applicability": "APPLICABLE",
                "status": "OK",
                "total": 3,
                "passed": 3,
                "failed": 0,
                "evidenceHash": "sha256:" + "d" * 64,
            }),
            encoding="utf-8",
        )
        code, out, err = self.run_cli(
            [
                "--json", "record",
                "--change-dir", str(self.change_dir),
                "--project", str(self.project),
                "--verification", "dbCompatibility",
                "--status", "ok",
                "--command", "pytest db_compat.py",
                "--exit-code", "0",
                "--duration-ms", "100",
                "--evidence", "db compatibility passed",
                "--scope", "module",
                "--files-from", str(files_manifest),
                "--metrics-file", str(metrics_file),
            ]
        )
        self.assertEqual(code, 0, err)
        self.assertIn("dbCompatibility", ledger.VERIFICATIONS)
        written = json.loads(
            (
                self.project / ".harness" / "state" / "changes" / "demo"
                / "evidence" / "verification-ledger.json"
            ).read_text(encoding="utf-8")
        )
        self.assertEqual(
            written["validations"]["dbCompatibility"]["metrics"]["status"],
            "OK",
        )


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

    def test_browser_test_is_a_canonical_verification_with_e2e_metrics(self) -> None:
        e2e = {"total": 9, "passed": 8, "failed": 1, "skipped": 0, "retries": 1}

        self.assertIn("browserTest", ledger.VERIFICATIONS)
        self.assertEqual(ledger.REQUIRED_COVERAGE["browserTest"], 1)
        self.assertEqual(ledger.validate_metrics("browserTest", e2e), [])
        self.assertNotEqual(
            ledger.validate_metrics(
                "browserTest",
                {"scenariosTotal": 9, "passed": 8, "failed": 1},
            ),
            [],
        )


class DynamicVerificationTargetTests(LedgerV3Fixture):
    def _write_profile(self) -> None:
        profile = {
            "schemaVersion": 3,
            "commands": {
                "backendTest": {
                    "command": "pytest backend",
                    "argvTemplate": ["pytest", "backend"],
                    "scope": "module",
                    "inputs": ["src/**"],
                    "coverage": "backendTest",
                    "source": "user",
                    "basis": {"policy": "project"},
                }
            },
            "verificationInputs": {"backendTest": ["src/**"]},
            "verificationGraph": {
                "schemaVersion": 1,
                "candidateTarget": "backendTest",
                "targets": {
                    "backendTest": {
                        "commandKey": "backendTest",
                        "dependsOn": [],
                        "requiredCoverage": "module",
                        "candidate": True,
                        "requiredCapabilities": ["python"],
                    }
                },
            },
        }
        path = self.project / ".harness" / "config" / "build-profile.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(profile), encoding="utf-8")

    def test_record_and_reuse_accept_project_defined_verification_target(self) -> None:
        self._write_profile()
        source = str(self.project / "src" / "app.py")
        record_code, _out, record_err = self.run_cli(
            [
                "--json",
                "record",
                "--change-dir",
                str(self.change_dir),
                "--project",
                str(self.project),
                "--verification",
                "backendTest",
                "--status",
                "ok",
                "--command",
                "pytest backend",
                "--exit-code",
                "0",
                "--duration-ms",
                "100",
                "--evidence",
                "backend passed",
                "--scope",
                "module",
                "--coverage",
                "module",
                "--files",
                source,
            ]
        )
        self.assertEqual(record_code, 0, record_err)

        reuse_code, reuse_out, reuse_err = self.run_cli(
            [
                "--json",
                "can-reuse",
                "--change-dir",
                str(self.change_dir),
                "--project",
                str(self.project),
                "--verification",
                "backendTest",
                "--command",
                "pytest backend",
                "--scope",
                "module",
                "--files",
                source,
                "--verbose",
            ]
        )
        self.assertEqual(reuse_code, 0, reuse_err)
        self.assertTrue(json.loads(reuse_out)["reuse"])

    def test_changed_target_definition_invalidates_recorded_evidence(self) -> None:
        self._write_profile()
        source = str(self.project / "src" / "app.py")
        record_code, _out, record_err = self.run_cli(
            [
                "--json",
                "record",
                "--change-dir",
                str(self.change_dir),
                "--project",
                str(self.project),
                "--verification",
                "backendTest",
                "--status",
                "ok",
                "--command",
                "pytest backend",
                "--exit-code",
                "0",
                "--duration-ms",
                "100",
                "--evidence",
                "backend passed",
                "--scope",
                "module",
                "--coverage",
                "module",
                "--files",
                source,
            ]
        )
        self.assertEqual(record_code, 0, record_err)

        profile_path = self.project / ".harness" / "config" / "build-profile.json"
        profile = json.loads(profile_path.read_text(encoding="utf-8"))
        target = profile["verificationGraph"]["targets"]["backendTest"]
        target["requiredCapabilities"] = ["python", "docker"]
        profile_path.write_text(json.dumps(profile), encoding="utf-8")

        reuse_code, reuse_out, reuse_err = self.run_cli(
            [
                "--json",
                "can-reuse",
                "--change-dir",
                str(self.change_dir),
                "--project",
                str(self.project),
                "--verification",
                "backendTest",
                "--command",
                "pytest backend",
                "--scope",
                "module",
                "--files",
                source,
                "--verbose",
            ]
        )
        self.assertEqual(reuse_code, 0, reuse_err)
        payload = json.loads(reuse_out)
        self.assertFalse(payload["reuse"])
        self.assertEqual(payload["code"], "TARGET_IDENTITY_CHANGED")

    def test_unknown_target_without_profile_declaration_fails_closed(self) -> None:
        source = str(self.project / "src" / "app.py")
        code, _out, err = self.run_cli(
            [
                "--json",
                "can-reuse",
                "--change-dir",
                str(self.change_dir),
                "--project",
                str(self.project),
                "--verification",
                "inventedTarget",
                "--files",
                source,
            ]
        )
        self.assertNotEqual(code, 0)
        self.assertIn("unsupported verification", err)

    def test_api_and_browser_records_coexist_without_overwrite(self) -> None:
        source = str(self.project / "src" / "app.py")

        for verification, status, command, metrics in (
            (
                "apiTest",
                "ok",
                "pytest api",
                {"total": 6, "passed": 6, "failed": 0, "blocked": 0},
            ),
            (
                "browserTest",
                "not_run",
                "playwright test --grep real-stack",
                {"total": 3, "passed": 0, "failed": 0, "skipped": 3},
            ),
        ):
            code, _out, err = self.run_cli(
                [
                    "--json",
                    "record",
                    "--change-dir",
                    str(self.change_dir),
                    "--verification",
                    verification,
                    "--status",
                    status,
                    "--command",
                    command,
                    "--exit-code",
                    "0",
                    "--duration-ms",
                    "100",
                    "--evidence",
                    f"{verification} evidence",
                    "--coverage",
                    "module",
                    "--files",
                    source,
                    "--metrics-json",
                    json.dumps(metrics),
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
        self.assertEqual(written["validations"]["apiTest"]["status"], "OK")
        self.assertEqual(written["validations"]["browserTest"]["status"], "NOT_RUN")
        self.assertEqual(written["validations"]["apiTest"]["metrics"]["passed"], 6)
        self.assertEqual(written["validations"]["browserTest"]["metrics"]["skipped"], 3)

    def test_api_test_metrics_are_typed_separately_from_api_contract(self) -> None:
        api_test = {"total": 7, "passed": 6, "failed": 1, "blocked": 0}

        self.assertEqual(ledger.validate_metrics("apiTest", api_test), [])
        self.assertNotEqual(
            ledger.validate_metrics("apiTest", {"scenariosTotal": 7}), []
        )

    def test_db_compatibility_metrics(self) -> None:
        ok = {
            "applicability": "APPLICABLE",
            "status": "OK",
            "total": 3,
            "passed": 3,
            "failed": 0,
            "evidenceHash": "sha256:" + "d" * 64,
        }
        self.assertEqual(ledger.validate_metrics("dbCompatibility", ok), [])
        na = {"applicability": "NOT_APPLICABLE", "reason": "frontend-only change"}
        self.assertEqual(ledger.validate_metrics("dbCompatibility", na), [])

    def test_db_compatibility_rejects_incomplete_or_inconsistent_metrics(self) -> None:
        incomplete = {"applicability": "APPLICABLE", "status": "OK"}
        self.assertNotEqual(ledger.validate_metrics("dbCompatibility", incomplete), [])
        inconsistent = {
            "applicability": "APPLICABLE",
            "status": "OK",
            "total": 2,
            "passed": 2,
            "failed": 1,
            "evidenceHash": "not-a-sha256",
        }
        problems = ledger.validate_metrics("dbCompatibility", inconsistent)
        self.assertTrue(any("counts" in item for item in problems), problems)
        self.assertTrue(any("evidenceHash" in item for item in problems), problems)

    def test_invalid_metrics_rejected(self) -> None:
        self.assertNotEqual(
            ledger.validate_metrics("unitTest", {"passed": "many"}), []
        )


class IntegrationFinalHashTests(LedgerV3Fixture):
    def _identity(self) -> dict:
        head = git(self.project, "rev-parse", "HEAD").stdout.strip()
        return {
            "schemaVersion": 3,
            "repositoryId": paths.repository_identity(self.project),
            "changeName": "demo",
            "baseCommit": head,
            "currentHead": head,
            "diffHash": "sha256:" + "d" * 64,
            "ownershipHash": "sha256:" + "e" * 64,
            "validations": {},
        }

    def test_record_integration_hashes_updates_v3_atomically(self) -> None:
        ledger_path = self.tmp / "verification-ledger.json"
        ledger_path.write_text(json.dumps(self._identity()) + "\n", encoding="utf-8")
        final_hash = git(self.project, "rev-parse", "HEAD").stdout.strip()

        result = ledger.record_integration_hashes(
            ledger_path,
            repository_id=paths.repository_identity(self.project),
            merge_final_hash=final_hash,
            ci_expected_head=final_hash,
            remote_head=final_hash,
        )

        self.assertTrue(result["ok"], result)
        written = json.loads(ledger_path.read_text(encoding="utf-8"))
        self.assertEqual(written["mergeFinalHash"], final_hash)
        self.assertEqual(written["ciExpectedHead"], final_hash)
        self.assertEqual(written["remoteHead"], final_hash)

    def test_record_integration_hashes_rejects_legacy_without_writing(self) -> None:
        ledger_path = self.tmp / "legacy-ledger.json"
        ledger_path.write_text(json.dumps({"changeName": "demo"}) + "\n", encoding="utf-8")
        before = ledger_path.read_bytes()
        final_hash = git(self.project, "rev-parse", "HEAD").stdout.strip()

        result = ledger.record_integration_hashes(
            ledger_path,
            repository_id=paths.repository_identity(self.project),
            merge_final_hash=final_hash,
            ci_expected_head=final_hash,
            remote_head=final_hash,
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "LEDGER_IDENTITY_INVALID")
        self.assertEqual(ledger_path.read_bytes(), before)

    def test_record_integration_hashes_preserves_legacy_contract_lifecycle(self) -> None:
        change_dir = self.project / ".harness" / "changes" / "legacy-demo"
        ledger_path = change_dir / "evidence" / "verification-ledger.json"
        ledger_path.parent.mkdir(parents=True)
        ledger_path.write_text(
            json.dumps({"changeName": "legacy-demo", "validations": {}}) + "\n",
            encoding="utf-8",
        )
        final_hash = git(self.project, "rev-parse", "HEAD").stdout.strip()

        result = ledger.record_integration_hashes(
            ledger_path,
            change_dir=change_dir,
            repository_id=paths.repository_identity(self.project),
            merge_final_hash=final_hash,
            ci_expected_head=final_hash,
            remote_head=final_hash,
        )

        self.assertTrue(result["ok"], result)
        written = json.loads(ledger_path.read_text(encoding="utf-8"))
        self.assertEqual(written["mergeFinalHash"], final_hash)
        self.assertEqual(written["ciExpectedHead"], final_hash)
        self.assertEqual(written["remoteHead"], final_hash)
        self.assertNotIn("schemaVersion", written)


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

    def test_ownership_diff_includes_untracked_owned_and_foreign_files(self) -> None:
        base = git(self.project, "rev-parse", "HEAD").stdout.strip()
        (self.project / "src" / "untracked.py").write_text("x = 1\n", encoding="utf-8")
        docs = self.project / "docs"
        docs.mkdir()
        (docs / "untracked.md").write_text("foreign\n", encoding="utf-8")

        result = ledger.compute_ownership_diff(
            self.project, base=base, change_dir=self.change_dir
        )

        self.assertIn("src/untracked.py", result["files"])
        self.assertIn("docs/untracked.md", result["foreignPaths"])
        self.assertEqual(result["ownedFileCount"], 1)


if __name__ == "__main__":
    unittest.main()
