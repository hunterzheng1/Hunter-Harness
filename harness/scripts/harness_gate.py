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
import hashlib
import json
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_change as hc  # noqa: E402
import harness_context as hctx  # noqa: E402
import harness_events as he  # noqa: E402
import harness_ledger as hl  # noqa: E402
import harness_paths as hp  # noqa: E402
import harness_plan_finalize as hpf  # noqa: E402
import harness_review as hr  # noqa: E402
import harness_runtime as hruntime  # noqa: E402
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

CAPABILITY_MARKERS: dict[str, tuple[str, ...]] = {
    "risk-classify-plan": ("harness_gate.py classify",),
    "gate-begin": ("harness_gate.py begin",),
    "gate-close": ("harness_gate.py close",),
    "ledger-record": ("harness_ledger.py record",),
    "ledger-can-reuse": ("harness_ledger.py can-reuse",),
    "test-guard": ("harness_test_guard.py begin", "harness_test_guard.py close"),
    "test-guard-stage": ("harness_test_guard.py stage",),
    "integration-lock": ("harness_change.py integration-lock",),
}

DESIGN_GATE_CAPABILITIES = frozenset({"deployment", "container", "api", "database"})
VALIDATION_DEPENDENCIES: dict[str, tuple[str, ...]] = {
    "compile": (),
    "unitTest": ("compile",),
    "unitTestFull": ("unitTest",),
    "apiTest": ("unitTest",),
    "browserTest": ("unitTest",),
    "dbCompatibility": ("unitTest",),
    "package": ("unitTestFull", "apiTest", "dbCompatibility"),
}


def _load_workflow_policy(
    *, project: Path | None = None, skills_root: Path | None = None
) -> dict[str, Any]:
    candidates = []
    if project is not None:
        candidates.append(project / "harness" / "contracts" / "workflow-policy.json")
    if skills_root is not None:
        candidates.append(skills_root / "contracts" / "workflow-policy.json")
    candidates.append(SCRIPTS_DIR.parent / "contracts" / "workflow-policy.json")
    for path in candidates:
        if path.is_file():
            raw = json.loads(path.read_text(encoding="utf-8"))
            return hwp.validate_policy(raw)
    raise FileNotFoundError("workflow-policy.json not found beside project or skills")


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
        # 文本模式同样给出恢复指引——--json 的 recoveryAction 一直有，
        # 但人类读的恰恰是文本模式（2026-08-30 实测：用户翻文档才找到 claim 命令）
        recovery = payload.get("recoveryAction")
        if isinstance(recovery, str) and recovery:
            sys.stderr.write(f"recovery: {recovery}\n")
    return 1


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


# ---------------------------------------------------------------------------
# Gate severity tiering (P1 controllability)
#
# Hard invariants stay fail-closed in every mode:
#   1. submit/merge identity & final-hash consistency (ledger/integration);
#   2. archive integrity (manifest/minimal set, enforced in harness_archive);
#   3. destructive-action protection (cleanup topology / protected paths).
# The sites listed in SOFT_GATE_SITES guard regenerable bookkeeping
# (plan-handoff projections, phase capsules, scenario coverage receipts,
# test-guard tracking). In "lenient" mode a failure at one of those sites is
# recorded as a WARN receipt (evidence/gate-warnings.ndjson) instead of
# blocking the phase. Release phases (submit/merge/archive/release/deploy)
# never downgrade.
# ---------------------------------------------------------------------------

GATE_RELEASE_PHASES = frozenset({"submit", "merge", "archive", "release", "deploy"})
SOFT_GATE_SITES = frozenset({
    "plan-handoff",
    "capsule",
    "scenario-coverage",
    "test-guard",
})
GATE_WARNINGS_REL = Path("evidence") / "gate-warnings.ndjson"

# Lifecycle order used to scope C9 scenario coverage by scenario ownerPhase.
# A scenario owned by a later phase is deferred, not missing, at an earlier
# phase close. Must stay a superset-ordering of hpf.VALID_OWNER_PHASES.
SCENARIO_OWNER_PHASE_ORDER = ("plan", "execute", "review", "submit")

# ---------------------------------------------------------------------------
# 阶段能力表：每个阶段在 begin/close 里额外做什么，集中在这里声明。
#
# 这些开关以前是 cmd_begin / cmd_close 里散落的 `if args.phase == ...` —— 两个
# 五百行的函数，想知道"execute 阶段关门时到底跑哪几项"要通读全文。更要紧的是
# execute/review 的差异被摊平在控制流里，看不出它们其实共用同一套生命周期。
#
# 键的含义：
#   plan_handoff      begin 时校验 plan 已 finalize（只有进入实现的第一个阶段需要）
#   test_guard        begin 建测试基线快照、close 比对（改测试的阶段才需要）
#   scenario_coverage close 时跑 C9 场景覆盖
#   ledger_blocking   close 时 ledger 校验失败是否阻断（否则只进 payload）
#   review_outputs    close 时校验 review sidecar 与 runId 绑定
#   head_may_advance  capsule 校验允许 HEAD 前移（会产生 commit 的阶段）
#   projection_drift  close 时 projection receipt 变化即硬失败（外发边界）
PHASE_GATE_RULES: dict[str, frozenset[str]] = {
    "plan": frozenset(),
    "execute": frozenset({
        "plan_handoff", "test_guard", "scenario_coverage",
        "ledger_blocking", "head_may_advance",
    }),
    "review": frozenset({"review_outputs"}),
    "package": frozenset({"ledger_blocking"}),
    "apidoc": frozenset(),
    "submit": frozenset({"head_may_advance", "projection_drift"}),
    "merge": frozenset({"head_may_advance"}),
    "archive": frozenset({"projection_drift"}),
}
# 不在 WORKFLOW_PHASES 里、但 projection 门禁按发布阶段对待的名字。
_EXTRA_PROJECTION_DRIFT_PHASES = frozenset({"release", "deploy"})


def phase_gate_rule(phase: str | None, rule: str) -> bool:
    """这个阶段是否启用某项门禁能力。未知阶段一律不启用（fail-safe）。"""
    name = str(phase or "")
    if rule == "projection_drift" and name in _EXTRA_PROJECTION_DRIFT_PHASES:
        return True
    resolved = hp.resolve_phase_name(name) or name
    return rule in PHASE_GATE_RULES.get(resolved, frozenset())


def gate_severity_mode(project: Path, change_dir: Path | None = None) -> str:
    """Resolve gate severity mode: env > change gate-policy > project config.

    Default is ``lenient`` (soft regenerable sites → WARN). Release phases and
    the three hard invariants stay fail-closed; set ``HUNTER_HARNESS_GATE_MODE``
    or ``gate-policy.json`` ``severityMode`` to ``strict`` to force fail-closed
    soft sites as well.
    """
    env_mode = str(os.environ.get("HUNTER_HARNESS_GATE_MODE") or "").strip().lower()
    if env_mode in {"strict", "lenient"}:
        return env_mode
    candidates: list[Path] = []
    if change_dir is not None:
        candidates.append(change_dir / "meta" / "gate-policy.json")
    candidates.append(project / ".harness" / "config" / "gate-policy.json")
    for path in candidates:
        if not path.is_file():
            continue
        try:
            document = _read_json(path)
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(document, dict):
            continue
        value = str(document.get("severityMode") or "").strip().lower()
        if value in {"strict", "lenient"}:
            return value
    return "lenient"


def gate_soft_allowed(mode: str, phase: str, site: str) -> bool:
    return (
        mode == "lenient"
        and phase not in GATE_RELEASE_PHASES
        and site in SOFT_GATE_SITES
    )


def record_gate_warning(
    change_dir: Path,
    *,
    phase: str,
    site: str,
    code: str,
    message: str,
) -> dict[str, Any]:
    """Append a downgraded-gate receipt; the phase continues with WARN."""
    entry = {
        "ts": he.now_iso(),
        "phase": phase,
        "site": site,
        "code": code,
        "message": message,
        "mode": "lenient",
    }
    path = change_dir / GATE_WARNINGS_REL
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False, separators=(",", ":")) + "\n")
    return entry


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


def _git_text(cwd: Path, *args: str) -> str | None:
    proc = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    return proc.stdout.strip() if proc.returncode == 0 else None


