#!/usr/bin/env python3
"""Harness events.ndjson writer and execution-log renderer (D2).

Subcommands:
  append  — append one schema_version 3 event, then auto-render execution-log.md
  render  — full re-render of logs/execution-log.md from events.ndjson
  summary — phase durations, event counts, and issue list (JSON)

Python 3.10+, stdlib only. UTF-8 without BOM. Windows path safe.
"""

from __future__ import annotations

import argparse
import copy
import contextlib
import datetime as dt
import hashlib
import json
import os
import re
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Sequence

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_paths  # noqa: E402


def _project_root_for_change(change_dir: Path) -> Path | None:
    resolved = change_dir.resolve()
    for candidate in (resolved, *resolved.parents):
        if candidate.name == "changes" and candidate.parent.name == ".harness":
            return candidate.parent.parent
    return None


def nudge_remote_sync(change_dir: Path) -> None:
    """Best-effort wake-up after the event append has been flushed to disk."""
    project_root = _project_root_for_change(change_dir)
    if project_root is None:
        return
    try:
        from harness_events_sync import schedule_events_sync

        schedule_events_sync(project_root, change_dir)
    except Exception:
        # Local event durability is authoritative; remote outages never roll it back.
        return


def _nudge_remote_sync(change_dir: Path) -> None:
    """Compatibility wrapper for older callers and focused tests."""
    nudge_remote_sync(change_dir)


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


EVENT_TYPES = frozenset(
    {
        "phase.start",
        "phase.end",
        "phase.auto_sealed",
        "gate.blocked",
        "gate.recovered",
        "command",
        "verification",
        "artifact",
        "issue",
        "issue.resolve",
        "decision",
        "correction",
        "change.rename",
    }
)

SCHEMA_VERSION = 3
_NOTE_FALLBACK_MAXLEN = 60
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
    "issue_id",
    "scope",
    "target_event_id",
    "target_field",
    "old_value_hash",
    "new_value_json",
    "run_id",
    "attempt",
    "executor_tool",
    "executor_agent",
    "executor_model",
    "handoff_from_tool",
    "handoff_reason",
    "trace_id",
    "span_id",
    "parent_span_id",
    "runner_ms",
    "orchestration_active_ms",
    "wall_clock_ms",
    "user_wait_ms",
    "renamed_from",
    "renamed_to",
    "change_uuid",
    "execution_mode",
    "decision_reason_code",
    "fallback_reason_code",
    "trigger",
    "from_phase",
    "result_status",
)

_PROVENANCE_FIELDS = frozenset(
    {
        "run_id",
        "attempt",
        "executor_tool",
        "executor_agent",
        "executor_model",
        "handoff_from_tool",
        "handoff_reason",
        "trace_id",
        "span_id",
        "parent_span_id",
        "runner_ms",
        "orchestration_active_ms",
        "wall_clock_ms",
        "user_wait_ms",
        "execution_mode",
        "decision_reason_code",
        "fallback_reason_code",
        "trigger",
        "from_phase",
        "result_status",
    }
)
_EVENT_ALLOWED_FIELDS = {
    "phase.start": frozenset({"note"}) | _PROVENANCE_FIELDS,
    "phase.end": frozenset(
        {"status", "duration_ms", "note", "reason", "issue_id"}
    )
    | _PROVENANCE_FIELDS,
    "phase.auto_sealed": frozenset({"status", "reason", "note"}) | _PROVENANCE_FIELDS,
    "gate.blocked": frozenset({"status", "code", "reason", "note"})
    | _PROVENANCE_FIELDS,
    "gate.recovered": frozenset({"status", "code", "reason", "note"})
    | _PROVENANCE_FIELDS,
    "command": frozenset({"command", "exit_code", "duration_ms", "note"})
    | _PROVENANCE_FIELDS,
    "verification": frozenset(
        {"name", "status", "reason", "command", "exit_code", "duration_ms", "note"}
    )
    | _PROVENANCE_FIELDS,
    "artifact": frozenset({"path", "kind", "note"}) | _PROVENANCE_FIELDS,
    "issue": frozenset({"code", "scope", "severity", "message", "reason", "note"})
    | frozenset({"issue_id"})
    | _PROVENANCE_FIELDS,
    "issue.resolve": frozenset({"issue_id", "reason", "note"})
    | _PROVENANCE_FIELDS,
    "decision": frozenset({"decision", "reason", "note"}) | _PROVENANCE_FIELDS,
    "correction": frozenset(
        {
            "target_event_id",
            "target_field",
            "old_value_hash",
            "new_value_json",
            "reason",
            "note",
        }
    )
    | _PROVENANCE_FIELDS,
    "change.rename": frozenset(
        {"renamed_from", "renamed_to", "change_uuid", "note"}
    )
    | _PROVENANCE_FIELDS,
}
_EVENT_REQUIRED_FIELDS = {
    "issue": ("severity",),
    "issue.resolve": ("issue_id", "reason"),
    "verification": ("name", "status"),
    "correction": (
        "target_event_id",
        "target_field",
        "old_value_hash",
        "new_value_json",
        "reason",
    ),
    "phase.auto_sealed": ("reason",),
}
_CORRECTION_PROTECTED_FIELDS = frozenset(
    {"schema_version", "id", "timestamp", "phase", "type"}
)

# HH-WF-20260730-001: reasons a write-path auto-seal may attribute to an
# attempt that was still open when it was closed on its behalf.
_AUTO_SEAL_REASONS = frozenset(
    {"executor_lost", "user_wait", "external_wait", "superseded", "unknown"}
)

# Best-effort mapping from wait-style metadata events (seen inside an open
# attempt's own event stream) to the auto-seal reason they imply.
_WAIT_EVENT_REASON_MAP = {
    "user.wait": "user_wait",
    "environment.wait": "external_wait",
    "env.wait": "external_wait",
    "external.wait": "external_wait",
    "ci.wait": "external_wait",
}
_RECOVERY_EVENT_TYPES = frozenset({"recovery", "phase.recovery", "attempt.recovery"})

# Terminal event types that close a phase attempt (RET/HH-WF-20260730-001).
# ``phase.end`` is an explicit human/automation-reported terminal; the
# write path also inserts ``phase.auto_sealed`` when a new ``phase.start``
# (or another terminal path) finds a still-open prior attempt.
TERMINAL_PHASE_EVENT_TYPES = frozenset({"phase.end", "phase.auto_sealed"})


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="milliseconds")


def emit_json(payload: dict[str, Any], *, as_json: bool) -> None:
    if as_json:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    else:
        ok = payload.get("ok", True)
        msg = payload.get("message") or payload.get("path") or ("ok" if ok else "error")
        sys.stdout.write(f"{msg}\n")


def emit_error(
    message: str,
    *,
    as_json: bool,
    code: int = 1,
    error_code: str | None = None,
) -> int:
    payload = {"ok": False, "error": message}
    if error_code:
        payload["code"] = error_code
    if as_json:
        sys.stderr.write(json.dumps(payload, ensure_ascii=False) + "\n")
    else:
        sys.stderr.write(f"error: {message}\n")
    return code


def resolve_change_dir(raw: str) -> Path:
    return Path(raw).expanduser().resolve()


def _state_dir(change_dir: Path) -> Path:
    return Path(harness_paths.resolve_state_dir_for_contract(change_dir))


