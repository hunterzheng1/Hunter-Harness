#!/usr/bin/env python3
"""Phase reconciliation, trace projection, and normalized CI metrics.

The reconciler is deliberately an evidence orchestrator: it decides REUSE,
RUN, or BLOCK for the required gate DAG. It never executes user test commands.
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
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path
from typing import Any


SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_events as he  # noqa: E402
import harness_ledger as hl  # noqa: E402
import harness_paths as hpaths  # noqa: E402


SCHEMA_VERSION = 1
CI_METRICS_SCHEMA_VERSION = 1
PHASE_ORDER = ("plan", "run", "test", "review", "package", "apidoc", "submit", "archive")
VALIDATION_PHASES = {
    "compile": "run",
    "unitTest": "run",
    "unitTestFull": "test",
    "apiTest": "test",
    "dbCompatibility": "test",
    "package": "package",
}


def _read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError(f"JSON object required: {path}")
    return value


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        temp.write_text(
            json.dumps(value, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        temp.replace(path)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise


def _stable_hex(*parts: Any, length: int) -> str:
    raw = "\x1f".join(str(part) for part in parts).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:length]


def target_required_dag(policy: dict[str, Any], target_phase: str) -> dict[str, Any]:
    """Return only the required predecessors needed to close ``target_phase``.

    Validations owned by the target phase are prerequisites to closing it;
    stage nodes for the target itself are deliberately excluded because their
    ``phase.end`` is the result of close, not evidence required before close.
    """
    if target_phase not in PHASE_ORDER:
        raise ValueError(f"unsupported reconcile target phase: {target_phase}")
    dag = policy.get("requiredGateDag")
    if not isinstance(dag, dict) or not isinstance(dag.get("nodes"), list):
        raise ValueError("gate policy missing requiredGateDag; run harness_gate.py classify")
    target_rank = PHASE_ORDER.index(target_phase)
    selected: list[dict[str, Any]] = []
    for raw in dag["nodes"]:
        if not isinstance(raw, dict):
            raise ValueError("requiredGateDag node must be an object")
        node = dict(raw)
        node_id = str(node.get("id") or "")
        node_kind, _, node_name = node_id.partition(":")
        inferred_phase = (
            VALIDATION_PHASES.get(node_name)
            if node_kind == "validation"
            else node_name
        )
        node_phase = str(node.get("phase") or inferred_phase or "")
        if node_phase not in PHASE_ORDER:
            raise ValueError(f"requiredGateDag node has unsupported phase: {node_id}")
        node_rank = PHASE_ORDER.index(node_phase)
        is_validation = node.get("kind") == "validation" or node_id.startswith(
            "validation:"
        )
        if node_rank < target_rank or (is_validation and node_rank == target_rank):
            selected.append(node)
    selected_ids = {str(node.get("id")) for node in selected}
    for node in selected:
        excluded_dependencies = [
            dependency
            for dependency in (node.get("dependsOn") or [])
            if dependency not in selected_ids
        ]
        if excluded_dependencies:
            raise ValueError(
                f"target DAG for {target_phase} excludes dependencies of "
                f"{node.get('id')}: {', '.join(excluded_dependencies)}"
            )
    return {
        "schemaVersion": dag.get("schemaVersion", 1),
        "nodes": selected,
        "edges": [
            edge
            for edge in (dag.get("edges") or [])
            if isinstance(edge, dict)
            and edge.get("from") in selected_ids
            and edge.get("to") in selected_ids
        ],
        "targetPhase": target_phase,
    }


def select_phase_capsule(
    change_dir: Path,
    project_root: Path,
    *,
    phase: str,
    run_id: str | None,
) -> dict[str, Any]:
    """Select a phase capsule by its exact phase/run identity, never by mtime."""
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", phase):
        return {
            "ok": False,
            "code": "PHASE_INVALID",
            "message": f"invalid phase selector: {phase}",
            "remediation": "pass the phase name emitted by harness_gate.py begin",
        }
    state_dir = hpaths.resolve_state_dir_for_contract(change_dir, project_root)
    capsule_dir = state_dir / "runtime" / "phase-context"
    candidates = (
        [
            path
            for path in capsule_dir.iterdir()
            if path.is_file()
            and path.name.startswith(f"{phase}-")
            and path.suffix == ".json"
        ]
        if capsule_dir.is_dir()
        else []
    )
    if not run_id:
        if not candidates:
            return {
                "ok": True,
                "code": "PHASE_CAPSULE_ABSENT",
                "capsule": None,
                "path": None,
            }
        return {
            "ok": False,
            "code": "PHASE_RUN_ID_REQUIRED",
            "message": f"{len(candidates)} capsule(s) exist for phase {phase}",
            "remediation": f"rerun reconcile with --phase {phase} --run-id <run-id>",
        }
    key = hashlib.sha256(f"{phase}\0{run_id}".encode("utf-8")).hexdigest()[:20]
    path = capsule_dir / f"{phase}-{key}.json"
    if not path.is_file():
        return {
            "ok": False,
            "code": "PHASE_CAPSULE_NOT_FOUND",
            "message": f"no capsule for phase {phase} and run-id {run_id}",
            "expectedPath": str(path),
            "remediation": f"begin/resume the phase or verify --phase {phase} --run-id {run_id}",
        }
    try:
        capsule = _read_json(path)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {
            "ok": False,
            "code": "PHASE_CAPSULE_INVALID",
            "message": str(exc),
            "path": str(path),
            "remediation": f"repair or resume the capsule for --phase {phase} --run-id {run_id}",
        }
    if capsule.get("phase") != phase or capsule.get("runId") != run_id:
        return {
            "ok": False,
            "code": "PHASE_CAPSULE_IDENTITY_MISMATCH",
            "message": "capsule content does not match the requested phase/run-id",
            "path": str(path),
            "remediation": f"resume the exact phase with --phase {phase} --run-id {run_id}",
        }
    return {
        "ok": True,
        "code": "PHASE_CAPSULE_SELECTED",
        "capsule": capsule,
        "path": str(path),
    }


def reconcile_dag(
    dag: dict[str, Any],
    evidence: dict[str, dict[str, Any]],
    *,
    identity: dict[str, Any],
) -> dict[str, Any]:
    """Reduce a required DAG to deterministic REUSE/RUN/BLOCK decisions."""
    raw_nodes = dag.get("nodes")
    if not isinstance(raw_nodes, list):
        raise ValueError("requiredGateDag.nodes must be an array")
    if not raw_nodes:
        raise ValueError("requiredGateDag.nodes must not be empty")
    nodes_by_id: dict[str, dict[str, Any]] = {}
    for raw in raw_nodes:
        if not isinstance(raw, dict) or not str(raw.get("id") or "").strip():
            raise ValueError("requiredGateDag node requires a non-empty id")
        node_id = str(raw["id"])
        if node_id in nodes_by_id:
            raise ValueError(f"duplicate DAG node: {node_id}")
        depends = raw.get("dependsOn") or []
        if not isinstance(depends, list) or any(not isinstance(item, str) for item in depends):
            raise ValueError(f"invalid dependsOn for {node_id}")
        nodes_by_id[node_id] = dict(raw)
    for node_id, node in nodes_by_id.items():
        missing = [dep for dep in node.get("dependsOn") or [] if dep not in nodes_by_id]
        if missing:
            raise ValueError(f"unknown dependency for {node_id}: {', '.join(missing)}")

    if not identity.get("ok"):
        blocker = {
            "code": str(identity.get("code") or "IDENTITY_MISMATCH"),
            "message": str(identity.get("message") or "identity validation failed"),
        }
        return {
            "nodes": [
                {
                    **node,
                    "decision": "BLOCK",
                    "reason": blocker["code"],
                    "evidence": evidence.get(node_id) or {},
                }
                for node_id, node in nodes_by_id.items()
            ],
            "blockers": [blocker],
            "canClose": False,
        }

    pending = set(nodes_by_id)
    decided: dict[str, dict[str, Any]] = {}
    while pending:
        progressed = False
        for node_id in list(pending):
            node = nodes_by_id[node_id]
            dependencies = list(node.get("dependsOn") or [])
            if any(dep not in decided for dep in dependencies):
                continue
            facts = evidence.get(node_id) or {}
            upstream = [decided[dep] for dep in dependencies]
            if any(item["decision"] == "BLOCK" for item in upstream):
                decision, reason = "BLOCK", "upstream-blocked"
            elif any(item["decision"] != "REUSE" for item in upstream):
                decision, reason = "RUN", "upstream-invalidated"
            elif bool(facts.get("reusable")):
                decision, reason = "REUSE", str(facts.get("reason") or "evidence-current")
            elif str(facts.get("decision") or "").upper() == "BLOCK":
                decision, reason = "BLOCK", str(facts.get("reason") or "evidence-blocked")
            else:
                decision, reason = "RUN", str(facts.get("reason") or "evidence-missing")
            decided[node_id] = {
                **node,
                "decision": decision,
                "reason": reason,
                "evidence": facts,
            }
            pending.remove(node_id)
            progressed = True
        if not progressed:
            raise ValueError("requiredGateDag contains a cycle")

    ordered = [decided[str(raw["id"])] for raw in raw_nodes]
    blockers = [
        {"code": "NODE_BLOCKED", "nodeId": node["id"], "message": node["reason"]}
        for node in ordered
        if node["decision"] == "BLOCK"
    ]
    return {
        "nodes": ordered,
        "blockers": blockers,
        "canClose": bool(ordered) and all(node["decision"] == "REUSE" for node in ordered),
    }


def _event_groups(events: list[dict[str, Any]]) -> list[tuple[str, int, list[dict[str, Any]]]]:
    order: list[tuple[str, int]] = []
    groups: dict[tuple[str, int], list[dict[str, Any]]] = defaultdict(list)
    for event in events:
        key = (str(event.get("phase") or "unknown"), int(event.get("attempt") or 1))
        if key not in groups:
            order.append(key)
        groups[key].append(event)
    return [(phase, attempt, groups[(phase, attempt)]) for phase, attempt in order]


def timing_dimensions(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep runner, orchestration-active, wall-clock, and user wait distinct."""
    output: list[dict[str, Any]] = []
    for phase, attempt, grouped in _event_groups(events):
        timing = he.canonical_phase_timing(grouped)
        runner_values = [
            event.get("duration_ms", event.get("durationMs"))
            for event in grouped
            if event.get("type") == "command"
            and isinstance(event.get("duration_ms", event.get("durationMs")), int)
        ]
        wait_values = [
            event.get("user_wait_ms", event.get("userWaitMs"))
            for event in grouped
            if isinstance(event.get("user_wait_ms", event.get("userWaitMs")), int)
        ]
        output.append(
            {
                "phase": phase,
                "attempt": attempt,
                "runnerMs": sum(runner_values) if runner_values else None,
                "orchestrationActiveMs": timing.get("activeExecutionMs"),
                "wallClockMs": timing.get("wallClockSpanMs"),
                "userWaitMs": sum(wait_values) if wait_values else None,
                "lateEventCount": timing.get("lateEventCount"),
            }
        )
    return output


