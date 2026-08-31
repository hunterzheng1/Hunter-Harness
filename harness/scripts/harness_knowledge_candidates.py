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
import re
import sys
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


def _valid_source_path(path: Any) -> str | None:
    """source_ref 的结构校验（与服务端 ARCHIVE_CANDIDATE_SOURCE_UNBOUND 同规则）。

    合法形态：`relative/path/to/file.ext`（调用方再附 `#L<line>`）。
    拒绝：目录引用（尾部斜杠）、空路径段、`.`/`..` 段、绝对路径、盘符、
    反斜杠。返回规范化路径；不合法返回 None——调用方必须跳过该候选，
    不得生成「目录 + 行号」的伪来源（2026-08-31 demo-datasource 实测：
    `quality/#L1` 一条不合法 ref 挡掉整份 42 条候选的包）。
    """
    if not isinstance(path, str):
        return None
    raw = path.strip()
    if not raw:
        return None
    if "\\" in raw:  # 反斜杠路径不合法（服务端拒绝，不做静默转换）
        return None
    if raw.startswith("/") or re.match(r"^[A-Za-z]:", raw):
        return None
    if raw.endswith("/"):  # 目录引用——尾部斜杠形成空路径段
        return None
    segments = raw.split("/")
    if any(segment in ("", ".", "..") for segment in segments):
        return None
    return raw


def _bound_source_refs(path: Any, line: Any, archive_id: str) -> list[str] | None:
    """构造可绑定文件来源；path 缺失时回退 archive 级来源，非法时返回 None。"""
    if not path or not isinstance(path, str) or not path.strip():
        return [f"archive:{archive_id}"]
    valid = _valid_source_path(path)
    if valid is None:
        return None
    if isinstance(line, int) and line > 0:
        return [f"{valid}#L{line}"]
    return [valid]
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
    source_refs = _bound_source_refs(path, line, archive_id)
    if source_refs is None:
        # 目录/非法路径——跳过整条候选，不生成伪来源（服务端会拒绝整包）；
        # 跳过必须可见，否则「少了一条候选」无从追溯
        print(
            "[harness-knowledge-candidates] 跳过候选：source_refs 非法"
            f"（path={path!r}，finding={finding_id or title!r}）",
            file=sys.stderr,
        )
        return None

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
    source_refs = _bound_source_refs(path, line, archive_id)
    if source_refs is None:
        print(
            "[harness-knowledge-candidates] 跳过候选：source_refs 非法"
            f"（path={path!r}）",
            file=sys.stderr,
        )
        return None

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


# --- plan/design-derived knowledge candidates ---------------------------------
#
# reviewFindings/knownRisks/decisions 只覆盖“经对抗评审的变更”。没有评审的简单
# 变更（无 RED/YELLOW 发现、无 knownRisks、无 adopted decisions）仍产出了
# 经用户确认批准的 design/plan/test-scenarios——这些也是值得沉淀的知识。
# 这里把 plans/*.md（v2 finalize 派生的机器契约）解析回结构化的自然内容，
# 与 summary 三源并列，但 confidence 略低（机器派生而非独立评审）。

_PLAN_CONFIDENCE = 0.85
_PLAN_SOURCE_KIND = "plan"


def _unescape_markdown(value: str) -> str:
    """Reverse the renderer's markdown escaping for clean knowledge text.

    harness-plan finalize 的渲染器对自由文本做了反斜杠/实体转义。知识候选存
    的是自然语言，不需要保留渲染转义。顺序有讲究：先反转义实体，再反转义
    反斜杠序列（从长到短）。
    """
    value = (
        value.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("<br>", "\n")
    )
    return (
        value.replace("\\`", "`")
        .replace("\\#", "#")
        .replace("\\*", "*")
        .replace("\\[", "[")
        .replace("\\]", "]")
        .replace("\\\\", "\\")
    )


def _markdown_sections(text: str) -> dict[str, list[str]]:
    """Split a v2 rendered markdown artifact into its ``## Header`` sections.

    Returns ``{header: [lines...]}``. Only the ``##`` level is split; ``###``
    and ``####`` content stays inside its parent section's lines.
    """
    sections: dict[str, list[str]] = {}
    current: str | None = None
    for line in text.splitlines():
        if line.startswith("## ") and not line.startswith("### "):
            current = line[3:].strip()
            sections[current] = []
        elif current is not None:
            sections[current].append(line)
    return sections


def _plan_source_refs(change_key: str, package_path: str) -> list[str]:
    """source_refs must exist in the package (core-v1 containment check)."""
    return [package_path]


