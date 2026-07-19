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
import harness_events as he  # noqa: E402
import harness_ledger as hl  # noqa: E402
import harness_paths as hp  # noqa: E402
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


def resolve_execution_root(main_project: Path, raw: str | None) -> Path:
    candidate = Path(raw).expanduser().resolve() if raw else main_project.resolve()
    if not candidate.is_dir():
        raise ValueError(f"execution root not found: {candidate}")
    top = _git_text(candidate, "rev-parse", "--show-toplevel")
    if not top:
        raise ValueError(f"execution root is not a git worktree: {candidate}")
    root = Path(top).resolve()
    if hp.repository_identity(root) != hp.repository_identity(main_project):
        raise ValueError("execution root belongs to a different repository")
    return root


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
    path = _phase_capsule_path(change_dir, phase, run_id)
    if not path.is_file():
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
                missing.append("status=OK")
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
            current_diff = hl.compute_ownership_diff(
                root,
                base=str(ledger["baseCommit"]),
                change_dir=change_dir,
            )["diffHash"]
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
            }

    problems: list[dict[str, Any]] = []
    degraded: list[str] = []
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
        elif is_degraded:
            degraded.append(verification)

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
    """Overlay a classified change's per-phase gate requirements."""
    path = change_dir / "meta" / "gate-policy.json"
    if not path.is_file():
        return workflow
    document = json.loads(path.read_text(encoding="utf-8"))
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
    if executor_tool and executor_tool != agent:
        raise ValueError(f"BUNDLE_IDENTITY_MISMATCH: executor {executor_tool} uses {agent} bundle")

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


def change_code_root(change_dir: Path) -> Path:
    project = change_dir.parents[2]
    metadata = (
        (change_dir / "meta" / "change-context.json", ("worktreeRoot",)),
        (change_dir / "meta" / "worktree.json", ("worktreePath", "path")),
    )
    for context_path, fields in metadata:
        if not context_path.is_file():
            continue
        try:
            context = json.loads(context_path.read_text(encoding="utf-8"))
            raw_root = next(
                (str(context.get(field) or "").strip() for field in fields if context.get(field)),
                "",
            )
            if raw_root:
                raw_path = Path(raw_root).expanduser()
                candidate = (raw_path if raw_path.is_absolute() else project / raw_path).resolve()
                if candidate.is_dir():
                    return candidate
        except (OSError, ValueError, json.JSONDecodeError):
            pass
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
                if validation_phases.get(item) in {"run", "test"}
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
    tier = "full"
    source = "default-full"
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
            if not raw or raw.startswith(".harness/"):
                continue
            changed.append(raw)
        capabilities = sorted(set(capabilities) | set(_diff_capabilities(changed)))
        lowered = "\n".join(changed).lower()
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
        elif changed and all(
            path.lower().endswith((".md", ".txt", ".rst"))
            or path.lower().startswith("docs/")
            for path in changed
        ):
            observed = "fast"
            signals.append("docs-only")
        elif changed:
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
        _write_json(change_dir / "meta" / "risk-classification.json", payload)
    return _apply_required_gate_contract(payload, workflow, capabilities)


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
    return _apply_required_gate_contract(
        payload, workflow, list(payload.get("capabilities") or [])
    )


def gate_policy_document(payload: dict[str, Any]) -> dict[str, Any]:
    """Cross-change contract: meta/gate-policy.json (schemaVersion=1)."""
    return {
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


def classify_defaults(
    workflow: dict[str, Any],
    *,
    change_id: str,
    stage: str,
) -> dict[str, Any]:
    tier = "full"
    source = "default-full"
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
        executor_tool=executor_tool,
        executor_agent=executor_agent,
        executor_model=executor_model,
        handoff_from_tool=None,
        handoff_reason=None,
    )
    event = he.build_event(args, existing)
    if identity:
        for key, value in identity.items():
            if key not in event and value is not None:
                event[key] = value
    line = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    lock_path = events_file.with_name(events_file.name + ".lock")
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