def events_path(change_dir: Path) -> Path:
    return _state_dir(change_dir) / "events.ndjson"


def execution_log_path(change_dir: Path) -> Path:
    return _state_dir(change_dir) / "logs" / "execution-log.md"


def archived_change_dir(change_dir: Path) -> Path | None:
    """Return the matching archive when change_dir follows the project layout."""
    changes_root = change_dir.parent
    harness_root = changes_root.parent
    if changes_root.name != "changes" or harness_root.name != ".harness":
        return None
    archive_root = harness_root / "archive"
    if not archive_root.is_dir():
        return None
    suffix = "-" + change_dir.name
    matches = sorted(
        candidate for candidate in archive_root.iterdir()
        if candidate.is_dir() and (
            candidate.name == change_dir.name or candidate.name.endswith(suffix)
        )
    )
    return matches[-1] if matches else None


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
    """Normalize schema_version 1/2/3 events for rendering and summary."""
    event = dict(raw)
    version = event.get("schema_version", 1)
    try:
        version_int = int(version)
    except (TypeError, ValueError):
        version_int = 1
    event["schema_version"] = version_int
    if version_int < SCHEMA_VERSION and "schemaValidation" not in event:
        event["schemaValidation"] = "legacy"
    if "note" not in event or event["note"] is None:
        event["note"] = ""
    return event