def build_trace(events: list[dict[str, Any]], *, change_id: str) -> dict[str, Any]:
    """Project legacy or trace-aware events into stable phase/attempt/tool spans."""
    event_ids = [str(event.get("id") or index) for index, event in enumerate(events)]
    explicit_trace = next(
        (
            str(event.get("traceId") or event.get("trace_id"))
            for event in events
            if event.get("traceId") or event.get("trace_id")
        ),
        "",
    )
    trace_id = explicit_trace if len(explicit_trace) == 32 else _stable_hex(change_id, *event_ids, length=32)
    root_span = _stable_hex(trace_id, "root", length=16)
    spans: list[dict[str, Any]] = [
        {
            "traceId": trace_id,
            "spanId": root_span,
            "parentSpanId": None,
            "kind": "change",
            "changeId": change_id,
        }
    ]
    for phase, attempt, grouped in _event_groups(events):
        phase_span = _stable_hex(trace_id, phase, attempt, length=16)
        spans.append(
            {
                "traceId": trace_id,
                "spanId": phase_span,
                "parentSpanId": root_span,
                "kind": "phase-attempt",
                "phase": phase,
                "attempt": attempt,
            }
        )
        tools: list[str] = []
        for event in grouped:
            tool = str(event.get("executor_tool") or event.get("executorTool") or "").strip()
            if tool and tool not in tools:
                tools.append(tool)
        for tool in tools:
            spans.append(
                {
                    "traceId": trace_id,
                    "spanId": _stable_hex(trace_id, phase, attempt, tool, length=16),
                    "parentSpanId": phase_span,
                    "kind": "tool",
                    "phase": phase,
                    "attempt": attempt,
                    "tool": tool,
                }
            )
    return {"schemaVersion": 1, "traceId": trace_id, "spans": spans}