def _git_is_ancestor(cwd: Path, ancestor: str, descendant: str) -> bool:
    proc = subprocess.run(
        ["git", "merge-base", "--is-ancestor", ancestor, descendant],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    return proc.returncode == 0


def evaluate_projection_gate(
    project: Path,
    phase: str,
) -> dict[str, Any]:
    """Validate three-stage projection identity and apply phase fallback policy."""
    project = project.resolve()
    path = project / ".harness" / "config" / "projection-receipt.json"
    release_phase = phase in {"submit", "archive", "release", "deploy"}
    if not path.is_file():
        return {
            "ok": True,
            "code": "PROJECTION_RECEIPT_NOT_CONFIGURED",
            "status": "legacy",
            "mode": "legacy",
            "receiptPath": str(path),
            "releasePhase": release_phase,
        }
    try:
        receipt = _read_json(path)
    except (OSError, json.JSONDecodeError) as exc:
        receipt = {}
        parse_error = str(exc)
    else:
        parse_error = None
    source = receipt.get("source")
    transform = receipt.get("transform")
    target = receipt.get("target")
    source = source if isinstance(source, dict) else {}
    transform = transform if isinstance(transform, dict) else {}
    target = target if isinstance(target, dict) else {}
    digest_pattern = re.compile(r"sha256:[0-9a-fA-F]{64}")
    issues = []
    if receipt.get("schemaVersion") != 1:
        issues.append("schemaVersion")
    for label, value in (
        ("source.hash", source.get("hash")),
        ("transform.hash", transform.get("hash")),
        ("target.hash", target.get("hash")),
    ):
        if not isinstance(value, str) or not digest_pattern.fullmatch(value):
            issues.append(label)
    if not str(transform.get("version") or "").strip():
        issues.append("transform.version")
    if not isinstance(receipt.get("projectOwnedExclusions"), list):
        issues.append("projectOwnedExclusions")
    if not str(receipt.get("generatedAt") or "").strip():
        issues.append("generatedAt")
    status = str(receipt.get("status") or "").strip().lower()
    if status not in {"verified", "degraded"}:
        issues.append("status")
        status = "degraded"
    if parse_error:
        issues.append("parse")
    receipt_hash = "sha256:" + hashlib.sha256(
        json.dumps(
            receipt,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    ).hexdigest()
    degraded = status == "degraded" or bool(issues)
    if degraded and release_phase:
        return {
            "ok": False,
            "code": "PROJECTION_DEGRADED_BLOCKED",
            "message": (
                "adapter/config projection is degraded; refresh the projection "
                "receipt before submit/archive/release"
            ),
            "status": "degraded",
            "mode": "blocked",
            "issues": issues,
            "receipt": receipt,
            "receiptHash": receipt_hash,
            "receiptPath": str(path),
            "releasePhase": True,
            "remediation": (
                "regenerate .harness/config/projection-receipt.json from the "
                "project truth source"
            ),
        }
    return {
        "ok": True,
        "code": (
            "PROJECTION_VERIFIED"
            if not degraded
            else "PROJECTION_DEGRADED_FALLBACK"
        ),
        "message": (
            "projection receipt verified"
            if not degraded
            else "degraded projection allowed only in explicit fallback mode"
        ),
        "status": "verified" if not degraded else "degraded",
        "mode": "normal" if not degraded else "fallback",
        "issues": issues,
        "receipt": receipt,
        "receiptHash": receipt_hash,
        "receiptPath": str(path),
        "releasePhase": release_phase,
        "remediation": (
            None
            if not degraded
            else (
                "regenerate .harness/config/projection-receipt.json from the "
                "project truth source before any release phase"
            )
        ),
    }


def resolve_execution_root(main_project: Path, raw: str | None) -> Path:
    candidate = Path(raw).expanduser().resolve() if raw else main_project.resolve()
    if not candidate.is_dir():
        raise ValueError(
            f"execution root not found: {candidate} — --project takes a "
            "filesystem path to the execution root (use '.' when running from "
            "it), not the project name"
        )
    top = _git_text(candidate, "rev-parse", "--show-toplevel")
    if not top:
        raise ValueError(f"execution root is not a git worktree: {candidate}")
    root = Path(top).resolve()
    if hp.repository_identity(root) != hp.repository_identity(main_project):
        raise ValueError("execution root belongs to a different repository")
    return root


def resolve_begin_execution_hint(
    main_project: Path,
    *,
    requested: str | None,
    capsule: dict[str, Any] | None,
    cwd: Path | None = None,
) -> dict[str, str]:
    """Choose an execution root explicitly, from the capsule, or from Git cwd."""
    if requested:
        return {
            "executionRoot": str(Path(requested).expanduser().resolve()),
            "source": "explicit",
        }
    if isinstance(capsule, dict) and str(capsule.get("executionRoot") or "").strip():
        return {
            "executionRoot": str(capsule["executionRoot"]),
            "source": "phase-capsule",
        }
    current = (cwd or Path.cwd()).resolve()
    try:
        top = _git_text(current, "rev-parse", "--show-toplevel")
        detected = Path(top).resolve() if top else None
        if (
            detected is not None
            and detected.is_dir()
            and hp.repository_identity(detected)
            == hp.repository_identity(main_project)
        ):
            return {
                "executionRoot": str(detected),
                "source": "cwd-git-root",
            }
    except (OSError, RuntimeError, ValueError):
        pass
    return {
        "executionRoot": str(main_project.resolve()),
        "source": "main-project-default",
    }


def _phase_capsule_path(change_dir: Path, phase: str, run_id: str) -> Path:
    key = hashlib.sha256(f"{phase}\0{run_id}".encode("utf-8")).hexdigest()[:20]
    return (
        Path(hp.resolve_state_dir_for_contract(change_dir))
        / "runtime"
        / "phase-context"
        / f"{phase}-{key}.json"
    )


def load_phase_capsule(
    change_dir: Path, phase: str, run_id: str
) -> dict[str, Any] | None:
    # 在途 change 的 capsule 可能按旧名（run/test）写入：先归一入参，canonical
    # 查不到时对所有解析为该 canonical 的旧名各查一次。新写一律 canonical。
    phase = hp.resolve_phase_name(phase) or phase
    candidates = [phase] + [
        legacy for legacy, canonical in hp.LEGACY_PHASE_ALIASES.items()
        if canonical == phase
    ]
    path: Path | None = None
    for name in candidates:
        candidate = _phase_capsule_path(change_dir, name, run_id)
        if candidate.is_file():
            path = candidate
            break
    if path is None:
        return None
    try:
        data = _read_json(path)
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"phase capsule is unreadable: {path}: {exc}") from exc
    if not isinstance(data, dict) or data.get("schemaVersion") != 1:
        raise ValueError(f"phase capsule has an unsupported schema: {path}")
    return data


def write_phase_capsule(
    change_dir: Path, phase: str, run_id: str, capsule: dict[str, Any]
) -> Path:
    path = _phase_capsule_path(change_dir, phase, run_id)
    _write_json(path, capsule)
    return path


def persist_close_failure(
    change_dir: Path,
    phase: str,
    run_id: str,
    capsule: dict[str, Any] | None,
    *,
    status: str,
    error: dict[str, Any],
) -> None:
    """Journal a retryable close failure before returning to the caller."""
    if capsule is None:
        return
    transaction = capsule.get("closeTransaction")
    transaction = dict(transaction) if isinstance(transaction, dict) else {}
    transaction.update(
        {
            "status": status,
            "retryable": True,
            "guardClosed": bool(transaction.get("guardClosed")),
            "phaseEndRecorded": bool(transaction.get("phaseEndRecorded")),
            "leaseReleased": False,
            "lastError": error,
            "updatedAt": he.now_iso(),
        }
    )
    capsule["closeTransaction"] = transaction
    capsule.pop("closeStatus", None)
    capsule.pop("closedAt", None)
    write_phase_capsule(change_dir, phase, run_id, capsule)


def validate_phase_capsule(
    capsule: dict[str, Any],
    *,
    change_dir: Path,
    change_id: str,
    phase: str,
    run_id: str,
    project: Path,
    execution_root: Path,
    skills_root: Path | None = None,
    allow_head_advance: bool = False,
) -> None:
    """Fail closed when a resume/close capsule no longer identifies this run."""
    required = (
        "changeId", "phase", "runId", "projectRoot", "stateRoot",
        "executionRoot", "skillsRoot", "repositoryId", "baseCommit", "currentHead",
    )
    missing = [
        field for field in required
        if not isinstance(capsule.get(field), str) or not str(capsule[field]).strip()
    ]
    if missing:
        raise ValueError("phase capsule missing: " + ", ".join(missing))
    expected = {
        "changeId": change_id,
        "phase": phase,
        "runId": run_id,
        "projectRoot": str(project.resolve()),
        "stateRoot": str(Path(hp.resolve_state_dir_for_contract(change_dir)).resolve()),
        "executionRoot": str(execution_root.resolve()),
    }
    if skills_root is not None:
        expected["skillsRoot"] = str(skills_root.resolve())
    for field, value in expected.items():
        if capsule.get(field) != value:
            raise ValueError(
                f"phase capsule {field} mismatch: expected {value}, found {capsule.get(field)}"
            )
    current_repository = hp.repository_identity(execution_root)
    if capsule.get("repositoryId") != current_repository:
        raise ValueError("phase capsule repositoryId mismatch")
    current_head = _git_text(execution_root, "rev-parse", "--verify", "HEAD")
    capsule_head = str(capsule["currentHead"])
    head_advanced = (
        allow_head_advance
        and isinstance(current_head, str)
        and _git_is_ancestor(execution_root, capsule_head, current_head)
    )
    if capsule_head != current_head and not head_advanced:
        raise ValueError(
            f"phase capsule currentHead mismatch: expected {capsule_head}, "
            f"found {current_head}"
        )


def load_checkpoints(change_dir: Path) -> dict[str, Any] | None:
    path = change_dir / CHECKPOINTS_REL
    if not path.is_file():
        return None
    try:
        data = _read_json(path)
    except (OSError, json.JSONDecodeError):
        return None
    # 刻意返回**原样**文档：cmd_checkpoint approve 会把这里的返回值写回盘，
    # 返回归一化结构会用合成内容覆盖 v2 的哈希绑定产物（ARTIFACT_HASH_DRIFT）。
    # 形状差异在只读的 checkpoint_status 里消化。
    return data if isinstance(data, dict) else None


def checkpoint_status(checkpoints: dict[str, Any] | None, checkpoint_id: str) -> str:
    """Read a checkpoint's status across the three shapes this file is written in.

    `meta/implementation-checkpoints.json` 有三个写入者，形状各不相同：
    `harness_change.migrate` 写 ``checkpoints[{id,status}]``；legacy plan finalize 写
    顶层 ``foundationGate``；v2 plan finalize 写 artifact 包装体，状态在
    ``content.foundation_gate``。以前只认第一种，另外两种一律返回 "missing"
    ——checkpoint 的状态对整条 v2 路径和 legacy finalize 之后都是读不出来的。

    只读归一化：调用方拿到的是状态，不是文档。写回路径（cmd_checkpoint approve）
    仍然操作原始文档，不能用归一化结构覆盖哈希绑定的 v2 产物。
    """
    if not checkpoints:
        return "missing"
    items = checkpoints.get("checkpoints")
    if isinstance(items, list):
        for item in items:
            if isinstance(item, dict) and item.get("id") == checkpoint_id:
                return str(item.get("status") or "pending")
        return "missing"
    if checkpoint_id != "foundation-gate":
        return "missing"
    unpacked = hpf.unpack_v2_implementation_checkpoints(checkpoints)
    if unpacked is not None:
        return str(unpacked["checkpoints"][0]["status"])
    legacy = checkpoints.get("foundationGate")
    return str(legacy).strip() if str(legacy or "").strip() else "missing"


def foundation_gate_blocks(task_number: int | None, change_dir: Path) -> dict[str, Any] | None:
    checkpoints = load_checkpoints(change_dir)
    status = checkpoint_status(checkpoints, "foundation-gate")
    # missing = checkpoint not enabled for this change (no file / no entry).
    if status in {"approved", "missing"}:
        return None
    if task_number is None:
        return {
            "ok": False,
            "code": "TASK_NUMBER_REQUIRED",
            "message": "--task is required while foundation-gate is pending",
            "checkpointId": "foundation-gate",
            "checkpointStatus": status,
        }
    if task_number < 6:
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


def is_degraded_ledger_entry(entry: dict[str, Any]) -> bool:
    """NOT_RUN + evidence starting with 'DEGRADED: <non-empty reason>'."""
    if entry.get("status") != "NOT_RUN":
        return False
    evidence = str(entry.get("evidence") or "").strip()
    if not evidence.startswith("DEGRADED:"):
        return False
    reason = evidence.split(":", 1)[1].strip()
    return bool(reason)


def validate_ledger_entry_v2(entry: dict[str, Any], verification: str) -> tuple[list[str], bool]:
    """Internal helper for ledger close validation (not a public API).

    Returns ``(missing_fields, degraded_ok)`` where ``degraded_ok`` is True only when
    the entry is a valid DEGRADED NOT_RUN record with no other missing fields.

    Retro §5.14: ``status=OK``/``status=NOT_RUN``/``status=FAIL`` in the
    missing list is a *status value* hint, not a field-completeness defect.
    Callers consuming this under ``phase_status=FAIL`` must filter out
    ``status=*`` entries from the missing list before treating them as
    blocking problems.
    """
    missing: list[str] = []
    degraded = is_degraded_ledger_entry(entry)
    for field in LEDGER_V2_REQUIRED_ENTRY_FIELDS:
        value = entry.get(field)
        if field == "inputsFiles":
            if not isinstance(value, list):
                missing.append(field)
            elif verification == "unitTestFull" and not value:
                missing.append("inputsFiles(non-empty)")
        elif field == "status":
            if value != "OK" and not degraded:
                if str(value).upper() == "NOT_RUN":
                    # 2026-09 dogfood: 此前提示 "missing: [status=NOT_RUN]"，
                    # 而条目状态明明就是 NOT_RUN——真实缺口是 evidence 缺
                    # DEGRADED: 前缀。直说，别让调用方对着状态值猜。
                    missing.append(
                        "status=NOT_RUN requires evidence starting with "
                        "'DEGRADED: <reason>' (is_degraded_ledger_entry)"
                    )
                else:
                    missing.append(f"status={value}")
        elif not (isinstance(value, str) and value.strip()):
            missing.append(field)
        elif field == "coverage" and str(value).strip() not in hl.COVERAGE_RANK:
            missing.append("coverage(valid)")
        elif field == "algorithmVersion" and str(value).strip() != hl.LEDGER_VERSION:
            missing.append("algorithmVersion(harness-ledger-2)")
    return missing, degraded and not missing


def validate_ledger_for_phase_close(
    change_dir: Path,
    phase: str,
    policy: dict[str, Any],
    *,
    execution_root: Path | None = None,
    phase_status: str = "OK",
) -> dict[str, Any]:
    """Validate ledger v2 fields required for phase close (UT-026).

    Retro §5.14: ``phase_status`` separates phase outcome from promotion gate.
    ``phase_status=OK`` (default) requires all required validations to be OK;
    ``phase_status=FAIL`` validates field completeness and identity but allows
    individual validation status to be FAIL/NOT_RUN, so a failing phase can
    close honestly without polluting evidence or blocking lease release.
    """
    resolved_phase = hp.resolve_phase_name(phase) or phase
    # requiredValidations 的键可能还是合并前的旧名（在途 change 的旧契约），
    # 入参也可能是旧名（手工 --phase run）——两侧都归一后再匹配；旧契约的
    # run/test 两个键都映射到 execute，取并集。
    required: list[str] = []
    for key, value in (policy.get("requiredValidations") or {}).items():
        if (hp.resolve_phase_name(key) or str(key)) == resolved_phase:
            for item in value or []:
                if item not in required:
                    required.append(item)
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

    try:
        contract = hp.load_change_contract(change_dir)
    except (OSError, ValueError, json.JSONDecodeError):
        contract = {}
    contract_version = contract.get("schemaVersion")
    contract_is_v2 = hp.contract_layout_kind(contract) == "split-v1" or (
        isinstance(contract_version, int) and contract_version >= 2
    )
    if contract_is_v2:
        missing_identity = hl.validate_ledger_identity(ledger)
        if missing_identity:
            return {
                "ok": False,
                "code": "LEDGER_IDENTITY_INVALID",
                "message": "ledger identity is incomplete",
                "phase": phase,
                "missing": missing_identity,
                "ledgerPath": str(ledger_path) if ledger_path else None,
            }
        root = Path(execution_root or hp.resolve_worktree_root(change_dir)).resolve()
        try:
            current_repository = hp.repository_identity(root)
            current_ownership = hl.ownership_hash(contract)
            current_diff_detail = hl.compute_ownership_diff(
                root,
                base=str(ledger["baseCommit"]),
                change_dir=change_dir,
            )
            current_diff = current_diff_detail["diffHash"]
            current_head = _git_text(root, "rev-parse", "--verify", "HEAD")
        except (OSError, ValueError, RuntimeError) as exc:
            return {
                "ok": False,
                "code": "LEDGER_IDENTITY_INVALID",
                "message": f"cannot resolve current ledger identity: {exc}",
                "phase": phase,
                "ledgerPath": str(ledger_path) if ledger_path else None,
            }
        identity_mismatch = (
            ledger.get("repositoryId") != current_repository
            or ledger.get("ownershipHash") != current_ownership
            or ledger.get("diffHash") != current_diff
        )
        if identity_mismatch:
            return {
                "ok": False,
                "code": "LEDGER_IDENTITY_MISMATCH",
                "message": "verification ledger does not match the current change",
                "phase": phase,
                "storedRepositoryId": ledger.get("repositoryId"),
                "currentRepositoryId": current_repository,
                "storedOwnershipHash": ledger.get("ownershipHash"),
                "currentOwnershipHash": current_ownership,
                "storedDiffHash": ledger.get("diffHash"),
                "currentDiffHash": current_diff,
                "storedHead": ledger.get("currentHead"),
                "currentHead": current_head,
                "ledgerPath": str(ledger_path) if ledger_path else None,
                "pathSummary": {
                    "ownedFiles": list(current_diff_detail.get("files") or [])[:20],
                    "foreignPaths": list(current_diff_detail.get("foreignPaths") or [])[:20],
                    "ownedFileCount": current_diff_detail.get("ownedFileCount", 0),
                    "excludedRuntimeCount": current_diff_detail.get(
                        "excludedRuntimeCount", 0
                    ),
                },
                "recoveryAction": (
                    "先确认新增、删除或越界路径是否属于当前变更；更新所有权后，"
                    "只重新执行受影响的验证，再原样重试 close。"
                ),
            }

    problems: list[dict[str, Any]] = []
    degraded: list[str] = []
    fail_status: list[str] = []
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
        missing, is_degraded = validate_ledger_entry_v2(entry, verification)
        # Retro §5.14: under phase_status=FAIL/WARN, status value hints
        # (status=FAIL, status=NOT_RUN) are acceptable; only real field-
        # completeness defects block close. Under phase_status=OK, status
        # value hints are blocking.
        if phase_status.upper() in {"FAIL", "WARN"}:
            missing = [m for m in missing if not m.startswith("status=")]
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
            continue
        if is_degraded:
            degraded.append(verification)
            continue
        # Under phase_status=FAIL/WARN, a FAIL/NOT_RUN status is acceptable.
        entry_status = str(entry.get("status") or "").upper()
        if entry_status in {"FAIL", "NOT_RUN"}:
            if phase_status.upper() in {"FAIL", "WARN"}:
                fail_status.append(verification)
            else:
                hint = (
                    ["status=NOT_RUN requires evidence starting with "
                     "'DEGRADED: <reason>'"]
                    if entry_status == "NOT_RUN" else [f"status={entry_status}"]
                )
                problems.append({
                    "verification": verification,
                    "missing": hint,
                    "code": "VALIDATION_NOT_OK",
                })

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
    if fail_status:
        return {
            "ok": True,
            "code": "LEDGER_OK_FAIL",
            "phase": phase,
            "validated": required,
            "failed": fail_status,
            "degraded": degraded,
            "ledgerPath": str(ledger_path) if ledger_path else None,
        }
    if degraded:
        return {
            "ok": True,
            "code": "LEDGER_OK_DEGRADED",
            "phase": phase,
            "validated": required,
            "degraded": degraded,
            "ledgerPath": str(ledger_path) if ledger_path else None,
        }
    return {
        "ok": True,
        "code": "LEDGER_OK",
        "phase": phase,
        "validated": required,
        "ledgerPath": str(ledger_path) if ledger_path else None,
    }


def effective_workflow_policy(
    workflow: dict[str, Any], change_dir: Path
) -> dict[str, Any]:
    """Overlay a classified change's per-phase gate requirements.

    权威切换（2026-08）：经 ``harness_paths.load_change_gate_policy`` 读取——
    v2 发布快照（meta/plan-profile.json）优先，classify 工作副本回退。
    返回值保持与历史一致的纯净 workflow 形状；source/drift 由需要记录的
    调用方另行调用 ``load_change_gate_policy`` 获取（见 gate begin 路径）。
    """
    loaded = hp.load_change_gate_policy(change_dir)
    document = loaded.get("policy")
    if document is None:
        return workflow
    if not isinstance(document, dict) or document.get("schemaVersion") != 1:
        raise ValueError("gate-policy.json must be a schemaVersion 1 object")
    by_phase = document.get("requiredValidationsByPhase")
    if by_phase is None:
        return workflow
    if not isinstance(by_phase, dict):
        raise ValueError("gate-policy.requiredValidationsByPhase must be an object")
    known = set(workflow.get("validationPhases") or {})
    required = dict(workflow.get("requiredValidations") or {})
    for phase, validations in by_phase.items():
        if not isinstance(phase, str) or not isinstance(validations, list):
            raise ValueError("gate-policy phase requirements must be string arrays")
        if any(not isinstance(item, str) or item not in known for item in validations):
            raise ValueError(f"gate-policy contains unknown validation for phase {phase}")
        required[phase] = _ordered_unique(validations)
    effective = dict(workflow)
    effective["requiredValidations"] = required
    return effective


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_identity(
    project: Path,
    skills_root: Path,
    executor_tool: str | None,
) -> dict[str, Any]:
    skills_root = skills_root.resolve()
    build_path = skills_root / ".harness-build.json"
    if not build_path.is_file():
        raise ValueError("BUNDLE_IDENTITY_MISSING: refresh the selected Harness adapter")
    build = _read_json(build_path)
    if not isinstance(build, dict) or build.get("schemaVersion") != 1:
        raise ValueError("BUNDLE_IDENTITY_INVALID: .harness-build.json schema")
    agent = str(build.get("agent") or "").strip()
    core_hash = str(build.get("coreHash") or "").strip()
    if not agent or not core_hash:
        raise ValueError("BUNDLE_IDENTITY_INVALID: agent/coreHash is required")

    # 「这个 bundle 是否可信」和「现在是哪个工具在跑」是两件事。以前
    # executor_tool != agent 直接 BUNDLE_IDENTITY_MISMATCH，于是 Codex 换
    # CodeBuddy 接手同一个 change 会被当成 bundle 身份不符挡下来。下面每一项
    # 校验用的都是 bundle 自称的 agent，与当前工具无关；工具名降级为审计字段，
    # 随 phase.start 事件留痕。
    executor_matches_bundle = not executor_tool or executor_tool == agent

    context = _read_json(project / ".harness" / "context-index.json")
    installed = _read_json(
        project / ".harness" / "state" / "local" / "installed-harness-bundle.json"
    )
    if not isinstance(context, dict) or not isinstance(installed, dict):
        raise ValueError("BUNDLE_IDENTITY_INVALID: context or installed state")
    adapters = context.get("project", {}).get("adapters", {})
    adapter = adapters.get(agent) if isinstance(adapters, dict) else None
    if not isinstance(adapter, dict):
        raise ValueError(f"BUNDLE_IDENTITY_MISMATCH: adapter {agent} is not configured")
    configured_root = (project / str(adapter.get("skills_root") or "")).resolve()
    if configured_root != skills_root:
        raise ValueError("BUNDLE_IDENTITY_MISMATCH: skills root differs from context-index")
    bundle = context.get("skill_bundles", {}).get(agent)
    if not isinstance(bundle, dict):
        raise ValueError("BUNDLE_IDENTITY_INVALID: context bundle metadata missing")
    registry_version = str(bundle.get("registry_version") or "")
    bundle_hash = str(bundle.get("bundle_hash") or "")
    profile = str((installed.get("profiles") or {}).get(agent) or "")
    manifests = installed.get("manifests")
    manifest = next((item for item in manifests if isinstance(item, dict)
                     and item.get("adapter") == agent and item.get("profile") == profile), None) \
        if isinstance(manifests, list) else None
    if not isinstance(manifest, dict) or \
            str(manifest.get("bundle_version") or "") != registry_version or \
            str(manifest.get("bundle_manifest_hash") or "") != bundle_hash:
        raise ValueError("BUNDLE_IDENTITY_MISMATCH: installed manifest differs from context-index")
    try:
        marker_target = build_path.relative_to(project).as_posix()
    except ValueError as exc:
        raise ValueError("BUNDLE_IDENTITY_MISMATCH: skills root is outside project") from exc
    files = installed.get("files")
    marker = next((item for item in files if isinstance(item, dict)
                   and item.get("owner") == agent
                   and str(item.get("target_path") or "").replace("\\", "/") == marker_target), None) \
        if isinstance(files, list) else None
    actual_hash = _sha256_file(build_path)
    if not isinstance(marker, dict) or str(marker.get("sha256") or "") != actual_hash:
        raise ValueError("BUNDLE_IDENTITY_MISMATCH: installed build marker hash drifted; refresh required")
    return {
        "skillsRoot": str(skills_root),
        "registryVersion": registry_version,
        "bundleHash": bundle_hash,
        "coreHash": core_hash,
        "overlay": str(build.get("overlay") or "none"),
        "profile": profile,
        "adapter": agent,
        "buildMarkerHash": actual_hash,
        "contextIndexPresent": True,
        "executorTool": executor_tool or None,
        "executorMatchesBundle": executor_matches_bundle,
    }


def read_identity(skills_root: Path) -> dict[str, Any]:
    """Backward-compatible marker reader used by callers that only need display data."""
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


def resolve_skills_root(raw: str | None) -> Path | None:
    """Resolve an explicit root or the installed bundle beside this script."""
    if isinstance(raw, str) and raw.strip():
        return Path(raw).expanduser().resolve()
    adjacent = SCRIPTS_DIR.parent.resolve()
    return adjacent if (adjacent / ".harness-build.json").is_file() else None


def change_code_root(change_dir: Path) -> Path:
    project = change_dir.parents[2]
    inferred = hl.infer_execution_project_root(change_dir)
    if inferred is not None:
        return inferred
    if hl.declares_execution_worktree(change_dir):
        raise ValueError(
            "EXECUTION_WORKTREE_INVALID: declared worktree is missing, not a Git root, "
            "or belongs to another repository"
        )
    return project


def _design_capabilities(change_dir: Path) -> list[str]:
    """Read explicit capability tags from design/plan YAML frontmatter."""
    capabilities: set[str] = set()
    candidates: list[Path] = []
    for directory in (change_dir / "spec", change_dir / "plans"):
        if directory.is_dir():
            candidates.extend(sorted(directory.glob("*.md")))
    for candidate in candidates:
        text = candidate.read_text(encoding="utf-8", errors="replace")
        if not text.startswith("---"):
            continue
        end = text.find("\n---", 3)
        if end < 0:
            continue
        frontmatter = text[3:end]
        inline = re.search(r"^capabilities\s*:\s*\[([^\]]*)\]\s*$", frontmatter, re.MULTILINE)
        if inline:
            values = (item.strip().strip("'\"") for item in inline.group(1).split(","))
            capabilities.update(item for item in values if item in DESIGN_GATE_CAPABILITIES)
            continue
        block = re.search(
            r"^capabilities\s*:\s*$((?:\n\s*-\s*[^\n]+)+)",
            frontmatter,
            re.MULTILINE,
        )
        if block:
            for item in re.findall(r"^\s*-\s*([^\n]+)$", block.group(1), re.MULTILINE):
                value = item.strip().strip("'\"")
                if value in DESIGN_GATE_CAPABILITIES:
                    capabilities.add(value)
    return sorted(capabilities)


def _diff_capabilities(changed: list[str]) -> list[str]:
    """Conservatively infer capabilities from the owned post-run diff."""
    lowered = "\n".join(path.lower().replace("\\", "/") for path in changed)
    found: set[str] = set()
    if any(marker in lowered for marker in ("deploy", "helm", "k8s", "kubernetes")):
        found.add("deployment")
    if any(marker in lowered for marker in ("dockerfile", "container", "compose.y")):
        found.add("container")
    if any(marker in lowered for marker in ("/api/", "openapi", "swagger", "controller")):
        found.add("api")
    if any(marker in lowered for marker in ("migration", "/sql/", ".sql", "schema")):
        found.add("database")
    return sorted(found)


def _ordered_unique(items: list[str]) -> list[str]:
    return list(dict.fromkeys(items))


FINAL_SEQUENCE_CANONICAL_ORDER = (
    "complete-review",
    "code-freeze",
    "unit-test-full",
    "delta-review",
    "submit-reuse",
    "remote-candidate-ci",
    "archive",
)


def _sequence_slug(value: str) -> str:
    expanded = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "-", value.strip())
    return re.sub(r"[^a-z0-9]+", "-", expanded.lower()).strip("-")


