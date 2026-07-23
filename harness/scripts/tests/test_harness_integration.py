#!/usr/bin/env python3
"""Tests for harness_integration.py — reentrant integration transaction.

Covers retro scenarios:
- RET-03 (API-001): normal prepare→merge→verify→push→cleanup path uses no `git stash`.
- RET-11 (API-002): journal step order and identities are the single contract.
- RET-12 (API-003): cleanup refuses repo root, parents, empty and escaping paths.
- RET-02 (INT-002): dirty primary worktree (staged/unstaged/untracked/ignored) untouched.
- RET-04 (INT-003): failure at each step keeps protection refs and journal; recover resumes
  without repeating side effects.
- RET-13 (INT-005): two concurrent transactions on one target — only one proceeds.
- RET-01/RET-08 (INT-001/INT-004): other changes' contract/runtime trees see zero diff.
"""

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


integration = load_module("harness_integration", "harness_integration.py")


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


def init_repo(root: Path, remote: Path | None = None) -> None:
    root.mkdir(parents=True, exist_ok=True)
    git(root, "init", "-b", "main")
    git(root, "config", "user.email", "test@example.com")
    git(root, "config", "user.name", "Test")
    git(root, "config", "commit.gpgsign", "false")
    # Isolate fixtures from machine-global CRLF policy. Without this, a newly
    # staged LF file can flip from A to AM after later Git refreshes on Windows.
    git(root, "config", "core.autocrlf", "false")
    (root / "README.md").write_text("demo\n", encoding="utf-8")
    git(root, "add", "README.md")
    git(root, "commit", "-m", "init")
    if remote is not None:
        remote.mkdir(parents=True, exist_ok=True)
        git(remote, "init", "--bare", "-b", "main")
        git(root, "remote", "add", "origin", str(remote))
        git(root, "push", "-u", "origin", "main")


def snapshot_tree(root: Path) -> dict[str, tuple[str, int]]:
    """Map relative file path -> (sha256, mtime_ns) for all files under root."""
    import hashlib

    snap: dict[str, tuple[str, int]] = {}
    if not root.exists():
        return snap
    for path in sorted(root.rglob("*")):
        if path.is_file() and not path.is_symlink():
            rel = path.relative_to(root).as_posix()
            snap[rel] = (
                hashlib.sha256(path.read_bytes()).hexdigest(),
                path.stat().st_mtime_ns,
            )
    return snap


