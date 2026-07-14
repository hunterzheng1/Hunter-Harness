#!/usr/bin/env python3
"""Build and query a local Harness knowledge index.

This script is intentionally dependency-free. It turns existing
.harness/archive/**/reports/final/summary-data.json files into a project-local
.harness/knowledge index with candidate entries, SQLite FTS5, Obsidian views,
and query context packs.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


ENTRY_TYPES = {
    "requirement",
    "decision",
    "implementation",
    "risk",
    "test-evidence",
    "pitfall",
    "api-contract",
}

DEFAULT_AUTO_KNOWLEDGE_CONFIG = {
    "autoPromote": {
        "enabled": True,
        "minConfidence": 0.82,
        "allowedTypes": ["decision", "api-contract", "requirement", "pitfall"],
        "requireValidators": False,
        "allowStale": False,
        "maxPerRun": 50,
    },
    "confidence": {
        "ttlHalfLifeDays": 45,
        "sourceChangePenalty": 0.25,
        "stalePenalty": 0.35,
        "validatorPassBonus": 0.15,
        "validatorFailPenalty": 0.5,
        "supersededPenalty": 0.8,
        "conflictPenalty": 0.8,
    },
    "activeLifecycle": {
        "autoDemote": True,
        "targetStatus": "stale",
    },
    "knowledgeValidation": {
        "enabled": True,
        "autoDemoteActive": True,
        "defaultTargetStatus": "stale",
        "allowCommandValidators": False,
        "commandTimeoutSeconds": 60,
    },
    "judge": {
        "maxCandidatesPerRun": 100,
    },
}


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def timestamp() -> str:
    return dt.datetime.now().strftime("%Y%m%d-%H%M%S")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _serialize_json_bytes(data: Any) -> bytes:
    return (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def write_json_if_changed(path: Path, data: Any) -> bool:
    """Write only when byte content would differ; returns True iff a write occurred."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = _serialize_json_bytes(data)
    if path.exists() and path.read_bytes() == payload:
        return False
    path.write_bytes(payload)
    return True


def write_text_if_changed(path: Path, text: str) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = text.encode("utf-8")
    if path.exists() and path.read_bytes() == payload:
        return False
    path.write_bytes(payload)
    return True


def json_clone(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False))


def load_config(knowledge: Path) -> dict[str, Any]:
    config_path = knowledge / "config.json"
    if not config_path.exists():
        return {}
    try:
        config = read_json(config_path)
    except (OSError, json.JSONDecodeError):
        return {}
    return config if isinstance(config, dict) else {}


def ensure_auto_knowledge_config(knowledge: Path) -> dict[str, Any]:
    config_path = knowledge / "config.json"
    if config_path.exists():
        config = load_config(knowledge)
        return {
            "path": str(config_path),
            "created": False,
            "autoPromoteEnabled": auto_promote_config(config)["enabled"],
            "autoDemoteEnabled": active_lifecycle_config(config)["autoDemote"],
            "autoDemoteActiveEnabled": knowledge_validation_config(config)["autoDemoteActive"],
            "maxCandidatesPerRun": judge_config(config)["maxCandidatesPerRun"],
            "appliedBy": "existing",
            "candidateAutoPromoted": None,
        }
    config = json_clone(DEFAULT_AUTO_KNOWLEDGE_CONFIG)
    write_json(config_path, config)
    return {
        "path": str(config_path),
        "created": True,
        "autoPromoteEnabled": True,
        "autoDemoteEnabled": True,
        "autoDemoteActiveEnabled": True,
        "maxCandidatesPerRun": judge_config(config)["maxCandidatesPerRun"],
        "appliedBy": None,
        "candidateAutoPromoted": None,
    }


def active_lifecycle_config(config: dict[str, Any]) -> dict[str, Any]:
    raw = config.get("activeLifecycle")
    if not isinstance(raw, dict):
        return {"autoDemote": False, "targetStatus": "stale"}
    target_status = str(raw.get("targetStatus") or "stale")
    if target_status not in {"candidate", "stale"}:
        target_status = "stale"
    return {
        "autoDemote": bool(raw.get("autoDemote")),
        "targetStatus": target_status,
    }


def knowledge_validation_config(config: dict[str, Any]) -> dict[str, Any]:
    raw = config.get("knowledgeValidation")
    if not isinstance(raw, dict):
        raw = {}
    target_status = str(raw.get("defaultTargetStatus") or "stale")
    if target_status not in {"candidate", "stale"}:
        target_status = "stale"
    return {
        "enabled": bool(raw.get("enabled", True)),
        "autoDemoteActive": bool(raw.get("autoDemoteActive", False)),
        "defaultTargetStatus": target_status,
        "allowCommandValidators": bool(raw.get("allowCommandValidators", False)),
        "commandTimeoutSeconds": int(raw.get("commandTimeoutSeconds") or 60),
    }


def confidence_config(config: dict[str, Any]) -> dict[str, Any]:
    raw = config.get("confidence")
    if not isinstance(raw, dict):
        raw = {}
    return {
        "ttlHalfLifeDays": max(1, int(raw.get("ttlHalfLifeDays") or 45)),
        "sourceChangePenalty": float(raw.get("sourceChangePenalty", 0.25)),
        "stalePenalty": float(raw.get("stalePenalty", 0.35)),
        "validatorPassBonus": float(raw.get("validatorPassBonus", 0.15)),
        "validatorFailPenalty": float(raw.get("validatorFailPenalty", 0.5)),
        "supersededPenalty": float(raw.get("supersededPenalty", 0.8)),
        "conflictPenalty": float(raw.get("conflictPenalty", 0.8)),
    }


def auto_promote_config(config: dict[str, Any]) -> dict[str, Any]:
    raw = config.get("autoPromote")
    if not isinstance(raw, dict):
        raw = {}
    allowed = raw.get("allowedTypes")
    if not isinstance(allowed, list):
        allowed = ["decision", "api-contract", "requirement", "pitfall"]
    allowed_types = [str(item) for item in allowed if str(item) in ENTRY_TYPES]
    if not allowed_types:
        allowed_types = ["decision", "api-contract", "requirement", "pitfall"]
    max_per_run = int(raw.get("maxPerRun") or 50)
    return {
        "enabled": bool(raw.get("enabled", False)),
        "minConfidence": float(raw.get("minConfidence", 0.82)),
        "allowedTypes": allowed_types,
        "requireValidators": bool(raw.get("requireValidators", False)),
        "allowStale": bool(raw.get("allowStale", False)),
        "maxPerRun": max(0, max_per_run),
    }


def judge_config(config: dict[str, Any]) -> dict[str, Any]:
    raw = config.get("judge")
    if not isinstance(raw, dict):
        raw = {}
    max_candidates = int(raw.get("maxCandidatesPerRun") or 100)
    return {
        "maxCandidatesPerRun": max(1, max_candidates),
    }


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def short_hash(value: str, length: int = 10) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:length]


def slugify(value: str, max_len: int = 64) -> str:
    value = value.lower().strip()
    value = re.sub(r"[^\w\u4e00-\u9fff]+", "-", value, flags=re.UNICODE)
    value = re.sub(r"-+", "-", value).strip("-")
    if not value:
        value = "item"
    return value[:max_len].strip("-") or "item"


def safe_filename(value: str) -> str:
    slug = slugify(value, 72)
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", slug)


def entry_filename(entry: dict) -> str:
    """生成 entry 文件名：可读前缀（截断安全）+ 完整 10 字符哈希（永不被截）。

    id 形如 ``project.archive.type.hash10``；rsplit 取末段为消歧哈希，
    拼在 safe_filename 截断之外，避免长归档名让 72 上限切掉哈希导致撞名。
    末段不足 6 字符或 id 无 hash 段时回退为 short_hash(id, 10)；
    末段含文件系统非法字符时按 safe_filename 同款规则清理，避免非法文件名。
    """
    entry_id = entry["id"]
    parts = entry_id.rsplit(".", 1)
    prefix = parts[0] if len(parts) == 2 else entry_id
    digest = parts[1] if len(parts) == 2 and len(parts[1]) >= 6 else short_hash(entry_id, 10)
    digest = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", digest)
    return safe_filename(prefix) + "-" + digest + ".json"


