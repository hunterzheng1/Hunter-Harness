#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import hashlib
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
test_runner = load_module("harness_test_runner_for_runtime", "harness_test_runner.py")


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
    def _write_log_receipt(
        self,
        state_root: Path,
        session_id: str = "run-log-fixture",
        *,
        status: str = "OK",
    ) -> tuple[Path, Path]:
        session_root = runtime._run_session_root(state_root, session_id)
        session_root.mkdir(parents=True, exist_ok=True)
        stdout_path = session_root / "stdout.log"
        stderr_path = session_root / "stderr.log"
        runtime._write_run_receipt(
            state_root,
            {
                "schemaVersion": 1,
                "sessionId": session_id,
                "status": status,
                "reasonCode": "CHILD_EXIT_ZERO",
                "exitCode": 0 if status == "OK" else None,
                "resultDigest": "sha256:" + "0" * 64,
                "workerPid": None,
                "workerIdentity": None,
                "lastHeartbeatAt": runtime.now_iso(),
                "heartbeatSeconds": 1,
                "stdoutPath": str(stdout_path),
                "stderrPath": str(stderr_path),
                "cleanupStatus": "PROCESS_EXITED",
            },
        )
        return stdout_path, stderr_path

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

    def test_terminal_receipt_waits_for_worker_process_to_exit(self) -> None:
        receipt = {
            "sessionId": "run-finalizing",
            "status": "OK",
            "reasonCode": "CHILD_EXIT_ZERO",
            "workerPid": 1234,
            "workerIdentity": {
                "startedAt": "2026-07-31T00:00:00+00:00",
                "executable": sys.executable,
            },
        }
        with (
            mock.patch.object(runtime, "_load_run_receipt", return_value=receipt),
            mock.patch(
                "harness_service.verify_process_identity",
                return_value=True,
            ),
            mock.patch("harness_service.is_pid_alive", return_value=True),
        ):
            finalizing = runtime.run_session_status(Path("."), "run-finalizing")

        self.assertEqual(finalizing["status"], "FINALIZING")
        self.assertEqual(finalizing["reasonCode"], "WORKER_FINALIZING")
        self.assertEqual(receipt["status"], "OK")

        with (
            mock.patch.object(runtime, "_load_run_receipt", return_value=receipt),
            mock.patch(
                "harness_service.verify_process_identity",
                return_value=False,
            ),
            mock.patch("harness_service.is_pid_alive", return_value=False),
        ):
            terminal = runtime.run_session_status(Path("."), "run-finalizing")

        self.assertEqual(terminal["status"], "OK")

    def test_reads_utf8_logs_by_byte_cursor_safely(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stdout_path, _ = self._write_log_receipt(root)
            stdout_path.write_bytes("甲乙丙".encode("utf-8"))

            first = runtime.read_run_session_log(
                root,
                "run-log-fixture",
                stream="stdout",
                cursor=0,
                max_bytes=4,
            )
            second = runtime.read_run_session_log(
                root,
                "run-log-fixture",
                stream="stdout",
                cursor=first["nextCursor"],
                max_bytes=64,
            )

            self.assertEqual(first["text"], "甲")
            self.assertEqual(second["text"], "乙丙")
            self.assertEqual(first["decodeStatus"], "OK")
            self.assertEqual(second["decodeStatus"], "OK")
            self.assertEqual(
                first["rawDigest"],
                "sha256:" + hashlib.sha256("甲".encode("utf-8")).hexdigest(),
            )
            self.assertEqual(first["nextCursor"], len("甲".encode("utf-8")))
            self.assertTrue(second["eof"])

    def test_preserves_raw_evidence_on_decode_degradation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            stdout_path, _ = self._write_log_receipt(root)
            raw = b"prefix\xffsuffix"
            stdout_path.write_bytes(raw)

            detail = runtime.read_run_session_log(
                root,
                "run-log-fixture",
                stream="stdout",
                cursor=0,
                max_bytes=64,
            )

            self.assertEqual(detail["decodeStatus"], "LOG_DECODE_DEGRADED")
            self.assertIn("\ufffd", detail["text"])
            self.assertEqual(detail["nextCursor"], len(raw))
            self.assertEqual(
                detail["rawDigest"],
                "sha256:" + hashlib.sha256(raw).hexdigest(),
            )

    def test_quarantines_legacy_sensitive_bytes_without_publishing_plaintext(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "change"
            private = Path(tmp) / "private-evidence"
            source = root / "runtime" / "legacy-secret.txt"
            source.parent.mkdir(parents=True)
            raw = b"password=do-not-publish\n"
            source.write_bytes(raw)

            result = runtime.quarantine_sensitive_evidence(
                source,
                change_root=root,
                private_root=private,
                reason="legacy crash evidence",
            )

            self.assertTrue(result["ok"], result)
            self.assertFalse(source.exists())
            private_path = Path(result["privatePath"])
            self.assertEqual(private_path.read_bytes(), raw)
            self.assertEqual(
                result["sourceDigest"],
                "sha256:" + hashlib.sha256(raw).hexdigest(),
            )
            receipt_path = runtime.sensitive_evidence_receipt_path(root)
            receipt_text = receipt_path.read_text(encoding="utf-8")
            self.assertNotIn("do-not-publish", receipt_text)
            self.assertEqual(
                json.loads(receipt_text)["status"],
                "QUARANTINED",
            )

    def test_quarantine_rejects_private_root_inside_publishable_tree(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "change"
            source = root / "legacy.txt"
            source.parent.mkdir(parents=True)
            source.write_text("token=blocked", encoding="utf-8")
            result = runtime.quarantine_sensitive_evidence(
                source,
                change_root=root,
                private_root=root / "private",
            )
            self.assertFalse(result["ok"])
            self.assertEqual(
                result["reasonCode"],
                "SENSITIVE_EVIDENCE_QUARANTINE_FAILED",
            )
            self.assertTrue(source.is_file())

    def test_classifies_worker_loss_as_incomplete(self) -> None:
        receipt = {
            "sessionId": "run-worker-lost",
            "status": "RUNNING",
            "reasonCode": "CHILD_RUNNING",
            "workerPid": 4321,
            "workerIdentity": {
                "pid": 4321,
                "startedAt": "2026-07-31T00:00:00+00:00",
                "executable": sys.executable,
            },
            "lastHeartbeatAt": "2026-07-31T00:00:00+00:00",
            "heartbeatSeconds": 0.1,
            "cleanupStatus": "PROCESS_TREE_ISOLATED",
        }
        with (
            mock.patch.object(runtime, "_load_run_receipt", return_value=receipt),
            mock.patch.object(runtime, "_receipt_identity_state", return_value=True),
            mock.patch("harness_service.is_pid_alive", return_value=False),
            mock.patch.object(runtime, "_write_run_receipt"),
        ):
            result = runtime.run_session_status(Path("."), "run-worker-lost")

        self.assertEqual(result["status"], "INCOMPLETE")
        self.assertEqual(result["reasonCode"], "HEARTBEAT_LOST")
        self.assertEqual(
            result["cleanupStatus"], "WORKER_EXITED_WITHOUT_FINAL_RECEIPT"
        )

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

    def test_windows_job_breakaway_requires_explicit_detached_mode(self) -> None:
        default_job = test_runner._WindowsKillOnCloseJob()
        detached_job = test_runner._WindowsKillOnCloseJob(allow_breakaway=True)

        self.assertFalse(default_job.allow_breakaway)
        self.assertTrue(detached_job.allow_breakaway)

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
