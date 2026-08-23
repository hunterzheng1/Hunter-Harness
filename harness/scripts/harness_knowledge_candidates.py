#!/usr/bin/env python3
"""Knowledge candidate generation from an archived change's summary-data.json.

The archive workflow has already filtered once: review findings were produced by
an independent reviewer and then adjudicated, knownRisks are evidence-derived
facts, and decisions are structured records adopted upstream (plan/execute/
review). This module turns those three — and only those three — into
KnowledgeCandidate records for the archive package's ``candidates/knowledge.json``.

Mapping is fixed by docs/superpowers/specs/2026-08-18-three-views-data-flow-design.md
("知识来源的选定"), extended 2026-08-23 with the decisions source::

    disposition = FIXED                      -> pitfall   RED 0.95 / YELLOW 0.85
    disposition = ACCEPTED_RISK | DEFERRED   -> risk      RED 0.95 / YELLOW 0.85
    knownRisks[]                             -> risk      0.85
    decisions[status=adopted]                -> record's entry_type (decision |
                                                requirement | api-contract)  0.85
    severity = OK | disposition = NOT_APPLICABLE -> dropped
    decisions[status != adopted]             -> kept in summary, not knowledge

Dispositions outside the adopted set (OPEN / UNKNOWN) are dropped too: an
unadjudicated finding is not yet knowledge. maintenanceNotes, finalStatusReasons
and manualActions are deliberately excluded — the spec evaluated each and found
them too noisy or empty to be worth persisting.

No LLM is involved. Every emitted field is copied or derived from a real
summary-data field, so the output is reproducible and free of invention.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

SCHEMA_VERSION = 1
PRODUCER = "harness-archive"

# Only these severities carry knowledge; OK is explicitly dropped by the spec.
_SEVERITIES = {"RED", "YELLOW"}
# Adjudicated dispositions the spec adopts, mapped to the knowledge entry type.
_DISPOSITION_ENTRY_TYPES = {
    "FIXED": "pitfall",
    "ACCEPTED_RISK": "risk",
    "DEFERRED": "risk",
}
_SEVERITY_CONFIDENCE = {"RED": 0.95, "YELLOW": 0.85}
_KNOWN_RISK_CONFIDENCE = 0.85

# decisions[]（来自 change 的 evidence/decisions.json，经 summary.decisions 传入）
# 与 findings 的裁决门槛同源：只有已采纳（adopted）的决策才成为候选——
# proposed/rejected/superseded 留在 summary 里做记录，但不构成知识。
# entry_type 直接取自记录，取值与 knowledgeCandidateEntryTypeSchema 对齐；
# source 对应 candidateProvenanceSourceKindSchema 的枚举。
_DECISION_ENTRY_TYPES = {"decision", "requirement", "api-contract"}
_DECISION_STATUSES = {"adopted", "proposed", "rejected", "superseded"}
_DECISION_SOURCE_KINDS = {"plan", "review", "manual", "archive"}
_DECISION_CONFIDENCE = 0.85

_MAX_KEYWORDS = 32
_MAX_KEYWORD_CHARS = 80
_MAX_BODY_CHARS = 20_000


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _digest(*parts: str) -> str:
    return hashlib.sha256("\0".join(parts).encode("utf-8")).hexdigest()


def _candidate_id(change_key: str, kind: str, identity: str) -> str:
    return f"kc_{_digest(change_key, kind, identity)[:32]}"


def _content_hash(entry_type: str, summary: str, body: str, keywords: list[str]) -> str:
    canonical = json.dumps(
        {"entry_type": entry_type, "summary": summary, "body": body, "keywords": keywords},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _keywords(*values: str) -> list[str]:
    """Deduplicate, preserve order, and honour the contract's bounds."""
    seen: list[str] = []
    for value in values:
        keyword = _text(value)[:_MAX_KEYWORD_CHARS]
        if keyword and keyword not in seen:
            seen.append(keyword)
    return seen[:_MAX_KEYWORDS]


def _path_segments(path: str) -> list[str]:
    return [segment for segment in path.replace("\\", "/").split("/") if segment]


def _location(path: str, line: Any) -> str:
    """``path:line`` when the line number is real, otherwise just the path."""
    if not path:
        return ""
    if isinstance(line, bool) or not isinstance(line, int) or line < 1:
        return path
    return f"{path}:{line}"


