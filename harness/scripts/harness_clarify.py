#!/usr/bin/env python3
"""10-M3：需求歧义 Clarify 前置步（确定性静态检查 + 一次 LLM 歧义扫描留证）。

回答「需求本身是否有唯一可执行解释」，在 evidence-pack 校验与 finalize 之前
执行。三层结构：

1. 确定性静态检查（零 LLM，fail-closed）：空 objective / scenario/task 悬空
   引用 / 不可测验收条件（无观察点或判据）直接判 failed；10-M4 起新增
   codebase-map 输入——``.harness/codebase/map/map-manifest.json`` 为 paths
   模式时，task affected_paths 越出地图扫描范围给定位缺陷，manifest 缺失或
   不可读则跳过不失败（只读消费，阶段 05 拥有其 schema）；
2. 一次 LLM 歧义扫描：由 agent 在 SKILL 引导下执行（每次 plan 至多一次，确认
   清单 ≤5 条），结果经 ``record-scan`` 留证；答案经 ``confirm`` 逐条闭包；
3. ClarifyReport v1（``meta/clarify-report.json``）：机器可读收据，全字段
   snake_case，状态枚举 ``passed | failed | confirmations_required |
   not_required``；中文文案仅展示，状态判定只读机器字段。

阻断点唯一：``harness_gate close --phase plan``（TS finalizer 是阶段 11/12
禁改区）。``harness_plan_finalize.py verify`` 只读附挂判定，不翻转 ok。
回滚 = 配置 ``clarifyGateMode=off``，报告文件保留为历史证据。存量 change 无
报告时按 not_required 放行（兼容读取）。

本模块不 import harness_plan_finalize（保持 harness_paths ← harness_clarify
← harness_plan_finalize ← harness_gate 的线性依赖）；少量辅助函数与其
重复，改动时必须双向同步（见各函数注释）。
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_paths as hp  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

CLARIFY_REPORT_REL = Path("meta") / "clarify-report.json"
CLARIFY_PEI_REL = Path("meta") / "plan-evidence-input.json"
CLARIFY_STATUSES = ("passed", "failed", "confirmations_required", "not_required")
CLARIFY_GATE_MODES = ("strict", "off")
CLARIFY_TIERS = ("fast", "standard", "full")
# 只有 standard/full 档要求澄清闭环；fast 档豁免。
CLARIFY_GATE_REQUIRED_TIERS = frozenset({"standard", "full"})
# 有界扫描：每次 plan 至多一次扫描、确认清单 ≤5 条。
CLARIFY_MAX_CONFIRMATIONS = 5
CLARIFY_MAX_QUESTION_CHARS = 500
CLARIFY_MAX_ANSWER_CHARS = 1000
_CLARIFY_CONFIRMATION_ID = re.compile(r"^clarify_confirm:[a-f0-9]{64}$")
_CLARIFY_SCAN_ID = re.compile(r"^clarify_scan:[a-f0-9]{64}$")


def _now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def _clarify_error(code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "code": code, "message": message}


def _write_json_atomic(path: Path, data: Any) -> None:
    """原子 JSON 写（temp + os.replace，LF、UTF-8 无 BOM）。

    与 harness_plan_finalize._write_json_atomic 同一实现；两处改动必须同步。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(text, encoding="utf-8", newline="\n")
        os.replace(tmp, path)
    except BaseException:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def clarify_tier(change_dir: Path) -> str:
    """解析 change 的档位（v2 plan-profile 的 tier 优先，回退 gate-policy.json）。

    与 harness_plan_finalize.knowledge_gate_tier 同一条解析链、同一回退语义
    （缺失或未知取值一律按 fast）；两处改动必须同步。
    """
    try:
        loaded = hp.load_change_gate_policy(Path(change_dir))
    except (OSError, ValueError, json.JSONDecodeError):
        return "fast"
    policy = loaded.get("policy") if isinstance(loaded, dict) else None
    tier = str(policy.get("tier") or "").strip().lower() if isinstance(policy, dict) else ""
    return tier if tier in CLARIFY_TIERS else "fast"


def clarify_gate_mode(project: Path, change_dir: Path | None = None) -> str:
    """解析澄清门禁模式：env > change gate-policy > project config > strict。

    与知识查询门禁的 warn 降级不同，本门禁的回滚语义是关闭（10-M3：回滚 =
    关闭门禁配置项，报告文件保留为历史证据）。
    """
    env_mode = (
        str(os.environ.get("HUNTER_HARNESS_CLARIFY_GATE_MODE") or "")
        .strip()
        .lower()
    )
    if env_mode in CLARIFY_GATE_MODES:
        return env_mode
    candidates: list[Path] = []
    if change_dir is not None:
        candidates.append(Path(change_dir) / "meta" / "gate-policy.json")
    candidates.append(Path(project) / ".harness" / "config" / "gate-policy.json")
    for path in candidates:
        if not path.is_file():
            continue
        try:
            document = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(document, dict):
            continue
        value = str(document.get("clarifyGateMode") or "").strip().lower()
        if value in CLARIFY_GATE_MODES:
            return value
    return "strict"


