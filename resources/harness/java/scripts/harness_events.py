#!/usr/bin/env python3
"""Harness events.ndjson writer and execution-log renderer (D2).

Subcommands:
  append  — append one schema_version 2 event, then auto-render execution-log.md
  render  — full re-render of logs/execution-log.md from events.ndjson
  summary — phase durations, event counts, and issue list (JSON)

Python 3.10+, stdlib only. UTF-8 without BOM. Windows path safe.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import json
import os
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


EVENT_TYPES = frozenset(
    {
        "phase.start",
        "phase.end",
        "command",
        "verification",
        "artifact",
        "issue",
        "decision",
    }
)

SCHEMA_VERSION = 2
HEADER_LINE = (
    "本文件由 harness_events.py 自动渲染，请勿手工编辑；事实源为 events.ndjson"
)

# Optional fields accepted on append; only non-None values are written.
OPTIONAL_FIELDS = (
    "command",
    "exit_code",
    "duration_ms",
    "note",
    "name",
    "status",
    "path",
    "kind",
    "code",
    "severity",
    "message",
    "decision",
    "reason",
)


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="milliseconds")


def emit_json(payload: dict[str, Any], *, as_json: bool) -> None:
    if as_json:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    else:
        ok = payload.get("ok", True)
        msg = payload.get("message") or payload.get("path") or ("ok" if ok else "error")
        sys.stdout.write(f"{msg}\n")


def emit_error(message: str, *, as_json: bool, code: int = 1) -> int:
    payload = {"ok": False, "error": message}
    if as_json:
        sys.stderr.write(json.dumps(payload, ensure_ascii=False) + "\n")
    else:
        sys.stderr.write(f"error: {message}\n")
    return code


def resolve_change_dir(raw: str) -> Path:
    return Path(raw).expanduser().resolve()


def events_path(change_dir: Path) -> Path:
    return change_dir / "events.ndjson"


def execution_log_path(change_dir: Path) -> Path:
    return change_dir / "logs" / "execution-log.md"


def parse_timestamp(value: Any) -> dt.datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return dt.datetime.fromisoformat(text)
    except ValueError:
        return None


def duration_ms_between(start: Any, end: Any) -> int | None:
    start_dt = parse_timestamp(start)
    end_dt = parse_timestamp(end)
    if start_dt is None or end_dt is None:
        return None
    return max(0, int((end_dt - start_dt).total_seconds() * 1000))


def normalize_event(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize schema_version 1/2 events for rendering and summary."""
    event = dict(raw)
    version = event.get("schema_version", 1)
    try:
        version_int = int(version)
    except (TypeError, ValueError):
        version_int = 1
    event["schema_version"] = version_int
    if "note" not in event or event["note"] is None:
        event["note"] = ""
    return event


