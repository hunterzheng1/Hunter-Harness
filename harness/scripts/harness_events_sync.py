#!/usr/bin/env python3
"""P4: sync local events.ndjson to the platform Run monitoring API.

Reads `.harness/credentials.local.yaml` + project_id, whitelists event fields,
POSTs batches with ACK cursor, and sends heartbeats. Offline-safe: cursor only
advances on accepted/duplicate_accepted responses.
"""

from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_paths  # noqa: E402

WHITELIST = {
    "id",
    "timestamp",
    "schema_version",
    # Legacy aliases remain readable while new writers use the canonical names.
    "ts",
    "type",
    "phase",
    "status",
    "note",
    "message",
    "attempt",
    "name",
    "code",
    "severity",
    "decision",
    "reason",
    "exit_code",
    "duration_ms",
    "schemaVersion",
    "summary",
    "executor_tool",
    "executor_agent",
    "executor_model",
    "execution_mode",
    "decision_reason_code",
    "fallback_reason_code",
    "trigger",
    "from_phase",
    "result_status",
    "planned_phases",
    "skipped_phases",
    "next_phase",
    "phase_plan_source",
    "closure_disposition",
    "closure_reason",
}

MAX_BATCH_SIZE = 100
ACCEPTED_STATUSES = {"accepted", "duplicate_accepted"}
QUARANTINE_STATUSES = {"id_conflict", "rejected", "rejected_schema"}
DISPLAY_TITLE_MAX_LENGTH = 200
EVENT_SUMMARY_MAX_LENGTH = 500

PHASE_LABELS = {
    "plan": "计划",
    "run": "编码",
    "test": "测试",
    "review": "评审",
    "package": "打包",
    "apidoc": "接口文档",
    "submit": "提交",
    "archive": "归档",
}

REVIEW_REASON_SUMMARIES = {
    "REVIEW_DELEGATED": "已使用独立评审，主会话负责核验结果。",
    "REVIEW_INLINE_UNAVAILABLE": "当前环境没有可用的隔离评审能力，已由主会话完成评审。",
    "REVIEW_INLINE_SPAWN_FAILED": "独立评审启动失败，已由主会话完成评审。",
    "REVIEW_INLINE_INVALID_RESULT": "独立评审未返回有效结果，已由主会话重新完成评审。",
    "INLINE_BY_ADAPTER": "当前适配器未提供隔离评审，已由主会话完成评审。",
}


def _yaml_scalar(text: str, key: str) -> str | None:
    match = re.search(rf"(?m)^[ \t]*{re.escape(key)}:\s*['\"]?([^'\"\n#]+)", text)
    if match is None:
        return None
    value = match.group(1).strip()
    return value or None


def load_endpoint(project: Path) -> dict[str, str] | None:
    creds = project / ".harness" / "credentials.local.yaml"
    if not creds.is_file():
        return None
    text = creds.read_text(encoding="utf-8", errors="ignore")
    server_url = _yaml_scalar(text, "server_url")
    token = _yaml_scalar(text, "token")
    project_id = _yaml_scalar(text, "project_id")
    if not project_id:
        py = project / ".harness" / "project.yaml"
        if py.is_file():
            project_id = _yaml_scalar(py.read_text(encoding="utf-8", errors="ignore"), "project_id")
    if not server_url or not token or not project_id:
        return None
    if project_id.lower() in {"null", "~", "none"}:
        return None
    return {
        "server_url": server_url.rstrip("/"),
        "token": token,
        "project_id": project_id,
    }