# ---------------------------------------------------------------------------
# 静态检查（确定性，零 LLM）
# ---------------------------------------------------------------------------


def _defect(code: str, field_path: str, message: str) -> dict[str, Any]:
    return {"code": code, "field_path": field_path, "message": message}


def _check_intent_goal(pei: dict[str, Any]) -> dict[str, Any]:
    intent = pei.get("intent")
    goal = intent.get("goal") if isinstance(intent, dict) else None
    defects: list[dict[str, Any]] = []
    if not str(goal or "").strip():
        defects.append(
            _defect(
                "CLARIFY_OBJECTIVE_EMPTY",
                "intent.goal",
                "需求目标为空：计划没有唯一可执行解释的方向",
            )
        )
    return {"check_id": "intent_goal_present", "ok": not defects, "defects": defects}


def _check_task_objectives(tasks: list[Any]) -> dict[str, Any]:
    defects: list[dict[str, Any]] = []
    for index, task in enumerate(tasks):
        if not isinstance(task, dict):
            continue
        if not str(task.get("objective") or "").strip():
            task_id = str(task.get("task_id") or "").strip() or f"#{index}"
            defects.append(
                _defect(
                    "CLARIFY_OBJECTIVE_EMPTY",
                    f"structured_input.tasks[{index}].objective",
                    f"任务 {task_id} 的 objective 为空：没有可验收的完成判据",
                )
            )
    return {"check_id": "task_objective_present", "ok": not defects, "defects": defects}


def _check_refs_closed(
    tasks: list[Any], scenarios: list[Any], requirements: list[Any]
) -> list[dict[str, Any]]:
    """scenario/task 悬空引用与 requirement_refs 悬空引用（两条检查）。

    只校验输入文件里实际出现的引用键；引用指向不存在的 id 即悬空。
    requirements 整节缺失时，任何 requirement_refs 都无法解析，一律悬空。
    """
    task_ids = {
        str(task.get("task_id") or "").strip()
        for task in tasks
        if isinstance(task, dict) and str(task.get("task_id") or "").strip()
    }
    scenario_ids = {
        str(item.get("scenario_id") or "").strip()
        for item in scenarios
        if isinstance(item, dict) and str(item.get("scenario_id") or "").strip()
    }
    requirement_ids = {
        str(item.get("requirement_id") or "").strip()
        for item in requirements
        if isinstance(item, dict) and str(item.get("requirement_id") or "").strip()
    }
    scenario_task_defects: list[dict[str, Any]] = []
    requirement_defects: list[dict[str, Any]] = []

    def _ref_list(owner: dict[str, Any], key: str) -> list[Any]:
        value = owner.get(key)
        return value if isinstance(value, list) else []

    for index, scenario in enumerate(scenarios):
        if not isinstance(scenario, dict):
            continue
        scenario_id = str(scenario.get("scenario_id") or "").strip() or f"#{index}"
        for ref_index, ref in enumerate(_ref_list(scenario, "task_refs")):
            ref_id = str(ref or "").strip()
            if ref_id and ref_id not in task_ids:
                scenario_task_defects.append(
                    _defect(
                        "CLARIFY_REF_DANGLING",
                        f"structured_input.scenarios[{index}].task_refs[{ref_index}]",
                        f"场景 {scenario_id} 引用了不存在的任务 {ref_id}",
                    )
                )
        for ref_index, ref in enumerate(_ref_list(scenario, "requirement_refs")):
            ref_id = str(ref or "").strip()
            if ref_id and ref_id not in requirement_ids:
                requirement_defects.append(
                    _defect(
                        "CLARIFY_REF_DANGLING",
                        f"structured_input.scenarios[{index}].requirement_refs[{ref_index}]",
                        f"场景 {scenario_id} 引用了不存在的需求 {ref_id}",
                    )
                )
    for index, task in enumerate(tasks):
        if not isinstance(task, dict):
            continue
        task_id = str(task.get("task_id") or "").strip() or f"#{index}"
        for key, known, label in (
            ("depends_on", task_ids, "任务"),
            ("scenario_refs", scenario_ids, "场景"),
        ):
            for ref_index, ref in enumerate(_ref_list(task, key)):
                ref_id = str(ref or "").strip()
                if ref_id and ref_id not in known:
                    scenario_task_defects.append(
                        _defect(
                            "CLARIFY_REF_DANGLING",
                            f"structured_input.tasks[{index}].{key}[{ref_index}]",
                            f"任务 {task_id} 引用了不存在的{label} {ref_id}",
                        )
                    )
        for ref_index, ref in enumerate(_ref_list(task, "requirement_refs")):
            ref_id = str(ref or "").strip()
            if ref_id and ref_id not in requirement_ids:
                requirement_defects.append(
                    _defect(
                        "CLARIFY_REF_DANGLING",
                        f"structured_input.tasks[{index}].requirement_refs[{ref_index}]",
                        f"任务 {task_id} 引用了不存在的需求 {ref_id}",
                    )
                )
    return [
        {
            "check_id": "scenario_task_refs_closed",
            "ok": not scenario_task_defects,
            "defects": scenario_task_defects,
        },
        {
            "check_id": "requirement_refs_closed",
            "ok": not requirement_defects,
            "defects": requirement_defects,
        },
    ]


