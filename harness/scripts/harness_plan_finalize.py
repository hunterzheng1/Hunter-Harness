#!/usr/bin/env python3
"""已发布计划的只读验收与 v2 清单解包（read-side only）。

legacy staging/finalize/republish 写侧已于 2026-08 移除（roadmap 14；采纳度
gating 由用户决策解除）。新 change 的发布走 `hunter-harness plan evidence-pack`
+ `plan finalize`（v2）；计划修订走 evidence-pack 重跑（expected_baseline
= present + 新 attempt）。本模块保留：
- `verify_plan`：已发布计划的只读验收（legacy receipt 与 v2 事务/journal 两种
  证据形状），供 `harness_gate.validate_plan_handoff` 与 `verify` 子命令使用；
- v2 manifest / checkpoints 解包与 plan/scenario 表解析：供 gate 与 ledger
  在只读侧消费（哈希校验后）。

历史 change 的 legacy 产物必须保持可读；删除的是写入路径，不是读路径。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
from pathlib import Path, PurePosixPath
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_clarify as hcl  # noqa: E402
import harness_events  # noqa: E402
import harness_paths as hp  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

SCHEMA_VERSION = 1
_LINK = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
_BACKTICK = re.compile(r"`([^`\r\n]+)`")
_CODE_PATH_SUFFIXES = {
    ".c", ".cc", ".cpp", ".cs", ".css", ".go", ".h", ".hpp", ".html",
    ".java", ".js", ".jsx", ".kt", ".kts", ".mjs", ".php", ".py", ".rb",
    ".rs", ".scss", ".sh", ".svelte", ".swift", ".ts", ".tsx", ".vue",
}
_BUILD_FILE_NAMES = {
    "build.gradle", "build.gradle.kts", "cargo.toml", "composer.json", "go.mod",
    "gradle.properties", "package-lock.json", "package.json", "pnpm-lock.yaml",
    "pom.xml", "pyproject.toml", "requirements.txt", "settings.gradle",
    "settings.gradle.kts", "tsconfig.json", "yarn.lock",
}

# C8: valid ownerPhase values (lifecycle phases that can own tasks).
VALID_OWNER_PHASES = {"plan", "execute", "review", "submit"}
SLICE_CANDIDATE_TYPES = {
    "independent-release-candidate",
    "child-of-aggregate",
    "fixback-of",
    "evidence-only",
}

# C9: map scenario priority to required evidence kind.
PRIORITY_EVIDENCE_KIND = {
    "P0": "ledger",
    "P1": "ledger",
    "P2": "advisory",
}
_FILE_ATTRIBUTE_REPARSE_POINT = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)


def _result_error(code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "code": code, "error": message}


class PlanParseError(ValueError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _normalize_header(value: str) -> str:
    return re.sub(r"[\s_-]+", "", value).lower()


def _column_index(
    headers: list[str],
    *aliases: str,
) -> int | None:
    normalized = {
        _normalize_header(header): index for index, header in enumerate(headers)
    }
    for alias in aliases:
        index = normalized.get(_normalize_header(alias))
        if index is not None:
            return index
    return None


def _table_cells(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def parse_test_scenarios(scenarios_path: Path) -> list[dict[str, Any]]:
    """C9: parse test-scenarios.md tables, extracting scenario rows.

    Returns a list of dicts with keys: id / priority / scenario / verification /
    ownerPhase / requiredEvidenceKind (last one derived from priority).
    """
    text = Path(scenarios_path).read_text(encoding="utf-8-sig")
    lines = text.splitlines()
    scenarios: list[dict[str, Any]] = []
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if line.startswith("|"):
            headers = _table_cells(line)
            id_index = _column_index(headers, "ID", "#", "编号", "场景 ID")
            scenario_index = _column_index(
                headers,
                "场景",
                "场景描述",
                "scenario",
                "description",
            )
            if id_index is None or scenario_index is None:
                i += 1
                continue
            priority_index = _column_index(headers, "优先级", "priority")
            category_index = _column_index(headers, "分类", "category")
            verification_index = _column_index(
                headers,
                "验证方式",
                "verification",
                "可复用证据",
            )
            owner_phase_index = _column_index(
                headers,
                "owner phase",
                "ownerPhase",
                "负责阶段",
            )
            execution_tier_index = _column_index(
                headers,
                "执行层级",
                "execution tier",
                "tier",
            )
            expected_index = _column_index(headers, "预期", "expected")
            depends_index = _column_index(
                headers,
                "依赖",
                "依赖场景",
                "dependsOn",
                "depends on",
            )
            executable_id_index = _column_index(
                headers,
                "executable test ID",
                "executableTestId",
                "可执行测试 ID",
                "测试 ID",
            )
            test_file_index = _column_index(
                headers,
                "test file",
                "testFile",
                "测试文件",
                "spec path",
            )
            test_title_index = _column_index(
                headers,
                "test title",
                "testTitle",
                "测试标题",
                "用例标题",
            )
            executable_mapping_declared = any(
                index is not None
                for index in (
                    executable_id_index,
                    test_file_index,
                    test_title_index,
                )
            )

            row_index = i + 2
            while row_index < len(lines):
                row = lines[row_index].strip()
                if not row.startswith("|"):
                    break
                cells = _table_cells(row)
                if max(id_index, scenario_index) >= len(cells):
                    raise PlanParseError(
                        "PLAN_SCENARIO_ROW_INVALID",
                        f"{scenarios_path.name}: line {row_index + 1} is missing scenario ID or description",
                    )
                complete_row = len(cells) == len(headers)
                scenario_id = cells[id_index].strip()
                if not scenario_id or set(scenario_id) <= {"-", ":"}:
                    raise PlanParseError(
                        "PLAN_SCENARIO_ROW_INVALID",
                        f"{scenarios_path.name}: line {row_index + 1} has an empty scenario ID",
                    )
                scenario_text = cells[scenario_index].strip()
                if not scenario_text or set(scenario_text) <= {"-", ":"}:
                    raise PlanParseError(
                        "PLAN_SCENARIO_ROW_INVALID",
                        f"{scenarios_path.name}: line {row_index + 1} has an empty scenario description",
                    )
                priority = (
                    cells[priority_index].strip().upper()
                    if priority_index is not None
                    and priority_index < len(cells)
                    and cells[priority_index].strip()
                    else "P1"
                )
                scenario = {
                    "id": scenario_id,
                    "priority": priority,
                    "scenario": scenario_text,
                    "ownerPhase": (
                        cells[owner_phase_index].strip()
                        if owner_phase_index is not None
                        and complete_row
                        and owner_phase_index < len(cells)
                        and cells[owner_phase_index].strip()
                        else "execute"
                    ),
                    "requiredEvidenceKind": PRIORITY_EVIDENCE_KIND.get(
                        priority,
                        "advisory",
                    ),
                    "executableMappingDeclared": executable_mapping_declared,
                }
                if category_index is not None and category_index < len(cells):
                    if cells[category_index].strip():
                        scenario["category"] = cells[category_index].strip()
                for key, index in (
                    ("verification", verification_index),
                    ("executionTier", execution_tier_index),
                    ("expected", expected_index),
                    ("executableTestId", executable_id_index),
                    ("testFile", test_file_index),
                    ("testTitle", test_title_index),
                ):
                    if (
                        complete_row
                        and index is not None
                        and index < len(cells)
                        and cells[index].strip()
                    ):
                        scenario[key] = cells[index].strip()
                if (
                    complete_row
                    and depends_index is not None
                    and depends_index < len(cells)
                    and cells[depends_index].strip()
                    and not set(cells[depends_index].strip()) <= {"-", ":", "—", "·"}
                ):
                    depends_on = [
                        item.strip()
                        for item in cells[depends_index].split(",")
                        if item.strip()
                    ]
                    if depends_on:
                        scenario["dependsOn"] = depends_on
                scenarios.append(scenario)
                row_index += 1
            i = row_index
            continue
        i += 1
    return scenarios


def scenario_manifest_schema_version(scenarios: list[dict[str, Any]]) -> int:
    required = [
        item
        for item in scenarios
        if str(item.get("requiredEvidenceKind") or "") == "ledger"
    ]
    if required and all(
        all(
            str(item.get(field) or "").strip()
            for field in ("executableTestId", "testFile", "testTitle")
        )
        for item in required
    ):
        return 2
    return 1


# v2 场景键 → 门禁与 ledger 消费的 legacy 键。可执行三元是可选的：缺了只是把
# manifest 降到 schemaVersion 1（绑不上结构化执行收据），不算缺口。
_V2_SCENARIO_FIELD_MAP = (
    ("scenario_id", "id"),
    ("priority", "priority"),
    ("required_evidence_kind", "requiredEvidenceKind"),
    ("owner_phase", "ownerPhase"),
)
_V2_SCENARIO_OPTIONAL_FIELD_MAP = (
    ("executable_test_id", "executableTestId"),
    ("test_file", "testFile"),
    ("test_title", "testTitle"),
)
# 列表型可选字段（不走字符串空值判断）：仅非空字符串列表才映射，空列表归一为缺省。
_V2_SCENARIO_OPTIONAL_LIST_FIELD_MAP = (
    ("depends_on", "dependsOn"),
)
V2_MANIFEST_UNSUPPORTED = "SCENARIO_MANIFEST_V2_UNSUPPORTED"


def is_v2_scenario_manifest(manifest: Any) -> bool:
    """v2 plan finalize 派生的 scenario_manifest artifact 包装体。

    它没有顶层 schemaVersion，场景字段全在 content.scenarios 下且改了名。
    """
    return (
        isinstance(manifest, dict)
        and manifest.get("artifact_type") == "scenario_manifest"
    )


def unpack_v2_scenario_manifest(manifest: Any) -> dict[str, Any] | None:
    """v2 artifact 包装体 → 消费端的 legacy 形状；字段不齐时 fail-closed。

    返回 None 表示"这不是 v2 包装体"，调用方按 legacy 原样处理。否则返回
    ``{"ok": True, "manifest": {...}}``（已是 legacy 形状，后续判定逻辑对
    v2 与 legacy 完全一致）或 ``{"ok": False, "code": V2_MANIFEST_UNSUPPORTED}``。

    这个函数住在 finalizer 里，是因为 legacy manifest 的 schema 本来就由本模块
    定义（``scenario_manifest_schema_version`` / ``PRIORITY_EVIDENCE_KIND``）。
    门禁与 ledger 都 import 它，两边不会各推一套解包规则。

    为什么必须逐场景校验、不能取键的并集：并集只要有**一条**场景带了
    priority 就算"present"，其余缺 priority 的场景会静默落进非必需集，
    ``required_ids`` 随之缩水——那正是把证据门禁悄悄关掉的老路子。
    """
    if not is_v2_scenario_manifest(manifest):
        return None
    content = manifest.get("content")
    raw = content.get("scenarios") if isinstance(content, dict) else None
    if not isinstance(raw, list):
        return {
            "ok": False,
            "code": V2_MANIFEST_UNSUPPORTED,
            "message": "v2 scenario-manifest 的 content.scenarios 必须是数组",
            "missingFields": [legacy for _, legacy in _V2_SCENARIO_FIELD_MAP],
            "artifactType": "scenario_manifest",
        }
    scenarios: list[dict[str, Any]] = []
    missing: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            missing.update(legacy for _, legacy in _V2_SCENARIO_FIELD_MAP)
            continue
        mapped: dict[str, Any] = {}
        for source, legacy in _V2_SCENARIO_FIELD_MAP:
            value = item.get(source)
            if not str(value or "").strip():
                missing.add(legacy)
                continue
            mapped[legacy] = value
        for source, legacy in _V2_SCENARIO_OPTIONAL_FIELD_MAP:
            value = item.get(source)
            if str(value or "").strip():
                mapped[legacy] = value
        for source, legacy in _V2_SCENARIO_OPTIONAL_LIST_FIELD_MAP:
            value = item.get(source)
            if isinstance(value, list):
                entries = [str(dep).strip() for dep in value if str(dep).strip()]
                if entries:
                    mapped[legacy] = entries
        scenarios.append(mapped)
    if missing:
        return {
            "ok": False,
            "code": V2_MANIFEST_UNSUPPORTED,
            "message": (
                "meta/scenario-manifest.json 是 v2 plan artifact 包装体，"
                "部分场景缺少消费端需要的字段；请在规划阶段补齐后重新发布，"
                "不要手改派生产物"
            ),
            "missingFields": sorted(missing),
            "artifactType": "scenario_manifest",
        }
    return {
        "ok": True,
        "manifest": {
            # 与 legacy 同一条规则判版本，不另立一套。
            "schemaVersion": scenario_manifest_schema_version(scenarios),
            "scenarios": scenarios,
        },
    }


def compute_scenario_waves(scenarios: list[dict[str, Any]]) -> dict[str, Any]:
    """16-M1：从场景清单的 dependsOn 派生拓扑波次（纯函数，不持久化）。

    入参为 legacy 形状的场景区列表（``unpack_v2_scenario_manifest`` 的输出或
    legacy manifest 的 ``scenarios`` 数组）。返回::

        {"available": True, "waveCount": N, "waves": [[id, ...], ...],
         "parallelizable": bool, "declared": int}

    - 无依赖声明：全部场景归入单一波次（wave 0，互为可并行候选）。
    - 未知引用 / 成环：``available=False`` + ``reason`` + 细节；调用方只做
      advisory 降级，不得阻断主流程。
    波次内按 scenario_id 排序，输出确定性；同一输入永远同一波次计划。
    """
    deps: dict[str, list[str]] = {}
    for scenario in scenarios:
        if not isinstance(scenario, dict):
            continue
        scenario_id = str(
            scenario.get("id") or scenario.get("scenario_id") or ""
        ).strip()
        if not scenario_id or scenario_id in deps:
            continue
        raw_deps = scenario.get("dependsOn")
        if not isinstance(raw_deps, list):
            raw_deps = scenario.get("depends_on")
        deps[scenario_id] = (
            [str(dep).strip() for dep in raw_deps if str(dep).strip()]
            if isinstance(raw_deps, list)
            else []
        )
    if not deps:
        return {"available": False, "reason": "scenario-manifest-empty", "waves": []}
    id_set = set(deps)
    unknown_refs = sorted(
        {dep for dep_list in deps.values() for dep in dep_list} - id_set
    )
    if unknown_refs:
        return {
            "available": False,
            "reason": "scenario-dependency-unresolved",
            "unknownRefs": unknown_refs,
            "waves": [],
        }
    # Kahn 拓扑分层：每层 = 依赖已全部落在之前层级的场景集合
    remaining = {scenario_id: set(dep_list) for scenario_id, dep_list in deps.items()}
    waves: list[list[str]] = []
    resolved: set[str] = set()
    while remaining:
        ready = sorted(
            scenario_id
            for scenario_id, dep_set in remaining.items()
            if dep_set <= resolved
        )
        if not ready:
            return {
                "available": False,
                "reason": "scenario-dependency-cycle",
                "cycleNodes": sorted(remaining),
                "waves": waves,
            }
        waves.append(ready)
        resolved.update(ready)
        for scenario_id in ready:
            del remaining[scenario_id]
    return {
        "available": True,
        "waveCount": len(waves),
        "waves": waves,
        "parallelizable": len(waves) < len(deps),
        "declared": sum(1 for dep_list in deps.values() if dep_list),
    }


def unpack_v2_implementation_checkpoints(document: Any) -> dict[str, Any] | None:
    """v2 的 implementation_checkpoints artifact 包装体 → 门禁消费的形状。

    返回 None 表示"这不是 v2 包装体"，调用方按原样处理。

    v2 的 content 是 ``{tasks, foundation_gate}``，而 ``checkpoint_status`` 找的是
    ``checkpoints: [{id, status}]``——找不到就返回 "missing"，``foundation_gate_blocks``
    随即放行。也就是说 foundation-gate 对**所有 v2 计划**是静默关闭的。信息本身是够
    的（``foundation_gate`` 就是那个状态），只是形状不同，所以这里解包而不是改文件名
    ——与 scenario-manifest 同一模式。
    """
    if (
        not isinstance(document, dict)
        or document.get("artifact_type") != "implementation_checkpoints"
    ):
        return None
    content = document.get("content")
    content = content if isinstance(content, dict) else {}
    status = str(content.get("foundation_gate") or "").strip() or "pending"
    tasks = content.get("tasks")
    return {
        "schemaVersion": 1,
        "checkpoints": [{"id": "foundation-gate", "status": status, "blocking": True}],
        "tasks": tasks if isinstance(tasks, list) else [],
    }


def parse_plan_tasks(plan_path: Path) -> list[dict[str, str]]:
    """C8: parse plan.md task table rows, extracting optional ownerPhase/implementationDoneWhen/verificationPhase columns.

    Returns a list of dicts with keys: # / 簇 / 任务 / ownerPhase / implementationDoneWhen /
    verificationPhase / requiresExplicitAuthority (last four optional, only present when
    the column header includes them).
    """
    text = Path(plan_path).read_text(encoding="utf-8-sig")
    lines = text.splitlines()
    tasks: list[dict[str, str]] = []
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if not line.startswith("|"):
            i += 1
            continue
        headers = _table_cells(line)
        number_index = _column_index(headers, "#", "任务编号", "task ID")
        task_index = _column_index(headers, "任务", "task")
        if number_index is None or task_index is None:
            i += 1
            continue
        cluster_index = _column_index(headers, "簇", "cluster")
        optional_indices = {
            name: _column_index(headers, name)
            for name in (
                "ownerPhase",
                "implementationDoneWhen",
                "verificationPhase",
                "requiresExplicitAuthority",
            )
        }
        row_index = i + 2
        while row_index < len(lines):
            row = lines[row_index].strip()
            if not row.startswith("|"):
                break
            cells = _table_cells(row)
            if max(number_index, task_index) >= len(cells):
                raise PlanParseError(
                    "PLAN_TASK_ROW_INVALID",
                    f"{plan_path.name}: line {row_index + 1} is missing task ID or description",
                )
            complete_row = len(cells) == len(headers)
            number = cells[number_index].strip()
            task_text = cells[task_index].strip()
            if (
                not number
                or not task_text
                or set(number) <= {"-", ":"}
                or set(task_text) <= {"-", ":"}
            ):
                raise PlanParseError(
                    "PLAN_TASK_ROW_INVALID",
                    f"{plan_path.name}: line {row_index + 1} has an empty task ID or description",
                )
            task: dict[str, str] = {"num": number, "task": task_text}
            if cluster_index is not None and cells[cluster_index].strip():
                task["cluster"] = cells[cluster_index].strip()
            for name, index in optional_indices.items():
                if (
                    complete_row
                    and index is not None
                    and index < len(cells)
                    and cells[index].strip()
                ):
                    task[name] = cells[index].strip()
            tasks.append(task)
            row_index += 1
        i = row_index
    return tasks




def _frontmatter(text: str) -> dict[str, str] | None:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None
    data: dict[str, str] = {}
    for line in lines[1:]:
        if line.strip() == "---":
            return data
        if ":" not in line:
            return None
        key, value = line.split(":", 1)
        data[key.strip()] = value.strip()
    return None


def _required_artifact_names(change_name: str) -> set[str]:
    return {
        f"spec/{change_name}-design.md",
        f"plans/{change_name}-plan.md",
        f"plans/{change_name}-implementation-detail.md",
        f"plans/{change_name}-test-scenarios.md",
        "meta/gate-policy.json",
        "meta/worktree.json",
    }


def _is_link_or_reparse(path: Path) -> bool:
    """Detect symlinks and Windows reparse points on every supported Python."""
    try:
        if path.is_symlink():
            return True
        attributes = getattr(os.lstat(path), "st_file_attributes", 0)
    except OSError:
        return False
    return bool(attributes & _FILE_ATTRIBUTE_REPARSE_POINT)














def _receipt_artifact_targets(
    change_dir: Path,
    files_list: list[Any],
) -> tuple[list[tuple[str, Path]] | None, dict[str, Any] | None]:
    targets: list[tuple[str, Path]] = []
    seen: set[str] = set()
    for index, value in enumerate(files_list):
        if not isinstance(value, str):
            return None, _result_error(
                "RECEIPT_FILE_PATH_INVALID",
                f"receipt files[{index}] must be a string",
            )
        raw = value
        segments = raw.split("/")
        rel = PurePosixPath(raw)
        invalid = (
            not raw
            or raw != raw.strip()
            or "\\" in raw
            or ":" in raw
            or rel.is_absolute()
            or any(segment in {"", ".", ".."} for segment in segments)
            or any(segment.endswith((".", " ")) for segment in segments)
            or not rel.parts
            or rel.parts[0] not in {"spec", "plans", "meta"}
        )
        if invalid:
            return None, _result_error(
                "RECEIPT_FILE_PATH_INVALID",
                f"receipt files[{index}] is not a safe artifact-relative path: {raw!r}",
            )
        normalized = rel.as_posix()
        if normalized in seen:
            return None, _result_error(
                "RECEIPT_FILE_PATH_INVALID",
                f"receipt contains duplicate artifact path: {normalized}",
            )
        seen.add(normalized)
        target = change_dir.joinpath(*rel.parts)
        cursor = change_dir
        for part in rel.parts:
            cursor = cursor / part
            if _is_link_or_reparse(cursor):
                return None, _result_error(
                    "RECEIPT_FILE_PATH_INVALID",
                    f"receipt artifact path traverses a link: {normalized}",
                )
        try:
            target.resolve(strict=False).relative_to(change_dir)
        except (OSError, RuntimeError, ValueError):
            return None, _result_error(
                "RECEIPT_FILE_PATH_INVALID",
                f"receipt artifact path resolves outside the change directory: {normalized}",
            )
        targets.append((normalized, target))
    return targets, None


def _verify_plan_v2(change_dir: Path) -> dict[str, Any] | None:
    """v2 finalizer（TS）证据的只读验收。

    v2 不产生 meta/plan-finalization.json；canonical 证据是
    meta/plan-finalization-transactions/ + meta/publication-journals/。
    本路径只做结构验收：最新事务终态、匹配 journal 的 committed/readback、
    durable targets 存在且字节哈希与 binding 一致。内容质量由 TS 质量层裁决，
    Python 不重复审判。无 v2 证据时返回 None（调用方回退 RECEIPT_MISSING）。
    """
    transactions_dir = change_dir / "meta" / "plan-finalization-transactions"
    if not transactions_dir.is_dir():
        return None
    transactions = sorted(
        transactions_dir.glob("*.json"),
        key=lambda path: path.stat().st_mtime,
    )
    if not transactions:
        return None
    latest: dict[str, Any] | None = None
    for candidate in reversed(transactions):
        try:
            payload = json.loads(candidate.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(payload, dict):
            latest = payload
            break
    if latest is None:
        return None
    if latest.get("change_key") != change_dir.name:
        return _result_error(
            "RECEIPT_CHANGE_NAME_INVALID",
            "v2 transaction change_key does not match the change directory",
        )
    if latest.get("status") != "publication_committed_event_complete":
        return _result_error(
            "RECEIPT_NOT_FINALIZED",
            f"v2 transaction status is {latest.get('status')!r}, "
            "expected 'publication_committed_event_complete'",
        )
    operation_id = str(latest.get("operation_id") or "")
    journals_dir = change_dir / "meta" / "publication-journals"
    journal: dict[str, Any] | None = None
    if journals_dir.is_dir():
        for candidate in sorted(journals_dir.glob("*.json")):
            try:
                payload = json.loads(candidate.read_text(encoding="utf-8-sig"))
            except (OSError, json.JSONDecodeError):
                continue
            if isinstance(payload, dict) and payload.get("operation_id") == operation_id:
                journal = payload
                break
    if journal is None:
        return _result_error(
            "PUBLICATION_JOURNAL_MISSING",
            f"no publication journal matches v2 operation {operation_id!r}",
        )
    if journal.get("state") != "committed" or journal.get("readback") != "verified":
        return _result_error(
            "PUBLICATION_JOURNAL_NOT_COMMITTED",
            "v2 publication journal is not committed with verified readback",
        )
    binding = journal.get("binding")
    if not isinstance(binding, dict):
        return _result_error("PUBLICATION_BINDING_INVALID", "v2 journal binding missing")
    payload_hashes = binding.get("expected_payload_hashes")
    ownership_paths = binding.get("ownership_paths")
    if not isinstance(payload_hashes, dict) or not isinstance(ownership_paths, list):
        return _result_error("PUBLICATION_BINDING_INVALID", "v2 binding fields malformed")
    required = {
        f"plans/{change_dir.name}-design.md",
        f"plans/{change_dir.name}-plan.md",
        # 11-M3 两件套：implementation-detail/test-scenarios 已并入 design/plan 正文，
        # 不再单独落盘。子集校验天然向后兼容——旧 v2 目录的四件套是超集，仍通过。
        # v2 发布的是派生视图 meta/plan-profile.json，不是 Python classify 写的
        # meta/gate-policy.json——后者是 run/test 门禁的权威输入，不能被发布覆盖。
        "meta/plan-profile.json",
        "meta/worktree.json",
    }
    missing_required = sorted(required - set(ownership_paths))
    if missing_required:
        return _result_error(
            "RECEIPT_FILES_INCOMPLETE",
            "v2 journal omits required artifacts: " + ", ".join(missing_required),
        )
    for rel, expected_hash in payload_hashes.items():
        if not isinstance(expected_hash, str) or not expected_hash.startswith("sha256:"):
            return _result_error("PUBLICATION_BINDING_INVALID", f"{rel}: malformed hash")
        target = change_dir / rel
        try:
            resolved = target.resolve()
            resolved.relative_to(change_dir.resolve())
        except (OSError, ValueError):
            return _result_error(
                "RECEIPT_FILE_PATH_INVALID",
                f"v2 artifact path resolves outside the change directory: {rel}",
            )
        if not target.is_file():
            return _result_error("ARTIFACT_MISSING", f"published artifact missing: {rel}")
        actual_hash = "sha256:" + hashlib.sha256(target.read_bytes()).hexdigest()
        if actual_hash != expected_hash:
            return _result_error(
                "ARTIFACT_HASH_DRIFT",
                f"{rel}: content hash {actual_hash} != v2 binding {expected_hash}",
            )
    return {
        "ok": True,
        "code": "PLAN_V2_VERIFIED",
        "v2": True,
        "operationId": operation_id,
        "runId": latest.get("run_id"),
        "attempt": latest.get("attempt"),
        "artifactCount": len(payload_hashes),
        "status": latest.get("status"),
    }


def verify_plan(
    change_dir: Path, project: Path | None = None
) -> dict[str, Any]:
    """Read-only verification of a finalized plan (retro §5.8).

    Validates the published artifacts, receipt and events stream without
    requiring the original staging directory. Returns the artifact hash,
    phase.end count/status, frontmatter, and consistency checks. Any parse
    error or inconsistency results in ok=false with a non-zero exit code.

    Also attaches the 09-M4 knowledge-query gate verdict under
    ``knowledgeGate`` (read-only; it never flips ``ok``—the blocking site is
    ``harness_gate close --phase plan``). ``project`` defaults to the main
    project root derived from ``change_dir``.
    """
    change_dir = change_dir.resolve()
    receipt_path = change_dir / "meta" / "plan-finalization.json"
    if not receipt_path.is_file():
        # v2 finalizer 证据路径（canonical 事实源是 transactions + journals）
        v2_result = _verify_plan_v2(change_dir)
        if v2_result is not None:
            return _with_clarify_verdict(
                change_dir,
                _with_knowledge_gate_verdict(change_dir, v2_result, project),
                project,
            )
        return _result_error("RECEIPT_MISSING", f"receipt not found: {receipt_path}")

    try:
        receipt = json.loads(receipt_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        return _result_error("RECEIPT_INVALID", str(exc))
    if not isinstance(receipt, dict):
        return _result_error("RECEIPT_INVALID", "receipt top-level must be an object")

    change_name = str(receipt.get("changeName") or "").strip()
    if not change_name:
        return _result_error("RECEIPT_INVALID", "receipt missing changeName")
    if change_name != change_dir.name:
        return _result_error(
            "RECEIPT_CHANGE_NAME_INVALID",
            f"receipt changeName {change_name!r} does not match {change_dir.name!r}",
        )

    expected_hash = str(receipt.get("artifactsHash") or "").strip()
    if not expected_hash.startswith("sha256:"):
        return _result_error("RECEIPT_INVALID", "receipt artifactsHash missing or malformed")

    files_list = receipt.get("files")
    if not isinstance(files_list, list) or not files_list:
        return _result_error("RECEIPT_INVALID", "receipt files list missing or empty")
    artifact_targets, path_error = _receipt_artifact_targets(change_dir, files_list)
    if path_error is not None:
        return path_error
    assert artifact_targets is not None
    artifact_name_set = {rel for rel, _ in artifact_targets}
    missing_required = sorted(
        _required_artifact_names(change_name) - artifact_name_set
    )
    if missing_required:
        return _result_error(
            "RECEIPT_FILES_INCOMPLETE",
            "receipt omits required artifacts: " + ", ".join(missing_required),
        )
    if receipt.get("status") != "finalized":
        return _result_error(
            "RECEIPT_NOT_FINALIZED",
            f"receipt status is {receipt.get('status')!r}, expected 'finalized'",
        )
    receipt_run_id = str(receipt.get("runId") or "").strip()
    receipt_attempt = receipt.get("attempt")
    if not receipt_run_id or not isinstance(receipt_attempt, int):
        return _result_error(
            "RECEIPT_INVALID",
            "receipt runId/attempt identity is missing or malformed",
        )

    # Recompute artifacts hash from published files.
    digest = hashlib.sha256()
    artifact_names: list[str] = []
    for rel, target in artifact_targets:
        if not target.is_file():
            return _result_error(
                "ARTIFACT_MISSING", f"published artifact missing: {rel}"
            )
        artifact_names.append(rel)
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        digest.update(target.read_bytes())
        digest.update(b"\0")
    actual_hash = "sha256:" + digest.hexdigest()
    if actual_hash != expected_hash:
        return _result_error(
            "ARTIFACT_HASH_DRIFT",
            f"published artifacts hash {actual_hash} != receipt {expected_hash}",
        )

    # Validate frontmatter on markdown artifacts.
    frontmatter_results: dict[str, Any] = {}
    for rel in artifact_names:
        if not rel.endswith(".md"):
            continue
        target = change_dir / rel
        try:
            text = target.read_text(encoding="utf-8-sig")
        except OSError as exc:
            return _result_error("ARTIFACT_UNREADABLE", f"{rel}: {exc}")
        fm = _frontmatter(text)
        if fm is None:
            return _result_error(
                "ARTIFACT_FRONTMATTER_MISSING", f"{rel}: no frontmatter"
            )
        if fm.get("change-name") != change_name:
            return _result_error(
                "ARTIFACT_FRONTMATTER_INVALID",
                f"{rel}: change-name '{fm.get('change-name')}' != '{change_name}'",
            )
        frontmatter_results[rel] = {
            "change-name": fm.get("change-name"),
            "status": fm.get("status"),
        }

    plan_path = change_dir / "plans" / f"{change_name}-plan.md"
    try:
        expected_tasks = parse_plan_tasks(plan_path)
    except PlanParseError as exc:
        return _result_error(exc.code, str(exc))
    if not expected_tasks:
        return _result_error(
            "PLAN_TASKS_EMPTY",
            f"no task rows parsed from {plan_path.relative_to(change_dir).as_posix()}",
        )
    checkpoints_path = change_dir / "meta" / "implementation-checkpoints.json"
    if not checkpoints_path.is_file():
        return _result_error(
            "IMPLEMENTATION_CHECKPOINTS_MISSING",
            f"derived task metadata missing: {checkpoints_path}",
        )
    try:
        checkpoints = json.loads(
            checkpoints_path.read_text(encoding="utf-8-sig")
        )
    except (OSError, json.JSONDecodeError) as exc:
        return _result_error("IMPLEMENTATION_CHECKPOINTS_INVALID", str(exc))
    expected_checkpoints = {
        "schemaVersion": 1,
        "changeName": change_name,
        "tasks": expected_tasks,
        "foundationGate": "approved",
    }
    if checkpoints != expected_checkpoints:
        return _result_error(
            "IMPLEMENTATION_CHECKPOINTS_DRIFT",
            "derived implementation checkpoints do not match the finalized plan",
        )

    scenarios_path = (
        change_dir / "plans" / f"{change_name}-test-scenarios.md"
    )
    try:
        expected_scenarios = parse_test_scenarios(scenarios_path)
    except PlanParseError as exc:
        return _result_error(exc.code, str(exc))
    if not expected_scenarios:
        return _result_error(
            "PLAN_SCENARIOS_EMPTY",
            f"no scenario rows parsed from {scenarios_path.relative_to(change_dir).as_posix()}",
        )
    scenario_manifest_path = change_dir / "meta" / "scenario-manifest.json"
    if not scenario_manifest_path.is_file():
        return _result_error(
            "SCENARIO_MANIFEST_MISSING",
            f"derived scenario metadata missing: {scenario_manifest_path}",
        )
    try:
        manifest = json.loads(
            scenario_manifest_path.read_text(encoding="utf-8-sig")
        )
    except (OSError, json.JSONDecodeError) as exc:
        return _result_error("SCENARIO_MANIFEST_INVALID", str(exc))
    actual_scenarios = manifest.get("scenarios") if isinstance(manifest, dict) else None
    if not isinstance(actual_scenarios, list) or not actual_scenarios:
        return _result_error(
            "SCENARIO_MANIFEST_EMPTY",
            "scenario-manifest.json must contain at least one scenario",
        )

    expected_manifest = {
        "schemaVersion": scenario_manifest_schema_version(expected_scenarios),
        "changeName": change_name,
        "scenarios": [
            {
                key: value
                for key, value in scenario.items()
                if key != "executableMappingDeclared"
            }
            for scenario in expected_scenarios
        ],
    }
    if manifest != expected_manifest:
        return _result_error(
            "SCENARIO_MANIFEST_DRIFT",
            "derived scenario manifest does not match the finalized scenario table",
        )

    # Validate gate-policy.json is parseable JSON.
    gate_policy_path = change_dir / "meta" / "gate-policy.json"
    if not gate_policy_path.is_file():
        return _result_error(
            "GATE_POLICY_MISSING",
            f"gate policy missing: {gate_policy_path}",
        )
    try:
        json.loads(gate_policy_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        return _result_error("GATE_POLICY_INVALID", str(exc))
    gate_policy_consistent = True

    # Validate events.ndjson: require one matching start/end lifecycle.
    events_path = harness_events.events_path(change_dir)
    phase_start_count = 0
    phase_end_count = 0
    phase_end_status: str | None = None
    events_parse_errors: list[str] = []
    if events_path.is_file():
        for line_no, line in enumerate(events_path.read_text(encoding="utf-8").splitlines(), 1):
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError as exc:
                events_parse_errors.append(f"line {line_no}: {exc}")
                continue
            if not isinstance(event, dict):
                events_parse_errors.append(f"line {line_no}: not an object")
                continue
            if event.get("phase") != "plan":
                continue
            if (
                str(event.get("run_id") or "") != receipt_run_id
                or event.get("attempt") != receipt_attempt
            ):
                continue
            if event.get("type") == "phase.start":
                phase_start_count += 1
            elif event.get("type") == "phase.end":
                phase_end_count += 1
                phase_end_status = str(event.get("status") or "").upper()
    else:
        events_parse_errors.append("events.ndjson missing")

    if events_parse_errors:
        return _result_error(
            "EVENTS_PARSE_ERROR", "; ".join(events_parse_errors[:5])
        )

    if phase_start_count == 0:
        return _result_error(
            "PHASE_START_MISSING",
            "no matching plan phase.start event found",
        )
    if phase_start_count > 1:
        return _result_error(
            "PHASE_START_DUPLICATE",
            f"found {phase_start_count} matching plan phase.start events",
        )
    if phase_end_count == 0:
        return _result_error("PHASE_END_MISSING", "no plan phase.end event found")
    if phase_end_count > 1:
        return _result_error(
            "PHASE_END_DUPLICATE", f"found {phase_end_count} phase.end events"
        )
    if phase_end_status != "OK":
        return _result_error(
            "PHASE_END_NOT_OK",
            f"plan phase.end status is {phase_end_status!r}, expected 'OK'",
        )

    verified = _with_knowledge_gate_verdict(
        change_dir,
        {
            "ok": True,
            "action": "verify",
            "changeDir": str(change_dir),
            "changeName": change_name,
            "artifactsHash": actual_hash,
            "phaseStartCount": phase_start_count,
            "phaseEndCount": phase_end_count,
            "phaseEndStatus": phase_end_status,
            "frontmatter": frontmatter_results,
            "gatePolicyConsistent": gate_policy_consistent,
            "receiptConsistent": True,
            "taskCount": len(expected_tasks),
            "scenarioCount": len(expected_scenarios),
            "files": artifact_names,
        },
        project,
    )
    return _with_clarify_verdict(change_dir, verified, project)




















# ---------------------------------------------------------------------------
# 09-M4：知识查询门禁（plan 阶段 fail-closed）
#
# 门禁对象是「执行并留证」，不是「必须命中」：standard/full 档的 plan 关门
# 必须证明知识查询确实执行过（结构化构造，非原文直查），收据结构可验、身份
# 绑定本 change 所属项目、且不超过 09-M1 的两条预算。fast 档豁免并记录跳过
# 原因。锚点文件的唯一写入口是 record-knowledge-receipt 子命令（幂等
# upsert），门禁本身只读。默认 strict（fail-closed）；knowledgeGateMode=warn
# 可把阻断降级为警告。
# ---------------------------------------------------------------------------

KNOWLEDGE_RECEIPT_REL = Path("meta") / "knowledge-query-receipt.json"
KNOWLEDGE_GATE_MAX_QUERIES = 2
KNOWLEDGE_GATE_MODES = ("strict", "warn")
KNOWLEDGE_GATE_TIERS = ("fast", "standard", "full")
# 只有 standard/full 档要求留证；fast 档豁免。
KNOWLEDGE_GATE_REQUIRED_TIERS = frozenset({"standard", "full"})
_KNOWLEDGE_QUERY_ID = re.compile(r"^knowledge_query:[a-f0-9]{64}$")
_KNOWLEDGE_RECEIPT_ID = re.compile(r"^knowledge_query_receipt:[a-f0-9]{64}$")
_KNOWLEDGE_SHA256 = re.compile(r"^sha256:[a-f0-9]{64}$")
_KNOWLEDGE_PROJECT_ID = re.compile(r"^prj_[A-Za-z0-9_-]{1,124}$")
_KNOWLEDGE_REASONS = frozenset({
    "initial_intent",
    "directed_evidence_followup",
    "remote_knowledge_unavailable",
})
# 第二槽位必须是定向追查；失败尝试（远端不可用）不占用方向预算但仍占一条
# 查询额度。
_KNOWLEDGE_FOLLOWUP_REASONS = frozenset({
    "directed_evidence_followup",
    "remote_knowledge_unavailable",
})


def _knowledge_entry_error(code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "code": code, "message": message}


def _write_json_atomic(path: Path, data: Any) -> None:
    """原子 JSON 写（temp + os.replace，LF、UTF-8 无 BOM）。"""
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


def _project_for_change(change_dir: Path) -> Path:
    """从 change 目录推导主项目根（.harness/changes/<id> 布局优先）。"""
    contract_dir = Path(change_dir).resolve()
    harness_root = contract_dir.parent.parent
    if contract_dir.parent.name == "changes" and harness_root.name == ".harness":
        return harness_root.parent
    return hp.resolve_main_project_root(contract_dir)


def _bound_project_id(project: Path) -> str | None:
    """本 change 所属项目 id（.harness/project.yaml 的 project.project_id）。

    与 CLI readLocalProjectId 的解析口径一致；项目未绑定时为 None，此时
    standard/full 档门禁 fail-closed。
    """
    try:
        text = (Path(project) / ".harness" / "project.yaml").read_text(
            encoding="utf-8-sig"
        )
    except OSError:
        return None
    match = re.search(
        r"^[ \t]*project_id:\s*['\"]?([^'\"\n#]+)", text, re.MULTILINE
    )
    if match is None:
        return None
    value = match.group(1).strip()
    if value in {"", "null", "~", "none"}:
        return None
    return value


def knowledge_gate_tier(change_dir: Path) -> str:
    """解析 change 的档位（v2 plan-profile 的 tier 优先，回退 gate-policy.json）。

    缺失或未知取值一律按 fast 处理——存量 fast 路径行为不变。档位权威在阶段
    08 的 PlanProfile；这里只读，不重算。
    """
    try:
        loaded = hp.load_change_gate_policy(Path(change_dir))
    except (OSError, ValueError, json.JSONDecodeError):
        return "fast"
    policy = loaded.get("policy") if isinstance(loaded, dict) else None
    tier = str(policy.get("tier") or "").strip().lower() if isinstance(policy, dict) else ""
    return tier if tier in KNOWLEDGE_GATE_TIERS else "fast"


def knowledge_gate_mode(project: Path, change_dir: Path | None = None) -> str:
    """解析知识查询门禁模式：env > change gate-policy > project config > strict。

    与 gate 的全局 severityMode 分开：默认 fail-closed 是本门禁的立项语义，
    但必须留一个把阻断降级为警告的回滚开关（09-M4 兼容与回滚方式）。
    """
    env_mode = (
        str(os.environ.get("HUNTER_HARNESS_KNOWLEDGE_GATE_MODE") or "")
        .strip()
        .lower()
    )
    if env_mode in KNOWLEDGE_GATE_MODES:
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
        value = str(document.get("knowledgeGateMode") or "").strip().lower()
        if value in KNOWLEDGE_GATE_MODES:
            return value
    return "strict"


def _validate_knowledge_entry(
    entry: Any, bound_project_id: str | None
) -> dict[str, Any]:
    """校验单条 `knowledge query --json` 载荷，返回归一化身份字段。

    只认 CLI 实际输出的形状；没有 receipt 的失败输出证明不了任何查询发生过，
    按非法收据拒绝。返回 {"ok": True, query_id/receipt_id/project_id/status/
    reason_code/resultCount} 或 {"ok": False, code, message}。
    """
    if not isinstance(entry, dict):
        return _knowledge_entry_error(
            "KNOWLEDGE_GATE_RECEIPT_INVALID", "query entry must be an object"
        )
    if entry.get("schema_version") != 1 or entry.get("command") != "knowledge query":
        return _knowledge_entry_error(
            "KNOWLEDGE_GATE_RECEIPT_INVALID",
            "query entry is not a knowledge-query v1 payload",
        )
    if entry.get("source") != "remote" or entry.get("fallback") is not False:
        return _knowledge_entry_error(
            "KNOWLEDGE_GATE_RECEIPT_INVALID",
            "query entry must come from the remote source with fallback=false",
        )
    query_id = str(entry.get("query_id") or "")
    if _KNOWLEDGE_QUERY_ID.fullmatch(query_id) is None:
        return _knowledge_entry_error(
            "KNOWLEDGE_GATE_RECEIPT_INVALID", f"query_id malformed: {query_id!r}"
        )
    project_id = str(entry.get("project_id") or "")
    if _KNOWLEDGE_PROJECT_ID.fullmatch(project_id) is None:
        return _knowledge_entry_error(
            "KNOWLEDGE_GATE_RECEIPT_INVALID", f"project_id malformed: {project_id!r}"
        )
    if bound_project_id is not None and project_id != bound_project_id:
        return _knowledge_entry_error(
            "KNOWLEDGE_GATE_PROJECT_MISMATCH",
            f"receipt project {project_id!r} != bound project {bound_project_id!r}",
        )
    receipt = entry.get("receipt")
    if not isinstance(receipt, dict) or receipt.get("schema_version") != 1:
        return _knowledge_entry_error(
            "KNOWLEDGE_GATE_RECEIPT_INVALID",
            "query entry carries no verifiable receipt anchor",
        )
    receipt_id = str(receipt.get("receipt_id") or "")
    if _KNOWLEDGE_RECEIPT_ID.fullmatch(receipt_id) is None:
        return _knowledge_entry_error(
            "KNOWLEDGE_GATE_RECEIPT_INVALID", f"receipt_id malformed: {receipt_id!r}"
        )
    query_hash = str(receipt.get("query_hash") or "")
    if _KNOWLEDGE_SHA256.fullmatch(query_hash) is None:
        return _knowledge_entry_error(
            "KNOWLEDGE_GATE_RECEIPT_INVALID", f"query_hash malformed: {query_hash!r}"
        )
    if query_hash.split(":", 1)[1] != query_id.split(":", 1)[1]:
        return _knowledge_entry_error(
            "KNOWLEDGE_GATE_IDENTITY_MISMATCH",
            "query_id does not bind receipt.query_hash",
        )
    if receipt.get("project_id") != project_id:
        return _knowledge_entry_error(
            "KNOWLEDGE_GATE_PROJECT_MISMATCH",
            "receipt.project_id does not match the payload project_id",
        )
    status = str(receipt.get("status") or "")
    if status not in {"succeeded", "failed"}:
        return _knowledge_entry_error(
            "KNOWLEDGE_GATE_RECEIPT_INVALID", f"receipt status invalid: {status!r}"
        )
    reason_code = str(receipt.get("reason_code") or "")
    if reason_code not in _KNOWLEDGE_REASONS:
        return _knowledge_entry_error(
            "KNOWLEDGE_GATE_RECEIPT_INVALID", f"reason_code invalid: {reason_code!r}"
        )
    if (status == "failed") != (reason_code == "remote_knowledge_unavailable"):
        return _knowledge_entry_error(
            "KNOWLEDGE_GATE_RECEIPT_INVALID",
            "receipt failure semantics are inconsistent with its status",
        )
    if status == "failed" and not str(receipt.get("failure_code") or "").strip():
        return _knowledge_entry_error(
            "KNOWLEDGE_GATE_RECEIPT_INVALID", "failed receipt carries no failure_code"
        )
    if not str(receipt.get("executed_at") or "").strip():
        return _knowledge_entry_error(
            "KNOWLEDGE_GATE_RECEIPT_INVALID", "receipt executed_at missing"
        )
    if status == "succeeded" and not isinstance(receipt.get("result_ids"), list):
        return _knowledge_entry_error(
            "KNOWLEDGE_GATE_RECEIPT_INVALID", "successful receipt result_ids missing"
        )
    return {
        "ok": True,
        "query_id": query_id,
        "receipt_id": receipt_id,
        "project_id": project_id,
        "status": status,
        "reason_code": reason_code,
        "resultCount": len(receipt.get("result_ids") or []),
    }


def validate_knowledge_query_gate(project: Path, change_dir: Path) -> dict[str, Any]:
    """plan 关门/交接时的知识查询门禁（只读，09-M4）。

    fast 档豁免并记录跳过原因；standard/full 档要求收据锚点存在、逐条结构与
    身份合法、项目绑定一致、查询数 ≤2 且第二槽位是定向追查。返回 ok/code/
    message + mode/tier/queryCount 等机器字段；中文文案仅展示，不参与判定。
    """
    change_dir = Path(change_dir).resolve()
    project = Path(project).resolve()
    mode = knowledge_gate_mode(project, change_dir)
    tier = knowledge_gate_tier(change_dir)
    verdict: dict[str, Any] = {
        "mode": mode,
        "tier": tier,
        "changeDir": str(change_dir),
    }
    if tier not in KNOWLEDGE_GATE_REQUIRED_TIERS:
        verdict.update({
            "ok": True,
            "code": "KNOWLEDGE_GATE_SKIPPED",
            "skipped": True,
            "queryCount": 0,
            "skipReason": (
                f"{tier} 档豁免知识查询门禁（09-M4 只约束 standard/full）；"
                "未执行查询不构成本阶段缺陷"
            ),
        })
        return verdict
    bound_project_id = _bound_project_id(project)
    if bound_project_id is None:
        verdict.update({
            "ok": False,
            "code": "KNOWLEDGE_GATE_PROJECT_UNBOUND",
            "message": (
                "项目尚未绑定远端平台（.harness/project.yaml 缺 project.project_id），"
                "无法校验知识查询收据的项目身份；先 connect 绑定后重跑"
            ),
        })
        return verdict
    receipt_path = change_dir / KNOWLEDGE_RECEIPT_REL
    if not receipt_path.is_file():
        verdict.update({
            "ok": False,
            "code": "KNOWLEDGE_GATE_RECEIPT_MISSING",
            "message": (
                f"{tier} 档要求在 {KNOWLEDGE_RECEIPT_REL.as_posix()} 留下知识查询"
                "收据锚点。执行结构化查询并留证：\n"
                "  npx hunter-harness knowledge query \"<结构化查询词>\" "
                "--limit 10 --json > knowledge-query.json\n"
                "  python <skills-root>/scripts/harness_plan_finalize.py "
                "record-knowledge-receipt --change-dir <change-dir> "
                "--payload-file knowledge-query.json"
            ),
        })
        return verdict
    try:
        anchor = json.loads(receipt_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        verdict.update({
            "ok": False,
            "code": "KNOWLEDGE_GATE_RECEIPT_INVALID",
            "message": f"收据锚点无法解析：{exc}",
        })
        return verdict
    queries = anchor.get("queries") if isinstance(anchor, dict) else None
    if (
        not isinstance(anchor, dict)
        or anchor.get("schema_version") != 1
        or not isinstance(queries, list)
    ):
        verdict.update({
            "ok": False,
            "code": "KNOWLEDGE_GATE_RECEIPT_INVALID",
            "message": "收据锚点形状非法：需要 {\"schema_version\": 1, \"queries\": [...]}",
        })
        return verdict
    if not queries:
        verdict.update({
            "ok": False,
            "code": "KNOWLEDGE_GATE_RECEIPT_MISSING",
            "message": "收据锚点存在但没有任何查询记录",
        })
        return verdict
    if len(queries) > KNOWLEDGE_GATE_MAX_QUERIES:
        verdict.update({
            "ok": False,
            "code": "KNOWLEDGE_GATE_BUDGET_EXCEEDED",
            "message": (
                f"知识查询预算为 {KNOWLEDGE_GATE_MAX_QUERIES} 条，锚点记录了 "
                f"{len(queries)} 条"
            ),
        })
        return verdict
    normalized: list[dict[str, Any]] = []
    for index, entry in enumerate(queries):
        checked = _validate_knowledge_entry(entry, bound_project_id)
        if not checked.get("ok"):
            verdict.update({
                "ok": False,
                "code": str(checked.get("code") or "KNOWLEDGE_GATE_RECEIPT_INVALID"),
                "message": f"第 {index + 1} 条查询收据非法：{checked.get('message')}",
                "queryIndex": index,
            })
            return verdict
        if index >= 1 and checked["reason_code"] not in _KNOWLEDGE_FOLLOWUP_REASONS:
            verdict.update({
                "ok": False,
                "code": "KNOWLEDGE_GATE_REASON_INVALID",
                "message": (
                    f"第 {index + 1} 条查询必须携带 reason_code="
                    "directed_evidence_followup（阶段 09 的两条预算约束）"
                ),
                "queryIndex": index,
            })
            return verdict
        normalized.append(checked)
    failed = [item for item in normalized if item["status"] == "failed"]
    if failed and len(failed) == len(normalized):
        verdict.update({
            "ok": False,
            "code": "KNOWLEDGE_GATE_QUERY_FAILED",
            "message": (
                "全部知识查询都失败（远端不可用）；恢复远端后重查，或按配置把"
                "门禁降级为警告（knowledgeGateMode=warn）再关门"
            ),
            "queryCount": len(normalized),
            "failedCount": len(failed),
        })
        return verdict
    verdict.update({
        "ok": True,
        "code": "KNOWLEDGE_GATE_OK",
        "skipped": False,
        "queryCount": len(normalized),
        "failedCount": len(failed),
        "queryIds": [item["query_id"] for item in normalized],
        "receiptIds": [item["receipt_id"] for item in normalized],
        "reasonCodes": [item["reason_code"] for item in normalized],
        "resultCounts": [item["resultCount"] for item in normalized],
    })
    return verdict


def record_knowledge_receipt(
    change_dir: Path, payload: Any, project: Path | None = None
) -> dict[str, Any]:
    """把一条 `knowledge query --json` 载荷写入收据锚点（唯一写入口）。

    按 query_id 幂等 upsert（同一条查询重录 = 重放，不是新查询）；锚点最多
    保留 KNOWLEDGE_GATE_MAX_QUERIES 条，第二槽位必须是定向追查理由。
    """
    change_dir = Path(change_dir).resolve()
    if not change_dir.is_dir():
        return _knowledge_entry_error(
            "CHANGE_DIR_MISSING", f"change directory not found: {change_dir}"
        )
    resolved_project = (
        Path(project).resolve()
        if project is not None
        else _project_for_change(change_dir)
    )
    checked = _validate_knowledge_entry(payload, _bound_project_id(resolved_project))
    if not checked.get("ok"):
        return checked
    anchor_path = change_dir / KNOWLEDGE_RECEIPT_REL
    queries: list[Any] = []
    if anchor_path.is_file():
        try:
            existing = json.loads(anchor_path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError) as exc:
            return _knowledge_entry_error(
                "KNOWLEDGE_GATE_RECEIPT_INVALID",
                f"existing anchor is unreadable: {exc}",
            )
        if (
            not isinstance(existing, dict)
            or existing.get("schema_version") != 1
            or not isinstance(existing.get("queries"), list)
        ):
            return _knowledge_entry_error(
                "KNOWLEDGE_GATE_RECEIPT_INVALID",
                "existing anchor shape is invalid; refusing to overwrite",
            )
        queries = list(existing["queries"])
    replaced_index = next(
        (
            index
            for index, item in enumerate(queries)
            if isinstance(item, dict) and item.get("query_id") == checked["query_id"]
        ),
        None,
    )
    if replaced_index is not None:
        queries[replaced_index] = payload
    else:
        if len(queries) >= KNOWLEDGE_GATE_MAX_QUERIES:
            return _knowledge_entry_error(
                "KNOWLEDGE_GATE_BUDGET_EXCEEDED",
                (
                    f"知识查询预算已满（{KNOWLEDGE_GATE_MAX_QUERIES} 条）；同一条"
                    "查询重录是幂等重放，新查询需要新 change"
                ),
            )
        if (
            len(queries) == 1
            and checked["reason_code"] not in _KNOWLEDGE_FOLLOWUP_REASONS
        ):
            return _knowledge_entry_error(
                "KNOWLEDGE_GATE_REASON_INVALID",
                (
                    "第二条查询必须携带 reason_code=directed_evidence_followup"
                    "（首查结果不足或冲突时的定向追查）"
                ),
            )
        queries.append(payload)
    _write_json_atomic(anchor_path, {"schema_version": 1, "queries": queries})
    return {
        "ok": True,
        "code": "KNOWLEDGE_RECEIPT_RECORDED",
        "queryId": checked["query_id"],
        "receiptId": checked["receipt_id"],
        "projectId": checked["project_id"],
        "reasonCode": checked["reason_code"],
        "status": checked["status"],
        "queryCount": len(queries),
        "replaced": replaced_index is not None,
        "path": str(anchor_path),
    }


def _with_knowledge_gate_verdict(
    change_dir: Path, result: dict[str, Any], project: Path | None = None
) -> dict[str, Any]:
    """把知识查询门禁判定附到 verify 结果上（只读，不改 ok）。

    阻断点只有一个：plan 关门门禁（harness_gate cmd_close --phase plan）。
    verify 是交接读路径，交的是判定事实——执行侧按自己的软站点策略处置。
    """
    if not result.get("ok"):
        return result
    verdict = validate_knowledge_query_gate(
        Path(project) if project is not None else _project_for_change(change_dir),
        change_dir,
    )
    enriched = dict(result)
    enriched["knowledgeGate"] = verdict
    return enriched


def _with_clarify_verdict(
    change_dir: Path, result: dict[str, Any], project: Path | None = None
) -> dict[str, Any]:
    """把需求澄清门禁判定附到 verify 结果上（只读，不改 ok，10-M3）。

    与知识查询门禁同一约定：阻断点唯一（plan 关门），verify 只交判定事实。
    """
    if not result.get("ok"):
        return result
    verdict = hcl.validate_clarify_gate(
        Path(project) if project is not None else _project_for_change(change_dir),
        change_dir,
    )
    enriched = dict(result)
    enriched["clarifyGate"] = verdict
    return enriched


def _cmd_verify(args: argparse.Namespace) -> int:
    project = Path(args.project) if getattr(args, "project", None) else None
    result = verify_plan(Path(args.change_dir), project=project)
    stream = sys.stdout if result["ok"] else sys.stderr
    if args.json:
        stream.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    else:
        stream.write((result.get("action") or result.get("code") or "error") + "\n")
    return 0 if result["ok"] else 1


def _cmd_record_knowledge_receipt(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    result: dict[str, Any] | None = None
    raw: str | None = None
    if bool(args.payload_file) == bool(args.payload):
        result = _knowledge_entry_error(
            "PAYLOAD_REQUIRED", "pass exactly one of --payload-file or --payload"
        )
    elif args.payload_file:
        try:
            raw = Path(args.payload_file).read_text(encoding="utf-8-sig")
        except OSError as exc:
            result = _knowledge_entry_error("PAYLOAD_UNREADABLE", str(exc))
    else:
        raw = str(args.payload)
    if raw is not None:
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            result = _knowledge_entry_error("PAYLOAD_INVALID", str(exc))
        else:
            result = record_knowledge_receipt(
                Path(args.change_dir),
                payload,
                project=Path(args.project) if args.project else None,
            )
    assert result is not None
    stream = sys.stdout if result.get("ok") else sys.stderr
    if as_json:
        stream.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    else:
        stream.write((result.get("code") or "error") + "\n")
    return 0 if result.get("ok") else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harness_plan_finalize.py")
    sub = parser.add_subparsers(dest="command", required=True)
    verify = sub.add_parser("verify")
    verify.add_argument("--change-dir", required=True)
    verify.add_argument("--project", default=None)
    verify.add_argument("--json", action="store_true")
    verify.set_defaults(func=_cmd_verify)
    record = sub.add_parser(
        "record-knowledge-receipt",
        help=(
            "把一条 `knowledge query --json` 载荷写入 "
            "meta/knowledge-query-receipt.json（幂等 upsert）"
        ),
    )
    record.add_argument("--change-dir", required=True)
    record.add_argument("--project", default=None)
    record.add_argument("--payload-file", default=None)
    record.add_argument("--payload", default=None)
    record.add_argument("--json", action="store_true")
    record.set_defaults(func=_cmd_record_knowledge_receipt)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
