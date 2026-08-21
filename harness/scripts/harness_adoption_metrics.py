#!/usr/bin/env python3
"""Legacy plan finalize 退役前的采纳度度量（roadmap 14，只读）。

对一组项目根聚合三条判据的读数，输出 ``pass`` / ``fail`` / ``indeterminate``。
本脚本只读：不写任何文件、不改判据阈值、不宣告"达标可删"。样本不足时输出
``indeterminate``，由人决定是否继续积累 dogfood 样本。

三条判据（docs/harness-improvement-roadmap/14-migration-rollout-and-acceptance.md）：

1. ``finalize_first_try``：v2 finalize 首次成功率。连续 10 次 finalize 中
   首次 attempt 即 ``publication_committed_event_complete`` 的比例 >= 8/10。
   操作化定义：磁盘布局是一 operation 一文件
   （``meta/plan-finalization-transactions/<operation_id>.json``），同 operation
   的重试覆盖同一文件，可观测的重试信号 = 同一 change 的后续 operation 文件数。
   "首次成功" = 该 change 最早创建的 operation 文件 status 为
   ``publication_committed_event_complete``。
2. ``evidence_closure``：证据闭环。连续 5 个 v2 change 的
   ``evidence/verification-ledger.json`` 覆盖全部 ``requiredEvidenceKind=ledger``
   场景，且 events 未出现 ``SCENARIO_MANIFEST_`` 阻断码。
   覆盖判定：场景声明的 ``executableTestId`` 出现在 ledger receipt 的
   ``declared`` 或 ``selected`` 列表，或其三元 identity（testId/file/title）
   出现在 ``collected``。任何一项判不出都记 uncovered 并带 reason——
   准入门槛宁缺毋滥。
3. ``legacy_fallback``：legacy 回退率。最近 10 个新 change 中写出
   ``meta/plan-finalization.json``（legacy finalize 收据）的比例 <= 1/10。

多项目样本合并成单一证据池（dogfood 车队是一个总体）。窗口内排序键：
payload ``created_at``（ISO 字典序）→ 缺则文件 mtime → 再并列按 change_key。

用法::

    python harness/scripts/harness_adoption_metrics.py \
        --project <root> [--project <root2> ...] [--json] [--strict]

默认 exit 0（度量工具不卡 CI）；``--strict`` 时任何 fail 或 indeterminate → exit 1。

Python 3.10+，stdlib only，不 import 任何 harness_*（零耦合）。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

FIRST_TRY_WINDOW = 10
FIRST_TRY_THRESHOLD = 8
EVIDENCE_WINDOW = 5
LEGACY_WINDOW = 10
LEGACY_THRESHOLD = 1

FINAL_STATUS = "publication_committed_event_complete"


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _change_dirs(project: Path) -> list[Path]:
    root = project / ".harness" / "changes"
    if not root.is_dir():
        return []
    return sorted((p for p in root.iterdir() if p.is_dir()), key=lambda p: p.name)


def _sort_key(created_at: str, mtime: float, change_key: str) -> tuple[str, float, str]:
    # created_at 是 ISO 字符串，字典序即时间序；缺失时退到 mtime。
    return (created_at, mtime, change_key)


def _operation_sort_key(record: dict[str, Any], path: Path) -> tuple[str, float, str]:
    return _sort_key(
        str(record.get("created_at") or ""),
        path.stat().st_mtime,
        str(record.get("operation_id") or path.name),
    )


# ---------------------------------------------------------------------------
# 判据 1：v2 finalize 首次成功率
# ---------------------------------------------------------------------------


def _collect_first_try(projects: list[Path]) -> dict[str, Any]:
    per_change: list[dict[str, Any]] = []
    for project in projects:
        for change in _change_dirs(project):
            transactions_dir = change / "meta" / "plan-finalization-transactions"
            if not transactions_dir.is_dir():
                continue
            records: list[tuple[dict[str, Any], Path]] = []
            for path in transactions_dir.glob("*.json"):
                payload = _read_json(path)
                if payload is not None:
                    records.append((payload, path))
            if not records:
                continue
            records.sort(key=lambda item: _operation_sort_key(item[0], item[1]))
            first_payload, _first_path = records[0]
            per_change.append(
                {
                    "project": str(project),
                    "change": change.name,
                    "first_status": str(first_payload.get("status") or ""),
                    "first_try_ok": first_payload.get("status") == FINAL_STATUS,
                    "retry_count": len(records) - 1,
                    "sort": _operation_sort_key(first_payload, records[0][1]),
                }
            )
    per_change.sort(key=lambda item: item["sort"])
    window = per_change[-FIRST_TRY_WINDOW:]
    sample = len(window)
    ok_count = sum(1 for item in window if item["first_try_ok"])
    if sample < FIRST_TRY_WINDOW:
        status = "indeterminate"
        detail = f"样本 {sample}/{FIRST_TRY_WINDOW}，判据不可判定"
    else:
        status = "pass" if ok_count >= FIRST_TRY_THRESHOLD else "fail"
        detail = (
            f"最近 {sample} 次 finalize 中首次即 {FINAL_STATUS} 的有 "
            f"{ok_count} 次（阈值 >= {FIRST_TRY_THRESHOLD}）"
        )
    return {
        "id": "finalize_first_try",
        "reading": f"{ok_count}/{sample}",
        "threshold": f">= {FIRST_TRY_THRESHOLD}/{FIRST_TRY_WINDOW}",
        "sample": sample,
        "status": status,
        "detail": detail,
        "changes": [
            {key: value for key, value in item.items() if key != "sort"}
            for item in window
        ],
    }


# ---------------------------------------------------------------------------
# 判据 2：证据闭环
# ---------------------------------------------------------------------------


def _evidence_closure_for_change(change: Path) -> dict[str, Any]:
    manifest = _read_json(change / "meta" / "scenario-manifest.json")
    if manifest is None:
        return {"change": change.name, "clean": False,
                "reason": "scenario-manifest.json 缺失或不可解析"}
    scenarios = manifest.get("scenarios")
    if not isinstance(scenarios, list):
        return {"change": change.name, "clean": False,
                "reason": "scenario-manifest.json 无 scenarios 数组"}
    ledger_scenarios = [
        s for s in scenarios
        if isinstance(s, dict) and s.get("requiredEvidenceKind") == "ledger"
    ]

    uncovered: list[str] = []
    if ledger_scenarios:
        ledger_payload = None
        for candidate in (
            change / ".harness" / "state" / "changes" / change.name
            / "evidence" / "verification-ledger.json",
            change / "evidence" / "verification-ledger.json",
        ):
            ledger_payload = _read_json(candidate)
            if ledger_payload is not None:
                break
        if ledger_payload is None:
            uncovered = [
                f"{s.get('id')}:verification-ledger.json 缺失或不可解析"
                for s in ledger_scenarios
            ]
        else:
            declared = set(ledger_payload.get("declared") or [])
            selected = set(ledger_payload.get("selected") or [])
            collected_keys = {
                (
                    str(item.get("testId") or ""),
                    str(item.get("file") or ""),
                    str(item.get("title") or ""),
                )
                for item in (ledger_payload.get("collected") or [])
                if isinstance(item, dict)
            }
            for scenario in ledger_scenarios:
                scenario_id = str(scenario.get("id") or "?")
                test_id = str(scenario.get("executableTestId") or "").strip()
                identity = (
                    test_id,
                    str(scenario.get("testFile") or "").strip(),
                    str(scenario.get("testTitle") or "").strip(),
                )
                if not test_id:
                    uncovered.append(f"{scenario_id}:缺 executableTestId，无法判定")
                    continue
                if (
                    test_id not in declared
                    and test_id not in selected
                    and identity not in collected_keys
                ):
                    uncovered.append(f"{scenario_id}:ledger 未覆盖")

    blocked = False
    for events_path in (
        change / "events.ndjson",
        change / ".harness" / "state" / "changes" / change.name / "events.ndjson",
        change / "meta" / "events.ndjson",
    ):
        try:
            text = events_path.read_text(encoding="utf-8-sig", errors="replace")
        except OSError:
            continue
        if "SCENARIO_MANIFEST_" in text:
            blocked = True
            break

    clean = not uncovered and not blocked
    result: dict[str, Any] = {
        "change": change.name,
        "clean": clean,
        "ledger_scenarios": len(ledger_scenarios),
    }
    if uncovered:
        result["uncovered"] = uncovered
    if blocked:
        result["blocked_by"] = "SCENARIO_MANIFEST_*"
    if clean:
        result["reason"] = "ok"
    return result


def _collect_evidence_closure(projects: list[Path]) -> dict[str, Any]:
    v2_changes: list[tuple[tuple[str, float, str], Path]] = []
    for project in projects:
        for change in _change_dirs(project):
            transactions_dir = change / "meta" / "plan-finalization-transactions"
            if not transactions_dir.is_dir() or not any(
                transactions_dir.glob("*.json")
            ):
                continue
            # 窗口排序键与判据 1 一致：最早事务的 created_at。
            earliest: tuple[str, float, str] | None = None
            for path in transactions_dir.glob("*.json"):
                payload = _read_json(path)
                if payload is None:
                    continue
                key = _operation_sort_key(payload, path)
                if earliest is None or key < earliest:
                    earliest = key
            v2_changes.append((earliest or _sort_key("", change.stat().st_mtime, change.name), change))
    v2_changes.sort(key=lambda item: item[0])
    window = [change for _key, change in v2_changes[-EVIDENCE_WINDOW:]]
    sample = len(window)
    results = [_evidence_closure_for_change(change) for change in window]
    clean_count = sum(1 for item in results if item["clean"])
    if sample < EVIDENCE_WINDOW:
        status = "indeterminate"
        detail = f"样本 {sample}/{EVIDENCE_WINDOW}，判据不可判定"
    else:
        status = "pass" if clean_count == sample else "fail"
        detail = (
            f"最近 {sample} 个 v2 change 中证据闭环干净的有 {clean_count} 个"
            f"（阈值 = {EVIDENCE_WINDOW}/{EVIDENCE_WINDOW}）"
        )
    return {
        "id": "evidence_closure",
        "reading": f"{clean_count}/{sample}",
        "threshold": f"{EVIDENCE_WINDOW}/{EVIDENCE_WINDOW} 干净",
        "sample": sample,
        "status": status,
        "detail": detail,
        "changes": results,
    }


# ---------------------------------------------------------------------------
# 判据 3：legacy 回退率
# ---------------------------------------------------------------------------


def _collect_legacy_fallback(projects: list[Path]) -> dict[str, Any]:
    all_changes: list[tuple[float, str, Path]] = []
    for project in projects:
        for change in _change_dirs(project):
            all_changes.append((change.stat().st_mtime, change.name, change))
    all_changes.sort(key=lambda item: (item[0], item[1]))
    window = [change for _mtime, _name, change in all_changes[-LEGACY_WINDOW:]]
    sample = len(window)
    legacy = [
        change.name
        for change in window
        if (change / "meta" / "plan-finalization.json").is_file()
    ]
    if sample < LEGACY_WINDOW:
        status = "indeterminate"
        detail = f"样本 {sample}/{LEGACY_WINDOW}，判据不可判定"
    else:
        status = "pass" if len(legacy) <= LEGACY_THRESHOLD else "fail"
        detail = (
            f"最近 {sample} 个 change 中含 legacy plan-finalization.json 的有 "
            f"{len(legacy)} 个（阈值 <= {LEGACY_THRESHOLD}）"
        )
    return {
        "id": "legacy_fallback",
        "reading": f"{len(legacy)}/{sample}",
        "threshold": f"<= {LEGACY_THRESHOLD}/{LEGACY_WINDOW}",
        "sample": sample,
        "status": status,
        "detail": detail,
        "legacy_changes": legacy,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def collect_metrics(projects: list[Path]) -> dict[str, Any]:
    criteria = [
        _collect_first_try(projects),
        _collect_evidence_closure(projects),
        _collect_legacy_fallback(projects),
    ]
    overall = "pass"
    if any(item["status"] == "fail" for item in criteria):
        overall = "fail"
    elif any(item["status"] == "indeterminate" for item in criteria):
        overall = "indeterminate"
    return {
        "projects": [str(project) for project in projects],
        "overall": overall,
        "criteria": criteria,
    }


def _print_text(report: dict[str, Any]) -> None:
    print(f"projects: {', '.join(report['projects']) or '(none)'}")
    print(f"overall: {report['overall']}")
    for criterion in report["criteria"]:
        print(
            f"[{criterion['status']:>13}] {criterion['id']}: "
            f"{criterion['reading']}（{criterion['detail']}）"
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="legacy plan finalize 采纳度度量（只读）",
    )
    parser.add_argument(
        "--project",
        action="append",
        default=[],
        help="项目根（含 .harness/changes/），可重复",
    )
    parser.add_argument("--json", action="store_true", help="JSON 输出")
    parser.add_argument(
        "--strict",
        action="store_true",
        help="任何 fail 或 indeterminate 时 exit 1",
    )
    args = parser.parse_args(argv)

    projects = [Path(item).resolve() for item in args.project]
    report = collect_metrics(projects)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        _print_text(report)
    if args.strict and report["overall"] != "pass":
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
