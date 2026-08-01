#!/usr/bin/env python3
"""Select verification targets from a diff and dependency graph."""

from __future__ import annotations

import argparse
import fnmatch
import json
import time
from collections import Counter
from pathlib import Path
from typing import Any


_COVERAGE_RANK = {"incremental": 0, "module": 1, "module-am": 2, "full": 3}

_REASON_EXPLANATIONS = {
    "PRODUCT_IDENTITY_REQUIRED": "A product identity is required before a verification can run.",
    "CAPABILITY_MISSING": "A required execution capability is not available.",
    "REQUIRED_COVERAGE_INVALID": "The required coverage declaration is invalid.",
    "COVERAGE_DECLARATION_REQUIRED": "The target does not declare the coverage level needed for this gate.",
    "COVERAGE_INSUFFICIENT": "The target coverage is below the required gate level.",
    "NOT_APPLICABLE": "The target is explicitly not applicable to this change.",
    "FROZEN_IDENTITY_REQUIRED": "The target requires a frozen product identity.",
    "FROZEN_IDENTITY_DRIFT": "The current product identity differs from the frozen identity.",
    "REUSE_POLICY_NEVER": "The target policy explicitly requires a fresh execution.",
    "REUSE_EVIDENCE_INVALID": "Ledger evidence does not match the target and product identity exactly.",
    "REUSE_ELIGIBLE": "Identity-matched ledger evidence permits reuse.",
    "SELECTED_FOR_EXECUTION": "The target was selected for execution and passed its gate checks.",
    "COMMAND_NOT_DECLARED": "The target command key is absent from the authoritative command declaration map.",
    "COMMAND_DECLARATION_INVALID": "The authoritative command declaration is empty or malformed.",
    "DEPENDENCY_UNKNOWN": "The target depends on a node that is not in the verification graph.",
    "DEPENDENCY_BLOCKED": "A dependency was skipped or blocked, so this target cannot run.",
    "DEPENDENCY_CYCLE": "The verification graph contains a dependency cycle.",
    "VERIFICATION_REUSED": "The target reused an identity-matched verification receipt.",
    "VERIFICATION_ARGV_NOT_CONCRETE": "The target command arguments are not concrete and executable.",
}


def _reason_explanation(reason_codes: list[str], decision: str) -> str:
    explanations: list[str] = []
    for raw in reason_codes:
        code = str(raw).split(":", 1)[0]
        explanation = _REASON_EXPLANATIONS.get(code)
        if explanation is None:
            if raw.startswith("depends-on:"):
                explanation = f"The target waits for dependency {raw.split(':', 1)[1]} to complete."
            elif raw.startswith("consumer-of:"):
                explanation = f"The target is included because it consumes {raw.split(':', 1)[1]}."
            elif raw.startswith("input-match:"):
                explanation = f"A changed input matched {raw.split(':', 1)[1]}."
            elif raw.startswith("CAPABILITY_MISSING:"):
                explanation = f"Capability {raw.split(':', 1)[1]} is unavailable."
            else:
                explanation = f"Verification decision reason: {raw}."
        if explanation not in explanations:
            explanations.append(explanation)
    if explanations:
        return " ".join(explanations)
    return {
        "EXECUTE": "The target passed all declared gate checks and is ready to execute.",
        "REUSE": "The target has valid identity-matched reusable evidence.",
        "SKIP": "The target is not applicable to this change.",
        "BLOCKED": "The target cannot execute until its blocking conditions are resolved.",
    }.get(decision, "The target has no executable decision.")


def _normalize_targets(raw_targets: Any) -> list[dict[str, Any]]:
    if isinstance(raw_targets, dict):
        return [
            {**dict(target), "id": str(target.get("id") or target_id)}
            for target_id, target in raw_targets.items()
            if isinstance(target_id, str) and isinstance(target, dict)
        ]
    if isinstance(raw_targets, list):
        return [
            dict(target)
            for target in raw_targets
            if isinstance(target, dict) and str(target.get("id") or "").strip()
        ]
    return []


def select_verifications(payload: dict[str, Any]) -> dict[str, Any]:
    changed = sorted(
        {
            str(path).replace("\\", "/")
            for path in payload.get("changedFiles", [])
            if str(path).strip()
        }
    )
    targets = _normalize_targets(payload.get("targets", []))
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


def _resource_locks(target: dict[str, Any]) -> list[str]:
    locks = sorted(
        {
            str(item).strip()
            for item in target.get("resourceLocks", [])
            if str(item).strip()
        }
    )
    estimated = float(
        target.get("estimatedDurationSeconds")
        or target.get("expectedDurationSeconds")
        or 0
    )
    if estimated >= 60 and not locks:
        locks.append("harness:unclassified-heavy")
    return locks


