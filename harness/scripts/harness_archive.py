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

SCHEMA_VERSION = "2.3"
NOT_AVAILABLE = "not_available"

# Compiled once for evidence-text count fallbacks in _ledger_unit_tests / _ledger_api_tests.
_RE_UNIT_COUNTS = re.compile(
    r"Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)"
)
_RE_API_PASSED = re.compile(r"(\d+)/(\d+)\s*passed", re.I)

# Ensure sibling harness_events is importable.
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_events as he  # noqa: E402
import harness_ledger as hl  # noqa: E402
import harness_paths as hp  # noqa: E402
import harness_review as hr  # noqa: E402


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


def load_ci_metrics(change_dir: Path) -> tuple[dict[str, Any] | None, str | None]:
    """Load schema-versioned runner metrics without parsing human CI logs."""
    for relative in ("evidence/ci-metrics.json", "runtime/ci-metrics.json"):
        path = change_dir / relative
        if not path.is_file():
            continue
        value = read_json(path)
        if value.get("schemaVersion") != 1:
            raise ValueError(f"unsupported ci-metrics schema: {path}")
        return value, relative
    return None, None


def load_product_candidate_ci(change_dir: Path) -> dict[str, Any] | None:
    """Load structured product-candidate CI evidence (IA-1). Fail closed if absent."""
    for relative in (
        "evidence/product-candidate-ci.json",
        "meta/product-candidate-ci.json",
        "runtime/product-candidate-ci.json",
    ):
        path = change_dir / relative
        if not path.is_file():
            continue
        try:
            data = read_json(path)
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(data, dict) and data.get("schemaVersion") == 1:
            return data
    ledger = load_ledger(change_dir) or {}
    for key in ("productCandidateCi", "product_candidate_ci"):
        value = ledger.get(key)
        if isinstance(value, dict):
            return {"schemaVersion": 1, **value}
    validations = ledger.get("validations") if isinstance(ledger.get("validations"), dict) else {}
    for key in ("productCandidateCi", "product_candidate_ci", "candidateCi"):
        value = validations.get(key) if isinstance(validations, dict) else None
        if isinstance(value, dict):
            return {"schemaVersion": 1, **value}
    return None


def evaluate_product_ci_gate(change_dir: Path) -> dict[str, Any]:
    """Hard gate: product candidate CI must be success with run URL + commit."""
    evidence = load_product_candidate_ci(change_dir)
    if evidence is None:
        return {
            "ok": False,
            "code": "PRODUCT_CI_NOT_GREEN",
            "message": (
                "missing product-candidate CI evidence "
                "(need evidence/product-candidate-ci.json with conclusion=success, "
                "runUrl, commit)"
            ),
            "evidence": None,
        }
    conclusion = str(
        evidence.get("conclusion") or evidence.get("status") or ""
    ).strip().lower()
    run_url = str(evidence.get("runUrl") or evidence.get("url") or "").strip()
    commit = str(evidence.get("commit") or evidence.get("headSha") or "").strip()
    if conclusion in {"success", "successful", "passed", "pass", "green", "ok"}:
        # Review Y1: success alone is insufficient — runUrl + commit are required.
        if not run_url or not commit:
            return {
                "ok": False,
                "code": "PRODUCT_CI_NOT_GREEN",
                "message": (
                    "product candidate CI conclusion is success but missing "
                    f"runUrl={run_url or 'empty'} commit={commit or 'empty'}"
                ),
                "evidence": evidence,
            }
        return {
            "ok": True,
            "code": "PRODUCT_CI_GREEN",
            "message": f"product candidate CI green commit={commit} url={run_url}",
            "evidence": evidence,
        }
    return {
        "ok": False,
        "code": "PRODUCT_CI_NOT_GREEN",
        "message": (
            f"product candidate CI conclusion={conclusion or 'unknown'} "
            f"commit={commit or 'unknown'} runUrl={run_url or 'unknown'}"
        ),
        "evidence": evidence,
    }


PRODUCT_TREE_HASH_FILE_LIMIT = 20_000


def compute_product_tree_hash_detail(
    project: Path,
    *,
    file_limit: int = PRODUCT_TREE_HASH_FILE_LIMIT,
) -> dict[str, Any]:
    """Hash product tree excluding .harness/**; report truncation metadata (Y3)."""
    project = project.resolve()
    skip_dirs = {
        ".harness",
        ".git",
        ".worktrees",
        "node_modules",
        ".next",
        "dist",
        "coverage",
        "__pycache__",
        ".venv",
        "venv",
    }
    limit = max(1, int(file_limit))
    lines: list[str] = []
    truncated = False
    for root, dirs, files in os.walk(project, onerror=lambda _exc: None):
        dirs[:] = [name for name in dirs if name not in skip_dirs]
        for name in sorted(files):
            path = Path(root) / name
            try:
                rel = path.relative_to(project).as_posix()
            except ValueError:
                continue
            try:
                digest = sha256_file(path)
            except OSError:
                continue
            lines.append(f"{rel}:{digest}")
            if len(lines) >= limit:
                truncated = True
                break
        if truncated:
            break
    digest = hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()
    return {
        "hash": digest,
        "truncated": truncated,
        "fileCount": len(lines),
        "limit": limit,
    }


def compute_product_tree_hash(
    project: Path,
    *,
    file_limit: int = PRODUCT_TREE_HASH_FILE_LIMIT,
) -> str:
    """Hash product tree excluding .harness/** governance paths."""
    return str(compute_product_tree_hash_detail(project, file_limit=file_limit)["hash"])


def resolve_product_archive_identity(
    change_dir: Path,
    *,
    project: Path | None = None,
    product_commit: str | None = None,
    archive_commit: str | None = None,
) -> dict[str, Any]:
    """Resolve the three-way archive identity fields for summary/meta."""
    change_dir = change_dir.resolve()
    project_root = (project or find_project_root(change_dir)).resolve()
    ledger = load_ledger(change_dir) or {}
    ci = load_product_candidate_ci(change_dir) or {}
    product = (
        product_commit
        or ledger.get("productCommit")
        or ci.get("commit")
        or ledger.get("finalCommit")
        or ""
    )
    archive = (
        archive_commit
        or ledger.get("archiveCommit")
        or ledger.get("finalCommit")
        or product
    )
    tree = str(ledger.get("productTreeHash") or "")
    under_harness = False
    try:
        change_dir.relative_to(project_root / ".harness")
        under_harness = True
    except ValueError:
        under_harness = False
    tree_meta: dict[str, Any] = {
        "truncated": False,
        "fileCount": 0,
        "limit": PRODUCT_TREE_HASH_FILE_LIMIT,
    }
    if not tree:
        if under_harness:
            try:
                tree_meta = compute_product_tree_hash_detail(project_root)
                tree = str(tree_meta["hash"])
            except OSError:
                tree = hashlib.sha256(b"").hexdigest()
        else:
            # Bare temp fixtures are not real project roots — avoid scanning up-tree.
            tree = hashlib.sha256(b"fixture-no-product-tree").hexdigest()
    identity = {
        "productCommit": str(product),
        "productTreeHash": str(tree),
        "archiveCommit": str(archive),
        "productTreeHashTruncated": bool(tree_meta.get("truncated")),
        "productTreeHashFileCount": int(tree_meta.get("fileCount") or 0),
    }
    expected_tree = tree
    if under_harness:
        try:
            expected_meta = compute_product_tree_hash_detail(project_root)
            expected_tree = str(expected_meta["hash"])
            identity["productTreeHashTruncated"] = bool(expected_meta.get("truncated"))
            identity["productTreeHashFileCount"] = int(expected_meta.get("fileCount") or 0)
        except OSError:
            expected_tree = tree
    identity["validation"] = validate_product_identity(
        product_commit=identity["productCommit"],
        product_tree_hash=identity["productTreeHash"],
        archive_commit=identity["archiveCommit"] or "unknown",
        project=project_root if under_harness else None,
        expected_tree_hash=expected_tree if under_harness else tree,
    )
    return identity


def validate_product_identity(
    *,
    product_commit: str,
    product_tree_hash: str,
    archive_commit: str,
    project: Path | None = None,
    expected_tree_hash: str | None = None,
) -> dict[str, Any]:
    """Validate productCommit/productTreeHash/archiveCommit relationship."""
    if not product_commit or not product_tree_hash or not archive_commit:
        return {
            "ok": False,
            "code": "PRODUCT_IDENTITY_INCOMPLETE",
            "message": "productCommit, productTreeHash, and archiveCommit are required",
        }
    expected = expected_tree_hash
    if expected is None and project is not None:
        expected = compute_product_tree_hash(project)
    if expected is not None and str(product_tree_hash) != str(expected):
        return {
            "ok": False,
            "code": "PRODUCT_TREE_HASH_MISMATCH",
            "message": (
                f"productTreeHash={product_tree_hash} does not match "
                f"product tree={expected} for productCommit={product_commit}"
            ),
            "expected": expected,
            "actual": product_tree_hash,
        }
    return {
        "ok": True,
        "code": "PRODUCT_IDENTITY_OK",
        "productCommit": product_commit,
        "productTreeHash": product_tree_hash,
        "archiveCommit": archive_commit,
    }


def evaluate_release_evidence(
    archived_identity: dict[str, Any],
    *,
    current_product_tree_hash: str,
) -> dict[str, Any]:
    """Old archive cannot remain release evidence after product inputs change."""
    archived_tree = str(archived_identity.get("productTreeHash") or "")
    if not archived_tree:
        return {
            "ok": False,
            "code": "ARCHIVE_EVIDENCE_REOPEN_REQUIRED",
            "message": "archived productTreeHash missing; reopen required",
        }
    if archived_tree != str(current_product_tree_hash):
        return {
            "ok": False,
            "code": "ARCHIVE_EVIDENCE_REOPEN_REQUIRED",
            "message": (
                "product inputs changed since archive; "
                f"archivedTree={archived_tree} currentTree={current_product_tree_hash}"
            ),
            "archivedProductTreeHash": archived_tree,
            "currentProductTreeHash": current_product_tree_hash,
        }
    return {
        "ok": True,
        "code": "ARCHIVE_EVIDENCE_CURRENT",
        "productTreeHash": archived_tree,
    }


def build_workflow_timing(
    events: list[dict[str, Any]],
    *,
    report_cutoff_at: str | None = None,
) -> dict[str, Any]:
    """Formal multi-semantic timing object (IA-2 / IA-6)."""
    stamps = [e.get("timestamp") for e in events if e.get("timestamp")]
    started = str(stamps[0]) if stamps else None
    cutoff = report_cutoff_at or (str(stamps[-1]) if stamps else None)
    stage_active = 0
    stage_wall = 0
    unclosed = 0
    for _phase, phase_events in he.group_events_by_phase(events):
        timing = he.canonical_phase_timing(phase_events, cutoff_ts=cutoff)
        stage_active += int(timing.get("activeExecutionMs") or 0)
        stage_wall += int(timing.get("wallClockSpanMs") or 0)
        unclosed += int(timing.get("unclosedAttemptCount") or 0)
    workflow_wall = he.duration_ms_between(started, cutoff) if started and cutoff else 0
    external = 0
    for event in events:
        etype = str(event.get("type") or "").lower()
        if etype in {"external.wait", "ci.wait", "environment.wait", "env.wait"}:
            dur = event.get("duration_ms") or event.get("durationMs")
            if isinstance(dur, int):
                external += max(0, dur)
            elif event.get("timestamp") and event.get("endedAt"):
                gap = he.duration_ms_between(event.get("timestamp"), event.get("endedAt"))
                if gap:
                    external += gap
    unattributed = max(0, int(workflow_wall or 0) - stage_active - external)
    post_archive_excluded = 0
    if cutoff:
        for event in events:
            if str(event.get("phase") or "").lower() != "archive":
                continue
            ts = event.get("timestamp")
            if ts and he.duration_ms_between(cutoff, ts) and he.duration_ms_between(cutoff, ts) > 0:
                # timestamp after cutoff
                start_dt = he.parse_timestamp(cutoff)
                end_dt = he.parse_timestamp(ts)
                if start_dt and end_dt and end_dt > start_dt:
                    post_archive_excluded += 1
    return {
        "workflowStartedAt": started or NOT_AVAILABLE,
        "reportCutoffAt": cutoff or NOT_AVAILABLE,
        "workflowWallClockMs": int(workflow_wall or 0),
        "stageActiveExecutionMs": int(stage_active),
        "stageWallClockSpanMs": int(stage_wall),
        "externalWaitMs": int(external),
        "agentOrToolUnattributedMs": int(unattributed),
        "unclosedAttemptCount": int(unclosed),
        "postArchiveEventsExcluded": int(post_archive_excluded),
        "totalMinutesSemantics": "active-only",
    }