class TransactionFixture(unittest.TestCase):
    """Base fixture: primary repo with origin, a feature branch, and a change."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-intg-"))
        self.remote = self.tmp / "remote.git"
        self.primary = self.tmp / "primary"
        init_repo(self.primary, remote=self.remote)
        # Feature branch with a product change and this change's contract dir.
        git(self.primary, "checkout", "-b", "feature/demo")
        (self.primary / "src").mkdir()
        (self.primary / "src" / "app.py").write_text("print('v2')\n", encoding="utf-8")
        contract = self.primary / ".harness" / "changes" / "demo"
        (contract / "meta").mkdir(parents=True)
        (contract / "meta" / "change-context.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 2,
                    "changeId": "demo",
                    "lifecycle": {"status": "active"},
                    "stateOwnership": {
                        "contractRoot": ".harness/changes/demo",
                        "runtimeRoot": ".harness/state/changes/demo",
                    },
                    "ownership": {
                        "productPaths": ["src/"],
                        "staticEvidencePaths": [".harness/changes/demo/"],
                    },
                    "integration": {"targetBranch": "main"},
                }
            ),
            encoding="utf-8",
        )
        git(self.primary, "add", "-A")
        git(self.primary, "commit", "-m", "feature work")
        git(self.primary, "checkout", "main")
        base = git(self.primary, "rev-parse", "main").stdout.strip()
        feature_head = git(self.primary, "rev-parse", "feature/demo").stdout.strip()
        self.ledger_path = (
            self.primary / ".harness" / "state" / "changes" / "demo"
            / "evidence" / "verification-ledger.json"
        )
        self.ledger_path.parent.mkdir(parents=True, exist_ok=True)
        self.ledger_path.write_text(json.dumps({
            "schemaVersion": 3,
            "repositoryId": integration.harness_paths.repository_identity(self.primary),
            "changeName": "demo",
            "baseCommit": base,
            "currentHead": feature_head,
            "diffHash": "sha256:" + "d" * 64,
            "ownershipHash": "sha256:" + "e" * 64,
            "validations": {},
        }) + "\n", encoding="utf-8")
        self.temp_root = self.tmp / "integration-temp"
        self.runner = integration.GitRunner()

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def make_txn(self, run_id: str = "run-1") -> object:
        return integration.IntegrationTransaction(
            project_root=self.primary,
            change_id="demo",
            run_id=run_id,
            target_branch="main",
            feature_branch="feature/demo",
            temp_root=self.temp_root,
            runner=self.runner,
        )


class JournalLifecycleTests(TransactionFixture):
    def test_journal_written_under_state_integration(self) -> None:
        txn = self.make_txn()
        journal = txn.preflight()
        journal_path = (
            self.primary
            / ".harness"
            / "state"
            / "integration"
            / journal["transactionId"]
            / "journal.json"
        )
        self.assertTrue(journal_path.is_file(), journal_path)
        on_disk = json.loads(journal_path.read_text(encoding="utf-8"))
        self.assertEqual(on_disk["transactionId"], journal["transactionId"])
        self.assertEqual(on_disk["changeName"], "demo")
        self.assertEqual(on_disk["schemaVersion"], 1)
        self.assertTrue(str(on_disk["repositoryId"]).startswith("sha256:"))
        self.assertIn("eventHighWater", on_disk["evidenceIdentity"])
        self.assertIn("artifactManifestHash", on_disk["evidenceIdentity"])
        self.assertIn("ledgerIdentity", on_disk["evidenceIdentity"])
        self.assertGreaterEqual(on_disk["revision"], 1)

    def test_stale_journal_revision_is_rejected(self) -> None:
        txn = self.make_txn()
        txn.preflight()
        first = integration.load_journal(self.primary, txn.transaction_id)
        stale = json.loads(json.dumps(first))
        first["probe"] = "winner"
        txn._save(first)
        stale["probe"] = "loser"
        with self.assertRaises(integration.JournalConflictError):
            txn._save(stale)

    def test_stale_dead_owner_journal_lock_is_reclaimed(self) -> None:
        txn = self.make_txn()
        journal = txn._new_journal("base", "feature")
        path = integration.journal_path(self.primary, txn.transaction_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        lock = path.with_name(path.name + ".lock")
        lock.write_text(
            json.dumps({"pid": 99999999, "createdAtEpoch": 1}) + "\n",
            encoding="utf-8",
        )
        integration._write_journal(self.primary, journal)
        self.assertFalse(lock.exists())
        self.assertEqual(
            integration.load_journal(self.primary, txn.transaction_id)["revision"], 1
        )

    def test_old_lock_with_live_owner_is_not_reclaimed(self) -> None:
        path = self.primary / ".harness" / "state" / "integration" / "txn" / "journal.json"
        path.parent.mkdir(parents=True)
        lock = path.with_name(path.name + ".lock")
        lock.write_text(
            json.dumps({"pid": os.getpid(), "createdAtEpoch": 1}) + "\n",
            encoding="utf-8",
        )

        with self.assertRaises(integration.JournalConflictError):
            integration._acquire_journal_lock(lock, path)

        self.assertTrue(lock.exists())

    def test_failed_lock_metadata_write_releases_descriptor_and_lock(self) -> None:
        path = self.primary / ".harness" / "state" / "integration" / "txn" / "journal.json"
        path.parent.mkdir(parents=True)
        lock = path.with_name(path.name + ".lock")

        with mock.patch.object(
            integration.os, "write", side_effect=OSError("disk full")
        ), mock.patch.object(
            integration.os, "close", wraps=integration.os.close
        ) as close:
            with self.assertRaisesRegex(OSError, "disk full"):
                integration._acquire_journal_lock(lock, path)

        close.assert_called_once()
        self.assertFalse(lock.exists())

    def test_full_happy_path_step_order_ret11(self) -> None:
        txn = self.make_txn()
        txn.preflight()
        txn.prepare()
        txn.merge()
        txn.verify(commands=[[sys.executable, "-c", "pass"]])
        txn.push()
        journal = txn.cleanup()
        steps = journal["steps"]
        order = ["preflight", "prepare", "merge", "verify", "push", "cleanup"]
        self.assertEqual([s["name"] for s in steps], order)
        for step in steps:
            self.assertEqual(step["status"], "DONE", step)
            self.assertIn("startedAt", step)
            self.assertIn("finishedAt", step)
        # Final identities recorded in the single contract.
        self.assertTrue(journal.get("mergeCommit"))
        self.assertTrue(journal.get("pushedHead"))
        self.assertEqual(
            git(self.remote, "rev-parse", "main").stdout.strip(),
            journal["pushedHead"],
        )
        self.assertEqual(journal["mergeFinalHash"], journal["pushedHead"])
        self.assertEqual(journal["ciExpectedHead"], journal["pushedHead"])
        self.assertEqual(journal["remoteHead"], journal["pushedHead"])
        self.assertEqual(journal["ledgerSync"]["status"], "DONE")
        ledger = json.loads(self.ledger_path.read_text(encoding="utf-8"))
        self.assertEqual(ledger["mergeFinalHash"], journal["pushedHead"])
        self.assertEqual(ledger["ciExpectedHead"], journal["pushedHead"])
        self.assertEqual(ledger["remoteHead"], journal["pushedHead"])
        self.assertIn("transactionArtifactsRemoved", journal["cleanupSummary"])
        self.assertFalse(journal["cleanupSummary"]["sourceWorktreeRetained"])
        self.assertTrue(journal["cleanupSummary"]["featureBranchRetained"])
        self.assertFalse(journal["cleanupSummary"]["primaryWorktreeUpdated"])

    def test_reentry_returns_reused_without_side_effects(self) -> None:
        txn = self.make_txn()
        txn.preflight()
        txn.prepare()
        txn.merge()
        head_after_merge = git(self.primary, "rev-parse", "main").stdout.strip()
        again = txn.merge()
        merge_step = [s for s in again["steps"] if s["name"] == "merge"][0]
        self.assertEqual(merge_step.get("reentry"), "REUSED")
        self.assertEqual(
            git(self.primary, "rev-parse", "main").stdout.strip(), head_after_merge
        )

    def test_merge_is_no_ff(self) -> None:
        txn = self.make_txn()
        txn.preflight()
        txn.prepare()
        journal = txn.merge()
        merge_commit = journal["mergeCommit"]
        parents = (
            git(self.primary, "rev-list", "--parents", "-n", "1", merge_commit)
            .stdout.strip()
            .split()
        )
        self.assertEqual(len(parents), 3, "merge commit must have two parents")

    def test_normal_path_uses_no_stash_ret03(self) -> None:
        txn = self.make_txn()
        txn.preflight()
        txn.prepare()
        txn.merge()
        txn.verify(commands=[[sys.executable, "-c", "pass"]])
        txn.push()
        txn.cleanup()
        stash_calls = [
            args for (cwd, args) in self.runner.history if "stash" in args
        ]
        self.assertEqual(stash_calls, [], stash_calls)
        stash_list = git(self.primary, "stash", "list").stdout.strip()
        self.assertEqual(stash_list, "")


class DirtyPrimaryTests(TransactionFixture):
    def test_dirty_primary_untouched_ret02(self) -> None:
        # staged
        (self.primary / "staged.txt").write_text("staged\n", encoding="utf-8")
        git(self.primary, "add", "staged.txt")
        # unstaged modification
        (self.primary / "README.md").write_text("demo\nmodified\n", encoding="utf-8")
        # untracked
        (self.primary / "untracked.txt").write_text("untracked\n", encoding="utf-8")
        # ignored
        (self.primary / ".gitignore").write_text("ignored.txt\n", encoding="utf-8")
        (self.primary / "ignored.txt").write_text("ignored\n", encoding="utf-8")

        status_before = git(self.primary, "status", "--porcelain=v1").stdout
        index_before = git(self.primary, "ls-files", "--stage").stdout
        files_before = {
            name: (self.primary / name).stat().st_mtime_ns
            for name in ("staged.txt", "README.md", "untracked.txt", "ignored.txt")
        }

        txn = self.make_txn()
        txn.preflight()
        txn.prepare()
        txn.merge()
        txn.verify(commands=[[sys.executable, "-c", "pass"]])
        txn.push()
        txn.cleanup()

        # User-visible porcelain lines must be identical. Harness-owned dynamic
        # state (.harness/state/, .harness/runtime/) is the transaction's own
        # evidence root, explicitly outside the user's worktree scope.
        def user_lines(raw: str) -> list[str]:
            return [
                line
                for line in raw.splitlines()
                if not line.startswith("?? .harness/")
            ]

        self.assertEqual(
            user_lines(git(self.primary, "status", "--porcelain=v1").stdout),
            user_lines(status_before),
        )
        self.assertEqual(git(self.primary, "ls-files", "--stage").stdout, index_before)
        for name, mtime in files_before.items():
            self.assertEqual((self.primary / name).stat().st_mtime_ns, mtime, name)


class ForeignChangeIsolationTests(TransactionFixture):
    def test_other_change_trees_zero_diff_ret08(self) -> None:
        other_contract = self.primary / ".harness" / "changes" / "other-change"
        (other_contract / "meta").mkdir(parents=True)
        (other_contract / "meta" / "change-context.json").write_text(
            json.dumps({"schemaVersion": 1, "changeId": "other-change"}),
            encoding="utf-8",
        )
        other_runtime = self.primary / ".harness" / "state" / "changes" / "other-change"
        other_runtime.mkdir(parents=True)
        (other_runtime / "events.ndjson").write_text(
            '{"id":"e1"}\n', encoding="utf-8"
        )
        before_contract = snapshot_tree(other_contract)
        before_runtime = snapshot_tree(other_runtime)

        txn = self.make_txn()
        txn.preflight()
        txn.prepare()
        txn.merge()
        txn.verify(commands=[[sys.executable, "-c", "pass"]])
        txn.push()
        txn.cleanup()

        self.assertEqual(snapshot_tree(other_contract), before_contract)
        # Runtime may gain proven concurrent appends but never modifications:
        after_runtime = snapshot_tree(other_runtime)
        for rel, (digest, _mtime) in before_runtime.items():
            self.assertIn(rel, after_runtime)
            self.assertEqual(after_runtime[rel][0], digest, rel)

    def test_merge_refuses_foreign_change_paths_in_diff(self) -> None:
        """Feature branch touching another change's contract must be refused."""
        git(self.primary, "checkout", "feature/demo")
        foreign = self.primary / ".harness" / "changes" / "other-change"
        (foreign / "meta").mkdir(parents=True)
        (foreign / "meta" / "change-context.json").write_text(
            json.dumps({"schemaVersion": 1, "changeId": "other-change"}),
            encoding="utf-8",
        )
        git(self.primary, "add", "-A")
        git(self.primary, "commit", "-m", "contaminated")
        git(self.primary, "checkout", "main")

        txn = self.make_txn()
        txn.preflight()
        txn.prepare()
        with self.assertRaises(integration.ForeignChangePathsError) as ctx:
            txn.merge()
        self.assertIn("other-change", str(ctx.exception))

    def test_merge_refuses_path_outside_declared_product_scope(self) -> None:
        git(self.primary, "checkout", "feature/demo")
        (self.primary / "docs").mkdir()
        (self.primary / "docs" / "unrelated.md").write_text("foreign\n", encoding="utf-8")
        git(self.primary, "add", "docs/unrelated.md")
        git(self.primary, "commit", "-m", "out of scope")
        git(self.primary, "checkout", "main")
        txn = self.make_txn()
        txn.preflight()
        txn.prepare()
        with self.assertRaises(integration.ForeignChangePathsError):
            txn.merge()


