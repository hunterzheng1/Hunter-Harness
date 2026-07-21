#!/usr/bin/env python3
"""Tests for harness_paths.py — Change contract, repository identity, dual-root layout.

Covers retro scenarios:
- RET-09 (COM-001): same repositoryId across worktree/main roots, relative paths stay valid.
- Change contract: lifecycle/ownership/stateOwnership/integration fields (design §3.1).
- Dual-root resolution: split-v1 for new changes, legacy-colocated fallback.
- assert_path_within: path boundary enforcement for cleanup/integration (RET-12 parts).
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


def init_repo(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    git(root, "init")
    git(root, "config", "user.email", "test@example.com")
    git(root, "config", "user.name", "Test")
    git(root, "config", "commit.gpgsign", "false")
    (root / "README.md").write_text("demo\n", encoding="utf-8")
    git(root, "add", "README.md")
    git(root, "commit", "-m", "init")


class RepositoryIdentityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-paths-id-"))
        self.repo = self.tmp / "repo"
        init_repo(self.repo)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_identity_stable_without_remote(self) -> None:
        first = paths.repository_identity(self.repo)
        second = paths.repository_identity(self.repo)
        self.assertTrue(first.startswith("sha256:"), first)
        self.assertEqual(first, second)

    def test_identity_same_across_worktrees_ret09(self) -> None:
        """COM-001/RET-09: main root and linked worktree share one repositoryId."""
        worktree = self.tmp / "wt"
        git(self.repo, "worktree", "add", str(worktree), "-b", "wt-branch")
        main_id = paths.repository_identity(self.repo)
        wt_id = paths.repository_identity(worktree)
        self.assertEqual(main_id, wt_id)

    def test_identity_differs_for_distinct_repos(self) -> None:
        other = self.tmp / "other"
        init_repo(other)
        (other / "OTHER.md").write_text("other\n", encoding="utf-8")
        git(other, "add", "OTHER.md")
        git(other, "commit", "-m", "other")
        self.assertNotEqual(
            paths.repository_identity(self.repo), paths.repository_identity(other)
        )

    def test_identity_ignores_worktree_absolute_path(self) -> None:
        """Identity must not embed the absolute worktree path (RET-09 root migration)."""
        identity = paths.repository_identity(self.repo)
        self.assertNotIn(str(self.repo), identity)


class ChangeContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-paths-contract-"))
        self.project = self.tmp / "project"
        init_repo(self.project)
        self.contract_dir = self.project / ".harness" / "changes" / "demo-change"
        (self.contract_dir / "meta").mkdir(parents=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_contract(self, payload: dict) -> Path:
        target = self.contract_dir / "meta" / "change-context.json"
        target.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        return target

    def test_load_full_contract_v2(self) -> None:
        self._write_contract(
            {
                "schemaVersion": 2,
                "changeId": "demo-change",
                "repositoryId": "sha256:abc",
                "lifecycle": {"status": "active"},
                "ownership": {
                    "productPaths": ["src/"],
                    "staticEvidencePaths": [".harness/changes/demo-change/spec"],
                    "excludedPaths": [".harness/state/"],
                },
                "stateOwnership": {
                    "contractRoot": ".harness/changes/demo-change",
                    "runtimeRoot": ".harness/state/changes/demo-change",
                },
                "integration": {
                    "targetBranch": "main",
                    "dependsOn": [],
                    "order": 1,
                },
            }
        )
        contract = paths.load_change_contract(self.contract_dir)
        self.assertEqual(contract["changeId"], "demo-change")
        self.assertEqual(contract["lifecycle"]["status"], "active")
        self.assertEqual(
            contract["stateOwnership"]["runtimeRoot"],
            ".harness/state/changes/demo-change",
        )
        self.assertEqual(contract["integration"]["targetBranch"], "main")

    def test_load_legacy_contract_marks_layout(self) -> None:
        """v1 contract without stateOwnership must still load and report legacy layout."""
        self._write_contract({"schemaVersion": 1, "changeId": "demo-change"})
        contract = paths.load_change_contract(self.contract_dir)
        self.assertEqual(contract["changeId"], "demo-change")
        layout = paths.contract_layout_kind(contract)
        self.assertEqual(layout, "legacy-colocated")

    def test_load_rejects_invalid_lifecycle_status(self) -> None:
        self._write_contract(
            {
                "schemaVersion": 2,
                "changeId": "demo-change",
                "lifecycle": {"status": "bogus"},
            }
        )
        with self.assertRaises(ValueError):
            paths.load_change_contract(self.contract_dir)

    def test_load_missing_context_file(self) -> None:
        with self.assertRaises(FileNotFoundError):
            paths.load_change_contract(self.contract_dir)


class ResolveChangeLayoutTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-paths-layout-"))
        self.project = self.tmp / "project"
        init_repo(self.project)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _make_change(
        self, change_id: str, contract: dict | None = None
    ) -> Path:
        contract_dir = self.project / ".harness" / "changes" / change_id
        (contract_dir / "meta").mkdir(parents=True, exist_ok=True)
        if contract is not None:
            (contract_dir / "meta" / "change-context.json").write_text(
                json.dumps(contract, indent=2), encoding="utf-8"
            )
        return contract_dir

    def test_split_v1_layout_for_new_change(self) -> None:
        self._make_change(
            "new-change",
            {
                "schemaVersion": 2,
                "changeId": "new-change",
                "lifecycle": {"status": "active"},
                "stateOwnership": {
                    "contractRoot": ".harness/changes/new-change",
                    "runtimeRoot": ".harness/state/changes/new-change",
                },
            },
        )
        layout = paths.resolve_change_layout(self.project, "new-change")
        self.assertEqual(layout["schemaVersion"], 1)
        self.assertEqual(layout["changeName"], "new-change")
        self.assertEqual(layout["layout"], "split-v1")
        self.assertTrue(layout["repositoryId"].startswith("sha256:"))
        self.assertEqual(
            Path(layout["contractRoot"]).resolve(),
            (self.project / ".harness" / "changes" / "new-change").resolve(),
        )
        self.assertEqual(
            Path(layout["stateRoot"]).resolve(),
            (self.project / ".harness" / "state" / "changes" / "new-change").resolve(),
        )
        self.assertEqual(
            Path(layout["projectRoot"]).resolve(), self.project.resolve()
        )

    def test_split_v1_runtime_root_cannot_escape_project(self) -> None:
        contract_dir = self._make_change(
            "escape-change",
            {
                "schemaVersion": 2,
                "changeId": "escape-change",
                "stateOwnership": {
                    "contractRoot": ".harness/changes/escape-change",
                    "runtimeRoot": "../../outside-runtime",
                },
            },
        )
        with self.assertRaises(ValueError):
            paths.resolve_change_layout(self.project, "escape-change")
        with self.assertRaises(ValueError):
            paths.resolve_state_dir_for_contract(contract_dir, self.project)

    def test_legacy_layout_keeps_colocated_state(self) -> None:
        """Old changes without stateOwnership keep reading the colocated layout."""
        self._make_change(
            "old-change", {"schemaVersion": 1, "changeId": "old-change"}
        )
        layout = paths.resolve_change_layout(self.project, "old-change")
        self.assertEqual(layout["layout"], "legacy-colocated")
        self.assertEqual(
            Path(layout["stateRoot"]).resolve(),
            Path(layout["contractRoot"]).resolve(),
        )

    def test_resolve_accepts_contract_dir_directly(self) -> None:
        contract_dir = self._make_change(
            "by-dir", {"schemaVersion": 1, "changeId": "by-dir"}
        )
        layout = paths.resolve_change_layout(self.project, contract_dir)
        self.assertEqual(layout["changeName"], "by-dir")

    def test_resolve_from_linked_worktree_uses_main_state(self) -> None:
        """State lives in the main project root even when code runs in a worktree."""
        self._make_change(
            "wt-change",
            {
                "schemaVersion": 2,
                "changeId": "wt-change",
                "lifecycle": {"status": "active"},
                "stateOwnership": {
                    "contractRoot": ".harness/changes/wt-change",
                    "runtimeRoot": ".harness/state/changes/wt-change",
                },
            },
        )
        wt = self.tmp / "linked-wt"
        git(self.project, "worktree", "add", str(wt), "-b", "wt-x")
        layout = paths.resolve_change_layout(wt, "wt-change")
        self.assertEqual(
            Path(layout["contractRoot"]).resolve(),
            (self.project / ".harness" / "changes" / "wt-change").resolve(),
        )
        self.assertEqual(Path(layout["worktreeRoot"]).resolve(), wt.resolve())
        self.assertEqual(
            Path(layout["projectRoot"]).resolve(), self.project.resolve()
        )

    def test_resolve_unknown_change_fails(self) -> None:
        with self.assertRaises((FileNotFoundError, ValueError)):
            paths.resolve_change_layout(self.project, "ghost")

    def test_resolve_does_not_move_legacy_files(self) -> None:
        """Resolution is read-only: legacy dynamic files must not be relocated."""
        contract_dir = self._make_change(
            "legacy-static", {"schemaVersion": 1, "changeId": "legacy-static"}
        )
        dynamic = contract_dir / "events.ndjson"
        dynamic.write_text("{}\n", encoding="utf-8")
        before = dynamic.read_bytes()
        paths.resolve_change_layout(self.project, "legacy-static")
        self.assertTrue(dynamic.is_file())
        self.assertEqual(dynamic.read_bytes(), before)
        self.assertFalse(
            (self.project / ".harness" / "state" / "changes" / "legacy-static").exists()
        )


class AssertPathWithinTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-paths-within-"))
        self.root = (self.tmp / "allowed").resolve()
        self.root.mkdir(parents=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_accepts_child_path(self) -> None:
        child = self.root / "a" / "b"
        child.mkdir(parents=True)
        resolved = paths.assert_path_within(child, self.root)
        self.assertEqual(Path(resolved), child.resolve())

    def test_accepts_root_itself_only_when_allowed(self) -> None:
        with self.assertRaises(ValueError):
            paths.assert_path_within(self.root, self.root, allow_root=False)
        resolved = paths.assert_path_within(self.root, self.root, allow_root=True)
        self.assertEqual(Path(resolved), self.root)

    def test_rejects_parent_directory(self) -> None:
        with self.assertRaises(ValueError):
            paths.assert_path_within(self.tmp, self.root)

    def test_rejects_sibling_prefix_attack(self) -> None:
        """`allowed-evil` shares the string prefix but is not inside `allowed`."""
        evil = (self.tmp / "allowed-evil").resolve()
        evil.mkdir()
        with self.assertRaises(ValueError):
            paths.assert_path_within(evil, self.root)

    def test_rejects_empty_and_dot(self) -> None:
        with self.assertRaises(ValueError):
            paths.assert_path_within(Path(""), self.root)

    def test_rejects_symlink_escape(self) -> None:
        outside = (self.tmp / "outside").resolve()
        outside.mkdir()
        link = self.root / "link"
        try:
            os.symlink(outside, link, target_is_directory=True)
        except (OSError, NotImplementedError) as exc:
            self.skipTest(f"symlink unavailable: {exc}")
        with self.assertRaises(ValueError):
            paths.assert_path_within(link / "payload", self.root)


class CommonRootTests(unittest.TestCase):
    """C7: common_root 从 git common dir 解析；worktree 返回主项目根。"""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-paths-common-"))
        self.repo = self.tmp / "repo"
        init_repo(self.repo)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_common_root_of_main_repo_is_repo_root(self) -> None:
        result = paths.common_root(self.repo)
        self.assertEqual(result, self.repo.resolve())

    def test_common_root_of_worktree_is_main_repo_root(self) -> None:
        worktree = self.tmp / "wt"
        git(self.repo, "worktree", "add", str(worktree), "-b", "wt-branch")
        result = paths.common_root(worktree)
        self.assertEqual(result, self.repo.resolve())

    def test_common_root_outside_git_repo_returns_input_resolved(self) -> None:
        non_repo = self.tmp / "not-a-repo"
        non_repo.mkdir()
        result = paths.common_root(non_repo)
        self.assertEqual(result, non_repo.resolve())


if __name__ == "__main__":
    unittest.main()
