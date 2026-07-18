#!/usr/bin/env python3
"""Harness review findings / fixback dispositions sidecar.

Structured source of truth for review output; Markdown reports are a human
projection of these sidecars, never the counting source.

Files (under the change state root):
  reports/review/review-findings.json
  reports/review/fixback-dispositions.json

Python 3.10+, stdlib only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import uuid
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_paths  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

SEVERITIES = {"RED", "YELLOW", "OK"}
DISPOSITIONS = {"OPEN", "FIXED", "ACCEPTED_RISK", "DEFERRED", "UNKNOWN"}
FINDINGS_REL = Path("reports") / "review" / "review-findings.json"
DISPOSITIONS_REL = Path("reports") / "review" / "fixback-dispositions.json"
_REQUIRED_FINDING_FIELDS = ("dimension", "severity", "path", "line", "title")


def _write_json_atomic(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_text(text, encoding="utf-8", newline="\n")
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _state_dir(change_dir: Path) -> Path:
    return Path(harness_paths.resolve_state_dir_for_contract(change_dir))


def findings_path(change_dir: Path) -> Path:
    return _state_dir(change_dir) / FINDINGS_REL


def dispositions_path(change_dir: Path) -> Path:
    return _state_dir(change_dir) / DISPOSITIONS_REL


def _normalize_title(title: str) -> str:
    return re.sub(r"\s+", " ", title.strip().lower())


def stable_finding_id(
    run_id: str, dimension: str, path: str, line: int, title: str
) -> str:
    """Stable finding identity (run + dimension + canonical path + line + title)."""
    canonical_path = str(path).replace("\\", "/").strip("/").lower()
    basis = (
        f"{run_id}|{dimension.strip().lower()}|{canonical_path}|{int(line)}|"
        f"{_normalize_title(title)}"
    )
    return "f-" + hashlib.sha256(basis.encode("utf-8")).hexdigest()[:16]


def validate_findings(doc: Any) -> list[str]:
    problems: list[str] = []
    if not isinstance(doc, dict):
        return ["findings document must be an object"]
    if not isinstance(doc.get("runId"), str) or not doc["runId"].strip():
        problems.append("runId is required")
    findings = doc.get("findings")
    if not isinstance(findings, list):
        problems.append("findings must be a list")
        return problems
    for index, finding in enumerate(findings):
        if not isinstance(finding, dict):
            problems.append(f"findings[{index}] must be an object")
            continue
        for field in _REQUIRED_FINDING_FIELDS:
            if field not in finding:
                problems.append(f"findings[{index}].{field} is required")
        severity = finding.get("severity")
        if severity is not None and severity not in SEVERITIES:
            problems.append(
                f"findings[{index}].severity must be one of {sorted(SEVERITIES)}"
            )
        line = finding.get("line")
        if line is not None and (not isinstance(line, int) or line < 0):
            problems.append(f"findings[{index}].line must be a non-negative int")
    return problems


def write_findings(change_dir: Path, doc: dict[str, Any]) -> dict[str, Any]:
    problems = validate_findings(doc)
    if problems:
        return {"ok": False, "code": "FINDINGS_INVALID", "problems": problems}
    run_id = doc["runId"]
    assigned: list[dict[str, Any]] = []
    seen: set[str] = set()
    for finding in doc["findings"]:
        fid = stable_finding_id(
            run_id,
            finding["dimension"],
            finding["path"],
            finding["line"],
            finding["title"],
        )
        suffix = 2
        unique = fid
        while unique in seen:
            unique = f"{fid}-{suffix}"
            suffix += 1
        seen.add(unique)
        entry = dict(finding)
        entry["id"] = unique
        assigned.append(entry)
    payload = {
        "schemaVersion": 1,
        "runId": run_id,
        "changeName": doc.get("changeName") or Path(change_dir).name,
        "findings": assigned,
    }
    out = findings_path(change_dir)
    _write_json_atomic(out, payload)
    return {"ok": True, "code": "FINDINGS_WRITTEN", "path": str(out),
            "count": len(assigned)}


def _load_findings(change_dir: Path) -> dict[str, Any] | None:
    path = findings_path(change_dir)
    if not path.is_file():
        return None
    try:
        data = _read_json(path)
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def validate_dispositions(
    doc: Any, known_ids: set[str]
) -> list[str]:
    problems: list[str] = []
    if not isinstance(doc, dict):
        return ["dispositions document must be an object"]
    dispositions = doc.get("dispositions")
    if not isinstance(dispositions, list):
        return ["dispositions must be a list"]
    for index, item in enumerate(dispositions):
        if not isinstance(item, dict):
            problems.append(f"dispositions[{index}] must be an object")
            continue
        fid = item.get("findingId")
        if not isinstance(fid, str) or not fid.strip():
            problems.append(f"dispositions[{index}].findingId is required")
        elif fid not in known_ids:
            problems.append(f"dispositions[{index}].findingId unknown: {fid}")
        value = item.get("disposition")
        if value not in DISPOSITIONS:
            problems.append(
                f"dispositions[{index}].disposition must be one of "
                f"{sorted(DISPOSITIONS)}"
            )
    return problems


def write_dispositions(change_dir: Path, doc: dict[str, Any]) -> dict[str, Any]:
    findings_doc = _load_findings(change_dir)
    known_ids = {
        f.get("id") for f in (findings_doc or {}).get("findings", [])
        if isinstance(f, dict)
    }
    problems = validate_dispositions(doc, known_ids)
    if problems:
        return {"ok": False, "code": "DISPOSITIONS_INVALID", "problems": problems}
    payload = {
        "schemaVersion": 1,
        "runId": doc.get("runId"),
        "dispositions": doc["dispositions"],
    }
    out = dispositions_path(change_dir)
    _write_json_atomic(out, payload)
    return {"ok": True, "code": "DISPOSITIONS_WRITTEN", "path": str(out)}


def status(change_dir: Path) -> dict[str, Any]:
    findings_doc = _load_findings(change_dir)
    if findings_doc is None:
        return {
            "ok": True,
            "code": "NO_FINDINGS",
            "counts": {"RED": 0, "YELLOW": 0, "OK": 0},
            "dispositions": {},
            "items": [],
        }
    dispositions_doc: dict[str, Any] = {}
    dpath = dispositions_path(change_dir)
    if dpath.is_file():
        try:
            loaded = _read_json(dpath)
            if isinstance(loaded, dict):
                dispositions_doc = loaded
        except (OSError, json.JSONDecodeError):
            dispositions_doc = {}
    by_id = {
        item.get("findingId"): item
        for item in dispositions_doc.get("dispositions", [])
        if isinstance(item, dict)
    }
    counts = {"RED": 0, "YELLOW": 0, "OK": 0}
    disposition_counts: dict[str, int] = {}
    items: list[dict[str, Any]] = []
    for finding in findings_doc.get("findings", []):
        severity = finding.get("severity")
        if severity in counts:
            counts[severity] += 1
        entry = by_id.get(finding.get("id"))
        disposition = entry.get("disposition") if entry else None
        if disposition not in DISPOSITIONS:
            disposition = "UNKNOWN"
        disposition_counts[disposition] = disposition_counts.get(disposition, 0) + 1
        items.append(
            {
                "id": finding.get("id"),
                "severity": severity,
                "path": finding.get("path"),
                "line": finding.get("line"),
                "title": finding.get("title"),
                "disposition": disposition,
            }
        )
    return {
        "ok": True,
        "code": "STATUS",
        "runId": findings_doc.get("runId"),
        "counts": counts,
        "dispositions": disposition_counts,
        "items": items,
    }


# ------------------------------------------------------------------- CLI


def _emit(payload: Any, *, as_json: bool) -> int:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    return 0 if payload.get("ok") else 1


def cmd_validate_findings(args: argparse.Namespace) -> int:
    doc = _read_json(Path(args.input))
    problems = validate_findings(doc)
    payload = {"ok": not problems, "problems": problems}
    return _emit(payload, as_json=True)


def cmd_write_findings(args: argparse.Namespace) -> int:
    doc = _read_json(Path(args.input))
    return _emit(write_findings(Path(args.change_dir), doc), as_json=True)


def cmd_write_dispositions(args: argparse.Namespace) -> int:
    doc = _read_json(Path(args.input))
    return _emit(write_dispositions(Path(args.change_dir), doc), as_json=True)


def cmd_status(args: argparse.Namespace) -> int:
    return _emit(status(Path(args.change_dir)), as_json=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harness_review.py")
    sub = parser.add_subparsers(dest="command_name", required=True)

    p_validate = sub.add_parser("validate-findings")
    p_validate.add_argument("--input", required=True)
    p_validate.set_defaults(func=cmd_validate_findings)

    p_findings = sub.add_parser("write-findings")
    p_findings.add_argument("--change-dir", required=True)
    p_findings.add_argument("--input", required=True)
    p_findings.set_defaults(func=cmd_write_findings)

    p_dispositions = sub.add_parser("write-dispositions")
    p_dispositions.add_argument("--change-dir", required=True)
    p_dispositions.add_argument("--input", required=True)
    p_dispositions.set_defaults(func=cmd_write_dispositions)

    p_status = sub.add_parser("status")
    p_status.add_argument("--change-dir", required=True)
    p_status.set_defaults(func=cmd_status)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
