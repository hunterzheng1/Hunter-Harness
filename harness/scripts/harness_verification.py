#!/usr/bin/env python3
"""Select verification targets from a diff and dependency graph."""

from __future__ import annotations

import argparse
import fnmatch
import json
from pathlib import Path
from typing import Any


def select_verifications(payload: dict[str, Any]) -> dict[str, Any]:
    changed = sorted(
        {
            str(path).replace("\\", "/")
            for path in payload.get("changedFiles", [])
            if str(path).strip()
        }
    )
    targets = [
        target for target in payload.get("targets", []) if isinstance(target, dict)
    ]
    selected_ids: set[str] = set()
    reasons: dict[str, list[str]] = {}
    for target in targets:
        target_id = str(target.get("id") or "")
        patterns = [str(pattern) for pattern in target.get("inputs", [])]
        matched = sorted(
            path
            for path in changed
            if any(fnmatch.fnmatch(path, pattern) for pattern in patterns)
        )
        if matched:
            selected_ids.add(target_id)
            reasons[target_id] = ["input-match:" + path for path in matched]

    changed_closure = True
    while changed_closure:
        changed_closure = False
        for target in targets:
            target_id = str(target.get("id") or "")
            dependencies = {str(item) for item in target.get("dependsOn", [])}
            if target_id not in selected_ids and dependencies & selected_ids:
                selected_ids.add(target_id)
                reasons[target_id] = [
                    "consumer-of:" + dependency
                    for dependency in sorted(dependencies & selected_ids)
                ]
                changed_closure = True

    escalation_reasons: list[str] = []
    lockfiles = {
        "package-lock.json",
        "npm-shrinkwrap.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "pom.xml",
        "Cargo.lock",
        "go.sum",
    }
    if any(path in lockfiles or Path(path).name in lockfiles for path in changed):
        escalation_reasons.append("lockfile-changed")
    if any(
        path.startswith(("packages/contracts/", "contracts/"))
        or "/schema/" in path
        or path.endswith((".schema.json", ".proto"))
        for path in changed
    ):
        escalation_reasons.append("public-contract-changed")
    selected = [
        {**target, "selectionReasons": reasons[str(target.get("id") or "")]}
        for target in targets
        if str(target.get("id") or "") in selected_ids
    ]
    omitted = [
        {**target, "omissionReason": "no impacted input or dependency"}
        for target in targets
        if str(target.get("id") or "") not in selected_ids
    ]
    return {
        "ok": True,
        "code": "VERIFICATION_TARGETS_SELECTED",
        "changedFiles": changed,
        "selected": selected,
        "omitted": omitted,
        "dependencyClosure": [str(item.get("id")) for item in selected],
        "candidateRequired": bool(escalation_reasons),
        "escalationReasons": escalation_reasons,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="harness_verification.py")
    parser.add_argument("select", nargs="?")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    result = select_verifications(
        json.loads(args.input.read_text(encoding="utf-8-sig"))
    )
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
