#!/usr/bin/env python3
"""Aggregate-plan scale, ownership and dependency-graph contracts."""

from __future__ import annotations

import argparse
import fnmatch
import json
from pathlib import Path
from typing import Any


def analyze_scale(payload: dict[str, Any]) -> dict[str, Any]:
    file_count = int(payload.get("fileCount") or 0)
    task_count = int(payload.get("taskCount") or 0)
    module_count = len(
        {str(item) for item in payload.get("modules", []) if str(item).strip()}
    )
    reasons: list[str] = []
    if file_count >= 30:
        reasons.append("file-count")
    if task_count >= 20:
        reasons.append("task-count")
    if module_count >= 3:
        reasons.append("module-count")
    return {
        "ok": True,
        "code": "PLAN_SCALE_ANALYZED",
        "mode": "aggregate" if reasons else "single",
        "reasons": reasons,
        "measurements": {
            "fileCount": file_count,
            "taskCount": task_count,
            "moduleCount": module_count,
        },
        "thresholds": {"fileCount": 30, "taskCount": 20, "moduleCount": 3},
    }


def _literal_prefix(pattern: str) -> str:
    normalized = pattern.replace("\\", "/").strip("/")
    wildcard = min(
        [index for token in ("*", "?", "[") if (index := normalized.find(token)) >= 0]
        or [len(normalized)]
    )
    return normalized[:wildcard].rstrip("/")


def _paths_overlap(left: str, right: str) -> bool:
    left_prefix = _literal_prefix(left)
    right_prefix = _literal_prefix(right)
    if not left_prefix or not right_prefix:
        return True
    if (
        left_prefix == right_prefix
        or left_prefix.startswith(right_prefix + "/")
        or right_prefix.startswith(left_prefix + "/")
    ):
        return True
    return fnmatch.fnmatch(left_prefix, right) or fnmatch.fnmatch(right_prefix, left)


def _cycle(children: list[dict[str, Any]]) -> list[str]:
    ids = {str(child.get("id") or "") for child in children}
    graph = {
        str(child.get("id") or ""): [
            str(dep) for dep in child.get("dependsOn", []) if str(dep) in ids
        ]
        for child in children
    }
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node: str, trail: list[str]) -> list[str]:
        if node in visiting:
            return trail[trail.index(node) :] + [node]
        if node in visited:
            return []
        visiting.add(node)
        for dependency in graph.get(node, []):
            found = visit(dependency, trail + [dependency])
            if found:
                return found
        visiting.remove(node)
        visited.add(node)
        return []

    for child_id in sorted(ids):
        found = visit(child_id, [child_id])
        if found:
            return found
    return []


def validate_aggregate(plan: dict[str, Any]) -> dict[str, Any]:
    children = [
        child for child in plan.get("children", []) if isinstance(child, dict)
    ]
    ids = [str(child.get("id") or "") for child in children]
    if not children or any(not child_id for child_id in ids) or len(set(ids)) != len(ids):
        return {
            "ok": False,
            "code": "AGGREGATE_CHILD_ID_INVALID",
            "parallelEligible": False,
        }
    cycle = _cycle(children)
    if cycle:
        return {
            "ok": False,
            "code": "AGGREGATE_DAG_CYCLE",
            "cycle": cycle,
            "parallelEligible": False,
        }
    overlaps: list[dict[str, str]] = []
    resource_conflicts: list[dict[str, str]] = []
    for index, left in enumerate(children):
        for right in children[index + 1 :]:
            for left_path in left.get("ownedPaths", []):
                for right_path in right.get("ownedPaths", []):
                    if _paths_overlap(str(left_path), str(right_path)):
                        overlaps.append(
                            {
                                "left": str(left["id"]),
                                "right": str(right["id"]),
                                "leftPath": str(left_path),
                                "rightPath": str(right_path),
                            }
                        )
            left_writes = {
                str(item)
                for item in left.get("sharedResources", {}).get("writes", [])
            }
            right_writes = {
                str(item)
                for item in right.get("sharedResources", {}).get("writes", [])
            }
            for resource in sorted(left_writes & right_writes):
                resource_conflicts.append(
                    {
                        "left": str(left["id"]),
                        "right": str(right["id"]),
                        "resource": resource,
                    }
                )
    if overlaps:
        return {
            "ok": False,
            "code": "AGGREGATE_OWNERSHIP_OVERLAP",
            "parallelEligible": False,
            "overlaps": overlaps,
        }
    if resource_conflicts:
        return {
            "ok": False,
            "code": "AGGREGATE_RESOURCE_CONFLICT",
            "parallelEligible": False,
            "conflicts": resource_conflicts,
        }
    integration = [child for child in children if child.get("kind") == "integration"]
    leaf_ids = {str(child["id"]) for child in children if child.get("kind") != "integration"}
    if integration:
        dependencies = {str(item) for item in integration[-1].get("dependsOn", [])}
        if not leaf_ids.issubset(dependencies):
            return {
                "ok": False,
                "code": "AGGREGATE_INTEGRATION_CLOSURE_MISSING",
                "parallelEligible": False,
                "missingChildren": sorted(leaf_ids - dependencies),
            }
    receipts = {
        str(receipt.get("childId") or ""): receipt
        for receipt in plan.get("receipts", [])
        if isinstance(receipt, dict)
    }
    if receipts and integration:
        leaf_commits = {
            str(receipts.get(child_id, {}).get("productCommit") or "")
            for child_id in leaf_ids
        }
        leaf_commits.discard("")
        integration_receipt = receipts.get(str(integration[-1]["id"]), {})
        covered = {
            str(item) for item in integration_receipt.get("coversProductCommits", [])
        }
        if leaf_commits != covered:
            return {
                "ok": False,
                "code": "AGGREGATE_PRODUCT_COMMIT_CLOSURE_MISSING",
                "parallelEligible": False,
                "missingProductCommits": sorted(leaf_commits - covered),
            }
    return {
        "ok": True,
        "code": "AGGREGATE_PLAN_VALID",
        "parallelEligible": True,
        "childOrder": ids,
        "integrationChild": str(integration[-1]["id"]) if integration else None,
    }


def materialize(payload: dict[str, Any]) -> dict[str, Any]:
    scale = analyze_scale(payload)
    children = payload.get("children") or payload.get("slices") or []
    result = {
        "schemaVersion": 1,
        "code": "AGGREGATE_PLAN_MATERIALIZED",
        "parent": {
            "id": str(payload.get("id") or payload.get("changeName") or "aggregate"),
            "scaleDecision": scale,
        },
        "children": children,
        "integration": payload.get("integration"),
    }
    validation = validate_aggregate({"children": children})
    result["validation"] = validation
    result["ok"] = validation["ok"]
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harness_plan_aggregate.py")
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ("analyze", "validate", "materialize"):
        child = sub.add_parser(command)
        child.add_argument("--input", required=True, type=Path)
        child.add_argument("--out", type=Path)
        child.add_argument("--json", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    payload = json.loads(args.input.read_text(encoding="utf-8-sig"))
    result = (
        analyze_scale(payload)
        if args.command == "analyze"
        else validate_aggregate(payload)
        if args.command == "validate"
        else materialize(payload)
    )
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok", True) else 1


if __name__ == "__main__":
    raise SystemExit(main())
