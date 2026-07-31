#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
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


runtime = load_module("harness_runtime", "harness_runtime.py")


class RuntimeDoctorTests(unittest.TestCase):
    def test_doctor_uses_absolute_current_python_when_path_lookup_is_empty(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(
            runtime.shutil, "which", return_value=None
        ):
            root = Path(tmp)
            change_dir = root / ".harness" / "changes" / "demo"

            result = runtime.doctor(root, change_dir, agent="codex")

            python = result["runtimes"]["python"]
            self.assertTrue(Path(python["executable"]).is_absolute())
            self.assertEqual(python["argvPrefix"], [python["executable"]])
            self.assertEqual(result["adapter"]["worktreeRoot"], ".worktrees")
            self.assertEqual(result["adapter"]["branchPrefix"], "harness/")
            capsule = json.loads(
                (change_dir / "meta" / "runtime.json").read_text(encoding="utf-8")
            )
            self.assertEqual(capsule["schemaVersion"], 1)
            self.assertTrue(capsule["capabilities"]["jsonRoundTrip"])

    def test_powershell_51_probe_never_uses_test_json(self) -> None:
        calls: list[list[str]] = []

        def fake_run(argv, **_kwargs):
            calls.append(list(argv))
            return subprocess.CompletedProcess(
                argv,
                0,
                stdout='{"edition":"Desktop","version":"5.1.19041.5608"}',
                stderr="",
            )

        result = runtime.probe_powershell(
            Path("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"),
            runner=fake_run,
        )

        self.assertEqual(result["edition"], "Desktop")
        self.assertTrue(result["version"].startswith("5.1"))
        self.assertNotIn("Test-Json", " ".join(calls[0]))
        self.assertEqual(result["jsonCapability"], "convert-to-json")

    def test_adapter_worktree_contract_is_unified_across_agents(self) -> None:
        expected = {
            "worktreeRoot": ".worktrees",
            "path": ".worktrees/runtime-plan",
            "branchPrefix": "harness/",
            "branch": "harness/runtime-plan",
        }
        for agent in ("codex", "claude-code", "cursor", "codebuddy"):
            result = runtime.adapter_worktree(agent, "runtime-plan")
            self.assertEqual(result["agent"], agent)
            for key, value in expected.items():
                self.assertEqual(result[key], value, f"{agent}.{key}")

    def test_adapter_worktree_all_agents_share_path_and_branch(self) -> None:
        results = [
            runtime.adapter_worktree(agent, "same-change")
            for agent in ("codex", "claude-code", "cursor", "codebuddy")
        ]
        paths = {r["path"] for r in results}
        branches = {r["branch"] for r in results}
        self.assertEqual(paths, {".worktrees/same-change"})
        self.assertEqual(branches, {"harness/same-change"})
        agents = {r["agent"] for r in results}
        self.assertEqual(agents, {"codex", "claude-code", "cursor", "codebuddy"})

    def test_adapter_rejects_path_like_change_id(self) -> None:
        with self.assertRaisesRegex(ValueError, "ADAPTER_CHANGE_ID_INVALID"):
            runtime.adapter_worktree("codex", "../escape")


class ManagedRunSessionTests(unittest.TestCase):
    def _wait_for_terminal(
        self,
        state_root: Path,
        session_id: str,
        *,
        timeout: float = 15.0,
    ) -> dict:
        status_fn = getattr(runtime, "run_session_status", None)
        self.assertTrue(callable(status_fn), "run_session_status must be implemented")
        deadline = time.monotonic() + timeout
        result: dict = {}
        while time.monotonic() < deadline:
            result = status_fn(state_root, session_id)
            if result.get("status") in {"OK", "FAIL", "INCOMPLETE", "CANCELLED"}:
                return result
            time.sleep(0.05)
        self.fail(f"run session did not finish: {result}")

    def test_detached_session_supports_unicode_paths_incremental_logs_and_receipt(
        self,
    ) -> None:
        start_fn = getattr(runtime, "start_run_session", None)
        read_log_fn = getattr(runtime, "read_run_session_log", None)
        self.assertTrue(callable(start_fn), "start_run_session must be implemented")
        self.assertTrue(callable(read_log_fn), "read_run_session_log must be implemented")
        with tempfile.TemporaryDirectory(prefix="harness runtime 空格 ") as tmp:
            root = Path(tmp)
            state_root = root / "状态 目录"
            result = start_fn(
                state_root=state_root,
                verification="unitTestFull",
                argv=[
                    sys.executable,
                    "-c",
                    "print('第一行'); print('第二行')",
                ],
                working_directory=root,
                environment={"HARNESS_TEST_SECRET": "never-write-this"},
                heartbeat_seconds=0.05,
                expected_duration_seconds=2,
            )
            self.assertEqual(result["status"], "STARTING")
            session_id = result["sessionId"]
            terminal = self._wait_for_terminal(state_root, session_id)
            worker_log = Path(terminal["workerLogPath"])
            detail = {
                **terminal,
                "workerLog": (
                    worker_log.read_text(encoding="utf-8", errors="replace")
                    if worker_log.is_file()
                    else "missing"
                ),
            }
            self.assertEqual(terminal["status"], "OK", detail)
            self.assertEqual(terminal["exitCode"], 0)
            self.assertEqual(terminal["verification"], "unitTestFull")
            self.assertTrue(
                {"prepare", "spawn", "execute", "summarize", "record"}
                <= {item["stage"] for item in terminal["stageTimings"]}
            )
            self.assertIn("commandHash", terminal)
            self.assertIn("environmentHash", terminal)
            self.assertNotIn("never-write-this", json.dumps(terminal))

            first = read_log_fn(
                state_root,
                session_id,
                stream="stdout",
                cursor=0,
                max_bytes=12,
            )
            second = read_log_fn(
                state_root,
                session_id,
                stream="stdout",
                cursor=first["nextCursor"],
                max_bytes=4096,
            )
            self.assertGreater(first["nextCursor"], 0)
            self.assertNotEqual(first["text"], second["text"])
            self.assertIn("第一行", first["text"] + second["text"])
            self.assertIn("第二行", first["text"] + second["text"])
            self.assertTrue(second["eof"])

    def test_launcher_failure_is_not_reported_as_test_failure(self) -> None:
        start_fn = getattr(runtime, "start_run_session", None)
        self.assertTrue(callable(start_fn), "start_run_session must be implemented")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = start_fn(
                state_root=root,
                verification="browser",
                argv=[str(root / "missing executable")],
                working_directory=root,
                heartbeat_seconds=0.05,
            )
            terminal = self._wait_for_terminal(root, result["sessionId"])
            self.assertEqual(terminal["status"], "INCOMPLETE")
            self.assertEqual(terminal["reasonCode"], "LAUNCHER_FAILED")
            self.assertIsNone(terminal["exitCode"])
            self.assertFalse(terminal["testProcessStarted"])

    def test_resource_locks_are_exclusive_and_released_after_cancel(self) -> None:
        start_fn = getattr(runtime, "start_run_session", None)
        cancel_fn = getattr(runtime, "cancel_run_session", None)
        status_fn = getattr(runtime, "run_session_status", None)
        self.assertTrue(callable(start_fn))
        self.assertTrue(callable(cancel_fn))
        self.assertTrue(callable(status_fn))
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(
            os.environ,
            {"HARNESS_RESOURCE_LOCK_ROOT": str(Path(tmp) / "global-locks")},
        ):
            root = Path(tmp)
            first = start_fn(
                state_root=root,
                verification="integration",
                argv=[sys.executable, "-c", "import time; time.sleep(30)"],
                working_directory=root,
                heartbeat_seconds=0.05,
                resource_locks=["db:integration"],
            )
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                current = status_fn(root, first["sessionId"])
                if current.get("status") == "RUNNING":
                    break
                time.sleep(0.05)
            self.assertEqual(current.get("status"), "RUNNING", current)

            blocked = start_fn(
                state_root=root,
                verification="integration",
                argv=[sys.executable, "-c", "print('must not run')"],
                working_directory=root,
                heartbeat_seconds=0.05,
                resource_locks=["db:integration"],
            )
            self.assertEqual(blocked["status"], "INCOMPLETE")
            self.assertEqual(blocked["reasonCode"], "RESOURCE_LOCK_BUSY")
            self.assertFalse(blocked["testProcessStarted"])

            cancel_result = cancel_fn(root, first["sessionId"])
            self.assertTrue(cancel_result["ok"], cancel_result)
            cancelled = self._wait_for_terminal(root, first["sessionId"])
            self.assertEqual(cancelled["status"], "CANCELLED", cancelled)

            third = start_fn(
                state_root=root,
                verification="integration",
                argv=[sys.executable, "-c", "print('released')"],
                working_directory=root,
                heartbeat_seconds=0.05,
                resource_locks=["db:integration"],
            )
            terminal = self._wait_for_terminal(root, third["sessionId"])
            self.assertEqual(terminal["status"], "OK", terminal)

    def test_resource_locks_are_exclusive_across_state_roots(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(
            os.environ,
            {"HARNESS_RESOURCE_LOCK_ROOT": str(Path(tmp) / "global-locks")},
        ):
            root = Path(tmp)
            first_state = root / "change-a"
            second_state = root / "change-b"
            first = runtime.start_run_session(
                state_root=first_state,
                verification="integration",
                argv=[sys.executable, "-c", "import time; time.sleep(30)"],
                working_directory=root,
                heartbeat_seconds=0.05,
                resource_locks=["db:shared"],
            )
            deadline = time.monotonic() + 10
            current: dict = {}
            while time.monotonic() < deadline:
                current = runtime.run_session_status(first_state, first["sessionId"])
                if current.get("status") == "RUNNING":
                    break
                time.sleep(0.05)
            self.assertEqual(current.get("status"), "RUNNING", current)

            blocked = runtime.start_run_session(
                state_root=second_state,
                verification="integration",
                argv=[sys.executable, "-c", "print('must not run')"],
                working_directory=root,
                heartbeat_seconds=0.05,
                resource_locks=["db:shared"],
            )
            self.assertEqual(blocked["reasonCode"], "RESOURCE_LOCK_BUSY")
            runtime.cancel_run_session(first_state, first["sessionId"])
            self._wait_for_terminal(first_state, first["sessionId"])

    def test_dead_resource_lock_owner_is_reclaimed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(
            os.environ,
            {"HARNESS_RESOURCE_LOCK_ROOT": str(Path(tmp) / "global-locks")},
        ):
            root = Path(tmp)
            lock_path = runtime._resource_lock_path(root, "db:stale")
            lock_path.parent.mkdir(parents=True)
            lock_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 2,
                        "lockName": "db:stale",
                        "sessionId": "dead-session",
                        "token": "dead-token",
                        "acquiredAt": "2026-01-01T00:00:00+00:00",
                        "heartbeatAtUnix": 1,
                        "expiresAtUnix": 2,
                        "owner": {
                            "pid": 2147483647,
                            "startedAt": "2026-01-01T00:00:00+00:00",
                            "executable": str(Path(sys.executable).resolve()),
                        },
                    }
                ),
                encoding="utf-8",
            )

            started = runtime.start_run_session(
                state_root=root / "state",
                verification="integration",
                argv=[sys.executable, "-c", "print('reclaimed')"],
                working_directory=root,
                heartbeat_seconds=0.05,
                resource_locks=["db:stale"],
            )
            terminal = self._wait_for_terminal(root / "state", started["sessionId"])
            self.assertEqual(terminal["status"], "OK", terminal)

    def test_windows_job_does_not_allow_descendant_breakaway(self) -> None:
        source = (SCRIPTS_DIR / "harness_test_runner.py").read_text(encoding="utf-8")
        self.assertNotIn("_JOB_OBJECT_LIMIT_BREAKAWAY_OK", source)

    def test_timeout_writes_diagnostics_before_bounded_termination(self) -> None:
        start_fn = getattr(runtime, "start_run_session", None)
        self.assertTrue(callable(start_fn), "start_run_session must be implemented")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = start_fn(
                state_root=root,
                verification="performance",
                argv=[sys.executable, "-c", "import time; time.sleep(30)"],
                working_directory=root,
                timeout_seconds=0.2,
                heartbeat_seconds=0.05,
            )
            terminal = self._wait_for_terminal(root, result["sessionId"])
            self.assertEqual(terminal["status"], "CANCELLED")
            self.assertEqual(terminal["reasonCode"], "TIMEOUT")
            diagnostic_path = Path(terminal["diagnosticPath"])
            self.assertTrue(diagnostic_path.is_file())
            diagnostic = json.loads(diagnostic_path.read_text(encoding="utf-8"))
            self.assertEqual(diagnostic["reasonCode"], "TIMEOUT")
            self.assertTrue(diagnostic["processIdentityVerified"])


if __name__ == "__main__":
    unittest.main()