def compile_final_sequence_dag(
    base_dag: dict[str, Any],
    sequence: list[Any],
) -> dict[str, Any]:
    """Compile a declared release sequence into an executable, versioned DAG."""
    raw_nodes = base_dag.get("nodes")
    raw_edges = base_dag.get("edges")
    if not isinstance(raw_nodes, list) or not isinstance(raw_edges, list):
        raise ValueError("base requiredGateDag must contain nodes and edges arrays")
    if not sequence:
        raise ValueError("finalSequence must not be empty")

    entries: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, raw in enumerate(sequence):
        if isinstance(raw, str):
            name = raw
            metadata: dict[str, Any] = {}
        elif isinstance(raw, dict):
            name = str(raw.get("id") or raw.get("name") or raw.get("step") or "")
            metadata = {
                key: value
                for key, value in raw.items()
                if key not in {"id", "name", "step", "dependsOn", "kind"}
            }
        else:
            raise ValueError(f"finalSequence[{index}] must be a string or object")
        slug = _sequence_slug(name)
        if not slug:
            raise ValueError(f"finalSequence[{index}] requires a non-empty name")
        if slug in seen:
            raise ValueError(f"duplicate finalSequence step: {slug}")
        seen.add(slug)
        entries.append({"slug": slug, "metadata": metadata})

    positions = {entry["slug"]: index for index, entry in enumerate(entries)}
    present_order = [
        name for name in FINAL_SEQUENCE_CANONICAL_ORDER if name in positions
    ]
    for left, right in zip(present_order, present_order[1:]):
        if positions[left] > positions[right]:
            raise ValueError(
                f"finalSequence must place {left} before {right}; "
                "code-freeze must precede unit-test-full"
            )
    if "archive" in positions and positions["archive"] != len(entries) - 1:
        raise ValueError("finalSequence archive step must be last")

    nodes = [dict(node) for node in raw_nodes if isinstance(node, dict)]
    edges = [dict(edge) for edge in raw_edges if isinstance(edge, dict)]
    base_ids = {
        str(node.get("id") or "")
        for node in nodes
        if str(node.get("id") or "")
    }
    depended_on = {
        str(dependency)
        for node in nodes
        for dependency in (node.get("dependsOn") or [])
        if isinstance(dependency, str)
    }
    base_terminals = sorted(base_ids - depended_on)

    sequence_ids: list[str] = []
    predecessor_ids = base_terminals
    freeze_id = "sequence:code-freeze"
    for index, entry in enumerate(entries):
        node_id = f"sequence:{entry['slug']}"
        sequence_ids.append(node_id)
        node = {
            "id": node_id,
            "kind": "sequence",
            "phase": "archive",
            "sequenceIndex": index,
            "dependsOn": list(predecessor_ids),
            "subjectBound": True,
            "invalidatedByProductChange": (
                freeze_id in sequence_ids or node_id == freeze_id
            ),
            **entry["metadata"],
        }
        nodes.append(node)
        edges.extend(
            {"from": dependency, "to": node_id}
            for dependency in predecessor_ids
        )
        predecessor_ids = [node_id]

    return {
        "schemaVersion": 2,
        "nodes": nodes,
        "edges": edges,
        "finalSequence": {
            "schemaVersion": 1,
            "nodeIds": sequence_ids,
            "freezeNodeId": (
                freeze_id if freeze_id in sequence_ids else None
            ),
            "terminalNodeId": sequence_ids[-1],
        },
    }


def _load_configured_final_sequence(
    project: Path,
    change_dir: Path,
) -> list[Any] | None:
    candidates = (
        change_dir / "meta" / "final-sequence.json",
        project / ".harness" / "config" / "final-sequence.json",
    )
    for path in candidates:
        if not path.is_file():
            continue
        raw = _read_json(path)
        if isinstance(raw, list):
            return raw
        if isinstance(raw, dict) and isinstance(raw.get("finalSequence"), list):
            return raw["finalSequence"]
        raise ValueError(f"final sequence configuration is invalid: {path}")
    return None


def _apply_required_gate_contract(
    payload: dict[str, Any],
    workflow: dict[str, Any],
    capabilities: list[str],
) -> dict[str, Any]:
    """Expand tier + capability facts into the persisted required-gate DAG."""
    result = dict(payload)
    tier = str(result["tier"])
    tier_policy = workflow["riskTiers"][tier]
    selected = sorted(set(capabilities) & set(workflow["capabilityGates"]))
    signals = list(result.get("signals") or [])
    required = list(tier_policy["requiredValidations"])
    required_stages: set[str] = set()
    for capability in selected:
        contract = workflow["capabilityGates"][capability]
        signals.extend(contract["signals"])
        required.extend(contract["requiredValidations"])
        required_stages.update(contract["requiredStages"])
    signals = sorted(set(signals))
    required = _ordered_unique(required)

    stage_decisions = _stage_decisions_for_tier(workflow, tier, signals)
    for stage_name in required_stages:
        decision = stage_decisions.setdefault(
            stage_name,
            {"required": False, "reason": "not-triggered", "matchedSignals": []},
        )
        decision["required"] = True
        if decision["reason"] == "not-triggered":
            decision["reason"] = "capability"

    validation_phases = workflow["validationPhases"]
    by_phase: dict[str, list[str]] = {}
    for verification in required:
        phase = validation_phases.get(verification)
        if isinstance(phase, str) and phase:
            by_phase.setdefault(phase, []).append(verification)

    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, str]] = []
    required_set = set(required)
    for verification in required:
        dependencies = [
            item for item in VALIDATION_DEPENDENCIES.get(verification, ())
            if item in required_set
        ]
        node_id = f"validation:{verification}"
        nodes.append({
            "id": node_id,
            "kind": "validation",
            "phase": validation_phases.get(verification),
            "dependsOn": [f"validation:{item}" for item in dependencies],
        })
        edges.extend(
            {"from": f"validation:{item}", "to": node_id}
            for item in dependencies
        )
    for stage_name, decision in sorted(stage_decisions.items()):
        if not decision.get("required"):
            continue
        if stage_name == "package":
            dependencies = [
                f"validation:{item}" for item in required
                if hp.resolve_phase_name(validation_phases.get(item)) == "execute"
            ]
        elif stage_name == "apidoc" and "apiTest" in required_set:
            dependencies = ["validation:apiTest"]
        else:
            dependencies = []
        node_id = f"stage:{stage_name}"
        nodes.append({
            "id": node_id,
            "kind": "stage",
            "phase": stage_name,
            "dependsOn": dependencies,
        })
        edges.extend({"from": item, "to": node_id} for item in dependencies)

    result["capabilities"] = selected
    result["signals"] = signals
    result["requiredValidations"] = required
    result["requiredValidationsByPhase"] = by_phase
    result["stageDecisions"] = stage_decisions
    result["requiredGateDag"] = {"schemaVersion": 1, "nodes": nodes, "edges": edges}
    return result


def classify_risk(
    change_dir: Path,
    stage: str,
    workflow: dict[str, Any] | None = None,
) -> dict[str, Any]:
    # 无风险信号时的起步档。曾经是 full，于是每个普通变更都默认背上
    # plan→execute→review→submit→archive 五阶段和 apiTest；风险信号推断只在
    # --stage post-run 下跑，而生产流程没有任何地方调用它，起步值实际就是终值。
    # standard 保留 compile/unitTest/unitTestFull 的证据闭环，只去掉默认的
    # review 阶段与 apiTest。下面的单调升级逻辑不变，有信号照样升到 full。
    tier = "standard"
    source = "default-standard"
    capabilities = _design_capabilities(change_dir)
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
    signals: list[str] = []
    if stage == "post-run":
        project = change_code_root(change_dir)
        proc = subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=all"],
            cwd=project,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        changed: list[str] = []
        for line in proc.stdout.splitlines():
            raw = line[3:].strip().strip('"').replace("\\", "/")
            if not raw:
                continue
            if " -> " in raw:
                raw = raw.rsplit(" -> ", 1)[-1].strip().strip('"')
            changed.append(raw)
        try:
            contract = hp.load_change_contract(change_dir)
        except (OSError, ValueError, json.JSONDecodeError):
            contract = {}
        ownership = contract.get("ownership") if isinstance(contract, dict) else None
        modern_scope = isinstance(ownership, dict) and bool(
            ownership.get("productPaths") or ownership.get("staticEvidencePaths")
        )
        product_paths: list[str] = []
        static_paths: list[str] = []
        excluded_paths: list[str] = []
        maintenance_paths: list[str] = []
        foreign_paths: list[str] = []

        def is_harness_maintenance(path: str) -> bool:
            normalized = path.replace("\\", "/")
            return normalized.startswith(
                (
                    ".cursor/skills/",
                    ".claude/skills/",
                    ".agents/skills/",
                    ".codebuddy/skills/",
                )
            ) or normalized in {
                ".harness/context-index.json",
                ".harness/config/build-profile.json",
            }

        for path in changed:
            if modern_scope:
                category = hl._classify_ownership_path(
                    path, change_dir.name, ownership
                )
                if category == "owned":
                    product_paths.append(path)
                elif category == "staticEvidence":
                    static_paths.append(path)
                elif category == "excludedRuntime":
                    excluded_paths.append(path)
                elif is_harness_maintenance(path):
                    maintenance_paths.append(path)
                else:
                    foreign_paths.append(path)
            elif path.startswith(".harness/") or is_harness_maintenance(path):
                maintenance_paths.append(path)
            else:
                product_paths.append(path)
        capabilities = sorted(
            set(capabilities) | set(_diff_capabilities(product_paths))
        )
        lowered = "\n".join(product_paths).lower()
        full_markers = {
            "auth": ("auth", "token", "credential", "permission"),
            "security": ("security", "secret", "crypto"),
            "migration": ("migration", "migrate", "/sql/", ".sql"),
            "concurrency": ("concurr", "lock", "lease", "transaction"),
            "artifact-protocol": ("artifact", "protocol", "manifest", "baseline"),
            "shared-state": ("shared", "state/", "workflow-policy"),
            "delete": ("delete", "purge", "archive"),
        }
        for signal, markers in full_markers.items():
            if any(marker in lowered for marker in markers):
                signals.append(signal)
        if signals:
            observed = "full"
        elif product_paths and all(
            path.lower().endswith((".md", ".txt", ".rst"))
            or path.lower().startswith("docs/")
            for path in product_paths
        ):
            observed = "fast"
            signals.append("docs-only")
        elif product_paths:
            observed = "standard"
            signals.append("production-code")
        else:
            observed = tier
            signals.append("no-code-diff")
        rank = {"fast": 0, "standard": 1, "full": 2}
        if rank[observed] > rank[tier]:
            tier = observed
        source = f"{source}+post-run"
    main_project = change_dir.parents[2]
    if workflow is None:
        workflow = _load_workflow_policy(project=main_project)
    tier_policy = workflow["riskTiers"][tier]
    unique_signals = sorted(set(signals))
    payload = {
        "ok": True,
        "code": "CLASSIFIED",
        "stage": stage,
        "tier": tier,
        "source": source,
        "changeId": change_dir.name,
        "signals": unique_signals,
        "defaultPhases": list(tier_policy["defaultPhases"]),
        "requiredValidations": list(tier_policy["requiredValidations"]),
        "conditionalStages": list(tier_policy["conditionalStages"]),
        "stageDecisions": _stage_decisions_for_tier(workflow, tier, unique_signals),
    }
    if stage == "post-run":
        payload["workspaceBreakdown"] = {
            "productPaths": sorted(set(product_paths)),
            "staticEvidencePaths": sorted(set(static_paths)),
            "excludedRuntimePaths": sorted(set(excluded_paths)),
            "harnessMaintenancePaths": sorted(set(maintenance_paths)),
            "foreignPaths": sorted(set(foreign_paths)),
        }
    if stage == "post-run":
        _write_json(change_dir / "meta" / "risk-classification.json", payload)
    result = _apply_required_gate_contract(payload, workflow, capabilities)
    configured_sequence = _load_configured_final_sequence(main_project, change_dir)
    if configured_sequence is not None:
        result["requiredGateDag"] = compile_final_sequence_dag(
            result["requiredGateDag"],
            configured_sequence,
        )
        result["finalSequence"] = result["requiredGateDag"]["finalSequence"]
    return result


def _stage_decisions_for_tier(
    workflow: dict[str, Any], tier: str, signals: list[str]
) -> dict[str, dict[str, Any]]:
    tier_policy = workflow["riskTiers"][tier]
    unique_signals = sorted(set(signals))
    stage_decisions: dict[str, dict[str, Any]] = {}
    for stage_name, stage_policy in workflow["conditionalStages"].items():
        default_required = stage_name in tier_policy["defaultPhases"]
        matched = sorted(set(unique_signals) & set(stage_policy["signals"]))
        signal_required = tier in stage_policy["tiers"] and bool(matched)
        stage_decisions[stage_name] = {
            "required": default_required or signal_required,
            "reason": (
                "tier-default" if default_required
                else "signal:" + ",".join(matched) if signal_required
                else "not-triggered"
            ),
            "matchedSignals": matched,
        }
    return stage_decisions


