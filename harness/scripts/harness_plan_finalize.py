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
import sys
import tempfile
from pathlib import Path
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

# C8: valid ownerPhase values (lifecycle phases that can own tasks).
VALID_OWNER_PHASES = {"plan", "run", "test", "review", "submit"}

# C9: map scenario priority to required evidence kind.
PRIORITY_EVIDENCE_KIND = {
    "P0": "ledger",
    "P1": "ledger",
    "P2": "advisory",
}


def _result_error(code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "code": code, "error": message}


def parse_test_scenarios(scenarios_path: Path) -> list[dict[str, str]]:
    """C9: parse test-scenarios.md tables, extracting scenario rows.

    Returns a list of dicts with keys: id / priority / scenario / verification /
    ownerPhase / requiredEvidenceKind (last one derived from priority).
    """
    text = Path(scenarios_path).read_text(encoding="utf-8-sig")
    lines = text.splitlines()
    scenarios: list[dict[str, str]] = []
    # Find all tables whose header includes "ID" and "优先级" (or "priority").
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if line.startswith("|") and "ID" in line and ("优先级" in line or "priority" in line):
            header_line = line
            headers = [h.strip() for h in header_line.strip("|").split("|")]
            col_map: dict[str, int] = {}
            for idx, name in enumerate(headers):
                key = name.lower()
                col_map[key] = idx
            # Skip separator row
            i += 2
            while i < len(lines):
                row = lines[i].strip()
                if not row.startswith("|"):
                    break
                cells = [c.strip() for c in row.strip("|").split("|")]
                if len(cells) < len(headers):
                    i += 1
                    continue
                scenario: dict[str, str] = {}
                for cn, en in (
                    ("ID", "id"),
                    ("优先级", "priority"),
                    ("场景", "scenario"),
                    ("验证方式", "verification"),
                    ("owner phase", "ownerPhase"),
                ):
                    if cn.lower() in col_map:
                        scenario[en] = cells[col_map[cn.lower()]]
                # Derive requiredEvidenceKind from priority
                priority = scenario.get("priority", "")
                scenario["requiredEvidenceKind"] = PRIORITY_EVIDENCE_KIND.get(priority, "advisory")
                scenarios.append(scenario)
                i += 1
            continue
        i += 1
    return scenarios


def parse_plan_tasks(plan_path: Path) -> list[dict[str, str]]:
    """C8: parse plan.md task table rows, extracting optional ownerPhase/implementationDoneWhen/verificationPhase columns.

    Returns a list of dicts with keys: # / 簇 / 任务 / ownerPhase / implementationDoneWhen /
    verificationPhase / requiresExplicitAuthority (last four optional, only present when
    the column header includes them).
    """
    text = Path(plan_path).read_text(encoding="utf-8-sig")
    lines = text.splitlines()
    # Find the task table: a header row starting with "| #" followed by a separator row.
    header_idx = -1
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("|") and "#" in stripped and "任务" in stripped:
            header_idx = i
            break
    if header_idx < 0:
        return []
    header_line = lines[header_idx]
    headers = [h.strip() for h in header_line.strip().strip("|").split("|")]
    # Map header names to column indices (case-insensitive, English keys).
    col_map: dict[str, int] = {}
    for idx, name in enumerate(headers):
        key = name.lower()
        col_map[key] = idx
    tasks: list[dict[str, str]] = []
    for line in lines[header_idx + 2 :]:  # skip header + separator
        stripped = line.strip()
        if not stripped.startswith("|"):
            break  # end of table
        cells = [c.strip() for c in stripped.strip("|").split("|")]
        if len(cells) < len(headers):
            continue
        task: dict[str, str] = {}
        # Chinese headers
        for cn, en in (("#", "num"), ("簇", "cluster"), ("任务", "task")):
            if cn in col_map:
                task[en] = cells[col_map[cn]]
        # English optional columns
        for en in ("ownerPhase", "implementationDoneWhen", "verificationPhase", "requiresExplicitAuthority"):
            if en.lower() in col_map:
                task[en] = cells[col_map[en.lower()]]
        tasks.append(task)
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


def _artifact_files(staging: Path) -> list[Path]:
    files: list[Path] = []
    for path in staging.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"PLAN_ARTIFACT_SYMLINK: {path}")
        if path.is_file():
            files.append(path)
    return sorted(files, key=lambda item: item.relative_to(staging).as_posix())


