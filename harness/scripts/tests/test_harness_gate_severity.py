#!/usr/bin/env python3
"""Unit tests for gate severity tiering (P1 controllability)."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import unittest
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


gate = load_module("harness_gate_for_severity", "harness_gate.py")


class GateSeverityModeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.project = Path(tempfile.mkdtemp(prefix="harness-gate-severity-"))
        self.change_dir = self.project / ".harness" / "changes" / "demo"
        (self.change_dir / "meta").mkdir(parents=True)

    def test_default_mode_is_lenient(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("HUNTER_HARNESS_GATE_MODE", None)
            self.assertEqual(
                gate.gate_severity_mode(self.project, self.change_dir), "lenient"
            )

    def test_env_override_wins(self) -> None:
        with mock.patch.dict(
            os.environ, {"HUNTER_HARNESS_GATE_MODE": "strict"}, clear=False
        ):
            self.assertEqual(
                gate.gate_severity_mode(self.project, self.change_dir), "strict"
            )

    def test_env_can_force_lenient(self) -> None:
        config_path = self.project / ".harness" / "config" / "gate-policy.json"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(
            json.dumps({"severityMode": "strict"}), encoding="utf-8"
        )
        with mock.patch.dict(
            os.environ, {"HUNTER_HARNESS_GATE_MODE": "lenient"}, clear=False
        ):
            self.assertEqual(
                gate.gate_severity_mode(self.project, self.change_dir), "lenient"
            )

    def test_change_gate_policy_severity_mode(self) -> None:
        (self.change_dir / "meta" / "gate-policy.json").write_text(
            json.dumps({"schemaVersion": 1, "severityMode": "strict"}),
            encoding="utf-8",
        )
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("HUNTER_HARNESS_GATE_MODE", None)
            self.assertEqual(
                gate.gate_severity_mode(self.project, self.change_dir), "strict"
            )

    def test_project_config_severity_mode(self) -> None:
        config_path = self.project / ".harness" / "config" / "gate-policy.json"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(
            json.dumps({"severityMode": "strict"}), encoding="utf-8"
        )
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("HUNTER_HARNESS_GATE_MODE", None)
            self.assertEqual(
                gate.gate_severity_mode(self.project, self.change_dir), "strict"
            )

    def test_change_policy_overrides_project_config(self) -> None:
        config_path = self.project / ".harness" / "config" / "gate-policy.json"
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(
            json.dumps({"severityMode": "strict"}), encoding="utf-8"
        )
        (self.change_dir / "meta" / "gate-policy.json").write_text(
            json.dumps({"schemaVersion": 1, "severityMode": "lenient"}),
            encoding="utf-8",
        )
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("HUNTER_HARNESS_GATE_MODE", None)
            self.assertEqual(
                gate.gate_severity_mode(self.project, self.change_dir), "lenient"
            )

    def test_invalid_mode_value_falls_back_to_lenient(self) -> None:
        (self.change_dir / "meta" / "gate-policy.json").write_text(
            json.dumps({"schemaVersion": 1, "severityMode": "yolo"}),
            encoding="utf-8",
        )
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("HUNTER_HARNESS_GATE_MODE", None)
            self.assertEqual(
                gate.gate_severity_mode(self.project, self.change_dir), "lenient"
            )


class GateSoftAllowedTests(unittest.TestCase):
    def test_soft_sites_downgrade_only_in_lenient(self) -> None:
        for site in ("plan-handoff", "capsule", "scenario-coverage", "test-guard"):
            self.assertTrue(gate.gate_soft_allowed("lenient", "run", site))
            self.assertFalse(gate.gate_soft_allowed("strict", "run", site))

    def test_release_phases_never_downgrade(self) -> None:
        for phase in ("submit", "merge", "archive", "release", "deploy"):
            self.assertFalse(gate.gate_soft_allowed("lenient", phase, "capsule"))

    def test_unknown_site_never_downgrades(self) -> None:
        self.assertFalse(gate.gate_soft_allowed("lenient", "run", "ledger"))


class RecordGateWarningTests(unittest.TestCase):
    def test_appends_ndjson_receipt(self) -> None:
        change_dir = Path(tempfile.mkdtemp(prefix="harness-gate-warn-"))
        first = gate.record_gate_warning(
            change_dir,
            phase="run",
            site="capsule",
            code="PHASE_CAPSULE_MISMATCH",
            message="stale capsule",
        )
        second = gate.record_gate_warning(
            change_dir,
            phase="run",
            site="scenario-coverage",
            code="SCENARIO_COVERAGE_FAILED",
            message="missing scenario",
        )
        self.assertEqual(first["mode"], "lenient")
        self.assertEqual(second["site"], "scenario-coverage")
        receipt = change_dir / "evidence" / "gate-warnings.ndjson"
        lines = receipt.read_text(encoding="utf-8").strip().splitlines()
        self.assertEqual(len(lines), 2)
        parsed = [json.loads(line) for line in lines]
        self.assertEqual(parsed[0]["code"], "PHASE_CAPSULE_MISMATCH")
        self.assertEqual(parsed[1]["phase"], "run")


if __name__ == "__main__":
    unittest.main()