def rel_to_project(project: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(project.resolve()).as_posix()
    except ValueError:
        return path.as_posix()


def project_id(project: Path) -> str:
    config = project / ".harness" / "project.yaml"
    if config.exists():
        text = config.read_text(encoding="utf-8", errors="ignore")
        match = re.search(r"(?m)^project[_-]?id:\s*['\"]?([^'\"\n#]+)", text)
        if match:
            return slugify(match.group(1).strip(), 80)
    return slugify(project.name, 80)


def git_head(project: Path) -> str | None:
    result = run_git(project, ["rev-parse", "HEAD"])
    return result.stdout.strip() if result.returncode == 0 else None


def is_git_repo(project: Path) -> bool:
    result = run_git(project, ["rev-parse", "--is-inside-work-tree"])
    return result.returncode == 0 and result.stdout.strip() == "true"


def git_commit_exists(project: Path, commit: str) -> bool:
    result = run_git(project, ["cat-file", "-e", f"{commit}^{{commit}}"])
    return result.returncode == 0


def run_git(project: Path, args: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            ["git", "-C", str(project), *args],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return subprocess.CompletedProcess(args, 1, "", str(exc))


def archive_name(summary_path: Path) -> str:
    parts = summary_path.parts
    try:
        idx = parts.index("archive")
        return parts[idx + 1]
    except (ValueError, IndexError):
        return summary_path.parent.name


def archive_dir_from_summary(summary_path: Path) -> Path:
    archive = archive_name(summary_path)
    current = summary_path
    for parent in summary_path.parents:
        if parent.name == archive and parent.parent.name == "archive":
            return parent
        current = parent
    return current


def changed_file_paths(summary: dict[str, Any]) -> list[str]:
    files = []
    for item in summary.get("changedFiles") or []:
        path = item.get("path") if isinstance(item, dict) else None
        if path and path not in files:
            files.append(str(path))
    return files


def archive_summary_records(project: Path, summary_paths: list[Path]) -> list[dict[str, Any]]:
    records = []
    for summary_path in summary_paths:
        stat = summary_path.stat()
        records.append(
            {
                "archive": rel_to_project(project, archive_dir_from_summary(summary_path)),
                "summaryData": rel_to_project(project, summary_path),
                "summarySha256": sha256_file(summary_path),
                "mtime": dt.datetime.fromtimestamp(stat.st_mtime, dt.timezone.utc).isoformat(timespec="seconds"),
            }
        )
    return records


def make_entry(
    *,
    project: Path,
    project_name: str,
    summary_path: Path,
    summary_hash: str,
    summary: dict[str, Any],
    entry_type: str,
    title: str,
    body: str,
    source_files: list[str],
    keywords: list[str],
    confidence: str = "medium",
) -> dict[str, Any]:
    if entry_type not in ENTRY_TYPES:
        raise ValueError(f"unsupported entry type: {entry_type}")

    archive = archive_name(summary_path)
    final_commit = str(summary.get("finalCommit") or summary.get("final_commit") or "")
    base_commit = str(summary.get("baseCommit") or summary.get("base_commit") or "")
    status = "candidate"
    stale_reasons: list[str] = []

    if final_commit and is_git_repo(project):
        if not git_commit_exists(project, final_commit):
            stale_reasons.append(
                "source commit missing from local git history: " + final_commit[:12]
            )
        elif source_files:
            diff = run_git(project, ["diff", "--name-only", f"{final_commit}..HEAD", "--", *source_files])
            if diff.returncode == 0:
                changed = [line.strip() for line in diff.stdout.splitlines() if line.strip()]
                if changed:
                    stale_reasons.append(
                        "source files changed after source commit: " + ", ".join(changed[:8])
                    )
            else:
                detail = first_sentence(diff.stderr.strip() or f"git diff exited {diff.returncode}")
                stale_reasons.append("source commit could not be compared with current HEAD: " + detail)

    if stale_reasons:
        status = "stale"

    identity = "|".join([project_name, archive, entry_type, title, body[:160]])
    entry_id = ".".join([project_name, slugify(archive, 80), entry_type, short_hash(identity)])
    archive_dir = archive_dir_from_summary(summary_path)

    return {
        "schemaVersion": 1,
        "id": entry_id,
        "projectId": project_name,
        "type": entry_type,
        "status": status,
        "title": title.strip(),
        "summary": first_sentence(body),
        "body": body.strip(),
        "keywords": sorted({kw for kw in keywords if kw}),
        "source": {
            "archive": rel_to_project(project, archive_dir),
            "summaryData": rel_to_project(project, summary_path),
            "summarySha256": summary_hash,
            "sourceCommit": final_commit,
            "baseCommit": base_commit,
            "changeName": str(summary.get("changeName") or archive),
            "finalStatus": str(summary.get("finalStatus") or ""),
        },
        "scope": {
            "sourceFiles": source_files,
            "staleIfPathsChanged": stale_patterns(source_files),
        },
        "lifecycle": {
            "createdAt": now_iso(),
            "verifiedAt": summary.get("archivedAt") or now_iso(),
            "lastCheckedAt": now_iso(),
            "confidence": confidence,
            "supersedes": [],
            "supersededBy": None,
            "conflictsWith": [],
            "staleReasons": stale_reasons,
        },
    }


def first_sentence(text: str) -> str:
    clean = re.sub(r"\s+", " ", text).strip()
    if len(clean) <= 180:
        return clean
    return clean[:177].rstrip() + "..."


def stale_patterns(files: list[str]) -> list[str]:
    patterns = []
    for path in files:
        if path not in patterns:
            patterns.append(path)
        parent = str(Path(path).parent).replace("\\", "/")
        if parent and parent != ".":
            pattern = parent + "/**"
            if pattern not in patterns:
                patterns.append(pattern)
    return patterns


def keyword_candidates(summary: dict[str, Any], extra: list[str] | None = None) -> list[str]:
    values = [
        str(summary.get("changeName") or ""),
        str(summary.get("businessGoal") or ""),
        str(summary.get("finalStatus") or ""),
    ]
    values.extend(extra or [])
    tokens: list[str] = []
    for value in values:
        for token in re.findall(r"[\w\u4e00-\u9fff]{2,}", value, flags=re.UNICODE):
            tokens.append(token.lower())
    return tokens[:40]


def extract_entries(project: Path, project_name: str, summary_path: Path) -> list[dict[str, Any]]:
    summary = read_json(summary_path)
    summary_hash = sha256_file(summary_path)
    files = changed_file_paths(summary)
    entries: list[dict[str, Any]] = []
    goal = str(summary.get("businessGoal") or "").strip()

    if goal:
        entries.append(
            make_entry(
                project=project,
                project_name=project_name,
                summary_path=summary_path,
                summary_hash=summary_hash,
                summary=summary,
                entry_type="requirement",
                title=f"{summary.get('changeName') or archive_name(summary_path)}: {first_sentence(goal)}",
                body=goal,
                source_files=files,
                keywords=keyword_candidates(summary, ["requirement", "goal"]),
                confidence="high",
            )
        )

    for idx, note in enumerate(summary.get("maintenanceNotes") or [], start=1):
        text = str(note).strip()
        if not text:
            continue
        entry_type = "decision" if looks_like_decision(text) else "implementation"
        entries.append(
            make_entry(
                project=project,
                project_name=project_name,
                summary_path=summary_path,
                summary_hash=summary_hash,
                summary=summary,
                entry_type=entry_type,
                title=f"{summary.get('changeName') or archive_name(summary_path)} note {idx}: {first_sentence(text)}",
                body=text,
                source_files=files,
                keywords=keyword_candidates(summary, ["maintenance", entry_type]),
                confidence="medium",
            )
        )

    for item in summary.get("changedFiles") or []:
        if not isinstance(item, dict) or not item.get("path"):
            continue
        path = str(item.get("path"))
        text = str(item.get("summary") or path)
        entry_type = "api-contract" if looks_like_contract_path(path) else "implementation"
        entries.append(
            make_entry(
                project=project,
                project_name=project_name,
                summary_path=summary_path,
                summary_hash=summary_hash,
                summary=summary,
                entry_type=entry_type,
                title=f"{path}: {first_sentence(text)}",
                body=f"{path}: {text}",
                source_files=[path],
                keywords=keyword_candidates(summary, [path, entry_type]),
                confidence="medium",
            )
        )

    for idx, risk in enumerate(summary.get("knownRisks") or [], start=1):
        text = str(risk).strip()
        if not text:
            continue
        entries.append(
            make_entry(
                project=project,
                project_name=project_name,
                summary_path=summary_path,
                summary_hash=summary_hash,
                summary=summary,
                entry_type="risk",
                title=f"{summary.get('changeName') or archive_name(summary_path)} risk {idx}: {first_sentence(text)}",
                body=text,
                source_files=files,
                keywords=keyword_candidates(summary, ["risk"]),
                confidence="medium",
            )
        )

    for idx, action in enumerate(summary.get("manualActions") or [], start=1):
        text = str(action).strip()
        if not text:
            continue
        entries.append(
            make_entry(
                project=project,
                project_name=project_name,
                summary_path=summary_path,
                summary_hash=summary_hash,
                summary=summary,
                entry_type="risk",
                title=f"{summary.get('changeName') or archive_name(summary_path)} manual action {idx}: {first_sentence(text)}",
                body="Manual action: " + text,
                source_files=files,
                keywords=keyword_candidates(summary, ["manual", "action", "risk"]),
                confidence="medium",
            )
        )

    verification = summary.get("verification")
    if verification:
        body = json.dumps(verification, ensure_ascii=False, indent=2)
        entries.append(
            make_entry(
                project=project,
                project_name=project_name,
                summary_path=summary_path,
                summary_hash=summary_hash,
                summary=summary,
                entry_type="test-evidence",
                title=f"{summary.get('changeName') or archive_name(summary_path)} verification evidence",
                body=body,
                source_files=files,
                keywords=keyword_candidates(summary, ["test", "verification", "evidence"]),
                confidence="high",
            )
        )

    review = summary.get("reviewSummary")
    if isinstance(review, dict) and review.get("summary"):
        body = str(review.get("summary"))
        entries.append(
            make_entry(
                project=project,
                project_name=project_name,
                summary_path=summary_path,
                summary_hash=summary_hash,
                summary=summary,
                entry_type="risk",
                title=f"{summary.get('changeName') or archive_name(summary_path)} review: {first_sentence(body)}",
                body=body,
                source_files=files,
                keywords=keyword_candidates(summary, ["review", "risk"]),
                confidence="medium",
            )
        )

    return entries


def looks_like_decision(text: str) -> bool:
    needles = ["不新增", "唯一", "保持", "改为", "取代", "决策", "wontfix", "tradeoff", "instead"]
    lower = text.lower()
    return any(needle in lower for needle in needles)


def looks_like_contract_path(path: str) -> bool:
    lower = path.lower()
    return any(part in lower for part in ["openapi", "contract", "schema", "protocol", "api"])


def ensure_knowledge_dirs(knowledge: Path) -> None:
    for sub in [
        "entries/candidate",
        "entries/active",
        "entries/stale",
        "entries/superseded",
        "entries/conflicted",
        "cache/archive-entries",
        "reports",
        "views",
        "context-packs",
    ]:
        (knowledge / sub).mkdir(parents=True, exist_ok=True)


def prune_generated_entries(knowledge: Path, current_entries: list[dict[str, Any]]) -> int:
    """Remove generated entry files that disappeared or moved to another status dir.

    Replaces the old reset-and-rewrite sweep. Preserved entries (active, and
    candidate/stale carrying a manual ``demotedAt``) are never removed, so the
    write-if-changed persist step can detect unchanged entries by content.
    Returns the number of files removed.
    """
    current_by_id: dict[str, dict[str, Any]] = {}
    for entry in current_entries:
        if isinstance(entry, dict) and entry.get("id"):
            current_by_id[str(entry["id"])] = entry
    preserved_ids = {entry["id"] for entry in load_preserved_entries(knowledge)}
    removed = 0
    for status in ["candidate", "stale", "superseded", "conflicted"]:
        status_dir = knowledge / "entries" / status
        if not status_dir.exists():
            continue
        for path in sorted(status_dir.glob("*.json")):
            try:
                entry = read_json(path)
            except (OSError, json.JSONDecodeError):
                path.unlink(missing_ok=True)
                removed += 1
                continue
            eid = entry.get("id") if isinstance(entry, dict) else None
            if eid is None:
                path.unlink(missing_ok=True)
                removed += 1
                continue
            if eid in preserved_ids:
                continue
            replacement = current_by_id.get(str(eid))
            if replacement is None:
                path.unlink(missing_ok=True)
                removed += 1
            elif str(replacement.get("status")) != status:
                # entry moved to another status dir; the new file was already
                # written by the persist step, so remove the stale old file.
                path.unlink(missing_ok=True)
                removed += 1
    return removed


def load_entries_from_dir(path: Path) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    if not path.exists():
        return entries
    for entry_path in sorted(path.glob("*.json")):
        try:
            entry = read_json(entry_path)
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(entry, dict) and entry.get("id"):
            entries.append(entry)
    return entries


def archive_entry_cache_path(project: Path, knowledge: Path, summary_path: Path, summary_hash: str) -> Path:
    rel_summary = rel_to_project(project, summary_path)
    cache_id = short_hash(rel_summary + "|" + summary_hash, 20)
    filename = f"{safe_filename(archive_name(summary_path))}-{cache_id}.json"
    return knowledge / "cache" / "archive-entries" / filename


def load_cached_archive_entries(
    cache_path: Path,
    *,
    summary_path: str,
    summary_hash: str,
) -> list[dict[str, Any]] | None:
    if not cache_path.exists():
        return None
    try:
        payload = read_json(cache_path)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    if payload.get("schemaVersion") != 1:
        return None
    if payload.get("summaryData") != summary_path:
        return None
    if payload.get("summarySha256") != summary_hash:
        return None
    # headCommit is intentionally ignored: archive extraction depends only on the
    # summary-data.json content, so an unrelated HEAD change must not invalidate
    # the extraction cache (design §3.5, cluster 6 — true incremental).
    entries = payload.get("entries")
    if not isinstance(entries, list):
        return None
    if not all(isinstance(entry, dict) and entry.get("id") for entry in entries):
        return None
    return json_clone(entries)


def write_cached_archive_entries(
    cache_path: Path,
    *,
    summary_path: str,
    summary_hash: str,
    entries: list[dict[str, Any]],
) -> None:
    write_json(
        cache_path,
        {
            "schemaVersion": 1,
            "generatedAt": now_iso(),
            "summaryData": summary_path,
            "summarySha256": summary_hash,
            "entries": entries,
        },
    )


def load_preserved_entries(knowledge: Path) -> list[dict[str, Any]]:
    active_entries = load_entries_from_dir(knowledge / "entries" / "active")
    demoted_entries = [
        entry
        for status in ["candidate", "stale"]
        for entry in load_entries_from_dir(knowledge / "entries" / status)
        if entry.get("lifecycle", {}).get("demotedAt")
    ]
    return active_entries + demoted_entries


def combine_generated_with_preserved(knowledge: Path, generated: list[dict[str, Any]]) -> list[dict[str, Any]]:
    preserved_entries = load_preserved_entries(knowledge)
    preserved_ids = {entry["id"] for entry in preserved_entries}
    return preserved_entries + [entry for entry in generated if entry["id"] not in preserved_ids]


def archive_sort_key(entry: dict[str, Any]) -> tuple[str, str]:
    archive = entry.get("source", {}).get("archive", "")
    match = re.search(r"(\d{4}-\d{2}-\d{2})", archive)
    return (match.group(1) if match else "", archive)


def archive_date(entry: dict[str, Any]) -> dt.date | None:
    date_text = archive_sort_key(entry)[0]
    if not date_text:
        return None
    try:
        return dt.date.fromisoformat(date_text)
    except ValueError:
        return None


def clamp_score(value: float) -> float:
    return max(0.0, min(1.0, value))


def confidence_level(score: float) -> str:
    if score >= 0.82:
        return "high"
    if score >= 0.55:
        return "medium"
    return "low"


def entry_age_days(entry: dict[str, Any]) -> int | None:
    date = archive_date(entry)
    if date is None:
        return None
    return max(0, (dt.date.today() - date).days)


def validation_status(entry: dict[str, Any]) -> str | None:
    validation = entry.get("lifecycle", {}).get("validation")
    if not isinstance(validation, dict):
        return None
    status = validation.get("status")
    return str(status) if status else None


def calculate_confidence(entry: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    policy = confidence_config(config)
    legacy = str(entry.get("lifecycle", {}).get("confidence") or "medium")
    score = {"high": 0.76, "medium": 0.58, "low": 0.36}.get(legacy, 0.58)
    signals = [f"base:{legacy}"]

    type_bonus = {
        "decision": 0.14,
        "api-contract": 0.14,
        "requirement": 0.12,
        "pitfall": 0.10,
        "test-evidence": 0.04,
        "implementation": 0.00,
        "risk": -0.04,
    }.get(str(entry.get("type")), 0.0)
    if type_bonus:
        score += type_bonus
        signals.append(f"type_bonus:{entry.get('type')}:{type_bonus:+.2f}")

    final_status = str(entry.get("source", {}).get("finalStatus") or "").strip().lower()
    if final_status in {"ok", "success", "passed", "pass"}:
        score += 0.04
        signals.append("source_final_status_ok:+0.04")
    elif final_status in {"fail", "failed", "error", "warn"}:
        score -= 0.08
        signals.append("source_final_status_not_ok:-0.08")

    if entry.get("scope", {}).get("sourceFiles"):
        score += 0.03
        signals.append("has_source_files:+0.03")

    text = normalized_entry_text(entry)
    if has_stability_signal(text) or str(entry.get("type")) in {"decision", "api-contract"}:
        score += 0.06
        signals.append("long_lived_signal:+0.06")

    status = str(entry.get("status") or "")
    stale_reasons = entry.get("lifecycle", {}).get("staleReasons") or []
    if status == "stale":
        score -= policy["stalePenalty"]
        signals.append("status_stale_penalty")
    if any("source files changed" in str(reason) for reason in stale_reasons):
        score -= policy["sourceChangePenalty"]
        signals.append("source_change_penalty")
    if status == "superseded" or entry.get("lifecycle", {}).get("supersededBy"):
        score -= policy["supersededPenalty"]
        signals.append("superseded_penalty")
    if status == "conflicted" or entry.get("lifecycle", {}).get("conflictsWith"):
        score -= policy["conflictPenalty"]
        signals.append("conflict_penalty")

    validator_status = validation_status(entry)
    if validator_status == "passed":
        score += policy["validatorPassBonus"]
        signals.append("validator_pass_bonus")
    elif validator_status == "failed":
        score -= policy["validatorFailPenalty"]
        signals.append("validator_fail_penalty")
    elif validator_status == "skipped":
        score -= 0.05
        signals.append("validator_skipped_penalty")

    age_days = entry_age_days(entry)
    if age_days is not None:
        age_penalty = min(0.25, (age_days / policy["ttlHalfLifeDays"]) * 0.06)
        if age_penalty:
            score -= age_penalty
            signals.append(f"age_penalty:{age_days}d:-{age_penalty:.2f}")

    score = clamp_score(score)
    return {
        "score": round(score, 3),
        "level": confidence_level(score),
        "signals": signals,
        "lastCalculatedAt": now_iso(),
    }


def apply_confidence_scores(entries: list[dict[str, Any]], config: dict[str, Any]) -> None:
    for entry in entries:
        fresh = calculate_confidence(entry, config)
        existing = entry.get("confidence") if isinstance(entry.get("confidence"), dict) else None
        if existing is not None and (
            existing.get("score") == fresh["score"]
            and existing.get("level") == fresh["level"]
            and existing.get("signals") == fresh["signals"]
        ):
            # The inputs that determine confidence are unchanged; keep the previous
            # lastCalculatedAt so the entry content (and mtime) does not churn on
            # every ingest. This is what makes write-if-changed effective for
            # unchanged entries.
            entry["confidence"] = {
                "score": fresh["score"],
                "level": fresh["level"],
                "signals": fresh["signals"],
                "lastCalculatedAt": existing.get("lastCalculatedAt"),
            }
        else:
            entry["confidence"] = fresh


def should_auto_promote(entry: dict[str, Any], policy: dict[str, Any]) -> bool:
    if not policy["enabled"]:
        return False
    if entry.get("type") not in set(policy["allowedTypes"]):
        return False
    if entry.get("status") == "stale" and not policy["allowStale"]:
        return False
    if entry.get("status") not in {"candidate", "stale"}:
        return False
    if entry.get("status") == "candidate" and entry.get("lifecycle", {}).get("staleReasons"):
        return False
    confidence = entry.get("confidence") if isinstance(entry.get("confidence"), dict) else {}
    if float(confidence.get("score") or 0.0) < policy["minConfidence"]:
        return False
    if policy["requireValidators"] and validation_status(entry) != "passed":
        return False
    if entry.get("lifecycle", {}).get("conflictsWith") or entry.get("lifecycle", {}).get("supersededBy"):
        return False
    return True


def apply_auto_promote_policy(entries: list[dict[str, Any]], config: dict[str, Any]) -> list[dict[str, Any]]:
    policy = auto_promote_config(config)
    if not policy["enabled"] or policy["maxPerRun"] <= 0:
        return []
    eligible = [entry for entry in entries if should_auto_promote(entry, policy)]
    eligible.sort(
        key=lambda entry: (
            float(entry.get("confidence", {}).get("score") or 0.0),
            archive_sort_key(entry),
            entry.get("id", ""),
        ),
        reverse=True,
    )
    actions: list[dict[str, Any]] = []
    for entry in eligible[: policy["maxPerRun"]]:
        entry["status"] = "active"
        lifecycle = entry.setdefault("lifecycle", {})
        score = float(entry.get("confidence", {}).get("score") or 0.0)
        note = f"autoPromote: confidence {score:.3f} >= {policy['minConfidence']:.3f}"
        lifecycle["promotedAt"] = now_iso()
        lifecycle["promotionNote"] = note
        lifecycle["autoPromoted"] = True
        lifecycle["lastCheckedAt"] = now_iso()
        confidence = entry.setdefault("confidence", {})
        signals = confidence.setdefault("signals", [])
        if isinstance(signals, list):
            signals.append("auto_promoted")
        actions.append(
            {
                "id": entry["id"],
                "type": entry.get("type"),
                "score": score,
                "status": "active",
                "reason": note,
            }
        )
    return actions


def _preserve_confidence_timestamp(target: Path, entry: dict[str, Any]) -> None:
    """Keep the on-disk ``lastCalculatedAt`` when confidence is otherwise unchanged.

    Extraction cache stores raw entries whose ``confidence`` is still the legacy
    string, so the first ``apply_confidence_scores`` of every build would mint a
    fresh ``lastCalculatedAt`` and churn unchanged entries. By re-reading the
    on-disk entry just before writing, an unchanged entry keeps its previous
    timestamp and ``write_json_if_changed`` becomes a true no-op (cluster 6).
    """
    if not target.exists():
        return
    try:
        disk = read_json(target)
    except (OSError, json.JSONDecodeError):
        return
    if not isinstance(disk, dict) or disk.get("id") != entry.get("id"):
        return
    disk_conf = disk.get("confidence") if isinstance(disk.get("confidence"), dict) else None
    new_conf = entry.get("confidence") if isinstance(entry.get("confidence"), dict) else None
    if not (disk_conf and new_conf):
        return
    if (
        disk_conf.get("score") == new_conf.get("score")
        and disk_conf.get("level") == new_conf.get("level")
        and disk_conf.get("signals") == new_conf.get("signals")
    ):
        entry["confidence"]["lastCalculatedAt"] = disk_conf.get("lastCalculatedAt")


def persist_entry_updates(knowledge: Path, entries: list[dict[str, Any]]) -> int:
    written = 0
    for entry in entries:
        status = str(entry.get("status") or "")
        if status not in {"candidate", "active", "stale", "superseded", "conflicted"}:
            continue
        path = knowledge / "entries" / status / entry_filename(entry)
        if path.exists():
            _preserve_confidence_timestamp(path, entry)
            if write_json_if_changed(path, entry):
                written += 1
    return written


def normalized_entry_text(entry: dict[str, Any]) -> str:
    return " ".join(
        str(value or "")
        for value in [
            entry.get("title"),
            entry.get("summary"),
            entry.get("body"),
            " ".join(entry.get("keywords") or []),
        ]
    ).lower()


def subject_terms(entry: dict[str, Any]) -> set[str]:
    text = normalized_entry_text(entry)
    terms = set(re.findall(r"[a-zA-Z_][a-zA-Z0-9_.-]{2,}", text))
    stop = {
        "the",
        "and",
        "for",
        "with",
        "from",
        "this",
        "that",
        "status",
        "note",
        "risk",
        "requirement",
        "implementation",
    }
    return {term for term in terms if term not in stop}


def has_replacement_signal(text: str) -> bool:
    needles = [
        "不再",
        "替代",
        "取代",
        "改为",
        "移除",
        "废弃",
        "deprecated",
        "instead",
        "replace",
        "replaced",
        "remove",
        "removed",
    ]
    return any(needle in text for needle in needles)


def has_stability_signal(text: str) -> bool:
    needles = ["唯一", "复用", "保持", "source of truth", "single source", "only source"]
    return any(needle in text for needle in needles)


def entries_conflict(left: dict[str, Any], right: dict[str, Any]) -> bool:
    comparable_types = {"requirement", "decision", "api-contract"}
    if left.get("type") != right.get("type") or left.get("type") not in comparable_types:
        return False
    if left.get("status") in {"active", "stale", "superseded", "conflicted"}:
        return False
    if right.get("status") in {"active", "stale", "superseded", "conflicted"}:
        return False

    left_files = set(left.get("scope", {}).get("sourceFiles") or [])
    right_files = set(right.get("scope", {}).get("sourceFiles") or [])
    if not left_files or not right_files or not (left_files & right_files):
        return False

    shared_terms = subject_terms(left) & subject_terms(right)
    if not shared_terms:
        return False

    left_text = normalized_entry_text(left)
    right_text = normalized_entry_text(right)
    return (
        has_replacement_signal(left_text)
        and has_stability_signal(right_text)
    ) or (
        has_replacement_signal(right_text)
        and has_stability_signal(left_text)
    )


def entries_conflict_for_review(left: dict[str, Any], right: dict[str, Any]) -> bool:
    comparable_types = {"requirement", "decision", "api-contract"}
    if left.get("type") != right.get("type") or left.get("type") not in comparable_types:
        return False

    left_files = set(left.get("scope", {}).get("sourceFiles") or [])
    right_files = set(right.get("scope", {}).get("sourceFiles") or [])
    if not left_files or not right_files or not (left_files & right_files):
        return False

    shared_terms = subject_terms(left) & subject_terms(right)
    if not shared_terms:
        return False

    left_text = normalized_entry_text(left)
    right_text = normalized_entry_text(right)
    return (
        has_replacement_signal(left_text)
        and has_stability_signal(right_text)
    ) or (
        has_replacement_signal(right_text)
        and has_stability_signal(left_text)
    )


def mark_conflict(left: dict[str, Any], right: dict[str, Any]) -> None:
    for entry, other in [(left, right), (right, left)]:
        entry["status"] = "conflicted"
        lifecycle = entry.setdefault("lifecycle", {})
        conflicts = lifecycle.setdefault("conflictsWith", [])
        if other["id"] not in conflicts:
            conflicts.append(other["id"])
        reasons = lifecycle.setdefault("staleReasons", [])
        reason = "potential conflict with: " + other["id"]
        if reason not in reasons:
            reasons.append(reason)
        lifecycle["lastCheckedAt"] = now_iso()


def mark_conflicting_generated_entries(entries: list[dict[str, Any]]) -> None:
    ordered = sorted(entries, key=archive_sort_key)
    for idx, left in enumerate(ordered):
        for right in ordered[idx + 1 :]:
            if entries_conflict(left, right):
                mark_conflict(left, right)


def number_value(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        value = value.strip()
        if value.isdigit():
            return int(value)
    return None


def parse_pass_rate(value: Any) -> tuple[int | None, int | None]:
    if not isinstance(value, str):
        return (None, None)
    match = re.search(r"(\d+)\s*/\s*(\d+)", value)
    if not match:
        return (None, None)
    return (int(match.group(1)), int(match.group(2)))


def collect_verification_metrics(value: Any) -> dict[str, Any]:
    metrics: dict[str, Any] = {
        "failed": 0,
        "passed": 0,
        "total": 0,
        "failedStatus": False,
    }

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            local_passed = None
            local_total = None
            local_ratio_found = False
            for key, raw in node.items():
                key_l = str(key).lower()
                if key_l in {"failures", "failed", "failure", "errors", "error"}:
                    number = number_value(raw)
                    if number is not None:
                        metrics["failed"] += number
                elif key_l in {"passed", "pass", "successes", "succeeded"}:
                    local_passed = number_value(raw)
                elif key_l in {"total", "run", "tests", "count"}:
                    local_total = number_value(raw)
                elif key_l in {"passrate", "pass_rate"}:
                    passed, total = parse_pass_rate(raw)
                    if passed is not None and total is not None:
                        metrics["passed"] += passed
                        metrics["total"] += total
                        local_ratio_found = True
                elif key_l == "status" and isinstance(raw, str):
                    status = raw.strip().lower()
                    if status in {"fail", "failed", "failure", "error", "errored", "red"}:
                        metrics["failedStatus"] = True
                visit(raw)
            if not local_ratio_found and local_passed is not None and local_total is not None:
                metrics["passed"] += local_passed
                metrics["total"] += local_total
        elif isinstance(node, list):
            for item in node:
                visit(item)

    visit(value)
    if metrics["total"]:
        metrics["passRatio"] = metrics["passed"] / metrics["total"]
    else:
        metrics["passRatio"] = None
    return metrics


def verification_metrics(entry: dict[str, Any]) -> dict[str, Any] | None:
    try:
        verification = json.loads(entry.get("body", "") or "{}")
    except json.JSONDecodeError:
        return None
    if not isinstance(verification, (dict, list)):
        return None
    return collect_verification_metrics(verification)


def verification_is_degraded(old_metrics: dict[str, Any] | None, new_metrics: dict[str, Any] | None) -> bool:
    if not new_metrics:
        return False
    if new_metrics.get("failedStatus") or int(new_metrics.get("failed") or 0) > 0:
        return True
    if not old_metrics:
        return False
    old_ratio = old_metrics.get("passRatio")
    new_ratio = new_metrics.get("passRatio")
    if isinstance(old_ratio, (int, float)) and isinstance(new_ratio, (int, float)):
        return new_ratio < old_ratio
    return False


def verification_degradation_detail(metrics: dict[str, Any]) -> str:
    parts: list[str] = []
    if metrics.get("failedStatus"):
        parts.append("failed status")
    failed = int(metrics.get("failed") or 0)
    if failed:
        parts.append(f"failures/errors={failed}")
    ratio = metrics.get("passRatio")
    if isinstance(ratio, (int, float)):
        parts.append(f"passRatio={ratio:.2f}")
    return ", ".join(parts) or "verification metrics worsened"


def mark_degraded_test_evidence(entries: list[dict[str, Any]]) -> None:
    ordered = sorted(entries, key=archive_sort_key)
    for idx, older in enumerate(ordered):
        if older.get("type") != "test-evidence":
            continue
        if older.get("status") in {"active", "superseded", "conflicted"}:
            continue
        older_files = set(older.get("scope", {}).get("sourceFiles") or [])
        if not older_files:
            continue
        old_metrics = verification_metrics(older)
        for newer in ordered[idx + 1 :]:
            if newer.get("type") != "test-evidence":
                continue
            if archive_sort_key(newer) <= archive_sort_key(older):
                continue
            newer_files = set(newer.get("scope", {}).get("sourceFiles") or [])
            if not newer_files or not (older_files & newer_files):
                continue
            new_metrics = verification_metrics(newer)
            if not verification_is_degraded(old_metrics, new_metrics):
                continue
            older["status"] = "stale"
            lifecycle = older.setdefault("lifecycle", {})
            reasons = lifecycle.setdefault("staleReasons", [])
            detail = verification_degradation_detail(new_metrics or {})
            reason = "newer verification degraded: " + newer.get("source", {}).get("archive", "")
            if detail:
                reason += f" ({detail})"
            if reason not in reasons:
                reasons.append(reason)
            lifecycle["lastCheckedAt"] = now_iso()
            break


def active_review_items(entries: list[dict[str, Any]], limit: int | None = None) -> list[dict[str, Any]]:
    comparable_types = {"requirement", "decision", "implementation", "api-contract"}
    ordered = sorted(entries, key=archive_sort_key)
    items: list[dict[str, Any]] = []
    for active in [entry for entry in ordered if entry.get("status") == "active"]:
        reasons: list[str] = []
        active_files = set(active.get("scope", {}).get("sourceFiles") or [])
        if not active_files:
            continue
        active_metrics = verification_metrics(active) if active.get("type") == "test-evidence" else None
        for newer in ordered:
            if newer.get("id") == active.get("id"):
                continue
            if archive_sort_key(newer) <= archive_sort_key(active):
                continue
            newer_files = set(newer.get("scope", {}).get("sourceFiles") or [])
            if not newer_files or not (active_files & newer_files):
                continue
            if entries_conflict_for_review(active, newer):
                reasons.append(f"requires manual review: potential conflict with {newer['id']}")
            elif active.get("type") in comparable_types and newer.get("type") in comparable_types:
                reasons.append(
                    "requires manual review: newer overlapping archive may supersede active entry: "
                    + newer.get("source", {}).get("archive", "")
                )
            if active.get("type") == "test-evidence" and newer.get("type") == "test-evidence":
                newer_metrics = verification_metrics(newer)
                if verification_is_degraded(active_metrics, newer_metrics):
                    reasons.append(
                        "requires manual review: newer verification degraded: "
                        + newer.get("source", {}).get("archive", "")
                    )
        if reasons:
            item = json_clone(active)
            item["reviewReasons"] = sorted(set(reasons))
            items.append(item)
    ranked = sorted(items, key=lambda entry: (len(entry.get("reviewReasons") or []), archive_sort_key(entry)), reverse=True)
    return ranked[:limit] if limit is not None else ranked


def apply_active_lifecycle_policy(
    knowledge: Path,
    entries: list[dict[str, Any]],
    config: dict[str, Any],
) -> list[dict[str, Any]]:
    policy = active_lifecycle_config(config)
    if not policy["autoDemote"]:
        return []

    target_status = policy["targetStatus"]
    actions: list[dict[str, Any]] = []
    for review_entry in active_review_items(entries):
        found = find_entry_file(knowledge, review_entry["id"], ["active"])
        if found is None:
            continue
        source_path, entry = found
        reasons = review_entry.get("reviewReasons") or []
        reason = "activeLifecycle auto-demotion"
        if reasons:
            reason += ": " + str(reasons[0])
        entry["status"] = target_status
        lifecycle = entry.setdefault("lifecycle", {})
        lifecycle["demotedAt"] = now_iso()
        lifecycle["demotionReason"] = reason
        lifecycle["autoDemoted"] = True
        lifecycle["lastCheckedAt"] = now_iso()
        if target_status == "stale":
            stale_reasons = lifecycle.setdefault("staleReasons", [])
            stale_reason = "auto demotion: " + reason
            if stale_reason not in stale_reasons:
                stale_reasons.append(stale_reason)
        target_path = knowledge / "entries" / target_status / entry_filename(entry)
        write_json(target_path, entry)
        if source_path != target_path and source_path.exists():
            source_path.unlink()
        actions.append(
            {
                "id": entry["id"],
                "status": target_status,
                "reason": reason,
                "path": str(target_path),
            }
        )
    return actions


def load_entry_files(
    knowledge: Path,
    statuses: list[str] | None = None,
) -> list[tuple[Path, dict[str, Any]]]:
    selected = statuses or ["candidate", "active", "stale", "superseded", "conflicted"]
    found: list[tuple[Path, dict[str, Any]]] = []
    for status in selected:
        for path in sorted((knowledge / "entries" / status).glob("*.json")):
            try:
                entry = read_json(path)
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(entry, dict) and entry.get("id"):
                found.append((path, entry))
    return found


def safe_project_path(project: Path, rel_path: str) -> Path | None:
    if not rel_path:
        return None
    candidate = (project / rel_path).resolve()
    try:
        candidate.relative_to(project.resolve())
    except ValueError:
        return None
    return candidate


def validator_result(
    validator: dict[str, Any],
    status: str,
    message: str,
) -> dict[str, Any]:
    result = {
        "type": str(validator.get("type") or "unknown"),
        "status": status,
        "message": message,
    }
    description = validator.get("description")
    if description:
        result["description"] = str(description)
    for key in ["path", "pattern", "symbol", "command"]:
        if key in validator:
            result[key] = validator[key]
    return result


def read_project_text(project: Path, rel_path: str) -> tuple[Path | None, str | None, str | None]:
    path = safe_project_path(project, rel_path)
    if path is None:
        return None, None, f"path escapes project root: {rel_path}"
    if not path.exists():
        return path, None, f"file missing: {rel_path}"
    if not path.is_file():
        return path, None, f"path is not a file: {rel_path}"
    try:
        return path, path.read_text(encoding="utf-8", errors="ignore"), None
    except OSError as exc:
        return path, None, f"file could not be read: {exc}"


def evaluate_file_exists(project: Path, validator: dict[str, Any]) -> dict[str, Any]:
    rel_path = str(validator.get("path") or "")
    path = safe_project_path(project, rel_path)
    if path is None:
        return validator_result(validator, "failed", f"path escapes project root: {rel_path}")
    if path.exists():
        return validator_result(validator, "passed", f"file exists: {rel_path}")
    return validator_result(validator, "failed", f"file missing: {rel_path}")


def evaluate_file_contains(project: Path, validator: dict[str, Any]) -> dict[str, Any]:
    rel_path = str(validator.get("path") or "")
    pattern = str(validator.get("pattern") or "")
    if not pattern:
        return validator_result(validator, "failed", "file_contains validator requires pattern")
    _, text, error = read_project_text(project, rel_path)
    if error is not None:
        return validator_result(validator, "failed", error)
    if pattern in (text or ""):
        return validator_result(validator, "passed", f"file contains pattern: {rel_path}")
    return validator_result(validator, "failed", f"pattern not found in file: {rel_path}")


def evaluate_symbol_exists(project: Path, entry: dict[str, Any], validator: dict[str, Any]) -> dict[str, Any]:
    symbol = str(validator.get("symbol") or "")
    if not symbol:
        return validator_result(validator, "failed", "symbol_exists validator requires symbol")
    raw_files = validator.get("files")
    files = raw_files if isinstance(raw_files, list) else entry.get("scope", {}).get("sourceFiles") or []
    files = [str(path) for path in files if path]
    if not files:
        return validator_result(validator, "failed", "symbol_exists validator requires files or sourceFiles")
    checked: list[str] = []
    missing: list[str] = []
    for rel_path in files:
        checked.append(rel_path)
        _, text, error = read_project_text(project, rel_path)
        if error is not None:
            missing.append(error)
            continue
        if symbol in (text or ""):
            return validator_result(validator, "passed", f"symbol found in {rel_path}")
    detail = "; ".join(missing[:3]) if missing else "symbol not found"
    return validator_result(validator, "failed", f"{detail}; checked: {', '.join(checked[:8])}")


def evaluate_command_validator(project: Path, validator: dict[str, Any], config: dict[str, Any]) -> dict[str, Any]:
    if not config["allowCommandValidators"]:
        return validator_result(validator, "skipped", "command validators disabled by knowledgeValidation.allowCommandValidators")
    command = validator.get("command")
    if not isinstance(command, list) or not all(isinstance(part, str) for part in command):
        return validator_result(validator, "failed", "command validator requires command as a string array")
    timeout = max(1, int(config.get("commandTimeoutSeconds") or 60))
    try:
        completed = subprocess.run(
            command,
            cwd=str(project),
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return validator_result(validator, "failed", f"command timed out after {timeout}s")
    except OSError as exc:
        return validator_result(validator, "failed", f"command could not be started: {exc}")
    if completed.returncode == 0:
        return validator_result(validator, "passed", "command exited 0")
    detail = first_sentence((completed.stderr or completed.stdout or "").strip())
    return validator_result(validator, "failed", f"command exited {completed.returncode}: {detail}")


def evaluate_validator(
    project: Path,
    entry: dict[str, Any],
    validator: dict[str, Any],
    config: dict[str, Any],
) -> dict[str, Any]:
    validator_type = str(validator.get("type") or "")
    if validator_type == "file_exists":
        return evaluate_file_exists(project, validator)
    if validator_type == "file_contains":
        return evaluate_file_contains(project, validator)
    if validator_type == "symbol_exists":
        return evaluate_symbol_exists(project, entry, validator)
    if validator_type == "command":
        return evaluate_command_validator(project, validator, config)
    return validator_result(validator, "failed", f"unknown validator type: {validator_type or 'missing'}")


def evaluate_entry_validators(
    project: Path,
    entry: dict[str, Any],
    config: dict[str, Any],
) -> dict[str, Any] | None:
    validators = entry.get("validators")
    if not isinstance(validators, list) or not validators:
        return None
    results = [
        evaluate_validator(project, entry, validator, config)
        if isinstance(validator, dict)
        else {"type": "invalid", "status": "failed", "message": "validator must be an object"}
        for validator in validators
    ]
    statuses = [str(result.get("status")) for result in results]
    if "failed" in statuses:
        status = "failed"
    elif "passed" in statuses:
        status = "passed"
    else:
        status = "skipped"
    validation = {
        "validatedAt": now_iso(),
        "status": status,
        "results": results,
    }
    lifecycle = entry.setdefault("lifecycle", {})
    lifecycle["validation"] = validation
    lifecycle["lastCheckedAt"] = validation["validatedAt"]
    return validation


def first_failed_validator_message(validation: dict[str, Any]) -> str:
    for result in validation.get("results") or []:
        if isinstance(result, dict) and result.get("status") == "failed":
            description = result.get("description")
            message = result.get("message")
            if description and message:
                return f"{description}: {message}"
            return str(message or description or "validator failed")
    return "validator failed"


def apply_knowledge_validation(
    project: Path,
    knowledge: Path,
    config: dict[str, Any],
) -> dict[str, Any]:
    policy = knowledge_validation_config(config)
    summary: dict[str, Any] = {
        "enabled": policy["enabled"],
        "checked": 0,
        "passed": 0,
        "failed": 0,
        "skipped": 0,
        "autoDemoted": 0,
        "entries": [],
    }
    if not policy["enabled"]:
        return summary

    for source_path, entry in load_entry_files(knowledge):
        validation = evaluate_entry_validators(project, entry, policy)
        if validation is None:
            continue
        summary["checked"] += 1
        summary[validation["status"]] += 1
        entry_summary = {
            "id": entry["id"],
            "status": entry.get("status"),
            "validationStatus": validation["status"],
            "results": validation["results"],
        }
        if validation["status"] == "failed" and entry.get("status") == "active" and policy["autoDemoteActive"]:
            target_status = policy["defaultTargetStatus"]
            reason = "validator failed: " + first_failed_validator_message(validation)
            lifecycle = entry.setdefault("lifecycle", {})
            lifecycle["previousStatus"] = str(entry.get("status") or "active")
            entry["status"] = target_status
            lifecycle["demotedAt"] = now_iso()
            lifecycle["demotionReason"] = reason
            lifecycle["autoDemoted"] = True
            stale_reasons = lifecycle.setdefault("staleReasons", [])
            if reason not in stale_reasons:
                stale_reasons.append(reason)
            target_path = knowledge / "entries" / target_status / entry_filename(entry)
            write_json(target_path, entry)
            if source_path != target_path and source_path.exists():
                source_path.unlink()
            summary["autoDemoted"] += 1
            entry_summary["status"] = target_status
            entry_summary["autoDemoted"] = True
        else:
            write_json(source_path, entry)
        summary["entries"].append(entry_summary)
    return summary


def supersede_overlapping_generated_entries(entries: list[dict[str, Any]]) -> None:
    comparable_types = {"requirement", "decision", "implementation", "api-contract"}
    ordered = sorted(entries, key=archive_sort_key)
    for idx, older in enumerate(ordered):
        if older.get("status") in {"active", "conflicted"} or older.get("type") not in comparable_types:
            continue
        older_files = set(older.get("scope", {}).get("sourceFiles") or [])
        if not older_files:
            continue
        for newer in ordered[idx + 1 :]:
            if newer.get("status") == "conflicted":
                continue
            if newer.get("type") not in comparable_types:
                continue
            if archive_sort_key(newer) <= archive_sort_key(older):
                continue
            newer_files = set(newer.get("scope", {}).get("sourceFiles") or [])
            overlap = sorted(older_files & newer_files)
            if not overlap:
                continue
            older["status"] = "superseded"
            lifecycle = older.setdefault("lifecycle", {})
            lifecycle["supersededBy"] = newer["id"]
            reasons = lifecycle.setdefault("staleReasons", [])
            reason = "overlapped by newer archive: " + newer.get("source", {}).get("archive", "")
            if reason not in reasons:
                reasons.append(reason)
            lifecycle["lastCheckedAt"] = now_iso()
            break


def ttl_days_from_config(config: dict[str, Any]) -> int | None:
    raw = config.get("staleTtlDays")
    if raw is None:
        return None
    try:
        ttl_days = int(raw)
    except (TypeError, ValueError):
        return None
    return ttl_days if ttl_days > 0 else None


def apply_ttl_stale(entries: list[dict[str, Any]], config: dict[str, Any]) -> None:
    ttl_days = ttl_days_from_config(config)
    if ttl_days is None:
        return

    today = dt.date.today()
    for entry in entries:
        if entry.get("status") in {"active", "superseded", "conflicted"}:
            continue
        archived_on = archive_date(entry)
        if archived_on is None:
            continue
        age_days = (today - archived_on).days
        if age_days <= ttl_days:
            continue

        entry["status"] = "stale"
        lifecycle = entry.setdefault("lifecycle", {})
        reasons = lifecycle.setdefault("staleReasons", [])
        reason = f"ttl expired: archive age {age_days} days exceeds staleTtlDays {ttl_days}"
        if reason not in reasons:
            reasons.append(reason)
        lifecycle["lastCheckedAt"] = now_iso()


SQLITE_SCHEMA_VERSION = 1


def compute_inputs_hash(
    records: list[dict[str, Any]], config: dict[str, Any], knowledge: Path
) -> str:
    """Stable hash of the inputs that determine knowledge index content.

    Excludes HEAD on purpose: a business-code commit that does not touch any
    archive must not invalidate the index (design §3.5, cluster 6 — true
    incremental). Inputs are archive checksums + knowledge config + schema
    versions + preserved entries (active / manually demoted), so promote/demote
    correctly invalidate the no-op fast path.
    """
    archive_fingerprint = json.dumps(
        sorted(
            (
                {"path": r.get("summaryData"), "sha256": r.get("summarySha256")}
                for r in records
            ),
            key=lambda item: item["path"] or "",
        ),
        ensure_ascii=False,
        sort_keys=True,
    )
    config_fingerprint = json.dumps(config, ensure_ascii=False, sort_keys=True)
    schema_fingerprint = json.dumps(
        {
            "entrySchemaVersion": 1,
            "indexSchemaVersion": 1,
            "sqliteSchemaVersion": SQLITE_SCHEMA_VERSION,
        },
        sort_keys=True,
    )
    preserved = load_preserved_entries(knowledge)
    preserved_fingerprint = json.dumps(
        sorted(
            (
                {
                    "id": e.get("id"),
                    "status": e.get("status"),
                    "lifecycle": e.get("lifecycle", {}),
                }
                for e in preserved
            ),
            key=lambda item: item["id"] or "",
        ),
        ensure_ascii=False,
        sort_keys=True,
    )
    digest = hashlib.sha256()
    digest.update(archive_fingerprint.encode("utf-8"))
    digest.update(b"|config|")
    digest.update(config_fingerprint.encode("utf-8"))
    digest.update(b"|schema|")
    digest.update(schema_fingerprint.encode("utf-8"))
    digest.update(b"|preserved|")
    digest.update(preserved_fingerprint.encode("utf-8"))
    return digest.hexdigest()


class KnowledgeSnapshot:
    """Shared per-invocation snapshot (design §3.5 / cluster 6 要点2).

    Loads config + archive records + inputs_hash once so auto/maintain/sync/query
    can pass it through instead of independently recomputing inputs_hash, reloading
    config, or rescanning archives. HEAD is intentionally not part of the snapshot
    -- an unrelated business-code commit must not invalidate the index.
    """

    __slots__ = (
        "project",
        "knowledge",
        "pname",
        "config",
        "summary_paths",
        "archive_records",
        "inputs_hash",
    )

    def __init__(
        self,
        project: Path,
        knowledge: Path,
        pname: str,
        config: dict[str, Any],
        summary_paths: list[Path],
        archive_records: list[dict[str, Any]],
        inputs_hash: str,
    ) -> None:
        self.project = project
        self.knowledge = knowledge
        self.pname = pname
        self.config = config
        self.summary_paths = summary_paths
        self.archive_records = archive_records
        self.inputs_hash = inputs_hash


def build_snapshot(project: Path) -> KnowledgeSnapshot:
    """Load config + archive records + inputs_hash exactly once for one invocation."""
    project = project.resolve()
    knowledge = project / ".harness" / "knowledge"
    pname = project_id(project)
    config = load_config(knowledge)
    summary_paths = sorted(
        (project / ".harness" / "archive").glob("*/reports/final/summary-data.json")
    )
    archive_records = archive_summary_records(project, summary_paths)
    inputs_hash = compute_inputs_hash(archive_records, config, knowledge)
    return KnowledgeSnapshot(
        project, knowledge, pname, config, summary_paths, archive_records, inputs_hash
    )


def build_index(
    project: Path,
    incremental: bool = True,
    *,
    snapshot: KnowledgeSnapshot | None = None,
) -> dict[str, Any]:
    project = project.resolve()
    if snapshot is not None:
        # Reuse the single-invocation snapshot: no recomputation of
        # config / archive records / inputs_hash (design §3.5, cluster 6 要点2).
        knowledge = snapshot.knowledge
        pname = snapshot.pname
        config = snapshot.config
        summary_paths = snapshot.summary_paths
        archive_records = snapshot.archive_records
        inputs_hash = snapshot.inputs_hash
    else:
        knowledge = project / ".harness" / "knowledge"
        pname = project_id(project)
        config = load_config(knowledge)
        summary_paths = sorted(
            (project / ".harness" / "archive").glob("*/reports/final/summary-data.json")
        )
        archive_records = archive_summary_records(project, summary_paths)
        inputs_hash = compute_inputs_hash(archive_records, config, knowledge)
    ensure_knowledge_dirs(knowledge)

    # No-op fast path: inputs (archive checksums + config + schema) are unchanged.
    # Write nothing — entries, sqlite, index and views all stay byte-identical,
    # so a repeated ingest is a true no-op (design §3.5, cluster 6, UT-025).
    # Also require index.sqlite to exist so a query never sees a stale index.json
    # pointing at a missing sqlite (API-009 single ensure-current).
    if incremental:
        old_index: dict[str, Any] | None = None
        index_path = knowledge / "index.json"
        if index_path.exists():
            try:
                old_index = read_json(index_path)
            except (OSError, json.JSONDecodeError):
                old_index = None
        if (
            isinstance(old_index, dict)
            and old_index.get("inputsHash") == inputs_hash
            and (knowledge / "index.sqlite").exists()
        ):
            stale_mode = dict(old_index.get("ingestMode", {}))
            stale_mode.update(
                {
                    "mode": "no-op",
                    "incremental": incremental,
                    "inputsHash": inputs_hash,
                    "entriesWritten": 0,
                    "entriesPruned": 0,
                    "archivesExtracted": 0,
                    "archivesReused": len(summary_paths),
                    "cacheWrites": 0,
                    "sqliteRebuild": 0,
                    "sqliteUpsert": 0,
                    "sqliteDelete": 0,
                }
            )
            result = dict(old_index)
            result["ingestMode"] = stale_mode
            return result

    mode = "cold" if not (knowledge / "index.json").exists() else "warm"
    current_head = git_head(project)  # recorded in manifest only; not an invalidation key
    entries: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    ingest_mode: dict[str, Any] = {
        "incremental": incremental,
        "mode": mode,
        "inputsHash": inputs_hash,
        "entriesWritten": 0,
        "entriesPruned": 0,
        "archivesExtracted": 0,
        "archivesReused": 0,
        "cacheWrites": 0,
        "activeAutoDemoted": 0,
        "confidenceScored": 0,
        "candidateAutoPromoted": 0,
        "validationChecked": 0,
        "validationFailed": 0,
        "validationAutoDemoted": 0,
        "sqliteRebuild": 0,
        "sqliteUpsert": 0,
        "sqliteDelete": 0,
    }

    for summary_path in summary_paths:
        summary_rel = rel_to_project(project, summary_path)
        summary_hash = sha256_file(summary_path)
        cache_path = archive_entry_cache_path(project, knowledge, summary_path, summary_hash)
        try:
            archive_entries = None
            if incremental:
                archive_entries = load_cached_archive_entries(
                    cache_path,
                    summary_path=summary_rel,
                    summary_hash=summary_hash,
                )
            if archive_entries is None:
                archive_entries = extract_entries(project, pname, summary_path)
                ingest_mode["archivesExtracted"] += 1
                if incremental:
                    write_cached_archive_entries(
                        cache_path,
                        summary_path=summary_rel,
                        summary_hash=summary_hash,
                        entries=archive_entries,
                    )
                    ingest_mode["cacheWrites"] += 1
            else:
                ingest_mode["archivesReused"] += 1
            entries.extend(archive_entries)
        except Exception as exc:  # keep one bad archive from blocking the index
            failures.append({"path": rel_to_project(project, summary_path), "error": str(exc)})

    seen: set[str] = set()
    deduped: list[dict[str, Any]] = []
    duplicates = 0
    for entry in entries:
        fingerprint = (
            entry["type"],
            entry["title"],
            entry["body"],
            entry["source"]["archive"],
        )
        fp = json.dumps(fingerprint, ensure_ascii=False, sort_keys=True)
        if fp in seen:
            duplicates += 1
            continue
        seen.add(fp)
        deduped.append(entry)

    near_dedupe = dedupe_near_duplicates(deduped)
    ingest_mode["nearDuplicatesMerged"] = near_dedupe["merged"]

    mark_conflicting_generated_entries(deduped)
    mark_degraded_test_evidence(deduped)
    supersede_overlapping_generated_entries(deduped)
    apply_ttl_stale(deduped, config)
    apply_confidence_scores(deduped, config)
    auto_promotions = apply_auto_promote_policy(deduped, config)
    ingest_mode["confidenceScored"] = len(deduped)
    ingest_mode["candidateAutoPromoted"] = len(auto_promotions)

    preserved_ids = {entry["id"] for entry in load_preserved_entries(knowledge)}
    for entry in deduped:
        if entry["id"] in preserved_ids:
            continue
        status = entry["status"]
        filename = entry_filename(entry)
        target = knowledge / "entries" / status / filename
        if target.exists():
            try:
                existing = read_json(target)
            except (OSError, json.JSONDecodeError):
                existing = None
            if isinstance(existing, dict) and existing.get("id") != entry["id"]:
                failures.append({"id": entry["id"], "reason": "filename collision",
                                 "path": str(target), "conflictsWith": existing.get("id")})
                continue
        _preserve_confidence_timestamp(target, entry)
        if write_json_if_changed(target, entry):
            ingest_mode["entriesWritten"] += 1

    indexed_entries = combine_generated_with_preserved(knowledge, deduped)
    apply_confidence_scores(indexed_entries, config)
    ingest_mode["entriesWritten"] += persist_entry_updates(knowledge, indexed_entries)
    auto_demotions = apply_active_lifecycle_policy(knowledge, indexed_entries, config)
    ingest_mode["activeAutoDemoted"] = len(auto_demotions)
    validation = apply_knowledge_validation(project, knowledge, config)
    ingest_mode["validationChecked"] = validation["checked"]
    ingest_mode["validationFailed"] = validation["failed"]
    ingest_mode["validationAutoDemoted"] = validation["autoDemoted"]
    if auto_demotions:
        indexed_entries = combine_generated_with_preserved(knowledge, deduped)
    if validation["checked"]:
        indexed_entries = [entry for _, entry in load_entry_files(knowledge)]
    apply_confidence_scores(indexed_entries, config)
    ingest_mode["entriesWritten"] += persist_entry_updates(knowledge, indexed_entries)
    ingest_mode["confidenceScored"] = len(indexed_entries)
    ingest_mode["entriesPruned"] = prune_generated_entries(knowledge, indexed_entries)

    sqlite_stats = write_sqlite(knowledge / "index.sqlite", indexed_entries)
    ingest_mode.update(sqlite_stats)
    index = make_manifest(
        project,
        pname,
        summary_paths,
        archive_records,
        indexed_entries,
        failures,
        duplicates,
        ingest_mode,
    )
    write_json_if_changed(knowledge / "index.json", index)
    write_views(knowledge, index, indexed_entries)
    write_ingest_report(knowledge, index, failures, duplicates)
    return index


def find_entry_file(knowledge: Path, entry_id: str, statuses: list[str]) -> tuple[Path, dict[str, Any]] | None:
    for status in statuses:
        for path in sorted((knowledge / "entries" / status).glob("*.json")):
            try:
                entry = read_json(path)
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(entry, dict) and entry.get("id") == entry_id:
                return path, entry
    return None


def promote_entry(project: Path, entry_id: str, note: str, allow_stale: bool = False) -> dict[str, Any]:
    project = project.resolve()
    knowledge = project / ".harness" / "knowledge"
    if not (knowledge / "index.json").exists():
        build_index(project)

    statuses = ["candidate"]
    if allow_stale:
        statuses.append("stale")
    found = find_entry_file(knowledge, entry_id, statuses)
    if found is None:
        stale_found = find_entry_file(knowledge, entry_id, ["stale"])
        if stale_found is not None and not allow_stale:
            raise ValueError("entry is stale; rerun with --allow-stale only after manual verification")
        raise ValueError(f"entry not found in promotable statuses: {entry_id}")

    source_path, entry = found
    entry["status"] = "active"
    lifecycle = entry.setdefault("lifecycle", {})
    lifecycle["promotedAt"] = now_iso()
    lifecycle["promotionNote"] = note
    lifecycle["lastCheckedAt"] = now_iso()
    active_path = knowledge / "entries" / "active" / entry_filename(entry)
    write_json(active_path, entry)
    if source_path != active_path and source_path.exists():
        source_path.unlink()
    index = build_index(project)
    return {
        "id": entry["id"],
        "status": "active",
        "activePath": str(active_path),
        "index": str(knowledge / "index.json"),
        "stats": index["stats"],
    }


def demote_entry(project: Path, entry_id: str, target_status: str, reason: str) -> dict[str, Any]:
    if target_status not in {"candidate", "stale"}:
        raise ValueError("demote target status must be candidate or stale")
    project = project.resolve()
    knowledge = project / ".harness" / "knowledge"
    if not (knowledge / "index.json").exists():
        build_index(project)

    found = find_entry_file(knowledge, entry_id, ["active"])
    if found is None:
        raise ValueError(f"active entry not found: {entry_id}")

    source_path, entry = found
    previous = str(entry.get("status") or "active")
    entry["status"] = target_status
    lifecycle = entry.setdefault("lifecycle", {})
    lifecycle["previousStatus"] = previous
    lifecycle["demotedAt"] = now_iso()
    lifecycle["demotionReason"] = reason
    lifecycle["lastCheckedAt"] = now_iso()
    if target_status == "stale":
        stale_reasons = lifecycle.setdefault("staleReasons", [])
        stale_reason = "manual demotion: " + reason
        if stale_reason not in stale_reasons:
            stale_reasons.append(stale_reason)

    target_path = knowledge / "entries" / target_status / entry_filename(entry)
    write_json(target_path, entry)
    if source_path != target_path and source_path.exists():
        source_path.unlink()
    index = build_index(project)
    return {
        "id": entry["id"],
        "status": target_status,
        "path": str(target_path),
        "index": str(knowledge / "index.json"),
        "stats": index["stats"],
    }


def read_sqlite_entries(sqlite_path: Path) -> list[dict[str, Any]]:
    con = sqlite3.connect(sqlite_path)
    try:
        rows = con.execute("select entry_json from entries").fetchall()
        return [json.loads(row[0]) for row in rows]
    finally:
        con.close()


def load_indexed_entries(project: Path) -> list[dict[str, Any]]:
    project = project.resolve()
    sqlite_path = project / ".harness" / "knowledge" / "index.sqlite"
    if not sqlite_path.exists():
        build_index(project)
    return read_sqlite_entries(sqlite_path)


def audit_entries(project: Path, limit: int = 10) -> dict[str, Any]:
    project = project.resolve()
    knowledge = project / ".harness" / "knowledge"
    sync = sync_status(project)
    if not sync["upToDate"]:
        build_index(project)
    entries = load_indexed_entries(project)
    candidates = sorted(
        [entry for entry in entries if entry["status"] == "candidate"],
        key=lambda entry: score_entry(entry, " ".join(entry.get("keywords") or [])),
        reverse=True,
    )[:limit]
    stale = sorted(
        [entry for entry in entries if entry["status"] == "stale"],
        key=lambda entry: (len(entry.get("lifecycle", {}).get("staleReasons") or []), score_entry(entry, "")),
        reverse=True,
    )[:limit]
    superseded = sorted(
        [entry for entry in entries if entry["status"] == "superseded"],
        key=archive_sort_key,
        reverse=True,
    )[:limit]
    conflicted = sorted(
        [entry for entry in entries if entry["status"] == "conflicted"],
        key=archive_sort_key,
        reverse=True,
    )[:limit]
    active_review = active_review_items(entries, limit)
    report_path = knowledge / "reports" / f"audit-report-{timestamp()}.md"
    lines = [
        "# Harness Knowledge Audit Report",
        "",
        f"- generatedAt: {now_iso()}",
        f"- project: `{project}`",
        f"- limit: {limit}",
        "",
        "## Candidate Review",
        "",
    ]
    if not candidates:
        lines.append("No candidate entries found.")
    for entry in candidates:
        lines.extend(render_audit_entry(entry))
    lines.extend(["", "## Stale Review", ""])
    if not stale:
        lines.append("No stale entries found.")
    for entry in stale:
        lines.extend(render_audit_entry(entry, include_reasons=True))
    lines.extend(["", "## Superseded Review", ""])
    if not superseded:
        lines.append("No superseded entries found.")
    for entry in superseded:
        lines.extend(render_audit_entry(entry, include_reasons=True))
    lines.extend(["", "## Conflict Review", ""])
    if not conflicted:
        lines.append("No conflicted entries found.")
    for entry in conflicted:
        lines.extend(render_audit_entry(entry, include_reasons=True, include_conflicts=True))
    lines.extend(["", "## Active Review", ""])
    if not active_review:
        lines.append("No active entries require manual review.")
    for entry in active_review:
        lines.extend(render_audit_entry(entry, include_review=True))
    write_text(report_path, "\n".join(lines) + "\n")
    return {
        "project": str(project),
        "limit": limit,
        "report": str(report_path),
        "candidateReview": [audit_summary(entry) for entry in candidates],
        "staleReview": [audit_summary(entry) for entry in stale],
        "supersededReview": [audit_summary(entry) for entry in superseded],
        "conflictReview": [audit_summary(entry) for entry in conflicted],
        "activeReview": [audit_summary(entry) for entry in active_review],
    }


def audit_summary(entry: dict[str, Any]) -> dict[str, Any]:
    summary = {
        "id": entry["id"],
        "type": entry["type"],
        "status": entry["status"],
        "title": entry["title"],
        "sourceArchive": entry["source"]["archive"],
        "sourceFiles": entry["scope"]["sourceFiles"],
    }
    if entry.get("reviewReasons"):
        summary["reviewReasons"] = entry["reviewReasons"]
    return summary


def render_audit_entry(
    entry: dict[str, Any],
    include_reasons: bool = False,
    include_conflicts: bool = False,
    include_review: bool = False,
) -> list[str]:
    lines = [
        f"- {entry['title']}",
        f"  - id: `{entry['id']}`",
        f"  - type/status: `{entry['type']}` / `{entry['status']}`",
        f"  - source: `{entry['source']['archive']}`",
    ]
    if entry["scope"]["sourceFiles"]:
        lines.append("  - files: " + ", ".join(f"`{path}`" for path in entry["scope"]["sourceFiles"][:6]))
    if include_reasons:
        for reason in entry.get("lifecycle", {}).get("staleReasons") or []:
            lines.append(f"  - reason: {reason}")
    if include_conflicts:
        for conflict_id in entry.get("lifecycle", {}).get("conflictsWith") or []:
            lines.append(f"  - conflictsWith: `{conflict_id}`")
    if include_review:
        for reason in entry.get("reviewReasons") or []:
            lines.append(f"  - review: {reason}")
    return lines


def make_manifest(
    project: Path,
    pname: str,
    summary_paths: list[Path],
    archive_records: list[dict[str, Any]],
    entries: list[dict[str, Any]],
    failures: list[dict[str, str]],
    duplicates: int,
    ingest_mode: dict[str, Any] | None = None,
) -> dict[str, Any]:
    stats = {status: 0 for status in ["candidate", "active", "stale", "superseded", "deprecated", "conflicted"]}
    by_type = {entry_type: 0 for entry_type in sorted(ENTRY_TYPES)}
    for entry in entries:
        stats[entry["status"]] = stats.get(entry["status"], 0) + 1
        by_type[entry["type"]] = by_type.get(entry["type"], 0) + 1

    manifest_entries = [
        {
            "id": e["id"],
            "type": e["type"],
            "status": e["status"],
            "title": e["title"],
            "sourceArchive": e["source"]["archive"],
            "sourceCommit": e["source"]["sourceCommit"],
            "sourceFiles": e["scope"]["sourceFiles"],
            "confidence": e.get("confidence", {}),
        }
        for e in sorted(entries, key=lambda item: (item["source"]["archive"], item["type"], item["title"]))
    ]

    return {
        "schemaVersion": 1,
        "generatedAt": now_iso(),
        "projectId": pname,
        "projectRoot": str(project),
        "headCommit": git_head(project),
        "inputsHash": (ingest_mode or {}).get("inputsHash"),
        "archives": {
            "scanned": len(summary_paths),
            "indexed": len(summary_paths) - len(failures),
            "failed": len(failures),
            "items": archive_records,
        },
        "stats": stats,
        "byType": by_type,
        "duplicatesSkipped": duplicates,
        "ingestMode": ingest_mode or {
            "incremental": False,
            "archivesExtracted": len(summary_paths) - len(failures),
            "archivesReused": 0,
            "cacheWrites": 0,
            "activeAutoDemoted": 0,
            "confidenceScored": 0,
            "candidateAutoPromoted": 0,
            "validationChecked": 0,
            "validationFailed": 0,
            "validationAutoDemoted": 0,
        },
        "failures": failures,
        "entries": manifest_entries,
    }


def write_sqlite(path: Path, entries: list[dict[str, Any]]) -> dict[str, Any]:
    """Persist entries to SQLite using a transactional dirty-set.

    Reads existing rows, then upserts only changed entries and deletes removed
    ones within a single transaction. When the schema version changes or the
    table is missing, performs a full rebuild. If nothing changed the file is
    not touched (cluster 6, design §3.5 — true incremental).
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    stats: dict[str, Any] = {
        "sqliteRebuild": 0,
        "sqliteUpsert": 0,
        "sqliteDelete": 0,
        "sqliteUnchanged": 0,
    }
    con = sqlite3.connect(path)
    try:
        con.execute("pragma journal_mode=wal")
        table_exists = con.execute(
            "select name from sqlite_master where type='table' and name='entries'"
        ).fetchone()
        existing_version = (
            con.execute("pragma user_version").fetchone()[0] if table_exists else 0
        )
        need_rebuild = (not table_exists) or existing_version != SQLITE_SCHEMA_VERSION

        existing_map: dict[str, str] = {}
        if not need_rebuild:
            rows = con.execute("select id, entry_json from entries").fetchall()
            existing_map = {str(row[0]): str(row[1]) for row in rows}

        new_map: dict[str, str] = {}
        for entry in entries:
            if isinstance(entry, dict) and entry.get("id"):
                new_map[str(entry["id"])] = json.dumps(entry, ensure_ascii=False)

        to_upsert = [eid for eid in new_map if new_map[eid] != existing_map.get(eid)]
        to_delete = [eid for eid in existing_map if eid not in new_map]
        stats["sqliteUnchanged"] = len(new_map) - len(to_upsert)

        if not need_rebuild and not to_upsert and not to_delete:
            # nothing to do; leave the file (and its mtime) untouched
            return stats

        if need_rebuild:
            con.execute("drop table if exists entries")
            con.execute("drop table if exists entry_files")
            con.execute("drop table if exists entries_fts")
            con.execute(
                """
                create table entries (
                  id text primary key,
                  project_id text not null,
                  type text not null,
                  status text not null,
                  title text not null,
                  summary text not null,
                  body text not null,
                  source_archive text not null,
                  source_commit text,
                  source_files_json text not null,
                  keywords_json text not null,
                  entry_json text not null
                )
                """
            )
            con.execute(
                """
                create table entry_files (
                  entry_id text not null,
                  source_file text not null,
                  primary key (entry_id, source_file),
                  foreign key (entry_id) references entries(id)
                )
                """
            )
            con.execute("create virtual table entries_fts using fts5(id, title, summary, body, keywords)")
            con.execute("create index idx_entries_status on entries(status)")
            con.execute("create index idx_entries_type on entries(type)")
            con.execute("create index idx_entries_source_archive on entries(source_archive)")
            con.execute("create index idx_entry_files_source_file on entry_files(source_file)")
            con.execute(f"pragma user_version = {SQLITE_SCHEMA_VERSION}")
            stats["sqliteRebuild"] = 1
            # full rebuild => every entry must be (re)inserted
            to_upsert = list(new_map.keys())
            to_delete = []

        con.execute("begin")
        try:
            for eid in to_delete:
                con.execute("delete from entries where id=?", (eid,))
                con.execute("delete from entries_fts where id=?", (eid,))
                con.execute("delete from entry_files where entry_id=?", (eid,))
            for entry in entries:
                eid = str(entry["id"])
                if eid not in to_upsert:
                    continue
                source_files_json = json.dumps(entry["scope"]["sourceFiles"], ensure_ascii=False)
                keywords_json = json.dumps(entry["keywords"], ensure_ascii=False)
                con.execute(
                    """
                    insert or replace into entries (
                      id, project_id, type, status, title, summary, body, source_archive,
                      source_commit, source_files_json, keywords_json, entry_json
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        entry["id"],
                        entry["projectId"],
                        entry["type"],
                        entry["status"],
                        entry["title"],
                        entry["summary"],
                        entry["body"],
                        entry["source"]["archive"],
                        entry["source"]["sourceCommit"],
                        source_files_json,
                        keywords_json,
                        new_map[eid],
                    ),
                )
                con.execute("delete from entries_fts where id=?", (eid,))
                con.execute(
                    "insert into entries_fts (id, title, summary, body, keywords) values (?, ?, ?, ?, ?)",
                    (
                        entry["id"],
                        entry["title"],
                        entry["summary"],
                        entry["body"],
                        " ".join(entry["keywords"]),
                    ),
                )
                con.execute("delete from entry_files where entry_id=?", (eid,))
                for source_file in entry["scope"]["sourceFiles"]:
                    con.execute(
                        "insert or ignore into entry_files (entry_id, source_file) values (?, ?)",
                        (eid, source_file),
                    )
            stats["sqliteUpsert"] = len(to_upsert)
            stats["sqliteDelete"] = len(to_delete)
            con.commit()
        except Exception:
            con.rollback()
            raise
    finally:
        con.close()
    return stats


def write_views(knowledge: Path, index: dict[str, Any], entries: list[dict[str, Any]]) -> None:
    dashboard = [
        "# Harness Knowledge Dashboard",
        "",
        f"- generatedAt: {index['generatedAt']}",
        f"- projectId: {index['projectId']}",
        f"- archives: {index['archives']['indexed']}/{index['archives']['scanned']}",
        f"- entries: {len(entries)}",
        "",
        "## Stats",
        "",
        "| status | count |",
        "|---|---:|",
    ]
    for status, count in index["stats"].items():
        dashboard.append(f"| {status} | {count} |")
    dashboard.extend(["", "## Recent Entries", ""])
    for entry in entries[:50]:
        dashboard.append(f"- **{entry['type']}** `{entry['status']}` {entry['title']}")
        dashboard.append(f"  - source: `{entry['source']['archive']}`")
    write_text_if_changed(knowledge / "views" / "knowledge-dashboard.md", "\n".join(dashboard) + "\n")

    by_file: dict[str, list[dict[str, Any]]] = {}
    for entry in entries:
        for source_file in entry["scope"]["sourceFiles"]:
            by_file.setdefault(source_file, []).append(entry)
    lines = ["# Harness Knowledge By File", ""]
    for source_file in sorted(by_file):
        lines.extend([f"## `{source_file}`", ""])
        for entry in by_file[source_file]:
            lines.append(f"- **{entry['type']}** `{entry['status']}` {entry['title']}")
        lines.append("")
    write_text_if_changed(knowledge / "views" / "by-file.md", "\n".join(lines))

    stale = [entry for entry in entries if entry["status"] == "stale"]
    lines = ["# Harness Stale Knowledge", ""]
    if not stale:
        lines.append("No stale knowledge detected in this run.")
    for entry in stale:
        lines.append(f"- **{entry['type']}** {entry['title']}")
        for reason in entry["lifecycle"]["staleReasons"]:
            lines.append(f"  - {reason}")
    write_text_if_changed(knowledge / "views" / "stale-items.md", "\n".join(lines) + "\n")

    superseded = [entry for entry in entries if entry["status"] == "superseded"]
    lines = ["# Harness Superseded Knowledge", ""]
    if not superseded:
        lines.append("No superseded knowledge detected in this run.")
    for entry in superseded:
        lines.append(f"- **{entry['type']}** {entry['title']}")
        superseded_by = entry.get("lifecycle", {}).get("supersededBy")
        if superseded_by:
            lines.append(f"  - supersededBy: `{superseded_by}`")
        for reason in entry["lifecycle"].get("staleReasons") or []:
            lines.append(f"  - {reason}")
    write_text_if_changed(knowledge / "views" / "superseded-items.md", "\n".join(lines) + "\n")

    conflicted = [entry for entry in entries if entry["status"] == "conflicted"]
    lines = ["# Harness Conflicted Knowledge", ""]
    if not conflicted:
        lines.append("No conflicted knowledge detected in this run.")
    for entry in conflicted:
        lines.append(f"- **{entry['type']}** {entry['title']}")
        for conflict_id in entry.get("lifecycle", {}).get("conflictsWith") or []:
            lines.append(f"  - conflictsWith: `{conflict_id}`")
        for reason in entry["lifecycle"].get("staleReasons") or []:
            lines.append(f"  - {reason}")
    write_text_if_changed(knowledge / "views" / "conflicted-items.md", "\n".join(lines) + "\n")

    active_review = active_review_items(entries)
    lines = ["# Harness Active Review", ""]
    if not active_review:
        lines.append("No active entries require manual review.")
    for entry in active_review:
        lines.append(f"- **{entry['type']}** {entry['title']}")
        lines.append(f"  - id: `{entry['id']}`")
        for reason in entry.get("reviewReasons") or []:
            lines.append(f"  - {reason}")
    write_text_if_changed(knowledge / "views" / "active-review.md", "\n".join(lines) + "\n")

    base = [
        'filters:',
        '  and:',
        '    - \'file.inFolder(".harness/knowledge/entries")\'',
        '    - \'file.ext == "json"\'',
        '',
        'properties:',
        '  file.name:',
        '    displayName: "Entry File"',
        '  file.folder:',
        '    displayName: "Lifecycle Folder"',
        '  file.mtime:',
        '    displayName: "Modified"',
        '',
        'views:',
        '  - type: table',
        '    name: "Lifecycle Table"',
        '    order:',
        '      - file.name',
        '      - file.folder',
        '      - file.mtime',
        '  - type: table',
        '    name: "Needs Review"',
        '    filters:',
        '      or:',
        '        - \'file.inFolder(".harness/knowledge/entries/stale")\'',
        '        - \'file.inFolder(".harness/knowledge/entries/conflicted")\'',
        '        - \'file.inFolder(".harness/knowledge/entries/superseded")\'',
        '    order:',
        '      - file.name',
        '      - file.folder',
        '      - file.mtime',
    ]
    write_text_if_changed(knowledge / "views" / "knowledge.base", "\n".join(base) + "\n")


def write_ingest_report(
    knowledge: Path, index: dict[str, Any], failures: list[dict[str, str]], duplicates: int
) -> None:
    lines = [
        "# Harness Knowledge Ingest Report",
        "",
        f"- generatedAt: {index['generatedAt']}",
        f"- projectId: {index['projectId']}",
        f"- archives scanned: {index['archives']['scanned']}",
        f"- archives indexed: {index['archives']['indexed']}",
        f"- entries: {len(index['entries'])}",
        f"- duplicates skipped: {duplicates}",
        f"- incremental: {index.get('ingestMode', {}).get('incremental', False)}",
        f"- archives extracted: {index.get('ingestMode', {}).get('archivesExtracted', 0)}",
        f"- archives reused: {index.get('ingestMode', {}).get('archivesReused', 0)}",
        f"- confidence scored: {index.get('ingestMode', {}).get('confidenceScored', 0)}",
        f"- candidate auto-promoted: {index.get('ingestMode', {}).get('candidateAutoPromoted', 0)}",
        f"- active auto-demoted: {index.get('ingestMode', {}).get('activeAutoDemoted', 0)}",
        f"- validators checked: {index.get('ingestMode', {}).get('validationChecked', 0)}",
        f"- validators failed: {index.get('ingestMode', {}).get('validationFailed', 0)}",
        f"- validator auto-demoted: {index.get('ingestMode', {}).get('validationAutoDemoted', 0)}",
        "",
        "## Status Counts",
        "",
        "| status | count |",
        "|---|---:|",
    ]
    for status, count in index["stats"].items():
        lines.append(f"| {status} | {count} |")
    if failures:
        lines.extend(["", "## Failures", ""])
        for failure in failures:
            lines.append(f"- `{failure['path']}`: {failure.get('error') or failure.get('reason')}")
    write_text(knowledge / "reports" / f"ingest-report-{timestamp()}.md", "\n".join(lines) + "\n")


def write_verification_report(knowledge: Path, summary: dict[str, Any]) -> Path:
    lines = [
        "# Harness Knowledge Verification Report",
        "",
        f"- generatedAt: {summary['generatedAt']}",
        f"- project: {summary['project']}",
        f"- enabled: {summary['enabled']}",
        f"- checked: {summary['checked']}",
        f"- passed: {summary['passed']}",
        f"- failed: {summary['failed']}",
        f"- skipped: {summary['skipped']}",
        f"- auto-demoted: {summary['autoDemoted']}",
        "",
        "## Entries",
        "",
    ]
    if not summary["entries"]:
        lines.append("- No entries with validators.")
    for entry in summary["entries"]:
        lines.append(f"- `{entry['id']}` `{entry['validationStatus']}` status=`{entry['status']}`")
        for result in entry.get("results") or []:
            description = result.get("description") or result.get("type")
            message = result.get("message") or ""
            lines.append(f"  - {result.get('status')}: {description} - {message}")
    path = knowledge / "reports" / f"verification-report-{timestamp()}.md"
    write_text(path, "\n".join(lines) + "\n")
    return path


def refresh_outputs_from_entry_files(
    project: Path,
    knowledge: Path,
    ingest_mode: dict[str, Any] | None = None,
) -> dict[str, Any]:
    summary_paths = sorted((project / ".harness" / "archive").glob("*/reports/final/summary-data.json"))
    archive_records = archive_summary_records(project, summary_paths)
    existing: dict[str, Any] = {}
    index_path = knowledge / "index.json"
    if index_path.exists():
        try:
            loaded = read_json(index_path)
            if isinstance(loaded, dict):
                existing = loaded
        except (OSError, json.JSONDecodeError):
            existing = {}
    file_entries = [entry for _, entry in load_entry_files(knowledge)]
    file_by_id = {entry["id"]: entry for entry in file_entries}
    sqlite_path = knowledge / "index.sqlite"
    if sqlite_path.exists():
        try:
            sqlite_entries = read_sqlite_entries(sqlite_path)
        except (OSError, sqlite3.Error, json.JSONDecodeError):
            sqlite_entries = []
    else:
        sqlite_entries = []
    if sqlite_entries:
        entries = [file_by_id.get(entry["id"], entry) for entry in sqlite_entries]
        existing_ids = {entry["id"] for entry in entries}
        entries.extend(entry for entry in file_entries if entry["id"] not in existing_ids)
    else:
        entries = file_entries
    index = make_manifest(
        project,
        project_id(project),
        summary_paths,
        archive_records,
        entries,
        existing.get("failures") or [],
        int(existing.get("duplicatesSkipped") or 0),
        ingest_mode or existing.get("ingestMode") or {},
    )
    write_sqlite(knowledge / "index.sqlite", entries)
    write_json(index_path, index)
    write_views(knowledge, index, entries)
    return index


def verify_knowledge(project: Path) -> dict[str, Any]:
    project = project.resolve()
    knowledge = project / ".harness" / "knowledge"
    if not (knowledge / "index.json").exists():
        build_index(project)
    config = load_config(knowledge)
    summary = apply_knowledge_validation(project, knowledge, config)
    summary["generatedAt"] = now_iso()
    summary["project"] = str(project)
    report = write_verification_report(knowledge, summary)
    index = refresh_outputs_from_entry_files(project, knowledge)
    summary["report"] = str(report)
    summary["paths"] = {
        "index": str(knowledge / "index.json"),
        "sqlite": str(knowledge / "index.sqlite"),
        "report": str(report),
    }
    summary["stats"] = index["stats"]
    return summary


VALIDATOR_TOKEN_STOPWORDS = {
    "api",
    "apps",
    "async",
    "body",
    "cache",
    "candidate",
    "change",
    "client",
    "commit",
    "config",
    "data",
    "entry",
    "error",
    "file",
    "files",
    "final",
    "harness",
    "index",
    "json",
    "knowledge",
    "manual",
    "project",
    "result",
    "source",
    "status",
    "store",
    "summary",
    "test",
    "tests",
    "type",
}


def validator_candidate_tokens(entry: dict[str, Any]) -> list[str]:
    text = " ".join(
        str(value or "")
        for value in [
            entry.get("title"),
            entry.get("summary"),
            entry.get("body"),
            " ".join(entry.get("keywords") or []),
        ]
    )
    tokens = []
    seen = set()
    for token in re.findall(r"[A-Za-z_][A-Za-z0-9_.]{3,}", text):
        lower = token.lower().strip("._")
        if lower in VALIDATOR_TOKEN_STOPWORDS:
            continue
        if token not in seen:
            seen.add(token)
            tokens.append(token)
    tokens.sort(key=lambda token: (("." not in token and not any(c.isupper() for c in token)), len(token)))
    return tokens[:12]


def suggest_validators_for_entry(project: Path, entry: dict[str, Any]) -> list[dict[str, Any]]:
    if isinstance(entry.get("validators"), list) and entry["validators"]:
        return []
    source_files = [str(path) for path in entry.get("scope", {}).get("sourceFiles") or [] if path]
    suggestions: list[dict[str, Any]] = []
    tokens = validator_candidate_tokens(entry)
    for rel_path in source_files[:3]:
        path = safe_project_path(project, rel_path)
        if path is None or not path.exists() or not path.is_file():
            continue
        suggestions.append(
            {
                "type": "file_exists",
                "path": rel_path,
                "description": f"source file still exists: {rel_path}",
            }
        )
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for token in tokens:
            if token in text:
                suggestions.append(
                    {
                        "type": "file_contains",
                        "path": rel_path,
                        "pattern": token,
                        "description": f"source file still contains {token}",
                    }
                )
                break
    return suggestions[:4]


def write_validator_suggestions_report(
    knowledge: Path,
    summary: dict[str, Any],
) -> Path:
    lines = [
        "# Harness Validator Suggestions",
        "",
        f"- generatedAt: {summary['generatedAt']}",
        f"- project: {summary['project']}",
        f"- suggested entries: {summary['suggested']}",
        f"- applied entries: {summary['applied']}",
        "",
        "## Suggestions",
        "",
    ]
    if not summary["entries"]:
        lines.append("- No validator suggestions found.")
    for item in summary["entries"]:
        lines.append(f"- `{item['id']}` `{item['status']}` {item['title']}")
        for validator in item["validators"]:
            detail = validator.get("pattern") or validator.get("path") or validator.get("type")
            lines.append(f"  - `{validator['type']}` {detail}: {validator.get('description', '')}")
    path = knowledge / "reports" / f"validator-suggestions-{timestamp()}.md"
    write_text(path, "\n".join(lines) + "\n")
    return path


def suggest_validators(
    project: Path,
    limit: int = 20,
    statuses: list[str] | None = None,
    apply: bool = False,
) -> dict[str, Any]:
    project = project.resolve()
    knowledge = project / ".harness" / "knowledge"
    if not (knowledge / "index.json").exists():
        build_index(project)
    selected_statuses = statuses or ["active", "candidate"]
    suggestions: list[dict[str, Any]] = []
    applied = 0
    for entry_path, entry in load_entry_files(knowledge, selected_statuses):
        validators = suggest_validators_for_entry(project, entry)
        if not validators:
            continue
        item = {
            "id": entry["id"],
            "status": entry.get("status"),
            "title": entry.get("title"),
            "path": str(entry_path),
            "validators": validators,
        }
        suggestions.append(item)
        if apply:
            entry["validators"] = validators
            write_json(entry_path, entry)
            applied += 1
        if len(suggestions) >= max(1, limit):
            break
    summary = {
        "generatedAt": now_iso(),
        "project": str(project),
        "statuses": selected_statuses,
        "limit": limit,
        "suggested": len(suggestions),
        "applied": applied,
        "entries": suggestions,
    }
    report = write_validator_suggestions_report(knowledge, summary)
    if apply and applied:
        index = refresh_outputs_from_entry_files(project, knowledge)
        summary["stats"] = index["stats"]
    summary["report"] = str(report)
    return summary


def auto_knowledge(
    project: Path,
    *,
    limit: int = 20,
    suggest_statuses: list[str] | None = None,
    apply_suggestions: bool = True,
    incremental: bool = True,
    audit_limit: int = 10,
) -> dict[str, Any]:
    project = project.resolve()
    knowledge = project / ".harness" / "knowledge"
    config_summary = ensure_auto_knowledge_config(knowledge)
    sync = sync_status(project, update=True, incremental=incremental)
    if config_summary["created"]:
        if sync.get("action") == "ingested":
            ingest_mode = sync.get("index", {}).get("ingestMode", {})
            config_summary["appliedBy"] = "sync"
            config_summary["candidateAutoPromoted"] = ingest_mode.get("candidateAutoPromoted", 0)
        elif sync.get("upToDate"):
            index = build_index(project, incremental=incremental)
            config_summary["appliedBy"] = "auto-rebuild"
            config_summary["candidateAutoPromoted"] = index.get("ingestMode", {}).get("candidateAutoPromoted", 0)
            sync = sync_status(project, update=False, incremental=incremental)
    suggestions = suggest_validators(
        project,
        limit=limit,
        statuses=suggest_statuses or [],
        apply=apply_suggestions,
    )
    verification = verify_knowledge(project)
    audit = audit_entries(project, limit=audit_limit)
    ingest_mode = sync.get("index", {}).get("ingestMode", {}) if isinstance(sync.get("index"), dict) else {}
    return {
        "project": str(project),
        "generatedAt": now_iso(),
        "mode": {
            "applySuggestions": apply_suggestions,
            "suggestStatuses": suggest_statuses or ["active", "candidate"],
            "limit": limit,
            "auditLimit": audit_limit,
            "incremental": incremental,
        },
        "config": config_summary,
        "sync": {
            "upToDate": sync["upToDate"],
            "action": sync["action"],
            "reasons": sync["reasons"],
            "archiveCount": sync["archiveCount"],
            "paths": sync["paths"],
        },
        "suggestions": {
            "suggested": suggestions["suggested"],
            "applied": suggestions["applied"],
            "report": suggestions["report"],
        },
        "verification": {
            "checked": verification["checked"],
            "passed": verification["passed"],
            "failed": verification["failed"],
            "skipped": verification["skipped"],
            "autoDemoted": verification["autoDemoted"],
            "report": verification["report"],
        },
        "audit": {
            "report": audit["report"],
            "candidateReview": len(audit["candidateReview"]),
            "staleReview": len(audit["staleReview"]),
            "supersededReview": len(audit["supersededReview"]),
            "conflictReview": len(audit["conflictReview"]),
            "activeReview": len(audit["activeReview"]),
        },
        "lifecycle": {
            "validatorsApplied": suggestions["applied"],
            "candidateAutoPromoted": ingest_mode.get(
                "candidateAutoPromoted", config_summary.get("candidateAutoPromoted") or 0
            ),
            "activeAutoDemoted": ingest_mode.get("activeAutoDemoted", 0),
            "validationAutoDemoted": ingest_mode.get("validationAutoDemoted", verification["autoDemoted"]),
            "pendingAgentJudge": len(audit["conflictReview"]) + len(audit["candidateReview"]),
        },
    }


def fts_query(query: str) -> str:
    tokens = re.findall(r"[\w\u4e00-\u9fff]{2,}", query, flags=re.UNICODE)
    if not tokens:
        return '"' + query.replace('"', '""') + '"'
    return " OR ".join('"' + token.replace('"', '""') + '"' for token in tokens[:12])


def query_index(
    project: Path,
    query: str,
    limit: int = 10,
    file_filters: list[str] | None = None,
    statuses: list[str] | None = None,
    types: list[str] | None = None,
) -> dict[str, Any]:
    project = project.resolve()
    knowledge = project / ".harness" / "knowledge"
    sqlite_path = knowledge / "index.sqlite"
    # API-009: one ensure-current. Build the shared snapshot once (inputs_hash
    # computed exactly once) and a single build_index call whose no-op fast path
    # keeps an up-to-date project a true no-op. Replaces the old sync_status +
    # build_index double orchestration, which computed inputs_hash twice.
    snapshot = build_snapshot(project)
    build_index(project, snapshot=snapshot)
    entries = search_entries(sqlite_path, query, limit, file_filters, statuses, types)
    context_path = write_context_pack(project, knowledge, query, entries)
    filters = {
        "files": file_filters or [],
        "statuses": statuses or [],
        "types": types or [],
    }
    return {
        "query": query,
        "matchCount": len(entries),
        "contextPack": str(context_path),
        "filters": filters,
        "planInput": {
            "kind": "harness-knowledge-context-pack",
            "path": str(context_path),
            "requiredBefore": "harness-plan",
            "usage": "Read this context pack before design, planning, code exploration, or implementation.",
        },
        "matches": [
            {
                "id": entry["id"],
                "type": entry["type"],
                "status": entry["status"],
                "title": entry["title"],
                "sourceArchive": entry["source"]["archive"],
                "sourceFiles": entry["scope"]["sourceFiles"],
            }
            for entry in entries
        ],
    }


def summarize_index(index: dict[str, Any]) -> dict[str, Any]:
    project_root = Path(index["projectRoot"])
    knowledge = project_root / ".harness" / "knowledge"
    return {
        "projectId": index["projectId"],
        "generatedAt": index["generatedAt"],
        "headCommit": index["headCommit"],
        "archives": index["archives"],
        "stats": index["stats"],
        "byType": index["byType"],
        "duplicatesSkipped": index["duplicatesSkipped"],
        "ingestMode": index.get("ingestMode", {}),
        "failures": index["failures"],
        "paths": {
            "index": str(knowledge / "index.json"),
            "sqlite": str(knowledge / "index.sqlite"),
            "dashboard": str(knowledge / "views" / "knowledge-dashboard.md"),
            "byFile": str(knowledge / "views" / "by-file.md"),
            "staleItems": str(knowledge / "views" / "stale-items.md"),
        },
    }


def sync_status(project: Path, update: bool = False, incremental: bool = True) -> dict[str, Any]:
    project = project.resolve()
    knowledge = project / ".harness" / "knowledge"
    index_path = knowledge / "index.json"
    sqlite_path = knowledge / "index.sqlite"
    archive_root = project / ".harness" / "archive"
    summary_paths = sorted(archive_root.glob("*/reports/final/summary-data.json"))
    current_records = archive_summary_records(project, summary_paths)
    reasons: list[str] = []
    index: dict[str, Any] | None = None

    if not index_path.exists():
        reasons.append("index.json missing")
    else:
        try:
            index = read_json(index_path)
        except (OSError, json.JSONDecodeError) as exc:
            reasons.append("index.json unreadable: " + first_sentence(str(exc)))

    if not sqlite_path.exists():
        reasons.append("index.sqlite missing")

    if index is not None:
        indexed_records = index.get("archives", {}).get("items")
        if not isinstance(indexed_records, list):
            reasons.append("archive checksums missing from index")
        else:
            indexed_by_path = {record.get("summaryData"): record for record in indexed_records}
            current_by_path = {record.get("summaryData"): record for record in current_records}
            indexed_paths = set(indexed_by_path)
            current_paths = set(current_by_path)
            for path in sorted(current_paths - indexed_paths):
                reasons.append("archive added: " + str(path))
            for path in sorted(indexed_paths - current_paths):
                reasons.append("archive removed: " + str(path))
            for path in sorted(current_paths & indexed_paths):
                if current_by_path[path].get("summarySha256") != indexed_by_path[path].get("summarySha256"):
                    reasons.append("archive checksum changed: " + str(path))

        # HEAD is intentionally not an invalidation key (cluster 6, UT-027): a
        # business-code commit that does not touch any archive must not force a
        # rebuild. The archive checksum checks above already cover archive
        # changes; compare the full input fingerprint to catch config/schema
        # drift that the per-archive checks would miss.
        current_inputs_hash = compute_inputs_hash(current_records, load_config(knowledge), knowledge)
        if current_inputs_hash != index.get("inputsHash") and not reasons:
            reasons.append("knowledge inputs changed (config or schema)")

    action = "none"
    refreshed: dict[str, Any] | None = None
    if reasons and update:
        refreshed = build_index(project, incremental=incremental)
        action = "ingested"
        reasons = []

    result = {
        "project": str(project),
        "upToDate": not reasons,
        "action": action,
        "reasons": reasons,
        "archiveCount": len(current_records),
        "paths": {
            "index": str(index_path),
            "sqlite": str(sqlite_path),
        },
    }
    if refreshed is not None:
        result["index"] = summarize_index(refreshed)
    return result


def search_entries(
    sqlite_path: Path,
    query: str,
    limit: int,
    file_filters: list[str] | None = None,
    statuses: list[str] | None = None,
    types: list[str] | None = None,
) -> list[dict[str, Any]]:
    con = sqlite3.connect(sqlite_path)
    try:
        con.row_factory = sqlite3.Row
        rows: list[sqlite3.Row] = []
        fetch_limit = max(limit * 5, 50)
        try:
            rows.extend(
                con.execute(
                """
                select e.entry_json
                from entries_fts f
                join entries e on e.id = f.id
                where entries_fts match ?
                limit ?
                """,
                    (fts_query(query), fetch_limit),
                ).fetchall()
            )
        except sqlite3.OperationalError:
            like = f"%{query}%"
            rows.extend(
                con.execute(
                """
                select entry_json
                from entries
                where title like ? or summary like ? or body like ?
                limit ?
                """,
                    (like, like, like, fetch_limit),
                ).fetchall()
            )

        like_terms = [f"%{token}%" for token in query_tokens(query)]
        for like in like_terms[:10]:
            rows.extend(
                con.execute(
                    """
                    select entry_json
                    from entries
                    where title like ? or summary like ? or body like ? or keywords_json like ?
                    limit ?
                    """,
                    (like, like, like, like, fetch_limit),
                ).fetchall()
            )

        for source_file in file_filters or []:
            rows.extend(
                con.execute(
                    """
                    select e.entry_json
                    from entry_files ef
                    join entries e on e.id = ef.entry_id
                    where ef.source_file = ? or ef.source_file like ?
                    limit ?
                    """,
                    (source_file, f"%{source_file}%", fetch_limit),
                ).fetchall()
            )

        entries_by_id: dict[str, dict[str, Any]] = {}
        for row in rows:
            entry = json.loads(row["entry_json"])
            if not entry_matches_filters(entry, file_filters, statuses, types):
                continue
            entries_by_id[entry["id"]] = entry
        ranked = sorted(
            entries_by_id.values(),
            key=lambda entry: score_entry(entry, query),
            reverse=True,
        )
        return ranked[:limit]
    finally:
        con.close()


def entry_matches_filters(
    entry: dict[str, Any],
    file_filters: list[str] | None = None,
    statuses: list[str] | None = None,
    types: list[str] | None = None,
) -> bool:
    if statuses and entry.get("status") not in statuses:
        return False
    if types and entry.get("type") not in types:
        return False
    if file_filters:
        source_files = entry.get("scope", {}).get("sourceFiles") or []
        for wanted in file_filters:
            if not any(wanted == actual or wanted in actual or actual in wanted for actual in source_files):
                return False
    return True


def query_tokens(query: str) -> list[str]:
    tokens = re.findall(r"[\w\u4e00-\u9fff]{2,}", query.lower(), flags=re.UNICODE)
    return list(dict.fromkeys(tokens))


def score_entry(entry: dict[str, Any], query: str) -> int:
    tokens = query_tokens(query)
    haystack = " ".join(
        [
            entry.get("title", ""),
            entry.get("summary", ""),
            entry.get("body", ""),
            " ".join(entry.get("keywords") or []),
            entry.get("source", {}).get("archive", ""),
            " ".join(entry.get("scope", {}).get("sourceFiles") or []),
        ]
    ).lower()
    score = 0
    q = query.lower().strip()
    if q and q in haystack:
        score += 20
    for token in tokens:
        if token in haystack:
            score += 8
            if token in entry.get("title", "").lower():
                score += 4
    score += {
        "requirement": 12,
        "decision": 8,
        "risk": 7,
        "test-evidence": 5,
        "api-contract": 4,
        "implementation": 3,
        "pitfall": 6,
    }.get(entry.get("type"), 0)
    score += {
        "active": 6,
        "candidate": 4,
        "stale": 1,
        "superseded": -3,
        "deprecated": -4,
        "conflicted": -2,
    }.get(entry.get("status"), 0)
    archive = entry.get("source", {}).get("archive", "")
    match = re.search(r"(\d{4}-\d{2}-\d{2})", archive)
    if match:
        try:
            days = (dt.date.today() - dt.date.fromisoformat(match.group(1))).days
            score += max(0, 10 - days)
        except ValueError:
            pass
    return score


def write_context_pack(project: Path, knowledge: Path, query: str, entries: list[dict[str, Any]]) -> Path:
    filename = f"{timestamp()}-{safe_filename(query) or 'query'}-{short_hash(query, 6)}.md"
    path = knowledge / "context-packs" / filename
    active_like = [e for e in entries if e["status"] in {"active", "candidate"}]
    stale = [e for e in entries if e["status"] == "stale"]
    risks = [e for e in entries if e["type"] == "risk"]
    files: list[str] = []
    for entry in entries:
        for source_file in entry["scope"]["sourceFiles"]:
            if source_file not in files:
                files.append(source_file)

    lines = [
        "# Knowledge Context Pack",
        "",
        "## Query",
        "",
        query,
        "",
        "## Before planning",
        "",
        "- Treat candidate entries as useful history, not current truth.",
        "- Re-check stale entries against the current code before relying on them.",
        "- Open the source archive and suggested files before making implementation decisions.",
        "",
        "## High-confidence relevant history",
        "",
    ]
    if not active_like:
        lines.append("No active or candidate history matched this query.")
    for entry in active_like:
        lines.extend(render_entry_for_context(entry))

    lines.extend(["", "## Potentially stale history", ""])
    if not stale:
        lines.append("No stale matched history detected.")
    for entry in stale:
        lines.extend(render_entry_for_context(entry, include_stale=True))

    lines.extend(["", "## Related risks", ""])
    if not risks:
        lines.append("No related risks matched this query.")
    for entry in risks[:8]:
        lines.append(f"- {entry['title']}")
        lines.append(f"  - source: `{entry['source']['archive']}`")

    lines.extend(["", "## Suggested files to inspect next", ""])
    if not files:
        lines.append("No source files were linked by matched entries.")
    for source_file in files[:20]:
        lines.append(f"- {source_file}")

    lines.extend(["", "## Source index", ""])
    lines.append(f"- project: `{project}`")
    lines.append(f"- generatedAt: {now_iso()}")
    write_text(path, "\n".join(lines) + "\n")
    write_json(
        knowledge / "context-packs" / "latest.json",
        {
            "schemaVersion": 1,
            "generatedAt": now_iso(),
            "query": query,
            "contextPack": str(path),
            "matchIds": [entry["id"] for entry in entries],
        },
    )
    return path


def render_entry_for_context(entry: dict[str, Any], include_stale: bool = False) -> list[str]:
    lines = [
        f"- {entry['title']}",
        f"  - type: `{entry['type']}`",
        f"  - status: `{entry['status']}`",
        f"  - source: `{entry['source']['archive']}`",
        f"  - commit: `{entry['source']['sourceCommit'] or 'unknown'}`",
        f"  - key takeaway: {entry['summary']}",
    ]
    if entry["scope"]["sourceFiles"]:
        lines.append("  - source files: " + ", ".join(f"`{f}`" for f in entry["scope"]["sourceFiles"][:6]))
    if include_stale:
        reasons = entry["lifecycle"].get("staleReasons") or []
        for reason in reasons:
            lines.append(f"  - stale reason: {reason}")
    return lines


# ---------------------------------------------------------------------------
# P0-3: rule automation + AI judgement interface (DESIGN.md D4)
# ---------------------------------------------------------------------------

NEAR_DUPLICATE_THRESHOLD = 0.88
AUTO_SUPERSEDE_SIMILARITY = 0.75
AUTO_SUPERSEDE_WEAK_SIMILARITY = 0.55
JUDGE_ACTIONS = {"promote", "drop", "supersede", "keep-conflict"}
ENTRY_STATUSES = {"candidate", "active", "stale", "superseded", "conflicted"}


def load_harness_project_config(project: Path) -> dict[str, Any]:
    config_path = project / ".harness" / "config" / "harness.json"
    if not config_path.exists():
        return {}
    try:
        config = read_json(config_path)
    except (OSError, json.JSONDecodeError):
        return {}
    return config if isinstance(config, dict) else {}


def manual_review_enabled(project: Path) -> bool:
    harness_cfg = load_harness_project_config(project)
    knowledge_section = harness_cfg.get("knowledge")
    if isinstance(knowledge_section, dict) and "manualReview" in knowledge_section:
        return bool(knowledge_section.get("manualReview"))
    knowledge_cfg = load_config(project / ".harness" / "knowledge")
    if "manualReview" in knowledge_cfg:
        return bool(knowledge_cfg.get("manualReview"))
    nested = knowledge_cfg.get("knowledge")
    if isinstance(nested, dict) and "manualReview" in nested:
        return bool(nested.get("manualReview"))
    return False


def normalize_similarity_text(text: str) -> str:
    lowered = str(text or "").lower()
    lowered = re.sub(r"[\W_]+", " ", lowered, flags=re.UNICODE)
    return re.sub(r"\s+", " ", lowered).strip()


def entry_compare_text(entry: dict[str, Any]) -> str:
    return normalize_similarity_text(
        " ".join(
            [
                str(entry.get("title") or ""),
                str(entry.get("summary") or ""),
                str(entry.get("body") or ""),
            ]
        )
    )


def entry_similarity(left: dict[str, Any], right: dict[str, Any]) -> float:
    left_text = entry_compare_text(left)
    right_text = entry_compare_text(right)
    if not left_text or not right_text:
        return 0.0
    return SequenceMatcher(None, left_text, right_text).ratio()


def status_rank(status: str | None) -> int:
    return {
        "active": 5,
        "candidate": 4,
        "stale": 3,
        "conflicted": 2,
        "superseded": 1,
    }.get(str(status or ""), 0)


def prefer_entry(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    left_key = (
        status_rank(left.get("status")),
        len(str(left.get("body") or "")),
        len(left.get("scope", {}).get("sourceFiles") or []),
        str(left.get("id") or ""),
    )
    right_key = (
        status_rank(right.get("status")),
        len(str(right.get("body") or "")),
        len(right.get("scope", {}).get("sourceFiles") or []),
        str(right.get("id") or ""),
    )
    return left if left_key >= right_key else right


def merge_entry_provenance(keeper: dict[str, Any], absorbed: dict[str, Any]) -> None:
    keeper["keywords"] = sorted(
        {
            str(item)
            for item in list(keeper.get("keywords") or []) + list(absorbed.get("keywords") or [])
            if item
        }
    )
    scope = keeper.setdefault("scope", {})
    files = list(scope.get("sourceFiles") or [])
    for path in absorbed.get("scope", {}).get("sourceFiles") or []:
        if path and path not in files:
            files.append(path)
    scope["sourceFiles"] = files
    if scope.get("staleIfPathsChanged") is not None or absorbed.get("scope", {}).get("staleIfPathsChanged"):
        patterns = list(scope.get("staleIfPathsChanged") or [])
        for pattern in absorbed.get("scope", {}).get("staleIfPathsChanged") or []:
            if pattern and pattern not in patterns:
                patterns.append(pattern)
        scope["staleIfPathsChanged"] = patterns

    lifecycle = keeper.setdefault("lifecycle", {})
    merged_from = lifecycle.setdefault("mergedFrom", [])
    if absorbed.get("id") and absorbed["id"] not in merged_from:
        merged_from.append(absorbed["id"])
    supersedes = lifecycle.setdefault("supersedes", [])
    for sid in absorbed.get("lifecycle", {}).get("supersedes") or []:
        if sid and sid not in supersedes:
            supersedes.append(sid)
    if absorbed.get("id") and absorbed["id"] not in supersedes:
        supersedes.append(absorbed["id"])
    for sid in absorbed.get("lifecycle", {}).get("mergedFrom") or []:
        if sid and sid not in merged_from:
            merged_from.append(sid)
    lifecycle["lastCheckedAt"] = now_iso()


def supersede_entry(entry: dict[str, Any], newer_id: str, reason: str) -> None:
    previous = str(entry.get("status") or "candidate")
    entry["status"] = "superseded"
    lifecycle = entry.setdefault("lifecycle", {})
    lifecycle["previousStatus"] = previous
    lifecycle["supersededBy"] = newer_id
    reasons = lifecycle.setdefault("staleReasons", [])
    if reason not in reasons:
        reasons.append(reason)
    lifecycle["lastCheckedAt"] = now_iso()


def dedupe_near_duplicates(
    entries: list[dict[str, Any]],
    threshold: float = NEAR_DUPLICATE_THRESHOLD,
) -> dict[str, Any]:
    """Merge near-duplicate entries within the same archive (in-place)."""
    by_archive: dict[str, list[dict[str, Any]]] = {}
    for entry in entries:
        if entry.get("status") == "superseded":
            continue
        archive = str(entry.get("source", {}).get("archive") or "")
        by_archive.setdefault(archive, []).append(entry)

    merges: list[dict[str, Any]] = []
    for archive, group in by_archive.items():
        remaining = list(group)
        while remaining:
            current = remaining.pop(0)
            if current.get("status") == "superseded":
                continue
            cluster = [current]
            still: list[dict[str, Any]] = []
            for other in remaining:
                if other.get("status") == "superseded":
                    continue
                if other.get("type") != current.get("type"):
                    still.append(other)
                    continue
                if entry_similarity(current, other) >= threshold:
                    cluster.append(other)
                else:
                    still.append(other)
            remaining = still
            if len(cluster) < 2:
                continue
            keeper = cluster[0]
            for candidate in cluster[1:]:
                keeper = prefer_entry(keeper, candidate)
            for absorbed in cluster:
                if absorbed is keeper or absorbed.get("id") == keeper.get("id"):
                    continue
                merge_entry_provenance(keeper, absorbed)
                supersede_entry(
                    absorbed,
                    str(keeper["id"]),
                    "near-duplicate merged into: " + str(keeper["id"]),
                )
                merges.append(
                    {
                        "keptId": keeper["id"],
                        "mergedId": absorbed["id"],
                        "archive": archive,
                        "similarity": round(entry_similarity(keeper, absorbed), 3),
                    }
                )
    return {"merged": len(merges), "merges": merges}


def relocate_entry_file(
    knowledge: Path,
    entry: dict[str, Any],
    source_path: Path | None = None,
) -> Path:
    status = str(entry.get("status") or "candidate")
    if status not in ENTRY_STATUSES:
        status = "candidate"
        entry["status"] = status
    target = knowledge / "entries" / status / entry_filename(entry)
    write_json(target, entry)
    if source_path is not None and source_path.exists() and source_path.resolve() != target.resolve():
        source_path.unlink()
    return target


def persist_entries_by_status(
    knowledge: Path,
    path_by_id: dict[str, Path],
    entries: list[dict[str, Any]],
) -> None:
    for entry in entries:
        entry_id = str(entry.get("id") or "")
        if not entry_id:
            continue
        source_path = path_by_id.get(entry_id)
        relocate_entry_file(knowledge, entry, source_path)


def dedupe_knowledge(project: Path, threshold: float = NEAR_DUPLICATE_THRESHOLD) -> dict[str, Any]:
    project = project.resolve()
    knowledge = project / ".harness" / "knowledge"
    if not (knowledge / "index.json").exists():
        build_index(project)
    loaded = load_entry_files(knowledge)
    path_by_id = {entry["id"]: path for path, entry in loaded}
    entries = [entry for _, entry in loaded]
    result = dedupe_near_duplicates(entries, threshold=threshold)
    if result["merged"]:
        persist_entries_by_status(knowledge, path_by_id, entries)
        index = refresh_outputs_from_entry_files(project, knowledge)
    else:
        index = read_json(knowledge / "index.json") if (knowledge / "index.json").exists() else {}
    return {
        "project": str(project),
        "generatedAt": now_iso(),
        "merged": result["merged"],
        "merges": result["merges"],
        "stats": index.get("stats") if isinstance(index, dict) else {},
        "paths": {
            "index": str(knowledge / "index.json"),
            "sqlite": str(knowledge / "index.sqlite"),
        },
    }


def is_clear_topic_evolution(older: dict[str, Any], newer: dict[str, Any]) -> bool:
    """Return True only when older→newer is an obvious same-topic evolution."""
    if older.get("type") != newer.get("type"):
        return False
    if older.get("status") in {"superseded", "conflicted"}:
        return False
    if newer.get("status") in {"superseded", "conflicted"}:
        return False
    older_archive = str(older.get("source", {}).get("archive") or "")
    newer_archive = str(newer.get("source", {}).get("archive") or "")
    if not older_archive or not newer_archive or older_archive == newer_archive:
        return False
    if archive_sort_key(newer) <= archive_sort_key(older):
        return False
    older_files = set(older.get("scope", {}).get("sourceFiles") or [])
    newer_files = set(newer.get("scope", {}).get("sourceFiles") or [])
    if not older_files or not newer_files or not (older_files & newer_files):
        return False
    # Semantic conflicts are left for judge.
    if entries_conflict_for_review(older, newer):
        return False
    shared_terms = subject_terms(older) & subject_terms(newer)
    similarity = entry_similarity(older, newer)
    same_title = normalize_similarity_text(str(older.get("title") or "")) == normalize_similarity_text(
        str(newer.get("title") or "")
    )
    if similarity >= AUTO_SUPERSEDE_SIMILARITY:
        return True
    if same_title and (shared_terms or similarity >= AUTO_SUPERSEDE_WEAK_SIMILARITY):
        return True
    if len(shared_terms) >= 2 and similarity >= AUTO_SUPERSEDE_WEAK_SIMILARITY:
        return True
    return False


def auto_supersede_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    ordered = sorted(entries, key=archive_sort_key)
    for idx, older in enumerate(ordered):
        if older.get("status") in {"superseded", "conflicted"}:
            continue
        for newer in ordered[idx + 1 :]:
            if not is_clear_topic_evolution(older, newer):
                continue
            supersede_entry(
                older,
                str(newer["id"]),
                "auto-superseded by newer same-topic entry: " + str(newer["id"]),
            )
            newer_life = newer.setdefault("lifecycle", {})
            supersedes = newer_life.setdefault("supersedes", [])
            if older["id"] not in supersedes:
                supersedes.append(older["id"])
            actions.append(
                {
                    "id": older["id"],
                    "supersededBy": newer["id"],
                    "type": older.get("type"),
                    "overlap": sorted(
                        set(older.get("scope", {}).get("sourceFiles") or [])
                        & set(newer.get("scope", {}).get("sourceFiles") or [])
                    ),
                }
            )
            break
    return actions


def auto_supersede_knowledge(project: Path) -> dict[str, Any]:
    project = project.resolve()
    knowledge = project / ".harness" / "knowledge"
    if not (knowledge / "index.json").exists():
        build_index(project)
    loaded = load_entry_files(knowledge)
    path_by_id = {entry["id"]: path for path, entry in loaded}
    entries = [entry for _, entry in loaded]
    actions = auto_supersede_entries(entries)
    if actions:
        persist_entries_by_status(knowledge, path_by_id, entries)
        index = refresh_outputs_from_entry_files(project, knowledge)
    else:
        index = read_json(knowledge / "index.json") if (knowledge / "index.json").exists() else {}
    return {
        "project": str(project),
        "generatedAt": now_iso(),
        "superseded": len(actions),
        "actions": actions,
        "stats": index.get("stats") if isinstance(index, dict) else {},
        "paths": {
            "index": str(knowledge / "index.json"),
            "sqlite": str(knowledge / "index.sqlite"),
        },
    }


def previous_status_for_restore(entry: dict[str, Any]) -> str:
    lifecycle = entry.get("lifecycle") or {}
    previous = lifecycle.get("previousStatus")
    if previous in ENTRY_STATUSES and previous != "stale":
        return str(previous)
    if lifecycle.get("demotedAt") or lifecycle.get("autoDemoted") or lifecycle.get("promotedAt"):
        return "active"
    return "candidate"


def reverify_stale_knowledge(project: Path) -> dict[str, Any]:
    project = project.resolve()
    knowledge = project / ".harness" / "knowledge"
    if not (knowledge / "index.json").exists():
        build_index(project)
    config = knowledge_validation_config(load_config(knowledge))
    restored: list[dict[str, Any]] = []
    kept_stale: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []

    for source_path, entry in load_entry_files(knowledge, ["stale"]):
        validators = entry.get("validators")
        if not isinstance(validators, list) or not validators:
            skipped.append({"id": entry["id"], "reason": "no validators"})
            continue
        usable = [
            validator
            for validator in validators
            if isinstance(validator, dict)
            and str(validator.get("type") or "") in {"file_exists", "file_contains"}
        ]
        if not usable:
            skipped.append({"id": entry["id"], "reason": "no file_exists/file_contains validators"})
            continue

        results = [evaluate_validator(project, entry, validator, config) for validator in usable]
        statuses = [str(result.get("status")) for result in results]
        validation = {
            "validatedAt": now_iso(),
            "status": "failed" if "failed" in statuses else ("passed" if "passed" in statuses else "skipped"),
            "results": results,
            "reverify": True,
        }
        lifecycle = entry.setdefault("lifecycle", {})
        lifecycle["validation"] = validation
        lifecycle["lastCheckedAt"] = validation["validatedAt"]

        if validation["status"] == "passed":
            target_status = previous_status_for_restore(entry)
            entry["status"] = target_status
            lifecycle.pop("demotedAt", None)
            lifecycle.pop("demotionReason", None)
            lifecycle.pop("autoDemoted", None)
            stale_reasons = [
                reason
                for reason in (lifecycle.get("staleReasons") or [])
                if "validator failed" not in str(reason) and "reverify failed" not in str(reason)
            ]
            lifecycle["staleReasons"] = stale_reasons
            lifecycle["reverifiedAt"] = validation["validatedAt"]
            relocate_entry_file(knowledge, entry, source_path)
            restored.append({"id": entry["id"], "status": target_status})
        else:
            reason = "reverify failed: " + first_failed_validator_message(validation)
            reasons = lifecycle.setdefault("staleReasons", [])
            if reason not in reasons:
                reasons.append(reason)
            write_json(source_path, entry)
            kept_stale.append({"id": entry["id"], "reason": reason})

    index = refresh_outputs_from_entry_files(project, knowledge)
    return {
        "project": str(project),
        "generatedAt": now_iso(),
        "restored": len(restored),
        "keptStale": len(kept_stale),
        "skipped": len(skipped),
        "entries": {
            "restored": restored,
            "keptStale": kept_stale,
            "skipped": skipped,
        },
        "stats": index.get("stats", {}),
        "paths": {
            "index": str(knowledge / "index.json"),
            "sqlite": str(knowledge / "index.sqlite"),
        },
    }


def snapshot_entry_state(entry: dict[str, Any]) -> dict[str, Any]:
    return json_clone(
        {
            "schemaVersion": entry.get("schemaVersion", 1),
            "id": entry.get("id"),
            "projectId": entry.get("projectId"),
            "status": entry.get("status"),
            "title": entry.get("title"),
            "type": entry.get("type"),
            "lifecycle": entry.get("lifecycle") or {},
            "scope": entry.get("scope") or {},
            "keywords": entry.get("keywords") or [],
            "body": entry.get("body"),
            "summary": entry.get("summary"),
            "source": entry.get("source") or {},
            "validators": entry.get("validators"),
            "confidence": entry.get("confidence"),
        }
    )


def judge_export(project: Path) -> dict[str, Any]:
    project = project.resolve()
    knowledge = project / ".harness" / "knowledge"
    if not (knowledge / "index.json").exists():
        build_index(project)
    entries = [entry for _, entry in load_entry_files(knowledge)]
    by_id = {entry["id"]: entry for entry in entries}

    conflicts: list[dict[str, Any]] = []
    seen_pairs: set[tuple[str, str]] = set()
    for entry in entries:
        if entry.get("status") != "conflicted":
            continue
        for other_id in entry.get("lifecycle", {}).get("conflictsWith") or []:
            pair = tuple(sorted([entry["id"], str(other_id)]))
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)
            other = by_id.get(str(other_id))
            conflicts.append(
                {
                    "kind": "conflict",
                    "ids": list(pair),
                    "entries": [
                        {
                            "id": entry["id"],
                            "type": entry.get("type"),
                            "status": entry.get("status"),
                            "title": entry.get("title"),
                            "body": entry.get("body"),
                            "summary": entry.get("summary"),
                            "source": entry.get("source"),
                            "scope": entry.get("scope"),
                            "lifecycle": {
                                "conflictsWith": entry.get("lifecycle", {}).get("conflictsWith") or [],
                                "staleReasons": entry.get("lifecycle", {}).get("staleReasons") or [],
                            },
                        },
                        {
                            "id": other.get("id") if other else other_id,
                            "type": other.get("type") if other else None,
                            "status": other.get("status") if other else None,
                            "title": other.get("title") if other else None,
                            "body": other.get("body") if other else None,
                            "summary": other.get("summary") if other else None,
                            "source": other.get("source") if other else None,
                            "scope": other.get("scope") if other else None,
                            "lifecycle": {
                                "conflictsWith": (other.get("lifecycle", {}) or {}).get("conflictsWith") or [],
                                "staleReasons": (other.get("lifecycle", {}) or {}).get("staleReasons") or [],
                            }
                            if other
                            else {},
                        },
                    ],
                }
            )

    promote_candidates: list[dict[str, Any]] = []
    for entry in entries:
        if entry.get("status") != "candidate":
            continue
        promote_candidates.append(
            {
                "kind": "promote-candidate",
                "id": entry["id"],
                "type": entry.get("type"),
                "status": entry.get("status"),
                "title": entry.get("title"),
                "body": entry.get("body"),
                "summary": entry.get("summary"),
                "source": entry.get("source"),
                "scope": entry.get("scope"),
                "confidence": entry.get("confidence"),
                "lifecycle": {
                    "staleReasons": entry.get("lifecycle", {}).get("staleReasons") or [],
                    "conflictsWith": entry.get("lifecycle", {}).get("conflictsWith") or [],
                },
            }
        )

    payload = {
        "schemaVersion": 1,
        "generatedAt": now_iso(),
        "project": str(project),
        "manualReview": manual_review_enabled(project),
        "counts": {
            "conflicts": len(conflicts),
            "promoteCandidates": len(promote_candidates),
            "pending": len(conflicts) + len(promote_candidates),
        },
        "conflicts": conflicts,
        "promoteCandidates": promote_candidates,
        "actions": sorted(JUDGE_ACTIONS),
    }
    export_path = knowledge / "reports" / f"judge-export-{timestamp()}.json"
    write_json(export_path, payload)
    payload["exportPath"] = str(export_path)
    return payload


def apply_judge_decision(
    knowledge: Path,
    entry: dict[str, Any],
    source_path: Path,
    decision: dict[str, Any],
    by_id: dict[str, dict[str, Any]],
    path_by_id: dict[str, Path],
) -> dict[str, Any]:
    action = str(decision.get("action") or "")
    reason = str(decision.get("reason") or "")
    before = snapshot_entry_state(entry)
    after_status = entry.get("status")

    if action == "promote":
        entry["status"] = "active"
        lifecycle = entry.setdefault("lifecycle", {})
        lifecycle["promotedAt"] = now_iso()
        lifecycle["promotionNote"] = reason or "judge promote"
        lifecycle["judgeAction"] = action
        lifecycle["lastCheckedAt"] = now_iso()
        # Clear conflict markers when promoting a resolved conflict side.
        lifecycle["conflictsWith"] = []
        stale_reasons = [
            item
            for item in (lifecycle.get("staleReasons") or [])
            if "potential conflict with" not in str(item)
        ]
        lifecycle["staleReasons"] = stale_reasons
        relocate_entry_file(knowledge, entry, source_path)
        path_by_id[entry["id"]] = knowledge / "entries" / "active" / entry_filename(entry)
        after_status = "active"
    elif action == "drop":
        supersede_entry(entry, str(decision.get("supersededBy") or entry["id"]), reason or "judge drop")
        lifecycle = entry.setdefault("lifecycle", {})
        lifecycle["judgeAction"] = action
        if not decision.get("supersededBy"):
            lifecycle["supersededBy"] = None
            lifecycle["droppedByJudge"] = True
        relocate_entry_file(knowledge, entry, source_path)
        path_by_id[entry["id"]] = knowledge / "entries" / "superseded" / entry_filename(entry)
        after_status = "superseded"
    elif action == "supersede":
        target_id = str(decision.get("supersededBy") or "")
        if not target_id:
            raise ValueError(f"supersede action requires supersededBy for entry {entry['id']}")
        supersede_entry(entry, target_id, reason or ("judge supersede by: " + target_id))
        entry.setdefault("lifecycle", {})["judgeAction"] = action
        target = by_id.get(target_id)
        if target is not None:
            supersedes = target.setdefault("lifecycle", {}).setdefault("supersedes", [])
            if entry["id"] not in supersedes:
                supersedes.append(entry["id"])
            target_path = path_by_id.get(target_id)
            relocate_entry_file(knowledge, target, target_path)
            path_by_id[target_id] = knowledge / "entries" / str(target.get("status")) / entry_filename(target)
        relocate_entry_file(knowledge, entry, source_path)
        path_by_id[entry["id"]] = knowledge / "entries" / "superseded" / entry_filename(entry)
        after_status = "superseded"
    elif action == "keep-conflict":
        entry["status"] = "conflicted"
        lifecycle = entry.setdefault("lifecycle", {})
        lifecycle["judgeAction"] = action
        lifecycle["judgeReason"] = reason
        lifecycle["lastCheckedAt"] = now_iso()
        relocate_entry_file(knowledge, entry, source_path)
        path_by_id[entry["id"]] = knowledge / "entries" / "conflicted" / entry_filename(entry)
        after_status = "conflicted"
    else:
        raise ValueError(f"unsupported judge action: {action}")

    return {
        "id": entry["id"],
        "action": action,
        "reason": reason,
        "before": before,
        "after": {"status": after_status, "supersededBy": entry.get("lifecycle", {}).get("supersededBy")},
        "supersededBy": decision.get("supersededBy"),
    }


def judge_apply(project: Path, decisions_path: Path, force: bool = False) -> dict[str, Any]:
    project = project.resolve()
    knowledge = project / ".harness" / "knowledge"
    if not (knowledge / "index.json").exists():
        build_index(project)
    if manual_review_enabled(project) and not force:
        raise ValueError("knowledge.manualReview=true; pass --force to apply judgements")

    raw = read_json(decisions_path)
    if isinstance(raw, dict):
        decisions = raw.get("decisions")
    else:
        decisions = raw
    if not isinstance(decisions, list):
        raise ValueError("decisions file must be a list or an object with decisions[]")

    loaded = load_entry_files(knowledge)
    path_by_id = {entry["id"]: path for path, entry in loaded}
    by_id = {entry["id"]: entry for _, entry in loaded}
    applied: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []

    for item in decisions:
        if not isinstance(item, dict):
            errors.append({"error": "decision must be an object"})
            continue
        entry_id = str(item.get("id") or "")
        action = str(item.get("action") or "")
        if not entry_id or action not in JUDGE_ACTIONS:
            errors.append({"id": entry_id, "error": f"invalid decision: action={action}"})
            continue
        found = by_id.get(entry_id)
        source_path = path_by_id.get(entry_id)
        if found is None or source_path is None:
            errors.append({"id": entry_id, "error": "entry not found"})
            continue
        try:
            record = apply_judge_decision(knowledge, found, source_path, item, by_id, path_by_id)
            applied.append(record)
        except ValueError as exc:
            errors.append({"id": entry_id, "error": str(exc)})

    judgement = {
        "schemaVersion": 1,
        "generatedAt": now_iso(),
        "project": str(project),
        "sourceDecisions": str(decisions_path),
        "manualReview": manual_review_enabled(project),
        "forced": force,
        "applied": applied,
        "errors": errors,
    }
    judgement_path = knowledge / "reports" / f"judgements-{timestamp()}.json"
    write_json(judgement_path, judgement)
    index = refresh_outputs_from_entry_files(project, knowledge)
    return {
        "project": str(project),
        "generatedAt": judgement["generatedAt"],
        "judgement": str(judgement_path),
        "applied": len(applied),
        "errors": errors,
        "stats": index.get("stats", {}),
        "paths": {
            "judgement": str(judgement_path),
            "index": str(knowledge / "index.json"),
            "sqlite": str(knowledge / "index.sqlite"),
        },
    }


def restore_entry_from_snapshot(knowledge: Path, before: dict[str, Any], current_path: Path | None) -> Path:
    entry = json_clone(before)
    if not entry.get("projectId"):
        entry["projectId"] = "unknown"
    if "schemaVersion" not in entry:
        entry["schemaVersion"] = 1
    status = str(entry.get("status") or "candidate")
    if status not in ENTRY_STATUSES:
        status = "candidate"
        entry["status"] = status
    target = knowledge / "entries" / status / entry_filename(entry)
    write_json(target, entry)
    if current_path is not None and current_path.exists() and current_path.resolve() != target.resolve():
        current_path.unlink()
    # Remove any stray copies of the same id in other status dirs.
    for status_name in ENTRY_STATUSES:
        for path in (knowledge / "entries" / status_name).glob("*.json"):
            if path.resolve() == target.resolve():
                continue
            try:
                other = read_json(path)
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(other, dict) and other.get("id") == entry.get("id"):
                path.unlink()
    return target


def rollback_judgement(project: Path, judgement_path: Path) -> dict[str, Any]:
    project = project.resolve()
    knowledge = project / ".harness" / "knowledge"
    judgement = read_json(judgement_path)
    if not isinstance(judgement, dict):
        raise ValueError("judgement file must be a JSON object")
    applied = judgement.get("applied")
    if not isinstance(applied, list):
        raise ValueError("judgement file missing applied[]")

    restored: list[dict[str, Any]] = []
    for item in reversed(applied):
        if not isinstance(item, dict):
            continue
        before = item.get("before")
        if not isinstance(before, dict) or not before.get("id"):
            continue
        entry_id = str(before["id"])
        found = find_entry_file(knowledge, entry_id, list(ENTRY_STATUSES))
        current_path = found[0] if found else None
        restore_entry_from_snapshot(knowledge, before, current_path)
        restored.append({"id": entry_id, "status": before.get("status")})

    index = refresh_outputs_from_entry_files(project, knowledge)
    return {
        "project": str(project),
        "generatedAt": now_iso(),
        "judgement": str(judgement_path),
        "restored": len(restored),
        "entries": restored,
        "stats": index.get("stats", {}),
        "paths": {
            "index": str(knowledge / "index.json"),
            "sqlite": str(knowledge / "index.sqlite"),
        },
    }


def _outbox_root(project: Path) -> Path:
    return project / ".harness" / "knowledge" / "maintenance-outbox"


def _outbox_item_path(outbox_root: Path, status: str, archive_id: str) -> Path:
    return outbox_root / status / f"{archive_id}.json"


def _move_outbox(
    outbox_root: Path, archive_id: str, from_status: str, to_status: str, item: dict[str, Any]
) -> None:
    src = _outbox_item_path(outbox_root, from_status, archive_id)
    dst = _outbox_item_path(outbox_root, to_status, archive_id)
    dst.parent.mkdir(parents=True, exist_ok=True)
    write_json(dst, item)
    if src.exists() and src.resolve() != dst.resolve():
        src.unlink()


def claim_outbox(outbox_root: Path, archive_id: str) -> tuple[dict[str, Any] | None, str | None]:
    """Atomically claim a pending or failed item -> running. Retryable from failed.
    Returns (item, current_status). If already running/completed, returns it as-is."""
    for from_status in ("pending", "failed", "pending-judge"):
        src = _outbox_item_path(outbox_root, from_status, archive_id)
        if src.is_file():
            try:
                dst = _outbox_item_path(outbox_root, "running", archive_id)
                dst.parent.mkdir(parents=True, exist_ok=True)
                # os.replace is the ownership boundary: only the process that
                # wins this rename may perform maintenance for this archive.
                src.replace(dst)
                item = read_json(dst)
            except FileNotFoundError:
                continue
            except (OSError, json.JSONDecodeError):
                item = {
                    "schemaVersion": 1,
                    "archiveId": archive_id,
                    "status": from_status,
                    "attempts": 0,
                }
            item["status"] = "running"
            write_json(_outbox_item_path(outbox_root, "running", archive_id), item)
            return item, "running"
    for status in ("running", "completed", "pending-judge"):
        p = _outbox_item_path(outbox_root, status, archive_id)
        if p.is_file():
            try:
                return read_json(p), status
            except (OSError, json.JSONDecodeError):
                pass
    return None, None


def maintain_knowledge(project: Path, archive_id: str) -> dict[str, Any]:
    """§8.3: single-process maintenance. Claim pending->running, incremental
    ingest (build_index already does in-memory near-dedupe -- do NOT re-run a
    disk-based dedupe pass), auto-supersede, reverify-stale, export residual
    judge checklist, running->completed (or completed_rules_pending_judge).
    Idempotent for completed items. Failure -> failed, attempts+1, retryable."""
    project = project.resolve()
    outbox_root = _outbox_root(project)
    outbox_root.mkdir(parents=True, exist_ok=True)

    item, status = claim_outbox(outbox_root, archive_id)
    if item is None:
        return {
            "ok": False,
            "archiveId": archive_id,
            "status": "not-found",
            "error": "no pending/failed/running/completed outbox item",
        }
    if status == "completed":
        return {
            "ok": True,
            "archiveId": archive_id,
            "status": str(item.get("status") or "completed"),
            "pendingJudgements": int(item.get("pendingJudgements") or 0),
            "idempotent": True,
        }

    try:
        # 2-3. incremental ingest (in-memory near-dedupe inside build_index)
        build_index(project, incremental=True)
        # A failure here means the archive has not completed maintenance.
        # Never convert that failure into a successful completed outbox entry.
        auto_supersede_knowledge(project)
        reverify_stale_knowledge(project)
        # 6. export residual judge checklist
        judge_result = judge_export(project)
        pending = int((judge_result.get("counts") or {}).get("pending") or 0)
        if pending > 0:
            pj_path = (
                project
                / ".harness"
                / "knowledge"
                / "reports"
                / f"pending-judgements-{archive_id}.json"
            )
            write_json(pj_path, judge_result)
            final_status = "pending-judge"
        else:
            final_status = "completed"
        item["status"] = final_status
        item["pendingJudgements"] = pending
        item["completedAt"] = now_iso()
        item["lastError"] = None
        _move_outbox(outbox_root, archive_id, "running", final_status, item)
        return {
            "ok": True,
            "archiveId": archive_id,
            "status": final_status,
            "pendingJudgements": pending,
        }
    except Exception as exc:
        item["status"] = "failed"
        item["attempts"] = int(item.get("attempts") or 0) + 1
        item["lastError"] = str(exc)
        item["failedAt"] = now_iso()
        _move_outbox(outbox_root, archive_id, "running", "failed", item)
        return {
            "ok": False,
            "archiveId": archive_id,
            "status": "failed",
            "error": str(exc),
            "attempts": item["attempts"],
        }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build and query Harness knowledge indexes.")
    sub = parser.add_subparsers(dest="command", required=True)

    ingest = sub.add_parser("ingest", help="Build .harness/knowledge from .harness/archive")
    ingest.add_argument("--project", default=".", help="Project root containing .harness/archive")
    ingest.add_argument(
        "--no-incremental",
        action="store_true",
        help="Re-extract every archive instead of reusing the archive entry cache",
    )

    sync = sub.add_parser("sync", help="Check whether .harness/knowledge is current")
    sync.add_argument("--project", default=".", help="Project root containing .harness/archive")
    sync.add_argument("--update", action="store_true", help="Rebuild the index when it is out of date")
    sync.add_argument(
        "--no-incremental",
        action="store_true",
        help="When used with --update, rebuild without reusing the archive entry cache",
    )

    auto = sub.add_parser("auto", help="Run the default automated knowledge maintenance workflow")
    auto.add_argument("--project", default=".", help="Project root containing .harness/archive")
    auto.add_argument("--limit", type=int, default=20, help="Maximum entries to suggest validators for")
    auto.add_argument("--audit-limit", type=int, default=10, help="Maximum audit entries per review section")
    auto.add_argument(
        "--suggest-status",
        action="append",
        dest="suggest_statuses",
        default=[],
        help="Only suggest validators for this lifecycle status",
    )
    auto.add_argument(
        "--no-apply-suggestions",
        action="store_true",
        help="Do not write validator suggestions into entry JSON files (default applies them)",
    )
    auto.add_argument("--no-incremental", action="store_true", help="Refresh without reusing the archive entry cache")

    audit = sub.add_parser("audit", help="Generate review lists for candidate, stale, and superseded entries")
    audit.add_argument("--project", default=".", help="Project root containing .harness/knowledge")
    audit.add_argument("--limit", type=int, default=10)

    verify = sub.add_parser("verify", help="Run configured validators against knowledge entries")
    verify.add_argument("--project", default=".", help="Project root containing .harness/knowledge")

    suggest = sub.add_parser("suggest-validators", help="Suggest deterministic validators for knowledge entries")
    suggest.add_argument("--project", default=".", help="Project root containing .harness/knowledge")
    suggest.add_argument("--limit", type=int, default=20, help="Maximum entries to suggest validators for")
    suggest.add_argument("--status", action="append", dest="statuses", default=[], help="Only suggest for this lifecycle status")
    suggest.add_argument("--apply", action="store_true", help="Write suggested validators into entry JSON files")

    query = sub.add_parser("query", help="Query .harness/knowledge and generate a context pack")
    query.add_argument("--project", default=".", help="Project root containing .harness/knowledge")
    query.add_argument("--query", required=True, help="Need, question, keyword, or file path to search")
    query.add_argument("--limit", type=int, default=10)
    query.add_argument("--file", action="append", dest="files", default=[], help="Only return entries linked to this source file")
    query.add_argument("--status", action="append", dest="statuses", default=[], help="Only return entries with this lifecycle status")
    query.add_argument("--type", action="append", dest="types", default=[], help="Only return entries of this knowledge type")

    promote = sub.add_parser("promote", help="Promote a candidate knowledge entry to active")
    promote.add_argument("--project", default=".", help="Project root containing .harness/knowledge")
    promote.add_argument("--id", required=True, help="Knowledge entry id to promote")
    promote.add_argument("--note", default="", help="Manual verification note")
    promote.add_argument(
        "--allow-stale",
        action="store_true",
        help="Allow promoting a stale entry after manual verification",
    )

    demote = sub.add_parser("demote", help="Demote an active entry after manual review")
    demote.add_argument("--project", default=".", help="Project root containing .harness/knowledge")
    demote.add_argument("--id", required=True, help="Active knowledge entry id to demote")
    demote.add_argument("--status", choices=["candidate", "stale"], required=True, help="Target lifecycle status")
    demote.add_argument("--reason", required=True, help="Manual demotion reason")

    dedupe = sub.add_parser("dedupe", help="Merge near-duplicate entries within the same archive")
    dedupe.add_argument("--project", default=".", help="Project root containing .harness/knowledge")
    dedupe.add_argument("--json", action="store_true", help="Emit machine-readable JSON (default behavior)")

    auto_supersede = sub.add_parser(
        "auto-supersede",
        help="Supersede older same-topic entries when evolution is clear",
    )
    auto_supersede.add_argument("--project", default=".", help="Project root containing .harness/knowledge")
    auto_supersede.add_argument("--json", action="store_true", help="Emit machine-readable JSON (default behavior)")

    reverify = sub.add_parser(
        "reverify-stale",
        help="Re-run file_exists/file_contains validators on stale entries",
    )
    reverify.add_argument("--project", default=".", help="Project root containing .harness/knowledge")
    reverify.add_argument("--json", action="store_true", help="Emit machine-readable JSON (default behavior)")

    judge = sub.add_parser("judge", help="Export or apply AI judgement decisions")
    judge.add_argument("--project", default=".", help="Project root containing .harness/knowledge")
    judge_mode = judge.add_mutually_exclusive_group(required=True)
    judge_mode.add_argument("--export", metavar="FILE", help="Write pending judgement checklist JSON")
    judge_mode.add_argument("--apply", metavar="FILE", help="Apply decisions JSON and write judgement log")
    judge.add_argument(
        "--force",
        action="store_true",
        help="Required when knowledge.manualReview=true before applying judgements",
    )
    judge.add_argument("--json", action="store_true", help="Emit machine-readable JSON (default behavior)")

    rollback = sub.add_parser("rollback", help="Restore entry states from a judgement decision log")
    rollback.add_argument("--project", default=".", help="Project root containing .harness/knowledge")
    rollback.add_argument("--judgement", required=True, help="Path to judgements-*.json decision log")
    rollback.add_argument("--json", action="store_true", help="Emit machine-readable JSON (default behavior)")

    maintain = sub.add_parser(
        "maintain",
        help="Single-process maintenance: claim outbox, ingest+dedupe, supersede, reverify, judge-export",
    )
    maintain.add_argument("--project", default=".", help="Project root containing .harness/knowledge")
    maintain.add_argument("--archive-id", required=True, help="Archive id of the outbox item to maintain")
    maintain.add_argument("--json", action="store_true", help="Emit machine-readable JSON (default behavior)")

    args = parser.parse_args(argv)
    if args.command == "ingest":
        index = build_index(Path(args.project), incremental=not args.no_incremental)
        print(json.dumps(summarize_index(index), ensure_ascii=False, indent=2))
        return 0
    if args.command == "sync":
        result = sync_status(Path(args.project), args.update, incremental=not args.no_incremental)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.command == "auto":
        result = auto_knowledge(
            Path(args.project),
            limit=args.limit,
            suggest_statuses=args.suggest_statuses,
            apply_suggestions=not args.no_apply_suggestions,
            incremental=not args.no_incremental,
            audit_limit=args.audit_limit,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.command == "audit":
        result = audit_entries(Path(args.project), args.limit)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.command == "verify":
        result = verify_knowledge(Path(args.project))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.command == "suggest-validators":
        result = suggest_validators(Path(args.project), args.limit, args.statuses, args.apply)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.command == "query":
        result = query_index(Path(args.project), args.query, args.limit, args.files, args.statuses, args.types)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.command == "promote":
        try:
            result = promote_entry(Path(args.project), args.id, args.note, args.allow_stale)
        except ValueError as exc:
            print(str(exc), file=sys.stderr)
            return 1
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.command == "demote":
        try:
            result = demote_entry(Path(args.project), args.id, args.status, args.reason)
        except ValueError as exc:
            print(str(exc), file=sys.stderr)
            return 1
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.command == "dedupe":
        result = dedupe_knowledge(Path(args.project))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.command == "auto-supersede":
        result = auto_supersede_knowledge(Path(args.project))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.command == "reverify-stale":
        result = reverify_stale_knowledge(Path(args.project))
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.command == "judge":
        try:
            if args.export:
                result = judge_export(Path(args.project))
                export_target = Path(args.export)
                write_json(export_target, {k: v for k, v in result.items() if k != "exportPath"})
                result["exportPath"] = str(export_target.resolve())
            else:
                result = judge_apply(Path(args.project), Path(args.apply), force=args.force)
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            print(str(exc), file=sys.stderr)
            return 1
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.command == "rollback":
        try:
            result = rollback_judgement(Path(args.project), Path(args.judgement))
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            print(str(exc), file=sys.stderr)
            return 1
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.command == "maintain":
        result = maintain_knowledge(Path(args.project), args.archive_id)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result.get("ok") else 1
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
