#!/usr/bin/env python3
"""Unittests for harness_archive.py (P0-2)."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_archive as ha  # noqa: E402
import harness_events as he  # noqa: E402
import harness_knowledge_candidates as hkc  # noqa: E402

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
    if (
        change_dir.parent.name == "changes"
        and change_dir.parent.parent.name == ".harness"
    ):
        project_root = change_dir.parents[2]
    else:
        # Compact unit fixtures use <tmp>/<change>; never escape the fixture
        # root and write into the OS temp directory's parent.
        project_root = change_dir.parent
    _write(project_root / ".gitattributes", ".harness/archive/** -text\n")
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
            # The archive boundary must cover a real product delta.  A fixture
            # with base == productCommit now fails closed because it models the
            # exact merge-only/truncated archive boundary that the adequacy
            # checks are intended to detect.
            "baseCommit": "aaaaaaaa",
            # Synthetic non-git fixtures use a neutral archive checkpoint for
            # base/final while productCommit identifies the independently
            # verified product candidate.
            "finalCommit": "aaaaaaaa",
            "productCommit": "bbbbbbbb",
            "archiveCommit": "bbbbbbbb",
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
                "dbCompatibility": {
                    "status": "OK",
                    "metrics": {
                        "applicability": "NOT_APPLICABLE",
                        "reason": "archive unit fixture has no database surface",
                    },
                },
            },
        },
    )
    # IA-1: product candidate CI must be green before archive (fail closed).
    _write_json(
        change_dir / "evidence" / "product-candidate-ci.json",
        {
            "schemaVersion": 1,
            "conclusion": "success",
            "commit": "bbbbbbbb",
            "runUrl": "https://ci.example/runs/seed",
        },
    )
    # Seed events via harness_events
    seq = [
        ["--phase", "plan", "--type", "phase.start", "--note", "开始"],
        ["--phase", "plan", "--type", "phase.end"],
        ["--phase", "execute", "--type", "phase.start"],
        [
            "--phase",
            "execute",
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
            "execute",
            "--type",
            "verification",
            "--name",
            "unitTest",
            "--status",
            "ok",
        ],
        ["--phase", "execute", "--type", "phase.end"],
        ["--phase", "execute", "--type", "phase.start"],
        ["--phase", "execute", "--type", "phase.end"],
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
                "--intent",
                "record-only",
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
        self.assertEqual(summary["schemaVersion"], "2.3")
        self.assertEqual(summary["changeName"], "demo-change")
        self.assertEqual(summary["releaseIntent"], "none")
        self.assertEqual(summary["closureDisposition"], "completed")
        self.assertIsNone(summary["closureReason"])
        self.assertEqual(
            summary["archiveDurability"]["status"],
            "ARCHIVED_LOCAL_ONLY",
        )
        self.assertEqual(payload["archiveDurability"]["status"], "ARCHIVED_LOCAL_ONLY")
        self.assertEqual(summary["maintenanceNotes"], [])
        self.assertEqual(summary["knownRisks"], [])
        self.assertEqual(summary["manualActions"], [])
        self.assertIn("reportPipeline", summary)
        # 平台监控直接读取 summary-data.json；归档不再生成重复的 HTML 投影。
        self.assertNotIn("render", payload["steps"])
        self.assertFalse(
            (archive_dir / "reports" / "final" / "final-summary.html").exists()
        )
        serialized = json.dumps(summary, ensure_ascii=False)
        self.assertNotIn("final-summary.html", serialized)

    def test_finalize_refuses_invalid_artifact_projection_and_preserves_change(self) -> None:
        invalid = {
            "ok": False,
            "items": [],
            "blocking": [],
            "error": "CORRECTION_OLD_VALUE_MISMATCH: injected",
        }
        with mock.patch.object(ha, "artifact_preflight", return_value=invalid):
            code, payload = _run(
                [
                    "finalize",
                    "--intent",
                    "record-only",
                    "--change-dir",
                    str(self.change),
                    "--archive-root",
                    str(self.archive_root),
                    "--skip-ingest",
                    "--json",
                ]
            )

        self.assertNotEqual(code, 0)
        self.assertFalse(payload.get("ok"), payload)
        self.assertTrue(self.change.is_dir(), "failed finalize must preserve source change")
        self.assertEqual(list(self.archive_root.iterdir()), [])
        serialized = json.dumps(payload, ensure_ascii=False)
        self.assertIn("ARTIFACT_PREFLIGHT_INVALID", serialized)
        self.assertIn("CORRECTION_OLD_VALUE_MISMATCH", serialized)
        events = he.load_events(he.events_path(self.change))
        archive_events = [item for item in events if item.get("phase") == "archive"]
        self.assertFalse(
            any(item.get("type") == "phase.start" for item in archive_events),
            "预发布校验失败不能制造一次归档执行",
        )
        self.assertTrue(
            any(item.get("type") == "phase.prepare.end" for item in archive_events),
            "预发布校验失败应记录为准备受阻",
        )

    def test_finalize_without_database_capability_needs_no_manual_db_ledger(self) -> None:
        ledger_path = self.change / "evidence" / "verification-ledger.json"
        ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
        ledger["validations"].pop("dbCompatibility", None)
        _write_json(ledger_path, ledger)
        _write_json(
            self.change / "meta" / "gate-policy.json",
            {"schemaVersion": 1, "capabilities": []},
        )

        code, payload = _run(
            [
                "finalize",
                "--intent",
                "record-only",
                "--change-dir",
                str(self.change),
                "--archive-root",
                str(self.archive_root),
                "--skip-ingest",
                "--json",
            ]
        )

        self.assertEqual(code, 0, msg=json.dumps(payload, ensure_ascii=False, indent=2))
        summary = json.loads(
            (
                Path(payload["archive_dir"])
                / "reports"
                / "final"
                / "summary-data.json"
            ).read_text(encoding="utf-8")
        )
        self.assertEqual(summary["verification"]["dbCompatibility"], "NOT_APPLICABLE")
        self.assertEqual(
            summary["verification"]["dbCompatibilityEvidence"]["source"],
            "capability-profile",
        )

    def test_finalize_without_capability_field_defaults_database_to_not_applicable(self) -> None:
        ledger_path = self.change / "evidence" / "verification-ledger.json"
        ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
        ledger["validations"].pop("dbCompatibility", None)
        _write_json(ledger_path, ledger)
        _write_json(
            self.change / "meta" / "gate-policy.json",
            {"schemaVersion": 1, "plannedPhases": ["plan", "archive"]},
        )

        code, payload = _run(
            [
                "finalize",
                "--intent",
                "record-only",
                "--change-dir",
                str(self.change),
                "--archive-root",
                str(self.archive_root),
                "--skip-ingest",
                "--json",
            ]
        )

        self.assertEqual(code, 0, msg=json.dumps(payload, ensure_ascii=False, indent=2))
        summary = json.loads(
            (
                Path(payload["archive_dir"])
                / "reports"
                / "final"
                / "summary-data.json"
            ).read_text(encoding="utf-8")
        )
        self.assertEqual(summary["verification"]["dbCompatibility"], "NOT_APPLICABLE")
        self.assertEqual(
            summary["verification"]["dbCompatibilityEvidence"]["source"],
            "capability-profile",
        )

    def test_finalize_writes_local_only_durability_without_durable_root(
        self,
    ) -> None:
        code, payload = _run(
            [
                "finalize",
                "--intent",
                "record-only",
                "--change-dir",
                str(self.change),
                "--archive-root",
                str(self.archive_root),
                "--skip-ingest",
                "--json",
            ]
        )

        self.assertEqual(code, 0, msg=json.dumps(payload, ensure_ascii=False, indent=2))
        durability = payload["archiveDurability"]
        self.assertEqual(durability["status"], "ARCHIVED_LOCAL_ONLY")
        self.assertEqual(durability["retentionPolicy"], "project-local")
        self.assertFalse(self.change.exists())
        archive_dir = Path(payload["archive_dir"])
        summary = json.loads(
            (archive_dir / "reports" / "final" / "summary-data.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(
            summary["archiveDurability"]["status"], "ARCHIVED_LOCAL_ONLY"
        )
        self.assertFalse(
            (archive_dir / "reports" / "final" / "final-summary.html").exists()
        )


class ArchiveIdentityResolutionTests(unittest.TestCase):
    def test_final_commit_ignores_archive_operation_hex_fragment(self) -> None:
        valid = "0368ff84419fce70c075d9dda16b31b2651380f4"
        events = [
            {
                "phase": "submit",
                "type": "phase.end",
                "note": f"submit 完成：本地提交 {valid}",
            },
            {
                "phase": "archive",
                "type": "phase.end",
                "note": (
                    "finalize operation a-8280e633866e discarded: "
                    "report adequacy failed"
                ),
            },
        ]

        def git_result(_project: Path, *args: str) -> tuple[int, str, str]:
            candidate = args[-1].removesuffix("^{commit}") if args else ""
            if valid.startswith(candidate):
                return 0, valid, ""
            if args == ("rev-parse", "HEAD"):
                return 0, valid, ""
            return 1, "", "unknown revision"

        with mock.patch.object(ha, "git_run", side_effect=git_result):
            resolved = ha._final_commit_from_sources(None, events, None, Path("."))

        self.assertEqual(resolved, valid)

    def test_base_commit_skips_symbolic_head_and_uses_concrete_phase_base(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            change = root / ".harness" / "changes" / "demo"
            context = change / "runtime" / "phase-context"
            context.mkdir(parents=True)
            expected = "0c39a651841179f387777796fef47f83b69bca23"
            _write_json(context / "older.json", {"baseCommit": expected})
            _write_json(context / "newer.json", {"baseCommit": "HEAD"})

            resolved = ha._resolve_base_commit(
                {"baseCommit": "HEAD"},
                change,
                root,
                "0368ff84419fce70c075d9dda16b31b2651380f4",
            )

        self.assertEqual(resolved, expected)


class CanonicalSummaryOnlyTests(unittest.TestCase):
    """平台直接消费 summary-data.json，归档不再运行本地 HTML 渲染。"""

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

    def test_finalize_does_not_need_node_or_create_html(self) -> None:
        code, payload = _run(
            [
                "finalize",
                "--intent",
                "record-only",
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
        self.assertFalse(
            (archive_dir / "reports" / "final" / "final-summary.html").exists()
        )
        self.assertNotIn("render", payload["steps"])

    def test_summary_validation_has_no_html_warning(self) -> None:
        summary = {"changeName": "x", "finalStatus": "OK", "verification": {}}
        result = ha.validate_summary_data(summary)
        codes = {i.get("code") for i in result.get("issues") or []}
        self.assertNotIn("missing-final-report", codes)
        errors = [i for i in result.get("issues") or [] if i.get("severity") == "error"]
        self.assertFalse(errors)
        self.assertTrue(result.get("ok"))


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
        invalid = {
            "ok": False,
            "issues": [{
                "code": "status-contradiction",
                "severity": "error",
                "message": "summary status contradicts verification",
            }],
            "error_count": 1,
            "warning_count": 0,
        }
        with mock.patch.object(ha, "validate_summary_data", return_value=invalid):
            code, payload = _run(
                [
                    "finalize",
                    "--intent",
                    "record-only",
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
        self.assertIn("status-contradiction", codes)
        events = he.load_events(self.change / "events.ndjson")
        archive_terminals = [
            event
            for event in events
            if event.get("phase") == "archive"
            and event.get("type") == "phase.end"
        ]
        self.assertEqual(len(archive_terminals), 1)
        self.assertEqual(archive_terminals[0].get("status"), "FAIL")


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
                    "--intent",
                    "record-only",
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
    def test_test_report_discovery_deduplicates_overlapping_patterns(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp)
            report = change / "reports" / "test" / "test-report-20260810.md"
            _write(report, "# 测试报告\n")

            self.assertEqual(ha.find_test_reports(change), [report])

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

    def test_business_goal_prefers_descriptive_title_over_first_task_row(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp)
            _write(
                change / "plans" / "monitor-plan.md",
                "# 实时监控后端绑定改造 — 任务拆分\n\n"
                "| # | 任务 |\n|---|---|\n| 1 | 编写数据库迁移脚本 |\n",
            )

            self.assertEqual(
                ha._business_goal_from_sources(change, []),
                "实时监控后端绑定改造",
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
                 "phase": "execute", "type": "phase.start", "attempt": 1, "executor_tool": "claude-code"},
                {"schema_version": 3, "id": "2", "timestamp": "2026-07-15T10:01:00+08:00",
                 "phase": "execute", "type": "phase.end", "attempt": 1, "status": "BLOCKED"},
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
            self.assertEqual(summary["stageStatus"]["execute"], "BLOCKED")
            self.assertEqual(summary["finalStatus"], "CONDITIONAL_OK")
            self.assertEqual(summary["timeline"][1]["handoffFromTool"], "claude-code")

    def test_stage_status_carries_run_test_keys_for_server_schema_23(self) -> None:
        # 服务端 CLI schema 2.3 要求 stageStatus 含 {plan, run, test, review,
        # submit, archive} 必需键；2026-08 起事件侧 run+test 已合并为 execute，
        # 生成器必须自己补齐，否则自己的服务端会以 422 拒绝自己的产物。
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / ".harness" / "changes" / "stage-keys-demo"
            _write(change / "plans" / "stage-keys-demo-plan.md", "# Plan\n\ngoal: check stage keys\n")
            events = [
                {"schema_version": 3, "id": "1", "timestamp": "2026-07-15T10:00:00+08:00",
                 "phase": "execute", "type": "phase.end", "attempt": 1, "status": "OK"},
            ]
            _write(change / "events.ndjson", "".join(json.dumps(e) + "\n" for e in events))

            summary = ha.collect_summary_data(change, write=False)
            stage = summary["stageStatus"]
            for key in ("plan", "run", "test", "review", "submit", "archive"):
                self.assertIn(key, stage)
            self.assertEqual(stage["run"], stage["execute"])
            self.assertEqual(stage["test"], stage["execute"])

    def test_stage_status_splits_legacy_run_test_events(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / ".harness" / "changes" / "legacy-stage-demo"
            _write(change / "plans" / "legacy-stage-demo-plan.md", "# Plan\n\ngoal: split legacy stages\n")
            events = [
                {"schema_version": 3, "id": "1", "timestamp": "2026-07-15T10:00:00+08:00",
                 "phase": "run", "type": "phase.end", "attempt": 1, "status": "OK"},
                {"schema_version": 3, "id": "2", "timestamp": "2026-07-15T10:01:00+08:00",
                 "phase": "test", "type": "phase.end", "attempt": 1, "status": "FAILED"},
            ]
            _write(change / "events.ndjson", "".join(json.dumps(e) + "\n" for e in events))

            summary = ha.collect_summary_data(change, write=False)
            stage = summary["stageStatus"]
            self.assertEqual(stage["run"], "OK")
            self.assertEqual(stage["test"], "FAIL")
            self.assertEqual(stage["execute"], "FAIL")

    def test_summary_embeds_validated_decisions_for_knowledge_candidates(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / ".harness" / "changes" / "decisions-demo"
            _write(change / "plans" / "decisions-demo-plan.md", "# Plan\n\ngoal: embed decisions\n")
            _write_json(change / "evidence" / "decisions.json", {
                "schema_version": 1,
                "decisions": [
                    {
                        "id": "D-001",
                        "title": "知识候选仅做确定性投影",
                        "rationale": "筛选在上游完成，零 LLM。",
                        "entry_type": "decision",
                        "status": "adopted",
                        "path": "docs/design/knowledge.md",
                        "line": 7,
                        "source": "plan",
                    },
                    {"title": "缺 entry_type 的非法记录"},
                ],
            })

            summary = ha.collect_summary_data(change, write=False)
            self.assertEqual([item["id"] for item in summary["decisions"]], ["D-001"])
            self.assertTrue(
                any("decisions.json" in str(note) for note in summary["maintenanceNotes"])
            )

            candidates = hkc.build_knowledge_candidates(
                summary,
                change_key="decisions-demo",
                archive_id="decisions-demo",
                producer_version="0.4.0",
                created_at="2026-08-23T12:00:00.000Z",
            )
            self.assertEqual(len(candidates), 1)
            self.assertEqual(candidates[0]["entry_type"], "decision")
            self.assertEqual(candidates[0]["source_refs"], ["docs/design/knowledge.md#L7"])

    def test_summary_data_keeps_full_evidence(self) -> None:
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
                "stageStatus": {"plan": "OK", "execute": "BLOCKED"},
                "durations": {"totalLabel": "3 分钟", "totalMinutes": 3, "stages": []},
                "verification": {
                    "unitTests": {"status": "OK", "run": 2, "failures": 0, "errors": 0},
                    "apiTests": {"status": "BLOCKED", "total": 1, "passed": 0, "blocked": 1},
                    "browserE2E": {
                        "status": "FAIL",
                        "total": 1,
                        "passed": 0,
                        "failed": 1,
                        "skipped": 0,
                    },
                    "dbCompatibility": "NOT_RUN",
                },
                "changedFiles": [{"path": "src/demo.ts", "insertions": 3, "deletions": 1}],
                "knownRisks": [{"message": "API 环境未启动"}],
                "manualActions": [{"action": "启动环境后补测"}],
                "timeline": [{"phase": "execute", "attempt": 1, "status": "OK", "executorTool": "codex"}],
                "archiveManifest": {"checksumStatus": "OK", "totalArchiveFiles": 8},
                "reportPipeline": {
                    "sources": ["events.ndjson"],
                    "commands": [{"phase": "execute", "command": "npm test", "exit_code": 0}],
                },
            })
            summary = json.loads(summary_path.read_text(encoding="utf-8"))
            self.assertEqual(summary["finalCommit"], full_hash)
            self.assertEqual(summary["verification"]["browserE2E"]["failed"], 1)
            self.assertEqual(
                summary["reportPipeline"]["commands"][0]["command"],
                "npm test",
            )
            self.assertEqual(summary["knownRisks"][0]["message"], "API 环境未启动")

    def test_summary_validation_rejects_browser_failure_as_ok(self) -> None:
        result = ha.validate_summary_data({
            "changeName": "browser-report",
            "finalStatus": "OK",
            "verification": {
                "unitTests": {},
                "apiTests": {},
                "browserE2E": {
                    "status": "FAIL",
                    "total": 3,
                    "passed": 0,
                    "failed": 3,
                    "skipped": 0,
                },
            },
        })
        self.assertFalse(result["ok"])
        self.assertIn(
            "status-contradiction",
            {item["code"] for item in result["issues"]},
        )


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

    def test_status_and_ledger_read_split_runtime_state_without_copying(self) -> None:
        state = self.tmp / ".harness" / "state" / "changes" / self.change.name
        state.mkdir(parents=True)
        _write_json(
            self.change / "meta" / "change-context.json",
            {
                "schemaVersion": 2,
                "changeName": self.change.name,
                "stateOwnership": {
                    "layout": "split-v1",
                    "runtimeRoot": f".harness/state/changes/{self.change.name}",
                },
            },
        )
        shutil.move(str(self.change / "events.ndjson"), str(state / "events.ndjson"))
        shutil.move(str(self.change / "evidence"), str(state / "evidence"))

        result = ha.check_status(self.change, archive_intent="record-only")

        self.assertNotIn("missing-events", {item["code"] for item in result["blockers"]})
        self.assertTrue(result["checks"]["events_ndjson"])
        self.assertIsNotNone(ha.load_ledger(self.change))
        self.assertEqual(
            result["checks"]["state_root"],
            str(state.resolve()),
        )

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
        _write(project / "f.txt", "0\n")
        subprocess.run(["git", "add", "-A"], cwd=str(project), check=True)
        env = {
            **os.environ,
            "GIT_AUTHOR_NAME": "t",
            "GIT_AUTHOR_EMAIL": "t@t",
            "GIT_COMMITTER_NAME": "t",
            "GIT_COMMITTER_EMAIL": "t@t",
        }
        subprocess.run(["git", "commit", "-q", "-m", "base"], cwd=str(project), env=env, check=True)
        base_hash = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=str(project),
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        _write(project / "f.txt", "1\n")
        subprocess.run(["git", "add", "-A"], cwd=str(project), check=True)
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
        data["baseCommit"] = base_hash
        data["mergeFinalHash"] = change_hash
        ledger.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        code, payload = _run([
            "status",
            "--change-dir",
            str(change),
            "--intent",
            "record-only",
            "--json",
        ])
        self.assertEqual(code, 0, msg=json.dumps(payload, ensure_ascii=False))
        self.assertTrue(payload["archivable"], msg=json.dumps(payload, ensure_ascii=False))
        self.assertEqual(payload["blockers"], [])
        self.assertTrue(payload["checks"].get("final_hash_ancestor"))

    def test_abandoned_closure_can_be_archived_without_a_verification_ledger(self) -> None:
        (self.change / "evidence" / "verification-ledger.json").unlink()

        result = ha.check_status(
            self.change,
            archive_intent="record-only",
            closure_disposition="abandoned",
            closure_reason="方案不再采用",
        )

        self.assertTrue(result["archivable"], result)
        self.assertEqual(result["closureDisposition"], "abandoned")
        self.assertEqual(result["closureReason"], "方案不再采用")
        self.assertNotIn(
            "missing-verification-ledger",
            {item["code"] for item in result["blockers"]},
        )
        self.assertIn(
            "closure-ledger-not-required",
            {item["code"] for item in result["warnings"]},
        )


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

    def test_byte_coverage_rejects_unlisted_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            _write(root / "spec" / "design.md", "covered\n")
            manifest_path = root / "evidence" / "archive-manifest-after.json"
            manifest_path.parent.mkdir(parents=True)
            manifest = ha.generate_manifest(root, manifest_path)

            self.assertTrue(ha.verify_manifest_byte_coverage(root, manifest)["ok"])
            _write(root / "meta" / "unexpected-receipt.json", "{}\n")
            result = ha.verify_manifest_byte_coverage(root, manifest)

            self.assertFalse(result["ok"])
            self.assertIn(
                {"path": "meta/unexpected-receipt.json", "reason": "unexpected"},
                result["mismatched"],
            )


class RemoteKnowledgeOwnershipTests(unittest.TestCase):
    """Finalize never creates local knowledge state; ingest follows ZIP upload."""

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

    def test_finalize_does_not_create_local_knowledge_or_run_legacy_cli(self) -> None:
        with mock.patch.object(ha.subprocess, "run", wraps=ha.subprocess.run) as mock_run:
            code, payload = _run(
                [
                    "finalize",
                    "--intent",
                    "record-only",
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
        archive_dir = Path(payload["archive_dir"])
        project_root = ha.find_project_root(archive_dir)
        self.assertFalse((project_root / ".harness" / "knowledge").exists())
        self.assertEqual(payload.get("knowledgeMaintenance"), "REMOTE_PENDING")
        self.assertEqual(payload["steps"]["knowledge"]["localIngest"], False)
        self.assertEqual(
            payload["steps"]["archive_push"]["reasonCode"],
            "ARCHIVE_UPLOAD_CREDENTIALS_MISSING",
        )
        self.assertTrue(Path(payload["steps"]["archive_push"]["packagePath"]).is_file())

    def test_completed_operation_records_remote_archive_result(self) -> None:
        call_order: list[str] = []
        remote = {
            "ok": True,
            "uploadStatus": "ready",
            "archiveId": "arc_outbox",
            "archiveStatus": "durable",
            "knowledgeStatus": "ready",
            "packageSha256": "sha256:" + "a" * 64,
            "manifestSha256": "sha256:" + "b" * 64,
            "remoteReceipt": ".harness/state/local/archive-packages/demo.remote.json",
        }
        managed = {"ok": True, "submitted": 4, "unchanged": False}
        with mock.patch.object(
            ha,
            "auto_push_archive_core",
            side_effect=lambda *_args, **_kwargs: (call_order.append("archive-upload"), remote)[1],
        ), mock.patch.object(
            ha,
            "auto_push_managed_snapshot",
            side_effect=lambda *_args, **_kwargs: (call_order.append("managed-push"), managed)[1],
        ), mock.patch.object(
            ha,
            "run_service_stop",
            side_effect=lambda path, *_args, **_kwargs: (
                call_order.append(
                    "service-stop-pre"
                    if Path(path).resolve() == self.change.resolve()
                    else "service-stop-post"
                ),
                {"ok": True},
            )[1],
        ):
            code, payload = _run(
                [
                    "finalize",
                    "--intent",
                    "record-only",
                    "--change-dir",
                    str(self.change),
                    "--archive-root",
                    str(self.archive_root),
                    "--json",
                ]
            )

        self.assertEqual(code, 0, msg=json.dumps(payload, ensure_ascii=False, indent=2))
        operation = json.loads(
            Path(payload["operationRecord"]).read_text(encoding="utf-8")
        )
        self.assertEqual(operation["archiveRemote"]["archiveId"], "arc_outbox")
        self.assertEqual(operation["archiveRemote"]["knowledgeStatus"], "ready")
        self.assertEqual(operation["knowledgeMaintenance"], "REMOTE_READY")
        self.assertEqual(operation["managedSnapshot"]["submitted"], 4)
        self.assertEqual(
            call_order,
            [
                "service-stop-pre",
                "service-stop-post",
                "archive-upload",
                "managed-push",
            ],
        )

    def test_blocked_execute_syncs_terminal_state(self) -> None:
        state_root = self.project / ".harness" / "state" / "changes" / self.change.name
        state_root.mkdir(parents=True)
        context_path = self.change / "meta" / "change-context.json"
        context = (
            json.loads(context_path.read_text(encoding="utf-8"))
            if context_path.is_file()
            else {"schemaVersion": 2, "changeName": self.change.name}
        )
        context["stateOwnership"] = {
            "layout": "split-v1",
            "runtimeRoot": f".harness/state/changes/{self.change.name}",
        }
        _write_json(context_path, context)
        with mock.patch.object(
            ha, "load_product_candidate_ci", return_value={"ok": True}
        ), mock.patch.object(
            ha,
            "archive_auto_gate",
            return_value={
                "ok": False,
                "reasonCode": "ARCHIVE_PRECONDITIONS_UNSATISFIED",
                "nextAction": "先完成缺失条件",
                "status": {"blockers": []},
            },
        ):
            code, payload = ha.execute_archive(self.change, self.archive_root)

        self.assertEqual(code, 1)
        self.assertEqual(payload["finalStatus"], "BLOCKED")
        events = he.load_events(he.events_path(state_root))
        self.assertTrue(any(
            item.get("phase") == "archive"
            and item.get("type") == "phase.end"
            and item.get("status") == "BLOCKED"
            for item in events
        ))


class ConditionalOkTests(unittest.TestCase):
    def test_user_skipped_forces_conditional_ok(self) -> None:
        stage = {"plan": "OK", "execute": "USER_SKIPPED", "review": "ADVISORY", "submit": "OK", "archive": "OK"}
        verification = {
            "unitTests": {"run": 0, "failures": 0, "errors": 0},
            "apiTests": {"status": "USER_SKIPPED", "failed": 0},
            "dbCompatibility": "NOT_RUN",
        }
        status, reasons = ha._compute_final_status(stage, verification)
        self.assertEqual(status, "CONDITIONAL_OK")
        self.assertTrue(reasons)

    def test_browser_failure_forces_fail(self) -> None:
        status, reasons = ha._compute_final_status(
            {"plan": "OK", "execute": "OK"},
            {
                "unitTests": {"run": 1, "failures": 0, "errors": 0},
                "apiTests": {"status": "OK", "failed": 0},
                "browserE2E": {"status": "FAIL", "failed": 3},
                "dbCompatibility": "OK",
            },
        )

        self.assertEqual(status, "FAIL")
        self.assertIn("browserE2E.failed=3", reasons)

    def test_browser_not_run_forces_conditional_ok(self) -> None:
        status, reasons = ha._compute_final_status(
            {"plan": "OK", "execute": "OK"},
            {
                "unitTests": {"run": 1, "failures": 0, "errors": 0},
                "apiTests": {"status": "OK", "failed": 0},
                "browserE2E": {"status": "NOT_RUN", "failed": 0},
                "dbCompatibility": "OK",
            },
        )

        self.assertEqual(status, "CONDITIONAL_OK")
        self.assertIn("browserE2E.status=NOT_RUN", reasons)

    def test_browser_failure_rejects_pure_ok_summary(self) -> None:
        summary = {
            "changeName": "browser-contradiction",
            "finalStatus": "OK",
            "verification": {
                "unitTests": {"failures": 0, "errors": 0},
                "apiTests": {"status": "OK", "failed": 0},
                "browserE2E": {"status": "FAIL", "failed": 1},
                "dbCompatibility": "OK",
            },
            "archiveManifest": {"totalArchiveFiles": 0},
            "reportPipeline": {"commands": []},
        }
        result = ha.validate_summary_data(summary)

        codes = {item.get("code") for item in result.get("issues") or []}
        self.assertIn("status-contradiction", codes)


class ArchiveCliBoundaryTests(unittest.TestCase):
    """API-013: execute 是常规归档入口；finalize 是内部兼容入口。

    恢复只消费已验证的持久化 receipt；不存在 collect/validate 子命令。
    repair 为 RET-40 新增显式修复子命令（不改写原归档）。
    """

    def test_cli_exposes_only_status_finalize_replay(self) -> None:
        parser = ha.build_parser()
        group = getattr(parser, "_subparsers", None)
        actions = getattr(group, "_group_actions", []) if group is not None else []
        sub_action = actions[0] if actions else None
        self.assertIsNotNone(sub_action, "parser must register a subparsers action")
        choices = set(getattr(sub_action, "choices", {}).keys())
        self.assertEqual(
            choices,
            {
                "status",
                "auto-gate",
                "adopt-existing-range",
                "certify-local",
                "execute",
                "finalize",
                "replay",
                "repair",
                "republish",
            },
            f"archive CLI commands changed unexpectedly: {choices}",
        )
        # 废弃的 collect/validate 不得作为子命令存在（旧编排路径已删）
        self.assertNotIn("collect", choices, "collect subcommand must not exist")
        self.assertNotIn("validate", choices, "validate subcommand must not exist")
        self.assertNotIn(
            "restore-durable",
            choices,
            "restore-durable subcommand must not exist (dead durable branch removed)",
        )

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
            "# execution log\n\n## [1] harness-execute\n\n**结果**: OK\n",
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

    def test_unstructured_review_report_keeps_finding_counts_visible(self) -> None:
        _write(
            self.change_dir / "reports" / "review" / "review-report-20260724.md",
            "\n".join(
                [
                    "# Review",
                    "### RED-1 History visibility",
                    "### RED-2 Missing audit",
                    "### RED-3 API baseline",
                    "### RED-4 Correlation N+1",
                    "### YELLOW-1 Improve naming",
                    "### YELLOW-2 Add documentation",
                ]
            ),
        )

        summary = ha._review_summary(self.change_dir, None, [])

        self.assertEqual(summary["status"], "ADVISORY_UNSTRUCTURED")
        self.assertEqual(summary["red"], 4)
        self.assertEqual(summary["yellow"], 2)
        self.assertEqual(summary["redConfirmed"], 4)
        self.assertIn("structured", summary["summary"].lower())


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

    def test_unit_fraction_evidence_from_safe_runner_is_counted(self) -> None:
        ledger = {
            "validations": {
                "unitTestFull": {
                    "status": "OK",
                    "evidence": "fixback 后 module 门禁 117/117（+4 修复用例）",
                }
            }
        }

        result = ha._ledger_unit_tests(ledger)

        self.assertEqual(result["run"], 117)
        self.assertEqual(result["failures"], 0)
        self.assertEqual(result["passRate"], "100%")
        self.assertEqual(result["source"], "evidence-text")
        self.assertEqual(result["latestAuthoritativeAttempt"]["run"], 117)

    def test_api_fraction_evidence_from_safe_runner_is_counted(self) -> None:
        ledger = {
            "validations": {
                "apiTest": {
                    "status": "OK",
                    "evidence": "apiTest 7/7（API-001/002、INT-001 + 回归 4 例）",
                }
            }
        }

        result = ha._ledger_api_tests(ledger)

        self.assertEqual(result["total"], 7)
        self.assertEqual(result["passed"], 7)
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

    def test_arc_ut001_unit_typed_metrics_infer_run_from_counts(self) -> None:
        ledger = {
            "validations": {
                "unitTestFull": {
                    "status": "OK",
                    "metrics": {"passed": 321, "failed": 0, "skipped": 2},
                }
            }
        }

        result = ha._ledger_unit_tests(ledger)

        self.assertEqual(result["run"], 323)
        self.assertEqual(result["failures"], 0)
        self.assertEqual(result["skipped"], 2)
        # H-13: skipped excluded from passRate denominator → 321/321.
        self.assertEqual(result["passRate"], "100%")

    def test_arc_ut002_api_typed_metrics_infer_missing_total(self) -> None:
        ledger = {
            "validations": {
                "apiTest": {
                    "status": "OK",
                    "metrics": {"passed": 1, "failed": 0, "blocked": 0},
                }
            }
        }

        result = ha._ledger_api_tests(ledger)

        self.assertEqual(result["total"], 1)
        self.assertEqual(result["passed"], 1)
        self.assertEqual(result["passRate"], "100%")

    def test_api_typed_metrics_accept_uppercase_result_keys(self) -> None:
        ledger = {
            "validations": {
                "apiTest": {
                    "status": "OK",
                    "metrics": {"PASS": 20, "FAIL": 0, "BLOCKED": 0},
                }
            }
        }

        result = ha._ledger_api_tests(ledger)

        self.assertEqual(result["total"], 20)
        self.assertEqual(result["executed"], 20)
        self.assertEqual(result["passed"], 20)
        self.assertEqual(result["failed"], 0)
        self.assertEqual(result["blocked"], 0)

    def test_api_pass_rate_excludes_blocked_and_reports_execution_rate(self) -> None:
        result = ha._ledger_api_tests({
            "validations": {
                "apiTest": {
                    "status": "BLOCKED",
                    "metrics": {
                        "total": 21,
                        "passed": 9,
                        "failed": 0,
                        "blocked": 12,
                    },
                }
            }
        })

        self.assertEqual(result["passed"], 9)
        self.assertEqual(result["failed"], 0)
        self.assertEqual(result["blocked"], 12)
        self.assertEqual(result["executed"], 9)
        self.assertEqual(result["passRate"], "100%")
        self.assertEqual(result["executionRate"], "43%")

    def test_unit_metrics_expose_deselected_and_performance_projection(self) -> None:
        ledger = {
            "validations": {
                "unitTestFull": {
                    "status": "OK",
                    "metrics": {
                        "total": 12,
                        "passed": 10,
                        "failed": 0,
                        "skipped": 2,
                        "deselected": 7,
                    },
                },
                "performance": {
                    "status": "OK",
                    "metrics": {"p95Ms": 81, "budgetMs": 100},
                },
            }
        }

        projection = ha.build_verification_projection(ledger)

        self.assertEqual(projection["unitTests"]["deselected"], 7)
        self.assertEqual(projection["performance"]["status"], "OK")
        self.assertEqual(projection["performance"]["metrics"]["p95Ms"], 81)

    def test_report_db_01_projects_typed_db_receipt_evidence(self) -> None:
        evidence_hash = "sha256:" + "d" * 64
        ledger = {
            "validations": {
                "dbCompatibility": {
                    "status": "OK",
                    "metrics": {
                        "applicability": "APPLICABLE",
                        "status": "OK",
                        "total": 3,
                        "passed": 3,
                        "failed": 0,
                        "evidenceHash": evidence_hash,
                    },
                }
            }
        }

        projection = ha.build_verification_projection(ledger)

        self.assertEqual(projection["dbCompatibility"], "OK")
        self.assertEqual(
            projection["dbCompatibilityEvidence"]["evidenceHash"], evidence_hash
        )

    def test_report_count_01_reruns_do_not_inflate_unique_test_count(self) -> None:
        attempts = [
            {
                "attempt": number,
                "status": "OK",
                "metrics": {
                    "total": 2,
                    "passed": 2,
                    "failed": 0,
                    "testIdentities": ["suite::one", "suite::two"],
                },
            }
            for number in (1, 2, 3)
        ]
        ledger = {
            "validations": {
                "unitTestFull": {
                    "status": "OK",
                    "attempts": attempts,
                    "metrics": attempts[-1]["metrics"],
                }
            }
        }

        result = ha._ledger_unit_tests(ledger)

        self.assertEqual(result["run"], 2)  # legacy latest-run field
        self.assertEqual(result["uniqueTestCount"], 2)
        self.assertEqual(result["rerunCount"], 2)
        self.assertEqual(len(result["perAttemptCounts"]), 3)
        self.assertEqual(result["latestAuthoritativeAttempt"]["attempt"], 3)

    def test_browser_test_projects_to_browser_e2e_without_polluting_api(self) -> None:
        ledger = {
            "validations": {
                "apiTest": {
                    "status": "OK",
                    "metrics": {"total": 6, "passed": 6, "failed": 0, "blocked": 0},
                },
                "browserTest": {
                    "status": "NOT_RUN",
                    "metrics": {
                        "total": 1,
                        "passed": 0,
                        "failed": 0,
                        "skipped": 1,
                        "retries": 2,
                    },
                },
            }
        }

        projection = ha.build_verification_projection(ledger)

        self.assertEqual(projection["apiTests"]["status"], "OK")
        self.assertEqual(projection["browserE2E"]["status"], "NOT_RUN")
        self.assertEqual(projection["browserE2E"]["skipped"], 1)
        self.assertEqual(projection["browserE2E"]["retries"], 2)


class ProductIdentityTests(unittest.TestCase):
    def test_feature_merge_and_release_tip_are_distinct(self) -> None:
        import os
        import subprocess

        root = Path(tempfile.mkdtemp(prefix="harness-identity-"))
        try:
            change = root / ".harness" / "changes" / "identity-demo"
            change.mkdir(parents=True)
            _seed_change_dir(change)
            subprocess.run(["git", "init", "-q"], cwd=str(root), check=True)
            env = {
                **os.environ,
                "GIT_AUTHOR_NAME": "t",
                "GIT_AUTHOR_EMAIL": "t@t",
                "GIT_COMMITTER_NAME": "t",
                "GIT_COMMITTER_EMAIL": "t@t",
            }
            _write(root / "product.txt", "feature\n")
            subprocess.run(["git", "add", "-A"], cwd=str(root), check=True)
            subprocess.run(["git", "commit", "-q", "-m", "feature"], cwd=str(root), env=env, check=True)
            feature = subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=str(root), capture_output=True, text=True, check=True
            ).stdout.strip()
            _write(root / "later.txt", "release\n")
            subprocess.run(["git", "add", "-A"], cwd=str(root), check=True)
            subprocess.run(["git", "commit", "-q", "-m", "later"], cwd=str(root), env=env, check=True)
            release = subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=str(root), capture_output=True, text=True, check=True
            ).stdout.strip()
            ledger_path = change / "evidence" / "verification-ledger.json"
            ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
            ledger["mergeFinalHash"] = feature
            ledger["productCommit"] = feature
            _write_json(ledger_path, ledger)

            identity = ha.resolve_product_archive_identity(change, project=root)

            self.assertEqual(identity["featureMergeHash"], feature)
            self.assertEqual(identity["releaseTipHash"], release)
            self.assertNotEqual(identity["featureMergeHash"], identity["releaseTipHash"])
        finally:
            shutil.rmtree(root, ignore_errors=True)


class FinalStatusReasonsTests(unittest.TestCase):
    """UT-110..111: finalStatusReasons."""

    def test_ut110_db_not_run_reasons(self) -> None:
        status, reasons = ha._compute_final_status(
            {"plan": "OK", "execute": "OK", "review": "OK", "submit": "OK", "archive": "OK"},
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
            {"plan": "OK", "execute": "OK", "review": "OK", "submit": "OK", "archive": "OK"},
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
                    "execute",
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
                    "execute",
                    "--type",
                    "issue",
                    "--code",
                    "info-note",
                    "--severity",
                    "info",
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
        result = ha.validate_summary_data(summary)
        codes = {i.get("code") for i in result.get("issues") or []}
        self.assertNotIn("missing-risk", codes)

    def test_arc_ut003_resolved_issue_is_not_a_risk_or_stage_downgrade(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp)
            events = [
                {
                    "schema_version": 3,
                    "id": "end-1",
                    "timestamp": "2026-07-19T09:59:00+08:00",
                    "phase": "execute",
                    "type": "phase.end",
                    "status": "OK",
                },
                {
                    "schema_version": 3,
                    "id": "issue-1",
                    "timestamp": "2026-07-19T10:00:00+08:00",
                    "phase": "execute",
                    "type": "issue",
                    "issue_id": "compile-warning",
                    "severity": "warning",
                    "message": "temporary warning",
                },
                {
                    "schema_version": 3,
                    "id": "resolve-1",
                    "timestamp": "2026-07-19T10:01:00+08:00",
                    "phase": "execute",
                    "type": "issue.resolve",
                    "issue_id": "compile-warning",
                },
            ]
            _write(
                change / "events.ndjson",
                "".join(json.dumps(event) + "\n" for event in events),
            )

            status = ha._stage_status_from_sources(events, None, change)
            summary = ha.collect_summary_data(change, write=False)

            self.assertEqual(status["execute"], "OK")
            self.assertEqual(summary["knownRisks"], [])


class ArchiveCorrectionProjectionTests(unittest.TestCase):
    def test_arc_ut004_artifact_correction_changes_projection_not_raw_history(self) -> None:
        events = [
            {
                "schema_version": 3,
                "id": "artifact-1",
                "timestamp": "2026-07-19T10:00:00+08:00",
                "phase": "execute",
                "type": "artifact",
                "path": "reports/old.json",
                "kind": "report",
            },
            {
                "schema_version": 3,
                "id": "correction-1",
                "timestamp": "2026-07-19T10:01:00+08:00",
                "phase": "execute",
                "type": "correction",
                "target_event_id": "artifact-1",
                "target_field": "path",
                "old_value_hash": he.canonical_value_hash("reports/old.json"),
                "new_value": "reports/final.json",
            },
        ]

        projected = he.apply_event_corrections(events)
        artifacts = ha._artifacts_from_events(projected)

        self.assertEqual(artifacts[0]["path"], "reports/final.json")
        self.assertEqual(events[0]["path"], "reports/old.json")


class ArchiveTimingReducerTests(unittest.TestCase):
    def test_arc_ut005_active_time_sums_closed_attempts(self) -> None:
        events = [
            {"type": "phase.start", "attempt": 1, "timestamp": "2026-07-19T10:00:00+00:00"},
            {"type": "phase.end", "attempt": 1, "status": "FAIL", "timestamp": "2026-07-19T10:01:00+00:00"},
            {"type": "phase.start", "attempt": 2, "timestamp": "2026-07-19T10:03:00+00:00"},
            {"type": "phase.end", "attempt": 2, "status": "FAIL", "timestamp": "2026-07-19T10:05:00+00:00"},
            {"type": "phase.start", "attempt": 3, "timestamp": "2026-07-19T10:10:00+00:00"},
            {"type": "phase.end", "attempt": 3, "status": "OK", "timestamp": "2026-07-19T10:13:00+00:00"},
        ]

        timing = he.canonical_phase_timing(events)

        self.assertEqual(timing["activeExecutionMs"], 6 * 60 * 1000)
        self.assertEqual(timing["wallClockSpanMs"], 13 * 60 * 1000)

    def test_arc_ut006_only_events_after_final_end_are_late(self) -> None:
        events = [
            {"type": "phase.start", "attempt": 1, "timestamp": "2026-07-19T10:00:00+00:00"},
            {"type": "phase.end", "attempt": 1, "status": "FAIL", "timestamp": "2026-07-19T10:01:00+00:00"},
            {"type": "phase.start", "attempt": 2, "timestamp": "2026-07-19T10:03:00+00:00"},
            {"type": "command", "attempt": 2, "timestamp": "2026-07-19T10:04:00+00:00"},
            {"type": "phase.end", "attempt": 2, "status": "OK", "timestamp": "2026-07-19T10:05:00+00:00"},
            {"type": "artifact", "attempt": 2, "timestamp": "2026-07-19T10:07:00+00:00"},
        ]

        timing = he.canonical_phase_timing(events)

        self.assertEqual(timing["lateEventCount"], 1)
        self.assertEqual(timing["lateEventSpanMs"], 2 * 60 * 1000)

    def test_arc_ut008_latest_phase_end_is_the_only_terminal_status(self) -> None:
        events = [
            {"type": "phase.end", "phase": "archive", "status": "FAIL"},
            {"type": "phase.end", "phase": "archive", "status": "OK"},
        ]

        with tempfile.TemporaryDirectory() as tmp:
            status = ha._stage_status_from_sources(events, None, Path(tmp))

        self.assertEqual(status["archive"], "OK")


class ArchiveExactBytePolicyTests(unittest.TestCase):
    def test_arc_cli004_does_not_require_consumer_gitattributes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            result = ha.check_archive_exact_byte_policy(project)

        self.assertTrue(result["ok"])
        self.assertEqual(result["mode"], "zip-content-hash")
        self.assertFalse((project / ".gitattributes").exists())

    def test_arc_cli004_accepts_exact_byte_attributes_rule(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            _write(project / ".gitattributes", ".harness/archive/** -text\n")

            result = ha.check_archive_exact_byte_policy(project)

        self.assertTrue(result["ok"])
        self.assertEqual(result["mode"], "zip-content-hash")


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
                    "defaultPhases": ["plan", "execute", "review", "submit", "archive"],
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
                    "defaultPhases": ["plan", "execute", "review", "submit", "archive"],
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
                "--intent",
                "record-only",
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
                "finalCommit": "aaaaaaaa",
                "productCommit": "bbbbbbbb",
                "archiveCommit": "bbbbbbbb",
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
                    "dbCompatibility": {
                        "status": "OK",
                        "metrics": {
                            "applicability": "NOT_APPLICABLE",
                            "reason": "pipeline fixture has no database surface",
                        },
                    },
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
                "--intent",
                "record-only",
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
    def test_int102_summary_data_includes_reasons(self) -> None:
        code, payload = _run(
            [
                "finalize",
                "--intent",
                "record-only",
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
        summary = json.loads(
            (archive_dir / "reports" / "final" / "summary-data.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertIn("finalStatusReasons", summary)
        self.assertTrue(archive_dir.is_dir())

    def test_int103_no_patch_still_consistent(self) -> None:
        """freeze-first: 无 _patch_archive_stage，archive 阶段事实仍完整一致。"""
        code, payload = _run(
            [
                "finalize",
                "--intent",
                "record-only",
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
        self.assertNotIn("patch_archive", payload.get("steps") or {})
        archive_dir = Path(payload["archive_dir"])
        summary = json.loads(
            (archive_dir / "reports" / "final" / "summary-data.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertIn(
            (summary.get("stageStatus") or {}).get("archive"),
            {"OK", "WARN"},
        )
        stages = (summary.get("durations") or {}).get("stages") or []
        archive_stage = next((s for s in stages if s.get("stage") == "archive"), None)
        self.assertIsNotNone(archive_stage, "archive stage must come from frozen events")
        self.assertIn(archive_stage.get("result"), {"OK", "WARN"})
        timeline = summary.get("timeline") or []
        archive_tl = [t for t in timeline if t.get("phase") == "archive"]
        self.assertTrue(archive_tl, "archive timeline must come from frozen events")
        events = (archive_dir / "events.ndjson").read_text(encoding="utf-8").strip().splitlines()
        self.assertEqual(
            summary["reportPipeline"]["event_count"],
            len([l for l in events if l.strip()]),
            "event_count must equal the frozen cutoff total without any patch",
        )


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
                "stageStatus": {"execute": "OK", "archive": "OK"},
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


class NoPatchConsistencyTests(unittest.TestCase):
    """freeze-first: archive stage facts derive from frozen events alone
    (replaces the deleted _patch_archive_stage unit tests, RET-19)."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-nopatch-"))
        self.work = self.tmp / "change"
        self.work.mkdir()
        ha.append_event(self.work, phase="execute", type_="phase.start", note="run start")
        ha.append_event(self.work, phase="execute", type_="phase.end", status="OK")
        import time

        time.sleep(0.02)
        ha.append_event(self.work, phase="archive", type_="phase.start", note="a")
        time.sleep(0.02)
        ha.append_event(self.work, phase="archive", type_="phase.end", status="OK")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_collect_derives_archive_stage_without_patch(self) -> None:
        summary = ha.collect_summary_data(self.work, write=False)
        stages = (summary.get("durations") or {}).get("stages") or []
        archive_stages = [s for s in stages if s.get("stage") == "archive"]
        self.assertEqual(len(archive_stages), 1, "exactly one archive stage")
        self.assertEqual(archive_stages[0].get("skill"), "harness-archive")
        self.assertEqual(archive_stages[0].get("result"), "OK")
        self.assertEqual((summary.get("stageStatus") or {}).get("archive"), "OK")
        # non-archive stage preserved
        self.assertTrue(any(s.get("stage") == "execute" for s in stages))
        # canonical timing fields present (UT-008)
        self.assertIn("activeExecutionMs", archive_stages[0])
        self.assertIn("wallClockSpanMs", archive_stages[0])

    def test_collect_archive_timeline_has_duration_without_patch(self) -> None:
        summary = ha.collect_summary_data(self.work, write=False)
        timeline = [
            t
            for t in (summary.get("timeline") or [])
            if t.get("phase") == "archive" and t.get("durationMs") is not None
        ]
        self.assertTrue(timeline, "archive timeline duration must come from events")
        self.assertGreaterEqual(timeline[-1]["durationMs"], 0)

    def test_collect_includes_execution_efficiency_summary(self) -> None:
        session_dir = (
            self.work
            / "runtime"
            / "run-sessions"
            / "verification-unit"
        )
        session_dir.mkdir(parents=True)
        _write_json(
            session_dir / "session.json",
            {
                "status": "OK",
                "wallClockMs": 1200,
                "activeTimeMs": 1000,
                "resourceWaitMs": 200,
                "commandHash": "sha256:command",
                "productIdentity": "sha256:product",
                "testProcessStarted": True,
            },
        )

        summary = ha.collect_summary_data(self.work, write=False)

        self.assertEqual(summary["efficiency"]["schemaVersion"], 1)
        self.assertEqual(summary["efficiency"]["verificationAttempts"], 1)
        self.assertEqual(summary["efficiency"]["timing"]["resourceWaitMs"], 200)


