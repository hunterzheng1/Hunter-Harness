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
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
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
FIXBACK_ACTIONS = {"code", "manual", "workflow"}
DISPOSITIONS = {
    "OPEN",
    "FIXED",
    "ACCEPTED_RISK",
    "DEFERRED",
    "NOT_APPLICABLE",
    "UNKNOWN",
}
CURRENT_RISK_DISPOSITIONS = {"OPEN", "ACCEPTED_RISK", "DEFERRED", "UNKNOWN"}
FINDINGS_REL = Path("reports") / "review" / "review-findings.json"
DISPOSITIONS_REL = Path("reports") / "review" / "fixback-dispositions.json"
_REQUIRED_FINDING_FIELDS = (
    "dimension",
    "severity",
    "path",
    "line",
    "title",
    "fixbackAction",
)


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


def validate_findings(doc: Any, *, require_ids: bool = False) -> list[str]:
    problems: list[str] = []
    if not isinstance(doc, dict):
        return ["findings document must be an object"]
    if not isinstance(doc.get("runId"), str) or not doc["runId"].strip():
        problems.append("runId is required")
    findings = doc.get("findings")
    if not isinstance(findings, list):
        problems.append("findings must be a list")
        return problems
    seen_ids: set[str] = set()
    for index, finding in enumerate(findings):
        if not isinstance(finding, dict):
            problems.append(f"findings[{index}] must be an object")
            continue
        if require_ids:
            finding_id = finding.get("id")
            if not isinstance(finding_id, str) or not finding_id.strip():
                problems.append(f"findings[{index}].id is required")
            elif finding_id in seen_ids:
                problems.append(f"findings[{index}].id must be unique")
            else:
                seen_ids.add(finding_id)
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
        action = finding.get("fixbackAction")
        if action is not None and action not in FIXBACK_ACTIONS:
            problems.append(
                f"findings[{index}].fixbackAction must be one of "
                f"{sorted(FIXBACK_ACTIONS)}"
            )
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
    doc: Any, known_ids: set[str], findings_run_id: str | None = None
) -> list[str]:
    """校验处置文档。``findings_run_id`` 给出时，还要求两份 sidecar 同属一轮。

    runId 以前完全不校验——``write_dispositions`` 直接透传 ``doc.get("runId")``，
    写 ``None`` 都能落盘，整条 sidecar 的强制力全压在 gate 关门时的一行断言上。
    而这条断言防的是 fixback 循环里的跨轮重放：sidecar 是 per-change 单文件、不带
    runId 后缀，第二轮 review 关门时磁盘上躺着第一轮那份（finding 全已 FIXED）。
    在写入端就挡住，比等到关门再拒绝早一整轮。
    """
    problems: list[str] = []
    if not isinstance(doc, dict):
        return ["dispositions document must be an object"]
    run_id = doc.get("runId")
    if not isinstance(run_id, str) or not run_id.strip():
        problems.append("runId is required")
    elif findings_run_id is not None and run_id != findings_run_id:
        problems.append(
            f"runId {run_id} does not match review findings runId {findings_run_id}"
        )
    dispositions = doc.get("dispositions")
    if not isinstance(dispositions, list):
        problems.append("dispositions must be a list")
        return problems
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
    findings_run_id = (findings_doc or {}).get("runId")
    problems = validate_dispositions(
        doc,
        known_ids,
        findings_run_id if isinstance(findings_run_id, str) else None,
    )
    if problems:
        return {"ok": False, "code": "DISPOSITIONS_INVALID", "problems": problems}
    payload = {
        "schemaVersion": 1,
        "runId": doc["runId"],
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
    current_risks = [
        item for item in items
        if item.get("severity") in {"RED", "YELLOW"}
        and item.get("disposition") in CURRENT_RISK_DISPOSITIONS
    ]
    return {
        "ok": True,
        "code": "STATUS",
        "runId": findings_doc.get("runId"),
        "counts": counts,
        "dispositions": disposition_counts,
        "items": items,
        "currentRiskCount": len(current_risks),
        "currentRisks": current_risks,
    }


# ------------------------------------------------------------------- CLI


def _emit(payload: Any, *, as_json: bool) -> int:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    return 0 if payload.get("ok") else 1


def dispatch_review(
    *,
    change_dir: Path,
    run_id: str,
    budget_seconds: int = 300,
) -> dict[str, Any]:
    """C11: dispatch a bounded review task.

    Returns reviewTaskId / deadline / heartbeatAt. The caller is expected to
    poll the review subagent and collect partial findings on timeout.
    """
    now = dt.datetime.now(dt.timezone.utc).astimezone()
    task_id = f"review-{uuid.uuid4().hex}"
    deadline = now + dt.timedelta(seconds=budget_seconds)
    # heartbeat at midpoint of the budget
    heartbeat = now + dt.timedelta(seconds=budget_seconds // 2)
    return {
        "ok": True,
        "code": "DISPATCHED",
        "reviewTaskId": task_id,
        "runId": run_id,
        "deadline": deadline.isoformat(timespec="milliseconds"),
        "heartbeatAt": heartbeat.isoformat(timespec="milliseconds"),
        "budgetSeconds": budget_seconds,
    }


def collect_partial_findings(
    *,
    change_dir: Path,
    run_id: str,
    completed_dimensions: list[str],
    pending_dimensions: list[str],
) -> dict[str, Any]:
    """C11: collect partial findings after timeout — completed dimensions only.

    Applies the degradation matrix to decide the fallback path.
    """
    matrix = degradation_matrix(
        subagent_timed_out=bool(pending_dimensions),
        main_session_available=True,
    )
    return {
        "ok": True,
        "code": "PARTIAL_FINDINGS",
        "runId": run_id,
        "completedDimensions": list(completed_dimensions),
        "pendingDimensions": list(pending_dimensions),
        "degradationMatrix": matrix,
    }


def degradation_matrix(
    *,
    subagent_timed_out: bool,
    main_session_available: bool,
) -> dict[str, Any]:
    """C11: degradation matrix — subagent timeout → main session; main fail → ADVISORY."""
    if not subagent_timed_out:
        return {"fallback": "none", "status": "OK"}
    if main_session_available:
        return {"fallback": "main-session", "status": "DEGRADED"}
    return {"fallback": "advisory", "status": "ADVISORY"}


def _canonical_root(value: str | Path) -> str:
    """Canonicalize a root for an identity comparison across Windows worktrees."""
    return os.path.normcase(str(Path(value).expanduser().resolve()))


def codegraph_worktree_id(execution_root: Path) -> str | None:
    """Return a stable id for a linked worktree, or ``None`` for the main checkout."""
    root = Path(execution_root).resolve()
    try:
        git_dir = subprocess.run(
            ["git", "rev-parse", "--git-dir"],
            cwd=str(root),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        common_dir = subprocess.run(
            ["git", "rev-parse", "--git-common-dir"],
            cwd=str(root),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except OSError:
        return None
    if git_dir.returncode != 0 or common_dir.returncode != 0:
        return None
    git_dir_path = Path(git_dir.stdout.strip())
    common_dir_path = Path(common_dir.stdout.strip())
    if not git_dir_path.is_absolute():
        git_dir_path = (root / git_dir_path).resolve()
    if not common_dir_path.is_absolute():
        common_dir_path = (root / common_dir_path).resolve()
    if _canonical_root(git_dir_path) == _canonical_root(common_dir_path):
        return None
    return "sha256:" + hashlib.sha256(
        _canonical_root(root).encode("utf-8")
    ).hexdigest()


def codegraph_expected_identity(
    execution_root: Path,
    *,
    expected_repository_id: str,
    expected_head: str,
) -> dict[str, str | None]:
    """Build the identity contract supplied with every CodeGraph query."""
    root = Path(execution_root).resolve()
    return {
        "rootPath": str(root),
        "worktreeId": codegraph_worktree_id(root),
        "repositoryId": expected_repository_id,
        "head": expected_head,
        "indexSnapshotAt": None,
    }


def validate_codegraph_identity(
    *,
    response: dict[str, Any],
    expected_repository_id: str,
    expected_head: str,
    expected_root: str | Path,
    expected_worktree_id: str | None,
) -> dict[str, Any]:
    """Validate CodeGraph evidence before Review adopts its source snippets.

    A repository id is shared by the main checkout and linked worktrees, so it
    cannot by itself prevent main-checkout evidence from being used for feature
    worktree review. Root and worktree identity are therefore mandatory.
    """
    repo_id = response.get("repositoryId")
    indexed_head = response.get("head", response.get("indexedHead"))
    indexed_at = response.get("indexSnapshotAt", response.get("indexedAt"))
    root_path = response.get("rootPath", response.get("indexedRoot"))
    worktree_id = response.get("worktreeId")
    expected_root_path = _canonical_root(expected_root)
    actual_root_path = (
        _canonical_root(root_path) if isinstance(root_path, str) and root_path.strip() else None
    )
    actual = {
        "rootPath": root_path,
        "worktreeId": worktree_id,
        "repositoryId": repo_id,
        "head": indexed_head,
        "indexSnapshotAt": indexed_at,
    }
    expected = {
        "rootPath": str(Path(expected_root).resolve()),
        "worktreeId": expected_worktree_id,
        "repositoryId": expected_repository_id,
        "head": expected_head,
        "indexSnapshotAt": None,
    }
    if (
        repo_id == expected_repository_id
        and indexed_head == expected_head
        and actual_root_path == expected_root_path
        and worktree_id == expected_worktree_id
        and indexed_at
    ):
        return {
            "ok": True,
            "code": "IDENTITY_OK",
            "evidence": actual,
        }
    return {
        "ok": False,
        "code": "IDENTITY_MISMATCH",
        "expected": expected,
        "actual": actual,
        "fallback": "grep-glob-read",
    }


def cmd_validate_findings(args: argparse.Namespace) -> int:
    doc = _read_json(Path(args.input))
    problems = validate_findings(doc)
    payload = {"ok": not problems, "problems": problems}
    return _emit(payload, as_json=True)


def cmd_validate_codegraph_identity(args: argparse.Namespace) -> int:
    response = _read_json(Path(args.input))
    if not isinstance(response, dict):
        raise ValueError("CodeGraph response must be an object")
    payload = validate_codegraph_identity(
        response=response,
        expected_repository_id=args.repository_id,
        expected_head=args.head,
        expected_root=args.execution_root,
        expected_worktree_id=args.worktree_id,
    )
    return _emit(payload, as_json=True)


def _input_document(args: argparse.Namespace) -> Any:
    """--input <file> 或 --stdin，二选一。

    为了把一段 JSON 交给命令而先在 runtime/ 落一个临时文件，既多一次往返，
    也给 runtime/ 又添一件没人清的草稿。
    """
    use_stdin = bool(getattr(args, "stdin", False))
    raw_input_path = getattr(args, "input", None)
    if use_stdin and raw_input_path:
        raise ValueError("--input 与 --stdin 只能二选一")
    if use_stdin:
        text = getattr(args, "_stdin_text", None)
        if text is None:
            text = sys.stdin.read()
        return json.loads(text)
    if not raw_input_path:
        raise ValueError("需要 --input <file> 或 --stdin")
    return _read_json(Path(raw_input_path))


def cmd_write_findings(args: argparse.Namespace) -> int:
    try:
        doc = _input_document(args)
    except (ValueError, json.JSONDecodeError) as exc:
        return _emit({"ok": False, "code": "FINDINGS_INPUT_INVALID", "error": str(exc)}, as_json=True)
    return _emit(write_findings(Path(args.change_dir), doc), as_json=True)


def cmd_write_dispositions(args: argparse.Namespace) -> int:
    try:
        doc = _input_document(args)
    except (ValueError, json.JSONDecodeError) as exc:
        return _emit(
            {"ok": False, "code": "DISPOSITIONS_INPUT_INVALID", "error": str(exc)},
            as_json=True,
        )
    return _emit(write_dispositions(Path(args.change_dir), doc), as_json=True)


def cmd_status(args: argparse.Namespace) -> int:
    return _emit(status(Path(args.change_dir)), as_json=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harness_review.py")
    sub = parser.add_subparsers(dest="command_name", required=True)

    p_validate = sub.add_parser("validate-findings")
    p_validate.add_argument("--input", required=True)
    p_validate.set_defaults(func=cmd_validate_findings)

    p_codegraph = sub.add_parser("validate-codegraph-identity")
    p_codegraph.add_argument("--input", required=True)
    p_codegraph.add_argument("--execution-root", required=True)
    p_codegraph.add_argument("--repository-id", required=True)
    p_codegraph.add_argument("--head", required=True)
    p_codegraph.add_argument("--worktree-id")
    p_codegraph.set_defaults(func=cmd_validate_codegraph_identity)

    p_findings = sub.add_parser("write-findings")
    p_findings.add_argument("--change-dir", required=True)
    p_findings.add_argument("--input", help="findings JSON 文件路径")
    p_findings.add_argument(
        "--stdin", action="store_true", help="从标准输入读 JSON，免落临时文件"
    )
    p_findings.set_defaults(func=cmd_write_findings)

    p_dispositions = sub.add_parser("write-dispositions")
    p_dispositions.add_argument("--change-dir", required=True)
    p_dispositions.add_argument("--input", help="dispositions JSON 文件路径")
    p_dispositions.add_argument(
        "--stdin", action="store_true", help="从标准输入读 JSON，免落临时文件"
    )
    p_dispositions.set_defaults(func=cmd_write_dispositions)

    p_status = sub.add_parser("status")
    p_status.add_argument("--change-dir", required=True)
    p_status.set_defaults(func=cmd_status)

    return parser


def main(argv: list[str] | None = None, *, stdin_text: str | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if stdin_text is not None:
        # 测试注入用；正式路径仍然读真正的 stdin。
        args._stdin_text = stdin_text
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
