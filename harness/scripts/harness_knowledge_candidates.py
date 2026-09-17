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

WI-E2 (O3/O4, design-o3-o4-outcome-assets-2026-09-14 §6): every candidate also
carries four asset-metadata keys — applicable_versions / validation_status /
supersedes / expires_when (see _asset_fields()). The contract takes them as an
optional/nullable increment (same evolution path as entry_type/body/keywords;
schema_version stays 1).
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path
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


# --- WI-E2（O3/O4）：资产元数据四键 -------------------------------------
#
# applicable_versions / validation_status / supersedes / expires_when
# （design-o3-o4-outcome-assets-2026-09-14 §6）。契约侧以 optional/nullable
# 增量接收（entry_type/body/keywords 先例，schema_version 保持 1）。
# 生成期取值：validation_status 恒 "unverified"（新候选的事实状态，派生非
# 凑数）；其余三键恒 None——生成期无真实来源可派生适用版本/替代关系/失效
# 条件，空白不凑数（O3 明示），由消费回执与服务端索引后续标注。
# 四键不进 content_hash：hash 锁内容身份，元数据可独立演化。
def _asset_fields() -> dict[str, Any]:
    return {
        "applicable_versions": None,
        "validation_status": "unverified",
        "supersedes": None,
        "expires_when": None,
    }


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
        **_asset_fields(),
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
        **_asset_fields(),
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
        **_asset_fields(),
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
        **_asset_fields(),
        "provenance": {
            "source_kind": _PLAN_SOURCE_KIND,
            "source_ref": f"archive:{archive_id}",
            "producer": PRODUCER,
            "producer_version": producer_version,
            "created_at": created_at,
        },
    }


# ---------------------------------------------------------------------------
# 计划产物候选：plan-evidence-input.json 直采（06B-4，2026-09-17 冻结映射表）
#
# 真相源是随变更目录整树归档的 meta/plan-evidence-input.json（CLI
# plan evidence-pack 的输入契约，packages/cli/src/commands/plan-evidence-pack.ts
# 的 EvidencePackInputFile）；渲染件 plans/*.md 归阶段 11 所有，本路径与其
# 结构变化解耦。
#
# 字段映射（聚焦测试 test_harness_knowledge_candidates.py 逐行锁定）：
#   requirement   structured_input.requirements[] 显式给出时直采（按
#                 behavior<invariant<failure_behavior、再按 requirement_id
#                 排序，与 CLI normalizeRequirements 一致）；键缺失时按
#                 CLI requirementsFrom 同一推导补齐：
#                 recommended_design→behavior、invariants[]→invariant、
#                 failure_behaviors[]→failure_behavior
#   goal          approval.content.goal ?? intent.goal；body 附
#                 user_visible_outcome（继承规则同 CLI completedApprovalContent）
#   risk          approval.content.risks[]（{risk, mitigation}）
#   invariant     approval.content.invariants[]（codepoint 排序）
#   tradeoff      approval.content.key_alternatives[]（排序）→ decision
#   compatibility approval.content.compatibility_boundaries[]（排序）→ api-contract
#   task          structured_input.tasks[]（{task_id, objective}）→ implementation
#   scenario      structured_input.scenarios[]（{scenario_id, title}）→ test-evidence
#
# 稳定性约定：candidate_id / content_hash 的输入（kind、summary、body、keywords）
# 与 md 反解析时代逐字节一致；source_refs 维持指向 plans/*.md 渲染件——core 包
# 包含性校验要求 source_refs 存在于包内，而 meta/* 不进 core 包
# （harness_archive._archive_core_file_specs）。已知差异（验收记录逐条登记）：
# 多行文本的 goal/task/scenario 旧候选 summary 残留渲染 <br> 字面量、markdown
# 特殊字符残留反斜杠转义（旧提取未 unescape 这三类），新候选为自然文本。
#
# hostile 输入语义：文件缺失 → 软失败 []；文件存在但 JSON 非法 / 顶层非对象 /
# 消费字段类型漂移 / 消费记录键集不符（缺键或意外键）→ ValueError 拒绝
# （harness_archive.write_knowledge_candidates 在合并处捕获 (OSError, ValueError)，
# 记 stderr warning、计划产物候选按空处理，summary 三源候选照常落盘，归档不中断）。
# 缺失可选分区（无 requirements 键、approval.content.goal 未给出等）→ 对应候选
# 为空，不报错。
#
# 旧 md 反解析路径（_markdown_sections / _goal_from_design / _requirements_from_design
# / _risks_from_design / _invariants_from_design / _tradeoffs_from_design /
# _compatibility_from_design / _tasks_from_plan / _scenarios_from_test_scenarios /
# _build_plan_candidates_from_markdown）保留为 dead code，仅作 06B-4 验收前的
# 回滚开关与旧版夹具对照，验收后删除。
# ---------------------------------------------------------------------------