def _finding_candidate(
    finding: dict[str, Any],
    *,
    change_key: str,
    archive_id: str,
    producer_version: str,
    created_at: str,
) -> dict[str, Any] | None:
    severity = _text(finding.get("severity"))
    disposition = _text(finding.get("disposition"))
    entry_type = _DISPOSITION_ENTRY_TYPES.get(disposition)
    title = _text(finding.get("title"))
    if severity not in _SEVERITIES or entry_type is None or not title:
        return None

    path = _text(finding.get("path"))
    line = finding.get("line")
    location = _location(path, line)
    segments = _path_segments(path)
    finding_id = _text(finding.get("id"))

    body_lines = [title]
    if location:
        body_lines.append(f"位置：{location}")
    body_lines.append(f"严重度：{severity}")
    body_lines.append(f"裁决：{disposition}")
    body = "\n".join(body_lines)[:_MAX_BODY_CHARS]

    keywords = _keywords(
        segments[-1] if segments else "",
        segments[-2] if len(segments) >= 2 else "",
        severity,
        disposition,
    )
    source_ref = f"archive:{archive_id}#{finding_id}" if finding_id else f"archive:{archive_id}"
    if path and location != path:
        source_refs = [f"{path}#L{line}"]
    elif path:
        source_refs = [path]
    else:
        source_refs = [f"archive:{archive_id}"]

    return {
        "schema_version": SCHEMA_VERSION,
        "candidate_id": _candidate_id(
            change_key, "review", finding_id or f"{title}\0{path}\0{line}"
        ),
        "source_change_key": change_key,
        "source_refs": source_refs,
        "summary": title,
        "reusability_scope": segments[0] if segments else "project",
        "content_hash": _content_hash(entry_type, title, body, keywords),
        "confidence": _SEVERITY_CONFIDENCE[severity],
        "status": "pending",
        "entry_type": entry_type,
        "body": body,
        "keywords": keywords,
        "provenance": {
            "source_kind": "review",
            "source_ref": source_ref,
            "producer": PRODUCER,
            "producer_version": producer_version,
            "created_at": created_at,
        },
    }


def _risk_candidate(
    risk: dict[str, Any],
    *,
    change_key: str,
    archive_id: str,
    producer_version: str,
    created_at: str,
) -> dict[str, Any] | None:
    message = _text(risk.get("message"))
    if not message:
        return None
    phase = _text(risk.get("phase"))
    severity = _text(risk.get("severity"))

    body_lines = [message]
    if phase:
        body_lines.append(f"阶段：{phase}")
    if severity:
        body_lines.append(f"严重度：{severity}")
    body = "\n".join(body_lines)[:_MAX_BODY_CHARS]
    keywords = _keywords(phase, severity)

    return {
        "schema_version": SCHEMA_VERSION,
        "candidate_id": _candidate_id(change_key, "known_risk", f"{phase}\0{message}"),
        "source_change_key": change_key,
        "source_refs": [f"archive:{archive_id}"],
        "summary": message,
        "reusability_scope": phase or "project",
        "content_hash": _content_hash("risk", message, body, keywords),
        "confidence": _KNOWN_RISK_CONFIDENCE,
        "status": "pending",
        "entry_type": "risk",
        "body": body,
        "keywords": keywords,
        "provenance": {
            "source_kind": "archive",
            "source_ref": f"archive:{archive_id}",
            "producer": PRODUCER,
            "producer_version": producer_version,
            "created_at": created_at,
        },
    }