class FailureRecoveryTests(TransactionFixture):
    def test_preflight_reconciles_fast_forward_remote_target(self) -> None:
        local_main = git(self.primary, "rev-parse", "main").stdout.strip()
        other = self.tmp / "remote-advance"
        git(self.tmp, "clone", str(self.remote), str(other))
        git(other, "config", "user.email", "test@example.com")
        git(other, "config", "user.name", "Test")
        git(other, "config", "commit.gpgsign", "false")
        (other / "remote.txt").write_text("remote advance\n", encoding="utf-8")
        git(other, "add", "remote.txt")
        git(other, "commit", "-m", "remote advance")
        git(other, "push", "origin", "main")
        remote_main = git(other, "rev-parse", "HEAD").stdout.strip()

        txn = self.make_txn()
        journal = txn.preflight()

        self.assertEqual(journal["base"], remote_main)
        self.assertEqual(journal["localTargetHead"], local_main)
        self.assertEqual(journal["remoteTargetHead"], remote_main)
        self.assertTrue(journal["primaryReconciliationRequired"])
        txn.prepare()
        txn.merge()
        txn.verify(commands=[[sys.executable, "-c", "pass"]])
        txn.push()
        verify_clone = self.tmp / "verify-remote"
        git(self.tmp, "clone", str(self.remote), str(verify_clone))
        self.assertTrue((verify_clone / "remote.txt").is_file())
        self.assertTrue((verify_clone / "src" / "app.py").is_file())

    def test_merge_detects_target_moved_after_prepare(self) -> None:
        txn = self.make_txn()
        txn.preflight()
        txn.prepare()
        git(self.primary, "checkout", "main")
        (self.primary / "moved.txt").write_text("moved\n", encoding="utf-8")
        git(self.primary, "add", "moved.txt")
        git(self.primary, "commit", "-m", "target moved")
        with self.assertRaises(integration.TargetMovedError):
            txn.merge()

    def test_merge_conflict_marks_failed_and_recover_resumes_ret04(self) -> None:
        # Move target branch so merge conflicts.
        git(self.primary, "checkout", "main")
        (self.primary / "src").mkdir(exist_ok=True)
        (self.primary / "src" / "app.py").write_text(
            "print('mainline')\n", encoding="utf-8"
        )
        git(self.primary, "add", "-A")
        git(self.primary, "commit", "-m", "mainline conflicting work")

        txn = self.make_txn()
        txn.preflight()
        txn.prepare()
        with self.assertRaises(integration.MergeFailedError):
            txn.merge()
        journal = integration.load_journal(self.primary, txn.transaction_id)
        merge_step = [s for s in journal["steps"] if s["name"] == "merge"][0]
        self.assertEqual(merge_step["status"], "FAILED")
        self.assertTrue(merge_step.get("error"))
        # Protection refs retained for diagnosis.
        base_ref = f"refs/harness/integration/{txn.transaction_id}/base"
        head_ref = f"refs/harness/integration/{txn.transaction_id}/head"
        self.assertTrue(
            git(self.primary, "show-ref", "--verify", base_ref, check=False)
            .stdout.strip()
        )
        self.assertTrue(
            git(self.primary, "show-ref", "--verify", head_ref, check=False)
            .stdout.strip()
        )

    def test_push_detects_target_moved(self) -> None:
        txn = self.make_txn()
        txn.preflight()
        txn.prepare()
        txn.merge()
        txn.verify(commands=[[sys.executable, "-c", "pass"]])
        # Someone else advances remote main after our merge.
        other = self.tmp / "other-clone"
        git(self.tmp, "clone", str(self.remote), str(other))
        git(other, "config", "user.email", "test@example.com")
        git(other, "config", "user.name", "Test")
        git(other, "config", "commit.gpgsign", "false")
        (other / "other.txt").write_text("other\n", encoding="utf-8")
        git(other, "add", "other.txt")
        git(other, "commit", "-m", "other push")
        git(other, "push", "origin", "main")

        with self.assertRaises(integration.TargetMovedError) as ctx:
            txn.push()
        self.assertEqual(getattr(ctx.exception, "code", "TARGET_MOVED"), "TARGET_MOVED")

    def test_push_recovers_when_remote_already_equals_merge_commit(self) -> None:
        txn = self.make_txn()
        txn.preflight()
        txn.prepare()
        journal = txn.merge()
        txn.verify(commands=[[sys.executable, "-c", "pass"]])
        merge_commit = journal["mergeCommit"]

        # Simulate a push that succeeded remotely while the local process failed
        # before it could mark the journal step DONE.
        git(
            self.primary,
            "push",
            "origin",
            f"{merge_commit}:refs/heads/main",
        )

        recovered = txn.push()

        push_step = next(s for s in recovered["steps"] if s["name"] == "push")
        self.assertEqual(push_step["status"], "DONE")
        self.assertEqual(recovered["pushedHead"], merge_commit)
        self.assertEqual(recovered["mergeFinalHash"], merge_commit)
        self.assertEqual(recovered["ciExpectedHead"], merge_commit)
        self.assertEqual(recovered["remoteHead"], merge_commit)
        self.assertEqual(recovered["ledgerSync"]["status"], "DONE")
        self.assertFalse(
            any(args and args[0] == "push" for _cwd, args in self.runner.history)
        )

    def test_cleanup_refuses_ledger_final_hash_drift(self) -> None:
        txn = self.make_txn()
        txn.preflight()
        txn.prepare()
        txn.merge()
        txn.verify(commands=[[sys.executable, "-c", "pass"]])
        txn.push()
        ledger = json.loads(self.ledger_path.read_text(encoding="utf-8"))
        ledger["remoteHead"] = "0" * 40
        self.ledger_path.write_text(json.dumps(ledger) + "\n", encoding="utf-8")

        with self.assertRaises(integration.CleanupRefusedError):
            txn.cleanup()

    def test_recover_finishes_ledger_sync_after_remote_push(self) -> None:
        txn = self.make_txn()
        txn.preflight()
        txn.prepare()
        journal = txn.merge()
        txn.verify(commands=[[sys.executable, "-c", "pass"]])
        ledger_bytes = self.ledger_path.read_bytes()
        self.ledger_path.unlink()

        with self.assertRaises(integration.LedgerSyncError):
            txn.push()

        failed = integration.load_journal(self.primary, txn.transaction_id)
        self.assertEqual(failed["remoteHead"], journal["mergeCommit"])
        self.assertEqual(failed["ledgerSync"]["status"], "FAILED")
        self.ledger_path.parent.mkdir(parents=True, exist_ok=True)
        self.ledger_path.write_bytes(ledger_bytes)
        push_calls_before = sum(
            1 for _cwd, args in self.runner.history if args and args[0] == "push"
        )

        recovered = txn.push()

        push_calls_after = sum(
            1 for _cwd, args in self.runner.history if args and args[0] == "push"
        )
        self.assertEqual(push_calls_after, push_calls_before)
        self.assertEqual(recovered["ledgerSync"]["status"], "DONE")
        self.assertEqual(recovered["mergeFinalHash"], journal["mergeCommit"])

    def test_recover_after_failed_verify_does_not_remerge(self) -> None:
        txn = self.make_txn()
        txn.preflight()
        txn.prepare()
        txn.merge()
        head_after_merge = git(self.primary, "rev-parse", "main").stdout.strip()
        with self.assertRaises(integration.VerificationFailedError):
            txn.verify(commands=[["python", "-c", "import sys; sys.exit(3)"]])

        journal = txn.recover(
            verify_commands=[[sys.executable, "-c", "pass"]]
        )
        verify_step = [s for s in journal["steps"] if s["name"] == "verify"][0]
        self.assertEqual(verify_step["status"], "DONE")
        merge_step = [s for s in journal["steps"] if s["name"] == "merge"][0]
        self.assertEqual(merge_step.get("reentry"), "REUSED")
        self.assertEqual(
            git(self.primary, "rev-parse", "main").stdout.strip(), head_after_merge
        )