_PLAN_EVIDENCE_INPUT_REL = Path("meta") / "plan-evidence-input.json"
_TASK_JSON_REL = Path("meta") / "task.json"

# 与 harness_task._generate_plan_md 的 T1 段逐字节一致（轻量任务流的唯一任务
# 候选锚点；两处必须同步修改）。
_TASK_FLOW_T1_OBJECTIVE = "完成变更并使验收条件全部通过。"

_REQUIREMENT_KINDS = ("behavior", "invariant", "failure_behavior")
_REQUIREMENT_KIND_ORDER = {
    kind: index for index, kind in enumerate(_REQUIREMENT_KINDS)
}
_REQUIREMENT_RECORD_ALLOWED_KEYS = (
    "requirement_id",
    "kind",
    "text",
    "evidence_refs",
    "approved_scope_refs",
)
_RISK_RECORD_KEYS = ("risk", "mitigation")
_TASK_RECORD_ALLOWED_KEYS = ("task_id", "objective", "affected_paths", "owner_phase")
_SCENARIO_RECORD_ALLOWED_KEYS = (
    "scenario_id",
    "title",
    "acceptance",
    "coverage_dimension",
    "execution_level",
    "evidence_requirements",
    "risk_level",
    "priority",
    "owner_phase",
    "applicability",
    "acceptance_default",
)


def _pei_reject(field_path: str, reason: str) -> None:
    """拒绝从 hostile plan-evidence-input.json 直采（调用方按软失败处理）。"""
    raise ValueError(f"meta/plan-evidence-input.json 拒绝直采：{field_path} {reason}")


