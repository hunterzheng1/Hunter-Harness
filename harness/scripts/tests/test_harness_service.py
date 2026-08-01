#!/usr/bin/env python3
"""Unittests for harness_service.py (P0-6)."""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path
from unittest import mock


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_service as hs  # noqa: E402
import harness_execution_contracts as hec  # noqa: E402


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


def _run_json(argv: list[str]) -> tuple[int, dict]:
    buf = StringIO()
    err = StringIO()
    with redirect_stdout(buf), redirect_stderr(err):
        code = hs.main(["--json", *argv])
    text = (buf.getvalue() or err.getvalue()).strip()
    payload = json.loads(text) if text else {}
    return code, payload


def _fake_service_script(health_file: Path, sleep_sec: int = 600) -> Path:
    """Write a tiny fake-service script; return its path."""
    script = health_file.parent / f"_fake_svc_{health_file.stem}.py"
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text(
        "from pathlib import Path\n"
        "import time\n"
        f"marker = Path({str(health_file)!r})\n"
        "marker.parent.mkdir(parents=True, exist_ok=True)\n"
        "marker.write_text('ok', encoding='utf-8')\n"
        f"time.sleep({sleep_sec})\n",
        encoding="utf-8",
        newline="\n",
    )
    return script


def _fake_service_command(health_file: Path, sleep_sec: int = 600) -> str:
    """Detached fake process: create health marker then sleep."""
    script = _fake_service_script(health_file, sleep_sec=sleep_sec)
    py = sys.executable
    # Quote both paths for Windows shell=True.
    return f'"{py}" "{script}"'


def _setup_project(
    root: Path,
    *,
    health_file: Path,
    command: str | None = None,
    sleep_sec: int = 600,
    input_files: list[str] | None = None,
) -> Path:
    """Create project with build-profile pointing at fake service.

    Task 3 §5.4: every service-starting fixture must create ≥1 real input file
    and list it in serviceStart.inputFiles (no reusable empty fingerprint)."""
    cmd = command if command is not None else _fake_service_command(health_file, sleep_sec=sleep_sec)
    src = root / "Svc.java"
    if not src.is_file():
        _write(src, "class Svc { int v = 1; }\n")
    profile = {
        "schemaVersion": 1,
        "serviceStart": {
            "command": cmd,
            "healthUrl": f"file:{health_file}",
            "healthFile": str(health_file),
            "startTimeoutSec": 20,
            "profile": "local-dev",
            "overlayPath": "",
            "inputFiles": list(input_files) if input_files is not None else ["Svc.java"],
        },
        "toolPaths": {},
        "buildCommands": {},
        "fingerprint": {},
    }
    _write_json(root / ".harness" / "config" / "build-profile.json", profile)
    return root


class EnsureReuseRestartTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-svc-"))
        self.project = self.tmp / "project"
        self.change = self.tmp / "change-1"
        self.change.mkdir(parents=True)
        self.project.mkdir(parents=True)
        self.health = self.change / "runtime" / "healthy.marker"
        self.mod = self.project / "Service.java"
        _write(self.mod, "class Service { int v = 1; }\n")
        _setup_project(self.project, health_file=self.health)
        self._pids: list[int] = []

    def tearDown(self) -> None:
        # Stop any leftover AI sessions
        try:
            hs.main(["--json", "stop", "--change-dir", str(self.change)])
        except Exception:
            pass
        for pid in self._pids:
            if hs.is_pid_alive(pid):
                hs.terminate_process_tree(pid)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_ensure_started_then_reused_same_pid(self) -> None:
        code1, p1 = _run_json(
            [
                "ensure",
                "--change-dir",
                str(self.change),
                "--project",
                str(self.project),
                "--files",
                str(self.mod),
            ]
        )
        self.assertEqual(code1, 0, msg=p1)
        self.assertTrue(p1.get("ok"), msg=p1)
        self.assertEqual(p1["action"], "started")
        pid = p1["pid"]
        self._pids.append(pid)
        self.assertTrue(hs.is_pid_alive(pid))
        self.assertTrue(self.health.is_file())
        session_file = self.change / "runtime" / "service-session.json"
        self.assertTrue(session_file.is_file())

        code2, p2 = _run_json(
            [
                "ensure",
                "--change-dir",
                str(self.change),
                "--project",
                str(self.project),
                "--files",
                str(self.mod),
            ]
        )
        self.assertEqual(code2, 0, msg=p2)
        self.assertEqual(p2["action"], "reused", msg=p2)
        self.assertEqual(p2["pid"], pid)

    def test_ensure_persists_explicit_port_lease_identity(self) -> None:
        code, payload = _run_json(
            [
                "ensure",
                "--change-dir",
                str(self.change),
                "--project",
                str(self.project),
                "--files",
                str(self.mod),
                "--leased-port",
                "43127",
                "--lease-owner",
                "run-test-port-owner",
            ]
        )
        self.assertEqual(code, 0, msg=payload)
        self._pids.append(payload["pid"])
        session = json.loads(
            (self.change / "runtime" / "service-session.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(session["leasedPort"], 43127)
        self.assertEqual(session["leaseOwner"], "run-test-port-owner")

    def test_leased_port_requires_owner(self) -> None:
        code, payload = _run_json(
            [
                "ensure",
                "--change-dir",
                str(self.change),
                "--project",
                str(self.project),
                "--files",
                str(self.mod),
                "--leased-port",
                "43128",
            ]
        )
        self.assertNotEqual(code, 0)
        self.assertIn("lease owner", payload["error"].lower())

    def test_ensure_restarted_when_fingerprint_changes(self) -> None:
        code1, p1 = _run_json(
            [
                "ensure",
                "--change-dir",
                str(self.change),
                "--project",
                str(self.project),
                "--files",
                str(self.mod),
            ]
        )
        self.assertEqual(code1, 0, msg=p1)
        self.assertEqual(p1["action"], "started")
        old_pid = p1["pid"]
        self._pids.append(old_pid)

        # Change module source → inputsHash mismatch
        _write(self.mod, "class Service { int v = 2; }\n")
        # Remove old health marker so wait loop sees the new process write it
        if self.health.is_file():
            self.health.unlink()

        code2, p2 = _run_json(
            [
                "ensure",
                "--change-dir",
                str(self.change),
                "--project",
                str(self.project),
                "--files",
                str(self.mod),
            ]
        )
        self.assertEqual(code2, 0, msg=p2)
        self.assertEqual(p2["action"], "restarted", msg=p2)
        new_pid = p2["pid"]
        self._pids.append(new_pid)
        self.assertNotEqual(new_pid, old_pid)
        # Old process should be gone
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and hs.is_pid_alive(old_pid):
            time.sleep(0.1)
        self.assertFalse(hs.is_pid_alive(old_pid))


class ServiceFingerprintTests(unittest.TestCase):
    """Task 3 (REMEDIATION-DESIGN §5): reuse must compare inputsHash + command
    + profile + overlay + process identity; empty inputs rejected."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-svc-fp-"))
        self.project = self.tmp / "project"
        self.change = self.tmp / "change-1"
        self.project.mkdir(parents=True)
        self.change.mkdir(parents=True)
        self.health = self.change / "runtime" / "healthy.marker"
        self.src = self.project / "Svc.java"
        _write(self.src, "class Svc { int v = 1; }\n")
        self._pids: list[int] = []
        self._write_profile()

    def _write_profile(
        self,
        *,
        command: str | None = None,
        profile: str = "local-dev",
        overlay_path: str = "",
        input_files: list[str] | None = None,
    ) -> None:
        cmd = command if command is not None else _fake_service_command(self.health, sleep_sec=600)
        prof = {
            "schemaVersion": 1,
            "serviceStart": {
                "command": cmd,
                "healthUrl": f"file:{self.health}",
                "healthFile": str(self.health),
                "startTimeoutSec": 20,
                "profile": profile,
                "overlayPath": overlay_path,
                "inputFiles": list(input_files) if input_files is not None else ["Svc.java"],
            },
            "toolPaths": {},
            "buildCommands": {},
            "fingerprint": {},
        }
        _write_json(self.project / ".harness" / "config" / "build-profile.json", prof)

    def _alt_command(self) -> str:
        """A genuinely different command string (different script path)."""
        script = self.change / "runtime" / "_fake_svc_alt.py"
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_text(
            "from pathlib import Path\n"
            "import time\n"
            f"marker = Path({str(self.health)!r})\n"
            "marker.parent.mkdir(parents=True, exist_ok=True)\n"
            "marker.write_text('ok', encoding='utf-8')\n"
            "time.sleep(600)\n",
            encoding="utf-8",
            newline="\n",
        )
        return f'"{sys.executable}" "{script}"'

    def tearDown(self) -> None:
        try:
            hs.main(["--json", "stop", "--change-dir", str(self.change)])
        except Exception:
            pass
        for pid in self._pids:
            if hs.is_pid_alive(pid):
                hs.terminate_process_tree(pid)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _ensure(self) -> tuple[int, dict]:
        return _run_json(
            ["ensure", "--change-dir", str(self.change), "--project", str(self.project)]
        )

    def test_ensure_rejects_empty_service_inputs(self) -> None:
        self._write_profile(input_files=[])
        buf = StringIO()
        err = StringIO()
        from contextlib import redirect_stderr

        with redirect_stdout(buf), redirect_stderr(err):
            code = hs.main(
                ["--json", "ensure", "--change-dir", str(self.change), "--project", str(self.project)]
            )
        self.assertNotEqual(code, 0, msg=err.getvalue())
        self.assertIn("service inputs are empty", err.getvalue())
        self.assertFalse((self.change / "runtime" / "service-session.json").is_file())

    def test_profile_input_glob_detects_source_change(self) -> None:
        code1, p1 = self._ensure()
        self.assertEqual(code1, 0, msg=p1)
        self.assertEqual(p1["action"], "started")
        pid1 = p1["pid"]
        self._pids.append(pid1)

        code2, p2 = self._ensure()
        self.assertEqual(code2, 0, msg=p2)
        self.assertEqual(p2["action"], "reused", msg=p2)

        _write(self.src, "class Svc { int v = 2; }\n")
        if self.health.is_file():
            self.health.unlink()

        code3, p3 = self._ensure()
        self.assertEqual(code3, 0, msg=p3)
        self.assertEqual(p3["action"], "restarted", msg=p3)
        pid3 = p3["pid"]
        self._pids.append(pid3)
        self.assertNotEqual(pid3, pid1)

    def test_command_change_restarts_service(self) -> None:
        code1, p1 = self._ensure()
        self.assertEqual(code1, 0, msg=p1)
        pid1 = p1["pid"]
        self._pids.append(pid1)
        self._ensure()  # reuse once

        self._write_profile(command=self._alt_command())
        if self.health.is_file():
            self.health.unlink()
        code3, p3 = self._ensure()
        self.assertEqual(code3, 0, msg=p3)
        self.assertEqual(p3["action"], "restarted", msg=p3)
        self._pids.append(p3["pid"])
        self.assertNotEqual(p3["pid"], pid1)

    def test_profile_change_restarts_service(self) -> None:
        code1, p1 = self._ensure()
        self.assertEqual(code1, 0, msg=p1)
        pid1 = p1["pid"]
        self._pids.append(pid1)
        self._ensure()  # reuse once

        self._write_profile(profile="local-dev-remote-sdk")
        if self.health.is_file():
            self.health.unlink()
        code3, p3 = self._ensure()
        self.assertEqual(code3, 0, msg=p3)
        self.assertEqual(p3["action"], "restarted", msg=p3)
        self._pids.append(p3["pid"])
        self.assertNotEqual(p3["pid"], pid1)

    def test_overlay_change_restarts_service(self) -> None:
        code1, p1 = self._ensure()
        self.assertEqual(code1, 0, msg=p1)
        pid1 = p1["pid"]
        self._pids.append(pid1)
        self._ensure()  # reuse once

        self._write_profile(overlay_path="C:/temp/harness-test-overlay/c1/application-harness-test.yml")
        if self.health.is_file():
            self.health.unlink()
        code3, p3 = self._ensure()
        self.assertEqual(code3, 0, msg=p3)
        self.assertEqual(p3["action"], "restarted", msg=p3)
        self._pids.append(p3["pid"])
        self.assertNotEqual(p3["pid"], pid1)


class PortOccupiedNeedsDecisionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-svc-port-"))
        self.project = self.tmp / "project"
        self.change = self.tmp / "change-1"
        self.change.mkdir(parents=True)
        self.project.mkdir(parents=True)
        self.health = self.change / "runtime" / "healthy.marker"
        # Bind an ephemeral port to simulate user-owned listener
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(1)
        self.port = int(self.sock.getsockname()[1])

        profile = {
            "schemaVersion": 1,
            "serviceStart": {
                "command": _fake_service_command(self.health),
                "healthUrl": f"tcp://127.0.0.1:{self.port}",
                "port": self.port,
                "startTimeoutSec": 5,
            },
        }
        _write_json(self.project / ".harness" / "config" / "build-profile.json", profile)

    def tearDown(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_port_occupied_without_session_needs_user_decision(self) -> None:
        code, payload = _run_json(
            [
                "ensure",
                "--change-dir",
                str(self.change),
                "--project",
                str(self.project),
            ]
        )
        self.assertEqual(code, 0, msg=payload)
        self.assertEqual(payload["action"], "needs-user-decision")
        self.assertIn("port-occupied", payload.get("reason", ""))
        # Must not have written an AI session or killed anything
        self.assertFalse((self.change / "runtime" / "service-session.json").is_file())


class SessionCorruptConservativeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-svc-corrupt-"))
        self.project = self.tmp / "project"
        self.change = self.tmp / "change-1"
        self.change.mkdir(parents=True)
        self.project.mkdir(parents=True)
        self.health = self.change / "runtime" / "healthy.marker"
        _setup_project(self.project, health_file=self.health)
        # Corrupt session
        _write(self.change / "runtime" / "service-session.json", "{not-json")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_ensure_corrupt_session_needs_user_decision(self) -> None:
        code, payload = _run_json(
            [
                "ensure",
                "--change-dir",
                str(self.change),
                "--project",
                str(self.project),
            ]
        )
        self.assertEqual(code, 0, msg=payload)
        self.assertEqual(payload["action"], "needs-user-decision")
        self.assertIn("session-corrupt", payload.get("reason", ""))

    def test_stop_corrupt_session_needs_user_decision(self) -> None:
        code, payload = _run_json(
            [
                "stop",
                "--change-dir",
                str(self.change),
            ]
        )
        self.assertEqual(code, 0, msg=payload)
        self.assertEqual(payload["action"], "needs-user-decision")
        self.assertFalse(payload.get("killed", True))


class StopIdempotentAndIfStartedByAiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-svc-stop-"))
        self.project = self.tmp / "project"
        self.change = self.tmp / "change-1"
        self.change.mkdir(parents=True)
        self.project.mkdir(parents=True)
        self.health = self.change / "runtime" / "healthy.marker"
        _setup_project(self.project, health_file=self.health)
        self._pids: list[int] = []
        self._procs: list = []

    def tearDown(self) -> None:
        try:
            hs.main(["--json", "stop", "--change-dir", str(self.change)])
        except Exception:
            pass
        for pid in self._pids:
            if hs.is_pid_alive(pid):
                hs.terminate_process_tree(pid)
        for proc in self._procs:
            try:
                proc.wait(timeout=5)
            except Exception:
                pass
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_stop_idempotent_when_no_session(self) -> None:
        code, payload = _run_json(["stop", "--change-dir", str(self.change)])
        self.assertEqual(code, 0, msg=payload)
        self.assertEqual(payload["action"], "already-stopped")
        self.assertFalse(payload.get("killed"))

        code2, payload2 = _run_json(["stop", "--change-dir", str(self.change)])
        self.assertEqual(code2, 0, msg=payload2)
        self.assertEqual(payload2["action"], "already-stopped")

    def test_stop_ai_session_then_idempotent(self) -> None:
        code, p = _run_json(
            [
                "ensure",
                "--change-dir",
                str(self.change),
                "--project",
                str(self.project),
            ]
        )
        self.assertEqual(code, 0, msg=p)
        self.assertEqual(p["action"], "started")
        pid = p["pid"]
        self._pids.append(pid)

        code2, p2 = _run_json(["stop", "--change-dir", str(self.change)])
        self.assertEqual(code2, 0, msg=p2)
        self.assertEqual(p2["action"], "stopped")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and hs.is_pid_alive(pid):
            time.sleep(0.1)
        self.assertFalse(hs.is_pid_alive(pid))
        self.assertFalse((self.change / "runtime" / "service-session.json").is_file())

        code3, p3 = _run_json(["stop", "--change-dir", str(self.change)])
        self.assertEqual(code3, 0, msg=p3)
        self.assertEqual(p3["action"], "already-stopped")

    def test_if_started_by_ai_skips_non_ai_session(self) -> None:
        # Write a non-AI session pointing at a live fake process we own for the test,
        # but mark startedBy as User — stop --if-started-by-ai must skip.
        health = self.health
        cmd = _fake_service_command(health, sleep_sec=30)
        # Start a process ourselves (not via ensure) to have a live pid
        log = self.change / "logs" / "manual.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open("w", encoding="utf-8") as lf:
            proc = __import__("subprocess").Popen(
                cmd,
                shell=True,
                stdout=lf,
                stderr=__import__("subprocess").STDOUT,
                cwd=str(self.project),
            )
        self._pids.append(proc.pid)
        self._procs.append(proc)
        time.sleep(0.3)
        session = {
            "pid": proc.pid,
            "startedBy": "User",
            "moduleInputsHash": "sha256:dead",
            "moduleInputsFiles": [],
            "profile": "local-dev",
            "startCommandHash": "sha256:x",
            "overlayPath": "",
            "startedAt": hs.now_iso(),
        }
        _write_json(self.change / "runtime" / "service-session.json", session)

        code, payload = _run_json(
            [
                "stop",
                "--change-dir",
                str(self.change),
                "--if-started-by-ai",
            ]
        )
        self.assertEqual(code, 0, msg=payload)
        self.assertEqual(payload["action"], "skipped")
        self.assertEqual(payload.get("reason"), "not-started-by-ai")
        self.assertTrue(hs.is_pid_alive(proc.pid), msg="must not kill non-AI process")

    def test_if_started_by_ai_stops_ai_session(self) -> None:
        code, p = _run_json(
            [
                "ensure",
                "--change-dir",
                str(self.change),
                "--project",
                str(self.project),
            ]
        )
        self.assertEqual(code, 0, msg=p)
        pid = p["pid"]
        self._pids.append(pid)

        code2, p2 = _run_json(
            [
                "stop",
                "--change-dir",
                str(self.change),
                "--if-started-by-ai",
            ]
        )
        self.assertEqual(code2, 0, msg=p2)
        self.assertEqual(p2["action"], "stopped")
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and hs.is_pid_alive(pid):
            time.sleep(0.1)
        self.assertFalse(hs.is_pid_alive(pid))


class SessionOwnershipTests(unittest.TestCase):
    def test_ensure_persists_and_discovers_runtime_ownership(self) -> None:
        with tempfile.TemporaryDirectory(prefix="harness-svc-owner-") as raw:
            root = Path(raw)
            project = root / "worktree"
            change = project / ".harness" / "state" / "changes" / "demo"
            execution = root / "execution"
            project.mkdir(parents=True)
            execution.mkdir()
            health = change / "runtime" / "healthy.marker"
            _setup_project(project, health_file=health)
            code, payload = _run_json(
                [
                    "ensure",
                    "--change-dir",
                    str(change),
                    "--project",
                    str(project),
                    "--change-name",
                    "demo",
                    "--worktree-root",
                    str(project),
                    "--execution-root",
                    str(execution),
                    "--attempt-id",
                    "attempt-1",
                ]
            )
            self.assertEqual(code, 0, msg=payload)
            pid = payload["pid"]
            try:
                session = hs.load_session(change)
                self.assertIsNotNone(session)
                assert session is not None
                self.assertEqual(session["changeId"], "demo")
                self.assertEqual(Path(session["worktreeRoot"]), project.resolve())
                self.assertEqual(Path(session["executionRoot"]), execution.resolve())
                self.assertEqual(session["attemptId"], "attempt-1")
                found = hs.find_owned_sessions(
                    project,
                    change_id="demo",
                    execution_root=execution,
                    worktree_root=project,
                )
                self.assertEqual(len(found["owned"]), 1)
                self.assertFalse(found["reported"])
            finally:
                hs.stop_ai_session(change, hs.load_session(change) or {}, require_identity=True)
                if hs.is_pid_alive(pid):
                    hs.terminate_process_tree(pid)


class MissingServiceStartConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-svc-nocmd-"))
        self.project = self.tmp / "project"
        self.change = self.tmp / "change-1"
        self.change.mkdir(parents=True)
        self.project.mkdir(parents=True)
        _write_json(
            self.project / ".harness" / "config" / "build-profile.json",
            {
                "schemaVersion": 1,
                "serviceStart": {"command": "", "healthUrl": "", "startTimeoutSec": 10},
            },
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_missing_command_returns_error(self) -> None:
        buf = StringIO()
        err = StringIO()
        from contextlib import redirect_stderr

        with redirect_stdout(buf), redirect_stderr(err):
            code = hs.main(
                [
                    "--json",
                    "ensure",
                    "--change-dir",
                    str(self.change),
                    "--project",
                    str(self.project),
                ]
            )
        self.assertNotEqual(code, 0)
        err_text = err.getvalue()
        self.assertIn("serviceStart.command", err_text)


class StatusAndIdentityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-svc-status-"))
        self.project = self.tmp / "project"
        self.change = self.tmp / "change-1"
        self.change.mkdir(parents=True)
        self.project.mkdir(parents=True)
        self.health = self.change / "runtime" / "healthy.marker"
        self.mod = self.project / "Svc.java"
        _write(self.mod, "class Svc {}\n")
        _setup_project(self.project, health_file=self.health)
        self._pids: list[int] = []

    def tearDown(self) -> None:
        try:
            hs.main(["--json", "stop", "--change-dir", str(self.change)])
        except Exception:
            pass
        for pid in self._pids:
            if hs.is_pid_alive(pid):
                hs.terminate_process_tree(pid)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_status_reports_alive_and_fingerprint(self) -> None:
        code, p = _run_json(
            [
                "ensure",
                "--change-dir",
                str(self.change),
                "--project",
                str(self.project),
                "--files",
                str(self.mod),
            ]
        )
        self.assertEqual(code, 0, msg=p)
        self._pids.append(p["pid"])

        code2, s = _run_json(
            [
                "status",
                "--change-dir",
                str(self.change),
                "--files",
                str(self.mod),
            ]
        )
        self.assertEqual(code2, 0, msg=s)
        self.assertTrue(s["sessionPresent"])
        self.assertTrue(s["alive"])
        self.assertTrue(s["identityVerified"])
        self.assertTrue(s["fingerprintMatch"])

    def test_identity_unknown_yields_needs_user_decision(self) -> None:
        code, p = _run_json(
            [
                "ensure",
                "--change-dir",
                str(self.change),
                "--project",
                str(self.project),
            ]
        )
        self.assertEqual(code, 0, msg=p)
        self._pids.append(p["pid"])

        # Monkeypatch: create-time unavailable → conservative
        original = hs.get_process_create_time
        hs.get_process_create_time = lambda pid: None  # type: ignore[assignment]
        try:
            code2, p2 = _run_json(
                [
                    "ensure",
                    "--change-dir",
                    str(self.change),
                    "--project",
                    str(self.project),
                ]
            )
            self.assertEqual(code2, 0, msg=p2)
            self.assertEqual(p2["action"], "needs-user-decision")
            self.assertIn("cannot-verify", p2.get("reason", ""))
        finally:
            hs.get_process_create_time = original  # type: ignore[assignment]


class FatalKeywordAbortTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-svc-fatal-"))
        self.project = self.tmp / "project"
        self.change = self.tmp / "change-1"
        self.change.mkdir(parents=True)
        self.project.mkdir(parents=True)
        self.health = self.change / "runtime" / "healthy.marker"
        # Child stdout is redirected to service-start.log; emit a fatal keyword.
        fatal_script = self.change / "runtime" / "_fatal_svc.py"
        fatal_script.parent.mkdir(parents=True, exist_ok=True)
        fatal_script.write_text(
            "import sys, time\n"
            "sys.stdout.write('BeanCreationException: boom\\n')\n"
            "sys.stdout.flush()\n"
            "time.sleep(60)\n",
            encoding="utf-8",
            newline="\n",
        )
        py = sys.executable
        cmd = f'"{py}" "{fatal_script}"'
        _write(self.project / "Svc.java", "class Svc {}\n")
        profile = {
            "schemaVersion": 1,
            "serviceStart": {
                "command": cmd,
                # Health never appears → wait until fatal keyword detected
                "healthUrl": f"file:{self.health}",
                "startTimeoutSec": 30,
                "inputFiles": ["Svc.java"],
            },
        }
        _write_json(self.project / ".harness" / "config" / "build-profile.json", profile)

    def tearDown(self) -> None:
        try:
            hs.main(["--json", "stop", "--change-dir", str(self.change)])
        except Exception:
            pass
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_fatal_keyword_aborts_start(self) -> None:
        buf = StringIO()
        err = StringIO()
        from contextlib import redirect_stderr

        with redirect_stdout(buf), redirect_stderr(err):
            code = hs.main(
                [
                    "--json",
                    "ensure",
                    "--change-dir",
                    str(self.change),
                    "--project",
                    str(self.project),
                ]
            )
        self.assertNotEqual(code, 0)
        err_text = err.getvalue().strip()
        if err_text and not err_text.lstrip().startswith("{"):
            for line in reversed(err_text.splitlines()):
                if line.strip().startswith("{"):
                    err_text = line.strip()
                    break
        err_payload = json.loads(err_text)
        self.assertFalse(err_payload.get("ok", True))
        self.assertIn("BeanCreationException", err_payload.get("error", ""))
        self.assertEqual(err_payload.get("fatalKeyword"), "BeanCreationException")


@unittest.skipUnless(os.name == "nt", "Windows CLI survival")
class CliSurvivalTests(unittest.TestCase):
    """Service must stay alive after harness_service CLI process exits."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-svc-cli-"))
        self.project = self.tmp / "project"
        self.change = self.tmp / "change-1"
        self.change.mkdir(parents=True)
        self.project.mkdir(parents=True)
        self.health = self.change / "runtime" / "healthy.marker"
        _setup_project(self.project, health_file=self.health, sleep_sec=120)
        self.svc_py = SCRIPTS_DIR / "harness_service.py"

    def tearDown(self) -> None:
        try:
            subprocess.run(
                [sys.executable, str(self.svc_py), "--json", "stop", "--change-dir", str(self.change)],
                capture_output=True,
                text=True,
                timeout=30,
            )
        except Exception:
            pass
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _ensure_cli(self) -> tuple[int, dict]:
        proc = subprocess.Popen(
            [
                sys.executable,
                str(self.svc_py),
                "--json",
                "ensure",
                "--change-dir",
                str(self.change),
                "--project",
                str(self.project),
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            proc.wait(timeout=60)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
            raise
        code = proc.returncode if proc.returncode is not None else 0
        if code != 0:
            return code, {}
        buf = StringIO()
        with redirect_stdout(buf):
            hs.main(["--json", "status", "--change-dir", str(self.change)])
        payload = json.loads(buf.getvalue().strip()) if buf.getvalue().strip() else {}
        session_path = self.change / "runtime" / "service-session.json"
        if session_path.is_file():
            session = json.loads(session_path.read_text(encoding="utf-8"))
            payload.setdefault("pid", session.get("pid"))
        return code, payload

    def test_service_survives_cli_exit_and_reuses(self) -> None:
        code1, p1 = self._ensure_cli()
        self.assertEqual(code1, 0, msg=p1)
        pid1 = p1.get("pid")
        self.assertIsInstance(pid1, int)
        time.sleep(0.5)
        self.assertTrue(hs.is_pid_alive(pid1), msg=f"service pid {pid1} died after CLI exit")

        code2, p2 = self._ensure_cli()
        self.assertEqual(code2, 0, msg=p2)
        pid2 = p2.get("pid")
        self.assertEqual(pid2, pid1, msg="second ensure should reuse the same service pid")
        self.assertTrue(hs.is_pid_alive(pid2))


class ProbeHelpersTests(unittest.TestCase):
    def test_file_health_probe(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / "ok.txt"
            svc = {"healthUrl": f"file:{marker}"}
            self.assertFalse(hs.probe_health(svc))
            marker.write_text("1", encoding="utf-8")
            self.assertTrue(hs.probe_health(svc))

    def test_port_from_http_health(self) -> None:
        self.assertEqual(
            hs.port_from_health_spec("http://127.0.0.1:9093/actuator/health"),
            9093,
        )
        self.assertIsNone(hs.port_from_health_spec("file:C:/tmp/x"))


class ResolveServiceStartTests(unittest.TestCase):
    """Cluster 3 §3.1/§3.4: resolve_service_start 从模板 serviceStart + runtime
    context 生成 resolved serviceStart；持久 profile 不被写回；含 worktree/change
    陈旧持久值时拒绝。对应 UT-019 + design §3.4「修复输入端陈旧 profile」。"""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-svc-resolve-"))
        self.project = self.tmp / "project"
        self.project.mkdir(parents=True)
        self.health = self.tmp / "change" / "runtime" / "healthy.marker"
        self.profile_path = self.project / ".harness" / "config" / "build-profile.json"
        self._pids: list[int] = []

    def tearDown(self) -> None:
        for pid in self._pids:
            if hs.is_pid_alive(pid):
                hs.terminate_process_tree(pid)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_profile(
        self,
        *,
        command: str | None = None,
        profile: str = "",
        overlay_path: str = "",
    ) -> None:
        cmd = command if command is not None else _fake_service_command(self.health)
        prof = {
            "schemaVersion": 2,
            "serviceStart": {
                "command": cmd,
                "healthUrl": f"file:{self.health}",
                "healthFile": str(self.health),
                "startTimeoutSec": 20,
                "inputFiles": ["Svc.java"],
                "source": "detected",
                "profile": profile,
                "overlayPath": overlay_path,
            },
        }
        _write(self.project / "Svc.java", "class Svc {}\n")
        _write_json(self.profile_path, prof)

    def test_resolve_injects_overlay_and_profile_without_mutating_persistent(self) -> None:
        # UT-019: 模板（profile/overlay 空）+ change-name/overlay → resolved 含具体值；
        # 持久 profile 保持模板态（运行期 resolve 不写回持久 profile）。
        self._write_profile()  # 模板态：profile="", overlayPath=""
        before = self.profile_path.read_text(encoding="utf-8")
        profile = hs.load_build_profile(self.project)
        resolved = hs.resolve_service_start(
            profile,
            change_name="my-change",
            worktree_root=self.tmp / "wt",
            overlay_path="/runtime/overlays/c1/application.yml",
        )
        self.assertEqual(resolved["overlayPath"], "/runtime/overlays/c1/application.yml")
        self.assertEqual(resolved["profile"], "my-change")
        # 持久 profile 文件字节未变
        self.assertEqual(self.profile_path.read_text(encoding="utf-8"), before)
        persistent = json.loads(before)
        self.assertEqual(persistent["serviceStart"]["profile"], "")
        self.assertEqual(persistent["serviceStart"]["overlayPath"], "")

    def test_resolve_keeps_persistent_profile_when_non_empty(self) -> None:
        # 持久 profile.profile 非空（如 v1 残留 "local-dev"）→ resolved 保留持久值，
        # 不被 change_name 覆盖（向后兼容 v1 fixture）。
        self._write_profile(profile="local-dev")
        profile = hs.load_build_profile(self.project)
        resolved = hs.resolve_service_start(
            profile, change_name="my-change", worktree_root=self.tmp
        )
        self.assertEqual(resolved["profile"], "local-dev")

    def test_resolve_rejects_stale_worktree_path_in_overlay(self) -> None:
        # §3.4：serviceStart.overlayPath 含 .claude/worktrees/<change> → 陈旧持久值，拒绝
        self._write_profile(overlay_path=".claude/worktrees/old-change/overlay.yml")
        profile = hs.load_build_profile(self.project)
        with self.assertRaises(ValueError) as ctx:
            hs.resolve_service_start(
                profile, change_name="new-change", worktree_root=self.tmp
            )
        self.assertIn("stale", str(ctx.exception).lower())

    def test_resolve_rejects_stale_worktree_path_in_command(self) -> None:
        # §3.4：serviceStart.command 含 .claude/worktrees/<change> → 拒绝
        self._write_profile(command="java -jar .claude/worktrees/old-change/app.jar")
        profile = hs.load_build_profile(self.project)
        with self.assertRaises(ValueError):
            hs.resolve_service_start(
                profile, change_name="new-change", worktree_root=self.tmp
            )

    def test_resolve_rejects_unified_worktree_path_in_command(self) -> None:
        # §3.4：新统一路径 .worktrees/<change> 同样是陈旧持久值 → 拒绝
        self._write_profile(command="java -jar .worktrees/old-change/app.jar")
        profile = hs.load_build_profile(self.project)
        with self.assertRaises(ValueError) as ctx:
            hs.resolve_service_start(
                profile, change_name="new-change", worktree_root=self.tmp
            )
        self.assertIn("stale", str(ctx.exception).lower())

    def test_resolve_rejects_unified_worktree_path_in_overlay(self) -> None:
        self._write_profile(overlay_path=".worktrees/old-change/overlay.yml")
        profile = hs.load_build_profile(self.project)
        with self.assertRaises(ValueError):
            hs.resolve_service_start(
                profile, change_name="new-change", worktree_root=self.tmp
            )


class ServiceOwnershipContractTests(unittest.TestCase):
    def test_rejects_health_checks_that_do_not_prove_service_identity(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            marker = Path(tmp) / "health.marker"
            marker.write_text("foreign-instance", encoding="utf-8")
            service_start = {
                "healthFile": str(marker),
                "requireInstanceToken": True,
                "instanceToken": "owned-token",
            }
            self.assertFalse(
                hs.probe_health(
                    service_start,
                    expected_instance_token="owned-token",
                )
            )
            marker.write_text("owned-token", encoding="utf-8")
            self.assertTrue(
                hs.probe_health(
                    service_start,
                    expected_instance_token="owned-token",
                )
            )

    def test_tokenless_listener_reuse_requires_owned_tree_proof(self) -> None:
        service_start = {
            "healthUrl": "tcp://127.0.0.1:4173/health",
            "port": 4173,
        }
        self.assertFalse(hs._listener_identity_is_owned({}, service_start))
        session = {
            "processAttestation": {"pid": 1234},
            "ownershipProof": {"proofId": "proof-1"},
        }
        with (
            mock.patch.object(hs._process_provider, "_observe_proof_members", return_value=[{"pid": 1234}]),
            mock.patch.object(hs._process_provider, "validate_ownership_proof", return_value={"ok": True}),
        ):
            self.assertTrue(hs._listener_identity_is_owned(session, service_start))

    def test_windows_launcher_owns_child_job_until_service_exits(self) -> None:
        source = hs._WIN_LAUNCHER_SOURCE

        self.assertIn("CreateJobObjectW", source)
        self.assertIn("AssignProcessToJobObject", source)
        self.assertIn("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE", source)
        self.assertIn("proc.wait()", source)

    def test_session_records_creation_identity_and_owned_ports(self) -> None:
        session = hs.build_session(
            pid=4321,
            module_inputs_hash="sha256:inputs",
            module_inputs_files=["Svc.java"],
            command="npm run dev",
            service_start={
                "profile": "local",
                "port": 4173,
                "healthUrl": "http://127.0.0.1:4173/health",
            },
            started_at="2026-07-31T12:00:00+00:00",
            service_pid=4322,
            job_id="harness-job-1",
        )

        self.assertEqual(session["ownedPorts"], [4173])
        self.assertEqual(session["servicePid"], 4322)
        self.assertEqual(session["jobId"], "harness-job-1")
        identity = session["processIdentity"]
        self.assertEqual(identity["commandHash"], hs.sha256_text("npm run dev"))
        self.assertEqual(identity["startedAt"], session["startedAt"])
        self.assertTrue(identity["executable"])
        self.assertTrue(identity["parentChain"])

    def test_stop_retains_session_when_process_tree_exit_is_unconfirmed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change"
            session = {
                "pid": 4321,
                "startedBy": "AI",
                "startedAt": "2026-07-31T12:00:00+00:00",
                "ownedPorts": [4173],
            }
            hs.write_session(change, session)
            with (
                mock.patch.object(hs, "verify_process_identity", return_value=True),
                mock.patch.object(hs, "terminate_process_tree"),
                mock.patch.object(hs, "is_pid_alive", return_value=True),
                mock.patch.object(hs, "is_port_in_use", return_value=False),
                mock.patch.object(hs, "STOP_CONFIRM_TIMEOUT_SEC", 0),
            ):
                result = hs.stop_ai_session(change, session)

            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "PROCESS_TREE_EXIT_UNCONFIRMED")
            self.assertFalse(result["sessionCleared"])
            self.assertTrue(hs.session_path(change).is_file())

    def test_stop_retains_session_when_owned_port_is_still_bound(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change"
            session = {
                "pid": 4321,
                "startedBy": "AI",
                "startedAt": "2026-07-31T12:00:00+00:00",
                "ownedPorts": [4173],
            }
            hs.write_session(change, session)
            with (
                mock.patch.object(hs, "verify_process_identity", return_value=True),
                mock.patch.object(hs, "terminate_process_tree"),
                mock.patch.object(hs, "is_pid_alive", return_value=False),
                mock.patch.object(hs, "is_port_in_use", return_value=True),
                mock.patch.object(hs, "STOP_CONFIRM_TIMEOUT_SEC", 0),
            ):
                result = hs.stop_ai_session(change, session)

            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "OWNED_PORT_RELEASE_UNCONFIRMED")
            self.assertEqual(result["occupiedPorts"], [4173])
            self.assertTrue(hs.session_path(change).is_file())

    def test_serializes_service_mutations_with_generation_compare_and_swap(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change"
            first = hs.ServiceMutationLock(change, operation="ensure")
            self.assertIsNone(first.acquire())
            try:
                second = hs.ServiceMutationLock(change, operation="stop")
                conflict = second.acquire()
                self.assertIsNotNone(conflict)
                self.assertEqual(conflict["code"], "SERVICE_MUTATION_CONFLICT")
                self.assertEqual(conflict["owner"]["operation"], "ensure")
            finally:
                first.release()
            third = hs.ServiceMutationLock(change, operation="retire")
            self.assertIsNone(third.acquire())
            third.release()

    def test_validates_every_service_transition_and_generation_rule(self) -> None:
        session = {"serviceGeneration": "generation-old", "stateRevision": 0}
        hs._ensure_session_state(session, operation_id="op-1")
        generation = session["serviceGeneration"]
        hs._transition(
            session,
            "STARTING",
            reason_code="SERVICE_STARTING",
            operation_id="op-1",
        )
        hs._transition(
            session,
            "READY",
            reason_code="SERVICE_READY",
            operation_id="op-1",
        )
        self.assertEqual(session["serviceGeneration"], generation)
        self.assertEqual(session["stateRevision"], 2)
        self.assertEqual(
            [item["to"] for item in session["transitionHistory"]],
            ["STARTING", "READY"],
        )
        revision_before = session["stateRevision"]
        conflict = hs._transition(
            session,
            "STARTING",
            reason_code="SERVICE_START_REQUESTED",
            operation_id="op-conflict",
        )
        self.assertEqual(conflict["code"], "SERVICE_TRANSITION_CONFLICT")
        self.assertEqual(session["stateRevision"], revision_before)

    def test_durable_service_session_accepts_operational_projection_fields(self) -> None:
        attestation = hs._process_provider.observe_process_identity(os.getpid())
        session = hs.build_session(
            pid=os.getpid(),
            module_inputs_hash="sha256:" + "a" * 64,
            module_inputs_files=["src/app.py"],
            command="python src/app.py",
            argv=["python", "src/app.py"],
            service_start={"serviceId": "preview", "profile": "local-dev"},
            process_attestation=attestation,
        )
        hs._ensure_session_state(session, operation_id="op-contract", generation=1)
        hs._transition(
            session,
            "READY",
            reason_code="SERVICE_READY",
            operation_id="op-contract",
        )
        parsed = hec.parse_execution_contract("service-session", session)
        self.assertTrue(parsed["ok"], parsed)

    def test_stop_refuses_unlisted_transition_before_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change"
            session = {
                "pid": 999999,
                "startedBy": "AI",
                "startedAt": "2026-08-01T00:00:00+00:00",
                "status": "FAILED",
                "processIdentity": {"executable": str(Path(sys.executable).resolve())},
                "serviceGeneration": 1,
                "stateRevision": 1,
            }
            with (
                mock.patch.object(hs, "verify_process_identity", return_value=True),
                mock.patch.object(hs, "terminate_process_tree") as terminate,
            ):
                result = hs.stop_ai_session(change, session)
            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "SERVICE_TRANSITION_CONFLICT")
            self.assertFalse(result["killed"])
            terminate.assert_not_called()
            self.assertEqual(session["status"], "FAILED")

    def test_never_treats_heartbeat_as_process_ownership_authority(self) -> None:
        session = {
            "serviceGeneration": "generation-1",
            "stateRevision": 1,
        }
        hs._ensure_session_state(session, operation_id="op-1")
        session["heartbeat"]["lastSeenAt"] = "2000-01-01T00:00:00+00:00"
        heartbeat = hs._heartbeat_status(session)
        self.assertTrue(heartbeat["stale"])
        self.assertEqual(heartbeat["reasonCode"], "SERVICE_HEARTBEAT_STALE")
        self.assertNotIn("killed", heartbeat)


class StaleSessionRetirementTests(unittest.TestCase):
    def test_retire_stale_preserves_evidence_without_touching_unknown_process(
        self,
    ) -> None:
        retire = getattr(hs, "retire_stale_session", None)
        self.assertTrue(callable(retire), "retire_stale_session must be implemented")
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            session = {
                "sessionId": "stale-session",
                "pid": 999_999_999,
                "startedAt": "2026-07-31T10:00:00+08:00",
                "startedBy": "AI",
                "processIdentity": {
                    "executable": str(Path(sys.executable).resolve()),
                },
            }
            hs.write_session(change_dir, session)
            result = retire(change_dir)
            self.assertTrue(result["ok"])
            self.assertEqual(result["action"], "retired-stale")
            self.assertTrue(result["unknownProcessUntouched"])
            self.assertFalse(hs.session_path(change_dir).exists())
            retired = Path(result["retiredEvidence"])
            self.assertTrue(retired.is_file())
            self.assertEqual(
                json.loads(retired.read_text(encoding="utf-8"))["sessionId"],
                "stale-session",
            )
            receipt_files = list((change_dir / "runtime" / "retired-service-sessions").glob("*.receipt.json"))
            self.assertEqual(len(receipt_files), 1)
            receipt = json.loads(receipt_files[0].read_text(encoding="utf-8"))
            self.assertEqual(receipt["state"], "FINALIZED")
            self.assertEqual(receipt["retirementStateCommit"]["status"], "COMMITTED")
            self.assertFalse(receipt["cleanupComplete"])
            repeated = retire(change_dir)
            self.assertTrue(repeated["ok"])
            self.assertEqual(repeated["code"], "SERVICE_RETIRED")

    def test_links_exactly_one_future_service_generation_to_a_retirement_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change_dir = Path(tmp)
            retired_root = change_dir / "runtime" / "retired-service-sessions"
            retired_root.mkdir(parents=True)
            receipt_path = retired_root / "retired.receipt.json"
            receipt_path.write_text(
                json.dumps(
                    {
                        "schemaVersion": 2,
                        "oldGeneration": 7,
                        "awaitingSuperseder": True,
                    }
                ),
                encoding="utf-8",
            )
            new_session = {
                "pid": 99999999,
                "startedBy": "AI",
                "startedAt": "2026-08-01T00:00:00+00:00",
                "sessionId": "session-new",
                "serviceGeneration": 8,
            }
            linked = hs.link_superseder(
                change_dir,
                retirement_receipt=receipt_path,
                new_session=new_session,
                operation_id="link-op-1",
            )
            self.assertTrue(linked["ok"], linked)
            self.assertEqual(linked["code"], "SUPERSEDER_LINKED")
            self.assertFalse(linked["receipt"]["awaitingSuperseder"])
            persisted = json.loads(receipt_path.read_text(encoding="utf-8"))
            self.assertEqual(persisted["supersededBySessionId"], "session-new")
            self.assertEqual(persisted["oldGeneration"], 7)
            repeated = hs.link_superseder(
                change_dir,
                retirement_receipt=receipt_path,
                new_session=new_session,
                operation_id="link-op-1",
            )
            self.assertEqual(repeated["code"], "SUPERSEDER_ALREADY_LINKED")


if __name__ == "__main__":
    unittest.main()
