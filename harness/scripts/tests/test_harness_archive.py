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


class ArchiveFactDerivationTests(unittest.TestCase):
    def test_business_goal_skips_frontmatter_and_generic_plan_title(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp)
            _write(
                change / "plans" / "demo-plan.md",
                "---\nchange-name: demo\nstatus: approved\n---\n\n"
                "# 任务计划 — demo\n\n> 变更范围：新增年度预算清算场景\n",
            )
            self.assertEqual(
                ha._business_goal_from_sources(change, []),
                "新增年度预算清算场景",
            )

    def test_final_commit_scope_keeps_all_task_commits_and_ignores_later_commits(self) -> None:
        import subprocess

        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            subprocess.run(["git", "init"], cwd=project, check=True, capture_output=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=project, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=project, check=True)
            _write(project / "base.txt", "base\n")
            subprocess.run(["git", "add", "base.txt"], cwd=project, check=True)
            subprocess.run(["git", "commit", "-m", "base"], cwd=project, check=True, capture_output=True)
            base = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=project, text=True).strip()
            _write(project / "feature.txt", "feature\n")
            subprocess.run(["git", "add", "feature.txt"], cwd=project, check=True)
            subprocess.run(["git", "commit", "-m", "feature-1"], cwd=project, check=True, capture_output=True)
            _write(project / "feature-2.txt", "feature 2\n")
            subprocess.run(["git", "add", "feature-2.txt"], cwd=project, check=True)
            subprocess.run(["git", "commit", "-m", "feature-2"], cwd=project, check=True, capture_output=True)
            feature = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=project, text=True).strip()
            _write(project / "unrelated.txt", "later\n")
            subprocess.run(["git", "add", "unrelated.txt"], cwd=project, check=True)
            subprocess.run(["git", "commit", "-m", "later"], cwd=project, check=True, capture_output=True)

            change = project / ".harness" / "changes" / "fact-demo"
            _write(change / "plans" / "fact-demo-plan.md", "# Plan\n\ngoal: isolate the task commit\n")
            _write_json(change / "evidence" / "verification-ledger.json", {
                "baseCommit": base,
                "finalCommit": feature,
                "validations": {
                    "unitTest": {"status": "OK", "testsRun": 27, "failures": 0, "errors": 0},
                    "apiTest": {"status": "BLOCKED", "blocked": 1},
                },
            })
            events = [
                {"schema_version": 3, "id": "1", "timestamp": "2026-07-15T10:00:00+08:00",
                 "phase": "test", "type": "phase.start", "attempt": 1, "executor_tool": "claude-code"},
                {"schema_version": 3, "id": "2", "timestamp": "2026-07-15T10:01:00+08:00",
                 "phase": "test", "type": "phase.end", "attempt": 1, "status": "BLOCKED"},
                {"schema_version": 3, "id": "3", "timestamp": "2026-07-15T10:02:00+08:00",
                 "phase": "submit", "type": "phase.start", "attempt": 1, "executor_tool": "codex",
                 "handoff_from_tool": "claude-code"},
                {"schema_version": 3, "id": "4", "timestamp": "2026-07-15T10:03:00+08:00",
                 "phase": "submit", "type": "phase.end", "attempt": 1, "status": "OK"},
            ]
            _write(
                change / "events.ndjson",
                "".join(json.dumps(event) + "\n" for event in events),
            )

            summary = ha.collect_summary_data(change, write=False)
            self.assertEqual(summary["finalCommit"], feature)
            self.assertEqual(summary["businessGoal"], "isolate the task commit")
            self.assertEqual(summary["diffStat"]["filesChanged"], 2)
            self.assertEqual(
                [item["path"] for item in summary["changedFiles"]],
                ["feature-2.txt", "feature.txt"],
            )
            self.assertEqual(summary["verification"]["unitTests"]["run"], 27)
            self.assertEqual(summary["stageStatus"]["test"], "BLOCKED")
            self.assertEqual(summary["finalStatus"], "CONDITIONAL_OK")
            self.assertEqual(summary["timeline"][1]["handoffFromTool"], "claude-code")

    def test_node_report_is_compact_utf8_and_keeps_full_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / ".harness" / "changes" / "report-demo"
            summary_path = change / "reports" / "final" / "summary-data.json"
            full_hash = "9d05b19a90f1e3cd1e13057bc12f3fead2c00659"
            _write_json(summary_path, {
                "schemaVersion": "2.2",
                "changeName": "report-demo",
                "businessGoal": "验证跨工具执行报告",
                "finalStatus": "CONDITIONAL_OK",
                "finalCommit": full_hash,
                "baseCommit": "a" * 40,
                "finalCommitBranch": "origin/main",
                "diffStat": {"filesChanged": 1, "insertions": 3, "deletions": 1, "range": "a..b"},
                "stageStatus": {"plan": "OK", "test": "BLOCKED"},
                "durations": {"totalLabel": "3 分钟", "totalMinutes": 3, "stages": []},
                "verification": {
                    "unitTests": {"status": "OK", "run": 2, "failures": 0, "errors": 0},
                    "apiTests": {"status": "BLOCKED", "total": 1, "passed": 0, "blocked": 1},
                    "dbCompatibility": "NOT_RUN",
                },
                "changedFiles": [{"path": "src/demo.ts", "insertions": 3, "deletions": 1}],
                "knownRisks": [{"message": "API 环境未启动"}],
                "manualActions": [{"action": "启动环境后补测"}],
                "timeline": [{"phase": "run", "attempt": 1, "status": "OK", "executorTool": "codex"}],
                "archiveManifest": {"checksumStatus": "OK", "totalArchiveFiles": 8},
                "reportPipeline": {
                    "sources": ["events.ndjson"],
                    "commands": [{"phase": "test", "command": "npm test", "exit_code": 0}],
                },
            })
            result = ha.render_final_summary(change, summary_path)
            self.assertTrue(result["ok"], msg=result)
            self.assertEqual(result["renderer"], "node", msg=result)
            html = Path(result["out_path"]).read_text(encoding="utf-8")
            self.assertIn("HARNESS EXECUTION REPORT", html)
            self.assertIn("执行时间线与工具交接", html)
            self.assertIn("<details>", html)
            self.assertIn(full_hash[:10], html)
            self.assertIn(full_hash, html)
            self.assertIn("npm test", html)
            self.assertNotIn("鍙", html)


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

    def test_status_archivable_when_final_hash_is_ancestor(self) -> None:
        # main advanced past the change's mergeFinalHash: the change's commit is
        # still pushed (ancestor of HEAD), so archivable must be True (multi-change
        # workflow where a later change merged on top).
        import os
        import subprocess

        project = self.tmp / "proj-anc"
        change = project / ".harness" / "changes" / "anc-change"
        change.mkdir(parents=True)
        _seed_change_dir(change)
        _write_json(change / "meta" / "worktree.json", {"requested": True, "created": True})
        subprocess.run(["git", "init", "-q"], cwd=str(project), check=True)
        _write(project / "f.txt", "1\n")
        subprocess.run(["git", "add", "-A"], cwd=str(project), check=True)
        env = {
            **os.environ,
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@t",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@t",
        }
        subprocess.run(["git", "commit", "-q", "-m", "change"], cwd=str(project), env=env, check=True)
        change_hash = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=str(project),
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        # advance main past the change commit
        _write(project / "f.txt", "2\n")
        subprocess.run(["git", "add", "-A"], cwd=str(project), check=True)
        subprocess.run(["git", "commit", "-q", "-m", "later"], cwd=str(project), env=env, check=True)
        # set mergeFinalHash to the (now ancestor) change commit
        ledger = change / "evidence" / "verification-ledger.json"
        data = json.loads(ledger.read_text(encoding="utf-8"))
        data["mergeFinalHash"] = change_hash
        ledger.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        code, payload = _run(["status", "--change-dir", str(change), "--json"])
        self.assertEqual(code, 0, msg=json.dumps(payload, ensure_ascii=False))
        self.assertTrue(payload["archivable"], msg=json.dumps(payload, ensure_ascii=False))
        self.assertEqual(payload["blockers"], [])
        self.assertTrue(payload["checks"].get("final_hash_ancestor"))


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
        status, reasons = ha._compute_final_status(stage, verification)
        self.assertEqual(status, "CONDITIONAL_OK")
        self.assertTrue(reasons)


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