def _plan_candidate(
    *,
    change_key: str,
    archive_id: str,
    producer_version: str,
    created_at: str,
    kind: str,
    entry_type: str,
    summary: str,
    body: str,
    keywords: list[str],
    source_refs: list[str],
    reusability_scope: str = "project",
) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "candidate_id": _candidate_id(change_key, kind, summary),
        "source_change_key": change_key,
        "source_refs": source_refs,
        "summary": summary,
        "reusability_scope": reusability_scope,
        "content_hash": _content_hash(entry_type, summary, body, keywords),
        "confidence": _PLAN_CONFIDENCE,
        "status": "pending",
        "entry_type": entry_type,
        "body": body,
        "keywords": keywords,
        "provenance": {
            "source_kind": _PLAN_SOURCE_KIND,
            "source_ref": f"archive:{archive_id}",
            "producer": PRODUCER,
            "producer_version": producer_version,
            "created_at": created_at,
        },
    }


def _requirements_from_design(
    design_text: str,
    *,
    change_key: str,
    archive_id: str,
    producer_version: str,
    created_at: str,
) -> list[dict[str, Any]]:
    """Parse ``## Requirements`` from design.md into requirement candidates.

    Each line is ``- requirement:sha256:... [kind]: text`` where kind is
    behavior | invariant | failure_behavior.
    """
    sections = _markdown_sections(design_text)
    lines = sections.get("Requirements", [])
    out: list[dict[str, Any]] = []
    for line in lines:
        stripped = line.strip()
        if not stripped.startswith("- "):
            continue
        prefix = stripped[2:]
        # kind 位于第一个 `]: ` 之前的方括号内。
        close_bracket = prefix.find("]")
        if close_bracket <= 0 or not prefix.startswith("requirement:"):
            continue
        kind = prefix[1:close_bracket].strip()
        if kind not in {"behavior", "invariant", "failure_behavior"}:
            continue
        colon = prefix.find(": ", close_bracket + 1)
        if colon == -1:
            continue
        text = _unescape_markdown(prefix[colon + 2:].strip())
        if not text:
            continue
        entry_type = "requirement"
        body = f"需求类型：{kind}\n{text}"
        keywords = _keywords(kind, entry_type)
        out.append(_plan_candidate(
            change_key=change_key,
            archive_id=archive_id,
            producer_version=producer_version,
            created_at=created_at,
            kind="requirement",
            entry_type=entry_type,
            summary=text,
            body=body,
            keywords=keywords,
            source_refs=_plan_source_refs(change_key, f"plans/{change_key}-design.md"),
        ))
    return out


def _risks_from_design(
    design_text: str,
    *,
    change_key: str,
    archive_id: str,
    producer_version: str,
    created_at: str,
) -> list[dict[str, Any]]:
    """Parse ``## Risks`` (``- risk`` + ``  - Mitigation: ...``) into risk candidates."""
    sections = _markdown_sections(design_text)
    lines = sections.get("Risks", [])
    out: list[dict[str, Any]] = []
    index = 0
    while index < len(lines):
        stripped = lines[index].strip()
        if not stripped.startswith("- "):
            index += 1
            continue
        risk = _unescape_markdown(stripped[2:].strip())
        if not risk or risk == "None.":
            index += 1
            continue
        mitigation = ""
        if index + 1 < len(lines) and lines[index + 1].strip().startswith("- Mitigation:"):
            mitigation = _unescape_markdown(
                lines[index + 1].strip()[len("- Mitigation:"):].strip()
            )
            index += 1
        body = risk if not mitigation else f"{risk}\n缓解：{mitigation}"
        out.append(_plan_candidate(
            change_key=change_key,
            archive_id=archive_id,
            producer_version=producer_version,
            created_at=created_at,
            kind="risk",
            entry_type="risk",
            summary=risk,
            body=body,
            keywords=_keywords("risk"),
            source_refs=_plan_source_refs(change_key, f"plans/{change_key}-design.md"),
        ))
        index += 1
    return out


def _invariants_from_design(
    design_text: str,
    *,
    change_key: str,
    archive_id: str,
    producer_version: str,
    created_at: str,
) -> list[dict[str, Any]]:
    """Parse ``## Invariants`` bullet list into requirement candidates."""
    sections = _markdown_sections(design_text)
    out: list[dict[str, Any]] = []
    for line in sections.get("Invariants", []):
        stripped = line.strip()
        if not stripped.startswith("- "):
            continue
        text = _unescape_markdown(stripped[2:].strip())
        if not text or text == "None.":
            continue
        out.append(_plan_candidate(
            change_key=change_key,
            archive_id=archive_id,
            producer_version=producer_version,
            created_at=created_at,
            kind="invariant",
            entry_type="requirement",
            summary=text,
            body=f"需求类型：invariant\n{text}",
            keywords=_keywords("invariant", "requirement"),
            source_refs=_plan_source_refs(change_key, f"plans/{change_key}-design.md"),
        ))
    return out


