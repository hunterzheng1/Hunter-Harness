#!/usr/bin/env python3
"""Tests for harness_events.py (P0-1)."""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
MODULE_PATH = SCRIPTS_DIR / "harness_events.py"


def load_module():
    spec = importlib.util.spec_from_file_location("harness_events", MODULE_PATH)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["harness_events"] = mod
    spec.loader.exec_module(mod)
    return mod


he = load_module()


class HarnessEventsTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        # Chinese path segment to verify Windows Unicode path support.
        self.change_dir = Path(self._tmpdir.name) / "变更-测试" / "change-demo"
        self.change_dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        self._tmpdir.cleanup()

    def _run(self, argv: list[str]) -> tuple[int, str, str]:
        from io import StringIO
        from contextlib import redirect_stdout, redirect_stderr

        out = StringIO()
        err = StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = he.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_append_atomic_and_auto_render_all_types(self) -> None:
        """10+ events covering all 7 types; auto-render <100 lines; atomic append."""
        events_file = self.change_dir / "events.ndjson"
        self.assertFalse(events_file.exists())

        sequence = [
            ["--phase", "plan", "--type", "phase.start", "--note", "开始规划"],
            [
                "--phase",
                "plan",
                "--type",
                "decision",
                "--decision",
                "采用方案A",
                "--reason",
                "风险更低",
            ],
            ["--phase", "plan", "--type", "phase.end", "--note", "规划完成"],
            ["--phase", "run", "--type", "phase.start"],
            [
                "--phase",
                "run",
                "--type",
                "command",
                "--command",
                "mvn -f module/pom.xml test -Dtest=Foo",
                "--exit-code",
                "0",
                "--duration-ms",
                "1200",
                "--note",
                "中文说明：GREEN 通过",
            ],
            [
                "--phase",
                "run",
                "--type",
                "command",
                "--command",
                "mvn -f module/pom.xml test -Dtest=Bar",
                "--exit-code",
                "0",
                "--duration-ms",
                "800",
                "--note",
                "连续命令折叠",
            ],
            [
                "--phase",
                "run",
                "--type",
                "command",
                "--command",
                "mvn -f module/pom.xml compile",
                "--exit-code",
                "0",
                "--duration-ms",
                "500",
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
            [
                "--phase",
                "run",
                "--type",
                "artifact",
                "--path",
                "evidence/verification-ledger.json",
                "--kind",
                "ledger",
            ],
            [
                "--phase",
                "run",
                "--type",
                "issue",
                "--code",
                "flake",
                "--severity",
                "warn",
                "--message",
                "偶发超时已重试成功",
            ],
            ["--phase", "run", "--type", "phase.end"],
            ["--phase", "test", "--type", "phase.start"],
            [
                "--phase",
                "test",
                "--type",
                "verification",
                "--name",
                "apiTest",
                "--status",
                "fail",
                "--reason",
                "setup 失败",
            ],
            ["--phase", "test", "--type", "phase.end"],
        ]

        for args in sequence:
            code, out, err = self._run(
                ["append", "--change-dir", str(self.change_dir), "--json", *args]
            )
            self.assertEqual(code, 0, msg=err)
            payload = json.loads(out)
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["event"]["schema_version"], 3)

        self.assertTrue(events_file.exists())
        raw = events_file.read_bytes()
        # UTF-8 without BOM
        self.assertFalse(raw.startswith(b"\xef\xbb\xbf"))
        lines = [
            ln for ln in events_file.read_text(encoding="utf-8").splitlines() if ln.strip()
        ]
        self.assertGreaterEqual(len(lines), 10)
        types = {json.loads(ln)["type"] for ln in lines}
        self.assertEqual(
            types,
            {
                "phase.start",
                "phase.end",
                "command",
                "verification",
                "artifact",
                "issue",
                "decision",
            },
        )

        # Atomic append: temp leftovers must not remain.
        leftovers = list(self.change_dir.glob(".events.ndjson.*.tmp"))
        self.assertEqual(leftovers, [])

        log_path = self.change_dir / "logs" / "execution-log.md"
        self.assertTrue(log_path.exists())
        log_text = log_path.read_text(encoding="utf-8")
        self.assertIn("自动渲染", log_text)
        self.assertIn("请勿手工编辑", log_text)
        self.assertIn("中文说明：GREEN 通过", log_text)
        self.assertLess(len(log_text.splitlines()), 100)
        # Consecutive commands collapsed into a markdown table.
        self.assertIn("| 命令 | exit | duration | note |", log_text)

    def test_render_idempotent(self) -> None:
        seed = [
            {"schema_version": 2, "id": "evt-a", "timestamp": "2026-07-10T01:00:00.000+08:00",
             "phase": "run", "type": "phase.start", "note": ""},
            {"schema_version": 2, "id": "evt-b", "timestamp": "2026-07-10T01:01:00.000+08:00",
             "phase": "run", "type": "command", "command": "echo hi", "exit_code": 0,
             "duration_ms": 10, "note": "你好"},
            {"schema_version": 2, "id": "evt-c", "timestamp": "2026-07-10T01:02:00.000+08:00",
             "phase": "run", "type": "phase.end", "note": ""},
        ]
        events_file = self.change_dir / "events.ndjson"
        events_file.write_text(
            "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in seed),
            encoding="utf-8",
        )

        code1, out1, err1 = self._run(
            ["render", "--change-dir", str(self.change_dir), "--json"]
        )
        self.assertEqual(code1, 0, msg=err1)
        log1 = (self.change_dir / "logs" / "execution-log.md").read_text(encoding="utf-8")

        code2, out2, err2 = self._run(
            ["render", "--change-dir", str(self.change_dir), "--json"]
        )
        self.assertEqual(code2, 0, msg=err2)
        log2 = (self.change_dir / "logs" / "execution-log.md").read_text(encoding="utf-8")
        self.assertEqual(log1, log2)

        # Direct API also stable.
        events = he.load_events(events_file)
        self.assertEqual(he.render_execution_log(events), he.render_execution_log(events))

    def test_schema_v1_v2_mixed_read(self) -> None:
        mixed = [
            {
                "schema_version": 1,
                "id": "evt-old",
                "timestamp": "2026-07-01T00:00:00.000Z",
                "phase": "run",
                "type": "phase.start",
            },
            {
                "schema_version": 1,
                "id": "evt-cmd",
                "timestamp": "2026-07-01T00:01:00.000Z",
                "phase": "run",
                "type": "command",
                "command": "npm test",
                "exit_code": 0,
                "duration_ms": 100,
            },
            {
                "schema_version": 2,
                "id": "evt-new",
                "timestamp": "2026-07-01T00:02:00.000Z",
                "phase": "run",
                "type": "phase.end",
                "note": "结束",
            },
        ]
        events_file = self.change_dir / "events.ndjson"
        events_file.write_text(
            "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in mixed),
            encoding="utf-8",
        )
        events = he.load_events(events_file)
        self.assertEqual(len(events), 3)
        # schema 1 missing note treated as empty
        self.assertEqual(events[0]["note"], "")
        self.assertEqual(events[1]["note"], "")
        self.assertEqual(events[2]["note"], "结束")

        code, _, err = self._run(["render", "--change-dir", str(self.change_dir), "--json"])
        self.assertEqual(code, 0, msg=err)
        log_text = (self.change_dir / "logs" / "execution-log.md").read_text(encoding="utf-8")
        self.assertIn("npm test", log_text)

    def test_chinese_note_and_summary_duration(self) -> None:
        seed = [
            {
                "schema_version": 2,
                "id": "evt-1",
                "timestamp": "2026-07-10T10:00:00.000+08:00",
                "phase": "run",
                "type": "phase.start",
                "note": "",
            },
            {
                "schema_version": 2,
                "id": "evt-2",
                "timestamp": "2026-07-10T10:00:30.000+08:00",
                "phase": "run",
                "type": "command",
                "command": "echo 中文",
                "exit_code": 0,
                "duration_ms": 5,
                "note": "验证中文路径与备注",
            },
            {
                "schema_version": 2,
                "id": "evt-3",
                "timestamp": "2026-07-10T10:01:00.000+08:00",
                "phase": "run",
                "type": "issue",
                "code": "x",
                "severity": "error",
                "message": "示例问题",
                "note": "",
            },
            {
                "schema_version": 2,
                "id": "evt-4",
                "timestamp": "2026-07-10T10:01:00.000+08:00",
                "phase": "run",
                "type": "phase.end",
                "note": "",
            },
        ]
        events_file = self.change_dir / "events.ndjson"
        events_file.write_text(
            "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in seed),
            encoding="utf-8",
        )

        code, out, err = self._run(
            ["summary", "--change-dir", str(self.change_dir), "--json"]
        )
        self.assertEqual(code, 0, msg=err)
        payload = json.loads(out)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["event_count"], 4)
        self.assertEqual(payload["phases"]["run"]["duration_ms"], 60_000)
        self.assertEqual(payload["phases"]["run"]["started_at"], seed[0]["timestamp"])
        self.assertEqual(payload["phases"]["run"]["ended_at"], seed[3]["timestamp"])
        self.assertEqual(len(payload["issues"]), 1)
        self.assertEqual(payload["issues"][0]["message"], "示例问题")

        code_r, _, err_r = self._run(
            ["render", "--change-dir", str(self.change_dir), "--json"]
        )
        self.assertEqual(code_r, 0, msg=err_r)
        log_text = (self.change_dir / "logs" / "execution-log.md").read_text(encoding="utf-8")
        self.assertIn("验证中文路径与备注", log_text)

    def test_schema3_provenance_and_repeated_phase_attempts(self) -> None:
        seed = [
            {"schema_version": 3, "id": "1", "timestamp": "2026-07-10T10:00:00+08:00",
             "phase": "test", "type": "phase.start", "attempt": 1,
             "executor_tool": "claude-code", "run_id": "run-a", "note": ""},
            {"schema_version": 3, "id": "2", "timestamp": "2026-07-10T10:01:00+08:00",
             "phase": "test", "type": "phase.end", "attempt": 1, "status": "fail", "note": ""},
            {"schema_version": 3, "id": "3", "timestamp": "2026-07-10T10:02:00+08:00",
             "phase": "test", "type": "phase.start", "attempt": 2,
             "executor_tool": "codex", "handoff_from_tool": "claude-code", "note": ""},
            {"schema_version": 3, "id": "4", "timestamp": "2026-07-10T10:05:00+08:00",
             "phase": "test", "type": "phase.end", "attempt": 2, "status": "ok", "note": ""},
        ]
        events_file = self.change_dir / "events.ndjson"
        events_file.write_text(
            "".join(json.dumps(event) + "\n" for event in seed), encoding="utf-8"
        )
        summary = he.build_summary(self.change_dir, he.load_events(events_file))
        phase = summary["phases"]["test"]
        self.assertEqual(phase["duration_ms"], 240_000)
        self.assertEqual(phase["status"], "ok")
        self.assertEqual([attempt["attempt"] for attempt in phase["attempts"]], [1, 2])
        self.assertEqual(phase["attempts"][1]["executor_tool"], "codex")
        rendered = he.render_execution_log(he.load_events(events_file))
        self.assertIn("test（尝试 1）", rendered)
        self.assertIn("test（尝试 2）", rendered)
        self.assertIn("claude-code → codex", rendered)

    def test_append_accepts_cross_tool_provenance(self) -> None:
        code, out, err = self._run([
            "append", "--change-dir", str(self.change_dir), "--json",
            "--phase", "run", "--type", "phase.start", "--attempt", "2",
            "--run-id", "run-2", "--executor-tool", "codex",
            "--executor-agent", "main", "--handoff-from-tool", "claude-code",
            "--handoff-reason", "continue implementation",
        ])
        self.assertEqual(code, 0, msg=err)
        event = json.loads(out)["event"]
        self.assertEqual(event["schema_version"], 3)
        self.assertEqual(event["attempt"], 2)
        self.assertEqual(event["executor_tool"], "codex")
        self.assertEqual(event["handoff_from_tool"], "claude-code")

    def test_atomic_append_helper_writes_after_temp_success(self) -> None:
        target = self.change_dir / "events.ndjson"
        line = json.dumps({"hello": "世界"}, ensure_ascii=False)
        he.atomic_append_line(target, line)
        he.atomic_append_line(target, line)
        content = target.read_text(encoding="utf-8")
        self.assertEqual(content.count("\n"), 2)
        self.assertIn("世界", content)
        self.assertEqual(list(self.change_dir.glob(".events.ndjson.*.tmp")), [])


