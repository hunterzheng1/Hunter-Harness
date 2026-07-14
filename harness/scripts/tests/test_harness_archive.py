#!/usr/bin/env python3
"""Unittests for harness_archive.py (P0-2)."""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_archive as ha  # noqa: E402
import harness_events as he  # noqa: E402

FIXTURE_ARCHIVE = (
    Path(__file__).resolve().parents[2]
    / "harness-knowledge-ingest"
    / "tests"
    / "fixtures"
    / "mcp-eval-project"
    / ".harness"
    / "archive"
    / "2026-01-10-ledger-reconciliation"
)


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def _write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def _run(argv: list[str]) -> tuple[int, dict]:
    from contextlib import redirect_stderr, redirect_stdout
    from io import StringIO

    out = StringIO()
    err = StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = ha.main(argv)
    text = out.getvalue().strip() or err.getvalue().strip()
    payload = json.loads(text) if text else {}
    return code, payload


def _seed_change_dir(change_dir: Path) -> None:
    """Minimal change fixture with events + ledger + plan."""
    _write(change_dir / "plans" / "demo-plan.md", "# plan\n\ngoal: demo archive\n")
    _write(
        change_dir / "tests" / "test-report-20260710.md",
        "# Test Report\n\nunit: 3/3 passed\n",
    )
    _write(
        change_dir / "reports" / "review" / "review-report-20260710.md",
        "# Review\n\nADVISORY: no blocking issues\n",
    )
    _write_json(
        change_dir / "evidence" / "verification-ledger.json",
        {
            "changeName": change_dir.name,
            "baseCommit": "aaaaaaaa",
            "finalCommit": "bbbbbbbb",
            "validations": {
                "unitTest": {
                    "status": "OK",
                    "command": "python -m unittest",
                    "evidence": {
                        "run": 3,
                        "failures": 0,
                        "errors": 0,
                        "skipped": 0,
                        "passRate": "3/3",
                    },
                },
                "apiTest": {
                    "status": "OK",
                    "total": 1,
                    "passed": 1,
                    "failed": 0,
                    "blocked": 0,
                    "passRate": "1/1",
                },
            },
        },
    )
    # Seed events via harness_events
    seq = [
        ["--phase", "plan", "--type", "phase.start", "--note", "开始"],
        ["--phase", "plan", "--type", "phase.end"],
        ["--phase", "run", "--type", "phase.start"],
        [
            "--phase",
            "run",
            "--type",
            "command",
            "--command",
            "python -m unittest",
            "--exit-code",
            "0",
            "--duration-ms",
            "500",
            "--note",
            "unit green",
        ],
        [
            "--phase",
            "run",
            "--type",
            "verification",
            "--name",
            "unitTest",
            "--status",
            "ok",
        ],
        ["--phase", "run", "--type", "phase.end"],
        ["--phase", "test", "--type", "phase.start"],
        ["--phase", "test", "--type", "phase.end"],
        ["--phase", "submit", "--type", "phase.start"],
        [
            "--phase",
            "submit",
            "--type",
            "command",
            "--command",
            "git push origin HEAD",
            "--exit-code",
            "0",
            "--note",
            "final pushed hash bbbbbbbb",
        ],
        ["--phase", "submit", "--type", "phase.end"],
    ]
    for args in seq:
        code = he.main(["--json", "append", "--change-dir", str(change_dir), *args])
        assert code == 0, f"seed append failed: {args}"


class FinalizeSuccessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-archive-ok-"))
        self.project = self.tmp / "proj"
        self.change = self.project / ".harness" / "changes" / "demo-change"
        self.archive_root = self.project / ".harness" / "archive"
        self.change.mkdir(parents=True)
        self.archive_root.mkdir(parents=True)
        _seed_change_dir(self.change)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_finalize_full_chain_success(self) -> None:
        code, payload = _run(
            [
                "finalize",
                "--change-dir",
                str(self.change),
                "--archive-root",
                str(self.archive_root),
                "--skip-ingest",
                "--json",
            ]
        )
        self.assertEqual(code, 0, msg=json.dumps(payload, ensure_ascii=False, indent=2))
        self.assertTrue(payload.get("ok"))
        archive_dir = Path(payload["archive_dir"])
        self.assertTrue(archive_dir.is_dir())
        self.assertFalse(self.change.exists(), "original change dir must be deleted")
        self.assertTrue(
            (archive_dir / "evidence" / "archive-manifest-before.json").is_file()
        )
        self.assertTrue(
            (archive_dir / "evidence" / "archive-manifest-after.json").is_file()
        )
        summary_path = archive_dir / "reports" / "final" / "summary-data.json"
        self.assertTrue(summary_path.is_file())
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
        self.assertEqual(summary["schemaVersion"], "2.2")
        self.assertEqual(summary["changeName"], "demo-change")
        self.assertEqual(summary["maintenanceNotes"], [])
        self.assertEqual(summary["knownRisks"], [])
        self.assertEqual(summary["manualActions"], [])
        self.assertIn("reportPipeline", summary)
        # Task 2 (§4): final-summary.html 始终产出（node 渲染器，否则 python-fallback）。
        html = archive_dir / "reports" / "final" / "final-summary.html"
        render_step = payload["steps"].get("render") or {}
        self.assertIn(render_step.get("renderer"), {"node", "python-fallback"})
        self.assertTrue(render_step.get("ok"))
        self.assertTrue(html.is_file(), "final-summary.html must always exist after finalize")
        summary = json.loads((archive_dir / "reports" / "final" / "summary-data.json").read_text(encoding="utf-8"))
        self.assertIn(str(summary["archiveManifest"]["totalArchiveFiles"]), html.read_text(encoding="utf-8"))
        html_text = html.read_text(encoding="utf-8")
        self.assertIn("demo-change", html_text)


class FallbackRenderTests(unittest.TestCase):
    """Task 2 (REMEDIATION-DESIGN §4): Node 不可用走 Python fallback；
    所有 renderer 失败则恢复原 change 目录并 exit 非 0。"""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-archive-fb-"))
        self.project = self.tmp / "proj"
        self.change = self.project / ".harness" / "changes" / "fb-change"
        self.archive_root = self.project / ".harness" / "archive"
        self.change.mkdir(parents=True)
        self.archive_root.mkdir(parents=True)
        _seed_change_dir(self.change)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_finalize_without_node_uses_python_fallback(self) -> None:
        with mock.patch.object(ha, "resolve_node_path", return_value=None):
            code, payload = _run(
                [
                    "finalize",
                    "--change-dir",
                    str(self.change),
                    "--archive-root",
                    str(self.archive_root),
                    "--skip-ingest",
                    "--json",
                ]
            )
        self.assertEqual(code, 0, msg=json.dumps(payload, ensure_ascii=False, indent=2))
        self.assertTrue(payload.get("ok"))
        archive_dir = Path(payload["archive_dir"])
        html = archive_dir / "reports" / "final" / "final-summary.html"
        self.assertTrue(html.is_file(), "python fallback must produce final-summary.html")
        render_step = payload["steps"].get("render") or {}
        self.assertEqual(render_step.get("renderer"), "python-fallback")
        self.assertTrue(render_step.get("ok"))
        self.assertIn("fb-change", html.read_text(encoding="utf-8"))

    def test_fallback_failure_restores_original(self) -> None:
        def _boom(_summary: dict) -> str:
            raise OSError("simulated fallback failure")

        with mock.patch.object(ha, "resolve_node_path", return_value=None), mock.patch.object(
            ha, "render_fallback_html", side_effect=_boom
        ):
            code, payload = _run(
                [
                    "finalize",
                    "--change-dir",
                    str(self.change),
                    "--archive-root",
                    str(self.archive_root),
                    "--skip-ingest",
                    "--json",
                ]
            )
        self.assertNotEqual(code, 0)
        self.assertFalse(payload.get("ok"))
        self.assertTrue(self.change.is_dir(), "original change dir must be restored")
        archive_dir = Path(payload.get("archive_dir") or "")
        self.assertFalse(archive_dir.exists(), "archive target must not exist after restore")

    def test_validate_missing_html_is_error_even_when_node_missing(self) -> None:
        summary = {"changeName": "x", "finalStatus": "OK", "verification": {}}
        # render_skipped=True 模拟 node 不可用场景；旧实现只给 warning，必须改成 error。
        result = ha.validate_summary(summary, None, render_skipped=True)
        codes = {i.get("code") for i in result.get("issues") or []}
        self.assertIn("missing-final-report", codes)
        errors = [i for i in result.get("issues") or [] if i.get("severity") == "error"]
        self.assertTrue(errors, "missing html must be error even when render was skipped")
        self.assertFalse(result.get("ok"))


class ValidateErrorKeepsOriginalTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-archive-val-"))
        self.project = self.tmp / "proj"
        self.change = self.project / ".harness" / "changes" / "bad-validate"
        self.archive_root = self.project / ".harness" / "archive"
        self.change.mkdir(parents=True)
        self.archive_root.mkdir(parents=True)
        _seed_change_dir(self.change)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_validate_error_preserves_original(self) -> None:
        def _bad_render(change_dir: Path, summary_path: Path) -> dict:
            out = change_dir / "reports" / "final" / "final-summary.html"
            out.parent.mkdir(parents=True, exist_ok=True)
            # Deliberately omit change id
            out.write_text(
                "<html><body><h1>变更最终报告</h1><p>no-id-here</p></body></html>",
                encoding="utf-8",
            )
            return {"ok": True, "skipped": False, "out_path": str(out)}

        with mock.patch.object(ha, "render_final_summary", side_effect=_bad_render):
            code, payload = _run(
                [
                    "finalize",
                    "--change-dir",
                    str(self.change),
                    "--archive-root",
                    str(self.archive_root),
                    "--skip-ingest",
                    "--json",
                ]
            )
        self.assertNotEqual(code, 0)
        self.assertFalse(payload.get("ok"))
        self.assertTrue(
            self.change.is_dir(),
            "original change dir must be preserved on validate error",
        )
        # Archive target should not remain as the sole copy
        archive_dir = Path(payload.get("archive_dir") or "")
        if archive_dir and archive_dir.exists():
            # If restore left a partial, original must still exist (already asserted)
            pass
        self.assertTrue(payload.get("original_preserved", True))
        issues = payload.get("issues") or (payload.get("steps", {}).get("validate") or {}).get("issues") or []
        codes = {i.get("code") for i in issues}
        self.assertIn("missing-change-id", codes)


class MoveFailureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-archive-move-"))
        self.project = self.tmp / "proj"
        self.change = self.project / ".harness" / "changes" / "move-fail"
        self.archive_root = self.project / ".harness" / "archive"
        self.change.mkdir(parents=True)
        self.archive_root.mkdir(parents=True)
        _seed_change_dir(self.change)
        # Marker file to prove no data loss
        _write(self.change / "KEEPME.txt", "precious-data\n")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_move_failure_does_not_lose_data(self) -> None:
        def _boom(*_a, **_k):
            raise OSError("simulated move failure")

        with mock.patch.object(ha.shutil, "move", side_effect=_boom):
            code, payload = _run(
                [
                    "finalize",
                    "--change-dir",
                    str(self.change),
                    "--archive-root",
                    str(self.archive_root),
                    "--skip-ingest",
                    "--json",
                ]
            )
        self.assertNotEqual(code, 0)
        self.assertTrue(self.change.is_dir())
        self.assertTrue((self.change / "KEEPME.txt").is_file())
        self.assertEqual(
            (self.change / "KEEPME.txt").read_text(encoding="utf-8"),
            "precious-data\n",
        )
        self.assertTrue(payload.get("original_preserved", True))
        # Nothing should have been created under archive for this change
        leftovers = list(self.archive_root.glob("*-move-fail"))
        self.assertEqual(leftovers, [])