def _tasks_from_plan(
    plan_text: str,
    *,
    change_key: str,
    archive_id: str,
    producer_version: str,
    created_at: str,
) -> list[dict[str, Any]]:
    """Parse ``## Tasks`` from plan.md into implementation candidates.

    Task headings are ``### T1``; the objective is the non-empty text between
    the heading and the first ``- `` metadata bullet.
    """
    sections = _markdown_sections(plan_text)
    lines = sections.get("Tasks", [])
    out: list[dict[str, Any]] = []
    index = 0
    while index < len(lines):
        stripped = lines[index].strip()
        if not stripped.startswith("### "):
            index += 1
            continue
        task_id = stripped[4:].strip()
        index += 1
        objective_parts: list[str] = []
        while index < len(lines):
            current = lines[index].strip()
            if current.startswith("### ") or current.startswith("- "):
                break
            if current:
                objective_parts.append(current)
            index += 1
        objective = " ".join(objective_parts).strip()
        if not objective:
            continue
        body = f"任务：{task_id}\n{objective}"
        out.append(_plan_candidate(
            change_key=change_key,
            archive_id=archive_id,
            producer_version=producer_version,
            created_at=created_at,
            kind="task",
            entry_type="implementation",
            summary=objective,
            body=body,
            keywords=_keywords(task_id, "implementation"),
            source_refs=_plan_source_refs(change_key, f"plans/{change_key}-plan.md"),
        ))
    return out


def _scenarios_from_test_scenarios(
    scenarios_text: str,
    *,
    change_key: str,
    archive_id: str,
    producer_version: str,
    created_at: str,
) -> list[dict[str, Any]]:
    """Parse ``## <id>: <title>`` headings into test-evidence candidates."""
    out: list[dict[str, Any]] = []
    for line in scenarios_text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("## ") or stripped.startswith("### "):
            continue
        heading = stripped[3:].strip()
        if heading == "Coverage":
            continue
        if ":" not in heading:
            continue
        scenario_id, title = heading.split(":", 1)
        title = title.strip()
        if not title:
            continue
        out.append(_plan_candidate(
            change_key=change_key,
            archive_id=archive_id,
            producer_version=producer_version,
            created_at=created_at,
            kind="scenario",
            entry_type="test-evidence",
            summary=title,
            body=f"场景：{scenario_id.strip()}\n{title}",
            keywords=_keywords(scenario_id.strip(), "test-evidence"),
            source_refs=_plan_source_refs(
                change_key, f"plans/{change_key}-test-scenarios.md"
            ),
        ))
    return out


def build_plan_candidates(
    archive_dir,
    *,
    change_key: str,
    archive_id: str,
    producer_version: str,
    created_at: str,
) -> list[dict[str, Any]]:
    """Extract knowledge candidates from the archive's plans/*.md artifacts.

    Complements ``build_knowledge_candidates`` (summary 三源)。没有评审的简单
    变更仍然产出 plans/*.md；这些是经用户确认批准的结构化真相源，parse 回来
    就是可沉淀的知识。缺文件/解析失败返回 []（软失败）。
    """
    candidates: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    def collect(items: list[dict[str, Any]]) -> None:
        for candidate in items:
            if candidate["candidate_id"] in seen_ids:
                continue
            seen_ids.add(candidate["candidate_id"])
            candidates.append(candidate)

    design_path = archive_dir / "plans" / f"{change_key}-design.md"
    if design_path.is_file():
        try:
            design_text = design_path.read_text(encoding="utf-8-sig")
        except OSError:
            design_text = ""
        collect(_requirements_from_design(
            design_text,
            change_key=change_key,
            archive_id=archive_id,
            producer_version=producer_version,
            created_at=created_at,
        ))
        collect(_risks_from_design(
            design_text,
            change_key=change_key,
            archive_id=archive_id,
            producer_version=producer_version,
            created_at=created_at,
        ))
        collect(_invariants_from_design(
            design_text,
            change_key=change_key,
            archive_id=archive_id,
            producer_version=producer_version,
            created_at=created_at,
        ))

    plan_path = archive_dir / "plans" / f"{change_key}-plan.md"
    if plan_path.is_file():
        try:
            plan_text = plan_path.read_text(encoding="utf-8-sig")
        except OSError:
            plan_text = ""
        collect(_tasks_from_plan(
            plan_text,
            change_key=change_key,
            archive_id=archive_id,
            producer_version=producer_version,
            created_at=created_at,
        ))

    scenarios_path = archive_dir / "plans" / f"{change_key}-test-scenarios.md"
    if scenarios_path.is_file():
        try:
            scenarios_text = scenarios_path.read_text(encoding="utf-8-sig")
        except OSError:
            scenarios_text = ""
        collect(_scenarios_from_test_scenarios(
            scenarios_text,
            change_key=change_key,
            archive_id=archive_id,
            producer_version=producer_version,
            created_at=created_at,
        ))

    return candidates


def render_knowledge_candidates_json(candidates: list[dict[str, Any]]) -> str:
    """Deterministic bytes for the archive package entry."""
    return json.dumps(
        candidates, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ) + "\n"