def canonical_value_hash(value: Any) -> str:
    """Return the stable optimistic-concurrency hash for a corrected value."""
    payload = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def apply_event_corrections(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Project append-only correction events without mutating event history.

    Corrections may target only earlier events and use an old-value hash as an
    optimistic-concurrency guard. The correction records remain in the raw
    stream; projections return only the corrected domain events.
    """
    projected: list[dict[str, Any]] = []
    by_id: dict[str, dict[str, Any]] = {}
    for raw in events:
        event = copy.deepcopy(raw)
        if event.get("type") != "correction":
            projected.append(event)
            event_id = str(event.get("id") or "").strip()
            if event_id:
                by_id[event_id] = event
            continue

        correction_id = str(event.get("id") or "<unknown>")
        target_id = str(event.get("target_event_id") or "").strip()
        target = by_id.get(target_id)
        if target is None:
            raise ValueError(
                f"CORRECTION_TARGET_NOT_FOUND: {correction_id} targets {target_id}"
            )
        field = str(event.get("target_field") or "").strip()
        if not field or field in _CORRECTION_PROTECTED_FIELDS:
            raise ValueError(
                f"CORRECTION_FIELD_NOT_ALLOWED: {correction_id} targets {field}"
            )
        actual_hash = canonical_value_hash(target.get(field))
        expected_hash = str(event.get("old_value_hash") or "").strip()
        if actual_hash != expected_hash:
            raise ValueError(
                "CORRECTION_OLD_VALUE_MISMATCH: "
                f"{correction_id} expected {expected_hash}, found {actual_hash}"
            )
        target[field] = copy.deepcopy(event.get("new_value"))
    return projected


def _issue_identity(event: dict[str, Any]) -> str:
    explicit = str(event.get("issue_id") or "").strip()
    if explicit:
        return explicit
    code = str(event.get("code") or "").strip()
    scope = str(event.get("scope") or "").strip()
    if code:
        return f"code:{code}|scope:{scope}"
    return str(event.get("id") or "").strip()


def current_issues(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return unresolved issues while preserving the full append-only history."""
    active: dict[str, dict[str, Any]] = {}
    for event in apply_event_corrections(events):
        event_type = event.get("type")
        if event_type == "issue":
            identity = _issue_identity(event)
            if identity:
                item = copy.deepcopy(event)
                item["issue_id"] = identity
                active[identity] = item
        elif event_type == "issue.resolve":
            active.pop(_issue_identity(event), None)
        elif event_type == "phase.end" and str(event.get("status") or "").upper() == "OK":
            identity = str(event.get("issue_id") or "").strip()
            if not identity:
                continue
            phase = event.get("phase")
            attempt = event.get("attempt")
            issue = active.get(identity)
            if issue is None or issue.get("phase") != phase:
                continue
            issue_attempt = issue.get("attempt")
            if (
                isinstance(attempt, int)
                and isinstance(issue_attempt, int)
                and issue_attempt >= attempt
            ):
                continue
            active.pop(identity, None)
    return list(active.values())


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


def merge_event_files(paths: list[Path]) -> list[dict[str, Any]]:
    """Union events from multiple NDJSON files by event ID (UT-001/RET-05).

    Each event ID appears exactly once; first-seen copy wins. Missing IDs are
    kept keyed by (file index, line number) so unidentified events are never
    silently dropped.
    """
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for path in paths:
        for event in load_events(Path(path)):
            event_id = str(event.get("id") or "").strip()
            if event_id:
                if event_id in seen:
                    continue
                seen.add(event_id)
            merged.append(event)
    return merged


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


def append_event(
    change_dir: Path,
    *,
    phase: str,
    type_: str,
    note: str = "",
    kind: str | None = None,
    path: str | None = None,
    run_id: str | None = None,
    executor_tool: str | None = None,
    renamed_from: str | None = None,
    renamed_to: str | None = None,
    change_uuid: str | None = None,
) -> dict[str, Any]:
    """Programmatic append API (retro §5.31 C5/T16).

    Validates and appends an event without going through argparse. Returns
    a payload dict with ``ok``/``code``/``event``.
    """
    args = argparse.Namespace(
        change_dir=str(change_dir),
        phase=phase,
        type=type_,
        note=note,
        kind=kind,
        path=path,
        run_id=run_id,
        executor_tool=executor_tool,
        command=None,
        exit_code=None,
        duration_ms=None,
        status=None,
        name=None,
        code=None,
        severity=None,
        message=None,
        decision=None,
        reason=None,
        issue_id=None,
        scope=None,
        target_event_id=None,
        target_field=None,
        old_value_hash=None,
        new_value_json=None,
        renamed_from=renamed_from,
        renamed_to=renamed_to,
        change_uuid=change_uuid,
        attempt=None,
        executor_agent=None,
        executor_model=None,
        handoff_from_tool=None,
        handoff_reason=None,
        trace_id=None,
        span_id=None,
        parent_span_id=None,
        runner_ms=None,
        orchestration_active_ms=None,
        wall_clock_ms=None,
        user_wait_ms=None,
        legacy_lenient=False,
        json=True,
    )
    as_json = True
    if type_ not in EVENT_TYPES:
        return {"ok": False, "code": "EVENT_TYPE_INVALID", "message": f"unsupported type: {type_}"}
    validation = validate_append_event(args)
    if validation:
        error_code, message = validation
        return {"ok": False, "code": error_code, "message": message}
    archived = archived_change_dir(change_dir)
    if archived is not None:
        return {"ok": False, "code": "ARCHIVED_CHANGE_IMMUTABLE", "message": str(archived)}
    events_path_obj = events_path(change_dir)
    event = build_event(args, [])
    result = append_with_auto_seal(events_path_obj, event)
    if result.get("phaseAlreadyClosed"):
        return {
            "ok": False,
            "code": "PHASE_ALREADY_CLOSED",
            "message": "PHASE_ALREADY_CLOSED: refusing a second phase.end for the same attempt",
            "event": event,
            "autoSealed": result.get("autoSealed") or [],
        }
    _nudge_remote_sync(change_dir)
    return {
        "ok": True,
        "event": event,
        "events_path": str(events_path_obj),
        "rendered": False,
        "autoSealed": result.get("autoSealed") or [],
    }


def batch_append_events(
    change_dir: Path,
    events: Sequence[dict[str, Any]],
) -> dict[str, Any]:
    """Validate then append many events under one lock (Wave-2 H-15).

    Any invalid item aborts the whole batch before mutation. ``phase.end`` items
    are rejected here — use single ``append`` so render semantics stay explicit.
    """
    if not isinstance(events, (list, tuple)) or not events:
        return {
            "ok": False,
            "code": "BATCH_EMPTY",
            "message": "batch-append requires a non-empty events array",
        }
    archived = archived_change_dir(change_dir)
    if archived is not None:
        return {
            "ok": False,
            "code": "ARCHIVED_CHANGE_IMMUTABLE",
            "message": str(archived),
        }

    built: list[dict[str, Any]] = []
    for index, raw in enumerate(events):
        if not isinstance(raw, dict):
            return {
                "ok": False,
                "code": "BATCH_ITEM_INVALID",
                "message": f"events[{index}] must be an object",
                "index": index,
            }
        type_ = str(raw.get("type") or "").strip()
        phase = str(raw.get("phase") or "").strip()
        if not type_ or type_ not in EVENT_TYPES:
            return {
                "ok": False,
                "code": "EVENT_TYPE_INVALID",
                "message": f"events[{index}]: unsupported type: {type_}",
                "index": index,
            }
        if not phase:
            return {
                "ok": False,
                "code": "EVENT_REQUIRED_FIELD",
                "message": f"events[{index}]: phase required",
                "index": index,
            }
        if type_ == "phase.end":
            return {
                "ok": False,
                "code": "BATCH_PHASE_END_FORBIDDEN",
                "message": f"events[{index}]: phase.end must use single append",
                "index": index,
            }
        args = argparse.Namespace(
            change_dir=str(change_dir),
            phase=phase,
            type=type_,
            note=raw.get("note"),
            kind=raw.get("kind"),
            path=raw.get("path"),
            run_id=raw.get("run_id"),
            executor_tool=raw.get("executor_tool"),
            command=raw.get("command"),
            exit_code=raw.get("exit_code"),
            duration_ms=raw.get("duration_ms"),
            status=raw.get("status"),
            name=raw.get("name"),
            code=raw.get("code"),
            severity=raw.get("severity"),
            message=raw.get("message"),
            decision=raw.get("decision"),
            reason=raw.get("reason"),
            issue_id=raw.get("issue_id"),
            scope=raw.get("scope"),
            target_event_id=raw.get("target_event_id"),
            target_field=raw.get("target_field"),
            old_value_hash=raw.get("old_value_hash"),
            new_value_json=raw.get("new_value_json"),
            renamed_from=raw.get("renamed_from"),
            renamed_to=raw.get("renamed_to"),
            change_uuid=raw.get("change_uuid"),
            attempt=raw.get("attempt"),
            executor_agent=raw.get("executor_agent"),
            executor_model=raw.get("executor_model"),
            handoff_from_tool=raw.get("handoff_from_tool"),
            handoff_reason=raw.get("handoff_reason"),
            trace_id=raw.get("trace_id"),
            span_id=raw.get("span_id"),
            parent_span_id=raw.get("parent_span_id"),
            runner_ms=raw.get("runner_ms"),
            orchestration_active_ms=raw.get("orchestration_active_ms"),
            wall_clock_ms=raw.get("wall_clock_ms"),
            user_wait_ms=raw.get("user_wait_ms"),
            legacy_lenient=False,
            json=True,
        )
        validation = validate_append_event(args)
        if validation:
            error_code, message = validation
            return {
                "ok": False,
                "code": error_code,
                "message": f"events[{index}]: {message}",
                "index": index,
            }
        built.append(build_event(args, []))

    events_path_obj = events_path(change_dir)
    lock_path = events_path_obj.with_name(events_path_obj.name + ".lock")
    with event_file_lock(lock_path):
        for event in built:
            atomic_append_line(
                events_path_obj, json.dumps(event, ensure_ascii=False, separators=(",", ":"))
            )
    _nudge_remote_sync(change_dir)
    return {
        "ok": True,
        "action": "batch-append",
        "count": len(built),
        "events": built,
        "events_path": str(events_path_obj),
        "rendered": False,
    }


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
        if field == "new_value_json":
            event["new_value"] = json.loads(value)
        else:
            event[field] = value
    if args.type == "issue" and not event.get("issue_id"):
        event["issue_id"] = _issue_identity(event)
    environment_defaults = {
        "run_id": "HUNTER_HARNESS_RUN_ID",
        "executor_tool": "HUNTER_HARNESS_TOOL",
        "executor_agent": "HUNTER_HARNESS_AGENT",
        "executor_model": "HUNTER_HARNESS_MODEL",
    }
    for field, env_name in environment_defaults.items():
        if field not in event and os.environ.get(env_name):
            event[field] = os.environ[env_name]
    if "note" not in event:
        event["note"] = ""
    return event


def validate_append_event(args: argparse.Namespace) -> tuple[str, str] | None:
    """Validate type-specific append fields before any file is mutated."""
    event_type = str(args.type)
    for field in _EVENT_REQUIRED_FIELDS.get(event_type, ()):
        value = getattr(args, field, None)
        if value is None or (isinstance(value, str) and not value.strip()):
            return (
                "EVENT_REQUIRED_FIELD",
                f"EVENT_REQUIRED_FIELD: {event_type} requires --{field.replace('_', '-')}",
            )
    allowed = _EVENT_ALLOWED_FIELDS[event_type]
    for field in OPTIONAL_FIELDS:
        value = getattr(args, field, None)
        if value is not None and field not in allowed:
            return (
                "EVENT_FIELD_NOT_ALLOWED",
                "EVENT_FIELD_NOT_ALLOWED: "
                f"{event_type} does not accept --{field.replace('_', '-')}",
            )
    for field, length in (("trace_id", 32), ("span_id", 16), ("parent_span_id", 16)):
        value = getattr(args, field, None)
        if value is not None and not re.fullmatch(rf"[0-9a-f]{{{length}}}", str(value)):
            return (
                "EVENT_TRACE_FIELD_INVALID",
                f"EVENT_TRACE_FIELD_INVALID: --{field.replace('_', '-')} must be {length} lowercase hex characters",
            )
    for field in (
        "runner_ms",
        "orchestration_active_ms",
        "wall_clock_ms",
        "user_wait_ms",
    ):
        value = getattr(args, field, None)
        if value is not None and (not isinstance(value, int) or value < 0):
            return (
                "EVENT_TIMING_FIELD_INVALID",
                f"EVENT_TIMING_FIELD_INVALID: --{field.replace('_', '-')} must be a nonnegative integer",
            )
    if event_type == "phase.auto_sealed":
        reason_value = str(getattr(args, "reason", "") or "").strip()
        if reason_value and reason_value not in _AUTO_SEAL_REASONS:
            return (
                "EVENT_REASON_INVALID",
                "EVENT_REASON_INVALID: phase.auto_sealed --reason must be one of "
                f"{sorted(_AUTO_SEAL_REASONS)}",
            )
    if event_type == "correction":
        target_field = str(getattr(args, "target_field", "") or "").strip()
        if target_field in _CORRECTION_PROTECTED_FIELDS:
            return (
                "CORRECTION_FIELD_NOT_ALLOWED",
                f"CORRECTION_FIELD_NOT_ALLOWED: cannot correct {target_field}",
            )
        try:
            json.loads(str(getattr(args, "new_value_json", "")))
        except json.JSONDecodeError as exc:
            return (
                "CORRECTION_VALUE_INVALID_JSON",
                f"CORRECTION_VALUE_INVALID_JSON: {exc}",
            )
    # Retro 2026-07-21 H-8: artifact events always require a non-empty path.
    # Knowledge/exploration notes must use issue/decision, not pathless artifacts.
    if event_type == "artifact":
        path = str(getattr(args, "path", "") or "").strip()
        if not path:
            return (
                "ARTIFACT_PATH_REQUIRED",
                "ARTIFACT_PATH_REQUIRED: artifact requires --path "
                "(use issue/decision for informational notes)",
            )
    return None


def status_symbol(status: Any, reason: Any = None) -> str:
    text = str(status or "").strip().lower()
    reason_text = str(reason or "").strip()
    if not text:
        return "—"
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
    return str(status)


def severity_symbol(severity: Any, message: Any = None) -> str:
    text = str(severity or "").strip().lower()
    msg = str(message or "").strip()
    if text in {"error", "fail", "failed", "critical"}:
        return f"❌FAIL({msg})" if msg else "❌FAIL"
    if text in {"warn", "warning"}:
        return f"🟡WARN({msg})" if msg else "🟡WARN"
    if text in {"info", "ok", "note"}:
        return f"✅OK({msg})" if msg else "✅OK"
    # Empty/unknown severity: never emit literal "issue"/"None".
    if not text:
        return ""
    return f"{severity}: {msg}" if msg else str(severity)


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


def split_phase_attempts(phase_events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Split repeated starts into attempts and flag legacy events written after end.

    ``phase.end`` and ``phase.auto_sealed`` are both terminal: either one closes
    the current attempt (HH-WF-20260730-001).
    """
    attempts: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    next_attempt = 1
    pre_start_metadata_types = {
        "correction",
        "decision",
        "environment.wait",
        "env.wait",
        "external.wait",
        "issue",
        "ci.wait",
    }
    for event in phase_events:
        if event.get("type") == "phase.start":
            if current is not None:
                current["warnings"].append("new phase.start before prior phase.end")
                attempts.append(current)
            raw_attempt = event.get("attempt")
            attempt = raw_attempt if isinstance(raw_attempt, int) and raw_attempt > 0 else next_attempt
            next_attempt = max(next_attempt, attempt + 1)
            current = {"attempt": attempt, "events": [event], "warnings": []}
            continue
        if current is None:
            if attempts:
                prior_type = attempts[-1]["events"][-1].get("type")
                attempts[-1]["events"].append(event)
                if prior_type in TERMINAL_PHASE_EVENT_TYPES:
                    attempts[-1]["warnings"].append("event recorded after phase.end")
                continue
            if event.get("type") in pre_start_metadata_types:
                # Decisions and diagnostics may be emitted while selecting or
                # recovering a phase. They describe workflow context, not an
                # execution attempt, so they must not manufacture an orphan.
                continue
            raw_attempt = event.get("attempt")
            attempt = raw_attempt if isinstance(raw_attempt, int) and raw_attempt > 0 else next_attempt
            next_attempt = max(next_attempt, attempt + 1)
            current = {
                "attempt": attempt,
                "events": [event],
                "warnings": ["missing phase.start"],
            }
        else:
            current["events"].append(event)
        if event.get("type") in TERMINAL_PHASE_EVENT_TYPES:
            attempts.append(current)
            current = None
    if current is not None:
        attempts.append(current)
    return attempts


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
        elif etype in TERMINAL_PHASE_EVENT_TYPES:
            end_ts = event.get("timestamp")
    if start_ts and end_ts:
        # Closed phases end at the matching phase.end. Late events appended
        # after closure are reported separately (late_event_stats) and never
        # extend the closed duration (RET-21).
        return duration_ms_between(start_ts, end_ts)
    # Fallback: first to last timestamp in the phase bucket.
    stamps = [e.get("timestamp") for e in phase_events if e.get("timestamp")]
    if len(stamps) >= 2:
        return duration_ms_between(stamps[0], stamps[-1])
    return None


def late_event_stats(phase_events: list[dict[str, Any]]) -> dict[str, int]:
    """Count events recorded after the final closing phase.end (RET-21)."""
    final_end_index = None
    for index, event in enumerate(phase_events):
        if event.get("type") == "phase.end":
            final_end_index = index
    if final_end_index is None:
        return {"lateEventCount": 0, "lateEventSpanMs": 0}
    end_ts = phase_events[final_end_index].get("timestamp")
    late_stamps = [
        event["timestamp"]
        for event in phase_events[final_end_index + 1 :]
        if event.get("timestamp")
    ]
    if not late_stamps:
        return {"lateEventCount": 0, "lateEventSpanMs": 0}
    span = duration_ms_between(end_ts, late_stamps[-1]) or 0
    return {"lateEventCount": len(late_stamps), "lateEventSpanMs": span}


def _seal_timestamp_for_attempt(
    events_in: list[dict[str, Any]],
    *,
    cutoff_ts: str | None,
    next_attempt_start: Any = None,
) -> tuple[Any, str | None]:
    """Pick a typed terminal and seal time for an unclosed attempt."""
    recovery_ts = None
    explicit_terminal: tuple[Any, str] | None = None
    for event in events_in:
        event_type = str(event.get("type") or "").lower()
        if event_type in {
            "recovery",
            "phase.recovery",
            "attempt.recovery",
        }:
            recovery_ts = event.get("timestamp") or recovery_ts
        terminal = {
            "attempt.abandoned": "ABANDONED",
            "phase.abandoned": "ABANDONED",
            "attempt.interrupted": "INTERRUPTED",
            "phase.interrupted": "INTERRUPTED",
            "attempt.orphaned": "ORPHANED",
            "phase.orphaned": "ORPHANED",
        }.get(event_type)
        if terminal and event.get("timestamp"):
            explicit_terminal = (event.get("timestamp"), terminal)
    if explicit_terminal is not None:
        return explicit_terminal
    if next_attempt_start:
        return next_attempt_start, "RECOVERED"
    if recovery_ts:
        return recovery_ts, "RECOVERED"
    if cutoff_ts:
        return cutoff_ts, "INCOMPLETE_AT_CUTOFF"
    # Fall back to last event timestamp so wall clock is not silently dropped.
    for event in reversed(events_in):
        if event.get("timestamp"):
            return event.get("timestamp"), "INTERRUPTED"
    return None, "ORPHANED"


def attempt_invocations(
    phase_events: list[dict[str, Any]],
    *,
    cutoff_ts: str | None = None,
) -> list[dict[str, Any]]:
    """Per-attempt invocation view: attempt, status, durationMs (RET-22 / IA-2).

    Closed attempts keep phase.end status. Attempts closed by a write-path
    ``phase.auto_sealed`` event (HH-WF-20260730-001) keep that event's status
    (typically RECOVERED) but are never activeEligible: recovered/superseded
    time must not count as active execution. Unclosed attempts (no terminal
    event at all yet) are sealed as INCOMPLETE at the next attempt start, an
    explicit recovery event, or cutoff.
    """
    attempts = split_phase_attempts(phase_events)
    invocations: list[dict[str, Any]] = []
    for index, attempt in enumerate(attempts):
        events_in = attempt.get("events") or []
        start_ts = None
        end_ts = None
        status = None
        terminal_status = None
        closed_by_end = False
        closed_by_auto_seal = False
        for event in events_in:
            if event.get("type") == "phase.start" and start_ts is None:
                start_ts = event.get("timestamp")
            elif event.get("type") == "phase.end":
                end_ts = event.get("timestamp")
                if "status" in event:
                    status = event.get("status")
                    terminal_status = str(event.get("status") or "").upper() or None
                closed_by_end = True
            elif event.get("type") == "phase.auto_sealed":
                end_ts = event.get("timestamp")
                seal_status = event.get("status") or "RECOVERED"
                status = seal_status
                terminal_status = str(seal_status or "").upper() or "RECOVERED"
                closed_by_auto_seal = True
        missing_start = start_ts is None
        sealed_incomplete = False
        if not closed_by_end and not closed_by_auto_seal:
            next_start = None
            if index + 1 < len(attempts):
                for event in attempts[index + 1].get("events") or []:
                    if event.get("type") == "phase.start" and event.get("timestamp"):
                        next_start = event.get("timestamp")
                        break
            seal_ts, seal_status = _seal_timestamp_for_attempt(
                events_in,
                cutoff_ts=cutoff_ts,
                next_attempt_start=next_start,
            )
            if seal_ts is not None:
                end_ts = seal_ts
                status = seal_status
                terminal_status = seal_status
                sealed_incomplete = True
        elif missing_start:
            terminal_status = "ORPHANED"
            status = "ORPHANED"
            sealed_incomplete = True
        duration = None
        if start_ts and end_ts:
            duration = duration_ms_between(start_ts, end_ts)
        # Active execution counts phase.end-closed attempts only. Both
        # cutoff/INCOMPLETE seals and auto-sealed (recovered/superseded)
        # attempts are excluded (HH-WF-20260730-001).
        active_eligible = closed_by_end and not sealed_incomplete
        invocations.append(
            {
                "attempt": attempt.get("attempt"),
                "status": status,
                "terminalStatus": terminal_status,
                "startedAt": start_ts,
                "endedAt": end_ts,
                "durationMs": duration,
                "activeEligible": active_eligible,
                "sealedIncomplete": sealed_incomplete,
                "closedByAutoSeal": closed_by_auto_seal,
                "warnings": list(attempt.get("warnings") or []),
            }
        )
    return invocations


def phase_final_state(phase_events: list[dict[str, Any]]) -> dict[str, Any]:
    """Reduce a phase to the state of its latest attempt."""
    invocations = attempt_invocations(phase_events)
    if not invocations:
        return {"attempt": None, "status": None, "durationMs": None, "closed": False}
    latest = invocations[-1]
    return {
        "attempt": latest.get("attempt"),
        "status": latest.get("status"),
        "durationMs": latest.get("durationMs"),
        "closed": latest.get("terminalStatus") not in {
            None,
            "INCOMPLETE",
            "INCOMPLETE_AT_CUTOFF",
            "ORPHANED",
            "INTERRUPTED",
        },
    }


def canonical_phase_timing(
    phase_events: list[dict[str, Any]],
    *,
    cutoff_ts: str | None = None,
) -> dict[str, Any]:
    """Single reducer for every duration view (RET-20 / IA-2).

    activeExecutionMs: sum of closed attempt start→end only (INCOMPLETE excluded).
    recoveredMs: sum of durations for attempts terminated via write-path
        auto-seal (HH-WF-20260730-001) — always disjoint from activeExecutionMs.
    wallClockSpanMs: first → last/cutoff timestamp; unclosed attempts retain span.
    """
    invocations = attempt_invocations(phase_events, cutoff_ts=cutoff_ts)
    stamps = [e.get("timestamp") for e in phase_events if e.get("timestamp")]
    # Cutoff seals INCOMPLETE attempts but must not inflate stage wall by itself.
    # Include cutoff in the wall span only when it sealed an otherwise-open attempt.
    if cutoff_ts and any(inv.get("sealedIncomplete") for inv in invocations):
        stamps = list(stamps) + [cutoff_ts]
    closed_durations = [
        invocation["durationMs"]
        for invocation in invocations
        if invocation.get("activeEligible") and invocation.get("durationMs") is not None
    ]
    active = sum(closed_durations) if closed_durations else (0 if invocations else None)
    recovered_durations = [
        invocation["durationMs"]
        for invocation in invocations
        if invocation.get("closedByAutoSeal") and invocation.get("durationMs") is not None
    ]
    recovered = sum(recovered_durations) if recovered_durations else (0 if invocations else None)
    late = late_event_stats(phase_events)
    if len(stamps) >= 2:
        wall = duration_ms_between(stamps[0], stamps[-1])
    else:
        wall = active
    unclosed = sum(
        1
        for invocation in invocations
        if invocation.get("terminalStatus")
        in {"INCOMPLETE", "INCOMPLETE_AT_CUTOFF", "ORPHANED", "INTERRUPTED"}
    )
    return {
        "activeExecutionMs": active,
        "recoveredMs": recovered,
        "wallClockSpanMs": wall,
        "lateEventCount": late["lateEventCount"],
        "lateEventSpanMs": late["lateEventSpanMs"],
        "unclosedAttemptCount": unclosed,
        "attempts": invocations,
    }


def render_command_block(commands: list[dict[str, Any]]) -> list[str]:
    if not commands:
        return []

    def command_display(event: dict[str, Any]) -> str:
        cmd = str(event.get("command") or "").strip()
        if cmd:
            return cmd
        return str(event.get("note") or "").strip()

    if len(commands) == 1:
        event = commands[0]
        display = command_display(event)
        if not display:
            return []
        exit_code = event.get("exit_code")
        exit_text = "?" if exit_code is None else str(exit_code)
        duration = format_duration(
            int(event["duration_ms"]) if isinstance(event.get("duration_ms"), int) else None
        )
        note = str(event.get("note") or "").strip()
        parts = [f"- command: `{display}`", f"exit={exit_text}", f"duration={duration}"]
        # Avoid duplicating note when it was already used as the display text.
        if note and note != display:
            parts.append(f"note={note}")
        return [" · ".join(parts)]

    rows: list[str] = []
    for event in commands:
        display = command_display(event)
        if not display:
            continue
        cmd = display.replace("|", "\\|")
        exit_code = event.get("exit_code")
        exit_text = "?" if exit_code is None else str(exit_code)
        duration = format_duration(
            int(event["duration_ms"]) if isinstance(event.get("duration_ms"), int) else None
        )
        note = str(event.get("note") or "").replace("|", "\\|")
        # If note was promoted to the command cell, leave the note column empty.
        note_cell = "" if note == display else note
        rows.append(f"| `{cmd}` | {exit_text} | {duration} | {note_cell} |")
    if not rows:
        return []
    lines = [
        "",
        "| 命令 | exit | duration | note |",
        "| --- | ---: | ---: | --- |",
        *rows,
        "",
    ]
    return lines


def render_event_line(event: dict[str, Any]) -> list[str]:
    etype = event.get("type")
    if etype == "phase.start":
        note = str(event.get("note") or "").strip()
        suffix = f" — {note}" if note else ""
        lines = [f"- phase.start @ {event.get('timestamp', '')}{suffix}"]
        tool = str(event.get("executor_tool") or "").strip()
        agent = str(event.get("executor_agent") or "").strip()
        handoff = str(event.get("handoff_from_tool") or "").strip()
        if handoff and tool:
            lines.append(f"- 工具交接: {handoff} → {tool}")
        elif tool:
            lines.append(f"- 执行来源: {tool}" + (f" / {agent}" if agent else ""))
        return lines
    if etype == "phase.end":
        note = str(event.get("note") or "").strip()
        suffix = f" — {note}" if note else ""
        return [f"- phase.end @ {event.get('timestamp', '')}{suffix}"]
    if etype == "phase.auto_sealed":
        reason = str(event.get("reason") or "").strip() or "unknown"
        status = str(event.get("status") or "RECOVERED").strip()
        note = str(event.get("note") or "").strip()
        suffix = f" — {note}" if note else ""
        return [
            f"- phase.auto_sealed ({status}/{reason}) @ {event.get('timestamp', '')}{suffix}"
        ]
    if etype == "verification":
        note = str(event.get("note") or "").strip()
        name = str(event.get("name") or "").strip() or (
            note[:_NOTE_FALLBACK_MAXLEN] if note else ""
        )
        if not name:
            return []
        symbol = status_symbol(event.get("status"), event.get("reason"))
        return [f"- verification: {name} → {symbol}"]
    if etype == "decision":
        decision = str(event.get("decision") or "").strip()
        reason = str(event.get("reason") or event.get("note") or "").strip()
        if not decision:
            return [f"- decision: {reason}"] if reason else []
        if reason:
            return [f"- decision: {decision} — {reason}"]
        return [f"- decision: {decision}"]
    if etype == "issue":
        note = str(event.get("note") or "").strip()
        message = str(event.get("message") or "").strip() or note
        symbol = severity_symbol(event.get("severity"), message)
        if not symbol:
            return [f"- issue: {note}"] if note else []
        code = event.get("code")
        prefix = f"[{code}] " if code else ""
        return [f"- issue: {prefix}{symbol}"]
    if etype == "issue.resolve":
        issue_id = str(event.get("issue_id") or "").strip()
        reason = str(event.get("reason") or event.get("note") or "").strip()
        suffix = f" — {reason}" if reason else ""
        return [f"- issue.resolve: {issue_id}{suffix}"] if issue_id else []
    if etype == "correction":
        target = str(event.get("target_event_id") or "").strip()
        field = str(event.get("target_field") or "").strip()
        reason = str(event.get("reason") or event.get("note") or "").strip()
        suffix = f" — {reason}" if reason else ""
        label = f"{target}.{field}".strip(".")
        return [f"- correction: {label}{suffix}"] if label else []
    if etype == "artifact":
        path = str(event.get("path") or "").strip()
        note = str(event.get("note") or "").strip()
        kind = event.get("kind")
        if not path:
            return [f"- artifact: {note}"] if note else []
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

    projected_domain_events = iter(apply_event_corrections(events))
    projected_events = [
        copy.deepcopy(event)
        if event.get("type") == "correction"
        else next(projected_domain_events)
        for event in events
    ]
    for phase, phase_events in group_events_by_phase(projected_events):
        attempts = split_phase_attempts(phase_events)
        for attempt_record in attempts:
            attempt_events = attempt_record["events"]
            start = phase_start_time(attempt_events) or "—"
            duration = phase_duration_ms(attempt_events)
            label = f"{phase}（尝试 {attempt_record['attempt']}）" if len(attempts) > 1 else phase
            lines.append(f"## {label} — {start}")
            lines.append("")
            if duration is not None:
                lines.append(f"- 阶段耗时: {format_duration(duration)}")
            for warning in attempt_record["warnings"]:
                lines.append(f"- 生命周期警告: {warning}")
            buffer: list[dict[str, Any]] = []

            def flush_commands() -> None:
                nonlocal buffer
                if buffer:
                    lines.extend(render_command_block(buffer))
                    buffer = []

            for event in attempt_events:
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


def execution_log_render_enabled(change_dir: Path) -> bool:
    """P1 slim-files: execution-log.md auto-render policy.

    `.harness/config/render-policy.json` with ``{"executionLog": "on-demand"}``
    disables the automatic render on ``phase.end``/auto-seal; the explicit
    ``harness_events.py render`` subcommand rebuilds the projection at any
    time. Default stays "auto" (render on phase.end).
    """
    current = change_dir.resolve()
    for candidate in [current, *current.parents]:
        if candidate.name == ".harness":
            config = candidate / "config" / "render-policy.json"
        else:
            config = candidate / ".harness" / "config" / "render-policy.json"
        if not config.is_file():
            continue
        try:
            document = json.loads(config.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            return True
        if isinstance(document, dict):
            mode = str(document.get("executionLog") or "").strip().lower()
            if mode == "on-demand":
                return False
        return True
    return True


def build_summary(change_dir: Path, events: list[dict[str, Any]]) -> dict[str, Any]:
    phases: dict[str, Any] = {}
    issues: list[dict[str, Any]] = []
    projected_events = apply_event_corrections(events)

    for phase, phase_events in group_events_by_phase(projected_events):
        attempt_records: list[dict[str, Any]] = []
        for record in split_phase_attempts(phase_events):
            attempt_events = record["events"]
            starts = [e for e in attempt_events if e.get("type") == "phase.start"]
            ends = [e for e in attempt_events if e.get("type") == "phase.end"]
            start_ts = starts[0].get("timestamp") if starts else None
            end_ts = ends[-1].get("timestamp") if ends else None
            provenance = starts[0] if starts else (attempt_events[0] if attempt_events else {})
            attempt_records.append({
                "attempt": record["attempt"],
                "event_count": len(attempt_events),
                "started_at": start_ts,
                "ended_at": end_ts,
                "duration_ms": phase_duration_ms(attempt_events),
                "status": ends[-1].get("status") if ends else None,
                "run_id": provenance.get("run_id"),
                "executor_tool": provenance.get("executor_tool"),
                "executor_agent": provenance.get("executor_agent"),
                "handoff_from_tool": provenance.get("handoff_from_tool"),
                "warnings": record["warnings"],
            })
        durations = [a["duration_ms"] for a in attempt_records if a["duration_ms"] is not None]
        first = attempt_records[0] if attempt_records else {}
        last = attempt_records[-1] if attempt_records else {}
        phases[phase] = {
            "event_count": len(phase_events),
            "started_at": first.get("started_at"),
            "ended_at": last.get("ended_at"),
            "duration_ms": sum(durations) if durations else None,
            "status": last.get("status"),
            "attempts": attempt_records,
        }

    for event in projected_events:
        if event.get("type") != "issue":
            continue
        issues.append(
            {
                "id": event.get("id"),
                "issue_id": _issue_identity(event),
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
        "current_issues": [
            {
                "id": event.get("id"),
                "issue_id": _issue_identity(event),
                "timestamp": event.get("timestamp"),
                "phase": event.get("phase"),
                "code": event.get("code"),
                "severity": event.get("severity"),
                "message": event.get("message"),
            }
            for event in current_issues(events)
        ],
    }


def phase_end_already_recorded(
    events: list[dict[str, Any]], candidate: dict[str, Any]
) -> bool:
    """Return whether the candidate attempt already has a terminal event.

    ``phase.auto_sealed`` counts as a terminal here too (HH-WF-20260730-001):
    a stale ``phase.end`` for an attempt that was already auto-sealed (e.g.
    superseded by a later ``phase.start``) must not close it a second time.
    """
    phase_events = [
        event for event in events if event.get("phase") == candidate.get("phase")
    ]
    candidate_attempt = candidate.get("attempt")
    if isinstance(candidate_attempt, int):
        return any(
            event.get("type") in TERMINAL_PHASE_EVENT_TYPES
            and event.get("attempt") == candidate_attempt
            for event in phase_events
        )
    attempts = split_phase_attempts(phase_events)
    if not attempts:
        return False
    latest_events = attempts[-1].get("events") or []
    return any(event.get("type") in TERMINAL_PHASE_EVENT_TYPES for event in latest_events)


def infer_auto_seal_reason(attempt_events: list[dict[str, Any]]) -> str:
    """Best-effort ``phase.auto_sealed`` reason from an open attempt's own events.

    HH-WF-20260730-001: prefer an explicit wait signal recorded while the
    attempt was open, then an explicit recovery marker, else fall back to
    ``superseded`` (the default meaning: a new phase.start arrived).
    """
    for event in attempt_events:
        mapped = _WAIT_EVENT_REASON_MAP.get(str(event.get("type") or "").lower())
        if mapped:
            return mapped
    for event in attempt_events:
        if str(event.get("type") or "").lower() in _RECOVERY_EVENT_TYPES:
            return "executor_lost"
    return "superseded"


def open_attempts_for_phase(
    existing_events: list[dict[str, Any]], phase: str
) -> list[dict[str, Any]]:
    """Return ``split_phase_attempts`` records for ``phase`` that started but
    have no terminal (``phase.end``/``phase.auto_sealed``) event yet.
    """
    phase_events = [event for event in existing_events if event.get("phase") == phase]
    if not phase_events:
        return []
    open_attempts: list[dict[str, Any]] = []
    for attempt in split_phase_attempts(phase_events):
        events_in = attempt.get("events") or []
        if not events_in:
            continue
        if not any(event.get("type") == "phase.start" for event in events_in):
            # No actual start recorded (e.g. pure metadata bucket) — nothing
            # to auto-seal; sealing it would manufacture a phantom attempt.
            continue
        if any(
            event.get("type") in TERMINAL_PHASE_EVENT_TYPES for event in events_in
        ):
            # Prefer "any terminal" over "last event is terminal": late events
            # may be appended onto a closed attempt after phase.end/auto_sealed.
            continue
        open_attempts.append(attempt)
    return open_attempts


def seal_open_phase_attempts(
    existing_events: list[dict[str, Any]],
    *,
    phase: str,
    seal_reason: str | None = None,
    seal_ts: str | None = None,
) -> list[dict[str, Any]]:
    """Build ``phase.auto_sealed`` events for still-open attempts of ``phase``.

    HH-WF-20260730-001: write-path auto-seal. Returns the seal event dicts —
    callers append them (then the triggering event, e.g. the new
    ``phase.start``) under the same lock so the whole sequence is atomic from
    other processes' point of view.

    When ``seal_reason`` is omitted, each open attempt gets a best-effort
    inferred reason (wait / recovery / superseded).
    """
    open_attempts = open_attempts_for_phase(existing_events, phase)
    if not open_attempts:
        return []
    ts = seal_ts or now_iso()
    seal_events: list[dict[str, Any]] = []
    for attempt in open_attempts:
        events_in = attempt.get("events") or []
        provenance_source = events_in[0] if events_in else {}
        if seal_reason is None:
            reason = infer_auto_seal_reason(events_in)
        elif seal_reason in _AUTO_SEAL_REASONS:
            reason = seal_reason
        else:
            reason = "unknown"
        seal_event: dict[str, Any] = {
            "schema_version": SCHEMA_VERSION,
            "id": new_event_id(),
            "timestamp": ts,
            "phase": phase,
            "type": "phase.auto_sealed",
            "status": "RECOVERED",
            "reason": reason,
            "note": "",
            "attempt": attempt.get("attempt"),
        }
        for field in ("run_id", "executor_tool", "executor_agent", "executor_model"):
            value = provenance_source.get(field)
            if value is not None:
                seal_event[field] = value
        seal_events.append(seal_event)
    return seal_events


def append_with_auto_seal(
    events_file: Path,
    event: dict[str, Any],
    *,
    existing_events: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Append ``event`` under lock; auto-seal open attempts when type is phase.start.

    Returns ``{ok, event, autoSealed, phaseAlreadyClosed, events_path}``.
    Caller must NOT hold the events lock — this function acquires it.
    """
    lock_path = events_file.with_name(events_file.name + ".lock")
    event_type = str(event.get("type") or "")
    phase = str(event.get("phase") or "")
    auto_sealed: list[dict[str, Any]] = []
    phase_already_closed = False
    with event_file_lock(lock_path):
        loaded = (
            existing_events
            if existing_events is not None
            else (
                load_events(events_file)
                if event_type in {"phase.start", "phase.end", "correction"}
                else []
            )
        )
        if event_type in {"phase.start", "phase.end", "phase.auto_sealed"} and phase:
            phase_attempts = split_phase_attempts(
                [item for item in loaded if item.get("phase") == phase]
            )
            latest_attempt = max(
                (
                    int(item.get("attempt"))
                    for item in phase_attempts
                    if isinstance(item.get("attempt"), int)
                ),
                default=0,
            )
            if not isinstance(event.get("attempt"), int) or int(event["attempt"]) <= 0:
                event["attempt"] = (
                    latest_attempt + 1 if event_type == "phase.start" else latest_attempt or 1
                )
        if event_type == "phase.start" and phase:
            auto_sealed = seal_open_phase_attempts(loaded, phase=phase)
            for seal_event in auto_sealed:
                atomic_append_line(
                    events_file,
                    json.dumps(seal_event, ensure_ascii=False, separators=(",", ":")),
                )
        if event_type == "phase.end":
            phase_already_closed = phase_end_already_recorded(loaded, event)
        if not phase_already_closed:
            atomic_append_line(
                events_file,
                json.dumps(event, ensure_ascii=False, separators=(",", ":")),
            )
    return {
        "ok": not phase_already_closed,
        "event": event,
        "autoSealed": auto_sealed,
        "phaseAlreadyClosed": phase_already_closed,
        "events_path": str(events_file),
    }


def cmd_append(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    if args.type not in EVENT_TYPES:
        return emit_error(
            f"unsupported type: {args.type}; expected one of {sorted(EVENT_TYPES)}",
            as_json=as_json,
        )
    legacy_lenient = bool(getattr(args, "legacy_lenient", False))
    validation = validate_append_event(args)
    if validation:
        error_code, message = validation
        legacy_compatible = legacy_lenient and args.type in {"issue", "verification"}
        if not legacy_compatible:
            return emit_error(message, as_json=as_json, error_code=error_code)
    change_dir = resolve_change_dir(args.change_dir)
    archived = archived_change_dir(change_dir)
    if archived is not None:
        return emit_error(
            "ARCHIVED_CHANGE_IMMUTABLE: refusing to append to archived change "
            f"{change_dir.name} ({archived})",
            as_json=as_json,
        )
    path = events_path(change_dir)
    lock_path = path.with_name(path.name + ".lock")

    # §6.1/§6.2: 普通 append = 加锁 -> 追加一行 -> fsync -> 解锁，不 load 历史、不渲染。
    # new_event_id 用完整 uuid，无需扫描去重。锁覆盖 atomic_append_line 的
    # open/write/flush/fsync 全过程。
    event = build_event(args, [])
    # Explicit compatibility mode preserves old append behavior and marks the
    # resulting event so strict consumers can distinguish it from valid v3.
    if validation:
        event["schemaValidation"] = "legacy"
    if legacy_lenient and args.type == "issue" and not args.severity:
        event["severity"] = "info"
        print(
            "warning: issue without --severity, defaulted to info",
            file=sys.stderr,
        )
    if legacy_lenient and args.type == "verification" and (not args.name or not args.status):
        print(
            "warning: verification missing --name or --status",
            file=sys.stderr,
        )
    phase_closed = False
    projection_error: str | None = None
    attempt_error: str | None = None
    auto_sealed_events: list[dict[str, Any]] = []
    try:
        with event_file_lock(lock_path):
            existing_events = (
                load_events(path)
                if args.type in {"phase.end", "correction", "phase.start"}
                or event.get("run_id") is not None
                or event.get("attempt") is not None
                else []
            )
            run_id = event.get("run_id")
            if run_id is not None:
                run_attempts = {
                    int(item["attempt"])
                    for item in existing_events
                    if item.get("phase") == event.get("phase")
                    and item.get("run_id") == run_id
                    and isinstance(item.get("attempt"), int)
                    and int(item["attempt"]) > 0
                }
                if run_attempts:
                    expected_attempt = max(run_attempts)
                    explicit_attempt = event.get("attempt")
                    if (
                        isinstance(explicit_attempt, int)
                        and explicit_attempt != expected_attempt
                    ):
                        attempt_error = (
                            "EVENT_ATTEMPT_CONFLICT: run_id is already bound to "
                            f"attempt {expected_attempt}, received {explicit_attempt}"
                        )
                    else:
                        event["attempt"] = expected_attempt
            if attempt_error is not None:
                pass
            elif args.type == "phase.end":
                phase_closed = phase_end_already_recorded(existing_events, event)
            elif args.type == "correction":
                try:
                    apply_event_corrections([*existing_events, event])
                except ValueError as exc:
                    projection_error = str(exc)
            elif args.type == "phase.start":
                # HH-WF-20260730-001: a new phase.start must not be appended
                # while a prior attempt for the same phase is still open —
                # auto-seal it first so timing never has two open attempts.
                open_attempts = open_attempts_for_phase(existing_events, args.phase)
                if open_attempts:
                    inferred_reason = infer_auto_seal_reason(
                        open_attempts[-1].get("events") or []
                    )
                    auto_sealed_events = seal_open_phase_attempts(
                        existing_events,
                        phase=args.phase,
                        seal_reason=inferred_reason,
                    )
            if not phase_closed and projection_error is None and attempt_error is None:
                for seal_event in auto_sealed_events:
                    atomic_append_line(
                        path,
                        json.dumps(seal_event, ensure_ascii=False, separators=(",", ":")),
                    )
                atomic_append_line(
                    path,
                    json.dumps(event, ensure_ascii=False, separators=(",", ":")),
                )
    except (OSError, TimeoutError, ValueError) as exc:
        return emit_error(f"append failed: {exc}", as_json=as_json)
    if phase_closed:
        return emit_error(
            "PHASE_ALREADY_CLOSED: refusing a second phase.end for the same attempt",
            as_json=as_json,
            error_code="PHASE_ALREADY_CLOSED",
        )
    if projection_error is not None:
        error_code = projection_error.split(":", 1)[0]
        return emit_error(
            projection_error,
            as_json=as_json,
            error_code=error_code,
        )
    if attempt_error is not None:
        return emit_error(
            attempt_error,
            as_json=as_json,
            error_code="EVENT_ATTEMPT_CONFLICT",
        )

    _nudge_remote_sync(change_dir)

    # §6.1: phase.end append（或写路径产生了 auto-seal）-> 追加成功后执行一次
    # render（从完整 events 重建 log）。普通 command/issue 等 append 不渲染
    # （O(1)）；显式 `render` 子命令随时重建。
    rendered = False
    log_path = None
    log_lines = None
    if (args.type == "phase.end" or auto_sealed_events) and \
            execution_log_render_enabled(change_dir):
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
    if args.type == "phase.start":
        payload["autoSealed"] = auto_sealed_events
    if log_path is not None:
        payload["execution_log_path"] = str(log_path)
        payload["execution_log_lines"] = log_lines
    emit_json(payload, as_json=as_json)
    return 0


def cmd_batch_append(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    change_dir = resolve_change_dir(args.change_dir)
    batch_path = Path(str(args.file)).expanduser()
    try:
        raw = json.loads(batch_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        return emit_error(f"batch-append failed to read --file: {exc}", as_json=as_json)
    result = batch_append_events(change_dir, raw if isinstance(raw, list) else [])
    if not result.get("ok"):
        return emit_error(
            str(result.get("message") or "batch-append failed"),
            as_json=as_json,
            error_code=str(result.get("code") or "BATCH_APPEND_FAILED"),
        )
    emit_json(result, as_json=as_json)
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
    p_append.add_argument("--issue-id", default=None)
    p_append.add_argument("--scope", default=None)
    p_append.add_argument("--target-event-id", default=None)
    p_append.add_argument("--target-field", default=None)
    p_append.add_argument("--old-value-hash", default=None)
    p_append.add_argument("--new-value-json", default=None)
    p_append.add_argument("--run-id", default=None)
    p_append.add_argument("--attempt", type=int, default=None)
    p_append.add_argument("--executor-tool", default=None)
    p_append.add_argument("--executor-agent", default=None)
    p_append.add_argument("--executor-model", default=None)
    p_append.add_argument("--handoff-from-tool", default=None)
    p_append.add_argument("--handoff-reason", default=None)
    p_append.add_argument("--trace-id", default=None)
    p_append.add_argument("--span-id", default=None)
    p_append.add_argument("--parent-span-id", default=None)
    p_append.add_argument("--runner-ms", type=int, default=None)
    p_append.add_argument("--orchestration-active-ms", type=int, default=None)
    p_append.add_argument("--wall-clock-ms", type=int, default=None)
    p_append.add_argument("--user-wait-ms", type=int, default=None)
    p_append.add_argument("--execution-mode", default=None)
    p_append.add_argument("--decision-reason-code", default=None)
    p_append.add_argument("--fallback-reason-code", default=None)
    p_append.add_argument("--trigger", default=None)
    p_append.add_argument("--from-phase", default=None)
    p_append.add_argument("--result-status", default=None)
    p_append.add_argument(
        "--legacy-lenient",
        action="store_true",
        help="accept legacy incomplete/type-mismatched events and mark them explicitly",
    )
    p_append.set_defaults(func=cmd_append)

    p_batch = sub.add_parser(
        "batch-append",
        parents=[common],
        help="validate and append many events under one lock (H-15)",
    )
    p_batch.add_argument("--change-dir", required=True)
    p_batch.add_argument(
        "--file",
        required=True,
        help="JSON file containing a non-empty array of event objects",
    )
    p_batch.set_defaults(func=cmd_batch_append)

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