def apply_tier_override(
    payload: dict[str, Any],
    workflow: dict[str, Any],
    *,
    tier: str,
    override_by: str,
) -> dict[str, Any]:
    """Rebind payload to an explicit tier override (source=override)."""
    tier_policy = workflow["riskTiers"][tier]
    now = hc.now_iso()
    signals = list(payload.get("signals") or [])
    payload = dict(payload)
    payload["tier"] = tier
    payload["source"] = "override"
    payload["defaultPhases"] = list(tier_policy["defaultPhases"])
    payload["requiredValidations"] = list(tier_policy["requiredValidations"])
    payload["conditionalStages"] = list(tier_policy["conditionalStages"])
    payload["stageDecisions"] = _stage_decisions_for_tier(workflow, tier, signals)
    payload["tierOverride"] = {"tier": tier, "by": override_by, "at": now}
    result = _apply_required_gate_contract(
        payload, workflow, list(payload.get("capabilities") or [])
    )
    final_sequence = payload.get("finalSequence")
    node_ids = (
        final_sequence.get("nodeIds")
        if isinstance(final_sequence, dict)
        else None
    )
    if isinstance(node_ids, list) and node_ids:
        sequence = [
            str(node_id).removeprefix("sequence:")
            for node_id in node_ids
            if str(node_id).startswith("sequence:")
        ]
        if sequence:
            result["requiredGateDag"] = compile_final_sequence_dag(
                result["requiredGateDag"],
                sequence,
            )
            result["finalSequence"] = result["requiredGateDag"][
                "finalSequence"
            ]
    return result


def gate_policy_document(payload: dict[str, Any]) -> dict[str, Any]:
    """Cross-change contract: meta/gate-policy.json (schemaVersion=1)."""
    document = {
        "schemaVersion": 1,
        "tier": payload["tier"],
        "source": payload["source"],
        "defaultPhases": list(payload.get("defaultPhases") or []),
        "requiredValidations": list(payload.get("requiredValidations") or []),
        "requiredValidationsByPhase": dict(
            payload.get("requiredValidationsByPhase") or {}
        ),
        "capabilities": list(payload.get("capabilities") or []),
        "signals": list(payload.get("signals") or []),
        "stageDecisions": dict(payload.get("stageDecisions") or {}),
        "requiredGateDag": dict(payload.get("requiredGateDag") or {}),
        "classifiedAt": payload.get("classifiedAt") or hc.now_iso(),
        "tierOverride": payload.get("tierOverride"),
    }
    if isinstance(payload.get("finalSequence"), dict):
        document["finalSequence"] = dict(payload["finalSequence"])
    for optional in ("candidateVerification", "releasePolicy"):
        if isinstance(payload.get(optional), dict):
            document[optional] = dict(payload[optional])
    return document


def classify_defaults(
    workflow: dict[str, Any],
    *,
    change_id: str,
    stage: str,
) -> dict[str, Any]:
    # change 目录不存在时的兜底，与 classify_risk 的起步档保持一致。
    tier = "standard"
    source = "default-standard"
    tier_policy = workflow["riskTiers"][tier]
    payload = {
        "ok": True,
        "code": "CLASSIFIED",
        "stage": stage,
        "tier": tier,
        "source": source,
        "changeId": change_id,
        "signals": [],
        "defaultPhases": list(tier_policy["defaultPhases"]),
        "requiredValidations": list(tier_policy["requiredValidations"]),
        "conditionalStages": list(tier_policy["conditionalStages"]),
        "stageDecisions": _stage_decisions_for_tier(workflow, tier, []),
    }
    return _apply_required_gate_contract(payload, workflow, [])


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
    try:
        workflow = _load_workflow_policy(skills_root=skills_root)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        violations.append(
            {
                "file": "contracts/workflow-policy.json",
                "line": 0,
                "pattern": "valid workflow policy",
                "text": str(exc),
            }
        )
        workflow = {"skills": {}}
    active_profile: str | None = None
    build_marker = skills_root / ".harness-build.json"
    if build_marker.is_file():
        try:
            marker = json.loads(build_marker.read_text(encoding="utf-8"))
            active_profile = "java" if marker.get("overlay") == "java" else "general"
        except (OSError, json.JSONDecodeError):
            active_profile = None
    for skill_name, contract in sorted(workflow["skills"].items()):
        if active_profile is not None and active_profile not in contract.get(
            "profiles", ["general", "java"]
        ):
            continue
        skill_files = sorted(skills_root.rglob(f"{skill_name}/SKILL.md"))
        if not skill_files:
            violations.append(
                {
                    "file": skill_name,
                    "line": 0,
                    "pattern": "policy skill exists",
                    "text": f"missing {skill_name}/SKILL.md",
                }
            )
            continue
        required = tuple(
            marker
            for capability in contract.get("capabilities", [])
            for marker in CAPABILITY_MARKERS.get(capability, ())
        )
        for skill_file in skill_files:
            text = skill_file.read_text(encoding="utf-8", errors="replace")
            for marker in required:
                if marker not in text:
                    violations.append(
                        {
                            "file": str(skill_file.relative_to(skills_root)),
                            "line": 0,
                            "pattern": marker,
                            "text": f"missing capability command: {marker}",
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
    executor_tool: str | None = None,
    executor_agent: str | None = None,
    executor_model: str | None = None,
    code: str | None = None,
    fixback: bool = False,
) -> dict[str, Any]:
    """Skill-facing phase lifecycle append (begin/close use this directly).

    HH-WF-20260730-001: shares harness_events' write-path auto-seal helpers
    so a ``phase.start`` here gets the same guarantee as the CLI's
    ``append_events.py append`` — a still-open prior attempt for the same
    phase is auto-sealed (``phase.auto_sealed``) before the new start is
    appended, atomically under the same lock.
    """
    events_file = he.events_path(change_dir)
    lock_path = events_file.with_name(events_file.name + ".lock")
    auto_sealed: list[dict[str, Any]] = []
    with he.event_file_lock(lock_path):
        existing = he.load_events(events_file)
        phase_attempts = he.split_phase_attempts(
            [event for event in existing if event.get("phase") == phase]
        )
        latest_attempt = max(
            (
                int(item.get("attempt"))
                for item in phase_attempts
                if isinstance(item.get("attempt"), int)
            ),
            default=0,
        )
        event_attempt = latest_attempt + 1 if type_ == "phase.start" else latest_attempt or 1
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
            code=code,
            severity=None,
            message=None,
            decision=None,
            reason=None,
            run_id=run_id,
            attempt=event_attempt,
            executor_tool=executor_tool,
            executor_agent=executor_agent,
            executor_model=executor_model,
            handoff_from_tool=None,
            handoff_reason=None,
            execution_mode=None,
            decision_reason_code=None,
            fallback_reason_code=None,
            # 显式信号优先。以前只嗅探 note 文本，而真正的 fixback 启动路径
            # （harness_fixback._default_gate_begin）写的 note 是
            # "开始处理评审中确认需要修改的代码问题。"，一个 "fixback" 字都没有
            # ——于是 fixback 的 run 事件从来没被打上 trigger/from_phase。
            # note 嗅探保留为兼容回退：手工传 --note 带 fixback 的老用法仍然有效。
            trigger=("fixback" if fixback or "fixback" in note.lower() else None),
            from_phase=(
                "review"
                if phase == "execute" and (fixback or "fixback" in note.lower())
                else None
            ),
            result_status=None,
        )
        event = he.build_event(args, existing)
        if identity:
            for key, value in identity.items():
                if key not in event and value is not None:
                    event[key] = value
        if type_ == "phase.start":
            open_attempts = he.open_attempts_for_phase(existing, phase)
            if open_attempts:
                inferred_reason = he.infer_auto_seal_reason(
                    open_attempts[-1].get("events") or []
                )
                auto_sealed = he.seal_open_phase_attempts(
                    existing, phase=phase, seal_reason=inferred_reason
                )
        for seal_event in auto_sealed:
            he.atomic_append_line(
                events_file,
                json.dumps(seal_event, ensure_ascii=False, separators=(",", ":")),
            )
        line = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
        he.atomic_append_line(events_file, line)
    rendered = False
    log_path = None
    if (type_ == "phase.end" or auto_sealed) and \
            he.execution_log_render_enabled(change_dir):
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
        "autoSealed": auto_sealed,
    }


def record_blocked_attempt(
    change_dir: Path,
    *,
    phase: str,
    code: str,
    message: str,
    run_id: str | None = None,
) -> dict[str, Any]:
    """Persist a rejected begin as a complete, zero-work attempt."""
    blocked_run_id = run_id or "blocked-" + uuid.uuid4().hex[:12]
    append_phase_event(
        change_dir,
        phase=phase,
        type_="phase.start",
        note=f"begin rejected: {code}",
        run_id=blocked_run_id,
    )
    return append_phase_event(
        change_dir,
        phase=phase,
        type_="phase.end",
        status="BLOCKED",
        note=message,
        run_id=blocked_run_id,
        code=code,
    )


def record_gate_blocked(
    change_dir: Path,
    *,
    phase: str,
    code: str,
    message: str,
    run_id: str | None = None,
) -> dict[str, Any]:
    """Persist a recoverable gate rejection without manufacturing a phase run."""
    return append_phase_event(
        change_dir,
        phase=phase,
        type_="gate.blocked",
        status="BLOCKED",
        note=message,
        run_id=run_id or "blocked-" + uuid.uuid4().hex[:12],
        code=code,
    )


def record_gate_recovered(
    change_dir: Path,
    *,
    phase: str,
    run_id: str,
) -> dict[str, Any]:
    """Close the latest unresolved gate.blocked record for this phase."""
    blocked: dict[str, Any] | None = None
    for event in reversed(he.load_events(he.events_path(change_dir))):
        if event.get("phase") != phase:
            continue
        if event.get("type") == "gate.recovered":
            break
        if event.get("type") == "gate.blocked":
            blocked = event
            break
    if blocked is None:
        return {"ok": True, "skipped": True, "reason": "no-unresolved-block"}
    return append_phase_event(
        change_dir,
        phase=phase,
        type_="gate.recovered",
        status="OK",
        note="阶段交接已恢复，门禁现已成功启动。",
        run_id=run_id,
        code=str(blocked.get("code") or "GATE_BLOCKED"),
    )


def validate_context_for_gate_begin(
    project: Path,
    change_id: str,
    phase: str,
) -> dict[str, Any]:
    """Require a completed Context handoff whenever modern Context state exists."""
    view = hctx.context_view(project, change_id)
    if not isinstance(view, dict) or not view.get("ok"):
        return {"ok": True, "code": "CONTEXT_LEGACY_COMPATIBLE"}
    current = view.get("current")
    transitions = view.get("transitions")
    begins = (view.get("attemptHistory") or {}).get("begins")
    if not isinstance(current, dict):
        return {"ok": True, "code": "CONTEXT_LEGACY_COMPATIBLE"}
    current_phase = str(current.get("phase") or view.get("currentPhase") or "")
    if hp.resolve_phase_name(current_phase) != phase:
        candidates = hctx.allowed_next_phases(project, change_id, current_phase)
        return {
            "ok": False,
            "code": "CONTEXT_HANDOFF_REQUIRED",
            "message": "阶段交接尚未完成，门禁未启动；请先完成上下文交接。",
            "expectedPhase": current_phase or None,
            "requestedPhase": phase,
            "recoveryAction": (
                f"当前上下文停留在 {current_phase} 阶段。一条命令补齐交接"
                "（自动补租约→写收据→begin 确认，无需 change claim/release）："
                f"harness_context.py handoff --project . --change {change_id} "
                f"--to-phase {phase} --executor <tool> --json"
                + (f"（计划后继阶段：{'/'.join(candidates)}）" if candidates else "")
            ),
        }
    if isinstance(transitions, list) and transitions:
        latest = transitions[-1] if isinstance(transitions[-1], dict) else {}
        receipt_hash = latest.get("receiptHash")
        begin_items = begins if isinstance(begins, list) else []
        acknowledged = any(
            isinstance(item, dict)
            and hp.resolve_phase_name(item.get("phase")) == phase
            and item.get("receiptHash") == receipt_hash
            for item in begin_items
        )
        if hp.resolve_phase_name(latest.get("toPhase")) != phase or not acknowledged:
            return {
                "ok": False,
                "code": "CONTEXT_BEGIN_REQUIRED",
                "message": "阶段交接收据尚未确认，门禁未启动；请先执行上下文 begin。",
                "requestedPhase": phase,
                "recoveryAction": (
                    "交接收据已写入但缺 begin 确认。一条命令补齐："
                    f"harness_context.py handoff --project . --change {change_id} "
                    f"--to-phase {phase} --executor <tool> --json"
                    "（检测到收据已存在时只补 begin 确认，不写重复 receipt）"
                ),
            }
    return {"ok": True, "code": "CONTEXT_READY"}


def _phase_event_exists(change_dir: Path, phase: str, type_: str, run_id: str) -> bool:
    return any(
        hp.resolve_phase_name(event.get("phase")) == phase
        and event.get("type") == type_
        and event.get("run_id") == run_id
        for event in he.load_events(he.events_path(change_dir))
    )


def _latest_phase_end(
    change_dir: Path,
    phase: str,
    run_id: str | None = None,
) -> dict[str, Any] | None:
    for event in reversed(he.load_events(he.events_path(change_dir))):
        if (
            hp.resolve_phase_name(event.get("phase")) != phase
            or event.get("type") != "phase.end"
        ):
            continue
        if run_id and event.get("run_id") != run_id:
            continue
        return event
    return None


def _latest_open_run_id(change_dir: Path, phase: str) -> str | None:
    """Return the newest ``phase.start`` run_id that has no matching ``phase.end``.

    A long phase can outlive its lease TTL; close then reports ``LEASE_ABSENT``
    with no way back.  Resuming needs the *original* run_id, so surface it here
    instead of making the caller reconstruct it from ``events.ndjson``.
    """
    started: list[str] = []
    ended: set[str] = set()
    for event in he.load_events(he.events_path(change_dir)):
        if hp.resolve_phase_name(event.get("phase")) != phase:
            continue
        run_id = str(event.get("run_id") or "")
        if not run_id:
            continue
        if event.get("type") == "phase.start":
            started.append(run_id)
        elif event.get("type") == "phase.end":
            ended.add(run_id)
    for run_id in reversed(started):
        if run_id not in ended:
            return run_id
    return None


def _terminal_matches_context_session(
    project: Path,
    change_id: str,
    phase: str,
    terminal: dict[str, Any],
) -> bool:
    view = hctx.context_view(project, change_id)
    current = view.get("current") if isinstance(view, dict) else None
    if not isinstance(current, dict) or current.get("phase") != phase:
        return False
    prepared_at = he.parse_timestamp(current.get("preparedAt"))
    terminal_at = he.parse_timestamp(
        terminal.get("timestamp") or terminal.get("occurred_at")
    )
    return (
        prepared_at is not None
        and terminal_at is not None
        and terminal_at >= prepared_at
    )


def _repair_handoff_missing_lease(
    project: Path,
    change_id: str,
    args: argparse.Namespace,
    *,
    status: str,
    handoff: dict[str, Any],
) -> dict[str, Any] | None:
    """S-1：交接因 context 租约缺失失败时自愈一次。

    阶段租约仍持有但 context 租约已被消费/缺失时，close_transition 只能报
    CONTEXT_LEASE_REQUIRED——原样重跑永远撞同一错误（2026-08-31 submit 实测，
    recoveryAction 声称“会重试”但重试无自愈能力）。这里补齐缺口：
    prepare_context 幂等重建本阶段 context 租约后重试一次交接，与
    `harness_context.py handoff` 命令同源（同 prepare→close 顺序）。
    """
    if handoff.get("code") != "CONTEXT_LEASE_REQUIRED":
        return None
    executor = getattr(args, "executor", None)
    if not executor:
        view = hctx.context_view(project, change_id)
        current = view.get("current") if isinstance(view, dict) else None
        executor = (
            str(current.get("executor"))
            if isinstance(current, dict) and current.get("executor")
            else None
        )
    if not executor:
        return None
    try:
        prepared = hctx.prepare_context(
            project,
            change=change_id,
            phase=args.phase,
            executor=executor,
        )
    except Exception:
        return None
    if not prepared.get("ok"):
        return None
    repaired = _close_context_handoff(project, change_id, args, status=status)
    if isinstance(repaired, dict):
        repaired = {**repaired, "leaseRepaired": True}
    return repaired


def _close_context_handoff(
    project: Path,
    change_id: str,
    args: argparse.Namespace,
    *,
    status: str,
) -> dict[str, Any] | None:
    to_phase = getattr(args, "to_phase", None)
    if not to_phase:
        return None
    # 写边界归一：旧名（--to-phase test）落 canonical；未知名交给
    # close_transition 的 PHASE_UNKNOWN 报错，不在此吞掉。
    to_phase = hp.resolve_phase_name(to_phase) or str(to_phase)
    try:
        return hctx.close_transition(
            project,
            change_id,
            from_phase=args.phase,
            to_phase=to_phase,
            executor=getattr(args, "executor", None),
            artifacts=list(getattr(args, "artifact", None) or []),
            status=status,
        )
    except Exception as exc:  # noqa: BLE001 — phase close remains locally durable
        return {
            "ok": False,
            "code": "CONTEXT_HANDOFF_FAILED",
            "message": str(exc),
        }


def _scenario_owner_phase_rank(owner_phase: str | None) -> int | None:
    """Rank a scenario ownerPhase against the lifecycle order, None when unknown."""
    if not owner_phase:
        return None
    normalized = str(owner_phase).strip().lower()
    # 旧 manifest 的 ownerPhase=run/test 经别名表归一到 execute 后再定秩。
    resolved = hp.resolve_phase_name(normalized)
    if resolved is not None:
        normalized = resolved
    if normalized not in hpf.VALID_OWNER_PHASES:
        return None
    try:
        return SCENARIO_OWNER_PHASE_ORDER.index(normalized)
    except ValueError:
        return None


