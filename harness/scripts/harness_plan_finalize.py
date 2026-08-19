#!/usr/bin/env python3
"""Validate and publish a complete Harness plan artifact set transactionally."""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import os
import re
import shutil
import stat
import sys
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_events  # noqa: E402

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
VALID_OWNER_PHASES = {"plan", "run", "test", "review", "submit"}
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
                        else "test"
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


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, raw_tmp = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    tmp = Path(raw_tmp)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


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


def lint_slice_plan(plan_path: Path) -> dict[str, Any]:
    """Validate the identity, reuse, and storage contract for a slice plan."""
    text = Path(plan_path).read_text(encoding="utf-8-sig")
    frontmatter = _frontmatter(text)
    if frontmatter is None:
        return _result_error(
            "SLICE_PLAN_CONTRACT_INVALID",
            f"{plan_path.name}: frontmatter is required",
        )
    enabled = (
        str(frontmatter.get("slice-plan") or "").strip().lower()
        in {"true", "yes", "1"}
        or "candidate-type" in frontmatter
    )
    if not enabled:
        return {
            "ok": True,
            "configured": False,
            "code": "SLICE_PLAN_NOT_CONFIGURED",
        }

    issues: list[str] = []
    candidate_type = str(frontmatter.get("candidate-type") or "").strip()
    aggregate_parent = str(frontmatter.get("aggregate-parent") or "").strip()
    evidence_reuse = str(frontmatter.get("evidence-reuse") or "").strip()
    raw_budget = str(frontmatter.get("artifact-budget-bytes") or "").strip()
    if candidate_type not in SLICE_CANDIDATE_TYPES:
        issues.append(
            "candidate-type must be one of "
            + ", ".join(sorted(SLICE_CANDIDATE_TYPES))
        )
    if not aggregate_parent:
        issues.append(
            "aggregate-parent is required (use 'none' for an independent candidate)"
        )
    if not evidence_reuse:
        issues.append(
            "evidence-reuse is required (use 'none' when no evidence is reused)"
        )
    try:
        artifact_budget = int(raw_budget)
        if artifact_budget <= 0:
            raise ValueError
    except ValueError:
        artifact_budget = 0
        issues.append("artifact-budget-bytes must be a positive integer")
    if issues:
        return {
            "ok": False,
            "code": "SLICE_PLAN_CONTRACT_INVALID",
            "error": f"{plan_path.name}: " + "; ".join(issues),
            "issues": issues,
        }
    return {
        "ok": True,
        "configured": True,
        "code": "SLICE_PLAN_CONTRACT_OK",
        "candidateType": candidate_type,
        "aggregateParent": aggregate_parent,
        "evidenceReuse": evidence_reuse,
        "artifactBudgetBytes": artifact_budget,
    }


def _artifact_files(staging: Path) -> list[Path]:
    files: list[Path] = []
    for path in staging.rglob("*"):
        if _is_link_or_reparse(path):
            raise ValueError(f"PLAN_ARTIFACT_SYMLINK: {path}")
        if path.is_file():
            files.append(path)
    return sorted(files, key=lambda item: item.relative_to(staging).as_posix())