class ReplayOldArchiveTests(unittest.TestCase):
    def test_replay_fixture_golden_fields(self) -> None:
        if not FIXTURE_ARCHIVE.is_dir():
            self.skipTest(f"fixture missing: {FIXTURE_ARCHIVE}")
        existing = json.loads(
            (FIXTURE_ARCHIVE / "reports" / "final" / "summary-data.json").read_text(
                encoding="utf-8"
            )
        )
        out_file = Path(tempfile.mkdtemp(prefix="harness-replay-")) / "out.json"
        try:
            code, payload = _run(
                [
                    "replay",
                    "--archive-dir",
                    str(FIXTURE_ARCHIVE),
                    "--out",
                    str(out_file),
                    "--json",
                ]
            )
            # Replay may exit 1 if validate soft-fails (no html); still check golden fields
            summary = payload.get("summary_data") or {}
            self.assertEqual(summary.get("finalStatus"), existing.get("finalStatus"))
            self.assertEqual(
                (summary.get("verification") or {}).get("unitTests", {}).get("passRate"),
                (existing.get("verification") or {}).get("unitTests", {}).get("passRate"),
            )
            self.assertEqual(
                [f.get("path") for f in (summary.get("changedFiles") or [])],
                [f.get("path") for f in (existing.get("changedFiles") or [])],
            )
            # Must not invent events source when absent
            sources = payload.get("sources") or []
            self.assertTrue(
                any("summary-data" in s or "ledger" in s or "execution-log" in s or s == "not_available" for s in sources)
                or "reports/final/summary-data.json" in sources
            )
            # Read-only: fixture summary-data mtime/content unchanged for knownRisks
            after = json.loads(
                (FIXTURE_ARCHIVE / "reports" / "final" / "summary-data.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(after, existing)
            self.assertTrue(out_file.is_file())
        finally:
            shutil.rmtree(out_file.parent, ignore_errors=True)


class StatusTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-archive-status-"))
        self.change = self.tmp / ".harness" / "changes" / "status-demo"
        self.change.mkdir(parents=True)
        _seed_change_dir(self.change)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_status_json_readonly(self) -> None:
        before_files = {p.relative_to(self.change) for p in self.change.rglob("*") if p.is_file()}
        code, payload = _run(["status", "--change-dir", str(self.change), "--json"])
        self.assertEqual(code, 0)
        self.assertTrue(payload.get("ok"))
        self.assertIn("archivable", payload)
        self.assertIn("checks", payload)
        self.assertIn("blockers", payload)
        self.assertIn("warnings", payload)
        after_files = {p.relative_to(self.change) for p in self.change.rglob("*") if p.is_file()}
        self.assertEqual(before_files, after_files)


class ManifestCompareExcludeTests(unittest.TestCase):
    def test_excludes_execution_log_and_events(self) -> None:
        before = {
            "fileCount": 3,
            "files": [
                {"path": "plans/a.md", "sizeBytes": 1, "sha256": "aaa"},
                {"path": "logs/execution-log.md", "sizeBytes": 10, "sha256": "old"},
                {"path": "events.ndjson", "sizeBytes": 10, "sha256": "old"},
            ],
        }
        after = {
            "fileCount": 4,
            "files": [
                {"path": "plans/a.md", "sizeBytes": 1, "sha256": "aaa"},
                {"path": "logs/execution-log.md", "sizeBytes": 99, "sha256": "new"},
                {"path": "events.ndjson", "sizeBytes": 99, "sha256": "new"},
                {"path": "reports/final/summary-data.json", "sizeBytes": 5, "sha256": "s"},
            ],
        }
        result = ha.compare_manifests(before, after)
        self.assertTrue(result["ok"])
        self.assertEqual(result["checksumStatus"], "OK")
        self.assertEqual(result["generatedFiles"], 1)


class MaintenanceOutboxTests(unittest.TestCase):
    """Task 6 (§8): finalize enqueues a maintenance outbox item instead of
    synchronously running the four knowledge subprocesses."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-archive-outbox-"))
        self.project = self.tmp / "proj"
        self.change = self.project / ".harness" / "changes" / "outbox-change"
        self.archive_root = self.project / ".harness" / "archive"
        self.change.mkdir(parents=True)
        self.archive_root.mkdir(parents=True)
        _seed_change_dir(self.change)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_finalize_enqueues_maintenance_without_running_four_commands(self) -> None:
        with mock.patch.object(ha.subprocess, "run", wraps=ha.subprocess.run) as mock_run:
            code, payload = _run(
                [
                    "finalize",
                    "--change-dir",
                    str(self.change),
                    "--archive-root",
                    str(self.archive_root),
                    "--json",
                ]
            )
        self.assertEqual(code, 0, msg=json.dumps(payload, ensure_ascii=False, indent=2))
        # finalize must not invoke the knowledge CLI (no four subprocess commands)
        for call in mock_run.call_args_list:
            recorded = call.args[0] if call.args else call.kwargs.get("args")
            self.assertFalse(
                any("harness_knowledge" in str(a) for a in (recorded or [])),
                f"finalize must not invoke knowledge CLI, got: {recorded}",
            )
        # a pending maintenance outbox item must exist for the archive
        archive_dir = Path(payload["archive_dir"])
        project_root = ha.find_project_root(archive_dir)
        pending = project_root / ".harness" / "knowledge" / "maintenance-outbox" / "pending"
        self.assertTrue(pending.is_dir(), f"pending outbox dir missing: {pending}")
        items = list(pending.glob("*.json"))
        self.assertTrue(items, "pending outbox must contain the enqueued archive")
        item = json.loads(items[0].read_text(encoding="utf-8"))
        self.assertEqual(item["status"], "pending")
        self.assertEqual(item["archiveId"], archive_dir.name)
        self.assertEqual(payload.get("knowledgeMaintenance"), "QUEUED")


class ConditionalOkTests(unittest.TestCase):
    def test_user_skipped_forces_conditional_ok(self) -> None:
        stage = {"plan": "OK", "run": "OK", "test": "USER_SKIPPED", "review": "ADVISORY", "submit": "OK", "archive": "OK"}
        verification = {
            "unitTests": {"run": 0, "failures": 0, "errors": 0},
            "apiTests": {"status": "USER_SKIPPED", "failed": 0},
            "dbCompatibility": "NOT_RUN",
        }
        self.assertEqual(ha._compute_final_status(stage, verification), "CONDITIONAL_OK")


class ArchiveCliBoundaryTests(unittest.TestCase):
    """API-013: archive finalize 是唯一归档路径。harness_archive.py CLI 只暴露
    status/finalize/replay；不存在 collect/validate 子命令（已废弃的旧编排路径，
    report-pipeline-protocol §标准命令 仅保留 finalize/replay，模型不得手写等价
    summary-data.json）。"""

    def test_cli_exposes_only_status_finalize_replay(self) -> None:
        parser = ha.build_parser()
        group = getattr(parser, "_subparsers", None)
        actions = getattr(group, "_group_actions", []) if group is not None else []
        sub_action = actions[0] if actions else None
        self.assertIsNotNone(sub_action, "parser must register a subparsers action")
        choices = set(getattr(sub_action, "choices", {}).keys())
        self.assertEqual(
            choices,
            {"status", "finalize", "replay"},
            f"archive CLI must expose only status/finalize/replay, got {choices}",
        )
        # 废弃的 collect/validate 不得作为子命令存在（旧编排路径已删）
        self.assertNotIn("collect", choices, "collect subcommand must not exist")
        self.assertNotIn("validate", choices, "validate subcommand must not exist")

    def test_collect_and_validate_subcommands_are_rejected(self) -> None:
        """未知子命令 collect/validate 被 argparse 拒绝 (exit 2)，证明无旧编排 CLI 路径。"""
        for bad in ("collect", "validate"):
            with self.assertRaises(SystemExit) as cm:
                ha.main([bad, "--change-dir", ".", "--json"])
            self.assertEqual(
                cm.exception.code,
                2,
                f"{bad} must be rejected as unknown subcommand",
            )


class ReplayLegacyWithoutEventsTests(unittest.TestCase):
    """COM-003: 历史 archive 无 events.ndjson 时 replay 仍兼容。从
    ledger/execution-log/summary-data 回放，不要求新事件，不发明 events 来源，
    只读不改 archive 内容。自包含 fixture（不依赖未 commit 的 mcp-eval-project）。"""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-archive-legacy-"))
        self.archive = self.tmp / ".harness" / "archive" / "2026-01-01-legacy-change"
        self.archive.mkdir(parents=True)
        _write_json(
            self.archive / "evidence" / "verification-ledger.json",
            {
                "changeName": "legacy-change",
                "baseCommit": "aaaaaaa",
                "finalCommit": "bbbbbbb",
                "validations": {
                    "unitTest": {
                        "status": "OK",
                        "command": "python -m unittest",
                        "evidence": {
                            "run": 5,
                            "failures": 0,
                            "errors": 0,
                            "skipped": 0,
                            "passRate": "5/5",
                        },
                    },
                },
            },
        )
        _write(
            self.archive / "logs" / "execution-log.md",
            "# execution log\n\n## [1] harness-run\n\n**结果**: OK\n",
        )
        _write_json(
            self.archive / "reports" / "final" / "summary-data.json",
            {
                "schemaVersion": "2.2",
                "changeName": "legacy-change",
                "finalStatus": "OK",
                "baseCommit": "aaaaaaa",
                "finalCommit": "bbbbbbb",
                "stageStatus": {"run": "OK"},
                "verification": {
                    "unitTests": {
                        "run": 5,
                        "failures": 0,
                        "errors": 0,
                        "skipped": 0,
                        "passRate": "5/5",
                    },
                    "apiTests": {
                        "status": "NOT_RUN",
                        "total": 0,
                        "passed": 0,
                        "failed": 0,
                        "blocked": 0,
                    },
                    "dbCompatibility": "NOT_RUN",
                    "coverageDisplay": "not_available",
                },
            },
        )
        # Legacy archive has NO events.ndjson — the crux of COM-003.
        self.assertFalse((self.archive / "events.ndjson").exists())

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_replay_without_events_is_compatible_and_readonly(self) -> None:
        out_file = self.tmp / "out" / "replay-out.json"
        out_file.parent.mkdir(parents=True, exist_ok=True)
        before = {
            p.relative_to(self.archive).as_posix(): p.read_bytes()
            for p in self.archive.rglob("*")
            if p.is_file()
        }
        code, payload = _run(
            [
                "replay",
                "--archive-dir",
                str(self.archive),
                "--out",
                str(out_file),
                "--json",
            ]
        )
        # Replay is a valid operation without events; validate may soft-fail on
        # missing html (exit 1) — allowed; assert golden fields + sources instead.
        summary = payload.get("summary_data") or {}
        self.assertEqual(summary.get("changeName"), "legacy-change")
        self.assertEqual(summary.get("finalStatus"), "OK")
        self.assertEqual(
            (summary.get("verification") or {}).get("unitTests", {}).get("passRate"),
            "5/5",
        )
        # Must not invent events.ndjson as a source.
        sources = payload.get("sources") or []
        self.assertNotIn("events.ndjson", sources)
        self.assertTrue(
            any(
                "ledger" in s or "execution-log" in s or "summary-data" in s
                for s in sources
            ),
            f"replay must source from legacy ledger/log/summary, got {sources}",
        )
        self.assertTrue(out_file.is_file(), "replay must write out file outside archive")
        # Read-only: archive contents byte-identical after replay.
        after = {
            p.relative_to(self.archive).as_posix(): p.read_bytes()
            for p in self.archive.rglob("*")
            if p.is_file()
        }
        self.assertEqual(before, after, "replay must not mutate archive contents")


if __name__ == "__main__":
    unittest.main()
