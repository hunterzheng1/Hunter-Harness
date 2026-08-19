#!/usr/bin/env python3
"""Harness archive finalize / status / replay (D3).

Subcommands:
  status   — pre-archive gate checks (read-only)
  finalize — single-process archive: manifest → move → collect → validate →
             after-manifest → publish → ZIP upload/service
  replay   — read-only re-collect + validate for historical archives

Python 3.10+, stdlib only. UTF-8 without BOM. Windows path safe.
Depends on P0-1 harness_events.py. Knowledge ingest is owned by Hunter Platform.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import io
import ipaddress
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
import zipfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


SCRIPTS_DIR = Path(__file__).resolve().parent
SKILLS_ROOT = SCRIPTS_DIR.parent
SUMMARY_TEMPLATE = (
    SKILLS_ROOT / "harness-archive" / "templates" / "summary-data-template.json"
)
SERVICE_SCRIPT = SCRIPTS_DIR / "harness_service.py"

# Manifest compare must ignore self-mutating log files appended during finalize.
MANIFEST_COMPARE_EXCLUDE = frozenset(
    {
        "logs/execution-log.md",
        "execution-log.md",
        "events.ndjson",
        "evidence/archive-manifest-after.json",
    }
)

SCHEMA_VERSION = "2.3"
NOT_AVAILABLE = "not_available"

# Compiled once for evidence-text count fallbacks in _ledger_unit_tests / _ledger_api_tests.
_RE_UNIT_COUNTS = re.compile(
    r"Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)"
)
_RE_API_PASSED = re.compile(r"(\d+)/(\d+)\s*passed", re.I)
_RE_RESULT_FRACTION = re.compile(
    r"(\d{1,7})\s*/\s*(\d{1,7})(?=\s*(?:passed|通过|[（(]|$))",
    re.I,
)


def _result_fraction(value: str) -> tuple[int, int] | None:
    match = _RE_RESULT_FRACTION.search(value)
    if match is None:
        return None
    passed = int(match.group(1))
    total = int(match.group(2))
    if total <= 0 or passed > total:
        return None
    return passed, total

# Ensure sibling harness_events is importable.
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_events as he  # noqa: E402
import harness_events_sync as hes  # noqa: E402
import harness_efficiency as heff  # noqa: E402
import harness_gate as hgate  # noqa: E402
import harness_knowledge_candidates as hkc  # noqa: E402
import harness_ledger as hl  # noqa: E402
import harness_paths as hp  # noqa: E402
import harness_phase as hphase  # noqa: E402
import harness_report_model as hrm  # noqa: E402
import harness_review as hr  # noqa: E402
import harness_runtime as hruntime  # noqa: E402


# ---------------------------------------------------------------------------
# I/O helpers
# ---------------------------------------------------------------------------


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="milliseconds")


def today_date() -> str:
    return dt.date.today().isoformat()


def emit_json(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


def emit_error(message: str, *, as_json: bool, extra: dict[str, Any] | None = None) -> int:
    payload: dict[str, Any] = {"ok": False, "error": message}
    if extra:
        payload.update(extra)
    if as_json:
        sys.stderr.write(json.dumps(payload, ensure_ascii=False) + "\n")
    else:
        sys.stderr.write(f"error: {message}\n")
    return 1


def resolve_path(raw: str) -> Path:
    return Path(raw).expanduser().resolve()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    # 强制 LF，UTF-8 无 BOM；原子写 temp+os.replace（与 runtime-helpers.mjs 一致）。
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(text, encoding="utf-8", newline="\n")
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def find_project_root(change_or_archive_dir: Path) -> Path:
    """Resolve project root from .harness/changes|archive/<name>."""
    p = change_or_archive_dir.resolve()
    if p.parent.name in {"changes", "archive"} and p.parent.parent.name == ".harness":
        return p.parent.parent.parent
    # Fallback: walk up looking for .harness
    for parent in p.parents:
        if (parent / ".harness").is_dir():
            return parent
    return p.parent


def infer_change_name(dir_path: Path) -> str:
    name = dir_path.name
    m = re.match(r"^(\d{4}-\d{2}-\d{2})-(.+)$", name)
    if m:
        return m.group(2)
    return name


def resolve_archive_state_root(change_dir: Path) -> Path:
    """Resolve the dynamic state view shared by status, certify and finalize."""
    change_dir = change_dir.resolve()
    return hp.resolve_state_dir_for_contract(
        change_dir,
        find_project_root(change_dir),
    ).resolve()


def archive_read_roots(change_dir: Path) -> list[Path]:
    """Return dynamic state first and the immutable contract as fallback."""
    contract = change_dir.resolve()
    state = resolve_archive_state_root(contract)
    return [state] if state == contract else [state, contract]


def _first_archive_path(change_dir: Path, relative: str) -> Path | None:
    for root in archive_read_roots(change_dir):
        candidate = root / relative
        if candidate.is_file():
            return candidate
    return None


def _archive_path_label(change_dir: Path, path: Path) -> str:
    for root in archive_read_roots(change_dir):
        try:
            return path.resolve().relative_to(root).as_posix()
        except ValueError:
            continue
    return path.name


def load_template() -> dict[str, Any]:
    if SUMMARY_TEMPLATE.is_file():
        data = read_json(SUMMARY_TEMPLATE)
        if isinstance(data, dict):
            return data
    return {"schemaVersion": SCHEMA_VERSION}


# ---------------------------------------------------------------------------
# Events append (reuse P0-1)
# ---------------------------------------------------------------------------


def append_event(
    change_dir: Path,
    *,
    phase: str,
    type_: str,
    **fields: Any,
) -> dict[str, Any]:
    """Append one event via harness_events primitives and re-render execution-log."""
    path = he.events_path(change_dir)
    existing = he.load_events(path) if path.exists() else []
    event: dict[str, Any] = {
        "schema_version": he.SCHEMA_VERSION,
        "id": he.new_event_id(existing),
        "timestamp": now_iso(),
        "phase": phase,
        "type": type_,
        "note": "",
    }
    for key, value in fields.items():
        if value is not None:
            event[key] = value
    result = he.append_with_auto_seal(path, event, existing_events=existing)
    event = result["event"]
    all_events = he.load_events(path)
    he.write_execution_log(change_dir, he.render_execution_log(all_events))
    return event


# ---------------------------------------------------------------------------
# Manifest (Python port of gen-manifest.ps1)
# ---------------------------------------------------------------------------


def generate_manifest(root: Path, output_path: Path) -> dict[str, Any]:
    """Build path/size/sha256 manifest; exclude the output file itself."""
    root = root.resolve()
    # Compare by relative path, not by resolve() per file: on Windows every
    # resolve() is a realpath syscall, and this loop runs over the whole tree.
    exclude_rel: str | None = None
    try:
        exclude_rel = output_path.resolve().relative_to(root).as_posix()
    except (OSError, ValueError):
        exclude_rel = None

    files: list[dict[str, Any]] = []
    total_bytes = 0
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        if path.name.endswith(".lock"):
            continue
        rel = path.relative_to(root).as_posix()
        if exclude_rel is not None and rel == exclude_rel:
            continue
        size = path.stat().st_size
        total_bytes += size
        files.append(
            {
                "path": rel,
                "sizeBytes": size,
                "sha256": sha256_file(path),
            }
        )

    result = {
        "root": str(root),
        "generatedAt": dt.datetime.now().isoformat(timespec="seconds"),
        "fileCount": len(files),
        "totalBytes": total_bytes,
        "files": files,
    }
    write_json(output_path, result)
    return result


def _manifest_path_excluded(rel: str) -> bool:
    norm = rel.replace("\\", "/")
    if norm in MANIFEST_COMPARE_EXCLUDE:
        return True
    if norm == "events.ndjson" or norm.endswith("/events.ndjson"):
        return True
    if norm.endswith("execution-log.md"):
        return True
    return False


def _manifest_index(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for item in manifest.get("files") or []:
        if not isinstance(item, dict):
            continue
        rel = str(item.get("path") or "").replace("\\", "/")
        if not rel or _manifest_path_excluded(rel):
            continue
        out[rel] = item
    return out


def compare_manifests(
    before: dict[str, Any],
    after: dict[str, Any],
) -> dict[str, Any]:
    """Compare before/after; exclude execution-log / events self-appends.

    Files only in after are treated as generated (OK).
    Files in before missing or hash-mismatched in after are errors.
    """
    b_idx = _manifest_index(before)
    a_idx = _manifest_index(after)

    missing: list[str] = []
    mismatched: list[dict[str, str]] = []
    for rel, b_item in b_idx.items():
        a_item = a_idx.get(rel)
        if a_item is None:
            missing.append(rel)
            continue
        if str(a_item.get("sha256")) != str(b_item.get("sha256")):
            mismatched.append(
                {
                    "path": rel,
                    "before": str(b_item.get("sha256")),
                    "after": str(a_item.get("sha256")),
                }
            )

    generated = sorted(set(a_idx) - set(b_idx))
    moved_ok = len(b_idx) - len(missing) - len(mismatched)
    ok = not missing and not mismatched
    return {
        "ok": ok,
        "movedFiles": moved_ok,
        "generatedFiles": len(generated),
        "totalArchiveFiles": int(after.get("fileCount") or len(a_idx)),
        "missing": missing,
        "mismatched": mismatched,
        "generated": generated,
        "checksumStatus": "OK" if ok else "FAIL",
    }


# ---------------------------------------------------------------------------
# Evidence loaders
# ---------------------------------------------------------------------------


def load_ledger(change_dir: Path) -> dict[str, Any] | None:
    for root in archive_read_roots(change_dir):
        for rel in (
            "evidence/verification-ledger.json",
            "verification-ledger.json",
        ):
            path = root / rel
            if not path.is_file():
                continue
            try:
                data = read_json(path)
                return data if isinstance(data, dict) else None
            except (OSError, json.JSONDecodeError):
                return None
    return None


def load_ci_metrics(change_dir: Path) -> tuple[dict[str, Any] | None, str | None]:
    """Load schema-versioned runner metrics without parsing human CI logs."""
    for root in archive_read_roots(change_dir):
        for relative in ("evidence/ci-metrics.json", "runtime/ci-metrics.json"):
            path = root / relative
            if not path.is_file():
                continue
            value = read_json(path)
            if value.get("schemaVersion") != 1:
                raise ValueError(f"unsupported ci-metrics schema: {path}")
            return value, relative
    return None, None


def build_remote_cost_summary(metrics: dict[str, Any] | None) -> dict[str, Any]:
    """Aggregate typed remote runner/storage costs by candidate identity."""
    value = metrics if isinstance(metrics, dict) else {}
    raw_runs = value.get("runs")
    if isinstance(raw_runs, list):
        runs = [item for item in raw_runs if isinstance(item, dict)]
    elif any(
        field in value
        for field in (
            "runnerMinutes",
            "queueWaitMs",
            "artifactBytes",
            "duplicateRunReason",
        )
    ):
        runs = [value]
    else:
        runs = []

    candidates: dict[str, dict[str, Any]] = {}
    for run in runs:
        subject = run.get("subject")
        subject = subject if isinstance(subject, dict) else {}
        candidate_id = str(
            run.get("candidateId")
            or subject.get("candidateId")
            or subject.get("productCommit")
            or "unattributed"
        ).strip()
        row = candidates.setdefault(
            candidate_id,
            {
                "candidateId": candidate_id,
                "runCount": 0,
                "runnerMinutes": 0.0,
                "queueWaitMs": 0,
                "artifactBytes": 0,
                "duplicateRunCount": 0,
                "duplicateRunReasons": [],
            },
        )
        row["runCount"] += 1
        row["runnerMinutes"] += max(0.0, float(run.get("runnerMinutes") or 0))
        row["queueWaitMs"] += max(0, int(run.get("queueWaitMs") or 0))
        row["artifactBytes"] += max(0, int(run.get("artifactBytes") or 0))
        reason = str(run.get("duplicateRunReason") or "").strip()
        if reason:
            row["duplicateRunCount"] += 1
            if reason not in row["duplicateRunReasons"]:
                row["duplicateRunReasons"].append(reason)

    items = sorted(candidates.values(), key=lambda item: item["candidateId"])
    for item in items:
        item["runnerMinutes"] = round(float(item["runnerMinutes"]), 3)
    totals = {
        "runCount": sum(int(item["runCount"]) for item in items),
        "runnerMinutes": round(
            sum(float(item["runnerMinutes"]) for item in items),
            3,
        ),
        "queueWaitMs": sum(int(item["queueWaitMs"]) for item in items),
        "artifactBytes": sum(int(item["artifactBytes"]) for item in items),
        "duplicateRunCount": sum(
            int(item["duplicateRunCount"]) for item in items
        ),
    }
    return {
        "schemaVersion": 1,
        "available": bool(runs),
        "candidates": items,
        "totals": totals,
    }


def _legacy_candidate_path(change_dir: Path) -> Path | None:
    for relative in (
        "evidence/product-candidate-ci.json",
        "meta/product-candidate-ci.json",
        "runtime/product-candidate-ci.json",
    ):
        path = change_dir / relative
        if path.is_file():
            return path
    return None


def _remote_ci_history_present(change_dir: Path) -> bool:
    if _legacy_candidate_path(change_dir) is not None:
        return True
    ledger = load_ledger(change_dir) or {}
    if any(key in ledger for key in ("productCandidateCi", "product_candidate_ci")):
        return True
    validations = (
        ledger.get("validations")
        if isinstance(ledger.get("validations"), dict)
        else {}
    )
    return any(
        key in validations
        for key in ("productCandidateCi", "product_candidate_ci", "candidateCi")
    )


def load_product_candidate_ci(change_dir: Path) -> dict[str, Any] | None:
    """Load platform-neutral candidate evidence, then legacy CI evidence."""
    for relative in (
        "evidence/product-candidate-verification.json",
        "meta/product-candidate-verification.json",
        "runtime/product-candidate-verification.json",
    ):
        path = _first_archive_path(change_dir, relative)
        if path is None:
            continue
        try:
            data = read_json(path)
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(data, dict) and data.get("schemaVersion") == 2:
            return data

    # Legacy schema remains readable so existing projects do not need an
    # immediate migration. It represents a remote claim, not an attestation.
    legacy_path = _legacy_candidate_path(change_dir)
    if legacy_path is not None:
        try:
            data = read_json(legacy_path)
        except (OSError, json.JSONDecodeError):
            data = None
        if isinstance(data, dict) and data.get("schemaVersion") == 1:
            return data
    ledger = load_ledger(change_dir) or {}
    for key in ("productCandidateCi", "product_candidate_ci"):
        value = ledger.get(key)
        if isinstance(value, dict):
            return {"schemaVersion": 1, **value}
    validations = ledger.get("validations") if isinstance(ledger.get("validations"), dict) else {}
    for key in ("productCandidateCi", "product_candidate_ci", "candidateCi"):
        value = validations.get(key) if isinstance(validations, dict) else None
        if isinstance(value, dict):
            return {"schemaVersion": 1, **value}
    return None


def evaluate_product_ci_gate(change_dir: Path) -> dict[str, Any]:
    """Evaluate whether candidate evidence is release-capable.

    Evidence validity and release authority are deliberately separate. A
    ``remote-claimed`` receipt remains useful for audit/migration, but can
    never authorize release. Local evidence requires an explicit project
    opt-in; remote-required projects require a subject/environment-bound,
    provider-verified immutable run.
    """
    evidence = load_product_candidate_ci(change_dir)
    if evidence is None:
        return {
            "ok": False,
            "code": "PRODUCT_CI_NOT_GREEN",
            "message": (
                "missing product-candidate CI evidence "
                "(need evidence/product-candidate-ci.json with conclusion=success, "
                "runUrl, commit)"
            ),
            "releaseCapable": False,
            "evidenceValid": False,
            "evidence": None,
        }

    if evidence.get("schemaVersion") == 2:
        conclusion = str(evidence.get("conclusion") or "").strip().lower()
        provider = str(evidence.get("provider") or "").strip()
        assurance = str(evidence.get("assurance") or "").strip()
        subject = evidence.get("subject")
        verification = evidence.get("verification")
        subject = subject if isinstance(subject, dict) else {}
        verification = verification if isinstance(verification, dict) else {}
        product_commit = str(subject.get("productCommit") or "").strip()
        product_tree_hash = str(subject.get("productTreeHash") or "").strip()
        environment_hash = str(subject.get("environmentHash") or "").strip()
        command_set_hash = str(verification.get("commandSetHash") or "").strip()
        ledger_hash = str(verification.get("ledgerHash") or "").strip()
        common_required_fields = {
            "provider": provider,
            "assurance": assurance,
            "subject.productCommit": product_commit,
            "subject.productTreeHash": product_tree_hash,
        }
        policy = load_gate_policy(change_dir) or {}
        candidate_policy = policy.get("candidateVerification")
        candidate_policy = (
            candidate_policy if isinstance(candidate_policy, dict) else {}
        )
        minimum_assurance = str(
            candidate_policy.get("minimumAssurance") or "local-reproducible"
        ).strip()
        remote_required = bool(candidate_policy.get("remoteRequired")) or (
            minimum_assurance == "remote-attested"
        )
        allow_local_release = bool(candidate_policy.get("allowLocalRelease"))
        declared_capabilities = {
            str(item).strip()
            for item in (evidence.get("capabilities") or [])
            if isinstance(item, str) and item.strip()
        }
        capabilities = set(declared_capabilities)
        if (
            provider == "local-harness"
            and _remote_ci_history_present(change_dir)
            and not bool(candidate_policy.get("allowLocalFallback"))
        ):
            return {
                "ok": False,
                "code": "REMOTE_CI_DOWNGRADE_REFUSED",
                "message": (
                    "remote CI history exists; local-harness evidence requires "
                    "candidateVerification.allowLocalFallback=true"
                ),
                "assurance": assurance,
                "releaseCapable": False,
                "evidenceValid": False,
                "evidence": evidence,
            }

        if conclusion not in {
            "success",
            "successful",
            "passed",
            "pass",
            "green",
            "ok",
        }:
            return {
                "ok": False,
                "code": "PRODUCT_CANDIDATE_NOT_VERIFIED",
                "message": (
                    f"product candidate conclusion={conclusion or 'unknown'} "
                    f"provider={provider or 'unknown'}"
                ),
                "assurance": assurance,
                "releaseCapable": False,
                "evidenceValid": False,
                "evidence": evidence,
            }

        if assurance == "remote-claimed":
            attestation = evidence.get("attestation")
            attestation = attestation if isinstance(attestation, dict) else {}
            required_fields = {
                **common_required_fields,
                "attestation.url": attestation.get("url"),
                "verification.legacyEvidenceHash": (
                    verification.get("legacyEvidenceHash") or ledger_hash
                ),
            }
            missing = [
                name for name, value in required_fields.items() if not value
            ]
            if missing:
                return {
                    "ok": False,
                    "code": "PRODUCT_CANDIDATE_NOT_VERIFIED",
                    "message": (
                        "remote claim is incomplete: " + ", ".join(missing)
                    ),
                    "assurance": assurance,
                    "releaseCapable": False,
                    "evidenceValid": False,
                    "capabilities": sorted(capabilities),
                    "evidence": evidence,
                }
            return {
                "ok": False,
                "code": "PRODUCT_CANDIDATE_RECORD_ONLY",
                "message": (
                    "remote-claimed evidence is audit-only and cannot authorize release"
                ),
                "assurance": assurance,
                "releaseCapable": False,
                "evidenceValid": True,
                "recordOnly": True,
                "capabilities": sorted(capabilities),
                "evidence": evidence,
            }

        if assurance == "local-reproducible" and provider == "local-harness":
            local_required = {
                "subject.environmentHash": environment_hash,
                "verification.commandSetHash": command_set_hash,
                "verification.ledgerHash": ledger_hash,
                "verification.toolchainHashes": verification.get("toolchainHashes"),
                "verification.environmentHashes": verification.get("environmentHashes"),
                "verification.dependencyHashes": verification.get("dependencyHashes"),
                "verification.logHashes": verification.get("logHashes"),
            }
            required_fields = {**common_required_fields, **local_required}
            missing = [
                name for name, value in required_fields.items() if not value
            ]
            if missing:
                return {
                    "ok": False,
                    "code": "PRODUCT_CANDIDATE_NOT_VERIFIED",
                    "message": (
                        "candidate evidence missing or invalid: "
                        + ", ".join(missing)
                    ),
                    "assurance": assurance,
                    "releaseCapable": False,
                    "evidenceValid": False,
                    "evidence": evidence,
                }
            capabilities.update(
                {
                    "subject-bound",
                    "locally-reproducible",
                    "environment-bound",
                }
            )
            if remote_required:
                return {
                    "ok": False,
                    "code": "PROJECT_RELEASE_POLICY_BLOCKED",
                    "message": (
                        "project requires remote-attested candidate evidence"
                    ),
                    "assurance": assurance,
                    "releaseCapable": False,
                    "evidenceValid": True,
                    "capabilities": sorted(capabilities),
                    "evidence": evidence,
                }
            if not allow_local_release:
                return {
                    "ok": False,
                    "code": "PROJECT_RELEASE_POLICY_BLOCKED",
                    "message": (
                        "local-reproducible evidence requires explicit "
                        "candidateVerification.allowLocalRelease=true"
                    ),
                    "assurance": assurance,
                    "releaseCapable": False,
                    "evidenceValid": True,
                    "capabilities": sorted(capabilities),
                    "evidence": evidence,
                }
            return {
                "ok": True,
                "code": "PRODUCT_CANDIDATE_VERIFIED",
                "message": (
                    "local reproducible candidate explicitly authorized by project policy "
                    f"commit={product_commit}"
                ),
                "assurance": assurance,
                "releaseCapable": True,
                "evidenceValid": True,
                "capabilities": sorted(capabilities),
                "evidence": evidence,
            }

        if assurance == "remote-attested" and provider == "remote-ci":
            attestation = evidence.get("attestation")
            attestation = attestation if isinstance(attestation, dict) else {}
            required_fields = {
                **common_required_fields,
                "subject.environmentHash": environment_hash,
                "attestation.url": attestation.get("url"),
                "attestation.providerRunDigest": attestation.get(
                    "providerRunDigest"
                ),
                "verification.attestationDigest": verification.get(
                    "attestationDigest"
                ),
            }
            missing = [
                name for name, value in required_fields.items() if not value
            ]
            if missing:
                return {
                    "ok": False,
                    "code": "PRODUCT_CANDIDATE_NOT_VERIFIED",
                    "message": (
                        "candidate evidence missing or invalid: "
                        + ", ".join(missing)
                    ),
                    "assurance": assurance,
                    "releaseCapable": False,
                    "evidenceValid": False,
                    "capabilities": sorted(capabilities),
                    "evidence": evidence,
                }
            capabilities.update(
                {
                    "subject-bound",
                    "provider-verified",
                    "immutable-run",
                    "environment-bound",
                }
            )
            required_capabilities = candidate_policy.get(
                "requiredCapabilities"
            )
            if not isinstance(required_capabilities, list):
                required_capabilities = (
                    [
                        "subject-bound",
                        "provider-verified",
                        "immutable-run",
                        "environment-bound",
                    ]
                    if remote_required
                    else []
                )
            missing_capabilities = sorted(
                {
                    str(item).strip()
                    for item in required_capabilities
                    if isinstance(item, str) and item.strip()
                }
                - capabilities
            )
            if missing_capabilities:
                return {
                    "ok": False,
                    "code": "PRODUCT_CANDIDATE_NOT_VERIFIED",
                    "message": (
                        "candidate capabilities missing: "
                        + ", ".join(missing_capabilities)
                    ),
                    "assurance": assurance,
                    "releaseCapable": False,
                    "evidenceValid": False,
                    "capabilities": sorted(capabilities),
                    "evidence": evidence,
                }
            return {
                "ok": True,
                "code": "PRODUCT_CANDIDATE_VERIFIED",
                "message": (
                    "remote candidate attested "
                    f"provider={provider} commit={product_commit}"
                ),
                "assurance": assurance,
                "releaseCapable": True,
                "evidenceValid": True,
                "capabilities": sorted(capabilities),
                "evidence": evidence,
            }

        return {
            "ok": False,
            "code": "PRODUCT_CANDIDATE_NOT_VERIFIED",
            "message": (
                "candidate provider/assurance combination is invalid: "
                f"provider={provider or 'unknown'} assurance={assurance or 'unknown'}"
            ),
            "assurance": assurance,
            "releaseCapable": False,
            "evidenceValid": False,
            "capabilities": sorted(capabilities),
            "evidence": evidence,
        }

    conclusion = str(
        evidence.get("conclusion") or evidence.get("status") or ""
    ).strip().lower()
    run_url = str(evidence.get("runUrl") or evidence.get("url") or "").strip()
    commit = str(evidence.get("commit") or evidence.get("headSha") or "").strip()
    if conclusion in {"success", "successful", "passed", "pass", "green", "ok"}:
        # Review Y1: success alone is insufficient — runUrl + commit are required.
        if not run_url or not commit:
            return {
                "ok": False,
                "code": "PRODUCT_CI_NOT_GREEN",
                "message": (
                    "product candidate CI conclusion is success but missing "
                    f"runUrl={run_url or 'empty'} commit={commit or 'empty'}"
                ),
                "releaseCapable": False,
                "evidenceValid": False,
                "evidence": evidence,
            }
        return {
            "ok": False,
            "code": "PRODUCT_CANDIDATE_RECORD_ONLY",
            "message": (
                "legacy CI success is a remote claim only; migrate/attest before release "
                f"commit={commit} url={run_url}"
            ),
            "releaseCapable": False,
            "evidenceValid": True,
            "recordOnly": True,
            "assurance": "remote-claimed",
            "evidence": evidence,
        }
    return {
        "ok": False,
        "code": "PRODUCT_CI_NOT_GREEN",
        "message": (
            f"product candidate CI conclusion={conclusion or 'unknown'} "
            f"commit={commit or 'unknown'} runUrl={run_url or 'unknown'}"
        ),
        "releaseCapable": False,
        "evidenceValid": False,
        "evidence": evidence,
    }


def _candidate_value_hash(value: Any) -> str:
    encoded = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _candidate_evidence_hash(change_dir: Path, value: Any) -> str:
    if isinstance(value, str) and value.strip():
        raw = Path(value.strip())
        candidates = [raw] if raw.is_absolute() else [
            root / raw for root in archive_read_roots(change_dir)
        ]
        for candidate in candidates:
            try:
                resolved = candidate.resolve()
                if not any(
                    resolved.is_relative_to(root.resolve())
                    for root in archive_read_roots(change_dir)
                ):
                    continue
            except OSError:
                continue
            if resolved.is_file():
                return f"sha256:{sha256_file(resolved)}"
    return _candidate_value_hash(value)


def migrate_legacy_candidate_evidence(
    change_dir: Path,
    *,
    project: Path | None = None,
) -> dict[str, Any]:
    """Convert legacy CI JSON into an explicit remote-claimed v2 receipt."""
    change_dir = change_dir.resolve()
    legacy_path = _legacy_candidate_path(change_dir)
    if legacy_path is None:
        raise ValueError("legacy product-candidate-ci.json missing")
    legacy = read_json(legacy_path)
    if not isinstance(legacy, dict) or legacy.get("schemaVersion") != 1:
        raise ValueError("legacy product-candidate-ci.json is invalid")
    conclusion = str(
        legacy.get("conclusion") or legacy.get("status") or ""
    ).strip().lower()
    commit = str(legacy.get("commit") or legacy.get("headSha") or "").strip()
    run_url = str(legacy.get("runUrl") or legacy.get("url") or "").strip()
    if conclusion not in {
        "success",
        "successful",
        "passed",
        "pass",
        "green",
        "ok",
    }:
        raise ValueError(f"legacy CI conclusion is not successful: {conclusion}")
    if not commit or not run_url:
        raise ValueError("legacy CI evidence requires commit and runUrl")
    project_root = (project or find_project_root(change_dir)).resolve()
    tree_detail = compute_product_tree_hash_detail(project_root)
    if tree_detail.get("truncated"):
        raise ValueError("product tree hash truncated during legacy migration")
    receipt = {
        "schemaVersion": 2,
        "provider": "remote-ci",
        "conclusion": "success",
        "assurance": "remote-claimed",
        "recordedAt": now_iso(),
        "subject": {
            "productCommit": commit,
            "productTreeHash": f"sha256:{tree_detail['hash']}",
        },
        "attestation": {
            "url": run_url,
            "source": "legacy-product-candidate-ci",
        },
        "verification": {
            "legacyEvidenceHash": f"sha256:{sha256_file(legacy_path)}",
        },
        "migration": {
            "fromSchemaVersion": 1,
            "sourcePath": legacy_path.relative_to(change_dir).as_posix(),
        },
    }
    write_json(
        change_dir / "evidence" / "product-candidate-verification.json",
        receipt,
    )
    return receipt


# 声明必须是具体的错误签名，不能是能匹配一切的短串。这个下限不是"安全边界"
# ——审计线索才是——但它挡住最省事的滥用写法。
_PREEXISTING_MIN_PATTERN = 8


def _known_preexisting_patterns(
    project_root: Path,
) -> tuple[list[dict[str, str]], list[dict[str, str]]]:
    """build-profile 里声明的预存失败签名，按"是否足够具体"分成两组。

    `knownPreexistingErrors` 由 `harness_preflight.py record-quirk --action
    skip-not-block` 写入，此前没有任何消费方——于是预存失败在 certify-local 处
    成为死结：要么去 gate-policy 降门禁，要么顺手改范围外的产品 bug。
    """
    path = project_root / ".harness" / "config" / "build-profile.json"
    if not path.is_file():
        return [], []
    try:
        profile = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return [], []
    declared = profile.get("knownPreexistingErrors") if isinstance(profile, dict) else None
    if not isinstance(declared, list):
        return [], []
    usable: list[dict[str, str]] = []
    vague: list[dict[str, str]] = []
    for item in declared:
        if not isinstance(item, dict) or item.get("action") != "skip-not-block":
            continue
        pattern = str(item.get("pattern") or "").strip()
        reason = str(item.get("reason") or "").strip()
        if not pattern or not reason:
            continue
        record = {"pattern": pattern, "reason": reason}
        (usable if len(pattern) >= _PREEXISTING_MIN_PATTERN else vague).append(record)
    return usable, vague


def _match_preexisting(
    entry: dict[str, Any], patterns: list[dict[str, str]]
) -> dict[str, str] | None:
    """失败证据里是否确实出现了某个已声明签名。

    只看"声明过"是不够的——那等于声明一次豁免一切。必须是这一条失败的证据里
    真的带着该签名，声明与现场才对得上。
    """
    evidence = entry.get("evidence")
    haystack = evidence if isinstance(evidence, str) else json.dumps(
        evidence, ensure_ascii=False, sort_keys=True
    )
    for record in patterns:
        if record["pattern"] in haystack:
            return record
    return None


def certify_local_candidate(
    change_dir: Path,
    *,
    project: Path | None = None,
) -> dict[str, Any]:
    """Create a reproducible local receipt from existing ledger evidence.

    This function never executes verification commands. It deliberately reuses
    only complete, successful ledger entries so submit/archive do not rerun an
    identical full suite merely to produce candidate evidence.
    """
    change_dir = change_dir.resolve()
    project_root = (project or find_project_root(change_dir)).resolve()
    ledger = load_ledger(change_dir)
    if not isinstance(ledger, dict):
        raise ValueError("verification ledger missing")
    validations = ledger.get("validations")
    if not isinstance(validations, dict):
        raise ValueError("verification ledger validations missing")

    policy = load_gate_policy(change_dir) or {}
    candidate_policy = policy.get("candidateVerification")
    candidate_policy = (
        candidate_policy if isinstance(candidate_policy, dict) else {}
    )
    if (
        _remote_ci_history_present(change_dir)
        and not bool(candidate_policy.get("allowLocalFallback"))
    ):
        raise ValueError(
            "remote CI history exists; refusing silent local fallback "
            "(set candidateVerification.allowLocalFallback=true explicitly)"
        )
    required = candidate_policy.get("requiredValidations")
    if not isinstance(required, list) or not required:
        required = ["unitTestFull"]
    required = [str(item).strip() for item in required if str(item).strip()]

    usable_patterns, vague_patterns = _known_preexisting_patterns(project_root)

    selected: list[dict[str, Any]] = []
    exemptions: list[dict[str, Any]] = []
    for name in required:
        entry = validations.get(name)
        if not isinstance(entry, dict):
            raise ValueError(f"required validation missing: {name}")
        missing: list[str] = []
        exempted = None
        if str(entry.get("status") or "").upper() != "OK":
            exempted = _match_preexisting(entry, usable_patterns)
            if exempted is None:
                vague = _match_preexisting(entry, vague_patterns)
                if vague is not None:
                    raise ValueError(
                        f"required validation {name} failed and the declared "
                        f"knownPreexistingErrors pattern {vague['pattern']!r} is too "
                        "generic to identify it; declare the specific error signature "
                        f"(at least {_PREEXISTING_MIN_PATTERN} characters)"
                    )
                missing.append("status=OK")
        for field in (
            "command",
            "evidence",
            "inputsHash",
        ):
            if entry.get(field) in (None, "", [], {}):
                missing.append(field)
        if missing:
            raise ValueError(
                f"required validation {name} is incomplete: {', '.join(missing)}"
            )
        if exempted is not None:
            exemptions.append(
                {
                    "validation": name,
                    "status": str(entry.get("status") or "").upper(),
                    "pattern": exempted["pattern"],
                    "reason": exempted["reason"],
                }
            )
        selected.append(
            {
                "name": name,
                "command": entry.get("command"),
                "inputsHash": entry.get("inputsHash"),
                "toolchainHash": (
                    entry.get("toolchainHash")
                    or hl.default_toolchain_hash(project_root)
                ),
                "environmentHash": (
                    entry.get("environmentHash")
                    or hl.default_environment_hash(project_root)
                ),
                "inputsFiles": list(entry.get("inputsFiles") or []),
                "logHash": _candidate_evidence_hash(
                    change_dir, entry.get("evidence")
                ),
            }
        )

    ledger_path = _first_archive_path(
        change_dir, "evidence/verification-ledger.json"
    ) or _first_archive_path(change_dir, "verification-ledger.json")
    if ledger_path is None:
        raise ValueError("verification ledger path missing")

    product_commit = str(
        ledger.get("productCommit")
        or ledger.get("currentHead")
        or ledger.get("finalCommit")
        or ""
    ).strip()
    rc, current_head, _stderr = git_run(project_root, "rev-parse", "HEAD")
    rebound_from_commit: str | None = None
    if rc == 0 and current_head:
        if product_commit and not (
            current_head.startswith(product_commit)
            or product_commit.startswith(current_head)
        ):
            for item in selected:
                input_files = [str(path) for path in item.get("inputsFiles") or []]
                if not input_files:
                    raise ValueError(
                        "product commit is stale and validation inputs are unavailable: "
                        f"ledger={product_commit} current={current_head}"
                    )
                current_inputs_hash, _paths = hl.compute_inputs_hash(
                    hl.resolve_input_files(input_files, project_root),
                    project_root=project_root,
                )
                if current_inputs_hash != item.get("inputsHash"):
                    raise ValueError(
                        "product commit is stale and validated inputs changed: "
                        f"ledger={product_commit} current={current_head}"
                    )
            rebound_from_commit = product_commit
        product_commit = current_head
    if not product_commit:
        raise ValueError("product commit unavailable")

    detail = compute_product_tree_hash_for_commit(
        project_root, product_commit
    )
    if detail.get("truncated"):
        raise ValueError(
            "product tree hash truncated; narrow the project or raise the explicit limit"
        )
    current_tree_hash = f"sha256:{detail['hash']}"
    recorded_tree_hash = str(ledger.get("productTreeHash") or "").strip()
    if recorded_tree_hash and rebound_from_commit is None and recorded_tree_hash.removeprefix(
        "sha256:"
    ) != current_tree_hash.removeprefix("sha256:"):
        raise ValueError(
            "product tree is stale: "
            f"ledger={recorded_tree_hash} current={current_tree_hash}"
        )
    product_tree_hash = current_tree_hash
    environment_hashes = sorted(
        {str(item["environmentHash"]) for item in selected}
    )
    subject_environment_hash = (
        environment_hashes[0]
        if len(environment_hashes) == 1
        else _candidate_value_hash(environment_hashes)
    )

    receipt = {
        "schemaVersion": 2,
        "provider": "local-harness",
        "conclusion": "success",
        "assurance": "local-reproducible",
        "recordedAt": now_iso(),
        "subject": {
            "productCommit": product_commit,
            "productTreeHash": product_tree_hash,
            "environmentHash": subject_environment_hash,
        },
        "verification": {
            "requiredValidations": required,
            "reusedValidations": [item["name"] for item in selected],
            "commandSetHash": _candidate_value_hash(
                [item["command"] for item in selected]
            ),
            "ledgerHash": f"sha256:{sha256_file(ledger_path)}",
            "toolchainHashes": sorted(
                {str(item["toolchainHash"]) for item in selected}
            ),
            "environmentHashes": environment_hashes,
            "dependencyHashes": sorted(
                {str(item["inputsHash"]) for item in selected}
            ),
            "logHashes": sorted({str(item["logHash"]) for item in selected}),
            # 豁免必须随收据一起留痕，否则事后无法把它与干净通过区分开
            "preexistingExemptions": exemptions,
        },
    }
    if rebound_from_commit is not None:
        receipt["subject"]["reboundFromCommit"] = rebound_from_commit
        receipt["verification"]["commitReboundWithoutRerun"] = True
    write_json(
        resolve_archive_state_root(change_dir)
        / "evidence"
        / "product-candidate-verification.json",
        receipt,
    )
    return receipt


PRODUCT_TREE_HASH_FILE_LIMIT = 20_000
PRODUCT_TREE_EXCLUDED_PARTS = frozenset(
    {
        ".harness",
        ".git",
        ".worktrees",
        "node_modules",
        ".next",
        "dist",
        "coverage",
        "__pycache__",
        ".venv",
        "venv",
    }
)


def _product_path_included(relative_path: str) -> bool:
    parts = {part for part in relative_path.replace("\\", "/").split("/") if part}
    return not bool(parts & PRODUCT_TREE_EXCLUDED_PARTS)


def compute_product_tree_hash_detail(
    project: Path,
    *,
    file_limit: int = PRODUCT_TREE_HASH_FILE_LIMIT,
) -> dict[str, Any]:
    """Hash product tree excluding .harness/**; report truncation metadata (Y3)."""
    project = project.resolve()
    limit = max(1, int(file_limit))
    lines: list[str] = []
    truncated = False
    for root, dirs, files in os.walk(project, onerror=lambda _exc: None):
        dirs[:] = sorted(
            name for name in dirs if name not in PRODUCT_TREE_EXCLUDED_PARTS
        )
        for name in sorted(files):
            path = Path(root) / name
            try:
                rel = path.relative_to(project).as_posix()
            except ValueError:
                continue
            if not _product_path_included(rel):
                continue
            try:
                digest = sha256_file(path)
            except OSError:
                continue
            lines.append(f"{rel}:{digest}")
            if len(lines) >= limit:
                truncated = True
                break
        if truncated:
            break
    lines.sort()
    digest = hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()
    return {
        "hash": digest,
        "truncated": truncated,
        "fileCount": len(lines),
        "limit": limit,
        "source": "working-tree",
        "algorithm": "sha256-path-content-v1",
    }


def compute_product_tree_hash(
    project: Path,
    *,
    file_limit: int = PRODUCT_TREE_HASH_FILE_LIMIT,
) -> str:
    """Hash product tree excluding .harness/** governance paths."""
    return str(compute_product_tree_hash_detail(project, file_limit=file_limit)["hash"])


def compute_product_tree_hash_for_commit(
    project: Path,
    product_commit: str,
    *,
    file_limit: int = PRODUCT_TREE_HASH_FILE_LIMIT,
) -> dict[str, Any]:
    """Hash immutable Git commit contents using the product exclusion rules."""
    project = project.resolve()
    commit = str(product_commit or "").strip()
    if not commit:
        raise ValueError("product commit is required")
    exists, resolved_commit, error = git_run(
        project, "rev-parse", "--verify", f"{commit}^{{commit}}"
    )
    if exists != 0 or not resolved_commit:
        raise ValueError(
            f"product commit not found: {commit} ({error or 'git rev-parse failed'})"
        )
    try:
        archive = subprocess.run(
            [
                "git",
                "-C",
                str(project),
                "archive",
                "--format=tar",
                resolved_commit,
            ],
            capture_output=True,
            timeout=120,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValueError(f"could not read product commit tree: {exc}") from exc
    if archive.returncode != 0:
        detail = archive.stderr.decode("utf-8", errors="replace").strip()
        raise ValueError(
            f"could not read product commit tree {resolved_commit}: {detail}"
        )

    limit = max(1, int(file_limit))
    lines: list[str] = []
    truncated = False
    with tarfile.open(fileobj=io.BytesIO(archive.stdout), mode="r:") as stream:
        members = sorted(stream.getmembers(), key=lambda item: item.name)
        for member in members:
            relative = member.name.rstrip("/")
            if not relative or not _product_path_included(relative):
                continue
            if member.isfile():
                extracted = stream.extractfile(member)
                if extracted is None:
                    continue
                content = extracted.read()
            elif member.issym() or member.islnk():
                content = member.linkname.encode("utf-8")
            else:
                continue
            lines.append(
                f"{relative}:{hashlib.sha256(content).hexdigest()}"
            )
            if len(lines) >= limit:
                truncated = True
                break
    digest = hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()
    return {
        "hash": digest,
        "truncated": truncated,
        "fileCount": len(lines),
        "limit": limit,
        "source": "git-commit-tree",
        "algorithm": "sha256-path-content-v1",
        "productCommit": resolved_commit,
    }


def resolve_product_archive_identity(
    change_dir: Path,
    *,
    project: Path | None = None,
    product_commit: str | None = None,
    archive_commit: str | None = None,
) -> dict[str, Any]:
    """Resolve checkpoint → product/feature → merge → release identity facts."""
    change_dir = change_dir.resolve()
    project_root = (project or find_project_root(change_dir)).resolve()
    ledger = load_ledger(change_dir) or {}
    ci = load_product_candidate_ci(change_dir) or {}
    candidate_subject = (
        ci.get("subject") if isinstance(ci.get("subject"), dict) else {}
    )
    product = (
        product_commit
        or ledger.get("productCommit")
        or candidate_subject.get("productCommit")
        or ci.get("commit")
        or ledger.get("finalCommit")
        or ""
    )
    checkpoint = str(
        ledger.get("checkpointCommit")
        or (ledger.get("checkpoint") or {}).get("commit")
        if isinstance(ledger.get("checkpoint"), dict)
        else ledger.get("checkpointCommit") or ""
    ).strip()
    feature_tip = str(
        ledger.get("featureTip")
        or ledger.get("featureTipHash")
        or product
    ).strip()
    merge_commit = str(
        ledger.get("mergeCommit")
        or ledger.get("featureMergeHash")
        or ledger.get("mergeFinalHash")
        or ""
    ).strip()
    code, current_head, _ = git_run(project_root, "rev-parse", "HEAD")
    release_tip = str(
        ledger.get("releaseTip")
        or ledger.get("releaseTipHash")
        or (current_head if code == 0 else "")
        or ledger.get("archiveCommit")
        or product
    ).strip()
    archive = (
        archive_commit
        or ledger.get("archiveCommit")
        or release_tip
        or product
    )
    tree = str(
        ledger.get("productTreeHash")
        or candidate_subject.get("productTreeHash")
        or ""
    )
    environment_hash = str(
        candidate_subject.get("environmentHash")
        or ledger.get("environmentHash")
        or ""
    ).strip()
    under_harness = False
    try:
        change_dir.relative_to(project_root / ".harness")
        under_harness = True
    except ValueError:
        under_harness = False
    tree_meta: dict[str, Any] = {
        "truncated": False,
        "fileCount": 0,
        "limit": PRODUCT_TREE_HASH_FILE_LIMIT,
    }
    if not tree:
        if under_harness:
            try:
                tree_meta = compute_product_tree_hash_for_commit(
                    project_root, str(product)
                )
                tree = f"sha256:{tree_meta['hash']}"
            except (OSError, ValueError):
                tree = hashlib.sha256(b"").hexdigest()
        else:
            # Bare temp fixtures are not real project roots — avoid scanning up-tree.
            tree = hashlib.sha256(b"fixture-no-product-tree").hexdigest()
    identity = {
        "checkpointCommit": checkpoint,
        "productCommit": str(product),
        "featureTip": feature_tip,
        "mergeCommit": merge_commit,
        "releaseTip": release_tip,
        # Legacy aliases retain their prior public contract.
        "featureMergeHash": merge_commit or feature_tip,
        "releaseTipHash": release_tip,
        "productTreeHash": str(tree),
        "archiveCommit": str(archive),
        "environmentHash": environment_hash,
        "productTreeHashTruncated": bool(tree_meta.get("truncated")),
        "productTreeHashFileCount": int(tree_meta.get("fileCount") or 0),
    }
    identity["validation"] = validate_product_identity(
        product_commit=identity["productCommit"],
        product_tree_hash=identity["productTreeHash"],
        archive_commit=identity["archiveCommit"] or "unknown",
        project=project_root if under_harness else None,
        expected_tree_hash=tree if not under_harness else None,
    )
    return identity


def validate_product_identity(
    *,
    product_commit: str,
    product_tree_hash: str,
    archive_commit: str,
    project: Path | None = None,
    expected_tree_hash: str | None = None,
) -> dict[str, Any]:
    """Validate productCommit/productTreeHash/archiveCommit relationship."""
    if not product_commit or not product_tree_hash or not archive_commit:
        return {
            "ok": False,
            "code": "PRODUCT_IDENTITY_INCOMPLETE",
            "message": "productCommit, productTreeHash, and archiveCommit are required",
        }
    expected = expected_tree_hash
    source = "provided-expected"
    resolved_product_commit = product_commit
    if project is not None and expected_tree_hash is None:
        code, resolved, error = git_run(
            project, "rev-parse", "--verify", f"{product_commit}^{{commit}}"
        )
        if code != 0 or not resolved:
            return {
                "ok": False,
                "code": "PRODUCT_COMMIT_NOT_FOUND",
                "message": (
                    f"productCommit={product_commit} is not a reachable Git commit: "
                    f"{error or 'not found'}"
                ),
                "productCommit": product_commit,
            }
        resolved_product_commit = resolved
        try:
            detail = compute_product_tree_hash_for_commit(
                project, resolved_product_commit
            )
        except ValueError as exc:
            return {
                "ok": False,
                "code": "PRODUCT_TREE_UNAVAILABLE",
                "message": str(exc),
                "productCommit": resolved_product_commit,
            }
        if detail.get("truncated"):
            return {
                "ok": False,
                "code": "PRODUCT_TREE_HASH_TRUNCATED",
                "message": (
                    f"product tree exceeds limit={detail.get('limit')} "
                    f"for productCommit={resolved_product_commit}"
                ),
            }
        expected = f"sha256:{detail['hash']}"
        source = "git-commit-tree"

    normalize_hash = lambda value: str(value or "").strip().removeprefix("sha256:")
    if expected is not None and normalize_hash(product_tree_hash) != normalize_hash(
        expected
    ):
        return {
            "ok": False,
            "code": "PRODUCT_TREE_HASH_MISMATCH",
            "message": (
                f"productTreeHash={product_tree_hash} does not match "
                f"product tree={expected} for productCommit={product_commit}"
            ),
            "expected": expected,
            "actual": product_tree_hash,
        }

    if project is not None:
        code, resolved_archive, error = git_run(
            project, "rev-parse", "--verify", f"{archive_commit}^{{commit}}"
        )
        if code != 0 or not resolved_archive:
            return {
                "ok": False,
                "code": "ARCHIVE_COMMIT_NOT_FOUND",
                "message": (
                    f"archiveCommit={archive_commit} is not a Git commit: "
                    f"{error or 'not found'}"
                ),
                "archiveCommit": archive_commit,
            }
        ancestor, _out, ancestry_error = git_run(
            project,
            "merge-base",
            "--is-ancestor",
            resolved_product_commit,
            resolved_archive,
        )
        if ancestor != 0:
            return {
                "ok": False,
                "code": "ARCHIVE_COMMIT_UNRELATED",
                "message": (
                    f"archiveCommit={resolved_archive} does not descend from "
                    f"productCommit={resolved_product_commit}: "
                    f"{ancestry_error or 'unrelated history'}"
                ),
                "productCommit": resolved_product_commit,
                "archiveCommit": resolved_archive,
            }
        archive_commit = resolved_archive
    return {
        "ok": True,
        "code": "PRODUCT_IDENTITY_OK",
        "productCommit": resolved_product_commit,
        "productTreeHash": product_tree_hash,
        "archiveCommit": archive_commit,
        "source": source,
    }


def evaluate_release_evidence(
    archived_identity: dict[str, Any],
    *,
    current_product_tree_hash: str,
) -> dict[str, Any]:
    """Old archive cannot remain release evidence after product inputs change."""
    archived_tree = str(archived_identity.get("productTreeHash") or "")
    if not archived_tree:
        return {
            "ok": False,
            "code": "ARCHIVE_EVIDENCE_REOPEN_REQUIRED",
            "message": "archived productTreeHash missing; reopen required",
        }
    if archived_tree != str(current_product_tree_hash):
        return {
            "ok": False,
            "code": "ARCHIVE_EVIDENCE_REOPEN_REQUIRED",
            "message": (
                "product inputs changed since archive; "
                f"archivedTree={archived_tree} currentTree={current_product_tree_hash}"
            ),
            "archivedProductTreeHash": archived_tree,
            "currentProductTreeHash": current_product_tree_hash,
        }
    return {
        "ok": True,
        "code": "ARCHIVE_EVIDENCE_CURRENT",
        "productTreeHash": archived_tree,
    }


def build_workflow_timing(
    events: list[dict[str, Any]],
    *,
    report_cutoff_at: str | None = None,
) -> dict[str, Any]:
    """Build typed attempts, sessions, and a wall-clock-conserving breakdown."""
    parsed_stamps = [
        he.parse_timestamp(event.get("timestamp"))
        for event in events
        if event.get("timestamp")
    ]
    parsed_stamps = [stamp for stamp in parsed_stamps if stamp is not None]
    started_dt = min(parsed_stamps) if parsed_stamps else None
    cutoff_text = report_cutoff_at or (
        max(parsed_stamps).isoformat() if parsed_stamps else None
    )
    cutoff_dt = he.parse_timestamp(cutoff_text) if cutoff_text else None
    started = started_dt.isoformat() if started_dt else None
    cutoff = cutoff_dt.isoformat() if cutoff_dt else cutoff_text

    def elapsed_ms(start: Any, end: Any) -> int:
        delta = end - start
        total_microseconds = (
            (delta.days * 86_400 + delta.seconds) * 1_000_000
            + delta.microseconds
        )
        return max(0, total_microseconds // 1_000)

    def clipped_interval(
        start_value: Any,
        end_value: Any,
    ) -> tuple[Any, Any] | None:
        start = (
            start_value
            if hasattr(start_value, "tzinfo")
            else he.parse_timestamp(start_value)
        )
        end = (
            end_value
            if hasattr(end_value, "tzinfo")
            else he.parse_timestamp(end_value)
        )
        if start is None or end is None or end <= start:
            return None
        if started_dt is not None:
            start = max(start, started_dt)
        if cutoff_dt is not None:
            end = min(end, cutoff_dt)
        return (start, end) if end > start else None

    def union_ms(intervals: list[tuple[Any, Any]]) -> int:
        merged: list[list[Any]] = []
        for interval_start, interval_end in sorted(intervals):
            if not merged or interval_start > merged[-1][1]:
                merged.append([interval_start, interval_end])
            else:
                merged[-1][1] = max(merged[-1][1], interval_end)
        return sum(
            max(
                0,
                elapsed_ms(interval_start, interval_end),
            )
            for interval_start, interval_end in merged
        )

    active_intervals: list[tuple[Any, Any]] = []
    attempts: list[dict[str, Any]] = []
    stage_active = 0
    unclosed = 0
    for phase, phase_events in he.group_events_by_phase(events):
        if not any(
            event.get("type") in {"phase.start", "phase.end"}
            for event in phase_events
        ):
            continue
        timing = he.canonical_phase_timing(phase_events, cutoff_ts=cutoff)
        stage_active += int(timing.get("activeExecutionMs") or 0)
        unclosed += int(timing.get("unclosedAttemptCount") or 0)
        for invocation in timing.get("attempts") or []:
            item = {"phase": phase, **invocation}
            attempts.append(item)
            if invocation.get("activeEligible"):
                interval = clipped_interval(
                    invocation.get("startedAt"),
                    invocation.get("endedAt"),
                )
                if interval is not None:
                    active_intervals.append(interval)

    external_intervals: list[tuple[Any, Any]] = []
    pause_intervals: list[tuple[Any, Any]] = []
    pause_start = None
    for event in sorted(
        events,
        key=lambda item: str(item.get("timestamp") or ""),
    ):
        event_type = str(event.get("type") or "").lower()
        timestamp = he.parse_timestamp(event.get("timestamp"))
        if event_type in {
            "external.wait",
            "ci.wait",
            "environment.wait",
            "env.wait",
        }:
            ended = he.parse_timestamp(event.get("endedAt"))
            duration = event.get("duration_ms", event.get("durationMs"))
            if ended is None and timestamp is not None and isinstance(duration, int):
                ended = timestamp + dt.timedelta(milliseconds=max(0, duration))
            interval = clipped_interval(timestamp, ended)
            if interval is not None:
                external_intervals.append(interval)
        if event_type in {"workflow.pause", "session.pause", "pause"}:
            pause_start = timestamp or pause_start
        elif event_type in {
            "workflow.resume",
            "session.resume",
            "resume",
        } and pause_start is not None:
            interval = clipped_interval(pause_start, timestamp)
            if interval is not None:
                pause_intervals.append(interval)
            pause_start = None
    if pause_start is not None and cutoff_dt is not None:
        interval = clipped_interval(pause_start, cutoff_dt)
        if interval is not None:
            pause_intervals.append(interval)

    boundaries = sorted(
        {
            point
            for interval in (
                active_intervals + external_intervals + pause_intervals
            )
            for point in interval
        }
        | (
            {started_dt, cutoff_dt}
            if started_dt is not None and cutoff_dt is not None
            else set()
        )
    )
    categories = {
        "attributed": 0,
        "external": 0,
        "paused": 0,
        "unattributed": 0,
    }

    def covered(
        interval_start: Any,
        interval_end: Any,
        intervals: list[tuple[Any, Any]],
    ) -> bool:
        return any(
            start <= interval_start and end >= interval_end
            for start, end in intervals
        )

    for segment_start, segment_end in zip(boundaries, boundaries[1:]):
        milliseconds = max(
            0,
            elapsed_ms(segment_start, segment_end),
        )
        if covered(segment_start, segment_end, active_intervals):
            categories["attributed"] += milliseconds
        elif covered(segment_start, segment_end, external_intervals):
            categories["external"] += milliseconds
        elif covered(segment_start, segment_end, pause_intervals):
            categories["paused"] += milliseconds
        else:
            categories["unattributed"] += milliseconds

    workflow_wall = (
        elapsed_ms(started_dt, cutoff_dt)
        if started_dt is not None and cutoff_dt is not None
        else 0
    )
    # Segment-level integer conversion can lose sub-millisecond fractions at
    # each boundary. Attribute only that positive rounding residue to the
    # otherwise-unattributed bucket so the partition remains exact.
    rounding_residue = workflow_wall - sum(categories.values())
    if rounding_residue > 0:
        categories["unattributed"] += rounding_residue
    stage_wall = union_ms(active_intervals)
    sessions: list[dict[str, Any]] = []
    session_start = started_dt
    for pause_start_dt, pause_end_dt in sorted(pause_intervals):
        if session_start is not None and pause_start_dt > session_start:
            sessions.append(
                {
                    "session": len(sessions) + 1,
                    "startedAt": session_start.isoformat(),
                    "endedAt": pause_start_dt.isoformat(),
                    "wallClockMs": elapsed_ms(session_start, pause_start_dt),
                    "terminalStatus": "PAUSED",
                }
            )
        session_start = pause_end_dt
    if (
        session_start is not None
        and cutoff_dt is not None
        and cutoff_dt > session_start
    ):
        sessions.append(
            {
                "session": len(sessions) + 1,
                "startedAt": session_start.isoformat(),
                "endedAt": cutoff_dt.isoformat(),
                "wallClockMs": elapsed_ms(session_start, cutoff_dt),
                "terminalStatus": "CUTOFF",
            }
        )
    conservation_total = sum(categories.values())
    post_archive_excluded = 0
    if cutoff:
        for event in events:
            if str(event.get("phase") or "").lower() != "archive":
                continue
            ts = event.get("timestamp")
            if ts and he.duration_ms_between(cutoff, ts) and he.duration_ms_between(cutoff, ts) > 0:
                # timestamp after cutoff
                start_dt = he.parse_timestamp(cutoff)
                end_dt = he.parse_timestamp(ts)
                if start_dt and end_dt and end_dt > start_dt:
                    post_archive_excluded += 1
    return {
        "workflowStartedAt": started or NOT_AVAILABLE,
        "reportCutoffAt": cutoff or NOT_AVAILABLE,
        "workflowWallClockMs": int(workflow_wall or 0),
        "stageActiveExecutionMs": int(stage_active),
        "stageWallClockSpanMs": int(stage_wall),
        "attributedStageUnionMs": int(categories["attributed"]),
        "externalWaitMs": int(categories["external"]),
        "pausedMs": int(categories["paused"]),
        "agentOrToolUnattributedMs": int(categories["unattributed"]),
        "conservationDeltaMs": int(workflow_wall - conservation_total),
        "unclosedAttemptCount": int(unclosed),
        "attempts": attempts,
        "sessions": sessions,
        "sessionWallClockMs": sum(
            int(item["wallClockMs"]) for item in sessions
        ),
        "postArchiveEventsExcluded": int(post_archive_excluded),
        "totalMinutesSemantics": "workflow-wall-primary; active-is-separate",
    }


def verify_manifest_byte_coverage(
    root: Path,
    manifest: dict[str, Any],
    *,
    exclude_paths: list[str] | None = None,
    exclusion_reasons: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Verify every covered manifest entry still matches on-disk bytes (IA-7)."""
    root = root.resolve()
    excluded = {
        p.replace("\\", "/") for p in (exclude_paths or [])
    }
    reasons = {
        k.replace("\\", "/"): v for k, v in (exclusion_reasons or {}).items()
    }
    mismatches: list[dict[str, str]] = []
    checked = 0
    manifest_paths: set[str] = set()
    for item in manifest.get("files") or []:
        if not isinstance(item, dict):
            continue
        rel = str(item.get("path") or "").replace("\\", "/")
        if not rel or _manifest_path_excluded(rel):
            continue
        manifest_paths.add(rel)
        if rel in excluded:
            reasons.setdefault(rel, "excluded from checksum coverage")
            continue
        path = root / rel
        if not path.is_file():
            mismatches.append({"path": rel, "reason": "missing"})
            continue
        actual = sha256_file(path)
        expected = str(item.get("sha256") or "")
        checked += 1
        if actual != expected:
            mismatches.append(
                {
                    "path": rel,
                    "reason": "hash-mismatch",
                    "expected": expected,
                    "actual": actual,
                }
            )
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.name.endswith(".lock"):
            continue
        rel = path.relative_to(root).as_posix()
        if _manifest_path_excluded(rel) or rel in excluded:
            continue
        if rel not in manifest_paths:
            mismatches.append({"path": rel, "reason": "unexpected"})
    ok = not mismatches
    if ok and reasons:
        checksum_status = "OK_WITH_EXCLUSIONS"
    elif ok:
        checksum_status = "OK"
    else:
        checksum_status = "FAIL"
    return {
        "ok": ok,
        "checksumStatus": checksum_status,
        "checked": checked,
        "mismatched": mismatches,
        "exclusionReasons": reasons,
    }

def load_execution_log(change_dir: Path) -> str:
    for root in archive_read_roots(change_dir):
        for rel in ("logs/execution-log.md", "execution-log.md"):
            path = root / rel
            if not path.is_file():
                continue
            try:
                return path.read_text(encoding="utf-8-sig")
            except OSError:
                return ""
    return ""


def load_existing_summary(change_dir: Path) -> dict[str, Any] | None:
    for root in archive_read_roots(change_dir):
        for rel in (
            "reports/final/summary-data.json",
            "summary-data.json",
        ):
            path = root / rel
            if not path.is_file():
                continue
            try:
                data = read_json(path)
                return data if isinstance(data, dict) else None
            except (OSError, json.JSONDecodeError):
                return None
    return None


def find_test_reports(change_dir: Path) -> list[Path]:
    patterns = [
        "tests/test-report-*.md",
        "reports/test/test-report-*.md",
        "reports/test/*.md",
    ]
    found: list[Path] = []
    seen: set[Path] = set()
    for pattern in patterns:
        for path in sorted(change_dir.glob(pattern)):
            if path in seen:
                continue
            seen.add(path)
            found.append(path)
    return found


def find_review_reports(change_dir: Path) -> list[Path]:
    patterns = [
        "reports/review/review-report-*.md",
        "reviews/review-report-*.md",
        "reports/review/fixback-*.md",
    ]
    found: list[Path] = []
    for pattern in patterns:
        found.extend(sorted(change_dir.glob(pattern)))
    return found


def review_phase_completed(events: list[dict[str, Any]]) -> bool:
    """True only when structured events record a review phase.end (UT-042)."""
    for event in events:
        if event.get("type") != "phase.end":
            continue
        if str(event.get("phase") or "").lower() == "review":
            return True
    return False


def review_evidence_present(
    change_dir: Path,
    events: list[dict[str, Any]] | None = None,
) -> bool:
    """Review ran only when report files or review phase.end events exist."""
    if find_review_reports(change_dir):
        return True
    if events is None:
        events = he.load_events(change_dir / "events.ndjson")
    return review_phase_completed(events)


def git_run(project: Path, *args: str) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            ["git", "-C", str(project), *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            check=False,
        )
        return proc.returncode, proc.stdout.strip(), proc.stderr.strip()
    except (OSError, subprocess.TimeoutExpired) as exc:
        return 1, "", str(exc)


def extract_final_pushed_hash(execution_log: str) -> str | None:
    """Parse 'final pushed hash' from execution-log (submit phase)."""
    patterns = [
        r"final pushed hash[:\s`]+([0-9a-f]{7,40})",
        r"finalPushedHash[:\s\"']+([0-9a-f]{7,40})",
        r"pushed hash[:\s`]+([0-9a-f]{7,40})",
    ]
    for pat in patterns:
        m = re.search(pat, execution_log, re.IGNORECASE)
        if m:
            return m.group(1)
    return None


def worktree_requested(change_dir: Path) -> bool:
    for rel in ("meta/worktree.json", "worktree.json"):
        path = change_dir / rel
        if path.is_file():
            try:
                data = read_json(path)
                if isinstance(data, dict):
                    return bool(data.get("requested"))
            except (OSError, json.JSONDecodeError):
                pass
    return False


def check_archive_exact_byte_policy(project_root: Path) -> dict[str, Any]:
    """Exact bytes are guaranteed by ZIP entry hashes, independent of Git."""
    return {
        "ok": True,
        "mode": "zip-content-hash",
        "gitattributesRequired": False,
        "note": "archive bytes are verified by manifest and package SHA-256",
    }


SENSITIVE_SCAN_POLICY_ENV = "HUNTER_HARNESS_SENSITIVE_SCAN"
DEFAULT_SENSITIVE_SCAN_POLICY = "warn"


def resolve_sensitive_scan_policy(env: dict[str, str] | None = None) -> str:
    """Publication-gate policy: ``off`` | ``warn`` | ``block`` (default warn).

    Mirrors resolveSensitiveScanPolicy() in packages/core so the archive gate
    and the push gate answer to the same switch.
    """
    source = os.environ if env is None else env
    raw = str(source.get(SENSITIVE_SCAN_POLICY_ENV) or "").strip().lower()
    if raw in {"off", "false", "0", "disabled"}:
        return "off"
    if raw in {"warn", "advisory"}:
        return "warn"
    if raw in {"block", "true", "1", "enforce"}:
        return "block"
    return DEFAULT_SENSITIVE_SCAN_POLICY


def _advisory_sensitive_gate(result: dict[str, Any], policy: str) -> dict[str, Any]:
    """Downgrade a failed gate to advisory under a non-blocking policy.

    The facts survive verbatim under ``advisory`` so the archive report still
    names every plaintext file; only the veto is dropped. A fail-closed gate
    with no proportionate setting gets worked around rather than respected.
    """
    if result.get("ok") or policy == "block":
        return result
    return {
        "ok": True,
        "reasonCode": "SENSITIVE_EVIDENCE_ADVISORY",
        "policy": policy,
        "receiptPath": result.get("receiptPath"),
        "unresolvedFailures": [],
        "advisory": {
            key: value
            for key, value in result.items()
            if key not in {"ok", "policy"}
        },
        "nextAction": (
            "Findings are advisory under "
            f"{SENSITIVE_SCAN_POLICY_ENV}={policy}; set it to `block` to veto "
            "publication, or quarantine with `harness_runtime.py "
            "quarantine-evidence`."
        ),
    }


def validate_sensitive_evidence_publication_gate(
    change_dir: Path,
    *,
    copy_root: Path | None = None,
    require_receipt: bool = False,
    receipt_override: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Fail closed before freeze/copy when plaintext evidence is unresolved.

    The receipt is deliberately self-excluded from the tree digest.  It may
    therefore bind the exact publishable bytes without creating a recursive
    digest.  Private quarantine paths are evidence metadata only and must be
    outside both the project/copy roots.
    """
    change_dir = change_dir.expanduser().resolve()
    copy_root = (copy_root or change_dir).expanduser().resolve()
    policy = resolve_sensitive_scan_policy()
    receipt_path = hruntime.sensitive_evidence_receipt_path(change_dir)
    if policy == "off":
        # Skipping the scan also skips a full-tree byte read of the change dir.
        return {
            "ok": True,
            "reasonCode": "SECRET_SCAN_DISABLED",
            "policy": policy,
            "receiptPath": str(receipt_path),
            "unresolvedFailures": [],
        }
    candidates = hruntime.sensitive_evidence_candidates(change_dir)
    if candidates:
        return _advisory_sensitive_gate(
            {
                "ok": False,
                "reasonCode": "SENSITIVE_EVIDENCE_UNQUARANTINED",
                "receiptPath": str(receipt_path),
                "unresolvedFailures": candidates,
                "nextAction": (
                    "Quarantine the original bytes before archive publication."
                ),
            },
            policy,
        )
    if receipt_override is None and not receipt_path.is_file():
        if require_receipt:
            return _advisory_sensitive_gate(
                {
                    "ok": False,
                    "reasonCode": "SECRET_SCAN_RECEIPT_MISSING",
                    "receiptPath": str(receipt_path),
                    "unresolvedFailures": [],
                },
                policy,
            )
        return {
            "ok": True,
            "reasonCode": "SECRET_SCAN_NOT_APPLICABLE",
            "receiptPath": str(receipt_path),
            "receiptRequired": False,
            "unresolvedFailures": [],
        }
    if receipt_override is None:
        try:
            receipt = read_json(receipt_path)
        except (OSError, json.JSONDecodeError, TypeError) as exc:
            return _advisory_sensitive_gate(
                {
                    "ok": False,
                    "reasonCode": "SECRET_SCAN_RECEIPT_INVALID",
                    "receiptPath": str(receipt_path),
                    "error": str(exc),
                },
                policy,
            )
    else:
        receipt = receipt_override
    if not isinstance(receipt, dict):
        return _advisory_sensitive_gate(
            {
                "ok": False,
                "reasonCode": "SECRET_SCAN_RECEIPT_INVALID",
                "receiptPath": str(receipt_path),
                "error": "receipt must be an object",
            },
            policy,
        )
    issues: list[dict[str, Any]] = []
    if receipt.get("schemaVersion") != 1:
        issues.append({"code": "SECRET_SCAN_SCHEMA_INVALID"})
    if receipt.get("rulesVersion") != hruntime.SECRET_SCAN_RULES_VERSION:
        issues.append({"code": "SECRET_SCAN_RULES_MISMATCH"})
    if receipt.get("changeId") != change_dir.name:
        issues.append({"code": "SECRET_SCAN_CHANGE_ID_MISMATCH"})
    if str(receipt.get("status") or "").upper() not in {"OK", "QUARANTINED"}:
        issues.append({"code": "SENSITIVE_EVIDENCE_QUARANTINE_FAILED"})
    unresolved = receipt.get("unresolvedFailures")
    if isinstance(unresolved, list) and unresolved:
        issues.append({"code": "SENSITIVE_EVIDENCE_QUARANTINE_FAILED", "count": len(unresolved)})
    elif unresolved not in (None, []):
        issues.append({"code": "SECRET_SCAN_UNRESOLVED_INVALID"})
    try:
        actual_digest = hruntime.publishable_tree_digest(change_dir)
    except OSError as exc:
        actual_digest = None
        issues.append({"code": "SECRET_SCAN_TREE_UNREADABLE", "error": str(exc)})
    if actual_digest is not None and receipt.get("publishableTreeDigest") != actual_digest:
        issues.append({
            "code": "SECRET_SCAN_TREE_DIGEST_MISMATCH",
            "expected": receipt.get("publishableTreeDigest"),
            "actual": actual_digest,
        })
    if receipt.get("publicationExcluded") is not True:
        issues.append({"code": "SECRET_SCAN_PUBLICATION_NOT_EXCLUDED"})
    project_root = find_project_root(change_dir)
    for entry in receipt.get("entries") or []:
        if not isinstance(entry, dict):
            issues.append({"code": "SECRET_SCAN_ENTRY_INVALID"})
            continue
        private_raw = entry.get("privatePath")
        if not isinstance(private_raw, str) or not private_raw.strip():
            issues.append({"code": "SECRET_SCAN_PRIVATE_PATH_MISSING"})
            continue
        private_path = Path(private_raw).expanduser().resolve()
        if (
            _path_is_within(private_path, copy_root)
            or _path_is_within(private_path, project_root)
            or _path_is_within(private_path, change_dir)
        ):
            issues.append({
                "code": "SECRET_SCAN_PRIVATE_PATH_IN_COPY_ROOT",
                "privatePath": str(private_path),
            })
        if not private_path.is_file():
            issues.append({
                "code": "SECRET_SCAN_PRIVATE_PATH_MISSING",
                "privatePath": str(private_path),
            })
        source_raw = entry.get("sourcePath")
        if isinstance(source_raw, str) and source_raw.strip():
            source_path = (change_dir / source_raw).resolve()
            if _path_is_within(source_path, change_dir) and source_path.exists():
                issues.append({
                    "code": "SENSITIVE_EVIDENCE_SOURCE_REMAINS",
                    "sourcePath": source_raw,
                })
    return _advisory_sensitive_gate(
        {
            "ok": not issues,
            "reasonCode": (
                "SECRET_SCAN_GATE_SATISFIED" if not issues else "SECRET_SCAN_GATE_BLOCKED"
            ),
            "receiptPath": str(receipt_path),
            "receipt": receipt,
            "issues": issues,
            "treeDigest": actual_digest,
        },
        policy,
    )


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------


def check_status(
    change_dir: Path,
    *,
    allow_missing_review: bool = False,
    archive_intent: str = "release-candidate",
    closure_disposition: str = "completed",
    closure_reason: str = "",
) -> dict[str, Any]:
    """Read-only archive preconditions. Never mutates."""
    if archive_intent not in {"release-candidate", "record-only"}:
        raise ValueError(
            "archive_intent must be release-candidate or record-only"
        )
    if closure_disposition not in {"completed", "abandoned", "superseded"}:
        raise ValueError(
            "closure_disposition must be completed, abandoned, or superseded"
        )
    closure_reason = closure_reason.strip()
    blockers: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    checks: dict[str, Any] = {}
    if closure_disposition != "completed" and not closure_reason:
        blockers.append(
            {
                "code": "closure-reason-required",
                "message": "ending an unfinished change requires a closure reason",
            }
        )
    if closure_disposition != "completed" and archive_intent == "release-candidate":
        blockers.append(
            {
                "code": "closure-not-release-candidate",
                "message": "abandoned or superseded changes can be archived but cannot be release candidates",
            }
        )

    if not change_dir.is_dir():
        return {
            "ok": False,
            "archivable": False,
            "releaseEligible": False,
            "change_dir": str(change_dir),
            "blockers": [{"code": "missing-change-dir", "message": f"not found: {change_dir}"}],
            "warnings": [],
            "checks": {},
        }

    project = find_project_root(change_dir)
    checks["project_root"] = str(project)
    state_root = resolve_archive_state_root(change_dir)
    checks["state_root"] = str(state_root)
    range_adoption = validate_existing_range_adoption(change_dir)
    checks["range_adoption"] = range_adoption
    if not range_adoption.get("ok"):
        blockers.append(
            {
                "code": str(
                    range_adoption.get("reasonCode")
                    or "EXISTING_RANGE_RECEIPT_INVALID"
                ),
                "message": str(
                    range_adoption.get("message")
                    or "既有提交范围认领收据无效。"
                ),
            }
        )

    exact_byte = check_archive_exact_byte_policy(project)
    checks["archive_exact_byte"] = exact_byte
    if not exact_byte["ok"]:
        warnings.append(
            {
                "code": "archive-exact-byte-policy-missing",
                "message": str(exact_byte["remediation"]),
            }
        )

    sensitive_gate = validate_sensitive_evidence_publication_gate(
        change_dir,
        copy_root=change_dir,
        require_receipt=False,
    )
    checks["sensitive_evidence_publication"] = sensitive_gate
    if not sensitive_gate.get("ok"):
        sensitive_issue_codes = {
            str(item.get("code") or "")
            for item in sensitive_gate.get("issues") or []
            if isinstance(item, dict)
        }
        digest_only_drift = sensitive_issue_codes == {
            "SECRET_SCAN_TREE_DIGEST_MISMATCH"
        }
        if digest_only_drift and not sensitive_gate.get("unresolvedFailures"):
            warnings.append(
                {
                    "code": "SECRET_SCAN_RECEIPT_REFRESH_REQUIRED",
                    "message": (
                        "归档事件或锁文件变化使敏感信息扫描收据过期；"
                        "正式归档会重新扫描并绑定当前字节。"
                    ),
                }
            )
        else:
            blockers.append({
                "code": str(sensitive_gate.get("reasonCode") or "SECRET_SCAN_GATE_BLOCKED"),
                "message": str(
                    sensitive_gate.get("nextAction")
                    or sensitive_gate.get("error")
                    or "sensitive evidence publication gate failed"
                ),
            })

    # --- H-4 formal-layer minimum set ---
    plans_dir = change_dir / "plans"
    plan_files = (
        sorted(plans_dir.glob("*-plan.md")) if plans_dir.is_dir() else []
    )
    checks["plan_files"] = [str(p.relative_to(change_dir)) for p in plan_files]
    if not plan_files:
        blockers.append(
            {
                "code": "missing-plan",
                "message": "plans/*-plan.md is required before archive",
            }
        )

    events_path = state_root / "events.ndjson"
    events_present = events_path.is_file() and events_path.stat().st_size > 0
    checks["events_ndjson"] = events_present
    if not events_present:
        blockers.append(
            {
                "code": "missing-events",
                "message": "events.ndjson is required and must be non-empty",
            }
        )

    ledger = load_ledger(change_dir)
    checks["verification_ledger"] = ledger is not None
    immutable_base = _immutable_change_base_from_snapshot(change_dir)
    ledger_base = (
        str(ledger.get("baseCommit") or "").strip()
        if isinstance(ledger, dict)
        else ""
    )
    checks["change_base"] = immutable_base or None
    if (
        immutable_base
        and ledger_base
        and immutable_base != ledger_base
        and not range_adoption.get("present")
    ):
        blockers.append(
            {
                "code": "CHANGE_BASE_IDENTITY_MISMATCH",
                "message": (
                    "计划阶段保存的变更基线与验证账本不一致；"
                    "请先恢复正确身份，不得在归档阶段自动改写。"
                ),
            }
        )
    if ledger is None:
        target = warnings if closure_disposition != "completed" else blockers
        target.append(
            {
                "code": (
                    "closure-ledger-not-required"
                    if closure_disposition != "completed"
                    else "missing-verification-ledger"
                ),
                "message": (
                    "verification was not completed; the closure records it as NOT_RUN"
                    if closure_disposition != "completed"
                    else "evidence/verification-ledger.json is required before archive"
                ),
            }
        )

    # --- commit pushed ---
    code, out, err = git_run(project, "rev-parse", "--is-inside-work-tree")
    if code != 0:
        warnings.append(
            {
                "code": "git-unavailable",
                "message": f"not a git work tree or git missing: {err or out}",
            }
        )
        checks["commit_pushed"] = None
    else:
        code, out, err = git_run(project, "log", "@{u}..HEAD", "--oneline")
        if code != 0:
            # No upstream configured
            warnings.append(
                {
                    "code": "no-upstream",
                    "message": err or "no upstream configured; cannot verify push",
                }
            )
            checks["commit_pushed"] = None
        elif out.strip():
            blockers.append(
                {
                    "code": "unpushed-commits",
                    "message": f"unpushed commits:\n{out}",
                }
            )
            checks["commit_pushed"] = False
        else:
            checks["commit_pushed"] = True

    # --- final hash ---
    code, head, _ = git_run(project, "rev-parse", "HEAD")
    head_hash = head if code == 0 else None
    checks["head"] = head_hash

    expected_hash: str | None = None
    hash_source: str | None = None
    if ledger is None:
        ledger = load_ledger(change_dir)
    if range_adoption.get("ok") and range_adoption.get("present"):
        expected_hash = str(range_adoption.get("tipCommit") or "").strip() or None
        hash_source = "meta/archive-range-adoption.json"
    if expected_hash is None and worktree_requested(change_dir) and ledger:
        merge_hash = ledger.get("mergeFinalHash") or (
            ledger.get("merge") or {}
        ).get("finalHash")
        if merge_hash:
            expected_hash = str(merge_hash)
            hash_source = "verification-ledger.mergeFinalHash"
    if expected_hash is None:
        log_text = load_execution_log(change_dir)
        pushed = extract_final_pushed_hash(log_text)
        if pushed:
            expected_hash = pushed
            hash_source = "execution-log.final-pushed-hash"
    if expected_hash is None and ledger:
        for key in ("finalCommit", "finalHash", "headCommit"):
            if ledger.get(key):
                expected_hash = str(ledger[key])
                hash_source = f"verification-ledger.{key}"
                break

    checks["expected_final_hash"] = expected_hash
    checks["hash_source"] = hash_source

    if head_hash and expected_hash:
        # Allow short-hash prefix match
        if head_hash.startswith(expected_hash) or expected_hash.startswith(head_hash[:7]):
            checks["final_hash_match"] = True
        else:
            # main may have advanced since this change merged (a later change
            # merged on top); the change's final hash is still pushed as long as
            # it is an ancestor of HEAD. Strict == would block archiving whenever
            # the repo moved on, which is the normal case in a multi-change
            # workflow.
            anc_code, _, _ = git_run(
                project, "merge-base", "--is-ancestor", expected_hash, head_hash
            )
            if anc_code == 0:
                checks["final_hash_match"] = True
                checks["final_hash_ancestor"] = True
            else:
                checks["final_hash_match"] = False
                blockers.append(
                    {
                        "code": "final-hash-mismatch",
                        "message": (
                            f"HEAD={head_hash} != expected={expected_hash} "
                            f"(source={hash_source}) and expected is not an ancestor "
                            f"of HEAD (not pushed?)"
                        ),
                    }
                )
    elif head_hash and expected_hash is None:
        warnings.append(
            {
                "code": "final-hash-unknown",
                "message": "could not determine expected final hash from ledger/log",
            }
        )
        checks["final_hash_match"] = None
    else:
        checks["final_hash_match"] = None

    # --- test / review reports ---
    test_reports = find_test_reports(change_dir)
    review_reports = find_review_reports(change_dir)
    events = he.load_events(events_path) if events_path.is_file() else []
    review_ran = review_evidence_present(change_dir, events)

    checks["test_reports"] = [str(p.relative_to(change_dir)) for p in test_reports]
    checks["review_reports"] = [str(p.relative_to(change_dir)) for p in review_reports]

    # H-4 min blockers are plan/events/ledger only. Missing test/review evidence
    # remains a warning so archive-before-review stays possible (advisory).
    if not test_reports and not review_reports and not review_ran:
        warnings.append(
            {
                "code": "missing-test-or-review-report",
                "message": (
                    "no test report or review evidence yet; prefer completing "
                    "test/review before archive (not a hard blocker)"
                ),
            }
        )

    if test_reports:
        checks["test_report_status"] = "present"
    else:
        checks["test_report_status"] = "missing-mark-skipped"
        warnings.append(
            {
                "code": "test-report-missing",
                "message": (
                    "no test-report-*.md; archive must mark verification as "
                    "NOT_RUN/USER_SKIPPED (not fabricated pass rates)"
                ),
            }
        )

    gate_policy = load_gate_policy(change_dir)
    risk_tier = str((gate_policy or {}).get("tier") or "unknown")
    checks["riskTier"] = risk_tier

    if review_reports:
        checks["review_report_status"] = "present"
    elif review_phase_completed(events):
        checks["review_report_status"] = "ran-but-not-persisted"
        warnings.append(
            {
                "code": "review-not-persisted",
                "message": (
                    "review phase.end recorded but no review-report file; "
                    "prefer persisting report before archive"
                ),
            }
        )
    else:
        checks["review_report_status"] = "not-run"
        review_msg = {
            "code": "review-not-run",
            "message": "no review report; mark reviewSummary as ADVISORY_NOT_RUN",
        }
        warnings.append(review_msg)
        if risk_tier == "full" and not review_ran:
            tier_issue = {
                "code": "review-required-on-full-tier",
                "message": (
                    "gate-policy tier=full requires review evidence; "
                    "pass --allow-missing-review to override"
                ),
            }
            if allow_missing_review:
                warnings.append(tier_issue)
            else:
                blockers.append(tier_issue)

    # Candidate verification is a release gate, not an archive-integrity fact.
    # A record-only archive may persist incomplete work but can never claim
    # release eligibility.
    ci_gate = evaluate_product_ci_gate(change_dir)
    checks["product_candidate_ci"] = {
        "ok": bool(ci_gate.get("ok")),
        "code": ci_gate.get("code"),
        "evidence": ci_gate.get("evidence"),
    }
    if not ci_gate.get("ok"):
        candidate_issue = {
            "code": (
                "PRODUCT_CANDIDATE_NOT_VERIFIED"
                if archive_intent == "record-only"
                else str(ci_gate.get("code") or "PRODUCT_CANDIDATE_NOT_VERIFIED")
            ),
            "message": str(
                ci_gate.get("message") or "product candidate not verified"
            ),
        }
        if archive_intent == "record-only":
            warnings.append(candidate_issue)
        else:
            blockers.append(candidate_issue)

    # --- artifact preflight (retro §5.31) ---
    # Classify artifact events before destructive finalize: informational (OK),
    # canonicalizable (same-change repo-relative path, warning), or blocking
    # (cross-change/absolute/escaping path, fail closed).
    try:
        preflight = artifact_preflight(change_dir)
    except Exception as exc:  # noqa: BLE001 — preflight must not crash status
        preflight = {"ok": False, "items": [], "blocking": [], "error": str(exc)}
    checks["artifact_preflight"] = preflight
    if preflight.get("ok") is not True and not preflight.get("blocking"):
        blockers.append({
            "code": "artifact-preflight-invalid",
            "message": str(
                preflight.get("error")
                or "artifact event projection or preflight validation failed"
            ),
        })
    for item in preflight.get("blocking") or []:
        blockers.append({
            "code": "artifact-path-blocking",
            "message": (
                f"artifact event {item.get('eventId', '')} path "
                f"{item.get('path', '')}: {item.get('reason', 'blocking')}"
            ),
        })
    for item in preflight.get("items") or []:
        if item.get("category") == "canonicalizable":
            warnings.append({
                "code": "artifact-path-canonicalizable",
                "message": (
                    f"artifact event {item.get('eventId', '')} path "
                    f"{item.get('path', '')} is repo-relative; "
                    f"canonical={item.get('canonicalPath', '')}"
                ),
            })

    candidate_codes = {
        "PRODUCT_CI_NOT_GREEN",
        "PRODUCT_CANDIDATE_NOT_VERIFIED",
        "PRODUCT_CANDIDATE_RECORD_ONLY",
        "PROJECT_RELEASE_POLICY_BLOCKED",
        "REMOTE_CI_DOWNGRADE_REFUSED",
    }
    report_adequacy: dict[str, Any]
    release_summary: dict[str, Any] | None = None
    try:
        release_summary = collect_summary_data(
            change_dir, write=False, for_replay=False
        )
        release_summary["archiveIntent"] = archive_intent
        release_summary["closureDisposition"] = closure_disposition
        release_summary["closureReason"] = closure_reason
        report_adequacy = validate_report_adequacy(release_summary)
    except Exception as exc:  # noqa: BLE001 — status must remain read-only
        report_adequacy = {
            "ok": False,
            "code": "REPORT_ADEQUACY_UNAVAILABLE",
            "message": str(exc),
            "issues": [
                {
                    "code": "REPORT_ADEQUACY_UNAVAILABLE",
                    "severity": "error",
                    "message": str(exc),
                }
            ],
        }

    adequacy_messages_zh = {
        "ARCHIVE_BASE_EQUALS_FEATURE_TIP": (
            "变更基线与产品提交相同，本次没有可归档的产品增量。"
            "如需封存已有提交，请先使用受控的既有范围认领；"
            "如变更未完成，请选择废弃或被替代并填写中文原因。"
        ),
        "IDENTITY_BASE_MISSING": "缺少不可变的变更基线，无法证明归档范围。",
        "DIFF_ZERO_WITH_NONEMPTY_COMMIT": "提交范围非空，但报告中的文件变更数为 0。",
        "ARCHIVE_DIFF_SHRUNK_VS_OWNERSHIP": "归档差异小于声明的产品范围。",
        "ARCHIVE_NOFF_MERGE_DELTA_ONLY": "归档只覆盖了合并提交差异，未覆盖完整变更。",
        "REPORT_ADEQUACY_UNAVAILABLE": "无法生成归档充分性报告。",
    }
    for issue in report_adequacy.get("issues") or []:
        if not isinstance(issue, dict) or issue.get("severity") != "error":
            continue
        code = str(issue.get("code") or "REPORT_ADEQUACY_FAILED")
        if any(item.get("code") == code for item in blockers):
            continue
        blockers.append(
            {
                "code": code,
                "message": adequacy_messages_zh.get(
                    code,
                    str(issue.get("message") or "归档报告不完整"),
                ),
            }
        )
    for issue in report_adequacy.get("issues") or []:
        if not isinstance(issue, dict) or issue.get("severity") != "warning":
            continue
        code = str(issue.get("code") or "REPORT_ADEQUACY_WARNING")
        if any(item.get("code") == code for item in warnings):
            continue
        warnings.append(
            {
                "code": code,
                "message": str(issue.get("message") or "归档报告需要注意"),
            }
        )

    archivable = len(blockers) == 0
    archive_integrity_ok = not any(
        item.get("code") not in candidate_codes for item in blockers
    )
    archive_integrity = {
        "ok": archive_integrity_ok,
        "code": (
            "ARCHIVE_INTEGRITY_OK"
            if archive_integrity_ok
            else "ARCHIVE_INTEGRITY_FAILED"
        ),
        "message": (
            "归档前置条件完整"
            if archive_integrity_ok
            else "归档前置条件存在阻断项"
        ),
    }
    if release_summary is not None:
        release_decision = evaluate_release_eligibility(
            change_dir,
            release_summary,
            archive_integrity=archive_integrity,
            report_adequacy=report_adequacy,
        )
    else:
        release_decision = compose_release_decision(
            {
                "archiveIntegrity": archive_integrity,
                "reportAdequacy": report_adequacy,
                "candidateVerification": ci_gate,
            }
        )
    return {
        "ok": True,
        "archivable": archivable,
        "archiveIntent": archive_intent,
        "releaseIntent": "candidate" if archive_intent == "release-candidate" else "none",
        "closureDisposition": closure_disposition,
        "closureReason": closure_reason or None,
        "archiveIntegrity": archive_integrity,
        "candidateVerification": release_decision["checks"][
            "candidateVerification"
        ],
        "releaseDecision": release_decision,
        "releaseEligible": (
            release_decision["releaseEligible"]
            if closure_disposition == "completed"
            else False
        ),
        "change_dir": str(change_dir),
        "change_name": infer_change_name(change_dir),
        "blockers": blockers,
        "warnings": warnings,
        "checks": checks,
    }


def archive_auto_gate(
    change_dir: Path,
    *,
    allow_missing_review: bool = False,
    archive_intent: str = "release-candidate",
    closure_disposition: str = "completed",
    closure_reason: str = "",
) -> dict[str, Any]:
    """Read-only proof that a post-submit/merge archive may run unattended."""
    status = check_status(
        change_dir,
        allow_missing_review=allow_missing_review,
        archive_intent=archive_intent,
        closure_disposition=closure_disposition,
        closure_reason=closure_reason,
    )
    if not status.get("archivable"):
        report_adequacy = (
            (status.get("releaseDecision") or {}).get("checks") or {}
        ).get("reportAdequacy") or {}
        adequacy_failed = report_adequacy.get("ok") is False
        return {
            "ok": False,
            "action": "auto-gate",
            "autoArchiveAllowed": False,
            "reasonCode": (
                "ARCHIVE_REPORT_ADEQUACY_FAILED"
                if adequacy_failed
                else "ARCHIVE_PRECONDITIONS_UNSATISFIED"
            ),
            "status": status,
            "nextAction": (
                "归档报告不完整，请按 blockers 中的中文建议处理后重试。"
                if adequacy_failed
                else "请先处理归档阻断项，再重新执行归档。"
            ),
        }

    state_root = resolve_archive_state_root(change_dir)
    snapshot_path = state_root / "meta" / "state-snapshot.json"
    if not snapshot_path.is_file():
        snapshot_path = change_dir / "meta" / "state-snapshot.json"
    try:
        snapshot = read_json(snapshot_path)
    except (OSError, json.JSONDecodeError, TypeError):
        snapshot = None
    if not isinstance(snapshot, dict):
        return {
            "ok": False,
            "action": "auto-gate",
            "autoArchiveAllowed": False,
            "reasonCode": "ARCHIVE_BOUNDARY_SNAPSHOT_MISSING",
            "status": status,
            "nextAction": "Capture the archive-boundary state snapshot before auto-archiving.",
        }

    git_state = snapshot.get("git")
    snapshot_base = snapshot.get("changeBase") or (
        (git_state.get("base") or git_state.get("baseCommit"))
        if isinstance(git_state, dict)
        else snapshot.get("base") or snapshot.get("baseCommit")
    )
    content_state = snapshot.get("content")
    content_hash = (
        content_state.get("productTreeHash")
        if isinstance(content_state, dict)
        else snapshot.get("productTreeHash")
    )
    content_boundary_valid = (
        isinstance(content_hash, str)
        and re.fullmatch(r"sha256:[0-9a-f]{64}", content_hash.strip()) is not None
    )
    git_boundary_valid = isinstance(snapshot_base, str) and bool(snapshot_base.strip())
    if not git_boundary_valid and not content_boundary_valid:
        return {
            "ok": False,
            "action": "auto-gate",
            "autoArchiveAllowed": False,
            "reasonCode": "ARCHIVE_BOUNDARY_SNAPSHOT_INVALID",
            "status": status,
            "nextAction": (
                "Capture a state snapshot containing either a Git boundary or "
                "a deterministic productTreeHash content boundary."
            ),
        }

    events_path = state_root / "events.ndjson"
    events = he.load_events(events_path) if events_path.is_file() else []
    policy = load_gate_policy(change_dir) or {}
    raw_planned = policy.get("plannedPhases")
    if not isinstance(raw_planned, list) or not raw_planned:
        raw_planned = policy.get("defaultPhases")
    planned_phases = (
        [str(item).strip() for item in raw_planned if str(item).strip()]
        if isinstance(raw_planned, list)
        else []
    )
    completed_phase: str | None = None
    if "archive" in planned_phases:
        archive_index = planned_phases.index("archive")
        if archive_index > 0:
            completed_phase = planned_phases[archive_index - 1]
    expected_phases = {completed_phase} if completed_phase else {"submit", "merge"}
    completed = any(
        event.get("phase") in expected_phases
        and event.get("type") == "phase.end"
        and str(event.get("status") or "").upper() in {"OK", "WARN"}
        for event in events
        if isinstance(event, dict)
    )
    if not completed:
        phase_label = completed_phase or "Submit or Merge"
        return {
            "ok": False,
            "action": "auto-gate",
            "autoArchiveAllowed": False,
            "reasonCode": "PLANNED_PREREQUISITE_NOT_COMPLETED",
            "status": status,
            "plannedPhases": planned_phases or None,
            "completedPrerequisitePhase": completed_phase,
            "nextAction": f"Complete {phase_label} and record its terminal phase event before auto-archiving.",
        }

    return {
        "ok": True,
        "action": "auto-gate",
        "autoArchiveAllowed": True,
        "reasonCode": "ARCHIVE_AUTO_GATE_SATISFIED",
        "plannedPhases": planned_phases or None,
        "completedPrerequisitePhase": completed_phase,
        "status": status,
        "snapshotPath": str(snapshot_path),
        "snapshotBase": snapshot_base,
        "nextAction": "运行 `harness_archive.py execute`；它会复用本次状态结果，不再重复扫描。",
    }


def execute_archive(
    change_dir: Path,
    archive_root: Path,
    *,
    durable_root: Path | None = None,
    retention_policy: str = "unspecified",
    skip_ingest: bool = False,
    allow_missing_review: bool = False,
    archive_intent: str = "release-candidate",
    closure_disposition: str = "completed",
    closure_reason: str = "",
) -> tuple[int, dict[str, Any]]:
    """Run one status collection, boundary gate, and finalize operation."""
    change_dir = change_dir.resolve()
    started = time.perf_counter()
    try:
        state_root = resolve_archive_state_root(change_dir)
    except (OSError, ValueError):
        state_root = change_dir
    if state_root.is_dir():
        try:
            append_event(
                state_root,
                phase="archive",
                type_="phase.prepare.start",
                note="开始一次性检查归档条件",
            )
        except OSError:
            pass
    candidate_certification: dict[str, Any] | None = None
    if load_product_candidate_ci(change_dir) is None:
        try:
            receipt = certify_local_candidate(
                change_dir,
                project=find_project_root(change_dir),
            )
            subject = (
                receipt.get("subject")
                if isinstance(receipt.get("subject"), dict)
                else {}
            )
            candidate_certification = {
                "ok": True,
                "code": "LOCAL_CANDIDATE_CERTIFIED",
                "assurance": receipt.get("assurance"),
                "subject": subject,
                "reusedValidations": (
                    receipt.get("verification", {}).get("reusedValidations", [])
                    if isinstance(receipt.get("verification"), dict)
                    else []
                ),
            }
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            candidate_certification = {
                "ok": False,
                "code": "LOCAL_CANDIDATE_CERTIFICATION_UNAVAILABLE",
                "message": str(exc),
            }
    gate = archive_auto_gate(
        change_dir,
        allow_missing_review=allow_missing_review,
        archive_intent=archive_intent,
        closure_disposition=closure_disposition,
        closure_reason=closure_reason,
    )
    elapsed_ms = max(0, int(round((time.perf_counter() - started) * 1000)))
    if state_root.is_dir():
        try:
            append_event(
                state_root,
                phase="archive",
                type_="phase.prepare.end",
                status="OK" if gate.get("ok") else "BLOCKED",
                code=str(gate.get("reasonCode") or "ARCHIVE_PREPARE_FINISHED"),
                message=(
                    "归档条件检查通过"
                    if gate.get("ok")
                    else str(gate.get("nextAction") or "归档条件未满足")
                ),
                duration_ms=elapsed_ms,
                note="一次性归档预检完成",
            )
        except OSError:
            pass
    if not gate.get("ok"):
        if state_root.is_dir():
            try:
                append_event(
                    state_root,
                    phase="archive",
                    type_="phase.end",
                    status="BLOCKED",
                    code=str(gate.get("reasonCode") or "ARCHIVE_PREPARE_BLOCKED"),
                    message=str(gate.get("nextAction") or "归档条件未满足"),
                    note="归档未开始，流程已在预检处结束",
                )
            except OSError:
                pass
        status = gate.get("status") if isinstance(gate.get("status"), dict) else {}
        blocked_payload = {
            "ok": False,
            "action": "execute",
            "reasonCode": gate.get("reasonCode"),
            "error": gate.get("nextAction"),
            "issues": list(status.get("blockers") or []),
            "preflight": gate,
            "change_dir": str(change_dir),
            "archive_dir": str(archive_root.resolve() / f"{today_date()}-{change_dir.name}"),
            "original_preserved": change_dir.is_dir(),
            "finalStatus": "BLOCKED",
            "preparationDurationMs": elapsed_ms,
        }
        if candidate_certification is not None:
            blocked_payload["candidateCertification"] = candidate_certification
        _best_effort_archive_terminal_sync(
            find_project_root(change_dir),
            state_root,
            change_key=change_dir.name,
            run_id=hes.run_id_for(change_dir),
            payload=blocked_payload,
        )
        return 1, blocked_payload
    code, payload = cmd_finalize(
        change_dir,
        archive_root,
        durable_root=durable_root,
        retention_policy=retention_policy,
        skip_ingest=skip_ingest,
        allow_missing_review=allow_missing_review,
        archive_intent=archive_intent,
        closure_disposition=closure_disposition,
        closure_reason=closure_reason,
        preflight_status=gate["status"],
    )
    payload["preflight"] = gate
    payload["preparationDurationMs"] = elapsed_ms
    if candidate_certification is not None:
        payload["candidateCertification"] = candidate_certification
    return code, payload


# ---------------------------------------------------------------------------
# collect
# ---------------------------------------------------------------------------


def _deepcopy_json(obj: Any) -> Any:
    return json.loads(json.dumps(obj))


def _na_if_missing(value: Any, *, allow_empty: bool = False) -> Any:
    if value is None:
        return NOT_AVAILABLE
    if not allow_empty and value == "":
        return NOT_AVAILABLE
    return value


def _ledger_unit_tests(ledger: dict[str, Any] | None) -> dict[str, Any]:
    empty = {
        "run": 0,
        "failures": 0,
        "errors": 0,
        "skipped": 0,
        "passRate": NOT_AVAILABLE,
        "source": "not-run",
        "latestAuthoritativeAttempt": None,
        "perAttemptCounts": [],
        "uniqueTestIdentities": [],
        "uniqueTestCount": 0,
        "rerunCount": 0,
    }
    if not ledger:
        return empty
    validations = ledger.get("validations") or ledger.get("verification") or {}
    unit = (
        validations.get("unitTestFull")
        or validations.get("unitTest")
        or validations.get("unitTests")
        or {}
    )
    if not isinstance(unit, dict):
        return empty
    status = str(unit.get("status") or "").upper()

    run = failures = errors = skipped = 0
    passed_count: int | None = None
    deselected = 0
    pass_rate: Any = None
    source = "committed"
    counted = False

    metrics = unit.get("metrics")
    if isinstance(metrics, dict) and any(
        k in metrics
        for k in (
            "run",
            "testsRun",
            "total",
            "passed",
            "failed",
            "failures",
            "errors",
            "skipped",
            "deselected",
        )
    ):
        if "total" in metrics:
            # ledger v3 typed metrics (UT-005/RET-15): total/passed/failed.
            run = int(metrics.get("total", 0) or 0)
        elif "run" in metrics or "testsRun" in metrics:
            run = int(metrics.get("run", metrics.get("testsRun", 0)) or 0)
        else:
            run = sum(
                int(metrics.get(key, 0) or 0)
                for key in ("passed", "failed", "errors", "skipped")
            )
        failures = int(metrics.get("failed", metrics.get("failures", 0)) or 0)
        errors = int(metrics.get("errors", 0) or 0)
        skipped = int(metrics.get("skipped", 0) or 0)
        deselected = int(metrics.get("deselected", 0) or 0)
        if "passed" in metrics:
            passed_count = int(metrics.get("passed", 0) or 0)
        pass_rate = metrics.get("passRate")
        source = "committed"
        counted = run > 0 or failures > 0 or errors > 0 or skipped > 0

    evidence = unit.get("evidence")
    if not counted and isinstance(evidence, dict):
        run = int(
            evidence.get(
                "run",
                evidence.get("testsRun", unit.get("run", unit.get("testsRun", 0))),
            )
            or 0
        )
        failures = int(evidence.get("failures", unit.get("failures", 0)) or 0)
        errors = int(evidence.get("errors", unit.get("errors", 0)) or 0)
        skipped = int(evidence.get("skipped", unit.get("skipped", 0)) or 0)
        deselected = int(evidence.get("deselected", unit.get("deselected", 0)) or 0)
        pass_rate = evidence.get("passRate") or unit.get("passRate")
        source = "committed"
        counted = run > 0 or failures > 0 or errors > 0 or skipped > 0

    evidence_text = evidence if isinstance(evidence, str) else ""
    if not counted and evidence_text:
        matches = list(_RE_UNIT_COUNTS.finditer(evidence_text))
        if matches:
            m = matches[-1]
            run = int(m.group(1))
            failures = int(m.group(2))
            errors = int(m.group(3))
            skipped = int(m.group(4))
            source = "evidence-text"
            counted = True
        else:
            fraction = _result_fraction(evidence_text)
            if fraction is not None:
                passed_count, run = fraction
                failures = max(run - passed_count, 0)
                errors = 0
                skipped = 0
                source = "evidence-text"
                counted = True

    if not counted:
        run = int(unit.get("run", unit.get("testsRun", 0)) or 0)
        failures = int(unit.get("failures", 0) or 0)
        errors = int(unit.get("errors", 0) or 0)
        skipped = int(unit.get("skipped", 0) or 0)
        deselected = int(unit.get("deselected", 0) or 0)
        pass_rate = unit.get("passRate")
        source = "committed"

    if status in {"NOT_RUN", "SKIPPED", "USER_SKIPPED"}:
        source = "not-run"
    elif str(unit.get("reused") or "").lower() in {"true", "1"} or "REUSED" in status:
        source = "committed"

    if pass_rate is None:
        passed = (
            passed_count
            if passed_count is not None
            else max(int(run or 0) - int(failures or 0) - int(errors or 0) - int(skipped or 0), 0)
        )
        # H-13: passRate denominator excludes skipped.
        denom = int(passed) + int(failures or 0) + int(errors or 0)
        if denom > 0:
            pass_rate = f"{passed / denom:.0%}"
        else:
            pass_rate = NOT_AVAILABLE

    result = {
        "run": int(run or 0),
        "failures": int(failures or 0),
        "errors": int(errors or 0),
        "skipped": int(skipped or 0),
        "deselected": int(deselected or 0),
        "passRate": pass_rate if pass_rate is not None else NOT_AVAILABLE,
        "source": source,
    }
    if status in {"NOT_RUN", "USER_SKIPPED", "SKIPPED"}:
        result["status"] = status if status != "SKIPPED" else "USER_SKIPPED"
    attempt_records: list[dict[str, Any]] = []
    for key in ("history", "attempts"):
        records = unit.get(key)
        if isinstance(records, list):
            attempt_records.extend(item for item in records if isinstance(item, dict))
    if not attempt_records:
        attempt_records = [unit]
    seen_attempts: set[str] = set()
    per_attempt: list[dict[str, Any]] = []
    unique_identities: set[str] = set()
    for index, attempt in enumerate(attempt_records, start=1):
        attempt_key = json.dumps(
            {
                "attempt": attempt.get("attempt"),
                "runId": attempt.get("runId") or attempt.get("run_id"),
                "finishedAt": attempt.get("finishedAt") or attempt.get("completedAt"),
                "metrics": attempt.get("metrics"),
            },
            ensure_ascii=False,
            sort_keys=True,
            default=str,
        )
        if attempt_key in seen_attempts:
            continue
        seen_attempts.add(attempt_key)
        attempt_metrics = (
            attempt.get("metrics") if isinstance(attempt.get("metrics"), dict) else attempt
        )
        attempt_total = int(
            attempt_metrics.get(
                "total",
                attempt_metrics.get("run", attempt_metrics.get("testsRun", 0)),
            )
            or 0
        )
        attempt_failed = int(
            attempt_metrics.get("failed", attempt_metrics.get("failures", 0)) or 0
        )
        attempt_errors = int(attempt_metrics.get("errors", 0) or 0)
        attempt_skipped = int(attempt_metrics.get("skipped", 0) or 0)
        attempt_passed = int(
            attempt_metrics.get(
                "passed",
                max(
                    attempt_total - attempt_failed - attempt_errors - attempt_skipped,
                    0,
                ),
            )
            or 0
        )
        if attempt_total == 0 and isinstance(attempt.get("evidence"), str):
            fraction = _result_fraction(str(attempt["evidence"]))
            if fraction is not None:
                attempt_passed, attempt_total = fraction
                attempt_failed = max(attempt_total - attempt_passed, 0)
        raw_identities = (
            attempt.get("testIdentities")
            or attempt_metrics.get("testIdentities")
            or attempt.get("testIds")
            or attempt_metrics.get("testIds")
            or []
        )
        identities = (
            sorted({str(item) for item in raw_identities if str(item)})
            if isinstance(raw_identities, list)
            else []
        )
        unique_identities.update(identities)
        per_attempt.append(
            {
                "attempt": attempt.get("attempt", index),
                "status": str(attempt.get("status") or status or "UNKNOWN").upper(),
                "run": attempt_total,
                "passed": attempt_passed,
                "failures": attempt_failed,
                "errors": attempt_errors,
                "skipped": attempt_skipped,
                "deselected": int(attempt_metrics.get("deselected", 0) or 0),
                "testIdentities": identities,
            }
        )
    result["perAttemptCounts"] = per_attempt
    result["latestAuthoritativeAttempt"] = per_attempt[-1] if per_attempt else None
    result["uniqueTestIdentities"] = sorted(unique_identities)
    result["uniqueTestCount"] = len(unique_identities)
    result["rerunCount"] = max(len(per_attempt) - 1, 0)
    return result


def _ledger_api_tests(
    ledger: dict[str, Any] | None,
    *,
    change_dir: Path | None = None,
) -> dict[str, Any]:
    empty = {
        "status": "NOT_RUN",
        "total": 0,
        "executed": 0,
        "passed": 0,
        "failed": 0,
        "blocked": 0,
        "passRate": NOT_AVAILABLE,
        "executionRate": NOT_AVAILABLE,
        "source": "not-run",
    }
    if not ledger:
        return empty
    validations = ledger.get("validations") or ledger.get("verification") or {}
    api = validations.get("apiTest") or validations.get("apiTests") or {}
    if not isinstance(api, dict):
        return empty
    status = str(api.get("status") or "NOT_RUN").upper()
    if status in {"OK", "PASS", "PASSED", "SUCCESS"}:
        status = "OK"
    elif status in {"SKIP", "SKIPPED"}:
        status = "USER_SKIPPED"

    total = passed = failed = blocked = 0
    pass_rate: Any = None
    source = "committed"
    counted = False

    metrics = api.get("metrics")
    normalized_metrics = (
        {str(key).lower(): value for key, value in metrics.items()}
        if isinstance(metrics, dict)
        else {}
    )
    if any(
        k in normalized_metrics
        for k in ("total", "passed", "pass", "failed", "fail", "blocked")
    ):
        passed = int(
            normalized_metrics.get("passed", normalized_metrics.get("pass", 0)) or 0
        )
        failed = int(
            normalized_metrics.get("failed", normalized_metrics.get("fail", 0)) or 0
        )
        blocked = int(normalized_metrics.get("blocked", 0) or 0)
        total = int(
            normalized_metrics.get("total", passed + failed + blocked) or 0
        )
        pass_rate = normalized_metrics.get("passrate")
        source = "committed"
        counted = total > 0 or passed > 0 or failed > 0 or blocked > 0

    evidence_raw = api.get("evidence")
    if not counted and isinstance(evidence_raw, dict):
        total = int(evidence_raw.get("total", api.get("total", 0)) or 0)
        passed = int(evidence_raw.get("passed", api.get("passed", 0)) or 0)
        failed = int(evidence_raw.get("failed", api.get("failed", 0)) or 0)
        blocked = int(evidence_raw.get("blocked", api.get("blocked", 0)) or 0)
        pass_rate = evidence_raw.get("passRate") or api.get("passRate")
        source = "committed"
        counted = total > 0 or passed > 0 or failed > 0 or blocked > 0

    evidence_text = evidence_raw if isinstance(evidence_raw, str) else ""
    if not counted and evidence_text:
        matches = list(_RE_API_PASSED.finditer(evidence_text))
        if matches:
            m = matches[-1]
            passed = int(m.group(1))
            total = int(m.group(2))
            failed = max(total - passed, 0)
            blocked = 0
            source = "evidence-text"
            counted = True
        else:
            fraction = _result_fraction(evidence_text)
            if fraction is not None:
                passed, total = fraction
                failed = max(total - passed, 0)
                blocked = 0
                source = "evidence-text"
                counted = True

    if not counted and change_dir is not None:
        results_path = change_dir / "runtime" / "api-test-results.json"
        if results_path.is_file():
            try:
                raw = read_json(results_path)
            except (OSError, json.JSONDecodeError):
                raw = None
            if isinstance(raw, dict) and all(
                isinstance(raw.get(k), int) for k in ("total", "passed", "failed", "blocked")
            ):
                total = int(raw["total"])
                passed = int(raw["passed"])
                failed = int(raw["failed"])
                blocked = int(raw["blocked"])
                source = "api-test-results"
                counted = True

    if not counted:
        total = int(api.get("total", 0) or 0)
        passed = int(api.get("passed", 0) or 0)
        failed = int(api.get("failed", 0) or 0)
        blocked = int(api.get("blocked", 0) or 0)
        pass_rate = api.get("passRate")
        source = "committed"

    executed = passed + failed
    pass_rate = f"{passed / executed:.0%}" if executed > 0 else NOT_AVAILABLE
    execution_rate = f"{executed / total:.0%}" if total > 0 else NOT_AVAILABLE

    return {
        "status": status,
        "total": int(total or 0),
        "executed": int(executed or 0),
        "passed": int(passed or 0),
        "failed": int(failed or 0),
        "blocked": int(blocked or 0),
        "passRate": pass_rate,
        "executionRate": execution_rate,
        "source": source,
    }


def _risks_from_test_results(change_dir: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """PARTIAL/OPEN/UNKNOWN/DEFERRED scenarios -> (knownRisks, manualActions).

    Scenario IDs are preserved so risks stay traceable to the test report
    (UT-013/RET-25); PARTIAL is a fact, not a pass.
    """
    risk_statuses = {"PARTIAL", "OPEN", "UNKNOWN", "DEFERRED", "BLOCKED"}
    results_path = change_dir / "runtime" / "api-test-results.json"
    if not results_path.is_file():
        return [], []
    try:
        raw = read_json(results_path)
    except (OSError, json.JSONDecodeError):
        return [], []
    scenarios = raw.get("scenarios") if isinstance(raw, dict) else None
    if not isinstance(scenarios, list):
        return [], []
    risks: list[dict[str, Any]] = []
    actions: list[dict[str, Any]] = []
    for item in scenarios:
        if not isinstance(item, dict):
            continue
        status = str(item.get("status") or "").upper()
        if status not in risk_statuses:
            continue
        scenario_id = str(item.get("id") or item.get("scenario") or "").strip()
        note = str(item.get("note") or item.get("message") or "").strip()
        risks.append(
            {
                "phase": "test",
                "severity": "medium",
                "scenarioId": scenario_id,
                "status": status,
                "message": f"{scenario_id}: {status}" + (f" — {note}" if note else ""),
            }
        )
        actions.append(
            {
                "stage": "test",
                "status": status,
                "scenarioId": scenario_id,
                "action": "补齐该场景的完整验证或显式接受风险",
            }
        )
    return risks, actions


def _ledger_db_compat(ledger: dict[str, Any] | None) -> dict[str, Any]:
    """Project only typed DB compatibility evidence; command text is not proof."""
    empty = {"status": "NOT_RUN", "source": "not-run"}
    if not ledger:
        return empty
    validations = ledger.get("validations") or {}
    db = validations.get("dbCompatibility") or validations.get("db") or {}
    if not isinstance(db, dict):
        return empty
    raw_status = str(db.get("status") or "").upper()
    if raw_status in {"NOT_RUN", "USER_SKIPPED", "SKIPPED"}:
        return {"status": "NOT_RUN", "source": "typed-ledger"}
    if raw_status == "UNKNOWN":
        return {"status": "UNKNOWN", "source": "typed-ledger"}
    metrics = db.get("metrics")
    receipt = db.get("receipt")
    if not isinstance(metrics, dict) and isinstance(receipt, dict):
        candidate = receipt.get("metrics", receipt)
        metrics = candidate if isinstance(candidate, dict) else None
    if not isinstance(metrics, dict):
        return {"status": "EVIDENCE_MISSING", "source": "typed-ledger"}
    applicability = str(metrics.get("applicability") or "").upper()
    if applicability == "NOT_APPLICABLE":
        reason = str(metrics.get("reason") or "").strip()
        return {
            "status": "NOT_APPLICABLE" if reason else "EVIDENCE_MISSING",
            "reason": reason,
            "source": "typed-receipt" if isinstance(receipt, dict) else "typed-ledger",
        }
    if applicability != "APPLICABLE":
        return {"status": "UNKNOWN", "source": "typed-ledger"}
    typed_status = str(metrics.get("status") or "").upper()
    total = metrics.get("total")
    passed = metrics.get("passed")
    failed = metrics.get("failed")
    evidence_hash = metrics.get("evidenceHash")
    valid_counts = (
        all(isinstance(value, int) and not isinstance(value, bool) and value >= 0
            for value in (total, passed, failed))
        and passed + failed == total
    )
    valid_hash = isinstance(evidence_hash, str) and bool(
        re.fullmatch(r"sha256:[0-9a-f]{64}", evidence_hash)
    )
    if typed_status not in {"OK", "FAIL"} or not valid_counts or not valid_hash:
        return {"status": "EVIDENCE_MISSING", "source": "typed-ledger"}
    return {
        "status": typed_status,
        "applicability": applicability,
        "total": total,
        "passed": passed,
        "failed": failed,
        "evidenceHash": evidence_hash,
        "source": "typed-receipt" if isinstance(receipt, dict) else "typed-ledger",
    }


def _typed_test_metrics(entry: dict[str, Any], *, total_key: str) -> dict[str, Any]:
    """Project a ledger v3 typed metrics entry to the canonical view."""
    metrics = entry.get("metrics") if isinstance(entry.get("metrics"), dict) else {}
    total = int(metrics.get(total_key, 0) or 0)
    passed = int(metrics.get("passed", 0) or 0)
    failed = int(metrics.get("failed", 0) or 0)
    executed = passed + failed
    status = str(entry.get("status") or "").upper() or "NOT_RUN"
    out: dict[str, Any] = {
        "status": status,
        "total": total,
        "executed": executed,
        "passed": passed,
        "failed": failed,
        "passRate": f"{passed / executed:.0%}" if executed > 0 else NOT_AVAILABLE,
        "executionRate": f"{executed / total:.0%}" if total > 0 else NOT_AVAILABLE,
        "source": "committed" if total > 0 else "not-run",
    }
    for optional_count in ("blocked", "skipped", "retries"):
        if optional_count in metrics:
            out[optional_count] = int(metrics.get(optional_count, 0) or 0)
    applicability = entry.get("applicability")
    if isinstance(applicability, dict):
        out["applicability"] = applicability
    return out


def build_verification_projection(
    ledger: dict[str, Any] | None,
    *,
    change_dir: Path | None = None,
) -> dict[str, Any]:
    """Canonical verification view shared by collector and validators (RET-16).

    apiContract and browserE2E are distinct typed projections; the legacy
    apiTests mapping is retained for schema compatibility.
    """
    effective_ledger = _deepcopy_json(ledger or {})
    projected_validations = hrm.latest_terminal_validations(effective_ledger)
    if projected_validations:
        effective_ledger["validations"] = projected_validations
    validations = effective_ledger.get("validations") or {}
    projection: dict[str, Any] = {
        "unitTests": _ledger_unit_tests(effective_ledger),
        "apiTests": _ledger_api_tests(effective_ledger, change_dir=change_dir),
    }
    db_compatibility = _ledger_db_compat(effective_ledger)
    if db_compatibility["status"] in {
        "NOT_RUN",
        "UNKNOWN",
        "EVIDENCE_MISSING",
    } and change_dir is not None:
        gate_policy_path = change_dir / "meta" / "gate-policy.json"
        try:
            gate_policy = read_json(gate_policy_path) if gate_policy_path.is_file() else None
        except (OSError, json.JSONDecodeError):
            gate_policy = None
        if isinstance(gate_policy, dict):
            capabilities = gate_policy.get("capabilities")
            required_names: set[str] = set()
            for field in ("requiredValidations", "requiredValidationsByPhase"):
                required = gate_policy.get(field)
                if isinstance(required, list):
                    required_names.update(str(item) for item in required)
                elif isinstance(required, dict):
                    for phase_items in required.values():
                        if isinstance(phase_items, list):
                            required_names.update(str(item) for item in phase_items)
            has_database_capability = (
                isinstance(capabilities, list) and "database" in capabilities
            )
            if not has_database_capability and "dbCompatibility" not in required_names:
                db_compatibility = {
                    "status": "NOT_APPLICABLE",
                    "reason": "门禁策略未声明数据库能力或数据库兼容性验证要求",
                    "source": "capability-profile",
                }
    projection["dbCompatibility"] = db_compatibility["status"]
    projection["dbCompatibilityEvidence"] = db_compatibility
    api_contract = validations.get("apiContract")
    if isinstance(api_contract, dict):
        projection["apiContract"] = _typed_test_metrics(
            api_contract, total_key="scenariosTotal"
        )
    browser_e2e = validations.get("browserTest") or validations.get("browserE2E")
    if isinstance(browser_e2e, dict):
        projection["browserE2E"] = _typed_test_metrics(browser_e2e, total_key="total")
    performance = validations.get("performance")
    if isinstance(performance, dict):
        projection["performance"] = {
            "status": str(performance.get("status") or "NOT_RUN").upper(),
            "metrics": _deepcopy_json(
                performance.get("metrics")
                if isinstance(performance.get("metrics"), dict)
                else {}
            ),
            "source": "committed",
        }
    return projection


def _parse_durations_from_log(log_text: str) -> dict[str, Any]:
    """Best-effort parse of harness-* sections from execution-log."""
    stages: list[dict[str, Any]] = []
    # Match both old hand-written and events-rendered phase headers.
    section_re = re.compile(
        r"(?:###\s*\[\d+\]\s*)?harness-(\w+)|##\s+(plan|run|test|review|submit|merge|archive)\b",
        re.IGNORECASE,
    )
    start_re = re.compile(r"\*\*开始\*\*:\s*(.+)")
    end_re = re.compile(r"\*\*结束\*\*:\s*(.+)")
    dur_re = re.compile(r"\*\*耗时\*\*:\s*(.+)")
    result_re = re.compile(r"\*\*结果\*\*:\s*(.+)")

    lines = log_text.splitlines()
    i = 0
    while i < len(lines):
        m = section_re.search(lines[i])
        if not m:
            i += 1
            continue
        stage = (m.group(1) or m.group(2) or "").lower()
        skill = f"harness-{stage}" if not stage.startswith("harness") else stage
        started = ended = None
        minutes = 0.0
        result = "OK"
        j = i + 1
        while j < len(lines) and not section_re.search(lines[j]):
            sm = start_re.search(lines[j])
            if sm:
                started = sm.group(1).strip()
            em = end_re.search(lines[j])
            if em:
                ended = em.group(1).strip()
            dm = dur_re.search(lines[j])
            if dm:
                raw = dm.group(1).strip()
                mm = re.search(r"(\d+)\s*分", raw)
                ss = re.search(r"(\d+)\s*秒", raw)
                minutes = (int(mm.group(1)) if mm else 0) + (
                    (int(ss.group(1)) if ss else 0) / 60.0
                )
                if minutes == 0:
                    ms = re.search(r"([\d.]+)\s*s", raw, re.I)
                    if ms:
                        minutes = float(ms.group(1)) / 60.0
            rm = result_re.search(lines[j])
            if rm:
                raw_r = rm.group(1)
                if "FAIL" in raw_r or "❌" in raw_r:
                    result = "FAIL"
                elif "WARN" in raw_r or "🟡" in raw_r:
                    result = "WARN"
                else:
                    result = "OK"
            j += 1
        stages.append(
            {
                "stage": stage.replace("harness-", ""),
                "skill": skill if skill.startswith("harness-") else f"harness-{stage}",
                "startedAt": started or NOT_AVAILABLE,
                "endedAt": ended or NOT_AVAILABLE,
                "minutes": round(minutes, 2),
                "result": result,
            }
        )
        i = j

    total = round(sum(float(s["minutes"]) for s in stages), 2)
    return {
        "totalLabel": f"约 {int(round(total))} 分" if total else "约 0 分",
        "totalMinutes": total,
        "stages": stages,
    }


def _skill_calls_from_stages(stages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    counts: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for s in stages:
        skill = str(s.get("skill") or s.get("stage") or "unknown")
        if skill not in counts:
            counts[skill] = {"skill": skill, "count": 0, "result": s.get("result") or "OK"}
            order.append(skill)
        counts[skill]["count"] += 1
        counts[skill]["result"] = s.get("result") or counts[skill]["result"]
    return [counts[k] for k in order]


def _phases_from_events_summary(summary: dict[str, Any]) -> dict[str, Any]:
    phases_out: dict[str, Any] = {}
    for name in ("plan", "run", "test", "review", "submit", "archive"):
        phases_out[name] = {"duration_ms": None, "event_count": 0}
    for name, info in (summary.get("phases") or {}).items():
        key = str(name).lower()
        if key not in phases_out:
            phases_out[key] = {"duration_ms": None, "event_count": 0}
        phases_out[key] = {
            "duration_ms": info.get("duration_ms"),
            "event_count": int(info.get("event_count") or 0),
        }
    return phases_out


def _commands_from_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for e in events:
        if e.get("type") != "command":
            continue
        out.append(
            {
                "command": e.get("command") or "",
                "exit_code": e.get("exit_code"),
                "duration_ms": e.get("duration_ms"),
                "phase": e.get("phase"),
                "timestamp": e.get("timestamp"),
            }
        )
    return out


def _verification_checks_from_events(
    events: list[dict[str, Any]],
    ledger: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    seen: set[str] = set()
    for e in events:
        if e.get("type") != "verification":
            continue
        name = str(e.get("name") or "unnamed")
        status = str(e.get("status") or "unknown").lower()
        checks.append(
            {
                "name": name,
                "status": status,
                "command": e.get("command") or "",
                "source": "events.ndjson",
            }
        )
        seen.add(name.lower())
    if ledger:
        validations = ledger.get("validations") or {}
        if isinstance(validations, dict):
            for name, info in validations.items():
                if name.lower() in seen:
                    continue
                if not isinstance(info, dict):
                    continue
                checks.append(
                    {
                        "name": name,
                        "status": str(info.get("status") or "unknown").lower(),
                        "command": str(info.get("command") or ""),
                        "source": "evidence/verification-ledger.json",
                    }
                )
    return checks


def _artifacts_from_events(
    events: list[dict[str, Any]],
    *,
    change_dir: Path | None = None,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for e in events:
        if e.get("type") != "artifact":
            continue
        raw_path = str(e.get("path") or "")
        archived_path = raw_path
        if change_dir is not None and raw_path:
            normalized = raw_path.replace("\\", "/")
            same_change_prefix = f".harness/changes/{change_dir.name}/"
            if normalized.startswith(same_change_prefix):
                archived_path = normalized[len(same_change_prefix):]
            product_copy = change_dir / "artifacts" / "product" / raw_path
            if archived_path == raw_path and not (change_dir / raw_path).is_file() and product_copy.is_file():
                archived_path = product_copy.relative_to(change_dir).as_posix()
        out.append(
            {
                "path": archived_path,
                **({"sourcePath": raw_path} if archived_path != raw_path else {}),
                "kind": e.get("kind") or "",
                "phase": e.get("phase") or "",
            }
        )
    return out


def _durations_from_event_phases(
    event_summary: dict[str, Any],
    events: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    # Canonical per-phase timing (UT-008/RET-20): one reducer feeds every view.
    # totalMinutes remains active-only (IA-2); use top-level timing for wall clock.
    cutoff = None
    if events:
        stamps = [e.get("timestamp") for e in events if e.get("timestamp")]
        cutoff = str(stamps[-1]) if stamps else None
    canonical: dict[str, dict[str, Any]] = {}
    if events:
        for phase_name, phase_events in he.group_events_by_phase(events):
            canonical[phase_name] = he.canonical_phase_timing(
                phase_events, cutoff_ts=cutoff
            )
    stages: list[dict[str, Any]] = []
    total_ms = 0
    for name, info in (event_summary.get("phases") or {}).items():
        dur = info.get("duration_ms")
        minutes = round((dur or 0) / 60000, 2) if dur is not None else 0
        if dur:
            total_ms += int(dur)
        attempts = info.get("attempts") if isinstance(info.get("attempts"), list) else []
        result = str(info.get("status") or "UNKNOWN").upper()
        if result in {"PASS", "PASSED", "SUCCESS"}:
            result = "OK"
        elif result in {"FAILED", "ERROR"}:
            result = "FAIL"
        stage: dict[str, Any] = {
            "stage": str(name),
            "skill": f"harness-{name}",
            "startedAt": info.get("started_at") or NOT_AVAILABLE,
            "endedAt": info.get("ended_at") or NOT_AVAILABLE,
            "minutes": minutes,
            "minutesSemantics": "active-only",
            "result": result,
            "attempts": attempts,
        }
        timing = canonical.get(name)
        if timing:
            stage["activeExecutionMs"] = timing.get("activeExecutionMs")
            # HH-WF-20260730-001: recovered/superseded time (write-path
            # auto-seal) stays disjoint from activeExecutionMs.
            stage["recoveredMs"] = timing.get("recoveredMs")
            stage["wallClockSpanMs"] = timing.get("wallClockSpanMs")
            stage["lateEventCount"] = timing.get("lateEventCount")
            stage["unclosedAttemptCount"] = timing.get("unclosedAttemptCount")
        stages.append(stage)
    total_min = round(total_ms / 60000, 2)
    return {
        "totalLabel": f"约 {int(round(total_min))} 分（活动执行）",
        "totalMinutes": total_min,
        "totalMinutesSemantics": "active-only",
        "stages": stages,
    }


def _stage_status_from_sources(
    events: list[dict[str, Any]],
    ledger: dict[str, Any] | None,
    change_dir: Path,
) -> dict[str, str]:
    status = {
        "plan": "OK",
        "run": "OK",
        "test": "OK",
        "review": "ADVISORY",
        "submit": "OK",
        "archive": "OK",
    }
    projected_events = he.apply_event_corrections(events)
    for event in projected_events:
        if event.get("type") != "phase.end":
            continue
        phase = str(event.get("phase") or "").lower()
        raw = str(event.get("status") or "").upper()
        if phase not in status or not raw:
            continue
        if raw in {"PASS", "PASSED", "SUCCESS"}:
            raw = "OK"
        elif raw in {"FAILED", "ERROR"}:
            raw = "FAIL"
        elif raw in {"SKIP", "SKIPPED"}:
            raw = "USER_SKIPPED"
        status[phase] = raw
    # Issues in events can downgrade. H-14: informational / hygiene / agent-preflight
    # notes must not downgrade an already-OK phase.end.
    _informational_markers = (
        "[archive-hygiene]",
        "informational",
        "custom_agents_unsupported",
        "definition_not_found_host_capable",
        "知识查询",
        "knowledge query",
        "harness-explorer",
        "harness-evaluator",
        "委派",
    )
    for e in he.current_issues(events):
        sev = str(e.get("severity") or "").lower()
        issue_text = " ".join(str(e.get(key) or "") for key in ("message", "note", "code")).lower()
        if not sev:
            if any(token in issue_text for token in ("fail", "error", "blocked", "失败", "阻塞")):
                sev = "error"
            elif any(token in issue_text for token in ("warn", "skip", "风险", "警告")):
                sev = "warn"
        if sev in {"warn", "warning"} and any(m in issue_text for m in _informational_markers):
            continue
        if sev in {"", "info", "note", "informational"}:
            continue
        phase = str(e.get("phase") or "").lower()
        if phase in status and sev in {"error", "fail", "failed", "critical"}:
            status[phase] = "FAIL"
        elif phase in status and sev in {"warn", "warning"} and status[phase] == "OK":
            status[phase] = "WARN"

    api = _ledger_api_tests(ledger, change_dir=change_dir)
    db = _ledger_db_compat(ledger)
    api_status = str(api.get("status") or "").upper()
    if api_status in {"FAIL", "FAILED", "ERROR"} or int(api.get("failed") or 0) > 0:
        status["test"] = "FAIL"
    elif api_status in {"BLOCKED", "BLOCKED_BY_ENV", "BLOCKED_BY_DBA"}:
        status["test"] = api_status
    elif api_status == "USER_SKIPPED":
        status["test"] = "USER_SKIPPED"
    elif db == "BLOCKED_BY_DBA":
        status["test"] = "BLOCKED_BY_DBA"
    elif api.get("status") == "NOT_RUN" and not find_test_reports(change_dir):
        unit = _ledger_unit_tests(ledger)
        if unit.get("source") == "not-run" and unit.get("run", 0) == 0:
            status["test"] = "NOT_RUN"

    if not review_evidence_present(change_dir, projected_events):
        status["review"] = "ADVISORY"

    return status


def _compute_final_status(
    stage_status: dict[str, str],
    verification: dict[str, Any],
) -> tuple[str, list[str]]:
    api = verification.get("apiTests") or {}
    browser = verification.get("browserE2E") or {}
    db = str(verification.get("dbCompatibility") or "")
    api_status = str(api.get("status") or "")
    browser_status = str(browser.get("status") or "")
    reasons: list[str] = []
    for phase, v in stage_status.items():
        # Archive is closeout/transport state, not a product-quality gate. Keep
        # its failed attempt visible in stageStatus and the command payload,
        # but do not let it poison a later finalize retry.
        if phase == "archive":
            continue
        if v == "FAIL":
            return "FAIL", [f"stage {phase}=FAIL"]
    unit = verification.get("unitTests") or {}
    if int(unit.get("failures") or 0) > 0:
        return "FAIL", [f"unitTests.failures={unit.get('failures')}"]
    if int(unit.get("errors") or 0) > 0:
        return "FAIL", [f"unitTests.errors={unit.get('errors')}"]
    if int(api.get("failed") or 0) > 0:
        return "FAIL", [f"apiTests.failed={api.get('failed')}"]
    if int(browser.get("failed") or 0) > 0:
        return "FAIL", [f"browserE2E.failed={browser.get('failed')}"]
    if browser_status == "FAIL":
        return "FAIL", ["browserE2E.status=FAIL"]
    conditional = {
        "USER_SKIPPED", "BLOCKED", "BLOCKED_BY_ENV", "BLOCKED_BY_DBA",
        "NOT_RUN", "PARTIAL",
    }
    if api_status in conditional:
        reasons.append(f"apiTests.status={api_status}")
    if browser_status in conditional:
        reasons.append(f"browserE2E.status={browser_status}")
    if db in conditional:
        reasons.append(f"dbCompatibility={db}")
    if reasons:
        return "CONDITIONAL_OK", reasons
    for phase, v in stage_status.items():
        if phase == "archive":
            continue
        if v == "WARN":
            return "WARN", [f"stage {phase}=WARN"]
        if v in conditional:
            return "CONDITIONAL_OK", [f"stage {phase}={v}"]
    return "OK", []


def load_gate_policy(change_dir: Path) -> dict[str, Any] | None:
    path = change_dir / "meta" / "gate-policy.json"
    if not path.is_file():
        return None
    try:
        data = read_json(path)
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or data.get("schemaVersion") != 1:
        return None
    return data


_RISK_SEVERITIES = frozenset({"warning", "error", "critical"})


def _cleanup_transients(work_dir: Path) -> dict[str, Any]:
    """Delete lock/pid/launcher/credential files; truncate oversized logs."""
    deleted: list[str] = []
    truncated: list[dict[str, Any]] = []

    def _rel(path: Path) -> str:
        try:
            return path.relative_to(work_dir).as_posix()
        except ValueError:
            return str(path)

    lock = work_dir / "events.ndjson.lock"
    if lock.is_file():
        try:
            lock.unlink()
            deleted.append(_rel(lock))
        except OSError:
            pass

    runtime = work_dir / "runtime"
    if runtime.is_dir():
        for path in sorted(runtime.iterdir()):
            if not path.is_file():
                continue
            name = path.name
            drop = False
            if name.endswith(".pid"):
                drop = True
            elif name in {
                "_harness_service_launcher.py",
                "_harness_service.command.txt",
            }:
                drop = True
            elif re.search(r"credential|token|secret", name, re.I):
                drop = True
            if drop:
                try:
                    path.unlink()
                    deleted.append(_rel(path))
                except OSError:
                    pass

    logs_root = work_dir / "logs"
    if logs_root.is_dir():
        for path in sorted(logs_root.rglob("*.log")):
            if not path.is_file():
                continue
            try:
                size = path.stat().st_size
            except OSError:
                continue
            if size <= 65536:
                continue
            try:
                with path.open("rb") as handle:
                    handle.seek(-65536, 2)
                    tail = handle.read()
                header = (
                    f"# [truncated by harness-archive finalize: original {size} bytes]\n"
                ).encode("utf-8")
                path.write_bytes(header + tail)
                truncated.append({"path": _rel(path), "originalBytes": size})
            except OSError:
                pass

    return {"deleted": deleted, "truncated": truncated}


def write_archive_meta(work_dir: Path, summary: dict[str, Any]) -> Path:
    """Generate meta/archive-meta.md from summary-data (single ownership)."""
    archive_id = work_dir.name
    change_name = str(summary.get("changeName") or work_dir.name)
    archived_at = dt.datetime.now().strftime("%Y-%m-%d %H:%M")
    final_status = str(summary.get("finalStatus") or "UNKNOWN")
    lines = [
        "---",
        f"archive-id: {archive_id}",
        f"change-name: {change_name}",
        f"archived-at: {archived_at}",
        f"final-commit: {summary.get('finalCommit') or ''}",
        f"base-commit: {summary.get('baseCommit') or ''}",
        f"final-status: {final_status}",
        "source: harness-archive",
        "---",
        f"# 归档元数据 — {change_name}",
        "",
        "## 阶段状态",
        "",
        "| 阶段 | 状态 |",
        "|---|---|",
    ]
    for stage, status in (summary.get("stageStatus") or {}).items():
        lines.append(f"| {stage} | {status} |")
    lines.extend(["", "## 变更文件", "", "| 路径 | + | - |", "|---|---|---|"])
    changed = summary.get("changedFiles") or []
    if changed:
        for item in changed:
            lines.append(
                f"| {item.get('path') or ''} | "
                f"{item.get('insertions', 0)} | {item.get('deletions', 0)} |"
            )
    else:
        lines.append("| （无） |  |  |")
    lines.extend(["", "## 已知风险", ""])
    risks = summary.get("knownRisks") or []
    if risks:
        for risk in risks:
            if isinstance(risk, dict):
                lines.append(
                    f"- [{risk.get('severity') or 'unknown'}] "
                    f"{risk.get('message') or risk}"
                )
            else:
                lines.append(f"- {risk}")
    else:
        lines.append("无")
    lines.append("")
    out = work_dir / "meta" / "archive-meta.md"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    return out


def write_knowledge_candidates(work_dir: Path, summary: dict[str, Any]) -> Path:
    """Generate candidates/knowledge.json from summary-data (single ownership).

    Mirrors write_archive_meta: derived from the same summary, written before the
    after-manifest so its bytes are covered. The archive directory name is the
    archive id, matching write_archive_meta's `archive-id` field.
    """
    archive_id = work_dir.name
    candidates = hkc.build_knowledge_candidates(
        summary,
        change_key=str(summary.get("changeName") or archive_id),
        archive_id=archive_id,
        # The archive schema version identifies the producing format; there is
        # no separate harness version constant to borrow here.
        producer_version=SCHEMA_VERSION,
        created_at=now_iso(),
    )
    out = work_dir / "candidates" / "knowledge.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        hkc.render_knowledge_candidates_json(candidates),
        encoding="utf-8",
        newline="\n",
    )
    return out




def _changed_files_from_git(
    project: Path,
    base: str | None,
    head: str | None,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    diff_stat = {
        "filesChanged": 0,
        "insertions": 0,
        "deletions": 0,
        "range": NOT_AVAILABLE,
    }
    changed: list[dict[str, Any]] = []
    if not base or not head:
        return diff_stat, changed
    # The ledger bounds the complete task.  Using only ``head^..head`` would
    # silently omit earlier checkpoint commits from the same change.
    rng = f"{base}..{head}"
    code, out, _ = git_run(project, "diff", "--numstat", rng)
    if code != 0 or not out:
        diff_stat["range"] = rng
        return diff_stat, changed
    insertions = deletions = 0
    files = 0
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        ins_s, del_s, path = parts[0], parts[1], parts[2]
        ins = int(ins_s) if ins_s.isdigit() else 0
        dele = int(del_s) if del_s.isdigit() else 0
        insertions += ins
        deletions += dele
        files += 1
        changed.append(
            {
                "path": path,
                "summary": "",
                "insertions": ins,
                "deletions": dele,
            }
        )
    diff_stat = {
        "filesChanged": files,
        "insertions": insertions,
        "deletions": deletions,
        "range": rng,
    }
    return diff_stat, changed


def _review_summary(
    change_dir: Path,
    existing: dict[str, Any] | None,
    events: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    base = {
        "status": "ADVISORY",
        "red": 0,
        "yellow": 0,
        "redFixed": 0,
        "redConfirmed": 0,
        "yellowFixed": 0,
        "yellowDeferred": 0,
        "currentRiskCount": 0,
        "summary": "",
    }
    sidecar = hr.findings_path(change_dir)
    if sidecar.is_file():
        status = hr.status(change_dir)
        items = status.get("items") or []
        red_items = [item for item in items if item.get("severity") == "RED"]
        yellow_items = [item for item in items if item.get("severity") == "YELLOW"]
        base.update(
            {
                "status": "ADVISORY",
                "red": len(red_items),
                "yellow": len(yellow_items),
                "redFixed": sum(
                    1 for item in red_items if item.get("disposition") == "FIXED"
                ),
                "redConfirmed": sum(
                    1
                    for item in red_items
                    if item.get("disposition") in {"OPEN", "ACCEPTED_RISK", "DEFERRED"}
                ),
                "yellowFixed": sum(
                    1 for item in yellow_items if item.get("disposition") == "FIXED"
                ),
                "yellowDeferred": sum(
                    1
                    for item in yellow_items
                    if item.get("disposition") in {"DEFERRED", "ACCEPTED_RISK"}
                ),
                "currentRiskCount": int(status.get("currentRiskCount") or 0),
                "currentRisks": list(status.get("currentRisks") or []),
                "summary": f"structured review run {status.get('runId') or 'unknown'}",
            }
        )
        return base
    if existing and isinstance(existing.get("reviewSummary"), dict):
        merged = dict(base)
        merged.update(existing["reviewSummary"])
        return merged
    reports = find_review_reports(change_dir)
    if reports:
        labels: set[tuple[str, str]] = set()
        pattern = re.compile(
            r"(?im)^\s{0,3}(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?"
            r"(RED|YELLOW)[-_\s]?(\d+)\b"
        )
        for report in reports:
            try:
                text = report.read_text(encoding="utf-8-sig")
            except OSError:
                continue
            labels.update(
                (match.group(1).upper(), match.group(2))
                for match in pattern.finditer(text)
            )
        red = sum(1 for severity, _ in labels if severity == "RED")
        yellow = sum(1 for severity, _ in labels if severity == "YELLOW")
        base.update(
            {
                "status": "ADVISORY_UNSTRUCTURED",
                "red": red,
                "yellow": yellow,
                "redConfirmed": red,
                "summary": (
                    "structured review findings missing; counts inferred from "
                    f"{len(reports)} markdown report(s)"
                ),
            }
        )
        return base
    if not review_evidence_present(change_dir, events):
        base["status"] = "ADVISORY_NOT_RUN"
    return base


def _archive_range_adoption_path(change_dir: Path) -> Path:
    return change_dir.resolve() / "meta" / "archive-range-adoption.json"


def _archive_range_receipt_id(payload: dict[str, Any]) -> str:
    canonical = {
        key: value for key, value in payload.items() if key != "receiptId"
    }
    raw = json.dumps(
        canonical,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def _evaluate_existing_range(
    change_dir: Path,
    *,
    base: str,
    tip: str,
) -> dict[str, Any]:
    project = find_project_root(change_dir)
    base_code, resolved_base, base_error = git_run(
        project, "rev-parse", "--verify", f"{base}^{{commit}}"
    )
    tip_code, resolved_tip, tip_error = git_run(
        project, "rev-parse", "--verify", f"{tip}^{{commit}}"
    )
    if base_code != 0 or not resolved_base:
        return {
            "ok": False,
            "reasonCode": "EXISTING_RANGE_BASE_INVALID",
            "message": f"无法解析既有范围基线：{base_error or base}",
        }
    if tip_code != 0 or not resolved_tip:
        return {
            "ok": False,
            "reasonCode": "EXISTING_RANGE_TIP_INVALID",
            "message": f"无法解析既有范围终点：{tip_error or tip}",
        }
    if resolved_base == resolved_tip:
        return {
            "ok": False,
            "reasonCode": "EXISTING_RANGE_EMPTY",
            "message": "既有提交范围为空，不能认领为已完成产品变更。",
        }
    ancestor_code, _, ancestor_error = git_run(
        project, "merge-base", "--is-ancestor", resolved_base, resolved_tip
    )
    if ancestor_code != 0:
        return {
            "ok": False,
            "reasonCode": "EXISTING_RANGE_NOT_ANCESTOR",
            "message": f"范围基线不是终点的祖先：{ancestor_error or resolved_base}",
        }
    identity = resolve_product_archive_identity(change_dir, project=project)
    expected_tip = str(
        identity.get("featureTip") or identity.get("productCommit") or ""
    ).strip()
    if expected_tip:
        expected_code, resolved_expected, _ = git_run(
            project, "rev-parse", "--verify", f"{expected_tip}^{{commit}}"
        )
        if expected_code == 0 and resolved_expected != resolved_tip:
            return {
                "ok": False,
                "reasonCode": "EXISTING_RANGE_TIP_MISMATCH",
                "message": (
                    "既有范围终点与当前产品提交不一致："
                    f"expected={resolved_expected} actual={resolved_tip}"
                ),
            }
    try:
        ownership = hl.compute_ownership_diff(
            project,
            base=resolved_base,
            head=resolved_tip,
            change_dir=change_dir,
        )
    except (OSError, ValueError, RuntimeError) as exc:
        return {
            "ok": False,
            "reasonCode": "EXISTING_RANGE_OWNERSHIP_UNAVAILABLE",
            "message": f"无法验证既有范围归属：{exc}",
        }
    foreign = list(ownership.get("foreignPaths") or [])
    owned = list(ownership.get("files") or [])
    if foreign:
        return {
            "ok": False,
            "reasonCode": "EXISTING_RANGE_FOREIGN_PATHS",
            "message": "既有范围包含不属于本变更的文件。",
            "foreignPaths": foreign,
        }
    if not owned:
        return {
            "ok": False,
            "reasonCode": "EXISTING_RANGE_NO_PRODUCT_FILES",
            "message": "既有范围未包含本变更声明的产品文件。",
        }
    return {
        "ok": True,
        "reasonCode": "EXISTING_RANGE_VALID",
        "project": project,
        "baseCommit": resolved_base,
        "tipCommit": resolved_tip,
        "ownership": ownership,
    }


def validate_existing_range_adoption(change_dir: Path) -> dict[str, Any]:
    path = _archive_range_adoption_path(change_dir)
    if not path.is_file():
        return {
            "ok": True,
            "present": False,
            "reasonCode": "EXISTING_RANGE_NOT_ADOPTED",
            "receiptPath": str(path),
        }
    try:
        receipt = read_json(path)
    except (OSError, json.JSONDecodeError, TypeError) as exc:
        return {
            "ok": False,
            "present": True,
            "reasonCode": "EXISTING_RANGE_RECEIPT_INVALID",
            "message": str(exc),
            "receiptPath": str(path),
        }
    if not isinstance(receipt, dict):
        return {
            "ok": False,
            "present": True,
            "reasonCode": "EXISTING_RANGE_RECEIPT_INVALID",
            "message": "既有范围认领收据必须是 JSON 对象。",
            "receiptPath": str(path),
        }
    issues: list[str] = []
    if receipt.get("schemaVersion") != 1:
        issues.append("schemaVersion")
    if receipt.get("action") != "adopt-existing-range":
        issues.append("action")
    if receipt.get("changeName") != change_dir.name:
        issues.append("changeName")
    if receipt.get("confirmedByUser") is not True:
        issues.append("confirmedByUser")
    reason = str(receipt.get("reason") or "").strip()
    if not reason or re.search(r"[\u4e00-\u9fff]", reason) is None:
        issues.append("reason")
    if receipt.get("receiptId") != _archive_range_receipt_id(receipt):
        issues.append("receiptId")
    if issues:
        return {
            "ok": False,
            "present": True,
            "reasonCode": "EXISTING_RANGE_RECEIPT_INVALID",
            "message": "既有范围认领收据字段无效：" + ", ".join(issues),
            "receiptPath": str(path),
        }
    evaluated = _evaluate_existing_range(
        change_dir,
        base=str(receipt.get("baseCommit") or ""),
        tip=str(receipt.get("tipCommit") or ""),
    )
    if not evaluated.get("ok"):
        return {
            **evaluated,
            "present": True,
            "receiptPath": str(path),
        }
    project = evaluated["project"]
    repository_id = hp.repository_identity(project)
    ownership = evaluated["ownership"]
    if receipt.get("repositoryId") != repository_id:
        issues.append("repositoryId")
    if receipt.get("diffHash") != ownership.get("diffHash"):
        issues.append("diffHash")
    if receipt.get("ownershipHash") != ownership.get("ownershipHash"):
        issues.append("ownershipHash")
    if list(receipt.get("files") or []) != list(ownership.get("files") or []):
        issues.append("files")
    if issues:
        return {
            "ok": False,
            "present": True,
            "reasonCode": "EXISTING_RANGE_RECEIPT_STALE",
            "message": "既有范围认领收据与当前仓库不一致：" + ", ".join(issues),
            "receiptPath": str(path),
        }
    return {
        "ok": True,
        "present": True,
        "reasonCode": "EXISTING_RANGE_ADOPTED",
        "receiptPath": str(path),
        "receipt": receipt,
        "baseCommit": evaluated["baseCommit"],
        "tipCommit": evaluated["tipCommit"],
        "files": list(ownership.get("files") or []),
    }


def adopt_existing_range(
    change_dir: Path,
    *,
    base: str,
    tip: str,
    reason: str,
    confirmed: bool,
) -> dict[str, Any]:
    change_dir = change_dir.resolve()
    path = _archive_range_adoption_path(change_dir)
    if not confirmed:
        return {
            "ok": False,
            "action": "adopt-existing-range",
            "reasonCode": "EXISTING_RANGE_CONFIRMATION_REQUIRED",
            "message": "认领既有提交范围必须先获得用户明确确认。",
            "receiptPath": str(path),
        }
    reason = reason.strip()
    if not reason or re.search(r"[\u4e00-\u9fff]", reason) is None:
        return {
            "ok": False,
            "action": "adopt-existing-range",
            "reasonCode": "EXISTING_RANGE_REASON_REQUIRED",
            "message": "请提供可读的中文认领原因。",
            "receiptPath": str(path),
        }
    evaluated = _evaluate_existing_range(
        change_dir,
        base=base,
        tip=tip,
    )
    if not evaluated.get("ok"):
        return {
            **evaluated,
            "action": "adopt-existing-range",
            "receiptPath": str(path),
        }
    project = evaluated["project"]
    ownership = evaluated["ownership"]
    if path.is_file():
        existing = validate_existing_range_adoption(change_dir)
        existing_receipt = (
            existing.get("receipt")
            if isinstance(existing.get("receipt"), dict)
            else {}
        )
        if (
            existing.get("ok")
            and existing_receipt.get("baseCommit") == evaluated["baseCommit"]
            and existing_receipt.get("tipCommit") == evaluated["tipCommit"]
            and existing_receipt.get("reason") == reason
        ):
            return {
                "ok": True,
                "action": "adopt-existing-range",
                "reasonCode": "EXISTING_RANGE_ADOPTED",
                "idempotent": True,
                "receiptPath": str(path),
                "receipt": existing_receipt,
            }
        return {
            "ok": False,
            "action": "adopt-existing-range",
            "reasonCode": "EXISTING_RANGE_RECEIPT_CONFLICT",
            "message": "已有不同的既有范围认领收据，拒绝覆盖。",
            "receiptPath": str(path),
        }
    receipt = {
        "schemaVersion": 1,
        "action": "adopt-existing-range",
        "changeName": change_dir.name,
        "repositoryId": hp.repository_identity(project),
        "baseCommit": evaluated["baseCommit"],
        "tipCommit": evaluated["tipCommit"],
        "diffHash": ownership["diffHash"],
        "ownershipHash": ownership["ownershipHash"],
        "files": list(ownership.get("files") or []),
        "reason": reason,
        "confirmedByUser": True,
        "recordedAt": now_iso(),
    }
    receipt["receiptId"] = _archive_range_receipt_id(receipt)
    write_json(path, receipt)
    return {
        "ok": True,
        "action": "adopt-existing-range",
        "reasonCode": "EXISTING_RANGE_ADOPTED",
        "idempotent": False,
        "receiptPath": str(path),
        "receipt": receipt,
    }


def _base_from_state_snapshot(change_dir: Path) -> str:
    """Read archive-boundary base from meta/state-snapshot.json when present."""
    for relative in (
        Path("meta") / "state-snapshot.json",
        Path("state-snapshot.json"),
    ):
        path = change_dir / relative
        if not path.is_file():
            continue
        try:
            payload = read_json(path)
        except (OSError, json.JSONDecodeError, TypeError):
            continue
        if not isinstance(payload, dict):
            continue
        change_base = str(payload.get("changeBase") or "").strip()
        if change_base and change_base != NOT_AVAILABLE:
            return change_base
        git_info = payload.get("git")
        if isinstance(git_info, dict):
            base = str(git_info.get("base") or git_info.get("baseCommit") or "").strip()
            if base and base != NOT_AVAILABLE:
                return base
        base = str(payload.get("baseCommit") or payload.get("base") or "").strip()
        if base and base != NOT_AVAILABLE:
            return base
    return ""


def _immutable_change_base_from_snapshot(change_dir: Path) -> str:
    for root in archive_read_roots(change_dir):
        for relative in (
            Path("meta") / "state-snapshot.json",
            Path("state-snapshot.json"),
        ):
            path = root / relative
            if not path.is_file():
                continue
            try:
                payload = read_json(path)
            except (OSError, json.JSONDecodeError, TypeError):
                continue
            if not isinstance(payload, dict):
                continue
            value = str(payload.get("changeBase") or "").strip()
            if value and value != NOT_AVAILABLE:
                return value
    return ""


def _resolve_base_commit(
    ledger: dict[str, Any] | None,
    change_dir: Path,
    project: Path,
    final: str | None,
) -> str:
    """Resolve baseCommit in archive-boundary order.

    Priority (HH-ARCHIVE-20260730-001):
      ledger base
      → archive-boundary state snapshot base
      → phase context
      → merge first parent
      → merge-base

    Latest merge phase context must not override the full change boundary.
    """
    def stable_base(value: Any) -> str:
        candidate = str(value or "").strip()
        if candidate.upper() in {"HEAD", "FETCH_HEAD", "ORIG_HEAD"}:
            return ""
        if candidate.startswith(("refs/", "@{")):
            return ""
        return candidate

    adoption = validate_existing_range_adoption(change_dir)
    if adoption.get("ok") and adoption.get("present"):
        adopted_base = stable_base(adoption.get("baseCommit"))
        if adopted_base:
            return adopted_base

    if ledger:
        base = stable_base(ledger.get("baseCommit"))
        if base and base != NOT_AVAILABLE:
            return base

    snapshot_base = _base_from_state_snapshot(change_dir)
    if snapshot_base:
        return snapshot_base

    ctx_dir = change_dir / "runtime" / "phase-context"
    if ctx_dir.is_dir():
        candidates = sorted(
            (p for p in ctx_dir.glob("*.json") if p.is_file()),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        for path in candidates:
            try:
                payload = read_json(path)
            except (OSError, json.JSONDecodeError, TypeError):
                continue
            if not isinstance(payload, dict):
                continue
            base = stable_base(payload.get("baseCommit"))
            if base and base != NOT_AVAILABLE:
                return base

    final_commit = str(final or "").strip()
    if final_commit and final_commit != NOT_AVAILABLE:
        code, parents_line, _ = git_run(
            project, "rev-list", "--parents", "-n", "1", final_commit
        )
        if code == 0 and parents_line:
            parts = parents_line.split()
            if len(parts) >= 2:
                return parts[1]
        code, merge_base, _ = git_run(project, "merge-base", final_commit, "HEAD")
        if code == 0 and merge_base and merge_base != final_commit:
            return merge_base
    return ""


def _final_commit_from_sources(
    ledger: dict[str, Any] | None,
    events: list[dict[str, Any]],
    existing: dict[str, Any] | None,
    project: Path,
) -> str:
    if ledger:
        for key in (
            "mergeFinalHash", "finalCommit", "finalHash", "changeCommit", "headCommit",
        ):
            value = str(ledger.get(key) or "").strip()
            if value:
                return value
    commit_pattern = re.compile(r"\b[0-9a-f]{7,40}\b", re.IGNORECASE)
    for event in reversed(events):
        if str(event.get("phase") or "").lower() not in {"submit", "merge", "archive"}:
            continue
        text = " ".join(str(event.get(key) or "") for key in ("note", "message", "command"))
        for match in commit_pattern.finditer(text):
            candidate = match.group(0)
            code, resolved, _ = git_run(
                project,
                "rev-parse",
                "--verify",
                f"{candidate}^{{commit}}",
            )
            resolved_lines = str(resolved or "").splitlines()
            resolved_hash = resolved_lines[0].strip() if resolved_lines else ""
            if code == 0 and re.fullmatch(r"[0-9a-f]{40}", resolved_hash, re.IGNORECASE):
                return resolved_hash
    if existing and existing.get("finalCommit"):
        return str(existing["finalCommit"])
    code, head, _ = git_run(project, "rev-parse", "HEAD")
    return head if code == 0 and head else ""


def _business_goal_from_sources(change_dir: Path, events: list[dict[str, Any]]) -> str:
    generic_plan_heading = re.compile(
        r"(?:(?:任务|实施|执行|变更)?计划|(?:implementation|execution|task)?\s*plan)"
        r"(?:\s*[—–-]\s*\S+)?",
        re.IGNORECASE,
    )
    plans_root = change_dir / "plans"
    primary = sorted(plans_root.glob("*-plan.md"))
    secondary = [
        path for path in sorted(plans_root.glob("*.md"))
        if path not in primary
        and "implementation-detail" not in path.name
        and "test-scenarios" not in path.name
    ]
    for plan in [*primary, *secondary]:
        try:
            text = plan.read_text(encoding="utf-8-sig")
        except OSError:
            continue
        body = re.sub(r"\A---\s*\n.*?\n---\s*\n", "", text, count=1, flags=re.DOTALL)
        goal = re.search(r"(?im)^\s*(?:goal|目标|业务目标|需求)\s*[:：]\s*(.+)$", body)
        if goal:
            return goal.group(1).strip()
        scope = re.search(r"(?im)^\s*>?\s*(?:变更范围|目标)\s*[:：]\s*(.+)$", body)
        if scope:
            return scope.group(1).strip()
        # UT-015/RET-27: structured "## 目标" section body wins over the first
        # task-table row — the task row is an activity, not the objective.
        section = re.search(
            r"(?im)^#{1,4}\s*(?:\d+[\.、]\s*)?(?:目标|业务目标|需求背景)\s*$",
            body,
        )
        if section:
            lines: list[str] = []
            for line in body[section.end():].splitlines():
                if re.match(r"^\s*#{1,4}\s", line):
                    break
                clean = line.strip()
                if clean and not clean.startswith(("|", ">", "---")):
                    lines.append(clean)
                if lines:
                    break
            if lines:
                return lines[0]
        heading = re.search(r"(?m)^#\s+(.+?)\s*$", body)
        if heading:
            title = heading.group(1).strip()
            title = re.sub(
                r"\s*[—–-]\s*(?:任务拆分|任务表|实施计划|执行计划|计划)\s*$",
                "",
                title,
            ).strip()
            if title and not generic_plan_heading.fullmatch(title):
                return title
        first_task = re.search(r"(?m)^\s*\|\s*1\s*\|\s*([^|]+?)\s*\|", body)
        if first_task:
            return first_task.group(1).strip()
        for line in body.splitlines():
            clean = line.strip().lstrip("#").strip()
            if generic_plan_heading.fullmatch(clean):
                continue
            if clean and not clean.startswith(("---", ">", "|")) and len(clean) > 8:
                return clean
    for event in events:
        if event.get("type") == "decision":
            value = str(event.get("decision") or event.get("note") or "").strip()
            if value:
                return re.sub(r"^(?:需求收敛|目标)\s*[:：]\s*", "", value)
    return ""


def _timeline_from_events(event_summary: dict[str, Any], events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    timeline: list[dict[str, Any]] = []
    for phase, info in (event_summary.get("phases") or {}).items():
        attempts = info.get("attempts") if isinstance(info.get("attempts"), list) else []
        for attempt in attempts:
            timeline.append({
                "phase": phase,
                "attempt": attempt.get("attempt"),
                "startedAt": attempt.get("started_at"),
                "endedAt": attempt.get("ended_at"),
                "durationMs": attempt.get("duration_ms"),
                "status": attempt.get("status") or "UNKNOWN",
                "executorTool": attempt.get("executor_tool"),
                "executorAgent": attempt.get("executor_agent"),
                "handoffFromTool": attempt.get("handoff_from_tool"),
            })
    for event in events:
        if event.get("type") not in {"decision", "issue"}:
            continue
        timeline.append({
            "phase": event.get("phase"),
            "timestamp": event.get("timestamp"),
            "type": event.get("type"),
            "summary": event.get("decision") or event.get("message") or event.get("note") or "",
        })
    return timeline


def collect_summary_data(
    change_dir: Path,
    *,
    before_manifest: dict[str, Any] | None = None,
    after_manifest: dict[str, Any] | None = None,
    compare_result: dict[str, Any] | None = None,
    write: bool = True,
    for_replay: bool = False,
) -> dict[str, Any]:
    """Build schema 2.2 summary-data from events/ledger/log/manifest/reports."""
    if before_manifest is None:
        frozen_before = change_dir / "evidence" / "archive-manifest-before.json"
        if frozen_before.is_file():
            before_manifest = read_json(frozen_before)
    if after_manifest is None:
        frozen_after = change_dir / "evidence" / "archive-manifest-after.json"
        if frozen_after.is_file():
            after_manifest = read_json(frozen_after)
    if compare_result is None and before_manifest is not None and after_manifest is not None:
        compare_result = compare_manifests(before_manifest, after_manifest)

    template = load_template()
    data = _deepcopy_json(template)
    # Clear placeholder strings from template
    data["schemaVersion"] = SCHEMA_VERSION
    change_name = infer_change_name(change_dir)
    data["changeName"] = change_name

    sources: list[str] = []
    events: list[dict[str, Any]] = []
    events_file = he.events_path(change_dir)
    has_events = events_file.is_file() and events_file.stat().st_size > 0
    if has_events:
        try:
            events = he.load_events(events_file)
            sources.append("events.ndjson")
        except ValueError:
            events = []
    projected_events = he.apply_event_corrections(events) if events else []

    ledger = load_ledger(change_dir)
    if ledger:
        sources.append("evidence/verification-ledger.json")

    ci_metrics, ci_metrics_source = load_ci_metrics(change_dir)
    if ci_metrics_source:
        sources.append(ci_metrics_source)
    remote_cost = build_remote_cost_summary(ci_metrics)

    log_text = load_execution_log(change_dir)
    if log_text:
        sources.append("logs/execution-log.md")

    existing = load_existing_summary(change_dir)
    if existing and for_replay:
        sources.append("reports/final/summary-data.json")

    # Prefer existing summary fields when replaying old archives (golden-stable).
    if for_replay and existing:
        for key in (
            "businessGoal",
            "finalStatus",
            "finalCommit",
            "finalCommitBranch",
            "baseCommit",
            "diffStat",
            "stageStatus",
            "durations",
            "timing",
            "skillCalls",
            "verification",
            "scenarioCoverage",
            "timeline",
            "changedFiles",
            "artifacts",
            "reviewSummary",
            "archiveManifest",
            "uncommittedTestEvidence",
            "maintenanceNotes",
            "knownRisks",
            "manualActions",
            "archiveIntent",
            "releaseIntent",
            "closureDisposition",
            "closureReason",
            "archiveIntegrity",
            "candidateVerification",
            "releaseDecision",
            "releaseEligible",
            "productCommit",
            "featureMergeHash",
            "releaseTipHash",
            "productTreeHash",
            "archiveCommit",
            "environmentHash",
            "changeIdentity",
            "artifactStorage",
            "retention",
            "archiveDurability",
            "remoteCost",
            "efficiency",
            "projection",
        ):
            if key in existing:
                data[key] = _deepcopy_json(existing[key])
    if not for_replay or not isinstance(data.get("remoteCost"), dict):
        data["remoteCost"] = remote_cost
    if not for_replay or not isinstance(data.get("efficiency"), dict):
        data["efficiency"] = heff.collect_efficiency_summary(change_dir)

    event_summary = he.build_summary(change_dir, events) if events else {
        "ok": True,
        "event_count": 0,
        "phases": {},
        "issues": [],
    }

    # businessGoal
    if not data.get("businessGoal") or str(data.get("businessGoal")).startswith("本次"):
        if existing and existing.get("businessGoal"):
            data["businessGoal"] = existing["businessGoal"]
        else:
            inferred_goal = _business_goal_from_sources(change_dir, projected_events)
            data["businessGoal"] = inferred_goal or (NOT_AVAILABLE if for_replay else "")

    # commits
    project = find_project_root(change_dir)
    if not data.get("finalCommit") or str(data.get("finalCommit")).startswith("<"):
        final_commit = _final_commit_from_sources(ledger, projected_events, existing, project)
        data["finalCommit"] = final_commit or (NOT_AVAILABLE if for_replay else "")

    if not data.get("baseCommit") or str(data.get("baseCommit")).startswith("<"):
        if for_replay and existing and existing.get("baseCommit"):
            data["baseCommit"] = existing["baseCommit"]
        else:
            resolved_base = _resolve_base_commit(
                ledger,
                change_dir,
                project,
                str(data.get("finalCommit") or "") or None,
            )
            if resolved_base:
                data["baseCommit"] = resolved_base
            elif existing and existing.get("baseCommit"):
                data["baseCommit"] = existing["baseCommit"]
            else:
                data["baseCommit"] = NOT_AVAILABLE if for_replay else ""

    if not data.get("finalCommitBranch") or str(data.get("finalCommitBranch")).startswith("<"):
        code, branch, _ = git_run(project, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
        if code == 0 and branch:
            data["finalCommitBranch"] = branch
        elif existing and existing.get("finalCommitBranch"):
            data["finalCommitBranch"] = existing["finalCommitBranch"]
        else:
            data["finalCommitBranch"] = NOT_AVAILABLE if for_replay else ""

    # verification
    if not for_replay or not isinstance(data.get("verification"), dict):
        projection = build_verification_projection(ledger, change_dir=change_dir)
        unit = projection["unitTests"]
        api = projection["apiTests"]
        db = projection["dbCompatibility"]
        if not find_test_reports(change_dir) and unit.get("run", 0) == 0:
            if "status" not in unit:
                unit["status"] = "NOT_RUN"
            if api.get("status") in {"", "OK"} and api.get("total", 0) == 0:
                api["status"] = "NOT_RUN"
        coverage = NOT_AVAILABLE
        if existing and isinstance(existing.get("verification"), dict):
            coverage = existing["verification"].get("coverageDisplay", coverage)
        data["verification"] = {
            "unitTests": unit,
            "apiTests": api,
            "dbCompatibility": db,
            "dbCompatibilityEvidence": projection["dbCompatibilityEvidence"],
            "coverageDisplay": coverage,
        }
        for typed_key in ("apiContract", "browserE2E", "performance"):
            if typed_key in projection:
                data["verification"][typed_key] = projection[typed_key]
        if ci_metrics is not None:
            data["verification"]["ciMetrics"] = _deepcopy_json(ci_metrics)
    else:
        # Ensure nested keys exist for old schema 2.1
        ver = data.setdefault("verification", {})
        ver.setdefault("unitTests", {})
        ver.setdefault("apiTests", {})
        ver.setdefault("dbCompatibility", ver.get("dbCompatibility", NOT_AVAILABLE))
        ver.setdefault("dbCompatibilityEvidence", {})
        ver.setdefault("coverageDisplay", ver.get("coverageDisplay", NOT_AVAILABLE))

    if not for_replay or not isinstance(data.get("scenarioCoverage"), dict):
        data["scenarioCoverage"] = hgate._validate_scenario_coverage(change_dir)

    # stageStatus / finalStatus
    if not for_replay or not isinstance(data.get("stageStatus"), dict):
        data["stageStatus"] = _stage_status_from_sources(events, ledger, change_dir)
    if not for_replay or not data.get("finalStatus") or str(data.get("finalStatus")).startswith("OK |"):
        final_status, final_reasons = _compute_final_status(
            data.get("stageStatus") or {},
            data.get("verification") or {},
        )
        data["finalStatus"] = final_status
        data["finalStatusReasons"] = list(final_reasons)
    else:
        data.setdefault("finalStatusReasons", [])

    gate_policy = load_gate_policy(change_dir)
    data["riskTier"] = str((gate_policy or {}).get("tier") or "unknown")
    intent_path = change_dir / "meta" / "archive-intent.json"
    intent_data: dict[str, Any] = {}
    if intent_path.is_file():
        try:
            loaded_intent = read_json(intent_path)
            intent_data = loaded_intent if isinstance(loaded_intent, dict) else {}
            sources.append("meta/archive-intent.json")
        except (OSError, json.JSONDecodeError):
            intent_data = {}
    candidate_gate = evaluate_product_ci_gate(change_dir)
    data["archiveIntent"] = str(
        intent_data.get("intent") or "release-candidate"
    )
    data["releaseIntent"] = str(
        intent_data.get("releaseIntent")
        or ("candidate" if data["archiveIntent"] == "release-candidate" else "none")
    )
    data["closureDisposition"] = str(
        intent_data.get("closureDisposition") or "completed"
    )
    raw_closure_reason = intent_data.get("closureReason")
    data["closureReason"] = (
        str(raw_closure_reason).strip()
        if isinstance(raw_closure_reason, str) and raw_closure_reason.strip()
        else None
    )
    data["archiveIntegrity"] = {"ok": True}
    data["candidateVerification"] = candidate_gate

    # durations / skillCalls
    if events:
        data["durations"] = _durations_from_event_phases(event_summary, events)
        data["skillCalls"] = _skill_calls_from_stages(data["durations"].get("stages") or [])
        stamps = [e.get("timestamp") for e in projected_events if e.get("timestamp")]
        cutoff = str(stamps[-1]) if stamps else None
        data["timing"] = build_workflow_timing(projected_events, report_cutoff_at=cutoff)
    elif log_text and (not for_replay or not data.get("durations")):
        data["durations"] = _parse_durations_from_log(log_text)
        data["skillCalls"] = _skill_calls_from_stages(data["durations"].get("stages") or [])
        data.setdefault(
            "timing",
            {
                "workflowStartedAt": NOT_AVAILABLE,
                "reportCutoffAt": NOT_AVAILABLE,
                "workflowWallClockMs": 0,
                "stageActiveExecutionMs": int(
                    round(float(data["durations"].get("totalMinutes") or 0) * 60000)
                ),
                "stageWallClockSpanMs": 0,
                "externalWaitMs": 0,
                "agentOrToolUnattributedMs": 0,
                "unclosedAttemptCount": 0,
                "postArchiveEventsExcluded": 0,
                "totalMinutesSemantics": "active-only",
            },
        )
    elif not data.get("durations"):
        data["durations"] = {
            "totalLabel": NOT_AVAILABLE,
            "totalMinutes": 0,
            "totalMinutesSemantics": "active-only",
            "stages": [],
        }
        data["skillCalls"] = []
        data.setdefault(
            "timing",
            {
                "workflowStartedAt": NOT_AVAILABLE,
                "reportCutoffAt": NOT_AVAILABLE,
                "workflowWallClockMs": 0,
                "stageActiveExecutionMs": 0,
                "stageWallClockSpanMs": 0,
                "externalWaitMs": 0,
                "agentOrToolUnattributedMs": 0,
                "unclosedAttemptCount": 0,
                "postArchiveEventsExcluded": 0,
                "totalMinutesSemantics": "active-only",
            },
        )

    # IA-1/4 identity (product vs archive)
    if not for_replay:
        identity = resolve_product_archive_identity(change_dir, project=project)
        data["checkpointCommit"] = identity.get("checkpointCommit") or ""
        data["productCommit"] = identity.get("productCommit") or data.get("finalCommit")
        data["featureTip"] = identity.get("featureTip") or data["productCommit"]
        data["mergeCommit"] = identity.get("mergeCommit") or ""
        data["releaseTip"] = identity.get("releaseTip") or data.get("archiveCommit")
        data["featureMergeHash"] = data["mergeCommit"] or data.get("finalCommit")
        data["releaseTipHash"] = data["releaseTip"] or data.get("archiveCommit")
        data["productTreeHash"] = identity.get("productTreeHash")
        data["archiveCommit"] = identity.get("archiveCommit") or data.get("finalCommit")
        data["environmentHash"] = identity.get("environmentHash") or NOT_AVAILABLE
        data["changeIdentity"] = identity
        data = hrm.apply_identity_mirrors(data)

    # diffStat / changedFiles
    if not for_replay or not data.get("changedFiles"):
        base = data.get("baseCommit")
        head = data.get("finalCommit")
        if base and head and base != NOT_AVAILABLE and head != NOT_AVAILABLE:
            diff_stat, changed = _changed_files_from_git(project, str(base), str(head))
            ownership_projection: dict[str, Any] | None = None
            try:
                hp.load_change_contract(change_dir)
                ownership_projection = hl.compute_ownership_diff(
                    project,
                    base=str(base),
                    head=str(head),
                    change_dir=change_dir,
                )
            except (OSError, ValueError, RuntimeError):
                ownership_projection = None
            if ownership_projection is not None:
                allowed = set(ownership_projection.get("files") or [])
                changed = [item for item in changed if item.get("path") in allowed]
                diff_stat = {
                    **diff_stat,
                    "filesChanged": len(changed),
                    "insertions": sum(int(item.get("insertions") or 0) for item in changed),
                    "deletions": sum(int(item.get("deletions") or 0) for item in changed),
                }
                data["ownershipDiff"] = ownership_projection
                if write:
                    write_json(
                        change_dir / "evidence" / "ownership-diff.json",
                        ownership_projection,
                    )
            if changed:
                data["diffStat"] = diff_stat
                data["changedFiles"] = changed
            elif existing and existing.get("changedFiles"):
                data["changedFiles"] = existing["changedFiles"]
                data["diffStat"] = existing.get("diffStat") or diff_stat
            else:
                data["diffStat"] = diff_stat
                data["changedFiles"] = []
        elif existing and existing.get("changedFiles"):
            data["changedFiles"] = existing["changedFiles"]
            data["diffStat"] = existing.get("diffStat") or {
                "filesChanged": len(existing["changedFiles"]),
                "insertions": 0,
                "deletions": 0,
                "range": NOT_AVAILABLE,
            }
        else:
            data["diffStat"] = {
                "filesChanged": 0,
                "insertions": 0,
                "deletions": 0,
                "range": NOT_AVAILABLE if for_replay else "",
            }
            data["changedFiles"] = []

    # H-11: surface identity + diff facts for adequacy (top-level + gitFacts).
    diff_for_facts = data.get("diffStat") if isinstance(data.get("diffStat"), dict) else {}
    data["gitFacts"] = {
        "baseCommit": data.get("baseCommit") or "",
        "checkpointCommit": data.get("checkpointCommit") or "",
        "finalCommit": data.get("finalCommit") or "",
        "productCommit": data.get("productCommit") or "",
        "featureTip": data.get("featureTip") or "",
        "mergeCommit": data.get("mergeCommit") or "",
        "releaseTip": data.get("releaseTip") or "",
        "featureMergeHash": data.get("featureMergeHash") or "",
        "releaseTipHash": data.get("releaseTipHash") or "",
        "productTreeHash": data.get("productTreeHash") or "",
        "environmentHash": data.get("environmentHash") or "",
        "filesChanged": int(diff_for_facts.get("filesChanged") or 0),
        "insertions": int(diff_for_facts.get("insertions") or 0),
        "deletions": int(diff_for_facts.get("deletions") or 0),
    }

    data.setdefault(
        "ownershipDiff",
        {
            "files": [item.get("path") for item in data.get("changedFiles") or []],
            "staticEvidenceFiles": [],
            "foreignPaths": [],
            "excludedRuntimeCount": 0,
            "ownedFileCount": len(data.get("changedFiles") or []),
        },
    )

    # artifacts (build products stay empty unless already known; reportPipeline has event artifacts)
    if not isinstance(data.get("artifacts"), list):
        data["artifacts"] = []
    if not for_replay:
        data["artifacts"] = _artifacts_from_events(
            projected_events, change_dir=change_dir
        )
        storage_path = change_dir / "evidence" / "artifact-storage.json"
        if storage_path.is_file():
            storage = read_json(storage_path)
            data["artifactStorage"] = (
                storage if isinstance(storage, dict) else {}
            )
            data["artifactStorage"]["available"] = True
            sources.append("evidence/artifact-storage.json")
        else:
            data["artifactStorage"] = {
                "schemaVersion": 1,
                "available": False,
                "artifactCount": 0,
                "bytesAdded": 0,
                "bytesReused": 0,
                "bytesPruned": 0,
                "largestItems": [],
            }
        retention = build_retention_audit(change_dir)
        data["retention"] = retention
        if write:
            write_json(
                change_dir / "evidence" / "retention-audit.json",
                retention,
            )
        data["projection"] = hgate.evaluate_projection_gate(
            project,
            "archive",
        )
    else:
        data.setdefault("artifactStorage", {})
        data.setdefault("retention", {})
        data.setdefault("projection", {})

    data["reviewSummary"] = _review_summary(
        change_dir,
        existing if for_replay else None,
        projected_events,
    )
    review_status = hr.status(change_dir)
    data["reviewFindings"] = list(review_status.get("items") or [])
    if not for_replay:
        data["timeline"] = _timeline_from_events(event_summary, projected_events)
    else:
        data.setdefault("timeline", [])
    data.setdefault("uncommittedTestEvidence", [])

    # Derive risks/actions from evidence. These fields are facts, not model prose.
    if not for_replay:
        maintenance_notes: list[str] = [
            str(event.get("note") or event.get("message") or "")
            for event in projected_events
            if event.get("type") == "decision" and (event.get("note") or event.get("message"))
        ]
        known_risks: list[dict[str, Any]] = []
        for event in he.current_issues(events):
            if event.get("phase") == "archive" and event.get("code") == "missing-command":
                continue
            sev = str(event.get("severity") or "").strip().lower()
            message = event.get("message") or event.get("note") or event.get("code") or ""
            if sev in _RISK_SEVERITIES:
                known_risks.append(
                    {
                        "phase": event.get("phase"),
                        "severity": sev,
                        "message": message,
                    }
                )
            else:
                note = str(message).strip()
                if note:
                    maintenance_notes.append(note)
        data["maintenanceNotes"] = maintenance_notes
        scenario_risks, scenario_actions = _risks_from_test_results(change_dir)
        data["knownRisks"] = known_risks + scenario_risks
        data["manualActions"] = scenario_actions
        for name, value in (data.get("stageStatus") or {}).items():
            if value in {"BLOCKED", "BLOCKED_BY_ENV", "BLOCKED_BY_DBA", "NOT_RUN", "USER_SKIPPED"}:
                data["manualActions"].append({
                    "stage": name,
                    "status": value,
                    "action": "补充或确认该阶段的真实验证证据",
                })
    else:
        data.setdefault("maintenanceNotes", [])
        data.setdefault("knownRisks", [])
        data.setdefault("manualActions", [])
        data.setdefault("finalStatusReasons", [])
        data.setdefault("riskTier", "unknown")

    data["normalizedReport"] = hrm.normalize_report(data)

    # archiveManifest
    am = {
        "movedFiles": 0,
        "generatedFiles": 0,
        "totalArchiveFiles": 0,
        "checksumStatus": "OK",
    }
    if compare_result:
        am["movedFiles"] = compare_result.get("movedFiles", 0)
        am["generatedFiles"] = compare_result.get("generatedFiles", 0)
        am["totalArchiveFiles"] = compare_result.get("totalArchiveFiles", 0)
        am["checksumStatus"] = compare_result.get("checksumStatus", "OK")
    elif after_manifest:
        am["totalArchiveFiles"] = int(after_manifest.get("fileCount") or 0)
    elif before_manifest:
        am["totalArchiveFiles"] = int(before_manifest.get("fileCount") or 0)
    elif for_replay and isinstance(data.get("archiveManifest"), dict):
        am = {**am, **data["archiveManifest"]}
    data["archiveManifest"] = am

    # reportPipeline
    commands = _commands_from_events(projected_events)
    if not commands and for_replay:
        # Cannot invent commands
        pass
    verification_checks = _verification_checks_from_events(projected_events, ledger)
    pipeline_artifacts = _artifacts_from_events(
        projected_events, change_dir=change_dir
    )
    if not sources:
        sources = [NOT_AVAILABLE]

    data["reportPipeline"] = {
        "schema_version": 1,
        "generated_at": now_iso(),
        "event_count": len(events),
        "sources": sources,
        "phases": _phases_from_events_summary(event_summary),
        "commands": commands,
        "verificationChecks": verification_checks,
        "artifacts": pipeline_artifacts,
        "validationIssues": [],
    }

    report_adequacy = validate_report_adequacy(data)
    checksum_status = str(
        (data.get("archiveManifest") or {}).get("checksumStatus") or ""
    )
    archive_integrity = {
        "ok": checksum_status in {"OK", "OK_WITH_EXCLUSIONS"},
        "code": (
            "ARCHIVE_INTEGRITY_OK"
            if checksum_status in {"OK", "OK_WITH_EXCLUSIONS"}
            else "ARCHIVE_INTEGRITY_FAILED"
        ),
        "message": f"checksumStatus={checksum_status or 'missing'}",
        "checksumStatus": checksum_status,
    }
    release_decision = evaluate_release_eligibility(
        change_dir,
        data,
        archive_integrity=archive_integrity,
        report_adequacy=report_adequacy,
    )
    data["archiveIntegrity"] = archive_integrity
    data["candidateVerification"] = release_decision["checks"][
        "candidateVerification"
    ]
    data["releaseDecision"] = release_decision
    data["releaseEligible"] = release_decision["releaseEligible"]
    data["reportPipeline"]["reportAdequacy"] = report_adequacy
    data["reportPipeline"]["releaseDecision"] = release_decision

    # Fill any remaining template placeholders that look like instructions
    for key in list(data.keys()):
        val = data[key]
        if isinstance(val, str) and ("|" in val and "OK" in val and len(val) < 80):
            # template enum hint left behind
            if for_replay:
                data[key] = existing.get(key, NOT_AVAILABLE) if existing else NOT_AVAILABLE

    if write:
        out_path = change_dir / "reports" / "final" / "summary-data.json"
        write_json(out_path, data)

    return data


# ---------------------------------------------------------------------------


def _manifest_self_stats(
    work_dir: Path,
    manifest: dict[str, Any],
    manifest_path: Path,
) -> dict[str, Any]:
    """UT-011/RET-23: physical files vs manifest entries (self-exclusion)."""
    physical = sum(1 for path in work_dir.rglob("*") if path.is_file())
    entries = int(manifest.get("fileCount") or len(manifest.get("files") or []))
    rel_manifest = manifest_path.resolve().relative_to(work_dir.resolve()).as_posix()
    in_entries = any(
        str(item.get("path") or "").replace("\\", "/") == rel_manifest
        for item in manifest.get("files") or []
        if isinstance(item, dict)
    )
    coverage = round(entries / physical * 100, 2) if physical else 100.0
    return {
        "physicalFileCount": physical,
        "entryCount": entries,
        "selfExcluded": not in_entries,
        "coveragePercent": coverage,
    }


def _append_finalize_failure_terminal(
    authoritative_change_dir: Path,
    message: str,
    *,
    operation_id: str,
) -> None:
    """Record a blocked preparation without manufacturing an archive attempt."""
    if not authoritative_change_dir.is_dir():
        return
    try:
        append_event(
            authoritative_change_dir,
            phase="archive",
            type_="phase.prepare.start",
            note="开始检查归档条件",
        )
        append_event(
            authoritative_change_dir,
            phase="archive",
            type_="phase.prepare.end",
            status="BLOCKED",
            code="ARCHIVE_PREPARE_BLOCKED",
            message=f"归档条件未满足：{message}",
            note=f"归档操作 {operation_id} 未进入正式执行",
        )
        append_event(
            authoritative_change_dir,
            phase="archive",
            type_="phase.end",
            status="BLOCKED",
            code="ARCHIVE_PREPARE_BLOCKED",
            message=f"归档条件未满足：{message}",
            note="归档未开始，流程已在预检处结束",
        )
    except OSError:
        pass


def _best_effort_archive_terminal_sync(
    project_root: Path,
    event_dir: Path,
    *,
    change_key: str,
    run_id: str | None,
    payload: dict[str, Any],
) -> None:
    """Publish terminal archive state before any slow post-archive networking."""
    try:
        monitor = hes.auto_events_sync(
            project_root,
            event_dir,
            run_id=run_id,
            change_key=change_key,
        )
        payload.setdefault("steps", {})["platform_events_sync"] = monitor
        if monitor.get("warning"):
            payload.setdefault("warnings", []).append(str(monitor["warning"]))
    except Exception as exc:  # noqa: BLE001 — monitoring cannot roll back archive
        warning = f"events-sync terminal hook failed: {exc}"
        payload.setdefault("warnings", []).append(warning)
        payload.setdefault("steps", {})["platform_events_sync"] = {
            "ok": False,
            "warning": warning,
        }


def _freeze_evidence_cutoff(work_dir: Path) -> dict[str, Any]:
    """Freeze the events cutoff: fsync events, write evidence-cutoff.json.

    After this point no event may be appended to the archived events file;
    the cutoff hash lets any later reader prove that (INT-006/RET-19).
    """
    events_file = he.events_path(work_dir)
    events = he.load_events(events_file) if events_file.is_file() else []
    if events_file.is_file():
        # Windows fsync requires a writable handle; O_RDONLY raises EBADF.
        fd = os.open(str(events_file), os.O_RDWR | os.O_BINARY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        raw = events_file.read_bytes()
    else:
        raw = b""
    cutoff = {
        "eventCount": len(events),
        "sha256": "sha256:" + hashlib.sha256(raw).hexdigest(),
        "frozenAt": now_iso(),
        "path": "events.ndjson",
    }
    write_json(work_dir / "evidence" / "evidence-cutoff.json", cutoff)
    # The staged archive is immutable after this point.  The event lock is a
    # runtime coordination file, not evidence, and must not survive publish.
    events_file.with_name(events_file.name + ".lock").unlink(missing_ok=True)
    return cutoff


def validate_artifact_immutability(entries: list[dict[str, Any]]) -> dict[str, Any]:
    """Same artifact path with two different hashes -> conflict (UT-003/RET-07)."""
    issues: list[dict[str, Any]] = []
    seen: dict[str, str] = {}
    for item in entries:
        if not isinstance(item, dict):
            continue
        rel = str(item.get("path") or "").strip()
        digest = str(item.get("sha256") or "").strip()
        if not rel or not digest:
            continue
        prior = seen.get(rel)
        if prior is not None and prior != digest:
            issues.append(
                {
                    "code": "artifact-hash-conflict",
                    "severity": "error",
                    "message": f"immutable artifact conflict at {rel}: {prior[:12]}… != {digest[:12]}…",
                }
            )
        else:
            seen[rel] = digest
    errors = [i for i in issues if i.get("severity") == "error"]
    return {
        "ok": len(errors) == 0,
        "issues": issues,
        "error_count": len(errors),
        "warning_count": len(issues) - len(errors),
    }


def validate_source_consistency(
    change_dir: Path,
    summary: dict[str, Any],
) -> dict[str, Any]:
    """Layer 1: summary facts must equal the frozen sources (UT-014/RET-26).

    Checks event count against the cutoff file, verification counts against
    ledger typed metrics, and review counts against sidecars when present.
    """
    issues: list[dict[str, str]] = []

    # 1. event count/hash vs frozen cutoff (fallback: live events file).
    events_file = he.events_path(change_dir)
    actual_count = None
    cutoff_path = change_dir / "evidence" / "evidence-cutoff.json"
    cutoff: dict[str, Any] | None = None
    if cutoff_path.is_file():
        try:
            cutoff = read_json(cutoff_path)
            actual_count = cutoff.get("eventCount")
        except (OSError, json.JSONDecodeError):
            actual_count = None
    if actual_count is None and events_file.is_file():
        actual_count = len(he.load_events(events_file))
    summary_count = (summary.get("reportPipeline") or {}).get("event_count")
    if actual_count is not None and summary_count is not None:
        if int(summary_count) != int(actual_count):
            issues.append(
                {
                    "code": "event-count-mismatch",
                    "severity": "error",
                    "message": (
                        f"summary event_count={summary_count} but cutoff has "
                        f"{actual_count} events"
                    ),
                }
            )

    if cutoff is not None and events_file.is_file():
        actual_hash = "sha256:" + hashlib.sha256(events_file.read_bytes()).hexdigest()
        if cutoff.get("sha256") != actual_hash:
            issues.append(
                {
                    "code": "cutoff-hash-mismatch",
                    "severity": "error",
                    "message": "evidence cutoff hash does not match events.ndjson",
                }
            )

    # 2. verification vs ledger typed metrics.
    ledger = load_ledger(change_dir)
    if ledger:
        projection = build_verification_projection(ledger, change_dir=change_dir)
        ver = summary.get("verification") or {}
        unit_src = projection.get("unitTests") or {}
        unit_sum = ver.get("unitTests") or {}
        if unit_src.get("run"):
            if int(unit_sum.get("run") or 0) != int(unit_src["run"]):
                issues.append(
                    {
                        "code": "verification-mismatch",
                        "severity": "error",
                        "message": (
                            f"unitTests: summary run={unit_sum.get('run')} but "
                            f"ledger projection run={unit_src['run']}"
                        ),
                    }
                )
        for typed_key in ("apiContract", "browserE2E"):
            src = projection.get(typed_key)
            if not isinstance(src, dict) or not src.get("total"):
                continue
            rendered = ver.get(typed_key) or {}
            if int(rendered.get("total") or 0) != int(src["total"]):
                issues.append(
                    {
                        "code": "verification-mismatch",
                        "severity": "error",
                        "message": (
                            f"{typed_key}: summary total={rendered.get('total')} "
                            f"but ledger projection total={src['total']}"
                        ),
                    }
                )

    # 3. Rebuild canonical projections from frozen sources and compare the
    # fields that must never come from prose or an existing summary.
    expected = collect_summary_data(change_dir, write=False, for_replay=False)
    projection_fields = {
        "reviewSummary": "review-mismatch",
        "knownRisks": "risk-mismatch",
        "manualActions": "manual-actions-mismatch",
        "durations": "phase-timing-mismatch",
        "changedFiles": "ownership-diff-mismatch",
        "ownershipDiff": "ownership-diff-mismatch",
        "artifacts": "artifact-mismatch",
    }
    for field, code in projection_fields.items():
        if summary.get(field) != expected.get(field):
            issues.append(
                {
                    "code": code,
                    "severity": "error",
                    "message": f"summary {field} does not match frozen source projection",
                }
            )

    # 4. Manifest structure/checksums and summary semantics.
    before_path = change_dir / "evidence" / "archive-manifest-before.json"
    if before_path.is_file():
        try:
            manifest = read_json(before_path)
            entries = manifest.get("files") if isinstance(manifest, dict) else None
            valid = isinstance(entries, list) and manifest.get("fileCount") == len(entries)
            seen: set[str] = set()
            if valid:
                for entry in entries:
                    rel = str(entry.get("path") or "") if isinstance(entry, dict) else ""
                    digest = str(entry.get("sha256") or "") if isinstance(entry, dict) else ""
                    if (
                        not rel
                        or rel in seen
                        or re.fullmatch(r"[0-9a-f]{64}", digest) is None
                    ):
                        valid = False
                        break
                    seen.add(rel)
                    target = (change_dir / rel).resolve()
                    if not target.is_relative_to(change_dir.resolve()) or not target.is_file():
                        valid = False
                        break
                    if not _manifest_path_excluded(rel) and sha256_file(target) != digest:
                        valid = False
                        break
            if not valid:
                issues.append(
                    {
                        "code": "manifest-invalid",
                        "severity": "error",
                        "message": "archive-manifest-before structure or checksum is invalid",
                    }
                )
        except (OSError, json.JSONDecodeError):
            issues.append(
                {
                    "code": "manifest-invalid",
                    "severity": "error",
                    "message": "archive-manifest-before is unreadable",
                }
            )

    # 5. Artifact paths must resolve to immutable files inside the archive.
    root = change_dir.resolve()
    for artifact in summary.get("artifacts") or []:
        raw = str(artifact.get("path") or "") if isinstance(artifact, dict) else ""
        candidate = (root / raw).resolve() if raw else root
        if not raw or not candidate.is_relative_to(root) or not candidate.is_file():
            issues.append(
                {
                    "code": "artifact-missing",
                    "severity": "error",
                    "message": f"artifact path is missing or outside archive: {raw}",
                }
            )

    errors = [i for i in issues if i.get("severity") == "error"]
    warnings = [i for i in issues if i.get("severity") != "error"]
    return {
        "ok": len(errors) == 0,
        "issues": issues,
        "error_count": len(errors),
        "warning_count": len(warnings),
    }


def validate_summary_data(summary: dict[str, Any]) -> dict[str, Any]:
    """Validate canonical summary data without creating an HTML projection."""
    issues: list[dict[str, str]] = []
    verification = summary.get("verification") or {}
    verification = verification if isinstance(verification, dict) else {}
    unit = verification.get("unitTests") or {}
    api = verification.get("apiTests") or {}
    browser = verification.get("browserE2E") or {}
    unit = unit if isinstance(unit, dict) else {}
    api = api if isinstance(api, dict) else {}
    browser = browser if isinstance(browser, dict) else {}
    api_status = str(api.get("status") or "")
    browser_status = str(browser.get("status") or "")
    final_status = str(summary.get("finalStatus") or "")
    has_skip = api_status == "USER_SKIPPED" or browser_status in {
        "USER_SKIPPED",
        "BLOCKED",
        "BLOCKED_BY_ENV",
        "NOT_RUN",
        "PARTIAL",
    } or str(verification.get("dbCompatibility") or "") == "BLOCKED_BY_DBA"
    has_failed_verification = (
        int(unit.get("failures") or 0) > 0
        or int(unit.get("errors") or 0) > 0
        or int(api.get("failed") or 0) > 0
        or int(browser.get("failed") or 0) > 0
        or browser_status == "FAIL"
    )
    stage = summary.get("stageStatus") or {}
    stage = stage if isinstance(stage, dict) else {}
    has_failed_stage = any(
        str(value).upper() == "FAIL"
        for phase, value in stage.items()
        if str(phase).lower() != "archive"
    )
    if (has_skip or has_failed_verification or has_failed_stage) and final_status == "OK":
        issues.append(
            {
                "code": "status-contradiction",
                "severity": "error",
                "message": (
                    "finalStatus is pure OK but skipped, blocked, or failed "
                    "verification is present"
                ),
            }
        )
    errors = [item for item in issues if item.get("severity") == "error"]
    return {
        "ok": not errors,
        "issues": issues,
        "error_count": len(errors),
        "warning_count": len(issues) - len(errors),
    }


# ---------------------------------------------------------------------------
# knowledge / service post-steps
# ---------------------------------------------------------------------------


def validate_report_adequacy(summary: dict[str, Any]) -> dict[str, Any]:
    """Validate that final summary is factually complete (retro §5.32).

    The archive validator must not return all-green when the summary is
    factually incomplete. This gate checks independent sources (git facts,
    typed metrics, stage status) rather than comparing the summary against
    a lossy projection of itself.
    """
    issues: list[dict[str, str]] = []
    closure_disposition = str(
        summary.get("closureDisposition") or "completed"
    ).strip()
    unfinished_closure = closure_disposition in {"abandoned", "superseded"}

    # H-12: prefer top-level baseCommit + diffStat; gitFacts is a mirror.
    base = str(summary.get("baseCommit") or "").strip()
    final = str(summary.get("finalCommit") or "").strip()
    merge_final = str(summary.get("mergeFinalHash") or "").strip()
    diff_stat = summary.get("diffStat") if isinstance(summary.get("diffStat"), dict) else {}
    files_changed = int(diff_stat.get("filesChanged") or 0)

    git_facts = summary.get("gitFacts") or {}
    if isinstance(git_facts, dict):
        if not base or base == NOT_AVAILABLE:
            base = str(git_facts.get("baseCommit") or "").strip() or base
        if not final or final == NOT_AVAILABLE:
            final = str(git_facts.get("finalCommit") or "").strip() or final
        if "filesChanged" in git_facts and files_changed == 0:
            try:
                files_changed = int(git_facts.get("filesChanged") or 0)
            except (TypeError, ValueError):
                files_changed = 0

    base_missing = not base or base == NOT_AVAILABLE
    final_present = bool(
        (final and final != NOT_AVAILABLE) or (merge_final and merge_final != NOT_AVAILABLE)
    )
    if final_present and base_missing and not unfinished_closure:
        issues.append({
            "code": "IDENTITY_BASE_MISSING",
            "severity": "error",
            "message": (
                "final/merge identity present but baseCommit is empty; "
                "refuse CONDITIONAL_OK+ without a resolved base"
            ),
        })

    if (
        base
        and final
        and base != NOT_AVAILABLE
        and final != NOT_AVAILABLE
        and base != final
        and files_changed == 0
        and not unfinished_closure
    ):
        issues.append({
            "code": "DIFF_ZERO_WITH_NONEMPTY_COMMIT",
            "severity": "error",
            "message": f"final commit {final} differs from base {base} but filesChanged=0",
        })

    # HH-ARCHIVE-20260730-001: refuse internally-consistent but truncated boundaries.
    identity_doc_early = (
        summary.get("changeIdentity")
        if isinstance(summary.get("changeIdentity"), dict)
        else {}
    )
    product_commit = str(
        summary.get("productCommit")
        or identity_doc_early.get("productCommit")
        or ""
    ).strip()
    feature_tip = str(
        summary.get("featureTip")
        or summary.get("featureTipHash")
        or product_commit
        or ""
    ).strip()
    if not feature_tip:
        feature_tip = str(identity_doc_early.get("productCommit") or "").strip()

    collapsed_boundary = (
        base
        and base != NOT_AVAILABLE
        and feature_tip
        and feature_tip != NOT_AVAILABLE
        and base == feature_tip
    )
    if collapsed_boundary and not unfinished_closure:
        issues.append({
            "code": "ARCHIVE_BASE_EQUALS_FEATURE_TIP",
            "severity": "error",
            "message": (
                f"baseCommit equals feature tip ({base}); "
                "archive boundary collapsed to an empty/merge-only delta"
            ),
        })
    elif unfinished_closure and files_changed == 0:
        issues.append({
            "code": "NO_PRODUCT_DELTA",
            "severity": "warning",
            "message": (
                "未完成变更没有产生产品增量；仅封存过程、原因与已有证据，"
                "不得作为发布候选。"
            ),
        })

    ownership = summary.get("ownershipDiff") or summary.get("ownership")
    ownership = ownership if isinstance(ownership, dict) else {}
    ownership_files = ownership.get("files") or ownership.get("changedFiles") or []
    ownership_count = 0
    if isinstance(ownership_files, list):
        ownership_count = len(ownership_files)
    elif isinstance(ownership.get("fileCount"), int):
        ownership_count = int(ownership["fileCount"])
    changed_files = summary.get("changedFiles")
    changed_count = len(changed_files) if isinstance(changed_files, list) else files_changed

    if ownership_count > 0 and changed_count == 0 and not unfinished_closure:
        issues.append({
            "code": "ARCHIVE_DIFF_SHRUNK_VS_OWNERSHIP",
            "severity": "error",
            "message": (
                f"ownership diff has {ownership_count} file(s) but report "
                "diff is empty; base/diff pairing is internally consistent "
                "but does not represent the full change"
            ),
        })
    elif (
        ownership_count > 0
        and changed_count > 0
        and changed_count * 3 < ownership_count
        and not unfinished_closure
    ):
        issues.append({
            "code": "ARCHIVE_DIFF_SHRUNK_VS_OWNERSHIP",
            "severity": "error",
            "message": (
                f"report diff covers {changed_count} file(s) but ownership "
                f"lists {ownership_count}; suspected merge-delta truncation"
            ),
        })

    merge_parents = summary.get("mergeParents") or summary.get("mergeParentHashes")
    if (
        isinstance(merge_parents, list)
        and len(merge_parents) >= 2
        and not unfinished_closure
    ):
        first_parent = str(merge_parents[0] or "").strip()
        if (
            base
            and first_parent
            and base == first_parent
            and ownership_count > max(changed_count, files_changed)
            and max(changed_count, files_changed) <= 1
        ):
            issues.append({
                "code": "ARCHIVE_NOFF_MERGE_DELTA_ONLY",
                "severity": "error",
                "message": (
                    "no-ff merge archive appears to cover only the merge "
                    "commit delta rather than archive-base..release-tip"
                ),
            })

    # Typed metrics missing despite test report artifacts present.
    verification = summary.get("verification") or {}
    if isinstance(verification, dict):
        unit = verification.get("unitTests") or {}
        api = verification.get("apiTests") or {}
        artifacts = summary.get("artifacts") or []
        has_test_report = any(
            isinstance(a, dict) and "test" in str(a.get("path") or "").lower()
            for a in artifacts
        ) if isinstance(artifacts, list) else False
        unit_pass = int(unit.get("passed") or 0) if isinstance(unit, dict) else 0
        api_status = str(api.get("status") or "") if isinstance(api, dict) else ""
        if has_test_report and unit_pass == 0 and api_status in {"", "not_available"}:
            issues.append({
                "code": "TYPED_METRICS_MISSING",
                "severity": "error",
                "message": "test report artifacts present but unitTests/apiTests typed metrics are empty",
            })
        db_status = str(verification.get("dbCompatibility") or "NOT_RUN").upper()
        db_evidence = verification.get("dbCompatibilityEvidence")
        if "dbCompatibility" in verification and db_status == "EVIDENCE_MISSING":
            issues.append({
                "code": "DB_COMPATIBILITY_EVIDENCE_MISSING",
                "severity": "error",
                "message": (
                    "DB compatibility was recorded but lacks a valid typed "
                    "ledger/receipt evidence payload"
                ),
            })
        elif "dbCompatibility" in verification and db_status == "NOT_RUN":
            issues.append({
                "code": "DB_COMPATIBILITY_NOT_RUN",
                "severity": "warning",
                "message": "DB compatibility validation was not run",
            })
        elif (
            "dbCompatibility" in verification
            and db_status in {"OK", "FAIL", "NOT_APPLICABLE"}
            and not isinstance(db_evidence, dict)
        ):
            issues.append({
                "code": "DB_COMPATIBILITY_EVIDENCE_MISSING",
                "severity": "error",
                "message": "DB compatibility status has no typed evidence projection",
            })

    # stageStatus contradicts event reducer.
    stage = summary.get("stageStatus") or {}
    stage_from_events = summary.get("stageStatusFromEvents") or {}
    if isinstance(stage, dict) and isinstance(stage_from_events, dict):
        for phase, status in stage.items():
            event_status = stage_from_events.get(phase)
            if event_status is not None and str(status) != str(event_status):
                issues.append({
                    "code": "STAGE_STATUS_CONTRADICTION",
                    "severity": "error",
                    "message": f"stageStatus.{phase}={status} but event reducer says {event_status}",
                })

    # All compatibility mirrors must be derived from the canonical identity.
    identity_doc = summary.get("changeIdentity")
    identity_doc = identity_doc if isinstance(identity_doc, dict) else {}
    canonical = hrm.canonical_identity(summary)
    mirror_sources = {
        "productCommit": summary.get("productCommit"),
        "featureMergeHash": summary.get("featureMergeHash"),
        "releaseTipHash": summary.get("releaseTipHash"),
        "productTreeHash": summary.get("productTreeHash"),
        "environmentHash": summary.get("environmentHash"),
    }
    for field, mirror in mirror_sources.items():
        expected = str(canonical.get(field) or "")
        actual = str(mirror or "")
        if field in hrm.CONTENT_HASH_FIELDS:
            expected = expected.removeprefix("sha256:")
            actual = actual.removeprefix("sha256:")
        if identity_doc.get(field) and actual and expected != actual:
            issues.append(
                {
                    "code": "IDENTITY_MIRROR_MISMATCH",
                    "severity": "error",
                    "message": f"{field} mirror differs from changeIdentity",
                    "expected": str(canonical.get(field) or ""),
                    "actual": str(mirror or ""),
                }
            )

    # Timing categories form a disjoint, wall-clock-conserving partition.
    timing = summary.get("timing")
    timing = timing if isinstance(timing, dict) else {}
    if timing:
        wall = int(timing.get("workflowWallClockMs") or 0)
        parts = sum(
            int(timing.get(key) or 0)
            for key in (
                "attributedStageUnionMs",
                "externalWaitMs",
                "pausedMs",
                "agentOrToolUnattributedMs",
            )
        )
        declared_delta = int(timing.get("conservationDeltaMs") or 0)
        if parts != wall or declared_delta != wall - parts:
            issues.append(
                {
                    "code": "TIMING_CONSERVATION_MISMATCH",
                    "severity": "error",
                    "message": (
                        f"timing categories total {parts}ms, wall clock is "
                        f"{wall}ms, declared delta is {declared_delta}ms"
                    ),
                }
            )

    candidate_gate_for_release = summary.get("candidateVerification")
    candidate_gate_for_release = (
        candidate_gate_for_release
        if isinstance(candidate_gate_for_release, dict)
        else {}
    )
    candidate_status = str(
        candidate_gate_for_release.get("status")
        or candidate_gate_for_release.get("code")
        or ""
    ).upper()
    if bool(summary.get("releaseEligible")) and (
        candidate_gate_for_release.get("ok") is False
        or candidate_status in {"FAIL", "FAILED", "ERROR", "BLOCKED"}
    ):
        issues.append(
            {
                "code": "RELEASE_ELIGIBILITY_CONTRADICTION",
                "severity": "error",
                "message": "releaseEligible=true while candidate verification is not successful",
            }
        )

    # Candidate receipt and summary must describe the same immutable subject.
    candidate_gate = summary.get("candidateVerification")
    candidate_gate = candidate_gate if isinstance(candidate_gate, dict) else {}
    candidate = candidate_gate.get("evidence")
    candidate = candidate if isinstance(candidate, dict) else {}
    subject = candidate.get("subject")
    subject = subject if isinstance(subject, dict) else {}

    summary_commit = str(summary.get("productCommit") or "").strip()
    candidate_commit = str(subject.get("productCommit") or "").strip()
    if (
        summary_commit
        and candidate_commit
        and summary_commit != candidate_commit
    ):
        issues.append(
            {
                "code": "CANDIDATE_SUMMARY_COMMIT_MISMATCH",
                "severity": "error",
                "message": (
                    "candidate productCommit does not match summary productCommit"
                ),
                "expected": summary_commit,
                "actual": candidate_commit,
            }
        )

    normalize_hash = lambda value: str(value or "").strip().removeprefix("sha256:")
    summary_tree = str(summary.get("productTreeHash") or "").strip()
    candidate_tree = str(subject.get("productTreeHash") or "").strip()
    if (
        summary_tree
        and candidate_tree
        and normalize_hash(summary_tree) != normalize_hash(candidate_tree)
    ):
        issues.append(
            {
                "code": "CANDIDATE_SUMMARY_TREE_MISMATCH",
                "severity": "error",
                "message": (
                    "candidate productTreeHash does not match summary productTreeHash"
                ),
                "expected": summary_tree,
                "actual": candidate_tree,
            }
        )

    summary_environment = str(summary.get("environmentHash") or "").strip()
    candidate_environment = str(subject.get("environmentHash") or "").strip()
    if (
        summary_environment
        and summary_environment != NOT_AVAILABLE
        and candidate_environment
        and normalize_hash(summary_environment)
        != normalize_hash(candidate_environment)
    ):
        issues.append(
            {
                "code": "CANDIDATE_SUMMARY_ENVIRONMENT_MISMATCH",
                "severity": "error",
                "message": (
                    "candidate environmentHash does not match summary environmentHash"
                ),
                "expected": summary_environment,
                "actual": candidate_environment,
            }
        )

    error_count = sum(
        1 for issue in issues if str(issue.get("severity") or "error") == "error"
    )
    return {
        "ok": error_count == 0,
        "issues": issues,
        "error_count": error_count,
        "warning_count": len(issues) - error_count,
    }


RELEASE_CHECKS = (
    "archiveIntegrity",
    "reportAdequacy",
    "candidateVerification",
    "candidateIdentity",
    "projectReleasePolicy",
    "terminalAttempts",
    "finalStatus",
)


def validate_parallel_isolation_contract(
    child_change_ids: list[str],
    isolation: Any,
) -> dict[str, Any]:
    """Require unique worktree, port, DB, temp root, and writer lease per child."""
    required = (
        "worktreeRoot",
        "port",
        "database",
        "tempRoot",
        "writerLease",
    )
    mapping = isolation if isinstance(isolation, dict) else {}
    issues: list[dict[str, Any]] = []
    expected = set(child_change_ids)
    actual = {str(key) for key in mapping}
    if expected != actual:
        issues.append(
            {
                "code": "PARALLEL_ISOLATION_MEMBERSHIP_MISMATCH",
                "message": "childIsolation must describe every covered child exactly once",
                "missing": sorted(expected - actual),
                "unexpected": sorted(actual - expected),
            }
        )

    def _identity(field: str, value: Any) -> str:
        text = str(value).strip()
        if field in {"worktreeRoot", "tempRoot"}:
            return text.replace("\\", "/").rstrip("/").casefold()
        return text.casefold()

    for field in required:
        owners: dict[str, list[str]] = {}
        for child_id in sorted(expected):
            row = mapping.get(child_id)
            row = row if isinstance(row, dict) else {}
            value = row.get(field)
            identity = _identity(field, value)
            if not identity:
                issues.append(
                    {
                        "code": "PARALLEL_ISOLATION_FIELD_MISSING",
                        "message": f"{child_id} is missing isolation field {field}",
                        "childChangeId": child_id,
                        "field": field,
                    }
                )
                continue
            owners.setdefault(identity, []).append(child_id)
        for value, children in owners.items():
            if len(children) > 1:
                issues.append(
                    {
                        "code": "PARALLEL_ISOLATION_COLLISION",
                        "message": (
                            f"parallel children share {field}; cross-write risk detected"
                        ),
                        "field": field,
                        "value": value,
                        "children": children,
                    }
                )
    return {
        "ok": not issues,
        "code": (
            "PARALLEL_ISOLATION_OK"
            if not issues
            else "PARALLEL_ISOLATION_INVALID"
        ),
        "issues": issues,
        "children": sorted(expected),
    }


def validate_aggregate_candidate_contract(
    contract: dict[str, Any],
    *,
    child_change_id: str | None = None,
    candidate_subject: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Validate aggregate/child/integration membership as one identity contract."""
    issues: list[dict[str, Any]] = []
    if contract.get("schemaVersion") != 1:
        issues.append(
            {
                "code": "AGGREGATE_SCHEMA_INVALID",
                "message": "aggregate candidate schemaVersion must be 1",
            }
        )
    if contract.get("candidateScope") != "aggregate":
        issues.append(
            {
                "code": "AGGREGATE_SCOPE_INVALID",
                "message": "candidateScope must be aggregate",
            }
        )
    aggregate_change_id = str(contract.get("aggregateChangeId") or "").strip()
    if not aggregate_change_id:
        issues.append(
            {
                "code": "AGGREGATE_CHANGE_ID_MISSING",
                "message": "aggregateChangeId is required",
            }
        )

    raw_children = contract.get("coveredChildChanges")
    children = (
        [str(item).strip() for item in raw_children]
        if isinstance(raw_children, list)
        else []
    )
    if (
        not children
        or any(not item for item in children)
        or len(set(children)) != len(children)
    ):
        issues.append(
            {
                "code": "AGGREGATE_CHILDREN_INVALID",
                "message": "coveredChildChanges must be non-empty and unique",
            }
        )
    commits = contract.get("childProductCommits")
    commits = commits if isinstance(commits, dict) else {}
    child_set = set(children)
    commit_set = {str(key) for key in commits}
    if child_set != commit_set or any(
        not isinstance(value, str) or not value.strip()
        for value in commits.values()
    ):
        issues.append(
            {
                "code": "AGGREGATE_CHILD_MEMBERSHIP_MISMATCH",
                "message": (
                    "childProductCommits must map every covered child exactly once"
                ),
                "missing": sorted(child_set - commit_set),
                "unexpected": sorted(commit_set - child_set),
            }
        )
    if child_change_id is not None and child_change_id not in child_set:
        issues.append(
            {
                "code": "AGGREGATE_CHILD_NOT_COVERED",
                "message": f"child change is not covered: {child_change_id}",
            }
        )

    integration_commit = str(
        contract.get("integrationProductCommit") or ""
    ).strip()
    subject_commit = str(
        (candidate_subject or {}).get("productCommit") or ""
    ).strip()
    if not integration_commit:
        issues.append(
            {
                "code": "AGGREGATE_INTEGRATION_COMMIT_MISSING",
                "message": "integrationProductCommit is required",
            }
        )
    elif subject_commit and integration_commit != subject_commit:
        issues.append(
            {
                "code": "AGGREGATE_INTEGRATION_COMMIT_MISMATCH",
                "message": (
                    "integrationProductCommit does not match candidate subject"
                ),
                "expected": subject_commit,
                "actual": integration_commit,
            }
        )

    coverage = contract.get("coverageProof")
    coverage = coverage if isinstance(coverage, dict) else {}
    digest = str(coverage.get("digest") or "")
    if not re.fullmatch(r"sha256:[0-9a-fA-F]{64}", digest):
        issues.append(
            {
                "code": "AGGREGATE_COVERAGE_PROOF_INVALID",
                "message": "coverageProof.digest must be a sha256 digest",
            }
        )
    if not str(coverage.get("source") or "").strip():
        issues.append(
            {
                "code": "AGGREGATE_COVERAGE_SOURCE_MISSING",
                "message": "coverageProof.source is required",
            }
        )
    parallel_isolation = None
    if (
        contract.get("concurrencyMode") == "isolated-multi-active"
        or "childIsolation" in contract
    ):
        parallel_isolation = validate_parallel_isolation_contract(
            children,
            contract.get("childIsolation"),
        )
        issues.extend(parallel_isolation.get("issues") or [])

    primary_code = (
        "AGGREGATE_CANDIDATE_OK"
        if not issues
        else (
            "AGGREGATE_CHILD_MEMBERSHIP_MISMATCH"
            if any(
                issue["code"] == "AGGREGATE_CHILD_MEMBERSHIP_MISMATCH"
                for issue in issues
            )
            else "AGGREGATE_CANDIDATE_INVALID"
        )
    )
    return {
        "ok": not issues,
        "code": primary_code,
        "message": (
            "aggregate candidate covers every child and matches integration identity"
            if not issues
            else f"aggregate candidate has {len(issues)} issue(s)"
        ),
        "aggregateChangeId": aggregate_change_id,
        "coveredChildChanges": children,
        "parallelIsolation": parallel_isolation,
        "issues": issues,
    }


def compose_release_decision(
    checks: dict[str, Any],
) -> dict[str, Any]:
    """Compose the only release-eligibility formula used by the archive."""
    normalized: dict[str, dict[str, Any]] = {}
    issues: list[dict[str, Any]] = []
    for name in RELEASE_CHECKS:
        value = checks.get(name)
        item = dict(value) if isinstance(value, dict) else {
            "ok": False,
            "code": "RELEASE_CHECK_MISSING",
            "message": f"required release check missing: {name}",
        }
        item["ok"] = bool(item.get("ok"))
        normalized[name] = item
        if not item["ok"]:
            issues.append(
                {
                    "check": name,
                    "code": str(
                        item.get("code")
                        or f"{name.upper()}_BLOCKED"
                    ),
                    "message": str(
                        item.get("message")
                        or f"release check failed: {name}"
                    ),
                }
            )
    eligible = all(normalized[name]["ok"] for name in RELEASE_CHECKS)
    return {
        "ok": eligible,
        "releaseEligible": eligible,
        "code": (
            "RELEASE_ELIGIBLE"
            if eligible
            else "RELEASE_NOT_ELIGIBLE"
        ),
        "checks": normalized,
        "issues": issues,
    }


def _candidate_identity_gate(
    change_dir: Path,
    summary: dict[str, Any],
    candidate_gate: dict[str, Any],
) -> dict[str, Any]:
    evidence = candidate_gate.get("evidence")
    evidence = evidence if isinstance(evidence, dict) else {}
    subject = evidence.get("subject")
    subject = subject if isinstance(subject, dict) else {}
    issues: list[dict[str, Any]] = []

    pairs = (
        (
            "productCommit",
            str(summary.get("productCommit") or "").strip(),
            str(subject.get("productCommit") or "").strip(),
            False,
        ),
        (
            "productTreeHash",
            str(summary.get("productTreeHash") or "").strip(),
            str(subject.get("productTreeHash") or "").strip(),
            True,
        ),
        (
            "environmentHash",
            str(summary.get("environmentHash") or "").strip(),
            str(subject.get("environmentHash") or "").strip(),
            True,
        ),
    )
    for field, expected, actual, is_hash in pairs:
        if not expected or expected == NOT_AVAILABLE or not actual:
            issues.append(
                {
                    "code": f"CANDIDATE_{field.upper()}_MISSING",
                    "message": (
                        f"candidate/summary identity field missing: {field}"
                    ),
                    "expected": expected,
                    "actual": actual,
                }
            )
            continue
        left = expected.removeprefix("sha256:") if is_hash else expected
        right = actual.removeprefix("sha256:") if is_hash else actual
        if left != right:
            issues.append(
                {
                    "code": f"CANDIDATE_{field.upper()}_MISMATCH",
                    "message": (
                        f"candidate {field} does not match summary {field}"
                    ),
                    "expected": expected,
                    "actual": actual,
                }
            )

    product_identity = validate_product_identity(
        product_commit=str(summary.get("productCommit") or ""),
        product_tree_hash=str(summary.get("productTreeHash") or ""),
        archive_commit=str(summary.get("archiveCommit") or ""),
        project=find_project_root(change_dir),
    )
    if not product_identity.get("ok"):
        issues.append(
            {
                "code": str(
                    product_identity.get("code")
                    or "PRODUCT_IDENTITY_INVALID"
                ),
                "message": str(
                    product_identity.get("message")
                    or "product/archive Git identity is invalid"
                ),
                "detail": product_identity,
            }
        )
    aggregate_contract = evidence.get("aggregateCandidate")
    if not isinstance(aggregate_contract, dict):
        aggregate_contract = evidence.get("aggregate")
    if not isinstance(aggregate_contract, dict) and (
        evidence.get("candidateScope") == "aggregate"
    ):
        aggregate_contract = evidence
    aggregate_identity = None
    if isinstance(aggregate_contract, dict):
        aggregate_identity = validate_aggregate_candidate_contract(
            aggregate_contract,
            candidate_subject=subject,
        )
        if not aggregate_identity.get("ok"):
            issues.append(
                {
                    "code": str(
                        aggregate_identity.get("code")
                        or "AGGREGATE_CANDIDATE_INVALID"
                    ),
                    "message": str(
                        aggregate_identity.get("message")
                        or "aggregate candidate identity is invalid"
                    ),
                    "detail": aggregate_identity,
                }
            )
    return {
        "ok": not issues,
        "code": (
            "CANDIDATE_IDENTITY_OK"
            if not issues
            else "CANDIDATE_IDENTITY_INVALID"
        ),
        "message": (
            "candidate, summary, environment, and Git identities agree"
            if not issues
            else f"candidate identity has {len(issues)} issue(s)"
        ),
        "issues": issues,
        "productIdentity": product_identity,
        "aggregateIdentity": aggregate_identity,
    }


def _project_release_policy_gate(
    change_dir: Path,
    summary: dict[str, Any],
    candidate_gate: dict[str, Any],
) -> dict[str, Any]:
    policy = load_gate_policy(change_dir) or {}
    candidate_policy = policy.get("candidateVerification")
    candidate_policy = (
        candidate_policy if isinstance(candidate_policy, dict) else {}
    )
    release_policy = policy.get("releasePolicy")
    release_policy = (
        release_policy if isinstance(release_policy, dict) else {}
    )
    projection = hgate.evaluate_projection_gate(
        find_project_root(change_dir),
        "archive",
    )
    if not projection.get("ok"):
        return {
            "ok": False,
            "code": str(
                projection.get("code") or "PROJECTION_DEGRADED_BLOCKED"
            ),
            "message": str(
                projection.get("message")
                or "projection receipt blocks release"
            ),
            "projection": projection,
        }
    if str(summary.get("archiveIntent") or "") == "record-only":
        return {
            "ok": False,
            "code": "RECORD_ONLY_ARCHIVE",
            "message": "record-only archive cannot authorize release",
            "remoteRequired": bool(candidate_policy.get("remoteRequired")),
        }
    minimum = str(
        candidate_policy.get("minimumAssurance")
        or "local-reproducible"
    ).strip()
    remote_required = bool(candidate_policy.get("remoteRequired")) or (
        minimum == "remote-attested"
    )
    assurance = str(candidate_gate.get("assurance") or "").strip()
    if remote_required and assurance != "remote-attested":
        return {
            "ok": False,
            "code": "REMOTE_ATTESTATION_REQUIRED",
            "message": (
                f"project requires remote-attested evidence; got {assurance or 'none'}"
            ),
            "remoteRequired": True,
        }
    if assurance == "local-reproducible" and not bool(
        candidate_policy.get("allowLocalRelease")
    ):
        return {
            "ok": False,
            "code": "LOCAL_RELEASE_NOT_AUTHORIZED",
            "message": (
                "local release requires "
                "candidateVerification.allowLocalRelease=true"
            ),
            "remoteRequired": remote_required,
        }
    evidence = candidate_gate.get("evidence")
    evidence = evidence if isinstance(evidence, dict) else {}
    subject = evidence.get("subject")
    subject = subject if isinstance(subject, dict) else {}
    final_sequence = hphase.evaluate_final_sequence(
        change_dir,
        {
            "productCommit": str(subject.get("productCommit") or ""),
            "productTreeHash": str(subject.get("productTreeHash") or ""),
            "environmentHash": str(subject.get("environmentHash") or ""),
        },
        exclude_nodes={"sequence:archive"},
    )
    if not final_sequence.get("ok"):
        return {
            "ok": False,
            "code": "FINAL_SEQUENCE_INCOMPLETE",
            "message": str(
                final_sequence.get("message")
                or "required final sequence is incomplete"
            ),
            "remoteRequired": remote_required,
            "finalSequence": final_sequence,
        }
    return {
        "ok": True,
        "code": "PROJECT_RELEASE_POLICY_OK",
        "message": "candidate evidence satisfies project release policy",
        "remoteRequired": remote_required,
        "minimumAssurance": minimum,
        "allowedFinalStatuses": release_policy.get(
            "allowedFinalStatuses", ["OK"]
        ),
        "finalSequence": final_sequence,
        "projection": projection,
    }


def _terminal_attempts_gate(summary: dict[str, Any]) -> dict[str, Any]:
    timing = summary.get("timing")
    timing = timing if isinstance(timing, dict) else {}
    unclosed = int(timing.get("unclosedAttemptCount") or 0)
    attempts = timing.get("attempts")
    attempts = attempts if isinstance(attempts, list) else []
    blocking_statuses = {
        "INCOMPLETE",
        "INCOMPLETE_AT_CUTOFF",
        "ORPHANED",
        "INTERRUPTED",
    }
    blocking = [
        item
        for item in attempts
        if isinstance(item, dict)
        and str(item.get("terminalStatus") or item.get("status") or "").upper()
        in blocking_statuses
    ]
    ok = unclosed == 0 and not blocking
    return {
        "ok": ok,
        "code": (
            "TERMINAL_ATTEMPTS_OK"
            if ok
            else "TERMINAL_ATTEMPTS_INCOMPLETE"
        ),
        "message": (
            "all release-critical attempts are terminal"
            if ok
            else (
                f"unclosedAttemptCount={unclosed} "
                f"blockingAttempts={len(blocking)}"
            )
        ),
        "unclosedAttemptCount": unclosed,
        "blockingAttempts": blocking,
    }


def evaluate_release_eligibility(
    change_dir: Path,
    summary: dict[str, Any],
    *,
    archive_integrity: dict[str, Any],
    report_adequacy: dict[str, Any],
) -> dict[str, Any]:
    """Evaluate the complete fail-closed release decision."""
    change_dir = change_dir.resolve()
    candidate_gate = evaluate_product_ci_gate(change_dir)
    candidate_identity = _candidate_identity_gate(
        change_dir, summary, candidate_gate
    )
    project_policy = _project_release_policy_gate(
        change_dir, summary, candidate_gate
    )
    gate_policy = load_gate_policy(change_dir) or {}
    release_policy = gate_policy.get("releasePolicy")
    release_policy = (
        release_policy if isinstance(release_policy, dict) else {}
    )
    allowed_statuses = release_policy.get("allowedFinalStatuses")
    if not isinstance(allowed_statuses, list) or not allowed_statuses:
        allowed_statuses = ["OK"]
    allowed_statuses = [
        str(item).upper() for item in allowed_statuses if str(item).strip()
    ]
    final_status = str(summary.get("finalStatus") or "").upper()
    final_status_gate = {
        "ok": final_status in allowed_statuses,
        "code": (
            "FINAL_STATUS_ALLOWED"
            if final_status in allowed_statuses
            else "FINAL_STATUS_BLOCKED"
        ),
        "message": (
            f"finalStatus={final_status or 'missing'} "
            f"allowed={allowed_statuses}"
        ),
        "actual": final_status,
        "allowed": allowed_statuses,
    }
    return compose_release_decision(
        {
            "archiveIntegrity": archive_integrity,
            "reportAdequacy": report_adequacy,
            "candidateVerification": candidate_gate,
            "candidateIdentity": candidate_identity,
            "projectReleasePolicy": project_policy,
            "terminalAttempts": _terminal_attempts_gate(summary),
            "finalStatus": final_status_gate,
        }
    )


def artifact_preflight(change_dir: Path) -> dict[str, Any]:
    """Classify artifact events before destructive finalize (retro §5.31 / H-8).

    Returns per-artifact classification: blocking (missing / escaping /
    cross-change path), canonicalizable (same-change repo-relative path),
    or file-backed (change-relative path). Pathless legacy rows fail closed.
    """
    change_dir = change_dir.resolve()
    events_p = change_dir / "events.ndjson"
    items: list[dict[str, Any]] = []
    blocking: list[dict[str, Any]] = []
    if not events_p.is_file():
        return {"ok": True, "items": [], "blocking": []}
    change_id = change_dir.name
    project_root = find_project_root(change_dir)
    events = he.apply_event_corrections(he.load_events(events_p))
    for event in events:
        if event.get("type") != "artifact":
            continue
        path = str(event.get("path") or "").strip()
        kind = str(event.get("kind") or "").strip()
        event_id = str(event.get("id") or "")
        if not path:
            item = {
                "eventId": event_id,
                "category": "blocking",
                "path": "",
                "kind": kind or "",
                "reason": "artifact path missing",
                "note": str(event.get("note") or "")[:80],
            }
            items.append(item)
            blocking.append(item)
            continue
        # Check for escaping/cross-change paths.
        parts = path.replace("\\", "/").split("/")
        if ".." in parts or path.startswith("/") or re.match(r"^[A-Za-z]:", path):
            item = {
                "eventId": event_id,
                "category": "blocking",
                "path": path,
                "reason": "absolute or escaping path",
            }
            items.append(item)
            blocking.append(item)
            continue
        # Same-change repo-relative path: canonicalizable.
        prefix = f".harness/changes/{change_id}/"
        if path.startswith(prefix):
            canonical = path[len(prefix):]
            items.append({
                "eventId": event_id,
                "category": "canonicalizable",
                "path": path,
                "canonicalPath": canonical,
                "correction": f"append correction --target-event-id {event_id} --target-field path --new-value-json \"{canonical}\"",
            })
            continue
        change_file = change_dir / path
        if change_file.is_file():
            items.append({
                "eventId": event_id,
                "category": "file-backed",
                "path": path,
                "exists": True,
            })
            continue
        repository_file = project_root / path
        if repository_file.is_file():
            items.append({
                "eventId": event_id,
                "category": "repository-file",
                "path": path,
                "archivePath": f"artifacts/product/{path}",
                "exists": True,
            })
            continue
        item = {
            "eventId": event_id,
            "category": "blocking",
            "path": path,
            "kind": kind,
            "reason": "artifact file not found in change or project root",
        }
        items.append(item)
        blocking.append(item)
    return {"ok": not blocking, "items": items, "blocking": blocking}


def _artifact_policy(project_root: Path) -> dict[str, Any]:
    path = (
        project_root
        / ".harness"
        / "config"
        / "artifact-policy.json"
    )
    defaults = {
        "schemaVersion": 1,
        "maxTotalBytes": 512 * 1024 * 1024,
        "maxFileBytes": 128 * 1024 * 1024,
        "contentAddressedMinBytes": 0,
        "runtimeTtlDays": 7,
        "stagingTtlDays": 2,
    }
    if not path.is_file():
        return {**defaults, "source": "defaults", "path": str(path)}
    value = read_json(path)
    if value.get("schemaVersion") != 1:
        raise ValueError("artifact policy schemaVersion must be 1")
    result = {**defaults, **value, "source": "project", "path": str(path)}
    for field in (
        "maxTotalBytes",
        "maxFileBytes",
        "contentAddressedMinBytes",
        "runtimeTtlDays",
        "stagingTtlDays",
    ):
        if not isinstance(result.get(field), int) or int(result[field]) < 0:
            raise ValueError(f"artifact policy {field} must be non-negative")
    return result


def build_retention_audit(change_dir: Path) -> dict[str, Any]:
    """Inventory expirable runtime/staging trees without deleting user data."""
    change_dir = change_dir.resolve()
    project_root = find_project_root(change_dir)
    policy = _artifact_policy(project_root)
    now = dt.datetime.now(dt.timezone.utc)
    roots = (
        (
            "runtime",
            change_dir / "runtime",
            int(policy["runtimeTtlDays"]),
        ),
        (
            "archive-operation-staging",
            project_root / ".harness" / "archive-operations" / "staging",
            int(policy["stagingTtlDays"]),
        ),
    )
    items: list[dict[str, Any]] = []
    for category, root, ttl_days in roots:
        if not root.is_dir():
            continue
        for path in sorted(root.iterdir(), key=lambda item: item.name):
            try:
                modified = dt.datetime.fromtimestamp(
                    path.stat().st_mtime,
                    tz=dt.timezone.utc,
                )
                bytes_on_disk = sum(
                    item.stat().st_size
                    for item in ([path] if path.is_file() else path.rglob("*"))
                    if item.is_file()
                )
            except OSError:
                continue
            age_seconds = max(0.0, (now - modified).total_seconds())
            expired = age_seconds >= ttl_days * 24 * 60 * 60
            try:
                relative = path.relative_to(project_root).as_posix()
            except ValueError:
                relative = str(path)
            items.append(
                {
                    "category": category,
                    "path": relative,
                    "modifiedAt": modified.isoformat().replace("+00:00", "Z"),
                    "ageDays": round(age_seconds / (24 * 60 * 60), 3),
                    "ttlDays": ttl_days,
                    "bytes": bytes_on_disk,
                    "status": "EXPIRED" if expired else "RETAINED",
                }
            )
    expired_items = [item for item in items if item["status"] == "EXPIRED"]
    return {
        "schemaVersion": 1,
        "generatedAt": now.isoformat().replace("+00:00", "Z"),
        "mode": "audit-only",
        "policy": {
            "runtimeTtlDays": int(policy["runtimeTtlDays"]),
            "stagingTtlDays": int(policy["stagingTtlDays"]),
            "source": policy["source"],
        },
        "items": items,
        "expiredCount": len(expired_items),
        "bytesPrunable": sum(int(item["bytes"]) for item in expired_items),
        "remediation": (
            "remove only expired entries after confirming no active capsule, "
            "lease, worktree, or archive operation references them"
        ),
    }


def evaluate_artifact_budget(change_dir: Path) -> dict[str, Any]:
    """Fail closed on archive size before the staging copy is created."""
    change_dir = change_dir.resolve()
    project_root = find_project_root(change_dir)
    try:
        policy = _artifact_policy(project_root)
        preflight = artifact_preflight(change_dir)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return {
            "ok": False,
            "code": "ARTIFACT_PREFLIGHT_INVALID",
            "message": str(exc),
        }
    if preflight.get("ok") is not True:
        return {
            "ok": False,
            "code": "ARTIFACT_PREFLIGHT_INVALID",
            "message": str(
                preflight.get("error")
                or "artifact event projection or preflight validation failed"
            ),
            "preflightBlocking": preflight.get("blocking") or [],
        }
    excluded_parts = {
        "node_modules",
        ".venv",
        "venv",
        "__pycache__",
        ".cache",
        "integration-temp",
    }
    files: dict[str, Path] = {}
    for path in sorted(change_dir.rglob("*")):
        if (
            not path.is_file()
            or any(part in excluded_parts for part in path.parts)
            or path.name.endswith(".lock")
        ):
            continue
        files[path.relative_to(change_dir).as_posix()] = path
    for item in preflight.get("items") or []:
        if item.get("category") != "repository-file":
            continue
        source = (project_root / str(item["path"])).resolve()
        if source.is_file() and source.is_relative_to(project_root):
            files[f"artifacts/product/{item['path']}"] = source
    entries = [
        {
            "path": relative,
            "bytes": path.stat().st_size,
        }
        for relative, path in files.items()
    ]
    entries.sort(key=lambda item: (-int(item["bytes"]), str(item["path"])))
    total = sum(int(item["bytes"]) for item in entries)
    max_total = int(policy["maxTotalBytes"])
    max_file = int(policy["maxFileBytes"])
    oversized = [
        item for item in entries if int(item["bytes"]) > max_file
    ]
    ok = total <= max_total and not oversized
    return {
        "ok": ok,
        "code": (
            "ARTIFACT_BUDGET_OK"
            if ok
            else "ARTIFACT_BUDGET_EXCEEDED"
        ),
        "message": (
            "archive artifacts fit the configured budget"
            if ok
            else "archive artifact budget exceeded before staging"
        ),
        "artifactCount": len(entries),
        "totalBytes": total,
        "maxTotalBytes": max_total,
        "maxFileBytes": max_file,
        "oversized": oversized,
        "largestItems": entries[:10],
        "policy": policy,
        "preflightBlocking": preflight.get("blocking") or [],
    }


def materialize_repository_artifacts(change_dir: Path) -> dict[str, Any]:
    """Materialize repository artifacts through a content-addressed object store."""
    change_dir = change_dir.resolve()
    project_root = find_project_root(change_dir)
    preflight = artifact_preflight(change_dir)
    if preflight.get("ok") is not True:
        raise ValueError(
            str(
                preflight.get("error")
                or "artifact event projection or preflight validation failed"
            )
        )
    copied: list[str] = []
    objects: list[dict[str, Any]] = []
    bytes_added = 0
    bytes_reused = 0
    object_root = (
        project_root
        / ".harness"
        / "cache"
        / "artifacts"
        / "objects"
        / "sha256"
    )
    for item in preflight.get("items") or []:
        if item.get("category") != "repository-file":
            continue
        source = (project_root / str(item["path"])).resolve()
        target = (change_dir / str(item["archivePath"])).resolve()
        if not source.is_relative_to(project_root) or not target.is_relative_to(change_dir):
            raise ValueError(f"artifact materialization escaped boundary: {item['path']}")
        digest = sha256_file(source)
        size = source.stat().st_size
        blob = object_root / digest[:2] / digest
        reused = blob.is_file()
        if reused:
            if blob.stat().st_size != size or sha256_file(blob) != digest:
                raise ValueError(f"content-addressed blob corrupted: {blob}")
            bytes_reused += size
        else:
            blob.parent.mkdir(parents=True, exist_ok=True)
            temporary = blob.with_name(
                f".{blob.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp"
            )
            try:
                shutil.copy2(source, temporary)
                if sha256_file(temporary) != digest:
                    raise ValueError(
                        f"content-addressed copy hash mismatch: {source}"
                    )
                os.replace(temporary, blob)
            finally:
                temporary.unlink(missing_ok=True)
            bytes_added += size
        target.parent.mkdir(parents=True, exist_ok=True)
        target_preexisting = target.exists()
        materialization = "existing"
        if target_preexisting:
            if target.stat().st_size != size or sha256_file(target) != digest:
                raise ValueError(f"artifact target conflicts: {target}")
        else:
            try:
                os.link(blob, target)
                materialization = "hardlink"
            except OSError:
                shutil.copy2(blob, target)
                materialization = "copy"
        copied.append(target.relative_to(change_dir).as_posix())
        objects.append(
            {
                "path": target.relative_to(change_dir).as_posix(),
                "sha256": "sha256:" + digest,
                "bytes": size,
                "blob": blob.relative_to(project_root).as_posix(),
                "reused": reused,
                "materialization": materialization,
            }
        )
    result = {
        "ok": True,
        "artifactCount": len(objects),
        "bytesAdded": bytes_added,
        "bytesReused": bytes_reused,
        "bytesPruned": 0,
        "largestItems": sorted(
            objects,
            key=lambda entry: (-int(entry["bytes"]), str(entry["path"])),
        )[:10],
        "objects": objects,
        "copied": sorted(copied),
    }
    if objects:
        write_json(
            change_dir / "evidence" / "artifact-storage.json",
            {"schemaVersion": 1, **result, "recordedAt": now_iso()},
        )
    return result


def run_service_stop(change_dir: Path) -> dict[str, Any]:
    if not SERVICE_SCRIPT.is_file():
        return {
            "ran": False,
            "skipped": True,
            "warning": f"harness_service.py not found; stop skipped",
        }
    try:
        proc = subprocess.run(
            [
                sys.executable,
                str(SERVICE_SCRIPT),
                "stop",
                "--change-dir",
                str(change_dir),
                "--if-started-by-ai",
                "--json",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            check=False,
        )
        return {
            "ran": True,
            "skipped": False,
            "exit_code": proc.returncode,
            "ok": proc.returncode == 0,
            "stdout": (proc.stdout or "")[:500],
        }
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ran": True, "skipped": False, "ok": False, "warning": str(exc)}


def _path_is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def _archive_tree_digest(root: Path) -> str:
    """Hash a complete archive tree without following links.

    Directory entries are included so an empty directory cannot disappear
    unnoticed.  Durable archives reject links rather than copying data from
    outside the finalized archive boundary.
    """
    root = root.resolve()
    if not root.is_dir():
        raise OSError(f"archive payload directory not found: {root}")
    digest = hashlib.sha256()
    for directory, dir_names, file_names in os.walk(root, followlinks=False):
        current = Path(directory)
        dir_names.sort()
        file_names.sort()
        for name in dir_names:
            child = current / name
            if child.is_symlink():
                raise OSError(f"durable archive refuses directory link: {child}")
            relative = child.relative_to(root).as_posix()
            digest.update(b"D\0")
            digest.update(relative.encode("utf-8"))
            digest.update(b"\0")
        for name in file_names:
            child = current / name
            if child.is_symlink():
                raise OSError(f"durable archive refuses file link: {child}")
            relative = child.relative_to(root).as_posix()
            file_hash = hashlib.sha256()
            size = 0
            with child.open("rb") as handle:
                while True:
                    chunk = handle.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    file_hash.update(chunk)
            digest.update(b"F\0")
            digest.update(relative.encode("utf-8"))
            digest.update(b"\0")
            digest.update(str(size).encode("ascii"))
            digest.update(b"\0")
            digest.update(file_hash.digest())
            digest.update(b"\0")
    return "sha256:" + digest.hexdigest()


def _atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    encoded = (
        json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    try:
        with temporary.open("wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def write_durable_archive(
    archive_payload: Path,
    durable_root: Path,
    *,
    archive_id: str,
    retention_policy: str,
) -> dict[str, Any]:
    """Publish and read back a content-addressed durable archive.

    The receipt is outside the payload so the payload hash is not
    self-referential.  An existing object is reusable only when its full tree
    hash matches the requested content.
    """
    source = archive_payload.resolve()
    root = durable_root.resolve()
    if not retention_policy.strip():
        raise ValueError("retention policy must not be empty")
    if (
        not archive_id
        or archive_id in {".", ".."}
        or Path(archive_id).name != archive_id
    ):
        raise ValueError(f"invalid durable archive id: {archive_id!r}")

    payload_hash = _archive_tree_digest(source)
    digest_hex = payload_hash.removeprefix("sha256:")
    object_dir = root / "objects" / "sha256" / digest_hex
    durable_payload = object_dir / "payload"
    receipt_path = root / "receipts" / f"{archive_id}.json"
    staging_root = root / ".staging" / f"d-{uuid.uuid4().hex}"
    staged_payload = staging_root / "payload"
    object_reused = False

    try:
        if durable_payload.exists():
            if not durable_payload.is_dir():
                raise OSError(f"durable object path is not a directory: {durable_payload}")
            readback_hash = _archive_tree_digest(durable_payload)
            if readback_hash != payload_hash:
                raise OSError(
                    "existing durable object failed readback verification: "
                    f"expected {payload_hash}, got {readback_hash}"
                )
            object_reused = True
        else:
            staging_root.mkdir(parents=True, exist_ok=False)
            shutil.copytree(source, staged_payload, copy_function=shutil.copy2)
            staged_hash = _archive_tree_digest(staged_payload)
            if staged_hash != payload_hash:
                raise OSError(
                    "durable staging readback mismatch: "
                    f"expected {payload_hash}, got {staged_hash}"
                )
            object_dir.mkdir(parents=True, exist_ok=True)
            try:
                os.replace(staged_payload, durable_payload)
            except OSError:
                # A concurrent writer may have published the same object.
                if not durable_payload.is_dir():
                    raise
                readback_hash = _archive_tree_digest(durable_payload)
                if readback_hash != payload_hash:
                    raise
                object_reused = True

        verified_hash = _archive_tree_digest(durable_payload)
        if verified_hash != payload_hash:
            raise OSError(
                "durable object verification failed: "
                f"expected {payload_hash}, got {verified_hash}"
            )

        receipt = {
            "schemaVersion": 1,
            "archiveId": archive_id,
            "status": "ARCHIVED_DURABLE",
            "payloadHash": payload_hash,
            "payloadPath": str(durable_payload),
            "retentionPolicy": retention_policy,
            "verifiedAt": now_iso(),
            "verification": {
                "algorithm": "sha256-tree-v1",
                "readBack": True,
            },
            "sourceDeletion": {
                "authorizedOnlyAfterVerification": True,
            },
        }
        if receipt_path.exists():
            existing = read_json(receipt_path)
            if (
                not isinstance(existing, dict)
                or existing.get("payloadHash") != payload_hash
                or existing.get("archiveId") != archive_id
            ):
                raise OSError(
                    f"durable receipt already exists for different content: {receipt_path}"
                )
            receipt = existing
        else:
            _atomic_write_json(receipt_path, receipt)

        return {
            "status": "ARCHIVED_DURABLE",
            "payloadHash": payload_hash,
            "payloadPath": str(durable_payload),
            "receiptPath": str(receipt_path),
            "retentionPolicy": retention_policy,
            "readBackVerified": True,
            "objectReused": object_reused,
        }
    finally:
        shutil.rmtree(staging_root, ignore_errors=True)
        staging_parent = root / ".staging"
        try:
            staging_parent.rmdir()
        except OSError:
            pass


def restore_durable_archive(receipt_path: Path, target_root: Path) -> dict[str, Any]:
    """Restore a verified durable object without overwriting an existing archive."""
    receipt_file = receipt_path.resolve()
    receipt = read_json(receipt_file)
    if not isinstance(receipt, dict) or receipt.get("schemaVersion") != 1:
        raise ValueError(f"invalid durable archive receipt: {receipt_file}")
    if receipt.get("status") != "ARCHIVED_DURABLE":
        raise ValueError(f"receipt is not durable: {receipt_file}")

    archive_id = str(receipt.get("archiveId") or "")
    payload_hash = str(receipt.get("payloadHash") or "")
    if (
        not archive_id
        or Path(archive_id).name != archive_id
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", payload_hash)
    ):
        raise ValueError(f"invalid durable archive receipt fields: {receipt_file}")

    durable_root = receipt_file.parent.parent.resolve()
    expected_payload = (
        durable_root
        / "objects"
        / "sha256"
        / payload_hash.removeprefix("sha256:")
        / "payload"
    ).resolve()
    declared_payload = Path(str(receipt.get("payloadPath") or "")).resolve()
    if declared_payload != expected_payload or not _path_is_within(
        expected_payload, durable_root / "objects"
    ):
        raise ValueError("durable receipt payload path is outside its object store")
    actual_hash = _archive_tree_digest(expected_payload)
    if actual_hash != payload_hash:
        raise OSError(
            f"durable payload hash mismatch: expected {payload_hash}, got {actual_hash}"
        )

    restore_root = target_root.resolve()
    destination = restore_root / archive_id
    if destination.exists():
        raise FileExistsError(f"restore destination already exists: {destination}")
    restore_root.mkdir(parents=True, exist_ok=True)
    staging = restore_root / f".restore-{uuid.uuid4().hex}"
    try:
        shutil.copytree(expected_payload, staging, copy_function=shutil.copy2)
        restored_hash = _archive_tree_digest(staging)
        if restored_hash != payload_hash:
            raise OSError(
                f"restored payload hash mismatch: expected {payload_hash}, got {restored_hash}"
            )
        os.replace(staging, destination)
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    return {
        "ok": True,
        "action": "restore-durable",
        "archiveId": archive_id,
        "payloadHash": payload_hash,
        "readBackVerified": True,
        "restoredArchive": str(destination),
    }


# ---------------------------------------------------------------------------
# finalize
# ---------------------------------------------------------------------------


def cmd_finalize(
    change_dir: Path,
    archive_root: Path,
    *,
    durable_root: Path | None = None,
    retention_policy: str = "unspecified",
    skip_ingest: bool = False,
    allow_missing_review: bool = False,
    archive_intent: str = "release-candidate",
    closure_disposition: str = "completed",
    closure_reason: str = "",
    preflight_status: dict[str, Any] | None = None,
) -> tuple[int, dict[str, Any]]:
    """Execute the 9-step finalize pipeline. Returns (exit_code, payload)."""
    if archive_intent not in {"release-candidate", "record-only"}:
        return 1, {
            "ok": False,
            "action": "finalize",
            "error": "archive_intent must be release-candidate or record-only",
        }
    if closure_disposition not in {"completed", "abandoned", "superseded"}:
        return 1, {
            "ok": False,
            "action": "finalize",
            "error": "invalid closure disposition",
        }
    closure_reason = closure_reason.strip()
    if closure_disposition != "completed" and not closure_reason:
        return 1, {
            "ok": False,
            "action": "finalize",
            "error": "closure reason is required for abandoned or superseded changes",
        }
    if closure_disposition != "completed" and archive_intent == "release-candidate":
        return 1, {
            "ok": False,
            "action": "finalize",
            "error": "abandoned or superseded changes cannot be release candidates",
        }
    warnings: list[str] = []
    original_change_dir = change_dir.resolve()
    change_name = original_change_dir.name
    archive_root = archive_root.resolve()
    archive_root.mkdir(parents=True, exist_ok=True)
    archive_dir = archive_root / f"{today_date()}-{change_name}"
    project_root = find_project_root(original_change_dir)
    if durable_root is not None:
        durable_root = durable_root.resolve()
        if _path_is_within(durable_root, project_root):
            return 1, {
                "ok": False,
                "action": "finalize",
                "change_dir": str(original_change_dir),
                "archive_dir": str(archive_dir),
                "issues": [
                    {
                        "code": "DURABLE_ROOT_NOT_INDEPENDENT",
                        "severity": "error",
                        "message": (
                            "durable root must be outside the project so project-local "
                            "state loss cannot delete both copies"
                        ),
                    }
                ],
                "error": "durable root is inside the project",
            }
    try:
        resolved_state_dir = hp.resolve_state_dir_for_contract(
            original_change_dir, project_root
        )
    except ValueError as exc:
        return 1, {
            "ok": False,
            "action": "finalize",
            "change_dir": str(original_change_dir),
            "error": f"invalid split runtime root: {exc}",
        }
    split_state_dir = (
        resolved_state_dir
        if resolved_state_dir.resolve() != original_change_dir.resolve()
        else None
    )
    authoritative_event_dir = (
        split_state_dir
        if split_state_dir is not None and split_state_dir.is_dir()
        else original_change_dir
    )
    monitoring_run_id = hes.run_id_for(original_change_dir)
    operation_id = f"a-{uuid.uuid4().hex[:12]}"
    operation_root = project_root / ".harness" / "archive-operations"
    operation_temp_dir = operation_root / "staging" / operation_id / change_dir.name
    operation_record = operation_root / f"{operation_id}.json"

    def _restore_finalize_failure() -> None:
        shutil.rmtree(operation_temp_dir.parent, ignore_errors=True)
        payload["original_preserved"] = original_change_dir.is_dir()
        payload["finalStatus"] = "FAIL"
        if authoritative_event_dir.is_dir():
            try:
                append_event(
                    authoritative_event_dir,
                    phase="archive",
                    type_="phase.end",
                    status="FAIL",
                    code=str(
                        payload.get("reasonCode")
                        or "ARCHIVE_FINALIZE_FAILED"
                    ),
                    message=str(payload.get("error") or "归档执行失败"),
                    note=f"归档操作 {operation_id} 失败，原变更目录已保留",
                )
            except OSError:
                pass
        _best_effort_archive_terminal_sync(
            project_root,
            authoritative_event_dir,
            change_key=change_name,
            run_id=monitoring_run_id,
            payload=payload,
        )
        try:
            write_json(
                operation_record,
                {
                    "schemaVersion": 1,
                    "operationId": operation_id,
                    "changeName": change_name,
                    "sourceDir": str(original_change_dir),
                    "archiveDir": str(archive_dir),
                    "finalStatus": "FAIL",
                    "error": payload.get("error"),
                    "finishedAt": now_iso(),
                },
            )
        except OSError as exc:
            warnings.append(f"could not persist failed archive operation: {exc}")

    payload: dict[str, Any] = {
        "ok": False,
        "action": "finalize",
        "change_dir": str(original_change_dir),
        "archive_dir": str(archive_dir),
        "change_name": change_name,
        "operationId": operation_id,
        "operationTempDir": str(operation_temp_dir),
        "operationRecord": str(operation_record),
        "archiveIntent": archive_intent,
        "releaseIntent": "candidate" if archive_intent == "release-candidate" else "none",
        "closureDisposition": closure_disposition,
        "closureReason": closure_reason or None,
        "releaseEligible": False,
        "warnings": warnings,
        "steps": {},
    }

    if not original_change_dir.is_dir():
        payload["error"] = f"change dir not found: {original_change_dir}"
        return 1, payload

    if archive_dir.exists():
        payload["error"] = f"archive target already exists: {archive_dir}"
        return 1, payload

    status = preflight_status or check_status(
        original_change_dir,
        allow_missing_review=allow_missing_review,
        archive_intent=archive_intent,
        closure_disposition=closure_disposition,
        closure_reason=closure_reason,
    )
    payload["steps"]["preflight"] = status
    if not status.get("archivable"):
        report_adequacy = (
            (status.get("releaseDecision") or {}).get("checks") or {}
        ).get("reportAdequacy") or {}
        adequacy_failed = report_adequacy.get("ok") is False
        payload["reasonCode"] = (
            "ARCHIVE_REPORT_ADEQUACY_FAILED"
            if adequacy_failed
            else "ARCHIVE_PRECONDITIONS_UNSATISFIED"
        )
        payload["error"] = (
            "归档报告不完整，未进入暂存与发布阶段。"
            if adequacy_failed
            else "归档前置条件未满足，未进入暂存与发布阶段。"
        )
        payload["issues"] = [
            {
                "code": str(
                    item.get("code") or "ARCHIVE_PRECONDITION_FAILED"
                ).replace("-", "_").upper(),
                "severity": "error",
                "message": str(item.get("message") or payload["error"]),
            }
            for item in status.get("blockers") or []
            if isinstance(item, dict)
        ]
        payload["original_preserved"] = original_change_dir.is_dir()
        payload["finalStatus"] = "BLOCKED"
        _append_finalize_failure_terminal(
            authoritative_event_dir,
            payload["error"],
            operation_id=operation_id,
        )
        _best_effort_archive_terminal_sync(
            project_root,
            authoritative_event_dir,
            change_key=change_name,
            run_id=monitoring_run_id,
            payload=payload,
        )
        return 1, payload

    # The formal archive attempt starts after the one-shot preflight succeeds,
    # before scans and staging begin.  Keeping this start in authoritative state
    # makes the monitor show the real duration and exactly one attempt.
    if authoritative_event_dir.is_dir():
        try:
            append_event(
                authoritative_event_dir,
                phase="archive",
                type_="phase.start",
                note="归档条件已通过，开始扫描、暂存与发布",
            )
        except OSError as exc:
            warnings.append(f"archive phase start append failed: {exc}")

    source_sensitive_refresh = hruntime.refresh_sensitive_evidence_scan_receipt(
        original_change_dir,
        persist=False,
    )
    payload["steps"]["sensitive_evidence_source_refresh"] = source_sensitive_refresh
    if not source_sensitive_refresh.get("ok"):
        payload["error"] = str(
            source_sensitive_refresh.get("error")
            or "sensitive evidence source receipt refresh failed"
        )
        payload["issues"] = [
            {
                "code": str(
                    source_sensitive_refresh.get("reasonCode")
                    or "SECRET_SCAN_RECEIPT_REFRESH_FAILED"
                ),
                "severity": "error",
                "message": payload["error"],
            }
        ]
        _restore_finalize_failure()
        return 1, payload

    source_sensitive_gate = validate_sensitive_evidence_publication_gate(
        original_change_dir,
        copy_root=original_change_dir,
        require_receipt=True,
        receipt_override=source_sensitive_refresh.get("receipt"),
    )
    payload["steps"]["sensitive_evidence_source_gate"] = source_sensitive_gate
    if not source_sensitive_gate.get("ok"):
        payload["error"] = str(
            source_sensitive_gate.get("nextAction")
            or source_sensitive_gate.get("error")
            or "sensitive evidence publication gate failed"
        )
        payload["issues"] = [
            {
                "code": str(
                    source_sensitive_gate.get("reasonCode")
                    or "SECRET_SCAN_GATE_BLOCKED"
                ),
                "severity": "error",
                "message": payload["error"],
            }
        ]
        _restore_finalize_failure()
        return 1, payload

    exact_byte = check_archive_exact_byte_policy(project_root)
    payload["steps"]["archive_exact_byte"] = exact_byte
    if not exact_byte["ok"]:
        warnings.append(str(exact_byte["remediation"]))

    artifact_budget = evaluate_artifact_budget(original_change_dir)
    payload["steps"]["artifact_budget"] = artifact_budget
    if not artifact_budget.get("ok"):
        if artifact_budget.get("code") == "ARTIFACT_PREFLIGHT_INVALID":
            payload["error"] = str(
                artifact_budget.get("message")
                or "artifact validation failed before staging"
            )
        else:
            payload["error"] = "artifact budget exceeded before staging"
        payload["issues"] = [
            {
                "code": str(
                    artifact_budget.get("code")
                    or "ARTIFACT_BUDGET_EXCEEDED"
                ),
                "severity": "error",
                "message": str(
                    artifact_budget.get("message")
                    or "artifact budget exceeded"
                ),
            }
        ]
        _restore_finalize_failure()
        return 1, payload

    payload["steps"]["service_stop_before_staging"] = run_service_stop(
        original_change_dir
    )
    transient_names = {
        "node_modules",
        ".venv",
        "venv",
        "__pycache__",
        ".cache",
        "integration-temp",
    }

    def _ignore_archive_transients(_directory: str, names: list[str]) -> set[str]:
        return {
            name
            for name in names
            if name in transient_names or name.endswith(".lock")
        }

    try:
        operation_temp_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(
            original_change_dir,
            operation_temp_dir,
            copy_function=shutil.copy2,
            ignore=_ignore_archive_transients,
        )
        write_json(
            operation_record,
            {
                "schemaVersion": 1,
                "operationId": operation_id,
                "changeName": change_name,
                "sourceDir": str(original_change_dir),
                "archiveDir": str(archive_dir),
                "finalStatus": "RUNNING",
                "startedAt": now_iso(),
            },
        )
    except OSError as exc:
        shutil.rmtree(operation_temp_dir.parent, ignore_errors=True)
        payload["error"] = f"operation staging failed: {exc}"
        _restore_finalize_failure()
        return 1, payload

    work_dir = operation_temp_dir
    before_manifest: dict[str, Any] | None = None

    # A source tree without sensitive evidence still receives a digest-bound
    # receipt in the isolated staging tree.  This keeps legacy archives
    # compatible while making every published archive auditable.
    try:
        # Split-v1 runtime state becomes part of the publishable archive.  Merge
        # it before the final scan so no late runtime byte can bypass the
        # sensitive-evidence gate or invalidate the receipt digest.
        if split_state_dir is not None and split_state_dir.is_dir():
            _merge_runtime_state(split_state_dir, work_dir)
            payload["steps"]["split_state_merge"] = {
                "ok": True,
                "stateDir": str(split_state_dir),
            }
        staged_sensitive_refresh = hruntime.refresh_sensitive_evidence_scan_receipt(
            work_dir
        )
        payload["steps"][
            "sensitive_evidence_staging_refresh"
        ] = staged_sensitive_refresh
        if not staged_sensitive_refresh.get("ok"):
            payload["error"] = str(
                staged_sensitive_refresh.get("error")
                or "sensitive evidence staging receipt refresh failed"
            )
            payload["issues"] = [
                {
                    "code": str(
                        staged_sensitive_refresh.get("reasonCode")
                        or "SECRET_SCAN_RECEIPT_REFRESH_FAILED"
                    ),
                    "severity": "error",
                    "message": payload["error"],
                }
            ]
            _restore_finalize_failure()
            return 1, payload
        staged_sensitive_gate = validate_sensitive_evidence_publication_gate(
            work_dir,
            copy_root=work_dir,
            require_receipt=True,
        )
        payload["steps"]["sensitive_evidence_publication"] = staged_sensitive_gate
        if not staged_sensitive_gate.get("ok"):
            payload["error"] = "sensitive evidence publication gate failed before freeze"
            payload["issues"] = [
                {
                    "code": str(
                        staged_sensitive_gate.get("reasonCode")
                        or "SECRET_SCAN_GATE_BLOCKED"
                    ),
                    "severity": "error",
                    "message": payload["error"],
                }
            ]
            _restore_finalize_failure()
            return 1, payload
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        payload["error"] = f"sensitive evidence publication gate failed: {exc}"
        _restore_finalize_failure()
        return 1, payload

    def _safe_append(**kwargs: Any) -> None:
        nonlocal work_dir
        try:
            append_event(work_dir, **kwargs)
        except OSError as exc:
            warnings.append(f"event append failed: {exc}")

    # --- 0. cleanup transients (before before-manifest) ---
    try:
        cleanup_result = _cleanup_transients(work_dir)
        payload["steps"]["cleanup"] = cleanup_result
        deleted_n = len(cleanup_result.get("deleted") or [])
        trunc_n = len(cleanup_result.get("truncated") or [])
        _safe_append(
            phase="archive",
            type_="command",
            command="cleanup-transients",
            exit_code=0,
            note=f"deleted={deleted_n} truncated={trunc_n}",
        )
    except OSError as exc:
        warnings.append(f"cleanup failed: {exc}")
        payload["steps"]["cleanup"] = {"ok": False, "error": str(exc)}

    # Product/business artifacts may live at repository-relative paths. Freeze
    # byte-for-byte copies inside the staged archive before either manifest.
    try:
        materialized = materialize_repository_artifacts(work_dir)
        payload["steps"]["artifact_materialization"] = materialized
    except (OSError, ValueError) as exc:
        payload["error"] = f"artifact materialization failed: {exc}"
        _restore_finalize_failure()
        return 1, payload

    # --- 1. before-manifest ---
    before_path = work_dir / "evidence" / "archive-manifest-before.json"
    try:
        before_manifest = generate_manifest(work_dir, before_path)
        payload["steps"]["before_manifest"] = {
            "ok": True,
            "path": str(before_path),
            "fileCount": before_manifest.get("fileCount"),
        }
        _safe_append(
            phase="archive",
            type_="artifact",
            path=str(before_path.relative_to(work_dir)).replace("\\", "/"),
            kind="manifest-before",
        )
        _safe_append(
            phase="archive",
            type_="command",
            command="generate_manifest(before)",
            exit_code=0,
            note="before-manifest",
        )
    except OSError as exc:
        payload["error"] = f"before-manifest failed: {exc}"
        _safe_append(
            phase="archive",
            type_="issue",
            code="before-manifest-failed",
            severity="error",
            message=str(exc),
        )
        _restore_finalize_failure()
        return 1, payload

    # --- 2b. user-flag decision (archive fact, must precede the cutoff) ---
    if allow_missing_review:
        _safe_append(
            phase="archive",
            type_="decision",
            note="review missing on full tier (allowed by user)",
        )

    # --- 2c. artifact preflight (retro §5.31) ---
    # Classify artifact events before freeze: blocking paths must fail closed
    # before the staged operation commits a phase.end.
    try:
        preflight = artifact_preflight(work_dir)
    except Exception as exc:  # noqa: BLE001 — preflight must not crash finalize
        preflight = {"ok": False, "items": [], "blocking": [], "error": str(exc)}
    payload["steps"]["artifact_preflight"] = {
        "ok": bool(preflight.get("ok")),
        "blockingCount": len(preflight.get("blocking") or []),
        "itemsCount": len(preflight.get("items") or []),
    }
    if preflight.get("ok") is not True:
        blocking_paths = preflight.get("blocking") or []
        if blocking_paths:
            payload["error"] = (
                f"artifact preflight blocking: "
                f"{len(blocking_paths)} path(s) cannot be archived"
            )
            payload["issues"] = [
                {
                    "code": "ARTIFACT_PATH_BLOCKING",
                    "severity": "error",
                    "message": f"{item.get('path', '')}: {item.get('reason', 'blocking')}",
                }
                for item in blocking_paths
            ]
        else:
            payload["error"] = (
                "artifact preflight invalid: "
                + str(
                    preflight.get("error")
                    or "artifact event projection or preflight validation failed"
                )
            )
            payload["issues"] = [
                {
                    "code": "ARTIFACT_PREFLIGHT_INVALID",
                    "severity": "error",
                    "message": payload["error"],
                }
            ]
        _restore_finalize_failure()
        payload["warnings"] = warnings
        payload["ok"] = False
        return 1, payload

    # --- 2d. product candidate verification / release eligibility ---
    if (
        not (
            work_dir / "evidence" / "product-candidate-verification.json"
        ).is_file()
        and _legacy_candidate_path(work_dir) is not None
    ):
        try:
            migrated = migrate_legacy_candidate_evidence(
                work_dir, project=project_root
            )
            payload["steps"]["candidate_evidence_migration"] = {
                "ok": True,
                "provider": migrated.get("provider"),
                "assurance": migrated.get("assurance"),
            }
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            payload["steps"]["candidate_evidence_migration"] = {
                "ok": False,
                "error": str(exc),
            }
            warnings.append(f"legacy candidate evidence migration failed: {exc}")
    ci_gate = evaluate_product_ci_gate(work_dir)
    payload["steps"]["product_candidate_ci"] = {
        "ok": bool(ci_gate.get("ok")),
        "code": ci_gate.get("code"),
        "message": ci_gate.get("message"),
    }
    payload["candidateVerification"] = ci_gate
    payload["releaseEligible"] = False
    if not ci_gate.get("ok") and archive_intent == "release-candidate":
        payload["error"] = str(ci_gate.get("message") or "PRODUCT_CI_NOT_GREEN")
        payload["issues"] = [
            {
                "code": "PRODUCT_CI_NOT_GREEN",
                "severity": "error",
                "message": str(ci_gate.get("message") or "product candidate CI not green"),
            }
        ]
        _restore_finalize_failure()
        payload["warnings"] = warnings
        payload["ok"] = False
        return 1, payload
    if not ci_gate.get("ok"):
        warnings.append(
            "record-only archive is not release eligible: "
            + str(ci_gate.get("message") or "product candidate not verified")
        )
    write_json(
        work_dir / "meta" / "archive-intent.json",
        {
            "schemaVersion": 1,
            "intent": archive_intent,
            "releaseIntent": (
                "candidate" if archive_intent == "release-candidate" else "none"
            ),
            "closureDisposition": closure_disposition,
            "closureReason": closure_reason or None,
            "candidateVerificationCode": ci_gate.get("code"),
            "releaseEligible": False,
            "releaseDecisionCode": "PENDING_IDENTITY_AND_REPORT_GATES",
            "recordedAt": now_iso(),
        },
    )

    # --- 3. candidate phase.end + freeze cutoff (RET-19 freeze-first) ---
    # This terminal exists only inside the isolated operation staging tree. It
    # becomes authoritative atomically at publish; validation failure discards
    # it and _restore_finalize_failure records the real FAIL attempt instead.
    # From here on, NO event may be appended to the staged events file.
    _safe_append(
        phase="archive",
        type_="phase.end",
        status="WARN" if warnings else "OK",
        note="finalize facts complete",
    )
    try:
        cutoff = _freeze_evidence_cutoff(work_dir)
        payload["steps"]["freeze"] = {"ok": True, "eventCount": cutoff["eventCount"]}
    except OSError as exc:
        payload["error"] = f"freeze failed: {exc}"
        payload["steps"]["freeze"] = {"ok": False, "error": str(exc)}
        _restore_finalize_failure()
        return 1, payload

    # --- 4. collect (pure function of frozen sources) ---
    try:
        summary = collect_summary_data(
            work_dir,
            before_manifest=before_manifest,
            write=True,
            for_replay=False,
        )
        summary_path = work_dir / "reports" / "final" / "summary-data.json"
        summary["archiveDurability"] = {
            "status": (
                "ARCHIVED_DURABLE"
                if durable_root is not None
                else "ARCHIVED_LOCAL_ONLY"
            ),
            "retentionPolicy": (
                retention_policy if durable_root is not None else "project-local"
            ),
            "readBackRequiredBeforeSourceDeletion": durable_root is not None,
            "risk": (
                None
                if durable_root is not None
                else (
                    "The archive exists only under the project-local .harness tree "
                    "and may be lost with that workspace."
                )
            ),
        }
        payload["archiveDurability"] = _deepcopy_json(
            summary["archiveDurability"]
        )
        write_json(summary_path, summary)
        if allow_missing_review:
            reasons = list(summary.get("finalStatusReasons") or [])
            reason = "review missing on full tier (allowed by user)"
            if reason not in reasons:
                reasons.append(reason)
            summary["finalStatusReasons"] = reasons
            write_json(summary_path, summary)
        payload["steps"]["collect"] = {"ok": True, "path": str(summary_path)}
    except Exception as exc:  # noqa: BLE001 — surface collect failures
        payload["error"] = f"collect failed: {exc}"
        payload["steps"]["collect"] = {"ok": False, "error": str(exc)}
        _restore_finalize_failure()
        return 1, payload

    # --- 5. source consistency (layer 1; UT-014) ---
    source_result = validate_source_consistency(work_dir, summary)
    payload["steps"]["source_consistency"] = source_result
    summary.setdefault("reportPipeline", {})["sourceConsistency"] = {
        "ok": bool(source_result.get("ok")),
        "issues": source_result.get("issues") or [],
    }
    try:
        write_json(summary_path, summary)
    except OSError as exc:
        warnings.append(f"could not write sourceConsistency: {exc}")
    if not source_result.get("ok"):
        payload["issues"] = source_result.get("issues") or []
        payload["error"] = "source consistency failed; staged operation discarded"
        _restore_finalize_failure()
        payload["warnings"] = warnings
        payload["ok"] = False
        return 1, payload

    # --- 5b. report adequacy (retro §5.32) ---
    # Validate that the summary is factually complete: no diff=0 with non-empty
    # commit, no missing typed metrics despite test reports, no stageStatus
    # contradictions. Fail closed rather than archiving an incomplete summary.
    adequacy_result = validate_report_adequacy(summary)
    payload["steps"]["report_adequacy"] = adequacy_result
    summary.setdefault("reportPipeline", {})["reportAdequacy"] = {
        "ok": bool(adequacy_result.get("ok")),
        "issues": adequacy_result.get("issues") or [],
    }
    try:
        write_json(summary_path, summary)
    except OSError as exc:
        warnings.append(f"could not write reportAdequacy: {exc}")
    release_decision = evaluate_release_eligibility(
        work_dir,
        summary,
        archive_integrity={
            "ok": True,
            "code": "ARCHIVE_INTEGRITY_PENDING_MANIFEST",
            "message": "pre-copy archive checks passed; checksum pending",
        },
        report_adequacy=adequacy_result,
    )
    summary["releaseDecision"] = release_decision
    summary["candidateVerification"] = release_decision["checks"][
        "candidateVerification"
    ]
    summary["releaseEligible"] = release_decision["releaseEligible"]
    payload["releaseDecision"] = release_decision
    payload["candidateVerification"] = summary["candidateVerification"]
    payload["releaseEligible"] = summary["releaseEligible"]
    try:
        write_json(summary_path, summary)
    except OSError as exc:
        warnings.append(f"could not write releaseDecision: {exc}")
    if not adequacy_result.get("ok"):
        payload["issues"] = adequacy_result.get("issues") or []
        payload["error"] = "report adequacy failed; staged operation discarded"
        _restore_finalize_failure()
        payload["warnings"] = warnings
        payload["ok"] = False
        return 1, payload
    if archive_intent == "release-candidate" and not release_decision[
        "releaseEligible"
    ]:
        payload["issues"] = release_decision.get("issues") or []
        payload["error"] = (
            "release eligibility failed; staged operation discarded"
        )
        _restore_finalize_failure()
        payload["warnings"] = warnings
        payload["ok"] = False
        return 1, payload

    # --- 6. canonical summary validation ---
    try:
        summary = read_json(summary_path)
    except (OSError, json.JSONDecodeError):
        pass
    validate_result = validate_summary_data(summary)
    payload["steps"]["validate"] = validate_result
    summary.setdefault("reportPipeline", {})["validationIssues"] = validate_result.get(
        "issues"
    ) or []
    try:
        write_json(summary_path, summary)
    except OSError as exc:
        warnings.append(f"could not write validationIssues: {exc}")

    # --- 8. archive-meta (before after-manifest so the manifest covers it) ---
    try:
        summary = read_json(summary_path)
        meta_path = write_archive_meta(work_dir, summary)
        payload["steps"]["archive_meta"] = {"ok": True, "path": str(meta_path)}
    except Exception as exc:  # noqa: BLE001 — meta soft-fail
        warnings.append(f"archive-meta write failed: {exc}")
        payload["steps"]["archive_meta"] = {"ok": False, "error": str(exc)}

    # --- 8b. knowledge candidates (also before the after-manifest) ---
    # Soft-fail like archive-meta: an archive must never be rolled back because
    # knowledge extraction found nothing. An empty array is a valid outcome.
    try:
        summary = read_json(summary_path)
        candidates_path = write_knowledge_candidates(work_dir, summary)
        payload["steps"]["knowledge_candidates"] = {
            "ok": True,
            "path": str(candidates_path),
            "count": len(read_json(candidates_path)),
        }
    except Exception as exc:  # noqa: BLE001 — candidates soft-fail
        warnings.append(f"knowledge candidates write failed: {exc}")
        payload["steps"]["knowledge_candidates"] = {"ok": False, "error": str(exc)}

    # --- 9/10. final summary stats, then LAST manifest (IA-7) ---
    # Post-manifest rewrites of covered bytes are forbidden. We update the
    # summary first, regenerate after-manifest last, then verify on-disk hashes.
    # If summary must still change after that, it is excluded with a reason.
    summary = read_json(summary_path)
    summary["archiveManifest"] = {
        "movedFiles": 0,
        "generatedFiles": 0,
        "totalArchiveFiles": 0,
        "checksumStatus": "PENDING",
    }
    write_json(summary_path, summary)
    summary = read_json(summary_path)
    validate_result = validate_summary_data(summary)
    payload["steps"]["validate"] = validate_result
    summary.setdefault("reportPipeline", {})["validationIssues"] = validate_result.get(
        "issues"
    ) or []
    write_json(summary_path, summary)

    after_path = work_dir / "evidence" / "archive-manifest-after.json"
    try:
        after_manifest = generate_manifest(work_dir, after_path)
        before_in_archive = work_dir / "evidence" / "archive-manifest-before.json"
        if before_in_archive.is_file():
            before_manifest = read_json(before_in_archive)
        compare_result = compare_manifests(before_manifest, after_manifest)
        # Embed compare stats into summary AFTER manifest → must exclude those paths.
        # Only one coverage pass runs: an earlier build verified here as well,
        # but that result was overwritten a few lines below by the pass that
        # excludes summary-data.json, so it only cost a full extra tree hash.
        summary = read_json(summary_path)
        summary["archiveManifest"] = {
            "movedFiles": compare_result.get("movedFiles", 0),
            "generatedFiles": compare_result.get("generatedFiles", 0),
            "totalArchiveFiles": compare_result.get("totalArchiveFiles", 0),
            "checksumStatus": "PENDING",
            "exclusionReasons": {
                "reports/final/summary-data.json": (
                    "archiveManifest stats written after coverage snapshot"
                ),
            },
            **_manifest_self_stats(work_dir, after_manifest, after_path),
        }
        write_json(summary_path, summary)
        coverage = verify_manifest_byte_coverage(
            work_dir,
            after_manifest,
            exclude_paths=[
                "reports/final/summary-data.json",
            ],
            exclusion_reasons=summary["archiveManifest"]["exclusionReasons"],
        )
        summary["archiveManifest"]["checksumStatus"] = coverage.get(
            "checksumStatus", "FAIL"
        )
        summary["archiveManifest"]["exclusionReasons"] = coverage.get(
            "exclusionReasons"
        ) or summary["archiveManifest"]["exclusionReasons"]
        summary["archiveManifest"]["coverageChecked"] = coverage.get("checked")
        final_archive_integrity = {
            "ok": bool(coverage.get("ok"))
            and str(coverage.get("checksumStatus") or "")
            in {"OK", "OK_WITH_EXCLUSIONS"},
            "code": (
                "ARCHIVE_INTEGRITY_OK"
                if bool(coverage.get("ok"))
                and str(coverage.get("checksumStatus") or "")
                in {"OK", "OK_WITH_EXCLUSIONS"}
                else "ARCHIVE_INTEGRITY_FAILED"
            ),
            "message": (
                "final archive manifest byte coverage verified"
                if bool(coverage.get("ok"))
                else "final archive manifest byte coverage failed"
            ),
            "checksumStatus": coverage.get("checksumStatus"),
        }
        final_adequacy = validate_report_adequacy(summary)
        final_release_decision = evaluate_release_eligibility(
            work_dir,
            summary,
            archive_integrity=final_archive_integrity,
            report_adequacy=final_adequacy,
        )
        summary["archiveIntegrity"] = final_archive_integrity
        summary["candidateVerification"] = final_release_decision["checks"][
            "candidateVerification"
        ]
        summary["releaseDecision"] = final_release_decision
        summary["releaseEligible"] = final_release_decision[
            "releaseEligible"
        ]
        summary.setdefault("reportPipeline", {})[
            "reportAdequacy"
        ] = final_adequacy
        summary["reportPipeline"][
            "releaseDecision"
        ] = final_release_decision
        payload["releaseDecision"] = final_release_decision
        payload["candidateVerification"] = summary[
            "candidateVerification"
        ]
        payload["releaseEligible"] = summary["releaseEligible"]
        write_json(summary_path, summary)
        summary = read_json(summary_path)
        validate_result = validate_summary_data(summary)
        payload["steps"]["validate"] = validate_result
        summary.setdefault("reportPipeline", {})["validationIssues"] = (
            validate_result.get("issues") or []
        )
        write_json(summary_path, summary)
        payload["steps"]["after_manifest"] = {
            "ok": bool(coverage.get("ok")) and bool(compare_result.get("ok")),
            "path": str(after_path),
            "compare": compare_result,
            "coverage": coverage,
        }
        compare_result = {
            **compare_result,
            "ok": bool(compare_result.get("ok")) and bool(coverage.get("ok")),
            "checksumStatus": coverage.get("checksumStatus"),
            "exclusionReasons": coverage.get("exclusionReasons"),
        }
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        payload["error"] = f"after-manifest failed: {exc}"
        payload["steps"]["after_manifest"] = {"ok": False, "error": str(exc)}
        _restore_finalize_failure()
        return 1, payload

    # --- 11. closure: only when both validators and manifest pass ---
    validate_ok = bool(validate_result.get("ok"))
    manifest_ok = bool(compare_result.get("ok"))
    # Honest checksum: FAIL blocks; OK and OK_WITH_EXCLUSIONS (with reasons) pass.
    checksum = str(compare_result.get("checksumStatus") or "")
    checksum_ok = checksum in {"OK", "OK_WITH_EXCLUSIONS"}
    release_ok = bool(
        (payload.get("releaseDecision") or {}).get("releaseEligible")
    )
    can_close = (
        validate_ok
        and manifest_ok
        and checksum_ok
        and (archive_intent == "record-only" or release_ok)
    )

    if not can_close:
        issues_out = list(validate_result.get("issues") or [])
        if not manifest_ok or not checksum_ok:
            issues_out.append(
                {
                    "code": "manifest-mismatch",
                    "severity": "error",
                    "message": (
                        f"missing={compare_result.get('missing')} "
                        f"mismatched={compare_result.get('mismatched')} "
                        f"checksumStatus={checksum}"
                    ),
                }
            )
        if archive_intent == "release-candidate" and not release_ok:
            issues_out.extend(
                (payload.get("releaseDecision") or {}).get("issues") or []
            )
        payload["issues"] = issues_out
        payload["error"] = "validate or manifest check failed; staged operation discarded"
        payload["steps"]["delete_original"] = {"ok": False, "deleted": False}
        _restore_finalize_failure()
        payload["warnings"] = warnings
        payload["ok"] = False
        return 1, payload

    # A durable sink, when requested, is committed and read back before either
    # publishing the local archive or deleting the source change directory.
    if durable_root is not None:
        try:
            durability = write_durable_archive(
                operation_temp_dir,
                durable_root,
                archive_id=archive_dir.name,
                retention_policy=retention_policy,
            )
            payload["archiveDurability"] = durability
            payload["steps"]["durable_archive"] = {
                "ok": True,
                **durability,
            }
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            payload["error"] = f"durable archive write failed: {exc}"
            payload["issues"] = [
                {
                    "code": "DURABLE_ARCHIVE_WRITE_FAILED",
                    "severity": "error",
                    "message": str(exc),
                }
            ]
            payload["steps"]["durable_archive"] = {
                "ok": False,
                "error": str(exc),
            }
            payload["steps"]["delete_original"] = {
                "ok": False,
                "deleted": False,
            }
            _restore_finalize_failure()
            payload["warnings"] = warnings
            payload["ok"] = False
            return 1, payload

    # Publish only after every validator passes. The archive path is never used
    # as mutable staging, so a failed attempt cannot poison the next retry.
    # Capture monitoring run_id from the live change path before it is deleted
    # so archive finalize can report terminal status on the same platform run.
    try:
        archive_root.mkdir(parents=True, exist_ok=True)
        shutil.move(str(operation_temp_dir), str(archive_dir))
        shutil.rmtree(operation_temp_dir.parent, ignore_errors=True)
        work_dir = archive_dir
        summary_path = work_dir / "reports" / "final" / "summary-data.json"
        payload["steps"]["move"] = {"ok": True, "to": str(archive_dir)}
    except OSError as exc:
        payload["error"] = f"publish failed: {exc}"
        payload["steps"]["move"] = {"ok": False, "error": str(exc)}
        _restore_finalize_failure()
        return 1, payload

    # Success path: the validated copy is published; now retire its source.
    if original_change_dir.exists():
        try:
            shutil.rmtree(original_change_dir)
            payload["steps"]["delete_original"] = {"ok": True, "deleted": True}
        except OSError as exc:
            warnings.append(f"could not remove leftover change dir: {exc}")
            payload["steps"]["delete_original"] = {"ok": False, "error": str(exc)}
    else:
        payload["steps"]["delete_original"] = {
            "ok": True,
            "deleted": True,
            "note": "source already absent",
        }

    if split_state_dir is not None and split_state_dir.is_dir():
        try:
            shutil.rmtree(split_state_dir)
            payload["steps"]["delete_runtime_state"] = {"ok": True, "deleted": True}
        except OSError as exc:
            warnings.append(f"could not remove archived runtime state: {exc}")
            payload["steps"]["delete_runtime_state"] = {"ok": False, "error": str(exc)}

    # --- 12. remote knowledge ownership + service ---
    # Knowledge ingest is server-owned. The local archive never builds or keeps
    # a searchable knowledge index; upload status below is the ingest receipt.
    payload["steps"]["knowledge"] = {
        "mode": "remote-after-archive-upload",
        "localIngest": False,
        "legacySkipIngestFlag": bool(skip_ingest),
    }
    payload["knowledgeMaintenance"] = "REMOTE_PENDING"

    # Freeze the platform run immediately after the local archive is published.
    # Service shutdown, ZIP upload, and managed snapshot synchronization are
    # independent post-phase work and may wait on process/network deadlines.
    _best_effort_archive_terminal_sync(
        project_root,
        archive_dir,
        change_key=change_name,
        run_id=monitoring_run_id,
        payload=payload,
    )

    service_result = run_service_stop(work_dir)
    payload["steps"]["service_stop"] = service_result
    if service_result.get("warning"):
        warnings.append(str(service_result["warning"]))

    # When remote credentials exist, upload one deterministic core-only ZIP.
    push_result = auto_push_archive_core(
        project_root,
        archive_dir,
        change_key=change_name,
    )
    payload["steps"]["archive_push"] = push_result
    payload["knowledgeMaintenance"] = _knowledge_maintenance_from_archive_push(
        push_result
    )
    remote_durability = remote_durable_archive_durability(
        payload.get("archiveDurability"), push_result
    )
    if remote_durability is not None:
        payload["archiveDurability"] = remote_durability
        # 报告必须跟着改口：上传发生在 summary 落盘之后，不回写就会出现
        # "回执 durable / 报告 local-only" 的自相矛盾
        if not persist_archive_durability(summary_path, remote_durability):
            warnings.append(
                "远端归档已持久化，但 summary-data.json 的 archiveDurability 回写失败"
            )
    if push_result.get("warning"):
        warnings.append(str(push_result["warning"]))

    managed_snapshot = auto_push_managed_snapshot(project_root)
    payload["steps"]["managed_snapshot_push"] = managed_snapshot
    if managed_snapshot.get("warning"):
        warnings.append(str(managed_snapshot["warning"]))

    archive_remote = {
        key: push_result.get(key)
        for key in (
            "archiveId",
            "archiveStatus",
            "knowledgeStatus",
            "knowledgeCandidateCount",
            "uploadStatus",
            "packageSha256",
            "manifestSha256",
            "reasonCode",
            "remoteReceipt",
        )
        if push_result.get(key) is not None
    }
    try:
        write_json(
            operation_record,
            {
                "schemaVersion": 1,
                "operationId": operation_id,
                "changeName": change_name,
                "sourceDir": str(original_change_dir),
                "archiveDir": str(archive_dir),
                "finalStatus": "OK",
                "publishedAt": now_iso(),
                "summarySha256": sha256_file(summary_path),
                "manifestSha256": sha256_file(
                    archive_dir / "evidence" / "archive-manifest-after.json"
                ),
                "archiveDurability": payload.get("archiveDurability"),
                "knowledgeMaintenance": payload["knowledgeMaintenance"],
                "archiveRemote": archive_remote,
                "managedSnapshot": managed_snapshot,
            },
        )
    except OSError as exc:
        warnings.append(f"could not persist completed archive operation: {exc}")

    payload["ok"] = True
    payload["finalStatus"] = "OK"
    payload["warnings"] = warnings
    payload["summary_data"] = str(summary_path)
    return 0, payload


def _yaml_scalar(raw: str) -> str | None:
    """Decode the small scalar subset used by Harness-owned YAML files."""
    value = raw.strip()
    if not value:
        return None
    quote: str | None = None
    escaped = False
    end = len(value)
    for index, character in enumerate(value):
        if escaped:
            escaped = False
            continue
        if quote == '"' and character == "\\":
            escaped = True
            continue
        if character in {"'", '"'}:
            if quote is None:
                quote = character
            elif quote == character:
                quote = None
            continue
        if character == "#" and quote is None:
            end = index
            break
    value = value[:end].strip()
    if value.lower() in {"", "null", "none", "~"}:
        return None
    if len(value) >= 2 and value[0] == value[-1] == '"':
        try:
            decoded = json.loads(value)
        except json.JSONDecodeError:
            return None
        return decoded.strip() if isinstance(decoded, str) and decoded.strip() else None
    if len(value) >= 2 and value[0] == value[-1] == "'":
        decoded = value[1:-1].replace("''", "'").strip()
        return decoded or None
    return value


def _yaml_mapping_value(
    text: str,
    key: str,
    *,
    section: str | None = None,
) -> str | None:
    """Read one root or one-level nested scalar without loading arbitrary YAML."""
    inside_section = section is None
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        match = re.match(
            r"^(?P<indent> *)(?P<key>[A-Za-z_][A-Za-z0-9_-]*):(?P<raw>.*)$",
            line,
        )
        if match is None:
            continue
        indent = len(match.group("indent"))
        name = match.group("key")
        if section is None:
            if indent == 0 and name == key:
                return _yaml_scalar(match.group("raw"))
            continue
        if section is not None and indent == 0:
            inside_section = name == section
            continue
        if inside_section and name == key and indent > 0:
            return _yaml_scalar(match.group("raw"))
    return None


def _read_optional_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8-sig")
    except OSError:
        return ""


def _archive_server_url_allowed(value: str | None) -> bool:
    """Require TLS remotely while allowing explicit loopback HTTP for local testing."""
    if value is None or not value.strip() or re.search(r"\s", value):
        return False
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").lower()
    except ValueError:
        return False
    if parsed.scheme.lower() == "https":
        return bool(host)
    if parsed.scheme.lower() != "http":
        return False
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _resolve_archive_remote_credentials(
    project_root: Path,
    environment: Mapping[str, str],
) -> dict[str, Any]:
    """Mirror CLI auth precedence without returning or persisting the token."""
    project_text = _read_optional_text(project_root / ".harness" / "project.yaml")
    local_text = _read_optional_text(
        project_root / ".harness" / "credentials.local.yaml"
    )
    project_url = _yaml_mapping_value(project_text, "url", section="server")
    token_env = _yaml_mapping_value(project_text, "token_env", section="server")
    local_url = _yaml_mapping_value(local_text, "server_url")
    local_token = _yaml_mapping_value(local_text, "token")
    server_url = local_url or project_url
    valid_token_env = (
        token_env
        if token_env is not None
        and re.fullmatch(r"[A-Z_][A-Z0-9_]*", token_env) is not None
        else None
    )
    env_token = (
        environment.get(valid_token_env, "").strip()
        if valid_token_env is not None
        else ""
    )
    token_available = bool(env_token or local_token)
    url_available = _archive_server_url_allowed(server_url)
    return {
        "configured": bool(url_available and token_available),
        "serverUrl": server_url if url_available else None,
        "tokenEnv": valid_token_env,
        "missing": [
            *([] if url_available else ["url"]),
            *([] if token_available else ["token"]),
        ],
    }


def _remote_credentials_configured(project_root: Path) -> bool:
    """Compatibility predicate backed by the same auth sources as the CLI."""
    return bool(
        _resolve_archive_remote_credentials(project_root.resolve(), os.environ)[
            "configured"
        ]
    )


_FILE_ATTRIBUTE_REPARSE_POINT = getattr(
    stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400
)


def _archive_path_is_link_or_reparse(path: Path) -> bool:
    """Detect symlinks and Windows junction/reparse points without following them."""
    try:
        if path.is_symlink():
            return True
        attributes = getattr(os.lstat(path), "st_file_attributes", 0)
    except OSError:
        return False
    return bool(attributes & _FILE_ATTRIBUTE_REPARSE_POINT)


def _require_archive_project_path(
    project_root: Path,
    candidate: Path,
    *,
    label: str,
    must_exist: bool,
) -> Path:
    """Return a canonical project-contained path after rejecting link components."""
    lexical_root = Path(os.path.abspath(os.fspath(project_root)))
    lexical_candidate = Path(os.path.abspath(os.fspath(candidate)))
    try:
        relative = lexical_candidate.relative_to(lexical_root)
    except ValueError as exc:
        raise ValueError(f"{label} is outside project root: {candidate}") from exc
    if not relative.parts:
        raise ValueError(f"{label} must be strictly inside project root")

    current = lexical_root
    for part in relative.parts:
        current = current / part
        if _archive_path_is_link_or_reparse(current):
            raise ValueError(f"{label} contains a link or reparse point: {current}")

    try:
        canonical_root = lexical_root.resolve(strict=True)
        canonical_candidate = lexical_candidate.resolve(strict=must_exist)
    except OSError as exc:
        raise ValueError(f"{label} does not exist or cannot be resolved: {candidate}") from exc
    try:
        canonical_relative = canonical_candidate.relative_to(canonical_root)
    except ValueError as exc:
        raise ValueError(f"{label} resolves outside project root: {candidate}") from exc
    if not canonical_relative.parts:
        raise ValueError(f"{label} must be strictly inside project root")
    return canonical_candidate


def _archive_core_file_specs(
    project_root: Path,
    archive_dir: Path,
) -> tuple[Path, Path, list[tuple[Path, str, str, str]]]:
    root = Path(os.path.abspath(os.fspath(project_root))).resolve(strict=True)
    archive = _require_archive_project_path(
        project_root,
        archive_dir,
        label="archive dir",
        must_exist=True,
    )
    if not archive.is_dir():
        raise ValueError(f"archive dir not found: {archive}")

    file_specs: list[tuple[Path, str, str, str]] = []

    def add_if_file(
        candidate: Path,
        package_path: str,
        role: str,
        media_type: str,
    ) -> None:
        safe = _require_archive_project_path(
            root,
            candidate,
            label=f"archive input {package_path}",
            must_exist=False,
        )
        if safe.is_file():
            file_specs.append((safe, package_path, role, media_type))

    add_if_file(
        archive / "reports" / "final" / "summary-data.json",
        "reports/final/summary-data.json",
        "summary",
        "application/json",
    )
    for folder, role in (("spec", "spec"), ("plans", "plan")):
        base = _require_archive_project_path(
            root,
            archive / folder,
            label=f"archive input {folder}",
            must_exist=False,
        )
        if not base.is_dir():
            continue
        for directory, directory_names, file_names in os.walk(
            base, topdown=True, followlinks=False
        ):
            current = Path(directory)
            directory_names.sort()
            file_names.sort()
            for name in directory_names:
                _require_archive_project_path(
                    root,
                    current / name,
                    label=f"archive input {folder}/{name}",
                    must_exist=True,
                )
            for name in file_names:
                source = _require_archive_project_path(
                    root,
                    current / name,
                    label=f"archive input {folder}/{name}",
                    must_exist=True,
                )
                if source.is_file() and source.suffix.lower() == ".md":
                    relative = source.relative_to(base).as_posix()
                    file_specs.append(
                        (source, f"{folder}/{relative}", role, "text/markdown")
                    )
    add_if_file(
        archive / "candidates" / "knowledge.json",
        "candidates/knowledge.json",
        "knowledge_candidates",
        "application/json",
    )
    add_if_file(
        archive / "meta" / "archive-meta.md",
        "archive-meta.md",
        "archive_meta",
        "text/markdown",
    )
    add_if_file(
        archive / "meta" / "change-context.json",
        "change-context.json",
        "change_context",
        "application/json",
    )
    return root, archive, file_specs


def collect_archive_core_paths(project_root: Path, archive_dir: Path) -> list[str]:
    """Return only durable core files; diagnostics and local knowledge stay local."""
    root, _, file_specs = _archive_core_file_specs(project_root, archive_dir)
    return [source.relative_to(root).as_posix() for source, *_ in file_specs]


def _archive_source_identity(project_root: Path) -> dict[str, str | None]:
    def git_value(*args: str) -> str | None:
        try:
            completed = subprocess.run(
                ["git", *args],
                cwd=str(project_root),
                text=True,
                encoding="utf-8",
                errors="replace",
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=10,
                shell=False,
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        value = completed.stdout.strip()
        return value if completed.returncode == 0 and value else None

    return {
        "commit": git_value("rev-parse", "HEAD"),
        "tree": git_value("rev-parse", "HEAD^{tree}"),
    }


def _archive_created_at(summary_path: Path) -> str:
    try:
        summary = read_json(summary_path)
    except (OSError, json.JSONDecodeError):
        return "1980-01-01T00:00:00.000Z"
    for key in ("archivedAt", "archived_at", "generatedAt", "generated_at"):
        value = summary.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return "1980-01-01T00:00:00.000Z"


def _deterministic_zip_info(path: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(path, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.create_system = 3
    info.external_attr = (0o100644 & 0xFFFF) << 16
    return info


_WINDOWS_LOCAL_PATH_RE = re.compile(
    r"\b[A-Za-z]:\\(?:[^\s<>:\"|?*]+\\)*[^\s<>:\"|?*]*"
)


def _archive_remote_json_value(value: Any) -> Any:
    """Remove machine-local absolute paths from the remote JSON projection."""
    if isinstance(value, dict):
        return {
            key: _archive_remote_json_value(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_archive_remote_json_value(item) for item in value]
    if not isinstance(value, str):
        return value
    if re.match(r"^[A-Za-z]:[\\/]", value) or value.startswith("\\\\"):
        return "<local-path>"
    return _WINDOWS_LOCAL_PATH_RE.sub("<local-path>", value)


def _archive_remote_json_bytes(raw: bytes) -> bytes:
    value = json.loads(raw)
    projected = _archive_remote_json_value(value)
    return (
        json.dumps(
            projected,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")


def resolve_npx_launcher() -> list[str]:
    """Resolve npx without asking CreateProcess to execute a Windows .CMD shim."""
    npx = shutil.which("npx")
    if not npx:
        raise FileNotFoundError("npx is not installed or not available on PATH")
    if os.name != "nt":
        return [npx]

    node = shutil.which("node")
    if not node:
        raise FileNotFoundError("node is required to launch npx on Windows")
    npx_path = Path(npx)
    npx_cli = npx_path.parent / "node_modules" / "npm" / "bin" / "npx-cli.js"
    if not npx_cli.is_file():
        raise FileNotFoundError(f"npx-cli.js not found beside Node.js: {npx_cli}")
    return [node, str(npx_cli)]


def _installed_cli_entry(project_root: Path) -> Path | None:
    """Find an installed hunter-harness entry script, walking up from the project.

    npx costs a full npm resolution (and a registry round-trip when the package
    is not a local dependency) on every call, and archive publishes it twice.
    Running the entry script under node directly skips all of that.
    """
    seen: set[Path] = set()
    for base in (project_root, *project_root.parents):
        if base in seen:
            continue
        seen.add(base)
        candidate = base / "node_modules" / "hunter-harness" / "dist" / "bin.js"
        if candidate.is_file():
            return candidate
    return None


def resolve_hunter_cli_command(project_root: Path) -> list[str]:
    """Command prefix that runs the hunter-harness CLI, cheapest route first."""
    node = shutil.which("node")
    if node:
        entry = _installed_cli_entry(project_root)
        if entry is not None:
            return [node, str(entry)]
    return [*resolve_npx_launcher(), "--yes", "hunter-harness"]


def build_archive_package(
    project_root: Path,
    archive_dir: Path,
    change_key: str,
    *,
    output_path: Path | None = None,
    extra_entries: dict[str, tuple[str, str, bytes]] | None = None,
) -> dict[str, Any]:
    """Build the deterministic core-v1 ZIP uploaded to hunter-platform.

    ``extra_entries`` maps a package path to ``(role, media_type, bytes)`` for
    content that is *not* on disk in the archive. Republishing an older archive
    uses it to supply knowledge candidates that predate the candidates step,
    without writing into a sealed archive directory whose manifest already
    covers every byte in it.
    """
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,159}", change_key) is None:
        raise ValueError("change_key must be a portable path segment")
    project_root, archive_dir, file_specs = _archive_core_file_specs(
        project_root, archive_dir
    )
    summary_path = archive_dir / "reports" / "final" / "summary-data.json"
    if not any(spec[1] == "reports/final/summary-data.json" for spec in file_specs):
        raise ValueError("archive final summary-data.json is required")

    on_disk_paths = {spec[1] for spec in file_specs}
    injected = {
        package_path: value
        for package_path, value in (extra_entries or {}).items()
        if package_path not in on_disk_paths
    }

    entries: list[dict[str, Any]] = []
    content_by_path: dict[str, bytes] = {}
    for package_path, (role, media_type, raw) in sorted(injected.items()):
        raw.decode("utf-8")
        if media_type == "application/json":
            raw = _archive_remote_json_bytes(raw)
        content_by_path[package_path] = raw
        entries.append(
            {
                "path": package_path,
                "role": role,
                "media_type": media_type,
                "content_sha256": "sha256:" + hashlib.sha256(raw).hexdigest(),
                "size_bytes": len(raw),
            }
        )
    for source, package_path, role, media_type in sorted(file_specs, key=lambda item: item[1]):
        source = _require_archive_project_path(
            project_root,
            source,
            label=f"archive input {package_path}",
            must_exist=True,
        )
        raw = source.read_bytes()
        # All semantic archive inputs are text and must round-trip as UTF-8.
        raw.decode("utf-8")
        if media_type == "application/json":
            raw = _archive_remote_json_bytes(raw)
        content_by_path[package_path] = raw
        entries.append(
            {
                "path": package_path,
                "role": role,
                "media_type": media_type,
                "content_sha256": "sha256:" + hashlib.sha256(raw).hexdigest(),
                "size_bytes": len(raw),
            }
        )

    entries.sort(key=lambda item: str(item["path"]))
    manifest = {
        "schema_version": 1,
        "profile": "core-v1",
        "change_key": change_key,
        "created_at": _archive_created_at(summary_path),
        "source": _archive_source_identity(project_root),
        "files": entries,
    }
    manifest_bytes = (
        json.dumps(
            manifest,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n"
    ).encode("utf-8")

    if output_path is None:
        output_path = (
            project_root
            / ".harness"
            / "state"
            / "local"
            / "archive-packages"
            / f"{change_key}.zip"
        )
    output_path = _require_archive_project_path(
        project_root,
        output_path,
        label="archive package output",
        must_exist=False,
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path = _require_archive_project_path(
        project_root,
        output_path,
        label="archive package output",
        must_exist=False,
    )
    temporary = output_path.with_name(output_path.name + f".{uuid.uuid4().hex}.tmp")
    try:
        with zipfile.ZipFile(
            temporary,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=9,
            strict_timestamps=True,
        ) as package:
            package.writestr(
                _deterministic_zip_info("archive-manifest.json"),
                manifest_bytes,
                compress_type=zipfile.ZIP_DEFLATED,
                compresslevel=9,
            )
            for path in sorted(content_by_path):
                package.writestr(
                    _deterministic_zip_info(path),
                    content_by_path[path],
                    compress_type=zipfile.ZIP_DEFLATED,
                    compresslevel=9,
                )
        output_path = _require_archive_project_path(
            project_root,
            output_path,
            label="archive package output",
            must_exist=False,
        )
        os.replace(temporary, output_path)
    finally:
        temporary.unlink(missing_ok=True)

    package_raw = output_path.read_bytes()
    # An upload can report knowledge_status=ready and still add nothing to the
    # platform when the package carries zero candidates. Counting them here is
    # what separates "server did not index" from "there was nothing to index".
    candidate_count = 0
    candidate_bytes = content_by_path.get("candidates/knowledge.json")
    if candidate_bytes is not None:
        try:
            parsed = json.loads(candidate_bytes)
            candidate_count = len(parsed) if isinstance(parsed, list) else 0
        except (json.JSONDecodeError, TypeError, ValueError):
            candidate_count = 0
    return {
        "schemaVersion": 1,
        "profile": "core-v1",
        "changeKey": change_key,
        "packagePath": str(output_path),
        "packageSha256": "sha256:" + hashlib.sha256(package_raw).hexdigest(),
        "manifestSha256": "sha256:" + hashlib.sha256(manifest_bytes).hexdigest(),
        "fileCount": len(entries),
        "sizeBytes": len(package_raw),
        "paths": [entry["path"] for entry in entries],
        "knowledgeCandidateCount": candidate_count,
    }


def remote_durable_archive_durability(
    current: Any, push_result: Mapping[str, Any]
) -> dict[str, Any] | None:
    """远端上传成功后的耐久性投影；未 durable 时返回 None。

    summary-data.json 在归档流程早期就以 ARCHIVED_LOCAL_ONLY 写盘，而 ZIP 上传在
    那之后才发生。此前上传成功只改内存里的 payload、还把对象覆盖成裸字符串，落盘
    报告从没跟着改——于是同一次归档，回执说 durable、报告说 local-only，平台和用户
    读到的是后者。这里保持对象形状并带上回执标识，供调用方同时更新 payload 与文件。
    """
    if str(push_result.get("archiveStatus") or "") != "durable":
        return None
    projected = dict(current) if isinstance(current, dict) else {}
    projected.update({
        "status": "ARCHIVED_REMOTE_DURABLE",
        # 已远端持久化：不再声称"只存在于本地、可能随工作区丢失"
        "risk": None,
        "archiveId": push_result.get("archiveId"),
        "uploadStatus": push_result.get("uploadStatus"),
        "knowledgeStatus": push_result.get("knowledgeStatus"),
    })
    return projected


def persist_archive_durability(summary_path: Path, durability: dict[str, Any]) -> bool:
    """把耐久性结论回写到已落盘的 summary，其余字段原样保留。

    summary-data.json 本就被排除在归档校验和覆盖之外（它在覆盖快照之后才写），
    所以这次回写不会破坏 manifest 对账。
    """
    try:
        summary = json.loads(Path(summary_path).read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return False
    if not isinstance(summary, dict):
        return False
    summary["archiveDurability"] = durability
    try:
        write_json(Path(summary_path), summary)
    except OSError:
        return False
    return True


def auto_push_managed_snapshot(project_root: Path) -> dict[str, Any]:
    """Best-effort upload of rules, Codebase Map and archive deliverables via remote sync.

    走 `harness-push`（remote-sync）而非 legacy `push`（proposal）。后者写的是
    project_files_current，不产生分支快照，平台的「分支文件」与「项目资料」两个视图
    都读不到；归档交付物在那条路上还会被 policy-never 全部跳过。
    """
    project_root = project_root.resolve()
    credentials = _resolve_archive_remote_credentials(project_root, os.environ)
    if not credentials["configured"]:
        return {
            "ok": False,
            "skipped": True,
            "reasonCode": "MANAGED_SNAPSHOT_CREDENTIALS_MISSING",
            "missingCredentials": credentials["missing"],
        }
    try:
        launcher = resolve_hunter_cli_command(project_root)
    except OSError as exc:
        return {
            "ok": False,
            "skipped": False,
            "reasonCode": "MANAGED_SNAPSHOT_UPLOAD_DEFERRED",
            "warning": f"项目规则与架构地图上传已延后：{exc}",
        }
    # 显式列出五个 scope 而非 `all`：含义固定，不随 `all` 的展开定义漂移。
    # branch_files 覆盖归档交付物（plans/spec/reports/docs），其余四个覆盖配置、
    # 规则、架构地图与指令入口。
    command = [
        *launcher,
        "harness-push",
        "--scope",
        "config,rules,architecture,instructions,branch_files",
        "--yes",
        "--non-interactive",
        "--json",
        "--server-url",
        str(credentials["serverUrl"]),
    ]
    if credentials["tokenEnv"] is not None:
        command.extend(["--token-env", str(credentials["tokenEnv"])])
    try:
        completed = subprocess.run(
            command,
            cwd=str(project_root),
            text=True,
            # 不指定 encoding 时中文 Windows 会按 cp936 解码 UTF-8，静默损坏 CLI
            # 的中文输出，并可能让下面的 json.loads 失败。
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=180,
            shell=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {
            "ok": False,
            "skipped": False,
            "reasonCode": "MANAGED_SNAPSHOT_UPLOAD_DEFERRED",
            "warning": f"项目规则与架构地图上传已延后：{exc}",
        }
    try:
        output = json.loads(completed.stdout)
    except (json.JSONDecodeError, TypeError):
        output = None
    if completed.returncode != 0 or not isinstance(output, dict):
        # 失败时丢掉 stdout/stderr 等于把线索一起丢了：plan/spec 与规则、架构地图
        # 全靠这条推送上平台，用户在平台上只会看到"东西没上去"，却无从查为什么。
        # 保留有界的诊断片段（push 本身拒绝上传 secret，这里再截断兜底）。
        detail = (completed.stderr or completed.stdout or "").strip()
        failure: dict[str, Any] = {
            "ok": False,
            "skipped": False,
            "exitCode": completed.returncode,
            "reasonCode": "MANAGED_SNAPSHOT_UPLOAD_FAILED",
            "detail": detail[-2_048:],
            "warning": (
                "项目规则与架构地图未能同步到平台（归档 plan/spec/report 也随这条推送上传）；"
                "归档不受影响，稍后可运行 npx hunter-harness harness-push "
                "--scope config,rules,architecture,instructions,branch_files "
                "--yes --non-interactive 重试。"
            ),
        }
        cli_code = output.get("code") or output.get("reason_code") if isinstance(output, dict) else None
        if isinstance(cli_code, str) and cli_code:
            failure["cliCode"] = cli_code
        return failure
    # harness-push 的回执用 summary.applied 计已落盘的操作数（legacy push 用 submitted）。
    summary = output.get("summary")
    applied = summary.get("applied", 0) if isinstance(summary, dict) else 0
    return {
        "ok": bool(output.get("ok", True)),
        "skipped": False,
        "projectId": output.get("project_id"),
        "submitted": applied if isinstance(applied, int) else 0,
        # 无变更时 harness-push 直接短路为 no_changes，不产生快照——即"仅在有更新时推送"。
        "unchanged": output.get("outcome") == "no_changes",
    }


def auto_push_archive_core(
    project_root: Path,
    archive_dir: Path,
    *,
    change_key: str | None = None,
    extra_entries: dict[str, tuple[str, str, bytes]] | None = None,
) -> dict[str, Any]:
    """Build and upload one deterministic core ZIP after finalize.

    The ZIP and its per-change receipt are always created before auth is
    evaluated. Failures become warnings so archive success is never rolled
    back by missing credentials or a remote outage.
    """
    project_root = project_root.resolve()
    effective_change_key = change_key or archive_dir.name
    try:
        package = build_archive_package(
            project_root,
            archive_dir,
            effective_change_key,
            extra_entries=extra_entries,
        )
    except (OSError, ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        return {
            "skipped": False,
            "ok": False,
            "reasonCode": "ARCHIVE_PACKAGE_BUILD_FAILED",
            "warning": f"核心归档 ZIP 生成失败：{exc}",
        }
    core_paths = list(package["paths"])
    package_path = Path(str(package["packagePath"]))
    try:
        pending_path = _require_archive_project_path(
            project_root,
            package_path.with_suffix(".upload.json"),
            label="archive upload receipt",
            must_exist=False,
        )
        remote_receipt_path = _require_archive_project_path(
            project_root,
            package_path.with_suffix(".remote.json"),
            label="durable archive receipt",
            must_exist=False,
        )
    except (OSError, ValueError) as exc:
        return {
            "skipped": False,
            "ok": False,
            "paths": core_paths,
            "packagePath": package["packagePath"],
            "packageSha256": package["packageSha256"],
            "reasonCode": "ARCHIVE_UPLOAD_RECEIPT_PATH_UNSAFE",
            "warning": f"归档上传回执路径不安全；已保留 ZIP：{exc}",
        }
    credentials = _resolve_archive_remote_credentials(project_root, os.environ)
    initial_reason_code = (
        "ARCHIVE_UPLOAD_PENDING"
        if credentials["configured"]
        else "ARCHIVE_UPLOAD_CREDENTIALS_MISSING"
    )
    pending: dict[str, Any] = {
        "schemaVersion": 1,
        "generatedAt": now_iso(),
        "updatedAt": now_iso(),
        "archiveDir": str(archive_dir),
        "changeKey": effective_change_key,
        "packagePath": package["packagePath"],
        "packageSha256": package["packageSha256"],
        "manifestSha256": package["manifestSha256"],
        "fileCount": package["fileCount"],
        "knowledgeCandidateCount": package["knowledgeCandidateCount"],
        "paths": core_paths,
        "uploadStatus": "pending",
        "reasonCode": initial_reason_code,
        "archiveStatus": None,
        "knowledgeStatus": None,
    }

    def persist_receipt(
        *,
        upload_status: str,
        reason_code: str | None,
        archive_status: str | None = None,
        knowledge_status: str | None = None,
        exit_code: int | None = None,
    ) -> None:
        pending.update(
            {
                "updatedAt": now_iso(),
                "uploadStatus": upload_status,
                "reasonCode": reason_code,
                "archiveStatus": archive_status,
                "knowledgeStatus": knowledge_status,
                "exitCode": exit_code,
            }
        )
        write_json(pending_path, pending)

    try:
        pending_path.parent.mkdir(parents=True, exist_ok=True)
        persist_receipt(
            upload_status="pending",
            reason_code=initial_reason_code,
        )
    except OSError as exc:
        return {
            "skipped": False,
            "ok": False,
            "paths": core_paths,
            "packagePath": package["packagePath"],
            "packageSha256": package["packageSha256"],
            "reasonCode": "ARCHIVE_UPLOAD_RECEIPT_WRITE_FAILED",
            "warning": f"无法写入归档上传回执：{exc}",
        }

    base_result: dict[str, Any] = {
        "skipped": False,
        "ok": False,
        "uploadStatus": "pending",
        "paths": core_paths,
        "packagePath": package["packagePath"],
        "packageSha256": package["packageSha256"],
        "manifestSha256": package["manifestSha256"],
        "fileCount": package["fileCount"],
        "sizeBytes": package["sizeBytes"],
        "knowledgeCandidateCount": package["knowledgeCandidateCount"],
        "pending": str(pending_path),
    }

    if not credentials["configured"]:
        reason_code = "ARCHIVE_UPLOAD_CREDENTIALS_MISSING"
        return {
            **base_result,
            "skipped": True,
            "reasonCode": reason_code,
            "missingCredentials": credentials["missing"],
            "reason": "未配置可用的远端地址或 API Token；已保留 ZIP 等待重试。",
        }

    # The published CLI owns credentials, project binding, durable receipt checks,
    # and retries. Generic `push` is intentionally not used for archive bytes.
    try:
        launcher = resolve_hunter_cli_command(project_root)
    except OSError as exc:
        reason_code = "ARCHIVE_UPLOAD_DEFERRED"
        try:
            persist_receipt(upload_status="pending", reason_code=reason_code)
        except OSError:
            pass
        return {
            **base_result,
            "reasonCode": reason_code,
            "warning": f"归档自动上传已延后：{exc}",
        }
    command = [
        *launcher,
        "archive",
        "upload",
        "--file",
        str(package["packagePath"]),
        "--change-key",
        effective_change_key,
        "--yes",
        "--non-interactive",
        "--json",
    ]
    command.extend(["--server-url", str(credentials["serverUrl"])])
    if credentials["tokenEnv"] is not None:
        command.extend(["--token-env", str(credentials["tokenEnv"])])
    try:
        completed = subprocess.run(
            command,
            cwd=str(project_root),
            text=True,
            # 不指定 encoding 时中文 Windows 按 cp936 解码 UTF-8，
            # CLI 的中文回执会被损坏，随后的 json.loads 也可能失败。
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=180,
            shell=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        reason_code = "ARCHIVE_UPLOAD_DEFERRED"
        try:
            persist_receipt(upload_status="pending", reason_code=reason_code)
        except OSError:
            pass
        return {
            **base_result,
            "reasonCode": reason_code,
            "warning": f"归档自动上传已延后：{exc}",
        }

    try:
        cli_payload = json.loads(completed.stdout)
    except (json.JSONDecodeError, TypeError):
        cli_payload = None
    if completed.returncode != 0:
        reason_code = "ARCHIVE_UPLOAD_COMMAND_FAILED"
        if isinstance(cli_payload, dict):
            errors = cli_payload.get("errors")
            if isinstance(errors, list) and errors and isinstance(errors[0], dict):
                cli_code = errors[0].get("code")
                if (
                    isinstance(cli_code, str)
                    and re.fullmatch(r"[A-Z][A-Z0-9_]{0,79}", cli_code.strip())
                    is not None
                ):
                    reason_code = cli_code.strip()
        try:
            persist_receipt(
                upload_status="pending",
                reason_code=reason_code,
                exit_code=completed.returncode,
            )
        except OSError:
            pass
        result = {
            **base_result,
            "exitCode": completed.returncode,
            "reasonCode": reason_code,
            "warning": (
                f"归档自动上传失败（退出码 {completed.returncode}）；"
                "已保留 ZIP 与回执，可重试同一个包。"
            ),
        }
        if completed.stderr.strip():
            result["stderr"] = completed.stderr.strip()[:500]
        return result

    if not isinstance(cli_payload, dict):
        reason_code = "ARCHIVE_UPLOAD_RECEIPT_INVALID"
        try:
            persist_receipt(
                upload_status="pending",
                reason_code=reason_code,
                exit_code=completed.returncode,
            )
        except OSError:
            pass
        return {
            **base_result,
            "exitCode": completed.returncode,
            "reasonCode": reason_code,
            "warning": "归档上传命令未返回可核验的 JSON 收据；已保留 ZIP 与回执。",
        }

    archive_status = cli_payload.get("archive_status")
    knowledge_status = cli_payload.get("knowledge_status")
    if archive_status != "durable" or knowledge_status not in {
        "indexing",
        "ready",
        "failed",
    }:
        reason_code = "ARCHIVE_UPLOAD_RECEIPT_INVALID"
        try:
            persist_receipt(
                upload_status="pending",
                reason_code=reason_code,
                archive_status=(
                    archive_status if isinstance(archive_status, str) else None
                ),
                knowledge_status=(
                    knowledge_status if isinstance(knowledge_status, str) else None
                ),
                exit_code=completed.returncode,
            )
        except OSError:
            pass
        return {
            **base_result,
            "exitCode": completed.returncode,
            "reasonCode": reason_code,
            "warning": "归档上传收据缺少有效的耐久或知识状态；已保留 ZIP 与回执。",
        }

    fully_ready = archive_status == "durable" and knowledge_status == "ready"
    if fully_ready:
        upload_status = "ready"
        reason_code = None
    elif knowledge_status == "failed":
        upload_status = "failed"
        reason_code = "ARCHIVE_KNOWLEDGE_INDEX_FAILED"
    else:
        upload_status = "pending"
        reason_code = "ARCHIVE_KNOWLEDGE_INDEXING"
    durable_receipt = {
        "schemaVersion": 1,
        "recordedAt": now_iso(),
        "changeKey": effective_change_key,
        "archiveId": cli_payload.get("archive_id"),
        "archiveStatus": archive_status,
        "knowledgeStatus": knowledge_status,
        "uploadStatus": upload_status,
        "packageSha256": package["packageSha256"],
        "manifestSha256": package["manifestSha256"],
        "fileCount": package["fileCount"],
    }
    try:
        remote_receipt_path.parent.mkdir(parents=True, exist_ok=True)
        write_json(remote_receipt_path, durable_receipt)
    except OSError as exc:
        try:
            persist_receipt(
                upload_status=upload_status,
                reason_code="ARCHIVE_DURABLE_RECEIPT_WRITE_FAILED",
                archive_status=archive_status,
                knowledge_status=knowledge_status,
                exit_code=completed.returncode,
            )
        except OSError:
            pass
        return {
            **base_result,
            "ok": True,
            "uploadStatus": upload_status,
            "archiveId": cli_payload.get("archive_id"),
            "archiveStatus": archive_status,
            "knowledgeStatus": knowledge_status,
            "reasonCode": "ARCHIVE_DURABLE_RECEIPT_WRITE_FAILED",
            "warning": (
                "服务端归档已持久化，但无法写入本地归档状态回执；"
                f"已保留重试文件：{exc}"
            ),
        }
    try:
        persist_receipt(
            upload_status=upload_status,
            reason_code=reason_code,
            archive_status=archive_status,
            knowledge_status=knowledge_status,
            exit_code=completed.returncode,
        )
    except OSError as exc:
        return {
            **base_result,
            "archiveId": cli_payload.get("archive_id"),
            "archiveStatus": archive_status,
            "knowledgeStatus": knowledge_status,
            "reasonCode": "ARCHIVE_UPLOAD_RECEIPT_WRITE_FAILED",
            "warning": f"服务端已返回状态，但本地上传回执更新失败：{exc}",
        }

    result = {
        **base_result,
        "ok": True,
        "uploadStatus": upload_status,
        "exitCode": completed.returncode,
        "archiveId": cli_payload.get("archive_id"),
        "archiveStatus": archive_status,
        "knowledgeStatus": knowledge_status,
        "reasonCode": reason_code,
        "remoteReceipt": str(remote_receipt_path),
    }
    if fully_ready:
        cleanup_warnings: list[str] = []
        for path in (package_path, pending_path):
            try:
                path.unlink(missing_ok=True)
            except OSError as exc:
                cleanup_warnings.append(f"{path.name}: {exc}")
        if cleanup_warnings:
            result["warning"] = (
                "远端归档与知识均已就绪，但本地重试文件清理不完整："
                + "; ".join(cleanup_warnings)
            )
    elif knowledge_status == "failed":
        result["warning"] = (
            "归档原包已在服务端持久化，但知识索引失败；"
            "已保留 ZIP 与上传回执，可重试同一个 ZIP。"
        )
    else:
        result["warning"] = (
            "归档原包已在服务端持久化，知识索引仍在进行；"
            "已保留 ZIP 与上传回执，可枚举后重试。"
        )
    return result


def _knowledge_maintenance_from_archive_push(push_result: dict[str, Any]) -> str:
    if (
        push_result.get("archiveStatus") == "durable"
        and push_result.get("knowledgeStatus") == "ready"
    ):
        return "REMOTE_READY"
    if push_result.get("knowledgeStatus") == "failed":
        return "REMOTE_INDEX_FAILED"
    return "REMOTE_PENDING"


def _merge_runtime_state(state_dir: Path, contract_dir: Path) -> None:
    """Materialize split-v1 dynamic state into the archive contract tree."""
    for source in sorted(state_dir.iterdir()):
        target = contract_dir / source.name
        if source.is_dir():
            shutil.copytree(source, target, dirs_exist_ok=True, copy_function=shutil.copy2)
        elif source.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)


def _restore_on_failure(
    archive_dir: Path,
    original_change_dir: Path,
    payload: dict[str, Any],
    warnings: list[str],
) -> None:
    """Move archive back to changes path so validate errors never lose the original."""
    if original_change_dir.exists():
        # Already present (e.g. move never happened)
        payload["original_preserved"] = True
        # Clean partial archive if present and distinct
        if archive_dir.exists() and archive_dir.resolve() != original_change_dir.resolve():
            warnings.append(
                f"partial archive left at {archive_dir} (original also present)"
            )
        return
    if not archive_dir.exists():
        payload["original_preserved"] = False
        warnings.append("restore failed: neither archive nor original exists")
        return
    try:
        original_change_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(archive_dir), str(original_change_dir))
        payload["original_preserved"] = True
        payload["restored_to"] = str(original_change_dir)
    except OSError as exc:
        payload["original_preserved"] = False
        warnings.append(f"restore move failed: {exc}; data at {archive_dir}")


# ---------------------------------------------------------------------------
# replay
# ---------------------------------------------------------------------------


def cmd_replay(
    archive_dir: Path,
    *,
    out_path: Path | None = None,
) -> tuple[int, dict[str, Any]]:
    """Read-only collect + validate. Never mutates archive contents."""
    archive_dir = archive_dir.resolve()
    if not archive_dir.is_dir():
        return 1, {"ok": False, "error": f"archive dir not found: {archive_dir}"}

    # Collect without writing into the archive
    summary = collect_summary_data(archive_dir, write=False, for_replay=True)

    validate_result = validate_summary_data(summary)
    summary.setdefault("reportPipeline", {})["validationIssues"] = (
        validate_result.get("issues") or []
    )

    if out_path is not None:
        # Allowed to write outside the archive
        out_resolved = out_path.resolve()
        try:
            out_resolved.relative_to(archive_dir.resolve())
            inside = True
        except ValueError:
            inside = False
        if inside:
            return 1, {
                "ok": False,
                "error": "replay refuses to write inside archive dir (read-only)",
            }
        write_json(out_resolved, summary)

    payload = {
        "ok": validate_result.get("ok", False),
        "action": "replay",
        "archive_dir": str(archive_dir),
        "change_name": summary.get("changeName"),
        "summary_data": summary,
        "validate": validate_result,
        "sources": (summary.get("reportPipeline") or {}).get("sources") or [],
    }
    # Replay itself is successful as an operation even if validate finds issues;
    # exit non-zero only on hard failures. Soft: ok mirrors validate.
    return (0 if payload["ok"] else 1), payload


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def cmd_status_cli(args: argparse.Namespace) -> int:
    change_dir = resolve_path(args.change_dir)
    result = check_status(
        change_dir,
        allow_missing_review=bool(getattr(args, "allow_missing_review", False)),
        archive_intent=str(getattr(args, "intent", "release-candidate")),
        closure_disposition=str(getattr(args, "closure", "completed")),
        closure_reason=str(getattr(args, "closure_reason", "")),
    )
    emit_json(result)
    # Checks completed → exit 0; archivable flag conveys the gate result.
    return 0 if result.get("ok") else 1


def cmd_auto_gate_cli(args: argparse.Namespace) -> int:
    result = archive_auto_gate(
        resolve_path(args.change_dir),
        allow_missing_review=bool(getattr(args, "allow_missing_review", False)),
        archive_intent=str(getattr(args, "intent", "release-candidate")),
        closure_disposition=str(getattr(args, "closure", "completed")),
        closure_reason=str(getattr(args, "closure_reason", "")),
    )
    emit_json(result)
    return 0 if result.get("ok") else 1


def cmd_adopt_existing_range_cli(args: argparse.Namespace) -> int:
    result = adopt_existing_range(
        resolve_path(args.change_dir),
        base=str(args.base),
        tip=str(args.tip),
        reason=str(args.reason),
        confirmed=bool(getattr(args, "confirm_existing_range", False)),
    )
    emit_json(result)
    return 0 if result.get("ok") else 1


def cmd_certify_local_cli(args: argparse.Namespace) -> int:
    change_dir = resolve_path(args.change_dir)
    project = (
        resolve_path(args.project)
        if getattr(args, "project", None)
        else None
    )
    try:
        receipt = certify_local_candidate(change_dir, project=project)
    except (OSError, ValueError) as exc:
        emit_json(
            {
                "ok": False,
                "action": "certify-local",
                "error": str(exc),
            }
        )
        return 1
    emit_json(
        {
            "ok": True,
            "action": "certify-local",
            "evidence": receipt,
            "path": str(
                change_dir
                / "evidence"
                / "product-candidate-verification.json"
            ),
        }
    )
    return 0


def cmd_finalize_cli(args: argparse.Namespace) -> int:
    change_dir = resolve_path(args.change_dir)
    archive_root = resolve_path(args.archive_root)
    durable_root = (
        resolve_path(args.durable_root)
        if getattr(args, "durable_root", None)
        else None
    )
    code, payload = cmd_finalize(
        change_dir,
        archive_root,
        durable_root=durable_root,
        retention_policy=str(
            getattr(args, "retention_policy", "unspecified")
        ),
        skip_ingest=bool(args.skip_ingest),
        allow_missing_review=bool(getattr(args, "allow_missing_review", False)),
        archive_intent=str(getattr(args, "intent", "release-candidate")),
        closure_disposition=str(getattr(args, "closure", "completed")),
        closure_reason=str(getattr(args, "closure_reason", "")),
    )
    emit_json(payload)
    return code


def cmd_execute_cli(args: argparse.Namespace) -> int:
    durable_root = (
        resolve_path(args.durable_root)
        if getattr(args, "durable_root", None)
        else None
    )
    code, payload = execute_archive(
        resolve_path(args.change_dir),
        resolve_path(args.archive_root),
        durable_root=durable_root,
        retention_policy=str(
            getattr(args, "retention_policy", "unspecified")
        ),
        skip_ingest=bool(args.skip_ingest),
        allow_missing_review=bool(getattr(args, "allow_missing_review", False)),
        archive_intent=str(getattr(args, "intent", "release-candidate")),
        closure_disposition=str(getattr(args, "closure", "completed")),
        closure_reason=str(getattr(args, "closure_reason", "")),
    )
    emit_json(payload)
    return code


def cmd_restore_durable_cli(args: argparse.Namespace) -> int:
    receipt_path = resolve_path(args.receipt)
    target_root = resolve_path(args.target_root)
    try:
        payload = restore_durable_archive(receipt_path, target_root)
        code = 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        code = 1
        payload = {
            "ok": False,
            "action": "restore-durable",
            "receipt": str(receipt_path),
            "targetRoot": str(target_root),
            "error": str(exc),
        }
    emit_json(payload)
    return code


def cmd_replay_cli(args: argparse.Namespace) -> int:
    archive_dir = resolve_path(args.archive_dir)
    out_path = resolve_path(args.out) if getattr(args, "out", None) else None
    code, payload = cmd_replay(archive_dir, out_path=out_path)
    emit_json(payload)
    return code


def cmd_repair(archive_dir: Path) -> tuple[int, dict[str, Any]]:
    """Versioned repair (task 11 / RET-40).

    Re-collect a candidate from the frozen sources, validate its source and
    canonical data, then write an immutable ``derived/v<N>/`` plus a repair
    record. The original summary and manifest are never overwritten.
    """
    payload: dict[str, Any] = {
        "ok": False,
        "action": "repair",
        "archive_dir": str(archive_dir),
    }
    if not archive_dir.is_dir():
        payload["error"] = f"archive dir not found: {archive_dir}"
        return 1, payload
    summary_path = archive_dir / "reports" / "final" / "summary-data.json"
    if not summary_path.is_file():
        payload["error"] = "summary-data.json missing; cannot repair"
        return 1, payload
    frozen_manifest_paths = {
        name: archive_dir / "evidence" / name
        for name in (
            "archive-manifest-before.json",
            "archive-manifest-after.json",
        )
    }
    missing_manifests = [
        name for name, path in frozen_manifest_paths.items() if not path.is_file()
    ]
    if missing_manifests:
        payload["error"] = (
            "frozen manifests missing; cannot repair: " + ", ".join(missing_manifests)
        )
        return 1, payload

    # 1. candidate: fresh collect from frozen sources (read-only on archive).
    try:
        candidate = collect_summary_data(archive_dir, write=False, for_replay=False)
    except Exception as exc:  # noqa: BLE001
        payload["error"] = f"repair collect failed: {exc}"
        return 1, payload

    # 2. stage outside the archive; validate canonical data only.
    staging = Path(tempfile.mkdtemp(prefix="harness-repair-"))
    try:
        staged_summary = staging / "summary-data.json"
        write_json(staged_summary, candidate)
        source_result = validate_source_consistency(archive_dir, candidate)
        summary_result = validate_summary_data(candidate)
        payload["validators"] = {
            "source": source_result,
            "summary": summary_result,
        }
        if not (source_result.get("ok") and summary_result.get("ok")):
            payload["error"] = "repair validators failed; derived version not written"
            return 1, payload

        # 3. immutable derived version.
        derived = archive_dir / "derived"
        derived.mkdir(exist_ok=True)
        existing = [
            int(p.name[1:])
            for p in derived.iterdir()
            if p.is_dir() and p.name.startswith("v") and p.name[1:].isdigit()
        ]
        version = f"v{(max(existing) + 1) if existing else 1}"
        version_dir = derived / version
        staged_version_dir = staging / version
        staged_version_dir.mkdir()
        final_summary = staged_version_dir / "summary-data.json"
        write_json(final_summary, candidate)
        frozen_manifest_hashes: dict[str, str] = {}
        for manifest_name, source_manifest in frozen_manifest_paths.items():
            target_manifest = staged_version_dir / manifest_name
            shutil.copy2(source_manifest, target_manifest)
            frozen_manifest_hashes[manifest_name] = "sha256:" + sha256_file(target_manifest)
        record = {
            "version": version,
            "createdAt": now_iso(),
            "summarySha256": "sha256:" + hashlib.sha256(final_summary.read_bytes()).hexdigest(),
            "baseSummarySha256": "sha256:" + hashlib.sha256(summary_path.read_bytes()).hexdigest(),
            "frozenManifestHashes": frozen_manifest_hashes,
            "validators": {
                "source": {"ok": bool(source_result.get("ok")), "issues": source_result.get("issues") or []},
                "summary": {"ok": bool(summary_result.get("ok")), "issues": summary_result.get("issues") or []},
            },
        }
        write_json(staged_version_dir / "repair-record.json", record)
        shutil.move(str(staged_version_dir), str(version_dir))

        # 4. authoritative pointer — only after both validators passed.
        write_json(
            derived / "authoritative.json",
            {
                "version": version,
                "summarySha256": record["summarySha256"],
                "updatedAt": record["createdAt"],
            },
        )
        payload["ok"] = True
        payload["version"] = version
        payload["derived_dir"] = str(version_dir)
        return 0, payload
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def cmd_repair_cli(args: argparse.Namespace) -> int:
    archive_dir = resolve_path(args.archive_dir)
    code, payload = cmd_repair(archive_dir)
    emit_json(payload)
    return code


def resolve_republish_project_root(explicit: Path | None, archive_dir: Path | None) -> Path:
    """Locate the project root for a republish without requiring --project.

    ``find_project_root`` walks ``p.parents``, which excludes ``p`` itself; it is
    built for a change/archive subdirectory. Handing it the cwd therefore skips
    the very directory the operator is standing in and keeps climbing — in a real
    run that resolved ``E:/WorkProject/kb-sdd`` to its parent and made the command
    look for archives that were never there.

    Order: explicit flag, then the archive's own location, then cwd and its
    parents (cwd included), then the deployed script's location — the script
    lives at ``<project>/.claude|.codebuddy/skills/scripts/`` after install.
    """
    if explicit is not None:
        return explicit.resolve()
    if archive_dir is not None:
        return find_project_root(archive_dir)

    def first_with_archive(start: Path) -> Path | None:
        start = start.resolve()
        for candidate in (start, *start.parents):
            if (candidate / ".harness" / "archive").is_dir():
                return candidate
        return None

    found = first_with_archive(Path.cwd())
    if found is not None:
        return found
    found = first_with_archive(Path(__file__).resolve().parent)
    if found is not None:
        return found
    # Nothing carries an archive directory; report against cwd so the error names
    # a path the operator recognises instead of some ancestor.
    return Path.cwd().resolve()


def resolve_archive_dir_for_change(
    project_root: Path,
    change_key: str,
) -> tuple[Path | None, list[str]]:
    """Locate the sealed archive directory for a change key.

    Directories are named ``<YYYY-MM-DD>-<change-key>``; older layouts use the
    bare key. Returns the newest match plus every candidate name so an ambiguous
    key is reported rather than silently resolved.
    """
    archive_root = project_root / ".harness" / "archive"
    if not archive_root.is_dir():
        return None, []
    matches = sorted(
        entry.name
        for entry in archive_root.iterdir()
        if entry.is_dir()
        and (entry.name == change_key or entry.name.endswith(f"-{change_key}"))
    )
    if not matches:
        return None, []
    return archive_root / matches[-1], matches


def _republish_knowledge_entry(archive_dir: Path) -> dict[str, tuple[str, str, bytes]]:
    """Knowledge candidates for archives sealed before the candidates step.

    Generated in memory only. The archive directory is sealed: its after-manifest
    covers every byte in it, so writing a new file there would break byte
    coverage for every later reader.
    """
    if (archive_dir / "candidates" / "knowledge.json").is_file():
        return {}
    summary_path = archive_dir / "reports" / "final" / "summary-data.json"
    summary = read_json(summary_path)
    candidates = hkc.build_knowledge_candidates(
        summary,
        change_key=str(summary.get("changeName") or archive_dir.name),
        archive_id=archive_dir.name,
        producer_version=SCHEMA_VERSION,
        # Derived from the archive, never wall-clock: `now_iso()` here made every
        # rebuild produce different bytes, so a package could never be compared
        # against a stored one and the "deterministic package" claim was false.
        created_at=_archive_created_at(summary_path),
    )
    if not candidates:
        return {}
    return {
        "candidates/knowledge.json": (
            "knowledge_candidates",
            "application/json",
            hkc.render_knowledge_candidates_json(candidates).encode("utf-8"),
        )
    }


def read_durable_archive_receipt(project_root: Path, change_key: str) -> dict[str, Any] | None:
    """The `<key>.remote.json` written after a confirmed durable upload, if any."""
    receipt_path = (
        project_root / ".harness" / "state" / "local" / "archive-packages"
        / f"{change_key}.remote.json"
    )
    if not receipt_path.is_file():
        return None
    try:
        receipt = read_json(receipt_path)
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return None
    return receipt if isinstance(receipt, dict) else None


def cmd_republish(
    *,
    change_key: str,
    archive_dir: Path | None,
    project_root: Path | None,
    dry_run: bool,
    inject_knowledge: bool = True,
) -> tuple[int, dict[str, Any]]:
    """Rebuild and re-upload the core ZIP for an already sealed archive.

    The normal publish path deletes the ZIP and its receipt once the server
    reports durable+ready, and archives produced before the outbox existed never
    had one, so nothing is left to retry from. Rebuilding from the sealed
    directory is the only route that can re-deliver an archive, and it is also
    how archives sealed before knowledge candidates existed get them.
    """
    payload: dict[str, Any] = {
        "ok": False,
        "action": "republish",
        "changeKey": change_key,
        "dryRun": dry_run,
    }
    if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,159}", change_key) is None:
        payload["error"] = "change key must be a portable path segment"
        payload["reasonCode"] = "ARCHIVE_CHANGE_KEY_INVALID"
        return 2, payload

    root = resolve_republish_project_root(project_root, archive_dir)
    payload["projectRoot"] = str(root)
    matches: list[str] = []
    if archive_dir is None:
        archive_dir, matches = resolve_archive_dir_for_change(root, change_key)
        payload["matchedArchives"] = matches
    if archive_dir is None or not archive_dir.is_dir():
        payload["error"] = (
            f"no archive directory for change key {change_key} under "
            f"{root / '.harness' / 'archive'}"
        )
        payload["reasonCode"] = "ARCHIVE_DIR_NOT_FOUND"
        return 1, payload
    archive_dir = archive_dir.resolve()
    payload["archiveDir"] = str(archive_dir)
    if len(matches) > 1:
        payload["warning"] = (
            "多个归档目录匹配该 change key，已选用最新的一个："
            + ", ".join(matches)
        )

    summary_path = archive_dir / "reports" / "final" / "summary-data.json"
    if not summary_path.is_file():
        payload["error"] = f"archive final summary-data.json missing: {summary_path}"
        payload["reasonCode"] = "ARCHIVE_SUMMARY_MISSING"
        return 1, payload

    extra_entries: dict[str, tuple[str, str, bytes]] = {}
    if inject_knowledge:
        try:
            extra_entries = _republish_knowledge_entry(archive_dir)
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            # Knowledge is additive: never fail a re-delivery over it.
            payload.setdefault("warnings", []).append(
                f"knowledge candidate regeneration skipped: {exc}"
            )
            extra_entries = {}
    payload["knowledgeCandidatesInjected"] = "candidates/knowledge.json" in extra_entries

    # Build once, into a preview path, so the bytes can be compared against any
    # durable receipt before an upload is attempted. The builder refuses to write
    # outside the project, so the preview lands beside the real packages under a
    # distinct name; it must never be mistaken for a pending upload.
    preview_path = (
        root / ".harness" / "state" / "local" / "archive-packages"
        / f"{change_key}.preview.zip"
    )
    try:
        package = build_archive_package(
            root,
            archive_dir,
            change_key,
            output_path=preview_path,
            extra_entries=extra_entries,
        )
    except (OSError, ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        payload["error"] = f"archive package build failed: {exc}"
        payload["reasonCode"] = "ARCHIVE_PACKAGE_BUILD_FAILED"
        return 1, payload
    finally:
        try:
            preview_path.unlink(missing_ok=True)
        except OSError:
            pass

    payload.update(
        {
            "fileCount": package["fileCount"],
            "sizeBytes": package["sizeBytes"],
            "knowledgeCandidateCount": package["knowledgeCandidateCount"],
            "packageSha256": package["packageSha256"],
            "manifestSha256": package["manifestSha256"],
            "files": package["paths"],
        }
    )

    # The platform stores exactly one immutable package per change key. A rebuild
    # that differs by even one byte is refused server-side, so decide here rather
    # than spending an upload to learn it.
    durable = read_durable_archive_receipt(root, change_key)
    stored_sha = str((durable or {}).get("packageSha256") or "")
    if durable is not None and str(durable.get("archiveStatus") or "") == "durable":
        payload["remoteReceipt"] = {
            "archiveId": durable.get("archiveId"),
            "archiveStatus": durable.get("archiveStatus"),
            "knowledgeStatus": durable.get("knowledgeStatus"),
            "packageSha256": stored_sha,
            "recordedAt": durable.get("recordedAt"),
        }
        if stored_sha and stored_sha == package["packageSha256"]:
            payload.update({
                "ok": True,
                "reasonCode": "ARCHIVE_ALREADY_PUBLISHED",
                "message": (
                    "远端已存有字节一致的同一个包，无需重传"
                    f"（archiveId={durable.get('archiveId')}）。"
                ),
            })
            return 0, payload
        payload.update({
            "ok": False,
            "reasonCode": "ARCHIVE_REMOTE_IMMUTABLE_CONFLICT",
            "error": (
                "该 change 在远端已是 durable 归档，服务端对同一 change key 只保存一个"
                "不可变包，不接受不同字节的替换。"
            ),
            "nextAction": (
                "补传只适用于『从未成功上传』或『字节完全一致的重试』。"
                + (
                    "本次重建注入了 "
                    f"{package['knowledgeCandidateCount']} 条知识候选"
                    "（原包上传时还没有 candidates/knowledge.json），因此字节必然不同——"
                    "已发布归档无法从客户端追加知识条目，需要平台侧提供重新索引或归档版本化能力。"
                    "若只是想重试同一个包（例如知识索引失败），加 --no-knowledge-injection "
                    "可重建与封存目录完全一致的字节。"
                    if payload.get("knowledgeCandidatesInjected")
                    else "本地归档内容与已上传的包不一致，请先确认哪一份才是应保留的事实。"
                )
            ),
        })
        return 1, payload

    if dry_run:
        payload.update({"ok": True, "reasonCode": "ARCHIVE_REPUBLISH_PREVIEW"})
        return 0, payload

    result = auto_push_archive_core(
        root,
        archive_dir,
        change_key=change_key,
        extra_entries=extra_entries,
    )
    payload["push"] = result
    payload["ok"] = bool(result.get("ok"))
    payload["reasonCode"] = result.get("reasonCode")
    if result.get("warning"):
        payload.setdefault("warnings", []).append(str(result["warning"]))
    return 0 if payload["ok"] else 1, payload


def cmd_republish_cli(args: argparse.Namespace) -> int:
    code, payload = cmd_republish(
        change_key=str(args.change).strip(),
        archive_dir=resolve_path(args.archive_dir) if args.archive_dir else None,
        project_root=resolve_path(args.project) if args.project else None,
        dry_run=bool(args.dry_run),
        inject_knowledge=not bool(args.no_knowledge_injection),
    )
    emit_json(payload)
    return code


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="harness_archive.py",
        description="Archive finalize / status / replay (D3)",
    )
    sub = parser.add_subparsers(dest="command_name", required=True)

    p_status = sub.add_parser("status", help="pre-archive gate checks (read-only)")
    p_status.add_argument("--change-dir", required=True)
    p_status.add_argument("--json", action="store_true", default=True)
    p_status.add_argument(
        "--allow-missing-review",
        action="store_true",
        help="downgrade full-tier missing review from blocker to warning",
    )
    p_status.add_argument(
        "--closure",
        choices=("completed", "abandoned", "superseded"),
        default="completed",
        help="lifecycle outcome, independent from release intent",
    )
    p_status.add_argument("--closure-reason", default="")
    p_status.add_argument(
        "--intent",
        choices=("release-candidate", "record-only"),
        default="release-candidate",
        help="release-candidate enforces candidate evidence; record-only archives facts without release eligibility",
    )
    p_status.set_defaults(func=cmd_status_cli)

    p_auto_gate = sub.add_parser(
        "auto-gate",
        help="read-only proof that a post-submit/merge archive may run without confirmation",
    )
    p_auto_gate.add_argument("--change-dir", required=True)
    p_auto_gate.add_argument("--json", action="store_true", default=True)
    p_auto_gate.add_argument(
        "--allow-missing-review",
        action="store_true",
        help="downgrade full-tier missing review from blocker to warning",
    )
    p_auto_gate.add_argument(
        "--intent",
        choices=("release-candidate", "record-only"),
        default="release-candidate",
    )
    p_auto_gate.add_argument(
        "--closure",
        choices=("completed", "abandoned", "superseded"),
        default="completed",
    )
    p_auto_gate.add_argument("--closure-reason", default="")
    p_auto_gate.set_defaults(func=cmd_auto_gate_cli)

    p_adopt = sub.add_parser(
        "adopt-existing-range",
        help="explicitly bind an already committed product range to this change",
    )
    p_adopt.add_argument("--change-dir", required=True)
    p_adopt.add_argument("--base", required=True)
    p_adopt.add_argument("--tip", required=True)
    p_adopt.add_argument("--reason", required=True)
    p_adopt.add_argument("--confirm-existing-range", action="store_true")
    p_adopt.add_argument("--json", action="store_true", default=True)
    p_adopt.set_defaults(func=cmd_adopt_existing_range_cli)

    p_cert = sub.add_parser(
        "certify-local",
        help="create candidate receipt from existing full ledger evidence without rerunning tests",
    )
    p_cert.add_argument("--change-dir", required=True)
    p_cert.add_argument("--project", default=None)
    p_cert.add_argument("--json", action="store_true", default=True)
    p_cert.set_defaults(func=cmd_certify_local_cli)

    p_fin = sub.add_parser("finalize", help="single-process archive finalize")
    p_fin.add_argument("--change-dir", required=True)
    p_fin.add_argument("--archive-root", required=True)
    p_fin.add_argument(
        "--durable-root",
        default=None,
        help=(
            "independent content-addressed archive store; it must be outside "
            "the project and is verified before source deletion"
        ),
    )
    p_fin.add_argument(
        "--closure",
        choices=("completed", "abandoned", "superseded"),
        default="completed",
        help="lifecycle outcome, independent from release intent",
    )
    p_fin.add_argument("--closure-reason", default="")
    p_fin.add_argument(
        "--retention-policy",
        default="unspecified",
        help="retention policy recorded in the durable archive receipt",
    )
    p_fin.add_argument("--skip-ingest", action="store_true")
    p_fin.add_argument(
        "--allow-missing-review",
        action="store_true",
        help="record override when full-tier review evidence is missing",
    )
    p_fin.add_argument(
        "--intent",
        choices=("release-candidate", "record-only"),
        default="release-candidate",
        help="release-candidate enforces candidate evidence; record-only archives facts without release eligibility",
    )
    p_fin.add_argument("--json", action="store_true", default=True)
    p_fin.set_defaults(func=cmd_finalize_cli)

    p_execute = sub.add_parser(
        "execute",
        help="run one archive preflight, boundary gate, finalize, ZIP, and upload flow",
    )
    p_execute.add_argument("--change-dir", required=True)
    p_execute.add_argument("--archive-root", required=True)
    p_execute.add_argument("--durable-root", default=None)
    p_execute.add_argument(
        "--closure",
        choices=("completed", "abandoned", "superseded"),
        default="completed",
    )
    p_execute.add_argument("--closure-reason", default="")
    p_execute.add_argument("--retention-policy", default="unspecified")
    p_execute.add_argument("--skip-ingest", action="store_true")
    p_execute.add_argument("--allow-missing-review", action="store_true")
    p_execute.add_argument(
        "--intent",
        choices=("release-candidate", "record-only"),
        default="release-candidate",
    )
    p_execute.add_argument("--json", action="store_true", default=True)
    p_execute.set_defaults(func=cmd_execute_cli)

    p_restore = sub.add_parser(
        "restore-durable",
        help="verify a durable receipt and restore its archive without overwriting",
    )
    p_restore.add_argument("--receipt", required=True)
    p_restore.add_argument("--target-root", required=True)
    p_restore.add_argument("--json", action="store_true", default=True)
    p_restore.set_defaults(func=cmd_restore_durable_cli)

    p_rep = sub.add_parser("replay", help="read-only re-collect + validate")
    p_rep.add_argument("--archive-dir", required=True)
    p_rep.add_argument("--out", default=None, help="write summary-data JSON outside archive")
    p_rep.add_argument("--json", action="store_true", default=True)
    p_rep.set_defaults(func=cmd_replay_cli)

    p_repair = sub.add_parser(
        "repair", help="versioned repair: validated derived version, original untouched"
    )
    p_repair.add_argument("--archive-dir", required=True)
    p_repair.add_argument("--json", action="store_true", default=True)
    p_repair.set_defaults(func=cmd_repair_cli)

    p_republish = sub.add_parser(
        "republish",
        help=(
            "rebuild and re-upload the core ZIP for an already sealed archive "
            "(the normal path deletes the ZIP once the server confirms it)"
        ),
    )
    p_republish.add_argument("--change", required=True, help="change key")
    p_republish.add_argument(
        "--archive-dir",
        default=None,
        help="explicit archive directory; resolved from --change when omitted",
    )
    p_republish.add_argument("--project", default=None)
    p_republish.add_argument(
        "--dry-run",
        action="store_true",
        help="build the package and report its contents without uploading",
    )
    p_republish.add_argument(
        "--no-knowledge-injection",
        action="store_true",
        help=(
            "rebuild exactly what the sealed archive holds; needed to retry the "
            "same bytes the server already stored"
        ),
    )
    p_republish.add_argument("--json", action="store_true", default=True)
    p_republish.set_defaults(func=cmd_republish_cli)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