class ReviewDetectionTests(unittest.TestCase):
    """UT-042: execution-log mention of harness-review must not imply review ran."""

    def setUp(self) -> None:
        self.change_dir = Path(tempfile.mkdtemp(prefix="archive-review-"))
        self.addCleanup(lambda: shutil.rmtree(self.change_dir, ignore_errors=True))

    def test_log_mention_without_events_is_not_review_ran(self) -> None:
        _write(
            self.change_dir / "logs" / "execution-log.md",
            "# log\n\nNext step: run harness-review after tests.\n",
        )
        events: list[dict] = []
        self.assertFalse(ha.review_evidence_present(self.change_dir, events))
        summary = ha._review_summary(self.change_dir, None, events)
        self.assertEqual(summary["status"], "ADVISORY_NOT_RUN")

    def test_review_phase_end_event_counts_as_review_ran(self) -> None:
        events = [
            {
                "schema_version": 3,
                "id": "evt-1",
                "timestamp": "2026-07-16T12:00:00+08:00",
                "phase": "review",
                "type": "phase.end",
                "status": "OK",
            }
        ]
        self.assertTrue(ha.review_phase_completed(events))
        self.assertTrue(ha.review_evidence_present(self.change_dir, events))


class LedgerCountFallbackTests(unittest.TestCase):
    """UT-104..109: metrics → evidence dict → text regex → api-test-results."""

    def test_ut104_metrics_preferred_over_text_evidence(self) -> None:
        ledger = {
            "validations": {
                "unitTest": {
                    "status": "OK",
                    "metrics": {"run": 155, "failures": 0, "errors": 0, "skipped": 0},
                    "evidence": "Tests run: 1, Failures: 1, Errors: 0, Skipped: 0",
                }
            }
        }
        result = ha._ledger_unit_tests(ledger)
        self.assertEqual(result["run"], 155)
        self.assertEqual(result["failures"], 0)
        self.assertEqual(result["source"], "committed")
        self.assertEqual(result["passRate"], "100%")

    def test_ut105_unit_text_regex_fallback(self) -> None:
        ledger = {
            "validations": {
                "unitTest": {
                    "status": "OK",
                    "evidence": "Tests run: 155, Failures: 0, Errors: 0, Skipped: 0",
                }
            }
        }
        result = ha._ledger_unit_tests(ledger)
        self.assertEqual(result["run"], 155)
        self.assertEqual(result["passRate"], "100%")
        self.assertEqual(result["source"], "evidence-text")

    def test_ut106_multi_segment_takes_last_match(self) -> None:
        ledger = {
            "validations": {
                "unitTest": {
                    "status": "OK",
                    "evidence": (
                        "module A: Tests run: 10, Failures: 1, Errors: 0, Skipped: 0\n"
                        "aggregate: Tests run: 155, Failures: 0, Errors: 0, Skipped: 0"
                    ),
                }
            }
        }
        result = ha._ledger_unit_tests(ledger)
        self.assertEqual(result["run"], 155)
        self.assertEqual(result["failures"], 0)
        self.assertEqual(result["source"], "evidence-text")

    def test_ut107_api_text_passed_fallback(self) -> None:
        ledger = {
            "validations": {
                "apiTest": {
                    "status": "OK",
                    "evidence": "API 3/3 passed",
                }
            }
        }
        result = ha._ledger_api_tests(ledger)
        self.assertEqual(result["total"], 3)
        self.assertEqual(result["passed"], 3)
        self.assertEqual(result["status"], "OK")
        self.assertEqual(result["source"], "evidence-text")

    def test_ut108_api_test_results_json_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp)
            runtime = change / "runtime"
            runtime.mkdir()
            _write_json(
                runtime / "api-test-results.json",
                {"total": 3, "passed": 3, "failed": 0, "blocked": 0},
            )
            ledger = {
                "validations": {
                    "apiTest": {
                        "status": "OK",
                        "evidence": "api done",
                    }
                }
            }
            result = ha._ledger_api_tests(ledger, change_dir=change)
            self.assertEqual(result["total"], 3)
            self.assertEqual(result["passed"], 3)
            self.assertEqual(result["source"], "api-test-results")

    def test_ut109_all_fallbacks_fail_returns_empty(self) -> None:
        ledger = {
            "validations": {
                "unitTest": {"status": "OK", "evidence": "no counts here"},
                "apiTest": {"status": "OK", "evidence": "no counts"},
            }
        }
        unit = ha._ledger_unit_tests(ledger)
        api = ha._ledger_api_tests(ledger)
        self.assertEqual(unit["run"], 0)
        self.assertEqual(unit["passRate"], ha.NOT_AVAILABLE)
        self.assertEqual(api["total"], 0)
        self.assertEqual(api["passRate"], ha.NOT_AVAILABLE)