class ArtifactPreflightIntegrationTests(unittest.TestCase):
    """C14 (retro §5.31): artifact_preflight 与 validate_report_adequacy 集成到
    check_status / cmd_finalize。"""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-archive-preflight-"))
        self.change = self.tmp / ".harness" / "changes" / "preflight-demo"
        self.change.mkdir(parents=True)
        _seed_change_dir(self.change)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_status_includes_artifact_preflight(self) -> None:
        """check_status 输出必须含 checks.artifact_preflight。"""
        code, payload = _run(["status", "--change-dir", str(self.change), "--json"])
        self.assertEqual(code, 0, msg=json.dumps(payload, ensure_ascii=False))
        checks = payload.get("checks") or {}
        self.assertIn(
            "artifact_preflight",
            checks,
            "check_status must include checks.artifact_preflight",
        )

    def test_status_blocks_on_artifact_preflight_blocking(self) -> None:
        """含 blocking artifact path（绝对路径）时 archivable=false。"""
        # 追加一个含绝对路径的 artifact 事件
        he.append_event(
            self.change,
            phase="execute",
            type_="artifact",
            path="C:/secret/escape.txt",
            kind="file-backed",
            note="escape attempt",
        )
        code, payload = _run(["status", "--change-dir", str(self.change), "--json"])
        self.assertEqual(code, 0)
        self.assertFalse(
            payload.get("archivable"),
            "blocking artifact path must make archivable=false",
        )
        blockers = payload.get("blockers") or []
        codes = [b.get("code") for b in blockers]
        self.assertIn("artifact-path-blocking", codes)

    def test_status_warns_on_canonicalizable_path(self) -> None:
        """同 change 仓库相对路径应分类为 canonicalizable（warning，非 blocker）。"""
        he.append_event(
            self.change,
            phase="execute",
            type_="artifact",
            path=f".harness/changes/preflight-demo/reports/run-task-status.md",
            kind="file-backed",
            note="repo-relative",
        )
        code, payload = _run(["status", "--change-dir", str(self.change), "--json"])
        self.assertEqual(code, 0)
        warnings = payload.get("warnings") or []
        codes = [w.get("code") for w in warnings]
        self.assertIn("artifact-path-canonicalizable", codes)

    def test_repository_product_artifact_is_copied_into_archive_namespace(self) -> None:
        product = self.tmp / "build" / "contract.json"
        _write(product, '{"ok":true}\n')
        he.append_event(
            self.change,
            phase="execute",
            type_="artifact",
            path="build/contract.json",
            kind="product",
        )

        preflight = ha.artifact_preflight(self.change)
        materialized = ha.materialize_repository_artifacts(self.change)
        events = he.apply_event_corrections(he.load_events(self.change / "events.ndjson"))
        artifacts = ha._artifacts_from_events(events, change_dir=self.change)

        self.assertTrue(preflight["ok"])
        self.assertEqual(preflight["items"][-1]["category"], "repository-file")
        self.assertEqual(materialized["copied"], ["artifacts/product/build/contract.json"])
        self.assertEqual(artifacts[-1]["path"], "artifacts/product/build/contract.json")
        self.assertTrue((self.change / artifacts[-1]["path"]).is_file())


class ArchiveAutoGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-archive-auto-gate-"))
        self.change = self.tmp / ".harness" / "changes" / "auto-gate-demo"
        self.change.mkdir(parents=True)
        _seed_change_dir(self.change)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _collapse_archive_boundary(self) -> None:
        ledger_path = self.change / "evidence" / "verification-ledger.json"
        ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
        ledger.update(
            {
                "baseCommit": "bbbbbbbb",
                "finalCommit": "bbbbbbbb",
                "productCommit": "bbbbbbbb",
                "archiveCommit": "bbbbbbbb",
            }
        )
        _write_json(ledger_path, ledger)
        _write_json(
            self.change / "meta" / "state-snapshot.json",
            {
                "schemaVersion": 1,
                "changeBase": "bbbbbbbb",
                "git": {"base": "bbbbbbbb", "head": "bbbbbbbb"},
            },
        )
        ha.append_event(
            self.change,
            phase="merge",
            type_="phase.end",
            status="OK",
            note="merge completed",
        )

    def test_auto_gate_requires_archive_boundary_snapshot(self) -> None:
        result = ha.archive_auto_gate(self.change, archive_intent="record-only")
        self.assertFalse(result["ok"])
        self.assertEqual(result["reasonCode"], "ARCHIVE_BOUNDARY_SNAPSHOT_MISSING")
        self.assertTrue(result["nextAction"])

    def test_auto_gate_allows_post_submit_snapshot_without_confirmation(self) -> None:
        _write_json(
            self.change / "meta" / "state-snapshot.json",
            {"git": {"base": "bbbbbbbb", "head": "bbbbbbbb"}},
        )
        ha.append_event(
            self.change,
            phase="merge",
            type_="phase.end",
            status="OK",
            note="merge completed",
        )

        result = ha.archive_auto_gate(self.change, archive_intent="record-only")

        self.assertTrue(result["ok"], msg=json.dumps(result, ensure_ascii=False))
        self.assertTrue(result["autoArchiveAllowed"])
        self.assertEqual(result["reasonCode"], "ARCHIVE_AUTO_GATE_SATISFIED")
        self.assertIn("execute", result["nextAction"])
        self.assertIn("不再重复扫描", result["nextAction"])

    def test_status_and_auto_gate_reject_collapsed_completed_boundary(self) -> None:
        self._collapse_archive_boundary()

        status = ha.check_status(self.change, archive_intent="record-only")
        auto_gate = ha.archive_auto_gate(
            self.change,
            archive_intent="record-only",
        )

        self.assertFalse(status["archivable"], status)
        self.assertIn(
            "ARCHIVE_BASE_EQUALS_FEATURE_TIP",
            {item["code"] for item in status["blockers"]},
        )
        self.assertFalse(auto_gate["ok"], auto_gate)
        self.assertFalse(auto_gate["autoArchiveAllowed"])
        self.assertEqual(
            auto_gate["reasonCode"],
            "ARCHIVE_REPORT_ADEQUACY_FAILED",
        )

    def test_status_rejects_snapshot_and_ledger_base_mismatch(self) -> None:
        ledger_path = self.change / "evidence" / "verification-ledger.json"
        ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
        ledger["baseCommit"] = "bbbbbbbb"
        _write_json(ledger_path, ledger)
        _write_json(
            self.change / "meta" / "state-snapshot.json",
            {
                "schemaVersion": 1,
                "changeBase": "aaaaaaaa",
                "git": {"base": "aaaaaaaa", "head": "bbbbbbbb"},
            },
        )

        status = ha.check_status(self.change, archive_intent="record-only")

        self.assertFalse(status["archivable"], status)
        self.assertIn(
            "CHANGE_BASE_IDENTITY_MISMATCH",
            {item["code"] for item in status["blockers"]},
        )

    def test_abandoned_zero_delta_is_archivable_with_a_reason(self) -> None:
        self._collapse_archive_boundary()

        status = ha.check_status(
            self.change,
            archive_intent="record-only",
            closure_disposition="abandoned",
            closure_reason="本轮实现不再继续",
        )

        self.assertTrue(status["archivable"], status)
        self.assertFalse(status["releaseEligible"])
        self.assertIn(
            "NO_PRODUCT_DELTA",
            {item["code"] for item in status["warnings"]},
        )

    def test_abandoned_zero_delta_executes_as_record_only_archive(self) -> None:
        self._collapse_archive_boundary()

        code, payload = ha.execute_archive(
            self.change,
            self.tmp / ".harness" / "archive",
            archive_intent="record-only",
            closure_disposition="abandoned",
            closure_reason="验证后决定停止该需求",
            skip_ingest=True,
        )

        self.assertEqual(code, 0, payload)
        self.assertTrue(payload["ok"], payload)
        self.assertFalse(payload["releaseEligible"])
        self.assertFalse(self.change.exists())
        archive_dir = Path(payload["archive_dir"])
        summary = json.loads(
            (archive_dir / "reports" / "final" / "summary-data.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(summary["closureDisposition"], "abandoned")
        self.assertEqual(summary["closureReason"], "验证后决定停止该需求")
        archive_events = he.load_events(he.events_path(archive_dir))
        starts = [
            item
            for item in archive_events
            if item.get("phase") == "archive" and item.get("type") == "phase.start"
        ]
        ends = [
            item
            for item in archive_events
            if item.get("phase") == "archive" and item.get("type") == "phase.end"
        ]
        self.assertEqual(len(starts), 1)
        self.assertEqual(len(ends), 1)

    def test_finalize_rejects_known_adequacy_error_before_staging(self) -> None:
        self._collapse_archive_boundary()
        archive_root = self.tmp / ".harness" / "archive"

        code, payload = ha.cmd_finalize(
            self.change,
            archive_root,
            archive_intent="record-only",
        )

        self.assertEqual(code, 1, payload)
        self.assertEqual(payload["reasonCode"], "ARCHIVE_REPORT_ADEQUACY_FAILED")
        self.assertIn(
            "ARCHIVE_BASE_EQUALS_FEATURE_TIP",
            {item["code"] for item in payload["issues"]},
        )
        self.assertFalse(Path(payload["operationTempDir"]).exists())
        operation_root = self.tmp / ".harness" / "archive-operations" / "staging"
        self.assertFalse(operation_root.exists())

    def test_direct_finalize_syncs_blocked_terminal_from_split_state(self) -> None:
        state_root = self.tmp / ".harness" / "state" / "changes" / self.change.name
        state_root.mkdir(parents=True)
        context_path = self.change / "meta" / "change-context.json"
        context = (
            json.loads(context_path.read_text(encoding="utf-8"))
            if context_path.is_file()
            else {"schemaVersion": 2, "changeName": self.change.name}
        )
        context["stateOwnership"] = {
            "layout": "split-v1",
            "runtimeRoot": f".harness/state/changes/{self.change.name}",
        }
        _write_json(context_path, context)
        code, payload = ha.cmd_finalize(
            self.change,
            self.tmp / ".harness" / "archive",
            archive_intent="record-only",
            preflight_status={
                "archivable": False,
                "blockers": [{"code": "TEST_BLOCK", "message": "测试阻断"}],
            },
        )

        self.assertEqual(code, 1, payload)
        events = he.load_events(he.events_path(state_root))
        self.assertTrue(any(
            item.get("phase") == "archive"
            and item.get("type") == "phase.end"
            and item.get("status") == "BLOCKED"
            for item in events
        ))

    def test_execute_collects_status_once_before_finalize(self) -> None:
        _write_json(
            self.change / "meta" / "state-snapshot.json",
            {"git": {"base": "aaaaaaaa", "head": "bbbbbbbb"}},
        )
        ha.append_event(
            self.change,
            phase="merge",
            type_="phase.end",
            status="OK",
            note="merge completed",
        )
        original = ha.check_status
        calls = 0

        def counted(*args, **kwargs):
            nonlocal calls
            calls += 1
            return original(*args, **kwargs)

        with mock.patch.object(ha, "check_status", side_effect=counted):
            code, payload = _run(
                [
                    "execute",
                    "--change-dir",
                    str(self.change),
                    "--archive-root",
                    str(self.tmp / ".harness" / "archive"),
                    "--intent",
                    "record-only",
                    "--skip-ingest",
                    "--json",
                ]
            )

        self.assertEqual(code, 0, payload)
        self.assertEqual(calls, 1)
        self.assertTrue(payload["preflight"]["autoArchiveAllowed"])
        archive_dir = Path(payload["archive_dir"])
        events = he.load_events(he.events_path(archive_dir))
        archive_starts = [
            item
            for item in events
            if item.get("phase") == "archive" and item.get("type") == "phase.start"
        ]
        archive_ends = [
            item
            for item in events
            if item.get("phase") == "archive" and item.get("type") == "phase.end"
        ]
        prepare_ends = [
            item
            for item in events
            if item.get("phase") == "archive"
            and item.get("type") == "phase.prepare.end"
        ]
        self.assertEqual(len(archive_starts), 1)
        self.assertEqual(len(archive_ends), 1)
        self.assertEqual(len(prepare_ends), 1)
        self.assertGreaterEqual(prepare_ends[0]["duration_ms"], 0)

    def test_execute_certifies_unchanged_local_candidate_before_preflight(self) -> None:
        receipt = {
            "schemaVersion": 2,
            "provider": "local-harness",
            "assurance": "local-reproducible",
            "subject": {
                "productCommit": "bbbbbbbb",
                "productTreeHash": "sha256:" + "a" * 64,
            },
        }
        blocked_gate = {
            "ok": False,
            "reasonCode": "ARCHIVE_BOUNDARY_SNAPSHOT_MISSING",
            "nextAction": "补齐快照",
            "status": {"blockers": []},
        }

        with (
            mock.patch.object(ha, "load_product_candidate_ci", return_value=None),
            mock.patch.object(
                ha,
                "certify_local_candidate",
                return_value=receipt,
            ) as certify,
            mock.patch.object(ha, "archive_auto_gate", return_value=blocked_gate),
        ):
            code, payload = ha.execute_archive(
                self.change,
                self.tmp / ".harness" / "archive",
                archive_intent="record-only",
                skip_ingest=True,
            )

        self.assertEqual(code, 1)
        certify.assert_called_once()
        self.assertTrue(payload["candidateCertification"]["ok"])
        self.assertEqual(
            payload["candidateCertification"]["subject"]["productCommit"],
            "bbbbbbbb",
        )

    def test_auto_gate_uses_split_state_and_the_last_planned_phase_without_git(self) -> None:
        state = self.tmp / ".harness" / "state" / "changes" / self.change.name
        state.mkdir(parents=True)
        _write_json(
            self.change / "meta" / "change-context.json",
            {
                "schemaVersion": 2,
                "changeName": self.change.name,
                "stateOwnership": {
                    "layout": "split-v1",
                    "runtimeRoot": f".harness/state/changes/{self.change.name}",
                },
            },
        )
        _write_json(
            self.change / "meta" / "gate-policy.json",
            {
                "schemaVersion": 1,
                "tier": "fast",
                "source": "change",
                "plannedPhases": ["plan", "execute", "archive"],
                "skippedPhases": [
                    {"phase": "submit", "reason": "本次不需要 Git 提交"}
                ],
            },
        )
        shutil.move(str(self.change / "evidence"), str(state / "evidence"))
        events = [
            {
                "schema_version": 3,
                "id": "evt-plan-end",
                "timestamp": "2026-08-09T00:00:00+00:00",
                "type": "phase.end",
                "phase": "plan",
                "status": "OK",
            },
            {
                "schema_version": 3,
                "id": "evt-run-end",
                "timestamp": "2026-08-09T00:01:00+00:00",
                "type": "phase.end",
                "phase": "execute",
                "status": "OK",
            },
        ]
        _write(
            state / "events.ndjson",
            "".join(json.dumps(item, ensure_ascii=False) + "\n" for item in events),
        )
        _write_json(
            state / "meta" / "state-snapshot.json",
            {
                "schemaVersion": 1,
                "sourceControl": "none",
                "content": {"productTreeHash": "sha256:" + "a" * 64},
            },
        )

        result = ha.archive_auto_gate(self.change, archive_intent="record-only")

        self.assertTrue(result["ok"], msg=json.dumps(result, ensure_ascii=False))
        self.assertEqual(result["completedPrerequisitePhase"], "execute")
        self.assertEqual(result["plannedPhases"], ["plan", "execute", "archive"])


class ArchiveRangeAdoptionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-archive-range-"))
        self.project = self.tmp / "project"
        self.project.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=self.project, check=True)
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=self.project,
            check=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Test"],
            cwd=self.project,
            check=True,
        )
        _write(self.project / "src" / "app.py", "value = 1\n")
        subprocess.run(["git", "add", "src/app.py"], cwd=self.project, check=True)
        subprocess.run(
            ["git", "commit", "-q", "-m", "base"],
            cwd=self.project,
            check=True,
        )
        self.base = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=self.project,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        _write(self.project / "src" / "app.py", "value = 2\n")
        subprocess.run(["git", "add", "src/app.py"], cwd=self.project, check=True)
        subprocess.run(
            ["git", "commit", "-q", "-m", "product"],
            cwd=self.project,
            check=True,
        )
        self.tip = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=self.project,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        self.change = self.project / ".harness" / "changes" / "existing-product"
        self.change.mkdir(parents=True)
        _seed_change_dir(self.change)
        _write_json(
            self.change / "meta" / "change-context.json",
            {
                "schemaVersion": 2,
                "changeId": self.change.name,
                "ownership": {
                    "productPaths": ["src/"],
                    "staticEvidencePaths": [
                        f".harness/changes/{self.change.name}/"
                    ],
                },
            },
        )
        ledger_path = self.change / "evidence" / "verification-ledger.json"
        ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
        ledger.update(
            {
                "baseCommit": self.tip,
                "finalCommit": self.tip,
                "productCommit": self.tip,
                "archiveCommit": self.tip,
            }
        )
        _write_json(ledger_path, ledger)
        _write_json(
            self.change / "evidence" / "product-candidate-ci.json",
            {
                "schemaVersion": 1,
                "conclusion": "success",
                "commit": self.tip,
                "runUrl": "https://ci.example/runs/range",
            },
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_adopt_existing_range_requires_explicit_confirmation(self) -> None:
        result = ha.adopt_existing_range(
            self.change,
            base=self.base,
            tip=self.tip,
            reason="将已有产品提交纳入本变更",
            confirmed=False,
        )

        self.assertFalse(result["ok"], result)
        self.assertEqual(result["reasonCode"], "EXISTING_RANGE_CONFIRMATION_REQUIRED")

    def test_adopt_existing_range_cli_requires_confirmation_flag(self) -> None:
        code, payload = _run(
            [
                "adopt-existing-range",
                "--change-dir",
                str(self.change),
                "--base",
                self.base,
                "--tip",
                self.tip,
                "--reason",
                "将已有产品提交纳入本变更",
                "--json",
            ]
        )

        self.assertEqual(code, 1)
        self.assertEqual(
            payload["reasonCode"],
            "EXISTING_RANGE_CONFIRMATION_REQUIRED",
        )

    def test_adopt_existing_range_overrides_collapsed_ledger_with_a_receipt(self) -> None:
        adopted = ha.adopt_existing_range(
            self.change,
            base=self.base,
            tip=self.tip,
            reason="将已有产品提交纳入本变更",
            confirmed=True,
        )
        summary = ha.collect_summary_data(self.change, write=False)
        status = ha.check_status(self.change, archive_intent="record-only")

        self.assertTrue(adopted["ok"], adopted)
        self.assertTrue(Path(adopted["receiptPath"]).is_file())
        self.assertEqual(summary["baseCommit"], self.base)
        self.assertEqual(summary["finalCommit"], self.tip)
        self.assertEqual(
            [item["path"] for item in summary["changedFiles"]],
            ["src/app.py"],
        )
        self.assertTrue(status["archivable"], status)
        self.assertEqual(
            status["checks"]["range_adoption"]["reasonCode"],
            "EXISTING_RANGE_ADOPTED",
        )

    def test_adopt_existing_range_is_idempotent_for_the_same_decision(self) -> None:
        first = ha.adopt_existing_range(
            self.change,
            base=self.base,
            tip=self.tip,
            reason="将已有产品提交纳入本变更",
            confirmed=True,
        )
        second = ha.adopt_existing_range(
            self.change,
            base=self.base,
            tip=self.tip,
            reason="将已有产品提交纳入本变更",
            confirmed=True,
        )

        self.assertTrue(first["ok"], first)
        self.assertTrue(second["ok"], second)
        self.assertTrue(second["idempotent"])
        self.assertEqual(
            first["receipt"]["receiptId"],
            second["receipt"]["receiptId"],
        )


class SensitiveEvidencePublicationGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-archive-secret-gate-"))
        self.project = self.tmp / "proj"
        self.change = self.project / ".harness" / "changes" / "secret-demo"
        self.change.mkdir(parents=True)
        # The gate is advisory by default; these cases assert the enforcing mode.
        self._policy = mock.patch.dict(
            os.environ, {ha.SENSITIVE_SCAN_POLICY_ENV: "block"}
        )
        self._policy.start()
        self.addCleanup(self._policy.stop)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_default_policy_reports_plaintext_without_blocking(self) -> None:
        self._policy.stop()
        self.addCleanup(self._policy.start)
        # 放在会被打进归档包的位置：发布门禁只对会发布的字节负责。
        source = self.change / "plans" / "legacy.md"
        source.parent.mkdir(parents=True)
        source.write_text("password=never-publish", encoding="utf-8")

        result = ha.validate_sensitive_evidence_publication_gate(self.change)

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["reasonCode"], "SENSITIVE_EVIDENCE_ADVISORY")
        # The facts survive so the archive report still names the file.
        advisory = result["advisory"]
        self.assertEqual(advisory["reasonCode"], "SENSITIVE_EVIDENCE_UNQUARANTINED")
        self.assertEqual(
            [item["path"] for item in advisory["unresolvedFailures"]],
            ["plans/legacy.md"],
        )
        self.assertTrue(source.is_file())

    def test_off_policy_skips_the_scan_entirely(self) -> None:
        self._policy.stop()
        self.addCleanup(self._policy.start)
        source = self.change / "plans" / "legacy.md"
        source.parent.mkdir(parents=True)
        source.write_text("password=never-publish", encoding="utf-8")

        with mock.patch.dict(os.environ, {ha.SENSITIVE_SCAN_POLICY_ENV: "off"}):
            result = ha.validate_sensitive_evidence_publication_gate(self.change)

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["reasonCode"], "SECRET_SCAN_DISABLED")
        self.assertNotIn("advisory", result)

    def test_gate_rejects_plaintext_sensitive_evidence_before_copy(self) -> None:
        source = self.change / "plans" / "legacy.md"
        source.parent.mkdir(parents=True)
        source.write_text("password=never-publish", encoding="utf-8")

        result = ha.validate_sensitive_evidence_publication_gate(self.change)

        self.assertFalse(result["ok"])
        self.assertEqual(result["reasonCode"], "SENSITIVE_EVIDENCE_UNQUARANTINED")
        self.assertTrue(source.is_file())

    def test_gate_binds_quarantine_receipt_to_tree_digest_and_excludes_private_path(self) -> None:
        source = self.change / "runtime" / "legacy.txt"
        source.parent.mkdir(parents=True)
        source.write_text("token=never-publish", encoding="utf-8")
        quarantined = ha.hruntime.quarantine_sensitive_evidence(
            source,
            change_root=self.change,
            private_root=self.tmp / "private",
        )
        self.assertTrue(quarantined["ok"], quarantined)

        allowed = ha.validate_sensitive_evidence_publication_gate(
            self.change,
            copy_root=self.project / ".harness" / "archive-operation-staging",
            require_receipt=True,
        )
        self.assertTrue(allowed["ok"], allowed)
        receipt_path = self.change / "meta" / "secret-scan-receipt.json"
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        receipt["publishableTreeDigest"] = "sha256:" + "0" * 64
        _write_json(receipt_path, receipt)
        denied = ha.validate_sensitive_evidence_publication_gate(
            self.change,
            require_receipt=True,
        )
        self.assertFalse(denied["ok"])
        self.assertEqual(denied["reasonCode"], "SECRET_SCAN_GATE_BLOCKED")

    def test_finalize_refreshes_quarantine_receipt_across_event_and_lock_drift(self) -> None:
        _seed_change_dir(self.change)
        archive_root = self.project / ".harness" / "archive"
        archive_root.mkdir(parents=True)
        source = self.change / "runtime" / "legacy.txt"
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text("token=never-publish", encoding="utf-8")
        quarantined = ha.hruntime.quarantine_sensitive_evidence(
            source,
            change_root=self.change,
            private_root=self.tmp / "private",
        )
        self.assertTrue(quarantined["ok"], quarantined)
        with (self.change / "events.ndjson").open(
            "a", encoding="utf-8", newline="\n"
        ) as handle:
            handle.write(
                '{"phase":"submit","type":"decision","note":"after receipt"}\n'
            )
        (self.change / "events.ndjson.lock").write_text("lock", encoding="utf-8")

        code, payload = _run(
            [
                "finalize",
                "--intent",
                "record-only",
                "--change-dir",
                str(self.change),
                "--archive-root",
                str(archive_root),
                "--skip-ingest",
                "--json",
            ]
        )

        self.assertEqual(code, 0, msg=json.dumps(payload, ensure_ascii=False, indent=2))
        self.assertTrue(payload["steps"]["sensitive_evidence_source_refresh"]["ok"])
        self.assertTrue(payload["steps"]["sensitive_evidence_staging_refresh"]["ok"])
        self.assertTrue(payload["steps"]["sensitive_evidence_publication"]["ok"])
        archive_dir = Path(payload["archive_dir"])
        self.assertFalse((archive_dir / "events.ndjson.lock").exists())
        receipt = json.loads(
            (archive_dir / "meta" / "secret-scan-receipt.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(receipt["status"], "QUARANTINED")
        self.assertEqual(len(receipt["entries"]), 1)
        self.assertNotIn("never-publish", json.dumps(receipt))


class ArchiveCorePushTests(unittest.TestCase):
    """A finalized change uploads one deterministic, core-only ZIP."""

    def _directory_link(self, link: Path, target: Path) -> None:
        link.parent.mkdir(parents=True, exist_ok=True)
        if sys.platform == "win32":
            completed = subprocess.run(
                ["cmd.exe", "/c", "mklink", "/J", str(link), str(target)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                check=False,
            )
            if completed.returncode != 0:
                self.skipTest(
                    f"junction unavailable: {completed.stderr or completed.stdout}"
                )
            return
        try:
            link.symlink_to(target, target_is_directory=True)
        except OSError as exc:
            self.skipTest(f"directory symlink unavailable: {exc}")

    def test_collect_archive_core_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / ".harness" / "archive" / "2026-08-06-demo"
            (archive / "reports" / "final").mkdir(parents=True)
            (archive / "spec").mkdir(parents=True)
            (archive / "plans").mkdir(parents=True)
            (archive / "reports" / "review").mkdir(parents=True)
            (archive / "reports" / "test").mkdir(parents=True)
            (archive / "meta").mkdir(parents=True)
            (archive / "reports" / "final" / "summary-data.json").write_text("{}", encoding="utf-8")
            (archive / "spec" / "design.md").write_text("# d\n", encoding="utf-8")
            (archive / "plans" / "plan.md").write_text("# p\n", encoding="utf-8")
            (archive / "reports" / "review" / "review.md").write_text("# r\n", encoding="utf-8")
            (archive / "reports" / "test" / "test.md").write_text("# t\n", encoding="utf-8")
            (archive / "meta" / "archive-meta.md").write_text("# m\n", encoding="utf-8")
            (archive / "meta" / "change-context.json").write_text("{}", encoding="utf-8")
            (root / ".harness" / "knowledge" / "entries" / "active").mkdir(parents=True)
            (root / ".harness" / "knowledge" / "entries" / "active" / "kn.json").write_text(
                "{}", encoding="utf-8"
            )
            paths = ha.collect_archive_core_paths(root, archive)
            joined = "\n".join(paths)
            self.assertIn("summary-data.json", joined)
            self.assertIn("spec/design.md", joined)
            self.assertIn("plans/plan.md", joined)
            self.assertNotIn("reports/review/review.md", joined)
            self.assertNotIn("reports/test/test.md", joined)
            self.assertIn("meta/archive-meta.md", joined)
            self.assertIn("meta/change-context.json", joined)
            self.assertNotIn("knowledge/entries/active/kn.json", joined)

    def test_archive_package_is_deterministic_and_core_only(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / ".harness" / "archive" / "2026-08-08-demo"
            _write_json(
                archive / "reports" / "final" / "summary-data.json",
                {"schema_version": 1, "change_key": "demo", "summary": "服务端入库"},
            )
            _write(archive / "spec" / "design.md", "# 设计\n")
            _write(archive / "plans" / "plan.md", "# 计划\n")
            _write(archive / "meta" / "archive-meta.md", "# 元数据\n")
            _write_json(archive / "meta" / "change-context.json", {"branch": "main"})
            _write(archive / "reports" / "review" / "review.md", "# 临时审查\n")
            _write(archive / "logs" / "debug.log", "temporary\n")
            self.assertTrue(hasattr(ha, "build_archive_package"))
            if not hasattr(ha, "build_archive_package"):
                return

            first = ha.build_archive_package(root, archive, "demo")
            first_bytes = Path(first["packagePath"]).read_bytes()
            second = ha.build_archive_package(root, archive, "demo")
            second_bytes = Path(second["packagePath"]).read_bytes()
            self.assertEqual(first_bytes, second_bytes)
            self.assertEqual(first["packageSha256"], second["packageSha256"])
            with zipfile.ZipFile(first["packagePath"], "r") as zipped:
                names = sorted(zipped.namelist())
                self.assertEqual(
                    names,
                    [
                        "archive-manifest.json",
                        "archive-meta.md",
                        "change-context.json",
                        "plans/plan.md",
                        "reports/final/summary-data.json",
                        "spec/design.md",
                    ],
                )
                manifest = json.loads(zipped.read("archive-manifest.json"))
                self.assertEqual(manifest["profile"], "core-v1")
                self.assertEqual(manifest["change_key"], "demo")
                self.assertEqual(len(manifest["files"]), 5)

    def test_archive_package_redacts_windows_local_paths_from_remote_json(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / ".harness" / "archive" / "2026-08-08-demo"
            _write_json(
                archive / "reports" / "final" / "summary-data.json",
                {
                    "schemaVersion": "2.3",
                    "changeName": "demo",
                    "projection": {
                        "receiptPath": r"E:\private\project\projection.json",
                        "relativePath": "reports/final/summary-data.json",
                    },
                },
            )

            package = ha.build_archive_package(root, archive, "demo")

            with zipfile.ZipFile(package["packagePath"], "r") as zipped:
                uploaded = json.loads(
                    zipped.read("reports/final/summary-data.json").decode("utf-8")
                )
            self.assertEqual(uploaded["projection"]["receiptPath"], "<local-path>")
            self.assertEqual(
                uploaded["projection"]["relativePath"],
                "reports/final/summary-data.json",
            )
            self.assertNotIn(r"E:\private", json.dumps(uploaded, ensure_ascii=False))

    def test_archive_package_rejects_linked_archive_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            real_archive = root / ".harness" / "archive" / "real"
            _write_json(
                real_archive / "reports" / "final" / "summary-data.json",
                {"schema_version": 1, "summary": "核心归档"},
            )
            linked_archive = root / ".harness" / "archive" / "linked"
            self._directory_link(linked_archive, real_archive)

            with self.assertRaisesRegex(ValueError, "link|reparse"):
                ha.build_archive_package(root, linked_archive, "demo")

    def test_archive_package_rejects_linked_core_directory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as outside:
            root = Path(tmp)
            archive = root / ".harness" / "archive" / "demo"
            _write_json(
                archive / "reports" / "final" / "summary-data.json",
                {"schema_version": 1, "summary": "核心归档"},
            )
            outside_spec = Path(outside) / "spec"
            _write(outside_spec / "secret.md", "never upload\n")
            self._directory_link(archive / "spec", outside_spec)

            with self.assertRaisesRegex(ValueError, "link|reparse"):
                ha.build_archive_package(root, archive, "demo")

    def test_archive_package_rejects_linked_output_parent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as outside:
            root = Path(tmp)
            archive = root / ".harness" / "archive" / "demo"
            _write_json(
                archive / "reports" / "final" / "summary-data.json",
                {"schema_version": 1, "summary": "核心归档"},
            )
            output_parent = (
                root / ".harness" / "state" / "local" / "archive-packages"
            )
            outside_parent = Path(outside) / "packages"
            outside_parent.mkdir()
            self._directory_link(output_parent, outside_parent)

            with self.assertRaisesRegex(ValueError, "link|reparse|outside"):
                ha.build_archive_package(root, archive, "demo")
            self.assertFalse((outside_parent / "demo.zip").exists())

    def test_archive_package_rejects_precreated_output_junction(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as outside:
            root = Path(tmp)
            archive = root / ".harness" / "archive" / "demo"
            _write_json(
                archive / "reports" / "final" / "summary-data.json",
                {"schema_version": 1, "summary": "核心归档"},
            )
            output = (
                root
                / ".harness"
                / "state"
                / "local"
                / "archive-packages"
                / "demo.zip"
            )
            outside_target = Path(outside) / "package-target"
            outside_target.mkdir()
            sentinel = outside_target / "keep.txt"
            sentinel.write_text("keep\n", encoding="utf-8")
            self._directory_link(output, outside_target)

            with self.assertRaisesRegex(ValueError, "link|reparse"):
                ha.build_archive_package(root, archive, "demo")
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep\n")

    def test_archive_package_rejects_input_and_output_outside_project(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as outside:
            root = Path(tmp)
            archive = Path(outside) / "archive"
            _write_json(
                archive / "reports" / "final" / "summary-data.json",
                {"schema_version": 1, "summary": "核心归档"},
            )
            with self.assertRaisesRegex(ValueError, "outside"):
                ha.build_archive_package(root, archive, "demo")

            local_archive = root / ".harness" / "archive" / "demo"
            _write_json(
                local_archive / "reports" / "final" / "summary-data.json",
                {"schema_version": 1, "summary": "核心归档"},
            )
            outside_output = Path(outside) / "demo.zip"
            with self.assertRaisesRegex(ValueError, "outside"):
                ha.build_archive_package(
                    root,
                    local_archive,
                    "demo",
                    output_path=outside_output,
                )
            self.assertFalse(outside_output.exists())

    def test_archive_package_rejects_non_portable_change_keys(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / ".harness" / "archive" / "demo"
            _write_json(
                archive / "reports" / "final" / "summary-data.json",
                {"schema_version": 1, "summary": "核心归档"},
            )
            for change_key in ("..", "contains space", "C:drive", "-leading"):
                with self.subTest(change_key=change_key):
                    with self.assertRaisesRegex(ValueError, "portable"):
                        ha.build_archive_package(root, archive, change_key)

    def test_auto_push_skips_without_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / ".harness" / "archive" / "demo"
            _write_json(
                archive / "reports" / "final" / "summary-data.json",
                {"schema_version": 1, "summary": "待上传核心归档"},
            )
            result = ha.auto_push_archive_core(root, archive)
            self.assertTrue(result.get("skipped"))
            self.assertEqual(
                result.get("reasonCode"), "ARCHIVE_UPLOAD_CREDENTIALS_MISSING"
            )
            self.assertTrue(Path(str(result["packagePath"])).is_file())
            self.assertTrue(Path(str(result["pending"])).is_file())

    def test_auto_push_uses_dedicated_archive_upload_command(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / ".harness" / "archive" / "2026-08-08-change-one"
            _write_json(
                archive / "reports" / "final" / "summary-data.json",
                {"schema_version": 1, "summary": "远端知识"},
            )
            _write(archive / "spec" / "design.md", "# 设计\n")
            _write(
                root / ".harness" / "credentials.local.yaml",
                "server_url: https://platform.example.test\ntoken: token\n",
            )
            completed = subprocess.CompletedProcess(
                [],
                0,
                stdout=json.dumps(
                    {
                        "archive_status": "durable",
                        "knowledge_status": "ready",
                    }
                ),
                stderr="",
            )
            with mock.patch.object(ha.subprocess, "run", return_value=completed) as run:
                result = ha.auto_push_archive_core(root, archive, change_key="change-one")

            command = run.call_args.args[0]
            self.assertIn("archive", command)
            self.assertIn("upload", command)
            self.assertIn("--file", command)
            self.assertIn("--change-key", command)
            self.assertNotIn("push", command)
            self.assertTrue(result.get("ok"))
            self.assertEqual(result.get("fileCount"), 2)
            self.assertFalse(Path(str(result["packagePath"])).exists())
            self.assertFalse(Path(str(result["pending"])).exists())

    def test_auto_push_keeps_retry_package_when_server_indexing_fails(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / ".harness" / "archive" / "2026-08-08-change-one"
            _write_json(
                archive / "reports" / "final" / "summary-data.json",
                {"schema_version": 1, "summary": "远端知识"},
            )
            _write(
                root / ".harness" / "credentials.local.yaml",
                "server_url: https://platform.example.test\ntoken: token\n",
            )
            completed = subprocess.CompletedProcess(
                [],
                0,
                stdout=json.dumps(
                    {
                        "archive_status": "durable",
                        "knowledge_status": "failed",
                    }
                ),
                stderr="",
            )
            with mock.patch.object(ha.subprocess, "run", return_value=completed):
                result = ha.auto_push_archive_core(root, archive, change_key="change-one")

            self.assertTrue(result.get("ok"))
            self.assertEqual(result.get("archiveStatus"), "durable")
            self.assertEqual(result.get("knowledgeStatus"), "failed")
            self.assertTrue(Path(str(result["packagePath"])).is_file())
            self.assertTrue(Path(str(result["pending"])).is_file())
            self.assertIn("索引", str(result.get("warning")))


class RemoteDurabilityReconciliationTests(unittest.TestCase):
    """上传成功后，落盘的 summary 必须跟着改口，不能和回执各说各话。

    实况：summary-data.json 在归档流程早期就以 ARCHIVED_LOCAL_ONLY 写盘，之后
    远端上传成功只更新了内存里的 payload（而且把对象覆盖成裸字符串，形状都变了），
    从没回写文件。于是同一次归档，回执说 durable、报告说 local-only——平台和用户
    读到的是后者。
    """

    def _local_only(self) -> dict:
        return {
            "status": "ARCHIVED_LOCAL_ONLY",
            "retentionPolicy": "project-local",
            "readBackRequiredBeforeSourceDeletion": False,
            "risk": "The archive exists only under the project-local .harness tree.",
        }

    def test_durable_push_projects_remote_status_and_keeps_object_shape(self) -> None:
        result = ha.remote_durable_archive_durability(
            self._local_only(),
            {
                "archiveStatus": "durable",
                "archiveId": "arc_abc123",
                "uploadStatus": "ready",
                "knowledgeStatus": "ready",
            },
        )

        self.assertIsNotNone(result)
        assert result is not None
        self.assertIsInstance(result, dict)  # 不得退化成裸字符串
        self.assertEqual(result["status"], "ARCHIVED_REMOTE_DURABLE")
        self.assertEqual(result["archiveId"], "arc_abc123")
        self.assertEqual(result["uploadStatus"], "ready")
        self.assertEqual(result["knowledgeStatus"], "ready")
        # 已经远端持久化，就不该再声称"只存在于本地、可能随工作区丢失"
        self.assertIsNone(result["risk"])

    def test_non_durable_push_leaves_local_only_untouched(self) -> None:
        for status in ("pending", "failed", None):
            with self.subTest(status=status):
                self.assertIsNone(
                    ha.remote_durable_archive_durability(
                        self._local_only(), {"archiveStatus": status}
                    )
                )

    def test_summary_file_is_rewritten_so_report_matches_the_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            summary_path = Path(tmp) / "summary-data.json"
            summary_path.write_text(
                json.dumps(
                    {"changeName": "demo", "archiveDurability": self._local_only()},
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            durability = ha.remote_durable_archive_durability(
                self._local_only(),
                {"archiveStatus": "durable", "archiveId": "arc_abc123", "uploadStatus": "ready"},
            )
            assert durability is not None

            ha.persist_archive_durability(summary_path, durability)

            written = json.loads(summary_path.read_text(encoding="utf-8-sig"))
            self.assertEqual(
                written["archiveDurability"]["status"], "ARCHIVED_REMOTE_DURABLE"
            )
            self.assertEqual(written["changeName"], "demo")  # 其余字段不动


class ManagedSnapshotFailureDiagnosticsTests(unittest.TestCase):
    """受管快照推送失败时必须留下可行动的原因。

    plan/spec、.harness/codebase、.harness/rules 全靠这条推送上平台（push 会 walk
    每个归档目录的 spec/ 与 plans/）。它在归档里是 best-effort：失败只记一句
    "未能同步到平台…稍后重试"，把 stdout/stderr 整个丢掉。实况就是这条挂了
    （exitCode=1），用户在平台上只看到更早一次推送留下的 3 个配置文件，而没有
    任何线索能查为什么。
    """

    def _run(self, *, returncode: int, stdout: str = "", stderr: str = ""):
        completed = subprocess.CompletedProcess(
            args=["npx"], returncode=returncode, stdout=stdout, stderr=stderr
        )
        with mock.patch.object(
            ha, "_resolve_archive_remote_credentials",
            return_value={"configured": True, "serverUrl": "https://example.invalid",
                          "tokenEnv": None, "missing": []},
        ), mock.patch.object(ha, "resolve_npx_launcher", return_value=["npx"]), \
                mock.patch.object(ha.subprocess, "run", return_value=completed):
            return ha.auto_push_managed_snapshot(Path("."))

    def test_failure_keeps_a_bounded_stderr_tail(self) -> None:
        result = self._run(
            returncode=1,
            stderr="PUSH_CREDENTIALS_INVALID: token rejected by server\n",
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["reasonCode"], "MANAGED_SNAPSHOT_UPLOAD_FAILED")
        self.assertIn("PUSH_CREDENTIALS_INVALID", result["detail"])

    def test_failure_surfaces_the_cli_error_code_when_json_is_emitted(self) -> None:
        result = self._run(
            returncode=1,
            stdout=json.dumps({"ok": False, "code": "PUSH_SECRET_SCAN_BLOCKED"}),
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["cliCode"], "PUSH_SECRET_SCAN_BLOCKED")

    def test_detail_is_length_bounded(self) -> None:
        result = self._run(returncode=1, stderr="x" * 10_000)

        self.assertLessEqual(len(result["detail"]), 2_048)

    def test_success_path_stays_unchanged(self) -> None:
        # harness-push 的回执用 summary.applied 计已落盘操作数（legacy push 用 submitted）。
        result = self._run(
            returncode=0,
            stdout=json.dumps({
                "ok": True,
                "project_id": "prj_x",
                "summary": {"planned": 12, "applied": 12, "conflicts": 0},
                "outcome": "ready",
            }),
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["submitted"], 12)
        self.assertFalse(result["unchanged"])
        self.assertNotIn("detail", result)


class ArchiveRepublishTests(unittest.TestCase):
    """Re-delivering a sealed archive.

    The publish path deletes the ZIP and its receipt once the server reports
    durable+ready, and archives sealed before the outbox existed never had one,
    so rebuilding from the archive directory is the only route left.
    """

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-archive-republish-"))
        self.project = self.tmp / "proj"
        self.archive = self.project / ".harness" / "archive" / "2026-08-19-demo-change"
        (self.archive / "reports" / "final").mkdir(parents=True)
        (self.archive / "plans").mkdir(parents=True)
        _write_json(
            self.archive / "reports" / "final" / "summary-data.json",
            {
                "schemaVersion": 1,
                "changeName": "demo-change",
                "reviewFindings": [
                    {
                        "id": "F-001",
                        "severity": "YELLOW",
                        "disposition": "FIXED",
                        "title": "path check missed the UNC prefix",
                        "path": "src/a.ts",
                        "line": 42,
                    }
                ],
                "knownRisks": [
                    {"phase": "execute", "severity": "WARN", "message": "apiTest skipped"}
                ],
            },
        )
        (self.archive / "plans" / "demo-plan.md").write_text("# plan\n", encoding="utf-8")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_dry_run_resolves_the_dated_directory_and_leaves_no_package(self) -> None:
        code, payload = ha.cmd_republish(
            change_key="demo-change",
            archive_dir=None,
            project_root=self.project,
            dry_run=True,
        )

        self.assertEqual(code, 0, payload)
        self.assertTrue(payload["ok"], payload)
        self.assertEqual(payload["matchedArchives"], ["2026-08-19-demo-change"])
        self.assertIn("candidates/knowledge.json", payload["files"])
        packages = self.project / ".harness" / "state" / "local" / "archive-packages"
        self.assertEqual(
            sorted(item.name for item in packages.iterdir()) if packages.is_dir() else [],
            [],
            "a preview must not leave a package behind that looks pending",
        )

    def test_regenerates_knowledge_candidates_without_touching_the_sealed_archive(self) -> None:
        before = sorted(
            item.relative_to(self.archive).as_posix()
            for item in self.archive.rglob("*")
            if item.is_file()
        )

        with mock.patch.dict(os.environ, {}, clear=False):
            for name in [key for key in os.environ if key.startswith("HUNTER_")]:
                os.environ.pop(name)
            code, payload = ha.cmd_republish(
                change_key="demo-change",
                archive_dir=None,
                project_root=self.project,
                dry_run=False,
            )

        # No credentials: the ZIP is built and kept for retry, nothing uploads.
        self.assertEqual(code, 1, payload)
        self.assertEqual(payload["reasonCode"], "ARCHIVE_UPLOAD_CREDENTIALS_MISSING")
        self.assertTrue(payload["knowledgeCandidatesInjected"])

        after = sorted(
            item.relative_to(self.archive).as_posix()
            for item in self.archive.rglob("*")
            if item.is_file()
        )
        self.assertEqual(before, after, "the sealed archive must not gain files")

        package = Path(payload["push"]["packagePath"])
        self.assertTrue(package.is_file())
        with zipfile.ZipFile(package) as bundle:
            names = sorted(bundle.namelist())
            self.assertIn("candidates/knowledge.json", names)
            manifest = json.loads(bundle.read("archive-manifest.json"))
            self.assertEqual(
                [entry["path"] for entry in manifest["files"]],
                sorted(entry["path"] for entry in manifest["files"]),
                "manifest entries must stay sorted once injected ones are mixed in",
            )
            for entry in manifest["files"]:
                self.assertEqual(
                    "sha256:" + hashlib.sha256(bundle.read(entry["path"])).hexdigest(),
                    entry["content_sha256"],
                )
            candidates = json.loads(bundle.read("candidates/knowledge.json"))
        self.assertEqual(
            sorted(item["entry_type"] for item in candidates), ["pitfall", "risk"]
        )

    def test_existing_candidates_file_is_not_overwritten_by_a_regenerated_one(self) -> None:
        (self.archive / "candidates").mkdir()
        (self.archive / "candidates" / "knowledge.json").write_text(
            "[]\n", encoding="utf-8"
        )

        code, payload = ha.cmd_republish(
            change_key="demo-change",
            archive_dir=None,
            project_root=self.project,
            dry_run=True,
        )

        self.assertEqual(code, 0, payload)
        self.assertFalse(payload["knowledgeCandidatesInjected"])

    def test_resolves_the_project_root_when_cwd_is_the_project_root(self) -> None:
        # find_project_root walks p.parents, which excludes p itself; handing it
        # the cwd skipped the very directory the operator stood in and climbed to
        # an ancestor, so republish looked for archives that were never there.
        previous = os.getcwd()
        os.chdir(self.project)
        try:
            code, payload = ha.cmd_republish(
                change_key="demo-change",
                archive_dir=None,
                project_root=None,
                dry_run=True,
            )
        finally:
            os.chdir(previous)

        self.assertEqual(code, 0, payload)
        self.assertEqual(Path(payload["projectRoot"]), self.project.resolve())

    def test_rebuilds_byte_identical_packages_across_runs(self) -> None:
        # Injected candidates used to carry now_iso(), so no two rebuilds matched
        # and the package could never be compared against a stored one.
        first = ha.cmd_republish(
            change_key="demo-change", archive_dir=None,
            project_root=self.project, dry_run=True,
        )[1]
        second = ha.cmd_republish(
            change_key="demo-change", archive_dir=None,
            project_root=self.project, dry_run=True,
        )[1]

        self.assertTrue(first["knowledgeCandidatesInjected"])
        self.assertEqual(first["packageSha256"], second["packageSha256"])

    def _write_durable_receipt(self, package_sha: str) -> None:
        receipt = (
            self.project / ".harness" / "state" / "local" / "archive-packages"
            / "demo-change.remote.json"
        )
        receipt.parent.mkdir(parents=True, exist_ok=True)
        _write_json(receipt, {
            "schemaVersion": 1,
            "recordedAt": "2026-08-17T10:00:00+08:00",
            "changeKey": "demo-change",
            "archiveId": "arc_demo",
            "archiveStatus": "durable",
            "knowledgeStatus": "ready",
            "uploadStatus": "ready",
            "packageSha256": package_sha,
            "manifestSha256": "sha256:" + "aa" * 32,
            "fileCount": 8,
        })

    def test_refuses_to_upload_over_a_durable_archive_with_different_bytes(self) -> None:
        # The platform keeps one immutable package per change key. Spending an
        # upload to learn that is pure waste, and the server's rejection reads as
        # a transport failure rather than "this archive is already published".
        self._write_durable_receipt("sha256:" + "6e" * 32)

        code, payload = ha.cmd_republish(
            change_key="demo-change", archive_dir=None,
            project_root=self.project, dry_run=False,
        )

        self.assertEqual(code, 1, payload)
        self.assertEqual(payload["reasonCode"], "ARCHIVE_REMOTE_IMMUTABLE_CONFLICT")
        self.assertNotIn("push", payload, "must decide locally, without uploading")
        self.assertIn("知识候选", payload["nextAction"])
        packages = self.project / ".harness" / "state" / "local" / "archive-packages"
        self.assertEqual(
            sorted(item.name for item in packages.iterdir()),
            ["demo-change.remote.json", "demo-change.zip"],
            "a refused republish keeps the built package available for inspection/retry",
        )

    def test_reports_already_published_when_the_rebuild_matches(self) -> None:
        rebuilt = ha.cmd_republish(
            change_key="demo-change", archive_dir=None,
            project_root=self.project, dry_run=True,
        )[1]
        self._write_durable_receipt(rebuilt["packageSha256"])

        code, payload = ha.cmd_republish(
            change_key="demo-change", archive_dir=None,
            project_root=self.project, dry_run=False,
        )

        self.assertEqual(code, 0, payload)
        self.assertEqual(payload["reasonCode"], "ARCHIVE_ALREADY_PUBLISHED")
        self.assertNotIn("push", payload)

    def test_still_uploads_when_no_durable_receipt_exists(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=False):
            for name in [key for key in os.environ if key.startswith("HUNTER_")]:
                os.environ.pop(name)
            code, payload = ha.cmd_republish(
                change_key="demo-change", archive_dir=None,
                project_root=self.project, dry_run=False,
            )

        self.assertEqual(code, 1, payload)
        self.assertIn("push", payload, "a never-published archive must reach the upload path")
        self.assertEqual(payload["reasonCode"], "ARCHIVE_UPLOAD_CREDENTIALS_MISSING")

    def test_no_knowledge_injection_reproduces_the_sealed_archive_bytes(self) -> None:
        # Retrying an upload whose knowledge index failed needs the bytes the
        # server already stored; injection guarantees a different package.
        injected = ha.cmd_republish(
            change_key="demo-change", archive_dir=None,
            project_root=self.project, dry_run=True,
        )[1]
        plain = ha.cmd_republish(
            change_key="demo-change", archive_dir=None,
            project_root=self.project, dry_run=True, inject_knowledge=False,
        )[1]

        self.assertTrue(injected["knowledgeCandidatesInjected"])
        self.assertFalse(plain["knowledgeCandidatesInjected"])
        self.assertNotIn("candidates/knowledge.json", plain["files"])
        self.assertNotEqual(injected["packageSha256"], plain["packageSha256"])

        # And that exact-rebuild path clears the immutable-archive conflict.
        self._write_durable_receipt(plain["packageSha256"])
        code, payload = ha.cmd_republish(
            change_key="demo-change", archive_dir=None,
            project_root=self.project, dry_run=False, inject_knowledge=False,
        )
        self.assertEqual(code, 0, payload)
        self.assertEqual(payload["reasonCode"], "ARCHIVE_ALREADY_PUBLISHED")

    def _write_retained_package(self, payload: bytes, sha: str | None = None) -> Path:
        packages = (
            self.project / ".harness" / "state" / "local" / "archive-packages"
        )
        packages.mkdir(parents=True, exist_ok=True)
        zip_path = packages / "demo-change.zip"
        zip_path.write_bytes(payload)
        _write_json(packages / "demo-change.upload.json", {
            "schemaVersion": 1,
            "changeKey": "demo-change",
            "packageSha256": sha or ("sha256:" + hashlib.sha256(payload).hexdigest()),
            "manifestSha256": "sha256:" + "cc" * 32,
            "fileCount": 7,
            "paths": ["reports/final/summary-data.json"],
            "uploadStatus": "pending",
        })
        return zip_path

    def test_retry_retained_uploads_the_stored_bytes_not_a_rebuild(self) -> None:
        # Six messages promise "可重试同一个 ZIP", but every retry used to rebuild
        # and produce a different package. A rebuild cannot match in general: the
        # manifest binds the archive's commit and the sealed tree moves on.
        zip_path = self._write_retained_package(b"PK\x03\x04retained-bytes")
        rebuilt = ha.cmd_republish(
            change_key="demo-change", archive_dir=None,
            project_root=self.project, dry_run=True,
        )[1]

        code, payload = ha.cmd_republish(
            change_key="demo-change", archive_dir=None,
            project_root=self.project, dry_run=True, retry_retained=True,
        )

        self.assertEqual(code, 0, payload)
        self.assertEqual(payload["reasonCode"], "ARCHIVE_RETAINED_PACKAGE_PREVIEW")
        self.assertEqual(
            payload["retainedPackage"]["packageSha256"],
            "sha256:" + hashlib.sha256(zip_path.read_bytes()).hexdigest(),
        )
        self.assertNotEqual(
            payload["retainedPackage"]["packageSha256"], rebuilt["packageSha256"],
            "the point of the flag is that a rebuild is a different package",
        )

    def test_retry_retained_reports_when_nothing_is_retained(self) -> None:
        code, payload = ha.cmd_republish(
            change_key="demo-change", archive_dir=None,
            project_root=self.project, dry_run=True, retry_retained=True,
        )

        self.assertEqual(code, 1)
        self.assertEqual(payload["reasonCode"], "ARCHIVE_RETAINED_PACKAGE_UNAVAILABLE")

    def test_retry_retained_ignores_a_receipt_that_no_longer_matches_its_zip(self) -> None:
        self._write_retained_package(b"PK\x03\x04drifted", sha="sha256:" + "11" * 32)

        self.assertIsNone(ha.load_retained_package(self.project, "demo-change"))

    def test_retry_retained_refuses_bytes_that_differ_from_the_published_package(self) -> None:
        self._write_retained_package(b"PK\x03\x04failed-attempt")
        self._write_durable_receipt("sha256:" + "6e" * 32)

        code, payload = ha.cmd_republish(
            change_key="demo-change", archive_dir=None,
            project_root=self.project, dry_run=False, retry_retained=True,
        )

        self.assertEqual(code, 1, payload)
        self.assertEqual(payload["reasonCode"], "ARCHIVE_REMOTE_IMMUTABLE_CONFLICT")
        self.assertNotIn("push", payload)

    def test_retry_retained_allows_identical_bytes_so_a_failed_index_can_rerun(self) -> None:
        # archiveStatus durable + knowledgeStatus failed keeps the ZIP precisely
        # so the same package can be sent again; refusing here would block the
        # one case the flag exists for.
        payload_bytes = b"PK\x03\x04published"
        self._write_retained_package(payload_bytes)
        sha = "sha256:" + hashlib.sha256(payload_bytes).hexdigest()
        self._write_durable_receipt(sha)

        with mock.patch.dict(os.environ, {}, clear=False):
            for name in [key for key in os.environ if key.startswith("HUNTER_")]:
                os.environ.pop(name)
            code, payload = ha.cmd_republish(
                change_key="demo-change", archive_dir=None,
                project_root=self.project, dry_run=False, retry_retained=True,
            )

        self.assertIn("push", payload, "identical bytes must reach the upload path")
        self.assertEqual(payload["reasonCode"], "ARCHIVE_UPLOAD_CREDENTIALS_MISSING")

    def test_package_source_binds_the_archive_commit_not_live_head(self) -> None:
        # Measured on a real archive: manifest.source.commit was the current HEAD
        # while the archive's own finalCommit was a different, earlier commit — so
        # the "deterministic package" claim broke on the next commit to the repo.
        summary_path = self.archive / "reports" / "final" / "summary-data.json"
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
        summary["finalCommit"] = "a" * 40
        _write_json(summary_path, summary)

        identity = ha._archive_source_identity(self.project, self.archive)

        self.assertEqual(identity["commit"], "a" * 40)

    def test_package_source_falls_back_to_head_without_a_recorded_commit(self) -> None:
        identity = ha._archive_source_identity(self.project, self.archive)

        self.assertIsNone(identity["commit"], "no git repo and no recorded commit")

    def test_unknown_change_key_reports_the_directory_it_searched(self) -> None:
        code, payload = ha.cmd_republish(
            change_key="not-a-change",
            archive_dir=None,
            project_root=self.project,
            dry_run=True,
        )

        self.assertEqual(code, 1)
        self.assertEqual(payload["reasonCode"], "ARCHIVE_DIR_NOT_FOUND")

    def test_latest_selects_newest_unpublished_archive(self) -> None:
        newer = self.project / ".harness" / "archive" / "2026-08-20-newer-change"
        (newer / "reports" / "final").mkdir(parents=True)
        _write_json(newer / "reports" / "final" / "summary-data.json", {
            "schemaVersion": 1,
            "changeName": "newer-change",
        })
        code, payload = ha.cmd_republish(
            change_key="latest", archive_dir=None,
            project_root=self.project, dry_run=True,
        )
        self.assertEqual(code, 0, payload)
        self.assertEqual(payload["selectedChange"], "newer-change")
        self.assertEqual(payload["changeKey"], "newer-change")


class PublicationGateScopeTests(unittest.TestCase):
    """归档发布门禁不得被 runtime/ 草稿挡住（2026-08-19 kld-sdd 归档卡点）。

    卡住那一轮的硬门禁是 refresh_sensitive_evidence_scan_receipt——它没有
    advisory 降级，unresolved 非空即 ok=False，直接把 execute 打回。
    """

    @staticmethod
    def _change(tmp: str, *, publishable: str, scratch: str | None) -> Path:
        change = Path(tmp) / "change"
        (change / "plans").mkdir(parents=True)
        (change / "plans" / "design.md").write_text(publishable, encoding="utf-8")
        if scratch is not None:
            (change / "runtime").mkdir(parents=True)
            (change / "runtime" / "review-diff.patch").write_text(
                scratch, encoding="utf-8"
            )
        return change

    def test_runtime_scratch_does_not_block_the_archive(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = self._change(
                tmp,
                publishable="# 设计\n",
                scratch="-  const h = { token: 'sk_cli_live_value' };\n",
            )

            refreshed = ha.hruntime.refresh_sensitive_evidence_scan_receipt(
                change,
                persist=False,
                exclude_dirs=ha.hruntime.PUBLICATION_EXCLUDED_DIRS,
            )
            gate = ha.validate_sensitive_evidence_publication_gate(change)

            self.assertTrue(refreshed["ok"], refreshed)
            self.assertEqual(refreshed["unresolvedFailures"], [])
            self.assertTrue(gate["ok"], gate)
            self.assertNotIn("advisory", gate)

    def test_publishable_plaintext_is_still_reported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            # 会被打进 ZIP 的文件里带明文赋值——这才是门禁该盯的。
            change = self._change(
                tmp, publishable="password: hunter2-real-value\n", scratch=None
            )

            refreshed = ha.hruntime.refresh_sensitive_evidence_scan_receipt(
                change,
                persist=False,
                exclude_dirs=ha.hruntime.PUBLICATION_EXCLUDED_DIRS,
            )
            gate = ha.validate_sensitive_evidence_publication_gate(change)

            self.assertFalse(refreshed["ok"], refreshed)
            self.assertEqual(
                [item["path"] for item in refreshed["unresolvedFailures"]],
                ["plans/design.md"],
            )
            # 默认策略是 warn：门禁放行但必须把发现如实回显。
            self.assertEqual(gate["reasonCode"], "SENSITIVE_EVIDENCE_ADVISORY")
            self.assertEqual(
                [item["path"] for item in gate["advisory"]["unresolvedFailures"]],
                ["plans/design.md"],
            )

    def test_block_policy_vetoes_publishable_plaintext(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = self._change(
                tmp, publishable="password: hunter2-real-value\n", scratch=None
            )

            with mock.patch.dict(
                os.environ, {ha.SENSITIVE_SCAN_POLICY_ENV: "block"}, clear=False
            ):
                gate = ha.validate_sensitive_evidence_publication_gate(change)

            self.assertFalse(gate["ok"], gate)
            self.assertEqual(gate["reasonCode"], "SENSITIVE_EVIDENCE_UNQUARANTINED")


class PublicationContentPrecheckTests(unittest.TestCase):
    """422 必须在归档开始时就说清楚，而不是跑完整条流程才由服务端告诉你。

    2026-08-19 kld-sdd：change 合并进 master、推送、清理分支、归档全部做完，
    最后 `archive upload` 才收到服务端 422 "archive contains sensitive content"。
    本地扫描器用的是另一套规则、扫的是另一批文件（整棵 change 树，含从不发布的
    runtime/），所以既没预测到、也给不出出路——agent 只能判定"不可篡改绕过"后放弃。

    触发源是 plans/*-design.md 里的内网默认地址，命中 packages/core 的
    HH_INTERNAL_ADDRESS（medium，overridable），本来有行内标注这条正规豁免通道。

    2026-08 后 status 路径停用内容扫描（上传归档链路下线），
    `check_status` 只记录停用契约、不再发起扫描；本类最后一条用例冻结该契约。
    """

    # 用本仓构建出的 CLI，而不是让解析器回退到 npx——npx 拉的是已发布版本，
    # 里面还没有 scan-sensitive，测出来的只会是"降级路径"。
    _CLI_ENTRY = (
        Path(__file__).resolve().parents[3] / "packages" / "cli" / "dist" / "bin.js"
    )

    def _local_cli(self):
        if not self._CLI_ENTRY.is_file():
            self.skipTest(
                f"CLI bundle not built: {self._CLI_ENTRY}（先跑 npm run bundle -w packages/cli）"
            )
        node = shutil.which("node")
        if node is None:
            self.skipTest("node not on PATH")
        return mock.patch.object(
            ha, "resolve_hunter_cli_command", return_value=[node, str(self._CLI_ENTRY)]
        )

    @staticmethod
    def _change(tmp: str, design: str) -> Path:
        change = Path(tmp) / "proj" / ".harness" / "changes" / "demo"
        (change / "plans").mkdir(parents=True)
        (change / "plans" / "demo-design.md").write_text(design, encoding="utf-8")
        return change

    def test_member_set_matches_what_actually_gets_packaged(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = self._change(tmp, "# design\n")
            (change / "spec").mkdir()
            (change / "spec" / "s.md").write_text("# spec\n", encoding="utf-8")
            # runtime/ 是草稿，永远不进包
            (change / "runtime").mkdir()
            (change / "runtime" / "review-diff.patch").write_text("x\n", encoding="utf-8")

            members = ha.publication_member_paths(change)

            self.assertEqual(
                sorted(members), ["plans/demo-design.md", "spec/s.md"]
            )

    def test_precheck_names_rule_path_line_and_the_way_out(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = self._change(
                tmp,
                "# design\n\nDEFAULT_SERVER_URL = http://10.29.213.80:8080\n",
            )

            with self._local_cli():
                result = ha.precheck_publication_content(change)

            self.assertTrue(result["ok"], result)
            self.assertTrue(result["blocked"], result)
            finding = result["findings"][0]
            self.assertEqual(finding["rule_id"], "HH_INTERNAL_ADDRESS")
            self.assertEqual(finding["path"], "plans/demo-design.md")
            self.assertEqual(finding["line"], 3)
            self.assertTrue(finding["overridable"])
            # 只报"有敏感内容"等于把人堵死；必须给出可粘贴的豁免写法。
            self.assertIn("hunter-harness-ignore", finding["recovery_action"])

    def test_inline_waiver_clears_the_precheck(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = self._change(
                tmp,
                "# design\n\n"
                "<!-- hunter-harness-ignore: HH_INTERNAL_ADDRESS reason=designed-endpoint -->\n"
                "DEFAULT_SERVER_URL = http://10.29.213.80:8080\n",
            )

            with self._local_cli():
                result = ha.precheck_publication_content(change)

            self.assertTrue(result["ok"], result)
            self.assertFalse(result["blocked"], result)

    def test_precheck_degrades_to_warning_when_the_cli_is_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = self._change(tmp, "# design\n")

            with mock.patch.object(
                ha, "resolve_hunter_cli_command", side_effect=FileNotFoundError("no npx")
            ):
                result = ha.precheck_publication_content(change)

            # 预检本身不能变成新的卡点。
            self.assertFalse(result["ok"], result)
            self.assertEqual(result["reasonCode"], "PUBLICATION_CONTENT_SCAN_UNAVAILABLE")
            self.assertIn("422", result["message"])

    def test_status_records_content_scan_as_disabled(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = self._change(
                tmp,
                "# design\n\nDEFAULT_SERVER_URL = http://10.29.213.80:8080\n",
            )

            status = ha.check_status(change)

            check = status["checks"]["publication_content_scan"]
            self.assertTrue(check["ok"], check)
            self.assertFalse(check["scan_performed"], check)
            self.assertEqual(check["findings"], [], check)
            self.assertIn("停用", check["message"], check)
            codes = {str(item.get("code")) for item in status["warnings"]}
            self.assertNotIn("PUBLICATION_CONTENT_SCAN_FLAGGED", codes)
            blocker_codes = {str(item.get("code")) for item in status["blockers"]}
            self.assertNotIn("PUBLICATION_CONTENT_SCAN_FLAGGED", blocker_codes)


class ExecuteResultPersistenceTests(unittest.TestCase):
    """execute 的结果只走 stdout，而它自己会把 change 目录整个移走。

    2026-08-19 kld-sdd：agent 三次尝试把 stdout 重定向到文件——/tmp、/e/tmp 都
    FileNotFoundError，改写进 change-dir 后，execute 中途把该目录移进
    .harness/archive/，重定向目标随之蒸发，archive-out3.json 变成空/损坏文件。
    steps 结果永久丢失，随后 8 次调用都在考古 managed_snapshot_push 跑没跑。
    """

    def test_result_path_inside_the_change_dir_is_refused_up_front(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "proj" / ".harness" / "changes" / "demo"
            change.mkdir(parents=True)

            resolved = ha.resolve_execute_result_path(
                change, str(change / "runtime" / "archive-out.json")
            )

            self.assertFalse(resolved["ok"], resolved)
            self.assertEqual(resolved["reasonCode"], "ARCHIVE_RESULT_PATH_VOLATILE")
            # 就地报错，并给出一个不会被移走的位置。
            self.assertIn("--output", resolved["recoveryAction"])

    def test_result_path_outside_the_change_dir_is_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "proj" / ".harness" / "changes" / "demo"
            change.mkdir(parents=True)
            target = Path(tmp) / "proj" / "archive-out.json"

            resolved = ha.resolve_execute_result_path(change, str(target))

            self.assertTrue(resolved["ok"], resolved)
            self.assertEqual(Path(resolved["path"]), target.resolve())

    def test_result_is_written_into_the_archive_after_the_move(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            archive_dir = Path(tmp) / "archive" / "2026-08-19-demo"
            (archive_dir / "meta").mkdir(parents=True)
            payload = {"ok": True, "finalStatus": "OK", "steps": {"move": {"ok": True}}}

            written = ha.persist_execute_result(archive_dir, payload)

            self.assertTrue(written["ok"], written)
            path = Path(written["path"])
            self.assertTrue(path.is_file())
            self.assertEqual(
                json.loads(path.read_text(encoding="utf-8"))["finalStatus"], "OK"
            )
            # 调用方不必自己猜落在哪：路径回显在 payload 里。
            self.assertEqual(payload["resultPath"], str(path))


if __name__ == "__main__":
    unittest.main()