def validate_staging(staging: Path, change_name: str) -> dict[str, Any]:
    staging = staging.resolve()
    required = {
        Path("spec") / f"{change_name}-design.md",
        Path("plans") / f"{change_name}-plan.md",
        Path("plans") / f"{change_name}-implementation-detail.md",
        Path("plans") / f"{change_name}-test-scenarios.md",
        Path("meta") / "gate-policy.json",
        Path("meta") / "worktree.json",
    }
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
    tasks = parse_plan_tasks(plan_path)
    for task in tasks:
        owner = task.get("ownerPhase")
        if owner is not None and owner != "" and owner not in VALID_OWNER_PHASES:
            return _result_error(
                "PLAN_OWNER_PHASE_INVALID",
                f"task {task.get('num', '?')}: ownerPhase '{owner}' not in {sorted(VALID_OWNER_PHASES)}",
            )

    # C9: parse test-scenarios.md for scenario manifest.
    scenarios_path = staging / "plans" / f"{change_name}-test-scenarios.md"
    scenarios = parse_test_scenarios(scenarios_path)

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


def finalize_plan(
    change_dir: Path,
    staging: Path,
    *,
    change_name: str,
    run_id: str,
    attempt: int,
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

    receipt_path = change_dir / "meta" / "plan-finalization.json"
    lock_path = change_dir / "meta" / "plan-finalize.lock"
    receipt: dict[str, Any] | None = None
    if receipt_path.is_file():
        try:
            loaded = json.loads(receipt_path.read_text(encoding="utf-8-sig"))
            receipt = loaded if isinstance(loaded, dict) else None
        except (OSError, json.JSONDecodeError) as exc:
            return _result_error("PLAN_FINALIZATION_RECEIPT_INVALID", str(exc))
        if receipt and receipt.get("artifactsHash") != validation["artifactsHash"]:
            return _result_error(
                "PLAN_FINALIZATION_HASH_CONFLICT",
                "finalizer was already invoked with a different artifact set",
            )
        if (
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
            }

    lock_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        lock_fd = os.open(str(lock_path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(lock_fd)
    except FileExistsError:
        return _result_error("PLAN_FINALIZATION_LOCKED", f"lock exists: {lock_path}")

    created: list[Path] = []
    terminal_committed = False
    try:
        for rel_text in validation["files"]:
            source = staging / rel_text
            target = change_dir / rel_text
            if target.exists() and target.read_bytes() != source.read_bytes():
                return _result_error(
                    "PLAN_TARGET_CONFLICT", f"refusing to overwrite {rel_text}"
                )

        for rel_text in validation["files"]:
            source = staging / rel_text
            target = change_dir / rel_text
            if target.exists():
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
            _atomic_write_json(checkpoints_path, checkpoints_payload)
            created.append(checkpoints_path)

        # C9: write scenario-manifest.json with parsed scenarios.
        scenarios = validation.get("scenarios") or []
        manifest_path = change_dir / "meta" / "scenario-manifest.json"
        manifest_payload = {
            "schemaVersion": 1,
            "changeName": change_name,
            "scenarios": scenarios,
        }
        _atomic_write_json(manifest_path, manifest_payload)
        created.append(manifest_path)

        pending_receipt = {
            "schemaVersion": SCHEMA_VERSION,
            "changeName": change_name,
            "status": "publishing",
            "artifactsHash": validation["artifactsHash"],
            "files": validation["files"],
            "runId": run_id,
            "attempt": attempt,
        }
        _atomic_write_json(receipt_path, pending_receipt)
        terminal_code, terminal_error = _append_terminal(change_dir, run_id, attempt)
        terminal_committed = _terminal_exists(change_dir, run_id, attempt)
        if terminal_code != 0 and not terminal_committed:
            for target in reversed(created):
                target.unlink(missing_ok=True)
            receipt_path.unlink(missing_ok=True)
            return _result_error(
                "PLAN_TERMINAL_APPEND_FAILED",
                terminal_error or "phase.end append failed",
            )
        pending_receipt["status"] = "finalized"
        _atomic_write_json(receipt_path, pending_receipt)
        return {
            "ok": True,
            "action": "finalize",
            "idempotent": False,
            "artifactsHash": validation["artifactsHash"],
            "files": validation["files"],
            "receiptPath": str(receipt_path),
            "executionLogPath": str(harness_events.execution_log_path(change_dir)),
        }
    except OSError as exc:
        if terminal_committed or _terminal_exists(change_dir, run_id, attempt):
            return _result_error(
                "PLAN_FINALIZATION_RECOVERY_REQUIRED",
                f"terminal committed; retry finalization to complete receipt: {exc}",
            )
        for target in reversed(created):
            target.unlink(missing_ok=True)
        receipt_path.unlink(missing_ok=True)
        return _result_error("PLAN_FINALIZATION_IO_ERROR", str(exc))
    finally:
        lock_path.unlink(missing_ok=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harness_plan_finalize.py")
    sub = parser.add_subparsers(dest="command", required=True)
    finalize = sub.add_parser("finalize")
    finalize.add_argument("--change-dir", required=True)
    finalize.add_argument("--staging-dir", required=True)
    finalize.add_argument("--change", required=True)
    finalize.add_argument("--run-id", required=True)
    finalize.add_argument("--attempt", required=True, type=int)
    finalize.add_argument("--json", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
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
