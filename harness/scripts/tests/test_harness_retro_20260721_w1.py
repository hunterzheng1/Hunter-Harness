#!/usr/bin/env python3
"""Wave-1 tests for retro-20260721-harness-hardening-w1 (clusters C/E + B/D/A)."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock


SCRIPTS_DIR = Path(__file__).resolve().parents[1]


def _load(name: str):
    path = SCRIPTS_DIR / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


he = _load("harness_events")
ha = _load("harness_archive")
hi = _load("harness_integration")
hp = _load("harness_paths")


class ArtifactPathRequiredTest(unittest.TestCase):
    """UT-001/002/003 — H-8 artifact always requires path."""

    def _args(self, **kwargs: object) -> argparse.Namespace:
        base = {
            "type": "artifact",
            "kind": None,
            "path": None,
            "note": "x",
            "phase": "plan",
            "command": None,
            "exit_code": None,
            "duration_ms": None,
            "status": None,
            "name": None,
            "code": None,
            "severity": None,
            "message": None,
            "decision": None,
            "reason": None,
            "issue_id": None,
            "scope": None,
            "target_event_id": None,
            "target_field": None,
            "old_value_hash": None,
            "new_value_json": None,
            "renamed_from": None,
            "renamed_to": None,
            "change_uuid": None,
            "attempt": None,
            "executor_tool": None,
            "executor_agent": None,
            "executor_model": None,
            "handoff_from_tool": None,
            "handoff_reason": None,
            "trace_id": None,
            "span_id": None,
            "parent_span_id": None,
            "runner_ms": None,
            "orchestration_active_ms": None,
            "wall_clock_ms": None,
            "user_wait_ms": None,
            "run_id": None,
            "legacy_lenient": False,
        }
        base.update(kwargs)
        return argparse.Namespace(**base)

    def test_ut001_artifact_without_path_rejected(self) -> None:
        err = he.validate_append_event(self._args())
        self.assertIsNotNone(err)
        assert err is not None
        self.assertEqual(err[0], "ARTIFACT_PATH_REQUIRED")

    def test_ut002_informational_without_path_rejected(self) -> None:
        err = he.validate_append_event(self._args(kind="informational"))
        self.assertIsNotNone(err)
        assert err is not None
        self.assertEqual(err[0], "ARTIFACT_PATH_REQUIRED")

    def test_ut003_artifact_with_path_ok(self) -> None:
        err = he.validate_append_event(self._args(path="reports/a.md", kind="file-backed"))
        self.assertIsNone(err)


class PassRateAndStageTest(unittest.TestCase):
    """UT-004/005/006/007 — H-13 passRate; H-14 stage WARN."""

    def test_ut004_pass_rate_excludes_skipped(self) -> None:
        ledger = {
            "validations": {
                "unitTestFull": {
                    "status": "OK",
                    "metrics": {"passed": 205, "failed": 0, "errors": 0, "skipped": 32},
                }
            }
        }
        unit = ha._ledger_unit_tests(ledger)
        self.assertEqual(unit["skipped"], 32)
        self.assertEqual(unit["failures"], 0)
        self.assertEqual(unit["passRate"], "100%")

    def test_ut005_pass_rate_with_failures_uses_executed_denominator(self) -> None:
        ledger = {
            "validations": {
                "unitTestFull": {
                    "status": "FAIL",
                    "metrics": {"passed": 10, "failed": 2, "errors": 0, "skipped": 5},
                }
            }
        }
        unit = ha._ledger_unit_tests(ledger)
        # 10/12 ≈ 83%
        self.assertEqual(unit["passRate"], "83%")

    def test_ut006_informational_warn_does_not_downgrade_ok_stage(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp) / "chg"
            change_dir.mkdir()
            events = [
                {
                    "type": "phase.end",
                    "phase": "plan",
                    "status": "OK",
                    "id": "e1",
                },
                {
                    "type": "issue",
                    "phase": "plan",
                    "severity": "warning",
                    "note": "CUSTOM_AGENTS_UNSUPPORTED host has no custom agents",
                    "id": "e2",
                    "issue_id": "e2",
                },
            ]
            status = ha._stage_status_from_sources(events, None, change_dir)
            self.assertEqual(status["plan"], "OK")

    def test_ut007_business_warning_still_downgrades(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp) / "chg"
            change_dir.mkdir()
            events = [
                {"type": "phase.end", "phase": "run", "status": "OK", "id": "e1"},
                {
                    "type": "issue",
                    "phase": "run",
                    "severity": "warning",
                    "note": "partial evidence: INT scenarios not batch-run",
                    "id": "e2",
                    "issue_id": "e2",
                },
            ]
            status = ha._stage_status_from_sources(events, None, change_dir)
            self.assertEqual(status["run"], "WARN")


class SummaryBaseAndAdequacyTest(unittest.TestCase):
    """UT-008/009/010 — H-11/H-12 summary base fallback + adequacy."""

    def test_ut008_base_commit_falls_back_to_phase_context(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp) / "chg"
            ctx = change_dir / "runtime" / "phase-context"
            ctx.mkdir(parents=True)
            (ctx / "run-1.json").write_text(
                json.dumps({"baseCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}),
                encoding="utf-8",
            )
            resolved = ha._resolve_base_commit(
                {"mergeFinalHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
                change_dir,
                Path(tmp),
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            )
            self.assertEqual(resolved, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")

    def test_ut009_identity_base_missing_when_final_without_base(self) -> None:
        summary = {
            "baseCommit": "",
            "finalCommit": "def5678",
            "mergeFinalHash": "def5678",
            "diffStat": {"filesChanged": 3},
            "gitFacts": {"baseCommit": "", "finalCommit": "def5678", "filesChanged": 3},
            "verification": {"unitTests": {}, "apiTests": {}},
            "stageStatus": {},
        }
        result = ha.validate_report_adequacy(summary)
        self.assertFalse(result["ok"])
        codes = {issue["code"] for issue in result["issues"]}
        self.assertIn("IDENTITY_BASE_MISSING", codes)

    def test_ut010_diff_zero_with_nonempty_commit_from_top_level(self) -> None:
        summary = {
            "baseCommit": "abc1234",
            "finalCommit": "def5678",
            "diffStat": {"filesChanged": 0, "insertions": 0, "deletions": 0},
            "verification": {
                "unitTests": {"passed": 1, "failed": 0},
                "apiTests": {"status": "OK"},
            },
            "stageStatus": {},
        }
        result = ha.validate_report_adequacy(summary)
        self.assertFalse(result["ok"])
        codes = {issue["code"] for issue in result["issues"]}
        self.assertIn("DIFF_ZERO_WITH_NONEMPTY_COMMIT", codes)


class CheckStatusMinSetTest(unittest.TestCase):
    """UT-011/012/013 — H-4 archive minimum set blockers."""

    def _bare_change(self, root: Path) -> Path:
        change_dir = root / "chg"
        change_dir.mkdir()
        # Satisfy git-related soft checks by pointing project away from a real repo when needed.
        return change_dir

    def test_ut011_missing_plan_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = self._bare_change(Path(tmp))
            (change_dir / "events.ndjson").write_text(
                '{"type":"phase.end","phase":"run","status":"OK","id":"1"}\n',
                encoding="utf-8",
            )
            (change_dir / "evidence").mkdir()
            (change_dir / "evidence" / "verification-ledger.json").write_text(
                "{}", encoding="utf-8"
            )
            (change_dir / "reports" / "test").mkdir(parents=True)
            (change_dir / "reports" / "test" / "test-report-1.md").write_text(
                "# t\n", encoding="utf-8"
            )
            with mock.patch.object(ha, "git_run", return_value=(1, "", "nogit")):
                result = ha.check_status(change_dir)
            codes = {b["code"] for b in result["blockers"]}
            self.assertIn("missing-plan", codes)
            self.assertFalse(result["archivable"])

    def test_ut012_missing_events_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = self._bare_change(Path(tmp))
            (change_dir / "plans").mkdir()
            (change_dir / "plans" / "chg-plan.md").write_text("# plan\n", encoding="utf-8")
            (change_dir / "evidence").mkdir()
            (change_dir / "evidence" / "verification-ledger.json").write_text(
                "{}", encoding="utf-8"
            )
            (change_dir / "reports" / "test").mkdir(parents=True)
            (change_dir / "reports" / "test" / "test-report-1.md").write_text(
                "# t\n", encoding="utf-8"
            )
            with mock.patch.object(ha, "git_run", return_value=(1, "", "nogit")):
                result = ha.check_status(change_dir)
            codes = {b["code"] for b in result["blockers"]}
            self.assertIn("missing-events", codes)
            self.assertFalse(result["archivable"])

    def test_ut013_missing_ledger_blocks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = self._bare_change(Path(tmp))
            (change_dir / "plans").mkdir()
            (change_dir / "plans" / "chg-plan.md").write_text("# plan\n", encoding="utf-8")
            (change_dir / "events.ndjson").write_text(
                '{"type":"phase.end","phase":"run","status":"OK","id":"1"}\n',
                encoding="utf-8",
            )
            (change_dir / "reports" / "test").mkdir(parents=True)
            (change_dir / "reports" / "test" / "test-report-1.md").write_text(
                "# t\n", encoding="utf-8"
            )
            with mock.patch.object(ha, "git_run", return_value=(1, "", "nogit")):
                result = ha.check_status(change_dir)
            codes = {b["code"] for b in result["blockers"]}
            self.assertIn("missing-verification-ledger", codes)
            self.assertFalse(result["archivable"])

    def test_ut013b_missing_test_report_is_warning_not_blocker(self) -> None:
        """H-4 min set only: plan/events/ledger; test/review absence is advisory."""
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = self._bare_change(Path(tmp))
            (change_dir / "plans").mkdir()
            (change_dir / "plans" / "chg-plan.md").write_text("# plan\n", encoding="utf-8")
            (change_dir / "events.ndjson").write_text(
                '{"type":"phase.end","phase":"run","status":"OK","id":"1"}\n',
                encoding="utf-8",
            )
            (change_dir / "evidence").mkdir()
            (change_dir / "evidence" / "verification-ledger.json").write_text(
                "{}", encoding="utf-8"
            )
            with mock.patch.object(ha, "git_run", return_value=(1, "", "nogit")):
                result = ha.check_status(change_dir)
            codes = {b["code"] for b in result["blockers"]}
            warn_codes = {w["code"] for w in result["warnings"]}
            self.assertNotIn("missing-test-or-review-report", codes)
            self.assertIn("missing-test-or-review-report", warn_codes)
            self.assertTrue(result["archivable"])


class IntegrationAbandonAndAutocrlfTest(unittest.TestCase):
    """UT-014/015/016 — H-5/H-6 abandon + prepare autocrlf."""

    def test_ut016_prepare_sets_autocrlf_false(self) -> None:
        txn = hi.IntegrationTransaction(
            project_root=Path("."),
            change_id="demo",
            run_id="run-1",
            target_branch="main",
            feature_branch="feature/demo",
            temp_root=Path(tempfile.gettempdir()) / "harness-intg-ut",
            runner=hi.GitRunner(),
        )
        journal = {
            "base": "abc",
            "integrationRoot": str(Path(tempfile.gettempdir()) / "harness-intg-ut" / "x"),
            "steps": [{"name": "prepare", "status": "PENDING"}],
        }
        calls: list[tuple[str, ...]] = []

        def fake_run(cwd, *args, check=True):  # noqa: ANN001
            calls.append(tuple(args))
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        with mock.patch.object(txn.runner, "run", side_effect=fake_run):
            with mock.patch.object(Path, "mkdir"):
                action = None

                def capture_run_step(name, act):  # noqa: ANN001
                    nonlocal action
                    action = act
                    act(journal)
                    return journal

                with mock.patch.object(txn, "_run_step", side_effect=capture_run_step):
                    txn.prepare()
        self.assertIn(("config", "core.autocrlf", "false"), calls)

    def test_ut015_abandon_refused_when_push_done(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            txn = hi.IntegrationTransaction(
                project_root=root,
                change_id="demo",
                run_id="run-1",
                target_branch="main",
                feature_branch="feature/demo",
                temp_root=root / "temp",
            )
            journal = {
                "transactionId": txn.transaction_id,
                "mergeCommit": "abc",
                "pushedHead": "abc",
                "mergeFinalHash": "abc",
                "integrationRoot": str(root / "temp" / txn.transaction_id),
                "allowedCleanupRoot": str(root / "temp" / txn.transaction_id),
                "protectionRefs": {"base": "refs/harness/x/base", "head": "refs/harness/x/head"},
                "steps": [
                    {"name": n, "status": "DONE" if n != "cleanup" else "PENDING"}
                    for n in hi.STEP_ORDER
                ],
                "revision": 1,
            }
            with mock.patch.object(txn, "_load", return_value=journal):
                with mock.patch.object(txn, "_remote_contains_merge", return_value=False):
                    with self.assertRaises(hi.AbandonRefusedError) as ctx:
                        txn.abandon()
            self.assertEqual(ctx.exception.code, "ABANDON_REFUSED")

    def test_ut014_abandon_cleans_integration_keeps_feature(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            temp_root = root / "temp"
            intg = temp_root / "demo-run-1"
            intg.mkdir(parents=True)
            (intg / "marker.txt").write_text("x", encoding="utf-8")
            feature_wt = root / "feature-wt"
            feature_wt.mkdir()
            (feature_wt / "keep.txt").write_text("keep", encoding="utf-8")

            txn = hi.IntegrationTransaction(
                project_root=root,
                change_id="demo",
                run_id="run-1",
                target_branch="main",
                feature_branch="feature/demo",
                temp_root=temp_root,
            )
            # Align transaction id path with constructed intg dir name used above.
            intg_root = Path(str(temp_root / txn.transaction_id))
            if intg_root != intg:
                intg_root.parent.mkdir(parents=True, exist_ok=True)
                if intg.exists() and not intg_root.exists():
                    intg.rename(intg_root)
                    intg = intg_root
            journal = {
                "transactionId": txn.transaction_id,
                "mergeCommit": None,
                "integrationRoot": str(intg),
                "allowedCleanupRoot": str(intg.resolve()),
                "protectionRefs": {
                    "base": f"refs/harness/integration/{txn.transaction_id}/base",
                    "head": f"refs/harness/integration/{txn.transaction_id}/head",
                },
                "steps": [
                    {
                        "name": n,
                        "status": (
                            "DONE"
                            if n in {"preflight", "prepare", "merge", "verify"}
                            else "FAILED"
                            if n == "push"
                            else "PENDING"
                        ),
                    }
                    for n in hi.STEP_ORDER
                ],
                "revision": 1,
            }
            jdir = root / ".harness" / "state" / "integration" / txn.transaction_id
            jdir.mkdir(parents=True)
            (jdir / "journal.json").write_text(
                json.dumps(journal), encoding="utf-8"
            )

            run_calls: list[tuple] = []

            def fake_run(cwd, *args, check=True):  # noqa: ANN001
                run_calls.append((str(cwd), args))
                return SimpleNamespace(returncode=0, stdout="", stderr="")

            def fake_text(cwd, *args):  # noqa: ANN001
                if args[:2] == ("worktree", "list"):
                    return ""
                if args[:1] == ("ls-remote",):
                    return ""
                return None

            with mock.patch.object(txn.runner, "run", side_effect=fake_run):
                with mock.patch.object(txn.runner, "text", side_effect=fake_text):
                    with mock.patch.object(
                        hi.harness_change, "integration_lock_release", return_value={"ok": True}
                    ):
                        # Force path: cleanup_target may refuse unregistered → force remove
                        result = txn.abandon()

            self.assertTrue(result["ok"])
            self.assertEqual(result["code"], "ABANDON_COMPLETE")
            self.assertTrue(result["featureWorktreeRetained"])
            self.assertTrue((feature_wt / "keep.txt").is_file())
            self.assertTrue(
                any(args[:2] == ("branch", "-D") for _, args in run_calls)
            )


class CleanupTopologyAndSnapshotTest(unittest.TestCase):
    """UT-017/018 — H-1/H-3 cleanup topology + formal snapshot."""

    def test_ut017_cleanup_refuses_state_inside_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cleanup = Path(tmp) / "cleanup"
            state = cleanup / "state"
            state.mkdir(parents=True)
            with self.assertRaises(hp.CleanupTopologyError) as ctx:
                hp.assert_cleanup_safe(cleanup, state_roots=[state], archive_roots=[])
            self.assertIn("CLEANUP_TOPOLOGY_REFUSED", str(ctx.exception))

    def test_ut017c_cleanup_skips_descending_into_node_modules(self) -> None:
        """Heavy dirs are still scanned as entries but not walked into."""
        with tempfile.TemporaryDirectory() as tmp:
            cleanup = Path(tmp) / "cleanup"
            nested = cleanup / "node_modules" / "pkg" / "deep"
            nested.mkdir(parents=True)
            (nested / "x.txt").write_text("x", encoding="utf-8")
            state = Path(tmp) / "state-outside"
            state.mkdir()
            # Should succeed: no link into state; walk must not explode on size.
            resolved = hp.assert_cleanup_safe(
                cleanup, state_roots=[state], archive_roots=[]
            )
            self.assertEqual(resolved, cleanup.resolve())

    def test_ut017b_cleanup_refuses_junction_into_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cleanup = root / "cleanup"
            cleanup.mkdir()
            state = root / "state-outside"
            state.mkdir()
            (state / "keep.json").write_text("{}", encoding="utf-8")
            link = cleanup / "linked-state"
            created = False
            if os.name == "nt":
                proc = subprocess.run(
                    ["cmd", "/c", "mklink", "/J", str(link), str(state)],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    check=False,
                )
                created = proc.returncode == 0 and link.exists()
            else:
                try:
                    link.symlink_to(state, target_is_directory=True)
                    created = True
                except OSError:
                    created = False
            if not created:
                self.skipTest("junction/symlink not available")
            with self.assertRaises(hp.CleanupTopologyError):
                hp.assert_cleanup_safe(cleanup, state_roots=[state], archive_roots=[])
            self.assertTrue((state / "keep.json").is_file())

    def test_ut018_snapshot_writes_cache_outside_change(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "proj"
            change = project / ".harness" / "changes" / "demo"
            (change / "plans").mkdir(parents=True)
            (change / "plans" / "demo-plan.md").write_text("# plan\n", encoding="utf-8")
            (change / "spec").mkdir()
            (change / "spec" / "demo-design.md").write_text("# design\n", encoding="utf-8")
            (change / "evidence").mkdir()
            (change / "evidence" / "verification-ledger.json").write_text(
                "{}", encoding="utf-8"
            )
            (change / "reports").mkdir()
            (change / "meta").mkdir()
            (change / "meta" / "worktree.json").write_text(
                '{"requested":true}', encoding="utf-8"
            )
            (change / "events.ndjson").write_text("{}\n", encoding="utf-8")

            with mock.patch.object(hp, "resolve_main_project_root", return_value=project):
                result = hp.snapshot_change_formal_layer(project, "demo")

            dest = project / ".harness" / "cache" / "change-snapshots" / "demo"
            self.assertTrue(result["ok"])
            self.assertTrue((dest / "plans" / "demo-plan.md").is_file())
            self.assertTrue((dest / "events.ndjson").is_file())
            self.assertTrue((dest / "manifest.json").is_file())
            self.assertFalse(str(dest).startswith(str(change)))


if __name__ == "__main__":
    unittest.main()
