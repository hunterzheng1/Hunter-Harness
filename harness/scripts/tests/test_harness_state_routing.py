#!/usr/bin/env python3
"""Resolver routing tests: dynamic artifacts follow stateRoot for split-v1 changes.

Design §3.1: static contract stays in .harness/changes/<id>/; dynamic
events/logs/ledger/tracking are uniquely owned by .harness/state/changes/<id>/.
Legacy contracts keep the colocated layout (existing 312-test suite proves it).
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

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
events = load_module("harness_events", "harness_events.py")
ledger = load_module("harness_ledger", "harness_ledger.py")
guard = load_module("harness_test_guard", "harness_test_guard.py")
change = load_module("harness_change", "harness_change.py")


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


class SplitRoutingFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-routing-"))
        self.project = self.tmp / "project"
        self.project.mkdir(parents=True)
        git(self.project, "init")
        git(self.project, "config", "user.email", "test@example.com")
        git(self.project, "config", "user.name", "Test")
        (self.project / "README.md").write_text("demo\n", encoding="utf-8")
        git(self.project, "add", "README.md")
        git(self.project, "commit", "-m", "init")

        self.change_id = "split-change"
        self.contract_dir = (
            self.project / ".harness" / "changes" / self.change_id
        )
        (self.contract_dir / "meta").mkdir(parents=True)
        (self.contract_dir / "meta" / "change-context.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 2,
                    "changeId": self.change_id,
                    "lifecycle": {"status": "active"},
                    "stateOwnership": {
                        "contractRoot": f".harness/changes/{self.change_id}",
                        "runtimeRoot": f".harness/state/changes/{self.change_id}",
                    },
                }
            ),
            encoding="utf-8",
        )
        self.state_dir = (
            self.project / ".harness" / "state" / "changes" / self.change_id
        )

        self.legacy_id = "legacy-change"
        self.legacy_dir = self.project / ".harness" / "changes" / self.legacy_id
        (self.legacy_dir / "meta").mkdir(parents=True)
        (self.legacy_dir / "meta" / "change-context.json").write_text(
            json.dumps({"schemaVersion": 1, "changeId": self.legacy_id}),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)


class ResolveStateDirHelperTests(SplitRoutingFixture):
    def test_split_contract_routes_to_state_root(self) -> None:
        resolved = paths.resolve_state_dir_for_contract(self.contract_dir)
        self.assertEqual(Path(resolved), self.state_dir.resolve())

    def test_legacy_contract_stays_colocated(self) -> None:
        resolved = paths.resolve_state_dir_for_contract(self.legacy_dir)
        self.assertEqual(Path(resolved), self.legacy_dir.resolve())

    def test_nonstandard_dir_returns_itself(self) -> None:
        loose = self.tmp / "loose-change"
        loose.mkdir()
        resolved = paths.resolve_state_dir_for_contract(loose)
        self.assertEqual(Path(resolved), loose.resolve())


class EventsRoutingTests(SplitRoutingFixture):
    def test_events_path_uses_state_root_for_split(self) -> None:
        self.assertEqual(
            events.events_path(self.contract_dir),
            self.state_dir.resolve() / "events.ndjson",
        )
        self.assertEqual(
            events.execution_log_path(self.contract_dir),
            self.state_dir.resolve() / "logs" / "execution-log.md",
        )

    def test_events_path_legacy_unchanged(self) -> None:
        self.assertEqual(
            events.events_path(self.legacy_dir),
            self.legacy_dir / "events.ndjson",
        )


class LedgerRoutingTests(SplitRoutingFixture):
    def test_preferred_write_path_uses_state_root(self) -> None:
        self.assertEqual(
            ledger.preferred_write_path(self.contract_dir),
            self.state_dir.resolve() / "evidence" / "verification-ledger.json",
        )

    def test_candidates_prefer_state_then_legacy(self) -> None:
        candidates = ledger.ledger_candidates(self.contract_dir)
        self.assertEqual(
            candidates[0],
            self.state_dir.resolve() / "evidence" / "verification-ledger.json",
        )
        self.assertIn(
            self.contract_dir / "evidence" / "verification-ledger.json",
            candidates,
        )

    def test_preferred_write_path_legacy_unchanged(self) -> None:
        self.assertEqual(
            ledger.preferred_write_path(self.legacy_dir),
            self.legacy_dir / "evidence" / "verification-ledger.json",
        )

    def test_load_ledger_reads_legacy_contract_location(self) -> None:
        """A split change with an old ledger at the contract dir still reads it."""
        legacy_ledger = self.contract_dir / "evidence" / "verification-ledger.json"
        legacy_ledger.parent.mkdir(parents=True)
        legacy_ledger.write_text('{"records": []}\n', encoding="utf-8")
        data, found = ledger.load_ledger(self.contract_dir)
        self.assertEqual(found, legacy_ledger)
        self.assertEqual(data, {"records": []})


class TestGuardRoutingTests(SplitRoutingFixture):
    def test_manifest_path_uses_state_root(self) -> None:
        change_root = guard._change_dir(self.project, self.contract_dir)
        self.assertIsNotNone(change_root)
        manifest = guard._manifest_path(change_root)
        self.assertEqual(
            manifest,
            self.state_dir.resolve() / "evidence" / "test-tracking.json",
        )

    def test_manifest_path_legacy_unchanged(self) -> None:
        change_root = guard._change_dir(self.project, self.legacy_dir)
        manifest = guard._manifest_path(change_root)
        self.assertEqual(
            manifest, self.legacy_dir / "evidence" / "test-tracking.json"
        )


class ChangeResolveRoutingTests(SplitRoutingFixture):
    def test_resolve_includes_layout_fields_for_split(self) -> None:
        payload = change.resolve_change(self.project, self.change_id)
        self.assertTrue(payload["ok"], payload)
        self.assertEqual(payload.get("layout"), "split-v1")
        self.assertEqual(
            Path(payload["stateRoot"]), self.state_dir.resolve()
        )
        self.assertEqual(
            Path(payload["contractRoot"]), self.contract_dir.resolve()
        )
        self.assertTrue(str(payload.get("repositoryId", "")).startswith("sha256:"))

    def test_resolve_legacy_marks_colocated(self) -> None:
        payload = change.resolve_change(self.project, self.legacy_id)
        self.assertTrue(payload["ok"], payload)
        self.assertEqual(payload.get("layout"), "legacy-colocated")
        self.assertEqual(
            Path(payload["stateRoot"]), Path(payload["contractRoot"])
        )


if __name__ == "__main__":
    unittest.main()
