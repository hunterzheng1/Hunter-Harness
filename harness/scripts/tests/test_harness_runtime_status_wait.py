#!/usr/bin/env python3
"""run-status 的终态可判性与阻塞等待。

背景（2026-08-18 fixback 执行日志）：一次 mvn 编译会话在启动阶段就以
INCOMPLETE/LAUNCHER_FAILED 终止，但调用方连等 20s、60s 仍在盲等——因为
"INCOMPLETE" 读起来像"还没结束"，而返回体里没有任何字段说明它已经是终态。
同一次执行里还出现 Start-Sleep 5/20/60/100 四次猜时长的轮询。

这两件事都是接口缺口，不是调用方不小心：
- 终态与否只存在于脚本内部的 RUN_TERMINAL_STATUSES，从未出现在输出里；
- 没有阻塞等待入口，调用方只能猜一个 sleep 时长再查。
"""
from __future__ import annotations

import datetime as dt
import importlib.util
import sys
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS_DIR = Path(__file__).resolve().parents[1]


def load_module(name: str, filename: str):
    path = SCRIPTS_DIR / filename
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


runtime = load_module("harness_runtime_status_wait", "harness_runtime.py")


def _receipt(status: str, **extra: object) -> dict:
    base = {
        "sessionId": "run-demo",
        "status": status,
        "reasonCode": extra.pop("reasonCode", None),
        "workerPid": 0,
        "workerIdentity": None,
    }
    base.update(extra)
    return base


class RunStatusTerminalFlagTests(unittest.TestCase):
    def test_terminal_statuses_are_reported_as_terminal(self) -> None:
        # INCOMPLETE 是终态。它读起来最像"未完成"，也正是日志里被误当成
        # "还在跑"而白等 80 秒的那一个。
        for status in ("OK", "FAIL", "INCOMPLETE", "CANCELLED"):
            with mock.patch.object(runtime, "_load_run_receipt", return_value=_receipt(status)):
                result = runtime.run_session_status(Path("."), "run-demo")
            self.assertIs(result.get("terminal"), True, status)

    def test_launcher_failure_is_terminal_and_carries_actionable_reason(self) -> None:
        receipt = _receipt(
            "INCOMPLETE",
            reasonCode="LAUNCHER_FAILED",
            testProcessStarted=False,
        )
        with mock.patch.object(runtime, "_load_run_receipt", return_value=receipt):
            result = runtime.run_session_status(Path("."), "run-demo")

        self.assertIs(result["terminal"], True)
        self.assertEqual(result["reasonCode"], "LAUNCHER_FAILED")
        # 启动就失败时必须说清"进程从未起来"，否则调用方会当成超时继续等。
        self.assertIs(result.get("testProcessStarted"), False)
        self.assertIn("terminalHint", result)
        self.assertIn("未能启动", result["terminalHint"])

    def test_running_session_is_not_terminal(self) -> None:
        # 真正在跑的会话有新鲜心跳；心跳缺失会被判定为 HEARTBEAT_LOST 终态，
        # 那是另一条正确路径，不能拿来验证"运行中"。
        running = _receipt(
            "RUNNING",
            reasonCode="CHILD_RUNNING",
            lastHeartbeatAt=dt.datetime.now().astimezone().isoformat(),
            heartbeatSeconds=30.0,
            workerPid=1234,
            workerIdentity={
                "startedAt": "2026-07-31T00:00:00+00:00",
                "executable": sys.executable,
            },
        )
        with (
            mock.patch.object(runtime, "_load_run_receipt", return_value=running),
            mock.patch("harness_service.verify_process_identity", return_value=True),
            mock.patch("harness_service.is_pid_alive", return_value=True),
        ):
            result = runtime.run_session_status(Path("."), "run-demo")
        self.assertEqual(result["status"], "RUNNING")
        self.assertIs(result.get("terminal"), False)

    def test_finalizing_is_not_terminal(self) -> None:
        # 收尾中：结果已定但 worker 尚未退出，调用方仍应继续等而不是取读数。
        receipt = _receipt(
            "OK",
            reasonCode="CHILD_EXIT_ZERO",
            workerPid=1234,
            workerIdentity={"startedAt": "2026-07-31T00:00:00+00:00", "executable": sys.executable},
        )
        with (
            mock.patch.object(runtime, "_load_run_receipt", return_value=receipt),
            mock.patch("harness_service.verify_process_identity", return_value=True),
            mock.patch("harness_service.is_pid_alive", return_value=True),
        ):
            result = runtime.run_session_status(Path("."), "run-demo")

        self.assertEqual(result["status"], "FINALIZING")
        self.assertIs(result.get("terminal"), False)


class RunStatusWaitTests(unittest.TestCase):
    def test_wait_returns_as_soon_as_the_session_reaches_a_terminal_status(self) -> None:
        # await 的职责只有"循环到终态"，状态判定由 run_session_status 负责，
        # 因此在标注层打桩，不掺入存活性分析。
        pages = [
            {"status": "STARTING", "terminal": False},
            {"status": "RUNNING", "terminal": False},
            {"status": "RUNNING", "terminal": False},
            {"status": "OK", "terminal": True},
        ]
        calls: list[str] = []

        def fake_status(_root: Path, _session: str) -> dict:
            page = dict(pages[min(len(calls), len(pages) - 1)])
            calls.append(str(page["status"]))
            return page

        with (
            mock.patch.object(runtime, "run_session_status", side_effect=fake_status),
            mock.patch.object(runtime.time, "sleep", return_value=None),
        ):
            result = runtime.await_run_session(
                Path("."), "run-demo", timeout_seconds=30.0, poll_seconds=0.01
            )

        self.assertEqual(result["status"], "OK")
        self.assertIs(result["terminal"], True)
        self.assertIs(result["waitTimedOut"], False)
        # 一到终态就返回，不再多轮询——否则等待本身又成了新的浪费。
        self.assertEqual(len(calls), 4)

    def test_wait_gives_up_with_a_timeout_marker_instead_of_hanging(self) -> None:
        ticks = iter([0.0, 1.0, 2.0, 3.0, 99.0, 99.0])

        with (
            mock.patch.object(
                runtime,
                "run_session_status",
                return_value={"status": "RUNNING", "terminal": False},
            ),
            mock.patch.object(runtime.time, "sleep", return_value=None),
            mock.patch.object(runtime.time, "monotonic", side_effect=lambda: next(ticks)),
        ):
            result = runtime.await_run_session(
                Path("."), "run-demo", timeout_seconds=5.0, poll_seconds=0.01
            )

        self.assertIs(result["terminal"], False)
        self.assertIs(result["waitTimedOut"], True)
        self.assertEqual(result["status"], "RUNNING")


if __name__ == "__main__":
    unittest.main()