class IntegrationLockTests(TransactionFixture):
    def test_second_transaction_on_same_target_rejected_ret13(self) -> None:
        first = self.make_txn(run_id="run-a")
        first.preflight()
        first.prepare()
        # Snapshot after the winner's writes; the loser must add nothing.
        status_after_first = git(self.primary, "status", "--porcelain=v1").stdout
        second = self.make_txn(run_id="run-b")
        with self.assertRaises(integration.IntegrationLockHeldError):
            second.preflight()
        self.assertEqual(
            git(self.primary, "status", "--porcelain=v1").stdout,
            status_after_first,
        )
        self.assertFalse(
            integration.journal_path(self.primary, second.transaction_id).exists()
        )

    def test_lock_released_after_cleanup(self) -> None:
        txn = self.make_txn()
        txn.preflight()
        txn.prepare()
        txn.merge()
        txn.verify(commands=[[sys.executable, "-c", "pass"]])
        txn.push()
        txn.cleanup()
        follower = self.make_txn(run_id="run-2")
        follower.preflight()  # must not raise
        follower.cleanup()


class CleanupBoundaryTests(TransactionFixture):
    def test_cleanup_before_push_is_refused_and_keeps_integration_worktree(self) -> None:
        txn = self.make_txn()
        txn.preflight()
        txn.prepare()
        journal = integration.load_journal(self.primary, txn.transaction_id)
        intg_root = Path(journal["integrationRoot"])

        with self.assertRaises(integration.CleanupRefusedError):
            txn.cleanup()

        self.assertTrue(intg_root.exists())
        journal = integration.load_journal(self.primary, txn.transaction_id)
        self.assertEqual(
            next(step for step in journal["steps"] if step["name"] == "push")["status"],
            "PENDING",
        )

    def test_cleanup_refuses_dangerous_targets_ret12(self) -> None:
        txn = self.make_txn()
        txn.preflight()
        txn.prepare()
        journal = integration.load_journal(self.primary, txn.transaction_id)
        dangerous = [
            self.primary,  # repo root
            self.temp_root,  # parent of the exact worktree
            self.primary / ".git",  # git dir
            Path(""),  # empty
            self.tmp / "elsewhere",  # outside allowed root
        ]
        for target in dangerous:
            with self.subTest(target=str(target)):
                with self.assertRaises((ValueError, integration.CleanupRefusedError)):
                    txn.cleanup_target(target)

    def test_cleanup_removes_exact_integration_worktree(self) -> None:
        txn = self.make_txn()
        txn.preflight()
        txn.prepare()
        journal = integration.load_journal(self.primary, txn.transaction_id)
        intg_root = Path(journal["integrationRoot"])
        self.assertTrue(intg_root.exists())
        txn.merge()
        txn.verify(commands=[[sys.executable, "-c", "pass"]])
        txn.push()
        txn.cleanup()
        self.assertFalse(intg_root.exists())
        worktrees = git(self.primary, "worktree", "list", "--porcelain").stdout
        self.assertNotIn(str(intg_root), worktrees)

    def test_cleanup_refuses_other_transaction_path(self) -> None:
        first = self.make_txn(run_id="run-a")
        first.preflight()
        first.prepare()
        first_journal = integration.load_journal(self.primary, first.transaction_id)
        first_root = Path(first_journal["integrationRoot"])
        # A second transaction object must not delete the first one's worktree.
        second = self.make_txn(run_id="run-b")
        with self.assertRaises(
            (ValueError, integration.CleanupRefusedError, integration.IntegrationLockHeldError)
        ):
            second.cleanup_target(first_root)
        self.assertTrue(first_root.exists())

    def test_cleanup_reports_residual_after_heavy_roots_are_removed(self) -> None:
        txn = self.make_txn()
        txn.preflight()
        txn.prepare()
        journal = integration.load_journal(self.primary, txn.transaction_id)
        intg_root = Path(journal["integrationRoot"])
        (intg_root / "node_modules" / "pkg").mkdir(parents=True)
        (intg_root / "node_modules" / "pkg" / "cache.bin").write_bytes(b"x")
        (intg_root / ".venv" / "Lib").mkdir(parents=True)
        (intg_root / ".venv" / "Lib" / "site.py").write_text("x\n", encoding="utf-8")
        original_run = txn.runner.run

        def remove_then_recreate(cwd, *args, **kwargs):
            if args[:3] == ("worktree", "remove", "--force"):
                self.assertFalse((intg_root / "node_modules").exists())
                self.assertFalse((intg_root / ".venv").exists())
                result = original_run(cwd, *args, **kwargs)
                intg_root.mkdir(parents=True, exist_ok=True)
                (intg_root / "locked-residual.txt").write_text(
                    "retained\n", encoding="utf-8"
                )
                return result
            return original_run(cwd, *args, **kwargs)

        with mock.patch.object(txn.runner, "run", side_effect=remove_then_recreate):
            result = txn.cleanup_target(intg_root)

        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "CLEANUP_RESIDUAL")
        self.assertIn("node_modules", result["heavyRootsRemoved"])
        self.assertIn(".venv", result["heavyRootsRemoved"])
        self.assertEqual(result["residualPaths"], ["locked-residual.txt"])
        self.assertFalse(result["worktreeRegistered"])

    def test_cleanup_reports_registration_removed_residual_present(self) -> None:
        """§5.30: git worktree remove returns non-zero but registration is
        already deleted and disk path remains — return structured half-success
        status, not generic CLEANUP_RESIDUAL."""
        txn = self.make_txn()
        txn.preflight()
        txn.prepare()
        journal = integration.load_journal(self.primary, txn.transaction_id)
        intg_root = Path(journal["integrationRoot"])
        (intg_root / "residual.txt").write_text("leftover\n", encoding="utf-8")
        original_run = txn.runner.run
        original_text = txn.runner.text
        call_state = {"remove_called": False}

        def remove_fails_registration_gone(cwd, *args, **kwargs):
            if args[:3] == ("worktree", "remove", "--force"):
                # Simulate Windows "Directory not empty": git returns non-zero
                # but registration is already removed.
                call_state["remove_called"] = True
                # Return a fake non-zero result without actually running git.
                class FakeResult:
                    returncode = 1
                    stdout = ""
                    stderr = "fatal: Directory not empty"
                return FakeResult()
            return original_run(cwd, *args, **kwargs)

        def worktree_list(cwd, *args, **kwargs):
            if args[:2] == ("worktree", "list"):
                if call_state["remove_called"]:
                    # After remove: registration gone.
                    return ""
                # Before remove: include the intg_root as registered.
                return f"worktree {intg_root}\n"
            return original_text(cwd, *args, **kwargs)

        with mock.patch.object(txn.runner, "run", side_effect=remove_fails_registration_gone), \
             mock.patch.object(txn.runner, "text", side_effect=worktree_list):
            result = txn.cleanup_target(intg_root)

        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "REGISTRATION_REMOVED_RESIDUAL_PRESENT")
        self.assertFalse(result["worktreeRegistered"])
        self.assertTrue(result["diskPathPresent"])
        self.assertIn("residual.txt", result["residualPaths"])