def load_events(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    events: list[dict[str, Any]] = []
    text = path.read_text(encoding="utf-8-sig")
    for line_no, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped:
            continue
        try:
            obj = json.loads(stripped)
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid JSON at {path} line {line_no}: {exc}") from exc
        if not isinstance(obj, dict):
            raise ValueError(f"event at {path} line {line_no} is not an object")
        events.append(normalize_event(obj))
    return events


def atomic_append_line(path: Path, line: str) -> None:
    """Write line to a temp file first, then append to the target (append-only)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = line if line.endswith("\n") else line + "\n"
    # Ensure UTF-8 without BOM for the temp payload.
    data = payload.encode("utf-8")
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=str(path.parent),
    )
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as tmp_f:
            tmp_f.write(data)
            tmp_f.flush()
            os.fsync(tmp_f.fileno())
        with path.open("ab") as out_f:
            out_f.write(data)
            out_f.flush()
            os.fsync(out_f.fileno())
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass


@contextlib.contextmanager
def event_file_lock(lock_path: Path, timeout_seconds: float = 10.0):
    """Acquire a cross-process exclusive lock or raise TimeoutError.

    §6.2: Windows uses msvcrt.locking; POSIX uses fcntl.flock. The lock file is
    ``<change-dir>/events.ndjson.lock``. On timeout the caller must fail non-zero
    -- never continue without a lock. ``finally`` always unlocks and closes.
    """
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    # Ensure at least 1 byte exists; msvcrt.locking on an empty file can misbehave
    # on some Windows versions.
    if not lock_path.exists() or lock_path.stat().st_size == 0:
        with open(lock_path, "ab") as seed_f:
            seed_f.write(b"\0")
    handle = open(lock_path, "r+b")
    try:
        handle.seek(0)
        _acquire_file_lock(handle, lock_path, timeout_seconds)
        try:
            yield
        finally:
            _release_file_lock(handle)
    finally:
        handle.close()


def _acquire_file_lock(handle, lock_path: Path, timeout_seconds: float) -> None:
    deadline = time.monotonic() + timeout_seconds
    if os.name == "nt":
        import msvcrt

        while True:
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                return
            except OSError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(
                        f"timeout acquiring event lock {lock_path} after {timeout_seconds}s"
                    )
                time.sleep(0.02)
    else:
        import fcntl

        while True:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                return
            except OSError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(
                        f"timeout acquiring event lock {lock_path} after {timeout_seconds}s"
                    )
                time.sleep(0.02)


def _release_file_lock(handle) -> None:
    try:
        if os.name == "nt":
            import msvcrt

            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    except OSError:
        pass


def new_event_id(existing: list[dict[str, Any]] | None = None) -> str:
    """Return a full-entropy event id.

    §6.2: UUID 不需要扫描历史去重；直接使用完整 ``uuid.uuid4().hex``。
    ``existing`` is accepted for backward-compat callers but intentionally unused.
    """
    return f"evt-{uuid.uuid4().hex}"


def build_event(args: argparse.Namespace, existing: list[dict[str, Any]]) -> dict[str, Any]:
    event: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "id": new_event_id(existing),
        "timestamp": now_iso(),
        "phase": args.phase,
        "type": args.type,
    }
    for field in OPTIONAL_FIELDS:
        value = getattr(args, field, None)
        if value is None:
            continue
        event[field] = value
    if "note" not in event:
        event["note"] = ""
    return event


def status_symbol(status: Any, reason: Any = None) -> str:
    text = str(status or "").strip().lower()
    reason_text = str(reason or "").strip()
    ok_set = {"ok", "passed", "pass", "success", "green", "✅", "✅ok"}
    warn_set = {"warn", "warning", "yellow", "skipped", "skip", "🟡", "🟡warn"}
    fail_set = {"fail", "failed", "error", "red", "blocked", "❌", "❌fail"}
    if text in ok_set or text.startswith("ok") or "✅" in text:
        return "✅OK"
    if text in warn_set or "warn" in text or "🟡" in text:
        return f"🟡WARN({reason_text})" if reason_text else "🟡WARN"
    if text in fail_set or "fail" in text or "error" in text or "❌" in text:
        return f"❌FAIL({reason_text})" if reason_text else "❌FAIL"
    if reason_text:
        return f"{status}({reason_text})"
    return str(status or "unknown")


def severity_symbol(severity: Any, message: Any = None) -> str:
    text = str(severity or "").strip().lower()
    msg = str(message or "").strip()
    if text in {"error", "fail", "failed", "critical"}:
        return f"❌FAIL({msg})" if msg else "❌FAIL"
    if text in {"warn", "warning"}:
        return f"🟡WARN({msg})" if msg else "🟡WARN"
    if text in {"info", "ok", "note"}:
        return f"✅OK({msg})" if msg else "✅OK"
    return f"{severity}: {msg}" if msg else str(severity or "issue")


def format_duration(ms: int | None) -> str:
    if ms is None:
        return "—"
    if ms < 1000:
        return f"{ms}ms"
    seconds = ms / 1000
    if seconds < 60:
        return f"{seconds:.1f}s"
    minutes = int(seconds // 60)
    rem = seconds - minutes * 60
    return f"{minutes}m{rem:04.1f}s"


def group_events_by_phase(events: list[dict[str, Any]]) -> list[tuple[str, list[dict[str, Any]]]]:
    """Preserve first-seen phase order; keep events in file order within each phase."""
    order: list[str] = []
    buckets: dict[str, list[dict[str, Any]]] = {}
    for event in events:
        phase = str(event.get("phase") or "unknown")
        if phase not in buckets:
            order.append(phase)
            buckets[phase] = []
        buckets[phase].append(event)
    return [(phase, buckets[phase]) for phase in order]


def phase_start_time(phase_events: list[dict[str, Any]]) -> str:
    for event in phase_events:
        if event.get("type") == "phase.start":
            return str(event.get("timestamp") or "")
    if phase_events:
        return str(phase_events[0].get("timestamp") or "")
    return ""


def phase_duration_ms(phase_events: list[dict[str, Any]]) -> int | None:
    start_ts = None
    end_ts = None
    for event in phase_events:
        etype = event.get("type")
        if etype == "phase.start" and start_ts is None:
            start_ts = event.get("timestamp")
        elif etype == "phase.end":
            end_ts = event.get("timestamp")
    if start_ts and end_ts:
        return duration_ms_between(start_ts, end_ts)
    # Fallback: first to last timestamp in the phase bucket.
    stamps = [e.get("timestamp") for e in phase_events if e.get("timestamp")]
    if len(stamps) >= 2:
        return duration_ms_between(stamps[0], stamps[-1])
    return None


def render_command_block(commands: list[dict[str, Any]]) -> list[str]:
    if not commands:
        return []
    if len(commands) == 1:
        event = commands[0]
        cmd = event.get("command") or ""
        exit_code = event.get("exit_code")
        exit_text = "?" if exit_code is None else str(exit_code)
        duration = format_duration(
            int(event["duration_ms"]) if isinstance(event.get("duration_ms"), int) else None
        )
        note = str(event.get("note") or "").strip()
        parts = [f"- command: `{cmd}`", f"exit={exit_text}", f"duration={duration}"]
        if note:
            parts.append(f"note={note}")
        return [" · ".join(parts)]

    lines = [
        "",
        "| 命令 | exit | duration | note |",
        "| --- | ---: | ---: | --- |",
    ]
    for event in commands:
        cmd = str(event.get("command") or "").replace("|", "\\|")
        exit_code = event.get("exit_code")
        exit_text = "?" if exit_code is None else str(exit_code)
        duration = format_duration(
            int(event["duration_ms"]) if isinstance(event.get("duration_ms"), int) else None
        )
        note = str(event.get("note") or "").replace("|", "\\|")
        lines.append(f"| `{cmd}` | {exit_text} | {duration} | {note} |")
    lines.append("")
    return lines


def render_event_line(event: dict[str, Any]) -> list[str]:
    etype = event.get("type")
    if etype == "phase.start":
        note = str(event.get("note") or "").strip()
        suffix = f" — {note}" if note else ""
        return [f"- phase.start @ {event.get('timestamp', '')}{suffix}"]
    if etype == "phase.end":
        note = str(event.get("note") or "").strip()
        suffix = f" — {note}" if note else ""
        return [f"- phase.end @ {event.get('timestamp', '')}{suffix}"]
    if etype == "verification":
        name = event.get("name") or "(unnamed)"
        symbol = status_symbol(event.get("status"), event.get("reason") or event.get("note"))
        return [f"- verification: {name} → {symbol}"]
    if etype == "decision":
        decision = event.get("decision") or ""
        reason = event.get("reason") or event.get("note") or ""
        if reason:
            return [f"- decision: {decision} — {reason}"]
        return [f"- decision: {decision}"]
    if etype == "issue":
        symbol = severity_symbol(event.get("severity"), event.get("message"))
        code = event.get("code")
        prefix = f"[{code}] " if code else ""
        return [f"- issue: {prefix}{symbol}"]
    if etype == "artifact":
        path = event.get("path") or ""
        kind = event.get("kind")
        if kind:
            return [f"- artifact: `{path}` ({kind})"]
        return [f"- artifact: `{path}`"]
    if etype == "command":
        return render_command_block([event])
    # Unknown types: skip from human log to keep size down.
    return []


def render_execution_log(events: list[dict[str, Any]]) -> str:
    lines: list[str] = [
        f"> [!warning] {HEADER_LINE}",
        "",
        "# Execution Log",
        "",
    ]
    if not events:
        lines.append("_（暂无事件）_")
        lines.append("")
        return "\n".join(lines)

    for phase, phase_events in group_events_by_phase(events):
        start = phase_start_time(phase_events) or "—"
        duration = phase_duration_ms(phase_events)
        lines.append(f"## {phase} — {start}")
        lines.append("")
        if duration is not None:
            lines.append(f"- 阶段耗时: {format_duration(duration)}")
        # Collapse consecutive commands into one table.
        buffer: list[dict[str, Any]] = []

        def flush_commands() -> None:
            nonlocal buffer
            if buffer:
                lines.extend(render_command_block(buffer))
                buffer = []

        for event in phase_events:
            if event.get("type") == "command":
                buffer.append(event)
                continue
            flush_commands()
            lines.extend(render_event_line(event))
        flush_commands()
        lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def write_execution_log(change_dir: Path, content: str) -> Path:
    path = execution_log_path(change_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    # UTF-8 without BOM
    path.write_text(content, encoding="utf-8", newline="\n")
    return path


def build_summary(change_dir: Path, events: list[dict[str, Any]]) -> dict[str, Any]:
    phases: dict[str, Any] = {}
    issues: list[dict[str, Any]] = []

    for phase, phase_events in group_events_by_phase(events):
        start_ts = None
        end_ts = None
        for event in phase_events:
            if event.get("type") == "phase.start" and start_ts is None:
                start_ts = event.get("timestamp")
            elif event.get("type") == "phase.end":
                end_ts = event.get("timestamp")
        duration = None
        if start_ts and end_ts:
            duration = duration_ms_between(start_ts, end_ts)
        phases[phase] = {
            "event_count": len(phase_events),
            "started_at": start_ts,
            "ended_at": end_ts,
            "duration_ms": duration,
        }

    for event in events:
        if event.get("type") != "issue":
            continue
        issues.append(
            {
                "id": event.get("id"),
                "timestamp": event.get("timestamp"),
                "phase": event.get("phase"),
                "code": event.get("code"),
                "severity": event.get("severity"),
                "message": event.get("message"),
            }
        )

    return {
        "ok": True,
        "change_dir": str(change_dir),
        "event_count": len(events),
        "phases": phases,
        "issues": issues,
    }


def cmd_append(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    if args.type not in EVENT_TYPES:
        return emit_error(
            f"unsupported type: {args.type}; expected one of {sorted(EVENT_TYPES)}",
            as_json=as_json,
        )
    change_dir = resolve_change_dir(args.change_dir)
    path = events_path(change_dir)
    lock_path = change_dir / "events.ndjson.lock"

    # §6.1/§6.2: 普通 append = 加锁 -> 追加一行 -> fsync -> 解锁，不 load 历史、不渲染。
    # new_event_id 用完整 uuid，无需扫描去重。锁覆盖 atomic_append_line 的
    # open/write/flush/fsync 全过程。
    event = build_event(args, [])
    line = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    try:
        with event_file_lock(lock_path):
            atomic_append_line(path, line)
    except (OSError, TimeoutError) as exc:
        return emit_error(f"append failed: {exc}", as_json=as_json)

    # §6.1: phase.end append -> 追加成功后执行一次 render（从完整 events 重建 log）。
    # 普通 command/issue 等 append 不渲染（O(1)）；显式 `render` 子命令随时重建。
    rendered = False
    log_path = None
    log_lines = None
    if args.type == "phase.end":
        try:
            events = load_events(path)
            content = render_execution_log(events)
            log_path = write_execution_log(change_dir, content)
            log_lines = len(content.splitlines())
            rendered = True
        except (OSError, ValueError) as exc:
            return emit_error(f"phase.end render failed: {exc}", as_json=as_json)

    payload: dict[str, Any] = {
        "ok": True,
        "action": "append",
        "event": event,
        "events_path": str(path),
        "rendered": rendered,
    }
    if log_path is not None:
        payload["execution_log_path"] = str(log_path)
        payload["execution_log_lines"] = log_lines
    emit_json(payload, as_json=as_json)
    return 0


def cmd_render(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    change_dir = resolve_change_dir(args.change_dir)
    path = events_path(change_dir)
    try:
        events = load_events(path)
        content = render_execution_log(events)
        log_path = write_execution_log(change_dir, content)
    except (OSError, ValueError) as exc:
        return emit_error(f"render failed: {exc}", as_json=as_json)

    payload = {
        "ok": True,
        "action": "render",
        "events_path": str(path),
        "execution_log_path": str(log_path),
        "event_count": len(events),
        "execution_log_lines": len(content.splitlines()),
    }
    emit_json(payload, as_json=as_json)
    return 0


def cmd_summary(args: argparse.Namespace) -> int:
    # Structured summary is always JSON (task card: summary --json).
    change_dir = resolve_change_dir(args.change_dir)
    path = events_path(change_dir)
    try:
        events = load_events(path)
        payload = build_summary(change_dir, events)
    except (OSError, ValueError) as exc:
        return emit_error(f"summary failed: {exc}", as_json=True)

    emit_json(payload, as_json=True)
    return 0


def build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--json",
        action="store_true",
        help="emit machine-readable JSON on stdout",
    )

    parser = argparse.ArgumentParser(
        prog="harness_events.py",
        description="Append/render/summarize harness change events.ndjson",
        parents=[common],
    )
    sub = parser.add_subparsers(dest="command_name", required=True)

    p_append = sub.add_parser(
        "append",
        parents=[common],
        help="append one event and auto-render execution-log",
    )
    p_append.add_argument("--change-dir", required=True)
    p_append.add_argument("--phase", required=True)
    p_append.add_argument("--type", required=True)
    p_append.add_argument("--command", default=None)
    p_append.add_argument("--exit-code", type=int, default=None)
    p_append.add_argument("--duration-ms", type=int, default=None)
    p_append.add_argument("--note", default=None)
    p_append.add_argument("--name", default=None)
    p_append.add_argument("--status", default=None)
    p_append.add_argument("--path", default=None)
    p_append.add_argument("--kind", default=None)
    p_append.add_argument("--code", default=None)
    p_append.add_argument("--severity", default=None)
    p_append.add_argument("--message", default=None)
    p_append.add_argument("--decision", default=None)
    p_append.add_argument("--reason", default=None)
    p_append.set_defaults(func=cmd_append)

    p_render = sub.add_parser(
        "render",
        parents=[common],
        help="re-render execution-log.md from events.ndjson",
    )
    p_render.add_argument("--change-dir", required=True)
    p_render.set_defaults(func=cmd_render)

    p_summary = sub.add_parser(
        "summary",
        parents=[common],
        help="summarize phases/issues from events.ndjson",
    )
    p_summary.add_argument("--change-dir", required=True)
    p_summary.set_defaults(func=cmd_summary)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