def _pei_object(value: Any, field_path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        _pei_reject(field_path, "必须是对象")
    return value


def _pei_section(record: dict[str, Any], key: str, field_path: str) -> dict[str, Any]:
    """可选对象分区：缺失/为 null → {}；存在但非对象 → 拒绝。"""
    if record.get(key) is None:
        return {}
    return _pei_object(record[key], f"{field_path}.{key}")


def _pei_text(record: dict[str, Any], key: str, field_path: str) -> str | None:
    """字符串字段：缺失/为 null → None；存在但非字符串 → 拒绝。返回 strip 后文本。"""
    if record.get(key) is None:
        return None
    value = record[key]
    if not isinstance(value, str):
        _pei_reject(f"{field_path}.{key}", "必须是字符串")
    return value.strip()


def _pei_text_list(record: dict[str, Any], key: str, field_path: str) -> list[str]:
    """字符串数组字段：缺失/为 null → []；非数组或元素非字符串 → 拒绝。"""
    if record.get(key) is None:
        return []
    value = record[key]
    if not isinstance(value, list):
        _pei_reject(f"{field_path}.{key}", "必须是数组")
    for index, item in enumerate(value):
        if not isinstance(item, str):
            _pei_reject(f"{field_path}.{key}[{index}]", "必须是字符串")
    return value


def _pei_record_keys(
    record: dict[str, Any],
    field_path: str,
    required: tuple[str, ...],
    allowed: tuple[str, ...],
) -> None:
    present = set(record)
    missing = [key for key in required if key not in present]
    if missing:
        _pei_reject(field_path, f"缺少键 {', '.join(missing)}")
    extra = sorted(present - set(allowed))
    if extra:
        _pei_reject(field_path, f"意外键 {', '.join(extra)}")


def _pei_records(
    record: dict[str, Any],
    key: str,
    field_path: str,
    required: tuple[str, ...],
    allowed: tuple[str, ...],
) -> list[dict[str, Any]]:
    """记录数组字段：缺失/为 null → []；存在则逐条校验对象与键集。"""
    if record.get(key) is None:
        return []
    value = record[key]
    if not isinstance(value, list):
        _pei_reject(f"{field_path}.{key}", "必须是数组")
    records: list[dict[str, Any]] = []
    for index, item in enumerate(value):
        item_path = f"{field_path}.{key}[{index}]"
        item_object = _pei_object(item, item_path)
        _pei_record_keys(item_object, item_path, required, allowed)
        records.append(item_object)
    return records


def _pei_approval_content(payload: dict[str, Any]) -> dict[str, Any]:
    approval = _pei_section(payload, "approval", "$")
    return _pei_section(approval, "content", "$.approval")


def _pei_goal_and_outcome(payload: dict[str, Any]) -> tuple[str, str]:
    """goal/user_visible_outcome：approval.content 优先，缺失回退 intent（同 CLI）。"""
    intent = _pei_section(payload, "intent", "$")
    content = _pei_approval_content(payload)
    goal = _pei_text(content, "goal", "$.approval.content") or (
        _pei_text(intent, "goal", "$.intent") or ""
    )
    outcome = _pei_text(content, "user_visible_outcome", "$.approval.content") or (
        _pei_text(intent, "user_visible_outcome", "$.intent") or ""
    )
    return goal, outcome


def _pei_requirement_pairs(payload: dict[str, Any]) -> list[tuple[str, str]]:
    """返回 (requirement kind, text) 列表；显式缺失时按 requirementsFrom 推导。"""
    structured = _pei_section(payload, "structured_input", "$")
    explicit = structured.get("requirements")
    if explicit is not None:
        records = _pei_records(
            structured,
            "requirements",
            "$.structured_input",
            ("requirement_id", "kind", "text"),
            _REQUIREMENT_RECORD_ALLOWED_KEYS,
        )
        pairs: list[tuple[str, str, str]] = []
        for index, record in enumerate(records):
            item_path = f"$.structured_input.requirements[{index}]"
            requirement_id = _pei_text(record, "requirement_id", item_path) or ""
            kind = _pei_text(record, "kind", item_path) or ""
            if kind not in _REQUIREMENT_KIND_ORDER:
                _pei_reject(
                    f"{item_path}.kind",
                    f"必须是 {'/'.join(_REQUIREMENT_KINDS)}",
                )
            text = _pei_text(record, "text", item_path) or ""
            _pei_text_list(record, "evidence_refs", item_path)
            _pei_text_list(record, "approved_scope_refs", item_path)
            if text:
                pairs.append((kind, requirement_id, text))
        pairs.sort(key=lambda item: (_REQUIREMENT_KIND_ORDER[item[0]], item[1]))
        return [(kind, text) for kind, _, text in pairs]

    content = _pei_approval_content(payload)
    derived: list[tuple[str, str]] = []
    recommended = _pei_text(content, "recommended_design", "$.approval.content")
    if recommended:
        derived.append(("behavior", recommended))
    for text in sorted(_pei_text_list(content, "invariants", "$.approval.content")):
        if text.strip():
            derived.append(("invariant", text.strip()))
    for text in sorted(_pei_text_list(content, "failure_behaviors", "$.approval.content")):
        if text.strip():
            derived.append(("failure_behavior", text.strip()))
    return derived


def _pei_sorted_content_list(payload: dict[str, Any], key: str) -> list[str]:
    """approval.content 的字符串数组：strip、去空与 None. 哨兵、codepoint 排序。"""
    content = _pei_approval_content(payload)
    return sorted(
        item.strip()
        for item in _pei_text_list(content, key, "$.approval.content")
        if item.strip() and item.strip() != "None."
    )


def _goal_candidates_pei(
    payload: dict[str, Any],
    *,
    change_key: str,
    archive_id: str,
    producer_version: str,
    created_at: str,
) -> list[dict[str, Any]]:
    goal, outcome = _pei_goal_and_outcome(payload)
    if not goal:
        return []
    body = f"目标：{goal}"
    if outcome:
        body += f"\n用户可见结果：{outcome}"
    return [_plan_candidate(
        change_key=change_key,
        archive_id=archive_id,
        producer_version=producer_version,
        created_at=created_at,
        kind="requirement",
        entry_type="requirement",
        summary=goal,
        body=body,
        keywords=_keywords("目标", "goal", "requirement"),
        source_refs=_plan_source_refs(change_key, f"plans/{change_key}-design.md"),
    )]


def _requirement_candidates_pei(
    payload: dict[str, Any],
    *,
    change_key: str,
    archive_id: str,
    producer_version: str,
    created_at: str,
) -> list[dict[str, Any]]:
    return [
        _plan_candidate(
            change_key=change_key,
            archive_id=archive_id,
            producer_version=producer_version,
            created_at=created_at,
            kind="requirement",
            entry_type="requirement",
            summary=text,
            body=f"需求类型：{kind}\n{text}",
            keywords=_keywords(kind, "requirement"),
            source_refs=_plan_source_refs(change_key, f"plans/{change_key}-design.md"),
        )
        for kind, text in _pei_requirement_pairs(payload)
    ]


def _risk_candidates_pei(
    payload: dict[str, Any],
    *,
    change_key: str,
    archive_id: str,
    producer_version: str,
    created_at: str,
) -> list[dict[str, Any]]:
    content = _pei_approval_content(payload)
    records = _pei_records(
        content, "risks", "$.approval.content", _RISK_RECORD_KEYS, _RISK_RECORD_KEYS
    )
    out: list[dict[str, Any]] = []
    for index, record in enumerate(records):
        item_path = f"$.approval.content.risks[{index}]"
        risk = _pei_text(record, "risk", item_path) or ""
        mitigation = _pei_text(record, "mitigation", item_path) or ""
        if not risk or risk == "None.":
            continue
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
    return out


def _invariant_candidates_pei(
    payload: dict[str, Any],
    *,
    change_key: str,
    archive_id: str,
    producer_version: str,
    created_at: str,
) -> list[dict[str, Any]]:
    return [
        _plan_candidate(
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
        )
        for text in _pei_sorted_content_list(payload, "invariants")
    ]


def _tradeoff_candidates_pei(
    payload: dict[str, Any],
    *,
    change_key: str,
    archive_id: str,
    producer_version: str,
    created_at: str,
) -> list[dict[str, Any]]:
    return [
        _plan_candidate(
            change_key=change_key,
            archive_id=archive_id,
            producer_version=producer_version,
            created_at=created_at,
            kind="decision",
            entry_type="decision",
            summary=text,
            body=f"取舍：{text}",
            keywords=_keywords("tradeoff", "decision", "取舍"),
            source_refs=_plan_source_refs(change_key, f"plans/{change_key}-design.md"),
        )
        for text in _pei_sorted_content_list(payload, "key_alternatives")
    ]


def _compatibility_candidates_pei(
    payload: dict[str, Any],
    *,
    change_key: str,
    archive_id: str,
    producer_version: str,
    created_at: str,
) -> list[dict[str, Any]]:
    return [
        _plan_candidate(
            change_key=change_key,
            archive_id=archive_id,
            producer_version=producer_version,
            created_at=created_at,
            kind="compatibility",
            entry_type="api-contract",
            summary=text,
            body=f"兼容边界：{text}",
            keywords=_keywords("compatibility", "api-contract", "兼容"),
            source_refs=_plan_source_refs(change_key, f"plans/{change_key}-design.md"),
        )
        for text in _pei_sorted_content_list(payload, "compatibility_boundaries")
    ]


def _task_candidates_pei(
    payload: dict[str, Any],
    *,
    change_key: str,
    archive_id: str,
    producer_version: str,
    created_at: str,
) -> list[dict[str, Any]]:
    structured = _pei_section(payload, "structured_input", "$")
    records = _pei_records(
        structured,
        "tasks",
        "$.structured_input",
        ("task_id", "objective"),
        _TASK_RECORD_ALLOWED_KEYS,
    )
    out: list[dict[str, Any]] = []
    for index, record in enumerate(records):
        item_path = f"$.structured_input.tasks[{index}]"
        task_id = _pei_text(record, "task_id", item_path) or ""
        objective = _pei_text(record, "objective", item_path) or ""
        _pei_text_list(record, "affected_paths", item_path)
        owner_phase = record.get("owner_phase")
        if owner_phase is not None and not isinstance(owner_phase, str):
            _pei_reject(f"{item_path}.owner_phase", "必须是字符串")
        if not task_id or not objective:
            continue
        out.append(_plan_candidate(
            change_key=change_key,
            archive_id=archive_id,
            producer_version=producer_version,
            created_at=created_at,
            kind="task",
            entry_type="implementation",
            summary=objective,
            body=f"任务：{task_id}\n{objective}",
            keywords=_keywords(task_id, "implementation"),
            source_refs=_plan_source_refs(change_key, f"plans/{change_key}-plan.md"),
        ))
    return out


def _scenario_candidates_pei(
    payload: dict[str, Any],
    *,
    change_key: str,
    archive_id: str,
    producer_version: str,
    created_at: str,
    scenarios_rel: str,
) -> list[dict[str, Any]]:
    structured = _pei_section(payload, "structured_input", "$")
    records = _pei_records(
        structured,
        "scenarios",
        "$.structured_input",
        ("scenario_id", "title"),
        _SCENARIO_RECORD_ALLOWED_KEYS,
    )
    out: list[dict[str, Any]] = []
    for index, record in enumerate(records):
        item_path = f"$.structured_input.scenarios[{index}]"
        scenario_id = _pei_text(record, "scenario_id", item_path) or ""
        title = _pei_text(record, "title", item_path) or ""
        if not scenario_id or not title:
            continue
        out.append(_plan_candidate(
            change_key=change_key,
            archive_id=archive_id,
            producer_version=producer_version,
            created_at=created_at,
            kind="scenario",
            entry_type="test-evidence",
            summary=title,
            body=f"场景：{scenario_id}\n{title}",
            keywords=_keywords(scenario_id, "test-evidence"),
            source_refs=_plan_source_refs(change_key, scenarios_rel),
        ))
    return out


def _task_flow_candidates(
    archive_dir: Path,
    *,
    change_key: str,
    archive_id: str,
    producer_version: str,
    created_at: str,
) -> list[dict[str, Any]]:
    """轻量任务流回退：meta/task.json 存在即产出与 plan.md T1 段等价的单条候选。"""
    task_path = archive_dir / _TASK_JSON_REL
    try:
        payload = json.loads(task_path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"meta/task.json 拒绝直采：读取失败（{exc}）") from exc
    if not isinstance(payload, dict):
        raise ValueError("meta/task.json 拒绝直采：顶层必须是对象")
    return [_plan_candidate(
        change_key=change_key,
        archive_id=archive_id,
        producer_version=producer_version,
        created_at=created_at,
        kind="task",
        entry_type="implementation",
        summary=_TASK_FLOW_T1_OBJECTIVE,
        body=f"任务：T1\n{_TASK_FLOW_T1_OBJECTIVE}",
        keywords=_keywords("T1", "implementation"),
        source_refs=_plan_source_refs(change_key, f"plans/{change_key}-plan.md"),
    )]


def _load_plan_evidence_input(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"meta/plan-evidence-input.json 拒绝直采：读取失败（{exc}）") from exc
    return _pei_object(payload, "$")


def build_plan_candidates(
    archive_dir,
    *,
    change_key: str,
    archive_id: str,
    producer_version: str,
    created_at: str,
) -> list[dict[str, Any]]:
    """从 meta/plan-evidence-input.json 直采计划产物候选（映射表见上方注释）。

    轻量任务流（无 plan-evidence-input.json、有 meta/task.json）回退产出
    T1 任务候选；两者皆无返回 []（软失败）；hostile 输入抛 ValueError（拒绝）。
    """
    archive_root = Path(archive_dir)
    candidates: list[dict[str, Any]] = []
    seen_ids: set[str] = set()

    def collect(items: list[dict[str, Any]]) -> None:
        for candidate in items:
            if candidate["candidate_id"] in seen_ids:
                continue
            seen_ids.add(candidate["candidate_id"])
            candidates.append(candidate)

    if (archive_root / _PLAN_EVIDENCE_INPUT_REL).is_file():
        payload = _load_plan_evidence_input(archive_root / _PLAN_EVIDENCE_INPUT_REL)
        kwargs = {
            "change_key": change_key,
            "archive_id": archive_id,
            "producer_version": producer_version,
            "created_at": created_at,
        }
        # 提取顺序与旧 md 路径一致（requirements → goal → risks → invariants
        # → tradeoffs → compatibility → tasks → scenarios），保证候选数组顺序
        # 与 candidate_id 去重优先级逐字节兼容。
        # 阶段 11 两件套：场景节并入 plan.md（`# Test Scenarios`），旧四件套归档
        # 仍为独立 test-scenarios.md。source_refs 受 core 包包含性校验约束，
        # 必须指向包内真实存在的 plans/*.md 渲染件。
        scenarios_rel = f"plans/{change_key}-test-scenarios.md"
        if not (archive_root / scenarios_rel).is_file():
            scenarios_rel = f"plans/{change_key}-plan.md"
        collect(_requirement_candidates_pei(payload, **kwargs))
        collect(_goal_candidates_pei(payload, **kwargs))
        collect(_risk_candidates_pei(payload, **kwargs))
        collect(_invariant_candidates_pei(payload, **kwargs))
        collect(_tradeoff_candidates_pei(payload, **kwargs))
        collect(_compatibility_candidates_pei(payload, **kwargs))
        collect(_task_candidates_pei(payload, **kwargs))
        collect(_scenario_candidates_pei(payload, scenarios_rel=scenarios_rel, **kwargs))
        return candidates

    if (archive_root / _TASK_JSON_REL).is_file():
        collect(_task_flow_candidates(
            archive_root,
            change_key=change_key,
            archive_id=archive_id,
            producer_version=producer_version,
            created_at=created_at,
        ))
    return candidates


def _goal_from_design(
    design_text: str,
    *,
    change_key: str,
    archive_id: str,
    producer_version: str,
    created_at: str,
) -> dict[str, Any] | None:
    """Extract ``## Goal`` + ``## User-visible outcome`` as a requirement candidate.

    变更的意图（目标/用户可见结果）是自然语言检索最重要的知识：场景、风险与
    不变量来自验收与评审，但「这个变更做了什么、解决什么」只写在 Goal。若不
    沉淀，用户按变更意图检索（如「问候语模块」）会查不到——2026-09 自测
    greeting-module 实测复现。
    """
    sections = _markdown_sections(design_text)
    goal_lines = [line.strip() for line in sections.get("Goal", []) if line.strip()]
    if not goal_lines:
        return None
    summary = " ".join(goal_lines)
    outcome_lines = [
        line.strip() for line in sections.get("User-visible outcome", []) if line.strip()
    ]
    body = f"目标：{summary}"
    if outcome_lines:
        body += "\n用户可见结果：" + " ".join(outcome_lines)
    return _plan_candidate(
        change_key=change_key,
        archive_id=archive_id,
        producer_version=producer_version,
        created_at=created_at,
        kind="requirement",
        entry_type="requirement",
        summary=summary,
        body=body,
        keywords=_keywords("目标", "goal", "requirement"),
        source_refs=_plan_source_refs(change_key, f"plans/{change_key}-design.md"),
    )


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


def _tradeoffs_from_design(
    design_text: str,
    *,
    change_key: str,
    archive_id: str,
    producer_version: str,
    created_at: str,
) -> list[dict[str, Any]]:
    """Parse ``## Tradeoffs`` bullet list into decision candidates.

    被否决的备选方案及其理由是下一次决策最需要的知识（2026-09 审查报告
    「design 更有意义，但不能整份照搬」第 1 条：如「否决独立
    /opsx-quick-simple，因为会制造第二入口」）。
    """
    sections = _markdown_sections(design_text)
    out: list[dict[str, Any]] = []
    for line in sections.get("Tradeoffs", []):
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
            kind="decision",
            entry_type="decision",
            summary=text,
            body=f"取舍：{text}",
            keywords=_keywords("tradeoff", "decision", "取舍"),
            source_refs=_plan_source_refs(change_key, f"plans/{change_key}-design.md"),
        ))
    return out