def _check_acceptance_testable(scenarios: list[Any]) -> dict[str, Any]:
    """验收条件可测：每个场景必须有判据（acceptance）与观察点（evidence_requirements）。"""
    defects: list[dict[str, Any]] = []
    for index, scenario in enumerate(scenarios):
        if not isinstance(scenario, dict):
            continue
        scenario_id = str(scenario.get("scenario_id") or "").strip() or f"#{index}"
        if not str(scenario.get("acceptance") or "").strip():
            defects.append(
                _defect(
                    "CLARIFY_ACCEPTANCE_UNTESTABLE",
                    f"structured_input.scenarios[{index}].acceptance",
                    f"场景 {scenario_id} 没有验收判据（acceptance 为空）",
                )
            )
        evidence_requirements = scenario.get("evidence_requirements")
        if not isinstance(evidence_requirements, list) or not evidence_requirements:
            defects.append(
                _defect(
                    "CLARIFY_ACCEPTANCE_UNTESTABLE",
                    f"structured_input.scenarios[{index}].evidence_requirements",
                    f"场景 {scenario_id} 没有观察点（evidence_requirements 为空）",
                )
            )
    return {"check_id": "acceptance_testable", "ok": not defects, "defects": defects}


# ---------------------------------------------------------------------------
# 10-M4：codebase-map manifest 作为静态检查输入（只读消费，阶段 05 拥有 schema）
# ---------------------------------------------------------------------------

MAP_MANIFEST_REL = Path(".harness") / "codebase" / "map" / "map-manifest.json"
# full/fast/focus 均为整仓扫描（文档子集不同），视为全量覆盖；paths 为局部范围。
_MAP_FULL_COVERAGE_TYPES = frozenset({"full", "fast", "focus"})


def _project_root_for_change(change_dir: Path) -> Path | None:
    """从 contract 布局 <project>/.harness/changes/<cn> 反推项目根；布局不符返回 None。"""
    resolved = Path(change_dir).resolve()
    if resolved.parent.name == "changes" and resolved.parent.parent.name == ".harness":
        return resolved.parent.parent.parent
    return None


def load_map_manifest(change_dir: Path) -> dict[str, Any] | None:
    """加载 codebase-map manifest；缺失/不可读/非对象/布局不符一律返回 None（跳过语义）。"""
    root = _project_root_for_change(change_dir)
    if root is None:
        return None
    manifest_path = root / MAP_MANIFEST_REL
    if not manifest_path.is_file():
        return None
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _normalize_map_path(raw: str) -> str:
    return raw.replace("\\", "/").strip().strip("/")


def _check_map_refs(
    tasks: list[Any], map_manifest: dict[str, Any] | None
) -> dict[str, Any]:
    """affected_paths 与 codebase-map 扫描范围对齐检查。

    paths 模式地图只覆盖声明的扫描根，越出范围的受影响路径 = 地图中不存在该
    模块的信息，给 CLARIFY_MAP_REF_UNKNOWN 定位缺陷；整仓模式视为全量覆盖。
    manifest 缺失/不可读/范围无法判定时 skipped（ok=True），不阻断 fail-closed。
    """
    check_id = "codebase_map_refs_known"
    if map_manifest is None:
        return {
            "check_id": check_id,
            "ok": True,
            "skipped": True,
            "skip_reason": "codebase map manifest 缺失或不可读，跳过（存量 change 行为不变）",
            "defects": [],
        }
    scope = map_manifest.get("path_scope")
    scope = scope if isinstance(scope, dict) else {}
    scope_type = str(scope.get("type") or "").strip()
    if scope_type in _MAP_FULL_COVERAGE_TYPES:
        return {"check_id": check_id, "ok": True, "defects": []}
    if scope_type != "paths":
        return {
            "check_id": check_id,
            "ok": True,
            "skipped": True,
            "skip_reason": f"无法判定的 path_scope.type（{scope_type or 'missing'}），跳过",
            "defects": [],
        }
    raw_paths = scope.get("paths")
    roots: list[str] = []
    if isinstance(raw_paths, list):
        for item in raw_paths:
            if isinstance(item, str):
                normalized = _normalize_map_path(item)
                if normalized:
                    roots.append(normalized)
    if not roots:
        return {
            "check_id": check_id,
            "ok": True,
            "skipped": True,
            "skip_reason": "paths 模式未声明 path_scope.paths，跳过",
            "defects": [],
        }
    defects: list[dict[str, Any]] = []
    for index, task in enumerate(tasks):
        if not isinstance(task, dict):
            continue
        task_id = str(task.get("task_id") or "").strip() or f"#{index}"
        affected = task.get("affected_paths")
        if not isinstance(affected, list):
            continue
        for path_index, raw in enumerate(affected):
            if not isinstance(raw, str) or not str(raw).strip():
                continue
            normalized = _normalize_map_path(raw)
            if any(
                normalized == root or normalized.startswith(root + "/")
                for root in roots
            ):
                continue
            defects.append(
                _defect(
                    "CLARIFY_MAP_REF_UNKNOWN",
                    f"structured_input.tasks[{index}].affected_paths[{path_index}]",
                    f"任务 {task_id} 的受影响路径 {raw} 不在 codebase map 扫描范围内"
                    f"（paths 模式仅覆盖：{', '.join(roots)}）；"
                    "请修正受影响路径，或重跑 codebase-map 扩展扫描范围",
                )
            )
    return {"check_id": check_id, "ok": not defects, "defects": defects}