def validate_staging(staging: Path, change_name: str) -> dict[str, Any]:
    staging = staging.resolve()
    required = {Path(name) for name in _required_artifact_names(change_name)}
    try:
        files = _artifact_files(staging)
    except ValueError as exc:
        code = str(exc).split(":", 1)[0]
        return _result_error(code, str(exc))
    rel_files = {path.relative_to(staging) for path in files}
    missing = sorted(path.as_posix() for path in required - rel_files)
    if missing:
        return _result_error(
            "PLAN_ARTIFACT_MISSING", "missing required artifacts: " + ", ".join(missing)
        )

    for path in files:
        rel = path.relative_to(staging)
        if rel.parts[0] not in {"spec", "plans", "meta"}:
            return _result_error(
                "PLAN_ARTIFACT_PATH_INVALID", f"unexpected artifact root: {rel.as_posix()}"
            )
        if path.suffix.lower() == ".json":
            try:
                payload = json.loads(path.read_text(encoding="utf-8-sig"))
            except (OSError, json.JSONDecodeError) as exc:
                return _result_error(
                    "PLAN_ARTIFACT_INVALID_JSON", f"{rel.as_posix()}: {exc}"
                )
            if not isinstance(payload, dict):
                return _result_error(
                    "PLAN_ARTIFACT_INVALID_JSON",
                    f"{rel.as_posix()}: top-level JSON must be an object",
                )
        elif path.suffix.lower() == ".md":
            try:
                text = path.read_text(encoding="utf-8-sig")
            except OSError as exc:
                return _result_error("PLAN_ARTIFACT_UNREADABLE", str(exc))
            frontmatter = _frontmatter(text)
            if frontmatter is None or frontmatter.get("change-name") != change_name:
                return _result_error(
                    "PLAN_ARTIFACT_FRONTMATTER_INVALID",
                    f"{rel.as_posix()}: change-name frontmatter mismatch",
                )
            for raw_link in _LINK.findall(text):
                link = raw_link.strip().split("#", 1)[0]
                if not link or "://" in link or link.startswith("mailto:"):
                    continue
                target = (path.parent / link).resolve()
                try:
                    target.relative_to(staging)
                except ValueError:
                    return _result_error(
                        "PLAN_ARTIFACT_REFERENCE_INVALID",
                        f"{rel.as_posix()}: reference escapes staging: {raw_link}",
                    )
                if not target.is_file():
                    return _result_error(
                        "PLAN_ARTIFACT_REFERENCE_MISSING",
                        f"{rel.as_posix()}: missing reference {raw_link}",
                    )

    # C8: validate ownerPhase values in plan.md task table.
    plan_path = staging / "plans" / f"{change_name}-plan.md"
    try:
        tasks = parse_plan_tasks(plan_path)
    except PlanParseError as exc:
        return _result_error(exc.code, str(exc))
    if not tasks:
        return _result_error(
            "PLAN_TASKS_EMPTY",
            f"{plan_path.relative_to(staging).as_posix()}: no task rows were parsed",
        )
    task_ids = [str(task.get("num") or "").strip() for task in tasks]
    duplicate_task_ids = sorted(
        {task_id for task_id in task_ids if task_ids.count(task_id) > 1}
    )
    if duplicate_task_ids:
        return _result_error(
            "PLAN_TASK_ID_DUPLICATE",
            "duplicate task IDs: " + ", ".join(duplicate_task_ids),
        )
    for task in tasks:
        owner = task.get("ownerPhase")
        if owner is not None and owner != "" and owner not in VALID_OWNER_PHASES:
            return _result_error(
                "PLAN_OWNER_PHASE_INVALID",
                f"task {task.get('num', '?')}: ownerPhase '{owner}' not in {sorted(VALID_OWNER_PHASES)}",
            )
    slice_plan = lint_slice_plan(plan_path)
    if not slice_plan.get("ok"):
        return slice_plan

    # C9: parse test-scenarios.md for scenario manifest.
    scenarios_path = staging / "plans" / f"{change_name}-test-scenarios.md"
    try:
        scenarios = parse_test_scenarios(scenarios_path)
    except PlanParseError as exc:
        return _result_error(exc.code, str(exc))
    if not scenarios:
        return _result_error(
            "PLAN_SCENARIOS_EMPTY",
            f"{scenarios_path.relative_to(staging).as_posix()}: no scenario rows were parsed",
        )
    scenario_ids = [str(item.get("id") or "").strip() for item in scenarios]
    duplicate_scenario_ids = sorted(
        {
            scenario_id
            for scenario_id in scenario_ids
            if scenario_ids.count(scenario_id) > 1
        }
    )
    if duplicate_scenario_ids:
        return _result_error(
            "PLAN_SCENARIO_ID_DUPLICATE",
            "duplicate scenario IDs: " + ", ".join(duplicate_scenario_ids),
        )
    for scenario in scenarios:
        priority = str(scenario.get("priority") or "").upper()
        if priority not in PRIORITY_EVIDENCE_KIND:
            return _result_error(
                "PLAN_SCENARIO_PRIORITY_INVALID",
                f"scenario {scenario.get('id', '?')}: unsupported priority '{priority}'",
            )
        owner = str(scenario.get("ownerPhase") or "")
        if owner not in VALID_OWNER_PHASES:
            return _result_error(
                "PLAN_SCENARIO_OWNER_PHASE_INVALID",
                f"scenario {scenario.get('id', '?')}: unsupported ownerPhase '{owner}'",
            )
        if (
            scenario.get("requiredEvidenceKind") == "ledger"
            and scenario.get("executableMappingDeclared")
        ):
            missing_mapping = [
                field
                for field in ("executableTestId", "testFile", "testTitle")
                if not str(scenario.get(field) or "").strip()
            ]
            if missing_mapping:
                return _result_error(
                    "PLAN_SCENARIO_EXECUTABLE_MAPPING_MISSING",
                    f"scenario {scenario.get('id', '?')}: missing executable mapping fields: "
                    + ", ".join(missing_mapping),
                )

    digest = hashlib.sha256()
    artifact_names: list[str] = []
    for path in files:
        rel = path.relative_to(staging).as_posix()
        artifact_names.append(rel)
        digest.update(rel.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return {
        "ok": True,
        "files": artifact_names,
        "artifactsHash": "sha256:" + digest.hexdigest(),
        "tasks": tasks,
        "scenarios": scenarios,
        "slicePlan": slice_plan,
    }


def validate_product_ownership(change_dir: Path, staging: Path) -> dict[str, Any]:
    """Ensure Plan declares stable prefix ownership for explicit code/test/build paths."""
    context_path = change_dir / "meta" / "change-context.json"
    if not context_path.is_file():
        return {"ok": True, "code": "PLAN_PRODUCT_PATHS_LEGACY_UNDECLARED"}
    try:
        context = json.loads(context_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        return _result_error("PLAN_CHANGE_CONTEXT_INVALID", str(exc))
    ownership = context.get("ownership") if isinstance(context, dict) else None
    raw_paths = ownership.get("productPaths") if isinstance(ownership, dict) else None
    product_paths = [
        str(item).strip().replace("\\", "/").removeprefix("./")
        for item in raw_paths or []
        if isinstance(item, str) and item.strip()
    ]
    unsupported = sorted(path for path in product_paths if any(char in path for char in "*?[]"))
    if unsupported:
        result = _result_error(
            "PLAN_PRODUCT_PATHS_GLOB_UNSUPPORTED",
            "productPaths 只接受精确文件或目录前缀，不支持通配：" + ", ".join(unsupported),
        )
        result["unsupportedPaths"] = unsupported
        return result

    planned_paths: set[str] = set()
    for document in sorted(staging.rglob("*.md")):
        text = document.read_text(encoding="utf-8-sig")
        for raw in _BACKTICK.findall(text):
            candidate = raw.strip().strip("'\"").replace("\\", "/")
            if not candidate or " " in candidate or "://" in candidate or "<" in candidate:
                continue
            candidate = re.sub(r":\d+(?::\d+)?$", "", candidate)
            candidate = candidate.removeprefix("./").strip("/.,;，；")
            if not candidate or candidate.startswith("../") or candidate.startswith(".harness/"):
                continue
            pure = PurePosixPath(candidate)
            if pure.name.lower() in _BUILD_FILE_NAMES or pure.suffix.lower() in _CODE_PATH_SUFFIXES:
                planned_paths.add(candidate)

    def covered(path: str) -> bool:
        return any(
            path == owned.rstrip("/")
            or path.startswith(owned.rstrip("/") + "/")
            for owned in product_paths
            if owned.rstrip("/")
        )

    missing = sorted(path for path in planned_paths if not covered(path))
    if missing:
        result = _result_error(
            "PLAN_PRODUCT_PATHS_INCOMPLETE",
            "productPaths 未覆盖计划明确引用的产品文件：" + ", ".join(missing),
        )
        result["missingPaths"] = missing
        result["recoveryAction"] = "在 Plan 阶段补充精确文件或目录前缀后重新 finalize。"
        return result
    return {
        "ok": True,
        "code": "PLAN_PRODUCT_PATHS_COMPLETE",
        "plannedPaths": sorted(planned_paths),
        "productPaths": product_paths,
    }


def _terminal_exists(change_dir: Path, run_id: str, attempt: int) -> bool:
    try:
        events = harness_events.load_events(harness_events.events_path(change_dir))
    except (OSError, ValueError):
        return False
    return any(
        event.get("phase") == "plan"
        and event.get("type") == "phase.end"
        and event.get("run_id") == run_id
        and event.get("attempt") == attempt
        and str(event.get("status") or "").upper() == "OK"
        for event in events
    )


def _validate_plan_start(
    change_dir: Path,
    run_id: str,
    attempt: int,
) -> dict[str, Any]:
    events_path = harness_events.events_path(change_dir)
    try:
        events = harness_events.load_events(events_path)
    except (OSError, ValueError) as exc:
        return _result_error("EVENTS_PARSE_ERROR", str(exc))
    matching = [
        event
        for event in events
        if event.get("phase") == "plan"
        and event.get("type") == "phase.start"
        and event.get("run_id") == run_id
        and event.get("attempt") == attempt
    ]
    if not matching:
        return _result_error(
            "PHASE_START_MISSING",
            "no matching plan phase.start event found for finalizer runId/attempt; "
            "append one with the same run id and attempt before finalizing, or use "
            "the `republish` subcommand which allocates and appends both for you",
        )
    if len(matching) > 1:
        return _result_error(
            "PHASE_START_DUPLICATE",
            f"found {len(matching)} matching plan phase.start events for run id "
            f"{run_id}. `harness_gate.py begin` already appends phase.start; a "
            "second manual append of the same run id creates this state. Recover "
            "with a fresh run id and the next attempt number (attempts are global "
            "per phase, not per run id): append phase.start with both, then "
            "finalize with the same pair.",
        )
    return {"ok": True, "phaseStartCount": 1}


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
        f"plans/{change_dir.name}-implementation-detail.md",
        f"plans/{change_dir.name}-test-scenarios.md",
        "meta/gate-policy.json",
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


def verify_plan(change_dir: Path) -> dict[str, Any]:
    """Read-only verification of a finalized plan (retro §5.8).

    Validates the published artifacts, receipt and events stream without
    requiring the original staging directory. Returns the artifact hash,
    phase.end count/status, frontmatter, and consistency checks. Any parse
    error or inconsistency results in ok=false with a non-zero exit code.
    """
    change_dir = change_dir.resolve()
    receipt_path = change_dir / "meta" / "plan-finalization.json"
    if not receipt_path.is_file():
        # v2 finalizer 证据路径（canonical 事实源是 transactions + journals）
        v2_result = _verify_plan_v2(change_dir)
        if v2_result is not None:
            return v2_result
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

    return {
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
    }


def _read_design_capabilities(staging: Path, change_name: str) -> list[str]:
    """Read capabilities from design frontmatter (retro §5.4)."""
    design_path = staging / "spec" / f"{change_name}-design.md"
    if not design_path.is_file():
        return []
    try:
        text = design_path.read_text(encoding="utf-8-sig")
    except OSError:
        return []
    frontmatter = _frontmatter(text)
    if not frontmatter:
        return []
    raw = frontmatter.get("capabilities") or ""
    if not raw:
        return []
    # capabilities may be comma-separated or YAML list
    if raw.startswith("["):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                return [str(c) for c in parsed if isinstance(c, str)]
        except json.JSONDecodeError:
            pass
    return [c.strip() for c in raw.split(",") if c.strip()]


def _reclassify_gate_policy(
    staging: Path,
    change_name: str,
) -> dict[str, Any]:
    """Reclassify gate policy based on approved design capabilities (retro §5.4).

    Reads design frontmatter `capabilities`, invokes harness_gate.py classify
    to recompute the gate DAG, and updates staging/meta/gate-policy.json.
    Returns {"ok": bool, "capabilities": [...], "drift": bool}.
    """
    capabilities = _read_design_capabilities(staging, change_name)
    if not capabilities:
        return {"ok": True, "capabilities": [], "drift": False, "updated": False}

    gate_policy_path = staging / "meta" / "gate-policy.json"
    try:
        existing = json.loads(gate_policy_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        existing = {}

    existing_caps = set(existing.get("capabilities") or [])
    design_caps = set(capabilities)
    drift = existing_caps != design_caps

    if drift:
        # Update gate-policy.json with design capabilities
        existing["capabilities"] = sorted(design_caps)
        try:
            gate_policy_path.write_text(
                json.dumps(existing, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
                newline="\n",
            )
        except OSError as exc:
            return {
                "ok": False,
                "error": f"failed to update gate-policy.json: {exc}",
                "capabilities": capabilities,
                "drift": True,
                "updated": False,
            }

    return {
        "ok": True,
        "capabilities": sorted(design_caps),
        "drift": drift,
        "updated": drift,
    }


def _append_terminal(change_dir: Path, run_id: str, attempt: int) -> tuple[int, str]:
    stdout = io.StringIO()
    stderr = io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        code = harness_events.main(
            [
                "append",
                "--change-dir",
                str(change_dir),
                "--phase",
                "plan",
                "--type",
                "phase.end",
                "--status",
                "OK",
                "--reason",
                "plan artifacts validated and published",
                "--run-id",
                run_id,
                "--attempt",
                str(attempt),
                "--json",
            ]
        )
    return code, stderr.getvalue().strip()


def _rollback_publish(
    created: list[Path], replaced: list[tuple[Path, bytes]]
) -> None:
    """Undo a failed publish: delete new files, restore overwritten ones."""
    for target in reversed(created):
        target.unlink(missing_ok=True)
    for target, original in reversed(replaced):
        try:
            target.write_bytes(original)
        except OSError:
            # Best effort: the caller already reports the publish failure.
            pass


def _plan_attempts(change_dir: Path) -> list[int]:
    """Every attempt number already used by a plan lifecycle event."""
    try:
        events = harness_events.load_events(harness_events.events_path(change_dir))
    except (OSError, ValueError):
        return []
    attempts: list[int] = []
    for event in events:
        if event.get("phase") != "plan":
            continue
        value = event.get("attempt")
        if isinstance(value, int) and not isinstance(value, bool):
            attempts.append(value)
    return attempts


def _run_id_in_use(change_dir: Path, run_id: str) -> bool:
    try:
        events = harness_events.load_events(harness_events.events_path(change_dir))
    except (OSError, ValueError):
        return False
    return any(event.get("run_id") == run_id for event in events)


def _append_plan_start(
    change_dir: Path, run_id: str, attempt: int, reason: str
) -> tuple[int, str]:
    stdout = io.StringIO()
    stderr = io.StringIO()
    with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        code = harness_events.main(
            [
                "append",
                "--change-dir",
                str(change_dir),
                "--phase",
                "plan",
                "--type",
                "phase.start",
                # phase.start accepts only `note` beyond provenance fields.
                "--note",
                reason,
                "--run-id",
                run_id,
                "--attempt",
                str(attempt),
                "--json",
            ]
        )
    return code, stderr.getvalue().strip()


def finalize_plan(
    change_dir: Path,
    staging: Path,
    *,
    change_name: str,
    run_id: str,
    attempt: int,
    allow_amend: bool = False,
    amend_reason: str | None = None,
) -> dict[str, Any]:
    change_dir = change_dir.resolve()
    staging = staging.resolve()

    # C2 (retro §5.4): reclassify gate policy based on approved design capabilities.
    # This updates staging/meta/gate-policy.json before validation, so the hash
    # reflects the final gate policy. Drift between design capabilities and
    # gate-policy capabilities is resolved in favor of the approved design.
    reclassify = _reclassify_gate_policy(staging, change_name)
    if not reclassify.get("ok"):
        return _result_error("CAPABILITY_GATE_DRIFT", reclassify.get("error", "reclassify failed"))

    validation = validate_staging(staging, change_name)
    if not validation["ok"]:
        return validation
    ownership_validation = validate_product_ownership(change_dir, staging)
    if not ownership_validation["ok"]:
        return ownership_validation
    start_validation = _validate_plan_start(change_dir, run_id, attempt)
    if not start_validation["ok"]:
        return start_validation

    receipt_path = change_dir / "meta" / "plan-finalization.json"
    lock_path = change_dir / "meta" / "plan-finalize.lock"
    receipt: dict[str, Any] | None = None
    supersedes: dict[str, Any] | None = None
    if receipt_path.is_file():
        try:
            loaded = json.loads(receipt_path.read_text(encoding="utf-8-sig"))
            receipt = loaded if isinstance(loaded, dict) else None
        except (OSError, json.JSONDecodeError) as exc:
            return _result_error("PLAN_FINALIZATION_RECEIPT_INVALID", str(exc))
        if receipt and receipt.get("artifactsHash") != validation["artifactsHash"]:
            if not allow_amend:
                return _result_error(
                    "PLAN_FINALIZATION_HASH_CONFLICT",
                    "finalizer was already invoked with a different artifact set; "
                    "to publish an approved amendment run: harness_plan_finalize.py "
                    "republish --change-dir <dir> --staging-dir <dir> --change "
                    f"{change_name} --run-id <fresh-run-id> --reason \"<why>\"",
                )
            # Authorized amendment: keep the superseded identity in the new
            # receipt so the published history stays auditable.
            supersedes = {
                "artifactsHash": receipt.get("artifactsHash"),
                "runId": receipt.get("runId"),
                "attempt": receipt.get("attempt"),
            }
        elif (
            receipt
            and receipt.get("status") == "finalized"
            and _terminal_exists(change_dir, run_id, attempt)
        ):
            return {
                "ok": True,
                "action": "finalize",
                "idempotent": True,
                "artifactsHash": validation["artifactsHash"],
                "files": validation["files"],
                "receiptPath": str(receipt_path),
                "artifactRef": "meta/plan-finalization.json",
            }

    lock_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        lock_fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(lock_fd)
    except FileExistsError:
        return _result_error("PLAN_FINALIZATION_LOCKED", f"lock exists: {lock_path}")

    created: list[Path] = []
    # Amendment overwrites replace already-published bytes. Keep the originals
    # so a failed publish restores them instead of deleting the published plan.
    replaced: list[tuple[Path, bytes]] = []
    terminal_committed = False
    try:
        for rel_text in validation["files"]:
            source = staging / rel_text
            target = change_dir / rel_text
            if (
                not allow_amend
                and target.exists()
                and target.read_bytes() != source.read_bytes()
            ):
                return _result_error(
                    "PLAN_TARGET_CONFLICT",
                    f"refusing to overwrite {rel_text}; publish an approved "
                    "amendment with the `republish` subcommand instead",
                )

        for rel_text in validation["files"]:
            source = staging / rel_text
            target = change_dir / rel_text
            existed = target.exists()
            if existed:
                original = target.read_bytes()
                if not allow_amend or original == source.read_bytes():
                    continue
            target.parent.mkdir(parents=True, exist_ok=True)
            fd, raw_tmp = tempfile.mkstemp(
                prefix=f".{target.name}.", suffix=".tmp", dir=str(target.parent)
            )
            os.close(fd)
            tmp = Path(raw_tmp)
            try:
                shutil.copyfile(source, tmp)
                os.replace(tmp, target)
                if existed:
                    replaced.append((target, original))
                else:
                    created.append(target)
            finally:
                tmp.unlink(missing_ok=True)

        # C8: write implementation-checkpoints.json with parsed task ownerPhase.
        tasks = validation.get("tasks") or []
        if tasks:
            checkpoints_path = change_dir / "meta" / "implementation-checkpoints.json"
            checkpoints_payload = {
                "schemaVersion": 1,
                "changeName": change_name,
                "tasks": tasks,
                "foundationGate": "approved",
            }
            if checkpoints_path.is_file():
                replaced.append((checkpoints_path, checkpoints_path.read_bytes()))
            else:
                created.append(checkpoints_path)
            _atomic_write_json(checkpoints_path, checkpoints_payload)

        # C9: write scenario-manifest.json with parsed scenarios.
        scenarios = validation.get("scenarios") or []
        manifest_path = change_dir / "meta" / "scenario-manifest.json"
        manifest_payload = {
            "schemaVersion": scenario_manifest_schema_version(scenarios),
            "changeName": change_name,
            "scenarios": [
                {
                    key: value
                    for key, value in scenario.items()
                    if key != "executableMappingDeclared"
                }
                for scenario in scenarios
            ],
        }
        if manifest_path.is_file():
            replaced.append((manifest_path, manifest_path.read_bytes()))
        else:
            created.append(manifest_path)
        _atomic_write_json(manifest_path, manifest_payload)

        pending_receipt = {
            "schemaVersion": SCHEMA_VERSION,
            "changeName": change_name,
            "status": "publishing",
            "artifactsHash": validation["artifactsHash"],
            "files": validation["files"],
            "runId": run_id,
            "attempt": attempt,
        }
        if supersedes is not None:
            pending_receipt["supersedes"] = supersedes
            pending_receipt["amendReason"] = amend_reason or ""
        _atomic_write_json(receipt_path, pending_receipt)
        terminal_code, terminal_error = _append_terminal(change_dir, run_id, attempt)
        terminal_committed = _terminal_exists(change_dir, run_id, attempt)
        if terminal_code != 0 and not terminal_committed:
            _rollback_publish(created, replaced)
            receipt_path.unlink(missing_ok=True)
            return _result_error(
                "PLAN_TERMINAL_APPEND_FAILED",
                terminal_error or "phase.end append failed",
            )
        pending_receipt["status"] = "finalized"
        _atomic_write_json(receipt_path, pending_receipt)
        result: dict[str, Any] = {
            "ok": True,
            "action": "republish" if supersedes is not None else "finalize",
            "idempotent": False,
            "artifactsHash": validation["artifactsHash"],
            "files": validation["files"],
            "receiptPath": str(receipt_path),
            "artifactRef": "meta/plan-finalization.json",
            "executionLogPath": str(harness_events.execution_log_path(change_dir)),
        }
        if supersedes is not None:
            result["supersedes"] = supersedes
            result["scenarioCount"] = len(scenarios)
            result["taskCount"] = len(tasks)
        return result
    except OSError as exc:
        if terminal_committed or _terminal_exists(change_dir, run_id, attempt):
            return _result_error(
                "PLAN_FINALIZATION_RECOVERY_REQUIRED",
                f"terminal committed; retry finalization to complete receipt: {exc}",
            )
        _rollback_publish(created, replaced)
        receipt_path.unlink(missing_ok=True)
        return _result_error("PLAN_FINALIZATION_IO_ERROR", str(exc))
    finally:
        lock_path.unlink(missing_ok=True)


def republish_plan(
    change_dir: Path,
    staging: Path,
    *,
    change_name: str,
    run_id: str,
    reason: str,
) -> dict[str, Any]:
    """Publish an approved amendment to an already-finalized plan.

    Amending a published plan (adding a scenario, correcting a task) used to
    require reverse-engineering a five-step lifecycle dance across three
    modules — new run id, incremented attempt, stale receipt removal, dangling
    attempt sealing — and every wrong turn produced a different error code
    (PLAN_FINALIZATION_HASH_CONFLICT / PHASE_START_MISSING /
    EVENT_ATTEMPT_CONFLICT / PHASE_ALREADY_CLOSED). Agents that gave up
    hand-edited meta/scenario-manifest.json, creating exactly the drift the
    hash guard exists to prevent.

    This performs the whole sequence atomically and keeps the superseded
    identity in the receipt, so amendment stays auditable rather than silent.
    """
    change_dir = change_dir.resolve()
    staging = staging.resolve()

    if not str(reason).strip():
        return _result_error(
            "PLAN_AMEND_REASON_REQUIRED",
            "--reason is required: an amendment to a published plan must record why",
        )

    receipt_path = change_dir / "meta" / "plan-finalization.json"
    if not receipt_path.is_file():
        return _result_error(
            "PLAN_NOT_FINALIZED",
            "no plan-finalization.json to amend; use `finalize` for the first "
            "publication",
        )

    if _run_id_in_use(change_dir, run_id):
        return _result_error(
            "PLAN_AMEND_RUN_ID_IN_USE",
            f"run id {run_id} already appears in this change's events; "
            "an amendment needs a fresh run id",
        )

    # Nothing to amend is a no-op, not a new attempt: probe the staged hash
    # before writing any lifecycle event.
    reclassify = _reclassify_gate_policy(staging, change_name)
    if not reclassify.get("ok"):
        return _result_error(
            "CAPABILITY_GATE_DRIFT", reclassify.get("error", "reclassify failed")
        )
    probe = validate_staging(staging, change_name)
    if not probe["ok"]:
        return probe
    try:
        published = json.loads(receipt_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        return _result_error("PLAN_FINALIZATION_RECEIPT_INVALID", str(exc))
    if (
        isinstance(published, dict)
        and published.get("status") == "finalized"
        and published.get("artifactsHash") == probe["artifactsHash"]
    ):
        return {
            "ok": True,
            "action": "republish",
            "idempotent": True,
            "artifactsHash": probe["artifactsHash"],
            "files": probe["files"],
            "receiptPath": str(receipt_path),
            "artifactRef": "meta/plan-finalization.json",
            "note": "published plan already matches staging; nothing to amend",
        }

    attempt = max(_plan_attempts(change_dir), default=0) + 1
    start_code, start_error = _append_plan_start(
        change_dir, run_id, attempt, f"plan amendment: {reason}"
    )
    if start_code != 0:
        return _result_error(
            "PLAN_AMEND_START_FAILED",
            start_error or "failed to append plan phase.start for the amendment",
        )

    result = finalize_plan(
        change_dir,
        staging,
        change_name=change_name,
        run_id=run_id,
        attempt=attempt,
        allow_amend=True,
        amend_reason=reason,
    )
    if isinstance(result, dict):
        result.setdefault("runId", run_id)
        result.setdefault("attempt", attempt)
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harness_plan_finalize.py")
    sub = parser.add_subparsers(dest="command", required=True)
    republish = sub.add_parser(
        "republish",
        help=(
            "publish an approved amendment to an already-finalized plan "
            "(allocates a fresh attempt and records what it supersedes)"
        ),
    )
    republish.add_argument("--change-dir", required=True)
    republish.add_argument("--staging-dir", required=True)
    republish.add_argument("--change", required=True)
    republish.add_argument(
        "--run-id", required=True, help="a fresh run id, unused by this change"
    )
    republish.add_argument(
        "--reason", required=True, help="why the published plan is being amended"
    )
    republish.add_argument("--json", action="store_true")
    finalize = sub.add_parser("finalize")
    finalize.add_argument("--change-dir", required=True)
    finalize.add_argument("--staging-dir", required=True)
    finalize.add_argument("--change", required=True)
    finalize.add_argument("--run-id", required=True)
    finalize.add_argument("--attempt", required=True, type=int)
    finalize.add_argument("--json", action="store_true")
    verify = sub.add_parser("verify")
    verify.add_argument("--change-dir", required=True)
    verify.add_argument("--json", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "verify":
        result = verify_plan(Path(args.change_dir))
    elif args.command == "republish":
        result = republish_plan(
            Path(args.change_dir),
            Path(args.staging_dir),
            change_name=args.change,
            run_id=args.run_id,
            reason=args.reason,
        )
    else:
        result = finalize_plan(
            Path(args.change_dir),
            Path(args.staging_dir),
            change_name=args.change,
            run_id=args.run_id,
            attempt=args.attempt,
        )
    stream = sys.stdout if result["ok"] else sys.stderr
    if args.json:
        stream.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    else:
        stream.write((result.get("action") or result.get("code") or "error") + "\n")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