class VerifyInIntegrationWorktreeTests(TransactionFixture):
    def test_verify_requires_nonempty_plan(self) -> None:
        txn = self.make_txn()
        txn.preflight()
        txn.prepare()
        txn.merge()
        with self.assertRaises(integration.VerifyPlanMissingError):
            txn.verify(commands=[])
        journal = integration.load_journal(self.primary, txn.transaction_id)
        step = next(item for item in journal["steps"] if item["name"] == "verify")
        self.assertEqual(step["status"], "FAILED")
        self.assertEqual(journal.get("verifyResults"), None)

    def test_push_requires_completed_nonempty_verify(self) -> None:
        txn = self.make_txn()
        txn.preflight()
        txn.prepare()
        txn.merge()
        with self.assertRaises(integration.VerifyPlanMissingError):
            txn.push()

    def test_verify_runs_inside_integration_root(self) -> None:
        txn = self.make_txn()
        txn.preflight()
        txn.prepare()
        txn.merge()
        marker = self.tmp / "verify-cwd.json"
        txn.verify(
            commands=[
                [
                    "python",
                    "-c",
                    "import json,os,pathlib;"
                    f"pathlib.Path({str(marker)!r}).write_text("
                    "json.dumps({'cwd': os.getcwd()}))",
                ]
            ]
        )
        recorded = json.loads(marker.read_text(encoding="utf-8"))
        journal = integration.load_journal(self.primary, txn.transaction_id)
        self.assertEqual(
            Path(recorded["cwd"]).resolve(),
            Path(journal["integrationRoot"]).resolve(),
        )

    def test_verify_times_out_and_records_actionable_result(self) -> None:
        txn = self.make_txn()
        txn.preflight()
        txn.prepare()
        txn.merge()
        with self.assertRaises(integration.VerificationFailedError):
            txn.verify(
                commands=[[sys.executable, "-c", "import time; time.sleep(1)"]],
                timeout_seconds=0.05,
            )
        journal = integration.load_journal(self.primary, txn.transaction_id)
        self.assertTrue(journal["verifyResults"][0]["timedOut"])
        self.assertEqual(journal["verifyResults"][0]["timeoutSeconds"], 0.05)