def _target_decision(
    target: dict[str, Any],
    *,
    product_identity: str,
    frozen_identity: str,
    available_capabilities: set[str],
    verification_ledger: list[dict[str, Any]],
    command_declarations: dict[str, Any] | None = None,
) -> tuple[str, list[str]]:
    blockers: list[str] = []
    if not product_identity:
        return "BLOCKED", ["PRODUCT_IDENTITY_REQUIRED"]
    if command_declarations is not None:
        command_key = str(target.get("commandKey") or "").strip()
        declaration = command_declarations.get(command_key) if command_key else None
        if declaration is None:
            blockers.append("COMMAND_NOT_DECLARED")
        elif isinstance(declaration, dict):
            argv = declaration.get("argv") or declaration.get("argvTemplate")
            if not isinstance(argv, list) or not argv or not all(
                isinstance(item, str) and item for item in argv
            ):
                blockers.append("COMMAND_DECLARATION_INVALID")
        elif not isinstance(declaration, list) or not declaration or not all(
            isinstance(item, str) and item for item in declaration
        ):
            blockers.append("COMMAND_DECLARATION_INVALID")
    required_capabilities = {
        str(item).strip()
        for item in target.get("requiredCapabilities", [])
        if str(item).strip()
    }
    blockers.extend(
        "CAPABILITY_MISSING:" + item
        for item in sorted(required_capabilities - available_capabilities)
    )
    required_coverage = str(target.get("requiredCoverage") or "").strip()
    coverage_level = str(
        target.get("coverageLevel") or target.get("scope") or ""
    ).strip()
    if required_coverage:
        if required_coverage not in _COVERAGE_RANK:
            blockers.append("REQUIRED_COVERAGE_INVALID")
        elif coverage_level not in _COVERAGE_RANK:
            blockers.append("COVERAGE_DECLARATION_REQUIRED")
        elif _COVERAGE_RANK[coverage_level] < _COVERAGE_RANK[required_coverage]:
            blockers.append(
                f"COVERAGE_INSUFFICIENT:{coverage_level}<{required_coverage}"
            )
    applicability = target.get("applicability")
    if isinstance(applicability, dict) and applicability.get("applicable") is False:
        return "SKIP", [
            str(applicability.get("reasonCode") or "NOT_APPLICABLE")
        ]
    if (
        target.get("requiresFrozenIdentity") is True
        and not frozen_identity
    ):
        blockers.append("FROZEN_IDENTITY_REQUIRED")
    if (
        target.get("requiresFrozenIdentity") is True
        and frozen_identity
        and product_identity != frozen_identity
    ):
        blockers.append("FROZEN_IDENTITY_DRIFT")
    if blockers:
        return "BLOCKED", blockers
    reuse = target.get("reuse")
    if isinstance(reuse, dict) and reuse.get("eligible") is True:
        if target.get("reusePolicy") == "never":
            return "EXECUTE", ["REUSE_POLICY_NEVER"]
        evidence_id = str(reuse.get("evidenceId") or "").strip()
        evidence_product = str(reuse.get("productIdentity") or "").strip()
        target_id = str(target.get("id") or "")
        ledger_match = next(
            (
                item
                for item in verification_ledger
                if str(item.get("evidenceId") or "") == evidence_id
                and str(item.get("targetId") or item.get("verification") or "")
                == target_id
                and str(item.get("productIdentity") or "") == product_identity
                and item.get("status") == "OK"
            ),
            None,
        )
        if (
            str(target.get("reusePolicy") or "") != "ledger-exact"
            or not evidence_id
            or evidence_product != product_identity
            or ledger_match is None
        ):
            return "BLOCKED", ["REUSE_EVIDENCE_INVALID"]
        return "REUSE", [str(reuse.get("reasonCode") or "REUSE_ELIGIBLE")]
    return "EXECUTE", ["SELECTED_FOR_EXECUTION"]