def _decision_candidate(
    record: dict[str, Any],
    *,
    change_key: str,
    archive_id: str,
    producer_version: str,
    created_at: str,
) -> dict[str, Any] | None:
    """Project one adopted design decision / requirement / API contract entry.

    Every field is copied from the record (written upstream by a human or an
    agent during plan/execute/review); nothing is inferred at archive time.
    """
    title = _text(record.get("title"))
    entry_type = _text(record.get("entry_type"))
    status = _text(record.get("status")).lower()
    if not title or entry_type not in _DECISION_ENTRY_TYPES or status != "adopted":
        return None

    rationale = _text(record.get("rationale"))
    path = _text(record.get("path"))
    line = record.get("line")
    location = _location(path, line)
    segments = _path_segments(path)
    record_id = _text(record.get("id"))
    source = _text(record.get("source"))
    if source not in _DECISION_SOURCE_KINDS:
        source = "plan"
    raw_keywords = record.get("keywords")
    record_keywords = (
        [item for item in raw_keywords if isinstance(item, str)]
        if isinstance(raw_keywords, list)
        else []
    )

    body_lines = [title]
    if rationale:
        body_lines.append(f"理由：{rationale}")
    if location:
        body_lines.append(f"位置：{location}")
    body_lines.append(f"类型：{entry_type}")
    body = "\n".join(body_lines)[:_MAX_BODY_CHARS]
    keywords = _keywords(
        *record_keywords,
        segments[-1] if segments else "",
        segments[-2] if len(segments) >= 2 else "",
        entry_type,
    )
    if path and location != path:
        source_refs = [f"{path}#L{line}"]
    elif path:
        source_refs = [path]
    else:
        source_refs = [f"archive:{archive_id}"]

    return {
        "schema_version": SCHEMA_VERSION,
        "candidate_id": _candidate_id(
            change_key, "decision", record_id or f"{title}\0{path}\0{line}"
        ),
        "source_change_key": change_key,
        "source_refs": source_refs,
        "summary": title,
        "reusability_scope": segments[0] if segments else "project",
        "content_hash": _content_hash(entry_type, title, body, keywords),
        "confidence": _DECISION_CONFIDENCE,
        "status": "pending",
        "entry_type": entry_type,
        "body": body,
        "keywords": keywords,
        "provenance": {
            "source_kind": source,
            "source_ref": f"archive:{archive_id}#{record_id}" if record_id else f"archive:{archive_id}",
            "producer": PRODUCER,
            "producer_version": producer_version,
            "created_at": created_at,
        },
    }


def build_knowledge_candidates(
    summary: dict[str, Any],
    *,
    change_key: str,
    archive_id: str,
    producer_version: str,
    created_at: str,
) -> list[dict[str, Any]]:
    """Project reviewFindings + knownRisks into KnowledgeCandidate records.

    Returns [] for missing or malformed input: an archive with nothing worth
    persisting must still produce a valid (empty) candidates file.
    """
    if not isinstance(summary, dict):
        return []
    candidates: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    def collect(candidate: dict[str, Any] | None) -> None:
        if candidate is None or candidate["candidate_id"] in seen_ids:
            return
        seen_ids.add(candidate["candidate_id"])
        candidates.append(candidate)

    findings = summary.get("reviewFindings")
    if isinstance(findings, list):
        for finding in findings:
            if isinstance(finding, dict):
                collect(_finding_candidate(
                    finding,
                    change_key=change_key,
                    archive_id=archive_id,
                    producer_version=producer_version,
                    created_at=created_at,
                ))

    risks = summary.get("knownRisks")
    if isinstance(risks, list):
        for risk in risks:
            if isinstance(risk, dict):
                collect(_risk_candidate(
                    risk,
                    change_key=change_key,
                    archive_id=archive_id,
                    producer_version=producer_version,
                    created_at=created_at,
                ))

    decisions = summary.get("decisions")
    if isinstance(decisions, list):
        for record in decisions:
            if isinstance(record, dict):
                collect(_decision_candidate(
                    record,
                    change_key=change_key,
                    archive_id=archive_id,
                    producer_version=producer_version,
                    created_at=created_at,
                ))

    return candidates


# Dispositions that mean "not yet adjudicated". A finding in this state with a
# knowledge-carrying severity is dropped by the mapping above — correctly — but
# the drop must be visible, or an archive with real findings looks identical to
# an archive with nothing worth keeping (both ship an empty candidates file).
_UNADJUDICATED_DISPOSITIONS = {"", "OPEN", "UNKNOWN"}


def count_unadjudicated_findings(summary: dict[str, Any]) -> int:
    """Count RED/YELLOW reviewFindings whose disposition is not yet adjudicated.

    These are the findings the mapping table silently drops. Callers use the
    count to warn when an archive would otherwise show "ready / 0 results"
    despite carrying real, unprocessed review signal.
    """
    if not isinstance(summary, dict):
        return 0
    findings = summary.get("reviewFindings")
    if not isinstance(findings, list):
        return 0
    count = 0
    for finding in findings:
        if not isinstance(finding, dict):
            continue
        severity = _text(finding.get("severity"))
        disposition = _text(finding.get("disposition")).upper()
        if severity in _SEVERITIES and disposition in _UNADJUDICATED_DISPOSITIONS:
            count += 1
    return count


def render_knowledge_candidates_json(candidates: list[dict[str, Any]]) -> str:
    """Deterministic bytes for the archive package entry."""
    return json.dumps(
        candidates, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ) + "\n"
