#!/usr/bin/env python3
"""Harness archive finalize / status / replay (D3).

Subcommands:
  status   — pre-archive gate checks (read-only)
  finalize — single-process archive: manifest → move → collect → render →
             validate → after-manifest → delete-or-keep → knowledge/service
  replay   — read-only re-collect + validate for historical archives

Python 3.10+, stdlib only. UTF-8 without BOM. Windows path safe.
Depends on P0-1 harness_events.py; optionally P0-3 harness_knowledge.py.
"""

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
import uuid
from pathlib import Path
from typing import Any


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


SCRIPTS_DIR = Path(__file__).resolve().parent
SKILLS_ROOT = SCRIPTS_DIR.parent
RENDER_SCRIPT = SKILLS_ROOT / "harness-archive" / "templates" / "render-summary.mjs"
SUMMARY_TEMPLATE = (
    SKILLS_ROOT / "harness-archive" / "templates" / "summary-data-template.json"
)
KNOWLEDGE_SCRIPT = (
    SKILLS_ROOT / "harness-knowledge-ingest" / "scripts" / "harness_knowledge.py"
)
SERVICE_SCRIPT = SCRIPTS_DIR / "harness_service.py"

# Manifest compare must ignore self-mutating log files appended during finalize.
MANIFEST_COMPARE_EXCLUDE = frozenset(
    {
        "logs/execution-log.md",
        "execution-log.md",
        "events.ndjson",
    }
)

SCHEMA_VERSION = "2.2"
NOT_AVAILABLE = "not_available"

# Ensure sibling harness_events is importable.
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_events as he  # noqa: E402


# ---------------------------------------------------------------------------
# I/O helpers
# ---------------------------------------------------------------------------


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="milliseconds")


def today_date() -> str:
    return dt.date.today().isoformat()


