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
- harness_gate.classify_risk / apply_tier_override / gate_policy_document
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


TASK_SCHEMA_VERSION = 1
TASK_REL = Path("meta") / "task.json"
TASK_PHASE = "task"
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


def write_json_file(path: Path, data: Any) -> None:
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
            "createdAt": now_iso(),
            "finishedAt": None,
            # begin 时刻脏树基线：finish 的外来路径检测基准（非循环）。
            "dirtyBaseline": capture_dirty_baseline(project),
        }
        write_json_file(change_dir / TASK_REL, task_doc)
    else:
        task_doc = existing_task
        # 既有任务补声明：之前 begin 未带 --tier，现在带了 → 补写
        # （同值幂等；不同值已被上面的冲突守卫拒绝）。
        if declared_tier is not None and task_doc.get("declaredTier") is None:
            task_doc["declaredTier"] = declared_tier
            write_json_file(change_dir / TASK_REL, task_doc)

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

    emit(
        {
            "ok": True,
            "code": "TASK_BEGUN",
            "changeId": change,
            "changeDir": str(change_dir),
            "changeCreated": created,
            "runId": run_id,
            "goal": task_doc.get("goal"),
            "acceptance": task_doc.get("acceptance"),
            "declaredTier": task_doc.get("declaredTier"),
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


def _git_commit_all(project: Path, message: str) -> tuple[str | None, str | None]:
    """git add -A + commit；返回 (commit_hash, error)。"""
    for args in (("add", "-A"), ("commit", "-m", message)):
        proc = subprocess.run(
            ["git", *args],
            cwd=project,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        if proc.returncode != 0:
            stderr = (proc.stderr or proc.stdout or "").strip()
            # commit 无变更时 git 返回 1 + "nothing to commit"——视为成功。
            if args[0] == "commit" and "nothing to commit" in stderr:
                break
            return None, stderr
    return git_text(project, "rev-parse", "HEAD"), None


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
    if task.get("status") != "open":
        emit(
            error_envelope(
                "TASK_ALREADY_FINISHED",
                f"change {change} 已处于终态 {task.get('status')!r}",
                field_path="meta/task.json.status",
                recovery_action=(
                    f"harness_task.py status --project . --change {change} --json"
                ),
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
    if (
        tier == "fast"
        and recorded_tier in ACCEPTED_TIERS
        and "no-code-diff" in [str(s) for s in (classification.get("signals") or [])]
    ):
        tier = recorded_tier

    # 声明档位下限（floor）：begin --tier 声明的档位比裁决高时抬升裁决，
    # 反之不压低——classify 信号升级（该拒还拒）不受声明影响。与上面的
    # recorded_tier 保留机制并行，任意顺序组合无冲突。
    if (
        declared_tier in ACCEPTED_TIERS
        and TIER_RANK[declared_tier] > TIER_RANK[tier]
    ):
        tier = declared_tier

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

    # ③ 写 gate-policy（plannedPhases=["task","archive"] 使 archive_auto_gate
    #    认得 phase.end(task)——harness_archive.py:3480-3485 的 completed_phase
    #    取 plannedPhases 中 archive 的前一个）。tier 用最终裁决值（含
    #    declared floor / recorded_tier 保留）——归档的 P13 文案与
    #    full-tier review 拦截都读这份文件的 tier。
    classification.setdefault("tierOverride", None)
    classification["tier"] = tier
    classification["classifiedAt"] = now_iso()
    policy_doc = hg.gate_policy_document(classification)
    policy_doc["plannedPhases"] = [TASK_PHASE, "archive"]
    hg._write_json(change_dir / "meta" / "gate-policy.json", policy_doc)

    verifications: list[dict[str, Any]] = []
    if closure == "completed":
        # ④ 变更感知验证计划（P1/P5/P6）+ ⑤ 逐项执行写 ledger
        signals = [str(s) for s in (classification.get("signals") or [])]
        plan = _plan_verifications(tier, signals, product_paths, project)
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
                emit(verify_error, as_json)
                return 2
            verifications.append(summary)
            if summary["status"] != "OK":
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
    head_hash = git_text(project, "rev-parse", "HEAD")
    committed_hash: str | None = None
    if not no_commit:
        default_message = (
            commit_message
            or f"harness-task: {task.get('goal') or change}"
        )
        committed_hash, commit_error = _git_commit_all(project, default_message)
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

    # ⑪ 更新 task.json 终态（归档会移走整个目录，终态必须先写才能入档；
    #     归档失败时在下方回滚为 open，保证 recoveryAction 承诺的
    #     finish 重跑不被 TASK_ALREADY_FINISHED 挡住）
    task["status"] = closure
    task["tier"] = tier
    task["finishedAt"] = now_iso()
    task["commit"] = head_hash
    write_json_file(change_dir / TASK_REL, task)

    # ⑫ 归档（record-only；completed 之外不要求 ledger——:2986-2991）。
    #     --no-commit 时跳过：无提交范围，归档必被
    #     ARCHIVE_BASE_EQUALS_FEATURE_TIP 阻断（base==HEAD 无产品增量）。
    if no_commit:
        emit(
            {
                "ok": True,
                "code": "TASK_FINISHED_NO_ARCHIVE",
                "changeId": change,
                "tier": tier,
                "closure": closure,
                "commit": head_hash,
                "verifications": verifications,
                "planPath": str(plan_path),
                "summary": {
                    "完成内容": task.get("goal"),
                    "验证结果": (
                        "；".join(
                            f"{v['verification']}={v['status']}({v['durationMs']}ms)"
                            for v in verifications
                        )
                        or "无（非 completed 闭包）"
                    ),
                    "残余风险": (
                        "--no-commit：变更未提交、未归档；工作区保持脏树"
                    ),
                    "代码位置": "未提交（工作区脏树）",
                },
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
        write_json_file(change_dir / TASK_REL, task)
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
            "code": "TASK_FINISHED",
            "changeId": change,
            "tier": tier,
            "closure": closure,
            "commit": head_hash,
            "verifications": verifications,
            "planPath": str(plan_path),
            "archiveDir": archive_dir,
            "summary": {
                "完成内容": task.get("goal"),
                "验证结果": (
                    "；".join(
                        f"{v['verification']}={v['status']}({v['durationMs']}ms)"
                        for v in verifications
                    )
                    or "无（非 completed 闭包）"
                ),
                "残余风险": (
                    "record-only 归档未做发布评审；full 档信号已前置拒绝"
                ),
                "代码位置": f"commit {head_hash}",
            },
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
    if status == "open":
        next_action = (
            "继续编辑/测试，然后 harness_task.py finish --project . "
            f"--change {change_dir.name} --json"
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