def schedule_verifications(payload: dict[str, Any]) -> dict[str, Any]:
    """Build an explainable, lock-aware verification execution plan.

    Dependencies define the earliest wave. Nodes in the same wave may run in
    parallel only when their declared resource locks are disjoint. Long tasks
    without a lock declaration receive one shared conservative lock.
    """
    targets = _normalize_targets(payload.get("targets", []))
    if not targets:
        return {
            "ok": False,
            "code": "VERIFICATION_TARGETS_REQUIRED",
            "productIdentity": str(payload.get("productIdentity") or ""),
            "frozenIdentity": str(payload.get("frozenIdentity") or ""),
            "plan": [],
            "waves": [],
        }
    targets.sort(key=lambda item: str(item["id"]))
    by_id = {str(item["id"]): item for item in targets}
    product_identity = str(payload.get("productIdentity") or "")
    frozen_identity = str(payload.get("frozenIdentity") or "")
    available_capabilities = {
        str(item).strip()
        for item in payload.get("availableCapabilities", [])
        if str(item).strip()
    }
    verification_ledger = [
        dict(item)
        for item in payload.get("verificationLedger", [])
        if isinstance(item, dict)
    ]
    raw_commands = payload.get("commands")
    command_declarations = (
        {str(key): value for key, value in raw_commands.items()}
        if isinstance(raw_commands, dict)
        else None
    )
    decisions: dict[str, tuple[str, list[str]]] = {
        target_id: _target_decision(
            target,
            product_identity=product_identity,
            frozen_identity=frozen_identity,
            available_capabilities=available_capabilities,
            verification_ledger=verification_ledger,
            command_declarations=command_declarations,
        )
        for target_id, target in by_id.items()
    }
    waves: list[list[str]] = []
    placed: dict[str, int | None] = {}
    pending = set(by_id)

    while pending:
        progressed = False
        for target_id in sorted(pending):
            target = by_id[target_id]
            dependencies = [str(item) for item in target.get("dependsOn", [])]
            unknown = sorted(set(dependencies) - set(by_id))
            if unknown:
                decisions[target_id] = (
                    "BLOCKED",
                    ["DEPENDENCY_UNKNOWN:" + item for item in unknown],
                )
                placed[target_id] = None
                pending.remove(target_id)
                progressed = True
                break
            if any(item not in placed for item in dependencies):
                continue
            failed_dependencies = [
                item
                for item in dependencies
                if decisions[item][0] in {"SKIP", "BLOCKED"}
            ]
            if failed_dependencies:
                decisions[target_id] = (
                    "BLOCKED",
                    [
                        "DEPENDENCY_BLOCKED:" + item
                        for item in sorted(failed_dependencies)
                    ],
                )
                placed[target_id] = None
                pending.remove(target_id)
                progressed = True
                break
            decision, _ = decisions[target_id]
            if decision in {"SKIP", "BLOCKED"}:
                placed[target_id] = None
                pending.remove(target_id)
                progressed = True
                break
            dependency_waves = [
                placed[item]
                for item in dependencies
                if placed.get(item) is not None
            ]
            earliest = (
                max(int(item) for item in dependency_waves) + 1
                if dependency_waves
                else 0
            )
            if decision == "REUSE":
                placed[target_id] = max(0, earliest - 1)
                pending.remove(target_id)
                progressed = True
                break
            locks = set(_resource_locks(target))
            wave = earliest
            while True:
                while wave >= len(waves):
                    waves.append([])
                occupied = {
                    lock
                    for item_id in waves[wave]
                    for lock in _resource_locks(by_id[item_id])
                }
                if not locks & occupied:
                    waves[wave].append(target_id)
                    placed[target_id] = wave
                    break
                wave += 1
            pending.remove(target_id)
            progressed = True
            break
        if not progressed:
            for target_id in sorted(pending):
                decisions[target_id] = ("BLOCKED", ["DEPENDENCY_CYCLE"])
                placed[target_id] = None
            pending.clear()

    plan: list[dict[str, Any]] = []
    for target_id, target in by_id.items():
        decision, reasons = decisions[target_id]
        dependencies = [str(item) for item in target.get("dependsOn", [])]
        reason_codes = [
            *reasons,
            *["depends-on:" + item for item in dependencies],
        ]
        plan.append(
            {
                **target,
                "id": target_id,
                "decision": decision,
                "reasonCodes": reason_codes,
                "explanation": _reason_explanation(reason_codes, decision),
                "resourceLocks": _resource_locks(target),
                "wave": placed[target_id],
            }
        )
    decision_counts = dict(
        sorted(Counter(item["decision"] for item in plan).items())
    )
    return {
        "ok": all(item["decision"] != "BLOCKED" for item in plan),
        "code": (
            "VERIFICATION_PLAN_READY"
            if all(item["decision"] != "BLOCKED" for item in plan)
            else "VERIFICATION_PLAN_BLOCKED"
        ),
        "productIdentity": product_identity,
        "frozenIdentity": frozen_identity,
        "plan": plan,
        "decisionCounts": decision_counts,
        "waves": [
            {"wave": index, "targets": target_ids}
            for index, target_ids in enumerate(waves)
            if target_ids
        ],
    }