def _phase_event_exists(change_dir: Path, phase: str, type_: str, run_id: str) -> bool:
    return any(
        event.get("phase") == phase
        and event.get("type") == type_
        and event.get("run_id") == run_id
        for event in he.load_events(he.events_path(change_dir))
    )


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
        policy = _load_workflow_policy(project=project)
        policy = effective_workflow_policy(policy, change_dir)
    except (OSError, ValueError, hwp.PolicyValidationError) as exc:
        return emit_error("POLICY_LOAD_FAILED", str(exc), as_json=as_json)

    executor_tool = args.executor_tool or os.environ.get("HUNTER_HARNESS_TOOL")
    if not args.skills_root:
        return emit_error(
            "BUNDLE_IDENTITY_REQUIRED",
            "--skills-root is required; refresh the selected Harness adapter if identity is missing",
            as_json=as_json,
        )
    try:
        identity = validate_identity(
            project, Path(args.skills_root).expanduser().resolve(), executor_tool
        )
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        return emit_error("BUNDLE_IDENTITY_INVALID", str(exc), as_json=as_json)
    executor_tool = executor_tool or str(identity.get("adapter") or "") or None
    explicit_run_id = args.run_id or os.environ.get("HUNTER_HARNESS_RUN_ID")
    current_lease = hc.inspect_lease(project, resolved["changeId"])
    run_id = explicit_run_id or (
        str(current_lease.get("runId"))
        if isinstance(current_lease, dict) and current_lease.get("phase") == args.phase
        else "run-" + uuid.uuid4().hex
    )
    try:
        capsule = load_phase_capsule(change_dir, args.phase, run_id)
    except ValueError as exc:
        return emit_error("PHASE_CAPSULE_INVALID", str(exc), as_json=as_json)
    execution_hint = args.project
    if not execution_hint and capsule is not None:
        execution_hint = str(capsule.get("executionRoot") or "")
    try:
        execution_root = resolve_execution_root(project, execution_hint)
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
                skills_root=Path(args.skills_root).expanduser(),
            )
        except ValueError as exc:
            return emit_error("PHASE_CAPSULE_MISMATCH", str(exc), as_json=as_json)
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

    guard_result: dict[str, Any] | None = None
    try:
        if capsule is not None:
            guard_result = {"ok": True, "code": "SNAPSHOT_REUSED"}
        else:
            if args.phase in {"run", "test"}:
                guard_result = htg.begin(execution_root, change_dir)
                if not guard_result.get("ok"):
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
            capsule = {
                "schemaVersion": 1,
                "changeId": resolved["changeId"],
                "phase": args.phase,
                "runId": run_id,
                "projectRoot": str(project.resolve()),
                "stateRoot": str(state_root),
                "executionRoot": str(execution_root),
                "skillsRoot": str(Path(args.skills_root).expanduser().resolve()),
                "repositoryId": hp.repository_identity(execution_root),
                "baseCommit": base_commit or current_head,
                "currentHead": current_head,
                "createdAt": he.now_iso(),
            }
            write_phase_capsule(change_dir, args.phase, run_id, capsule)
        event_result = {"ok": True, "skipped": True, "reason": "already-recorded"} \
            if _phase_event_exists(change_dir, args.phase, "phase.start", run_id) \
            else append_phase_event(
                change_dir,
                phase=args.phase,
                type_="phase.start",
                note=args.note or "",
                identity=identity,
                run_id=run_id,
                executor_tool=executor_tool,
                executor_agent=args.executor_agent or os.environ.get("HUNTER_HARNESS_AGENT"),
                executor_model=args.executor_model or os.environ.get("HUNTER_HARNESS_MODEL"),
            )
    except BaseException:
        hc.release_lease(
            project, change_id=resolved["changeId"], phase=args.phase, run_id=run_id
        )
        raise

    payload = {
        "ok": True,
        "code": "PHASE_BEGUN",
        "phase": args.phase,
        "changeId": resolved["changeId"],
        "changeDir": str(change_dir),
        "projectRoot": str(project),
        "stateRoot": capsule.get("stateRoot") if capsule else None,
        "executionRoot": capsule.get("executionRoot") if capsule else str(execution_root),
        "skillsRoot": capsule.get("skillsRoot") if capsule else str(Path(args.skills_root).resolve()),
        "lease": claim.get("lease"),
        "identity": identity,
        "event": event_result,
        "testGuard": guard_result,
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
        policy = _load_workflow_policy(project=project)
        policy = effective_workflow_policy(policy, change_dir)
    except (OSError, ValueError, hwp.PolicyValidationError) as exc:
        return emit_error("POLICY_LOAD_FAILED", str(exc), as_json=as_json)

    explicit_run_id = args.run_id or os.environ.get("HUNTER_HARNESS_RUN_ID")
    current_lease = hc.inspect_lease(project, resolved["changeId"])
    if current_lease is None:
        return emit_error("LEASE_ABSENT", "no active lease for phase close", as_json=as_json)
    run_id = explicit_run_id or str(current_lease.get("runId") or "")
    if str(current_lease.get("runId")) != run_id or str(current_lease.get("phase")) != args.phase:
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
                    return emit_error(
                        "EXECUTION_ROOT_MISMATCH",
                        "close must use the execution root captured at begin",
                        as_json=as_json,
                        extra={
                            "storedExecutionRoot": str(execution_root),
                            "requestedExecutionRoot": str(requested_root),
                        },
                    )
        except ValueError as exc:
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
                allow_head_advance=args.phase in {"run", "submit", "merge"},
            )
        except ValueError as exc:
            return emit_error("PHASE_CAPSULE_MISMATCH", str(exc), as_json=as_json)

    ledger_result = validate_ledger_for_phase_close(
        change_dir, args.phase, policy, execution_root=execution_root
    )
    if not ledger_result.get("ok") and args.phase in {"run", "test", "package"}:
        return emit_error(
            str(ledger_result.get("code", "LEDGER_INVALID")),
            str(ledger_result.get("message", "ledger validation failed")),
            as_json=as_json,
            extra={k: v for k, v in ledger_result.items() if k not in {"ok", "message", "code"}},
        )

    close_status = args.status
    close_code = "PHASE_CLOSED"
    if ledger_result.get("code") == "LEDGER_OK_DEGRADED":
        close_code = "CLOSED_DEGRADED"
        # Degraded close: phase.end status must not exceed WARN (OK → WARN).
        if close_status == "OK":
            close_status = "WARN"

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
    if args.phase in {"run", "test"}:
        if close_transaction.get("guardClosed"):
            guard_result = {"ok": True, "code": "ALREADY_CLOSED", "reused": True}
        else:
            guard_result = htg.close(execution_root, change_dir)
            if not guard_result.get("ok"):
                if capsule is not None:
                    close_transaction.update({
                        "status": "GUARD_CLOSE_FAILED",
                        "lastError": guard_result,
                        "updatedAt": he.now_iso(),
                    })
                    write_phase_capsule(change_dir, args.phase, run_id, capsule)
                return emit_error(
                    str(guard_result.get("code", "TEST_GUARD_CLOSE_FAILED")),
                    "test guard close failed",
                    as_json=as_json,
                    extra=guard_result,
                )
            if capsule is not None:
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
            extra={k: v for k, v in release.items() if k not in {"ok", "message", "code"}},
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
    }
    emit(payload, as_json=as_json)
    return 0


def cmd_classify(args: argparse.Namespace) -> int:
    as_json = bool(args.json)
    project = hc.resolve_main_project_root()
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
        policy_doc = gate_policy_document(payload)
        policy_path = change_dir / "meta" / "gate-policy.json"
        _write_json(policy_path, policy_doc)
        payload["policyPersisted"] = True
        payload["policyPath"] = str(policy_path)
    else:
        payload["policyPersisted"] = False
        payload["warning"] = (
            "change directory does not exist; gate-policy.json not written"
        )

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
    p_classify.add_argument(
        "--tier-override",
        default=None,
        choices=["fast", "standard", "full"],
    )
    p_classify.add_argument("--override-by", default="user")
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