class FinalStatusReasonsTests(unittest.TestCase):
    """UT-110..111: finalStatusReasons."""

    def test_ut110_db_not_run_reasons(self) -> None:
        status, reasons = ha._compute_final_status(
            {"plan": "OK", "run": "OK", "test": "OK", "review": "OK", "submit": "OK", "archive": "OK"},
            {
                "unitTests": {"run": 10, "failures": 0, "errors": 0},
                "apiTests": {"status": "OK", "failed": 0},
                "dbCompatibility": "NOT_RUN",
            },
        )
        self.assertEqual(status, "CONDITIONAL_OK")
        self.assertIn("dbCompatibility=NOT_RUN", reasons)

    def test_ut111_all_green_empty_reasons(self) -> None:
        status, reasons = ha._compute_final_status(
            {"plan": "OK", "run": "OK", "test": "OK", "review": "OK", "submit": "OK", "archive": "OK"},
            {
                "unitTests": {"run": 10, "failures": 0, "errors": 0},
                "apiTests": {"status": "OK", "failed": 0, "total": 1, "passed": 1},
                "dbCompatibility": "OK",
            },
        )
        self.assertEqual(status, "OK")
        self.assertEqual(reasons, [])


class KnownRisksFilterTests(unittest.TestCase):
    """UT-112..113: knownRisks severity filter + missing-risk."""

    def test_ut112_severity_filter_to_known_risks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "risk-filter"
            change.mkdir()
            _seed_change_dir(change)
            he.main(
                [
                    "--json",
                    "append",
                    "--change-dir",
                    str(change),
                    "--phase",
                    "run",
                    "--type",
                    "issue",
                    "--code",
                    "warn-x",
                    "--severity",
                    "warning",
                    "--message",
                    "real warning risk",
                ]
            )
            he.main(
                [
                    "--json",
                    "append",
                    "--change-dir",
                    str(change),
                    "--phase",
                    "run",
                    "--type",
                    "issue",
                    "--code",
                    "info-note",
                    "--message",
                    "knowledge query result not a risk",
                ]
            )
            summary = ha.collect_summary_data(change, write=False)
            risk_msgs = [r.get("message") for r in summary.get("knownRisks") or []]
            self.assertIn("real warning risk", risk_msgs)
            self.assertNotIn("knowledge query result not a risk", risk_msgs)
            notes = " ".join(summary.get("maintenanceNotes") or [])
            self.assertIn("knowledge query result not a risk", notes)

    def test_ut113_missing_risk_ignores_no_severity_issue(self) -> None:
        summary = {
            "changeName": "x",
            "finalStatus": "OK",
            "verification": {"unitTests": {}, "apiTests": {}},
            "knownRisks": [],
            "archiveManifest": {"totalArchiveFiles": 1},
            "reportPipeline": {"commands": []},
        }
        with tempfile.TemporaryDirectory() as tmp:
            html = Path(tmp) / "final-summary.html"
            html.write_text(
                "<html>x OK 1</html>",
                encoding="utf-8",
            )
            result = ha.validate_summary(summary, html)
            codes = {i.get("code") for i in result.get("issues") or []}
            self.assertNotIn("missing-risk", codes)