def _number(value: Any, *, integer: bool = True) -> int | float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return int(number) if integer else number


def _junit_metrics(text: str) -> dict[str, Any]:
    root = ET.fromstring(text)
    suites = [root] if root.tag.endswith("testsuite") else list(root.findall(".//testsuite"))
    aggregate = root if root.tag.endswith(("testsuite", "testsuites")) else None
    attrs = aggregate.attrib if aggregate is not None else {}
    def attribute_total(name: str, fallback: str | None = None) -> int | None:
        direct = _number(attrs.get(name, attrs.get(fallback) if fallback else None))
        if direct is not None:
            return int(direct)
        values = [
            _number(item.attrib.get(name, item.attrib.get(fallback) if fallback else None))
            for item in suites
        ]
        return (
            sum(int(value) for value in values if value is not None)
            if any(value is not None for value in values)
            else None
        )

    total = attribute_total("tests")
    failures = attribute_total("failures")
    errors = attribute_total("errors")
    skipped = attribute_total("skipped", "disabled")
    duration_seconds = _number(attrs.get("time"), integer=False)
    if duration_seconds is None:
        durations = [_number(item.attrib.get("time"), integer=False) for item in suites]
        duration_seconds = (
            sum(value for value in durations if value is not None)
            if any(value is not None for value in durations)
            else None
        )
    passed = None
    if all(value is not None for value in (total, failures, errors, skipped)):
        passed = max(int(total) - int(failures) - int(errors) - int(skipped), 0)
    return {
        "suites": len(suites) if suites else None,
        "passed": passed,
        "failed": failures,
        "skipped": skipped,
        "setupErrors": errors,
        "durationMs": int(duration_seconds * 1000) if duration_seconds is not None else None,
    }


