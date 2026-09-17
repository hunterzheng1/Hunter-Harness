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
    dimension: str, path: str, line: int, title: str
) -> str:
    """Stable finding identity (dimension + canonical path + line + title).

    WI-3.1：id 不含 runId——同一问题跨轮 review 保持同一 id，
    携带（carry-over）与处置继承才有可比对的身份。轮次信息降为
    finding 字段（firstSeenRunId / lastSeenRunId）。
    """
    canonical_path = str(path).replace("\\", "/").strip("/").lower()
    basis = (
        f"{dimension.strip().lower()}|{canonical_path}|{int(line)}|"
        f"{_normalize_title(title)}"
    )
    return "f-" + hashlib.sha256(basis.encode("utf-8")).hexdigest()[:16]


ANCHOR_CONTEXT_RADIUS = 2


def _load_carryover_receipt(change_dir: Path) -> dict[str, Any] | None:
    """读最近的评审携带回执（fixback 批次判定产物）；无/损坏返回 None。"""
    base = (
        Path(harness_paths.resolve_state_dir_for_contract(change_dir))
        / "runtime"
        / "invalidations"
    )
    if not base.is_dir():
        return None
    receipts = sorted(base.glob("review-carryover-*.json"))
    if not receipts:
        return None
    try:
        data = json.loads(receipts[-1].read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def compute_finding_anchor(repo_root: Path, path: Any, line: Any) -> dict[str, Any]:
    """WI-3.1 锚点：finding 行 ±2 行规范化文本（去行尾空白）的 sha256。

    锚点是携带判定的安全网：文件不在 changedFiles 里却被改动（声明不全）
    时，contextHash 漂移会把 finding 打回 invalidated。文件缺失、目录
    路径、行号越界或行 0（文件级 finding）一律 unresolvable——下游对
    unresolvable 的语义是 fail-closed（放大失效，不携带）。
    """
    rel = str(path).replace("\\", "/").strip("/") if isinstance(path, str) else ""
    anchor: dict[str, Any] = {
        "path": rel,
        "contextHash": None,
        "unresolvable": False,
    }
    line_no = line if isinstance(line, int) else -1
    if not rel or rel.endswith("/") or line_no < 1:
        anchor["unresolvable"] = True
        return anchor
    target = Path(repo_root) / rel
    try:
        if not target.is_file():
            raise OSError("not a file")
        lines = target.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        anchor["unresolvable"] = True
        return anchor
    if line_no > len(lines):
        anchor["unresolvable"] = True
        return anchor
    lo = max(1, line_no - ANCHOR_CONTEXT_RADIUS)
    hi = min(len(lines), line_no + ANCHOR_CONTEXT_RADIUS)
    window = [re.sub(r"\s+$", "", text) for text in lines[lo - 1 : hi]]
    basis = rel + "\n" + "\n".join(window)
    anchor["contextHash"] = (
        "sha256:" + hashlib.sha256(basis.encode("utf-8")).hexdigest()
    )
    return anchor


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


def write_findings(
    change_dir: Path,
    doc: dict[str, Any],
    *,
    diff_mode: str | None = None,
) -> dict[str, Any]:
    # B2-6：缺 runId 时自动取当前 review run（events 里最近一轮 phase.start），
    # 不再让调用方为拿 runId 被迫读 events 原文。显式给出的 runId 始终优先。
    auto_filled_run_id = False
    if not isinstance(doc.get("runId"), str) or not doc["runId"].strip():
        current = _latest_review_run_id(change_dir)
        if current is not None:
            doc = {**doc, "runId": current}
            auto_filled_run_id = True
    problems = validate_findings(doc)
    if problems:
        result = {"ok": False, "code": "FINDINGS_INVALID", "problems": problems}
        current = _latest_review_run_id(change_dir)
        if current is not None:
            result["currentRunId"] = current
        return result
    run_id = doc["runId"]
    # WI-3.1：重写前读旧 sidecar——跨轮重现的问题保留 firstSeenRunId，
    # id 由 stable_finding_id 保证跨轮一致。v1 旧 sidecar 的 id 含 runId，
    # 与 v2 id 空间不重叠，自然全部视为新发现（不迁移历史文件）。
    previous = _load_findings(change_dir)
    first_seen_by_id: dict[str, str] = {}
    for old in (previous or {}).get("findings", []):
        if (
            isinstance(old, dict)
            and isinstance(old.get("id"), str)
            and isinstance(old.get("firstSeenRunId"), str)
            and old["firstSeenRunId"].strip()
        ):
            first_seen_by_id[old["id"]] = old["firstSeenRunId"]
    repo_root = Path(harness_paths.resolve_worktree_root(change_dir))
    assigned: list[dict[str, Any]] = []
    seen: set[str] = set()
    for finding in doc["findings"]:
        fid = stable_finding_id(
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
        entry["firstSeenRunId"] = first_seen_by_id.get(fid, run_id)
        entry["lastSeenRunId"] = run_id
        entry["anchors"] = compute_finding_anchor(
            repo_root, finding.get("path"), finding.get("line")
        )
        assigned.append(entry)
    # WI-3.1 步骤③：重评审轮（存在携带回执）时，回执判定为携带、但模型
    # 未重新上报的 finding 从上一轮 sidecar 合并回来。fail-closed 防丢失：
    # 携带项若静默消失，其处置也随之蒸发，关门校验会因缺处置而拒绝。
    carryover_receipt = _load_carryover_receipt(change_dir)
    if carryover_receipt is not None:
        previous_by_id = {
            str(old.get("id")): old
            for old in (previous or {}).get("findings", [])
            if isinstance(old, dict) and old.get("id")
        }
        for carried_id in carryover_receipt.get("carriedOverIds", []):
            if carried_id in seen or carried_id not in previous_by_id:
                continue
            merged = dict(previous_by_id[carried_id])
            merged["carriedOver"] = True
            merged["lastSeenRunId"] = merged.get("firstSeenRunId", run_id)
            assigned.append(merged)
            seen.add(carried_id)
    # WI-3.4：schemaVersion 3，顶层附 diffScope（被审内容身份：base/head/
    # diffHash/files/mode/capturedAt）。mode 显式声明（stdin diffMode 字段
    # 或 CLI --mode）优先，缺省自动推断（上轮有 diffScope → incremental）。
    mode_override = (
        doc.get("diffMode") if isinstance(doc.get("diffMode"), str) else diff_mode
    )
    payload = {
        "schemaVersion": 3,
        "runId": run_id,
        "changeName": doc.get("changeName") or Path(change_dir).name,
        "findings": assigned,
        "diffScope": _capture_diff_scope(change_dir, previous, mode_override),
    }
    # 目录路径的 finding 下游产不出可绑定的知识候选（source_refs 会拒整包），
    # 写入时提前可见——demo-datasource 的 quality/#L1 就是这么漏出去的
    directory_paths = [
        str(f.get("path"))
        for f in assigned
        if isinstance(f.get("path"), str) and f["path"].rstrip().endswith("/")
    ]
    out = findings_path(change_dir)
    _write_json_atomic(out, payload)
    result = {"ok": True, "code": "FINDINGS_WRITTEN", "path": str(out),
              "count": len(assigned)}
    if auto_filled_run_id:
        result["runIdAutoFilled"] = run_id
    if directory_paths:
        result["warnings"] = [
            "以下 finding 的 path 是目录而非文件，知识候选生成时会整条跳过"
            "（source_refs 无法绑定文件）：" + "; ".join(directory_paths) +
            "。请改为具体文件路径后重新写入"
        ]
    return result


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
    # WI-3.1 步骤③：携带项的处置自动继承上一轮（模型只处置新发现/失效重生）。
    # 继承条目标 inheritedFromRunId，关门校验（gate）会验签其必须属于携带回执。
    inherited: list[dict[str, Any]] = []
    submitted_ids = {
        item.get("findingId")
        for item in doc["dispositions"]
        if isinstance(item, dict)
    }
    carryover_receipt = _load_carryover_receipt(change_dir)
    if carryover_receipt is not None:
        previous: dict[str, Any] | None = None
        dpath = dispositions_path(change_dir)
        if dpath.is_file():
            try:
                loaded = _read_json(dpath)
                if isinstance(loaded, dict):
                    previous = loaded
            except (OSError, json.JSONDecodeError):
                previous = None
        prev_by_id = {
            item.get("findingId"): item
            for item in (previous or {}).get("dispositions", [])
            if isinstance(item, dict)
        }
        for carried_id in carryover_receipt.get("carriedOverIds", []):
            if carried_id in submitted_ids or carried_id not in prev_by_id:
                continue
            entry = dict(prev_by_id[carried_id])
            entry["inheritedFromRunId"] = (previous or {}).get("runId")
            inherited.append(entry)
    payload = {
        "schemaVersion": 1,
        "runId": doc["runId"],
        "dispositions": [*doc["dispositions"], *inherited],
    }
    out = dispositions_path(change_dir)
    _write_json_atomic(out, payload)
    return {"ok": True, "code": "DISPOSITIONS_WRITTEN", "path": str(out)}


# ---------------------------------------------------------------------------
# WI-3.4 增量评审：diff-scope 判定与 diffScope 捕获
#
# 评审输入从「整个 diff」收敛到「上次评审边界之后的增量 + 受影响上下文 +
# 既有未解决发现」。边界身份记录在 findings sidecar 顶层 diffScope
# （schemaVersion 3）；per-file 内容哈希是增量判定主键（diffHash 只做整体
# 校验）；扩大信号与 WI-1/detect_blast_radius 同源（risk-signals.json）。
# ---------------------------------------------------------------------------


def _now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).astimezone().isoformat(timespec="seconds")


def _git(repo_root: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=str(repo_root),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )


def _read_change_base(change_dir: Path) -> str | None:
    """best-effort 读 state-snapshot 的不可变 base（git.base → changeBase）。"""
    snapshot = Path(change_dir) / "meta" / "state-snapshot.json"
    try:
        doc = json.loads(snapshot.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(doc, dict):
        return None
    git_section = doc.get("git")
    if isinstance(git_section, dict):
        base = git_section.get("base")
        if isinstance(base, str) and base.strip():
            return base.strip()
    base = doc.get("changeBase")
    if isinstance(base, str) and base.strip():
        return base.strip()
    return None


def _current_change_set(
    repo_root: Path, base: str | None
) -> tuple[str, dict[str, str | None]]:
    """当前变更集（path → 工作区内容 sha256；None = 已删除）。

    变更集定义与 ledger diffHash 同源（_changed_paths：相对 base 的 tracked
    diff ∪ untracked，commit 无关）——checkpoint commit 不会冲掉内容身份。
    """
    import harness_ledger  # 延迟 import：大模块，仅本路径需要

    resolved_base, paths = harness_ledger._changed_paths(repo_root, base)
    files: dict[str, str | None] = {}
    for rel in paths:
        abs_path = Path(repo_root) / rel
        if abs_path.is_file():
            files[rel] = "sha256:" + hashlib.sha256(abs_path.read_bytes()).hexdigest()
        else:
            files[rel] = None
    return resolved_base, files


def _current_diff_hash(
    repo_root: Path, base: str | None, change_dir: Path
) -> str | None:
    import harness_ledger  # 延迟 import

    try:
        digest, _meta = harness_ledger.compute_diff_hash(repo_root, base, change_dir)
    except Exception:
        return None
    return digest if isinstance(digest, str) else None


def _current_head(repo_root: Path) -> str | None:
    proc = _git(repo_root, "rev-parse", "HEAD")
    if proc.returncode != 0:
        return None
    head = proc.stdout.strip()
    return head or None


def _head_resolvable(repo_root: Path, head: str) -> bool:
    proc = _git(repo_root, "rev-parse", "--verify", "--quiet", f"{head}^{{commit}}")
    return proc.returncode == 0


def _expansion_signals(paths: list[str]) -> list[str]:
    """变更路径命中 risk-signals 扩大信号 → 信号名清单（回退全量依据）。

    与 WI-1 classify / WI-3.1 detect_blast_radius 同一数据源
    （harness/contracts/risk-signals.json）：fullMarkers 子串命中（信号语义
    与 classify_risk 一致）∪ contractSchemaPaths 精确命中（contract-schema）。
    """
    import harness_gate as hg  # 延迟 import：避免与 harness_fixback 的 import 环

    normalized = [str(p).replace("\\", "/").lower() for p in paths if str(p).strip()]
    if not normalized:
        return []
    contract = hg._load_risk_signals_contract()
    hits: set[str] = set()
    for signal, markers in contract["fullMarkers"].items():
        for marker in markers:
            token = str(marker).lower()
            if any(token in path for path in normalized):
                hits.add(signal)
                break
    schema_paths = {
        str(p).replace("\\", "/").lower()
        for p in contract.get("contractSchemaPaths", [])
    }
    if any(path in schema_paths for path in normalized):
        hits.add("contract-schema")
    return sorted(hits)


_CONTEXT_FILE_CAP = 20


def _context_files(
    repo_root: Path, incremental: list[str]
) -> tuple[list[str], str | None]:
    """受影响上下文的保守圈定：增量源文件配对的测试文件。

    不建依赖图（依赖图缺失时保守是 O2 允许的）；超阈值截断并给 note，
    不伪造完整性，也不因此回退 full（上下文是加分项不是门禁）。
    """
    tests_root = Path(repo_root) / "tests"
    stems = {
        Path(p).stem
        for p in incremental
        if Path(p).stem and not Path(p).stem.startswith("test_")
    }
    found: set[str] = set()
    if stems and tests_root.is_dir():
        for stem in sorted(stems):
            for candidate in sorted(tests_root.rglob(f"test_{stem}.py")):
                found.add(
                    candidate.relative_to(repo_root).as_posix()
                )
    note = None
    out = sorted(found)
    if len(out) > _CONTEXT_FILE_CAP:
        out = out[:_CONTEXT_FILE_CAP]
        note = f"受影响上下文超阈值（>{_CONTEXT_FILE_CAP}），已截断——如需完整上下文请人工补充"
    return out, note


def _open_findings(change_dir: Path) -> list[dict[str, Any]]:
    current = status(change_dir)
    risks = current.get("currentRisks")
    return list(risks) if isinstance(risks, list) else []


def _diff_scope_result(
    change_dir: Path,
    *,
    mode: str,
    reason: str | None,
    change_base: str | None,
    current_files: dict[str, str | None],
    previous: dict[str, Any] | None,
    incremental: list[str] | None = None,
    context: list[str] | None = None,
    context_note: str | None = None,
) -> dict[str, Any]:
    prev_scope = (previous or {}).get("diffScope") if isinstance(previous, dict) else None
    previous_review = None
    if isinstance(prev_scope, dict):
        previous_review = {
            "runId": (previous or {}).get("runId"),
            "diffHash": prev_scope.get("diffHash"),
            "capturedAt": prev_scope.get("capturedAt"),
        }
    result: dict[str, Any] = {
        "ok": True,
        "code": "REVIEW_DIFF_SCOPE",
        "mode": mode,
        "reason": reason,
        "changeBase": change_base,
        "previousReview": previous_review,
        "openFindings": _open_findings(change_dir),
    }
    if mode == "incremental":
        result["incrementalFiles"] = list(incremental or [])
        result["contextFiles"] = list(context or [])
        if context_note:
            result["contextNote"] = context_note
    else:
        result["fullFiles"] = sorted(current_files)
    return result


def diff_scope(change_dir: Path) -> dict[str, Any]:
    """WI-3.4：判定本轮评审输入是增量还是全量。

    fail-closed 回退全量：无上一轮边界 / 上轮 head 不可解析 / 增量命中
    扩大信号 / per-file 无差异但整体 diffHash 不一致（UNEXPLAINED_DRIFT）/
    变更集计算出错（DIFF_ERROR）。
    """
    change_dir = Path(change_dir)
    repo_root = Path(harness_paths.resolve_worktree_root(change_dir))
    base = _read_change_base(change_dir)
    try:
        resolved_base, current_files = _current_change_set(repo_root, base)
        diff_hash = _current_diff_hash(repo_root, resolved_base, change_dir)
    except Exception as exc:
        return _diff_scope_result(
            change_dir,
            mode="full",
            reason="DIFF_ERROR",
            change_base=base,
            current_files={},
            previous=None,
            context_note=f"变更集计算失败: {exc}",
        )
    previous = _load_findings(change_dir)
    prev_scope = (previous or {}).get("diffScope") if isinstance(previous, dict) else None
    prev_files = prev_scope.get("files") if isinstance(prev_scope, dict) else None
    if not isinstance(prev_files, dict):
        return _diff_scope_result(
            change_dir,
            mode="full",
            reason="NO_PREVIOUS_SCOPE",
            change_base=resolved_base,
            current_files=current_files,
            previous=previous,
        )
    prev_head = prev_scope.get("head")
    if (
        isinstance(prev_head, str)
        and prev_head.strip()
        and not _head_resolvable(repo_root, prev_head)
    ):
        return _diff_scope_result(
            change_dir,
            mode="full",
            reason="HEAD_UNRESOLVABLE",
            change_base=resolved_base,
            current_files=current_files,
            previous=previous,
        )
    # 新出现/内容变化/删除（digest=None）都算增量；还原的文件自然退出
    # 变更集不在 current_files，无需审。注意「删除」的 digest 是 None，
    # 不能用 prev_files.get(path) != digest（None == None 会漏掉删除）。
    incremental = sorted(
        path for path, digest in current_files.items()
        if path not in prev_files or prev_files[path] != digest
    )
    if not incremental and diff_hash is not None and diff_hash != prev_scope.get("diffHash"):
        return _diff_scope_result(
            change_dir,
            mode="full",
            reason="UNEXPLAINED_DRIFT",
            change_base=resolved_base,
            current_files=current_files,
            previous=previous,
        )
    signals = _expansion_signals(incremental) if incremental else []
    if signals:
        return _diff_scope_result(
            change_dir,
            mode="full",
            reason=f"EXPANDED_SIGNALS:{','.join(signals)}",
            change_base=resolved_base,
            current_files=current_files,
            previous=previous,
        )
    context, context_note = _context_files(repo_root, incremental)
    return _diff_scope_result(
        change_dir,
        mode="incremental",
        reason=None,
        change_base=resolved_base,
        current_files=current_files,
        previous=previous,
        incremental=incremental,
        context=context,
        context_note=context_note,
    )


def _capture_diff_scope(
    change_dir: Path,
    previous: dict[str, Any] | None,
    mode_override: str | None,
) -> dict[str, Any]:
    """write_findings 落盘时捕获被审内容身份（best-effort，失败不阻塞写入）。

    mode：显式声明（stdin diffMode 字段 / CLI --mode）优先；缺省自动推断
    ——上一轮 sidecar 有 diffScope 即 incremental，否则 full。
    """
    repo_root = Path(harness_paths.resolve_worktree_root(change_dir))
    base = _read_change_base(change_dir)
    files: dict[str, str | None] = {}
    resolved_base = base
    diff_hash = None
    try:
        resolved_base, files = _current_change_set(repo_root, base)
        diff_hash = _current_diff_hash(repo_root, resolved_base, change_dir)
    except Exception:
        pass
    prev_scope = (previous or {}).get("diffScope") if isinstance(previous, dict) else None
    if mode_override in ("full", "incremental"):
        mode = mode_override
    else:
        mode = "incremental" if isinstance(prev_scope, dict) else "full"
    return {
        "base": resolved_base,
        "head": _current_head(repo_root),
        "diffHash": diff_hash,
        "files": files,
        "mode": mode,
        "capturedAt": _now_iso(),
    }


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
        # 15-M4：scenario→finding→fixback 三链闭环视图（只读 join，零 schema 变更）
        "scenarioChain": _scenario_chain(change_dir, items),
    }


def _scenario_chain(
    change_dir: Path, items: list[dict[str, Any]]
) -> dict[str, Any]:
    """scenario→finding→fixback 三链 join（15-M4，只读派生视图）。

    - scenario 源：`meta/scenario-manifest.json`（v2 包装与 legacy 平铺兼容，
      复用 harness_plan_finalize.unpack_v2_scenario_manifest）；缺失时降级
      为 findings×dispositions 视图（available=False），不报错。
    - finding 关联：finding.scenarioRefs（可选声明字段）优先；否则按
      finding.path 与 scenario 的 paths/files/testFile 启发式反挂，
      标注 linkage=heuristic。
    - fixback 关联：batch.issues[].issueId == finding.id（issue 创建时即从
      finding id 透传，见 harness_fixback.open_review_batch）。
    """
    manifest_path = change_dir / "meta" / "scenario-manifest.json"
    if not manifest_path.is_file():
        return {
            "available": False,
            "reason": "scenario-manifest-missing",
            "note": "降级为 findings×dispositions 视图",
        }
    try:
        manifest = _read_json(manifest_path)
    except (OSError, json.JSONDecodeError) as exc:
        return {
            "available": False,
            "reason": "scenario-manifest-invalid",
            "note": f"manifest unreadable: {exc}",
        }
    if isinstance(manifest, dict) and isinstance(manifest.get("content"), dict):
        # v2 包装形态（schemaId/content）：content.scenarios
        manifest = manifest["content"]
    scenarios = manifest.get("scenarios") if isinstance(manifest, dict) else None
    if not isinstance(scenarios, list):
        return {
            "available": False,
            "reason": "scenario-manifest-invalid",
            "note": "scenarios must be a list",
        }

    state_dir = _state_dir(change_dir)
    # fixback 批次索引：issueId → batch/issue 状态
    issue_index: dict[str, dict[str, Any]] = {}
    fixback_dir = state_dir / "fixback" / "batches"
    if fixback_dir.is_dir():
        for batch_path in sorted(fixback_dir.glob("*.json")):
            try:
                batch = _read_json(batch_path)
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(batch, dict):
                continue
            for issue in batch.get("issues") or []:
                if not isinstance(issue, dict):
                    continue
                issue_id = str(issue.get("issueId") or "")
                if issue_id and issue_id not in issue_index:
                    issue_index[issue_id] = {
                        "batchId": str(batch.get("batchId") or batch_path.stem),
                        "batchStatus": batch.get("status"),
                        "issueStatus": issue.get("status"),
                    }

    # findings 的 scenarioRefs 需要原始文档（items 视图未携带）
    findings_raw: dict[str, dict[str, Any]] = {}
    fpath = findings_path(change_dir)
    if fpath.is_file():
        try:
            fdoc = _read_json(fpath)
        except (OSError, json.JSONDecodeError):
            fdoc = {}
        if isinstance(fdoc, dict):
            for raw in fdoc.get("findings") or []:
                if isinstance(raw, dict) and raw.get("id"):
                    findings_raw[str(raw["id"])] = raw

    def _finding_view(item: dict[str, Any], linkage: str) -> dict[str, Any]:
        fid = str(item.get("id") or "")
        return {
            "id": fid,
            "severity": item.get("severity"),
            "title": item.get("title"),
            "path": item.get("path"),
            "linkage": linkage,
            "disposition": item.get("disposition"),
            "fixback": issue_index.get(fid),
        }

    linked_ids: set[str] = set()
    scenarios_view: list[dict[str, Any]] = []
    for scenario in scenarios:
        if not isinstance(scenario, dict):
            continue
        sid = str(scenario.get("id") or "").strip()
        scenario_paths: set[str] = set()
        for key in ("paths", "files", "relatedFiles"):
            value = scenario.get(key)
            if isinstance(value, list):
                scenario_paths.update(
                    str(p).replace("\\", "/") for p in value if str(p).strip()
                )
        test_file = str(scenario.get("testFile") or "").strip()
        if test_file:
            scenario_paths.add(test_file.replace("\\", "/"))

        scenario_findings: list[dict[str, Any]] = []
        for item in items:
            fid = str(item.get("id") or "")
            raw = findings_raw.get(fid) or {}
            refs = raw.get("scenarioRefs")
            if isinstance(refs, list) and sid in {str(r) for r in refs}:
                scenario_findings.append(_finding_view(item, "declared"))
                linked_ids.add(fid)
                continue
            fpath_str = str(item.get("path") or "").replace("\\", "/")
            if fpath_str and any(
                fpath_str == sp
                or fpath_str.startswith(sp.rstrip("/") + "/")
                or sp.startswith(fpath_str.rstrip("/") + "/")
                for sp in scenario_paths
            ):
                scenario_findings.append(_finding_view(item, "heuristic"))
                linked_ids.add(fid)

        scenarios_view.append(
            {
                "id": sid,
                "priority": scenario.get("priority"),
                "ownerPhase": scenario.get("ownerPhase"),
                "requiredEvidenceKind": scenario.get("requiredEvidenceKind"),
                "findings": scenario_findings,
                "findingCounts": {
                    severity: sum(
                        1 for f in scenario_findings if f["severity"] == severity
                    )
                    for severity in ("RED", "YELLOW", "OK")
                    if any(f["severity"] == severity for f in scenario_findings)
                },
            }
        )

    unlinked = [
        str(item.get("id")) for item in items
        if str(item.get("id") or "") not in linked_ids
    ]
    return {
        "available": True,
        "scenarios": scenarios_view,
        "unlinkedFindings": unlinked,
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
    return _emit(
        write_findings(
            Path(args.change_dir), doc, diff_mode=getattr(args, "mode", None)
        ),
        as_json=True,
    )


def cmd_write_dispositions(args: argparse.Namespace) -> int:
    try:
        doc = _input_document(args)
    except (ValueError, json.JSONDecodeError) as exc:
        return _emit(
            {"ok": False, "code": "DISPOSITIONS_INPUT_INVALID", "error": str(exc)},
            as_json=True,
        )
    return _emit(write_dispositions(Path(args.change_dir), doc), as_json=True)


def _latest_review_run_id(change_dir: Path) -> str | None:
    """从 events.ndjson 取最近一轮 review phase.start 的 run_id（best-effort）。"""
    candidates = [change_dir / "events.ndjson"]
    state_events = _state_dir(change_dir) / "events.ndjson"
    if state_events != candidates[0]:
        candidates.append(state_events)
    run_id: str | None = None
    for path in candidates:
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            if (
                isinstance(item, dict)
                and item.get("type") == "phase.start"
                and item.get("phase") == "review"
                and isinstance(item.get("run_id"), str)
                and item["run_id"].strip()
            ):
                run_id = item["run_id"]
    return run_id


def scaffold(change_dir: Path, run_id: str | None) -> dict[str, Any]:
    """按当前轮次生成 review-findings / fixback-dispositions 的写入骨架。

    sidecar 的 schema 以前只能从 harness_review.py 源码里挖；骨架直接能喂给
    write-findings / write-dispositions --stdin，消除手拼 JSON 的整类错误。
    已有 findings 时，骨架为每条 finding 生成一条占位处置（disposition=OPEN，
    由调用方逐条改判），并复用 findings 的 runId，保证两份 sidecar 同属一轮。
    """
    change_dir = Path(change_dir)
    findings_doc = _load_findings(change_dir)
    if findings_doc is not None:
        effective_run_id = str(findings_doc.get("runId") or "").strip()
        if not effective_run_id:
            return {
                "ok": False,
                "code": "FINDINGS_RUN_ID_MISSING",
                "problems": ["review-findings.json 缺少 runId，无法生成同轮处置骨架"],
            }
        dispositions = [
            {"findingId": f["id"], "disposition": "OPEN"}
            for f in findings_doc.get("findings", [])
            if isinstance(f, dict) and isinstance(f.get("id"), str)
        ]
        return {
            "ok": True,
            "code": "REVIEW_SCAFFOLD_DISPOSITIONS",
            "runId": effective_run_id,
            "dispositionsInput": {
                "schemaVersion": 1,
                "runId": effective_run_id,
                "dispositions": dispositions,
            },
            "writeCommand": (
                "harness_review.py write-dispositions "
                f"--change-dir {change_dir} --stdin"
            ),
            "note": "逐条把 disposition 改判为 FIXED/ACCEPTED_RISK/DEFERRED/NOT_APPLICABLE；"
            "OPEN 表示待修复，gate 关门时所有 finding 都必须有处置记录。",
        }
    effective_run_id = (run_id or "").strip() or _latest_review_run_id(change_dir)
    if not effective_run_id:
        return {
            "ok": False,
            "code": "SCAFFOLD_RUN_ID_REQUIRED",
            "problems": [
                "无法从 events.ndjson 推断本轮 review runId；请显式传 --run-id"
            ],
        }
    return {
        "ok": True,
        "code": "REVIEW_SCAFFOLD_FINDINGS",
        "runId": effective_run_id,
        "findingsInput": {
            "schemaVersion": 1,
            "runId": effective_run_id,
            "changeName": change_dir.name,
            "findings": [],
            "_exampleFinding": {
                "dimension": "正确性",
                "severity": "YELLOW",
                "path": "src/example.ts",
                "line": 1,
                "title": "一句话问题标题",
                "fixbackAction": "code",
            },
        },
        "writeCommand": (
            f"harness_review.py write-findings --change-dir {change_dir} --stdin"
        ),
        "note": "无发现时保持 findings 为空数组即合法；write-findings 会为每条 "
        "finding 分配稳定 id。落地后重跑 scaffold 生成对应的处置骨架。",
    }


def cmd_scaffold(args: argparse.Namespace) -> int:
    return _emit(
        scaffold(Path(args.change_dir), getattr(args, "run_id", None)),
        as_json=True,
    )


def cmd_status(args: argparse.Namespace) -> int:
    # 15-M4：--change-dir 与 --change(+--project) 二选一
    raw_dir = getattr(args, "change_dir", None)
    change_name = str(getattr(args, "change", "") or "").strip()
    if raw_dir and change_name:
        return _emit(
            {
                "ok": False,
                "code": "STATUS_ARGS_CONFLICT",
                "error": "--change-dir 与 --change 只能二选一",
            },
            as_json=True,
        )
    if change_name:
        project = Path(getattr(args, "project", None) or Path.cwd()).resolve()
        change_dir = project / ".harness" / "changes" / change_name
        if not change_dir.is_dir():
            return _emit(
                {
                    "ok": False,
                    "code": "CHANGE_DIR_MISSING",
                    "error": f"{change_dir} 不存在",
                },
                as_json=True,
            )
    elif raw_dir:
        change_dir = Path(raw_dir)
    else:
        return _emit(
            {
                "ok": False,
                "code": "STATUS_ARGS_MISSING",
                "error": "需要 --change-dir 或 --change（搭配 --project，默认 cwd）",
            },
            as_json=True,
        )
    return _emit(status(change_dir), as_json=True)


def cmd_diff_scope(args: argparse.Namespace) -> int:
    return _emit(diff_scope(Path(args.change_dir)), as_json=True)


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
    p_findings.add_argument(
        "--mode",
        choices=("full", "incremental"),
        default=None,
        help="WI-3.4：显式声明本轮评审模式（如实按 diff-scope 输出填写）；"
        "stdin JSON 的 diffMode 字段优先；缺省自动推断",
    )
    p_findings.set_defaults(func=cmd_write_findings)

    p_dispositions = sub.add_parser("write-dispositions")
    p_dispositions.add_argument("--change-dir", required=True)
    p_dispositions.add_argument("--input", help="dispositions JSON 文件路径")
    p_dispositions.add_argument(
        "--stdin", action="store_true", help="从标准输入读 JSON，免落临时文件"
    )
    p_dispositions.set_defaults(func=cmd_write_dispositions)

    p_scaffold = sub.add_parser(
        "scaffold",
        help="按当前轮次生成 review-findings / fixback-dispositions 的写入骨架",
    )
    p_scaffold.add_argument("--change-dir", required=True)
    p_scaffold.add_argument(
        "--run-id",
        help="本轮 review runId；缺省从 events.ndjson 最新的 review phase.start 推断",
    )
    p_scaffold.set_defaults(func=cmd_scaffold)

    p_status = sub.add_parser("status")
    # 15-M4：--change（搭配 --project，默认 cwd）与 --change-dir 二选一。
    p_status.add_argument("--change-dir", default=None)
    p_status.add_argument("--change", default=None, help="change 名（配 --project）")
    p_status.add_argument("--project", default=None, help="项目根（默认 cwd）")
    p_status.set_defaults(func=cmd_status)

    p_scope = sub.add_parser(
        "diff-scope",
        help="WI-3.4：判定本轮评审输入是增量还是全量（含增量文件集/上下文/未解决发现）",
    )
    p_scope.add_argument("--change-dir", required=True)
    p_scope.set_defaults(func=cmd_diff_scope)

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