class VerifyCommandParsingTests(unittest.TestCase):
    def test_quoted_arguments_survive_parsing(self) -> None:
        commands = integration._parse_verify_commands(
            ["python -m pytest -k 'alpha beta' --maxfail=1"]
        )
        self.assertEqual(
            commands,
            [["python", "-m", "pytest", "-k", "alpha beta", "--maxfail=1"]],
        )

    def test_plain_command_still_splits_on_spaces(self) -> None:
        commands = integration._parse_verify_commands(["npm run check:all"])
        self.assertEqual(commands, [["npm", "run", "check:all"]])
        self.assertEqual(integration._parse_verify_commands(None), [])

    def test_windows_command_wrapper_is_resolved(self) -> None:
        command = integration._normalize_verify_command(
            ["npm", "run", "check"],
            platform="win32",
            resolver=lambda name: "C:/tools/npm.cmd" if name == "npm.cmd" else None,
        )
        self.assertEqual(command, ["C:/tools/npm.cmd", "run", "check"])

    def test_duplicate_commands_are_executed_once(self) -> None:
        commands = integration._dedupe_verify_commands(
            [["npm", "run", "check"], ["npm", "run", "check"], ["npm", "test"]]
        )
        self.assertEqual(
            commands,
            [["npm", "run", "check"], ["npm", "test"]],
        )


