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
        txn.verify(commands=[])
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
        txn.verify(commands=[])
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
        txn.verify(commands=[])
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
        txn.verify(commands=[])
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
        txn.verify(commands=[])
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

    def test_recover_after_failed_verify_does_not_remerge(self) -> None:
        txn = self.make_txn()
        txn.preflight()
        txn.prepare()
        txn.merge()
        head_after_merge = git(self.primary, "rev-parse", "main").stdout.strip()
        with self.assertRaises(integration.VerificationFailedError):
            txn.verify(commands=[["python", "-c", "import sys; sys.exit(3)"]])

        journal = txn.recover(verify_commands=[])
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
        txn.verify(commands=[])
        txn.push()
        txn.cleanup()
        follower = self.make_txn(run_id="run-2")
        follower.preflight()  # must not raise
        follower.cleanup()


class CleanupBoundaryTests(TransactionFixture):
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


class VerifyInIntegrationWorktreeTests(TransactionFixture):
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


if __name__ == "__main__":
    unittest.main()
