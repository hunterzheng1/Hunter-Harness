#!/usr/bin/env python3
"""Platform process identity, spawn attestation, and owned-tree termination.

OS observations never accept expected argv/cwd/owner fields.  Destructive
actions require both independently observed identity closure and a
platform-specific ownership proof.
"""

from __future__ import annotations

from dataclasses import dataclass
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import time
from typing import Any, Callable, Mapping, Sequence
import uuid


IDENTITY_TOLERANCE_SECONDS = 1.0
PROVENANCE = {"OBSERVED", "ATTESTED", "UNAVAILABLE"}
_WINDOWS_JOB_HANDLES: dict[str, Any] = {}


def canonical_argv_hash(argv: Sequence[str]) -> str:
    payload = json.dumps(
        [str(item) for item in argv],
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def _token_hash(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def _iso(value: dt.datetime | None) -> str | None:
    if value is None:
        return None
    return value.astimezone(dt.timezone.utc).isoformat(timespec="microseconds")


def _parse_iso(value: Any) -> dt.datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.astimezone()
    return parsed.astimezone(dt.timezone.utc)


def is_pid_alive(pid: int) -> bool:
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(0x1000, False, pid)
            if not handle:
                return False
            try:
                exit_code = wintypes.DWORD()
                if not kernel32.GetExitCodeProcess(
                    handle, ctypes.byref(exit_code)
                ):
                    return False
                return int(exit_code.value) == 259
            finally:
                kernel32.CloseHandle(handle)
        except Exception:
            return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False


def get_process_create_time(pid: int) -> dt.datetime | None:
    if not is_pid_alive(pid):
        return None
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(0x1000, False, pid)
            if not handle:
                return None
            try:
                creation = wintypes.FILETIME()
                exit_time = wintypes.FILETIME()
                kernel_time = wintypes.FILETIME()
                user_time = wintypes.FILETIME()
                if not kernel32.GetProcessTimes(
                    handle,
                    ctypes.byref(creation),
                    ctypes.byref(exit_time),
                    ctypes.byref(kernel_time),
                    ctypes.byref(user_time),
                ):
                    return None
                raw = (creation.dwHighDateTime << 32) | creation.dwLowDateTime
                seconds = (raw - 116444736000000000) / 10_000_000
                return dt.datetime.fromtimestamp(
                    seconds, tz=dt.timezone.utc
                )
            finally:
                kernel32.CloseHandle(handle)
        except Exception:
            return None
    stat = _read_proc_stat(pid)
    if stat is None:
        return None
    boot = _linux_boot_time()
    if boot is None:
        return None
    try:
        ticks = int(os.sysconf("SC_CLK_TCK"))
        return dt.datetime.fromtimestamp(
            boot + int(stat["startTicks"]) / ticks,
            tz=dt.timezone.utc,
        )
    except (OSError, TypeError, ValueError):
        return None


def get_process_executable(pid: int) -> str | None:
    if not is_pid_alive(pid):
        return None
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(0x1000, False, pid)
            if not handle:
                return None
            try:
                capacity = wintypes.DWORD(32768)
                buffer = ctypes.create_unicode_buffer(capacity.value)
                if not kernel32.QueryFullProcessImageNameW(
                    handle, 0, buffer, ctypes.byref(capacity)
                ):
                    return None
                return str(Path(buffer.value).resolve())
            finally:
                kernel32.CloseHandle(handle)
        except Exception:
            return None
    try:
        return str(Path(f"/proc/{pid}/exe").resolve(strict=True))
    except OSError:
        return None


def _linux_boot_time() -> float | None:
    try:
        for line in Path("/proc/stat").read_text(encoding="utf-8").splitlines():
            if line.startswith("btime "):
                return float(line.split()[1])
    except (OSError, ValueError):
        return None
    return None


def _read_proc_stat(pid: int) -> dict[str, int] | None:
    try:
        text = Path(f"/proc/{pid}/stat").read_text(
            encoding="utf-8", errors="replace"
        )
        right = text.rfind(")")
        if right < 0:
            return None
        fields = text[right + 2 :].split()
        return {
            "parentPid": int(fields[1]),
            "groupId": int(fields[2]),
            "sessionId": int(fields[3]),
            "startTicks": int(fields[19]),
        }
    except (OSError, IndexError, ValueError):
        return None


def _proc_argv(pid: int) -> list[str] | None:
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return None
    if not raw:
        return None
    try:
        return [
            part.decode("utf-8", errors="strict")
            for part in raw.rstrip(b"\0").split(b"\0")
        ]
    except UnicodeDecodeError:
        return None


def _proc_cwd(pid: int) -> str | None:
    try:
        return str(Path(f"/proc/{pid}/cwd").resolve(strict=True))
    except OSError:
        return None


def _enumerate_posix_members(
    group_id: int,
    session_id: int,
) -> tuple[list[int], bool]:
    proc = Path("/proc")
    if not proc.is_dir():
        return [], False
    members: list[int] = []
    complete = True
    for candidate in proc.iterdir():
        if not candidate.name.isdigit():
            continue
        stat = _read_proc_stat(int(candidate.name))
        if stat is None:
            continue
        if (
            stat["groupId"] == group_id
            and stat["sessionId"] == session_id
        ):
            members.append(int(candidate.name))
    return sorted(members), complete


def normalize_process_observation(raw: Mapping[str, Any]) -> dict[str, Any]:
    pid = int(raw.get("pid") or 0)
    alive = bool(raw.get("alive"))
    created = raw.get("createdAt")
    executable = raw.get("executable")
    argv_hash = raw.get("argvHash")
    cwd = raw.get("workingDirectory")
    parent = raw.get("parentIdentity")
    tree = raw.get("treeIdentity")
    return {
        "schemaVersion": 1,
        "pid": pid,
        "alive": alive,
        "createdAt": created if isinstance(created, str) else None,
        "executable": executable if isinstance(executable, str) else None,
        "argvHash": argv_hash if isinstance(argv_hash, str) else None,
        "workingDirectory": cwd if isinstance(cwd, str) else None,
        "parentIdentity": parent if isinstance(parent, dict) else None,
        "ownerTokenHash": (
            str(raw["ownerTokenHash"])
            if isinstance(raw.get("ownerTokenHash"), str)
            else None
        ),
        "treeIdentity": tree if isinstance(tree, dict) else None,
        "fieldProvenance": {
            "pid": "OBSERVED",
            "createdAt": "OBSERVED" if isinstance(created, str) else "UNAVAILABLE",
            "executable": (
                "OBSERVED" if isinstance(executable, str) else "UNAVAILABLE"
            ),
            "argvHash": "OBSERVED" if isinstance(argv_hash, str) else "UNAVAILABLE",
            "workingDirectory": "OBSERVED" if isinstance(cwd, str) else "UNAVAILABLE",
            "parentIdentity": "OBSERVED" if isinstance(parent, dict) else "UNAVAILABLE",
            "ownerTokenHash": (
                "ATTESTED"
                if isinstance(raw.get("ownerTokenHash"), str)
                else "UNAVAILABLE"
            ),
            "treeIdentity": "OBSERVED" if isinstance(tree, dict) else "UNAVAILABLE",
        },
        "capabilities": {
            "canObserveCreateTime": isinstance(created, str),
            "canObserveExecutable": isinstance(executable, str),
            "canObserveArgv": isinstance(argv_hash, str),
            "canObserveWorkingDirectory": isinstance(cwd, str),
            "canObserveParent": isinstance(parent, dict),
            "canEnumerateTree": bool(
                isinstance(tree, dict) and tree.get("complete") is True
            ),
            "canVerifyOwnership": bool(raw.get("canVerifyOwnership")),
        },
    }


def observe_process_identity(pid: int) -> dict[str, Any]:
    """Observe OS facts only.  Expected identity is intentionally not accepted."""

    alive = is_pid_alive(pid)
    if not alive:
        return normalize_process_observation(
            {"pid": pid, "alive": False, "platform": _platform_name()}
        )
    created = _iso(get_process_create_time(pid))
    executable = get_process_executable(pid)
    parent: dict[str, Any] | None = None
    tree: dict[str, Any] | None = None
    argv_hash: str | None = None
    cwd: str | None = None
    if os.name != "nt":
        stat = _read_proc_stat(pid)
        argv = _proc_argv(pid)
        argv_hash = canonical_argv_hash(argv) if argv is not None else None
        cwd = _proc_cwd(pid)
        if stat is not None and stat["parentPid"] > 0:
            parent = {
                "pid": stat["parentPid"],
                "createdAt": _iso(
                    get_process_create_time(stat["parentPid"])
                ),
                "executable": get_process_executable(stat["parentPid"]),
            }
            members, complete = _enumerate_posix_members(
                stat["groupId"], stat["sessionId"]
            )
            tree = {
                "platform": "LINUX" if sys.platform.startswith("linux") else "POSIX",
                "proofKind": "OBSERVED_SESSION",
                "memberPids": members,
                "complete": complete,
                "groupId": stat["groupId"],
                "sessionId": stat["sessionId"],
            }
    return normalize_process_observation(
        {
            "pid": pid,
            "alive": True,
            "createdAt": created,
            "executable": executable,
            "argvHash": argv_hash,
            "workingDirectory": cwd,
            "parentIdentity": parent,
            "treeIdentity": tree,
            "canVerifyOwnership": False,
        }
    )


def _platform_name() -> str:
    if os.name == "nt":
        return "WINDOWS"
    return "LINUX" if sys.platform.startswith("linux") else "POSIX"


def _normalized_path(value: str) -> str:
    normalized = os.path.normcase(os.path.abspath(value))
    return normalized.replace("\\", "/")


def _created_at_matches(expected: Any, actual: Any) -> bool | None:
    left = _parse_iso(expected)
    right = _parse_iso(actual)
    if left is None or right is None:
        return None
    return abs((left - right).total_seconds()) <= IDENTITY_TOLERANCE_SECONDS


def verify_process_identity(
    expected_attestation: Mapping[str, Any],
    observed_identity: Mapping[str, Any],
) -> dict[str, Any]:
    """Compare spawn attestation to independent OS observation."""

    if observed_identity.get("alive") is not True:
        return _decision(False, "PROCESS_IDENTITY_MISMATCH", ["process-dead"])
    if expected_attestation.get("pid") != observed_identity.get("pid"):
        return _decision(False, "PROCESS_IDENTITY_MISMATCH", ["pid"])
    checks = (
        ("createdAt", "PROCESS_CREATE_TIME_MISMATCH", _created_at_matches),
        (
            "executable",
            "PROCESS_EXECUTABLE_MISMATCH",
            lambda left, right: (
                _normalized_path(left) == _normalized_path(right)
                if isinstance(left, str) and isinstance(right, str)
                else None
            ),
        ),
        (
            "argvHash",
            "PROCESS_ARGV_MISMATCH",
            lambda left, right: left == right
            if isinstance(left, str) and isinstance(right, str)
            else None,
        ),
        (
            "workingDirectory",
            "PROCESS_CWD_MISMATCH",
            lambda left, right: (
                _normalized_path(left) == _normalized_path(right)
                if isinstance(left, str) and isinstance(right, str)
                else None
            ),
        ),
        (
            "ownerTokenHash",
            "PROCESS_OWNER_MISMATCH",
            lambda left, right: (
                left == right
                if isinstance(left, str) and isinstance(right, str)
                else True if right is None else None
            ),
        ),
    )
    unavailable: list[str] = []
    expected_provenance = expected_attestation.get("fieldProvenance")
    if not isinstance(expected_provenance, Mapping):
        expected_provenance = {}
    observed_provenance = observed_identity.get("fieldProvenance")
    if not isinstance(observed_provenance, Mapping):
        observed_provenance = {}
    for field, reason, comparator in checks:
        expected = expected_attestation.get(field)
        if expected is None:
            continue
        actual = observed_identity.get(field)
        expected_source = expected_provenance.get(field)
        observed_source = observed_provenance.get(field)
        # Create time, executable and owner/parent facts must come from an
        # independent OS observation.  argv/cwd may remain spawn-attested on
        # platforms that cannot read them back, but a value labelled
        # UNAVAILABLE is never allowed to masquerade as an observation.
        independent_field = field in {
            "createdAt",
            "executable",
            "parentIdentity",
        }
        if actual is not None and observed_source not in {"OBSERVED", "ATTESTED"}:
            unavailable.append(field)
            continue
        if actual is not None and independent_field and observed_source != "OBSERVED":
            unavailable.append(field)
            continue
        compared = comparator(expected, actual)
        if compared is False:
            return _decision(False, reason, [field])
        if compared is None:
            if field in {"argvHash", "workingDirectory"} and expected_source == "ATTESTED" and actual is None:
                # The attestation is the only trustworthy source on a
                # platform without argv/cwd observation.  Core identity and
                # ownership proof checks below still have to close.
                continue
            unavailable.append(field)
    expected_parent = expected_attestation.get("parentIdentity")
    if isinstance(expected_parent, dict):
        actual_parent = observed_identity.get("parentIdentity")
        if not isinstance(actual_parent, dict):
            unavailable.append("parentIdentity")
        elif observed_provenance.get("parentIdentity") != "OBSERVED":
            unavailable.append("parentIdentity")
        elif expected_parent.get("pid") != actual_parent.get("pid"):
            return _decision(
                False, "PROCESS_PARENT_MISMATCH", ["parentIdentity.pid"]
            )
        else:
            parent_time = _created_at_matches(
                expected_parent.get("createdAt"),
                actual_parent.get("createdAt"),
            )
            if parent_time is False:
                return _decision(
                    False,
                    "PROCESS_PARENT_MISMATCH",
                    ["parentIdentity.createdAt"],
                )
            if parent_time is None:
                unavailable.append("parentIdentity.createdAt")
    if unavailable:
        return _decision(False, "IDENTITY_UNVERIFIABLE", unavailable)
    return _decision(True, "PROCESS_IDENTITY_VERIFIED", [])


def _decision(ok: bool, reason: str, details: list[str]) -> dict[str, Any]:
    return {
        "ok": ok,
        "authorized": ok,
        "reasonCode": reason,
        "details": details,
    }


def validate_ownership_proof(
    expected_attestation: Mapping[str, Any],
    ownership_proof: Mapping[str, Any] | None,
    observed_members: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    if not isinstance(ownership_proof, Mapping):
        return _decision(False, "IDENTITY_UNVERIFIABLE", ["proof-missing"])
    if (
        expected_attestation.get("ownerTokenHash") is None
        or ownership_proof.get("ownershipTokenHash")
        != expected_attestation.get("ownerTokenHash")
    ):
        return _decision(False, "PROCESS_OWNER_MISMATCH", ["ownerTokenHash"])
    if ownership_proof.get("membersComplete") is not True:
        return _decision(False, "IDENTITY_UNVERIFIABLE", ["members-incomplete"])
    if ownership_proof.get("leaderExited") is True:
        return _decision(False, "IDENTITY_UNVERIFIABLE", ["leader-exited"])
    kind = ownership_proof.get("kind")
    if kind not in {"WINDOWS_NAMED_JOB", "LINUX_PIDFD_SESSION", "POSIX_MEMBERS"}:
        return _decision(False, "IDENTITY_UNVERIFIABLE", ["proof-kind"])
    expected_members = ownership_proof.get("members")
    if not isinstance(expected_members, list) or not expected_members:
        return _decision(False, "IDENTITY_UNVERIFIABLE", ["attested-members"])
    expected_by_pid = {
        item.get("pid"): item
        for item in expected_members
        if isinstance(item, Mapping) and isinstance(item.get("pid"), int)
    }
    observed_by_pid = {
        item.get("pid"): item
        for item in observed_members
        if isinstance(item, Mapping) and item.get("alive") is True
    }
    if set(expected_by_pid) != set(observed_by_pid):
        return _decision(
            False,
            "IDENTITY_UNVERIFIABLE",
            ["foreign-or-missing-member"],
        )
    leader_pid = ownership_proof.get("leaderPid")
    if leader_pid not in observed_by_pid:
        return _decision(False, "IDENTITY_UNVERIFIABLE", ["leader-missing"])
    for pid, expected in expected_by_pid.items():
        observed = observed_by_pid[pid]
        verified = verify_process_identity(expected, observed)
        if not verified["ok"]:
            return verified
        expected_tree = expected.get("treeIdentity")
        observed_tree = observed.get("treeIdentity")
        if kind != "WINDOWS_NAMED_JOB":
            if not isinstance(observed_tree, Mapping):
                return _decision(
                    False, "IDENTITY_UNVERIFIABLE", ["tree-unavailable"]
                )
            for field in ("groupId", "sessionId"):
                proof_value = ownership_proof.get(field)
                if proof_value is not None and observed_tree.get(field) != proof_value:
                    return _decision(
                        False,
                        "IDENTITY_UNVERIFIABLE",
                        [f"{field}-reused"],
                    )
    return {
        "ok": True,
        "authorized": True,
        "reasonCode": "OWNERSHIP_PROOF_VERIFIED",
        "details": [],
        "memberPids": sorted(int(pid) for pid in observed_by_pid),
    }


def _observe_proof_members(
    ownership_proof: Mapping[str, Any] | None,
) -> list[dict[str, Any]]:
    if not isinstance(ownership_proof, Mapping):
        return []
    members = ownership_proof.get("members")
    if not isinstance(members, list):
        return []
    if ownership_proof.get("kind") == "WINDOWS_NAMED_JOB":
        pids = _windows_job_member_pids(ownership_proof)
        if pids is None:
            if isinstance(ownership_proof, dict):
                ownership_proof["membersComplete"] = False
            return []
        return [observe_process_identity(pid) for pid in pids]
    observed = [
        observe_process_identity(int(item["pid"]))
        for item in members
        if isinstance(item, Mapping) and isinstance(item.get("pid"), int)
    ]
    if ownership_proof.get("kind") != "WINDOWS_NAMED_JOB":
        group_id = ownership_proof.get("groupId")
        session_id = ownership_proof.get("sessionId")
        if isinstance(group_id, int) and isinstance(session_id, int):
            pids, complete = _enumerate_posix_members(group_id, session_id)
            ownership_proof["membersComplete"] = bool(complete)
            known = {item["pid"] for item in observed}
            observed.extend(
                observe_process_identity(pid) for pid in pids if pid not in known
            )
    return observed


def terminate_owned_tree(
    expected_attestation: Mapping[str, Any],
    ownership_proof: Mapping[str, Any] | None,
    timeout_policy: Mapping[str, Any] | None = None,
    *,
    member_observer: Callable[
        [Mapping[str, Any] | None], Sequence[Mapping[str, Any]]
    ] = _observe_proof_members,
    signaler: Callable[[int, int], None] = os.kill,
) -> dict[str, Any]:
    """Terminate only after proof and every current member identity close."""

    observed = list(member_observer(ownership_proof))
    proof_result = validate_ownership_proof(
        expected_attestation, ownership_proof, observed
    )
    if not proof_result["ok"]:
        return {
            **proof_result,
            "terminatedPids": [],
            "cleanupComplete": False,
        }
    assert ownership_proof is not None
    pids = list(reversed(proof_result["memberPids"]))
    terminated: list[int] = []
    if ownership_proof.get("kind") == "WINDOWS_NAMED_JOB":
        proof_id = str(ownership_proof.get("proofId") or "")
        job = _WINDOWS_JOB_HANDLES.get(proof_id)
        if job is None:
            job = _WindowsNamedJob(
                str(ownership_proof.get("jobName") or ""),
                configure=False,
            )
        if job is None or not job.terminate():
            return {
                "ok": False,
                "authorized": False,
                "reasonCode": "IDENTITY_UNVERIFIABLE",
                "details": ["named-job-unavailable"],
                "terminatedPids": [],
                "cleanupComplete": False,
            }
        terminated.extend(pids)
    else:
        for pid in pids:
            try:
                signaler(pid, signal.SIGTERM)
                terminated.append(pid)
            except ProcessLookupError:
                terminated.append(pid)
            except OSError as exc:
                return {
                    "ok": False,
                    "authorized": True,
                    "reasonCode": "SERVICE_STOP_FAILED",
                    "details": [str(exc)],
                    "terminatedPids": terminated,
                    "cleanupComplete": False,
                }
    grace = float((timeout_policy or {}).get("graceSeconds", 3.0))
    deadline = time.monotonic() + max(0.0, grace)
    remaining = [
        item
        for item in member_observer(ownership_proof)
        if item.get("alive") is True
    ]
    while remaining and time.monotonic() < deadline:
        time.sleep(min(0.05, max(0.0, deadline - time.monotonic())))
        remaining = [
            item
            for item in member_observer(ownership_proof)
            if item.get("alive") is True
        ]
    if remaining and ownership_proof.get("kind") != "WINDOWS_NAMED_JOB":
        for item in remaining:
            try:
                signaler(int(item["pid"]), signal.SIGKILL)
            except OSError:
                pass
        remaining = [
            item
            for item in member_observer(ownership_proof)
            if item.get("alive") is True
        ]
    return {
        "ok": not remaining,
        "authorized": True,
        "reasonCode": (
            "SERVICE_STOPPED" if not remaining else "SERVICE_STOP_TIMEOUT"
        ),
        "details": [],
        "terminatedPids": sorted(set(terminated)),
        "cleanupComplete": not remaining,
    }


class _WindowsNamedJob:
    def __init__(self, name: str, *, configure: bool = True) -> None:
        self.name = name
        self.handle: Any = None
        if os.name != "nt":
            return
        try:
            import ctypes

            kernel32 = ctypes.windll.kernel32
            kernel32.CreateJobObjectW.restype = ctypes.c_void_p
            handle = kernel32.CreateJobObjectW(None, name)
            self.handle = int(handle) if handle else None
            if self.handle is not None and configure:
                self._configure_kill_on_close()
        except Exception:
            if self.handle is not None:
                try:
                    ctypes.windll.kernel32.CloseHandle(ctypes.c_void_p(self.handle))
                except Exception:
                    pass
            self.handle = None

    def _configure_kill_on_close(self) -> None:
        if self.handle is None:
            return
        import ctypes
        from ctypes import wintypes

        class BasicLimit(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class IoCounters(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_uint64),
                ("WriteOperationCount", ctypes.c_uint64),
                ("OtherOperationCount", ctypes.c_uint64),
                ("ReadTransferCount", ctypes.c_uint64),
                ("WriteTransferCount", ctypes.c_uint64),
                ("OtherTransferCount", ctypes.c_uint64),
            ]

        class ExtendedLimit(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", BasicLimit),
                ("IoInfo", IoCounters),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        info = ExtendedLimit()
        info.BasicLimitInformation.LimitFlags = 0x00002000
        if not ctypes.windll.kernel32.SetInformationJobObject(
            ctypes.c_void_p(self.handle),
            9,
            ctypes.byref(info),
            ctypes.sizeof(info),
        ):
            raise OSError("SetInformationJobObject(KILL_ON_JOB_CLOSE) failed")

    def assign(self, process: subprocess.Popen[Any]) -> bool:
        if self.handle is None:
            return False
        try:
            import ctypes

            return bool(
                ctypes.windll.kernel32.AssignProcessToJobObject(
                    ctypes.c_void_p(self.handle),
                    ctypes.c_void_p(int(process._handle)),  # type: ignore[attr-defined]
                )
            )
        except Exception:
            return False

    def terminate(self) -> bool:
        opened = False
        try:
            import ctypes

            if self.handle is None and os.name == "nt" and self.name:
                kernel32 = ctypes.windll.kernel32
                kernel32.OpenJobObjectW.restype = ctypes.c_void_p
                raw = kernel32.OpenJobObjectW(0x0001, False, self.name)
                if raw:
                    self.handle = int(raw)
                    opened = True
            if self.handle is None:
                return False
            return bool(
                ctypes.windll.kernel32.TerminateJobObject(
                    ctypes.c_void_p(self.handle), 1
                )
            )
        except Exception:
            return False
        finally:
            if opened and self.handle is not None:
                try:
                    ctypes.windll.kernel32.CloseHandle(ctypes.c_void_p(self.handle))
                except Exception:
                    pass
                self.handle = None

    def close(self) -> None:
        if self.handle is None:
            return
        try:
            import ctypes

            ctypes.windll.kernel32.CloseHandle(ctypes.c_void_p(self.handle))
        finally:
            self.handle = None


def _windows_job_member_pids(
    ownership_proof: Mapping[str, Any],
) -> list[int] | None:
    if os.name != "nt":
        return None
    proof_id = str(ownership_proof.get("proofId") or "")
    job = _WINDOWS_JOB_HANDLES.get(proof_id)
    handle = job.handle if job is not None else None
    opened = False
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        if handle is None:
            name = ownership_proof.get("jobName")
            if not isinstance(name, str) or not name:
                return None
            kernel32.OpenJobObjectW.restype = ctypes.c_void_p
            raw = kernel32.OpenJobObjectW(0x0004 | 0x0008, False, name)
            if not raw:
                return None
            handle = int(raw)
            opened = True
        pointer_size = ctypes.sizeof(ctypes.c_size_t)
        capacity = 4096
        buffer = ctypes.create_string_buffer(8 + pointer_size * capacity)
        returned = ctypes.c_uint32()
        if not kernel32.QueryInformationJobObject(
            ctypes.c_void_p(handle),
            3,
            buffer,
            ctypes.sizeof(buffer),
            ctypes.byref(returned),
        ):
            return None
        assigned = ctypes.c_uint32.from_buffer_copy(buffer.raw[0:4]).value
        count = ctypes.c_uint32.from_buffer_copy(buffer.raw[4:8]).value
        if count > assigned or count > capacity:
            return None
        array_type = ctypes.c_size_t * count
        members = array_type.from_buffer_copy(
            buffer.raw[8 : 8 + pointer_size * count]
        )
        return sorted(int(pid) for pid in members)
    except Exception:
        return None
    finally:
        if opened and handle is not None:
            try:
                import ctypes

                ctypes.windll.kernel32.CloseHandle(ctypes.c_void_p(handle))
            except Exception:
                pass


@dataclass
class SpawnedProcess:
    process: subprocess.Popen[Any]
    attestation: dict[str, Any]
    observedIdentity: dict[str, Any]
    ownershipProof: dict[str, Any] | None
    _job: _WindowsNamedJob | None = None
    _pidfd: int | None = None

    def close(self) -> None:
        if self._pidfd is not None:
            try:
                os.close(self._pidfd)
            except OSError:
                pass
            self._pidfd = None
        if self._job is not None:
            proof_id = (
                str(self.ownershipProof.get("proofId") or "")
                if isinstance(self.ownershipProof, dict)
                else ""
            )
            if proof_id:
                _WINDOWS_JOB_HANDLES.pop(proof_id, None)
            # KILL_ON_JOB_CLOSE is the durable backstop, but explicitly
            # terminating the owned job first closes a short race where a
            # descendant is still being attached while the leader exits.
            try:
                self._job.terminate()
            except Exception:
                pass
            self._job.close()
            self._job = None


def capture_owned_members(spawned: SpawnedProcess) -> dict[str, Any] | None:
    """Refresh a spawn proof with the provider's current owned members.

    A process can create children between spawn and cleanup (notably console
    hosts on Windows).  The provider, rather than each consumer, must capture
    that membership before identity verification and termination.
    """

    proof = spawned.ownershipProof
    leader = spawned.attestation
    if not isinstance(proof, dict) or not isinstance(leader, dict):
        return proof if isinstance(proof, dict) else None
    observed = list(_observe_proof_members(proof))
    if not observed:
        return proof
    leader_pid = leader.get("pid")
    members: list[dict[str, Any]] = []
    for item in observed:
        if item.get("pid") == leader_pid:
            members.append(json.loads(json.dumps(leader)))
        else:
            members.append(json.loads(json.dumps(item)))
    if leader_pid in {item.get("pid") for item in members}:
        proof["members"] = members
        proof["membersComplete"] = True
    return proof


def resolve_windows_executable(argv: Sequence[str]) -> list[str]:
    """Windows 无扩展名命令解析为实际可执行文件（F-1）。

    CreateProcess 不走 shell，`mvn`/`npm` 这类 .cmd 包装会报 WinError 2；
    shutil.which 遵循 PATHEXT 能找到 mvn.cmd。POSIX 或未命中时原样返回。
    """
    if os.name != "nt" or not argv:
        return list(argv)
    head = argv[0]
    if not isinstance(head, str) or not head or os.path.splitext(head)[1]:
        return list(argv)
    resolved = shutil.which(head)
    if resolved is None:
        return list(argv)
    return [resolved, *argv[1:]]


def spawn_structured_argv(
    argv: Sequence[str],
    *,
    cwd: Path | str,
    environment: Mapping[str, str] | None,
    owner_token: str,
    stdout: Any = None,
    stderr: Any = None,
) -> SpawnedProcess:
    """Spawn with shell=False and return separate attestation/observation/proof."""

    if (
        not argv
        or any(not isinstance(item, str) or "\0" in item for item in argv)
        or not isinstance(owner_token, str)
        or not owner_token
    ):
        raise ValueError("ARGUMENT_INVALID: argv and owner token are required")
    root = Path(cwd).expanduser().resolve()
    child_env = os.environ.copy()
    child_env.update({str(key): str(value) for key, value in (environment or {}).items()})
    child_env.setdefault("PYTHONUTF8", "1")
    child_env.setdefault("PYTHONIOENCODING", "utf-8")
    kwargs: dict[str, Any] = {
        "cwd": str(root),
        "env": child_env,
        "shell": False,
        "stdout": stdout,
        "stderr": stderr,
    }
    if os.name == "nt":
        kwargs["creationflags"] = getattr(
            subprocess, "CREATE_NEW_PROCESS_GROUP", 0
        )
    else:
        kwargs["start_new_session"] = True
    process = subprocess.Popen(list(argv), **kwargs)
    observed = observe_process_identity(process.pid)
    owner_hash = _token_hash(owner_token)
    attestation = json.loads(json.dumps(observed))
    attestation["argvHash"] = canonical_argv_hash(argv)
    attestation["workingDirectory"] = str(root)
    attestation["ownerTokenHash"] = owner_hash
    attestation["fieldProvenance"]["argvHash"] = (
        "OBSERVED" if observed.get("argvHash") is not None else "ATTESTED"
    )
    attestation["fieldProvenance"]["workingDirectory"] = (
        "OBSERVED"
        if observed.get("workingDirectory") is not None
        else "ATTESTED"
    )
    attestation["fieldProvenance"]["ownerTokenHash"] = "ATTESTED"
    proof_id = "proof-" + uuid.uuid4().hex
    job: _WindowsNamedJob | None = None
    pidfd: int | None = None
    proof: dict[str, Any] | None
    if os.name == "nt":
        job = _WindowsNamedJob(
            "Local\\HunterHarness-" + owner_hash.split(":", 1)[1][:16] + "-" + proof_id
        )
        # AssignProcessToJobObject can transiently fail under system load
        # (e.g. while the child is still being set up).  Retry briefly before
        # declaring the ownership proof unavailable — killing the child here
        # aborts an otherwise healthy managed run.
        assigned = False
        child_exited = False
        if job.handle is not None:
            for attempt in range(5):
                if job.assign(process):
                    assigned = True
                    break
                if process.poll() is not None:
                    # The child already exited: there is no live tree left to
                    # isolate, so a failed assignment is benign.  Return the
                    # spawn without an ownership proof instead of killing a
                    # process that is already gone and raising.
                    child_exited = True
                    break
                time.sleep(0.02 * (attempt + 1))
        if assigned:
            _WINDOWS_JOB_HANDLES[proof_id] = job
            proof = {
                "schemaVersion": 1,
                "proofId": proof_id,
                "kind": "WINDOWS_NAMED_JOB",
                "jobName": job.name,
                "ownershipTokenHash": owner_hash,
                "leaderPid": process.pid,
                "leaderCreatedAt": attestation.get("createdAt"),
                "members": [attestation],
                "membersComplete": True,
                "leaderExited": False,
            }
        elif child_exited:
            # Benign race: short-lived child exited before job assignment.
            # No proof, but the process tree is already gone — the caller's
            # normal exit handling applies.
            job.close()
            job = None
            proof = None
        else:
            try:
                process.kill()
                process.wait(timeout=5)
            except (OSError, subprocess.TimeoutExpired):
                pass
            job.close()
            raise RuntimeError("IDENTITY_UNVERIFIABLE: Windows ownership proof unavailable")
    else:
        tree = observed.get("treeIdentity") or {}
        kind = "POSIX_MEMBERS"
        if sys.platform.startswith("linux") and hasattr(os, "pidfd_open"):
            try:
                pidfd = os.pidfd_open(process.pid)
                kind = "LINUX_PIDFD_SESSION"
            except OSError:
                pidfd = None
        proof = {
            "schemaVersion": 1,
            "proofId": proof_id,
            "kind": kind,
            "ownershipTokenHash": owner_hash,
            "leaderPid": process.pid,
            "leaderCreatedAt": attestation.get("createdAt"),
            "groupId": tree.get("groupId", process.pid),
            "sessionId": tree.get("sessionId", process.pid),
            "members": [attestation],
            "membersComplete": bool(tree.get("complete", False)),
            "leaderExited": False,
            "pidfdHeld": pidfd is not None,
        }
    attestation["capabilities"]["canVerifyOwnership"] = bool(
        isinstance(proof, dict)
        and proof.get("membersComplete") is True
    )
    return SpawnedProcess(
        process=process,
        attestation=attestation,
        observedIdentity=observed,
        ownershipProof=proof,
        _job=job,
        _pidfd=pidfd,
    )
