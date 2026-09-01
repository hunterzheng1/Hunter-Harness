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
        for agent in ("codex", "claude-code", "cursor", "codebuddy", "pi"):
            result = runtime.adapter_worktree(agent, "runtime-plan")
            self.assertEqual(result["agent"], agent)
            for key, value in expected.items():
                self.assertEqual(result[key], value, f"{agent}.{key}")

    def test_adapter_worktree_all_agents_share_path_and_branch(self) -> None:
        results = [
            runtime.adapter_worktree(agent, "same-change")
            for agent in ("codex", "claude-code", "cursor", "codebuddy", "pi")
        ]
        paths = {r["path"] for r in results}
        branches = {r["branch"] for r in results}
        self.assertEqual(paths, {".worktrees/same-change"})
        self.assertEqual(branches, {"harness/same-change"})
        agents = {r["agent"] for r in results}
        self.assertEqual(agents, {"codex", "claude-code", "cursor", "codebuddy", "pi"})

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

    def test_refresh_preserves_quarantine_entries_and_rebinds_current_tree(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "change"
            private = Path(tmp) / "private-evidence"
            source = root / "runtime" / "legacy-secret.txt"
            source.parent.mkdir(parents=True)
            source.write_text("token=never-publish", encoding="utf-8")
            quarantined = runtime.quarantine_sensitive_evidence(
                source,
                change_root=root,
                private_root=private,
            )
            self.assertTrue(quarantined["ok"], quarantined)
            original_entry = quarantined["receipt"]["entries"][0]
            (root / "events.ndjson").write_text("event-after-receipt\n", encoding="utf-8")
            (root / "events.ndjson.lock").write_text("lock", encoding="utf-8")

            refreshed = runtime.refresh_sensitive_evidence_scan_receipt(root)
            repeated = runtime.refresh_sensitive_evidence_scan_receipt(root)

            self.assertTrue(refreshed["ok"], refreshed)
            self.assertTrue(repeated["ok"], repeated)
            receipt = repeated["receipt"]
            self.assertEqual(receipt["status"], "QUARANTINED")
            self.assertEqual(receipt["entries"], [original_entry])
            self.assertEqual(
                receipt["publishableTreeDigest"],
                runtime.publishable_tree_digest(root),
            )

    def test_refresh_fails_closed_when_plaintext_reappears(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "change"
            private = Path(tmp) / "private-evidence"
            source = root / "runtime" / "legacy-secret.txt"
            source.parent.mkdir(parents=True)
            source.write_text("token=first-sensitive-value", encoding="utf-8")
            quarantined = runtime.quarantine_sensitive_evidence(
                source,
                change_root=root,
                private_root=private,
            )
            self.assertTrue(quarantined["ok"], quarantined)
            reintroduced = root / "runtime" / "reintroduced.txt"
            reintroduced.write_text("token=second-sensitive-value", encoding="utf-8")

            refreshed = runtime.refresh_sensitive_evidence_scan_receipt(root)

            self.assertFalse(refreshed["ok"])
            self.assertEqual(
                refreshed["reasonCode"],
                "SENSITIVE_EVIDENCE_UNQUARANTINED",
            )
            self.assertEqual(refreshed["receipt"]["status"], "FAIL")
            self.assertTrue(refreshed["receipt"]["unresolvedFailures"])
            self.assertEqual(
                refreshed["receipt"]["entries"],
                quarantined["receipt"]["entries"],
            )

    def test_scan_allows_documented_authorization_placeholder(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "change"
            design = root / "spec" / "api.md"
            design.parent.mkdir(parents=True)
            design.write_text(
                "请求头示例：`Authorization: Bearer <apiKey>`\n",
                encoding="utf-8",
            )

            result = runtime.refresh_sensitive_evidence_scan_receipt(root)

            self.assertTrue(result["ok"], result)
            self.assertEqual(result["receipt"]["unresolvedFailures"], [])

    def test_scan_still_blocks_real_authorization_credential(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "change"
            evidence = root / "runtime" / "request.txt"
            evidence.parent.mkdir(parents=True)
            evidence.write_text(
                "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.real-signature\n",
                encoding="utf-8",
            )

            result = runtime.refresh_sensitive_evidence_scan_receipt(root)

            self.assertFalse(result["ok"])
            self.assertEqual(
                result["reasonCode"],
                "SENSITIVE_EVIDENCE_UNQUARANTINED",
            )

    def test_refresh_rejects_invalid_entries_without_overwriting_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "change"
            receipt_path = runtime.sensitive_evidence_receipt_path(root)
            receipt_path.parent.mkdir(parents=True)
            receipt_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "rulesVersion": runtime.SECRET_SCAN_RULES_VERSION,
                        "changeId": root.name,
                        "status": "QUARANTINED",
                        "unresolvedFailures": [],
                        "entries": {"invalid": "shape"},
                        "publishableTreeDigest": "sha256:" + "0" * 64,
                        "publicationExcluded": True,
                    }
                ),
                encoding="utf-8",
            )
            before = receipt_path.read_bytes()

            refreshed = runtime.refresh_sensitive_evidence_scan_receipt(root)

            self.assertFalse(refreshed["ok"])
            self.assertEqual(refreshed["reasonCode"], "SECRET_SCAN_RECEIPT_INVALID")
            self.assertEqual(receipt_path.read_bytes(), before)

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

    def test_fixback_session_without_batch_requires_product_identity(self) -> None:
        """F-2：fixback-* 会话缺 product-identity 且无 OPEN 批次 → 当场拒绝。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaises(ValueError) as ctx:
                runtime.start_run_session(
                    state_root=root,
                    verification="fixback-red",
                    argv=[sys.executable, "-c", "pass"],
                    working_directory=root,
                )
            self.assertIn("FIXBACK_PRODUCT_IDENTITY_REQUIRED", str(ctx.exception))

    def test_fixback_session_injects_open_batch_identity(self) -> None:
        """F-2：OPEN 批次存在时自动注入 baseProductIdentity，不再白跑一轮。"""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            batches = root / "fixback" / "batches"
            batches.mkdir(parents=True)
            (batches / "batch-1.json").write_text(json.dumps({
                "batchId": "batch-1",
                "status": "OPEN",
                "baseProductIdentity": "sha256:base-identity",
            }), encoding="utf-8")
            started = runtime.start_run_session(
                state_root=root,
                verification="fixback-green",
                argv=[sys.executable, "-c", "pass"],
                working_directory=root,
                heartbeat_seconds=0.05,
            )
            self.assertEqual(started["productIdentity"], "sha256:base-identity")
            self.assertEqual(
                started["productIdentitySource"], "fixback-batch:batch-1"
            )
            self._wait_for_terminal(root, started["sessionId"])

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


class QuarantineReachabilityTests(unittest.TestCase):
    """隔离是归档的硬前置，但它此前既跨不了盘、也没有命令行入口。

    执行日志里的实况：默认私有根在 `~/.harness/private-evidence`（C 盘），项目在
    E 盘，`os.replace` 直接 WinError 17；换到项目内又被归档的密钥扫描门禁以
    SECRET_SCAN_PRIVATE_PATH_IN_COPY_ROOT 拒绝——函数自己的校验只看 change_root，
    比门禁宽，于是"这里过了、门禁再拒"。第三次才试对。全程还得写
    `python -c` + sys.path hack，因为这个必经步骤没有子命令。
    """

    def test_private_root_defaults_to_home_and_honors_override(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "proj" / ".harness" / "changes" / "demo" / "x.txt"
            source.parent.mkdir(parents=True)
            source.write_text("token=blocked", encoding="utf-8")

            root = runtime.private_evidence_root_for(source)

            # 默认根恒为 ~/.harness/private-evidence：跨卷由 _transfer_evidence
            # copy+unlink 处理，不再退到源驱动器根（2026-09 起盘根回退已移除）。
            self.assertEqual(
                root,
                (Path.home() / ".harness" / "private-evidence").resolve(),
            )

            explicit = runtime.private_evidence_root_for(
                source, Path(tmp) / "elsewhere" / "private-evidence"
            )
            self.assertEqual(explicit, (Path(tmp) / "elsewhere" / "private-evidence").resolve())

    @unittest.skipUnless(os.name == "nt", "跨盘概念仅 Windows 适用")
    def test_cross_drive_quarantine_transfers_via_copy(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            # 模拟源在其它盘：把默认根固定到 tmp（与源同盘），再显式传一个
            # 跨盘私有根，验证 _transfer_evidence 走 copy+unlink 而非 os.replace。
            project = Path(tmp) / "proj"
            change_root = project / ".harness" / "changes" / "demo"
            source = change_root / "meta" / "journal.json"
            source.parent.mkdir(parents=True)
            source.write_text("token=blocked", encoding="utf-8")

            other_drive = "Z:" if Path(tmp).resolve().drive.upper() != "Z:" else "Y:"
            private = Path(other_drive) / "hunter-quarantine-test" / "private-evidence"
            result = runtime.quarantine_sensitive_evidence(
                source,
                change_root=change_root,
                private_root=private,
                project_root=project,
            )
            # 本机不一定有 Z: 盘，跨盘 copy 会失败——失败必须 fail-closed（源保留）。
            if not result["ok"]:
                self.assertTrue(source.is_file(), "fail-closed: source must remain")
                return
            self.assertFalse(source.exists())
            self.assertTrue(Path(result["privatePath"]).is_file())

    def test_private_root_inside_project_root_is_rejected_up_front(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "proj"
            change_root = project / ".harness" / "changes" / "demo"
            source = change_root / "meta" / "journal.json"
            source.parent.mkdir(parents=True)
            (project / ".harness").mkdir(parents=True, exist_ok=True)
            source.write_text("token=blocked", encoding="utf-8")

            result = runtime.quarantine_sensitive_evidence(
                source,
                change_root=change_root,
                # 在 change_root 之外、但仍在项目根内——归档门禁会拒，这里就该拒
                private_root=project / ".harness" / "private-evidence",
                project_root=project,
            )

            self.assertFalse(result["ok"], result)
            self.assertIn("project", str(result.get("error") or "").lower())
            self.assertTrue(source.is_file())

    def test_quarantine_has_a_cli_entry_point(self) -> None:
        parser = runtime.build_parser()
        args = parser.parse_args([
            "quarantine-evidence",
            "--project", ".",
            "--change-dir", ".harness/changes/demo",
            "--file", "meta/journal.json",
            "--reason", "plan_finalize journal",
            "--json",
        ])
        self.assertEqual(args.command, "quarantine-evidence")


class PublicationScopedScanTests(unittest.TestCase):
    """发布门禁扫的字节，必须就是会被发布出去的字节。

    2026-08-19 kld-sdd 归档记录：review 阶段自己生成的 runtime/review-diff.patch
    （`git diff HEAD >`，5068 行，内含被删除的旧 token 代码）触发
    SENSITIVE_EVIDENCE_UNQUARANTINED，把归档整个挡住。但 runtime/ 从来不进归档
    ZIP —— 包成员只有 summary-data.json / spec/**.md / plans/**.md / knowledge.json
    / archive-meta.md / change-context.json / manifest 七类。

    于是本地门禁在"永远不会发布的文件"上过严，却对"真正会发布的文件"一个字没查，
    最后由服务端判 422。范围完全倒置。
    """

    @staticmethod
    def _change_with_runtime_scratch(root: Path) -> Path:
        change = root / "change"
        (change / "plans").mkdir(parents=True)
        (change / "plans" / "design.md").write_text(
            "# 设计\n默认服务地址 http://10.29.213.80:8080\n", encoding="utf-8"
        )
        (change / "runtime").mkdir(parents=True)
        # review 阶段的临时 diff：内含旧代码里的 token 赋值，但从不入包。
        (change / "runtime" / "review-diff.patch").write_text(
            "-  const headers = { token: 'sk_cli_live_value' };\n", encoding="utf-8"
        )
        return change

    def test_runtime_scratch_is_out_of_publication_scope(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = self._change_with_runtime_scratch(Path(tmp))

            full = runtime.sensitive_evidence_candidates(change)
            scoped = runtime.sensitive_evidence_candidates(
                change, exclude_dirs=runtime.PUBLICATION_EXCLUDED_DIRS
            )

            # 全树扫描仍然看得见它——quarantine 流程依赖这个能力，不能回退。
            self.assertEqual(
                [item["path"] for item in full], ["runtime/review-diff.patch"]
            )
            # 但发布门禁不该被一个永远不发布的草稿挡住。
            self.assertEqual(scoped, [])

    def test_harness_recovery_token_is_not_a_user_secret(self) -> None:
        """P1-2：发布日志里 harness 自生成的 recovery_token 不该被扫成明文秘密。"""
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change"
            journals = change / "meta" / "publication-journals"
            journals.mkdir(parents=True)
            (journals / "plan_finalize-1.json").write_text(
                json.dumps({"recovery_token": "a1b2c3d4e5f6", "status": "ok"}),
                encoding="utf-8",
            )
            (journals / "plan_finalize-2.json").write_text(
                json.dumps({"recovery_token": "f6e5d4c3b2a1"}),
                encoding="utf-8",
            )

            self.assertEqual(runtime.sensitive_evidence_candidates(change), [])

            # 真实用户秘密仍然命中——豁免只覆盖 recovery_token 这一个系统字段
            (change / "config.json").write_text(
                json.dumps({"api_token": "sk_live_value_123"}),
                encoding="utf-8",
            )
            candidates = runtime.sensitive_evidence_candidates(change)
            self.assertEqual([item["path"] for item in candidates], ["config.json"])

            # 同文件里 recovery_token 被豁免、另一个字段仍命中
            (journals / "mixed.json").write_text(
                '{"recovery_token": "a1b2c3d4", "password": "hunter2secret"}',
                encoding="utf-8",
            )
            paths = [item["path"] for item in runtime.sensitive_evidence_candidates(change)]
            self.assertIn("meta/publication-journals/mixed.json", paths)
            self.assertNotIn("meta/publication-journals/plan_finalize-1.json", paths)

    def test_publishable_digest_ignores_runtime_churn(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = self._change_with_runtime_scratch(Path(tmp))
            excluded = runtime.PUBLICATION_EXCLUDED_DIRS

            before = runtime.publishable_tree_digest(change, exclude_dirs=excluded)
            (change / "runtime" / "scratch-2.json").write_text("{}", encoding="utf-8")
            after = runtime.publishable_tree_digest(change, exclude_dirs=excluded)

            # 每写一个草稿就让收据失效，等于强迫全量重扫。
            self.assertEqual(before, after)

    def test_receipt_records_its_own_exclusions(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = self._change_with_runtime_scratch(Path(tmp))

            result = runtime.refresh_sensitive_evidence_scan_receipt(
                change, exclude_dirs=runtime.PUBLICATION_EXCLUDED_DIRS
            )

            self.assertTrue(result["ok"], result)
            receipt = result["receipt"]
            # 收据必须自述扫描范围，否则复算摘要的一方无从得知该排除什么。
            self.assertEqual(
                list(receipt["publicationExcludedDirs"]),
                list(runtime.PUBLICATION_EXCLUDED_DIRS),
            )
            self.assertEqual(
                receipt["publishableTreeDigest"],
                runtime.publishable_tree_digest(
                    change, exclude_dirs=runtime.PUBLICATION_EXCLUDED_DIRS
                ),
            )


class SweepScratchTests(unittest.TestCase):
    """runtime/ 会一路堆积草稿，没人清，还会被别的门禁读到。

    2026-08-19 kld-sdd 一轮下来 runtime/ 里躺着：review-diff.patch(5068 行)、
    review-diff-postfix.patch(5071 行)、findings-input.json、dispositions-input.json、
    findings-rereview.json、dispositions-input2.json、fixback-y1-check.cjs、
    archive-out{,2,3}.json ——其中两个 patch 直接把归档挡住了。

    这些是过程草稿，不是证据。证据在 evidence/、reports/、meta/ 里，一个都不能碰。
    """

    @staticmethod
    def _seed(change: Path) -> None:
        (change / "runtime").mkdir(parents=True)
        for name in (
            "review-diff.patch",
            "review-diff-postfix.patch",
            "findings-input.json",
            "dispositions-input2.json",
            "archive-out3.json",
            "fixback-y1-check.cjs",
        ):
            (change / "runtime" / name).write_text("scratch", encoding="utf-8")
        # 必须留下的：门禁与恢复要读的运行态
        (change / "runtime" / "context-lease.json").write_text("{}", encoding="utf-8")
        (change / "runtime" / "fixback-session.json").write_text("{}", encoding="utf-8")
        (change / "runtime" / "preflight.json").write_text("{}", encoding="utf-8")
        (change / "runtime" / "scenario-receipt-test.json").write_text("{}", encoding="utf-8")
        sessions = change / "runtime" / "run-sessions" / "run-1"
        sessions.mkdir(parents=True)
        (sessions / "session.json").write_text("{}", encoding="utf-8")
        # 证据与报告：绝对不能碰
        (change / "evidence").mkdir()
        (change / "evidence" / "verification-ledger.json").write_text("{}", encoding="utf-8")
        (change / "reports" / "review").mkdir(parents=True)
        (change / "reports" / "review" / "review-findings.json").write_text(
            "{}", encoding="utf-8"
        )

    def test_sweep_removes_scratch_and_keeps_everything_else(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change"
            self._seed(change)

            result = runtime.sweep_scratch(change)

            self.assertTrue(result["ok"], result)
            self.assertEqual(
                sorted(result["removed"]),
                [
                    "runtime/archive-out3.json",
                    "runtime/dispositions-input2.json",
                    "runtime/findings-input.json",
                    "runtime/fixback-y1-check.cjs",
                    "runtime/review-diff-postfix.patch",
                    "runtime/review-diff.patch",
                ],
            )
            for kept in (
                "runtime/context-lease.json",
                "runtime/fixback-session.json",
                "runtime/preflight.json",
                "runtime/scenario-receipt-test.json",
                "runtime/run-sessions/run-1/session.json",
                "evidence/verification-ledger.json",
                "reports/review/review-findings.json",
            ):
                self.assertTrue((change / kept).is_file(), kept)

    def test_dry_run_reports_without_deleting(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change"
            self._seed(change)

            result = runtime.sweep_scratch(change, dry_run=True)

            self.assertTrue(result["ok"], result)
            self.assertIn("runtime/review-diff.patch", result["removed"])
            # 只报不删：调用方要能先看一眼再决定。
            self.assertTrue((change / "runtime" / "review-diff.patch").is_file())

    def test_missing_runtime_dir_is_not_an_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change"
            change.mkdir()

            result = runtime.sweep_scratch(change)

            self.assertTrue(result["ok"], result)
            self.assertEqual(result["removed"], [])


if __name__ == "__main__":
    unittest.main()
