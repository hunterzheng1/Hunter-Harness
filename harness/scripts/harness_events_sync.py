#!/usr/bin/env python3
"""P4: sync local events.ndjson to the platform Run monitoring API.

Reads `.harness/credentials.local.yaml` + project_id, whitelists event fields,
POSTs batches with ACK cursor, and sends heartbeats. Offline-safe: cursor only
advances on accepted/duplicate_accepted responses.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

WHITELIST = {
    "id",
    "ts",
    "type",
    "phase",
    "status",
    "note",
    "attempt",
    "name",
    "code",
    "severity",
    "decision",
    "reason",
    "exit_code",
    "duration_ms",
    "schemaVersion",
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


def sanitize(event: dict[str, Any]) -> dict[str, Any]:
    return {key: event[key] for key in WHITELIST if key in event}


def cursor_path(change_dir: Path) -> Path:
    return change_dir / "meta" / "events-sync-cursor.json"


def load_cursor(change_dir: Path) -> int:
    path = cursor_path(change_dir)
    if not path.is_file():
        return 0
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 0
    return int(data.get("acked_lines") or 0)


def save_cursor(change_dir: Path, acked_lines: int) -> None:
    path = cursor_path(change_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"schemaVersion": 1, "acked_lines": acked_lines}, indent=2) + "\n",
        encoding="utf-8",
    )


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

    # Always heartbeat so the console can separate connection vs run status.
    try:
        from datetime import datetime, timezone

        client_time = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        post_json(
            endpoint,
            f"/api/v1/projects/{project_id}/runs/heartbeats",
            {
                "protocol_version": "hunter-progress-sync/v1",
                "run_id": rid,
                "change_key": resolved_key,
                "client_time": client_time,
                "title": resolved_key,
            },
        )
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        return {"ok": False, "error": f"heartbeat failed: {exc}", "run_id": rid}

    if heartbeat_only:
        return {"ok": True, "heartbeat": True, "run_id": rid, "change_key": resolved_key}

    events_file = change_dir / "events.ndjson"
    if not events_file.is_file():
        return {
            "ok": True,
            "run_id": rid,
            "change_key": resolved_key,
            "uploaded": 0,
            "reason": "no events.ndjson",
        }

    lines = events_file.read_text(encoding="utf-8").splitlines()
    acked = load_cursor(change_dir)
    pending_raw = lines[acked:]
    batch: list[dict[str, Any]] = []
    for offset, line in enumerate(pending_raw, start=1):
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        event_id = str(event.get("id") or f"{resolved_key}:{acked + offset}")
        payload = sanitize(event)
        batch.append(
            {
                "event_id": event_id,
                "producer_seq": acked + offset,
                "event_type": str(event.get("type") or "unknown"),
                "phase": event.get("phase"),
                "occurred_at": str(event.get("ts") or client_time),
                "payload": payload,
            }
        )
    if not batch:
        save_cursor(change_dir, len(lines))
        return {
            "ok": True,
            "run_id": rid,
            "change_key": resolved_key,
            "uploaded": 0,
            "acked_lines": len(lines),
        }

    # Drop None phase keys for strict schema.
    for item in batch:
        if item.get("phase") is None:
            item.pop("phase", None)

    try:
        result = post_json(
            endpoint,
            f"/api/v1/projects/{project_id}/runs/events:batch",
            {
                "protocol_version": "hunter-progress-sync/v1",
                "run_id": rid,
                "change_key": resolved_key,
                "title": resolved_key,
                "events": batch,
            },
        )
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        return {"ok": False, "error": f"batch HTTP {exc.code}: {detail}", "run_id": rid}
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as exc:
        return {"ok": False, "error": f"batch failed: {exc}", "run_id": rid}

    items = result.get("items") if isinstance(result, dict) else None
    accepted = 0
    if isinstance(items, list):
        for item in items:
            status = str((item or {}).get("status") or "")
            if status in {"accepted", "duplicate_accepted"}:
                accepted += 1
    # Advance cursor only when the whole batch was accepted/duplicated.
    if accepted == len(batch):
        save_cursor(change_dir, acked + len(pending_raw))
        acked_lines = acked + len(pending_raw)
    else:
        acked_lines = acked
    return {
        "ok": accepted == len(batch),
        "run_id": rid,
        "change_key": resolved_key,
        "uploaded": accepted,
        "batch_size": len(batch),
        "acked_lines": acked_lines,
        "server": result,
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Sync events.ndjson to platform Run monitoring")
    parser.add_argument("--project", default=".", help="Project root")
    parser.add_argument("--change-dir", help="Specific change directory")
    parser.add_argument("--run-id", help="Override stable run_id (archive finalize continuity)")
    parser.add_argument("--change-key", help="Override change_key sent to the platform")
    parser.add_argument("--heartbeat-only", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    project = Path(args.project).resolve()
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
