#!/usr/bin/env python3
"""Resolve Harness runtimes into a reusable, argv-based phase capsule."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

SCHEMA_VERSION = 1
_CHANGE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_ADAPTERS = {
    "claude-code": (".claude/worktrees", "claude/"),
    "codex": (".codex/worktrees", "codex/"),
    "cursor": (".cursor/worktrees", "cursor/"),
    "codebuddy": (".codebuddy/worktrees", "codebuddy/"),
}


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="milliseconds")


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
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


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
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "doctor":
            result = doctor(Path(args.project), Path(args.change_dir), agent=args.agent)
        else:
            result = {"ok": True, "action": "adapter", **adapter_worktree(args.agent, args.change)}
    except (OSError, ValueError) as exc:
        code = str(exc).split(":", 1)[0]
        result = {"ok": False, "code": code, "error": str(exc)}
        stream = sys.stderr
        stream.write(json.dumps(result, ensure_ascii=False) + "\n")
        return 1
    if args.json:
        sys.stdout.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    else:
        sys.stdout.write(str(result.get("action")) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