def run_static_checks(
    pei: dict[str, Any], map_manifest: dict[str, Any] | None = None
) -> list[dict[str, Any]]:
    """对 PEI 跑全部确定性静态检查，返回 check 结果列表（含 ok/defects）。

    map_manifest 由调用方从 change_dir 所在项目根加载（10-M4）；None 时
    codebase-map 检查项输出 skipped 结果，不影响 fail-closed 语义。
    """
    structured = pei.get("structured_input")
    structured = structured if isinstance(structured, dict) else {}
    tasks = structured.get("tasks")
    tasks = tasks if isinstance(tasks, list) else []
    scenarios = structured.get("scenarios")
    scenarios = scenarios if isinstance(scenarios, list) else []
    requirements = structured.get("requirements")
    requirements = requirements if isinstance(requirements, list) else []
    return [
        _check_intent_goal(pei),
        _check_task_objectives(tasks),
        *_check_refs_closed(tasks, scenarios, requirements),
        _check_acceptance_testable(scenarios),
        _check_map_refs(tasks, map_manifest),
    ]


def _all_defects(checks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [defect for check in checks for defect in check.get("defects") or []]


# ---------------------------------------------------------------------------
# ClarifyReport v1：读、写、状态推导
# ---------------------------------------------------------------------------


def _pei_hash(pei_path: Path) -> str:
    return "sha256:" + hashlib.sha256(pei_path.read_bytes()).hexdigest()


def _confirmation_id(question: str) -> str:
    return "clarify_confirm:" + hashlib.sha256(
        question.strip().encode("utf-8")
    ).hexdigest()


def _scan_id(confirmation_ids: list[str]) -> str:
    material = "\n".join(sorted(confirmation_ids))
    return "clarify_scan:" + hashlib.sha256(material.encode("utf-8")).hexdigest()


def _pending_confirmation_ids(scan: Any) -> list[str]:
    if not isinstance(scan, dict):
        return []
    confirmations = scan.get("confirmations")
    if not isinstance(confirmations, list):
        return []
    return [
        str(item.get("confirmation_id"))
        for item in confirmations
        if isinstance(item, dict) and item.get("status") == "pending"
    ]


def _compute_status(
    tier: str,
    pei_present: bool,
    checks: list[dict[str, Any]],
    scan: Any,
) -> str:
    """状态枚举推导：机器字段唯一来源，中文文案不参与判定。"""
    if tier not in CLARIFY_GATE_REQUIRED_TIERS:
        return "not_required"
    if not pei_present:
        return "not_required"
    if any(not check.get("ok") for check in checks):
        return "failed"
    if _pending_confirmation_ids(scan):
        return "confirmations_required"
    return "passed"


def _load_report(change_dir: Path) -> dict[str, Any] | None:
    """读取既有报告；缺失或形状非法时返回 None（调用方按语义处置）。"""
    path = Path(change_dir) / CLARIFY_REPORT_REL
    if not path.is_file():
        return None
    try:
        document = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(document, dict) or document.get("schema_version") != 1:
        return None
    return document


def _validate_report_shape(report: dict[str, Any], change_key: str) -> bool:
    """门禁读取侧的形状校验。"""
    if report.get("change_key") != change_key:
        return False
    if str(report.get("status") or "") not in CLARIFY_STATUSES:
        return False
    if not isinstance(report.get("checks"), list):
        return False
    scan = report.get("scan")
    if scan is not None:
        if not isinstance(scan, dict):
            return False
        if _CLARIFY_SCAN_ID.fullmatch(str(scan.get("scan_id") or "")) is None:
            return False
        confirmations = scan.get("confirmations")
        if not isinstance(confirmations, list):
            return False
        for item in confirmations:
            if not isinstance(item, dict):
                return False
            if _CLARIFY_CONFIRMATION_ID.fullmatch(
                str(item.get("confirmation_id") or "")
            ) is None:
                return False
            if item.get("status") not in {"pending", "answered"}:
                return False
            if item.get("status") == "answered" and not str(
                item.get("answer") or ""
            ).strip():
                return False
    return True


# ---------------------------------------------------------------------------
# 子命令：check / record-scan / confirm
# ---------------------------------------------------------------------------


def run_check(change_dir: Path) -> dict[str, Any]:
    """跑静态检查并刷新 ClarifyReport（rebase PEI 哈希，保留已留证的扫描与答案）。

    check 是报告的 rebase 入口：PEI 修订后重跑即可让报告重新绑定当前输入，
    已回答的确认不会丢失。每次 check 全量重算静态检查（确定性、幂等）。
    """
    change_dir = Path(change_dir).resolve()
    if not change_dir.is_dir():
        return _clarify_error(
            "CHANGE_DIR_MISSING", f"change directory not found: {change_dir}"
        )
    tier = clarify_tier(change_dir)
    pei_path = change_dir / CLARIFY_PEI_REL
    pei_present = pei_path.is_file()
    pei: dict[str, Any] | None = None
    if pei_present:
        try:
            loaded = json.loads(pei_path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError) as exc:
            return _clarify_error(
                "CLARIFY_INPUT_INVALID",
                f"{CLARIFY_PEI_REL.as_posix()} 无法解析：{exc}",
            )
        if not isinstance(loaded, dict):
            return _clarify_error(
                "CLARIFY_INPUT_INVALID",
                f"{CLARIFY_PEI_REL.as_posix()} 顶层必须是对象",
            )
        pei = loaded
    checks = (
        run_static_checks(pei, load_map_manifest(change_dir))
        if pei is not None
        else []
    )
    previous = _load_report(change_dir)
    scan = previous.get("scan") if isinstance(previous, dict) else None
    status = _compute_status(tier, pei_present, checks, scan)
    now = _now_iso()
    report = {
        "schema_version": 1,
        "change_key": change_dir.name,
        "tier": tier,
        "status": status,
        "plan_evidence_input_hash": _pei_hash(pei_path) if pei_present else None,
        "checks": checks,
        "scan": scan,
        "created_at": (
            str(previous.get("created_at"))
            if isinstance(previous, dict) and previous.get("created_at")
            else now
        ),
        "updated_at": now,
    }
    _write_json_atomic(change_dir / CLARIFY_REPORT_REL, report)
    defects = _all_defects(checks)
    return {
        "ok": status != "failed",
        "code": "CLARIFY_CHECK_" + status.upper(),
        "status": status,
        "tier": tier,
        "changeDir": str(change_dir),
        "reportPath": str(change_dir / CLARIFY_REPORT_REL),
        "checkCount": len(checks),
        "defectCount": len(defects),
        "defects": defects,
        "pendingConfirmationIds": _pending_confirmation_ids(scan),
        "scanRecorded": isinstance(scan, dict),
    }


def _parse_questions(payload: Any) -> dict[str, Any]:
    """解析 record-scan 载荷 → 归一化问题列表；非法形状给错误码。"""
    if not isinstance(payload, dict) or payload.get("schema_version") != 1:
        return _clarify_error(
            "CLARIFY_SCAN_INVALID",
            'payload must be {"schema_version": 1, "questions": [...]}',
        )
    raw = payload.get("questions")
    if not isinstance(raw, list):
        return _clarify_error("CLARIFY_SCAN_INVALID", "questions must be a list")
    if len(raw) > CLARIFY_MAX_CONFIRMATIONS:
        return _clarify_error(
            "CLARIFY_SCAN_BUDGET_EXCEEDED",
            f"确认清单最多 {CLARIFY_MAX_CONFIRMATIONS} 条（10-M3 有界扫描），给了 {len(raw)} 条",
        )
    questions: list[str] = []
    for index, item in enumerate(raw):
        text = item.get("question") if isinstance(item, dict) else item
        text = str(text or "").strip()
        if not text:
            return _clarify_error("CLARIFY_SCAN_INVALID", f"questions[{index}] is empty")
        if len(text) > CLARIFY_MAX_QUESTION_CHARS:
            return _clarify_error(
                "CLARIFY_SCAN_INVALID",
                f"questions[{index}] exceeds {CLARIFY_MAX_QUESTION_CHARS} chars",
            )
        questions.append(text)
    return {"ok": True, "questions": questions}


def record_scan(change_dir: Path, payload: Any) -> dict[str, Any]:
    """把一次 LLM 歧义扫描的确认清单写入报告（每次 plan 至多一次，幂等重放）。

    扫描由 agent 在 SKILL 引导下执行（零脚本 LLM 调用）；本命令只留证。同一
    问题集合的重录是幂等重放；不同问题集合拒绝（一次扫描预算已消耗）。
    """
    change_dir = Path(change_dir).resolve()
    if not change_dir.is_dir():
        return _clarify_error(
            "CHANGE_DIR_MISSING", f"change directory not found: {change_dir}"
        )
    parsed = _parse_questions(payload)
    if not parsed.get("ok"):
        return parsed
    pei_path = change_dir / CLARIFY_PEI_REL
    if not pei_path.is_file():
        return _clarify_error(
            "CLARIFY_INPUT_MISSING",
            f"{CLARIFY_PEI_REL.as_posix()} 不存在；先完成 plan-evidence-input 草稿再扫描",
        )
    report = _load_report(change_dir)
    if report is None:
        return _clarify_error(
            "CLARIFY_REPORT_MISSING",
            "clarify-report 不存在或形状非法；先跑 harness_clarify.py check 建报告",
        )
    current_hash = _pei_hash(pei_path)
    if report.get("plan_evidence_input_hash") != current_hash:
        return _clarify_error(
            "CLARIFY_REPORT_STALE",
            "plan-evidence-input 已在 check 之后修订；先重跑 check 让报告 rebase 到当前输入",
        )
    confirmation_ids = [_confirmation_id(q) for q in parsed["questions"]]
    existing_scan = report.get("scan")
    if isinstance(existing_scan, dict):
        existing_ids = sorted(
            str(item.get("confirmation_id"))
            for item in existing_scan.get("confirmations") or []
            if isinstance(item, dict)
        )
        if existing_ids == sorted(confirmation_ids):
            return {
                "ok": True,
                "code": "CLARIFY_SCAN_REPLAYED",
                "replayed": True,
                "status": report.get("status"),
                "scanId": existing_scan.get("scan_id"),
                "confirmationCount": len(existing_ids),
                "reportPath": str(change_dir / CLARIFY_REPORT_REL),
            }
        return _clarify_error(
            "CLARIFY_SCAN_ALREADY_RECORDED",
            "本 change 已留证过一次歧义扫描（10-M3：每次 plan 至多一次）；"
            "已回答的确认不会丢失，新疑问请并入既有清单的答案闭环",
        )
    now = _now_iso()
    confirmations = [
        {
            "confirmation_id": confirmation_id,
            "question": question,
            "status": "pending",
            "answer": None,
            "answered_at": None,
        }
        for confirmation_id, question in zip(confirmation_ids, parsed["questions"])
    ]
    scan = {
        "scan_id": _scan_id(confirmation_ids),
        "recorded_at": now,
        "confirmations": confirmations,
    }
    checks = report.get("checks") if isinstance(report.get("checks"), list) else []
    status = _compute_status(
        str(report.get("tier") or clarify_tier(change_dir)), True, checks, scan
    )
    report = {**report, "status": status, "scan": scan, "updated_at": now}
    _write_json_atomic(change_dir / CLARIFY_REPORT_REL, report)
    return {
        "ok": True,
        "code": "CLARIFY_SCAN_RECORDED",
        "replayed": False,
        "status": status,
        "scanId": scan["scan_id"],
        "confirmationIds": confirmation_ids,
        "confirmationCount": len(confirmations),
        "reportPath": str(change_dir / CLARIFY_REPORT_REL),
    }


def _parse_answers(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or payload.get("schema_version") != 1:
        return _clarify_error(
            "CLARIFY_CONFIRM_INVALID",
            'payload must be {"schema_version": 1, "answers": [...]}',
        )
    raw = payload.get("answers")
    if not isinstance(raw, list) or not raw:
        return _clarify_error(
            "CLARIFY_CONFIRM_INVALID", "answers must be a non-empty list"
        )
    answers: list[tuple[str, str]] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            return _clarify_error(
                "CLARIFY_CONFIRM_INVALID", f"answers[{index}] must be an object"
            )
        confirmation_id = str(item.get("confirmation_id") or "").strip()
        if _CLARIFY_CONFIRMATION_ID.fullmatch(confirmation_id) is None:
            return _clarify_error(
                "CLARIFY_CONFIRM_INVALID",
                f"answers[{index}].confirmation_id malformed: {confirmation_id!r}",
            )
        answer = str(item.get("answer") or "").strip()
        if not answer:
            return _clarify_error(
                "CLARIFY_CONFIRM_INVALID", f"answers[{index}].answer is empty"
            )
        if len(answer) > CLARIFY_MAX_ANSWER_CHARS:
            return _clarify_error(
                "CLARIFY_CONFIRM_INVALID",
                f"answers[{index}].answer exceeds {CLARIFY_MAX_ANSWER_CHARS} chars",
            )
        answers.append((confirmation_id, answer))
    return {"ok": True, "answers": answers}


def record_confirmations(change_dir: Path, payload: Any) -> dict[str, Any]:
    """把确认清单的答案闭包写回报告；全部 answered 且静态干净时状态转 passed。"""
    change_dir = Path(change_dir).resolve()
    if not change_dir.is_dir():
        return _clarify_error(
            "CHANGE_DIR_MISSING", f"change directory not found: {change_dir}"
        )
    parsed = _parse_answers(payload)
    if not parsed.get("ok"):
        return parsed
    pei_path = change_dir / CLARIFY_PEI_REL
    if not pei_path.is_file():
        return _clarify_error(
            "CLARIFY_INPUT_MISSING",
            f"{CLARIFY_PEI_REL.as_posix()} 不存在；无输入可闭包",
        )
    report = _load_report(change_dir)
    if report is None:
        return _clarify_error(
            "CLARIFY_REPORT_MISSING",
            "clarify-report 不存在或形状非法；先跑 harness_clarify.py check 建报告",
        )
    if report.get("plan_evidence_input_hash") != _pei_hash(pei_path):
        return _clarify_error(
            "CLARIFY_REPORT_STALE",
            "plan-evidence-input 已在 check 之后修订；先重跑 check 再闭包答案",
        )
    scan = report.get("scan")
    if not isinstance(scan, dict):
        return _clarify_error(
            "CLARIFY_SCAN_MISSING",
            "报告里还没有扫描留证；先 record-scan（零疑问时给空 questions 列表）",
        )
    confirmations = [
        item
        for item in scan.get("confirmations") or []
        if isinstance(item, dict)
    ]
    by_id = {str(item.get("confirmation_id")): item for item in confirmations}
    for confirmation_id, _ in parsed["answers"]:
        if confirmation_id not in by_id:
            return _clarify_error(
                "CLARIFY_CONFIRMATION_UNKNOWN",
                f"confirmation_id 不在本次扫描清单里：{confirmation_id}",
            )
    now = _now_iso()
    for confirmation_id, answer in parsed["answers"]:
        item = by_id[confirmation_id]
        item["status"] = "answered"
        item["answer"] = answer
        item["answered_at"] = now
    checks = report.get("checks") if isinstance(report.get("checks"), list) else []
    status = _compute_status(
        str(report.get("tier") or clarify_tier(change_dir)), True, checks, scan
    )
    report = {**report, "status": status, "scan": scan, "updated_at": now}
    _write_json_atomic(change_dir / CLARIFY_REPORT_REL, report)
    return {
        "ok": True,
        "code": "CLARIFY_CONFIRMATIONS_RECORDED",
        "status": status,
        "answeredCount": sum(1 for item in confirmations if item.get("status") == "answered"),
        "pendingConfirmationIds": _pending_confirmation_ids(scan),
        "reportPath": str(change_dir / CLARIFY_REPORT_REL),
    }


# ---------------------------------------------------------------------------
# 门禁判定（plan 关门 fail-closed；verify 只读附挂）
# ---------------------------------------------------------------------------


def validate_clarify_gate(project: Path, change_dir: Path) -> dict[str, Any]:
    """plan 关门时的澄清门禁（只读，10-M3）。

    off 模式或 fast 档豁免并记录原因；standard/full 档对当前 PEI 全量重跑
    静态检查（报告陈旧骗不过门禁），并要求报告内的确认清单已闭环。存量
    change 无报告且静态干净时按 not_required 放行（兼容读取）。
    """
    change_dir = Path(change_dir).resolve()
    project = Path(project).resolve()
    mode = clarify_gate_mode(project, change_dir)
    tier = clarify_tier(change_dir)
    verdict: dict[str, Any] = {
        "mode": mode,
        "tier": tier,
        "changeDir": str(change_dir),
    }
    if mode == "off":
        verdict.update({
            "ok": True,
            "code": "CLARIFY_GATE_DISABLED",
            "skipped": True,
            "skipReason": "clarifyGateMode=off（10-M3 回滚开关；报告保留为历史证据）",
        })
        return verdict
    if tier not in CLARIFY_GATE_REQUIRED_TIERS:
        verdict.update({
            "ok": True,
            "code": "CLARIFY_GATE_SKIPPED",
            "skipped": True,
            "reportStatus": "not_required",
            "skipReason": f"{tier} 档豁免澄清门禁（10-M3 只约束 standard/full）",
        })
        return verdict
    pei_path = change_dir / CLARIFY_PEI_REL
    if not pei_path.is_file():
        verdict.update({
            "ok": True,
            "code": "CLARIFY_GATE_NOT_REQUIRED",
            "skipped": True,
            "reportStatus": "not_required",
            "skipReason": "无 plan-evidence-input（legacy/T1 轻量路径），无可澄清输入",
        })
        return verdict
    try:
        pei = json.loads(pei_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        verdict.update({
            "ok": False,
            "code": "CLARIFY_GATE_INPUT_INVALID",
            "message": f"{CLARIFY_PEI_REL.as_posix()} 无法解析：{exc}",
        })
        return verdict
    if not isinstance(pei, dict):
        verdict.update({
            "ok": False,
            "code": "CLARIFY_GATE_INPUT_INVALID",
            "message": f"{CLARIFY_PEI_REL.as_posix()} 顶层必须是对象",
        })
        return verdict
    checks = run_static_checks(pei, load_map_manifest(change_dir))
    defects = _all_defects(checks)
    if defects:
        verdict.update({
            "ok": False,
            "code": "CLARIFY_GATE_STATIC_FAILED",
            "message": (
                f"需求澄清静态检查未通过（{len(defects)} 处缺陷）；"
                "逐条修复 plan-evidence-input 后重跑 harness_clarify.py check"
            ),
            "defects": defects,
            "reportStatus": "failed",
        })
        return verdict
    report = _load_report(change_dir)
    if report is None:
        verdict.update({
            "ok": True,
            "code": "CLARIFY_GATE_NOT_REQUIRED",
            "skipped": False,
            "compat": True,
            "reportStatus": "not_required",
            "skipReason": "存量 change 无 clarify-report，按当前行为放行（10-M3 兼容读取）",
        })
        return verdict
    if not _validate_report_shape(report, change_dir.name):
        verdict.update({
            "ok": False,
            "code": "CLARIFY_GATE_REPORT_INVALID",
            "message": "clarify-report 形状非法（schema_version/change_key/status/扫描身份）；重跑 check 重建",
        })
        return verdict
    if report.get("plan_evidence_input_hash") != _pei_hash(pei_path):
        verdict.update({
            "ok": False,
            "code": "CLARIFY_GATE_REPORT_STALE",
            "message": "plan-evidence-input 已在 check 之后修订；重跑 harness_clarify.py check 让报告 rebase 到当前输入",
        })
        return verdict
    scan = report.get("scan")
    pending = _pending_confirmation_ids(scan)
    if pending:
        verdict.update({
            "ok": False,
            "code": "CLARIFY_GATE_CONFIRMATIONS_OPEN",
            "message": (
                f"歧义确认清单还有 {len(pending)} 条未闭环；逐条向用户确认后用 "
                "harness_clarify.py confirm 写回答案"
            ),
            "pendingConfirmationIds": pending,
            "reportStatus": "confirmations_required",
        })
        return verdict
    confirmations = scan.get("confirmations") if isinstance(scan, dict) else []
    answered = (
        sum(1 for item in confirmations if isinstance(item, dict) and item.get("status") == "answered")
        if isinstance(confirmations, list)
        else 0
    )
    verdict.update({
        "ok": True,
        "code": "CLARIFY_GATE_OK",
        "skipped": False,
        "reportStatus": report.get("status"),
        "scanRecorded": isinstance(scan, dict),
        "confirmationCount": len(confirmations) if isinstance(confirmations, list) else 0,
        "answeredCount": answered,
    })
    return verdict


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _read_payload_arg(args: argparse.Namespace) -> tuple[Any, dict[str, Any] | None]:
    if bool(getattr(args, "payload_file", None)) == bool(getattr(args, "payload", None)):
        return None, _clarify_error(
            "PAYLOAD_REQUIRED", "pass exactly one of --payload-file or --payload"
        )
    raw: str
    if getattr(args, "payload_file", None):
        try:
            raw = Path(args.payload_file).read_text(encoding="utf-8-sig")
        except OSError as exc:
            return None, _clarify_error("PAYLOAD_UNREADABLE", str(exc))
    else:
        raw = str(args.payload)
    try:
        return json.loads(raw), None
    except json.JSONDecodeError as exc:
        return None, _clarify_error("PAYLOAD_INVALID", str(exc))


def _emit(result: dict[str, Any], as_json: bool) -> int:
    stream = sys.stdout if result.get("ok") else sys.stderr
    if as_json:
        stream.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    else:
        stream.write(str(result.get("code") or result.get("status") or "error") + "\n")
    return 0 if result.get("ok") else 1


def _cmd_check(args: argparse.Namespace) -> int:
    return _emit(run_check(Path(args.change_dir)), bool(args.json))


def _cmd_record_scan(args: argparse.Namespace) -> int:
    payload, error = _read_payload_arg(args)
    if error is not None:
        return _emit(error, bool(args.json))
    return _emit(record_scan(Path(args.change_dir), payload), bool(args.json))


def _cmd_confirm(args: argparse.Namespace) -> int:
    payload, error = _read_payload_arg(args)
    if error is not None:
        return _emit(error, bool(args.json))
    return _emit(record_confirmations(Path(args.change_dir), payload), bool(args.json))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harness_clarify.py")
    sub = parser.add_subparsers(dest="command", required=True)
    check = sub.add_parser(
        "check",
        help="跑确定性静态检查并刷新 meta/clarify-report.json（rebase，保留扫描与答案）",
    )
    check.add_argument("--change-dir", required=True)
    check.add_argument("--json", action="store_true")
    check.set_defaults(func=_cmd_check)
    scan = sub.add_parser(
        "record-scan",
        help="把一次 LLM 歧义扫描的确认清单留证（每次 plan 至多一次，幂等重放）",
    )
    scan.add_argument("--change-dir", required=True)
    scan.add_argument("--payload-file", default=None)
    scan.add_argument("--payload", default=None)
    scan.add_argument("--json", action="store_true")
    scan.set_defaults(func=_cmd_record_scan)
    confirm = sub.add_parser(
        "confirm",
        help="把确认清单的答案闭包写回报告（全部 answered 后状态转 passed）",
    )
    confirm.add_argument("--change-dir", required=True)
    confirm.add_argument("--payload-file", default=None)
    confirm.add_argument("--payload", default=None)
    confirm.add_argument("--json", action="store_true")
    confirm.set_defaults(func=_cmd_confirm)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