def execute_verifications(payload: dict[str, Any]) -> dict[str, Any]:
    """Execute a scheduled graph wave-by-wave through managed run sessions."""
    import harness_runtime

    scheduled = schedule_verifications(payload)
    if not scheduled["ok"]:
        return {**scheduled, "execution": []}
    state_root = Path(str(payload.get("stateRoot") or "")).expanduser().resolve()
    working_directory = Path(
        str(payload.get("workingDirectory") or "")
    ).expanduser().resolve()
    if not str(payload.get("stateRoot") or "").strip():
        return {
            **scheduled,
            "ok": False,
            "code": "VERIFICATION_STATE_ROOT_REQUIRED",
            "execution": [],
        }
    if not working_directory.is_dir():
        return {
            **scheduled,
            "ok": False,
            "code": "VERIFICATION_WORKDIR_INVALID",
            "execution": [],
        }
    by_id = {str(item["id"]): item for item in scheduled["plan"]}
    outcomes: dict[str, dict[str, Any]] = {
        target_id: {
            "targetId": target_id,
            "status": "OK",
            "reasonCode": "VERIFICATION_REUSED",
        }
        for target_id, target in by_id.items()
        if target.get("decision") == "REUSE"
    }
    execution: list[dict[str, Any]] = list(outcomes.values())
    for wave in scheduled["waves"]:
        running: list[tuple[str, str]] = []
        for target_id in wave["targets"]:
            target = by_id[target_id]
            failed_dependencies = [
                dependency
                for dependency in target.get("dependsOn", [])
                if outcomes.get(str(dependency), {}).get("status") != "OK"
            ]
            if failed_dependencies:
                outcome = {
                    "targetId": target_id,
                    "status": "BLOCKED",
                    "reasonCode": "DEPENDENCY_EXECUTION_FAILED",
                    "blockedBy": failed_dependencies,
                }
                outcomes[target_id] = outcome
                execution.append(outcome)
                continue
            argv = target.get("argvTemplate")
            if (
                not isinstance(argv, list)
                or not argv
                or not all(isinstance(item, str) and item for item in argv)
                or any("{" in item or "}" in item for item in argv)
            ):
                outcome = {
                    "targetId": target_id,
                    "status": "BLOCKED",
                    "reasonCode": "VERIFICATION_ARGV_NOT_CONCRETE",
                }
                outcomes[target_id] = outcome
                execution.append(outcome)
                continue
            receipt = harness_runtime.start_run_session(
                state_root=state_root,
                verification=target_id,
                argv=argv,
                working_directory=working_directory,
                timeout_seconds=target.get("timeoutSeconds"),
                expected_duration_seconds=target.get(
                    "estimatedDurationSeconds"
                ),
                product_identity=scheduled["productIdentity"],
                resource_locks=list(target["resourceLocks"]),
            )
            if receipt.get("status") in harness_runtime.RUN_TERMINAL_STATUSES:
                outcome = {"targetId": target_id, **receipt}
                outcomes[target_id] = outcome
                execution.append(outcome)
            else:
                running.append((target_id, str(receipt["sessionId"])))
        while running:
            remaining: list[tuple[str, str]] = []
            for target_id, session_id in running:
                receipt = harness_runtime.run_session_status(state_root, session_id)
                if receipt.get("status") in harness_runtime.RUN_TERMINAL_STATUSES:
                    outcome = {"targetId": target_id, **receipt}
                    outcomes[target_id] = outcome
                    execution.append(outcome)
                else:
                    remaining.append((target_id, session_id))
            running = remaining
            if running:
                time.sleep(0.05)
    execution_ok = all(item.get("status") == "OK" for item in execution)
    return {
        **scheduled,
        "ok": execution_ok,
        "code": (
            "VERIFICATION_EXECUTION_OK"
            if execution_ok
            else "VERIFICATION_EXECUTION_FAILED"
        ),
        "execution": execution,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="harness_verification.py")
    parser.add_argument(
        "command",
        nargs="?",
        choices=("select", "plan", "execute"),
        default="select",
    )
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    payload = json.loads(args.input.read_text(encoding="utf-8-sig"))
    if args.command == "execute":
        result = execute_verifications(payload)
    elif args.command == "plan":
        result = schedule_verifications(payload)
    else:
        result = select_verifications(payload)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