def normalize_ci_metrics(
    raw: str | dict[str, Any],
    *,
    runner: str,
    head_sha: str | None,
    source: str | None = None,
) -> dict[str, Any]:
    """Normalize JUnit, Vitest, or Playwright machine output without inventing zeros."""
    normalized_runner = runner.lower()
    if normalized_runner == "junit":
        if not isinstance(raw, str):
            raise ValueError("JUnit input must be XML text")
        metrics = _junit_metrics(raw)
    else:
        if isinstance(raw, str):
            value = json.loads(raw)
        else:
            value = raw
        if not isinstance(value, dict):
            raise ValueError("runner metrics must be a JSON object")
        if normalized_runner == "vitest":
            runtimes = [
                _number((item.get("perfStats") or {}).get("runtime"))
                for item in (value.get("testResults") or [])
                if isinstance(item, dict)
            ]
            metrics = {
                "suites": _number(value.get("numTotalTestSuites")),
                "passed": _number(value.get("numPassedTests")),
                "failed": _number(value.get("numFailedTests")),
                "skipped": _number(value.get("numPendingTests")),
                "setupErrors": _number(value.get("numRuntimeErrorTestSuites")),
                "durationMs": sum(item for item in runtimes if item is not None)
                if any(item is not None for item in runtimes)
                else None,
            }
        elif normalized_runner == "playwright":
            stats = value.get("stats") if isinstance(value.get("stats"), dict) else {}
            suites = value.get("suites")
            error_counts = []
            for raw_errors in (value.get("errors"), stats.get("errors")):
                count = len(raw_errors) if isinstance(raw_errors, list) else _number(raw_errors)
                if count is not None:
                    error_counts.append(count)
            setup_errors = max(error_counts) if error_counts else None
            metrics = {
                "suites": len(suites) if isinstance(suites, list) else None,
                "passed": _number(stats.get("expected")),
                "failed": _number(stats.get("unexpected")),
                "skipped": _number(stats.get("skipped")),
                "setupErrors": _number(setup_errors),
                "durationMs": _number(stats.get("duration")),
            }
        else:
            raise ValueError(f"unsupported runner: {runner}")
    result = {
        "schemaVersion": CI_METRICS_SCHEMA_VERSION,
        "runner": normalized_runner,
        "source": source,
        **metrics,
        "headSha": head_sha,
    }
    for field in ("suites", "passed", "failed", "skipped", "setupErrors", "durationMs"):
        value = result.get(field)
        if value is not None and (not isinstance(value, int) or value < 0):
            raise ValueError(f"invalid CI metric {field}: expected nonnegative integer or null")
    if head_sha is not None and not re.fullmatch(r"[0-9a-f]{40}(?:[0-9a-f]{24})?", head_sha):
        raise ValueError("headSha must be a lowercase 40- or 64-character hex commit id")
    return result


