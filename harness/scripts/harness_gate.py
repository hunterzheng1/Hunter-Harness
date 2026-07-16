#!/usr/bin/env python3
"""Harness deterministic phase gate: begin/close, checkpoints, classify, lint.

Subcommands:
  begin           — claim lease, optional identity capture, append phase.start
  close           — validate ledger/test-guard/policy, append phase.end, release lease
  classify        — plan/post-run risk tier stub
  checkpoint      — status|approve foundation-gate (and future checkpoints)
  lint-skills     — forbid hand-written ledger patterns in skill trees

foundation-gate must block task>=6 until approved (API-012).
Python 3.10+, stdlib only.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_change as hc  # noqa: E402
import harness_events as he  # noqa: E402
import harness_ledger as hl  # noqa: E402
import harness_workflow_policy as hwp  # noqa: E402
import harness_test_guard as htg  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


CHECKPOINTS_REL = Path("meta") / "implementation-checkpoints.json"
FORBIDDEN_SKILL_PATTERNS = (
    re.compile(r"Write\s+verification-ledger\.json", re.IGNORECASE),
    re.compile(r"Edit\s+verification-ledger", re.IGNORECASE),
    re.compile(r"hand-?write.*verification-ledger", re.IGNORECASE),
)

LEDGER_V2_REQUIRED_ENTRY_FIELDS = (
    "algorithmVersion",
    "coverage",
    "inputsHash",
    "inputsFiles",
    "status",
    "command",
    "evidence",
)


def emit(payload: dict[str, Any], *, as_json: bool) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


def emit_error(
    code: str,
    message: str,
    *,
    as_json: bool,
    extra: dict[str, Any] | None = None,
) -> int:
    payload: dict[str, Any] = {"ok": False, "code": code, "message": message}
    if extra:
        payload.update(extra)
    if as_json:
        sys.stderr.write(json.dumps(payload, ensure_ascii=False) + "\n")
    else:
        sys.stderr.write(f"error: {message} ({code})\n")
    return 1


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(text, encoding="utf-8", newline="\n")
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def load_checkpoints(change_dir: Path) -> dict[str, Any] | None:
    path = change_dir / CHECKPOINTS_REL
    if not path.is_file():
        return None
    try:
        data = _read_json(path)
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def checkpoint_status(checkpoints: dict[str, Any] | None, checkpoint_id: str) -> str:
    if not checkpoints:
        return "missing"
    items = checkpoints.get("checkpoints")
    if not isinstance(items, list):
        return "missing"
    for item in items:
        if isinstance(item, dict) and item.get("id") == checkpoint_id:
            return str(item.get("status") or "pending")
    return "missing"


def foundation_gate_blocks(task_number: int | None, change_dir: Path) -> dict[str, Any] | None:
    if task_number is None or task_number < 6:
        return None
    checkpoints = load_checkpoints(change_dir)
    status = checkpoint_status(checkpoints, "foundation-gate")
    if status == "approved":
        return None
    return {
        "ok": False,
        "code": "FOUNDATION_GATE_PENDING",
        "message": (
            "foundation-gate is not approved; tasks 6+ are blocked until "
            "reports/review/foundation-gate-review.md is reviewed and checkpoint approved"
        ),
        "checkpointId": "foundation-gate",
        "checkpointStatus": status,
        "task": task_number,
    }


def validate_ledger_entry_v2(entry: dict[str, Any], verification: str) -> list[str]:
    missing: list[str] = []
    for field in LEDGER_V2_REQUIRED_ENTRY_FIELDS:
        value = entry.get(field)
        if field == "inputsFiles":
            if not isinstance(value, list):
                missing.append(field)
            elif verification == "unitTestFull" and not value:
                missing.append("inputsFiles(non-empty)")
        elif field == "status":
            if value != "OK":
                missing.append("status=OK")
        elif not (isinstance(value, str) and value.strip()):
            missing.append(field)
        elif field == "coverage" and str(value).strip() not in hl.COVERAGE_RANK:
            missing.append("coverage(valid)")
        elif field == "algorithmVersion" and str(value).strip() != hl.LEDGER_VERSION:
            missing.append("algorithmVersion(harness-ledger-2)")
    return missing


def validate_ledger_for_phase_close(
    change_dir: Path,
    phase: str,
    policy: dict[str, Any],
) -> dict[str, Any]:
    """Validate ledger v2 fields required for phase close (UT-026)."""
    required = policy.get("requiredValidations", {}).get(phase, [])
    if not required:
        return {"ok": True, "code": "LEDGER_NOT_REQUIRED", "phase": phase}

    ledger, ledger_path = hl.load_ledger(change_dir)
    if ledger is None:
        return {
            "ok": False,
            "code": "LEDGER_MISSING",
            "message": "verification ledger missing",
            "phase": phase,
            "required": required,
        }
    validations = ledger.get("validations")
    if not isinstance(validations, dict):
        return {
            "ok": False,
            "code": "VALIDATIONS_MISSING",
            "message": "ledger validations missing",
            "phase": phase,
            "ledgerPath": str(ledger_path) if ledger_path else None,
        }

    problems: list[dict[str, Any]] = []
    for verification in required:
        entry = validations.get(verification)
        if not isinstance(entry, dict):
            problems.append(
                {
                    "verification": verification,
                    "missing": ["entry"],
                    "code": "VALIDATION_MISSING",
                }
            )
            continue
        missing = validate_ledger_entry_v2(entry, verification)
        if missing:
            code = (
                "MISSING_V2_FIELDS"
                if any(
                    field in missing
                    for field in (
                        "algorithmVersion",
                        "algorithmVersion(harness-ledger-2)",
                        "coverage",
                        "coverage(valid)",
                    )
                )
                else "MISSING_FIELDS"
            )
            problems.append(
                {
                    "verification": verification,
                    "missing": missing,
                    "code": code,
                }
            )

    if problems:
        return {
            "ok": False,
            "code": problems[0]["code"],
            "message": "ledger validation failed for phase close",
            "phase": phase,
            "problems": problems,
            "ledgerPath": str(ledger_path) if ledger_path else None,
            "detail": "natural-language override is not permitted",
        }
    return {
        "ok": True,
        "code": "LEDGER_OK",
        "phase": phase,
        "validated": required,
        "ledgerPath": str(ledger_path) if ledger_path else None,
    }


def read_identity(skills_root: Path) -> dict[str, Any]:
    identity: dict[str, Any] = {"skillsRoot": str(skills_root.resolve())}
    build_path = skills_root / ".harness-build.json"
    if build_path.is_file():
        try:
            build = _read_json(build_path)
            if isinstance(build, dict):
                for key in (
                    "registryVersion",
                    "bundleHash",
                    "coreHash",
                    "overlayHash",
                    "profile",
                    "adapter",
                ):
                    if key in build:
                        identity[key] = build[key]
        except (OSError, json.JSONDecodeError):
            identity["buildReadError"] = True
    context_path = skills_root / ".harness" / "context-index.json"
    if not context_path.is_file():
        alt = skills_root.parent / ".harness" / "context-index.json"
        if alt.is_file():
            context_path = alt
    if context_path.is_file():
        try:
            context = _read_json(context_path)
            if isinstance(context, dict):
                identity["contextIndexPresent"] = True
        except (OSError, json.JSONDecodeError):
            identity["contextIndexPresent"] = False
    return identity


def classify_risk(change_dir: Path, stage: str) -> dict[str, Any]:
    tier = "full"
    source = "default-full"
    plan_path = change_dir / "plans"
    for candidate in sorted(plan_path.glob("*.md")) if plan_path.is_dir() else []:
        text = candidate.read_text(encoding="utf-8", errors="replace")
        match = re.search(r"风险等级[:：]\s*(fast|standard|full)", text, re.IGNORECASE)
        if match:
            tier = match.group(1).lower()
            source = f"plan:{candidate.name}"
            break
        match = re.search(r"risk[^:]*:\s*(fast|standard|full)", text, re.IGNORECASE)
        if match:
            tier = match.group(1).lower()
            source = f"plan:{candidate.name}"
            break
    if stage == "post-run":
        # Stub: post-run reclassification upgrades only; keep plan tier for now.
        source = f"{source}+post-run-stub"
    return {
        "ok": True,
        "code": "CLASSIFIED",
        "stage": stage,
        "tier": tier,
        "source": source,
        "changeId": change_dir.name,
    }


def lint_skill_tree(skills_root: Path) -> dict[str, Any]:
    violations: list[dict[str, Any]] = []
    if not skills_root.is_dir():
        return {
            "ok": False,
            "code": "SKILLS_ROOT_MISSING",
            "message": f"skills root not found: {skills_root}",
        }
    for path in sorted(skills_root.rglob("*.md")):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for line_no, line in enumerate(text.splitlines(), start=1):
            for pattern in FORBIDDEN_SKILL_PATTERNS:
                if pattern.search(line):
                    violations.append(
                        {
                            "file": str(path.relative_to(skills_root)),
                            "line": line_no,
                            "pattern": pattern.pattern,
                            "text": line.strip(),
                        }
                    )
    return {
        "ok": len(violations) == 0,
        "code": "LINT_OK" if not violations else "SKILL_CONTRACT_VIOLATION",
        "violations": violations,
        "skillsRoot": str(skills_root.resolve()),
    }


def append_phase_event(
    change_dir: Path,
    *,
    phase: str,
    type_: str,
    status: str | None = None,
    note: str = "",
    identity: dict[str, Any] | None = None,
    run_id: str | None = None,
) -> dict[str, Any]:
    events_file = he.events_path(change_dir)
    existing = he.load_events(events_file)
    args = argparse.Namespace(
        phase=phase,
        type=type_,
        status=status,
        note=note,
        command=None,
        exit_code=None,
        duration_ms=None,
        name=None,
        path=None,
        kind=None,
        code=None,
        severity=None,
        message=None,
        decision=None,
        reason=None,
        run_id=run_id,
        attempt=None,
        executor_tool=None,
        executor_agent=None,
        executor_model=None,
        handoff_from_tool=None,
        handoff_reason=None,
    )
    event = he.build_event(args, existing)
    if identity:
        for key, value in identity.items():
            if key not in event and value is not None:
                event[key] = value
    line = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    lock_path = change_dir / "events.ndjson.lock"
    with he.event_file_lock(lock_path):
        he.atomic_append_line(events_file, line)
    rendered = False
    log_path = None
    if type_ == "phase.end":
        events = he.load_events(events_file)
        content = he.render_execution_log(events)
        log_path = he.write_execution_log(change_dir, content)
        rendered = True
    return {
        "ok": True,
        "eventId": event.get("id"),
        "path": str(events_file),
        "rendered": rendered,
        "executionLogPath": str(log_path) if log_path else None,
    }


def cmd_begin(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    project = hc.resolve_main_project_root()
    resolved = hc.resolve_change(project, args.change)
    if not resolved.get("ok"):
        return emit_error(
            str(resolved.get("code", "RESOLVE_FAILED")),
            str(resolved.get("message", "change resolve failed")),
            as_json=as_json,
            extra={k: v for k, v in resolved.items() if k not in {"ok", "message"}},
        )
    change_dir = Path(resolved["changeDir"])
    blocked = foundation_gate_blocks(getattr(args, "task", None), change_dir)
    if blocked:
        return emit_error(
            blocked["code"],
            blocked["message"],
            as_json=as_json,
            extra={k: v for k, v in blocked.items() if k not in {"ok", "message", "code"}},
        )

    try:
        policy = hwp.load_policy(project)
    except (OSError, ValueError, hwp.PolicyValidationError) as exc:
        return emit_error("POLICY_LOAD_FAILED", str(exc), as_json=as_json)

    run_id = args.run_id or os.environ.get("HUNTER_HARNESS_RUN_ID", f"run-{os.getpid()}")
    claim = hc.claim_lease(
        project,
        change_id=resolved["changeId"],
        phase=args.phase,
        run_id=run_id,
        ttl_seconds=int(args.ttl_seconds),
    )
    if not claim.get("ok"):
        return emit_error(
            str(claim.get("code", "LEASE_CONFLICT")),
            str(claim.get("message", "lease claim failed")),
            as_json=as_json,
            extra={k: v for k, v in claim.items() if k not in {"ok", "message", "code"}},
        )

    identity = None
    if args.skills_root:
        identity = read_identity(Path(args.skills_root).expanduser().resolve())

    event_result = append_phase_event(
        change_dir,
        phase=args.phase,
        type_="phase.start",
        note=args.note or "",
        identity=identity,
        run_id=run_id,
    )

    payload = {
        "ok": True,
        "code": "PHASE_BEGUN",
        "phase": args.phase,
        "changeId": resolved["changeId"],
        "changeDir": str(change_dir),
        "projectRoot": str(project),
        "lease": claim.get("lease"),
        "identity": identity,
        "event": event_result,
        "policySchemaVersion": policy.get("schemaVersion"),
    }
    emit(payload, as_json=as_json)
    return 0


def cmd_close(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    project = hc.resolve_main_project_root()
    resolved = hc.resolve_change(project, args.change)
    if not resolved.get("ok"):
        return emit_error(
            str(resolved.get("code", "RESOLVE_FAILED")),
            str(resolved.get("message", "change resolve failed")),
            as_json=as_json,
            extra={k: v for k, v in resolved.items() if k not in {"ok", "message"}},
        )
    change_dir = Path(resolved["changeDir"])
    blocked = foundation_gate_blocks(getattr(args, "task", None), change_dir)
    if blocked:
        return emit_error(
            blocked["code"],
            blocked["message"],
            as_json=as_json,
            extra={k: v for k, v in blocked.items() if k not in {"ok", "message", "code"}},
        )

    try:
        policy = hwp.load_policy(project)
    except (OSError, ValueError, hwp.PolicyValidationError) as exc:
        return emit_error("POLICY_LOAD_FAILED", str(exc), as_json=as_json)

    ledger_result = validate_ledger_for_phase_close(change_dir, args.phase, policy)
    if not ledger_result.get("ok") and args.phase in {"run", "test", "package"}:
        return emit_error(
            str(ledger_result.get("code", "LEDGER_INVALID")),
            str(ledger_result.get("message", "ledger validation failed")),
            as_json=as_json,
            extra={k: v for k, v in ledger_result.items() if k not in {"ok", "message", "code"}},
        )

    guard_result = None
    if args.phase in {"run", "test"}:
        project_root = args.project or str(project)
        guard_result = htg.close(project_root, change_dir)
        if not guard_result.get("ok"):
            return emit_error(
                str(guard_result.get("code", "TEST_GUARD_CLOSE_FAILED")),
                "test guard close failed",
                as_json=as_json,
                extra=guard_result,
            )

    run_id = args.run_id or os.environ.get("HUNTER_HARNESS_RUN_ID", f"run-{os.getpid()}")
    event_result = append_phase_event(
        change_dir,
        phase=args.phase,
        type_="phase.end",
        status=args.status,
        note=args.note or "",
        run_id=run_id,
    )

    release = hc.release_lease(
        project,
        change_id=resolved["changeId"],
        phase=args.phase,
        run_id=run_id,
    )
    if not release.get("ok"):
        return emit_error(
            str(release.get("code", "LEASE_RELEASE_FAILED")),
            str(release.get("message", "lease release failed")),
            as_json=as_json,
            extra={k: v for k, v in release.items() if k not in {"ok", "message", "code"}},
        )

    payload = {
        "ok": True,
        "code": "PHASE_CLOSED",
        "phase": args.phase,
        "status": args.status,
        "changeId": resolved["changeId"],
        "ledger": ledger_result,
        "testGuard": guard_result,
        "event": event_result,
        "lease": release,
    }
    emit(payload, as_json=as_json)
    return 0


def cmd_classify(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    project = hc.resolve_main_project_root()
    resolved = hc.resolve_change(project, args.change)
    if not resolved.get("ok"):
        return emit_error(
            str(resolved.get("code", "RESOLVE_FAILED")),
            str(resolved.get("message", "change resolve failed")),
            as_json=as_json,
            extra={k: v for k, v in resolved.items() if k not in {"ok", "message"}},
        )
    payload = classify_risk(Path(resolved["changeDir"]), args.stage)
    emit(payload, as_json=as_json)
    return 0


def cmd_checkpoint(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    project = hc.resolve_main_project_root()
    resolved = hc.resolve_change(project, args.change)
    if not resolved.get("ok"):
        return emit_error(
            str(resolved.get("code", "RESOLVE_FAILED")),
            str(resolved.get("message", "change resolve failed")),
            as_json=as_json,
            extra={k: v for k, v in resolved.items() if k not in {"ok", "message"}},
        )
    change_dir = Path(resolved["changeDir"])
    path = change_dir / CHECKPOINTS_REL
    if args.checkpoint_action == "status":
        checkpoints = load_checkpoints(change_dir)
        status = checkpoint_status(checkpoints, args.id)
        payload = {
            "ok": True,
            "code": "CHECKPOINT_STATUS",
            "checkpointId": args.id,
            "status": status,
            "path": str(path) if path.is_file() else None,
        }
        emit(payload, as_json=as_json)
        return 0

    if args.checkpoint_action != "approve":
        return emit_error("INVALID_CHECKPOINT_ACTION", args.checkpoint_action, as_json=as_json)

    checkpoints = load_checkpoints(change_dir)
    if checkpoints is None:
        checkpoints = {
            "schemaVersion": 1,
            "changeName": resolved["changeId"],
            "checkpoints": [],
        }
    items = checkpoints.setdefault("checkpoints", [])
    if not isinstance(items, list):
        items = []
        checkpoints["checkpoints"] = items
    found = False
    for item in items:
        if isinstance(item, dict) and item.get("id") == args.id:
            item["status"] = "approved"
            item["approvedAt"] = hc.now_iso()
            if args.reviewer:
                item["approvedBy"] = args.reviewer
            found = True
            break
    if not found:
        items.append(
            {
                "id": args.id,
                "status": "approved",
                "approvedAt": hc.now_iso(),
                "approvedBy": args.reviewer or "manual",
                "blocking": True,
            }
        )
    _write_json(path, checkpoints)
    payload = {
        "ok": True,
        "code": "CHECKPOINT_APPROVED",
        "checkpointId": args.id,
        "status": "approved",
        "path": str(path),
    }
    emit(payload, as_json=as_json)
    return 0


def cmd_lint_skills(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    root = Path(args.skills_root).expanduser().resolve()
    payload = lint_skill_tree(root)
    if payload.get("ok"):
        emit(payload, as_json=as_json)
        return 0
    return emit_error(
        str(payload.get("code", "LINT_FAILED")),
        str(payload.get("message", "skill lint failed")),
        as_json=as_json,
        extra={k: v for k, v in payload.items() if k not in {"ok", "message", "code"}},
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harness_gate.py")
    parser.add_argument("--json", action="store_true")
    sub = parser.add_subparsers(dest="command_name", required=True)
    shared = argparse.ArgumentParser(add_help=False)
    shared.add_argument("--json", action="store_true", default=argparse.SUPPRESS)

    p_begin = sub.add_parser("begin", parents=[shared])
    p_begin.add_argument("--phase", required=True)
    p_begin.add_argument("--change", default=None)
    p_begin.add_argument("--project", default=None)
    p_begin.add_argument("--skills-root", default=None)
    p_begin.add_argument("--run-id", default=None)
    p_begin.add_argument("--ttl-seconds", type=int, default=3600)
    p_begin.add_argument("--task", type=int, default=None)
    p_begin.add_argument("--note", default="")
    p_begin.add_argument("--executor-tool", default=None)
    p_begin.add_argument("--executor-agent", default=None)
    p_begin.add_argument("--executor-model", default=None)
    p_begin.set_defaults(func=cmd_begin)

    p_close = sub.add_parser("close", parents=[shared])
    p_close.add_argument("--phase", required=True)
    p_close.add_argument("--change", default=None)
    p_close.add_argument("--project", default=None)
    p_close.add_argument("--status", required=True)
    p_close.add_argument("--run-id", default=None)
    p_close.add_argument("--task", type=int, default=None)
    p_close.add_argument("--note", default="")
    p_close.set_defaults(func=cmd_close)

    p_classify = sub.add_parser("classify", parents=[shared])
    p_classify.add_argument("--change", default=None)
    p_classify.add_argument("--stage", required=True, choices=["plan", "post-run"])
    p_classify.set_defaults(func=cmd_classify)

    p_checkpoint = sub.add_parser("checkpoint", parents=[shared])
    p_checkpoint.add_argument("checkpoint_action", choices=["status", "approve"])
    p_checkpoint.add_argument("--id", required=True)
    p_checkpoint.add_argument("--change", default=None)
    p_checkpoint.add_argument("--reviewer", default=None)
    p_checkpoint.set_defaults(func=cmd_checkpoint)

    p_lint = sub.add_parser("lint-skills", parents=[shared])
    p_lint.add_argument("--skills-root", required=True)
    p_lint.set_defaults(func=cmd_lint_skills)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