class CleanupTransientTests(unittest.TestCase):
    """UT-114..116: pre-manifest cleanup."""

    def test_ut114_cleanup_deletes_transients(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "events.ndjson.lock").write_text("lock", encoding="utf-8")
            runtime = root / "runtime"
            runtime.mkdir()
            (runtime / "svc.pid").write_text("1", encoding="utf-8")
            (runtime / "_harness_service_launcher.py").write_text("x", encoding="utf-8")
            (runtime / "credential-cache.json").write_text("{}", encoding="utf-8")
            keep = root / "plans" / "p.md"
            keep.parent.mkdir()
            keep.write_text("keep", encoding="utf-8")
            result = ha._cleanup_transients(root)
            deleted = set(result.get("deleted") or [])
            self.assertTrue(any("events.ndjson.lock" in d for d in deleted))
            self.assertTrue(any(d.endswith(".pid") or "svc.pid" in d for d in deleted))
            self.assertTrue(any("launcher" in d for d in deleted))
            self.assertTrue(any("credential-cache" in d for d in deleted))
            self.assertFalse((root / "events.ndjson.lock").exists())
            self.assertFalse((runtime / "credential-cache.json").exists())
            self.assertTrue(keep.is_file())

    def test_ut115_cleanup_truncates_large_log(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            log_dir = root / "logs"
            log_dir.mkdir()
            big = log_dir / "service-start.log"
            big.write_bytes(b"x" * 100_000)
            result = ha._cleanup_transients(root)
            truncated = result.get("truncated") or []
            self.assertTrue(truncated)
            text = big.read_text(encoding="utf-8", errors="replace")
            self.assertTrue(text.startswith("# [truncated by harness-archive finalize:"))
            self.assertLessEqual(big.stat().st_size, 65536 + 200)

    def test_ut116_cleanup_noop_on_clean_tree(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "plans").mkdir()
            result = ha._cleanup_transients(root)
            self.assertEqual(result.get("deleted") or [], [])
            self.assertEqual(result.get("truncated") or [], [])


class GatePolicyConsumeTests(unittest.TestCase):
    """UT-117..119: meta/gate-policy.json consumption."""

    def test_ut117_full_tier_missing_review_is_blocker(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "gp-full"
            change.mkdir()
            _seed_change_dir(change)
            # remove review report so review evidence is absent
            for p in (change / "reports" / "review").glob("*.md"):
                p.unlink()
            _write_json(
                change / "meta" / "gate-policy.json",
                {
                    "schemaVersion": 1,
                    "tier": "full",
                    "defaultPhases": ["plan", "run", "test", "review", "submit", "archive"],
                    "requiredValidations": ["compile", "unitTest", "unitTestFull", "apiTest"],
                    "classifiedAt": "2026-07-16T00:00:00+08:00",
                    "source": "default-full",
                    "tierOverride": None,
                },
            )
            result = ha.check_status(change)
            codes = {b.get("code") for b in result.get("blockers") or []}
            self.assertIn("review-required-on-full-tier", codes)
            self.assertFalse(result.get("archivable"))

    def test_ut118_allow_missing_review_downgrades(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "gp-allow"
            change.mkdir()
            _seed_change_dir(change)
            for p in (change / "reports" / "review").glob("*.md"):
                p.unlink()
            _write_json(
                change / "meta" / "gate-policy.json",
                {
                    "schemaVersion": 1,
                    "tier": "full",
                    "defaultPhases": ["plan", "run", "test", "review", "submit", "archive"],
                    "requiredValidations": ["compile"],
                    "classifiedAt": "2026-07-16T00:00:00+08:00",
                    "source": "default-full",
                    "tierOverride": None,
                },
            )
            result = ha.check_status(change, allow_missing_review=True)
            codes = {b.get("code") for b in result.get("blockers") or []}
            self.assertNotIn("review-required-on-full-tier", codes)
            warn_codes = {w.get("code") for w in result.get("warnings") or []}
            self.assertIn("review-required-on-full-tier", warn_codes)

    def test_ut119_missing_gate_policy_keeps_legacy(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "gp-none"
            change.mkdir()
            _seed_change_dir(change)
            for p in (change / "reports" / "review").glob("*.md"):
                p.unlink()
            result = ha.check_status(change)
            codes = {b.get("code") for b in result.get("blockers") or []}
            self.assertNotIn("review-required-on-full-tier", codes)
            summary = ha.collect_summary_data(change, write=False)
            self.assertEqual(summary.get("riskTier"), "unknown")


class ArchiveMetaAndPipelineTests(unittest.TestCase):
    """UT-120 + INT-101..103 style finalize assertions."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-archive-pipe-"))
        self.project = self.tmp / "proj"
        self.change = self.project / ".harness" / "changes" / "pipe-change"
        self.archive_root = self.project / ".harness" / "archive"
        self.change.mkdir(parents=True)
        self.archive_root.mkdir(parents=True)
        _seed_change_dir(self.change)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_ut120_archive_meta_matches_final_status(self) -> None:
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
        archive_dir = Path(payload["archive_dir"])
        meta = archive_dir / "meta" / "archive-meta.md"
        self.assertTrue(meta.is_file())
        text = meta.read_text(encoding="utf-8")
        summary = json.loads(
            (archive_dir / "reports" / "final" / "summary-data.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertIn(f"final-status: {summary['finalStatus']}", text)
        after = json.loads(
            (archive_dir / "evidence" / "archive-manifest-after.json").read_text(
                encoding="utf-8"
            )
        )
        paths = {f["path"] for f in after.get("files") or []}
        self.assertIn("meta/archive-meta.md", paths)

    def test_int101_finalize_counts_cleanup_archive_duration(self) -> None:
        # text-only unit counts + api-test-results + junk files
        _write_json(
            self.change / "evidence" / "verification-ledger.json",
            {
                "changeName": self.change.name,
                "baseCommit": "aaaaaaaa",
                "finalCommit": "bbbbbbbb",
                "validations": {
                    "unitTest": {
                        "status": "OK",
                        "command": "python -m unittest",
                        "evidence": "Tests run: 155, Failures: 0, Errors: 0, Skipped: 0",
                    },
                    "apiTest": {
                        "status": "OK",
                        "evidence": "api finished",
                    },
                    "dbCompatibility": {"status": "OK"},
                },
            },
        )
        runtime = self.change / "runtime"
        runtime.mkdir(exist_ok=True)
        _write_json(
            runtime / "api-test-results.json",
            {"total": 3, "passed": 3, "failed": 0, "blocked": 0},
        )
        (runtime / "credential-cache.json").write_text('{"token":"x"}', encoding="utf-8")
        (self.change / "events.ndjson.lock").write_text("l", encoding="utf-8")
        logs = self.change / "logs"
        logs.mkdir(exist_ok=True)
        (logs / "service-start.log").write_bytes(b"y" * 100_000)

        import time

        time.sleep(0.05)
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
        archive_dir = Path(payload["archive_dir"])
        summary = json.loads(
            (archive_dir / "reports" / "final" / "summary-data.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(summary["verification"]["unitTests"]["run"], 155)
        self.assertEqual(summary["verification"]["apiTests"]["total"], 3)
        self.assertEqual(summary["verification"]["apiTests"]["passed"], 3)
        archive_status = (summary.get("stageStatus") or {}).get("archive")
        self.assertNotEqual(archive_status, "UNKNOWN")
        stages = (summary.get("durations") or {}).get("stages") or []
        archive_stage = next((s for s in stages if s.get("stage") == "archive"), None)
        self.assertIsNotNone(archive_stage)
        # duration may be 0 minutes if very fast; durationMs via timeline preferred
        timeline = summary.get("timeline") or []
        archive_tl = [
            t
            for t in timeline
            if t.get("phase") == "archive" and t.get("durationMs") is not None
        ]
        if archive_tl:
            self.assertGreater(archive_tl[-1]["durationMs"], 0)
        self.assertTrue((archive_dir / "meta" / "archive-meta.md").is_file())
        self.assertFalse((archive_dir / "runtime" / "credential-cache.json").exists())
        self.assertFalse((archive_dir / "events.ndjson.lock").exists())
        cleanup = (payload.get("steps") or {}).get("cleanup") or {}
        self.assertTrue(cleanup.get("deleted"))
        html = (archive_dir / "reports" / "final" / "final-summary.html").read_text(
            encoding="utf-8"
        )
        self.assertIn("155", html)
        self.assertTrue("3/3" in html or "3" in html)

    def test_int102_python_fallback_includes_reasons(self) -> None:
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
        self.assertEqual(code, 0, msg=payload)
        archive_dir = Path(payload["archive_dir"])
        html = (archive_dir / "reports" / "final" / "final-summary.html").read_text(
            encoding="utf-8"
        )
        self.assertIn("finalStatusReasons", html)
        self.assertTrue(archive_dir.is_dir())

    def test_int103_patch_failure_keeps_archive(self) -> None:
        with mock.patch.object(
            ha, "_patch_archive_stage", side_effect=OSError("simulated patch fail")
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
        self.assertEqual(code, 0, msg=payload)
        self.assertTrue(payload.get("ok"))
        warnings = payload.get("warnings") or []
        self.assertTrue(any("patch" in str(w).lower() for w in warnings))
        self.assertTrue(Path(payload["archive_dir"]).is_dir())


class ComEvidenceDictRegressionTests(unittest.TestCase):
    """COM-101: evidence dict counts still work."""

    def test_com101_evidence_dict_counts(self) -> None:
        ledger = {
            "validations": {
                "unitTest": {
                    "status": "OK",
                    "evidence": {
                        "run": 42,
                        "failures": 0,
                        "errors": 0,
                        "skipped": 1,
                        "passRate": "41/42",
                    },
                }
            }
        }
        result = ha._ledger_unit_tests(ledger)
        self.assertEqual(result["run"], 42)
        self.assertEqual(result["skipped"], 1)


class ComArchiveMetaReplayReadonlyTests(unittest.TestCase):
    """COM-102: replay must not write or overwrite meta/archive-meta.md."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-archive-com102-"))
        self.archive = self.tmp / ".harness" / "archive" / "2026-01-01-com102"
        self.archive.mkdir(parents=True)
        _write_json(
            self.archive / "evidence" / "verification-ledger.json",
            {
                "changeName": "com102",
                "baseCommit": "aaaaaaa",
                "finalCommit": "bbbbbbb",
                "validations": {
                    "unitTest": {
                        "status": "OK",
                        "evidence": {
                            "run": 2,
                            "failures": 0,
                            "errors": 0,
                            "skipped": 0,
                            "passRate": "2/2",
                        },
                    },
                },
            },
        )
        _write_json(
            self.archive / "reports" / "final" / "summary-data.json",
            {
                "schemaVersion": "2.2",
                "changeName": "com102",
                "finalStatus": "OK",
                "baseCommit": "aaaaaaa",
                "finalCommit": "bbbbbbb",
                "stageStatus": {"run": "OK", "archive": "OK"},
                "verification": {
                    "unitTests": {
                        "run": 2,
                        "failures": 0,
                        "errors": 0,
                        "skipped": 0,
                        "passRate": "2/2",
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
        self.meta = self.archive / "meta" / "archive-meta.md"
        self.meta_marker = (
            "---\narchive-id: COM102-MARKER\nfinal-status: OK\n"
            "source: pre-existing\n---\n# COM-102 fixture meta\n"
        )
        _write(self.meta, self.meta_marker)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_com102_replay_does_not_overwrite_archive_meta(self) -> None:
        out_file = self.tmp / "out" / "replay-out.json"
        out_file.parent.mkdir(parents=True, exist_ok=True)
        before_bytes = self.meta.read_bytes()
        before_mtime = self.meta.stat().st_mtime_ns

        _run(
            [
                "replay",
                "--archive-dir",
                str(self.archive),
                "--out",
                str(out_file),
                "--json",
            ]
        )

        self.assertTrue(self.meta.is_file(), "replay must not delete archive-meta.md")
        self.assertEqual(
            self.meta.read_bytes(),
            before_bytes,
            "replay must not overwrite existing meta/archive-meta.md",
        )
        self.assertEqual(self.meta.read_text(encoding="utf-8"), self.meta_marker)
        self.assertEqual(
            self.meta.stat().st_mtime_ns,
            before_mtime,
            "replay must not touch archive-meta.md mtime",
        )
        # Also: no new archive-meta if we had deleted it — recreate without meta
        self.meta.unlink()
        self.assertFalse(self.meta.exists())
        _run(
            [
                "replay",
                "--archive-dir",
                str(self.archive),
                "--out",
                str(out_file),
                "--json",
            ]
        )
        self.assertFalse(
            self.meta.exists(),
            "replay must not create meta/archive-meta.md when absent",
        )


class PatchArchiveStageUnitTests(unittest.TestCase):
    """Direct unit coverage for _patch_archive_stage replace vs append."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-patch-stage-"))
        self.work = self.tmp / "change"
        self.work.mkdir()
        (self.work / "reports" / "final").mkdir(parents=True)
        (self.work / "meta").mkdir(parents=True)
        # phase.start → phase.end so build_summary yields archive duration/status
        ha.append_event(
            self.work,
            phase="archive",
            type_="phase.start",
            note="patch unit start",
        )
        import time

        time.sleep(0.02)
        ha.append_event(
            self.work,
            phase="archive",
            type_="phase.end",
            status="OK",
            note="patch unit end",
        )
        self.summary_path = self.work / "reports" / "final" / "summary-data.json"

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _base_summary(self, *, stages: list[dict]) -> dict:
        return {
            "schemaVersion": "2.2",
            "changeName": "patch-stage",
            "finalStatus": "OK",
            "stageStatus": {"run": "OK"},
            "durations": {"stages": stages, "totalMinutes": 0, "totalLabel": "约 0 分"},
            "timeline": [],
            "skillCalls": [],
            "verification": {
                "unitTests": {
                    "run": 0,
                    "failures": 0,
                    "errors": 0,
                    "skipped": 0,
                    "passRate": "not_available",
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
        }

    def test_patch_replaces_existing_archive_stage(self) -> None:
        _write_json(
            self.summary_path,
            self._base_summary(
                stages=[
                    {
                        "stage": "archive",
                        "skill": "harness-archive",
                        "startedAt": "old",
                        "endedAt": "old",
                        "minutes": 99,
                        "result": "UNKNOWN",
                        "attempts": [],
                    },
                    {
                        "stage": "run",
                        "skill": "harness-run",
                        "minutes": 1,
                        "result": "OK",
                    },
                ]
            ),
        )
        with mock.patch.object(ha, "render_final_summary") as render_mock:
            ha._patch_archive_stage(self.summary_path, self.work, render=False)
            render_mock.assert_not_called()

        summary = json.loads(self.summary_path.read_text(encoding="utf-8"))
        stages = (summary.get("durations") or {}).get("stages") or []
        archive_stages = [s for s in stages if s.get("stage") == "archive"]
        self.assertEqual(len(archive_stages), 1, "must replace, not duplicate")
        self.assertNotEqual(archive_stages[0].get("startedAt"), "old")
        self.assertEqual(archive_stages[0].get("result"), "OK")
        self.assertEqual((summary.get("stageStatus") or {}).get("archive"), "OK")
        # non-archive stage preserved
        self.assertTrue(any(s.get("stage") == "run" for s in stages))

    def test_patch_appends_archive_stage_when_missing(self) -> None:
        _write_json(
            self.summary_path,
            self._base_summary(
                stages=[
                    {
                        "stage": "run",
                        "skill": "harness-run",
                        "minutes": 1,
                        "result": "OK",
                    }
                ]
            ),
        )
        with mock.patch.object(ha, "render_final_summary") as render_mock:
            ha._patch_archive_stage(self.summary_path, self.work, render=True)
            render_mock.assert_called_once_with(self.work, self.summary_path)

        summary = json.loads(self.summary_path.read_text(encoding="utf-8"))
        stages = (summary.get("durations") or {}).get("stages") or []
        archive_stages = [s for s in stages if s.get("stage") == "archive"]
        self.assertEqual(len(archive_stages), 1)
        self.assertEqual(archive_stages[0].get("skill"), "harness-archive")
        self.assertEqual(archive_stages[0].get("result"), "OK")
        self.assertEqual((summary.get("stageStatus") or {}).get("archive"), "OK")
        self.assertEqual(len(stages), 2)


if __name__ == "__main__":
    unittest.main()