class RemoteProbeTests(unittest.TestCase):
    """C13 (retro §5.28): remote probe typed error.

    `ls-remote` failure must not be folded into `TARGET_MOVED found None`;
    network/auth/process failures must return `REMOTE_PROBE_FAILED` with
    redacted stderr, allowing bounded retry.
    """

    def test_remote_probe_returns_typed_result_on_success(self) -> None:
        runner = integration.GitRunner()
        # Use a real git repo (the test's own repo) to probe origin
        result = runner.remote_probe(
            Path(__file__).resolve().parents[3],
            "rev-parse",
            "HEAD",
        )
        self.assertEqual(result["exitCode"], 0)
        self.assertEqual(result["category"], "ok")
        self.assertIsNotNone(result["stdoutHash"])

    def test_remote_probe_returns_probe_failed_on_nonzero_exit(self) -> None:
        runner = integration.GitRunner()
        result = runner.remote_probe(
            Path(__file__).resolve().parents[3],
            "ls-remote",
            "origin",
            "nonexistent-branch-xyz",
        )
        # ls-remote on a nonexistent branch returns exit 0 with empty stdout on
        # some git versions, or exit 2 on others. Either way, stdoutHash is None
        # when no hash is available, and category is never "target-moved".
        if result["exitCode"] != 0:
            self.assertIn(result["category"], {"probe-failed", "auth-failed"})
            self.assertIsNone(result["stdoutHash"])
        else:
            # exit=0 but no hash (empty stdout) — category=ok, stdoutHash=None
            self.assertEqual(result["category"], "ok")

    def test_remote_probe_redacts_credentials_in_stderr(self) -> None:
        """stderr with credential patterns must be redacted."""
        runner = integration.GitRunner()
        # Simulate a probe with auth failure by mocking run()
        fake_proc = subprocess.CompletedProcess(
            args=["git", "ls-remote"],
            returncode=128,
            stdout="",
            stderr="fatal: Authentication failed for https://user:pass@github.com/repo.git",
        )
        with mock.patch.object(runner, "run", return_value=fake_proc):
            result = runner.remote_probe(
                Path(__file__).resolve().parents[3],
                "ls-remote",
                "origin",
                "main",
            )
        self.assertEqual(result["exitCode"], 128)
        self.assertEqual(result["category"], "auth-failed")
        self.assertIsNone(result["stdoutHash"])
        # Credentials must be redacted
        self.assertNotIn("user:pass", result["redactedStderr"])
        self.assertIn("***", result["redactedStderr"])

    def test_merge_returns_remote_probe_failed_on_network_error(self) -> None:
        """When ls-remote fails (non-zero exit), merge must raise
        RemoteProbeFailedError, not TargetMovedError with found=None."""
        txn_fixture = TransactionFixture()
        txn_fixture.setUp()
        try:
            txn = txn_fixture.make_txn()
            txn.preflight()
            txn.prepare()
            # Mock remote_probe to return a probe-failed result
            probe_result = {
                "exitCode": 128,
                "stdoutHash": None,
                "redactedStderr": "fatal: unable to access: Network unreachable",
                "category": "probe-failed",
            }
            with mock.patch.object(
                txn_fixture.runner, "remote_probe", return_value=probe_result
            ):
                with self.assertRaises(integration.RemoteProbeFailedError):
                    txn.merge()
        finally:
            txn_fixture.tearDown()

    def test_merge_returns_target_moved_only_on_exit_zero_hash_mismatch(self) -> None:
        """When ls-remote succeeds (exit=0) but hash differs, merge must raise
        TargetMovedError (not RemoteProbeFailedError)."""
        txn_fixture = TransactionFixture()
        txn_fixture.setUp()
        try:
            txn = txn_fixture.make_txn()
            txn.preflight()
            txn.prepare()
            # Mock remote_probe to return exit=0 but different hash
            probe_result = {
                "exitCode": 0,
                "stdoutHash": "deadbeef" * 5,  # different from expected
                "redactedStderr": "",
                "category": "ok",
            }
            with mock.patch.object(
                txn_fixture.runner, "remote_probe", return_value=probe_result
            ):
                with self.assertRaises(integration.TargetMovedError):
                    txn.merge()
        finally:
            txn_fixture.tearDown()