def _compatibility_from_design(
    design_text: str,
    *,
    change_key: str,
    archive_id: str,
    producer_version: str,
    created_at: str,
) -> list[dict[str, Any]]:
    """Parse ``## Compatibility boundaries`` bullet list into api-contract candidates.

    审查报告同节第 3 条：兼容边界（如「旧 proposal 没有 auto-scale 字段时
    不受影响」）决定升级与回滚的判断，是孤立风险条目替代不了的知识。
    """
    sections = _markdown_sections(design_text)
    out: list[dict[str, Any]] = []
    for line in sections.get("Compatibility boundaries", []):
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
            kind="compatibility",
            entry_type="api-contract",
            summary=text,
            body=f"兼容边界：{text}",
            keywords=_keywords("compatibility", "api-contract", "兼容"),
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


def _build_plan_candidates_from_markdown(
    archive_dir,
    *,
    change_key: str,
    archive_id: str,
    producer_version: str,
    created_at: str,
) -> list[dict[str, Any]]:
    """DEAD CODE（06B-4 回滚开关，验收后删除）：旧 plans/*.md 反解析路径。

    新归档一律走 build_plan_candidates 的 meta/plan-evidence-input.json 直采；
    本函数仅为回滚恢复与旧版夹具对照保留，生产路径不再调用。
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
        goal = _goal_from_design(
            design_text,
            change_key=change_key,
            archive_id=archive_id,
            producer_version=producer_version,
            created_at=created_at,
        )
        if goal is not None:
            collect([goal])
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
        collect(_tradeoffs_from_design(
            design_text,
            change_key=change_key,
            archive_id=archive_id,
            producer_version=producer_version,
            created_at=created_at,
        ))
        collect(_compatibility_from_design(
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