def _mp_append_worker(change_dir: str, worker_id: int, per: int) -> None:
    """Module-level worker for multiprocess append (Windows spawn safe)."""
    for i in range(per):
        he.main(
            [
                "append",
                "--change-dir",
                change_dir,
                "--json",
                "--phase",
                "run",
                "--type",
                "command",
                "--command",
                f"w{worker_id}-c{i}",
                "--exit-code",
                "0",
                "--duration-ms",
                "1",
            ]
        )


class O1ConcurrentAppendTests(unittest.TestCase):
    """Task 4 (REMEDIATION-DESIGN §6): O(1) append, no full-history load;
    cross-process lock; render only on phase.end."""

    def setUp(self) -> None:
        self._tmpdir = tempfile.TemporaryDirectory()
        self.change_dir = Path(self._tmpdir.name) / "change-o1"
        self.change_dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        self._tmpdir.cleanup()

    def _run(self, argv: list[str]) -> tuple[int, str, str]:
        from io import StringIO
        from contextlib import redirect_stdout, redirect_stderr

        out = StringIO()
        err = StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = he.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_append_does_not_load_entire_history(self) -> None:
        # Pre-seed so events.ndjson exists (current impl loads history when the
        # file exists). Patch load_events to fail if anyone reads history.
        events_file = self.change_dir / "events.ndjson"
        events_file.write_text(
            json.dumps(
                {
                    "schema_version": 2,
                    "id": "evt-seed",
                    "timestamp": he.now_iso(),
                    "phase": "run",
                    "type": "phase.start",
                    "note": "",
                },
                ensure_ascii=False,
            )
            + "\n",
            encoding="utf-8",
        )
        from unittest import mock

        with mock.patch.object(
            he, "load_events", side_effect=AssertionError("must not load history on append")
        ):
            code, out, err = self._run(
                [
                    "append",
                    "--change-dir",
                    str(self.change_dir),
                    "--json",
                    "--phase",
                    "run",
                    "--type",
                    "command",
                    "--command",
                    "echo hi",
                    "--exit-code",
                    "0",
                    "--duration-ms",
                    "5",
                ]
            )
        self.assertEqual(code, 0, msg=err)
        self.assertTrue(json.loads(out)["ok"])

    def test_phase_end_renders_all_events(self) -> None:
        log_path = self.change_dir / "logs" / "execution-log.md"
        seq = [
            ["--phase", "run", "--type", "phase.start"],
            ["--phase", "run", "--type", "command", "--command", "cmd-alpha", "--exit-code", "0", "--duration-ms", "5"],
            ["--phase", "run", "--type", "command", "--command", "cmd-beta", "--exit-code", "0", "--duration-ms", "5"],
            ["--phase", "run", "--type", "command", "--command", "cmd-gamma", "--exit-code", "0", "--duration-ms", "5"],
        ]
        for args in seq:
            code, _, err = self._run(
                ["append", "--change-dir", str(self.change_dir), "--json", *args]
            )
            self.assertEqual(code, 0, msg=err)
        # 普通 append（phase.start / command）不渲染：最新 command 不应已进入 log。
        # 旧实现每次 append 都渲染 -> 此断言在旧实现上失败。
        latest_in_log = log_path.exists() and "cmd-gamma" in log_path.read_text(encoding="utf-8")
        self.assertFalse(latest_in_log, "command append must not render; only phase.end renders")

        code, _, err = self._run(
            [
                "append",
                "--change-dir",
                str(self.change_dir),
                "--json",
                "--phase",
                "run",
                "--type",
                "phase.end",
            ]
        )
        self.assertEqual(code, 0, msg=err)
        self.assertTrue(log_path.exists())
        log_text = log_path.read_text(encoding="utf-8")
        self.assertIn("cmd-alpha", log_text)
        self.assertIn("cmd-beta", log_text)
        self.assertIn("cmd-gamma", log_text)

    def test_multiprocess_append_keeps_all_events(self) -> None:
        import multiprocessing

        procs_n = 8
        per = 25
        total = procs_n * per
        children = []
        for w in range(procs_n):
            p = multiprocessing.Process(
                target=_mp_append_worker, args=(str(self.change_dir), w, per)
            )
            p.start()
            children.append(p)
        for p in children:
            p.join(timeout=180)
            self.assertFalse(p.is_alive(), f"worker {p.pid} hung")
        events = he.load_events(self.change_dir / "events.ndjson")
        self.assertEqual(len(events), total, "no events lost under concurrent append")
        ids = [e.get("id") for e in events]
        self.assertEqual(len(set(ids)), total, "event ids must be unique")

    def test_append_performance_not_linear(self) -> None:
        # §6.4 sanity gate: 500 command events; p95 < 1s; all 500 persisted.
        # O(1) is proven structurally by test_append_does_not_load_entire_history
        # (no load_events on append) -- at n=500 wall-time alone cannot distinguish
        # O(1) from O(n) because constant I/O overhead dominates the linear parse.
        import time

        durations: list[float] = []
        for i in range(500):
            t0 = time.perf_counter()
            code, _, err = self._run(
                [
                    "append",
                    "--change-dir",
                    str(self.change_dir),
                    "--json",
                    "--phase",
                    "run",
                    "--type",
                    "command",
                    "--command",
                    f"cmd-{i}",
                    "--exit-code",
                    "0",
                    "--duration-ms",
                    "1",
                ]
            )
            durations.append(time.perf_counter() - t0)
            self.assertEqual(code, 0, msg=err)

        sorted_d = sorted(durations)
        p95 = sorted_d[int(len(sorted_d) * 0.95)]
        self.assertLess(p95, 1.0, f"p95 append {p95:.3f}s > 1s")
        events = he.load_events(self.change_dir / "events.ndjson")
        self.assertEqual(len(events), 500)


if __name__ == "__main__":
    unittest.main()
