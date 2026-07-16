#!/usr/bin/env python3
"""Regression tests for harness_change.py (UT-017, UT-019)."""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
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


change = load_module("harness_change", "harness_change.py")


class HarnessChangeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.project = Path(tempfile.mkdtemp(prefix="harness-change-project-"))
        self.changes = self.project / ".harness" / "changes"
        for change_id in ("alpha", "beta"):
            meta = self.changes / change_id / "meta"
            meta.mkdir(parents=True)
            (meta / "change-context.json").write_text(
                json.dumps({"schemaVersion": 1, "changeId": change_id}),
                encoding="utf-8",
            )
        self._git_init()

    def tearDown(self) -> None:
        shutil.rmtree(self.project, ignore_errors=True)

    def _git_init(self) -> None:
        subprocess.run(["git", "init"], cwd=self.project, check=True, capture_output=True)
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=self.project,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Test"],
            cwd=self.project,
            check=True,
            capture_output=True,
        )
        (self.project / "README.md").write_text("demo\n", encoding="utf-8")
        subprocess.run(["git", "add", "README.md"], cwd=self.project, check=True, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "init"],
            cwd=self.project,
            check=True,
            capture_output=True,
        )

    def test_resolve_single_active_change_without_flag(self) -> None:
        shutil.rmtree(self.changes / "beta")
        payload = change.resolve_change(self.project, None)
        self.assertTrue(payload["ok"], payload)
        self.assertEqual(payload["changeId"], "alpha")
        self.assertTrue(payload.get("autoSelected"))

    def test_resolve_multiple_active_requires_selection_ut017(self) -> None:
        payload = change.resolve_change(self.project, None)
        self.assertFalse(payload["ok"], payload)
        self.assertEqual(payload["code"], "CHANGE_SELECTION_REQUIRED")
        ids = {item["changeId"] for item in payload["activeChanges"]}
        self.assertEqual(ids, {"alpha", "beta"})
        self.assertNotIn("autoSelected", payload)

    def test_resolve_missing_change_does_not_create_dir(self) -> None:
        missing = "ghost-change"
        payload = change.resolve_change(self.project, missing)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["code"], "CHANGE_NOT_FOUND")
        self.assertFalse((self.changes / missing).exists())

    def test_runtime_only_and_closed_worktree_residues_are_not_active(self) -> None:
        runtime_only = self.changes / "runtime-only"
        (runtime_only / "runtime").mkdir(parents=True)
        (runtime_only / "runtime" / "commit-message.txt").write_text(
            "chore: residue\n", encoding="utf-8"
        )
        events_only = self.changes / "events-only"
        events_only.mkdir(parents=True)
        (events_only / "events.ndjson").write_text("{}\n", encoding="utf-8")
        closed_worktree = self.changes / "closed-worktree" / "meta"
        closed_worktree.mkdir(parents=True)
        (closed_worktree / "worktree.json").write_text(
            json.dumps({"requested": False, "created": False}), encoding="utf-8"
        )

        ids = {item["changeId"] for item in change.list_active_changes(self.project)}

        self.assertEqual(ids, {"alpha", "beta"})

    def test_plan_or_created_worktree_is_active_without_change_context(self) -> None:
        plan_dir = self.changes / "plan-only" / "plans"
        plan_dir.mkdir(parents=True)
        (plan_dir / "plan-only-plan.md").write_text("# Plan\n", encoding="utf-8")
        worktree_meta = self.changes / "worktree-active" / "meta"
        worktree_meta.mkdir(parents=True)
        (worktree_meta / "worktree.json").write_text(
            json.dumps({"requested": True, "created": True}), encoding="utf-8"
        )

        ids = {item["changeId"] for item in change.list_active_changes(self.project)}

        self.assertTrue({"plan-only", "worktree-active"}.issubset(ids))

    def test_claim_conflict_same_change_ut019(self) -> None:
        first = change.claim_lease(
            self.project,
            change_id="alpha",
            phase="run",
            run_id="run-a",
            ttl_seconds=3600,
        )
        second = change.claim_lease(
            self.project,
            change_id="alpha",
            phase="run",
            run_id="run-b",
            ttl_seconds=3600,
        )
        self.assertTrue(first["ok"], first)
        self.assertFalse(second["ok"], second)
        self.assertEqual(second["code"], "LEASE_CONFLICT")

    def test_parallel_claim_same_change_has_one_winner(self) -> None:
        def acquire(index: int):
            return change.claim_lease(
                self.project,
                change_id="alpha",
                phase="run",
                run_id=f"parallel-{index}",
                ttl_seconds=3600,
            )

        with ThreadPoolExecutor(max_workers=8) as executor:
            results = list(executor.map(acquire, range(8)))
        winners = [item for item in results if item["ok"]]
        self.assertEqual(len(winners), 1, results)
        self.assertTrue(all(item.get("code") == "LEASE_CONFLICT" for item in results if not item["ok"]))

    def test_parallel_claim_different_changes(self) -> None:
        first = change.claim_lease(
            self.project,
            change_id="alpha",
            phase="run",
            run_id="run-a",
            ttl_seconds=3600,
        )
        second = change.claim_lease(
            self.project,
            change_id="beta",
            phase="run",
            run_id="run-b",
            ttl_seconds=3600,
        )
        self.assertTrue(first["ok"], first)
        self.assertTrue(second["ok"], second)

    def test_parallel_port_leases_are_unique(self) -> None:
        def allocate(index: int):
            return change.lease_port(
                self.project,
                change_id="alpha" if index % 2 == 0 else "beta",
                run_id=f"run-{index}",
                port_range=(43100, 43107),
            )

        with ThreadPoolExecutor(max_workers=8) as executor:
            results = list(executor.map(allocate, range(8)))
        self.assertTrue(all(item["ok"] for item in results), results)
        ports = [item["port"] for item in results]
        self.assertEqual(len(set(ports)), 8, results)

    def test_port_release_requires_owner_and_returns_port_to_pool(self) -> None:
        first = change.lease_port(
            self.project, change_id="demo", run_id="owner-a", port_range=(43200, 43200)
        )
        denied = change.release_port(
            self.project, change_id="demo", run_id="owner-b"
        )
        self.assertFalse(denied["ok"])
        self.assertEqual(denied["code"], "PORT_LEASE_OWNER_MISMATCH")
        released = change.release_port(
            self.project, change_id="demo", run_id="owner-a"
        )
        self.assertTrue(released["ok"])
        second = change.lease_port(
            self.project, change_id="other", run_id="owner-c", port_range=(43200, 43200)
        )
        self.assertEqual(second["port"], first["port"])

    def test_integration_lock_serializes_submit(self) -> None:
        first = change.integration_lock_acquire(self.project, run_id="submit-a")
        second = change.integration_lock_acquire(self.project, run_id="submit-b")
        self.assertTrue(first["ok"])
        self.assertFalse(second["ok"])
        self.assertEqual(second["code"], "INTEGRATION_LOCK_HELD")
        self.assertFalse(change.integration_lock_release(self.project, run_id="submit-b")["ok"])
        self.assertTrue(change.integration_lock_release(self.project, run_id="submit-a")["ok"])

    def test_parallel_integration_lock_has_one_winner(self) -> None:
        with ThreadPoolExecutor(max_workers=8) as executor:
            results = list(executor.map(
                lambda index: change.integration_lock_acquire(
                    self.project, run_id=f"submit-{index}"
                ),
                range(8),
            ))
        winners = [item for item in results if item["ok"]]
        self.assertEqual(len(winners), 1, results)
        self.assertTrue(all(item.get("code") == "INTEGRATION_LOCK_HELD" for item in results if not item["ok"]))

    def test_migrate_writes_checkpoints_without_touching_business_files(self) -> None:
        plan = self.changes / "alpha" / "plans" / "demo.md"
        plan.parent.mkdir(parents=True, exist_ok=True)
        plan.write_text("# unchanged plan\n", encoding="utf-8")
        before = plan.read_text(encoding="utf-8")
        payload = change.migrate_change(self.project, "alpha")
        self.assertTrue(payload["ok"], payload)
        checkpoints = self.changes / "alpha" / "meta" / "implementation-checkpoints.json"
        self.assertTrue(checkpoints.is_file())
        data = json.loads(checkpoints.read_text(encoding="utf-8"))
        self.assertEqual(data["checkpoints"][0]["id"], "foundation-gate")
        self.assertEqual(plan.read_text(encoding="utf-8"), before)

    def test_cli_help(self) -> None:
        proc = subprocess.run(
            [sys.executable, str(SCRIPTS_DIR / "harness_change.py"), "--help"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("resolve", proc.stdout)


if __name__ == "__main__":
    unittest.main()