def verify_manifest_byte_coverage(
    root: Path,
    manifest: dict[str, Any],
    *,
    exclude_paths: list[str] | None = None,
    exclusion_reasons: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Verify every covered manifest entry still matches on-disk bytes (IA-7)."""
    root = root.resolve()
    excluded = {
        p.replace("\\", "/") for p in (exclude_paths or [])
    }
    reasons = {
        k.replace("\\", "/"): v for k, v in (exclusion_reasons or {}).items()
    }
    mismatches: list[dict[str, str]] = []
    checked = 0
    for item in manifest.get("files") or []:
        if not isinstance(item, dict):
            continue
        rel = str(item.get("path") or "").replace("\\", "/")
        if not rel or _manifest_path_excluded(rel):
            continue
        if rel in excluded:
            reasons.setdefault(rel, "excluded from checksum coverage")
            continue
        path = root / rel
        if not path.is_file():
            mismatches.append({"path": rel, "reason": "missing"})
            continue
        actual = sha256_file(path)
        expected = str(item.get("sha256") or "")
        checked += 1
        if actual != expected:
            mismatches.append(
                {
                    "path": rel,
                    "reason": "hash-mismatch",
                    "expected": expected,
                    "actual": actual,
                }
            )
    ok = not mismatches
    if ok and reasons:
        checksum_status = "OK_WITH_EXCLUSIONS"
    elif ok:
        checksum_status = "OK"
    else:
        checksum_status = "FAIL"
    return {
        "ok": ok,
        "checksumStatus": checksum_status,
        "checked": checked,
        "mismatched": mismatches,
        "exclusionReasons": reasons,
    }

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


def check_archive_exact_byte_policy(project_root: Path) -> dict[str, Any]:
    """Verify frozen archive paths are exempt from Git text conversion."""
    required_rule = ".harness/archive/** -text"
    attributes_path = project_root / ".gitattributes"
    rules: list[str] = []
    if attributes_path.is_file():
        try:
            rules = [
                line.strip()
                for line in attributes_path.read_text(encoding="utf-8-sig").splitlines()
                if line.strip() and not line.lstrip().startswith("#")
            ]
        except OSError:
            rules = []
    matching = []
    for rule in rules:
        fields = rule.split()
        if not fields or fields[0] != ".harness/archive/**":
            continue
        matching.append(rule)
        if "-text" in fields[1:] or "binary" in fields[1:]:
            return {
                "ok": True,
                "path": str(attributes_path),
                "requiredRule": required_rule,
                "matchedRule": rule,
            }
    return {
        "ok": False,
        "path": str(attributes_path),
        "requiredRule": required_rule,
        "matchedRules": matching,
        "remediation": f"add this exact-byte rule to .gitattributes: {required_rule}",
    }


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------


def check_status(
    change_dir: Path,
    *,
    allow_missing_review: bool = False,
) -> dict[str, Any]:
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

    exact_byte = check_archive_exact_byte_policy(project)
    checks["archive_exact_byte"] = exact_byte
    if not exact_byte["ok"]:
        warnings.append(
            {
                "code": "archive-exact-byte-policy-missing",
                "message": str(exact_byte["remediation"]),
            }
        )

    # --- H-4 formal-layer minimum set ---
    plans_dir = change_dir / "plans"
    plan_files = (
        sorted(plans_dir.glob("*-plan.md")) if plans_dir.is_dir() else []
    )
    checks["plan_files"] = [str(p.relative_to(change_dir)) for p in plan_files]
    if not plan_files:
        blockers.append(
            {
                "code": "missing-plan",
                "message": "plans/*-plan.md is required before archive",
            }
        )

    events_path = change_dir / "events.ndjson"
    events_present = events_path.is_file() and events_path.stat().st_size > 0
    checks["events_ndjson"] = events_present
    if not events_present:
        blockers.append(
            {
                "code": "missing-events",
                "message": "events.ndjson is required and must be non-empty",
            }
        )

    ledger = load_ledger(change_dir)
    checks["verification_ledger"] = ledger is not None
    if ledger is None:
        blockers.append(
            {
                "code": "missing-verification-ledger",
                "message": "evidence/verification-ledger.json is required before archive",
            }
        )

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
    if ledger is None:
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
    events = he.load_events(events_path) if events_path.is_file() else []
    review_ran = review_evidence_present(change_dir, events)

    checks["test_reports"] = [str(p.relative_to(change_dir)) for p in test_reports]
    checks["review_reports"] = [str(p.relative_to(change_dir)) for p in review_reports]

    # H-4 min blockers are plan/events/ledger only. Missing test/review evidence
    # remains a warning so archive-before-review stays possible (advisory).
    if not test_reports and not review_reports and not review_ran:
        warnings.append(
            {
                "code": "missing-test-or-review-report",
                "message": (
                    "no test report or review evidence yet; prefer completing "
                    "test/review before archive (not a hard blocker)"
                ),
            }
        )

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

    gate_policy = load_gate_policy(change_dir)
    risk_tier = str((gate_policy or {}).get("tier") or "unknown")
    checks["riskTier"] = risk_tier

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
        review_msg = {
            "code": "review-not-run",
            "message": "no review report; mark reviewSummary as ADVISORY_NOT_RUN",
        }
        warnings.append(review_msg)
        if risk_tier == "full" and not review_ran:
            tier_issue = {
                "code": "review-required-on-full-tier",
                "message": (
                    "gate-policy tier=full requires review evidence; "
                    "pass --allow-missing-review to override"
                ),
            }
            if allow_missing_review:
                warnings.append(tier_issue)
            else:
                blockers.append(tier_issue)

    # --- IA-1 product candidate CI hard gate ---
    ci_gate = evaluate_product_ci_gate(change_dir)
    checks["product_candidate_ci"] = {
        "ok": bool(ci_gate.get("ok")),
        "code": ci_gate.get("code"),
        "evidence": ci_gate.get("evidence"),
    }
    if not ci_gate.get("ok"):
        blockers.append(
            {
                "code": "PRODUCT_CI_NOT_GREEN",
                "message": str(ci_gate.get("message") or "product candidate CI not green"),
            }
        )

    # --- artifact preflight (retro §5.31) ---
    # Classify artifact events before destructive finalize: informational (OK),
    # canonicalizable (same-change repo-relative path, warning), or blocking
    # (cross-change/absolute/escaping path, fail closed).
    try:
        preflight = artifact_preflight(change_dir)
    except Exception as exc:  # noqa: BLE001 — preflight must not crash status
        preflight = {"ok": False, "items": [], "blocking": [], "error": str(exc)}
    checks["artifact_preflight"] = preflight
    for item in preflight.get("blocking") or []:
        blockers.append({
            "code": "artifact-path-blocking",
            "message": (
                f"artifact event {item.get('eventId', '')} path "
                f"{item.get('path', '')}: {item.get('reason', 'blocking')}"
            ),
        })
    for item in preflight.get("items") or []:
        if item.get("category") == "canonicalizable":
            warnings.append({
                "code": "artifact-path-canonicalizable",
                "message": (
                    f"artifact event {item.get('eventId', '')} path "
                    f"{item.get('path', '')} is repo-relative; "
                    f"canonical={item.get('canonicalPath', '')}"
                ),
            })

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
    unit = (
        validations.get("unitTestFull")
        or validations.get("unitTest")
        or validations.get("unitTests")
        or {}
    )
    if not isinstance(unit, dict):
        return empty
    status = str(unit.get("status") or "").upper()

    run = failures = errors = skipped = 0
    passed_count: int | None = None
    pass_rate: Any = None
    source = "committed"
    counted = False

    metrics = unit.get("metrics")
    if isinstance(metrics, dict) and any(
        k in metrics
        for k in (
            "run",
            "testsRun",
            "total",
            "passed",
            "failed",
            "failures",
            "errors",
            "skipped",
        )
    ):
        if "total" in metrics:
            # ledger v3 typed metrics (UT-005/RET-15): total/passed/failed.
            run = int(metrics.get("total", 0) or 0)
        elif "run" in metrics or "testsRun" in metrics:
            run = int(metrics.get("run", metrics.get("testsRun", 0)) or 0)
        else:
            run = sum(
                int(metrics.get(key, 0) or 0)
                for key in ("passed", "failed", "errors", "skipped")
            )
        failures = int(metrics.get("failed", metrics.get("failures", 0)) or 0)
        errors = int(metrics.get("errors", 0) or 0)
        skipped = int(metrics.get("skipped", 0) or 0)
        if "passed" in metrics:
            passed_count = int(metrics.get("passed", 0) or 0)
        pass_rate = metrics.get("passRate")
        source = "committed"
        counted = run > 0 or failures > 0 or errors > 0 or skipped > 0

    evidence = unit.get("evidence")
    if not counted and isinstance(evidence, dict):
        run = int(
            evidence.get(
                "run",
                evidence.get("testsRun", unit.get("run", unit.get("testsRun", 0))),
            )
            or 0
        )
        failures = int(evidence.get("failures", unit.get("failures", 0)) or 0)
        errors = int(evidence.get("errors", unit.get("errors", 0)) or 0)
        skipped = int(evidence.get("skipped", unit.get("skipped", 0)) or 0)
        pass_rate = evidence.get("passRate") or unit.get("passRate")
        source = "committed"
        counted = run > 0 or failures > 0 or errors > 0 or skipped > 0

    evidence_text = evidence if isinstance(evidence, str) else ""
    if not counted and evidence_text:
        matches = list(_RE_UNIT_COUNTS.finditer(evidence_text))
        if matches:
            m = matches[-1]
            run = int(m.group(1))
            failures = int(m.group(2))
            errors = int(m.group(3))
            skipped = int(m.group(4))
            source = "evidence-text"
            counted = True

    if not counted:
        run = int(unit.get("run", unit.get("testsRun", 0)) or 0)
        failures = int(unit.get("failures", 0) or 0)
        errors = int(unit.get("errors", 0) or 0)
        skipped = int(unit.get("skipped", 0) or 0)
        pass_rate = unit.get("passRate")
        source = "committed"

    if status in {"NOT_RUN", "SKIPPED", "USER_SKIPPED"}:
        source = "not-run"
    elif str(unit.get("reused") or "").lower() in {"true", "1"} or "REUSED" in status:
        source = "committed"

    if pass_rate is None:
        passed = (
            passed_count
            if passed_count is not None
            else max(int(run or 0) - int(failures or 0) - int(errors or 0) - int(skipped or 0), 0)
        )
        # H-13: passRate denominator excludes skipped.
        denom = int(passed) + int(failures or 0) + int(errors or 0)
        if denom > 0:
            pass_rate = f"{passed / denom:.0%}"
        else:
            pass_rate = NOT_AVAILABLE

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


def _ledger_api_tests(
    ledger: dict[str, Any] | None,
    *,
    change_dir: Path | None = None,
) -> dict[str, Any]:
    empty = {
        "status": "NOT_RUN",
        "total": 0,
        "passed": 0,
        "failed": 0,
        "blocked": 0,
        "passRate": NOT_AVAILABLE,
        "source": "not-run",
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

    total = passed = failed = blocked = 0
    pass_rate: Any = None
    source = "committed"
    counted = False

    metrics = api.get("metrics")
    if isinstance(metrics, dict) and any(
        k in metrics for k in ("total", "passed", "failed", "blocked")
    ):
        passed = int(metrics.get("passed", 0) or 0)
        failed = int(metrics.get("failed", 0) or 0)
        blocked = int(metrics.get("blocked", 0) or 0)
        total = int(metrics.get("total", passed + failed + blocked) or 0)
        pass_rate = metrics.get("passRate")
        source = "committed"
        counted = total > 0 or passed > 0 or failed > 0 or blocked > 0

    evidence_raw = api.get("evidence")
    if not counted and isinstance(evidence_raw, dict):
        total = int(evidence_raw.get("total", api.get("total", 0)) or 0)
        passed = int(evidence_raw.get("passed", api.get("passed", 0)) or 0)
        failed = int(evidence_raw.get("failed", api.get("failed", 0)) or 0)
        blocked = int(evidence_raw.get("blocked", api.get("blocked", 0)) or 0)
        pass_rate = evidence_raw.get("passRate") or api.get("passRate")
        source = "committed"
        counted = total > 0 or passed > 0 or failed > 0 or blocked > 0

    evidence_text = evidence_raw if isinstance(evidence_raw, str) else ""
    if not counted and evidence_text:
        matches = list(_RE_API_PASSED.finditer(evidence_text))
        if matches:
            m = matches[-1]
            passed = int(m.group(1))
            total = int(m.group(2))
            failed = max(total - passed, 0)
            blocked = 0
            source = "evidence-text"
            counted = True

    if not counted and change_dir is not None:
        results_path = change_dir / "runtime" / "api-test-results.json"
        if results_path.is_file():
            try:
                raw = read_json(results_path)
            except (OSError, json.JSONDecodeError):
                raw = None
            if isinstance(raw, dict) and all(
                isinstance(raw.get(k), int) for k in ("total", "passed", "failed", "blocked")
            ):
                total = int(raw["total"])
                passed = int(raw["passed"])
                failed = int(raw["failed"])
                blocked = int(raw["blocked"])
                source = "api-test-results"
                counted = True

    if not counted:
        total = int(api.get("total", 0) or 0)
        passed = int(api.get("passed", 0) or 0)
        failed = int(api.get("failed", 0) or 0)
        blocked = int(api.get("blocked", 0) or 0)
        pass_rate = api.get("passRate")
        source = "committed"

    if pass_rate is None and total > 0:
        pass_rate = f"{passed / total:.0%}"
    elif pass_rate is None:
        pass_rate = NOT_AVAILABLE

    return {
        "status": status,
        "total": int(total or 0),
        "passed": int(passed or 0),
        "failed": int(failed or 0),
        "blocked": int(blocked or 0),
        "passRate": pass_rate if pass_rate is not None else NOT_AVAILABLE,
        "source": source,
    }


def _risks_from_test_results(change_dir: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """PARTIAL/OPEN/UNKNOWN/DEFERRED scenarios -> (knownRisks, manualActions).

    Scenario IDs are preserved so risks stay traceable to the test report
    (UT-013/RET-25); PARTIAL is a fact, not a pass.
    """
    risk_statuses = {"PARTIAL", "OPEN", "UNKNOWN", "DEFERRED", "BLOCKED"}
    results_path = change_dir / "runtime" / "api-test-results.json"
    if not results_path.is_file():
        return [], []
    try:
        raw = read_json(results_path)
    except (OSError, json.JSONDecodeError):
        return [], []
    scenarios = raw.get("scenarios") if isinstance(raw, dict) else None
    if not isinstance(scenarios, list):
        return [], []
    risks: list[dict[str, Any]] = []
    actions: list[dict[str, Any]] = []
    for item in scenarios:
        if not isinstance(item, dict):
            continue
        status = str(item.get("status") or "").upper()
        if status not in risk_statuses:
            continue
        scenario_id = str(item.get("id") or item.get("scenario") or "").strip()
        note = str(item.get("note") or item.get("message") or "").strip()
        risks.append(
            {
                "phase": "test",
                "severity": "medium",
                "scenarioId": scenario_id,
                "status": status,
                "message": f"{scenario_id}: {status}" + (f" — {note}" if note else ""),
            }
        )
        actions.append(
            {
                "stage": "test",
                "status": status,
                "scenarioId": scenario_id,
                "action": "补齐该场景的完整验证或显式接受风险",
            }
        )
    return risks, actions


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


def _typed_test_metrics(entry: dict[str, Any], *, total_key: str) -> dict[str, Any]:
    """Project a ledger v3 typed metrics entry to the canonical view."""
    metrics = entry.get("metrics") if isinstance(entry.get("metrics"), dict) else {}
    total = int(metrics.get(total_key, 0) or 0)
    passed = int(metrics.get("passed", 0) or 0)
    failed = int(metrics.get("failed", 0) or 0)
    status = str(entry.get("status") or "").upper() or "NOT_RUN"
    out: dict[str, Any] = {
        "status": status,
        "total": total,
        "passed": passed,
        "failed": failed,
        "passRate": f"{passed / total:.0%}" if total > 0 else NOT_AVAILABLE,
        "source": "committed" if total > 0 else "not-run",
    }
    if "blocked" in metrics:
        out["blocked"] = int(metrics.get("blocked", 0) or 0)
    if "skipped" in metrics:
        out["skipped"] = int(metrics.get("skipped", 0) or 0)
    applicability = entry.get("applicability")
    if isinstance(applicability, dict):
        out["applicability"] = applicability
    return out


def build_verification_projection(
    ledger: dict[str, Any] | None,
    *,
    change_dir: Path | None = None,
) -> dict[str, Any]:
    """Canonical verification view shared by collector and validators (RET-16).

    apiContract and browserE2E are distinct typed projections; the legacy
    apiTests mapping is retained for schema compatibility.
    """
    validations = (ledger or {}).get("validations") or {}
    projection: dict[str, Any] = {
        "unitTests": _ledger_unit_tests(ledger),
        "apiTests": _ledger_api_tests(ledger, change_dir=change_dir),
        "dbCompatibility": _ledger_db_compat(ledger),
    }
    api_contract = validations.get("apiContract")
    if isinstance(api_contract, dict):
        projection["apiContract"] = _typed_test_metrics(
            api_contract, total_key="scenariosTotal"
        )
    browser_e2e = validations.get("browserE2E")
    if isinstance(browser_e2e, dict):
        projection["browserE2E"] = _typed_test_metrics(browser_e2e, total_key="total")
    return projection


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


def _durations_from_event_phases(
    event_summary: dict[str, Any],
    events: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    # Canonical per-phase timing (UT-008/RET-20): one reducer feeds every view.
    # totalMinutes remains active-only (IA-2); use top-level timing for wall clock.
    cutoff = None
    if events:
        stamps = [e.get("timestamp") for e in events if e.get("timestamp")]
        cutoff = str(stamps[-1]) if stamps else None
    canonical: dict[str, dict[str, Any]] = {}
    if events:
        for phase_name, phase_events in he.group_events_by_phase(events):
            canonical[phase_name] = he.canonical_phase_timing(
                phase_events, cutoff_ts=cutoff
            )
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
        stage: dict[str, Any] = {
            "stage": str(name),
            "skill": f"harness-{name}",
            "startedAt": info.get("started_at") or NOT_AVAILABLE,
            "endedAt": info.get("ended_at") or NOT_AVAILABLE,
            "minutes": minutes,
            "minutesSemantics": "active-only",
            "result": result,
            "attempts": attempts,
        }
        timing = canonical.get(name)
        if timing:
            stage["activeExecutionMs"] = timing.get("activeExecutionMs")
            stage["wallClockSpanMs"] = timing.get("wallClockSpanMs")
            stage["lateEventCount"] = timing.get("lateEventCount")
            stage["unclosedAttemptCount"] = timing.get("unclosedAttemptCount")
        stages.append(stage)
    total_min = round(total_ms / 60000, 2)
    return {
        "totalLabel": f"约 {int(round(total_min))} 分（活动执行）",
        "totalMinutes": total_min,
        "totalMinutesSemantics": "active-only",
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
    projected_events = he.apply_event_corrections(events)
    for event in projected_events:
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
    # Issues in events can downgrade. H-14: informational / hygiene / agent-preflight
    # notes must not downgrade an already-OK phase.end.
    _informational_markers = (
        "[archive-hygiene]",
        "informational",
        "custom_agents_unsupported",
        "definition_not_found_host_capable",
        "知识查询",
        "knowledge query",
        "harness-explorer",
        "harness-evaluator",
        "委派",
    )
    for e in he.current_issues(events):
        sev = str(e.get("severity") or "").lower()
        issue_text = " ".join(str(e.get(key) or "") for key in ("message", "note", "code")).lower()
        if not sev:
            if any(token in issue_text for token in ("fail", "error", "blocked", "失败", "阻塞")):
                sev = "error"
            elif any(token in issue_text for token in ("warn", "skip", "风险", "警告")):
                sev = "warn"
        if sev in {"warn", "warning"} and any(m in issue_text for m in _informational_markers):
            continue
        if sev in {"", "info", "note", "informational"}:
            continue
        phase = str(e.get("phase") or "").lower()
        if phase in status and sev in {"error", "fail", "failed", "critical"}:
            status[phase] = "FAIL"
        elif phase in status and sev in {"warn", "warning"} and status[phase] == "OK":
            status[phase] = "WARN"

    api = _ledger_api_tests(ledger, change_dir=change_dir)
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

    if not review_evidence_present(change_dir, projected_events):
        status["review"] = "ADVISORY"

    return status


def _compute_final_status(
    stage_status: dict[str, str],
    verification: dict[str, Any],
) -> tuple[str, list[str]]:
    api = verification.get("apiTests") or {}
    db = str(verification.get("dbCompatibility") or "")
    api_status = str(api.get("status") or "")
    reasons: list[str] = []
    for phase, v in stage_status.items():
        if v == "FAIL":
            return "FAIL", [f"stage {phase}=FAIL"]
    unit = verification.get("unitTests") or {}
    if int(unit.get("failures") or 0) > 0:
        return "FAIL", [f"unitTests.failures={unit.get('failures')}"]
    if int(unit.get("errors") or 0) > 0:
        return "FAIL", [f"unitTests.errors={unit.get('errors')}"]
    if int(api.get("failed") or 0) > 0:
        return "FAIL", [f"apiTests.failed={api.get('failed')}"]
    conditional = {
        "USER_SKIPPED", "BLOCKED", "BLOCKED_BY_ENV", "BLOCKED_BY_DBA",
        "NOT_RUN", "PARTIAL",
    }
    if api_status in conditional:
        reasons.append(f"apiTests.status={api_status}")
    if db in conditional:
        reasons.append(f"dbCompatibility={db}")
    if reasons:
        return "CONDITIONAL_OK", reasons
    for phase, v in stage_status.items():
        if v == "WARN":
            return "WARN", [f"stage {phase}=WARN"]
        if v in conditional:
            return "CONDITIONAL_OK", [f"stage {phase}={v}"]
    return "OK", []


def load_gate_policy(change_dir: Path) -> dict[str, Any] | None:
    path = change_dir / "meta" / "gate-policy.json"
    if not path.is_file():
        return None
    try:
        data = read_json(path)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or data.get("schemaVersion") != 1:
        return None
    return data


_RISK_SEVERITIES = frozenset({"warning", "error", "critical"})


def _cleanup_transients(work_dir: Path) -> dict[str, Any]:
    """Delete lock/pid/launcher/credential files; truncate oversized logs."""
    deleted: list[str] = []
    truncated: list[dict[str, Any]] = []

    def _rel(path: Path) -> str:
        try:
            return path.relative_to(work_dir).as_posix()
        except ValueError:
            return str(path)

    lock = work_dir / "events.ndjson.lock"
    if lock.is_file():
        try:
            lock.unlink()
            deleted.append(_rel(lock))
        except OSError:
            pass

    runtime = work_dir / "runtime"
    if runtime.is_dir():
        for path in sorted(runtime.iterdir()):
            if not path.is_file():
                continue
            name = path.name
            drop = False
            if name.endswith(".pid"):
                drop = True
            elif name in {
                "_harness_service_launcher.py",
                "_harness_service.command.txt",
            }:
                drop = True
            elif re.search(r"credential|token|secret", name, re.I):
                drop = True
            if drop:
                try:
                    path.unlink()
                    deleted.append(_rel(path))
                except OSError:
                    pass

    logs_root = work_dir / "logs"
    if logs_root.is_dir():
        for path in sorted(logs_root.rglob("*.log")):
            if not path.is_file():
                continue
            try:
                size = path.stat().st_size
            except OSError:
                continue
            if size <= 65536:
                continue
            try:
                with path.open("rb") as handle:
                    handle.seek(-65536, 2)
                    tail = handle.read()
                header = (
                    f"# [truncated by harness-archive finalize: original {size} bytes]\n"
                ).encode("utf-8")
                path.write_bytes(header + tail)
                truncated.append({"path": _rel(path), "originalBytes": size})
            except OSError:
                pass

    return {"deleted": deleted, "truncated": truncated}


def write_archive_meta(work_dir: Path, summary: dict[str, Any]) -> Path:
    """Generate meta/archive-meta.md from summary-data (single ownership)."""
    archive_id = work_dir.name
    change_name = str(summary.get("changeName") or work_dir.name)
    archived_at = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    final_status = str(summary.get("finalStatus") or "UNKNOWN")
    lines = [
        "---",
        f"archive-id: {archive_id}",
        f"change-name: {change_name}",
        f"archived-at: {archived_at}",
        f"final-commit: {summary.get('finalCommit') or ''}",
        f"base-commit: {summary.get('baseCommit') or ''}",
        f"final-status: {final_status}",
        "source: harness-archive",
        "---",
        f"# 归档元数据 — {change_name}",
        "",
        "## 阶段状态",
        "",
        "| 阶段 | 状态 |",
        "|---|---|",
    ]
    for stage, status in (summary.get("stageStatus") or {}).items():
        lines.append(f"| {stage} | {status} |")
    lines.extend(["", "## 变更文件", "", "| 路径 | + | - |", "|---|---|---|"])
    changed = summary.get("changedFiles") or []
    if changed:
        for item in changed:
            lines.append(
                f"| {item.get('path') or ''} | "
                f"{item.get('insertions', 0)} | {item.get('deletions', 0)} |"
            )
    else:
        lines.append("| （无） |  |  |")
    lines.extend(["", "## 已知风险", ""])
    risks = summary.get("knownRisks") or []
    if risks:
        for risk in risks:
            if isinstance(risk, dict):
                lines.append(
                    f"- [{risk.get('severity') or 'unknown'}] "
                    f"{risk.get('message') or risk}"
                )
            else:
                lines.append(f"- {risk}")
    else:
        lines.append("无")
    lines.append("")
    out = work_dir / "meta" / "archive-meta.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    return out




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
    sidecar = hr.findings_path(change_dir)
    if sidecar.is_file():
        status = hr.status(change_dir)
        items = status.get("items") or []
        red_items = [item for item in items if item.get("severity") == "RED"]
        yellow_items = [item for item in items if item.get("severity") == "YELLOW"]
        base.update(
            {
                "status": "ADVISORY",
                "red": len(red_items),
                "yellow": len(yellow_items),
                "redFixed": sum(
                    1 for item in red_items if item.get("disposition") == "FIXED"
                ),
                "redConfirmed": sum(
                    1
                    for item in red_items
                    if item.get("disposition") in {"OPEN", "ACCEPTED_RISK", "DEFERRED"}
                ),
                "yellowFixed": sum(
                    1 for item in yellow_items if item.get("disposition") == "FIXED"
                ),
                "yellowDeferred": sum(
                    1
                    for item in yellow_items
                    if item.get("disposition") in {"DEFERRED", "ACCEPTED_RISK"}
                ),
                "summary": f"structured review run {status.get('runId') or 'unknown'}",
            }
        )
        return base
    if existing and isinstance(existing.get("reviewSummary"), dict):
        merged = dict(base)
        merged.update(existing["reviewSummary"])
        return merged
    if not review_evidence_present(change_dir, events):
        base["status"] = "ADVISORY_NOT_RUN"
    return base


def _resolve_base_commit(
    ledger: dict[str, Any] | None,
    change_dir: Path,
    project: Path,
    final: str | None,
) -> str:
    """Resolve baseCommit: ledger → latest phase-context → merge first parent → merge-base."""
    if ledger:
        base = str(ledger.get("baseCommit") or "").strip()
        if base and base != NOT_AVAILABLE:
            return base

    ctx_dir = change_dir / "runtime" / "phase-context"
    if ctx_dir.is_dir():
        candidates = sorted(
            (p for p in ctx_dir.glob("*.json") if p.is_file()),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        for path in candidates:
            try:
                payload = read_json(path)
            except (OSError, json.JSONDecodeError, TypeError):
                continue
            if not isinstance(payload, dict):
                continue
            base = str(payload.get("baseCommit") or "").strip()
            if base and base != NOT_AVAILABLE:
                return base

    final_commit = str(final or "").strip()
    if final_commit and final_commit != NOT_AVAILABLE:
        code, parents_line, _ = git_run(
            project, "rev-list", "--parents", "-n", "1", final_commit
        )
        if code == 0 and parents_line:
            parts = parents_line.split()
            if len(parts) >= 2:
                return parts[1]
        code, merge_base, _ = git_run(project, "merge-base", final_commit, "HEAD")
        if code == 0 and merge_base and merge_base != final_commit:
            return merge_base
    return ""


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
        # UT-015/RET-27: structured "## 目标" section body wins over the first
        # task-table row — the task row is an activity, not the objective.
        section = re.search(
            r"(?im)^#{1,4}\s*(?:\d+[\.、]\s*)?(?:目标|业务目标|需求背景)\s*$",
            body,
        )
        if section:
            lines: list[str] = []
            for line in body[section.end():].splitlines():
                if re.match(r"^\s*#{1,4}\s", line):
                    break
                clean = line.strip()
                if clean and not clean.startswith(("|", ">", "---")):
                    lines.append(clean)
                if lines:
                    break
            if lines:
                return lines[0]
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
    if before_manifest is None:
        frozen_before = change_dir / "evidence" / "archive-manifest-before.json"
        if frozen_before.is_file():
            before_manifest = read_json(frozen_before)
    if after_manifest is None:
        frozen_after = change_dir / "evidence" / "archive-manifest-after.json"
        if frozen_after.is_file():
            after_manifest = read_json(frozen_after)
    if compare_result is None and before_manifest is not None and after_manifest is not None:
        compare_result = compare_manifests(before_manifest, after_manifest)

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
    projected_events = he.apply_event_corrections(events) if events else []

    ledger = load_ledger(change_dir)
    if ledger:
        sources.append("evidence/verification-ledger.json")

    ci_metrics, ci_metrics_source = load_ci_metrics(change_dir)
    if ci_metrics_source:
        sources.append(ci_metrics_source)

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
            inferred_goal = _business_goal_from_sources(change_dir, projected_events)
            data["businessGoal"] = inferred_goal or (NOT_AVAILABLE if for_replay else "")

    # commits
    project = find_project_root(change_dir)
    if not data.get("finalCommit") or str(data.get("finalCommit")).startswith("<"):
        final_commit = _final_commit_from_sources(ledger, projected_events, existing, project)
        data["finalCommit"] = final_commit or (NOT_AVAILABLE if for_replay else "")

    if not data.get("baseCommit") or str(data.get("baseCommit")).startswith("<"):
        if for_replay and existing and existing.get("baseCommit"):
            data["baseCommit"] = existing["baseCommit"]
        else:
            resolved_base = _resolve_base_commit(
                ledger,
                change_dir,
                project,
                str(data.get("finalCommit") or "") or None,
            )
            if resolved_base:
                data["baseCommit"] = resolved_base
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
        projection = build_verification_projection(ledger, change_dir=change_dir)
        unit = projection["unitTests"]
        api = projection["apiTests"]
        db = projection["dbCompatibility"]
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
        for typed_key in ("apiContract", "browserE2E"):
            if typed_key in projection:
                data["verification"][typed_key] = projection[typed_key]
        if ci_metrics is not None:
            data["verification"]["ciMetrics"] = _deepcopy_json(ci_metrics)
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
        final_status, final_reasons = _compute_final_status(
            data.get("stageStatus") or {},
            data.get("verification") or {},
        )
        data["finalStatus"] = final_status
        data["finalStatusReasons"] = list(final_reasons)
    else:
        data.setdefault("finalStatusReasons", [])

    gate_policy = load_gate_policy(change_dir)
    data["riskTier"] = str((gate_policy or {}).get("tier") or "unknown")

    # durations / skillCalls
    if events:
        data["durations"] = _durations_from_event_phases(event_summary, events)
        data["skillCalls"] = _skill_calls_from_stages(data["durations"].get("stages") or [])
        stamps = [e.get("timestamp") for e in projected_events if e.get("timestamp")]
        cutoff = str(stamps[-1]) if stamps else None
        data["timing"] = build_workflow_timing(projected_events, report_cutoff_at=cutoff)
    elif log_text and (not for_replay or not data.get("durations")):
        data["durations"] = _parse_durations_from_log(log_text)
        data["skillCalls"] = _skill_calls_from_stages(data["durations"].get("stages") or [])
        data.setdefault(
            "timing",
            {
                "workflowStartedAt": NOT_AVAILABLE,
                "reportCutoffAt": NOT_AVAILABLE,
                "workflowWallClockMs": 0,
                "stageActiveExecutionMs": int(
                    round(float(data["durations"].get("totalMinutes") or 0) * 60000)
                ),
                "stageWallClockSpanMs": 0,
                "externalWaitMs": 0,
                "agentOrToolUnattributedMs": 0,
                "unclosedAttemptCount": 0,
                "postArchiveEventsExcluded": 0,
                "totalMinutesSemantics": "active-only",
            },
        )
    elif not data.get("durations"):
        data["durations"] = {
            "totalLabel": NOT_AVAILABLE,
            "totalMinutes": 0,
            "totalMinutesSemantics": "active-only",
            "stages": [],
        }
        data["skillCalls"] = []
        data.setdefault(
            "timing",
            {
                "workflowStartedAt": NOT_AVAILABLE,
                "reportCutoffAt": NOT_AVAILABLE,
                "workflowWallClockMs": 0,
                "stageActiveExecutionMs": 0,
                "stageWallClockSpanMs": 0,
                "externalWaitMs": 0,
                "agentOrToolUnattributedMs": 0,
                "unclosedAttemptCount": 0,
                "postArchiveEventsExcluded": 0,
                "totalMinutesSemantics": "active-only",
            },
        )

    # IA-1/4 identity (product vs archive)
    if not for_replay:
        identity = resolve_product_archive_identity(change_dir, project=project)
        data["productCommit"] = identity.get("productCommit") or data.get("finalCommit")
        data["productTreeHash"] = identity.get("productTreeHash")
        data["archiveCommit"] = identity.get("archiveCommit") or data.get("finalCommit")
        data["changeIdentity"] = identity

    # diffStat / changedFiles
    if not for_replay or not data.get("changedFiles"):
        base = data.get("baseCommit")
        head = data.get("finalCommit")
        if base and head and base != NOT_AVAILABLE and head != NOT_AVAILABLE:
            diff_stat, changed = _changed_files_from_git(project, str(base), str(head))
            ownership_projection: dict[str, Any] | None = None
            try:
                hp.load_change_contract(change_dir)
                ownership_projection = hl.compute_ownership_diff(
                    project,
                    base=str(base),
                    head=str(head),
                    change_dir=change_dir,
                )
            except (OSError, ValueError, RuntimeError):
                ownership_projection = None
            if ownership_projection is not None:
                allowed = set(ownership_projection.get("files") or [])
                changed = [item for item in changed if item.get("path") in allowed]
                diff_stat = {
                    **diff_stat,
                    "filesChanged": len(changed),
                    "insertions": sum(int(item.get("insertions") or 0) for item in changed),
                    "deletions": sum(int(item.get("deletions") or 0) for item in changed),
                }
                data["ownershipDiff"] = ownership_projection
                if write:
                    write_json(
                        change_dir / "evidence" / "ownership-diff.json",
                        ownership_projection,
                    )
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

    # H-11: surface identity + diff facts for adequacy (top-level + gitFacts).
    diff_for_facts = data.get("diffStat") if isinstance(data.get("diffStat"), dict) else {}
    data["gitFacts"] = {
        "baseCommit": data.get("baseCommit") or "",
        "finalCommit": data.get("finalCommit") or "",
        "filesChanged": int(diff_for_facts.get("filesChanged") or 0),
        "insertions": int(diff_for_facts.get("insertions") or 0),
        "deletions": int(diff_for_facts.get("deletions") or 0),
    }

    data.setdefault(
        "ownershipDiff",
        {
            "files": [item.get("path") for item in data.get("changedFiles") or []],
            "staticEvidenceFiles": [],
            "foreignPaths": [],
            "excludedRuntimeCount": 0,
            "ownedFileCount": len(data.get("changedFiles") or []),
        },
    )

    # artifacts (build products stay empty unless already known; reportPipeline has event artifacts)
    if not isinstance(data.get("artifacts"), list):
        data["artifacts"] = []
    if not for_replay:
        data["artifacts"] = _artifacts_from_events(projected_events)

    data["reviewSummary"] = _review_summary(
        change_dir,
        existing if for_replay else None,
        projected_events,
    )
    if not for_replay:
        data["timeline"] = _timeline_from_events(event_summary, projected_events)
    else:
        data.setdefault("timeline", [])
    data.setdefault("uncommittedTestEvidence", [])

    # Derive risks/actions from evidence. These fields are facts, not model prose.
    if not for_replay:
        maintenance_notes: list[str] = [
            str(event.get("note") or event.get("message") or "")
            for event in projected_events
            if event.get("type") == "decision" and (event.get("note") or event.get("message"))
        ]
        known_risks: list[dict[str, Any]] = []
        for event in he.current_issues(events):
            if event.get("phase") == "archive" and event.get("code") == "missing-command":
                continue
            sev = str(event.get("severity") or "").strip().lower()
            message = event.get("message") or event.get("note") or event.get("code") or ""
            if sev in _RISK_SEVERITIES:
                known_risks.append(
                    {
                        "phase": event.get("phase"),
                        "severity": sev,
                        "message": message,
                    }
                )
            else:
                note = str(message).strip()
                if note:
                    maintenance_notes.append(note)
        data["maintenanceNotes"] = maintenance_notes
        scenario_risks, scenario_actions = _risks_from_test_results(change_dir)
        data["knownRisks"] = known_risks + scenario_risks
        data["manualActions"] = scenario_actions
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
        data.setdefault("finalStatusReasons", [])
        data.setdefault("riskTier", "unknown")

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
    commands = _commands_from_events(projected_events)
    if not commands and for_replay:
        # Cannot invent commands
        pass
    verification_checks = _verification_checks_from_events(projected_events, ledger)
    pipeline_artifacts = _artifacts_from_events(projected_events)
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
        f'<div id="finalStatusReasons"><strong>finalStatusReasons</strong><ul>',
    ]
    for reason in summary.get("finalStatusReasons") or []:
        parts.append(f"<li>{esc(reason)}</li>")
    parts.append("</ul></div>")
    if summary.get("riskTier"):
        parts.append(f"<p><strong>riskTier</strong>: {esc(summary.get('riskTier'))}</p>")

    timing = summary.get("timing") if isinstance(summary.get("timing"), dict) else {}
    if timing:
        parts.append("<h3>Timing</h3>")
        parts.append(
            "<p id=\"timingColumns\">"
            f"stageActiveExecution={esc(timing.get('stageActiveExecutionMs'))} · "
            f"stageWallClockSpan={esc(timing.get('stageWallClockSpanMs'))} · "
            f"workflowWallClock={esc(timing.get('workflowWallClockMs'))}"
            "</p>"
        )
        parts.append(
            f"<p><strong>reportCutoffAt</strong>: "
            f"<span id=\"reportCutoffAt\">{esc(timing.get('reportCutoffAt'))}</span></p>"
        )
        parts.append(
            "<p><small>durations.totalMinutes is active-only; "
            "do not treat it as workflow wall clock.</small></p>"
        )

    if summary.get("productCommit") or summary.get("productTreeHash"):
        parts.append("<h3>Identity</h3>")
        parts.append(
            f"<p>productCommit={esc(summary.get('productCommit'))} "
            f"productTreeHash={esc(summary.get('productTreeHash'))} "
            f"archiveCommit={esc(summary.get('archiveCommit'))}</p>"
        )

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


def _manifest_self_stats(
    work_dir: Path,
    manifest: dict[str, Any],
    manifest_path: Path,
) -> dict[str, Any]:
    """UT-011/RET-23: physical files vs manifest entries (self-exclusion)."""
    physical = sum(1 for path in work_dir.rglob("*") if path.is_file())
    entries = int(manifest.get("fileCount") or len(manifest.get("files") or []))
    rel_manifest = manifest_path.resolve().relative_to(work_dir.resolve()).as_posix()
    in_entries = any(
        str(item.get("path") or "").replace("\\", "/") == rel_manifest
        for item in manifest.get("files") or []
        if isinstance(item, dict)
    )
    coverage = round(entries / physical * 100, 2) if physical else 100.0
    return {
        "physicalFileCount": physical,
        "entryCount": entries,
        "selfExcluded": not in_entries,
        "coveragePercent": coverage,
    }


def _append_finalize_failure_terminal(
    authoritative_change_dir: Path,
    message: str,
    *,
    operation_id: str,
) -> None:
    """Persist one failed finalize attempt on the authoritative change source."""
    if not authoritative_change_dir.is_dir():
        return
    try:
        append_event(
            authoritative_change_dir,
            phase="archive",
            type_="phase.start",
            note=f"finalize operation {operation_id} failed before publish",
        )
        append_event(
            authoritative_change_dir,
            phase="archive",
            type_="phase.end",
            status="FAIL",
            note=f"finalize operation {operation_id} discarded: {message}",
        )
    except OSError:
        pass


def _freeze_evidence_cutoff(work_dir: Path) -> dict[str, Any]:
    """Freeze the events cutoff: fsync events, write evidence-cutoff.json.

    After this point no event may be appended to the archived events file;
    the cutoff hash lets any later reader prove that (INT-006/RET-19).
    """
    events_file = he.events_path(work_dir)
    events = he.load_events(events_file) if events_file.is_file() else []
    if events_file.is_file():
        # Windows fsync requires a writable handle; O_RDONLY raises EBADF.
        fd = os.open(str(events_file), os.O_RDWR | os.O_BINARY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        raw = events_file.read_bytes()
    else:
        raw = b""
    cutoff = {
        "eventCount": len(events),
        "sha256": "sha256:" + hashlib.sha256(raw).hexdigest(),
        "frozenAt": now_iso(),
        "path": "events.ndjson",
    }
    write_json(work_dir / "evidence" / "evidence-cutoff.json", cutoff)
    return cutoff


def validate_artifact_immutability(entries: list[dict[str, Any]]) -> dict[str, Any]:
    """Same artifact path with two different hashes -> conflict (UT-003/RET-07)."""
    issues: list[dict[str, str]] = []
    seen: dict[str, str] = {}
    for item in entries:
        if not isinstance(item, dict):
            continue
        rel = str(item.get("path") or "").strip()
        digest = str(item.get("sha256") or "").strip()
        if not rel or not digest:
            continue
        prior = seen.get(rel)
        if prior is not None and prior != digest:
            issues.append(
                {
                    "code": "artifact-hash-conflict",
                    "severity": "error",
                    "message": f"immutable artifact conflict at {rel}: {prior[:12]}… != {digest[:12]}…",
                }
            )
        else:
            seen[rel] = digest
    errors = [i for i in issues if i.get("severity") == "error"]
    return {
        "ok": len(errors) == 0,
        "issues": issues,
        "error_count": len(errors),
        "warning_count": len(issues) - len(errors),
    }


def validate_source_consistency(
    change_dir: Path,
    summary: dict[str, Any],
) -> dict[str, Any]:
    """Layer 1: summary facts must equal the frozen sources (UT-014/RET-26).

    Checks event count against the cutoff file, verification counts against
    ledger typed metrics, and review counts against sidecars when present.
    """
    issues: list[dict[str, str]] = []

    # 1. event count/hash vs frozen cutoff (fallback: live events file).
    events_file = he.events_path(change_dir)
    actual_count = None
    cutoff_path = change_dir / "evidence" / "evidence-cutoff.json"
    cutoff: dict[str, Any] | None = None
    if cutoff_path.is_file():
        try:
            cutoff = read_json(cutoff_path)
            actual_count = cutoff.get("eventCount")
        except (OSError, json.JSONDecodeError):
            actual_count = None
    if actual_count is None and events_file.is_file():
        actual_count = len(he.load_events(events_file))
    summary_count = (summary.get("reportPipeline") or {}).get("event_count")
    if actual_count is not None and summary_count is not None:
        if int(summary_count) != int(actual_count):
            issues.append(
                {
                    "code": "event-count-mismatch",
                    "severity": "error",
                    "message": (
                        f"summary event_count={summary_count} but cutoff has "
                        f"{actual_count} events"
                    ),
                }
            )

    if cutoff is not None and events_file.is_file():
        actual_hash = "sha256:" + hashlib.sha256(events_file.read_bytes()).hexdigest()
        if cutoff.get("sha256") != actual_hash:
            issues.append(
                {
                    "code": "cutoff-hash-mismatch",
                    "severity": "error",
                    "message": "evidence cutoff hash does not match events.ndjson",
                }
            )

    # 2. verification vs ledger typed metrics.
    ledger = load_ledger(change_dir)
    if ledger:
        projection = build_verification_projection(ledger, change_dir=change_dir)
        ver = summary.get("verification") or {}
        unit_src = projection.get("unitTests") or {}
        unit_sum = ver.get("unitTests") or {}
        if unit_src.get("run"):
            if int(unit_sum.get("run") or 0) != int(unit_src["run"]):
                issues.append(
                    {
                        "code": "verification-mismatch",
                        "severity": "error",
                        "message": (
                            f"unitTests: summary run={unit_sum.get('run')} but "
                            f"ledger projection run={unit_src['run']}"
                        ),
                    }
                )
        for typed_key in ("apiContract", "browserE2E"):
            src = projection.get(typed_key)
            if not isinstance(src, dict) or not src.get("total"):
                continue
            rendered = ver.get(typed_key) or {}
            if int(rendered.get("total") or 0) != int(src["total"]):
                issues.append(
                    {
                        "code": "verification-mismatch",
                        "severity": "error",
                        "message": (
                            f"{typed_key}: summary total={rendered.get('total')} "
                            f"but ledger projection total={src['total']}"
                        ),
                    }
                )

    # 3. Rebuild canonical projections from frozen sources and compare the
    # fields that must never come from prose or an existing summary.
    expected = collect_summary_data(change_dir, write=False, for_replay=False)
    projection_fields = {
        "reviewSummary": "review-mismatch",
        "knownRisks": "risk-mismatch",
        "manualActions": "manual-actions-mismatch",
        "durations": "phase-timing-mismatch",
        "changedFiles": "ownership-diff-mismatch",
        "ownershipDiff": "ownership-diff-mismatch",
        "artifacts": "artifact-mismatch",
    }
    for field, code in projection_fields.items():
        if summary.get(field) != expected.get(field):
            issues.append(
                {
                    "code": code,
                    "severity": "error",
                    "message": f"summary {field} does not match frozen source projection",
                }
            )

    # 4. Manifest structure/checksums and summary semantics.
    before_path = change_dir / "evidence" / "archive-manifest-before.json"
    if before_path.is_file():
        try:
            manifest = read_json(before_path)
            entries = manifest.get("files") if isinstance(manifest, dict) else None
            valid = isinstance(entries, list) and manifest.get("fileCount") == len(entries)
            seen: set[str] = set()
            if valid:
                for entry in entries:
                    rel = str(entry.get("path") or "") if isinstance(entry, dict) else ""
                    digest = str(entry.get("sha256") or "") if isinstance(entry, dict) else ""
                    if (
                        not rel
                        or rel in seen
                        or re.fullmatch(r"[0-9a-f]{64}", digest) is None
                    ):
                        valid = False
                        break
                    seen.add(rel)
                    target = (change_dir / rel).resolve()
                    if not target.is_relative_to(change_dir.resolve()) or not target.is_file():
                        valid = False
                        break
                    if not _manifest_path_excluded(rel) and sha256_file(target) != digest:
                        valid = False
                        break
            if not valid:
                issues.append(
                    {
                        "code": "manifest-invalid",
                        "severity": "error",
                        "message": "archive-manifest-before structure or checksum is invalid",
                    }
                )
        except (OSError, json.JSONDecodeError):
            issues.append(
                {
                    "code": "manifest-invalid",
                    "severity": "error",
                    "message": "archive-manifest-before is unreadable",
                }
            )

    # 5. Artifact paths must resolve to immutable files inside the archive.
    root = change_dir.resolve()
    for artifact in summary.get("artifacts") or []:
        raw = str(artifact.get("path") or "") if isinstance(artifact, dict) else ""
        candidate = (root / raw).resolve() if raw else root
        if not raw or not candidate.is_relative_to(root) or not candidate.is_file():
            issues.append(
                {
                    "code": "artifact-missing",
                    "severity": "error",
                    "message": f"artifact path is missing or outside archive: {raw}",
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
            # UT-016/RET-28: canonical projection — structured risk objects
            # project to their message; str(dict) never matches rendered HTML.
            if isinstance(risk, dict):
                text = str(risk.get("message") or risk.get("summary") or "").strip()
            else:
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


def validate_report_adequacy(summary: dict[str, Any]) -> dict[str, Any]:
    """Validate that final summary is factually complete (retro §5.32).

    The archive validator must not return all-green when the summary is
    factually incomplete. This gate checks independent sources (git facts,
    typed metrics, stage status) rather than comparing the summary against
    a lossy projection of itself.
    """
    issues: list[dict[str, str]] = []

    # H-12: prefer top-level baseCommit + diffStat; gitFacts is a mirror.
    base = str(summary.get("baseCommit") or "").strip()
    final = str(summary.get("finalCommit") or "").strip()
    merge_final = str(summary.get("mergeFinalHash") or "").strip()
    diff_stat = summary.get("diffStat") if isinstance(summary.get("diffStat"), dict) else {}
    files_changed = int(diff_stat.get("filesChanged") or 0)

    git_facts = summary.get("gitFacts") or {}
    if isinstance(git_facts, dict):
        if not base or base == NOT_AVAILABLE:
            base = str(git_facts.get("baseCommit") or "").strip() or base
        if not final or final == NOT_AVAILABLE:
            final = str(git_facts.get("finalCommit") or "").strip() or final
        if "filesChanged" in git_facts and files_changed == 0:
            try:
                files_changed = int(git_facts.get("filesChanged") or 0)
            except (TypeError, ValueError):
                files_changed = 0

    base_missing = not base or base == NOT_AVAILABLE
    final_present = bool(
        (final and final != NOT_AVAILABLE) or (merge_final and merge_final != NOT_AVAILABLE)
    )
    if final_present and base_missing:
        issues.append({
            "code": "IDENTITY_BASE_MISSING",
            "severity": "error",
            "message": (
                "final/merge identity present but baseCommit is empty; "
                "refuse CONDITIONAL_OK+ without a resolved base"
            ),
        })

    if (
        base
        and final
        and base != NOT_AVAILABLE
        and final != NOT_AVAILABLE
        and base != final
        and files_changed == 0
    ):
        issues.append({
            "code": "DIFF_ZERO_WITH_NONEMPTY_COMMIT",
            "severity": "error",
            "message": f"final commit {final} differs from base {base} but filesChanged=0",
        })

    # Typed metrics missing despite test report artifacts present.
    verification = summary.get("verification") or {}
    if isinstance(verification, dict):
        unit = verification.get("unitTests") or {}
        api = verification.get("apiTests") or {}
        artifacts = summary.get("artifacts") or []
        has_test_report = any(
            isinstance(a, dict) and "test" in str(a.get("path") or "").lower()
            for a in artifacts
        ) if isinstance(artifacts, list) else False
        unit_pass = int(unit.get("passed") or 0) if isinstance(unit, dict) else 0
        api_status = str(api.get("status") or "") if isinstance(api, dict) else ""
        if has_test_report and unit_pass == 0 and api_status in {"", "not_available"}:
            issues.append({
                "code": "TYPED_METRICS_MISSING",
                "severity": "error",
                "message": "test report artifacts present but unitTests/apiTests typed metrics are empty",
            })

    # stageStatus contradicts event reducer.
    stage = summary.get("stageStatus") or {}
    stage_from_events = summary.get("stageStatusFromEvents") or {}
    if isinstance(stage, dict) and isinstance(stage_from_events, dict):
        for phase, status in stage.items():
            event_status = stage_from_events.get(phase)
            if event_status is not None and str(status) != str(event_status):
                issues.append({
                    "code": "STAGE_STATUS_CONTRADICTION",
                    "severity": "error",
                    "message": f"stageStatus.{phase}={status} but event reducer says {event_status}",
                })

    return {"ok": not issues, "issues": issues}


def artifact_preflight(change_dir: Path) -> dict[str, Any]:
    """Classify artifact events before destructive finalize (retro §5.31 / H-8).

    Returns per-artifact classification: blocking (missing / escaping /
    cross-change path), canonicalizable (same-change repo-relative path),
    or file-backed (change-relative path). Pathless legacy rows fail closed.
    """
    change_dir = change_dir.resolve()
    events_p = change_dir / "events.ndjson"
    items: list[dict[str, Any]] = []
    blocking: list[dict[str, Any]] = []
    if not events_p.is_file():
        return {"ok": True, "items": [], "blocking": []}
    change_id = change_dir.name
    for line in events_p.read_text(encoding="utf-8").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict) or event.get("type") != "artifact":
            continue
        path = str(event.get("path") or "").strip()
        kind = str(event.get("kind") or "").strip()
        event_id = str(event.get("id") or "")
        if not path:
            item = {
                "eventId": event_id,
                "category": "blocking",
                "path": "",
                "kind": kind or "",
                "reason": "artifact path missing",
                "note": str(event.get("note") or "")[:80],
            }
            items.append(item)
            blocking.append(item)
            continue
        # Check for escaping/cross-change paths.
        parts = path.replace("\\", "/").split("/")
        if ".." in parts or path.startswith("/") or re.match(r"^[A-Za-z]:", path):
            item = {
                "eventId": event_id,
                "category": "blocking",
                "path": path,
                "reason": "absolute or escaping path",
            }
            items.append(item)
            blocking.append(item)
            continue
        # Same-change repo-relative path: canonicalizable.
        prefix = f".harness/changes/{change_id}/"
        if path.startswith(prefix):
            canonical = path[len(prefix):]
            items.append({
                "eventId": event_id,
                "category": "canonicalizable",
                "path": path,
                "canonicalPath": canonical,
                "correction": f"append correction --target-event-id {event_id} --target-field path --new-value-json \"{canonical}\"",
            })
            continue
        # Change-relative path: OK.
        items.append({
            "eventId": event_id,
            "category": "file-backed",
            "path": path,
            "exists": (change_dir / path).is_file(),
        })
    return {"ok": not blocking, "items": items, "blocking": blocking}


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
    allow_missing_review: bool = False,
) -> tuple[int, dict[str, Any]]:
    """Execute the 9-step finalize pipeline. Returns (exit_code, payload)."""
    warnings: list[str] = []
    original_change_dir = change_dir.resolve()
    change_name = original_change_dir.name
    archive_root = archive_root.resolve()
    archive_root.mkdir(parents=True, exist_ok=True)
    archive_dir = archive_root / f"{today_date()}-{change_name}"
    project_root = find_project_root(original_change_dir)
    try:
        resolved_state_dir = hp.resolve_state_dir_for_contract(
            original_change_dir, project_root
        )
    except ValueError as exc:
        return 1, {
            "ok": False,
            "action": "finalize",
            "change_dir": str(original_change_dir),
            "error": f"invalid split runtime root: {exc}",
        }
    split_state_dir = (
        resolved_state_dir
        if resolved_state_dir.resolve() != original_change_dir.resolve()
        else None
    )
    operation_id = f"archive-{uuid.uuid4().hex}"
    operation_root = project_root / ".harness" / "archive-operations"
    operation_temp_dir = operation_root / "staging" / operation_id / change_name
    operation_record = operation_root / f"{operation_id}.json"

    def _restore_finalize_failure() -> None:
        shutil.rmtree(operation_temp_dir.parent, ignore_errors=True)
        payload["original_preserved"] = original_change_dir.is_dir()
        payload["finalStatus"] = "FAIL"
        _append_finalize_failure_terminal(
            split_state_dir
            if split_state_dir is not None and split_state_dir.is_dir()
            else original_change_dir,
            str(payload.get("error") or "archive finalize failed"),
            operation_id=operation_id,
        )
        try:
            write_json(
                operation_record,
                {
                    "schemaVersion": 1,
                    "operationId": operation_id,
                    "changeName": change_name,
                    "sourceDir": str(original_change_dir),
                    "archiveDir": str(archive_dir),
                    "finalStatus": "FAIL",
                    "error": payload.get("error"),
                    "finishedAt": now_iso(),
                },
            )
        except OSError as exc:
            warnings.append(f"could not persist failed archive operation: {exc}")

    payload: dict[str, Any] = {
        "ok": False,
        "action": "finalize",
        "change_dir": str(original_change_dir),
        "archive_dir": str(archive_dir),
        "change_name": change_name,
        "operationId": operation_id,
        "operationTempDir": str(operation_temp_dir),
        "operationRecord": str(operation_record),
        "warnings": warnings,
        "steps": {},
    }

    if not original_change_dir.is_dir():
        payload["error"] = f"change dir not found: {original_change_dir}"
        return 1, payload

    if archive_dir.exists():
        payload["error"] = f"archive target already exists: {archive_dir}"
        return 1, payload

    exact_byte = check_archive_exact_byte_policy(project_root)
    payload["steps"]["archive_exact_byte"] = exact_byte
    if not exact_byte["ok"]:
        warnings.append(str(exact_byte["remediation"]))

    try:
        operation_temp_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(
            original_change_dir,
            operation_temp_dir,
            copy_function=shutil.copy2,
        )
        write_json(
            operation_record,
            {
                "schemaVersion": 1,
                "operationId": operation_id,
                "changeName": change_name,
                "sourceDir": str(original_change_dir),
                "archiveDir": str(archive_dir),
                "finalStatus": "RUNNING",
                "startedAt": now_iso(),
            },
        )
    except OSError as exc:
        shutil.rmtree(operation_temp_dir.parent, ignore_errors=True)
        payload["error"] = f"operation staging failed: {exc}"
        _restore_finalize_failure()
        return 1, payload

    work_dir = operation_temp_dir
    before_manifest: dict[str, Any] | None = None

    if split_state_dir is not None and split_state_dir.is_dir():
        _merge_runtime_state(split_state_dir, work_dir)
        payload["steps"]["split_state_merge"] = {
            "ok": True,
            "stateDir": str(split_state_dir),
        }

    def _safe_append(**kwargs: Any) -> None:
        nonlocal work_dir
        try:
            append_event(work_dir, **kwargs)
        except OSError as exc:
            warnings.append(f"event append failed: {exc}")

    # Step 9 starts here: phase.start
    _safe_append(phase="archive", type_="phase.start", note="finalize start")

    # --- 0. cleanup transients (before before-manifest) ---
    try:
        cleanup_result = _cleanup_transients(work_dir)
        payload["steps"]["cleanup"] = cleanup_result
        deleted_n = len(cleanup_result.get("deleted") or [])
        trunc_n = len(cleanup_result.get("truncated") or [])
        _safe_append(
            phase="archive",
            type_="command",
            command="cleanup-transients",
            exit_code=0,
            note=f"deleted={deleted_n} truncated={trunc_n}",
        )
    except OSError as exc:
        warnings.append(f"cleanup failed: {exc}")
        payload["steps"]["cleanup"] = {"ok": False, "error": str(exc)}

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
        _restore_finalize_failure()
        return 1, payload

    # --- 2b. user-flag decision (archive fact, must precede the cutoff) ---
    if allow_missing_review:
        _safe_append(
            phase="archive",
            type_="decision",
            note="review missing on full tier (allowed by user)",
        )

    # --- 2c. artifact preflight (retro §5.31) ---
    # Classify artifact events before freeze: blocking paths must fail closed
    # before the staged operation commits a phase.end.
    try:
        preflight = artifact_preflight(work_dir)
    except Exception as exc:  # noqa: BLE001 — preflight must not crash finalize
        preflight = {"ok": False, "items": [], "blocking": [], "error": str(exc)}
    payload["steps"]["artifact_preflight"] = {
        "ok": bool(preflight.get("ok")),
        "blockingCount": len(preflight.get("blocking") or []),
        "itemsCount": len(preflight.get("items") or []),
    }
    if preflight.get("blocking"):
        payload["error"] = (
            f"artifact preflight blocking: "
            f"{len(preflight['blocking'])} path(s) cannot be archived"
        )
        payload["issues"] = [
            {
                "code": "ARTIFACT_PATH_BLOCKING",
                "severity": "error",
                "message": f"{item.get('path', '')}: {item.get('reason', 'blocking')}",
            }
            for item in preflight["blocking"]
        ]
        _restore_finalize_failure()
        payload["warnings"] = warnings
        payload["ok"] = False
        return 1, payload

    # --- 2d. product candidate CI hard gate (IA-1) ---
    ci_gate = evaluate_product_ci_gate(work_dir)
    payload["steps"]["product_candidate_ci"] = {
        "ok": bool(ci_gate.get("ok")),
        "code": ci_gate.get("code"),
        "message": ci_gate.get("message"),
    }
    if not ci_gate.get("ok"):
        payload["error"] = str(ci_gate.get("message") or "PRODUCT_CI_NOT_GREEN")
        payload["issues"] = [
            {
                "code": "PRODUCT_CI_NOT_GREEN",
                "severity": "error",
                "message": str(ci_gate.get("message") or "product candidate CI not green"),
            }
        ]
        _restore_finalize_failure()
        payload["warnings"] = warnings
        payload["ok"] = False
        return 1, payload

    # --- 3. candidate phase.end + freeze cutoff (RET-19 freeze-first) ---
    # This terminal exists only inside the isolated operation staging tree. It
    # becomes authoritative atomically at publish; validation failure discards
    # it and _restore_finalize_failure records the real FAIL attempt instead.
    # From here on, NO event may be appended to the staged events file.
    _safe_append(
        phase="archive",
        type_="phase.end",
        status="WARN" if warnings else "OK",
        note="finalize facts complete",
    )
    try:
        cutoff = _freeze_evidence_cutoff(work_dir)
        payload["steps"]["freeze"] = {"ok": True, "eventCount": cutoff["eventCount"]}
    except OSError as exc:
        payload["error"] = f"freeze failed: {exc}"
        payload["steps"]["freeze"] = {"ok": False, "error": str(exc)}
        _restore_finalize_failure()
        return 1, payload

    # --- 4. collect (pure function of frozen sources) ---
    try:
        summary = collect_summary_data(
            work_dir,
            before_manifest=before_manifest,
            write=True,
            for_replay=False,
        )
        summary_path = work_dir / "reports" / "final" / "summary-data.json"
        if allow_missing_review:
            reasons = list(summary.get("finalStatusReasons") or [])
            reason = "review missing on full tier (allowed by user)"
            if reason not in reasons:
                reasons.append(reason)
            summary["finalStatusReasons"] = reasons
            write_json(summary_path, summary)
        payload["steps"]["collect"] = {"ok": True, "path": str(summary_path)}
    except Exception as exc:  # noqa: BLE001 — surface collect failures
        payload["error"] = f"collect failed: {exc}"
        payload["steps"]["collect"] = {"ok": False, "error": str(exc)}
        _restore_finalize_failure()
        return 1, payload

    # --- 5. source consistency (layer 1; UT-014) ---
    source_result = validate_source_consistency(work_dir, summary)
    payload["steps"]["source_consistency"] = source_result
    summary.setdefault("reportPipeline", {})["sourceConsistency"] = {
        "ok": bool(source_result.get("ok")),
        "issues": source_result.get("issues") or [],
    }
    try:
        write_json(summary_path, summary)
    except OSError as exc:
        warnings.append(f"could not write sourceConsistency: {exc}")
    if not source_result.get("ok"):
        payload["issues"] = source_result.get("issues") or []
        payload["error"] = "source consistency failed; staged operation discarded"
        _restore_finalize_failure()
        payload["warnings"] = warnings
        payload["ok"] = False
        return 1, payload

    # --- 5b. report adequacy (retro §5.32) ---
    # Validate that the summary is factually complete: no diff=0 with non-empty
    # commit, no missing typed metrics despite test reports, no stageStatus
    # contradictions. Fail closed rather than archiving an incomplete summary.
    adequacy_result = validate_report_adequacy(summary)
    payload["steps"]["report_adequacy"] = adequacy_result
    summary.setdefault("reportPipeline", {})["reportAdequacy"] = {
        "ok": bool(adequacy_result.get("ok")),
        "issues": adequacy_result.get("issues") or [],
    }
    try:
        write_json(summary_path, summary)
    except OSError as exc:
        warnings.append(f"could not write reportAdequacy: {exc}")
    if not adequacy_result.get("ok"):
        payload["issues"] = adequacy_result.get("issues") or []
        payload["error"] = "report adequacy failed; staged operation discarded"
        _restore_finalize_failure()
        payload["warnings"] = warnings
        payload["ok"] = False
        return 1, payload

    # --- 6. render (Node, else Python fallback) ---
    render_result = render_final_summary(work_dir, summary_path)
    payload["steps"]["render"] = render_result
    if not render_result.get("ok"):
        # 永不关闭一个没有 final-summary 的归档。
        msg = str(render_result.get("fallbackReason") or "render failed")
        payload["error"] = f"final-summary render failed: {msg}"
        _restore_finalize_failure()
        payload["warnings"] = warnings
        payload["ok"] = False
        return 1, payload
    renderer = render_result.get("renderer")
    if renderer == "python-fallback" and render_result.get("fallbackReason"):
        warnings.append(
            f"node render unavailable; used python-fallback: "
            f"{render_result.get('fallbackReason')}"
        )

    html_path = work_dir / "reports" / "final" / "final-summary.html"

    # --- 7. renderer consistency (layer 2) ---
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

    # --- 8. archive-meta (before after-manifest so the manifest covers it) ---
    try:
        summary = read_json(summary_path)
        meta_path = write_archive_meta(work_dir, summary)
        payload["steps"]["archive_meta"] = {"ok": True, "path": str(meta_path)}
    except Exception as exc:  # noqa: BLE001 — meta soft-fail
        warnings.append(f"archive-meta write failed: {exc}")
        payload["steps"]["archive_meta"] = {"ok": False, "error": str(exc)}

    # --- 9/10. final summary stats + render, then LAST manifest (IA-7) ---
    # Post-manifest rewrites of covered bytes are forbidden. We update summary /
    # HTML first, regenerate after-manifest last, then verify on-disk hashes.
    # If summary/html must still change after that, they are excluded with reasons.
    summary = read_json(summary_path)
    summary["archiveManifest"] = {
        "movedFiles": 0,
        "generatedFiles": 0,
        "totalArchiveFiles": 0,
        "checksumStatus": "PENDING",
    }
    write_json(summary_path, summary)
    render_result = render_final_summary(work_dir, summary_path)
    if not render_result.get("ok"):
        payload["error"] = f"final summary re-render failed: {render_result.get('error')}"
        _restore_finalize_failure()
        return 1, payload
    summary = read_json(summary_path)
    validate_result = validate_summary(summary, html_path if html_path.is_file() else None)
    payload["steps"]["validate"] = validate_result
    summary.setdefault("reportPipeline", {})["validationIssues"] = validate_result.get(
        "issues"
    ) or []
    write_json(summary_path, summary)

    after_path = work_dir / "evidence" / "archive-manifest-after.json"
    try:
        after_manifest = generate_manifest(work_dir, after_path)
        before_in_archive = work_dir / "evidence" / "archive-manifest-before.json"
        if before_in_archive.is_file():
            before_manifest = read_json(before_in_archive)
        compare_result = compare_manifests(before_manifest, after_manifest)
        coverage = verify_manifest_byte_coverage(work_dir, after_manifest)
        # Embed compare stats into summary AFTER manifest → must exclude those paths.
        summary = read_json(summary_path)
        summary["archiveManifest"] = {
            "movedFiles": compare_result.get("movedFiles", 0),
            "generatedFiles": compare_result.get("generatedFiles", 0),
            "totalArchiveFiles": compare_result.get("totalArchiveFiles", 0),
            "checksumStatus": coverage.get("checksumStatus", "FAIL"),
            "exclusionReasons": {
                "reports/final/summary-data.json": (
                    "archiveManifest stats written after coverage snapshot"
                ),
                "reports/final/final-summary.html": (
                    "re-rendered after coverage snapshot to display manifest stats"
                ),
            },
            **_manifest_self_stats(work_dir, after_manifest, after_path),
        }
        write_json(summary_path, summary)
        render_result = render_final_summary(work_dir, summary_path)
        if not render_result.get("ok"):
            payload["error"] = (
                f"post-manifest summary render failed: {render_result.get('error')}"
            )
            _restore_finalize_failure()
            return 1, payload
        coverage = verify_manifest_byte_coverage(
            work_dir,
            after_manifest,
            exclude_paths=[
                "reports/final/summary-data.json",
                "reports/final/final-summary.html",
            ],
            exclusion_reasons=summary["archiveManifest"]["exclusionReasons"],
        )
        summary["archiveManifest"]["checksumStatus"] = coverage.get(
            "checksumStatus", "FAIL"
        )
        summary["archiveManifest"]["exclusionReasons"] = coverage.get(
            "exclusionReasons"
        ) or summary["archiveManifest"]["exclusionReasons"]
        summary["archiveManifest"]["coverageChecked"] = coverage.get("checked")
        write_json(summary_path, summary)
        # Re-render once more for checksumStatus display; remain excluded.
        render_final_summary(work_dir, summary_path)
        summary = read_json(summary_path)
        validate_result = validate_summary(
            summary, html_path if html_path.is_file() else None
        )
        payload["steps"]["validate"] = validate_result
        summary.setdefault("reportPipeline", {})["validationIssues"] = (
            validate_result.get("issues") or []
        )
        write_json(summary_path, summary)
        payload["steps"]["after_manifest"] = {
            "ok": bool(coverage.get("ok")) and bool(compare_result.get("ok")),
            "path": str(after_path),
            "compare": compare_result,
            "coverage": coverage,
        }
        compare_result = {
            **compare_result,
            "ok": bool(compare_result.get("ok")) and bool(coverage.get("ok")),
            "checksumStatus": coverage.get("checksumStatus"),
            "exclusionReasons": coverage.get("exclusionReasons"),
        }
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        payload["error"] = f"after-manifest failed: {exc}"
        payload["steps"]["after_manifest"] = {"ok": False, "error": str(exc)}
        _restore_finalize_failure()
        return 1, payload

    # --- 11. closure: only when both validators and manifest pass ---
    validate_ok = bool(validate_result.get("ok"))
    manifest_ok = bool(compare_result.get("ok"))
    # Honest checksum: FAIL blocks; OK and OK_WITH_EXCLUSIONS (with reasons) pass.
    checksum = str(compare_result.get("checksumStatus") or "")
    checksum_ok = checksum in {"OK", "OK_WITH_EXCLUSIONS"}
    can_close = validate_ok and manifest_ok and checksum_ok

    if not can_close:
        issues_out = list(validate_result.get("issues") or [])
        if not manifest_ok or not checksum_ok:
            issues_out.append(
                {
                    "code": "manifest-mismatch",
                    "severity": "error",
                    "message": (
                        f"missing={compare_result.get('missing')} "
                        f"mismatched={compare_result.get('mismatched')} "
                        f"checksumStatus={checksum}"
                    ),
                }
            )
        payload["issues"] = issues_out
        payload["error"] = "validate or manifest check failed; staged operation discarded"
        payload["steps"]["delete_original"] = {"ok": False, "deleted": False}
        _restore_finalize_failure()
        payload["warnings"] = warnings
        payload["ok"] = False
        return 1, payload

    # Publish only after every validator passes. The archive path is never used
    # as mutable staging, so a failed attempt cannot poison the next retry.
    try:
        archive_root.mkdir(parents=True, exist_ok=True)
        shutil.move(str(operation_temp_dir), str(archive_dir))
        shutil.rmtree(operation_temp_dir.parent, ignore_errors=True)
        work_dir = archive_dir
        summary_path = work_dir / "reports" / "final" / "summary-data.json"
        html_path = work_dir / "reports" / "final" / "final-summary.html"
        payload["steps"]["move"] = {"ok": True, "to": str(archive_dir)}
    except OSError as exc:
        payload["error"] = f"publish failed: {exc}"
        payload["steps"]["move"] = {"ok": False, "error": str(exc)}
        _restore_finalize_failure()
        return 1, payload

    # Success path: the validated copy is published; now retire its source.
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
            "note": "source already absent",
        }

    if split_state_dir is not None and split_state_dir.is_dir():
        try:
            shutil.rmtree(split_state_dir)
            payload["steps"]["delete_runtime_state"] = {"ok": True, "deleted": True}
        except OSError as exc:
            warnings.append(f"could not remove archived runtime state: {exc}")
            payload["steps"]["delete_runtime_state"] = {"ok": False, "error": str(exc)}

    # --- 12. maintenance outbox + service ---
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

    try:
        write_json(
            operation_record,
            {
                "schemaVersion": 1,
                "operationId": operation_id,
                "changeName": change_name,
                "sourceDir": str(original_change_dir),
                "archiveDir": str(archive_dir),
                "finalStatus": "OK",
                "publishedAt": now_iso(),
                "summarySha256": sha256_file(summary_path),
                "manifestSha256": sha256_file(
                    archive_dir / "evidence" / "archive-manifest-after.json"
                ),
            },
        )
    except OSError as exc:
        warnings.append(f"could not persist completed archive operation: {exc}")

    payload["ok"] = True
    payload["finalStatus"] = "OK"
    payload["warnings"] = warnings
    payload["summary_data"] = str(summary_path)
    payload["final_summary"] = str(html_path) if html_path.is_file() else None
    return 0, payload


def _merge_runtime_state(state_dir: Path, contract_dir: Path) -> None:
    """Materialize split-v1 dynamic state into the archive contract tree."""
    for source in sorted(state_dir.iterdir()):
        target = contract_dir / source.name
        if source.is_dir():
            shutil.copytree(source, target, dirs_exist_ok=True, copy_function=shutil.copy2)
        elif source.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)


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
    result = check_status(
        change_dir,
        allow_missing_review=bool(getattr(args, "allow_missing_review", False)),
    )
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
        allow_missing_review=bool(getattr(args, "allow_missing_review", False)),
    )
    emit_json(payload)
    return code


def cmd_replay_cli(args: argparse.Namespace) -> int:
    archive_dir = resolve_path(args.archive_dir)
    out_path = resolve_path(args.out) if getattr(args, "out", None) else None
    code, payload = cmd_replay(archive_dir, out_path=out_path)
    emit_json(payload)
    return code


def _render_html_to(
    change_dir: Path,
    summary_path: Path,
    out_path: Path,
) -> dict[str, Any]:
    """Render summary HTML to an arbitrary path (node first, python fallback).

    Unlike ``render_final_summary`` this never touches the canonical
    ``reports/final/final-summary.html`` — repair renders into staging.
    """
    project = find_project_root(change_dir)
    node = resolve_node_path(project)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if node and RENDER_SCRIPT.is_file():
        try:
            proc = subprocess.run(
                [node, str(RENDER_SCRIPT), "--summary", str(summary_path), "--out", str(out_path)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=60,
                check=False,
            )
            if proc.returncode == 0 and out_path.is_file():
                return {"ok": True, "renderer": "node", "out_path": str(out_path)}
        except (OSError, subprocess.TimeoutExpired):
            pass
    try:
        summary = read_json(summary_path)
        html = render_fallback_html(summary)
        out_path.write_text(html, encoding="utf-8", newline="\n")
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        return {"ok": False, "renderer": "none", "error": str(exc)}
    return {"ok": True, "renderer": "python-fallback", "out_path": str(out_path)}


def cmd_repair(archive_dir: Path) -> tuple[int, dict[str, Any]]:
    """Versioned repair (task 11 / RET-40).

    Re-collect a candidate from the frozen sources, run both validators, and
    only then write an immutable ``derived/v<N>/`` plus a repair record. The
    original summary/HTML/manifest is never overwritten; the authoritative
    pointer moves only when both validators pass.
    """
    payload: dict[str, Any] = {
        "ok": False,
        "action": "repair",
        "archive_dir": str(archive_dir),
    }
    if not archive_dir.is_dir():
        payload["error"] = f"archive dir not found: {archive_dir}"
        return 1, payload
    summary_path = archive_dir / "reports" / "final" / "summary-data.json"
    if not summary_path.is_file():
        payload["error"] = "summary-data.json missing; cannot repair"
        return 1, payload
    frozen_manifest_paths = {
        name: archive_dir / "evidence" / name
        for name in (
            "archive-manifest-before.json",
            "archive-manifest-after.json",
        )
    }
    missing_manifests = [
        name for name, path in frozen_manifest_paths.items() if not path.is_file()
    ]
    if missing_manifests:
        payload["error"] = (
            "frozen manifests missing; cannot repair: " + ", ".join(missing_manifests)
        )
        return 1, payload

    # 1. candidate: fresh collect from frozen sources (read-only on archive).
    try:
        candidate = collect_summary_data(archive_dir, write=False, for_replay=False)
    except Exception as exc:  # noqa: BLE001
        payload["error"] = f"repair collect failed: {exc}"
        return 1, payload

    # 2. stage outside the archive; run both validators on the candidate.
    staging = Path(tempfile.mkdtemp(prefix="harness-repair-"))
    try:
        staged_summary = staging / "summary-data.json"
        write_json(staged_summary, candidate)
        source_result = validate_source_consistency(archive_dir, candidate)
        render_result = _render_html_to(
            archive_dir, staged_summary, staging / "final-summary.html"
        )
        staged_html = staging / "final-summary.html"
        renderer_result = validate_summary(
            candidate,
            staged_html if staged_html.is_file() else None,
        )
        payload["validators"] = {
            "source": source_result,
            "renderer": renderer_result,
        }
        if not (source_result.get("ok") and renderer_result.get("ok")):
            payload["error"] = "repair validators failed; derived version not written"
            return 1, payload

        # 3. immutable derived version.
        derived = archive_dir / "derived"
        derived.mkdir(exist_ok=True)
        existing = [
            int(p.name[1:])
            for p in derived.iterdir()
            if p.is_dir() and p.name.startswith("v") and p.name[1:].isdigit()
        ]
        version = f"v{(max(existing) + 1) if existing else 1}"
        version_dir = derived / version
        staged_version_dir = staging / version
        staged_version_dir.mkdir()
        final_summary = staged_version_dir / "summary-data.json"
        write_json(final_summary, candidate)
        frozen_manifest_hashes: dict[str, str] = {}
        for manifest_name, source_manifest in frozen_manifest_paths.items():
            target_manifest = staged_version_dir / manifest_name
            shutil.copy2(source_manifest, target_manifest)
            frozen_manifest_hashes[manifest_name] = "sha256:" + sha256_file(target_manifest)
        if staged_html.is_file():
            shutil.copy2(staged_html, staged_version_dir / "final-summary.html")
        record = {
            "version": version,
            "createdAt": now_iso(),
            "summarySha256": "sha256:" + hashlib.sha256(final_summary.read_bytes()).hexdigest(),
            "baseSummarySha256": "sha256:" + hashlib.sha256(summary_path.read_bytes()).hexdigest(),
            "frozenManifestHashes": frozen_manifest_hashes,
            "validators": {
                "source": {"ok": bool(source_result.get("ok")), "issues": source_result.get("issues") or []},
                "renderer": {"ok": bool(renderer_result.get("ok")), "issues": renderer_result.get("issues") or []},
            },
        }
        write_json(staged_version_dir / "repair-record.json", record)
        shutil.move(str(staged_version_dir), str(version_dir))

        # 4. authoritative pointer — only after both validators passed.
        write_json(
            derived / "authoritative.json",
            {
                "version": version,
                "summarySha256": record["summarySha256"],
                "updatedAt": record["createdAt"],
            },
        )
        payload["ok"] = True
        payload["version"] = version
        payload["derived_dir"] = str(version_dir)
        return 0, payload
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def cmd_repair_cli(args: argparse.Namespace) -> int:
    archive_dir = resolve_path(args.archive_dir)
    code, payload = cmd_repair(archive_dir)
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
    p_status.add_argument(
        "--allow-missing-review",
        action="store_true",
        help="downgrade full-tier missing review from blocker to warning",
    )
    p_status.set_defaults(func=cmd_status_cli)

    p_fin = sub.add_parser("finalize", help="single-process archive finalize")
    p_fin.add_argument("--change-dir", required=True)
    p_fin.add_argument("--archive-root", required=True)
    p_fin.add_argument("--skip-ingest", action="store_true")
    p_fin.add_argument(
        "--allow-missing-review",
        action="store_true",
        help="record override when full-tier review evidence is missing",
    )
    p_fin.add_argument("--json", action="store_true", default=True)
    p_fin.set_defaults(func=cmd_finalize_cli)

    p_rep = sub.add_parser("replay", help="read-only re-collect + validate")
    p_rep.add_argument("--archive-dir", required=True)
    p_rep.add_argument("--out", default=None, help="write summary-data JSON outside archive")
    p_rep.add_argument("--json", action="store_true", default=True)
    p_rep.set_defaults(func=cmd_replay_cli)

    p_repair = sub.add_parser(
        "repair", help="versioned repair: validated derived version, original untouched"
    )
    p_repair.add_argument("--archive-dir", required=True)
    p_repair.add_argument("--json", action="store_true", default=True)
    p_repair.set_defaults(func=cmd_repair_cli)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