def _summary_text(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    text = re.sub(r"\s+", " ", value).strip()
    text = "".join(character for character in text if ord(character) >= 32 and ord(character) != 127)
    return text[:EVENT_SUMMARY_MAX_LENGTH].rstrip()


_MACHINE_DETAIL_RE = re.compile(
    r"(?:\s*[；;,，]?\s*)"
    r"(?:artifactsHash|artifactHash|receiptHash|content_sha256|contentSha256)"
    r"\s*[:=]\s*(?:sha256:)?[0-9a-f]{32,64}",
    re.IGNORECASE,
)


def _readable_summary_text(value: Any) -> str:
    text = _summary_text(value)
    if not text:
        return ""
    text = _MACHINE_DETAIL_RE.sub("", text)
    text = re.sub(
        r"\bfinalize\s+ok\b",
        "规划产物已校验并发布",
        text,
        flags=re.IGNORECASE,
    )
    text = re.sub(r"\s*([；;，,])\s*([；;，,])", r"\1", text)
    return _summary_text(text.strip(" ；;，,"))


def build_event_summary(event: dict[str, Any]) -> str:
    reason_code = _summary_text(
        event.get("fallback_reason_code") or event.get("decision_reason_code")
    )
    reason_summary = REVIEW_REASON_SUMMARIES.get(reason_code)
    explicit = _readable_summary_text(event.get("summary"))
    if reason_summary and (
        not explicit
        or explicit == reason_code
        or re.search(r"REVIEW_[A-Z0-9_]+|INLINE_BY_ADAPTER", explicit)
    ):
        return reason_summary
    if explicit and not re.search(
        r"\b[A-Z][A-Z0-9_]{3,}\b|\b[a-z][\w.-]+\s*=\s*(?:true|false)\b",
        explicit,
    ):
        return explicit

    event_type = _summary_text(event.get("type"))
    phase = _summary_text(event.get("phase"))
    phase_label = PHASE_LABELS.get(phase, phase or "当前")
    note = _readable_summary_text(event.get("note"))
    message = _readable_summary_text(event.get("message"))
    decision = _readable_summary_text(event.get("decision"))
    reason = _readable_summary_text(event.get("reason"))
    name = _readable_summary_text(event.get("name"))
    code = _readable_summary_text(event.get("code"))
    status = _summary_text(event.get("status"))

    if event_type == "decision" and decision:
        return _summary_text(f"{decision}；原因：{reason}" if reason else decision)
    if event_type == "issue":
        detail = message or note or code
        if detail and reason and reason != detail:
            return _summary_text(f"{detail}；原因：{reason}")
        return detail or "发现一项需要处理的问题。"
    if event_type == "issue.resolve":
        detail = message or note or code
        return _summary_text(f"问题已解决：{detail}" if detail else "已解决此前记录的问题。")
    if event_type == "phase.start":
        return _summary_text(
            f"开始执行{phase_label}阶段：{note}" if note else f"开始执行{phase_label}阶段。"
        )
    if event_type in {"phase.end", "phase.auto_sealed"}:
        detail = note or status
        return _summary_text(
            f"{phase_label}阶段已结束：{detail}" if detail else f"{phase_label}阶段已结束。"
        )
    if event_type == "gate.blocked":
        return note or message or "阶段门禁暂未通过，现场已保留，可按提示恢复。"
    if event_type == "gate.recovered":
        return note or message or "阶段门禁已恢复，流程可以继续。"
    if event_type == "command":
        detail = name or note
        return _summary_text(f"执行步骤：{detail}" if detail else "执行了一项工作步骤。")
    if event_type == "verification":
        detail = name or note or status
        return _summary_text(f"完成验证：{detail}" if detail else "完成了一项结果验证。")
    if event_type == "artifact":
        detail = name or note
        return _summary_text(f"生成或更新产物：{detail}" if detail else "生成或更新了一项交付内容。")
    if event_type == "correction":
        detail = note or reason or message
        return _summary_text(f"调整执行方式：{detail}" if detail else "根据当前结果调整了执行方式。")
    if event_type == "change.rename":
        return note or message or "更新了变更名称。"
    if event_type in {"recovery", "phase.recovery", "attempt.recovery"}:
        return note or reason or message or "恢复了中断的运行状态。"
    if event_type == "heartbeat":
        return "客户端保持在线，并同步了最新运行状态。"

    return note or message or name or reason or code or "记录了一项运行事件。"


def sanitize(event: dict[str, Any]) -> dict[str, Any]:
    payload = {key: event[key] for key in WHITELIST if key in event}
    payload["summary"] = build_event_summary(event)
    return payload


def _workflow_plan(change_dir: Path) -> dict[str, Any] | None:
    policy_path = change_dir / "meta" / "gate-policy.json"
    if not policy_path.is_file():
        return None
    try:
        policy = json.loads(policy_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(policy, dict):
        return None
    raw = policy.get("plannedPhases")
    source = "change"
    if not isinstance(raw, list) or not raw:
        raw = policy.get("defaultPhases")
        source = "policy-default"
    if not isinstance(raw, list):
        return None
    phases = [str(item).strip() for item in raw if str(item).strip()]
    if not phases:
        return None
    skipped = policy.get("skippedPhases")
    return {
        "planned_phases": list(dict.fromkeys(phases)),
        "skipped_phases": skipped if isinstance(skipped, list) else [],
        "phase_plan_source": source,
    }


def _event_payload(event: dict[str, Any], phase_plan: dict[str, Any] | None) -> dict[str, Any]:
    payload = sanitize(event)
    if phase_plan is None:
        return payload
    payload.update(phase_plan)
    if str(event.get("type") or "") in {"phase.end", "phase.auto_sealed"}:
        phase = str(event.get("phase") or "").strip()
        planned = phase_plan["planned_phases"]
        if phase in planned:
            index = planned.index(phase)
            payload["next_phase"] = planned[index + 1] if index + 1 < len(planned) else None
    return payload


def _valid_display_title(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    title = value.strip()
    if (
        not title
        or len(title) > DISPLAY_TITLE_MAX_LENGTH
        or any(ord(character) < 32 or ord(character) == 127 for character in title)
    ):
        return None
    return title


def _safe_file_within(change_dir: Path, path: Path) -> Path | None:
    try:
        root = change_dir.resolve()
        resolved = path.resolve()
    except OSError:
        return None
    if path.is_symlink() or not resolved.is_relative_to(root) or not resolved.is_file():
        return None
    return resolved


def load_display_title(change_dir: Path, change_key: str) -> str:
    metadata_path = _safe_file_within(
        change_dir, change_dir / "meta" / "change-title.json"
    )
    if metadata_path is not None:
        try:
            payload = json.loads(metadata_path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            payload = None
        if isinstance(payload, dict):
            title = _valid_display_title(payload.get("displayTitle"))
            if title is not None:
                return title

    # Legacy migration: older Plan runs already wrote a human title into the
    # approved design H1 but had no structured title metadata.
    design_path = _safe_file_within(
        change_dir, change_dir / "spec" / f"{change_key}-design.md"
    )
    if design_path is not None:
        try:
            with design_path.open("r", encoding="utf-8-sig") as stream:
                for _ in range(40):
                    line = stream.readline()
                    if not line:
                        break
                    if not line.startswith("# "):
                        continue
                    candidate = re.sub(
                        r"\s+(?:设计文档|设计方案|设计)$", "", line[2:].strip()
                    )
                    title = _valid_display_title(candidate)
                    if title is not None and title != change_key:
                        return title
                    break
        except OSError:
            pass
    return change_key


def cursor_path(change_dir: Path) -> Path:
    return _state_dir(change_dir) / "meta" / "events-sync-cursor.json"


def _state_dir(change_dir: Path) -> Path:
    return Path(harness_paths.resolve_state_dir_for_contract(change_dir))


def load_cursor(
    change_dir: Path,
    *,
    maximum_lines: int | None = None,
    repair: bool = False,
) -> int:
    path = cursor_path(change_dir)
    if not path.is_file():
        return 0
    valid = True
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        data = None
        valid = False
    raw = data.get("acked_lines") if isinstance(data, dict) else None
    if isinstance(raw, bool) or not isinstance(raw, int) or raw < 0:
        valid = False
        value = 0
    else:
        value = raw
    if maximum_lines is not None:
        if maximum_lines < 0:
            raise ValueError("maximum_lines must be non-negative")
        if value > maximum_lines:
            valid = False
            value = 0
    if not valid and repair:
        save_cursor(change_dir, 0)
    return value


def _fsync_parent(path: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(str(path.parent), os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def save_cursor(change_dir: Path, acked_lines: int) -> None:
    if isinstance(acked_lines, bool) or not isinstance(acked_lines, int) or acked_lines < 0:
        raise ValueError("acked_lines must be a non-negative integer")
    path = cursor_path(change_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    encoded = (
        json.dumps({"schemaVersion": 1, "acked_lines": acked_lines}, indent=2) + "\n"
    ).encode("utf-8")
    descriptor = os.open(
        str(temporary), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600
    )
    try:
        with os.fdopen(descriptor, "wb") as stream:
            descriptor = -1
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        _fsync_parent(path)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def quarantine_path(change_dir: Path) -> Path:
    return _state_dir(change_dir) / "meta" / "events-sync-quarantine.ndjson"


def append_quarantine(
    change_dir: Path,
    *,
    event_id: str,
    line_number: int,
    error_code: str,
    status: str,
) -> None:
    path = quarantine_path(change_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "schema_version": 1,
        "event_id": event_id,
        "line_number": line_number,
        "status": status,
        "error_code": error_code,
        "quarantined_at": datetime.now(timezone.utc).isoformat(),
    }
    with path.open("a", encoding="utf-8", newline="\n") as stream:
        stream.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def run_id_for(change_dir: Path) -> str:
    # Stable opaque id from absolute path — no hostname/username leakage.
    digest = hashlib.sha256(str(change_dir.resolve()).encode("utf-8")).hexdigest()[:24]
    return "run_" + digest


def post_json(endpoint: dict[str, str], path: str, body: dict[str, Any]) -> dict[str, Any]:
    url = endpoint["server_url"] + path
    data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {endpoint['token']}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def _event_lines_snapshot(events_file: Path) -> list[str]:
    """Read a complete-line snapshot under the writer's events.ndjson lock."""
    lock = _CrossProcessLock(events_file.with_name(events_file.name + ".lock"))
    lock.acquire(blocking=True)
    try:
        data = events_file.read_bytes()
    finally:
        lock.release()
    # A non-cooperating/external writer may still leave a partial tail. Never
    # quarantine or acknowledge that tail; the next nudge will retry it once a
    # terminating newline makes the physical record durable.
    if data and not data.endswith(b"\n"):
        last_newline = data.rfind(b"\n")
        data = b"" if last_newline < 0 else data[:last_newline + 1]
    return data.decode("utf-8-sig").splitlines()


def sync_change(
    project: Path,
    change_dir: Path,
    *,
    heartbeat_only: bool = False,
    run_id: str | None = None,
    change_key: str | None = None,
) -> dict[str, Any]:
    endpoint = load_endpoint(project)
    if endpoint is None:
        return {"ok": True, "skipped": True, "reason": "remote credentials not configured"}
    resolved_key = change_key or change_dir.name
    rid = run_id or run_id_for(change_dir)
    project_id = endpoint["project_id"]
    display_title = load_display_title(change_dir, resolved_key)

    # Always heartbeat so the console can separate connection vs run status.
    try:
        client_time = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        post_json(
            endpoint,
            f"/api/v1/projects/{project_id}/runs/heartbeats",
            {
                "protocol_version": "hunter-progress-sync/v1",
                "run_id": rid,
                "change_key": resolved_key,
                "client_time": client_time,
                "title": display_title,
            },
        )
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        return {"ok": False, "error": f"heartbeat failed: {exc}", "run_id": rid}

    if heartbeat_only:
        return {"ok": True, "heartbeat": True, "run_id": rid, "change_key": resolved_key}

    events_file = _state_dir(change_dir) / "events.ndjson"
    if not events_file.is_file():
        return {
            "ok": True,
            "run_id": rid,
            "change_key": resolved_key,
            "uploaded": 0,
            "reason": "no events.ndjson",
        }

    lines = _event_lines_snapshot(events_file)
    acked = load_cursor(
        change_dir,
        maximum_lines=len(lines),
        repair=True,
    )
    pending_raw = lines[acked:]
    phase_plan = _workflow_plan(change_dir)
    uploaded = 0
    quarantined = 0
    last_result: dict[str, Any] | None = None

    # Chunk physical lines, not only valid events, so a malformed line can never
    # strand all later valid events behind the durable cursor.
    for chunk_start in range(0, len(pending_raw), MAX_BATCH_SIZE):
        raw_chunk = pending_raw[chunk_start:chunk_start + MAX_BATCH_SIZE]
        batch: list[dict[str, Any]] = []
        line_by_event_id: dict[str, int] = {}
        local_invalid: list[tuple[str, int, str]] = []
        for offset, raw_line in enumerate(raw_chunk, start=1):
            line_number = acked + chunk_start + offset
            line = raw_line.strip()
            if not line:
                local_invalid.append((f"{resolved_key}:{line_number}", line_number, "EMPTY_LINE"))
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                local_invalid.append((f"{resolved_key}:{line_number}", line_number, "INVALID_JSON"))
                continue
            if not isinstance(event, dict):
                local_invalid.append((f"{resolved_key}:{line_number}", line_number, "INVALID_EVENT"))
                continue
            event_id = str(event.get("id") or f"{resolved_key}:{line_number}")
            item: dict[str, Any] = {
                "event_id": event_id,
                "producer_seq": line_number,
                "event_type": str(event.get("type") or "unknown"),
                "occurred_at": str(event.get("timestamp") or event.get("ts") or client_time),
                "payload": _event_payload(event, phase_plan),
            }
            if event.get("phase") is not None:
                item["phase"] = event.get("phase")
            batch.append(item)
            line_by_event_id[event_id] = line_number

        if batch:
            try:
                result = post_json(
                    endpoint,
                    f"/api/v1/projects/{project_id}/runs/events:batch",
                    {
                        "protocol_version": "hunter-progress-sync/v1",
                        "run_id": rid,
                        "change_key": resolved_key,
                        "title": display_title,
                        "events": batch,
                    },
                )
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")
                return {
                    "ok": False,
                    "error": f"batch HTTP {exc.code}: {detail}",
                    "run_id": rid,
                    "uploaded": uploaded,
                    "quarantined": quarantined,
                    "acked_lines": load_cursor(change_dir),
                }
            except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
                return {
                    "ok": False,
                    "error": f"batch failed: {exc}",
                    "run_id": rid,
                    "uploaded": uploaded,
                    "quarantined": quarantined,
                    "acked_lines": load_cursor(change_dir),
                }
            last_result = result
            items = result.get("items") if isinstance(result, dict) else None
            if not isinstance(items, list) or len(items) != len(batch):
                return {
                    "ok": False,
                    "error": "batch response did not acknowledge every event",
                    "run_id": rid,
                    "uploaded": uploaded,
                    "quarantined": quarantined,
                    "acked_lines": load_cursor(change_dir),
                }
            response_by_id = {
                str(item.get("id") or item.get("event_id") or ""): item
                for item in items if isinstance(item, dict)
            }
            for event in batch:
                event_id = str(event["event_id"])
                item = response_by_id.get(event_id)
                status = str((item or {}).get("status") or "")
                if status in ACCEPTED_STATUSES:
                    uploaded += 1
                    continue
                if status in QUARANTINE_STATUSES:
                    append_quarantine(
                        change_dir,
                        event_id=event_id,
                        line_number=line_by_event_id[event_id],
                        error_code=str((item or {}).get("error_code") or status.upper()),
                        status=status,
                    )
                    quarantined += 1
                    continue
                return {
                    "ok": False,
                    "error": f"event {event_id} was not durably acknowledged",
                    "run_id": rid,
                    "uploaded": uploaded,
                    "quarantined": quarantined,
                    "acked_lines": load_cursor(change_dir),
                    "server": result,
                }

        for event_id, line_number, error_code in local_invalid:
            append_quarantine(
                change_dir,
                event_id=event_id,
                line_number=line_number,
                error_code=error_code,
                status="local_invalid",
            )
            quarantined += 1
        save_cursor(change_dir, acked + chunk_start + len(raw_chunk))

    return {
        "ok": True,
        "run_id": rid,
        "change_key": resolved_key,
        "uploaded": uploaded,
        "quarantined": quarantined,
        "batch_size": min(MAX_BATCH_SIZE, len(pending_raw)),
        "acked_lines": len(lines),
        "server": last_result,
    }


def auto_events_sync(
    project_root: Path,
    change_dir: Path,
    *,
    heartbeat_only: bool = False,
    run_id: str | None = None,
    change_key: str | None = None,
) -> dict[str, Any]:
    """Best-effort platform events sync (same style as auto_push_archive_core).

    Failures become warnings so the caller never rolls back the main workflow.
    """
    project_root = project_root.resolve()
    change_dir = change_dir.resolve()
    if load_endpoint(project_root) is None:
        return {"skipped": True, "reason": "no remote credentials"}
    try:
        result = sync_change(
            project_root,
            change_dir,
            heartbeat_only=heartbeat_only,
            run_id=run_id,
            change_key=change_key,
        )
    except Exception as exc:  # noqa: BLE001 — best-effort never blocks caller
        return {
            "skipped": False,
            "ok": False,
            "warning": f"events-sync deferred: {exc}",
        }
    if result.get("skipped"):
        return {"skipped": True, "reason": result.get("reason") or "skipped"}
    if result.get("ok"):
        return {"skipped": False, "ok": True, **{
            key: result[key]
            for key in ("run_id", "change_key", "uploaded", "acked_lines", "heartbeat")
            if key in result
        }}
    return {
        "skipped": False,
        "ok": False,
        "warning": str(result.get("error") or "events-sync failed"),
        **{
            key: result[key]
            for key in ("run_id", "change_key")
            if key in result
        },
    }


def _nudge_path(project_root: Path) -> Path:
    return project_root / ".harness" / "state" / "local" / "events-sync" / "nudge.json"


def _agent_lock_path(project_root: Path) -> Path:
    return project_root / ".harness" / "state" / "local" / "events-sync" / "agent.lock"


def _agent_waiter_lock_path(project_root: Path) -> Path:
    return project_root / ".harness" / "state" / "local" / "events-sync" / "agent-waiter.lock"


class _CrossProcessLock:
    """Cross-platform advisory file lock held by an open descriptor.

    Lock files are deliberately persistent: ownership belongs to the kernel lock,
    not mtime or file existence, so a slow live worker can never be stolen.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self._stream: Any | None = None

    def acquire(self, *, blocking: bool) -> bool:
        if self._stream is not None:
            return True
        self.path.parent.mkdir(parents=True, exist_ok=True)
        stream = self.path.open("a+b", buffering=0)
        if stream.seek(0, os.SEEK_END) == 0:
            stream.write(b"\0")
            stream.flush()
            os.fsync(stream.fileno())
        while True:
            stream.seek(0)
            try:
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                self._stream = stream
                return True
            except OSError as exc:
                if exc.errno not in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                    stream.close()
                    raise
                if not blocking:
                    stream.close()
                    return False
                time.sleep(0.05)

    def release(self) -> None:
        stream = self._stream
        if stream is None:
            return
        try:
            stream.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        finally:
            stream.close()
            self._stream = None


def _windowless_python_executable(
    executable: str, base_executable: str | None
) -> str:
    """Return a Windows interpreter that cannot allocate a console window.

    Virtual-environment ``python.exe`` files may be forwarding launchers.  Even
    when the first process is created with ``CREATE_NO_WINDOW``, such a launcher
    can start the real console interpreter and make Windows Terminal flash.  A
    sibling ``pythonw.exe`` preserves the windowless subsystem across that hop.
    """
    executable_path = Path(executable)
    candidates = [executable_path.with_name("pythonw.exe")]
    if base_executable:
        base_path = Path(base_executable)
        base_windowless = base_path.with_name("pythonw.exe")
        if base_windowless not in candidates:
            candidates.append(base_windowless)
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    if base_executable and Path(base_executable).is_file():
        return str(Path(base_executable))
    return str(executable_path)


def schedule_events_sync(project_root: Path, change_dir: Path) -> bool:
    """Wake a finite, project-local sync worker after an event is durable.

    The wake-up record contains no credential or event payload. Multiple spawns are
    harmless: a project-local lock lets only one worker perform network requests.
    """
    project_root = project_root.resolve()
    change_dir = change_dir.resolve()
    if load_endpoint(project_root) is None:
        return False
    nudge = _nudge_path(project_root)
    nudge.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema_version": 1,
        "generation": uuid.uuid4().hex,
        "change": change_dir.name,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    temporary = nudge.with_name(f".{nudge.name}.{uuid.uuid4().hex}.tmp")
    temporary.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    os.replace(temporary, nudge)
    interpreter = sys.executable
    if os.name == "nt":
        interpreter = _windowless_python_executable(
            sys.executable,
            getattr(sys, "_base_executable", None),
        )
    command = [
        interpreter,
        str(Path(__file__).resolve()),
        "--project",
        str(project_root),
        "--agent",
        "--json",
    ]
    kwargs: dict[str, Any] = {
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "close_fds": True,
    }
    if os.name == "nt":
        kwargs["creationflags"] = (
            getattr(subprocess, "CREATE_NO_WINDOW", 0)
            | getattr(subprocess, "DETACHED_PROCESS", 0)
        )
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen(command, **kwargs)  # noqa: S603 — fixed local interpreter/script
    return True


def _read_nudge_generation(project_root: Path) -> str:
    try:
        value = json.loads(_nudge_path(project_root).read_text(encoding="utf-8"))
        return str(value.get("generation") or "") if isinstance(value, dict) else ""
    except (OSError, json.JSONDecodeError):
        return ""


def _discover_changes(project_root: Path) -> list[Path]:
    root = project_root / ".harness" / "changes"
    return sorted(path for path in root.glob("*") if path.is_dir()) if root.is_dir() else []


def _change_has_open_phase(change_dir: Path) -> bool:
    """Project the append-only stream into open/closed phase state."""
    try:
        path = Path(harness_paths.resolve_state_dir_for_contract(change_dir)) / "events.ndjson"
    except (OSError, ValueError):
        return False
    if not path.is_file():
        return False
    open_phases: dict[str, bool] = {}
    try:
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            if not line.strip():
                continue
            event = json.loads(line)
            if not isinstance(event, dict):
                continue
            phase = event.get("phase")
            event_type = event.get("type")
            if not isinstance(phase, str) or not phase:
                continue
            if event_type == "phase.start":
                open_phases[phase] = True
            elif event_type in {"phase.end", "phase.auto_sealed", "workflow.end", "run.end"}:
                open_phases[phase] = False
    except (OSError, json.JSONDecodeError):
        return False
    return any(open_phases.values())


def _project_has_open_phase(project_root: Path) -> bool:
    return any(_change_has_open_phase(path) for path in _discover_changes(project_root))


def _run_agent_session(project_root: Path) -> dict[str, Any]:
    attempts = 0
    uploaded = 0
    quarantined = 0
    while attempts < 6:
        generation = _read_nudge_generation(project_root)
        results = [sync_change(project_root, path) for path in _discover_changes(project_root)]
        uploaded += sum(int(item.get("uploaded") or 0) for item in results)
        quarantined += sum(int(item.get("quarantined") or 0) for item in results)
        if all(item.get("ok") for item in results):
            time.sleep(0.6)
            if generation == _read_nudge_generation(project_root):
                if not _project_has_open_phase(project_root):
                    return {
                        "ok": True,
                        "uploaded": uploaded,
                        "quarantined": quarantined,
                        "attempts": attempts + 1,
                    }
                # Keep a finite workflow lease alive while a phase is open.
                # A phase.end nudge is observed on the next pass and releases
                # the worker naturally; no terminal window is created.
                time.sleep(10.0)
                heartbeat_results = [
                    sync_change(project_root, path, heartbeat_only=True)
                    for path in _discover_changes(project_root)
                ]
                if all(item.get("ok") for item in heartbeat_results):
                    attempts = 0
                    continue
                results = heartbeat_results
            attempts = 0
            if generation != _read_nudge_generation(project_root):
                continue
        time.sleep(min(16.0, float(2 ** attempts)))
        attempts += 1
    return {
        "ok": False,
        "uploaded": uploaded,
        "quarantined": quarantined,
        "attempts": attempts,
        "error": "remote sync remains unavailable after bounded retries",
    }


def run_agent(project_root: Path) -> dict[str, Any]:
    """Run a bounded retry session with a lossless one-worker handoff."""
    primary = _CrossProcessLock(_agent_lock_path(project_root))
    waiter: _CrossProcessLock | None = None
    if not primary.acquire(blocking=False):
        # At most one follower waits at the release boundary. Any later nudge is
        # represented by the same atomic generation record and that follower sees it.
        waiter = _CrossProcessLock(_agent_waiter_lock_path(project_root))
        if not waiter.acquire(blocking=False):
            return {"ok": True, "already_running": True}
        try:
            primary.acquire(blocking=True)
        finally:
            waiter.release()
    try:
        return _run_agent_session(project_root)
    finally:
        primary.release()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Sync events.ndjson to platform Run monitoring")
    parser.add_argument("--project", default=".", help="Project root")
    parser.add_argument("--change-dir", help="Specific change directory")
    parser.add_argument("--run-id", help="Override stable run_id (archive finalize continuity)")
    parser.add_argument("--change-key", help="Override change_key sent to the platform")
    parser.add_argument("--heartbeat-only", action="store_true")
    parser.add_argument("--agent", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    project = Path(args.project).resolve()
    if args.agent:
        result = run_agent(project)
        payload = {
            "schema_version": 1,
            "ok": bool(result.get("ok")),
            "command": "events.sync.agent",
            "exit_code": 0 if result.get("ok") else 1,
            "result": result,
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return int(payload["exit_code"])
    if args.change_dir:
        changes = [Path(args.change_dir).resolve()]
    else:
        root = project / ".harness" / "changes"
        changes = sorted(path for path in root.glob("*") if path.is_dir()) if root.is_dir() else []
    results = [
        sync_change(
            project,
            change_dir,
            heartbeat_only=args.heartbeat_only,
            run_id=args.run_id,
            change_key=args.change_key,
        )
        for change_dir in changes
    ]
    ok = all(item.get("ok") for item in results) if results else True
    # P5 headless envelope — stable for orchestrators.
    payload = {
        "schema_version": 1,
        "ok": ok,
        "command": "events.sync",
        "change": None,
        "phase": None,
        "exit_code": 0 if ok else 1,
        "warnings": [],
        "errors": [] if ok else [{"message": "one or more change syncs failed"}],
        "result": {"results": results},
        # Backward-compatible aliases used by early callers / tests.
        "results": results,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