class JournalCompactOutputTests(TransactionFixture):
    """C5: journal 子命令默认 compact 输出，--verbose 展开全量。"""

    def _run_cli(self, args: list[str]) -> tuple[int, str, str]:
        from io import StringIO
        from contextlib import redirect_stdout, redirect_stderr

        buf = StringIO()
        err = StringIO()
        orig_cwd = os.getcwd()
        os.chdir(self.primary)
        try:
            with redirect_stdout(buf), redirect_stderr(err):
                code = integration.main(args)
        finally:
            os.chdir(orig_cwd)
        return code, buf.getvalue(), err.getvalue()

    def test_journal_default_compact_has_only_required_fields(self) -> None:
        txn = self.make_txn()
        txn.preflight()  # ensure journal exists

        code, out, err = self._run_cli([
            "journal",
            "--change", "demo",
            "--run-id", "run-1",
            "--target-branch", "main",
            "--feature-branch", "feature/demo",
            "--temp-root", str(self.temp_root),
        ])
        self.assertEqual(code, 0, err)
        payload = json.loads(out)
        # compact: only transactionId/currentStep/status
        self.assertIn("transactionId", payload)
        self.assertIn("currentStep", payload)
        self.assertIn("status", payload)
        self.assertNotIn("steps", payload)
        self.assertNotIn("mergeCommit", payload)
        self.assertNotIn("pushedHead", payload)

    def test_journal_verbose_returns_full_payload(self) -> None:
        txn = self.make_txn()
        txn.preflight()  # ensure journal exists

        code, out, err = self._run_cli([
            "journal",
            "--change", "demo",
            "--run-id", "run-1",
            "--target-branch", "main",
            "--feature-branch", "feature/demo",
            "--temp-root", str(self.temp_root),
            "--verbose",
        ])
        self.assertEqual(code, 0, err)
        payload = json.loads(out)
        self.assertIn("transactionId", payload)
        self.assertIn("steps", payload)
        self.assertIn("mergeCommit", payload)
        self.assertIn("pushedHead", payload)


if __name__ == "__main__":
    unittest.main()