def _partition_scenarios_by_owner_phase(
    scenarios: list[Any],
    required_ids: set[str],
    phase: str | None,
) -> tuple[set[str], list[str]]:
    """Split required scenarios into (due now, deferred to a later phase).

    A scenario is deferred only when it declares an `ownerPhase` that ranks
    strictly after the phase being closed. Scenarios without a usable
    `ownerPhase` (legacy/v1 manifests) stay due, preserving old behaviour.
    """
    closing_rank = _scenario_owner_phase_rank(phase)
    if closing_rank is None:
        return set(required_ids), []
    due: set[str] = set()
    deferred: set[str] = set()
    for scenario in scenarios:
        if not isinstance(scenario, dict):
            continue
        scenario_id = str(scenario.get("id") or "").strip()
        if scenario_id not in required_ids:
            continue
        owner_rank = _scenario_owner_phase_rank(scenario.get("ownerPhase"))
        if owner_rank is not None and owner_rank > closing_rank:
            deferred.add(scenario_id)
        else:
            due.add(scenario_id)
    # IDs present in required_ids but absent from the scan stay due (defensive).
    due |= required_ids - due - deferred
    # A duplicated ID declaring two ownerPhases must fail closed: if any
    # occurrence is due now, the scenario is due now.
    deferred -= due
    return due, sorted(deferred)


def _deferred_hint(deferred_ids: list[str], phase: str | None) -> str:
    """Append a note so callers never mistake a deferred scenario for a blocker."""
    if not deferred_ids:
        return ""
    return (
        f"（另有 {len(deferred_ids)} 个场景按 ownerPhase 移交后续阶段，"
        f"未计入 {phase or '本'} 阶段要求: " + ", ".join(deferred_ids) + "）"
    )


_PROJECT_ROOT_HELP = (
    "project root PATH (defaults to resolving from CWD). Takes a path, not a project name."
)


def _resolve_project(args: argparse.Namespace) -> Path:
    """--project 优先，未给时按 CWD 解析主项目根。

    其他 harness 脚本都把 --project 当项目根且列为必填，只有 gate 例外——调用方
    按惯例传过来会被 argparse 拒掉。注意 begin/close 的 --project 是另一层语义
    （本阶段执行根/worktree），本函数只服务 classify/checkpoint。
    """
    raw = getattr(args, "project", None)
    if raw:
        return Path(raw).expanduser().resolve()
    return hc.resolve_main_project_root()


def _validate_scenario_coverage(
    change_dir: Path, phase: str | None = None
) -> dict[str, Any]:
    """C9: validate all ledger-required scenarios are covered by ledger entries.

    Reads meta/scenario-manifest.json and evidence/verification-ledger.json.
    Returns ok=True when a legacy manifest is missing or all required scenarios
    are covered. A present but empty manifest is always invalid.

    Phase scoping: when `phase` is given, only scenarios whose `ownerPhase`
    is due by that phase are required to carry passing receipts. Scenarios
    owned by a later phase (e.g. `ownerPhase=test` at `run` close) are
    reported under `deferred` instead of blocking the close — this matches the
    documented hand-off rule in harness-execute/SKILL.md ("ownerPhase=test 按计划移交").
    """
    manifest_path = change_dir / "meta" / "scenario-manifest.json"
    if not manifest_path.is_file():
        return {"ok": True, "code": "MANIFEST_MISSING", "skipped": True}
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        return {
            "ok": False,
            "code": "SCENARIO_MANIFEST_INVALID",
            "message": f"scenario-manifest.json unreadable: {exc}",
        }
    unpacked = hpf.unpack_v2_scenario_manifest(manifest)
    if unpacked is not None:
        if not unpacked.get("ok"):
            return unpacked
        # 解包成 legacy 形状后，下面的判定逻辑对 v2 与 legacy 完全一致。
        manifest = unpacked["manifest"]
    scenarios = manifest.get("scenarios") if isinstance(manifest, dict) else None
    if not isinstance(scenarios, list):
        return {
            "ok": False,
            "code": "SCENARIO_MANIFEST_INVALID",
            "message": "scenario-manifest.json scenarios must be a list",
        }
    if not scenarios:
        return {
            "ok": False,
            "code": "SCENARIO_MANIFEST_EMPTY",
            "message": "scenario-manifest.json must contain at least one scenario",
        }
    invalid_items = [
        index
        for index, scenario in enumerate(scenarios)
        if not isinstance(scenario, dict) or not str(scenario.get("id") or "").strip()
    ]
    if invalid_items:
        return {
            "ok": False,
            "code": "SCENARIO_MANIFEST_INVALID",
            "message": f"scenario entries missing IDs at indexes: {invalid_items}",
        }
    required_ids = {
        str(s.get("id"))
        for s in scenarios
        if isinstance(s, dict)
        and (
            str(s.get("priority", "")).upper() in {"P0", "P1"}
            or s.get("requiredEvidenceKind") == "ledger"
        )
    }
    if not required_ids:
        return {"ok": True, "code": "NO_LEDGER_REQUIRED_SCENARIOS"}
    due_ids, deferred_ids = _partition_scenarios_by_owner_phase(
        scenarios, required_ids, phase
    )
    raw_schema_version = (
        manifest.get("schemaVersion") if isinstance(manifest, dict) else None
    )
    if (
        not isinstance(raw_schema_version, int)
        or isinstance(raw_schema_version, bool)
        or raw_schema_version < 1
    ):
        return {
            "ok": False,
            "code": "SCENARIO_MANIFEST_INVALID",
            "message": "scenario-manifest.json schemaVersion must be a positive integer",
        }
    schema_version = raw_schema_version
    if schema_version >= 2:
        missing_mappings = sorted(
            str(s.get("id"))
            for s in scenarios
            if isinstance(s, dict)
            and str(s.get("id")) in required_ids
            and any(
                not str(s.get(field) or "").strip()
                for field in ("executableTestId", "testFile", "testTitle")
            )
        )
        if missing_mappings:
            return {
                "ok": False,
                "code": "SCENARIO_MANIFEST_INVALID",
                "message": "required scenarios are missing executable test identities",
                "missingMappings": missing_mappings,
            }

    if not due_ids:
        # Every required scenario is owned by a later phase — nothing is due
        # at this close. Report the hand-off instead of blocking.
        return {
            "ok": True,
            "code": "SCENARIO_COVERAGE_DEFERRED",
            "covered": [],
            "deferred": deferred_ids,
            "ownerPhaseScope": phase,
            "schemaVersion": schema_version,
        }

    try:
        ledger, ledger_path = hl.load_ledger(change_dir)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {
            "ok": False,
            "code": "SCENARIO_COVERAGE_FAILED",
            "message": f"ledger unreadable: {exc}",
            "missing": sorted(due_ids),
            "deferred": deferred_ids,
        }
    if ledger is None or ledger_path is None:
        return {
            "ok": False,
            "code": "SCENARIO_COVERAGE_FAILED",
            "message": "ledger missing; cannot verify required scenario coverage",
            "missing": sorted(due_ids),
            "deferred": deferred_ids,
        }
    if schema_version >= 2:
        coverage_sets: dict[str, set[str]] = {
            key: set()
            for key in (
                "declared",
                "selected",
                "collected",
                "executed",
                "passed",
                "skipped",
                "failed",
            )
        }
        bound: set[str] = set()
        attempts: dict[str, set[int]] = {}
        invalid_receipts: list[dict[str, str]] = []
        validations = ledger.get("validations") or {}
        if isinstance(validations, dict):
            for verification, entry in validations.items():
                if not isinstance(entry, dict):
                    continue
                ids = entry.get("scenarioIds")
                if not isinstance(ids, list):
                    continue
                entry_ids = sorted(
                    {
                        str(item).strip()
                        for item in ids
                        if str(item).strip() in required_ids
                    }
                )
                if not entry_ids:
                    continue
                bound.update(entry_ids)
                receipt = entry.get("scenarioReceipt")
                if not isinstance(receipt, dict):
                    invalid_receipts.append(
                        {
                            "verification": str(verification),
                            "code": "SCENARIO_RECEIPT_REQUIRED",
                        }
                    )
                    continue
                result = hl.validate_scenario_execution_receipt(
                    change_dir=change_dir,
                    scenario_ids=entry_ids,
                    receipt=receipt,
                )
                if not result.get("ok"):
                    invalid_receipts.append(
                        {
                            "verification": str(verification),
                            "code": str(
                                result.get("code") or "SCENARIO_RECEIPT_INVALID"
                            ),
                        }
                    )
                    continue
                receipt_coverage = result["coverage"]
                for key in coverage_sets:
                    if (
                        key == "passed"
                        and str(entry.get("status") or "").upper() != "OK"
                    ):
                        continue
                    values = receipt_coverage.get(key)
                    if isinstance(values, list):
                        coverage_sets[key].update(
                            str(item) for item in values if str(item) in required_ids
                        )
                receipt_attempt = result["receipt"].get("attempt")
                if isinstance(receipt_attempt, int):
                    for scenario_id in receipt_coverage.get("executed") or []:
                        attempts.setdefault(str(scenario_id), set()).add(
                            receipt_attempt
                        )

        passed = coverage_sets["passed"]
        missing = sorted(due_ids - bound)
        unexecuted = sorted(due_ids - passed)
        detail = {
            key: sorted(values & required_ids)
            for key, values in coverage_sets.items()
        }
        detail.update(
            {
                "missing": missing,
                "unexecuted": unexecuted,
                "deferred": deferred_ids,
                "ownerPhaseScope": phase,
                "attempts": {
                    scenario_id: sorted(values)
                    for scenario_id, values in sorted(attempts.items())
                },
                "invalidReceipts": invalid_receipts,
                "schemaVersion": schema_version,
            }
        )
        if unexecuted:
            return {
                "ok": False,
                "code": "REQUIRED_SCENARIO_NOT_EXECUTED",
                "message": (
                    "required scenarios without exact passed execution receipts: "
                    + ", ".join(unexecuted)
                    + _deferred_hint(deferred_ids, phase)
                ),
                **detail,
            }
        return {
            "ok": True,
            "code": "SCENARIO_COVERAGE_OK",
            "covered": sorted(passed),
            **detail,
        }

    covered: set[str] = set()
    validations = ledger.get("validations") or {}
    if isinstance(validations, dict):
        for entry in validations.values():
            if isinstance(entry, dict):
                ids = entry.get("scenarioIds")
                if isinstance(ids, list):
                    covered.update(str(i) for i in ids)
    missing = sorted(due_ids - covered)
    if missing:
        return {
            "ok": False,
            "code": "SCENARIO_COVERAGE_FAILED",
            "message": (
                "ledger-required scenarios without ledger entry: "
                + ", ".join(missing)
                + _deferred_hint(deferred_ids, phase)
            ),
            "missing": missing,
            "deferred": deferred_ids,
            "ownerPhaseScope": phase,
        }
    return {
        "ok": True,
        "code": "SCENARIO_COVERAGE_OK",
        "covered": sorted(covered & required_ids),
        "deferred": deferred_ids,
        "ownerPhaseScope": phase,
    }


def validate_plan_handoff(change_dir: Path) -> dict[str, Any]:
    """Verify a finalized modern plan before the first run-side effect."""
    receipt_path = change_dir / "meta" / "plan-finalization.json"
    plans_root = change_dir / "plans"
    has_plan_artifacts = plans_root.is_dir() and any(
        plans_root.glob("*-plan.md")
    )
    if not receipt_path.is_file() and not has_plan_artifacts:
        return {
            "ok": True,
            "code": "PLAN_HANDOFF_NOT_APPLICABLE",
            "skipped": True,
        }
    return hpf.verify_plan(change_dir)


def validate_review_outputs_for_close(
    change_dir: Path,
    run_id: str,
) -> dict[str, Any]:
    """Require complete, run-bound structured Review sidecars before close."""

    findings_path = hr.findings_path(change_dir)
    dispositions_path = hr.dispositions_path(change_dir)
    missing = [
        str(path)
        for path in (findings_path, dispositions_path)
        if not path.is_file()
    ]
    if missing:
        return {
            "ok": False,
            "code": "REVIEW_OUTPUTS_INCOMPLETE",
            "message": "评审的结构化发现或处置记录缺失，尚不能结束评审阶段。",
            "missing": missing,
            "recoveryAction": (
                "用骨架生成器补写：harness_review.py scaffold --change-dir <change-dir>"
                "（无 findings 时先生成发现骨架→write-findings 落地→重跑 scaffold "
                "生成处置骨架→write-dispositions 落地），再重试关门"
            ),
        }
    try:
        findings = json.loads(findings_path.read_text(encoding="utf-8-sig"))
        dispositions = json.loads(
            dispositions_path.read_text(encoding="utf-8-sig")
        )
    except (OSError, json.JSONDecodeError) as exc:
        return {
            "ok": False,
            "code": "REVIEW_OUTPUTS_INVALID",
            "message": f"评审结构化记录无法读取：{exc}",
        }
    finding_problems = hr.validate_findings(findings, require_ids=True)
    known_ids = {
        str(item.get("id"))
        for item in findings.get("findings", [])
        if isinstance(item, dict) and item.get("id")
    }
    disposition_problems = hr.validate_dispositions(dispositions, known_ids)
    disposition_ids = {
        str(item.get("findingId"))
        for item in dispositions.get("dispositions", [])
        if isinstance(item, dict) and item.get("findingId")
    }
    problems = [*finding_problems, *disposition_problems]
    if findings.get("runId") != run_id or dispositions.get("runId") != run_id:
        problems.append("review sidecars must match the active review runId")
    missing_dispositions = sorted(known_ids - disposition_ids)
    if missing_dispositions:
        problems.append(
            "findings without dispositions: " + ",".join(missing_dispositions)
        )
    if problems:
        return {
            "ok": False,
            "code": "REVIEW_OUTPUTS_INVALID",
            "message": "评审结构化记录不完整或与当前轮次不一致。",
            "problems": problems,
        }
    return {
        "ok": True,
        "code": "REVIEW_OUTPUTS_READY",
        "findingCount": len(known_ids),
    }


def _normalize_gate_phase(args: argparse.Namespace, as_json: bool) -> int | None:
    """cmd_begin/cmd_close 入口归一：旧名（run/test）映射到现阶段名。

    归一后 args.phase 全链路只流动 canonical 名；未知名报错并列出合法名与别名。
    """
    resolved = hp.resolve_phase_name(getattr(args, "phase", None))
    if resolved is not None:
        args.phase = resolved
        return None
    return emit_error(
        "PHASE_UNKNOWN",
        f"未知阶段名 {getattr(args, 'phase', None)!r}；合法阶段 "
        f"{list(hp.WORKFLOW_PHASES)}，旧名别名 {hp.LEGACY_PHASE_ALIASES}。",
        as_json=as_json,
        extra={
            "allowedPhases": list(hp.WORKFLOW_PHASES),
            "legacyAliases": dict(hp.LEGACY_PHASE_ALIASES),
        },
    )