def _git_head(project_root: Path) -> str | None:
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--verify", "HEAD"],
            cwd=str(project_root),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except OSError:
        return None
    return proc.stdout.strip() if proc.returncode == 0 and proc.stdout.strip() else None


def assess_identity(
    change_dir: Path,
    project_root: Path,
    ledger: dict[str, Any] | None,
    *,
    target_phase: str | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    current_head = _git_head(project_root)
    capsule: dict[str, Any] | None = None
    capsule_selection: dict[str, Any] | None = None
    if target_phase is not None:
        capsule_selection = select_phase_capsule(
            change_dir,
            project_root,
            phase=target_phase,
            run_id=run_id,
        )
        if not capsule_selection.get("ok"):
            return {
                "ok": False,
                "code": capsule_selection.get("code"),
                "message": capsule_selection.get("message"),
                "remediation": capsule_selection.get("remediation"),
                "capsuleSelection": {
                    key: value
                    for key, value in capsule_selection.items()
                    if key != "capsule"
                },
            }
        selected = capsule_selection.get("capsule")
        capsule = selected if isinstance(selected, dict) else None
    if capsule is not None:
        stored_head = capsule.get("currentHead")
        if stored_head and current_head and stored_head != current_head:
            return {
                "ok": False,
                "code": "HEAD_MISMATCH",
                "message": f"phase capsule head {stored_head} != current {current_head}",
                "storedHead": stored_head,
                "currentHead": current_head,
                "capsuleSelection": capsule_selection,
            }
    if not ledger or ledger.get("schemaVersion") != 3:
        return {
            "ok": True,
            "code": "IDENTITY_NOT_REUSABLE",
            "message": "no ledger v3 identity; validations must RUN unless their own evidence is current",
            "currentHead": current_head,
            "capsuleSelection": capsule_selection,
        }
    missing = hl.validate_ledger_identity(ledger)
    if missing:
        return {
            "ok": False,
            "code": "LEDGER_IDENTITY_INVALID",
            "message": "missing: " + ", ".join(missing),
        }
    if capsule is not None and capsule.get("baseCommit") not in {
        None,
        ledger.get("baseCommit"),
    }:
        return {
            "ok": False,
            "code": "BASE_MISMATCH",
            "message": "phase capsule and ledger base commits differ",
            "capsuleBase": capsule.get("baseCommit"),
            "ledgerBase": ledger.get("baseCommit"),
        }
    try:
        contract = hpaths.load_change_contract(change_dir)
        current_repository = hpaths.repository_identity(project_root)
        current_ownership = hl.ownership_hash(contract)
        current_diff = hl.compute_ownership_diff(
            project_root,
            base=str(ledger["baseCommit"]),
            change_dir=change_dir,
        )["diffHash"]
    except (OSError, ValueError, RuntimeError) as exc:
        return {"ok": False, "code": "IDENTITY_RESOLUTION_FAILED", "message": str(exc)}
    identity_dimensions = {
        "repositoryId": (ledger.get("repositoryId"), current_repository),
        "ownershipHash": (ledger.get("ownershipHash"), current_ownership),
        "currentHead": (ledger.get("currentHead"), current_head),
    }
    changed = {
        key: {"stored": stored, "current": current}
        for key, (stored, current) in identity_dimensions.items()
        if stored != current
    }
    if changed:
        return {
            "ok": False,
            "code": "LEDGER_IDENTITY_MISMATCH",
            "message": "ledger identity does not match current change",
            "mismatches": changed,
        }
    if ledger.get("diffHash") != current_diff:
        return {
            "ok": True,
            "code": "DIFF_CHANGED",
            "message": "ownership diff changed; reuse is decided per node inputs",
            "storedDiffHash": ledger.get("diffHash"),
            "currentDiffHash": current_diff,
            "currentHead": current_head,
        }
    return {
        "ok": True,
        "code": "IDENTITY_OK",
        "currentHead": current_head,
        "capsuleSelection": capsule_selection,
    }


def _latest_phase_status(events: list[dict[str, Any]], phase: str) -> str | None:
    status = None
    for event in he.apply_event_corrections(events):
        if event.get("type") == "phase.end" and event.get("phase") == phase:
            status = str(event.get("status") or "").upper() or None
    return status


def collect_node_evidence(
    dag: dict[str, Any],
    change_dir: Path,
    events: list[dict[str, Any]],
    ledger: dict[str, Any] | None,
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    validations = (ledger or {}).get("validations") or {}
    for node in dag.get("nodes") or []:
        node_id = str(node.get("id") or "")
        if node.get("kind") == "validation" or node_id.startswith("validation:"):
            verification = node_id.split(":", 1)[1]
            entry = validations.get(verification) if isinstance(validations, dict) else None
            if not isinstance(entry, dict):
                result[node_id] = {"reusable": False, "reason": "validation-missing"}
                continue
            files = entry.get("inputsFiles") if isinstance(entry.get("inputsFiles"), list) else []
            if not files:
                result[node_id] = {"reusable": False, "reason": "inputs-missing"}
                continue
            reuse = hl.decide_can_reuse(
                change_dir=change_dir,
                verification=verification,
                files=[str(item) for item in files],
                requested_scope=entry.get("scope") if isinstance(entry.get("scope"), str) else None,
                requested_command=str(entry.get("command") or "") or None,
            )
            result[node_id] = {
                "reusable": bool(reuse.get("reuse")),
                "reason": str(reuse.get("code") or reuse.get("reason") or "not-reusable"),
                "reuse": reuse,
            }
        else:
            phase = str(node.get("phase") or node_id.split(":", 1)[-1])
            status = _latest_phase_status(events, phase)
            result[node_id] = {
                "reusable": status in {"OK", "WARN"},
                "reason": f"phase-status:{status or 'missing'}",
                "status": status,
            }
    return result


def reconcile(
    change_dir: Path,
    project_root: Path,
    *,
    target_phase: str | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    change_dir = change_dir.resolve()
    project_root = project_root.resolve()
    policy = _read_json(change_dir / "meta" / "gate-policy.json")
    dag = (
        target_required_dag(policy, target_phase)
        if target_phase is not None
        else policy.get("requiredGateDag")
    )
    if not isinstance(dag, dict):
        raise ValueError("gate policy missing requiredGateDag; run harness_gate.py classify")
    ledger, ledger_path = hl.load_ledger(change_dir)
    events_file = he.events_path(change_dir)
    events = he.load_events(events_file) if events_file.is_file() else []
    identity = assess_identity(
        change_dir,
        project_root,
        ledger,
        target_phase=target_phase,
        run_id=run_id,
    )
    evidence = collect_node_evidence(dag, change_dir, events, ledger)
    if identity.get("code") not in {"IDENTITY_OK", "DIFF_CHANGED"}:
        for facts in evidence.values():
            facts["reusable"] = False
            facts["reason"] = "identity-not-reusable"
    if dag.get("nodes"):
        decision = reconcile_dag(dag, evidence, identity=identity)
    elif identity.get("ok"):
        decision = {"nodes": [], "blockers": [], "canClose": True}
    else:
        decision = {
            "nodes": [],
            "blockers": [
                {
                    "code": str(identity.get("code") or "IDENTITY_MISMATCH"),
                    "message": str(identity.get("message") or "identity validation failed"),
                }
            ],
            "canClose": False,
        }
    guard_path = change_dir / "evidence" / "test-guard-snapshot.json"
    guard = _read_json(guard_path) if guard_path.is_file() else None
    return {
        "ok": not decision["blockers"],
        "action": "reconcile",
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": dt.datetime.now().astimezone().isoformat(timespec="milliseconds"),
        "changeId": change_dir.name,
        "projectRoot": str(project_root),
        "changeDir": str(change_dir),
        "targetPhase": target_phase,
        "runId": run_id,
        "identity": identity,
        **decision,
        "guard": guard,
        "ledgerPath": str(ledger_path) if ledger_path else None,
        "trace": build_trace(events, change_id=change_dir.name),
        "timing": timing_dimensions(events),
    }


def format_compact(result: dict[str, Any]) -> str:
    lines: list[str] = []
    for node in result.get("nodes") or []:
        decision = str(node.get("decision") or "")
        if decision == "REUSE":
            continue
        lines.append(f"{decision} {node.get('id')}: {node.get('reason')}")
    for blocker in result.get("blockers") or []:
        lines.append(f"BLOCK {blocker.get('code')}: {blocker.get('message')}")
    if not lines:
        nodes = result.get("nodes") or []
        if not result.get("ok") or not nodes:
            lines.append(
                f"BLOCK {result.get('code') or 'EMPTY_RECONCILIATION'}: "
                f"{result.get('error') or 'no required nodes were reconciled'}"
            )
        else:
            lines.append(f"REUSED {len(nodes)} required nodes; safe to close")
    return "\n".join(lines)


def _close_gate(args: argparse.Namespace) -> dict[str, Any]:
    command = [
        sys.executable,
        str(SCRIPTS_DIR / "harness_gate.py"),
        "close",
        "--json",
        "--phase",
        args.phase,
        "--change",
        Path(args.change_dir).name,
        "--project",
        str(Path(args.project).resolve()),
        "--status",
        "OK",
    ]
    if args.run_id:
        command.extend(["--run-id", args.run_id])
    proc = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError:
        payload = {"ok": False, "code": "GATE_CLOSE_INVALID_OUTPUT", "stderr": proc.stderr}
    payload["exitCode"] = proc.returncode
    return payload


def _cmd_reconcile(args: argparse.Namespace) -> int:
    try:
        result = reconcile(
            Path(args.change_dir),
            Path(args.project),
            target_phase=args.phase,
            run_id=args.run_id,
        )
        if args.close:
            if not result.get("canClose"):
                result["close"] = {
                    "ok": False,
                    "code": "RECONCILE_NOT_CLOSABLE",
                    "message": "required nodes still need RUN or are BLOCKED",
                }
                result["ok"] = False
                result.setdefault("blockers", []).append(
                    {
                        "code": "RECONCILE_NOT_CLOSABLE",
                        "message": "explicit close refused because required nodes are not reusable",
                    }
                )
            else:
                result["close"] = _close_gate(args)
                if not result["close"].get("ok"):
                    result["ok"] = False
        if args.output:
            _write_json(Path(args.output).resolve(), result)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        result = {"ok": False, "action": "reconcile", "code": "RECONCILE_FAILED", "error": str(exc)}
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(format_compact(result))
    return 0 if result.get("ok") else 2


def _cmd_metrics(args: argparse.Namespace) -> int:
    input_path = Path(args.input).resolve()
    try:
        text = input_path.read_text(encoding="utf-8-sig")
        runner = args.runner
        if runner == "auto":
            if input_path.suffix.lower() == ".xml":
                runner = "junit"
                raw: str | dict[str, Any] = text
            else:
                raw = json.loads(text)
                runner = (
                    "playwright"
                    if isinstance(raw, dict) and "stats" in raw and "suites" in raw
                    else "vitest"
                )
        else:
            raw = text if runner == "junit" else json.loads(text)
        result = normalize_ci_metrics(
            raw,
            runner=runner,
            head_sha=args.head_sha,
            source=str(input_path),
        )
        if args.output:
            _write_json(Path(args.output).resolve(), result)
    except (OSError, ValueError, ET.ParseError, json.JSONDecodeError) as exc:
        result = {"ok": False, "code": "CI_METRICS_FAILED", "error": str(exc)}
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harness_phase.py")
    sub = parser.add_subparsers(dest="command", required=True)
    reconcile_parser = sub.add_parser("reconcile")
    reconcile_parser.add_argument("--change-dir", required=True)
    reconcile_parser.add_argument("--project", required=True)
    reconcile_parser.add_argument("--json", action="store_true")
    reconcile_parser.add_argument("--output")
    reconcile_parser.add_argument("--close", action="store_true")
    reconcile_parser.add_argument("--phase", default="run")
    reconcile_parser.add_argument("--run-id")
    reconcile_parser.set_defaults(func=_cmd_reconcile)

    metrics_parser = sub.add_parser("metrics")
    metrics_parser.add_argument("--input", required=True)
    metrics_parser.add_argument("--runner", choices=("auto", "junit", "vitest", "playwright"), default="auto")
    metrics_parser.add_argument("--head-sha")
    metrics_parser.add_argument("--output")
    metrics_parser.set_defaults(func=_cmd_metrics)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
