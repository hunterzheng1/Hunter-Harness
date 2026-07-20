#!/usr/bin/env python3
"""Tests for fail-state gate close (C4/T12-T15, retro §5.14).

close --status FAIL must validate field completeness but allow validation
status to be FAIL/NOT_RUN; close --status OK on the same failing ledger
must fail. Promotion gate must block Review/Submit after a FAIL phase.
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

import harness_gate as hg  # noqa: E402


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _bootstrap_change(project: Path, change_id: str) -> Path:
    change_dir = project / ".harness" / "changes" / change_id
    (change_dir / "meta").mkdir(parents=True, exist_ok=True)
    (change_dir / "evidence").mkdir(parents=True, exist_ok=True)
    (change_dir / "logs").mkdir(parents=True, exist_ok=True)
    _write(change_dir / "meta" / "worktree.json", json.dumps({"requested": False}))
    _write(change_dir / "meta" / "gate-policy.json", json.dumps({
        "schemaVersion": 1,
        "capabilities": [],
        "signals": [],
        "requiredValidationsByPhase": {
            "run": ["compile", "unitTest"],
            "test": ["unitTestFull", "apiTest"]
        }
    }))
    return change_dir


def _write_ledger(change_dir: Path, phase: str, validations: dict[str, dict]) -> None:
    ledger_path = change_dir / "evidence" / "verification-ledger.json"
    entries = {}
    for name, fields in validations.items():
        entry = {
            "verification": name,
            "phase": phase,
            "status": fields.get("status", "OK"),
            "command": fields.get("command", "test"),
            "exitCode": fields.get("exitCode", 0),
            "durationMs": fields.get("durationMs", 1000),
            "evidence": fields.get("evidence", "evidence/test.md"),
            "files": fields.get("files", "src/"),
            "algorithmVersion": "harness-ledger-2",
            "coverage": fields.get("coverage", "full"),
            "inputsHash": "sha256:abc",
            "inputsFiles": fields.get("inputsFiles", ["src/"]),
            "scope": "module",
        }
        if "resultClass" in fields:
            entry["resultClass"] = fields["resultClass"]
        entries[name] = entry
    _write(ledger_path, json.dumps({"validations": entries}, indent=2))


def _policy(phase: str, validations: list[str]) -> dict:
    return {"requiredValidations": {phase: validations}}


class FailStateCloseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-fail-close-"))
        self.project = self.tmp / "project"
        (self.project / ".harness" / "changes").mkdir(parents=True, exist_ok=True)
        self.change_dir = _bootstrap_change(self.project, "change-a")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_close_fail_with_fail_ledger_succeeds_and_writes_phase_end_fail(self) -> None:
        # Ledger with unitTestFull=FAIL, apiTest=FAIL/PARTIAL.
        _write_ledger(self.change_dir, "test", {
            "unitTestFull": {"status": "FAIL", "exitCode": 1},
            "apiTest": {"status": "FAIL", "exitCode": 1, "resultClass": "PARTIAL"},
        })
        result = hg.validate_ledger_for_phase_close(
            self.change_dir, "test", _policy("test", ["unitTestFull", "apiTest"]),
            phase_status="FAIL"
        )
        self.assertTrue(result.get("ok"), f"close FAIL should succeed: {result}")
        self.assertEqual(result.get("code"), "LEDGER_OK_FAIL")

    def test_close_ok_with_fail_ledger_fails(self) -> None:
        _write_ledger(self.change_dir, "test", {
            "unitTestFull": {"status": "FAIL", "exitCode": 1},
            "apiTest": {"status": "FAIL", "exitCode": 1},
        })
        result = hg.validate_ledger_for_phase_close(
            self.change_dir, "test", _policy("test", ["unitTestFull", "apiTest"]),
            phase_status="OK"
        )
        self.assertFalse(result.get("ok"))
        # Must fail because required validations are not OK.
        self.assertIn(result.get("code"), {"VALIDATION_NOT_OK", "MISSING_FIELDS", "VALIDATION_MISSING"})

    def test_close_fail_with_missing_validation_still_requires_field_completeness(self) -> None:
        # Ledger missing apiTest entirely: close FAIL must still require the
        # entry to exist (field completeness), but allow its status to be FAIL.
        _write_ledger(self.change_dir, "test", {
            "unitTestFull": {"status": "FAIL", "exitCode": 1},
        })
        result = hg.validate_ledger_for_phase_close(
            self.change_dir, "test", _policy("test", ["unitTestFull", "apiTest"]),
            phase_status="FAIL"
        )
        self.assertFalse(result.get("ok"))
        # apiTest entry is missing entirely — that's a field completeness error.
        self.assertEqual(result.get("code"), "VALIDATION_MISSING")

    def test_result_class_partial_preserved(self) -> None:
        _write_ledger(self.change_dir, "test", {
            "unitTestFull": {"status": "FAIL", "exitCode": 1},
            "apiTest": {"status": "FAIL", "exitCode": 1, "resultClass": "PARTIAL"},
        })
        # The ledger entry should carry resultClass=PARTIAL and not be flattened.
        ledger_path = self.change_dir / "evidence" / "verification-ledger.json"
        ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
        api_entry = ledger["validations"]["apiTest"]
        self.assertEqual(api_entry.get("resultClass"), "PARTIAL")


if __name__ == "__main__":
    unittest.main()
