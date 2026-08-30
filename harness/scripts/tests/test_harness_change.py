#!/usr/bin/env python3
"""Regression tests for harness_change.py (UT-017, UT-019)."""

from __future__ import annotations

import importlib.util
import json
import os
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


def bounded_test_workers(requested: int) -> int:
    try:
        configured = int(os.environ.get("HARNESS_TEST_MAX_WORKERS", "2"))
    except ValueError:
        configured = 2
    return max(1, min(requested, configured, 2))


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

    def test_change_status_classifies_verified_archive_leftover(self) -> None:
        archive = (
            self.project / ".harness" / "archive" / "2026-07-28-alpha"
            / "reports" / "final"
        )
        archive.mkdir(parents=True)
        summary = archive / "summary-data.json"
        summary.write_text(
            json.dumps({"changeName": "alpha", "finalStatus": "OK"}),
            encoding="utf-8",
        )
        receipt = archive.parent.parent / "meta" / "archive-receipt.json"
        receipt.parent.mkdir(parents=True)
        receipt.write_text(
            json.dumps({
                "status": "archived",
                "changeName": "alpha",
                "summarySha256": change.sha256_file(summary),
            }),
            encoding="utf-8",
        )

        statuses = {
            item["changeId"]: item for item in change.classify_changes(self.project)
        }

        self.assertEqual(statuses["alpha"]["status"], "ARCHIVED_LEFTOVER")
        self.assertEqual(statuses["beta"]["status"], "ACTIVE")

    def test_change_status_marks_archive_hash_mismatch_invalid(self) -> None:
        archive = (
            self.project / ".harness" / "archive" / "2026-07-28-alpha"
            / "reports" / "final"
        )
        archive.mkdir(parents=True)
        (archive / "summary-data.json").write_text(
            json.dumps({"changeName": "alpha"}),
            encoding="utf-8",
        )
        receipt = archive.parent.parent / "meta" / "archive-receipt.json"
        receipt.parent.mkdir(parents=True)
        receipt.write_text(
            json.dumps({
                "status": "archived",
                "changeName": "alpha",
                "summarySha256": "0" * 64,
            }),
            encoding="utf-8",
        )

        status = next(
            item for item in change.classify_changes(self.project)
            if item["changeId"] == "alpha"
        )

        self.assertEqual(status["status"], "INVALID")
        self.assertIn("ARCHIVE_HASH_MISMATCH", status["reasonCodes"])

    def test_cleanup_dry_run_only_lists_verified_archive_leftovers(self) -> None:
        archive = (
            self.project / ".harness" / "archive" / "2026-07-28-alpha"
            / "reports" / "final"
        )
        archive.mkdir(parents=True)
        summary = archive / "summary-data.json"
        summary.write_text(
            json.dumps({"changeName": "alpha", "finalStatus": "OK"}),
            encoding="utf-8",
        )
        receipt = archive.parent.parent / "meta" / "archive-receipt.json"
        receipt.parent.mkdir(parents=True)
        receipt.write_text(
            json.dumps({
                "status": "archived",
                "changeName": "alpha",
                "summarySha256": change.sha256_file(summary),
            }),
            encoding="utf-8",
        )

        result = change.cleanup_changes(self.project, apply=False)

        self.assertEqual(result["eligible"], ["alpha"])
        self.assertTrue((self.changes / "alpha").is_dir())
        self.assertNotIn("beta", result["eligible"])

    def test_claim_conflict_same_change_ut019(self) -> None:
        first = change.claim_lease(
            self.project,
            change_id="alpha",
            phase="execute",
            run_id="run-a",
            ttl_seconds=3600,
        )
        second = change.claim_lease(
            self.project,
            change_id="alpha",
            phase="execute",
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
                phase="execute",
                run_id=f"parallel-{index}",
                ttl_seconds=3600,
            )

        with ThreadPoolExecutor(max_workers=bounded_test_workers(8)) as executor:
            results = list(executor.map(acquire, range(8)))
        winners = [item for item in results if item["ok"]]
        self.assertEqual(len(winners), 1, results)
        self.assertTrue(all(item.get("code") == "LEASE_CONFLICT" for item in results if not item["ok"]))

    def test_parallel_claim_different_changes(self) -> None:
        first = change.claim_lease(
            self.project,
            change_id="alpha",
            phase="execute",
            run_id="run-a",
            ttl_seconds=3600,
        )
        second = change.claim_lease(
            self.project,
            change_id="beta",
            phase="execute",
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

        with ThreadPoolExecutor(max_workers=bounded_test_workers(8)) as executor:
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

    def test_releases_a_port_lease_only_with_matching_identity_and_generation(self) -> None:
        leased = change.lease_port(
            self.project,
            change_id="cas-change",
            run_id="cas-run",
            port_range=(43201, 43201),
            generation=7,
        )
        self.assertTrue(leased["ok"], leased)
        wrong = change.release_port(
            self.project,
            change_id="cas-change",
            run_id="cas-run",
            lease_id=leased["leaseId"],
            generation=6,
        )
        self.assertFalse(wrong["ok"])
        self.assertEqual(wrong["code"], "PORT_LEASE_GENERATION_CONFLICT")
        released = change.release_port(
            self.project,
            change_id="cas-change",
            run_id="cas-run",
            lease_id=leased["leaseId"],
            generation=7,
        )
        self.assertTrue(released["ok"], released)

    def test_lease_claim_and_release_reject_stale_generation(self) -> None:
        first = change.claim_lease(
            self.project,
            change_id="generation-change",
            phase="execute",
            run_id="generation-run",
            ttl_seconds=3600,
        )
        self.assertTrue(first["ok"], first)
        generation = first["lease"]["generation"]
        stale = change.claim_lease(
            self.project,
            change_id="generation-change",
            phase="execute",
            run_id="generation-run",
            ttl_seconds=3600,
            expected_generation=generation - 1,
        )
        self.assertFalse(stale["ok"])
        self.assertEqual(stale["code"], "LEASE_GENERATION_CONFLICT")
        released = change.release_lease(
            self.project,
            change_id="generation-change",
            phase="execute",
            run_id="generation-run",
            lease_id=first["lease"]["leaseId"],
            generation=generation,
        )
        self.assertTrue(released["ok"], released)

    def test_port_listener_identity_is_required_when_lease_records_one(self) -> None:
        listener = {
            "pid": 4100,
            "alive": True,
            "createdAt": "2026-07-31T10:00:00+00:00",
            "executable": "C:/Python/python.exe",
            "fieldProvenance": {
                "createdAt": "OBSERVED",
                "executable": "OBSERVED",
            },
        }
        leased = change.lease_port(
            self.project,
            change_id="listener-change",
            run_id="listener-run",
            port_range=(43202, 43202),
            generation=3,
            listener_identity=listener,
        )
        self.assertTrue(leased["ok"], leased)
        missing = change.release_port(
            self.project,
            change_id="listener-change",
            run_id="listener-run",
            lease_id=leased["leaseId"],
            generation=3,
        )
        self.assertFalse(missing["ok"])
        self.assertEqual(missing["code"], "LISTENER_IDENTITY_UNVERIFIABLE")
        released = change.release_port(
            self.project,
            change_id="listener-change",
            run_id="listener-run",
            lease_id=leased["leaseId"],
            generation=3,
            listener_identity=listener,
        )
        self.assertTrue(released["ok"], released)

    def test_integration_lock_serializes_submit(self) -> None:
        first = change.integration_lock_acquire(self.project, run_id="submit-a")
        second = change.integration_lock_acquire(self.project, run_id="submit-b")
        self.assertTrue(first["ok"])
        self.assertFalse(second["ok"])
        self.assertEqual(second["code"], "INTEGRATION_LOCK_HELD")
        self.assertFalse(change.integration_lock_release(self.project, run_id="submit-b")["ok"])
        self.assertTrue(change.integration_lock_release(self.project, run_id="submit-a")["ok"])

    def test_parallel_integration_lock_has_one_winner(self) -> None:
        with ThreadPoolExecutor(max_workers=bounded_test_workers(8)) as executor:
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


class PortLeaseSubsetTests(unittest.TestCase):
    """C10 (retro §5.16): port lease ID + subset release."""

    def setUp(self) -> None:
        self.project = Path(tempfile.mkdtemp(prefix="harness-port-subset-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.project, ignore_errors=True)

    def test_lease_port_returns_lease_id(self) -> None:
        """C10: lease-port returns leaseId (UUID4)."""
        result = change.lease_port(
            self.project, change_id="c1", run_id="r1", port_range=(55432, 55435)
        )
        self.assertTrue(result["ok"])
        self.assertIn("leaseId", result)
        import re
        self.assertRegex(
            result["leaseId"],
            r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        )

    def test_release_port_by_lease_id(self) -> None:
        """C10: release by leaseId only deletes matching subset."""
        a = change.lease_port(self.project, change_id="c1", run_id="r1", port_range=(55432, 55435))
        b = change.lease_port(self.project, change_id="c1", run_id="r2", port_range=(55432, 55435))
        self.assertTrue(a["ok"])
        self.assertTrue(b["ok"])
        self.assertNotEqual(a["port"], b["port"])

        # Release only lease a by leaseId
        released = change.release_port(
            self.project, change_id="c1", run_id="r1", lease_id=a["leaseId"]
        )
        self.assertTrue(released["ok"])
        self.assertIn(a["port"], released["ports"])

        # Lease b should still be active
        released_b = change.release_port(self.project, change_id="c1", run_id="r2")
        self.assertTrue(released_b["ok"])
        self.assertIn(b["port"], released_b["ports"])

    def test_release_port_by_port_number(self) -> None:
        """C10: release by --port only deletes matching port."""
        a = change.lease_port(self.project, change_id="c1", run_id="r1", port_range=(55432, 55435))
        b = change.lease_port(self.project, change_id="c1", run_id="r2", port_range=(55432, 55435))
        self.assertTrue(a["ok"])
        self.assertTrue(b["ok"])

        # Release port a by --port
        released = change.release_port(
            self.project, change_id="c1", run_id="r1", port=a["port"]
        )
        self.assertTrue(released["ok"])
        self.assertIn(a["port"], released["ports"])

        # Port b should still be active
        released_b = change.release_port(self.project, change_id="c1", run_id="r2")
        self.assertTrue(released_b["ok"])
        self.assertIn(b["port"], released_b["ports"])

    def test_subset_release_does_not_require_all_owners_match(self) -> None:
        """C10: releasing run B's ports must not fail because run A's ports exist."""
        a = change.lease_port(self.project, change_id="c1", run_id="r1", port_range=(55432, 55435))
        b = change.lease_port(self.project, change_id="c1", run_id="r2", port_range=(55432, 55435))
        self.assertTrue(a["ok"])
        self.assertTrue(b["ok"])

        # Release run B's ports — should succeed even though run A's ports exist
        released = change.release_port(self.project, change_id="c1", run_id="r2")
        self.assertTrue(released["ok"])
        self.assertIn(b["port"], released["ports"])
        self.assertNotIn(a["port"], released["ports"])

        # Run A's port should still be active
        released_a = change.release_port(self.project, change_id="c1", run_id="r1")
        self.assertTrue(released_a["ok"])
        self.assertIn(a["port"], released_a["ports"])


class ChangeRenameTests(unittest.TestCase):
    """C3 (retro §5.5): Change rename transaction with stable UUID."""

    def setUp(self) -> None:
        self.project = Path(tempfile.mkdtemp(prefix="harness-rename-"))
        self.changes = self.project / ".harness" / "changes"
        self.old_dir = self.changes / "old-name"
        meta = self.old_dir / "meta"
        meta.mkdir(parents=True)
        (meta / "change-context.json").write_text(
            json.dumps({"schemaVersion": 1, "changeId": "old-name"}),
            encoding="utf-8",
        )
        # knowledge-context.json with old changeId
        (meta / "knowledge-context.json").write_text(
            json.dumps({"changeId": "old-name"}),
            encoding="utf-8",
        )
        # worktree.json with old name in path/branch
        (meta / "worktree.json").write_text(
            json.dumps({
                "requested": True,
                "path": ".codebuddy/worktrees/old-name",
                "branch": "codebuddy/old-name",
            }),
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

    def test_ensure_identity_generates_uuid(self) -> None:
        """C3: ensure-identity creates meta/change-identity.json with UUID4."""
        proc = subprocess.run(
            [
                sys.executable,
                str(SCRIPTS_DIR / "harness_change.py"),
                "ensure-identity",
                "--change", "old-name",
                "--json",
            ],
            cwd=self.project,
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        data = json.loads(proc.stdout)
        self.assertIn("changeUuid", data)
        # UUID4 format: 8-4-4-4-12 hex
        import re
        self.assertRegex(
            data["changeUuid"],
            r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        )
        self.assertEqual(data["changeName"], "old-name")
        # File exists
        identity_path = self.old_dir / "meta" / "change-identity.json"
        self.assertTrue(identity_path.is_file())

    def test_rename_updates_directory_and_pointers(self) -> None:
        """C3: rename --change old --to new updates directory, pointers, worktree."""
        # First ensure identity exists
        subprocess.run(
            [
                sys.executable,
                str(SCRIPTS_DIR / "harness_change.py"),
                "ensure-identity",
                "--change", "old-name",
                "--json",
            ],
            cwd=self.project,
            capture_output=True,
            check=True,
        )

        proc = subprocess.run(
            [
                sys.executable,
                str(SCRIPTS_DIR / "harness_change.py"),
                "rename",
                "--change", "old-name",
                "--to", "new-name",
                "--json",
            ],
            cwd=self.project,
            capture_output=True,
            text=True,
            encoding="utf-8",
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        data = json.loads(proc.stdout)
        self.assertEqual(data["code"], "RENAMED")
        self.assertEqual(data["renamedFrom"], "old-name")
        self.assertEqual(data["renamedTo"], "new-name")

        # Old directory gone, new directory exists
        self.assertFalse(self.old_dir.exists())
        new_dir = self.changes / "new-name"
        self.assertTrue(new_dir.is_dir())

        # knowledge-context.json.changeId updated
        kc = json.loads((new_dir / "meta" / "knowledge-context.json").read_text(encoding="utf-8"))
        self.assertEqual(kc["changeId"], "new-name")

        # worktree.json path/branch updated
        wt = json.loads((new_dir / "meta" / "worktree.json").read_text(encoding="utf-8"))
        self.assertIn("new-name", wt["path"])
        self.assertIn("new-name", wt["branch"])

        # change-identity.json.changeName updated, renamedFrom preserved
        ident = json.loads((new_dir / "meta" / "change-identity.json").read_text(encoding="utf-8"))
        self.assertEqual(ident["changeName"], "new-name")
        self.assertEqual(ident["renamedFrom"], "old-name")

    def test_rename_appends_change_rename_event(self) -> None:
        """C3: rename appends change.rename event to events.ndjson."""
        # Ensure identity
        subprocess.run(
            [
                sys.executable,
                str(SCRIPTS_DIR / "harness_change.py"),
                "ensure-identity",
                "--change", "old-name",
                "--json",
            ],
            cwd=self.project,
            capture_output=True,
            check=True,
        )
        # Rename
        subprocess.run(
            [
                sys.executable,
                str(SCRIPTS_DIR / "harness_change.py"),
                "rename",
                "--change", "old-name",
                "--to", "new-name",
                "--json",
            ],
            cwd=self.project,
            capture_output=True,
            check=True,
        )
        # Check events.ndjson
        new_dir = self.changes / "new-name"
        events_path = new_dir / "events.ndjson"
        self.assertTrue(events_path.is_file())
        events = [json.loads(line) for line in events_path.read_text(encoding="utf-8").splitlines() if line.strip()]
        rename_events = [e for e in events if e.get("type") == "change.rename"]
        self.assertEqual(len(rename_events), 1)
        self.assertEqual(rename_events[0]["renamed_from"], "old-name")
        self.assertEqual(rename_events[0]["renamed_to"], "new-name")
        self.assertIn("change_uuid", rename_events[0])


class DeclareOwnershipTests(unittest.TestCase):
    """`ownership.productPaths` 此前没有任何写入方，归档因此必卡。

    plan 的 validate_product_ownership 只校验、缺失时软放行
    （PLAN_PRODUCT_PATHS_LEGACY_UNDECLARED）；到了归档，compute_ownership_diff
    把全部改动判成 foreignPaths，filesChanged=0 触发
    DIFF_ZERO_WITH_NONEMPTY_COMMIT——两端口径不一致，中间没有工具能补。
    执行日志里的结果是执行者反复读源码，最后打算手改契约。
    """

    def setUp(self) -> None:
        self.project = Path(tempfile.mkdtemp(prefix="harness-own-"))
        self.change_dir = self.project / ".harness" / "changes" / "demo"
        (self.change_dir / "meta").mkdir(parents=True)
        (self.change_dir / "meta" / "change-context.json").write_text(
            json.dumps({"schemaVersion": 1, "changeId": "demo"}, ensure_ascii=False),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.project, ignore_errors=True)

    def _context(self) -> dict:
        return json.loads(
            (self.change_dir / "meta" / "change-context.json").read_text(encoding="utf-8-sig")
        )

    def test_declare_writes_product_paths_into_the_contract(self) -> None:
        result = change.declare_product_ownership(
            self.project, "demo", product_paths=["kld-sdd/", "docs/api.md"]
        )

        self.assertTrue(result["ok"], result)
        self.assertEqual(
            self._context()["ownership"]["productPaths"], ["docs/api.md", "kld-sdd/"]
        )

    def test_declare_is_idempotent(self) -> None:
        change.declare_product_ownership(self.project, "demo", product_paths=["kld-sdd/"])
        second = change.declare_product_ownership(
            self.project, "demo", product_paths=["kld-sdd/"]
        )

        self.assertTrue(second["ok"], second)
        self.assertTrue(second.get("idempotent"))
        self.assertEqual(self._context()["ownership"]["productPaths"], ["kld-sdd/"])

    def test_glob_paths_are_rejected(self) -> None:
        # 与 plan 的 validate_product_ownership 同一条规则：只收精确文件或目录前缀
        result = change.declare_product_ownership(
            self.project, "demo", product_paths=["kld-sdd/**"]
        )

        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "PLAN_PRODUCT_PATHS_GLOB_UNSUPPORTED")
        self.assertNotIn("ownership", self._context())

    def test_empty_declaration_is_rejected(self) -> None:
        result = change.declare_product_ownership(self.project, "demo", product_paths=[])

        self.assertFalse(result["ok"], result)
        self.assertNotIn("ownership", self._context())

    def test_cli_exposes_declare_ownership(self) -> None:
        parser = change.build_parser()
        args = parser.parse_args([
            "declare-ownership", "--change", "demo", "--product-path", "kld-sdd/", "--json",
        ])
        self.assertEqual(args.product_path, ["kld-sdd/"])


class AllowLocalReleaseTests(unittest.TestCase):
    """PROJECT_RELEASE_POLICY_BLOCKED 的正规出路（2026-08-30 archive 实测）：
    此前只能手工编辑 meta/gate-policy.json。"""

    def setUp(self) -> None:
        self.project = Path(tempfile.mkdtemp(prefix="harness-local-release-"))
        self.change_dir = self.project / ".harness" / "changes" / "demo"
        (self.change_dir / "meta").mkdir(parents=True)
        (self.change_dir / "meta" / "change-context.json").write_text(
            json.dumps({"schemaVersion": 1, "changeId": "demo"}, ensure_ascii=False),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.project, ignore_errors=True)

    def _policy(self) -> dict:
        return json.loads(
            (self.change_dir / "meta" / "gate-policy.json").read_text(
                encoding="utf-8-sig"
            )
        )

    def test_creates_policy_when_missing(self) -> None:
        result = change.allow_local_release(self.project, "demo")

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], "LOCAL_RELEASE_ALLOWED")
        policy = self._policy()
        self.assertEqual(policy["schemaVersion"], 1)
        self.assertTrue(policy["candidateVerification"]["allowLocalRelease"])

    def test_preserves_existing_policy_content(self) -> None:
        (self.change_dir / "meta" / "gate-policy.json").write_text(
            json.dumps({
                "schemaVersion": 1,
                "tier": "full",
                "candidateVerification": {"minimumAssurance": "local-reproducible"},
            }),
            encoding="utf-8",
        )
        result = change.allow_local_release(self.project, "demo")

        self.assertTrue(result["ok"], result)
        policy = self._policy()
        self.assertEqual(policy["tier"], "full")
        self.assertEqual(
            policy["candidateVerification"]["minimumAssurance"], "local-reproducible"
        )
        self.assertTrue(policy["candidateVerification"]["allowLocalRelease"])

    def test_idempotent_when_already_allowed(self) -> None:
        change.allow_local_release(self.project, "demo")
        second = change.allow_local_release(self.project, "demo")

        self.assertTrue(second["ok"], second)
        self.assertEqual(second["code"], "LOCAL_RELEASE_ALREADY_ALLOWED")

    def test_cli_exposes_allow_local_release(self) -> None:
        parser = change.build_parser()
        args = parser.parse_args([
            "allow-local-release", "--change", "demo", "--json",
        ])
        self.assertEqual(args.change, "demo")


class InspectLeaseStateTests(unittest.TestCase):
    """inspect_lease 把三种失败压成 None，调用方就没法分别应对。

    「租约从没建立」「阶段跑过了 TTL」「租约文件坏了」需要三种不同的答案：
    过期租约还带着能证明所有权的 runId，损坏的什么都证明不了，而不存在的
    可能只是阶段已经正常关过门了。
    """

    def setUp(self) -> None:
        self.project = Path(tempfile.mkdtemp(prefix="harness-lease-state-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.project, ignore_errors=True)

    def _expire(self, change_id: str = "demo") -> None:
        path = change._lease_path(self.project, change_id)
        lease = json.loads(path.read_text(encoding="utf-8"))
        lease["expiresAt"] = "2000-01-01T00:00:00.000+00:00"
        path.write_text(json.dumps(lease), encoding="utf-8")

    def _claim(self, run_id: str) -> None:
        claimed = change.claim_lease(
            self.project,
            change_id="demo",
            phase="execute",
            run_id=run_id,
            ttl_seconds=3600,
        )
        self.assertTrue(claimed["ok"], claimed)

    def test_absent_when_no_lease_file_exists(self) -> None:
        state = change.inspect_lease_state(self.project, "demo")

        self.assertEqual(state["state"], "absent")
        self.assertIsNone(state["lease"])

    def test_active_lease_is_returned(self) -> None:
        self._claim("run-active")

        state = change.inspect_lease_state(self.project, "demo")

        self.assertEqual(state["state"], "active")
        self.assertEqual(state["lease"]["runId"], "run-active")

    def test_expired_lease_still_carries_its_run_id(self) -> None:
        self._claim("run-expired")
        self._expire()

        state = change.inspect_lease_state(self.project, "demo")

        # 过期不等于消失：runId 还在，close 正是靠它证明没人抢占过。
        self.assertEqual(state["state"], "expired")
        self.assertEqual(state["lease"]["runId"], "run-expired")

    def test_corrupt_lease_is_not_reported_as_absent(self) -> None:
        path = change._lease_path(self.project, "demo")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{not json", encoding="utf-8")

        state = change.inspect_lease_state(self.project, "demo")

        self.assertEqual(state["state"], "corrupt")
        self.assertIsNone(state["lease"])
        # 关键区分：损坏必须与不存在可分辨，否则调用方会把它当成本来就没租约。
        self.assertNotEqual(
            state["state"],
            change.inspect_lease_state(self.project, "never-claimed")["state"],
        )

    def test_inspect_lease_still_returns_only_active_leases(self) -> None:
        self._claim("run-compat")
        self.assertIsNotNone(change.inspect_lease(self.project, "demo"))

        self._expire()

        self.assertIsNone(change.inspect_lease(self.project, "demo"))


if __name__ == "__main__":
    unittest.main()
