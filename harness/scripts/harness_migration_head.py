#!/usr/bin/env python3
"""Migration head single-source consistency check (Wave-2 H-7).

Canonical file (default ``.harness/config/migration-head.json``)::

    {
      "schemaVersion": 1,
      "head": "005_example",
      "sources": [
        {"path": "backend/app/config.py", "pattern": "EXPECTED_ALEMBIC_HEAD\\s*=\\s*[\\\"']([^\\\"']+)[\\\"']"},
        {"path": "integration/manifest.json", "jsonPointer": "/migrationHead"}
      ]
    }

Each source must resolve to the same ``head`` value. This harness repo may not
ship alembic; consumer projects declare the canonical file and run::

    python harness_migration_head.py check --project . --json
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

DEFAULT_REL = ".harness/config/migration-head.json"


def emit_json(payload: dict[str, Any], *, as_json: bool) -> None:
    if as_json:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    else:
        code = payload.get("code") or ("OK" if payload.get("ok") else "FAIL")
        sys.stdout.write(f"{code}\n")


def emit_error(code: str, message: str, *, as_json: bool, extra: dict[str, Any] | None = None) -> int:
    payload: dict[str, Any] = {"ok": False, "code": code, "message": message}
    if extra:
        payload.update(extra)
    stream = sys.stdout if as_json else sys.stderr
    if as_json:
        stream.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    else:
        stream.write(f"{code}: {message}\n")
    return 1


def _read_json_pointer(data: Any, pointer: str) -> Any:
    if not pointer.startswith("/"):
        raise ValueError(f"jsonPointer must start with /: {pointer}")
    cur = data
    for part in pointer.lstrip("/").split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            raise KeyError(pointer)
    return cur


def _extract_source(project: Path, source: dict[str, Any]) -> str:
    rel = str(source.get("path") or "").strip().replace("\\", "/")
    if not rel or rel.startswith("/") or ".." in rel.split("/"):
        raise ValueError(f"invalid source path: {rel}")
    target = (project / rel).resolve()
    try:
        target.relative_to(project.resolve())
    except ValueError as exc:
        raise ValueError(f"source escapes project: {rel}") from exc
    if not target.is_file():
        raise FileNotFoundError(rel)
    text = target.read_text(encoding="utf-8-sig")
    if "jsonPointer" in source and source["jsonPointer"]:
        data = json.loads(text)
        value = _read_json_pointer(data, str(source["jsonPointer"]))
        if value is None or (isinstance(value, str) and not value.strip()):
            raise ValueError(f"empty value at {source['jsonPointer']} in {rel}")
        return str(value).strip()
    pattern = str(source.get("pattern") or "").strip()
    if not pattern:
        raise ValueError(f"source {rel} requires pattern or jsonPointer")
    match = re.search(pattern, text, flags=re.MULTILINE)
    if not match:
        raise ValueError(f"pattern did not match in {rel}")
    return str(match.group(1) if match.lastindex else match.group(0)).strip()


def check_migration_head(
    project: Path,
    *,
    config_rel: str = DEFAULT_REL,
) -> dict[str, Any]:
    project = project.resolve()
    config_path = (project / config_rel).resolve()
    try:
        config_path.relative_to(project)
    except ValueError:
        return {
            "ok": False,
            "code": "MIGRATION_HEAD_CONFIG_ESCAPE",
            "message": f"config path escapes project: {config_rel}",
        }
    if not config_path.is_file():
        return {
            "ok": False,
            "code": "MIGRATION_HEAD_MISSING",
            "message": f"canonical migration-head file missing: {config_rel}",
            "configPath": str(config_path),
        }
    try:
        data = json.loads(config_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        return {
            "ok": False,
            "code": "MIGRATION_HEAD_UNREADABLE",
            "message": str(exc),
            "configPath": str(config_path),
        }
    if not isinstance(data, dict) or data.get("schemaVersion") != 1:
        return {
            "ok": False,
            "code": "MIGRATION_HEAD_SCHEMA_INVALID",
            "message": "migration-head.json must be schemaVersion 1 object",
            "configPath": str(config_path),
        }
    head = str(data.get("head") or "").strip()
    sources = data.get("sources")
    if not head:
        return {
            "ok": False,
            "code": "MIGRATION_HEAD_EMPTY",
            "message": "head must be a non-empty string",
            "configPath": str(config_path),
        }
    if not isinstance(sources, list) or not sources:
        return {
            "ok": False,
            "code": "MIGRATION_HEAD_SOURCES_EMPTY",
            "message": "sources must be a non-empty array",
            "configPath": str(config_path),
        }

    observed: list[dict[str, Any]] = []
    drifts: list[dict[str, Any]] = []
    for index, source in enumerate(sources):
        if not isinstance(source, dict):
            return {
                "ok": False,
                "code": "MIGRATION_HEAD_SOURCE_INVALID",
                "message": f"sources[{index}] must be an object",
            }
        try:
            value = _extract_source(project, source)
        except (OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
            return {
                "ok": False,
                "code": "MIGRATION_HEAD_SOURCE_UNREADABLE",
                "message": str(exc),
                "index": index,
                "path": source.get("path"),
            }
        item = {"path": source.get("path"), "value": value}
        observed.append(item)
        if value != head:
            drifts.append({**item, "expected": head})

    if drifts:
        return {
            "ok": False,
            "code": "MIGRATION_HEAD_DRIFT",
            "message": "one or more sources disagree with canonical head",
            "head": head,
            "drifts": drifts,
            "observed": observed,
            "configPath": str(config_path),
        }
    return {
        "ok": True,
        "code": "MIGRATION_HEAD_OK",
        "head": head,
        "observed": observed,
        "configPath": str(config_path),
        "sourceCount": len(observed),
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harness_migration_head.py")
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser("check", help="verify sources match canonical head")
    check.add_argument("--project", required=True)
    check.add_argument("--config", default=DEFAULT_REL)
    check.add_argument("--json", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    as_json = bool(getattr(args, "json", False))
    if args.command == "check":
        result = check_migration_head(Path(args.project), config_rel=str(args.config))
        if not result.get("ok"):
            return emit_error(
                str(result.get("code") or "MIGRATION_HEAD_FAIL"),
                str(result.get("message") or "check failed"),
                as_json=as_json,
                extra={k: v for k, v in result.items() if k not in {"ok", "code", "message"}},
            )
        emit_json(result, as_json=as_json)
        return 0
    return emit_error("UNKNOWN_COMMAND", f"unknown command: {args.command}", as_json=as_json)


if __name__ == "__main__":
    raise SystemExit(main())
