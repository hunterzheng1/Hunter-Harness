#!/usr/bin/env python3
"""harness_task — 轻任务闭环（批次 1 试点，提案 §3/§10/§12）。

一条命令完成任务记录 → 验证 → 归档，替代模型手工编排阶段 Skill 与
plan-evidence-input.json。设计约束（2026-09-07 批次 0 基线）：

- 只接受 fast + standard 档（docs/config + 普通功能 + 局部缺陷修复）；
  full 信号（auth/security/migration/concurrency/artifact-protocol/
  shared-state/delete/contract-schema）→ 拒绝并转介 /harness-plan 完整流程。
- 验证不接受模型口述通过：命令从 build-profile verificationGraph
  解析或按变更定向选择（P1 docs-only→doc contract、P6 harness
  Python→定向 unittest、P5 同 argv 去重），经本脚本执行，结果写
  verification-ledger（提案 §4.6）。
- 错误信封带 code + field_path + problems[] + recoveryAction（直击
  F3：无 field_path 排障 25 min）。

复用既有程序化 API（不复制逻辑）：
- harness_change.migrate_change / resolve_change
- harness_state.capture_current_state
- harness_gate.classify_risk / apply_tier_override / persist_gate_policy
  （WI-F2：meta/gate-policy 工作副本的唯一文档构建写入口）
- harness_events.append_event
- harness_ledger（record 等价逻辑，含 profile-input 展开）
- harness_archive.execute_archive（record-only）

Python 3.10+ stdlib only. UTF-8 无 BOM. Windows 路径友好。
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
import time
import uuid
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_archive as ha  # noqa: E402
import harness_asset_outbox  # noqa: E402
import harness_change as hchg  # noqa: E402
import harness_events as he  # noqa: E402
import harness_gate as hg  # noqa: E402
import harness_ledger as hl  # noqa: E402
import harness_profile as hp  # noqa: E402
import harness_state as hs  # noqa: E402
import harness_test_runner as htr  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


# v2：新增 writeScope/dependsOn（WI-3.3 并行冲突检测与依赖门）；
# v1 读侧兼容——字段缺省即未声明，不参与检测。
TASK_SCHEMA_VERSION = 2
TASK_REL = Path("meta") / "task.json"
TASK_PHASE = "task"
# 终态集合：status 属于此集合且 change 目录仍在 .harness/changes/ 下时，
# 说明上次 finish 在「终态写入 → 归档」之间崩溃，走恢复通道（R3/O1）。
TERMINAL_TASK_STATUSES = ("completed", "abandoned", "superseded")
# 轻任务入口接受的档位；full 必须走完整流程（用户确认 2026-09-07）。
ACCEPTED_TIERS = ("fast", "standard")
# WI-1：触发 full 档拒绝的信号集从共享契约派生（risk-signals.json 的
# fullMarkers 键集 + gate 侧独立追加的 contract-schema），消除第三份漂移面。
FULL_MARKERS = (
    *tuple(sorted(hg._load_risk_signals_contract()["fullMarkers"])),
    "contract-schema",
)
# 档位严格度排序：begin --tier 声明的下限（floor）语义用——声明的档位
# 比 finish 裁决更高时抬升裁决，反之不压低（classify 信号升级仍生效）。
TIER_RANK = {"fast": 0, "standard": 1, "full": 2}
# 档位 → 验证序列（与 workflow-policy riskTiers.requiredValidations 对齐）。
TIER_VALIDATIONS = {
    "fast": ("unitTest",),
    "standard": ("compile", "unitTest", "unitTestFull"),
}
# 档位验证序列的回退链：profile 缺 target 时逐级向更广覆盖回退（F6：
# node 探测 profile 通常只声明 unitTestFull，compile/unitTest 无 target）。
# 回退记录真实执行的命令与证据，不伪造缺失项的 ledger。
VALIDATION_FALLBACK = {
    "unitTest": ("unitTestFull",),
    "compile": ("unitTest", "unitTestFull"),
}
# doc contract 测试的扫描范围（与 test_harness_doc_contract.py:23-26 的
# DOC_DIRS/DOC_NAMES 一致）：harness/protocols/*.md + harness/harness-*/
# 下的 SKILL.md/reference.md/checklist.md。docs-only 且命中此范围的
# 变更用 doc contract 测试替代回退链（P1）；范围外的 docs-only（如根
# README.md）保持回退——doc contract 覆盖不到，跑了不构成证据。
DOC_CONTRACT_DIRS = ("harness/protocols",)
DOC_CONTRACT_SKILL_PREFIX = "harness/harness-"
DOC_CONTRACT_NAMES = ("SKILL.md", "reference.md", "checklist.md")
# harness Python 源 → 测试模块的显式补充表（与
# scripts/changed-test-selection.mjs:101-134 的 PYTHON_TESTS_BY_PATH 对齐；
# 多测试映射的源必须显式列出，约定派生只覆盖单测试情形）。
PYTHON_TEST_MODULES_BY_SOURCE = {
    "harness/scripts/harness_archive.py": (
        "test_harness_archive",
        "test_harness_archive_c",
        "test_harness_archive_preflight",
        "test_harness_archive_remote",
    ),
    "harness/scripts/harness_gate.py": (
        "test_harness_gate",
        "test_harness_gate_severity",
    ),
    "harness/scripts/harness_ledger.py": (
        "test_harness_ledger",
        "test_harness_ledger_targets",
        "test_harness_ledger_v3",
    ),
}
PYTHON_SOURCE_PREFIX = "harness/scripts/harness_"
PYTHON_TEST_PREFIX = "harness/scripts/tests/test_"
CHANGE_NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def emit(payload: dict[str, Any], as_json: bool) -> None:
    if as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(payload, ensure_ascii=False))


def error_envelope(
    code: str,
    message: str,
    *,
    field_path: str | None = None,
    problems: list[str] | None = None,
    recovery_action: str | None = None,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """统一错误信封：F3 的教训是缺 field_path 时排障靠读源码。"""
    payload: dict[str, Any] = {
        "ok": False,
        "code": code,
        "message": message,
    }
    if field_path:
        payload["field_path"] = field_path
    if problems:
        payload["problems"] = list(problems)
    if recovery_action:
        payload["recoveryAction"] = recovery_action
    if extra:
        payload.update(extra)
    return payload


def read_json_file(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


# ---------------------------------------------------------------------------
# WI-E1（O3）：实际成果摘要——meta/outcome.json
#
# goal 与 outcome 分字段（禁止把 goal 复制成成功说明）；facts 全部由 finish
# 既有数据派生（diff/验证/closure/commit），模型不可写；模型只经 finish
# --outcome-* 参数补动机、取舍、残余风险与未验证项。空白不凑数：未提供的
# 字段为 null/空数组，绝不拿 goal 回填。写失败必须显示报错（O4：磁盘写入
# 失败显示未保存，不静默丢失）。
# ---------------------------------------------------------------------------

OUTCOME_REL = Path("meta") / "outcome.json"


def _read_outcome(change_dir: Path) -> dict[str, Any] | None:
    try:
        doc = json.loads(
            (Path(change_dir) / OUTCOME_REL).read_text(encoding="utf-8-sig")
        )
    except (OSError, json.JSONDecodeError):
        return None
    return doc if isinstance(doc, dict) else None


def write_outcome(
    change_dir: Path,
    *,
    task: dict[str, Any],
    closure: str,
    closure_reason: str,
    committed_hash: str | None,
    product_paths: list[str],
    verifications: list[dict[str, Any]],
    finished_at: str,
    outcome_input: dict[str, Any],
) -> tuple[dict[str, Any] | None, list[str]]:
    """写 meta/outcome.json（原子覆写，同参幂等——capturedAt 除外）。

    返回 (error_envelope | None, warnings)。completed 缺 summary →
    warning OUTCOME_SUMMARY_MISSING（不阻塞，不回填）。
    """
    doc = {
        "schemaVersion": 1,
        "changeId": Path(change_dir).name,
        "closure": closure,
        "goal": task.get("goal"),
        "outcome": {
            "summary": outcome_input.get("summary"),
            "motivation": outcome_input.get("motivation"),
            "residualRisks": list(outcome_input.get("residualRisks") or []),
            "nextSteps": list(outcome_input.get("nextSteps") or []),
            "unverifiedItems": list(outcome_input.get("unverifiedItems") or []),
        },
        "facts": {
            "commit": committed_hash,
            "changedFiles": sorted(
                str(p).replace("\\", "/") for p in product_paths
            ),
            "verifications": [
                {
                    "name": str(v.get("verification") or v.get("name") or ""),
                    "status": str(v.get("status") or ""),
                    "exitCode": v.get("exitCode"),
                }
                for v in verifications
            ],
            "closureReason": closure_reason or None,
            "finishedAt": finished_at,
        },
        "capturedAt": now_iso(),
    }
    warnings: list[str] = []
    if closure == "completed" and not doc["outcome"]["summary"]:
        warnings.append("OUTCOME_SUMMARY_MISSING")
    try:
        hs.write_json(Path(change_dir) / OUTCOME_REL, doc)
    except OSError as exc:
        return (
            error_envelope(
                "OUTCOME_WRITE_FAILED",
                f"成果摘要写入失败（{exc}）——任务保持 open，未静默丢失",
                field_path="meta/outcome.json",
                recovery_action="排除文件系统问题后重跑 finish",
            ),
            warnings,
        )
    return None, warnings


def _summary_block(
    change_dir: Path,
    *,
    verifications: list[dict[str, Any]],
    no_verify_note: str,
    default_risk: str,
    code_location: str,
    outcome_doc: dict[str, Any] | None = None,
) -> dict[str, str]:
    """stdout summary 是 meta/outcome.json 的派生展示（权威只有 outcome.json）。

    完成内容/残余风险改读 outcome；缺失时给占位文案，绝不回退成 goal。
    outcome_doc：归档后 change_dir 已被移走，调用方在归档前缓存传入；
    缺省从盘读（恢复通道——目录被移回，outcome.json 随档在）。
    """
    if outcome_doc is None:
        outcome_doc = _read_outcome(change_dir)
    outcome = (outcome_doc or {}).get("outcome") or {}
    summary_text = (
        outcome.get("summary") or "（未记录成果摘要——见 meta/outcome.json）"
    )
    risks = [
        str(r) for r in (outcome.get("residualRisks") or []) if str(r).strip()
    ]
    return {
        "完成内容": summary_text,
        "验证结果": (
            "；".join(
                f"{v['verification']}={v['status']}({v['durationMs']}ms)"
                for v in verifications
            )
            or no_verify_note
        ),
        "残余风险": "；".join(risks) if risks else default_risk,
        "代码位置": code_location,
    }


def load_task(change_dir: Path) -> dict[str, Any] | None:
    path = change_dir / TASK_REL
    if not path.is_file():
        return None
    try:
        data = read_json_file(path)
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def git_text(project: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", *args],
        cwd=project,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    return proc.stdout.strip() if proc.returncode == 0 else ""


def _dirty_paths(project: Path) -> list[str]:
    """git status --porcelain 的路径列表（XY <path>，不能 strip 整行）。

    重命名 `R  old -> new` 拆成两侧：old 视为删除（预存删除同样会被
    add -A 扫进提交），new 为脏路径。
    """
    proc = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=project,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    paths: list[str] = []
    for line in proc.stdout.splitlines():
        if not line.strip():
            continue
        raw = line[3:].strip().strip('"')
        if " -> " in raw:
            old, new = raw.split(" -> ", 1)
            paths.extend((old.strip().strip('"'), new.strip().strip('"')))
        else:
            paths.append(raw)
    return paths


def _file_sha256(path: Path) -> str | None:
    try:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(65536), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None


def capture_dirty_baseline(project: Path) -> dict[str, str]:
    """begin 时刻的脏树基线：路径 → 内容 sha256（排除 .harness/**）。

    finish 的外来路径检测用它做非循环判定：begin 前就脏、finish 时内容
    未变 → 任务从未触碰的外来路径（git add -A 会误扫进提交，必须拒绝）；
    内容变了或新出现 → 任务自身的工作，属产品路径。
    classify_risk 首跑时无 ownership 契约，非 .harness 路径全部进
    productPaths（harness_gate.py:1494-1497），foreignPaths 恒空——
    从 diff 自身派生契约是循环论证，检测不了预存脏路径。
    已删除路径记 "<deleted>" 哨兵：预存删除同样会被 add -A 扫进提交。
    """
    baseline: dict[str, str] = {}
    for rel in _dirty_paths(project):
        normalized = rel.replace("\\", "/")
        if normalized.startswith(".harness/"):
            continue
        absolute = project / normalized
        if absolute.is_file():
            digest = _file_sha256(absolute)
            if digest is not None:
                baseline[normalized] = digest
        else:
            baseline[normalized] = "<deleted>"
    return baseline


def detect_foreign_dirt(
    project: Path, baseline: dict[str, str]
) -> list[str]:
    """对照 begin 基线找外来脏路径：仍脏且内容未变 → foreign。"""
    foreign: list[str] = []
    for rel in _dirty_paths(project):
        normalized = rel.replace("\\", "/")
        if normalized.startswith(".harness/"):
            continue
        if normalized not in baseline:
            continue  # 任务期间新出现的路径——任务自身的工作
        absolute = project / normalized
        digest = _file_sha256(absolute) if absolute.is_file() else "<deleted>"
        if digest == baseline[normalized]:
            foreign.append(normalized)  # 内容未变——任务从未触碰
    return sorted(foreign)


def resolve_change_dir(project: Path, change: str) -> tuple[Path | None, dict[str, Any]]:
    resolved = hchg.resolve_change(project, change)
    if resolved.get("ok"):
        return Path(resolved["changeDir"]), resolved
    return None, resolved


# ---------------------------------------------------------------------------
# begin
# ---------------------------------------------------------------------------

def _normalize_write_scope(raw: list[str] | None) -> tuple[list[str] | None, list[str]]:
    """begin --write-scope 规范化：POSIX 相对路径、去尾斜杠、去重保序。

    返回 (规范化结果, problems)；raw 为 None（未带参数）时返回 (None, [])
    表示「未声明」。声明是 begin 时的事实输入，格式非法即拒（不建目录）。
    """
    if raw is None:
        return None, []
    problems: list[str] = []
    normalized: list[str] = []
    for item in raw:
        text = str(item).strip().replace("\\", "/")
        if text.startswith("/") or re.match(r"^[A-Za-z]:", text):
            problems.append(f"writeScope 必须是仓库相对路径（非绝对路径）: {item!r}")
            continue
        if ".." in text.split("/"):
            problems.append(f"writeScope 不允许父级引用 '..': {item!r}")
            continue
        text = text.strip("/")
        if not text:
            problems.append("writeScope 不允许空路径")
            continue
        if text not in normalized:
            normalized.append(text)
    return normalized, problems


def _normalize_depends_on(raw: list[str] | None) -> list[str] | None:
    """begin --depends-on 规范化：strip、去空、去重保序；None 表示未声明。

    非法 change 名不单独拒绝——存在性检查会以 TASK_DEPENDENCY_MISSING 兜底。
    """
    if raw is None:
        return None
    out: list[str] = []
    for item in raw:
        name = str(item).strip()
        if name and name not in out:
            out.append(name)
    return out


def _paths_overlap(a: str, b: str) -> bool:
    """前缀包含语义：相等或一方是另一方的父目录即视为相交。"""
    return a == b or a.startswith(b + "/") or b.startswith(a + "/")


def _detect_scope_conflicts(
    project: Path, self_change: str, write_scope: list[str]
) -> tuple[list[dict[str, Any]], list[str]]:
    """扫 .harness/changes/ 下其他 open 任务的 writeScope（排除自身与归档目录）。

    返回 (conflicts, unscoped_change_ids)：conflicts 带相交路径明细；
    unscoped 是未声明 scope 的 open 任务（仅提示，不阻塞）。
    """
    conflicts: list[dict[str, Any]] = []
    unscoped: list[str] = []
    changes_root = project / ".harness" / "changes"
    if not changes_root.is_dir():
        return conflicts, unscoped
    for child in sorted(changes_root.iterdir()):
        if not child.is_dir() or child.name == self_change:
            continue
        doc = load_task(child)
        if doc is None or doc.get("status") != "open":
            continue
        other = [str(p) for p in (doc.get("writeScope") or []) if str(p).strip()]
        if not other:
            unscoped.append(child.name)
            continue
        hits = sorted(
            {
                mine
                for mine in write_scope
                for theirs in other
                if _paths_overlap(mine, theirs)
            }
        )
        if hits:
            conflicts.append({"changeId": child.name, "overlaps": hits})
    return conflicts, unscoped


def _detect_dependency_cycle(
    project: Path, self_change: str, depends_on: list[str]
) -> list[str] | None:
    """从 self 沿 dependsOn 图 DFS：回到 self 返回环路径，否则 None。

    缺失节点视为无出边（存在性由 TASK_DEPENDENCY_MISSING 单独报告）；
    self 的出边直接用本次声明值（首次 begin 时盘上尚无 task.json）。
    """
    changes_root = project / ".harness" / "changes"

    def _deps_of(name: str) -> list[str]:
        if name == self_change:
            return list(depends_on)
        doc = load_task(changes_root / name)
        if doc is None:
            return []
        return [str(d) for d in (doc.get("dependsOn") or [])]

    visited: set[str] = set()
    stack: list[tuple[str, list[str]]] = [(self_change, [self_change])]
    while stack:
        node, path = stack.pop()
        if node in visited:
            continue
        visited.add(node)
        for nxt in _deps_of(node):
            if nxt == self_change:
                return path + [nxt]
            if nxt not in visited:
                stack.append((nxt, path + [nxt]))
    return None


def load_task_events(change_dir: Path) -> list[dict[str, Any]]:
    events_path = change_dir / "events.ndjson"
    if not events_path.is_file():
        return []
    try:
        return [
            json.loads(line)
            for line in events_path.read_text(encoding="utf-8-sig").splitlines()
            if line.strip()
        ]
    except (OSError, json.JSONDecodeError):
        return []


def find_open_task_start(events: list[dict[str, Any]]) -> dict[str, Any] | None:
    """最近一个未关闭的 task phase.start（run_id 无对应 phase.end）。"""
    for item in reversed(events):
        if not (
            isinstance(item, dict)
            and item.get("phase") == TASK_PHASE
            and item.get("type") == "phase.start"
        ):
            continue
        run_id = item.get("run_id")
        closed = any(
            isinstance(other, dict)
            and other.get("phase") == TASK_PHASE
            and other.get("type") in ("phase.end", "phase.auto_sealed")
            and other.get("run_id") == run_id
            for other in events
        )
        if not closed:
            return item
    return None


def cmd_begin(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    project = Path(args.project).resolve()
    change = str(args.change or "").strip()
    goal = str(args.goal or "").strip()
    acceptance = [str(item).strip() for item in (args.acceptance or []) if str(item).strip()]
    executor = str(args.executor or "").strip() or "unknown"
    declared_tier = str(args.tier) if getattr(args, "tier", None) else None

    problems: list[str] = []
    if not change:
        problems.append("--change is required (kebab-case, e.g. fix-docs-count)")
    elif not CHANGE_NAME_RE.fullmatch(change):
        problems.append(
            f"--change must match {CHANGE_NAME_RE.pattern}; got: {change!r}"
        )
    if not goal:
        problems.append("--goal is required (one sentence, becomes businessGoal)")
    if not acceptance:
        problems.append(
            "--acceptance is required and repeatable "
            "(at least one verifiable condition)"
        )
    if problems:
        emit(
            error_envelope(
                "TASK_INPUT_INVALID",
                "begin 输入不完整或非法",
                field_path="args",
                problems=problems,
                recovery_action=(
                    "python <skills-root>/scripts/harness_task.py begin "
                    "--project . --change <kebab-case-id> --executor <tool> "
                    '--goal "<目标一句话>" --acceptance "<可验证条件>" '
                    "(--acceptance 可重复) --json"
                ),
            ),
            as_json,
        )
        return 2

    harness_root = project / ".harness"
    if not harness_root.is_dir():
        emit(
            error_envelope(
                "PROJECT_ROOT_INVALID",
                f"{harness_root} 不存在——该项目尚未初始化，先运行 hunter-harness init",
                recovery_action="npx hunter-harness init --profile general",
            ),
            as_json,
        )
        return 2

    change_dir = project / ".harness" / "changes" / change
    existing_task = load_task(change_dir)
    if existing_task is not None and existing_task.get("status") != "open":
        emit(
            error_envelope(
                "TASK_ALREADY_FINISHED",
                f"change {change} 已处于终态 {existing_task.get('status')!r}，"
                "不得重复 begin；如需新任务请换 change 名",
                field_path="meta/task.json.status",
                recovery_action=f"harness_task.py status --project . --change {change} --json",
            ),
            as_json,
        )
        return 2

    # --tier full：轻任务入口不承接 full 档工作，立即拒绝且不建 change
    # 目录（无孤儿目录）。P12 修复：显式声明也必须走 /harness-plan。
    if declared_tier == "full":
        emit(
            error_envelope(
                "TASK_TIER_UPGRADE_REQUIRED",
                "--tier full 超出轻任务入口承接范围——契约/schema 邻接或"
                "高风险变更请走 /harness-plan 完整流程",
                field_path="args.tier",
                recovery_action=(
                    "/harness-plan（完整五阶段流程：plan→execute→review→"
                    "submit→archive）"
                ),
            ),
            as_json,
        )
        return 3

    # 重声明冲突守卫：同一 change 不得改口声明档位（防止事后降级声明）。
    if (
        existing_task is not None
        and declared_tier is not None
        and existing_task.get("declaredTier") not in (None, declared_tier)
    ):
        emit(
            error_envelope(
                "TASK_INPUT_INVALID",
                f"change {change} 已声明档位 "
                f"{existing_task.get('declaredTier')!r}，不得改口为 {declared_tier!r}",
                field_path="args.tier",
                recovery_action=(
                    f"harness_task.py status --project . --change {change} --json"
                ),
            ),
            as_json,
        )
        return 2

    # WI-3.3：写入范围与依赖声明校验。全部失败路径都不建 change 目录
    # （对齐 --tier full 先例：begin 拒绝不留孤儿目录）。
    # getattr 防御：既有测试/调用方手工构造 Namespace 时可能缺新属性
    # （对齐 args.tier 的处理先例）。
    write_scope, scope_problems = _normalize_write_scope(
        getattr(args, "write_scope", None)
    )
    depends_on = _normalize_depends_on(getattr(args, "depends_on", None))
    if scope_problems:
        emit(
            error_envelope(
                "TASK_SCOPE_INVALID",
                "--write-scope 声明非法：须为仓库相对 POSIX 路径，"
                "不允许绝对路径 / 父级引用 / 空路径",
                field_path="args.write_scope",
                problems=scope_problems,
                recovery_action=(
                    "示例：--write-scope src/auth --write-scope docs/api.md"
                ),
            ),
            as_json,
        )
        return 2

    # 声明不可改（对齐 declaredTier 守卫语义）：open 任务重复 begin 时，
    # 未带参数 = 不表态（幂等放行）；带参数且与既有声明不同 = 拒绝。
    # 改范围 = 新协调，须 abandon 后以新声明重开。
    if existing_task is not None:
        existing_scope = existing_task.get("writeScope") or None
        existing_depends = existing_task.get("dependsOn") or None
        redeclared: list[str] = []
        if write_scope and existing_scope is not None and existing_scope != write_scope:
            redeclared.append(
                f"writeScope: 已声明 {existing_scope}，不得改口为 {write_scope}"
            )
        if depends_on and existing_depends is not None and existing_depends != depends_on:
            redeclared.append(
                f"dependsOn: 已声明 {existing_depends}，不得改口为 {depends_on}"
            )
        if redeclared:
            emit(
                error_envelope(
                    "TASK_SCOPE_REDECLARED",
                    f"change {change} 的 begin 声明不可改——"
                    "改范围/改依赖须先 abandon 再以新声明重开",
                    field_path="meta/task.json",
                    problems=redeclared,
                    recovery_action=(
                        f"harness_task.py finish --project . --change {change} "
                        "--closure abandoned --closure-reason 重声明 --json"
                    ),
                ),
                as_json,
            )
            return 2

    # 生效声明 = 既有声明优先（幂等复用/补声明场景），否则本次新声明。
    effective_scope = (
        (existing_task.get("writeScope") or None) if existing_task is not None else None
    ) or (write_scope or None)
    effective_depends = (
        (existing_task.get("dependsOn") or None) if existing_task is not None else None
    ) or (depends_on or None)

    # 依赖门：先环检测（图结构问题，不看状态），再存在性，再完成状态。
    # 目标 abandoned/superseded 同样阻塞——不可强行 begin，须先重开/替换依赖。
    if effective_depends:
        cycle = _detect_dependency_cycle(project, change, effective_depends)
        if cycle is not None:
            emit(
                error_envelope(
                    "TASK_DEPENDENCY_CYCLE",
                    f"依赖声明成环: {' → '.join(cycle)}",
                    field_path="args.depends_on",
                    extra={"cycle": cycle},
                    recovery_action="解开环后重试（调整 --depends-on 声明）",
                ),
                as_json,
            )
            return 2
        changes_root = project / ".harness" / "changes"
        missing_deps: list[str] = []
        unmet_deps: list[str] = []
        for dep in effective_depends:
            dep_doc = load_task(changes_root / dep)
            if dep_doc is None:
                missing_deps.append(dep)
                continue
            dep_status = str(dep_doc.get("status") or "open")
            if dep_status != "completed":
                unmet_deps.append(f"{dep}(status={dep_status})")
        if missing_deps:
            emit(
                error_envelope(
                    "TASK_DEPENDENCY_MISSING",
                    f"依赖的 change 不存在: {', '.join(missing_deps)}",
                    field_path="args.depends_on",
                    problems=[f"missing: {dep}" for dep in missing_deps],
                    recovery_action="确认依赖 change 名，或先 begin 该依赖任务",
                ),
                as_json,
            )
            return 2
        if unmet_deps:
            emit(
                error_envelope(
                    "TASK_DEPENDENCY_UNMET",
                    "依赖目标未达 completed，不允许 begin"
                    "（依赖语义不腐蚀——先等待/重开/替换依赖）",
                    field_path="args.depends_on",
                    problems=[f"unmet: {dep}" for dep in unmet_deps],
                    recovery_action=(
                        "依赖目标完成后重试；目标 abandoned/superseded 时"
                        "须重开或替换依赖（不可强行 begin）"
                    ),
                ),
                as_json,
            )
            return 2

    # 写入范围冲突检测：仅双方均声明时判定（既有未声明 open 任务只提示）。
    unscoped_open: list[str] = []
    if effective_scope:
        conflicts, unscoped_open = _detect_scope_conflicts(
            project, change, effective_scope
        )
        if conflicts:
            conflict_ids = [item["changeId"] for item in conflicts]
            emit(
                error_envelope(
                    "TASK_SCOPE_CONFLICT",
                    f"写入范围与 open 任务 {', '.join(conflict_ids)} 相交，"
                    "拒绝并行 begin",
                    field_path="args.write_scope",
                    problems=[
                        f"conflict with {item['changeId']}: "
                        f"{', '.join(item['overlaps'])}"
                        for item in conflicts
                    ],
                    recovery_action=(
                        "等待冲突任务 finish 后重试（begin 拒绝零副作用，"
                        "可直接重跑）；或收窄 --write-scope 到不相交范围"
                    ),
                    extra={
                        "conflicts": conflicts,
                        "unscopedOpenChanges": unscoped_open,
                    },
                ),
                as_json,
            )
            return 2

    created = not change_dir.is_dir()
    if created:
        (change_dir / "meta").mkdir(parents=True, exist_ok=True)

    migrated = hchg.migrate_change(project, change)
    if not migrated.get("ok"):
        emit(
            error_envelope(
                str(migrated.get("code", "MIGRATE_FAILED")),
                str(migrated.get("message", "migrate_change failed")),
            ),
            as_json,
        )
        return 2

    # 首次 capture 固化不可变 changeBase（design §3.6）。
    snapshot, _changed = hs.capture_current_state(
        project=project,
        change_dir=change_dir,
        change_name=change,
        worktree_root=project,
    )
    git_state = snapshot.get("git") or {}

    if existing_task is None:
        task_doc = {
            "schemaVersion": TASK_SCHEMA_VERSION,
            "changeId": change,
            "goal": goal,
            "acceptance": acceptance,
            "executor": executor,
            "status": "open",
            "tier": None,
            # begin --tier 声明的档位下限；tier 仍是 finish 裁决值。
            "declaredTier": declared_tier,
            # WI-3.3：写入范围与依赖声明（None = 未声明，不参与检测）。
            "writeScope": effective_scope,
            "dependsOn": effective_depends,
            "createdAt": now_iso(),
            "finishedAt": None,
            # begin 时刻脏树基线：finish 的外来路径检测基准（非循环）。
            "dirtyBaseline": capture_dirty_baseline(project),
        }
        hs.write_json(change_dir / TASK_REL, task_doc)
    else:
        task_doc = existing_task
        # 既有任务补声明：之前 begin 未带参数、现在带了 → 补写
        # （同值幂等；不同值已被上面的重声明守卫拒绝）。
        task_dirty = False
        if declared_tier is not None and task_doc.get("declaredTier") is None:
            task_doc["declaredTier"] = declared_tier
            task_dirty = True
        if write_scope and not task_doc.get("writeScope"):
            task_doc["writeScope"] = write_scope
            task_dirty = True
        if depends_on and not task_doc.get("dependsOn"):
            task_doc["dependsOn"] = depends_on
            task_dirty = True
        if task_dirty:
            hs.write_json(change_dir / TASK_REL, task_doc)

    # phase.start 幂等：已有未关闭的 task phase.start 则复用，不重复追加。
    # attempt 不硬编码：append_with_auto_seal 自动取 phase 内最大 attempt+1
    # （harness_events.py:1889-1892），归档失败回滚后重跑 begin 不会与
    # 旧 attempt=1 的 phase.end 撞车（PHASE_ALREADY_CLOSED）。
    events = load_task_events(change_dir)
    open_start = find_open_task_start(events)
    run_id = None
    if open_start is None:
        run_id = f"task_{uuid.uuid4()}"
        appended = he.append_event(
            change_dir,
            phase=TASK_PHASE,
            type_="phase.start",
            run_id=run_id,
            executor_tool=executor,
            note=f"/harness-task 轻任务开始：{goal[:60]}",
        )
        if not appended.get("ok"):
            emit(
                error_envelope(
                    str(appended.get("code", "EVENT_APPEND_FAILED")),
                    str(appended.get("message", "phase.start append failed")),
                ),
                as_json,
            )
            return 2
    else:
        run_id = str(open_start.get("run_id") or "")

    decision = he.append_event(
        change_dir,
        phase=TASK_PHASE,
        type_="decision",
        note=f"任务目标：{goal}；验收：{'；'.join(acceptance)}",
    )
    if not decision.get("ok"):
        emit(
            error_envelope(
                str(decision.get("code", "EVENT_APPEND_FAILED")),
                str(decision.get("message", "decision append failed")),
            ),
            as_json,
        )
        return 2

    # WI-E3（O4）：下次启动续跑钩子——reap 过期租约 + asset-outbox 摘要。
    # best-effort：队列损坏只记 warning，不阻塞 begin（参照 12-m3 reconcile）。
    try:
        asset_outbox_summary: dict[str, Any] = harness_asset_outbox.maintenance(project)
    except Exception as exc:  # noqa: BLE001 —— best-effort 钩子不得阻塞 begin
        asset_outbox_summary = {
            "warning": "ASSET_OUTBOX_MAINTENANCE_FAILED",
            "error": f"{type(exc).__name__}: {exc}",
        }

    emit(
        {
            "ok": True,
            "code": "TASK_BEGUN",
            "changeId": change,
            "changeDir": str(change_dir),
            "changeCreated": created,
            "runId": run_id,
            "assetOutbox": asset_outbox_summary,
            "goal": task_doc.get("goal"),
            "acceptance": task_doc.get("acceptance"),
            "declaredTier": task_doc.get("declaredTier"),
            "writeScope": task_doc.get("writeScope"),
            "dependsOn": task_doc.get("dependsOn"),
            # WI-3.3：未声明 scope 的 open 任务（不参与冲突检测，仅提示）。
            "unscopedOpenChanges": unscoped_open,
            "changeBase": git_state.get("base"),
            "head": git_state.get("head"),
            "nextAction": (
                "自由探索/编辑/测试；完成后运行 "
                f"harness_task.py finish --project . --change {change} --json"
            ),
        },
        as_json,
    )
    return 0


# ---------------------------------------------------------------------------
# finish — 编排步骤（计划 §命令面）
# ---------------------------------------------------------------------------

def _tier_from_classification(payload: dict[str, Any]) -> tuple[str | None, list[str]]:
    """从 classify_risk(post-run) 的 signals 裁决档位。

    classify 的单调升级只升不降（F5：docs-only 不会把默认 standard 降为
    fast），轻任务入口自己裁决：full 信号 → 拒绝；docs-only / 无产品 diff
    → fast；其余 → standard。
    """
    signals = [str(item) for item in (payload.get("signals") or [])]
    full_hits = sorted(set(signals) & set(FULL_MARKERS))
    if full_hits:
        return None, full_hits
    if "docs-only" in signals or "no-code-diff" in signals:
        return "fast", []
    return "standard", []


def _apply_tier_floors(
    tier: str,
    recorded_tier: str,
    declared_tier: Any,
    classification: dict[str, Any],
) -> str:
    """档位下限调整（recorded_tier 保留 + begin 声明 floor），两处裁决共用。

    - 补归档重跑（无新 diff）时沿用上次裁决的档位，避免 standard 工作
      被改记成 fast；
    - begin --tier 声明的档位比裁决高时抬升，反之不压低（full 信号升级
      拒绝不受此影响）。
    """
    if (
        tier == "fast"
        and recorded_tier in ACCEPTED_TIERS
        and "no-code-diff"
        in [str(s) for s in (classification.get("signals") or [])]
    ):
        tier = recorded_tier
    if (
        declared_tier in ACCEPTED_TIERS
        and TIER_RANK[declared_tier] > TIER_RANK[tier]
    ):
        tier = declared_tier
    return tier


def _resolve_verification_argv(
    project: Path, verification: str
) -> tuple[str, list[str] | None]:
    """解析验证命令 argv；返回 (resolved_name, argv|None)。

    verificationGraph.targets.<key>.argvTemplate 是权威命令模板
    （harness_profile._derive_verification_graph 直接从 commands 派生）。
    缺 target 时按 VALIDATION_FALLBACK 向更广覆盖回退（F6）。
    """
    profile = hp.load_profile(project)
    graph = profile.get("verificationGraph") if isinstance(profile, dict) else None
    targets = graph.get("targets") if isinstance(graph, dict) else None
    if not isinstance(targets, dict):
        return verification, None
    candidates = [verification, *VALIDATION_FALLBACK.get(verification, ())]
    for name in candidates:
        target = targets.get(name)
        if not isinstance(target, dict):
            continue
        argv = [str(tok) for tok in (target.get("argvTemplate") or [])]
        if not argv:
            # 兼容只声明 commandKey 的 target：回退 commands.<commandKey>。
            command_key = str(target.get("commandKey") or name)
            try:
                resolved = hp.resolve_command(profile, command_key)
            except KeyError:
                resolved = None
            argv = [str(tok) for tok in ((resolved or {}).get("argv") or [])]
        if argv:
            return name, argv
    return verification, None


def _doc_contract_scope_paths(product_paths: list[str]) -> list[str]:
    """product_paths 中落在 doc contract 测试扫描范围内的子集（P1）。

    范围 = harness/protocols/<name>.md + harness/harness-*/{SKILL,reference,
    checklist}.md（与 test_harness_doc_contract.py 的 DOC_DIRS/DOC_NAMES
    一致）。范围外的 docs-only 变更保持回退链。
    """
    scoped: list[str] = []
    for path in product_paths:
        normalized = path.replace("\\", "/")
        if any(
            normalized.startswith(f"{prefix}/") and normalized.endswith(".md")
            for prefix in DOC_CONTRACT_DIRS
        ):
            scoped.append(normalized)
            continue
        name = normalized.rsplit("/", 1)[-1]
        if (
            name in DOC_CONTRACT_NAMES
            and normalized.startswith(DOC_CONTRACT_SKILL_PREFIX)
            and normalized.count("/") == 2
        ):
            scoped.append(normalized)
    return sorted(set(scoped))


def _python_test_modules_for_paths(
    product_paths: list[str], project: Path
) -> list[str]:
    """变更路径 → 定向 Python unittest 模块名（P6）。

    映射规则（与 scripts/changed-test-selection.mjs 对齐）：
    1. 变更本身是 harness/scripts/tests/test_X.py → 模块 test_X
    2. 显式补充表（多测试映射：archive/gate/ledger）
    3. 约定派生：harness/scripts/harness_X.py → test_harness_X（存在才用）
    无命中 → 空列表（调用方保持回退链）。
    """
    tests_dir = project / "harness" / "scripts" / "tests"
    modules: set[str] = set()
    for path in product_paths:
        normalized = path.replace("\\", "/")
        if normalized.startswith(PYTHON_TEST_PREFIX) and normalized.endswith(".py"):
            modules.add(Path(normalized).stem)
            continue
        if not normalized.startswith(PYTHON_SOURCE_PREFIX):
            continue
        if normalized in PYTHON_TEST_MODULES_BY_SOURCE:
            modules.update(PYTHON_TEST_MODULES_BY_SOURCE[normalized])
            continue
        derived = "test_" + Path(normalized).stem
        if (tests_dir / f"{derived}.py").is_file():
            modules.add(derived)
    return sorted(modules)


def _plan_verifications(
    tier: str,
    signals: list[str],
    product_paths: list[str],
    project: Path,
) -> list[dict[str, Any]]:
    """变更感知的验证计划（P1/P5/P6）。

    输入：档位验证序列（TIER_VALIDATIONS）+ classify signals + 产品路径。
    输出：有序计划项 [{name, argv, resolvedAs, reason, profile_input,
    files, cwd}]。规则：
    - P5：按 resolved argv 元组去重——三项全解析到同一 argv 时只保留
      首个可执行项，去重项标 dedupedFrom（不执行、不重复记 ledger）。
    - P1：docs-only 且命中 doc contract 扫描范围 → unitTest 项替换为
      doc contract 测试（~1s，对照回退链 npm 全链 ~260s）。
    - P6：harness Python 源/测试变更 → unitTest 项替换为定向 unittest
      （~5s）；compile/unitTestFull 不替换（编译面+全量回归本就该跑
      全链），但受 P5 去重约束。
    """
    plan: list[dict[str, Any]] = []
    seen_argv: dict[tuple[str, ...], str] = {}
    doc_scoped = _doc_contract_scope_paths(product_paths)
    python_modules = _python_test_modules_for_paths(product_paths, project)
    tests_dir = project / "harness" / "scripts" / "tests"

    for verification in TIER_VALIDATIONS[tier]:
        item: dict[str, Any] = {
            "name": verification,
            "argv": None,
            "resolvedAs": verification,
            "reason": "fallback",
            "profile_input": verification,
            "files": None,
            "cwd": None,
        }
        targeted = False
        if verification == "unitTest" and "docs-only" in signals and doc_scoped:
            # P1：doc contract 测试覆盖全部被改文档的 CLI 引用契约。
            item["argv"] = [sys.executable, "-m", "unittest", "test_harness_doc_contract"]
            item["resolvedAs"] = "unitTest"
            item["reason"] = "doc-contract"
            item["profile_input"] = None
            item["files"] = sorted(set(doc_scoped))
            item["cwd"] = tests_dir
            targeted = True
        elif verification == "unitTest" and python_modules:
            # P6：定向 unittest 只测变更相关的测试模块。
            item["argv"] = [sys.executable, "-m", "unittest", *python_modules]
            item["resolvedAs"] = "unitTest"
            item["reason"] = "python-targeted"
            item["profile_input"] = None
            item["files"] = sorted(
                set(product_paths)
                | {
                    f"harness/scripts/tests/{module}.py"
                    for module in python_modules
                }
            )
            item["cwd"] = tests_dir
            targeted = True
        if not targeted:
            resolved_name, argv = _resolve_verification_argv(project, verification)
            item["resolvedAs"] = resolved_name
            item["argv"] = argv
            # ledger 的 profile-input 键用 resolved 名（verificationInputs
            # 只有真实 target 的键；名义名会触发 profile 刷新误报）。
            item["profile_input"] = resolved_name
            if argv is None:
                # 无可执行 target：保留占位项，_run_verification 报
                # VERIFICATION_TARGET_MISSING（现状语义不变）。
                plan.append(item)
                continue

        argv_key = tuple(item["argv"] or [])
        if argv_key and argv_key in seen_argv:
            # P5：同一 argv 已在计划中——去重，不重复执行/记账。
            plan.append(
                {
                    "name": verification,
                    "argv": None,
                    "resolvedAs": item["resolvedAs"],
                    "reason": "deduped",
                    "dedupedFrom": seen_argv[argv_key],
                    "profile_input": None,
                    "files": None,
                    "cwd": None,
                }
            )
            continue
        if argv_key:
            seen_argv[argv_key] = verification
        plan.append(item)
    return plan


def _split_shell_chain(argv: list[str]) -> list[list[str]]:
    """把 argvTemplate 里的 `&&` 链拆成顺序段（不引入 shell）。

    node 探测的 profile 会给 `npm run lint && npm test` 这类 shell 命令串
    拆出的 argvTemplate（['npm','run','lint','&&','npm','test']）——
    validate_managed_argv 对批处理参数里的命令解释符 fail-closed，
    轻任务按 `&&` 边界拆段顺序执行，语义等价且无 shell 注入面。
    """
    segments: list[list[str]] = []
    current: list[str] = []
    for token in argv:
        if token == "&&":
            if current:
                segments.append(current)
            current = []
        else:
            current.append(token)
    if current:
        segments.append(current)
    return segments or [argv]


def _run_verification(
    project: Path, change_dir: Path, item: dict[str, Any]
) -> tuple[dict[str, Any], dict[str, Any] | None]:
    """执行一项验证计划项并写 ledger；返回 (summary, error_envelope|None)。

    item 来自 _plan_verifications：{name, argv, resolvedAs, reason,
    profile_input, files, cwd}。回退项 ledger 记录真实执行的验证名
    （如 unitTestFull），缺失项不伪造；定向项（doc-contract /
    python-targeted）以 unitTest + 显式 files 记账（derive_coverage →
    "incremental"，恰是定向测试的真实覆盖语义）。
    执行走 harness_test_runner.run_managed_command（PATH/PATHEXT 解析 +
    进程树隔离 + 超时），与 test_runner exec 同一安全面。
    """
    verification = str(item["name"])
    argv = item.get("argv")
    if not argv:
        return {}, error_envelope(
            "VERIFICATION_TARGET_MISSING",
            f"build-profile 未声明验证目标 {verification}（含回退链）",
            field_path=f"verificationGraph.targets.{verification}",
            recovery_action=(
                "python <skills-root>/scripts/harness_preflight.py detect "
                "--project . --json（重新探测 build-profile）"
            ),
        )

    evidence_dir = change_dir / "evidence"
    evidence_dir.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    evidence_rel = f"evidence/{verification}-{stamp}.log"
    evidence_path = change_dir / evidence_rel

    segments = _split_shell_chain(argv)
    started = time.perf_counter()
    exit_code = 0
    log_parts: list[str] = [f"$ {' '.join(argv)}"]
    for index, segment in enumerate(segments):
        try:
            result = htr.run_managed_command(
                segment,
                cwd=Path(item["cwd"]) if item.get("cwd") else project,
                timeout_seconds=1800,
                capture_output=True,
            )
            segment_exit = 1 if result.timed_out else result.returncode
            output_tail = result.output_tail or ""
        except (htr.ManagedCommandNotFound, htr.ManagedCommandUnsafe) as exc:
            return {}, error_envelope(
                "VERIFICATION_COMMAND_UNRESOLVED",
                f"验证命令无法安全执行：{exc}",
                field_path=f"verificationGraph.targets.{verification}.argvTemplate",
                recovery_action=(
                    "检查 build-profile 的 argvTemplate；含 shell 解释符的"
                    "命令串需拆成单命令或改用原生可执行文件"
                ),
            )
        log_parts.append(
            f"[segment {index + 1}/{len(segments)}] $ {' '.join(segment)}\n"
            f"exit={segment_exit}\n{output_tail}\n"
        )
        if segment_exit != 0:
            exit_code = segment_exit
            break  # && 语义：前段失败后段不执行
    duration_ms = max(0, int(round((time.perf_counter() - started) * 1000)))
    log_text = f"exit={exit_code}\n" + "\n".join(log_parts) + "\n"
    evidence_path.write_text(log_text, encoding="utf-8", newline="\n")

    status = "OK" if exit_code == 0 else "FAIL"
    record_error = _record_ledger_entry(
        project=project,
        change_dir=change_dir,
        verification=str(item.get("resolvedAs") or verification),
        status=status,
        command=" ".join(argv),
        exit_code=exit_code,
        duration_ms=duration_ms,
        evidence=evidence_rel,
        profile_input=item.get("profile_input"),
        files=item.get("files"),
    )
    if record_error is not None:
        return {}, record_error

    summary = {
        "verification": verification,
        "resolvedAs": item.get("resolvedAs") or verification,
        "status": status,
        "exitCode": exit_code,
        "durationMs": duration_ms,
        "evidence": evidence_rel,
        "command": " ".join(argv),
        "reason": item.get("reason") or "fallback",
    }
    if item.get("dedupedFrom"):
        summary["dedupedFrom"] = item["dedupedFrom"]
    return summary, None


def _record_ledger_entry(
    *,
    project: Path,
    change_dir: Path,
    verification: str,
    status: str,
    command: str,
    exit_code: int,
    duration_ms: int,
    evidence: str,
    profile_input: str | None = None,
    files: list[str] | None = None,
) -> dict[str, Any] | None:
    """cmd_record 等价逻辑（profile-input 展开 + 迁移 + 写入）。

    不走 subprocess 是为了复用 hl 的进程内缓存与错误信封；参数与
    harness_ledger.py record 子命令一一对应。定向项（P1/P6）传
    profile_input=None + files=<变更源+测试文件>：显式 --files 路径，
    inputsHash/inputsFiles 从显式文件算，derive_coverage("unitTest",
    None)→"incremental"。不用 unitTestFull 的 profile 输入集给定向项
    记账——输入集声称覆盖全部 harness/scripts/*.py 而实际只测了部分，
    正是 harness_ledger.py:2703-2705 反对的假证据。
    """
    args = argparse.Namespace(
        change_dir=str(change_dir),
        verification=verification,
        status=status,
        command=command,
        runner_command=None,
        exit_code=exit_code,
        duration_ms=duration_ms,
        files=",".join(files) if files else None,
        files_from=None,
        evidence=evidence,
        project=str(project),
        profile_input=profile_input,
        scope=None,
        coverage=None,
        toolchain_hash=None,
        profile_hash=None,
        environment_hash=None,
        db_schema_hash=None,
        deploy_artifact=None,
        artifact_hash=None,
        tests_executed=False,
        tests_reused_from=None,
        metrics_json=None,
        metrics_file=None,
        base_commit=None,
        diff_hash=None,
        applicability=None,
        applicability_reason=None,
        scenario_ids=None,
        scenario_receipt_file=None,
        verbose=False,
        json=True,
    )
    # cmd_record 的 emit_json 走 stdout、emit_error 走 stderr
    # （harness_ledger.py:285/355）——两边都捕获才能还原错误信封。
    class _Capture:
        def __init__(self) -> None:
            self.chunks: list[str] = []

        def write(self, text: str) -> int:
            self.chunks.append(text)
            return len(text)

        def flush(self) -> None:
            pass

        def getvalue(self) -> str:
            return "".join(self.chunks)

    captured_out = _Capture()
    captured_err = _Capture()
    original_stdout = sys.stdout
    original_stderr = sys.stderr
    sys.stdout = captured_out  # type: ignore[assignment]
    sys.stderr = captured_err  # type: ignore[assignment]
    try:
        rc = hl.cmd_record(args)
    finally:
        sys.stdout = original_stdout  # type: ignore[assignment]
        sys.stderr = original_stderr  # type: ignore[assignment]
    raw = captured_err.getvalue().strip() or captured_out.getvalue()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        payload = {"ok": rc == 0, "raw": raw[:500]}
    if rc != 0 or not payload.get("ok"):
        return error_envelope(
            str(payload.get("code") or payload.get("error_code") or "LEDGER_RECORD_FAILED"),
            str(payload.get("message") or payload.get("error") or "ledger record failed"),
            field_path=f"verification-ledger.validations.{verification}",
            recovery_action=(
                "修复上述 ledger 写入问题后重跑 "
                f"harness_task.py finish --project . --change {change_dir.name} --json"
            ),
        )
    return None


def _generate_plan_md(
    change_dir: Path, task: dict[str, Any], tier: str, verifications: list[dict[str, Any]]
) -> Path:
    """从 task.json 生成 plans/<cn>-plan.md（businessGoal/风险等级/任务表）。

    消费方契约：
    - _business_goal_from_sources 读 `目标: <text>` 行（harness_archive.py:5447）
    - classify_risk 读 `风险等级: fast|standard|full`（harness_gate.py:1421）
    - build_plan_candidates._tasks_from_plan 读 `## Tasks` + `### T1`
    """
    change = str(task.get("changeId") or change_dir.name)
    goal = str(task.get("goal") or "")
    acceptance = [str(item) for item in (task.get("acceptance") or [])]
    lines: list[str] = [
        f"# {change} 实施计划",
        "",
        f"目标: {goal}",
        f"风险等级: {tier}",
        "",
        "## 验收条件",
        "",
    ]
    for index, item in enumerate(acceptance, start=1):
        lines.append(f"{index}. {item}")
    lines.extend(
        [
            "",
            "## Tasks",
            "",
            "### T1",
            "完成变更并使验收条件全部通过。",
            f"- 验证：{'、'.join(v['verification'] for v in verifications)}",
            "",
        ]
    )
    plans_dir = change_dir / "plans"
    plans_dir.mkdir(parents=True, exist_ok=True)
    plan_path = plans_dir / f"{change}-plan.md"
    plan_path.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    return plan_path


def _write_execution_log(change_dir: Path, head_hash: str) -> Path:
    """final-hash 提取链需要 execution-log 含 `final pushed hash:`（:2337）。"""
    logs_dir = change_dir / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)
    log_path = logs_dir / "execution-log.md"
    stamp = now_iso()
    text = (
        f"# 执行日志（harness-task 轻任务）\n\n"
        f"- 完成时间: {stamp}\n"
        f"- final pushed hash: {head_hash}\n"
        f"- 说明: 轻任务闭环由 harness_task.py finish 自动生成；\n"
        f"  本地无上游时不执行 push，hash 即本地 HEAD。\n"
    )
    log_path.write_text(text, encoding="utf-8", newline="\n")
    return log_path





def _full_signals_for_paths(paths: list[str]) -> list[str]:
    """对任意路径集计算 full 档信号（与 classify_risk 同一权威契约）。

    classify_risk 只对 productPaths 跑信号扫描；finish 的落定范围复检需要
    对外来/新增路径独立判定，避免信号被 ownership 归类遮蔽（R1）。
    """
    normalized = [str(p).replace("\\", "/") for p in paths]
    lowered = "\n".join(normalized).lower()
    hits = [
        signal
        for signal, markers in hg._load_risk_signals_contract()["fullMarkers"].items()
        if any(marker in lowered for marker in markers)
    ]
    if any(path.lower() in hg.CONTRACT_SCHEMA_PATHS for path in normalized):
        hits.append("contract-schema")
    return sorted(set(hits))


def _scope_content_fingerprint(
    project: Path, paths: list[str]
) -> dict[str, Any]:
    """落定范围的内容指纹：path → sha256；目录递归展开；缺失记 None。

    用于「验证完成 → 提交」窗口的并发写入检测：指纹不同 = 产品内容在
    验证后被改写，验证结论不再覆盖提交内容，必须冲突报错（R1）。
    """
    fingerprint: dict[str, Any] = {}
    for raw in paths:
        rel = str(raw).replace("\\", "/")
        abs_path = project / rel
        if abs_path.is_file():
            fingerprint[rel] = _file_sha256(abs_path)
        elif abs_path.is_dir():
            entries: list[str] = []
            for file in sorted(abs_path.rglob("*")):
                if file.is_file():
                    rel_file = file.relative_to(project).as_posix()
                    entries.append(f"{rel_file}={_file_sha256(file)}")
            fingerprint[rel] = hashlib.sha256(
                "\n".join(entries).encode("utf-8")
            ).hexdigest()
        else:
            fingerprint[rel] = None
    return fingerprint


def _git_commit_scoped(
    project: Path, change: str, product_paths: list[str], message: str
) -> tuple[str | None, str | None]:
    """精确范围提交（R1 修复）：只暂存落定产品范围 + 本任务证据目录。

    旧实现 git add -A 会把验证窗口内落入的外来文件、其他任务的 .harness
    目录一并吞进本任务提交。现在逐路径暂存；范围外改动保留在工作区由
    用户处置（finish 起步的 FOREIGN_PATHS_PRESENT 与提交前复检兜底）。
    返回 (commit_hash, error)；范围内无差异时返回 (None, None)。
    """
    stage: list[str] = []
    seen: set[str] = set()
    candidates = [
        *[str(p).replace("\\", "/") for p in product_paths],
        f".harness/changes/{change}",
        f".harness/state/changes/{change}",
        ".harness/closure-ledger.json",
        ".harness/config/build-profile.json",
    ]
    for rel in candidates:
        if rel in seen:
            continue
        seen.add(rel)
        if (project / rel).exists():
            stage.append(rel)
            continue
        # 已删除的路径：仅当被 git 跟踪过才需要显式暂存删除
        tracked = subprocess.run(
            ["git", "ls-files", "--error-unmatch", "--", rel],
            cwd=project,
            capture_output=True,
            check=False,
        )
        if tracked.returncode == 0:
            stage.append(rel)
    if not stage:
        return None, None
    # 被 .gitignore 忽略的路径（如真实仓库整目录忽略的 .harness/）显式传给
    # git add 会报 "paths are ignored"；旧实现 git add -A 无 pathspec 所以
    # 静默跳过。先过滤保持一致（check-ignore 默认不报告已跟踪路径）。
    probe = subprocess.run(
        ["git", "check-ignore", "--", *stage],
        cwd=project,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    ignored = {
        line.strip().strip('"').replace("\\", "/")
        for line in probe.stdout.splitlines()
        if line.strip()
    }
    stage = [rel for rel in stage if rel not in ignored]
    if not stage:
        return None, None
    add = subprocess.run(
        ["git", "add", "-A", "--", *stage],
        cwd=project,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if add.returncode != 0:
        return None, (add.stderr or add.stdout or "").strip()
    diff = subprocess.run(
        ["git", "diff", "--cached", "--quiet"],
        cwd=project,
        capture_output=True,
        check=False,
    )
    if diff.returncode == 0:
        return None, None
    commit = subprocess.run(
        ["git", "commit", "-m", message],
        cwd=project,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if commit.returncode != 0:
        return None, (commit.stderr or commit.stdout or "").strip()
    return git_text(project, "rev-parse", "HEAD"), None


def _terminal_ledger_state(change_dir: Path) -> bool:
    """终态任务的验证账本完整性：存在、可解析、至少一条且全部 OK。"""
    return hl.all_validations_ok(hl.load_validations(change_dir))


def _ledger_verifications(change_dir: Path) -> list[dict[str, Any]]:
    """从 ledger 重建 verifications 摘要（恢复路径不重跑验证）。"""
    validations = hl.load_validations(change_dir)
    if not validations:
        return []
    return [
        {
            "verification": name,
            "resolvedAs": name,
            "status": str(entry.get("status") or "UNKNOWN"),
            "durationMs": int(entry.get("durationMs") or 0),
        }
        for name, entry in sorted(validations.items())
        if isinstance(entry, dict)
    ]


def _resume_terminal_finish(
    project: Path,
    change_dir: Path,
    task: dict[str, Any],
    no_commit: bool,
    as_json: bool,
) -> int | None:
    """R3/O1 恢复通道：终态已写但归档缺失，只补缺失动作。

    - completed 且 commit + ledger 证据齐全 → 只补 plan/snapshot/exec-log
      与归档（不重复验证/提交），发 TASK_RESUMED；
    - completed 但 commit 缺失（崩溃于提交前，或 --no-commit 终态）或
      ledger 不完整 → 验证结论无法覆盖提交内容，回滚 open 并返回 None，
      由主流程完整重验证（fail-closed）；
    - abandoned/superseded 闭包本就无提交（R2）→ 直接补归档。
    归档失败时不回滚终态——本通道可重入，重跑 finish 继续恢复。
    """
    change = change_dir.name
    closure = str(task.get("status") or "completed")
    commit = str(task.get("commit") or "") or None
    started_at = time.perf_counter()

    if closure == "completed" and (
        commit is None or not _terminal_ledger_state(change_dir)
    ):
        # fail-closed：证据链不完整，回滚 open 走完整重验证
        task["status"] = "open"
        task["finishedAt"] = None
        task["commit"] = None
        hs.write_json(change_dir / TASK_REL, task)
        return None

    tier = str(task.get("tier") or "fast")
    verifications = _ledger_verifications(change_dir)
    plan_path = change_dir / "plans" / f"{change}-plan.md"
    # 目录内已有归档 manifest = 曾被完整归档后移回：证据与清单校验和绑定，
    # 对 change_dir 的任何写入都会破坏 source consistency——一个字节都
    # 不写，只重执行归档。否则按真实崩溃处理：只补缺失证据（幂等，
    # 已存在的一律不重写，避免漂移已有清单）。
    sealed_before = (
        change_dir / "evidence" / "archive-manifest-before.json"
    ).is_file()
    if not sealed_before:
        if not plan_path.is_file():
            plan_path = _generate_plan_md(change_dir, task, tier, verifications)
        if not (change_dir / "meta" / "state-snapshot.json").is_file():
            hs.capture_current_state(
                project=project,
                change_dir=change_dir,
                change_name=change,
                worktree_root=project,
            )
        exec_log_path = change_dir / "logs" / "execution-log.md"
        if not exec_log_path.is_file():
            head_hash = commit or git_text(project, "rev-parse", "HEAD")
            _write_execution_log(change_dir, head_hash)
        # 崩溃若发生在 phase.end 写入前，补上闭环事件（与 ⑩ 同一配对约定）。
        open_start = find_open_task_start(load_task_events(change_dir))
        if open_start is not None:
            start_attempt = open_start.get("attempt")
            he.append_event(
                change_dir,
                phase=TASK_PHASE,
                type_="phase.end",
                run_id=str(open_start.get("run_id") or "") or None,
                attempt=(
                    int(start_attempt) if isinstance(start_attempt, int) else None
                ),
                status="OK",
                duration_ms=0,
                note=f"轻任务恢复闭包：{closure}",
            )
        he.append_event(
            change_dir,
            phase=TASK_PHASE,
            type_="decision",
            note=f"恢复补归档：{closure}（commit={commit or '无'}）",
        )

    archive_root = project / ".harness" / "archive"
    archive_code, archive_payload = ha.execute_archive(
        change_dir,
        archive_root,
        skip_ingest=False,
        allow_missing_review=True,
        archive_intent="record-only",
        closure_disposition=closure,
        closure_reason=str(task.get("closureReason") or ""),
    )
    if archive_code != 0:
        blockers = [
            str(item.get("code") or item.get("message") or item)
            for item in (
                archive_payload.get("issues")
                or (archive_payload.get("preflight") or {}).get("status", {}).get("blockers")
                or []
            )
            if isinstance(item, dict)
        ]
        emit(
            error_envelope(
                "ARCHIVE_FAILED",
                str(
                    archive_payload.get("error")
                    or archive_payload.get("reasonCode")
                    or "archive execute failed"
                ),
                problems=blockers,
                recovery_action=(
                    "处理归档阻断项后重跑 "
                    f"harness_task.py finish --project . --change {change} --json"
                    "（恢复通道可重入，仍只补归档）"
                ),
                extra={"archivePayload": archive_payload},
            ),
            as_json,
        )
        return 2

    duration_ms = max(0, int(round((time.perf_counter() - started_at) * 1000)))
    archive_dir = str(
        archive_payload.get("archive_dir")
        or archive_payload.get("archiveDir")
        or (archive_root / f"{dt.date.today().isoformat()}-{change}")
    )
    emit(
        {
            "ok": True,
            "code": "TASK_RESUMED",
            "changeId": change,
            "tier": tier,
            "closure": closure,
            "commit": commit,
            "verifications": verifications,
            "planPath": str(plan_path),
            "archiveDir": archive_dir,
            "resumed": True,
            "summary": _summary_block(
                change_dir,
                verifications=verifications,
                no_verify_note=f"无（{closure} 闭包不重跑验证）",
                default_risk="恢复通道未重复验证/提交，仅补齐归档证据链",
                code_location=(
                    f"commit {commit}" if commit else "未提交（非 completed 闭包）"
                ),
            ),
            "durationMs": duration_ms,
        },
        as_json,
    )
    return 0


def _precommit_scope_check(
    project: Path,
    change: str,
    product_paths: list[str],
    scope_fingerprint: dict[str, Any] | None,
    task: dict[str, Any],
    as_json: bool,
) -> int | None:
    """提交前复检（R1）：验证结论必须覆盖实际提交内容。

    - 验证窗口内晚到的外来路径若命中 full 信号 → rc3 升级拒绝（本任务
      验证副作用豁免——合法测试输出不错误升级；普通外来文件不拒绝，
      _git_commit_scoped 本就不暂存它们，留工作区给用户）；
    - 落定范围内内容在验证后被改写（指纹漂移）→ TASK_CONTENT_DRIFT。
    返回 None 表示通过，否则已 emit 错误并返回退出码。
    """
    scope = {str(p).replace("\\", "/") for p in product_paths}
    recorded_effects = {
        str(p).replace("\\", "/")
        for p in (task.get("verificationSideEffects") or [])
    }

    def _in_scope(rel: str) -> bool:
        return any(
            rel == base or rel.startswith(base.rstrip("/") + "/")
            for base in scope
        )

    late_foreign = sorted(
        normalized
        for raw in _dirty_paths(project)
        for normalized in (raw.replace("\\", "/"),)
        if not _in_scope(normalized)
        and not normalized.startswith(".harness/")
        and normalized not in recorded_effects
    )
    late_signals = _full_signals_for_paths(late_foreign)
    if late_signals:
        emit(
            error_envelope(
                "TASK_TIER_UPGRADE_REQUIRED",
                "验证完成后窗口内落入的外来路径命中 full 档信号，验证结论不再"
                "覆盖待提交内容，轻任务链禁止自动升级",
                field_path="risk-classification.signals",
                problems=[f"signal: {item}" for item in late_signals],
                recovery_action=(
                    "把外来文件移出工作区或 stash 后重跑 finish；确属本任务的"
                    "变更请改用 /harness-plan 完整流程"
                ),
                extra={"signals": late_signals, "paths": late_foreign},
            ),
            as_json,
        )
        return 3
    if scope_fingerprint is not None:
        current = _scope_content_fingerprint(project, product_paths)
        if current != scope_fingerprint:
            drifted = sorted(
                path
                for path in set(current) | set(scope_fingerprint)
                if current.get(path) != scope_fingerprint.get(path)
            )
            emit(
                error_envelope(
                    "TASK_CONTENT_DRIFT",
                    "落定范围内的内容在验证完成后被改写，验证结论不再覆盖待提交"
                    "内容",
                    field_path="workspaceBreakdown.productPaths",
                    problems=drifted,
                    recovery_action=(
                        "harness_task.py finish --project . "
                        f"--change {change} --json 重跑以重新验证当前内容"
                    ),
                ),
                as_json,
            )
            return 2
    return None


def _record_verification_side_effects(
    project: Path,
    change_dir: Path,
    task: dict[str, Any],
    pre_verify_dirty: set[str],
) -> None:
    """R1/P9：记录验证窗口内新落盘的非 .harness 路径（本任务验证副作用）。

    重试 finish 时这些路径豁免 ②c 升级判定（合法测试输出不错误升级），
    窗口外的用户/他人新增路径不在此列，仍须过 full 信号复检。
    """
    current = {
        str(p).replace("\\", "/")
        for p in _dirty_paths(project)
        if not str(p).replace("\\", "/").startswith(".harness/")
    }
    new_paths = sorted(current - pre_verify_dirty)
    if not new_paths:
        return
    recorded = {
        str(p).replace("\\", "/")
        for p in (task.get("verificationSideEffects") or [])
    }
    merged = sorted(recorded | set(new_paths))
    if merged != sorted(recorded):
        task["verificationSideEffects"] = merged
        hs.write_json(change_dir / TASK_REL, task)


def cmd_finish(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    project = Path(args.project).resolve()
    change = str(args.change or "").strip()
    closure = str(args.closure or "completed")
    closure_reason = str(args.closure_reason or "").strip()
    commit_message = str(args.commit_message or "").strip()
    no_commit = bool(args.no_commit)

    change_dir, resolved = resolve_change_dir(project, change)
    if change_dir is None:
        emit(
            error_envelope(
                str(resolved.get("code", "CHANGE_NOT_FOUND")),
                str(resolved.get("message", f"change not found: {change}")),
                recovery_action=(
                    f"harness_task.py begin --project . --change {change} "
                    "--executor <tool> --goal <goal> --acceptance <cond> --json"
                ),
            ),
            as_json,
        )
        return 2

    task = load_task(change_dir)
    if task is None:
        emit(
            error_envelope(
                "TASK_NOT_BEGUN",
                f"change {change} 缺少 meta/task.json——先运行 begin",
                field_path="meta/task.json",
                recovery_action=(
                    f"harness_task.py begin --project . --change {change} "
                    "--executor <tool> --goal <goal> --acceptance <cond> --json"
                ),
            ),
            as_json,
        )
        return 2
    resumed = False
    if task.get("status") != "open":
        # R3/O1：终态但归档缺失（终态写入后、归档前崩溃）→ 走恢复通道，
        # 只补做缺失动作；证据链不完整时回滚 open 继续下方完整重验证；
        # 非终态的脏 status 一律 fail-closed。
        if task.get("status") in TERMINAL_TASK_STATUSES:
            resume_rc = _resume_terminal_finish(
                project, change_dir, task, no_commit, as_json
            )
            if resume_rc is not None:
                return resume_rc
            resumed = True
            task = load_task(change_dir) or task
        else:
            emit(
                error_envelope(
                    "TASK_STATE_INVALID",
                    f"change {change} 任务状态不可信（status={task.get('status')!r}），"
                    "fail-closed 拒绝 finish",
                    field_path="meta/task.json.status",
                    recovery_action="人工核对 meta/task.json 后修正为 open 再重跑 finish",
                ),
                as_json,
            )
            return 2

    if closure != "completed" and not closure_reason:
        emit(
            error_envelope(
                "TASK_INPUT_INVALID",
                "abandoned/superseded 闭包必须给 --closure-reason（中文原因）",
                field_path="args.closure_reason",
                recovery_action=(
                    f"harness_task.py finish --project . --change {change} "
                    f"--closure {closure} --closure-reason \"<中文原因>\" --json"
                ),
            ),
            as_json,
        )
        return 2

    started_at = time.perf_counter()

    # ① classify（post-run 读脏树）
    try:
        workflow = hg._load_workflow_policy(project=project)
    except (OSError, ValueError) as exc:
        emit(
            error_envelope("POLICY_LOAD_FAILED", str(exc)),
            as_json,
        )
        return 2
    classification = hg.classify_risk(change_dir, "post-run", workflow=workflow)

    # ② 档位裁决：full 信号 / 外来脏路径 → 拒绝
    #    纵深防御：手改 task.json declaredTier 为 full（绕过 begin 拒绝）
    #    → 同样拒绝。begin --tier choices 已挡非法值，这里只防手改。
    declared_tier = task.get("declaredTier")
    if declared_tier is not None and declared_tier not in ACCEPTED_TIERS:
        emit(
            error_envelope(
                "TASK_TIER_UPGRADE_REQUIRED",
                f"task.json declaredTier={declared_tier!r} 非法（轻任务入口只接受"
                " fast/standard 声明；full 请走 /harness-plan 完整流程）",
                field_path="meta/task.json.declaredTier",
                recovery_action=(
                    "修正 meta/task.json 的 declaredTier，或改用 /harness-plan"
                    " 完整流程"
                ),
            ),
            as_json,
        )
        return 3
    #    外来检测双通道（互补，缺一必有盲区）：
    #    a) begin 脏树基线（task.json.dirtyBaseline）：begin 前就脏且内容
    #       未变 → 任务从未触碰，git add -A 会误扫进提交。首跑时 classify
    #       无 ownership 契约，非 .harness 路径全进 productPaths
    #       （harness_gate.py:1494-1497），foreignPaths 恒空——只有基线
    #       能拦住预存脏路径。
    #    b) classify workspaceBreakdown.foreignPaths（重试路径：契约已
    #       存在）：只对 .harness 命名空间生效——结构性越界（别的 change
    #       的状态、state 根）即使被 .gitignore 挡住不进提交，也会污染
    #       归档快照，必须拒绝。产品树路径不在此列（P9）：重试时契约是
    #       上次 finish 的快照，上次验证的副作用文件（如 npm pretest →
    #       sync:harness 改 bundle manifest）不在快照里，但它们是任务
    #       自身验证链的产物——按 dirtyBaseline 的同一原则（begin 后
    #       新出现/变更 = 任务工作），并入 productPaths 重新声明，不拒绝。
    baseline = task.get("dirtyBaseline")
    baseline = dict(baseline) if isinstance(baseline, dict) else {}
    foreign_paths = detect_foreign_dirt(project, baseline)
    breakdown = classification.get("workspaceBreakdown") or {}
    own_prefix = f".harness/changes/{change}/"
    contract_foreign = [
        str(path).replace("\\", "/")
        for path in (breakdown.get("foreignPaths") or [])
    ]
    harness_foreign = sorted(
        path for path in contract_foreign
        if path.startswith(".harness/") and not path.startswith(own_prefix)
    )
    foreign_paths = sorted(set(foreign_paths) | set(harness_foreign))
    if foreign_paths:
        emit(
            error_envelope(
                "FOREIGN_PATHS_PRESENT",
                "工作区存在任务边界外的脏路径（begin 前已存在且未被本任务"
                "修改，或 .harness 结构越界），轻任务不得提交它们",
                field_path="workspaceBreakdown.foreignPaths",
                problems=foreign_paths,
                recovery_action=(
                    "把这些文件移出工作区、提交或 stash 后重跑；"
                    "涉及流程变更请改用 /harness-plan 完整流程"
                ),
            ),
            as_json,
        )
        return 2

    tier, full_hits = _tier_from_classification(classification)
    if tier is None:
        emit(
            error_envelope(
                "TASK_TIER_UPGRADE_REQUIRED",
                "diff 触发 full 档信号，超出轻任务入口接受范围（fast+standard）",
                field_path="risk-classification.signals",
                problems=[f"signal: {item}" for item in full_hits],
                recovery_action=(
                    "改用完整流程：/harness-plan → /harness-execute → "
                    "/harness-archive；change 目录已保留，可直接续用"
                ),
                extra={
                    "changeDir": str(change_dir),
                    "signals": full_hits,
                    "changePreserved": True,
                },
            ),
            as_json,
        )
        return 3

    # 补归档重跑（归档失败后）：产品树已提交、无新 diff（no-code-diff），
    # 档位沿用上次裁决的记录，避免把 standard 工作改记成 fast。
    recorded_tier = str(task.get("tier") or "")
    tier = _apply_tier_floors(tier, recorded_tier, declared_tier, classification)

    # ②b 声明产品所有权：classify 的 productPaths 即本次 diff 的产品路径。
    #     不声明则归档把全部改动判 foreignPaths → DIFF_ZERO_WITH_NONEMPTY_COMMIT
    #     （declare_product_ownership 的文档注释即此坑）。
    #     重试路径（P9）：上次契约快照外的产品树脏路径（上次验证的副作用
    #     等）一并并入——归档的 compute_ownership_diff 按新契约把它们判
    #     owned，提交范围与声明范围一致。
    product_paths = sorted(
        {
            str(path).replace("\\", "/")
            for path in (breakdown.get("productPaths") or [])
        }
        | {
            path for path in contract_foreign
            if not path.startswith(".harness/")
        }
    )
    # WI-3.3：声明了 writeScope 的任务，实际产品 diff（含吸纳的外来路径）
    # 必须落在声明范围内；越界即停止——不声明、不提交，改动留在工作区，
    # 由用户收窄改动或以更大范围重开任务（声明是 begin 时的协调事实）。
    task_scope = [
        str(p) for p in (task.get("writeScope") or []) if str(p).strip()
    ]
    if task_scope and product_paths:
        out_of_scope = [
            path
            for path in product_paths
            if not any(
                path == scope or path.startswith(scope + "/")
                for scope in task_scope
            )
        ]
        if out_of_scope:
            emit(
                error_envelope(
                    "TASK_SCOPE_VIOLATION",
                    f"实际改动越过 begin 声明的写入范围 {task_scope}，已停止",
                    field_path="meta/task.json.writeScope",
                    problems=[
                        f"out-of-scope: {path}" for path in out_of_scope
                    ],
                    recovery_action=(
                        "收窄改动到声明范围内；或先 abandon 本任务，"
                        "以覆盖实际改动的 --write-scope 重新 begin"
                    ),
                    extra={
                        "declaredScope": task_scope,
                        "outOfScope": out_of_scope,
                    },
                ),
                as_json,
            )
            return 2

    if product_paths:
        ownership = hchg.declare_product_ownership(
            project, change, product_paths=product_paths
        )
        if not ownership.get("ok"):
            emit(
                error_envelope(
                    str(ownership.get("code", "PRODUCT_OWNERSHIP_FAILED")),
                    str(ownership.get("message", "declare ownership failed")),
                ),
                as_json,
            )
            return 2

    # ②c R1：吸纳外来路径后，基于落定范围重分类并重裁决档位。旧实现沿用
    #     吸纳前的分类——其信号只扫旧 ownership.productPaths，导致验证失败
    #     重试时新增的 full 信号路径（auth/迁移等）被静默按原档提交。
    #     同时区分来源（R1 实施要求 2）：本任务验证窗口内落盘的副作用
    #     （verificationSideEffects，如 manifest 类构建产物）是合法测试
    #     输出，豁免升级判定；窗口外的用户/他人新增路径必须过 full 信号。
    absorbed_foreign = [
        path for path in contract_foreign if not path.startswith(".harness/")
    ]
    if absorbed_foreign:
        recorded_effects = {
            str(p).replace("\\", "/")
            for p in (task.get("verificationSideEffects") or [])
        }
        escalated = [
            path for path in absorbed_foreign if path not in recorded_effects
        ]
        classification = hg.classify_risk(change_dir, "post-run", workflow=workflow)
        settled_tier, settled_full_hits = _tier_from_classification(classification)
        if escalated and settled_tier is None:
            emit(
                error_envelope(
                    "TASK_TIER_UPGRADE_REQUIRED",
                    "范围落定后重分类命中 full 档信号（验证失败重试时新增/吸纳"
                    "的路径），轻量任务链禁止自动升级",
                    field_path="risk-classification.signals",
                    problems=[f"signal: {item}" for item in settled_full_hits],
                    recovery_action=(
                        "方案 A（推荐）：harness_ledger.py record-degradation "
                        "--reason '授权扩大' --verification all --approval user "
                        "→ harness_gate.py add-approval --approver user → 重跑 finish；"
                        "方案 B：放弃该任务（finish --closure abandoned）"
                    ),
                    extra={
                        "changeDir": str(change_dir),
                        "signals": settled_full_hits,
                        "paths": escalated,
                        "changePreserved": True,
                    },
                ),
                as_json,
            )
            return 3
        tier = _apply_tier_floors(
            settled_tier if settled_tier is not None else tier,
            recorded_tier,
            declared_tier,
            classification,
        )

    # ③ 写 gate-policy 工作副本（唯一写入口 hg.persist_gate_policy——
    #    WI-F2 单写入方）。plannedPhases=["task","archive"] 使
    #    archive_auto_gate 认得 phase.end(task)——harness_archive.py:3480-3485
    #    的 completed_phase 取 plannedPhases 中 archive 的前一个）。tier 用
    #    最终裁决值（含 declared floor / recorded_tier 保留）——归档的
    #    P13 文案与 full-tier review 拦截都读这份文件的 tier。
    classification.setdefault("tierOverride", None)
    classification["tier"] = tier
    classification["classifiedAt"] = now_iso()
    policy_doc = hg.persist_gate_policy(
        change_dir, classification, planned_phases=[TASK_PHASE, "archive"]
    )

    verifications: list[dict[str, Any]] = []
    if closure == "completed":
        # ④ 变更感知验证计划（P1/P5/P6）+ ⑤ 逐项执行写 ledger
        signals = [str(s) for s in (classification.get("signals") or [])]
        plan = _plan_verifications(tier, signals, product_paths, project)
        # R1/P9：验证前快照——窗口内新落盘的非 .harness 路径记为本任务
        # 验证副作用（供 ②c 来源区分）；窗口外的用户/他人新增不在此列。
        pre_verify_dirty = {
            str(p).replace("\\", "/")
            for p in _dirty_paths(project)
            if not str(p).replace("\\", "/").startswith(".harness/")
        }
        for item in plan:
            if item.get("reason") == "deduped":
                # P5：同一 argv 已执行——名义项保留在摘要，不重复执行/记账。
                verifications.append(
                    {
                        "verification": item["name"],
                        "resolvedAs": item.get("resolvedAs") or item["name"],
                        "status": "DEDUPED",
                        "durationMs": 0,
                        "dedupedFrom": item.get("dedupedFrom"),
                    }
                )
                continue
            summary, verify_error = _run_verification(project, change_dir, item)
            if verify_error is not None:
                _record_verification_side_effects(
                    project, change_dir, task, pre_verify_dirty
                )
                emit(verify_error, as_json)
                return 2
            verifications.append(summary)
            if summary["status"] != "OK":
                _record_verification_side_effects(
                    project, change_dir, task, pre_verify_dirty
                )
                emit(
                    error_envelope(
                        "VERIFICATION_FAILED",
                        f"验证 {item['name']} 失败（exit {summary['exitCode']}）",
                        field_path=f"validations.{item['name']}",
                        problems=[f"evidence: {summary['evidence']}"],
                        recovery_action=(
                            "修复失败后重跑 "
                            f"harness_task.py finish --project . --change {change} --json"
                            "（ledger 已记录本次失败，重跑会覆盖）"
                        ),
                    ),
                    as_json,
                )
                return 2
        # 成功路径同样记录——副作用判定只看验证窗口，与验证成败无关。
        _record_verification_side_effects(
            project, change_dir, task, pre_verify_dirty
        )

    # R1：验证完成时刻对落定范围取内容指纹；提交前复检比对（见 ⑧）。
    scope_fingerprint: dict[str, Any] | None = (
        _scope_content_fingerprint(project, product_paths)
        if closure == "completed"
        else None
    )

    # ⑥ 生成 plan.md（businessGoal/风险等级/任务表三契约）
    plan_path = _generate_plan_md(change_dir, task, tier, verifications)

    # ⑦ 刷新 state snapshot（HEAD 前移；changeBase 不可变）
    hs.capture_current_state(
        project=project,
        change_dir=change_dir,
        change_name=change,
        worktree_root=project,
    )

    # ⑧ commit（不 push；record-only 归档在无上游场景通过——批次 0 证据）
    #     R2：abandoned/superseded 闭包跳过提交——取消的任务不产生代码提交，
    #     工作区改动保留给用户处置（文档 §闭包语义）；归档走 unfinished
    #     closure 通道保留证据链。
    head_hash = git_text(project, "rev-parse", "HEAD")
    committed_hash: str | None = None
    if closure == "completed" and not no_commit:
        # R1：提交前复检候选内容——验证后窗口落入的范围外路径、或落定范围
        # 内被并发改写的内容，都使验证结论不再覆盖待提交内容，fail-closed。
        precheck_rc = _precommit_scope_check(
            project, change, product_paths, scope_fingerprint, task, as_json
        )
        if precheck_rc is not None:
            return precheck_rc
        default_message = (
            commit_message
            or f"harness-task: {task.get('goal') or change}"
        )
        committed_hash, commit_error = _git_commit_scoped(
            project, change, product_paths, default_message
        )
        if commit_error is not None:
            emit(
                error_envelope(
                    "GIT_COMMIT_FAILED",
                    commit_error,
                    recovery_action=(
                        "手工检查 git status 后重跑，或用 --no-commit 跳过提交"
                    ),
                ),
                as_json,
            )
            return 2
        head_hash = committed_hash or head_hash

    # ⑨ execution-log（final-hash 提取链）
    _write_execution_log(change_dir, head_hash)

    # ⑩ phase.end + decision(outcome)——幂等：重跑（如归档失败后补归档）
    #     时已有未关闭 start 才追加，且带 run_id/attempt；无未关闭 start
    #     （phase.end 已写过）则跳过，避免 PHASE_ALREADY_CLOSED。
    duration_ms = max(0, int(round((time.perf_counter() - started_at) * 1000)))
    open_start = find_open_task_start(load_task_events(change_dir))
    if open_start is not None:
        # phase.end 必须与 start 同 attempt 才会被 split_phase_attempts
        # 配对（phase_end_already_recorded 按 attempt 去重）。
        start_attempt = open_start.get("attempt")
        phase_end = he.append_event(
            change_dir,
            phase=TASK_PHASE,
            type_="phase.end",
            run_id=str(open_start.get("run_id") or "") or None,
            attempt=int(start_attempt)
            if isinstance(start_attempt, int)
            else None,
            status="OK",
            duration_ms=duration_ms,
            note=(
                f"轻任务完成：tier={tier}；验证 "
                f"{'、'.join(v['verification'] + '=' + v['status'] for v in verifications)}"
                if closure == "completed"
                else f"轻任务闭包：{closure}（{closure_reason}）"
            ),
        )
        if not phase_end.get("ok"):
            emit(
                error_envelope(
                    str(phase_end.get("code", "EVENT_APPEND_FAILED")),
                    str(phase_end.get("message", "phase.end append failed")),
                ),
                as_json,
            )
            return 2
    he.append_event(
        change_dir,
        phase=TASK_PHASE,
        type_="decision",
        note=(
            f"闭包决定：{closure}"
            + (f"；原因：{closure_reason}" if closure_reason else "")
            + f"；档位：{tier}"
        ),
    )

    # ⑩c WI-E1：成果摘要先落盘（facts 派生 + 模型 --outcome-* 输入）。
    #     先于 task.json 终态写入——保证「终态已写 ⇒ outcome 必在」；
    #     写失败保持 open 报错退出（O4：磁盘写入失败显示未保存）。
    finished_at = now_iso()
    outcome_input = {
        "summary": (args.outcome_summary or "").strip() or None,
        "motivation": (args.outcome_motivation or "").strip() or None,
        "residualRisks": [
            str(r).strip() for r in (args.outcome_risk or []) if str(r).strip()
        ],
        "nextSteps": [
            str(r).strip() for r in (args.outcome_next or []) if str(r).strip()
        ],
        "unverifiedItems": [
            str(r).strip() for r in (args.outcome_unverified or []) if str(r).strip()
        ],
    }
    outcome_error, outcome_warnings = write_outcome(
        change_dir,
        task=task,
        closure=closure,
        closure_reason=closure_reason,
        committed_hash=committed_hash if closure == "completed" else None,
        product_paths=product_paths,
        verifications=verifications,
        finished_at=finished_at,
        outcome_input=outcome_input,
    )
    if outcome_error is not None:
        emit(outcome_error, as_json)
        return 2
    # 归档会移走 change 目录——emit 展示用的 outcome 在归档前缓存。
    outcome_doc = _read_outcome(change_dir)

    # WI-E3（O4）：outcome 资产同进程原子入队 asset-outbox——
    # 「终态已写 ⇒ outcome 在且资产已入队」。payload 内嵌完整文档（自包含，
    # 归档移走目录后仍可交付）。入队失败显示不静默（E1 语义）：任务保持
    # open；重跑 finish 由幂等键去重，不会重复入队。
    try:
        if outcome_doc is None:
            raise harness_asset_outbox.AssetOutboxError(
                harness_asset_outbox.ASSET_OUTBOX_WRITE_FAILED,
                "outcome.json 写入后读回为空",
            )
        harness_asset_outbox.enqueue_outcome(project, change, outcome_doc)
    except harness_asset_outbox.AssetOutboxError as exc:
        emit(
            error_envelope(
                "ASSET_OUTBOX_ENQUEUE_FAILED",
                f"outcome 资产入队失败：{exc.message}——任务保持 open，未静默丢失",
                recovery_action="处理 asset-outbox（harness_asset_outbox.py drain/清理死信）后重跑 finish；幂等键去重不重复入队",
            ),
            as_json,
        )
        return 2

    # ⑪ 更新 task.json 终态（归档会移走整个目录，终态必须先写才能入档；
    #     归档失败时在下方回滚为 open，保证 recoveryAction 承诺的
    #     finish 重跑不被 TASK_ALREADY_FINISHED 挡住）
    task["status"] = closure
    # task.json.tier 是 gate-policy 权威文档的投影（WI-F2）：数据源必须
    # 是 persist_gate_policy 返回的文档，不是本函数的局部裁决变量。
    task["tier"] = policy_doc["tier"]
    task["finishedAt"] = finished_at
    # R2：只有 completed 闭包才有本任务提交；abandoned/superseded 不产生
    # 提交，记 HEAD 会把无关提交误标成本任务成果。
    task["commit"] = committed_hash if closure == "completed" else None
    task["closureReason"] = closure_reason or None
    hs.write_json(change_dir / TASK_REL, task)

    # ⑫ 归档（record-only；completed 之外不要求 ledger——:2986-2991）。
    #     --no-commit 时跳过：无提交范围，归档必被
    #     ARCHIVE_BASE_EQUALS_FEATURE_TIP 阻断（base==HEAD 无产品增量）。
    if no_commit:
        emit(
            {
                "ok": True,
                "code": "TASK_RESUMED" if resumed else "TASK_FINISHED_NO_ARCHIVE",
                "changeId": change,
                "tier": tier,
                "closure": closure,
                "commit": committed_hash,
                "resumed": resumed,
                "verifications": verifications,
                "planPath": str(plan_path),
                "summary": _summary_block(
                    change_dir,
                    verifications=verifications,
                    no_verify_note="无（非 completed 闭包）",
                    default_risk="--no-commit：变更未提交、未归档；工作区保持脏树",
                    code_location="未提交（工作区脏树）",
                    outcome_doc=outcome_doc,
                ),
                **({"warnings": outcome_warnings} if outcome_warnings else {}),
                "nextAction": (
                    "手工提交后如需归档：harness_archive.py execute "
                    f"--change-dir \"{change_dir}\" "
                    f"--archive-root \"{project / '.harness' / 'archive'}\" "
                    "--intent record-only --json"
                ),
                "durationMs": duration_ms,
            },
            as_json,
        )
        return 0

    archive_root = project / ".harness" / "archive"
    archive_code, archive_payload = ha.execute_archive(
        change_dir,
        archive_root,
        skip_ingest=False,
        allow_missing_review=True,
        archive_intent="record-only",
        closure_disposition=closure,
        closure_reason=closure_reason,
    )
    if archive_code != 0:
        # 归档失败：回滚 task.json 为 open（tier 保留——补归档重跑时
        # 产品树已提交、classify 只见 no-code-diff，档位沿用本记录），
        # finish 重跑（recoveryAction 承诺的路径）才不会被
        # TASK_ALREADY_FINISHED 挡住。
        task["status"] = "open"
        task["finishedAt"] = None
        task["commit"] = None
        hs.write_json(change_dir / TASK_REL, task)
        blockers = [
            str(item.get("code") or item.get("message") or item)
            for item in (archive_payload.get("issues")
                         or (archive_payload.get("preflight") or {}).get("status", {}).get("blockers")
                         or [])
            if isinstance(item, dict)
        ]
        emit(
            error_envelope(
                "ARCHIVE_FAILED",
                str(
                    archive_payload.get("error")
                    or archive_payload.get("reasonCode")
                    or "archive execute failed"
                ),
                problems=blockers,
                recovery_action=(
                    "处理归档阻断项后重跑 "
                    f"harness_task.py finish --project . --change {change} --json"
                    "（验证与提交已完成，重跑只补归档）"
                ),
                extra={"archivePayload": archive_payload},
            ),
            as_json,
        )
        return 2

    # ⑬ 简短摘要（完成内容/验证结果/残余风险/代码位置）
    archive_dir = str(
        archive_payload.get("archive_dir")
        or archive_payload.get("archiveDir")
        or (archive_root / f"{dt.date.today().isoformat()}-{change}")
    )
    emit(
        {
            "ok": True,
            "code": "TASK_RESUMED" if resumed else "TASK_FINISHED",
            "changeId": change,
            "tier": tier,
            "closure": closure,
            "commit": committed_hash,
            "verifications": verifications,
            "planPath": str(plan_path),
            "archiveDir": archive_dir,
            "resumed": resumed,
            "summary": _summary_block(
                change_dir,
                verifications=verifications,
                no_verify_note="无（非 completed 闭包）",
                default_risk="record-only 归档未做发布评审；full 档信号已前置拒绝",
                code_location=(
                    f"commit {committed_hash}"
                    if committed_hash
                    else "未提交（工作区保留，用户处置）"
                ),
                outcome_doc=outcome_doc,
            ),
            **({"warnings": outcome_warnings} if outcome_warnings else {}),
            "durationMs": duration_ms,
        },
        as_json,
    )
    return 0


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------

def cmd_status(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    project = Path(args.project).resolve()
    change = str(args.change or "").strip()

    change_dir, resolved = resolve_change_dir(project, change)
    if change_dir is None:
        emit(
            error_envelope(
                str(resolved.get("code", "CHANGE_NOT_FOUND")),
                str(resolved.get("message", f"change not found: {change}")),
            ),
            as_json,
        )
        return 2

    task = load_task(change_dir)
    if task is None:
        emit(
            {
                "ok": True,
                "code": "TASK_NOT_BEGUN",
                "changeId": change_dir.name,
                "changeDir": str(change_dir),
                "nextAction": (
                    "harness_task.py begin --project . "
                    f"--change {change_dir.name} --executor <tool> "
                    "--goal <goal> --acceptance <cond> --json"
                ),
            },
            as_json,
        )
        return 0

    # 已记验证（ledger）
    ledger_path = hl.find_ledger_path(change_dir)
    recorded: list[str] = []
    if ledger_path is not None:
        try:
            ledger = read_json_file(ledger_path)
            recorded = sorted(
                key for key, value in (ledger.get("validations") or {}).items()
                if isinstance(value, dict)
            )
        except (OSError, json.JSONDecodeError):
            recorded = []

    # 未提交 diff（porcelain 重命名 `R old -> new` 已在 _dirty_paths 拆开）
    dirty_paths = _dirty_paths(project)

    status = str(task.get("status") or "open")
    # 能解析到 change 目录说明尚未归档（归档会移走整个目录）——终态 + 目录
    # 仍在 = 归档中断，需要恢复指引而非误导性的"已终态"文案（R3/O1）。
    recovery_pending = status in TERMINAL_TASK_STATUSES
    if status == "open":
        next_action = (
            "继续编辑/测试，然后 harness_task.py finish --project . "
            f"--change {change_dir.name} --json"
        )
    elif recovery_pending:
        next_action = (
            f"任务已终态（{status}）但归档中断；重跑 harness_task.py finish "
            f"--project . --change {change_dir.name} --json ——恢复通道只补缺失"
            "动作，不重复验证/提交"
        )
    else:
        next_action = "任务已终态；归档目录见 archiveDir 或 .harness/archive/"

    emit(
        {
            "ok": True,
            "code": "TASK_STATUS",
            "changeId": change_dir.name,
            "changeDir": str(change_dir),
            "status": status,
            "goal": task.get("goal"),
            "acceptance": task.get("acceptance"),
            "tier": task.get("tier"),
            "declaredTier": task.get("declaredTier"),
            "recordedVerifications": recorded,
            "uncommittedPaths": dirty_paths,
            "commit": task.get("commit"),
            "createdAt": task.get("createdAt"),
            "finishedAt": task.get("finishedAt"),
            "recoveryPending": recovery_pending,
            "nextAction": next_action,
        },
        as_json,
    )
    return 0


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="轻任务闭环：begin → 编辑/测试 → finish（验证+ledger+归档一条命令）"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_begin = sub.add_parser("begin", help="开始轻任务（建 change + 固化基线）")
    p_begin.add_argument("--project", default=".")
    p_begin.add_argument("--change", required=True, help="kebab-case change id")
    p_begin.add_argument("--executor", default="unknown", help="executor tool name")
    p_begin.add_argument("--goal", required=True, help="任务目标（一句话，成为 businessGoal）")
    p_begin.add_argument(
        "--acceptance",
        action="append",
        required=True,
        help="可验证验收条件；可重复",
    )
    p_begin.add_argument(
        "--tier",
        choices=("fast", "standard", "full"),
        default=None,
        help="声明档位下限；full 直接拒绝（转 /harness-plan 完整流程）",
    )
    p_begin.add_argument(
        "--write-scope",
        action="append",
        default=None,
        metavar="PATH",
        help="写入范围声明（仓库相对路径，可重复）；与其他 open 任务声明"
        "相交即拒绝 begin，finish 实际 diff 越界即停止",
    )
    p_begin.add_argument(
        "--depends-on",
        action="append",
        default=None,
        metavar="CHANGE",
        help="依赖的 change id（可重复）；目标须达 completed 才允许 begin，"
        "abandoned/superseded 须先重开或替换依赖",
    )
    p_begin.add_argument("--json", action="store_true")
    p_begin.set_defaults(func=cmd_begin)

    p_finish = sub.add_parser("finish", help="验证 + ledger + plan + commit + 归档")
    p_finish.add_argument("--project", default=".")
    p_finish.add_argument("--change", required=True)
    p_finish.add_argument("--commit-message", default=None)
    p_finish.add_argument(
        "--closure",
        choices=("completed", "abandoned", "superseded"),
        default="completed",
    )
    p_finish.add_argument("--closure-reason", default="")
    p_finish.add_argument(
        "--no-commit",
        action="store_true",
        help="跳过自动 git commit（逃生口）",
    )
    p_finish.add_argument(
        "--outcome-summary",
        default=None,
        help="WI-E1：实际完成的行为叙述（落盘 meta/outcome.json；"
        "completed 缺省给 OUTCOME_SUMMARY_MISSING 警告，绝不回填 goal）",
    )
    p_finish.add_argument(
        "--outcome-motivation",
        default=None,
        help="关键取舍与原因；无法证实的解释标注 [推测]",
    )
    p_finish.add_argument(
        "--outcome-risk", action="append", default=[], help="残余风险（可重复）"
    )
    p_finish.add_argument(
        "--outcome-next", action="append", default=[], help="必要下一步（可重复）"
    )
    p_finish.add_argument(
        "--outcome-unverified",
        action="append",
        default=[],
        help="声明过但未验证的项（可重复）",
    )
    p_finish.add_argument("--json", action="store_true")
    p_finish.set_defaults(func=cmd_finish)

    p_status = sub.add_parser("status", help="只读恢复视图（档位/验证/脏树/下一步）")
    p_status.add_argument("--project", default=".")
    p_status.add_argument("--change", required=True)
    p_status.add_argument("--json", action="store_true")
    p_status.set_defaults(func=cmd_status)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