def _verification_target_coverage_warning(
    change_dir: Path, phase: str
) -> dict[str, Any] | None:
    """E-5：场景表引用未声明的 verification target 时提前 WARN。

    场景带 execution_level（unit/integration/…），但 build-profile 的
    verificationGraph.targets 未声明对应 target 时，问题要等到 ledger record
    才以 unsupported verification 报错——太迟。gate begin 提前列出待补清单。
    映射约定：unit → unitTest；其他 level → 任一以其名开头的 target。
    """
    if phase != "execute":
        return None
    manifest_path = change_dir / "meta" / "scenario-manifest.json"
    profile_path = change_dir / "meta" / "build-profile.json"
    if not profile_path.is_file():
        # build-profile 常规位置在项目 .harness/config/；change meta 下优先
        profile_path = change_dir.parents[2] / ".harness" / "config" / "build-profile.json"
    if not manifest_path.is_file() or not profile_path.is_file():
        return None
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
        profile = json.loads(profile_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return None
    content = manifest.get("content") if isinstance(manifest, dict) else None
    scenarios = content.get("scenarios") if isinstance(content, dict) else None
    if not isinstance(scenarios, list):
        return None
    levels = sorted({
        str(s.get("execution_level")).strip()
        for s in scenarios
        if isinstance(s, dict) and str(s.get("execution_level") or "").strip()
    })
    graph = profile.get("verificationGraph")
    targets = graph.get("targets") if isinstance(graph, dict) else None
    target_names = set(targets.keys()) if isinstance(targets, dict) else set()
    uncovered = [
        level for level in levels
        if level != "unit"
        and not any(name.lower().startswith(level.lower()) for name in target_names)
    ]
    # unit 场景由 unitTest 覆盖；只在完全没有 unitTest 时才算缺口
    if "unit" in levels and "unitTest" not in target_names:
        uncovered.append("unit(→unitTest)")
    if not uncovered:
        return None
    return {
        "code": "VERIFICATION_TARGETS_UNDECLARED",
        "message": (
            "场景表涉及未声明的验证级别: " + ", ".join(uncovered) +
            "；ledger record 将报 unsupported verification。请在 "
            ".harness/config/build-profile.json 的 verificationGraph.targets "
            "声明对应 target（如 integrationTest）"
        ),
        "uncoveredLevels": uncovered,
    }


def cmd_begin(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    normalized = _normalize_gate_phase(args, as_json)
    if normalized is not None:
        return normalized
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
    context_check = validate_context_for_gate_begin(
        project, str(resolved["changeId"]), args.phase
    )
    if not context_check.get("ok"):
        code = str(context_check.get("code") or "CONTEXT_HANDOFF_REQUIRED")
        message = str(
            context_check.get("message")
            or "阶段交接尚未完成，门禁未启动。"
        )
        record_gate_blocked(
            change_dir,
            phase=args.phase,
            code=code,
            message=message,
            run_id=args.run_id or os.environ.get("HUNTER_HARNESS_RUN_ID"),
        )
        return emit_error(
            code,
            message,
            as_json=as_json,
            extra={
                key: value
                for key, value in context_check.items()
                if key not in {"ok", "code", "message"}
            },
        )
    severity_mode = gate_severity_mode(project, change_dir)
    gate_warnings: list[dict[str, Any]] = []
    plan_verification: dict[str, Any] | None = None
    if phase_gate_rule(args.phase, "plan_handoff"):
        plan_verification = validate_plan_handoff(change_dir)
        if not plan_verification.get("ok"):
            code = str(
                plan_verification.get("code") or "PLAN_HANDOFF_INVALID"
            )
            message = str(
                plan_verification.get("error")
                or plan_verification.get("message")
                or "finalized plan verification failed"
            )
            if gate_soft_allowed(severity_mode, args.phase, "plan-handoff"):
                gate_warnings.append(record_gate_warning(
                    change_dir,
                    phase=args.phase,
                    site="plan-handoff",
                    code=code,
                    message=message,
                ))
            else:
                return emit_error(
                    code,
                    message,
                    as_json=as_json,
                    extra={
                        key: value
                        for key, value in plan_verification.items()
                        if key not in {"ok", "code", "error", "message"}
                    },
                )
    concurrency_block = hc.check_concurrency_block(project, resolved["changeId"])
    if concurrency_block is not None:
        record_blocked_attempt(
            change_dir,
            phase=args.phase,
            code=str(concurrency_block.get("code", "CONCURRENCY_BLOCKED")),
            message=str(
                concurrency_block.get("message", "concurrency mode blocked begin")
            ),
            run_id=args.run_id or os.environ.get("HUNTER_HARNESS_RUN_ID"),
        )
        return emit_error(
            str(concurrency_block.get("code", "CONCURRENCY_BLOCKED")),
            str(concurrency_block.get("message", "concurrency mode blocked begin")),
            as_json=as_json,
            extra={k: v for k, v in concurrency_block.items() if k not in {"ok", "message"}},
        )
    blocked = foundation_gate_blocks(getattr(args, "task", None), change_dir)
    if blocked:
        return emit_error(
            blocked["code"],
            blocked["message"],
            as_json=as_json,
            extra={k: v for k, v in blocked.items() if k not in {"ok", "message", "code"}},
        )

    try:
        policy = _load_workflow_policy(project=project)
        policy = effective_workflow_policy(policy, change_dir)
    except (OSError, ValueError, hwp.PolicyValidationError) as exc:
        return emit_error("POLICY_LOAD_FAILED", str(exc), as_json=as_json)

    executor_tool = args.executor_tool or os.environ.get("HUNTER_HARNESS_TOOL")
    skills_root = resolve_skills_root(args.skills_root)
    if skills_root is None:
        return emit_error(
            "BUNDLE_IDENTITY_REQUIRED",
            "--skills-root is required; refresh the selected Harness adapter if identity is missing",
            as_json=as_json,
        )
    try:
        identity = validate_identity(project, skills_root, executor_tool)
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        return emit_error("BUNDLE_IDENTITY_INVALID", str(exc), as_json=as_json)
    executor_tool = executor_tool or str(identity.get("adapter") or "") or None
    projection = evaluate_projection_gate(project, args.phase)
    if not projection.get("ok"):
        return emit_error(
            str(projection.get("code") or "PROJECTION_BLOCKED"),
            str(projection.get("message") or "projection gate blocked phase"),
            as_json=as_json,
            extra={
                key: value
                for key, value in projection.items()
                if key not in {"ok", "code", "message"}
            },
        )
    explicit_run_id = args.run_id or os.environ.get("HUNTER_HARNESS_RUN_ID")
    current_lease = hc.inspect_lease(project, resolved["changeId"])
    run_id = explicit_run_id or (
        str(current_lease.get("runId"))
        if isinstance(current_lease, dict) and (
            hp.resolve_phase_name(current_lease.get("phase")) == args.phase
        )
        else "run-" + uuid.uuid4().hex
    )
    try:
        capsule = load_phase_capsule(change_dir, args.phase, run_id)
    except ValueError as exc:
        return emit_error("PHASE_CAPSULE_INVALID", str(exc), as_json=as_json)
    execution_hint = resolve_begin_execution_hint(
        project,
        requested=args.project,
        capsule=capsule,
    )
    try:
        execution_root = resolve_execution_root(
            project,
            execution_hint["executionRoot"],
        )
    except ValueError as exc:
        return emit_error("EXECUTION_ROOT_INVALID", str(exc), as_json=as_json)
    if capsule is not None:
        try:
            validate_phase_capsule(
                capsule,
                change_dir=change_dir,
                change_id=str(resolved["changeId"]),
                phase=args.phase,
                run_id=run_id,
                project=project,
                execution_root=execution_root,
                skills_root=skills_root,
            )
        except ValueError as exc:
            if gate_soft_allowed(severity_mode, args.phase, "capsule"):
                gate_warnings.append(record_gate_warning(
                    change_dir,
                    phase=args.phase,
                    site="capsule",
                    code="PHASE_CAPSULE_MISMATCH",
                    message=str(exc),
                ))
                # Stale capsule is regenerable state: rebuild it below.
                capsule = None
            else:
                return emit_error("PHASE_CAPSULE_MISMATCH", str(exc), as_json=as_json)
    claim = hc.claim_lease(
        project,
        change_id=resolved["changeId"],
        phase=args.phase,
        run_id=run_id,
        ttl_seconds=int(args.ttl_seconds),
    )
    if not claim.get("ok"):
        claim_code = str(claim.get("code", "LEASE_CONFLICT"))
        claim_extra = {
            k: v for k, v in claim.items() if k not in {"ok", "message", "code"}
        }
        holder = claim.get("holder")
        if claim_code == "LEASE_CONFLICT" and isinstance(holder, dict):
            holder_phase = str(holder.get("phase") or "")
            holder_run_id = str(holder.get("runId") or "")
            # A lease whose own phase already recorded phase.end is leftover state:
            # only close releases the lease, so any begin-without-close strands it
            # for the full TTL and blocks the next phase.
            holder_closed = (
                bool(holder_phase)
                and bool(holder_run_id)
                and _latest_phase_end(change_dir, holder_phase, holder_run_id) is not None
            )
            claim_extra["holderPhaseClosed"] = holder_closed
            if holder_closed:
                claim_extra["recoveryAction"] = (
                    f"持有租约的 {holder_phase} 阶段（run-id {holder_run_id}）已写入 phase.end，"
                    "这是残留租约，释放后重试 begin 是安全的："
                    "python <skills-root>/scripts/harness_change.py release "
                    f"--change {resolved['changeId']} --phase {holder_phase} "
                    f"--run-id {holder_run_id} --json"
                )
            else:
                claim_extra["recoveryAction"] = (
                    f"{holder_phase or '另一个'} 阶段（run-id {holder_run_id or '未知'}）"
                    "仍在进行中且尚未写入 phase.end。先让该阶段正常关门；"
                    "确认其执行进程已不存在时才可释放租约，不要直接 --steal。"
                )
        return emit_error(
            claim_code,
            str(claim.get("message", "lease claim failed")),
            as_json=as_json,
            extra=claim_extra,
        )

    guard_result: dict[str, Any] | None = None
    try:
        if capsule is not None:
            guard_result = {"ok": True, "code": "SNAPSHOT_REUSED"}
        else:
            if phase_gate_rule(args.phase, "test_guard"):
                guard_result = htg.begin(execution_root, change_dir)
                if not guard_result.get("ok"):
                    if gate_soft_allowed(severity_mode, args.phase, "test-guard"):
                        gate_warnings.append(record_gate_warning(
                            change_dir,
                            phase=args.phase,
                            site="test-guard",
                            code=str(guard_result.get("code", "TEST_GUARD_BEGIN_FAILED")),
                            message="test guard begin failed (downgraded to WARN)",
                        ))
                    else:
                        record_gate_blocked(
                            change_dir,
                            phase=args.phase,
                            code=str(
                                guard_result.get("code")
                                or "TEST_GUARD_BEGIN_FAILED"
                            ),
                            message="测试保护快照建立失败，已停止阶段启动。",
                            run_id=run_id,
                        )
                        hc.release_lease(
                            project,
                            change_id=resolved["changeId"],
                            phase=args.phase,
                            run_id=run_id,
                        )
                        return emit_error(
                            str(guard_result.get("code", "TEST_GUARD_BEGIN_FAILED")),
                            "test guard begin failed",
                            as_json=as_json,
                            extra=guard_result,
                        )
            state_root = Path(hp.resolve_state_dir_for_contract(change_dir)).resolve()
            current_head = _git_text(execution_root, "rev-parse", "--verify", "HEAD")
            ledger, _ = hl.load_ledger(change_dir)
            base_commit = ledger.get("baseCommit") if isinstance(ledger, dict) else None
            try:
                begin_contract = hp.load_change_contract(change_dir)
                begin_ownership_hash = hl.ownership_hash(begin_contract)
            except (OSError, ValueError, json.JSONDecodeError):
                begin_ownership_hash = None
            capsule = {
                "schemaVersion": 1,
                "changeId": resolved["changeId"],
                "phase": args.phase,
                "runId": run_id,
                "projectRoot": str(project.resolve()),
                "stateRoot": str(state_root),
                "executionRoot": str(execution_root),
                "skillsRoot": str(skills_root.resolve()),
                "repositoryId": hp.repository_identity(execution_root),
                "baseCommit": base_commit or current_head,
                "currentHead": current_head,
                "ownershipHash": begin_ownership_hash,
                "createdAt": he.now_iso(),
                "projectionReceipt": projection,
            }
            write_phase_capsule(change_dir, args.phase, run_id, capsule)
        event_result = {"ok": True, "skipped": True, "reason": "already-recorded"} \
            if _phase_event_exists(change_dir, args.phase, "phase.start", run_id) \
            else append_phase_event(
                change_dir,
                phase=args.phase,
                type_="phase.start",
                note=args.note or "",
                fixback=bool(getattr(args, "fixback", False)),
                identity=identity,
                run_id=run_id,
                executor_tool=executor_tool,
                executor_agent=args.executor_agent or os.environ.get("HUNTER_HARNESS_AGENT"),
                executor_model=args.executor_model or os.environ.get("HUNTER_HARNESS_MODEL"),
            )
        recovery_result = record_gate_recovered(
            change_dir,
            phase=args.phase,
            run_id=run_id,
        )
    except BaseException:
        hc.release_lease(
            project, change_id=resolved["changeId"], phase=args.phase, run_id=run_id
        )
        raise

    coverage_warning = _verification_target_coverage_warning(change_dir, args.phase)
    if coverage_warning is not None:
        gate_warnings.append(coverage_warning)
        print(
            f"[harness-gate] WARNING {coverage_warning['code']}: "
            f"{coverage_warning['message']}",
            file=sys.stderr,
        )
    payload = {
        "ok": True,
        "code": "PHASE_BEGUN",
        "phase": args.phase,
        "changeId": resolved["changeId"],
        "changeDir": str(change_dir),
        "projectRoot": str(project),
        "stateRoot": capsule.get("stateRoot") if capsule else None,
        "executionRoot": capsule.get("executionRoot") if capsule else str(execution_root),
        "skillsRoot": capsule.get("skillsRoot") if capsule else str(skills_root.resolve()),
        "lease": claim.get("lease"),
        "identity": identity,
        "event": event_result,
        "gateRecovery": recovery_result,
        "testGuard": guard_result,
        "policySchemaVersion": policy.get("schemaVersion"),
        "planVerification": plan_verification,
        "projection": projection,
        "executionRootSource": execution_hint["source"],
        "gateSeverityMode": severity_mode,
        "gateWarnings": gate_warnings,
    }
    emit(payload, as_json=as_json)
    return 0


def _emit_close_summary(
    code: str,
    phase: str,
    status: str,
    to_phase: str | None,
    *,
    derived: bool = False,
) -> None:
    """关门成功的一行摘要（stderr，不污染 stdout 的 JSON 契约）。"""
    suffix = "(auto)" if derived and to_phase else ""
    sys.stderr.write(
        f"{code} · phase={phase} · status={status} · next={to_phase or '-'}{suffix}\n"
    )


def _finalize_close_journal(
    change_dir: Path,
    phase: str,
    run_id: str,
    close_status: str,
) -> None:
    """续跑成功后把 capsule 的 closeTransaction 收口为 CLOSED（best-effort）。"""
    if not run_id:
        return
    try:
        capsule = load_phase_capsule(change_dir, phase, run_id)
    except (OSError, ValueError):
        capsule = None
    if not isinstance(capsule, dict):
        return
    transaction = capsule.get("closeTransaction")
    if not isinstance(transaction, dict):
        return
    transaction.update({
        "status": "CLOSED",
        "retryable": False,
        "leaseReleased": True,
        "updatedAt": he.now_iso(),
    })
    capsule["closedAt"] = he.now_iso()
    capsule["closeStatus"] = close_status
    try:
        write_phase_capsule(change_dir, phase, run_id, capsule)
    except OSError:
        pass


def _resume_closed_phase(
    project: Path,
    resolved: dict[str, Any],
    args: argparse.Namespace,
    terminal: dict[str, Any],
    *,
    as_json: bool,
) -> int:
    """phase.end 已写、租约已释放、收尾未走完的幂等续跑。

    这个中间态是"租约释放早于后续步骤"（或输出中断）留下的：本地关门事实
    已经存在，剩下的 handoff/monitor/recovery/scratch 全部幂等。识别并补跑，
    而不是报 LEASE_ABSENT 逼调用方手工 claim 重取租约（2026-08-30 实测路径）。
    """
    change_id = str(resolved["changeId"])
    change_dir = Path(resolved["changeDir"])
    run_id = str(terminal.get("run_id") or getattr(args, "run_id", None) or "")
    close_status = str(terminal.get("status") or args.status)
    to_phase = getattr(args, "to_phase", None)

    view = hctx.context_view(project, change_id)
    transitions = view.get("transitions") if isinstance(view, dict) else None
    handoff_recorded = isinstance(transitions, list) and any(
        isinstance(item, dict)
        and hp.resolve_phase_name(item.get("fromPhase")) == args.phase
        for item in transitions
    )

    handoff: dict[str, Any] | None = None
    derived_to_phase: str | None = None
    if handoff_recorded:
        # 交接收据已在 transitions.ndjson——重放 close_transition 也只会幂等命中
        handoff = {"ok": True, "code": "TRANSITION_ALREADY_CLOSED", "resumed": True}
    else:
        candidates = [
            candidate
            for candidate in hctx.allowed_next_phases(project, change_id, args.phase)
            if hp.resolve_phase_name(candidate) != args.phase
        ]
        # F-4：续跑路径同样——fixback 回环的 execute 关门应回 review 的后继
        if args.phase == "execute" and isinstance(transitions, list) and transitions:
            latest_t = transitions[-1]
            if (
                isinstance(latest_t, dict)
                and hp.resolve_phase_name(latest_t.get("fromPhase")) == "review"
                and hp.resolve_phase_name(latest_t.get("toPhase")) == "execute"
                and latest_t.get("trigger") == "review-fixback"
            ):
                candidates = [
                    candidate
                    for candidate in hctx.allowed_next_phases(project, change_id, "review")
                    if hp.resolve_phase_name(candidate) != args.phase
                ]
        if to_phase is None and len(candidates) == 1:
            # 计划后继唯一（排除 fixback 自环）：close 的意图没有歧义，直接补跑 handoff
            to_phase = candidates[0]
            args.to_phase = to_phase
            derived_to_phase = to_phase
        if to_phase is None and candidates:
            return emit_error(
                "PHASE_HANDOFF_PENDING",
                "phase gate already closed locally (phase.end recorded), but the context "
                "handoff is still pending and the successor is ambiguous; re-run with --to-phase",
                as_json=as_json,
                extra={
                    "localCloseComplete": True,
                    "retryable": True,
                    "phase": args.phase,
                    "status": close_status,
                    "changeId": change_id,
                    "candidateNextPhases": candidates,
                    "recoveryAction": (
                        "本地关门已完成（phase.end 已写、租约已释放），只剩上下文交接。"
                        "不需要重新 claim 租约——用原命令补 --to-phase 重跑即幂等续跑："
                        "python <skills-root>/scripts/harness_gate.py close "
                        f"--phase {args.phase} --change {change_id} --status {close_status} "
                        f"--to-phase <{'|'.join(candidates)}> --json"
                    ),
                },
            )
        if to_phase is not None:
            handoff = _close_context_handoff(
                project,
                change_id,
                args,
                status=close_status,
            )
    if isinstance(handoff, dict) and not handoff.get("ok"):
        # S-1：续跑路径同样的自愈
        repaired = _repair_handoff_missing_lease(
            project, change_id, args,
            status=close_status, handoff=handoff,
        )
        if repaired is not None:
            handoff = repaired
    if isinstance(handoff, dict) and not handoff.get("ok"):
        return emit_error(
            "PHASE_HANDOFF_PENDING",
            "phase gate is closed, but context handoff still needs attention",
            as_json=as_json,
            extra={
                "localCloseComplete": True,
                "retryable": True,
                "contextHandoff": handoff,
            },
        )
    recovery_result = record_gate_recovered(
        change_dir,
        phase=args.phase,
        run_id=run_id,
    )
    try:
        scratch_swept = hruntime.sweep_scratch(change_dir)
    except Exception as exc:  # noqa: BLE001 — 收尾步骤失败只记录，绝不阻断续跑
        scratch_swept = {"ok": False, "code": "SCRATCH_SWEEP_FAILED", "error": str(exc)}
    _finalize_close_journal(change_dir, args.phase, run_id, close_status)
    emit(
        {
            "ok": True,
            "code": "PHASE_CLOSE_RESUMED",
            "phase": args.phase,
            "status": close_status,
            "changeId": change_id,
            "localCloseComplete": True,
            "contextHandoff": handoff,
            "gateRecovery": recovery_result,
            "scratchSwept": scratch_swept,
            **({"derivedToPhase": derived_to_phase} if derived_to_phase else {}),
        },
        as_json=as_json,
    )
    _emit_close_summary("PHASE_CLOSE_RESUMED", args.phase, close_status, to_phase, derived=derived_to_phase is not None)
    return 0


def cmd_close(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    normalized = _normalize_gate_phase(args, as_json)
    if normalized is not None:
        return normalized
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
    severity_mode = gate_severity_mode(project, change_dir)
    gate_warnings: list[dict[str, Any]] = []
    blocked = foundation_gate_blocks(getattr(args, "task", None), change_dir)
    if blocked:
        return emit_error(
            blocked["code"],
            blocked["message"],
            as_json=as_json,
            extra={k: v for k, v in blocked.items() if k not in {"ok", "message", "code"}},
        )

    try:
        policy = _load_workflow_policy(project=project)
        policy = effective_workflow_policy(policy, change_dir)
    except (OSError, ValueError, hwp.PolicyValidationError) as exc:
        return emit_error("POLICY_LOAD_FAILED", str(exc), as_json=as_json)

    explicit_run_id = args.run_id or os.environ.get("HUNTER_HARNESS_RUN_ID")
    current_lease = hc.inspect_lease(project, resolved["changeId"])
    lease_lapsed: dict[str, Any] | None = None
    # 只有在"没有活跃租约"时才需要区分不存在/已过期/已损坏——三者要给的答案
    # 完全不同，而 inspect_lease 把它们一律压成 None。
    lease_state = (
        {"state": "active", "lease": current_lease}
        if current_lease is not None
        else hc.inspect_lease_state(project, resolved["changeId"])
    )

    if lease_state["state"] == "corrupt":
        # 损坏的租约证明不了"没人抢占过"，所以不自动恢复——那正是自动重取唯一
        # 的安全前提。
        return emit_error(
            "LEASE_INVALID",
            "phase lease file is unreadable; it cannot prove the phase was not taken over",
            as_json=as_json,
            extra={
                "phase": args.phase,
                "changeId": resolved["changeId"],
                "recoveryAction": (
                    "租约文件已损坏，无法自动恢复。确认没有其他进程在跑同一个 change 后，"
                    "用本阶段原 run-id 重新取得租约再重试 close："
                    "python <skills-root>/scripts/harness_change.py claim "
                    f"--change {resolved['changeId']} --phase {args.phase} "
                    "--run-id <原 run-id> --ttl-seconds 3600 --json"
                ),
            },
        )

    if lease_state["state"] == "expired":
        expired_lease = lease_state["lease"] or {}
        expired_run_id = str(expired_lease.get("runId") or "")
        expected_run_id = explicit_run_id or expired_run_id
        # 租约过期、runId 还是本轮的，恰好证明没有第三方抢占过：抢占会重写
        # 租约文件把 runId 换掉。所以过期只说明这个阶段跑得比 TTL 久，不说明
        # 所有权变了——harness_context.close_transition 早就是这么推理的
        # （只记 leaseLapsed 照常收尾），这里把 Gate 侧对齐过去，不再要求
        # 用户手工 claim 一遍再原样重试。
        if (
            expired_run_id
            and expired_run_id == expected_run_id
            and hp.resolve_phase_name(expired_lease.get("phase")) == args.phase
        ):
            reacquired = hc.claim_lease(
                project,
                change_id=str(resolved["changeId"]),
                phase=args.phase,
                run_id=expired_run_id,
                ttl_seconds=int(getattr(args, "ttl_seconds", 0) or 3600),
            )
            if not reacquired.get("ok"):
                return emit_error(
                    str(reacquired.get("code") or "LEASE_CONFLICT"),
                    "expired phase lease could not be reacquired for close",
                    as_json=as_json,
                    extra={
                        "phase": args.phase,
                        "changeId": resolved["changeId"],
                        "holder": reacquired.get("holder"),
                    },
                )
            current_lease = reacquired.get("lease")
            lease_lapsed = {
                "acquiredAt": expired_lease.get("acquiredAt"),
                "expiresAt": expired_lease.get("expiresAt"),
                "reacquiredAt": (current_lease or {}).get("refreshedAt")
                or (current_lease or {}).get("acquiredAt"),
                "runId": expired_run_id,
            }
        else:
            return emit_error(
                "LEASE_OWNER_MISMATCH",
                "expired lease belongs to a different run or phase",
                as_json=as_json,
                extra={"holder": expired_lease},
            )

    if current_lease is None:
        terminal = _latest_phase_end(change_dir, args.phase, explicit_run_id)
        if terminal is not None and _terminal_matches_context_session(
            project, str(resolved["changeId"]), args.phase, terminal
        ):
            # phase.end 已写且属于当前会话：本地关门已完成，租约缺失是历史运行的
            # 释放顺序（或输出中断）留下的中间态——幂等续跑剩余步骤，与是否携带
            # --to-phase 无关；后继未显式给出时从计划派生（唯一后继自动补跑）。
            return _resume_closed_phase(project, resolved, args, terminal, as_json=as_json)
        resume_run_id = explicit_run_id or _latest_open_run_id(change_dir, args.phase)
        return emit_error(
            "LEASE_ABSENT",
            "no active lease for phase close",
            as_json=as_json,
            extra={
                "retryable": True,
                "phase": args.phase,
                "changeId": resolved["changeId"],
                "resumeRunId": resume_run_id,
                "recoveryAction": (
                    "本阶段没有任何租约记录——过期租约现在由 close 自动重取，所以这里说明的是"
                    "租约从未建立或已被释放。先确认 gate begin 是否真的跑过（events.ndjson 里"
                    f"应有 phase={args.phase} 的 phase.start）。确有本轮 run-id 时用它重新取得"
                    "租约再原样重试 close："
                    "python <skills-root>/scripts/harness_change.py claim "
                    f"--change {resolved['changeId']} --phase {args.phase} "
                    f"--run-id {resume_run_id or '<原 run-id>'} --ttl-seconds 3600 --json"
                    "。不要重跑 gate begin——那会新开一次 attempt 并丢失本轮 capsule。"
                ),
            },
        )
    run_id = explicit_run_id or str(current_lease.get("runId") or "")
    if str(current_lease.get("runId")) != run_id or (
        hp.resolve_phase_name(current_lease.get("phase")) != args.phase
    ):
        return emit_error(
            "LEASE_OWNER_MISMATCH",
            "active lease does not match close phase/run-id",
            as_json=as_json,
            extra={"holder": current_lease},
        )

    try:
        capsule = load_phase_capsule(change_dir, args.phase, run_id)
    except ValueError as exc:
        return emit_error("PHASE_CAPSULE_INVALID", str(exc), as_json=as_json)
    if capsule is not None:
        try:
            execution_root = resolve_execution_root(
                project, str(capsule.get("executionRoot") or "")
            )
            if args.project:
                requested_root = resolve_execution_root(project, args.project)
                if requested_root != execution_root:
                    persist_close_failure(
                        change_dir,
                        args.phase,
                        run_id,
                        capsule,
                        status="ROOT_VALIDATION_FAILED",
                        error={
                            "code": "EXECUTION_ROOT_MISMATCH",
                            "storedExecutionRoot": str(execution_root),
                            "requestedExecutionRoot": str(requested_root),
                        },
                    )
                    return emit_error(
                        "EXECUTION_ROOT_MISMATCH",
                        "close must use the execution root captured at begin",
                        as_json=as_json,
                        extra={
                            "storedExecutionRoot": str(execution_root),
                            "requestedExecutionRoot": str(requested_root),
                            "recoveryAction": (
                                "retry close from the stored execution root or "
                                "pass --project with storedExecutionRoot"
                            ),
                        },
                    )
        except ValueError as exc:
            persist_close_failure(
                change_dir,
                args.phase,
                run_id,
                capsule,
                status="ROOT_VALIDATION_FAILED",
                error={
                    "code": "EXECUTION_ROOT_INVALID",
                    "message": str(exc),
                },
            )
            return emit_error("EXECUTION_ROOT_INVALID", str(exc), as_json=as_json)
    else:
        try:
            execution_root = resolve_execution_root(project, args.project)
        except ValueError as exc:
            return emit_error("EXECUTION_ROOT_INVALID", str(exc), as_json=as_json)
    if capsule is not None:
        try:
            validate_phase_capsule(
                capsule,
                change_dir=change_dir,
                change_id=str(resolved["changeId"]),
                phase=args.phase,
                run_id=run_id,
                project=project,
                execution_root=execution_root,
                allow_head_advance=phase_gate_rule(args.phase, "head_may_advance"),
            )
        except ValueError as exc:
            if gate_soft_allowed(severity_mode, args.phase, "capsule"):
                gate_warnings.append(record_gate_warning(
                    change_dir,
                    phase=args.phase,
                    site="capsule",
                    code="PHASE_CAPSULE_MISMATCH",
                    message=str(exc),
                ))
            else:
                persist_close_failure(
                    change_dir,
                    args.phase,
                    run_id,
                    capsule,
                    status="CAPSULE_VALIDATION_FAILED",
                    error={
                        "code": "PHASE_CAPSULE_MISMATCH",
                        "message": str(exc),
                    },
                )
                return emit_error("PHASE_CAPSULE_MISMATCH", str(exc), as_json=as_json)

    projection = evaluate_projection_gate(project, args.phase)
    if not projection.get("ok"):
        persist_close_failure(
            change_dir,
            args.phase,
            run_id,
            capsule,
            status="PROJECTION_VALIDATION_FAILED",
            error=projection,
        )
        return emit_error(
            str(projection.get("code") or "PROJECTION_BLOCKED"),
            str(projection.get("message") or "projection gate blocked close"),
            as_json=as_json,
            extra={
                key: value
                for key, value in projection.items()
                if key not in {"ok", "code", "message"}
            },
        )
    captured_projection = (
        capsule.get("projectionReceipt")
        if isinstance(capsule, dict)
        else None
    )
    if (
        isinstance(captured_projection, dict)
        and captured_projection.get("receiptHash")
        and captured_projection.get("receiptHash")
        != projection.get("receiptHash")
        and phase_gate_rule(args.phase, "projection_drift")
    ):
        mismatch = {
            "code": "PROJECTION_CHANGED_DURING_PHASE",
            "message": "projection receipt changed after phase begin",
            "capturedReceiptHash": captured_projection.get("receiptHash"),
            "currentReceiptHash": projection.get("receiptHash"),
        }
        persist_close_failure(
            change_dir,
            args.phase,
            run_id,
            capsule,
            status="PROJECTION_VALIDATION_FAILED",
            error=mismatch,
        )
        return emit_error(
            mismatch["code"],
            mismatch["message"],
            as_json=as_json,
            extra=mismatch,
        )

    ledger_result = validate_ledger_for_phase_close(
        change_dir, args.phase, policy, execution_root=execution_root,
        phase_status=args.status,
    )
    if not ledger_result.get("ok") and phase_gate_rule(args.phase, "ledger_blocking"):
        persist_close_failure(
            change_dir,
            args.phase,
            run_id,
            capsule,
            status="LEDGER_VALIDATION_FAILED",
            error=ledger_result,
        )
        record_gate_blocked(
            change_dir,
            phase=args.phase,
            code=str(ledger_result.get("code") or "LEDGER_INVALID"),
            message=(
                "验证记录与当前变更身份不一致，已保留现场；"
                "请按返回的路径摘要重新验证受影响范围。"
            ),
            run_id=run_id,
        )
        return emit_error(
            str(ledger_result.get("code", "LEDGER_INVALID")),
            str(ledger_result.get("message", "ledger validation failed")),
            as_json=as_json,
            extra={k: v for k, v in ledger_result.items() if k not in {"ok", "message", "code"}},
        )

    if phase_gate_rule(args.phase, "review_outputs"):
        review_outputs = validate_review_outputs_for_close(change_dir, run_id)
        if not review_outputs.get("ok"):
            persist_close_failure(
                change_dir,
                args.phase,
                run_id,
                capsule,
                status="REVIEW_OUTPUTS_INVALID",
                error=review_outputs,
            )
            record_gate_blocked(
                change_dir,
                phase=args.phase,
                code=str(review_outputs.get("code") or "REVIEW_OUTPUTS_INVALID"),
                message=str(review_outputs.get("message") or "评审记录不完整。"),
                run_id=run_id,
            )
            return emit_error(
                str(review_outputs.get("code") or "REVIEW_OUTPUTS_INVALID"),
                str(review_outputs.get("message") or "评审记录不完整。"),
                as_json=as_json,
                extra={
                    key: value
                    for key, value in review_outputs.items()
                    if key not in {"ok", "code", "message"}
                },
            )

    # C9: scenario coverage check — every P0/ledger scenario *due by this phase*
    # must have a ledger entry. Scenarios with a later ownerPhase are deferred,
    # not missing (see _validate_scenario_coverage).
    if phase_gate_rule(args.phase, "scenario_coverage"):
        coverage = _validate_scenario_coverage(change_dir, args.phase)
        if not coverage.get("ok"):
            if gate_soft_allowed(severity_mode, args.phase, "scenario-coverage"):
                gate_warnings.append(record_gate_warning(
                    change_dir,
                    phase=args.phase,
                    site="scenario-coverage",
                    code=str(coverage.get("code", "SCENARIO_COVERAGE_FAILED")),
                    message=str(coverage.get("message", "scenario coverage validation failed")),
                ))
            else:
                persist_close_failure(
                    change_dir,
                    args.phase,
                    run_id,
                    capsule,
                    status="SCENARIO_VALIDATION_FAILED",
                    error=coverage,
                )
                return emit_error(
                    str(coverage.get("code", "SCENARIO_COVERAGE_FAILED")),
                    str(coverage.get("message", "scenario coverage validation failed")),
                    as_json=as_json,
                    extra={k: v for k, v in coverage.items() if k not in {"ok", "message", "code"}},
                )

    close_status = args.status
    close_code = "PHASE_CLOSED"
    if ledger_result.get("code") == "LEDGER_OK_DEGRADED":
        close_code = "CLOSED_DEGRADED"
        # Degraded close: phase.end status must not exceed WARN (OK → WARN).
        if close_status == "OK":
            close_status = "WARN"
    if gate_warnings:
        # Lenient-mode downgrades: phase closes, but never better than WARN.
        if close_status == "OK":
            close_status = "WARN"
        if close_code == "PHASE_CLOSED":
            close_code = "CLOSED_WITH_WARNINGS"

    close_transaction: dict[str, Any] = {}
    if capsule is not None:
        existing_transaction = capsule.get("closeTransaction")
        if isinstance(existing_transaction, dict):
            close_transaction.update(existing_transaction)
        close_transaction.update({
            "status": "CLOSING",
            "retryable": True,
            "guardClosed": bool(close_transaction.get("guardClosed")),
            "phaseEndRecorded": bool(close_transaction.get("phaseEndRecorded")),
            "leaseReleased": False,
            "updatedAt": he.now_iso(),
        })
        capsule["closeTransaction"] = close_transaction
        write_phase_capsule(change_dir, args.phase, run_id, capsule)

    guard_result = None
    if phase_gate_rule(args.phase, "test_guard"):
        if close_transaction.get("guardClosed"):
            guard_result = {"ok": True, "code": "ALREADY_CLOSED", "reused": True}
        else:
            guard_result = htg.close(execution_root, change_dir)
            if not guard_result.get("ok"):
                if gate_soft_allowed(severity_mode, args.phase, "test-guard"):
                    gate_warnings.append(record_gate_warning(
                        change_dir,
                        phase=args.phase,
                        site="test-guard",
                        code=str(guard_result.get("code", "TEST_GUARD_CLOSE_FAILED")),
                        message="test guard close failed (downgraded to WARN)",
                    ))
                else:
                    if capsule is not None:
                        close_transaction.update({
                            "status": "GUARD_CLOSE_FAILED",
                            "lastError": guard_result,
                            "updatedAt": he.now_iso(),
                        })
                        write_phase_capsule(change_dir, args.phase, run_id, capsule)
                    record_gate_blocked(
                        change_dir,
                        phase=args.phase,
                        code=str(
                            guard_result.get("code")
                            or "TEST_GUARD_CLOSE_FAILED"
                        ),
                        message="测试保护关门失败，已保留现场并等待同一命令恢复。",
                        run_id=run_id,
                    )
                    return emit_error(
                        str(guard_result.get("code", "TEST_GUARD_CLOSE_FAILED")),
                        "test guard close failed",
                        as_json=as_json,
                        extra=guard_result,
                    )
            if guard_result.get("ok") and capsule is not None:
                close_transaction["guardClosed"] = True
                close_transaction["updatedAt"] = he.now_iso()
                write_phase_capsule(change_dir, args.phase, run_id, capsule)

    if close_transaction.get("phaseEndRecorded") or _phase_event_exists(
        change_dir, args.phase, "phase.end", run_id
    ):
        event_result = {"ok": True, "skipped": True, "reason": "already-recorded"}
    else:
        try:
            event_result = append_phase_event(
                change_dir,
                phase=args.phase,
                type_="phase.end",
                status=close_status,
                note=args.note or "",
                fixback=bool(getattr(args, "fixback", False)),
                run_id=run_id,
            )
        except BaseException as exc:
            if capsule is not None:
                close_transaction.update({
                    "status": "PHASE_END_FAILED",
                    "lastError": {"type": type(exc).__name__, "message": str(exc)},
                    "updatedAt": he.now_iso(),
                })
                write_phase_capsule(change_dir, args.phase, run_id, capsule)
            return emit_error(
                "PHASE_END_FAILED",
                str(exc),
                as_json=as_json,
                extra={"retryable": True},
            )
    if capsule is not None:
        close_transaction["phaseEndRecorded"] = True
        close_transaction["updatedAt"] = he.now_iso()
        write_phase_capsule(change_dir, args.phase, run_id, capsule)

    # 租约释放必须是关门的最后一个可失败步骤。历史上它排在 handoff/monitor
    # 之前，一旦中途失败就留下“phase.end 已写 + 租约已放 + 交接没写”的三不管
    # 状态，重试直接死在 LEASE_ABSENT（2026-08-30 sales-insight-agent 实测）。
    # 现在顺序为：handoff → monitor → recovery → scratch → release → emit；
    # 任何中途失败时租约仍持有，重试同一命令按 closeTransaction journal 幂等续跑。
    # P0-1：plain close 不得静默跳过交接。上下文状态存在且计划后继唯一
    # （排除 fixback 自环）时自动派生后继并执行交接——断链从根上消失；
    # 多后继仍要求显式 --to-phase。
    derived_to_phase: str | None = None
    if not getattr(args, "to_phase", None):
        context_view = hctx.context_view(project, str(resolved["changeId"]))
        if (
            isinstance(context_view, dict)
            and context_view.get("ok")
            and isinstance(context_view.get("current"), dict)
        ):
            # F-4：fixback 回环（最新交接是 review→execute 且 trigger=
            # review-fixback）关门时，后继不是再来一轮 review，而是 review
            # 当时的计划后继（submit）。不按此处理会把 transitions 链写成
            # …→review→execute→review 的语义错乱（2026-08-31 实测）。
            source_phase = args.phase
            transitions = context_view.get("transitions") or []
            if args.phase == "execute" and transitions:
                latest = transitions[-1]
                if (
                    isinstance(latest, dict)
                    and hp.resolve_phase_name(latest.get("fromPhase")) == "review"
                    and hp.resolve_phase_name(latest.get("toPhase")) == "execute"
                    and latest.get("trigger") == "review-fixback"
                ):
                    source_phase = "review"
            forward = [
                candidate
                for candidate in hctx.allowed_next_phases(
                    project, str(resolved["changeId"]), source_phase
                )
                if hp.resolve_phase_name(candidate) != args.phase
            ]
            if len(forward) == 1:
                derived_to_phase = forward[0]
                args.to_phase = derived_to_phase
    context_handoff = _close_context_handoff(
        project,
        str(resolved["changeId"]),
        args,
        status=close_status,
    )
    if isinstance(context_handoff, dict) and not context_handoff.get("ok"):
        # S-1：context 租约缺失时自愈一次（prepare 幂等重建 + 重试交接），
        # 修复前“原样重跑”永远撞同一个 CONTEXT_LEASE_REQUIRED
        repaired = _repair_handoff_missing_lease(
            project, str(resolved["changeId"]), args,
            status=close_status, handoff=context_handoff,
        )
        if repaired is not None:
            context_handoff = repaired
    if isinstance(context_handoff, dict) and not context_handoff.get("ok"):
        record_gate_blocked(
            change_dir,
            phase=args.phase,
            code=str(context_handoff.get("code") or "PHASE_HANDOFF_PENDING"),
            message="阶段本地关门已完成，但上下文交接尚待恢复。",
            run_id=run_id,
        )
        return emit_error(
            "PHASE_HANDOFF_PENDING",
            "phase gate closed locally, but context handoff failed; retry the same close command",
            as_json=as_json,
            extra={
                "localCloseComplete": True,
                "retryable": True,
                "phase": args.phase,
                "status": close_status,
                "changeId": resolved["changeId"],
                "contextHandoff": context_handoff,
                "recoveryAction": (
                    "租约仍持有，无需重新 claim——原样重跑同一 close 命令即可幂等续跑"
                    "（phase.end 已落会跳过，handoff 会重试；context 租约缺失时会自动"
                    "补建）。仍失败时用一条命令补齐交接："
                    "harness_context.py handoff --project . "
                    f"--change {resolved['changeId']} --to-phase "
                    f"{getattr(args, 'to_phase', None) or '<后继阶段>'} "
                    "--executor <tool> --json"
                ),
            },
        )

    recovery_result = record_gate_recovered(
        change_dir,
        phase=args.phase,
        run_id=run_id,
    )
    # 关门时清掉本阶段的过程草稿（diff、临时输入、命令输出重定向）。没人清它们，
    # 而且它们会被别的门禁读到——2026-08-19 那次，review 自己生成的两个 diff
    # 直接把归档挡住了。白名单式删除，证据/报告/运行态一律不碰；失败只记不阻断。
    try:
        scratch_swept = hruntime.sweep_scratch(change_dir)
    except Exception as exc:  # noqa: BLE001 — 清草稿是收尾便利，任何失败都不得阻断关门
        scratch_swept = {"ok": False, "code": "SCRATCH_SWEEP_FAILED", "error": str(exc)}

    release = hc.release_lease(
        project,
        change_id=resolved["changeId"],
        phase=args.phase,
        run_id=run_id,
    )
    if not release.get("ok"):
        if capsule is not None:
            close_transaction.update({
                "status": "RELEASE_PENDING",
                "retryable": True,
                "lastError": release,
                "updatedAt": he.now_iso(),
            })
            write_phase_capsule(change_dir, args.phase, run_id, capsule)
        return emit_error(
            str(release.get("code", "LEASE_RELEASE_FAILED")),
            str(release.get("message", "lease release failed")),
            as_json=as_json,
            extra={
                **{k: v for k, v in release.items() if k not in {"ok", "message", "code"}},
                "localCloseComplete": True,
                "retryable": True,
                "recoveryAction": (
                    "本地关门与上下文交接均已完成，仅租约释放失败——原样重跑同一 close "
                    "命令即幂等续跑（phase.end/handoff 幂等命中，仅重试释放）"
                ),
            },
        )

    if capsule is not None:
        close_transaction.update({
            "status": "CLOSED",
            "retryable": False,
            "leaseReleased": True,
            "updatedAt": he.now_iso(),
        })
        capsule["closedAt"] = he.now_iso()
        capsule["closeStatus"] = close_status
        write_phase_capsule(change_dir, args.phase, run_id, capsule)

    payload = {
        "ok": True,
        "code": close_code,
        "phase": args.phase,
        "status": close_status,
        "changeId": resolved["changeId"],
        "stateRoot": capsule.get("stateRoot") if capsule else str(Path(hp.resolve_state_dir_for_contract(change_dir)).resolve()),
        "executionRoot": str(execution_root),
        "skillsRoot": capsule.get("skillsRoot") if capsule else None,
        "ledger": ledger_result,
        "testGuard": guard_result,
        "event": event_result,
        "lease": release,
        "gateSeverityMode": severity_mode,
        "gateWarnings": gate_warnings,
        "contextHandoff": context_handoff,
        "gateRecovery": recovery_result,
        "scratchSwept": scratch_swept,
    }
    if derived_to_phase is not None:
        # plain close 自动派生的后继，调用方必须看得到这不是显式选择。
        payload["derivedToPhase"] = derived_to_phase
    if lease_lapsed is not None:
        # 与 context transition receipt 的 leaseLapsed 同名同义：记录这个阶段
        # 跑过了 TTL 且租约是自动重取的，不隐藏。
        payload["leaseLapsed"] = lease_lapsed
    emit(payload, as_json=as_json)
    _emit_close_summary(
        close_code,
        args.phase,
        close_status,
        getattr(args, "to_phase", None),
        derived=derived_to_phase is not None,
    )
    return 0


def cmd_classify(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    project = _resolve_project(args)
    try:
        workflow = _load_workflow_policy(project=project)
    except (OSError, ValueError, hwp.PolicyValidationError) as exc:
        return emit_error("POLICY_LOAD_FAILED", str(exc), as_json=as_json)

    resolved = hc.resolve_change(project, args.change)
    change_dir: Path | None = None
    change_id = str(args.change or "")
    if resolved.get("ok"):
        change_dir = Path(resolved["changeDir"])
        change_id = str(resolved.get("changeId") or change_dir.name)
        if not change_dir.is_dir():
            change_dir = None

    if change_dir is not None:
        payload = classify_risk(change_dir, args.stage, workflow=workflow)
    else:
        payload = classify_defaults(workflow, change_id=change_id or "unknown", stage=args.stage)
        if not resolved.get("ok"):
            payload["resolveCode"] = resolved.get("code")

    tier_override = getattr(args, "tier_override", None)
    if tier_override:
        payload = apply_tier_override(
            payload,
            workflow,
            tier=str(tier_override),
            override_by=str(getattr(args, "override_by", None) or "user"),
        )
    else:
        payload.setdefault("tierOverride", None)

    classified_at = hc.now_iso()
    payload["classifiedAt"] = classified_at

    if change_dir is not None and change_dir.is_dir():
        finalized = (change_dir / "meta" / "plan-profile.json").is_file()
        if finalized and not getattr(args, "force", False):
            # P1-1：classify 形态像只读查询，实际是写操作。已发布的 change
            # 被误跑 classify 会覆盖 configure-plan 写入的工作副本（2026-08-30
            # demo-datasource 实测 plannedPhases 被清）。默认拒写并显式提示。
            payload["policyPersisted"] = False
            payload["warning"] = (
                "change 已发布（meta/plan-profile.json 存在），classify 不再重写 "
                "meta/gate-policy.json 工作副本；确需重算请显式传 --force"
            )
            payload["writeGuarded"] = True
        else:
            policy_doc = gate_policy_document(payload)
            policy_path = change_dir / "meta" / "gate-policy.json"
            _write_json(policy_path, policy_doc)
            payload["policyPersisted"] = True
            payload["policyPath"] = str(policy_path)
            if finalized:
                payload["warning"] = "--force：已发布 change 的工作副本已被重写"
    else:
        payload["policyPersisted"] = False
        payload["warning"] = (
            "change directory does not exist; gate-policy.json not written"
        )

    emit(payload, as_json=as_json)
    return 0

def cmd_checkpoint(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    project = _resolve_project(args)
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
    items = checkpoints.get("checkpoints") if isinstance(checkpoints, dict) else None
    item = next((candidate for candidate in items if isinstance(candidate, dict)
                 and candidate.get("id") == args.id), None) if isinstance(items, list) else None
    if item is None:
        return emit_error("CHECKPOINT_NOT_FOUND", f"checkpoint not found: {args.id}", as_json=as_json)
    expected_reviewer = str(item.get("reviewerTool") or "")
    if not args.reviewer or (expected_reviewer and args.reviewer != expected_reviewer):
        return emit_error(
            "CHECKPOINT_REVIEWER_MISMATCH",
            f"checkpoint requires reviewer {expected_reviewer or 'explicit reviewer'}",
            as_json=as_json,
        )
    required_report = str(item.get("requiredReport") or "")
    report_rel = Path(required_report)
    if (
        not required_report
        or report_rel.is_absolute()
        or ".." in report_rel.parts
    ):
        return emit_error(
            "CHECKPOINT_REPORT_PATH_INVALID",
            f"required report path is invalid: {required_report or '<unset>'}",
            as_json=as_json,
        )
    state_dir = hp.resolve_state_dir_for_contract(change_dir, project)
    report_candidates = [state_dir / report_rel]
    if state_dir != change_dir:
        # Compatibility fallback for split-v1 changes created before dynamic
        # reports were routed to the state root.
        report_candidates.append(change_dir / report_rel)
    report_path = next(
        (candidate for candidate in report_candidates if candidate.is_file()),
        report_candidates[0],
    )
    if not report_path.is_file() or report_path.stat().st_size == 0:
        return emit_error(
            "CHECKPOINT_REPORT_MISSING",
            f"required report is missing: {required_report}",
            as_json=as_json,
        )
    report_text = report_path.read_text(encoding="utf-8", errors="replace")
    if not re.search(r"(?im)^foundation-gate:\s*approved\s*$", report_text):
        return emit_error(
            "CHECKPOINT_REPORT_NOT_APPROVED",
            "required report does not contain 'foundation-gate: approved'",
            as_json=as_json,
        )
    item["status"] = "approved"
    item["approvedAt"] = hc.now_iso()
    item["approvedBy"] = args.reviewer
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
    p_begin.add_argument("--change", "--change-dir", dest="change", default=None)
    p_begin.add_argument(
        "--project",
        default=None,
        help=(
            "execution root PATH (worktree) for this phase; defaults to the "
            "change's main project. Takes a path, not a project name."
        ),
    )
    p_begin.add_argument("--skills-root", default=None)
    p_begin.add_argument("--run-id", default=None)
    p_begin.add_argument("--ttl-seconds", type=int, default=3600)
    p_begin.add_argument("--task", type=int, default=None)
    p_begin.add_argument("--note", default="")
    p_begin.add_argument(
        "--fixback",
        action="store_true",
        help="This phase is a review fixback round (tags the lifecycle event).",
    )
    p_begin.add_argument("--executor-tool", default=None)
    p_begin.add_argument("--executor-agent", default=None)
    p_begin.add_argument("--executor-model", default=None)
    p_begin.set_defaults(func=cmd_begin)

    p_close = sub.add_parser(
        "close",
        parents=[shared],
        help="关闭阶段门禁（关门只调本命令；上下文交接由 --to-phase 内联完成，不要再单独调 harness_context.py close）",
    )
    p_close.add_argument("--phase", required=True)
    p_close.add_argument("--change", "--change-dir", dest="change", default=None)
    p_close.add_argument(
        "--project",
        default=None,
        help=(
            "execution root PATH (worktree) for this phase; defaults to the "
            "change's main project. Takes a path, not a project name."
        ),
    )
    p_close.add_argument("--status", required=True)
    p_close.add_argument("--run-id", default=None)
    p_close.add_argument("--task", type=int, default=None)
    p_close.add_argument("--note", default="")
    p_close.add_argument(
        "--fixback",
        action="store_true",
        help="This phase is a review fixback round (tags the lifecycle event).",
    )
    p_close.add_argument("--to-phase", default=None)
    p_close.add_argument("--executor", default=None)
    p_close.add_argument("--artifact", action="append", default=[])
    p_close.set_defaults(func=cmd_close)

    p_classify = sub.add_parser("classify", parents=[shared])
    p_classify.add_argument("--project", default=None, type=Path, help=_PROJECT_ROOT_HELP)
    p_classify.add_argument("--change", "--change-dir", dest="change", default=None)
    p_classify.add_argument("--stage", required=True, choices=["plan", "post-run"])
    p_classify.add_argument(
        "--tier-override",
        default=None,
        choices=["fast", "standard", "full"],
    )
    p_classify.add_argument("--override-by", default="user")
    p_classify.add_argument(
        "--force",
        action="store_true",
        help="已发布 change 也强制重写 gate-policy.json 工作副本",
    )
    p_classify.set_defaults(func=cmd_classify)

    p_checkpoint = sub.add_parser("checkpoint", parents=[shared])
    p_checkpoint.add_argument("--project", default=None, type=Path, help=_PROJECT_ROOT_HELP)
    p_checkpoint.add_argument("checkpoint_action", choices=["status", "approve"])
    p_checkpoint.add_argument("--id", required=True)
    p_checkpoint.add_argument("--change", "--change-dir", dest="change", default=None)
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