def emit_json(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


def emit_error(message: str, *, as_json: bool, extra: dict[str, Any] | None = None) -> int:
    payload: dict[str, Any] = {"ok": False, "error": message}
    if extra:
        payload.update(extra)
    if as_json:
        sys.stderr.write(json.dumps(payload, ensure_ascii=False) + "\n")
    else:
        sys.stderr.write(f"error: {message}\n")
    return 1


def resolve_path(raw: str) -> Path:
    return Path(raw).expanduser().resolve()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    # 强制 LF，UTF-8 无 BOM；原子写 temp+os.replace（与 runtime-helpers.mjs 一致）。
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(text, encoding="utf-8", newline="\n")
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def find_project_root(change_or_archive_dir: Path) -> Path:
    """Resolve project root from .harness/changes|archive/<name>."""
    p = change_or_archive_dir.resolve()
    if p.parent.name in {"changes", "archive"} and p.parent.parent.name == ".harness":
        return p.parent.parent.parent
    # Fallback: walk up looking for .harness
    for parent in p.parents:
        if (parent / ".harness").is_dir():
            return parent
    return p.parent


def infer_change_name(dir_path: Path) -> str:
    name = dir_path.name
    m = re.match(r"^(\d{4}-\d{2}-\d{2})-(.+)$", name)
    if m:
        return m.group(2)
    return name


def load_template() -> dict[str, Any]:
    if SUMMARY_TEMPLATE.is_file():
        data = read_json(SUMMARY_TEMPLATE)
        if isinstance(data, dict):
            return data
    return {"schemaVersion": SCHEMA_VERSION}


# ---------------------------------------------------------------------------
# Events append (reuse P0-1)
# ---------------------------------------------------------------------------


def append_event(
    change_dir: Path,
    *,
    phase: str,
    type_: str,
    **fields: Any,
) -> dict[str, Any]:
    """Append one event via harness_events primitives and re-render execution-log."""
    path = he.events_path(change_dir)
    existing = he.load_events(path) if path.exists() else []
    event: dict[str, Any] = {
        "schema_version": he.SCHEMA_VERSION,
        "id": he.new_event_id(existing),
        "timestamp": now_iso(),
        "phase": phase,
        "type": type_,
        "note": "",
    }
    for key, value in fields.items():
        if value is not None:
            event[key] = value
    line = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    he.atomic_append_line(path, line)
    all_events = existing + [he.normalize_event(event)]
    he.write_execution_log(change_dir, he.render_execution_log(all_events))
    return event


# ---------------------------------------------------------------------------
# Manifest (Python port of gen-manifest.ps1)
# ---------------------------------------------------------------------------


def generate_manifest(root: Path, output_path: Path) -> dict[str, Any]:
    """Build path/size/sha256 manifest; exclude the output file itself."""
    root = root.resolve()
    exclude: Path | None = None
    if output_path.exists():
        exclude = output_path.resolve()

    files: list[dict[str, Any]] = []
    total_bytes = 0
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        if exclude is not None and path.resolve() == exclude:
            continue
        rel = path.relative_to(root).as_posix()
        size = path.stat().st_size
        total_bytes += size
        files.append(
            {
                "path": rel,
                "sizeBytes": size,
                "sha256": sha256_file(path),
            }
        )

    result = {
        "root": str(root),
        "generatedAt": dt.datetime.now().isoformat(timespec="seconds"),
        "fileCount": len(files),
        "totalBytes": total_bytes,
        "files": files,
    }
    write_json(output_path, result)
    return result


def _manifest_path_excluded(rel: str) -> bool:
    norm = rel.replace("\\", "/")
    if norm in MANIFEST_COMPARE_EXCLUDE:
        return True
    if norm == "events.ndjson" or norm.endswith("/events.ndjson"):
        return True
    if norm.endswith("execution-log.md"):
        return True
    return False


def _manifest_index(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for item in manifest.get("files") or []:
        if not isinstance(item, dict):
            continue
        rel = str(item.get("path") or "").replace("\\", "/")
        if not rel or _manifest_path_excluded(rel):
            continue
        out[rel] = item
    return out


def compare_manifests(
    before: dict[str, Any],
    after: dict[str, Any],
) -> dict[str, Any]:
    """Compare before/after; exclude execution-log / events self-appends.

    Files only in after are treated as generated (OK).
    Files in before missing or hash-mismatched in after are errors.
    """
    b_idx = _manifest_index(before)
    a_idx = _manifest_index(after)

    missing: list[str] = []
    mismatched: list[dict[str, str]] = []
    for rel, b_item in b_idx.items():
        a_item = a_idx.get(rel)
        if a_item is None:
            missing.append(rel)
            continue
        if str(a_item.get("sha256")) != str(b_item.get("sha256")):
            mismatched.append(
                {
                    "path": rel,
                    "before": str(b_item.get("sha256")),
                    "after": str(a_item.get("sha256")),
                }
            )

    generated = sorted(set(a_idx) - set(b_idx))
    moved_ok = len(b_idx) - len(missing) - len(mismatched)
    ok = not missing and not mismatched
    return {
        "ok": ok,
        "movedFiles": moved_ok,
        "generatedFiles": len(generated),
        "totalArchiveFiles": int(after.get("fileCount") or len(a_idx)),
        "missing": missing,
        "mismatched": mismatched,
        "generated": generated,
        "checksumStatus": "OK" if ok else "FAIL",
    }


# ---------------------------------------------------------------------------
# Evidence loaders
# ---------------------------------------------------------------------------


def load_ledger(change_dir: Path) -> dict[str, Any] | None:
    for rel in (
        "evidence/verification-ledger.json",
        "verification-ledger.json",
    ):
        path = change_dir / rel
        if path.is_file():
            try:
                data = read_json(path)
                return data if isinstance(data, dict) else None
            except (OSError, json.JSONDecodeError):
                return None
    return None


def load_execution_log(change_dir: Path) -> str:
    for rel in ("logs/execution-log.md", "execution-log.md"):
        path = change_dir / rel
        if path.is_file():
            try:
                return path.read_text(encoding="utf-8-sig")
            except OSError:
                return ""
    return ""


def load_existing_summary(change_dir: Path) -> dict[str, Any] | None:
    for rel in (
        "reports/final/summary-data.json",
        "summary-data.json",
    ):
        path = change_dir / rel
        if path.is_file():
            try:
                data = read_json(path)
                return data if isinstance(data, dict) else None
            except (OSError, json.JSONDecodeError):
                return None
    return None


def find_test_reports(change_dir: Path) -> list[Path]:
    patterns = [
        "tests/test-report-*.md",
        "reports/test/test-report-*.md",
        "reports/test/*.md",
    ]
    found: list[Path] = []
    for pattern in patterns:
        found.extend(sorted(change_dir.glob(pattern)))
    return found


def find_review_reports(change_dir: Path) -> list[Path]:
    patterns = [
        "reports/review/review-report-*.md",
        "reviews/review-report-*.md",
        "reports/review/fixback-*.md",
    ]
    found: list[Path] = []
    for pattern in patterns:
        found.extend(sorted(change_dir.glob(pattern)))
    return found


def review_phase_completed(events: list[dict[str, Any]]) -> bool:
    """True only when structured events record a review phase.end (UT-042)."""
    for event in events:
        if event.get("type") != "phase.end":
            continue
        if str(event.get("phase") or "").lower() == "review":
            return True
    return False


def review_evidence_present(
    change_dir: Path,
    events: list[dict[str, Any]] | None = None,
) -> bool:
    """Review ran only when report files or review phase.end events exist."""
    if find_review_reports(change_dir):
        return True
    if events is None:
        events = he.load_events(change_dir / "events.ndjson")
    return review_phase_completed(events)


def git_run(project: Path, *args: str) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            ["git", "-C", str(project), *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            check=False,
        )
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, "", str(exc)


def extract_final_pushed_hash(execution_log: str) -> str | None:
    """Parse 'final pushed hash' from execution-log (submit phase)."""
    patterns = [
        r"final pushed hash[:\s`]+([0-9a-f]{7,40})",
        r"finalPushedHash[:\s\"']+([0-9a-f]{7,40})",
        r"pushed hash[:\s`]+([0-9a-f]{7,40})",
    ]
    for pat in patterns:
        m = re.search(pat, execution_log, re.IGNORECASE)
        if m:
            return m.group(1)
    return None


def worktree_requested(change_dir: Path) -> bool:
    for rel in ("meta/worktree.json", "worktree.json"):
        path = change_dir / rel
        if path.is_file():
            try:
                data = read_json(path)
                if isinstance(data, dict):
                    return bool(data.get("requested"))
            except (OSError, json.JSONDecodeError):
                pass
    return False


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------


def check_status(change_dir: Path) -> dict[str, Any]:
    """Read-only archive preconditions. Never mutates."""
    blockers: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    checks: dict[str, Any] = {}

    if not change_dir.is_dir():
        return {
            "ok": False,
            "archivable": False,
            "change_dir": str(change_dir),
            "blockers": [{"code": "missing-change-dir", "message": f"not found: {change_dir}"}],
            "warnings": [],
            "checks": {},
        }

    project = find_project_root(change_dir)
    checks["project_root"] = str(project)

    # --- commit pushed ---
    code, out, err = git_run(project, "rev-parse", "--is-inside-work-tree")
    if code != 0:
        warnings.append(
            {
                "code": "git-unavailable",
                "message": f"not a git work tree or git missing: {err or out}",
            }
        )
        checks["commit_pushed"] = None
    else:
        code, out, err = git_run(project, "log", "@{u}..HEAD", "--oneline")
        if code != 0:
            # No upstream configured
            warnings.append(
                {
                    "code": "no-upstream",
                    "message": err or "no upstream configured; cannot verify push",
                }
            )
            checks["commit_pushed"] = None
        elif out.strip():
            blockers.append(
                {
                    "code": "unpushed-commits",
                    "message": f"unpushed commits:\n{out}",
                }
            )
            checks["commit_pushed"] = False
        else:
            checks["commit_pushed"] = True

    # --- final hash ---
    code, head, _ = git_run(project, "rev-parse", "HEAD")
    head_hash = head if code == 0 else None
    checks["head"] = head_hash

    expected_hash: str | None = None
    hash_source: str | None = None
    ledger = load_ledger(change_dir)
    if worktree_requested(change_dir) and ledger:
        merge_hash = ledger.get("mergeFinalHash") or (
            ledger.get("merge") or {}
        ).get("finalHash")
        if merge_hash:
            expected_hash = str(merge_hash)
            hash_source = "verification-ledger.mergeFinalHash"
    if expected_hash is None:
        log_text = load_execution_log(change_dir)
        pushed = extract_final_pushed_hash(log_text)
        if pushed:
            expected_hash = pushed
            hash_source = "execution-log.final-pushed-hash"
    if expected_hash is None and ledger:
        for key in ("finalCommit", "finalHash", "headCommit"):
            if ledger.get(key):
                expected_hash = str(ledger[key])
                hash_source = f"verification-ledger.{key}"
                break

    checks["expected_final_hash"] = expected_hash
    checks["hash_source"] = hash_source

    if head_hash and expected_hash:
        # Allow short-hash prefix match
        if head_hash.startswith(expected_hash) or expected_hash.startswith(head_hash[:7]):
            checks["final_hash_match"] = True
        else:
            # main may have advanced since this change merged (a later change
            # merged on top); the change's final hash is still pushed as long as
            # it is an ancestor of HEAD. Strict == would block archiving whenever
            # the repo moved on, which is the normal case in a multi-change
            # workflow.
            anc_code, _, _ = git_run(
                project, "merge-base", "--is-ancestor", expected_hash, head_hash
            )
            if anc_code == 0:
                checks["final_hash_match"] = True
                checks["final_hash_ancestor"] = True
            else:
                checks["final_hash_match"] = False
                blockers.append(
                    {
                        "code": "final-hash-mismatch",
                        "message": (
                            f"HEAD={head_hash} != expected={expected_hash} "
                            f"(source={hash_source}) and expected is not an ancestor "
                            f"of HEAD (not pushed?)"
                        ),
                    }
                )
    elif head_hash and expected_hash is None:
        warnings.append(
            {
                "code": "final-hash-unknown",
                "message": "could not determine expected final hash from ledger/log",
            }
        )
        checks["final_hash_match"] = None
    else:
        checks["final_hash_match"] = None

    # --- test / review reports ---
    test_reports = find_test_reports(change_dir)
    review_reports = find_review_reports(change_dir)
    events_path = change_dir / "events.ndjson"
    events = he.load_events(events_path) if events_path.is_file() else []
    review_ran = review_evidence_present(change_dir, events)

    checks["test_reports"] = [str(p.relative_to(change_dir)) for p in test_reports]
    checks["review_reports"] = [str(p.relative_to(change_dir)) for p in review_reports]

    if test_reports:
        checks["test_report_status"] = "present"
    else:
        checks["test_report_status"] = "missing-mark-skipped"
        warnings.append(
            {
                "code": "test-report-missing",
                "message": (
                    "no test-report-*.md; archive must mark verification as "
                    "NOT_RUN/USER_SKIPPED (not fabricated pass rates)"
                ),
            }
        )

    if review_reports:
        checks["review_report_status"] = "present"
    elif review_phase_completed(events):
        checks["review_report_status"] = "ran-but-not-persisted"
        warnings.append(
            {
                "code": "review-not-persisted",
                "message": (
                    "review phase.end recorded but no review-report file; "
                    "prefer persisting report before archive"
                ),
            }
        )
    else:
        checks["review_report_status"] = "not-run"
        warnings.append(
            {
                "code": "review-not-run",
                "message": "no review report; mark reviewSummary as ADVISORY_NOT_RUN",
            }
        )

    archivable = len(blockers) == 0
    return {
        "ok": True,
        "archivable": archivable,
        "change_dir": str(change_dir),
        "change_name": infer_change_name(change_dir),
        "blockers": blockers,
        "warnings": warnings,
        "checks": checks,
    }


# ---------------------------------------------------------------------------
# collect
# ---------------------------------------------------------------------------


def _deepcopy_json(obj: Any) -> Any:
    return json.loads(json.dumps(obj))


def _na_if_missing(value: Any, *, allow_empty: bool = False) -> Any:
    if value is None:
        return NOT_AVAILABLE
    if not allow_empty and value == "":
        return NOT_AVAILABLE
    return value


def _ledger_unit_tests(ledger: dict[str, Any] | None) -> dict[str, Any]:
    empty = {
        "run": 0,
        "failures": 0,
        "errors": 0,
        "skipped": 0,
        "passRate": NOT_AVAILABLE,
        "source": "not-run",
    }
    if not ledger:
        return empty
    validations = ledger.get("validations") or ledger.get("verification") or {}
    unit = validations.get("unitTest") or validations.get("unitTests") or {}
    if not isinstance(unit, dict):
        return empty
    status = str(unit.get("status") or "").upper()
    evidence = unit.get("evidence") or {}
    if isinstance(evidence, dict):
        run = evidence.get(
            "run",
            evidence.get("testsRun", unit.get("run", unit.get("testsRun", 0))),
        )
        failures = evidence.get("failures", unit.get("failures", 0))
        errors = evidence.get("errors", unit.get("errors", 0))
        skipped = evidence.get("skipped", unit.get("skipped", 0))
        pass_rate = evidence.get("passRate") or unit.get("passRate")
    else:
        run = unit.get("run", unit.get("testsRun", 0))
        failures = unit.get("failures", 0)
        errors = unit.get("errors", 0)
        skipped = unit.get("skipped", 0)
        pass_rate = unit.get("passRate")

    source = "committed"
    if status in {"NOT_RUN", "SKIPPED", "USER_SKIPPED"}:
        source = "not-run"
    elif str(unit.get("reused") or "").lower() in {"true", "1"} or "REUSED" in status:
        source = "committed"

    result = {
        "run": int(run or 0),
        "failures": int(failures or 0),
        "errors": int(errors or 0),
        "skipped": int(skipped or 0),
        "passRate": pass_rate if pass_rate is not None else NOT_AVAILABLE,
        "source": source,
    }
    if status in {"NOT_RUN", "USER_SKIPPED", "SKIPPED"}:
        result["status"] = status if status != "SKIPPED" else "USER_SKIPPED"
    return result


def _ledger_api_tests(ledger: dict[str, Any] | None) -> dict[str, Any]:
    empty = {
        "status": "NOT_RUN",
        "total": 0,
        "passed": 0,
        "failed": 0,
        "blocked": 0,
        "passRate": NOT_AVAILABLE,
    }
    if not ledger:
        return empty
    validations = ledger.get("validations") or ledger.get("verification") or {}
    api = validations.get("apiTest") or validations.get("apiTests") or {}
    if not isinstance(api, dict):
        return empty
    status = str(api.get("status") or "NOT_RUN").upper()
    if status in {"OK", "PASS", "PASSED", "SUCCESS"}:
        status = "OK"
    elif status in {"SKIP", "SKIPPED"}:
        status = "USER_SKIPPED"
    evidence = api.get("evidence") if isinstance(api.get("evidence"), dict) else {}
    total = evidence.get("total", api.get("total", 0))
    passed = evidence.get("passed", api.get("passed", 0))
    failed = evidence.get("failed", api.get("failed", 0))
    blocked = evidence.get("blocked", api.get("blocked", 0))
    pass_rate = evidence.get("passRate") or api.get("passRate")
    return {
        "status": status,
        "total": int(total or 0),
        "passed": int(passed or 0),
        "failed": int(failed or 0),
        "blocked": int(blocked or 0),
        "passRate": pass_rate if pass_rate is not None else NOT_AVAILABLE,
    }


def _ledger_db_compat(ledger: dict[str, Any] | None) -> str:
    if not ledger:
        return "NOT_RUN"
    validations = ledger.get("validations") or {}
    db = validations.get("dbCompatibility") or validations.get("db") or {}
    if isinstance(db, dict):
        return str(db.get("status") or "NOT_RUN").upper()
    if isinstance(db, str) and db.strip():
        return db.strip().upper()
    top = ledger.get("dbCompatibility")
    if isinstance(top, str) and top.strip():
        return top.strip().upper()
    return "NOT_RUN"


def _parse_durations_from_log(log_text: str) -> dict[str, Any]:
    """Best-effort parse of harness-* sections from execution-log."""
    stages: list[dict[str, Any]] = []
    # Match both old hand-written and events-rendered phase headers.
    section_re = re.compile(
        r"(?:###\s*\[\d+\]\s*)?harness-(\w+)|##\s+(plan|run|test|review|submit|merge|archive)\b",
        re.IGNORECASE,
    )
    start_re = re.compile(r"\*\*开始\*\*:\s*(.+)")
    end_re = re.compile(r"\*\*结束\*\*:\s*(.+)")
    dur_re = re.compile(r"\*\*耗时\*\*:\s*(.+)")
    result_re = re.compile(r"\*\*结果\*\*:\s*(.+)")

    lines = log_text.splitlines()
    i = 0
    while i < len(lines):
        m = section_re.search(lines[i])
        if not m:
            i += 1
            continue
        stage = (m.group(1) or m.group(2) or "").lower()
        skill = f"harness-{stage}" if not stage.startswith("harness") else stage
        started = ended = None
        minutes = 0.0
        result = "OK"
        j = i + 1
        while j < len(lines) and not section_re.search(lines[j]):
            sm = start_re.search(lines[j])
            if sm:
                started = sm.group(1).strip()
            em = end_re.search(lines[j])
            if em:
                ended = em.group(1).strip()
            dm = dur_re.search(lines[j])
            if dm:
                raw = dm.group(1).strip()
                mm = re.search(r"(\d+)\s*分", raw)
                ss = re.search(r"(\d+)\s*秒", raw)
                minutes = (int(mm.group(1)) if mm else 0) + (
                    (int(ss.group(1)) if ss else 0) / 60.0
                )
                if minutes == 0:
                    ms = re.search(r"([\d.]+)\s*s", raw, re.I)
                    if ms:
                        minutes = float(ms.group(1)) / 60.0
            rm = result_re.search(lines[j])
            if rm:
                raw_r = rm.group(1)
                if "FAIL" in raw_r or "❌" in raw_r:
                    result = "FAIL"
                elif "WARN" in raw_r or "🟡" in raw_r:
                    result = "WARN"
                else:
                    result = "OK"
            j += 1
        stages.append(
            {
                "stage": stage.replace("harness-", ""),
                "skill": skill if skill.startswith("harness-") else f"harness-{stage}",
                "startedAt": started or NOT_AVAILABLE,
                "endedAt": ended or NOT_AVAILABLE,
                "minutes": round(minutes, 2),
                "result": result,
            }
        )
        i = j

    total = round(sum(float(s["minutes"]) for s in stages), 2)
    return {
        "totalLabel": f"约 {int(round(total))} 分" if total else "约 0 分",
        "totalMinutes": total,
        "stages": stages,
    }


def _skill_calls_from_stages(stages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    counts: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for s in stages:
        skill = str(s.get("skill") or s.get("stage") or "unknown")
        if skill not in counts:
            counts[skill] = {"skill": skill, "count": 0, "result": s.get("result") or "OK"}
            order.append(skill)
        counts[skill]["count"] += 1
        counts[skill]["result"] = s.get("result") or counts[skill]["result"]
    return [counts[k] for k in order]


def _phases_from_events_summary(summary: dict[str, Any]) -> dict[str, Any]:
    phases_out: dict[str, Any] = {}
    for name in ("plan", "run", "test", "review", "submit", "archive"):
        phases_out[name] = {"duration_ms": None, "event_count": 0}
    for name, info in (summary.get("phases") or {}).items():
        key = str(name).lower()
        if key not in phases_out:
            phases_out[key] = {"duration_ms": None, "event_count": 0}
        phases_out[key] = {
            "duration_ms": info.get("duration_ms"),
            "event_count": int(info.get("event_count") or 0),
        }
    return phases_out


def _commands_from_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for e in events:
        if e.get("type") != "command":
            continue
        out.append(
            {
                "command": e.get("command") or "",
                "exit_code": e.get("exit_code"),
                "duration_ms": e.get("duration_ms"),
                "phase": e.get("phase"),
                "timestamp": e.get("timestamp"),
            }
        )
    return out


def _verification_checks_from_events(
    events: list[dict[str, Any]],
    ledger: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    seen: set[str] = set()
    for e in events:
        if e.get("type") != "verification":
            continue
        name = str(e.get("name") or "unnamed")
        status = str(e.get("status") or "unknown").lower()
        checks.append(
            {
                "name": name,
                "status": status,
                "command": e.get("command") or "",
                "source": "events.ndjson",
            }
        )
        seen.add(name.lower())
    if ledger:
        validations = ledger.get("validations") or {}
        if isinstance(validations, dict):
            for name, info in validations.items():
                if name.lower() in seen:
                    continue
                if not isinstance(info, dict):
                    continue
                checks.append(
                    {
                        "name": name,
                        "status": str(info.get("status") or "unknown").lower(),
                        "command": str(info.get("command") or ""),
                        "source": "evidence/verification-ledger.json",
                    }
                )
    return checks


def _artifacts_from_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for e in events:
        if e.get("type") != "artifact":
            continue
        out.append(
            {
                "path": e.get("path") or "",
                "kind": e.get("kind") or "",
                "phase": e.get("phase") or "",
            }
        )
    return out


def _durations_from_event_phases(event_summary: dict[str, Any]) -> dict[str, Any]:
    stages: list[dict[str, Any]] = []
    total_ms = 0
    for name, info in (event_summary.get("phases") or {}).items():
        dur = info.get("duration_ms")
        minutes = round((dur or 0) / 60000, 2) if dur is not None else 0
        if dur:
            total_ms += int(dur)
        attempts = info.get("attempts") if isinstance(info.get("attempts"), list) else []
        result = str(info.get("status") or "UNKNOWN").upper()
        if result in {"PASS", "PASSED", "SUCCESS"}:
            result = "OK"
        elif result in {"FAILED", "ERROR"}:
            result = "FAIL"
        stages.append({
            "stage": str(name),
            "skill": f"harness-{name}",
            "startedAt": info.get("started_at") or NOT_AVAILABLE,
            "endedAt": info.get("ended_at") or NOT_AVAILABLE,
            "minutes": minutes,
            "result": result,
            "attempts": attempts,
        })
    total_min = round(total_ms / 60000, 2)
    return {
        "totalLabel": f"约 {int(round(total_min))} 分",
        "totalMinutes": total_min,
        "stages": stages,
    }


def _stage_status_from_sources(
    events: list[dict[str, Any]],
    ledger: dict[str, Any] | None,
    change_dir: Path,
) -> dict[str, str]:
    status = {
        "plan": "OK",
        "run": "OK",
        "test": "OK",
        "review": "ADVISORY",
        "submit": "OK",
        "archive": "OK",
    }
    for event in events:
        if event.get("type") != "phase.end":
            continue
        phase = str(event.get("phase") or "").lower()
        raw = str(event.get("status") or "").upper()
        if phase not in status or not raw:
            continue
        if raw in {"PASS", "PASSED", "SUCCESS"}:
            raw = "OK"
        elif raw in {"FAILED", "ERROR"}:
            raw = "FAIL"
        elif raw in {"SKIP", "SKIPPED"}:
            raw = "USER_SKIPPED"
        status[phase] = raw
    # Issues in events can downgrade
    for e in events:
        if e.get("type") != "issue":
            continue
        sev = str(e.get("severity") or "").lower()
        issue_text = " ".join(str(e.get(key) or "") for key in ("message", "note", "code")).lower()
        if not sev:
            if any(token in issue_text for token in ("fail", "error", "blocked", "失败", "阻塞")):
                sev = "error"
            elif any(token in issue_text for token in ("warn", "skip", "风险", "警告")):
                sev = "warn"
        phase = str(e.get("phase") or "").lower()
        if phase in status and sev in {"error", "fail", "failed", "critical"}:
            status[phase] = "FAIL"
        elif phase in status and sev in {"warn", "warning"} and status[phase] == "OK":
            status[phase] = "WARN"

    api = _ledger_api_tests(ledger)
    db = _ledger_db_compat(ledger)
    api_status = str(api.get("status") or "").upper()
    if api_status in {"FAIL", "FAILED", "ERROR"} or int(api.get("failed") or 0) > 0:
        status["test"] = "FAIL"
    elif api_status in {"BLOCKED", "BLOCKED_BY_ENV", "BLOCKED_BY_DBA"}:
        status["test"] = api_status
    elif api_status == "USER_SKIPPED":
        status["test"] = "USER_SKIPPED"
    elif db == "BLOCKED_BY_DBA":
        status["test"] = "BLOCKED_BY_DBA"
    elif api.get("status") == "NOT_RUN" and not find_test_reports(change_dir):
        unit = _ledger_unit_tests(ledger)
        if unit.get("source") == "not-run" and unit.get("run", 0) == 0:
            status["test"] = "NOT_RUN"

    if not review_evidence_present(change_dir, events):
        status["review"] = "ADVISORY"

    return status


def _compute_final_status(
    stage_status: dict[str, str],
    verification: dict[str, Any],
) -> str:
    api = verification.get("apiTests") or {}
    db = str(verification.get("dbCompatibility") or "")
    api_status = str(api.get("status") or "")
    for v in stage_status.values():
        if v == "FAIL":
            return "FAIL"
    unit = verification.get("unitTests") or {}
    if int(unit.get("failures") or 0) > 0 or int(unit.get("errors") or 0) > 0:
        return "FAIL"
    if int(api.get("failed") or 0) > 0:
        return "FAIL"
    conditional = {
        "USER_SKIPPED", "BLOCKED", "BLOCKED_BY_ENV", "BLOCKED_BY_DBA",
        "NOT_RUN", "PARTIAL",
    }
    if api_status in conditional or db in conditional:
        return "CONDITIONAL_OK"
    for v in stage_status.values():
        if v in {"WARN", *conditional}:
            return "WARN" if v == "WARN" else "CONDITIONAL_OK"
    return "OK"


def _changed_files_from_git(
    project: Path,
    base: str | None,
    head: str | None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    diff_stat = {
        "filesChanged": 0,
        "insertions": 0,
        "deletions": 0,
        "range": NOT_AVAILABLE,
    }
    changed: list[dict[str, Any]] = []
    if not base or not head:
        return diff_stat, changed
    # The ledger bounds the complete task.  Using only ``head^..head`` would
    # silently omit earlier checkpoint commits from the same change.
    rng = f"{base}..{head}"
    code, out, _ = git_run(project, "diff", "--numstat", rng)
    if code != 0 or not out:
        diff_stat["range"] = rng
        return diff_stat, changed
    insertions = deletions = 0
    files = 0
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        ins_s, del_s, path = parts[0], parts[1], parts[2]
        ins = int(ins_s) if ins_s.isdigit() else 0
        dele = int(del_s) if del_s.isdigit() else 0
        insertions += ins
        deletions += dele
        files += 1
        changed.append(
            {
                "path": path,
                "summary": "",
                "insertions": ins,
                "deletions": dele,
            }
        )
    diff_stat = {
        "filesChanged": files,
        "insertions": insertions,
        "deletions": deletions,
        "range": rng,
    }
    return diff_stat, changed


def _review_summary(
    change_dir: Path,
    existing: dict[str, Any] | None,
    events: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    base = {
        "status": "ADVISORY",
        "red": 0,
        "yellow": 0,
        "redFixed": 0,
        "redConfirmed": 0,
        "yellowFixed": 0,
        "yellowDeferred": 0,
        "summary": "",
    }
    if existing and isinstance(existing.get("reviewSummary"), dict):
        merged = dict(base)
        merged.update(existing["reviewSummary"])
        return merged
    if not review_evidence_present(change_dir, events):
        base["status"] = "ADVISORY_NOT_RUN"
    return base


def _final_commit_from_sources(
    ledger: dict[str, Any] | None,
    events: list[dict[str, Any]],
    existing: dict[str, Any] | None,
    project: Path,
) -> str:
    if ledger:
        for key in (
            "mergeFinalHash", "finalCommit", "finalHash", "changeCommit", "headCommit",
        ):
            value = str(ledger.get(key) or "").strip()
            if value:
                return value
    commit_pattern = re.compile(r"\b[0-9a-f]{7,40}\b", re.IGNORECASE)
    for event in reversed(events):
        if str(event.get("phase") or "").lower() not in {"submit", "merge", "archive"}:
            continue
        text = " ".join(str(event.get(key) or "") for key in ("note", "message", "command"))
        match = commit_pattern.search(text)
        if match:
            return match.group(0)
    if existing and existing.get("finalCommit"):
        return str(existing["finalCommit"])
    code, head, _ = git_run(project, "rev-parse", "HEAD")
    return head if code == 0 and head else ""


def _business_goal_from_sources(change_dir: Path, events: list[dict[str, Any]]) -> str:
    plans_root = change_dir / "plans"
    primary = sorted(plans_root.glob("*-plan.md"))
    secondary = [
        path for path in sorted(plans_root.glob("*.md"))
        if path not in primary
        and "implementation-detail" not in path.name
        and "test-scenarios" not in path.name
    ]
    for plan in [*primary, *secondary]:
        try:
            text = plan.read_text(encoding="utf-8-sig")
        except OSError:
            continue
        body = re.sub(r"\A---\s*\n.*?\n---\s*\n", "", text, count=1, flags=re.DOTALL)
        goal = re.search(r"(?im)^\s*(?:goal|目标|业务目标|需求)\s*[:：]\s*(.+)$", body)
        if goal:
            return goal.group(1).strip()
        scope = re.search(r"(?im)^\s*>?\s*(?:变更范围|目标)\s*[:：]\s*(.+)$", body)
        if scope:
            return scope.group(1).strip()
        first_task = re.search(r"(?m)^\s*\|\s*1\s*\|\s*([^|]+?)\s*\|", body)
        if first_task:
            return first_task.group(1).strip()
        for line in body.splitlines():
            clean = line.strip().lstrip("#").strip()
            if clean and not clean.startswith(("---", ">", "|")) and len(clean) > 8:
                return clean
    for event in events:
        if event.get("type") == "decision":
            value = str(event.get("decision") or event.get("note") or "").strip()
            if value:
                return re.sub(r"^(?:需求收敛|目标)\s*[:：]\s*", "", value)
    return ""


def _timeline_from_events(event_summary: dict[str, Any], events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    timeline: list[dict[str, Any]] = []
    for phase, info in (event_summary.get("phases") or {}).items():
        attempts = info.get("attempts") if isinstance(info.get("attempts"), list) else []
        for attempt in attempts:
            timeline.append({
                "phase": phase,
                "attempt": attempt.get("attempt"),
                "startedAt": attempt.get("started_at"),
                "endedAt": attempt.get("ended_at"),
                "durationMs": attempt.get("duration_ms"),
                "status": attempt.get("status") or "UNKNOWN",
                "executorTool": attempt.get("executor_tool"),
                "executorAgent": attempt.get("executor_agent"),
                "handoffFromTool": attempt.get("handoff_from_tool"),
            })
    for event in events:
        if event.get("type") not in {"decision", "issue"}:
            continue
        timeline.append({
            "phase": event.get("phase"),
            "timestamp": event.get("timestamp"),
            "type": event.get("type"),
            "summary": event.get("decision") or event.get("message") or event.get("note") or "",
        })
    return timeline


def collect_summary_data(
    change_dir: Path,
    *,
    before_manifest: dict[str, Any] | None = None,
    after_manifest: dict[str, Any] | None = None,
    compare_result: dict[str, Any] | None = None,
    write: bool = True,
    for_replay: bool = False,
) -> dict[str, Any]:
    """Build schema 2.2 summary-data from events/ledger/log/manifest/reports."""
    template = load_template()
    data = _deepcopy_json(template)
    # Clear placeholder strings from template
    data["schemaVersion"] = SCHEMA_VERSION
    change_name = infer_change_name(change_dir)
    data["changeName"] = change_name

    sources: list[str] = []
    events: list[dict[str, Any]] = []
    events_file = he.events_path(change_dir)
    has_events = events_file.is_file() and events_file.stat().st_size > 0
    if has_events:
        try:
            events = he.load_events(events_file)
            sources.append("events.ndjson")
        except ValueError:
            events = []

    ledger = load_ledger(change_dir)
    if ledger:
        sources.append("evidence/verification-ledger.json")

    log_text = load_execution_log(change_dir)
    if log_text:
        sources.append("logs/execution-log.md")

    existing = load_existing_summary(change_dir)
    if existing and for_replay:
        sources.append("reports/final/summary-data.json")

    # Prefer existing summary fields when replaying old archives (golden-stable).
    if for_replay and existing:
        for key in (
            "businessGoal",
            "finalStatus",
            "finalCommit",
            "finalCommitBranch",
            "baseCommit",
            "diffStat",
            "stageStatus",
            "durations",
            "skillCalls",
            "verification",
            "timeline",
            "changedFiles",
            "artifacts",
            "reviewSummary",
            "archiveManifest",
            "uncommittedTestEvidence",
            "maintenanceNotes",
            "knownRisks",
            "manualActions",
        ):
            if key in existing:
                data[key] = _deepcopy_json(existing[key])

    event_summary = he.build_summary(change_dir, events) if events else {
        "ok": True,
        "event_count": 0,
        "phases": {},
        "issues": [],
    }

    # businessGoal
    if not data.get("businessGoal") or str(data.get("businessGoal")).startswith("本次"):
        if existing and existing.get("businessGoal"):
            data["businessGoal"] = existing["businessGoal"]
        else:
            inferred_goal = _business_goal_from_sources(change_dir, events)
            data["businessGoal"] = inferred_goal or (NOT_AVAILABLE if for_replay else "")

    # commits
    project = find_project_root(change_dir)
    if not data.get("finalCommit") or str(data.get("finalCommit")).startswith("<"):
        final_commit = _final_commit_from_sources(ledger, events, existing, project)
        data["finalCommit"] = final_commit or (NOT_AVAILABLE if for_replay else "")

    if not data.get("baseCommit") or str(data.get("baseCommit")).startswith("<"):
        if ledger and ledger.get("baseCommit"):
            data["baseCommit"] = ledger["baseCommit"]
        elif existing and existing.get("baseCommit"):
            data["baseCommit"] = existing["baseCommit"]
        else:
            data["baseCommit"] = NOT_AVAILABLE if for_replay else ""

    if not data.get("finalCommitBranch") or str(data.get("finalCommitBranch")).startswith("<"):
        code, branch, _ = git_run(project, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
        if code == 0 and branch:
            data["finalCommitBranch"] = branch
        elif existing and existing.get("finalCommitBranch"):
            data["finalCommitBranch"] = existing["finalCommitBranch"]
        else:
            data["finalCommitBranch"] = NOT_AVAILABLE if for_replay else ""

    # verification
    if not for_replay or not isinstance(data.get("verification"), dict):
        unit = _ledger_unit_tests(ledger)
        api = _ledger_api_tests(ledger)
        db = _ledger_db_compat(ledger)
        if not find_test_reports(change_dir) and unit.get("run", 0) == 0:
            if "status" not in unit:
                unit["status"] = "NOT_RUN"
            if api.get("status") in {"", "OK"} and api.get("total", 0) == 0:
                api["status"] = "NOT_RUN"
        coverage = NOT_AVAILABLE
        if existing and isinstance(existing.get("verification"), dict):
            coverage = existing["verification"].get("coverageDisplay", coverage)
        data["verification"] = {
            "unitTests": unit,
            "apiTests": api,
            "dbCompatibility": db,
            "coverageDisplay": coverage,
        }
    else:
        # Ensure nested keys exist for old schema 2.1
        ver = data.setdefault("verification", {})
        ver.setdefault("unitTests", {})
        ver.setdefault("apiTests", {})
        ver.setdefault("dbCompatibility", ver.get("dbCompatibility", NOT_AVAILABLE))
        ver.setdefault("coverageDisplay", ver.get("coverageDisplay", NOT_AVAILABLE))

    # stageStatus / finalStatus
    if not for_replay or not isinstance(data.get("stageStatus"), dict):
        data["stageStatus"] = _stage_status_from_sources(events, ledger, change_dir)
    if not for_replay or not data.get("finalStatus") or str(data.get("finalStatus")).startswith("OK |"):
        data["finalStatus"] = _compute_final_status(
            data.get("stageStatus") or {},
            data.get("verification") or {},
        )

    # durations / skillCalls
    if events:
        data["durations"] = _durations_from_event_phases(event_summary)
        data["skillCalls"] = _skill_calls_from_stages(data["durations"].get("stages") or [])
    elif log_text and (not for_replay or not data.get("durations")):
        data["durations"] = _parse_durations_from_log(log_text)
        data["skillCalls"] = _skill_calls_from_stages(data["durations"].get("stages") or [])
    elif not data.get("durations"):
        data["durations"] = {
            "totalLabel": NOT_AVAILABLE,
            "totalMinutes": 0,
            "stages": [],
        }
        data["skillCalls"] = []

    # diffStat / changedFiles
    if not for_replay or not data.get("changedFiles"):
        base = data.get("baseCommit")
        head = data.get("finalCommit")
        if base and head and base != NOT_AVAILABLE and head != NOT_AVAILABLE:
            diff_stat, changed = _changed_files_from_git(project, str(base), str(head))
            if changed:
                data["diffStat"] = diff_stat
                data["changedFiles"] = changed
            elif existing and existing.get("changedFiles"):
                data["changedFiles"] = existing["changedFiles"]
                data["diffStat"] = existing.get("diffStat") or diff_stat
            else:
                data["diffStat"] = diff_stat
                data["changedFiles"] = []
        elif existing and existing.get("changedFiles"):
            data["changedFiles"] = existing["changedFiles"]
            data["diffStat"] = existing.get("diffStat") or {
                "filesChanged": len(existing["changedFiles"]),
                "insertions": 0,
                "deletions": 0,
                "range": NOT_AVAILABLE,
            }
        else:
            data["diffStat"] = {
                "filesChanged": 0,
                "insertions": 0,
                "deletions": 0,
                "range": NOT_AVAILABLE if for_replay else "",
            }
            data["changedFiles"] = []

    # artifacts (build products stay empty unless already known; reportPipeline has event artifacts)
    if not isinstance(data.get("artifacts"), list):
        data["artifacts"] = []
    if not for_replay:
        data["artifacts"] = _artifacts_from_events(events)

    data["reviewSummary"] = _review_summary(
        change_dir,
        existing if for_replay else None,
        events,
    )
    if not for_replay:
        data["timeline"] = _timeline_from_events(event_summary, events)
    else:
        data.setdefault("timeline", [])
    data.setdefault("uncommittedTestEvidence", [])

    # Derive risks/actions from evidence. These fields are facts, not model prose.
    if not for_replay:
        data["maintenanceNotes"] = [
            str(event.get("note") or event.get("message") or "")
            for event in events
            if event.get("type") == "decision" and (event.get("note") or event.get("message"))
        ]
        data["knownRisks"] = [
            {
                "phase": event.get("phase"),
                "severity": event.get("severity") or "unknown",
                "message": event.get("message") or event.get("note") or event.get("code") or "",
            }
            for event in events
            if event.get("type") == "issue"
            and not (
                event.get("phase") == "archive"
                and event.get("code") == "missing-command"
            )
        ]
        data["manualActions"] = []
        for name, value in (data.get("stageStatus") or {}).items():
            if value in {"BLOCKED", "BLOCKED_BY_ENV", "BLOCKED_BY_DBA", "NOT_RUN", "USER_SKIPPED"}:
                data["manualActions"].append({
                    "stage": name,
                    "status": value,
                    "action": "补充或确认该阶段的真实验证证据",
                })
    else:
        data.setdefault("maintenanceNotes", [])
        data.setdefault("knownRisks", [])
        data.setdefault("manualActions", [])

    # archiveManifest
    am = {
        "movedFiles": 0,
        "generatedFiles": 0,
        "totalArchiveFiles": 0,
        "checksumStatus": "OK",
    }
    if compare_result:
        am["movedFiles"] = compare_result.get("movedFiles", 0)
        am["generatedFiles"] = compare_result.get("generatedFiles", 0)
        am["totalArchiveFiles"] = compare_result.get("totalArchiveFiles", 0)
        am["checksumStatus"] = compare_result.get("checksumStatus", "OK")
    elif after_manifest:
        am["totalArchiveFiles"] = int(after_manifest.get("fileCount") or 0)
    elif before_manifest:
        am["totalArchiveFiles"] = int(before_manifest.get("fileCount") or 0)
    elif for_replay and isinstance(data.get("archiveManifest"), dict):
        am = {**am, **data["archiveManifest"]}
    data["archiveManifest"] = am

    # reportPipeline
    commands = _commands_from_events(events)
    if not commands and for_replay:
        # Cannot invent commands
        pass
    verification_checks = _verification_checks_from_events(events, ledger)
    pipeline_artifacts = _artifacts_from_events(events)
    if not sources:
        sources = [NOT_AVAILABLE]

    data["reportPipeline"] = {
        "schema_version": 1,
        "generated_at": now_iso(),
        "event_count": len(events),
        "sources": sources,
        "phases": _phases_from_events_summary(event_summary),
        "commands": commands,
        "verificationChecks": verification_checks,
        "artifacts": pipeline_artifacts,
        "validationIssues": [],
    }

    # Fill any remaining template placeholders that look like instructions
    for key in list(data.keys()):
        val = data[key]
        if isinstance(val, str) and ("|" in val and "OK" in val and len(val) < 80):
            # template enum hint left behind
            if for_replay:
                data[key] = existing.get(key, NOT_AVAILABLE) if existing else NOT_AVAILABLE

    if write:
        out_path = change_dir / "reports" / "final" / "summary-data.json"
        write_json(out_path, data)

    return data


# ---------------------------------------------------------------------------
# render
# ---------------------------------------------------------------------------


def resolve_node_path(project_root: Path) -> str | None:
    profile = project_root / ".harness" / "config" / "build-profile.json"
    if profile.is_file():
        try:
            data = read_json(profile)
            node = (data.get("toolPaths") or {}).get("node")
            if node and Path(str(node)).exists():
                return str(node)
        except (OSError, json.JSONDecodeError, TypeError):
            pass
    return shutil.which("node")


def render_fallback_html(summary: dict[str, Any]) -> str:
    """Render escaped, deterministic HTML with every validate-required fact.

    Used when the Node renderer is unavailable or fails. No timestamps / random
    data; all dynamic values are HTML-escaped via _html_escape.
    """
    def esc(v: Any) -> str:
        return _html_escape("" if v is None else str(v))

    parts: list[str] = [
        "<!DOCTYPE html>",
        '<html lang="zh-CN"><head><meta charset="utf-8">',
        "<title>harness final-summary (python fallback)</title>",
        "</head><body>",
        "<h1>变更最终报告（Python fallback 渲染）</h1>",
        f'<h2 id="changeName">{esc(summary.get("changeName"))}</h2>',
        f'<p><strong>finalStatus</strong>: '
        f'<span id="finalStatus">{esc(summary.get("finalStatus"))}</span></p>',
    ]

    pipeline = summary.get("reportPipeline") or {}
    cmds = pipeline.get("commands") or []
    parts.append("<h3>Commands</h3><ul>")
    for c in cmds:
        parts.append(
            f"<li><code>{esc(c.get('command'))}</code> "
            f"exitCode={esc(c.get('exit_code'))}</li>"
        )
    parts.append("</ul>")

    ver = summary.get("verification") or {}
    unit = ver.get("unitTests") or {}
    api = ver.get("apiTests") or {}
    parts.append("<h3>Verification</h3>")
    parts.append(
        "<p>unitTests: run={run} failures={failures} errors={errors} "
        "skipped={skipped} passRate={passRate} status={status}</p>".format(
            run=esc(unit.get("run")),
            failures=esc(unit.get("failures")),
            errors=esc(unit.get("errors")),
            skipped=esc(unit.get("skipped")),
            passRate=esc(unit.get("passRate")),
            status=esc(unit.get("status")),
        )
    )
    parts.append(
        "<p>apiTests: status={status} total={total} passed={passed} "
        "failed={failed} blocked={blocked}</p>".format(
            status=esc(api.get("status")),
            total=esc(api.get("total")),
            passed=esc(api.get("passed")),
            failed=esc(api.get("failed")),
            blocked=esc(api.get("blocked")),
        )
    )
    parts.append(f"<p>dbCompatibility: {esc(ver.get('dbCompatibility'))}</p>")

    parts.append("<h3>Changed Files</h3><ul>")
    for f in summary.get("changedFiles") or []:
        parts.append(
            f"<li>{esc(f.get('path'))} +{esc(f.get('insertions'))} "
            f"-{esc(f.get('deletions'))}</li>"
        )
    parts.append("</ul>")

    am = summary.get("archiveManifest") or {}
    parts.append("<h3>Archive Manifest</h3>")
    parts.append(
        "<p>movedFiles={moved} generatedFiles={gen} totalArchiveFiles={total} "
        "checksumStatus={cs}</p>".format(
            moved=esc(am.get("movedFiles")),
            gen=esc(am.get("generatedFiles")),
            total=esc(am.get("totalArchiveFiles")),
            cs=esc(am.get("checksumStatus")),
        )
    )

    def _list_section(title: str, items: Any) -> None:
        parts.append(f"<h3>{esc(title)}</h3><ul>")
        for it in items or []:
            parts.append(f"<li>{esc(it)}</li>")
        parts.append("</ul>")

    _list_section("Known Risks", summary.get("knownRisks"))
    _list_section("Manual Actions", summary.get("manualActions"))
    _list_section("Maintenance Notes", summary.get("maintenanceNotes"))

    parts.append("</body></html>")
    return "\n".join(parts) + "\n"


def render_final_summary(
    change_dir: Path,
    summary_path: Path,
) -> dict[str, Any]:
    """Render final-summary.html via Node; fall back to a Python renderer.

    Returns ``{ok, renderer, fallbackReason, out_path}``:
    - Node success -> renderer="node".
    - Node unavailable/timeout/non-zero/no-file -> Python fallback; success ->
      renderer="python-fallback" (fallbackReason carries the node failure cause).
    - Both fail or produce no file -> ok=False (caller must restore + exit non-0).
    """
    out_path = change_dir / "reports" / "final" / "final-summary.html"
    project = find_project_root(change_dir)
    node = resolve_node_path(project)
    fallback_reason = ""

    if node and RENDER_SCRIPT.is_file():
        out_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            proc = subprocess.run(
                [
                    node,
                    str(RENDER_SCRIPT),
                    "--summary",
                    str(summary_path),
                    "--out",
                    str(out_path),
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=60,
                check=False,
            )
            if proc.returncode == 0 and out_path.is_file():
                return {
                    "ok": True,
                    "renderer": "node",
                    "fallbackReason": "",
                    "out_path": str(out_path),
                }
            fallback_reason = (
                f"node render exit {proc.returncode}: "
                f"{(proc.stderr or proc.stdout or '')[:200]}"
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            fallback_reason = f"node render failed: {exc}"
    else:
        fallback_reason = (
            "node unavailable" if not node else f"renderer missing: {RENDER_SCRIPT}"
        )

    # Python fallback
    try:
        summary = read_json(summary_path)
        html = render_fallback_html(summary)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(html, encoding="utf-8", newline="\n")
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        return {
            "ok": False,
            "renderer": "none",
            "fallbackReason": f"{fallback_reason}; fallback failed: {exc}",
            "out_path": str(out_path),
        }
    if out_path.is_file():
        return {
            "ok": True,
            "renderer": "python-fallback",
            "fallbackReason": fallback_reason,
            "out_path": str(out_path),
        }
    return {
        "ok": False,
        "renderer": "none",
        "fallbackReason": f"{fallback_reason}; fallback produced no file",
        "out_path": str(out_path),
    }


# ---------------------------------------------------------------------------
# validate
# ---------------------------------------------------------------------------


def validate_summary(
    summary: dict[str, Any],
    html_path: Path | None,
    *,
    render_skipped: bool = False,
) -> dict[str, Any]:
    """Validate final-summary covers summary-data key facts (in-process)."""
    issues: list[dict[str, str]] = []

    change_id = str(summary.get("changeName") or "")
    html = ""
    if html_path and html_path.is_file():
        try:
            html = html_path.read_text(encoding="utf-8-sig")
        except OSError as exc:
            issues.append(
                {
                    "code": "missing-final-report",
                    "severity": "error",
                    "message": f"cannot read final-summary: {exc}",
                }
            )
    else:
        # Task 2 (§4.1 rule 5): 不再存在"没有 HTML 但只 warning"的分支。
        # 缺 final-summary 恒为 error；finalize 会 restore + exit 非 0。
        issues.append(
            {
                "code": "missing-final-report",
                "severity": "error",
                "message": "reports/final/final-summary.html not found",
            }
        )

    def has_text(needle: str) -> bool:
        if not needle or needle == NOT_AVAILABLE:
            return True
        return needle in html

    # change id
    if html and change_id and not has_text(change_id):
        issues.append(
            {
                "code": "missing-change-id",
                "severity": "error",
                "message": f"final-summary missing change id '{change_id}'",
            }
        )

    # key commands — stock render-summary.mjs does not embed reportPipeline.commands.
    # Require commands to be present in summary-data; HTML absence is warning only.
    commands = (summary.get("reportPipeline") or {}).get("commands") or []
    if html:
        for cmd in commands[:8]:
            c = str(cmd.get("command") or "").strip()
            if not c:
                continue
            fragment = c if len(c) <= 60 else c[:60]
            token = c.split()[-1] if c.split() else c
            in_html = (
                fragment in html
                or _html_escape(fragment) in html
                or (len(token) >= 4 and (token in html or _html_escape(token) in html))
            )
            if not in_html:
                issues.append(
                    {
                        "code": "missing-command",
                        "severity": "warning",
                        "message": (
                            f"final-summary HTML omits command (renderer may not "
                            f"embed commands): {c}"
                        ),
                    }
                )

        # verification
        ver = summary.get("verification") or {}
        unit = ver.get("unitTests") or {}
        api = ver.get("apiTests") or {}
        pass_rate = unit.get("passRate")
        if pass_rate and pass_rate != NOT_AVAILABLE and str(pass_rate) not in html:
            issues.append(
                {
                    "code": "missing-verification",
                    "severity": "warning",
                    "message": f"unitTests.passRate '{pass_rate}' not in final-summary",
                }
            )
        api_status = str(api.get("status") or "")
        if api_status and api_status not in {"", NOT_AVAILABLE} and api_status not in html:
            # Renderer shows api status; soft warning
            if api_status in {"USER_SKIPPED", "BLOCKED_BY_DBA", "NOT_RUN", "PARTIAL"}:
                issues.append(
                    {
                        "code": "missing-verification",
                        "severity": "warning",
                        "message": f"apiTests.status '{api_status}' not visible in final-summary",
                    }
                )

        # artifacts / summary-data path hints
        am = summary.get("archiveManifest") or {}
        total = am.get("totalArchiveFiles")
        if total is not None and str(total) not in html:
            issues.append(
                {
                    "code": "missing-artifact",
                    "severity": "warning",
                    "message": "archiveManifest.totalArchiveFiles not reflected in final-summary",
                }
            )

        # risks / manual actions — empty arrays are OK (placeholder)
        for risk in summary.get("knownRisks") or []:
            text = str(risk)
            if text and text not in html and _html_escape(text) not in html:
                issues.append(
                    {
                        "code": "missing-risk",
                        "severity": "warning",
                        "message": f"knownRisk not in final-summary: {text[:80]}",
                    }
                )

        # status contradiction
        final_status = str(summary.get("finalStatus") or "")
        has_skip = api_status == "USER_SKIPPED" or str(
            ver.get("dbCompatibility") or ""
        ) == "BLOCKED_BY_DBA"
        has_fail_ver = int(unit.get("failures") or 0) > 0 or int(unit.get("errors") or 0) > 0
        has_fail_ver = has_fail_ver or int(api.get("failed") or 0) > 0
        stage = summary.get("stageStatus") or {}
        has_fail_stage = any(str(v).upper() == "FAIL" for v in stage.values())

        if (has_skip or has_fail_ver or has_fail_stage) and final_status == "OK":
            issues.append(
                {
                    "code": "status-contradiction",
                    "severity": "error",
                    "message": (
                        "finalStatus is pure OK but USER_SKIPPED/BLOCKED_BY_DBA/"
                        "failed verification present"
                    ),
                }
            )
        if has_skip and html:
            if re.search(r">\s*OK\s*<", html) and "CONDITIONAL" not in html.upper():
                if final_status != "CONDITIONAL_OK":
                    issues.append(
                        {
                            "code": "status-contradiction",
                            "severity": "error",
                            "message": "final-summary shows pure OK despite USER_SKIPPED/BLOCKED",
                        }
                    )
    else:
        # No HTML (and not render_skipped handled above): still check data-level status rules
        ver = summary.get("verification") or {}
        unit = ver.get("unitTests") or {}
        api = ver.get("apiTests") or {}
        api_status = str(api.get("status") or "")
        final_status = str(summary.get("finalStatus") or "")
        has_skip = api_status == "USER_SKIPPED" or str(
            ver.get("dbCompatibility") or ""
        ) == "BLOCKED_BY_DBA"
        has_fail_ver = int(unit.get("failures") or 0) > 0 or int(unit.get("errors") or 0) > 0
        has_fail_ver = has_fail_ver or int(api.get("failed") or 0) > 0
        stage = summary.get("stageStatus") or {}
        has_fail_stage = any(str(v).upper() == "FAIL" for v in stage.values())
        if (has_skip or has_fail_ver or has_fail_stage) and final_status == "OK":
            issues.append(
                {
                    "code": "status-contradiction",
                    "severity": "error",
                    "message": (
                        "finalStatus is pure OK but USER_SKIPPED/BLOCKED_BY_DBA/"
                        "failed verification present"
                    ),
                }
            )

    errors = [i for i in issues if i.get("severity") == "error"]
    warnings = [i for i in issues if i.get("severity") != "error"]
    return {
        "ok": len(errors) == 0,
        "issues": issues,
        "error_count": len(errors),
        "warning_count": len(warnings),
    }


def _html_escape(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


# ---------------------------------------------------------------------------
# knowledge / service post-steps
# ---------------------------------------------------------------------------


def run_knowledge_poststeps(project_root: Path) -> dict[str, Any]:
    results: dict[str, Any] = {"ran": False, "steps": [], "warnings": []}
    if not KNOWLEDGE_SCRIPT.is_file():
        results["warnings"].append(f"harness_knowledge.py not found: {KNOWLEDGE_SCRIPT}")
        return results
    results["ran"] = True
    for cmd in ("ingest", "dedupe", "auto-supersede", "reverify-stale"):
        try:
            proc = subprocess.run(
                [
                    sys.executable,
                    str(KNOWLEDGE_SCRIPT),
                    cmd,
                    "--project",
                    str(project_root),
                    "--json",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=300,
                check=False,
            )
            step = {
                "command": cmd,
                "exit_code": proc.returncode,
                "ok": proc.returncode == 0,
            }
            if proc.returncode != 0:
                step["stderr"] = (proc.stderr or proc.stdout or "")[:500]
                results["warnings"].append(f"knowledge {cmd} exit {proc.returncode}")
            results["steps"].append(step)
        except (OSError, subprocess.TimeoutExpired) as exc:
            results["steps"].append({"command": cmd, "ok": False, "error": str(exc)})
            results["warnings"].append(f"knowledge {cmd} failed: {exc}")
    return results


def enqueue_maintenance_outbox(project_root: Path, archive_dir: Path) -> dict[str, Any]:
    """§8.2: write a pending maintenance-outbox item instead of synchronously
    running the four knowledge subprocesses. Never rolls back the archive."""
    pending_dir = (
        project_root / ".harness" / "knowledge" / "maintenance-outbox" / "pending"
    )
    pending_dir.mkdir(parents=True, exist_ok=True)
    archive_id = archive_dir.name
    manifest = archive_dir / "evidence" / "archive-manifest-after.json"
    manifest_hash = "sha256:" + sha256_file(manifest) if manifest.is_file() else ""
    try:
        rel = archive_dir.resolve().relative_to(project_root.resolve()).as_posix()
    except ValueError:
        rel = str(archive_dir)
    item = {
        "schemaVersion": 1,
        "archiveId": archive_id,
        "archivePath": rel,
        "archiveManifestHash": manifest_hash,
        "status": "pending",
        "attempts": 0,
        "createdAt": now_iso(),
        "lastError": None,
    }
    item_path = pending_dir / f"{archive_id}.json"
    write_json(item_path, item)
    return {
        "queued": True,
        "outboxPath": str(item_path),
        "archiveId": archive_id,
        "status": "pending",
    }


def run_service_stop(change_dir: Path) -> dict[str, Any]:
    if not SERVICE_SCRIPT.is_file():
        return {
            "ran": False,
            "skipped": True,
            "warning": f"harness_service.py not found; stop skipped",
        }
    try:
        proc = subprocess.run(
            [
                sys.executable,
                str(SERVICE_SCRIPT),
                "stop",
                "--change-dir",
                str(change_dir),
                "--if-started-by-ai",
                "--json",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            check=False,
        )
        return {
            "ran": True,
            "skipped": False,
            "exit_code": proc.returncode,
            "ok": proc.returncode == 0,
            "stdout": (proc.stdout or "")[:500],
        }
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ran": True, "skipped": False, "ok": False, "warning": str(exc)}


# ---------------------------------------------------------------------------
# finalize
# ---------------------------------------------------------------------------


def cmd_finalize(
    change_dir: Path,
    archive_root: Path,
    *,
    skip_ingest: bool = False,
) -> tuple[int, dict[str, Any]]:
    """Execute the 9-step finalize pipeline. Returns (exit_code, payload)."""
    warnings: list[str] = []
    original_change_dir = change_dir.resolve()
    change_name = original_change_dir.name
    archive_root = archive_root.resolve()
    archive_root.mkdir(parents=True, exist_ok=True)
    archive_dir = archive_root / f"{today_date()}-{change_name}"
    project_root = find_project_root(original_change_dir)

    payload: dict[str, Any] = {
        "ok": False,
        "action": "finalize",
        "change_dir": str(original_change_dir),
        "archive_dir": str(archive_dir),
        "change_name": change_name,
        "warnings": warnings,
        "steps": {},
    }

    if not original_change_dir.is_dir():
        payload["error"] = f"change dir not found: {original_change_dir}"
        return 1, payload

    if archive_dir.exists():
        payload["error"] = f"archive target already exists: {archive_dir}"
        return 1, payload

    work_dir = original_change_dir

    def _safe_append(**kwargs: Any) -> None:
        nonlocal work_dir
        try:
            append_event(work_dir, **kwargs)
        except OSError as exc:
            warnings.append(f"event append failed: {exc}")

    # Step 9 starts here: phase.start
    _safe_append(phase="archive", type_="phase.start", note="finalize start")

    # --- 1. before-manifest ---
    before_path = work_dir / "evidence" / "archive-manifest-before.json"
    try:
        before_manifest = generate_manifest(work_dir, before_path)
        payload["steps"]["before_manifest"] = {
            "ok": True,
            "path": str(before_path),
            "fileCount": before_manifest.get("fileCount"),
        }
        _safe_append(
            phase="archive",
            type_="artifact",
            path=str(before_path.relative_to(work_dir)).replace("\\", "/"),
            kind="manifest-before",
        )
        _safe_append(
            phase="archive",
            type_="command",
            command="generate_manifest(before)",
            exit_code=0,
            note="before-manifest",
        )
    except OSError as exc:
        payload["error"] = f"before-manifest failed: {exc}"
        _safe_append(
            phase="archive",
            type_="issue",
            code="before-manifest-failed",
            severity="error",
            message=str(exc),
        )
        return 1, payload

    # --- 2. move ---
    try:
        archive_root.mkdir(parents=True, exist_ok=True)
        shutil.move(str(original_change_dir), str(archive_dir))
        work_dir = archive_dir
        payload["steps"]["move"] = {"ok": True, "to": str(archive_dir)}
        _safe_append(
            phase="archive",
            type_="command",
            command=f"move → {archive_dir.name}",
            exit_code=0,
            note="moved change dir to archive",
        )
    except OSError as exc:
        # Move failed: original intact, stop immediately
        payload["error"] = f"move failed: {exc}"
        payload["steps"]["move"] = {"ok": False, "error": str(exc)}
        payload["original_preserved"] = original_change_dir.is_dir()
        try:
            append_event(
                original_change_dir,
                phase="archive",
                type_="issue",
                code="move-failed",
                severity="error",
                message=str(exc),
            )
        except OSError:
            pass
        return 1, payload

    # --- 3. collect ---
    try:
        summary = collect_summary_data(
            work_dir,
            before_manifest=before_manifest,
            write=True,
            for_replay=False,
        )
        summary_path = work_dir / "reports" / "final" / "summary-data.json"
        payload["steps"]["collect"] = {"ok": True, "path": str(summary_path)}
        _safe_append(
            phase="archive",
            type_="artifact",
            path="reports/final/summary-data.json",
            kind="summary-data",
        )
    except Exception as exc:  # noqa: BLE001 — surface collect failures
        payload["error"] = f"collect failed: {exc}"
        payload["steps"]["collect"] = {"ok": False, "error": str(exc)}
        _restore_on_failure(archive_dir, original_change_dir, payload, warnings)
        return 1, payload

    # --- 4. render (Node, else Python fallback) ---
    render_result = render_final_summary(work_dir, summary_path)
    payload["steps"]["render"] = render_result
    if not render_result.get("ok"):
        # Node + fallback both failed: restore + exit non-0 (§4.1 rule 4)。
        # 永不关闭一个没有 final-summary 的归档。
        msg = str(render_result.get("fallbackReason") or "render failed")
        payload["error"] = f"final-summary render failed: {msg}"
        _safe_append(
            phase="archive",
            type_="issue",
            code="render-failed",
            severity="error",
            message=msg,
        )
        _restore_on_failure(archive_dir, original_change_dir, payload, warnings)
        _restore_target = original_change_dir if original_change_dir.is_dir() else work_dir
        try:
            append_event(
                _restore_target,
                phase="archive",
                type_="phase.end",
                status="FAIL",
                note="finalize aborted; render failed; original preserved",
            )
        except OSError:
            pass
        payload["warnings"] = warnings
        payload["ok"] = False
        return 1, payload
    renderer = render_result.get("renderer")
    if renderer == "python-fallback" and render_result.get("fallbackReason"):
        warnings.append(
            f"node render unavailable; used python-fallback: "
            f"{render_result.get('fallbackReason')}"
        )
    _safe_append(
        phase="archive",
        type_="artifact",
        path="reports/final/final-summary.html",
        kind="final-report",
    )
    _safe_append(
        phase="archive",
        type_="command",
        command=f"render-final-summary ({renderer})",
        exit_code=0,
        note=f"final-summary rendered by {renderer}",
    )

    html_path = work_dir / "reports" / "final" / "final-summary.html"

    # --- 5. validate (same process, no re-collect) ---
    # Refresh summary from disk (collect already wrote it); do not re-collect.
    try:
        summary = read_json(summary_path)
    except (OSError, json.JSONDecodeError):
        pass
    validate_result = validate_summary(
        summary,
        html_path if html_path.is_file() else None,
    )
    payload["steps"]["validate"] = validate_result
    summary.setdefault("reportPipeline", {})["validationIssues"] = validate_result.get(
        "issues"
    ) or []
    try:
        write_json(summary_path, summary)
    except OSError as exc:
        warnings.append(f"could not write validationIssues: {exc}")

    for issue in validate_result.get("issues") or []:
        _safe_append(
            phase="archive",
            type_="issue",
            code=str(issue.get("code") or "validate"),
            severity=str(issue.get("severity") or "warning"),
            message=str(issue.get("message") or ""),
        )

    # --- 6. after-manifest + compare ---
    after_path = work_dir / "evidence" / "archive-manifest-after.json"
    try:
        after_manifest = generate_manifest(work_dir, after_path)
        # Re-read before from archive (moved with the tree)
        before_in_archive = work_dir / "evidence" / "archive-manifest-before.json"
        if before_in_archive.is_file():
            before_manifest = read_json(before_in_archive)
        compare_result = compare_manifests(before_manifest, after_manifest)
        payload["steps"]["after_manifest"] = {
            "ok": True,
            "path": str(after_path),
            "compare": compare_result,
        }
        _safe_append(
            phase="archive",
            type_="artifact",
            path="evidence/archive-manifest-after.json",
            kind="manifest-after",
        )
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        payload["error"] = f"after-manifest failed: {exc}"
        payload["steps"]["after_manifest"] = {"ok": False, "error": str(exc)}
        _restore_on_failure(archive_dir, original_change_dir, payload, warnings)
        return 1, payload

    # Update archiveManifest in summary-data with compare stats
    summary["archiveManifest"] = {
        "movedFiles": compare_result.get("movedFiles", 0),
        "generatedFiles": compare_result.get("generatedFiles", 0),
        "totalArchiveFiles": compare_result.get("totalArchiveFiles", 0),
        "checksumStatus": compare_result.get("checksumStatus", "FAIL"),
    }
    try:
        write_json(summary_path, summary)
    except OSError as exc:
        warnings.append(f"could not update archiveManifest: {exc}")

    # The first render is needed so the after-manifest includes a final report,
    # but it predates the final manifest statistics.  Render and validate once
    # more from the now-final summary so HTML never contradicts summary-data.
    render_result = render_final_summary(work_dir, summary_path)
    if not render_result.get("ok"):
        payload["error"] = f"final summary re-render failed: {render_result.get('error')}"
        _restore_on_failure(archive_dir, original_change_dir, payload, warnings)
        return 1, payload
    validate_result = validate_summary(summary, html_path if html_path.is_file() else None)
    payload["steps"]["validate"] = validate_result
    summary.setdefault("reportPipeline", {})["validationIssues"] = validate_result.get("issues") or []
    write_json(summary_path, summary)

    # --- 7. delete original only if validate+manifest OK ---
    # After move, "original" is gone; on failure we restore. On success, ensure
    # the changes path does not linger.
    validate_ok = bool(validate_result.get("ok"))
    manifest_ok = bool(compare_result.get("ok"))
    can_close = validate_ok and manifest_ok

    if not can_close:
        issues_out = list(validate_result.get("issues") or [])
        if not manifest_ok:
            issues_out.append(
                {
                    "code": "manifest-mismatch",
                    "severity": "error",
                    "message": (
                        f"missing={compare_result.get('missing')} "
                        f"mismatched={compare_result.get('mismatched')}"
                    ),
                }
            )
        payload["issues"] = issues_out
        payload["error"] = "validate or manifest check failed; original change dir restored"
        payload["steps"]["delete_original"] = {"ok": False, "deleted": False}
        _restore_on_failure(archive_dir, original_change_dir, payload, warnings)
        _safe_append_restored = original_change_dir if original_change_dir.is_dir() else None
        if _safe_append_restored:
            try:
                append_event(
                    _safe_append_restored,
                    phase="archive",
                    type_="phase.end",
                    status="FAIL",
                    note="finalize aborted; original preserved",
                )
            except OSError:
                pass
        payload["warnings"] = warnings
        payload["ok"] = False
        return 1, payload

    # Success path: original already relocated; confirm absence
    if original_change_dir.exists():
        try:
            shutil.rmtree(original_change_dir)
            payload["steps"]["delete_original"] = {"ok": True, "deleted": True}
        except OSError as exc:
            warnings.append(f"could not remove leftover change dir: {exc}")
            payload["steps"]["delete_original"] = {"ok": False, "error": str(exc)}
    else:
        payload["steps"]["delete_original"] = {
            "ok": True,
            "deleted": True,
            "note": "removed by move",
        }

    _safe_append(
        phase="archive",
        type_="verification",
        name="archive-closure",
        status="ok",
        note="manifest+validate passed; original removed",
    )

    # --- 8. maintenance outbox + service (§8.2: close no longer runs the four
    # knowledge subprocesses; it enqueues a pending outbox item and returns) ---
    if skip_ingest:
        payload["steps"]["knowledge"] = {"skipped": True, "reason": "--skip-ingest"}
        payload["knowledgeMaintenance"] = "SKIPPED"
    else:
        try:
            enqueue = enqueue_maintenance_outbox(project_root, work_dir)
            payload["steps"]["knowledge"] = enqueue
            payload["knowledgeMaintenance"] = "QUEUED"
        except OSError as exc:
            warnings.append(f"maintenance outbox enqueue failed: {exc}")
            payload["steps"]["knowledge"] = {"queued": False, "error": str(exc)}
            payload["knowledgeMaintenance"] = "NOT_QUEUED"

    service_result = run_service_stop(work_dir)
    payload["steps"]["service_stop"] = service_result
    if service_result.get("warning"):
        warnings.append(str(service_result["warning"]))

    _safe_append(
        phase="archive",
        type_="phase.end",
        status="WARN" if warnings else "OK",
        note="finalize complete",
    )

    payload["ok"] = True
    payload["warnings"] = warnings
    payload["summary_data"] = str(summary_path)
    payload["final_summary"] = str(html_path) if html_path.is_file() else None
    return 0, payload


def _restore_on_failure(
    archive_dir: Path,
    original_change_dir: Path,
    payload: dict[str, Any],
    warnings: list[str],
) -> None:
    """Move archive back to changes path so validate errors never lose the original."""
    if original_change_dir.exists():
        # Already present (e.g. move never happened)
        payload["original_preserved"] = True
        # Clean partial archive if present and distinct
        if archive_dir.exists() and archive_dir.resolve() != original_change_dir.resolve():
            warnings.append(
                f"partial archive left at {archive_dir} (original also present)"
            )
        return
    if not archive_dir.exists():
        payload["original_preserved"] = False
        warnings.append("restore failed: neither archive nor original exists")
        return
    try:
        original_change_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(archive_dir), str(original_change_dir))
        payload["original_preserved"] = True
        payload["restored_to"] = str(original_change_dir)
    except OSError as exc:
        payload["original_preserved"] = False
        warnings.append(f"restore move failed: {exc}; data at {archive_dir}")


# ---------------------------------------------------------------------------
# replay
# ---------------------------------------------------------------------------


def cmd_replay(
    archive_dir: Path,
    *,
    out_path: Path | None = None,
) -> tuple[int, dict[str, Any]]:
    """Read-only collect + validate. Never mutates archive contents."""
    archive_dir = archive_dir.resolve()
    if not archive_dir.is_dir():
        return 1, {"ok": False, "error": f"archive dir not found: {archive_dir}"}

    # Collect without writing into the archive
    summary = collect_summary_data(archive_dir, write=False, for_replay=True)

    html_path = archive_dir / "reports" / "final" / "final-summary.html"
    render_skipped = not html_path.is_file()
    validate_result = validate_summary(
        summary,
        html_path if html_path.is_file() else None,
        render_skipped=render_skipped,
    )
    summary.setdefault("reportPipeline", {})["validationIssues"] = (
        validate_result.get("issues") or []
    )

    if out_path is not None:
        # Allowed to write outside the archive
        out_resolved = out_path.resolve()
        try:
            out_resolved.relative_to(archive_dir.resolve())
            inside = True
        except ValueError:
            inside = False
        if inside:
            return 1, {
                "ok": False,
                "error": "replay refuses to write inside archive dir (read-only)",
            }
        write_json(out_resolved, summary)

    payload = {
        "ok": validate_result.get("ok", False),
        "action": "replay",
        "archive_dir": str(archive_dir),
        "change_name": summary.get("changeName"),
        "summary_data": summary,
        "validate": validate_result,
        "sources": (summary.get("reportPipeline") or {}).get("sources") or [],
    }
    # Replay itself is successful as an operation even if validate finds issues;
    # exit non-zero only on hard failures. Soft: ok mirrors validate.
    return (0 if payload["ok"] else 1), payload


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def cmd_status_cli(args: argparse.Namespace) -> int:
    change_dir = resolve_path(args.change_dir)
    result = check_status(change_dir)
    emit_json(result)
    # Checks completed → exit 0; archivable flag conveys the gate result.
    return 0 if result.get("ok") else 1


def cmd_finalize_cli(args: argparse.Namespace) -> int:
    change_dir = resolve_path(args.change_dir)
    archive_root = resolve_path(args.archive_root)
    code, payload = cmd_finalize(
        change_dir,
        archive_root,
        skip_ingest=bool(args.skip_ingest),
    )
    emit_json(payload)
    return code


def cmd_replay_cli(args: argparse.Namespace) -> int:
    archive_dir = resolve_path(args.archive_dir)
    out_path = resolve_path(args.out) if getattr(args, "out", None) else None
    code, payload = cmd_replay(archive_dir, out_path=out_path)
    emit_json(payload)
    return code


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="harness_archive.py",
        description="Archive finalize / status / replay (D3)",
    )
    sub = parser.add_subparsers(dest="command_name", required=True)

    p_status = sub.add_parser("status", help="pre-archive gate checks (read-only)")
    p_status.add_argument("--change-dir", required=True)
    p_status.add_argument("--json", action="store_true", default=True)
    p_status.set_defaults(func=cmd_status_cli)

    p_fin = sub.add_parser("finalize", help="single-process archive finalize")
    p_fin.add_argument("--change-dir", required=True)
    p_fin.add_argument("--archive-root", required=True)
    p_fin.add_argument("--skip-ingest", action="store_true")
    p_fin.add_argument("--json", action="store_true", default=True)
    p_fin.set_defaults(func=cmd_finalize_cli)

    p_rep = sub.add_parser("replay", help="read-only re-collect + validate")
    p_rep.add_argument("--archive-dir", required=True)
    p_rep.add_argument("--out", default=None, help="write summary-data JSON outside archive")
    p_rep.add_argument("--json", action="store_true", default=True)
    p_rep.set_defaults(func=cmd_replay_cli)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
