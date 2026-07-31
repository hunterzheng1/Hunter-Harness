#!/usr/bin/env python3
"""Resolve Harness runtimes into a reusable, argv-based phase capsule."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

SCHEMA_VERSION = 1
RUN_SESSION_SCHEMA_VERSION = 1
RUN_TERMINAL_STATUSES = {"OK", "FAIL", "INCOMPLETE", "CANCELLED"}
_CHANGE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_ADAPTERS = {
    "claude-code": (".worktrees", "harness/"),
    "codex": (".worktrees", "harness/"),
    "cursor": (".worktrees", "harness/"),
    "codebuddy": (".worktrees", "harness/"),
}


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="milliseconds")


def _stage_transition(receipt: dict[str, Any], next_stage: str) -> None:
    ended_at = now_iso()
    started_at = str(receipt.get("stageStartedAt") or ended_at)
    try:
        started = dt.datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        ended = dt.datetime.fromisoformat(ended_at.replace("Z", "+00:00"))
        wall_ms = max(0, int((ended - started).total_seconds() * 1000))
    except ValueError:
        wall_ms = 0
    stage = str(receipt.get("stage") or "unknown")
    timings = receipt.setdefault("stageTimings", [])
    if isinstance(timings, list):
        timings.append(
            {
                "stage": stage,
                "createdAt": started_at,
                "endedAt": ended_at,
                "wallClockMs": wall_ms,
                "activeTimeMs": 0 if stage == "resource-wait" else wall_ms,
                "resourceWaitMs": wall_ms if stage == "resource-wait" else 0,
            }
        )
    receipt["stage"] = next_stage
    receipt["stageStartedAt"] = ended_at


def _close_current_stage(receipt: dict[str, Any]) -> None:
    current = str(receipt.get("stage") or "record")
    _stage_transition(receipt, current)
    timings = receipt.get("stageTimings")
    if isinstance(timings, list) and timings:
        receipt["stageStartedAt"] = timings[-1].get("endedAt")


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    fd, raw_tmp = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    tmp = Path(raw_tmp)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        # Windows can transiently deny replacement while another process has
        # just finished reading the receipt.  Keep the atomic replace contract,
        # but retry the sharing violation within a small bounded window.
        for attempt in range(20):
            try:
                os.replace(tmp, path)
                break
            except PermissionError:
                if attempt == 19:
                    raise
                time.sleep(0.01 * (attempt + 1))
    finally:
        tmp.unlink(missing_ok=True)


def _sha256_json(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _run_sessions_root(state_root: Path) -> Path:
    return state_root.expanduser().resolve() / "runtime" / "run-sessions"


def _run_session_root(state_root: Path, session_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", session_id):
        raise ValueError(f"RUN_SESSION_ID_INVALID: {session_id}")
    return _run_sessions_root(state_root) / session_id


def _run_receipt_path(state_root: Path, session_id: str) -> Path:
    return _run_session_root(state_root, session_id) / "session.json"


def _load_run_receipt(state_root: Path, session_id: str) -> dict[str, Any]:
    path = _run_receipt_path(state_root, session_id)
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError as exc:
        raise ValueError(f"RUN_SESSION_NOT_FOUND: {session_id}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"RUN_SESSION_CORRUPT: {session_id}")
    return value


def _resource_lock_root() -> Path:
    return Path(
        os.environ.get(
            "HARNESS_RESOURCE_LOCK_ROOT",
            str(Path(tempfile.gettempdir()) / "hunter-harness-resource-locks"),
        )
    ).expanduser().resolve()


def _resource_lock_path(_state_root: Path, lock_name: str) -> Path:
    digest = hashlib.sha256(lock_name.encode("utf-8")).hexdigest()
    return _resource_lock_root() / f"{digest}.json"


def _lock_owner_identity(owner: Any) -> bool | None:
    if not isinstance(owner, dict):
        return None
    pid = owner.get("pid")
    started_at = owner.get("startedAt")
    executable = owner.get("executable")
    if (
        not isinstance(pid, int)
        or pid <= 0
        or not isinstance(started_at, str)
        or not started_at
        or not isinstance(executable, str)
        or not executable
    ):
        return None
    from harness_service import verify_process_identity

    return verify_process_identity(
        {
            "pid": pid,
            "startedAt": started_at,
            "processIdentity": {"executable": executable},
        }
    )


def _valid_resource_lock_record(
    record: Any,
    *,
    lock_name: str,
) -> bool:
    return bool(
        isinstance(record, dict)
        and record.get("schemaVersion") == 2
        and record.get("lockName") == lock_name
        and isinstance(record.get("sessionId"), str)
        and record.get("sessionId")
        and isinstance(record.get("token"), str)
        and record.get("token")
        and isinstance(record.get("heartbeatAtUnix"), (int, float))
        and isinstance(record.get("expiresAtUnix"), (int, float))
        and _lock_owner_identity(record.get("owner")) is not None
    )


def _write_resource_lock(
    path: Path,
    *,
    lock_name: str,
    session_id: str,
    token: str,
    owner: dict[str, Any],
    acquired_at: str,
) -> None:
    now = time.time()
    atomic_write_json(
        path,
        {
            "schemaVersion": 2,
            "lockName": lock_name,
            "sessionId": session_id,
            "token": token,
            "acquiredAt": acquired_at,
            "heartbeatAtUnix": now,
            "expiresAtUnix": now + 300.0,
            "owner": owner,
        },
    )


def _refresh_resource_locks(
    state_root: Path,
    session_id: str,
    tokens: dict[str, str],
    owner: dict[str, Any],
) -> bool:
    refreshed = True
    for lock_name, token in sorted(tokens.items()):
        path = _resource_lock_path(state_root, lock_name)
        try:
            record = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            refreshed = False
            continue
        if (
            not _valid_resource_lock_record(record, lock_name=lock_name)
            or record.get("sessionId") != session_id
            or record.get("token") != token
        ):
            refreshed = False
            continue
        _write_resource_lock(
            path,
            lock_name=lock_name,
            session_id=session_id,
            token=token,
            owner=owner,
            acquired_at=str(record["acquiredAt"]),
        )
    return refreshed


def _release_resource_locks(
    state_root: Path,
    session_id: str,
    tokens: dict[str, str],
) -> bool:
    released = True
    for lock_name, token in sorted(tokens.items()):
        path = _resource_lock_path(state_root, lock_name)
        try:
            record = json.loads(path.read_text(encoding="utf-8-sig"))
        except FileNotFoundError:
            continue
        except (OSError, json.JSONDecodeError):
            released = False
            continue
        if (
            not isinstance(record, dict)
            or record.get("sessionId") != session_id
            or record.get("token") != token
        ):
            released = False
            continue
        try:
            path.unlink()
        except OSError:
            released = False
    return released


def _acquire_resource_locks(
    state_root: Path,
    session_id: str,
    lock_names: list[str],
) -> tuple[dict[str, str], dict[str, Any] | None]:
    tokens: dict[str, str] = {}
    for lock_name in lock_names:
        path = _resource_lock_path(state_root, lock_name)
        path.parent.mkdir(parents=True, exist_ok=True)
        token = uuid.uuid4().hex
        owner_identity = _process_identity(os.getpid(), sys.executable)
        now = time.time()
        record = {
            "schemaVersion": 2,
            "lockName": lock_name,
            "sessionId": session_id,
            "token": token,
            "acquiredAt": now_iso(),
            "heartbeatAtUnix": now,
            "expiresAtUnix": now + 300.0,
            "owner": owner_identity,
        }
        encoded = (
            json.dumps(record, ensure_ascii=False, indent=2) + "\n"
        ).encode("utf-8")
        for attempt in range(2):
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                owner: dict[str, Any] | None = None
                try:
                    loaded = json.loads(path.read_text(encoding="utf-8-sig"))
                    owner = loaded if isinstance(loaded, dict) else None
                except (OSError, json.JSONDecodeError):
                    owner = None
                reclaimable = bool(
                    _valid_resource_lock_record(owner, lock_name=lock_name)
                    and _lock_owner_identity(owner.get("owner")) is False
                )
                if reclaimable and attempt == 0:
                    try:
                        current = json.loads(path.read_text(encoding="utf-8-sig"))
                        if current.get("token") == owner.get("token"):
                            path.unlink()
                            continue
                    except (OSError, json.JSONDecodeError):
                        pass
                _release_resource_locks(state_root, session_id, tokens)
                return {}, {
                    "lockName": lock_name,
                    "ownerSessionId": (
                        owner.get("sessionId") if owner is not None else None
                    ),
                    "lockRecordValid": bool(
                        _valid_resource_lock_record(owner, lock_name=lock_name)
                    ),
                    "ownerIdentity": (
                        _lock_owner_identity(owner.get("owner"))
                        if owner is not None
                        else None
                    ),
                }
            else:
                break
        else:
            raise RuntimeError("RESOURCE_LOCK_ACQUIRE_RETRY_EXHAUSTED")
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
        except BaseException:
            path.unlink(missing_ok=True)
            _release_resource_locks(state_root, session_id, tokens)
            raise
        tokens[lock_name] = token
    return tokens, None


def _write_run_receipt(state_root: Path, receipt: dict[str, Any]) -> None:
    atomic_write_json(
        _run_receipt_path(state_root, str(receipt["sessionId"])),
        receipt,
    )


def _process_identity(pid: int, executable_hint: str) -> dict[str, Any]:
    from harness_service import get_process_create_time, get_process_executable

    created = get_process_create_time(pid)
    executable = get_process_executable(pid)
    return {
        "pid": pid,
        "startedAt": (
            created.astimezone().isoformat(timespec="milliseconds")
            if created is not None
            else now_iso()
        ),
        "executable": executable or _absolute_executable(executable_hint),
    }


def _spawn_detached_worker(
    argv: list[str],
    *,
    cwd: Path,
    env: dict[str, str],
    output: Any = subprocess.DEVNULL,
) -> subprocess.Popen[bytes]:
    kwargs: dict[str, Any] = {
        "cwd": str(cwd),
        "env": env,
        "stdin": subprocess.DEVNULL,
        "stdout": output,
        "stderr": output,
        "close_fds": True,
    }
    if os.name == "nt":
        detached = 0x00000008
        new_group = 0x00000200
        no_window = 0x08000000
        breakaway = 0x01000000
        try:
            return subprocess.Popen(
                argv,
                creationflags=detached | new_group | no_window | breakaway,
                **kwargs,
            )
        except OSError:
            return subprocess.Popen(
                argv,
                creationflags=detached | new_group | no_window,
                **kwargs,
            )
    return subprocess.Popen(argv, start_new_session=True, **kwargs)


def start_run_session(
    *,
    state_root: Path,
    verification: str,
    argv: list[str],
    working_directory: Path,
    environment: dict[str, str] | None = None,
    timeout_seconds: float | None = None,
    heartbeat_seconds: float = 30.0,
    expected_duration_seconds: float | None = None,
    product_identity: str | None = None,
    resource_locks: list[str] | None = None,
    run_id: str | None = None,
    session_id: str | None = None,
) -> dict[str, Any]:
    """Start a re-attachable managed command without shell re-parsing.

    The short-lived launch specification is removed by the worker immediately
    after spawn. Environment values are inherited by the worker and hashed in
    the durable receipt; they are never serialized.
    """
    if not verification.strip():
        raise ValueError("RUN_SESSION_VERIFICATION_REQUIRED")
    if not argv or not all(isinstance(item, str) and item for item in argv):
        raise ValueError("RUN_SESSION_ARGV_REQUIRED")
    if heartbeat_seconds <= 0:
        raise ValueError("RUN_SESSION_HEARTBEAT_INVALID")
    if timeout_seconds is not None and timeout_seconds <= 0:
        raise ValueError("RUN_SESSION_TIMEOUT_INVALID")
    normalized_resource_locks: list[str] = []
    for raw_lock in resource_locks or []:
        if (
            not isinstance(raw_lock, str)
            or not raw_lock.strip()
            or len(raw_lock.strip()) > 256
        ):
            raise ValueError("RUN_SESSION_RESOURCE_LOCK_INVALID")
        normalized_resource_locks.append(raw_lock.strip())
    normalized_resource_locks = sorted(set(normalized_resource_locks))

    state_root = state_root.expanduser().resolve()
    working_directory = working_directory.expanduser().resolve()
    if not working_directory.is_dir():
        raise ValueError(f"RUN_SESSION_WORKDIR_MISSING: {working_directory}")
    session_id = session_id or f"run-{uuid.uuid4().hex}"
    run_id = run_id or session_id
    session_root = _run_session_root(state_root, session_id)
    session_root.mkdir(parents=True, exist_ok=False)
    created_at = now_iso()
    stdout_path = session_root / "stdout.log"
    stderr_path = session_root / "stderr.log"
    worker_log_path = session_root / "worker.log"
    spec_path = session_root / "launch-spec.json"
    overrides = dict(environment or {})
    command_hash = _sha256_json(argv)
    environment_hash = _sha256_json(overrides)
    receipt: dict[str, Any] = {
        "schemaVersion": RUN_SESSION_SCHEMA_VERSION,
        "sessionId": session_id,
        "runId": run_id,
        "verification": verification,
        "commandHash": command_hash,
        "workingDirectory": str(working_directory),
        "environmentHash": environment_hash,
        "launcherPid": os.getpid(),
        "workerPid": None,
        "servicePid": None,
        "processIdentity": None,
        "createdAt": created_at,
        "lastHeartbeatAt": created_at,
        "startedAt": None,
        "endedAt": None,
        "exitCode": None,
        "status": "STARTING",
        "reasonCode": "WORKER_STARTING",
        "stage": "prepare",
        "stageStartedAt": created_at,
        "stageTimings": [],
        "stdoutPath": str(stdout_path),
        "stderrPath": str(stderr_path),
        "workerLogPath": str(worker_log_path),
        "resultDigest": None,
        "cleanupStatus": "PENDING",
        "testProcessStarted": False,
        "timeoutSeconds": timeout_seconds,
        "heartbeatSeconds": heartbeat_seconds,
        "expectedDurationSeconds": expected_duration_seconds,
        "productIdentity": product_identity,
        "resourceLocks": normalized_resource_locks,
        "resourceLockTokens": {},
        "resourceWaitMs": 0,
        "activeTimeMs": 0,
        "wallClockMs": 0,
        "diagnosticPath": None,
    }
    _write_run_receipt(state_root, receipt)
    lock_tokens, lock_conflict = _acquire_resource_locks(
        state_root,
        session_id,
        normalized_resource_locks,
    )
    if lock_conflict is not None:
        receipt.update(
            {
                "status": "INCOMPLETE",
                "reasonCode": "RESOURCE_LOCK_BUSY",
                "endedAt": now_iso(),
                "cleanupStatus": "NO_CHILD",
                "resourceLockConflict": lock_conflict,
            }
        )
        _write_run_receipt(state_root, receipt)
        return receipt
    receipt["resourceLockTokens"] = lock_tokens
    _write_run_receipt(state_root, receipt)
    atomic_write_json(
        spec_path,
        {
            "schemaVersion": 1,
            "stateRoot": str(state_root),
            "sessionId": session_id,
            "argv": argv,
            "heartbeatSeconds": heartbeat_seconds,
        },
    )
    try:
        spec_path.chmod(0o600)
    except OSError:
        pass

    worker_env = {**os.environ, **overrides}
    worker_env["PYTHONUTF8"] = "1"
    worker_env["PYTHONIOENCODING"] = "utf-8"
    worker_env["HARNESS_RUN_SESSION_WORKER"] = "1"
    worker_argv = [
        _absolute_executable(sys.executable),
        str(Path(__file__).resolve()),
        "_worker",
        "--state-root",
        str(state_root),
        "--session-id",
        session_id,
    ]
    try:
        with worker_log_path.open("ab", buffering=0) as worker_log:
            worker = _spawn_detached_worker(
                worker_argv,
                cwd=working_directory,
                env=worker_env,
                output=worker_log,
            )
    except OSError as exc:
        spec_path.unlink(missing_ok=True)
        locks_released = _release_resource_locks(
            state_root,
            session_id,
            lock_tokens,
        )
        receipt.update(
            {
                "status": "INCOMPLETE",
                "reasonCode": "WORKER_LAUNCH_FAILED",
                "endedAt": now_iso(),
                "cleanupStatus": (
                    "NO_CHILD"
                    if locks_released
                    else "RESOURCE_LOCK_RELEASE_FAILED"
                ),
                "error": str(exc),
            }
        )
        _write_run_receipt(state_root, receipt)
        return receipt
    receipt["workerPid"] = worker.pid
    receipt["workerIdentity"] = _process_identity(worker.pid, sys.executable)
    # Best-effort early handoff. The worker repeats and verifies this transfer
    # before spawning the managed command. Do not rewrite the session receipt
    # here: the detached worker may already have advanced it to RUNNING.
    _refresh_resource_locks(
        state_root,
        session_id,
        lock_tokens,
        dict(receipt["workerIdentity"]),
    )
    threading.Thread(target=worker.wait, daemon=True).start()
    return receipt


def _terminate_managed_child(
    process: subprocess.Popen[bytes],
    job: Any,
) -> bool:
    from harness_service import is_pid_alive, terminate_process_tree

    if job is not None and getattr(job, "handle", None) is not None:
        job.terminate_and_wait()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            return False
        return not is_pid_alive(process.pid)
    terminate_process_tree(process.pid)
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        return False
    return not is_pid_alive(process.pid)


def _run_session_worker(state_root: Path, session_id: str) -> int:
    from harness_service import verify_process_identity

    session_root = _run_session_root(state_root, session_id)
    spec_path = session_root / "launch-spec.json"
    receipt = _load_run_receipt(state_root, session_id)
    try:
        spec = json.loads(spec_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        _release_resource_locks(
            state_root,
            session_id,
            dict(receipt.get("resourceLockTokens") or {}),
        )
        receipt.update(
            {
                "status": "INCOMPLETE",
                "reasonCode": "LAUNCH_SPEC_INVALID",
                "endedAt": now_iso(),
                "cleanupStatus": "NO_CHILD",
                "error": str(exc),
            }
        )
        _write_run_receipt(state_root, receipt)
        return 1
    argv = [str(item) for item in spec.get("argv", [])]
    heartbeat_seconds = max(float(spec.get("heartbeatSeconds") or 30.0), 0.01)
    spec_path.unlink(missing_ok=True)
    started_monotonic = time.monotonic()
    _stage_transition(receipt, "spawn")
    receipt.update(
        {
            "workerPid": os.getpid(),
            "workerIdentity": _process_identity(os.getpid(), sys.executable),
            "lastHeartbeatAt": now_iso(),
        }
    )
    if not _refresh_resource_locks(
        state_root,
        session_id,
        dict(receipt.get("resourceLockTokens") or {}),
        dict(receipt["workerIdentity"]),
    ):
        receipt.update(
            {
                "status": "INCOMPLETE",
                "reasonCode": "RESOURCE_LOCK_OWNERSHIP_LOST",
                "endedAt": now_iso(),
                "cleanupStatus": "NO_CHILD",
            }
        )
        _write_run_receipt(state_root, receipt)
        return 1
    _write_run_receipt(state_root, receipt)

    stdout_path = Path(str(receipt["stdoutPath"]))
    stderr_path = Path(str(receipt["stderrPath"]))
    stdout_path.parent.mkdir(parents=True, exist_ok=True)
    job = None
    process: subprocess.Popen[bytes] | None = None
    try:
        with stdout_path.open("wb", buffering=0) as stdout, stderr_path.open(
            "wb", buffering=0
        ) as stderr:
            popen_kwargs: dict[str, Any] = {
                "cwd": str(receipt["workingDirectory"]),
                "env": os.environ.copy(),
                "stdin": subprocess.DEVNULL,
                "stdout": stdout,
                "stderr": stderr,
                "shell": False,
                "close_fds": True,
            }
            if os.name == "nt":
                popen_kwargs["creationflags"] = 0x00000200
            else:
                popen_kwargs["start_new_session"] = True
            try:
                process = subprocess.Popen(argv, **popen_kwargs)
            except OSError as exc:
                receipt.update(
                    {
                        "status": "INCOMPLETE",
                        "reasonCode": "LAUNCHER_FAILED",
                        "endedAt": now_iso(),
                        "exitCode": None,
                        "testProcessStarted": False,
                        "cleanupStatus": "NO_CHILD",
                        "error": str(exc),
                    }
                )
                return 1
            identity = _process_identity(process.pid, argv[0])
            if os.name == "nt":
                from harness_test_runner import _WindowsKillOnCloseJob

                candidate = _WindowsKillOnCloseJob()
                if candidate.assign(process):
                    job = candidate
                else:
                    identity_session = {
                        "pid": process.pid,
                        "startedAt": identity["startedAt"],
                        "processIdentity": {
                            "executable": identity["executable"],
                        },
                    }
                    verified = verify_process_identity(identity_session) is True
                    terminated = (
                        _terminate_managed_child(process, None)
                        if verified
                        else False
                    )
                    receipt.update(
                        {
                            "servicePid": process.pid,
                            "processIdentity": identity,
                            "startedAt": identity["startedAt"],
                            "status": "INCOMPLETE",
                            "reasonCode": "PROCESS_TREE_ISOLATION_UNAVAILABLE",
                            "stage": "spawn",
                            "testProcessStarted": True,
                            "processTreeIsolated": False,
                            "exitCode": process.poll(),
                            "cleanupStatus": (
                                "PROCESS_TREE_TERMINATED"
                                if terminated
                                else "PROCESS_TERMINATION_UNCONFIRMED"
                            ),
                        }
                    )
                    return 1
            _stage_transition(receipt, "execute")
            receipt.update(
                {
                    "servicePid": process.pid,
                    "processIdentity": identity,
                    "startedAt": identity["startedAt"],
                    "status": "RUNNING",
                    "reasonCode": "CHILD_RUNNING",
                    "testProcessStarted": True,
                    "processTreeIsolated": job is not None or os.name != "nt",
                }
            )
            _write_run_receipt(state_root, receipt)

            timeout_seconds = receipt.get("timeoutSeconds")
            next_heartbeat = time.monotonic()
            termination_reason: str | None = None
            while process.poll() is None:
                now = time.monotonic()
                if timeout_seconds is not None and (
                    now - started_monotonic >= float(timeout_seconds)
                ):
                    termination_reason = "TIMEOUT"
                cancel_path = session_root / "cancel-request.json"
                if cancel_path.is_file():
                    termination_reason = "CANCEL_REQUESTED"
                if termination_reason is not None:
                    diagnostic_path = session_root / "diagnostic.json"
                    identity_session = {
                        "pid": process.pid,
                        "startedAt": identity["startedAt"],
                        "processIdentity": {
                            "executable": identity["executable"],
                        },
                    }
                    verified = verify_process_identity(identity_session) is True
                    job_owned = job is not None
                    diagnostic = {
                        "schemaVersion": 1,
                        "sessionId": session_id,
                        "reasonCode": termination_reason,
                        "observedAt": now_iso(),
                        "processIdentityVerified": verified,
                        "terminationAuthority": (
                            "JOB_OBJECT_OWNED"
                            if job_owned
                            else (
                                "PROCESS_IDENTITY_VERIFIED"
                                if verified
                                else "NONE"
                            )
                        ),
                        "pid": process.pid,
                        "stdoutBytes": (
                            stdout_path.stat().st_size if stdout_path.exists() else 0
                        ),
                        "stderrBytes": (
                            stderr_path.stat().st_size if stderr_path.exists() else 0
                        ),
                    }
                    atomic_write_json(diagnostic_path, diagnostic)
                    receipt["diagnosticPath"] = str(diagnostic_path)
                    if job_owned or verified:
                        terminated = _terminate_managed_child(process, job)
                        job = None
                        if not terminated:
                            receipt.update(
                                {
                                    "status": "INCOMPLETE",
                                    "reasonCode": "PROCESS_TERMINATION_UNCONFIRMED",
                                    "cleanupStatus": "PROCESS_TERMINATION_UNCONFIRMED",
                                }
                            )
                    else:
                        receipt.update(
                            {
                                "status": "INCOMPLETE",
                                "reasonCode": "PROCESS_IDENTITY_UNVERIFIED",
                                "cleanupStatus": "UNKNOWN_PROCESS_UNTOUCHED",
                            }
                        )
                    break
                if now >= next_heartbeat:
                    receipt["lastHeartbeatAt"] = now_iso()
                    receipt["activeTimeMs"] = int(
                        (now - started_monotonic) * 1000
                    )
                    receipt["wallClockMs"] = receipt["activeTimeMs"]
                    if not _refresh_resource_locks(
                        state_root,
                        session_id,
                        dict(receipt.get("resourceLockTokens") or {}),
                        dict(receipt["workerIdentity"]),
                    ):
                        receipt.update(
                            {
                                "status": "INCOMPLETE",
                                "reasonCode": "RESOURCE_LOCK_OWNERSHIP_LOST",
                                "cleanupStatus": "PROCESS_TREE_TERMINATION_REQUIRED",
                            }
                        )
                        _terminate_managed_child(process, job)
                        job = None
                        break
                    _write_run_receipt(state_root, receipt)
                    next_heartbeat = now + heartbeat_seconds
                time.sleep(min(heartbeat_seconds, 0.05))

            exit_code = process.poll()
            _stage_transition(receipt, "summarize")
            if termination_reason is not None and receipt["reasonCode"] not in {
                "PROCESS_IDENTITY_UNVERIFIED",
                "PROCESS_TERMINATION_UNCONFIRMED",
                "RESOURCE_LOCK_OWNERSHIP_LOST",
            }:
                receipt.update(
                    {
                        "status": "CANCELLED",
                        "reasonCode": termination_reason,
                        "exitCode": exit_code,
                        "cleanupStatus": "PROCESS_TREE_TERMINATED",
                    }
                )
            elif receipt["reasonCode"] not in {
                "PROCESS_IDENTITY_UNVERIFIED",
                "PROCESS_TERMINATION_UNCONFIRMED",
                "RESOURCE_LOCK_OWNERSHIP_LOST",
            }:
                receipt.update(
                    {
                        "status": "OK" if exit_code == 0 else "FAIL",
                        "reasonCode": (
                            "CHILD_EXIT_ZERO"
                            if exit_code == 0
                            else "CHILD_EXIT_NONZERO"
                        ),
                        "exitCode": exit_code,
                        "cleanupStatus": "PROCESS_EXITED",
                    }
                )
    except BaseException as exc:
        receipt.update(
            {
                "status": "INCOMPLETE",
                "reasonCode": "WORKER_FAILED",
                "exitCode": None if process is None else process.poll(),
                "cleanupStatus": "WORKER_EXCEPTION",
                "error": str(exc),
            }
        )
    finally:
        if job is not None:
            tree_drained = job.terminate_and_wait()
            if not tree_drained:
                receipt.update(
                    {
                        "status": "INCOMPLETE",
                        "reasonCode": "PROCESS_TREE_TERMINATION_UNCONFIRMED",
                        "cleanupStatus": "PROCESS_TREE_TERMINATION_UNCONFIRMED",
                    }
                )
            elif receipt.get("cleanupStatus") == "PROCESS_EXITED":
                receipt["cleanupStatus"] = "PROCESS_TREE_TERMINATED"
        ended = time.monotonic()
        _stage_transition(receipt, "record")
        receipt["endedAt"] = now_iso()
        receipt["lastHeartbeatAt"] = receipt["endedAt"]
        receipt["activeTimeMs"] = int((ended - started_monotonic) * 1000)
        receipt["wallClockMs"] = receipt["activeTimeMs"] + int(
            receipt.get("resourceWaitMs") or 0
        )
        digest = hashlib.sha256()
        for path in (stdout_path, stderr_path):
            if path.is_file():
                digest.update(path.read_bytes())
        receipt["resultDigest"] = "sha256:" + digest.hexdigest()
        locks_released = _release_resource_locks(
            state_root,
            session_id,
            dict(receipt.get("resourceLockTokens") or {}),
        )
        if not locks_released:
            receipt.update(
                {
                    "status": "INCOMPLETE",
                    "reasonCode": "RESOURCE_LOCK_RELEASE_FAILED",
                    "cleanupStatus": "RESOURCE_LOCK_RELEASE_FAILED",
                }
            )
        _close_current_stage(receipt)
        _write_run_receipt(state_root, receipt)
    return 0 if receipt.get("status") == "OK" else 1


def run_session_status(state_root: Path, session_id: str) -> dict[str, Any]:
    from harness_service import is_pid_alive, verify_process_identity

    receipt = _load_run_receipt(state_root, session_id)
    if receipt.get("status") in RUN_TERMINAL_STATUSES:
        return receipt
    heartbeat_text = str(receipt.get("lastHeartbeatAt") or "")
    try:
        heartbeat_at = dt.datetime.fromisoformat(
            heartbeat_text.replace("Z", "+00:00")
        )
        if heartbeat_at.tzinfo is None:
            heartbeat_at = heartbeat_at.astimezone()
        heartbeat_age = (
            dt.datetime.now().astimezone() - heartbeat_at
        ).total_seconds()
    except ValueError:
        heartbeat_age = float("inf")
    grace = max(float(receipt.get("heartbeatSeconds") or 30.0) * 4, 2.0)
    startup_grace = max(grace, 10.0)
    # The detached worker owns the durable identity record.  The launcher can
    # return before the worker has published it, so STARTING is intentionally
    # treated as a bounded handshake window rather than an identity failure.
    if (
        receipt.get("status") == "STARTING"
        and receipt.get("workerIdentity") is None
        and heartbeat_age < startup_grace
    ):
        return receipt
    worker_pid = receipt.get("workerPid")
    worker_identity = receipt.get("workerIdentity")
    worker_session = {
        "pid": worker_pid,
        "startedAt": (
            worker_identity.get("startedAt")
            if isinstance(worker_identity, dict)
            else None
        ),
        "processIdentity": {
            "executable": (
                worker_identity.get("executable")
                if isinstance(worker_identity, dict)
                else None
            )
        },
    }
    identity_state = verify_process_identity(worker_session)
    worker_gone = (
        isinstance(worker_pid, int)
        and worker_pid > 0
        and not is_pid_alive(worker_pid)
    )
    if worker_gone or identity_state is False or heartbeat_age >= grace:
        latest = _load_run_receipt(state_root, session_id)
        if latest.get("status") in RUN_TERMINAL_STATUSES:
            return latest
        if heartbeat_age < grace and worker_gone and identity_state is not False:
            return latest
        receipt.update(
            {
                "status": "INCOMPLETE",
                "reasonCode": (
                    "WORKER_IDENTITY_MISMATCH"
                    if identity_state is False and not worker_gone
                    else "HEARTBEAT_LOST"
                ),
                "endedAt": now_iso(),
                "cleanupStatus": "WORKER_EXITED_WITHOUT_FINAL_RECEIPT",
            }
        )
        _write_run_receipt(state_root, receipt)
    return receipt


def read_run_session_log(
    state_root: Path,
    session_id: str,
    *,
    stream: str = "stdout",
    cursor: int = 0,
    max_bytes: int = 64 * 1024,
) -> dict[str, Any]:
    if stream not in {"stdout", "stderr"}:
        raise ValueError(f"RUN_SESSION_STREAM_INVALID: {stream}")
    if cursor < 0 or max_bytes <= 0:
        raise ValueError("RUN_SESSION_CURSOR_INVALID")
    receipt = _load_run_receipt(state_root, session_id)
    path = Path(str(receipt[f"{stream}Path"]))
    raw = b""
    size = path.stat().st_size if path.is_file() else 0
    if path.is_file() and cursor < size:
        with path.open("rb") as handle:
            handle.seek(cursor)
            raw = handle.read(max_bytes)
        while raw:
            try:
                text = raw.decode("utf-8")
                break
            except UnicodeDecodeError as exc:
                if exc.end != len(raw):
                    text = raw.decode("utf-8", errors="replace")
                    break
                raw = raw[: exc.start]
        else:
            text = ""
    else:
        text = ""
    next_cursor = cursor + len(raw)
    terminal = receipt.get("status") in RUN_TERMINAL_STATUSES
    return {
        "ok": True,
        "sessionId": session_id,
        "stream": stream,
        "cursor": cursor,
        "nextCursor": next_cursor,
        "text": text,
        "eof": terminal and next_cursor >= size,
        "status": receipt.get("status"),
    }


def cancel_run_session(
    state_root: Path,
    session_id: str,
    *,
    reason: str = "CANCEL_REQUESTED",
) -> dict[str, Any]:
    from harness_service import verify_process_identity

    receipt = _load_run_receipt(state_root, session_id)
    if receipt.get("status") in RUN_TERMINAL_STATUSES:
        return receipt
    worker_identity = receipt.get("workerIdentity")
    worker_session = {
        "pid": receipt.get("workerPid"),
        "startedAt": (
            worker_identity.get("startedAt")
            if isinstance(worker_identity, dict)
            else None
        ),
        "processIdentity": {
            "executable": (
                worker_identity.get("executable")
                if isinstance(worker_identity, dict)
                else None
            )
        },
    }
    if verify_process_identity(worker_session) is not True:
        return {
            **receipt,
            "ok": False,
            "code": "WORKER_IDENTITY_UNVERIFIED",
            "unknownProcessUntouched": True,
        }
    atomic_write_json(
        _run_session_root(state_root, session_id) / "cancel-request.json",
        {"reasonCode": reason, "requestedAt": now_iso()},
    )
    return {**receipt, "ok": True, "action": "cancel-requested"}


def adapter_worktree(agent: str, change_id: str) -> dict[str, str]:
    if agent not in _ADAPTERS:
        raise ValueError(f"ADAPTER_UNKNOWN: {agent}")
    if not _CHANGE_ID.fullmatch(change_id) or change_id in {".", ".."}:
        raise ValueError(f"ADAPTER_CHANGE_ID_INVALID: {change_id}")
    root, prefix = _ADAPTERS[agent]
    return {
        "agent": agent,
        "worktreeRoot": root,
        "path": f"{root}/{change_id}",
        "branchPrefix": prefix,
        "branch": f"{prefix}{change_id}",
    }


def _absolute_executable(value: str | Path) -> str:
    return str(Path(value).expanduser().resolve())


def _run_version(executable: str, *args: str) -> dict[str, Any]:
    try:
        proc = subprocess.run(
            [executable, *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"available": False, "error": str(exc)}
    version = (proc.stdout or proc.stderr).strip().splitlines()
    return {
        "available": proc.returncode == 0,
        "version": version[0] if version else "",
        "exitCode": proc.returncode,
    }


def probe_powershell(
    executable: Path,
    *,
    runner: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> dict[str, Any]:
    """Probe Windows PowerShell/Pwsh without relying on PowerShell 6 Test-Json."""
    script = (
        "$value = [ordered]@{"
        "edition = [string]$PSVersionTable.PSEdition;"
        "version = [string]$PSVersionTable.PSVersion.ToString()"
        "}; $value | ConvertTo-Json -Compress"
    )
    argv = [
        _absolute_executable(executable),
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
    ]
    try:
        proc = runner(
            argv,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=10,
        )
        if proc.returncode != 0:
            return {
                "available": False,
                "executable": argv[0],
                "argvPrefix": [argv[0], "-NoLogo", "-NoProfile", "-NonInteractive"],
                "error": proc.stderr.strip(),
                "jsonCapability": "convert-to-json",
            }
        raw = json.loads(proc.stdout.strip())
        return {
            "available": True,
            "executable": argv[0],
            "argvPrefix": [argv[0], "-NoLogo", "-NoProfile", "-NonInteractive"],
            "edition": str(raw.get("edition") or "Desktop"),
            "version": str(raw.get("version") or ""),
            "jsonCapability": "convert-to-json",
        }
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        return {
            "available": False,
            "executable": argv[0],
            "argvPrefix": [argv[0], "-NoLogo", "-NoProfile", "-NonInteractive"],
            "error": str(exc),
            "jsonCapability": "convert-to-json",
        }


def _optional_runtime(name: str, version_arg: str = "--version") -> dict[str, Any]:
    found = shutil.which(name)
    if not found:
        return {"available": False, "executable": None, "argvPrefix": []}
    executable = _absolute_executable(found)
    return {
        "executable": executable,
        "argvPrefix": [executable],
        **_run_version(executable, version_arg),
    }


def doctor(project: Path, change_dir: Path, *, agent: str) -> dict[str, Any]:
    project = project.expanduser().resolve()
    change_dir = change_dir.expanduser().resolve()
    python_executable = _absolute_executable(sys.executable)
    python_version = _run_version(python_executable, "--version")

    powershell_path = shutil.which("pwsh") or shutil.which("powershell")
    powershell = (
        probe_powershell(Path(powershell_path))
        if powershell_path
        else {
            "available": False,
            "executable": None,
            "argvPrefix": [],
            "edition": None,
            "version": None,
            "jsonCapability": "python-json",
        }
    )
    sample = {"path": "E:/示例/计划", "ok": True}
    json_round_trip = json.loads(json.dumps(sample, ensure_ascii=False)) == sample
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": now_iso(),
        "projectRoot": str(project),
        "changeDir": str(change_dir),
        "adapter": adapter_worktree(agent, change_dir.name),
        "runtimes": {
            "python": {
                "available": python_version.get("available", True),
                "executable": python_executable,
                "argvPrefix": [python_executable],
                "version": python_version.get("version") or sys.version.split()[0],
                "stdioEncoding": "utf-8",
                "filesystemEncoding": sys.getfilesystemencoding(),
            },
            "node": _optional_runtime("node"),
            "powershell": powershell,
        },
        "capabilities": {
            "jsonRoundTrip": json_round_trip,
            "argvArrays": True,
            "utf8NoBom": True,
        },
    }
    atomic_write_json(change_dir / "meta" / "runtime.json", payload)
    return {"ok": True, "action": "doctor", **payload}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harness_runtime.py")
    sub = parser.add_subparsers(dest="command", required=True)
    p_doctor = sub.add_parser("doctor")
    p_doctor.add_argument("--project", required=True)
    p_doctor.add_argument("--change-dir", required=True)
    p_doctor.add_argument("--agent", choices=sorted(_ADAPTERS), required=True)
    p_doctor.add_argument("--json", action="store_true")
    p_adapter = sub.add_parser("adapter")
    p_adapter.add_argument("--agent", choices=sorted(_ADAPTERS), required=True)
    p_adapter.add_argument("--change", required=True)
    p_adapter.add_argument("--json", action="store_true")
    p_start = sub.add_parser("run-start", help="start a managed background run")
    p_start.add_argument("--state-root", required=True)
    p_start.add_argument("--verification", required=True)
    p_start.add_argument("--working-directory", required=True)
    p_start.add_argument("--timeout-seconds", type=float)
    p_start.add_argument("--heartbeat-seconds", type=float, default=30.0)
    p_start.add_argument("--expected-duration-seconds", type=float)
    p_start.add_argument("--product-identity")
    p_start.add_argument("--resource-lock", action="append", default=[])
    p_start.add_argument("--json", action="store_true")
    p_start.add_argument("argv", nargs=argparse.REMAINDER)
    p_status = sub.add_parser("run-status", help="read a managed run receipt")
    p_status.add_argument("--state-root", required=True)
    p_status.add_argument("--session-id", required=True)
    p_status.add_argument("--json", action="store_true")
    p_log = sub.add_parser("run-log", help="read an incremental log page")
    p_log.add_argument("--state-root", required=True)
    p_log.add_argument("--session-id", required=True)
    p_log.add_argument("--stream", choices=("stdout", "stderr"), default="stdout")
    p_log.add_argument("--cursor", type=int, default=0)
    p_log.add_argument("--max-bytes", type=int, default=64 * 1024)
    p_log.add_argument("--json", action="store_true")
    p_cancel = sub.add_parser("run-cancel", help="request identity-safe cancellation")
    p_cancel.add_argument("--state-root", required=True)
    p_cancel.add_argument("--session-id", required=True)
    p_cancel.add_argument("--json", action="store_true")
    p_worker = sub.add_parser("_worker", help=argparse.SUPPRESS)
    p_worker.add_argument("--state-root", required=True)
    p_worker.add_argument("--session-id", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "doctor":
            result = doctor(Path(args.project), Path(args.change_dir), agent=args.agent)
        elif args.command == "adapter":
            result = {"ok": True, "action": "adapter", **adapter_worktree(args.agent, args.change)}
        elif args.command == "_worker":
            return _run_session_worker(Path(args.state_root), args.session_id)
        elif args.command == "run-start":
            command_argv = list(args.argv)
            if command_argv and command_argv[0] == "--":
                command_argv = command_argv[1:]
            result = start_run_session(
                state_root=Path(args.state_root),
                verification=args.verification,
                argv=command_argv,
                working_directory=Path(args.working_directory),
                timeout_seconds=args.timeout_seconds,
                heartbeat_seconds=args.heartbeat_seconds,
                expected_duration_seconds=args.expected_duration_seconds,
                product_identity=args.product_identity,
                resource_locks=list(args.resource_lock),
            )
        elif args.command == "run-status":
            result = run_session_status(Path(args.state_root), args.session_id)
        elif args.command == "run-log":
            result = read_run_session_log(
                Path(args.state_root),
                args.session_id,
                stream=args.stream,
                cursor=args.cursor,
                max_bytes=args.max_bytes,
            )
        else:
            result = cancel_run_session(Path(args.state_root), args.session_id)
    except (OSError, ValueError) as exc:
        code = str(exc).split(":", 1)[0]
        result = {"ok": False, "code": code, "error": str(exc)}
        stream = sys.stderr
        stream.write(json.dumps(result, ensure_ascii=False) + "\n")
        return 1
    if getattr(args, "json", False):
        sys.stdout.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    else:
        sys.stdout.write(str(result.get("action")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
