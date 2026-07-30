#!/usr/bin/env python3
"""Harness archive finalize / status / replay (D3).

Subcommands:
  status   — pre-archive gate checks (read-only)
  finalize — single-process archive: manifest → move → collect → render →
             validate → after-manifest → delete-or-keep → knowledge/service
  replay   — read-only re-collect + validate for historical archives

Python 3.10+, stdlib only. UTF-8 without BOM. Windows path safe.
Depends on P0-1 harness_events.py; optionally P0-3 harness_knowledge.py.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import uuid
from pathlib import Path
from typing import Any


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


SCRIPTS_DIR = Path(__file__).resolve().parent
SKILLS_ROOT = SCRIPTS_DIR.parent
RENDER_SCRIPT = SKILLS_ROOT / "harness-archive" / "templates" / "render-summary.mjs"
SUMMARY_TEMPLATE = (
    SKILLS_ROOT / "harness-archive" / "templates" / "summary-data-template.json"
)
KNOWLEDGE_SCRIPT = (
    SKILLS_ROOT / "harness-knowledge-ingest" / "scripts" / "harness_knowledge.py"
)
SERVICE_SCRIPT = SCRIPTS_DIR / "harness_service.py"

# Manifest compare must ignore self-mutating log files appended during finalize.
MANIFEST_COMPARE_EXCLUDE = frozenset(
    {
        "logs/execution-log.md",
        "execution-log.md",
        "events.ndjson",
    }
)

SCHEMA_VERSION = "2.3"
NOT_AVAILABLE = "not_available"

# Compiled once for evidence-text count fallbacks in _ledger_unit_tests / _ledger_api_tests.
_RE_UNIT_COUNTS = re.compile(
    r"Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)"
)
_RE_API_PASSED = re.compile(r"(\d+)/(\d+)\s*passed", re.I)

# Ensure sibling harness_events is importable.
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_events as he  # noqa: E402
import harness_gate as hgate  # noqa: E402
import harness_ledger as hl  # noqa: E402
import harness_paths as hp  # noqa: E402
import harness_phase as hphase  # noqa: E402
import harness_report_model as hrm  # noqa: E402
import harness_review as hr  # noqa: E402


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
    line = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    he.atomic_append_line(path, line)
    all_events = existing + [he.normalize_event(event)]
    he.write_execution_log(change_dir, he.render_execution_log(all_events))
    return event


# ---------------------------------------------------------------------------
# Manifest (Python port of gen-manifest.ps1)
# ---------------------------------------------------------------------------


def generate_manifest(root: Path, output_path: Path) -> dict[str, Any]:
    """Build path/size/sha256 manifest; exclude the output file itself."""
    root = root.resolve()
    exclude: Path | None = None
    if output_path.exists():
        exclude = output_path.resolve()

    files: list[dict[str, Any]] = []
    total_bytes = 0
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        if exclude is not None and path.resolve() == exclude:
            continue
        rel = path.relative_to(root).as_posix()
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
    for rel in (
        "evidence/verification-ledger.json",
        "verification-ledger.json",
    ):
        path = change_dir / rel
        if path.is_file():
            try:
                data = read_json(path)
                return data if isinstance(data, dict) else None
            except (OSError, json.JSONDecodeError):
                return None
    return None


def load_ci_metrics(change_dir: Path) -> tuple[dict[str, Any] | None, str | None]:
    """Load schema-versioned runner metrics without parsing human CI logs."""
    for relative in ("evidence/ci-metrics.json", "runtime/ci-metrics.json"):
        path = change_dir / relative
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
        path = change_dir / relative
        if not path.is_file():
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
        candidate = raw if raw.is_absolute() else change_dir / raw
        try:
            resolved = candidate.resolve()
            resolved.relative_to(change_dir.resolve())
        except (OSError, ValueError):
            resolved = None
        if resolved is not None and resolved.is_file():
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

    selected: list[dict[str, Any]] = []
    for name in required:
        entry = validations.get(name)
        if not isinstance(entry, dict):
            raise ValueError(f"required validation missing: {name}")
        missing: list[str] = []
        if str(entry.get("status") or "").upper() != "OK":
            missing.append("status=OK")
        for field in (
            "command",
            "evidence",
            "inputsHash",
            "toolchainHash",
            "environmentHash",
        ):
            if entry.get(field) in (None, "", [], {}):
                missing.append(field)
        if missing:
            raise ValueError(
                f"required validation {name} is incomplete: {', '.join(missing)}"
            )
        selected.append(
            {
                "name": name,
                "command": entry.get("command"),
                "inputsHash": entry.get("inputsHash"),
                "toolchainHash": entry.get("toolchainHash"),
                "environmentHash": entry.get("environmentHash"),
                "logHash": _candidate_evidence_hash(
                    change_dir, entry.get("evidence")
                ),
            }
        )

    ledger_path = next(
        (
            change_dir / relative
            for relative in (
                "evidence/verification-ledger.json",
                "verification-ledger.json",
            )
            if (change_dir / relative).is_file()
        ),
        None,
    )
    if ledger_path is None:
        raise ValueError("verification ledger path missing")

    product_commit = str(
        ledger.get("productCommit")
        or ledger.get("currentHead")
        or ledger.get("finalCommit")
        or ""
    ).strip()
    rc, current_head, _stderr = git_run(project_root, "rev-parse", "HEAD")
    if rc == 0 and current_head:
        if product_commit and not (
            current_head.startswith(product_commit)
            or product_commit.startswith(current_head)
        ):
            raise ValueError(
                "product commit is stale: "
                f"ledger={product_commit} current={current_head}"
            )
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
    if recorded_tree_hash and recorded_tree_hash.removeprefix(
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
        },
    }
    write_json(
        change_dir / "evidence" / "product-candidate-verification.json",
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
    for item in manifest.get("files") or []:
        if not isinstance(item, dict):
            continue
        rel = str(item.get("path") or "").replace("\\", "/")
        if not rel or _manifest_path_excluded(rel):
            continue
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
    for rel in ("logs/execution-log.md", "execution-log.md"):
        path = change_dir / rel
        if path.is_file():
            try:
                return path.read_text(encoding="utf-8-sig")
            except OSError:
                return ""
    return ""


def load_existing_summary(change_dir: Path) -> dict[str, Any] | None:
    for rel in (
        "reports/final/summary-data.json",
        "summary-data.json",
    ):
        path = change_dir / rel
        if path.is_file():
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
    for pattern in patterns:
        found.extend(sorted(change_dir.glob(pattern)))
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
    """Verify frozen archive paths are exempt from Git text conversion."""
    required_rule = ".harness/archive/** -text"
    attributes_path = project_root / ".gitattributes"
    rules: list[str] = []
    if attributes_path.is_file():
        try:
            rules = [
                line.strip()
                for line in attributes_path.read_text(encoding="utf-8-sig").splitlines()
                if line.strip() and not line.lstrip().startswith("#")
            ]
        except OSError:
            rules = []
    matching = []
    for rule in rules:
        fields = rule.split()
        if not fields or fields[0] != ".harness/archive/**":
            continue
        matching.append(rule)
        if "-text" in fields[1:] or "binary" in fields[1:]:
            return {
                "ok": True,
                "path": str(attributes_path),
                "requiredRule": required_rule,
                "matchedRule": rule,
            }
    return {
        "ok": False,
        "path": str(attributes_path),
        "requiredRule": required_rule,
        "matchedRules": matching,
        "remediation": f"add this exact-byte rule to .gitattributes: {required_rule}",
    }


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------


def check_status(
    change_dir: Path,
    *,
    allow_missing_review: bool = False,
    archive_intent: str = "release-candidate",
) -> dict[str, Any]:
    """Read-only archive preconditions. Never mutates."""
    if archive_intent not in {"release-candidate", "record-only"}:
        raise ValueError(
            "archive_intent must be release-candidate or record-only"
        )
    blockers: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    checks: dict[str, Any] = {}

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

    exact_byte = check_archive_exact_byte_policy(project)
    checks["archive_exact_byte"] = exact_byte
    if not exact_byte["ok"]:
        warnings.append(
            {
                "code": "archive-exact-byte-policy-missing",
                "message": str(exact_byte["remediation"]),
            }
        )

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

    events_path = change_dir / "events.ndjson"
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
    if ledger is None:
        blockers.append(
            {
                "code": "missing-verification-ledger",
                "message": "evidence/verification-ledger.json is required before archive",
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
    if worktree_requested(change_dir) and ledger:
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

    archivable = len(blockers) == 0
    candidate_codes = {
        "PRODUCT_CI_NOT_GREEN",
        "PRODUCT_CANDIDATE_NOT_VERIFIED",
        "PRODUCT_CANDIDATE_RECORD_ONLY",
        "PROJECT_RELEASE_POLICY_BLOCKED",
        "REMOTE_CI_DOWNGRADE_REFUSED",
    }
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
            "archive preconditions are complete"
            if archive_integrity_ok
            else "archive preconditions contain non-candidate blockers"
        ),
    }
    try:
        release_summary = collect_summary_data(
            change_dir, write=False, for_replay=False
        )
        release_summary["archiveIntent"] = archive_intent
        report_adequacy = validate_report_adequacy(release_summary)
        release_decision = evaluate_release_eligibility(
            change_dir,
            release_summary,
            archive_integrity=archive_integrity,
            report_adequacy=report_adequacy,
        )
    except Exception as exc:  # noqa: BLE001 — status must remain read-only
        release_decision = compose_release_decision(
            {
                "archiveIntegrity": archive_integrity,
                "reportAdequacy": {
                    "ok": False,
                    "code": "REPORT_ADEQUACY_UNAVAILABLE",
                    "message": str(exc),
                },
                "candidateVerification": ci_gate,
            }
        )
    return {
        "ok": True,
        "archivable": archivable,
        "archiveIntent": archive_intent,
        "archiveIntegrity": archive_integrity,
        "candidateVerification": release_decision["checks"][
            "candidateVerification"
        ],
        "releaseDecision": release_decision,
        "releaseEligible": release_decision["releaseEligible"],
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
) -> dict[str, Any]:
    """Read-only proof that a post-submit/merge archive may run unattended."""
    status = check_status(
        change_dir,
        allow_missing_review=allow_missing_review,
        archive_intent=archive_intent,
    )
    if not status.get("archivable"):
        return {
            "ok": False,
            "action": "auto-gate",
            "autoArchiveAllowed": False,
            "reasonCode": "ARCHIVE_PRECONDITIONS_UNSATISFIED",
            "status": status,
            "nextAction": "Resolve archive status blockers, then run `harness_archive.py auto-gate` again.",
        }

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
            "nextAction": "Capture the post-submit/merge archive-boundary state snapshot before auto-archiving.",
        }

    git_state = snapshot.get("git")
    snapshot_base = (
        (git_state.get("base") or git_state.get("baseCommit"))
        if isinstance(git_state, dict)
        else snapshot.get("base") or snapshot.get("baseCommit")
    )
    if not isinstance(snapshot_base, str) or not snapshot_base.strip():
        return {
            "ok": False,
            "action": "auto-gate",
            "autoArchiveAllowed": False,
            "reasonCode": "ARCHIVE_BOUNDARY_SNAPSHOT_INVALID",
            "status": status,
            "nextAction": "Capture a state snapshot containing the archive-boundary base commit after Submit or Merge.",
        }

    events_path = change_dir / "events.ndjson"
    events = he.load_events(events_path) if events_path.is_file() else []
    completed = any(
        event.get("phase") in {"submit", "merge"}
        and event.get("type") == "phase.end"
        and str(event.get("status") or "").upper() in {"OK", "WARN"}
        for event in events
        if isinstance(event, dict)
    )
    if not completed:
        return {
            "ok": False,
            "action": "auto-gate",
            "autoArchiveAllowed": False,
            "reasonCode": "SUBMIT_OR_MERGE_NOT_COMPLETED",
            "status": status,
            "nextAction": "Complete Submit or Merge and record its terminal phase event before auto-archiving.",
        }

    return {
        "ok": True,
        "action": "auto-gate",
        "autoArchiveAllowed": True,
        "reasonCode": "ARCHIVE_AUTO_GATE_SATISFIED",
        "status": status,
        "snapshotPath": str(snapshot_path),
        "snapshotBase": snapshot_base,
        "nextAction": "Run `harness_archive.py finalize` with the same change directory and intent; no AskQuestion confirmation is required.",
    }


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
        git_info = payload.get("git")
        if isinstance(git_info, dict):
            base = str(git_info.get("base") or git_info.get("baseCommit") or "").strip()
            if base and base != NOT_AVAILABLE:
                return base
        base = str(payload.get("baseCommit") or payload.get("base") or "").strip()
        if base and base != NOT_AVAILABLE:
            return base
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
    if ledger:
        base = str(ledger.get("baseCommit") or "").strip()
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
            base = str(payload.get("baseCommit") or "").strip()
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
        match = commit_pattern.search(text)
        if match:
            return match.group(0)
    if existing and existing.get("finalCommit"):
        return str(existing["finalCommit"])
    code, head, _ = git_run(project, "rev-parse", "HEAD")
    return head if code == 0 and head else ""


def _business_goal_from_sources(change_dir: Path, events: list[dict[str, Any]]) -> str:
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
        first_task = re.search(r"(?m)^\s*\|\s*1\s*\|\s*([^|]+?)\s*\|", body)
        if first_task:
            return first_task.group(1).strip()
        for line in body.splitlines():
            clean = line.strip().lstrip("#").strip()
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
            "remoteCost",
            "projection",
        ):
            if key in existing:
                data[key] = _deepcopy_json(existing[key])
    if not for_replay or not isinstance(data.get("remoteCost"), dict):
        data["remoteCost"] = remote_cost

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
# render
# ---------------------------------------------------------------------------


def resolve_node_path(project_root: Path) -> str | None:
    profile = project_root / ".harness" / "config" / "build-profile.json"
    if profile.is_file():
        try:
            data = read_json(profile)
            node = (data.get("toolPaths") or {}).get("node")
            if node and Path(str(node)).exists():
                return str(node)
        except (OSError, json.JSONDecodeError, TypeError):
            pass
    return shutil.which("node")


def _render_legacy_fallback_html(summary: dict[str, Any]) -> str:
    """Render escaped, deterministic HTML with every validate-required fact.

    Used when the Node renderer is unavailable or fails. No timestamps / random
    data; all dynamic values are HTML-escaped via _html_escape.
    """
    def esc(v: Any) -> str:
        return _html_escape("" if v is None else str(v))

    parts: list[str] = [
        "<!DOCTYPE html>",
        '<html lang="zh-CN"><head><meta charset="utf-8">',
        "<title>harness final-summary (python fallback)</title>",
        "</head><body>",
        "<h1>变更最终报告（Python fallback 渲染）</h1>",
        f'<h2 id="changeName">{esc(summary.get("changeName"))}</h2>',
        f'<p><strong>finalStatus</strong>: '
        f'<span id="finalStatus">{esc(summary.get("finalStatus"))}</span></p>',
        f'<div id="finalStatusReasons"><strong>finalStatusReasons</strong><ul>',
    ]
    for reason in summary.get("finalStatusReasons") or []:
        parts.append(f"<li>{esc(reason)}</li>")
    parts.append("</ul></div>")
    if summary.get("riskTier"):
        parts.append(f"<p><strong>riskTier</strong>: {esc(summary.get('riskTier'))}</p>")
    parts.append("<h3>Current Outcome</h3>")
    parts.append(
        f"<p>finalStatus={esc(summary.get('finalStatus'))}</p>"
    )

    candidate = (
        summary.get("candidateVerification")
        if isinstance(summary.get("candidateVerification"), dict)
        else {}
    )
    parts.append("<h3>Candidate Claim / Attestation</h3>")
    parts.append(
        f"<p>assurance={esc(candidate.get('assurance'))} "
        f"code={esc(candidate.get('code'))} "
        f"provider={esc(candidate.get('provider'))}</p>"
    )

    integrity = (
        summary.get("archiveIntegrity")
        if isinstance(summary.get("archiveIntegrity"), dict)
        else {}
    )
    parts.append("<h3>Archive Integrity</h3>")
    parts.append(
        f"<p>ok={esc(integrity.get('ok'))} "
        f"code={esc(integrity.get('code'))} "
        f"checksumStatus={esc(integrity.get('checksumStatus'))}</p>"
    )

    decision = (
        summary.get("releaseDecision")
        if isinstance(summary.get("releaseDecision"), dict)
        else {}
    )
    parts.append("<h3>Release Eligibility</h3>")
    parts.append(
        f"<p>releaseEligible={esc(decision.get('releaseEligible'))} "
        f"code={esc(decision.get('code'))}</p><ul>"
    )
    checks = decision.get("checks")
    checks = checks if isinstance(checks, dict) else {}
    for name, check in checks.items():
        check = check if isinstance(check, dict) else {}
        parts.append(
            f"<li>{esc(name)}: ok={esc(check.get('ok'))} "
            f"code={esc(check.get('code'))}</li>"
        )
    parts.append("</ul>")

    timing = summary.get("timing") if isinstance(summary.get("timing"), dict) else {}
    if timing:
        parts.append("<h3>Timing</h3>")
        parts.append(
            "<p id=\"timingColumns\">"
            f"stageActiveExecution={esc(timing.get('stageActiveExecutionMs'))} · "
            f"stageWallClockSpan={esc(timing.get('stageWallClockSpanMs'))} · "
            f"workflowWallClock={esc(timing.get('workflowWallClockMs'))}"
            "</p>"
        )
        parts.append(
            "<p id=\"timingConservation\">"
            f"attributedStageUnionMs={esc(timing.get('attributedStageUnionMs'))} · "
            f"externalWaitMs={esc(timing.get('externalWaitMs'))} · "
            f"pausedMs={esc(timing.get('pausedMs'))} · "
            "agentOrToolUnattributedMs="
            f"{esc(timing.get('agentOrToolUnattributedMs'))} · "
            f"conservationDeltaMs={esc(timing.get('conservationDeltaMs'))}"
            "</p>"
        )
        parts.append(
            f"<p><strong>reportCutoffAt</strong>: "
            f"<span id=\"reportCutoffAt\">{esc(timing.get('reportCutoffAt'))}</span></p>"
        )
        parts.append(
            "<p><small>durations.totalMinutes is active-only; "
            "do not treat it as workflow wall clock.</small></p>"
        )
    parts.append("<h3>History Quality</h3><ul>")
    attempts = timing.get("attempts")
    attempts = attempts if isinstance(attempts, list) else []
    for attempt in attempts:
        attempt = attempt if isinstance(attempt, dict) else {}
        parts.append(
            f"<li>{esc(attempt.get('phase'))}: "
            f"{esc(attempt.get('terminalStatus') or attempt.get('status'))} "
            f"durationMs={esc(attempt.get('durationMs'))}</li>"
        )
    if not attempts:
        parts.append("<li>no typed attempts recorded</li>")
    parts.append("</ul>")

    remote_cost = (
        summary.get("remoteCost")
        if isinstance(summary.get("remoteCost"), dict)
        else {}
    )
    remote_totals = remote_cost.get("totals")
    remote_totals = remote_totals if isinstance(remote_totals, dict) else {}
    parts.append("<h3>Remote Cost</h3>")
    parts.append(
        f"<p>runnerMinutes={esc(remote_totals.get('runnerMinutes'))} "
        f"queueWaitMs={esc(remote_totals.get('queueWaitMs'))} "
        f"artifactBytes={esc(remote_totals.get('artifactBytes'))} "
        f"duplicateRunCount={esc(remote_totals.get('duplicateRunCount'))}</p>"
    )

    storage = (
        summary.get("artifactStorage")
        if isinstance(summary.get("artifactStorage"), dict)
        else {}
    )
    parts.append("<h3>Artifact Storage</h3>")
    parts.append(
        f"<p>artifactCount={esc(storage.get('artifactCount'))} "
        f"bytesAdded={esc(storage.get('bytesAdded'))} "
        f"bytesReused={esc(storage.get('bytesReused'))} "
        f"bytesPruned={esc(storage.get('bytesPruned'))}</p>"
    )

    projection = (
        summary.get("projection")
        if isinstance(summary.get("projection"), dict)
        else {}
    )
    parts.append("<h3>Projection / Fallback</h3>")
    parts.append(
        f"<p>mode={esc(projection.get('mode'))} "
        f"code={esc(projection.get('code'))} "
        f"remediation={esc(projection.get('remediation'))}</p>"
    )

    if summary.get("productCommit") or summary.get("productTreeHash"):
        parts.append("<h3>Identity</h3>")
        parts.append(
            f"<p>productCommit={esc(summary.get('productCommit'))} "
            f"productTreeHash={esc(summary.get('productTreeHash'))} "
            f"archiveCommit={esc(summary.get('archiveCommit'))}</p>"
        )

    pipeline = summary.get("reportPipeline") or {}
    cmds = pipeline.get("commands") or []
    parts.append("<h3>Commands</h3><ul>")
    for c in cmds:
        parts.append(
            f"<li><code>{esc(c.get('command'))}</code> "
            f"exitCode={esc(c.get('exit_code'))}</li>"
        )
    parts.append("</ul>")

    ver = summary.get("verification") or {}
    unit = ver.get("unitTests") or {}
    api = ver.get("apiTests") or {}
    browser = ver.get("browserE2E") or {}
    parts.append("<h3>Verification</h3>")
    parts.append(
        "<p>unitTests: run={run} failures={failures} errors={errors} "
        "skipped={skipped} passRate={passRate} status={status}</p>".format(
            run=esc(unit.get("run")),
            failures=esc(unit.get("failures")),
            errors=esc(unit.get("errors")),
            skipped=esc(unit.get("skipped")),
            passRate=esc(unit.get("passRate")),
            status=esc(unit.get("status")),
        )
    )
    parts.append(
        "<p>apiTests: status={status} total={total} passed={passed} "
        "failed={failed} blocked={blocked}</p>".format(
            status=esc(api.get("status")),
            total=esc(api.get("total")),
            passed=esc(api.get("passed")),
            failed=esc(api.get("failed")),
            blocked=esc(api.get("blocked")),
        )
    )
    parts.append(
        "<p>browserE2E: status={status} total={total} passed={passed} "
        "failed={failed} skipped={skipped} retries={retries}</p>".format(
            status=esc(browser.get("status")),
            total=esc(browser.get("total")),
            passed=esc(browser.get("passed")),
            failed=esc(browser.get("failed")),
            skipped=esc(browser.get("skipped")),
            retries=esc(browser.get("retries")),
        )
    )
    parts.append(f"<p>dbCompatibility: {esc(ver.get('dbCompatibility'))}</p>")

    parts.append("<h3>Changed Files</h3><ul>")
    for f in summary.get("changedFiles") or []:
        parts.append(
            f"<li>{esc(f.get('path'))} +{esc(f.get('insertions'))} "
            f"-{esc(f.get('deletions'))}</li>"
        )
    parts.append("</ul>")

    am = summary.get("archiveManifest") or {}
    parts.append("<h3>Archive Manifest</h3>")
    parts.append(
        "<p>movedFiles={moved} generatedFiles={gen} totalArchiveFiles={total} "
        "checksumStatus={cs}</p>".format(
            moved=esc(am.get("movedFiles")),
            gen=esc(am.get("generatedFiles")),
            total=esc(am.get("totalArchiveFiles")),
            cs=esc(am.get("checksumStatus")),
        )
    )

    def _list_section(title: str, items: Any) -> None:
        parts.append(f"<h3>{esc(title)}</h3><ul>")
        for it in items or []:
            parts.append(f"<li>{esc(it)}</li>")
        parts.append("</ul>")

    _list_section("Known Risks", summary.get("knownRisks"))
    _list_section("Manual Actions", summary.get("manualActions"))
    _list_section("Maintenance Notes", summary.get("maintenanceNotes"))

    parts.append("</body></html>")
    return "\n".join(parts) + "\n"


def render_fallback_html(summary: dict[str, Any]) -> str:
    """Render the same executive information architecture without Node."""

    def esc(value: Any) -> str:
        return _html_escape("" if value is None else str(value))

    def rec(value: Any) -> dict[str, Any]:
        return value if isinstance(value, dict) else {}

    def seq(value: Any) -> list[Any]:
        return value if isinstance(value, list) else []

    normalized = rec(summary.get("normalizedReport"))
    outcomes = rec(normalized.get("outcomes"))
    current = rec(outcomes.get("current")) or {
        "status": summary.get("finalStatus"),
        "reasons": seq(summary.get("finalStatusReasons")),
        "stages": rec(summary.get("stageStatus")),
        "knownRisks": seq(summary.get("knownRisks")),
    }
    release = rec(outcomes.get("release")) or {
        "intent": summary.get("archiveIntent"),
        "decision": "NOT_REQUESTED"
        if summary.get("archiveIntent") == "record-only"
        else rec(summary.get("releaseDecision")).get("code"),
        "eligible": rec(summary.get("releaseDecision")).get("releaseEligible"),
    }
    identity = rec(normalized.get("identity")) or rec(summary.get("changeIdentity"))
    verification = rec(normalized.get("verification")) or rec(
        summary.get("verification")
    )
    timing = rec(normalized.get("timing")) or rec(summary.get("timing"))
    measurements = rec(normalized.get("measurements"))
    record_only = (
        release.get("intent") == "record-only"
        or summary.get("archiveIntent") == "record-only"
    )
    product_commit = (
        identity.get("productCommit")
        or summary.get("productCommit")
        or summary.get("finalCommit")
        or "N/A"
    )
    labels = [
        ("后端", ("unitTests", "dbCompatibility")),
        ("Geo", ("geo",)),
        ("前端", ("frontend",)),
        ("浏览器", ("browserE2E",)),
        ("API", ("apiTests",)),
    ]
    status_labels = {
        "OK": "通过",
        "PASS": "通过",
        "PASSED": "通过",
        "CONDITIONAL_OK": "有条件通过",
        "WARN": "警告",
        "ADVISORY": "建议",
        "FAIL": "失败",
        "FAILED": "失败",
        "ERROR": "错误",
        "BLOCKED": "阻塞",
        "NOT_RUN": "未运行",
        "SKIPPED": "已跳过",
        "NOT_APPLICABLE": "不适用",
        "UNKNOWN": "未知",
    }

    def status_label(value: Any) -> str:
        status = str(value or "UNKNOWN").upper()
        return status_labels.get(status, status)

    def verification_status(value: Any) -> str:
        if isinstance(value, str):
            return value
        item = rec(value)
        if item.get("status"):
            return str(item["status"])
        if int(item.get("failures") or 0) + int(item.get("errors") or 0):
            return "FAIL"
        if int(item.get("run") or item.get("total") or 0):
            return "OK"
        return "NOT_RUN"

    def describe(value: Any) -> str:
        if isinstance(value, str):
            return value
        item = rec(value)
        return str(
            item.get("title")
            or item.get("message")
            or item.get("summary")
            or item.get("action")
            or item.get("remediation")
            or item
        )

    def measurement_label(value: Any) -> str:
        item = rec(value)
        if item.get("state") in {"unknown", "not_applicable"}:
            return "N/A"
        if item.get("state") == "zero":
            return "0"
        if item.get("state") == "known":
            return str(item.get("value"))
        return "N/A" if value is None or value == "" else str(value)

    risks = (
        seq(current.get("findings"))
        or seq(current.get("knownRisks"))
        or seq(summary.get("knownRisks"))
    )
    actions = seq(summary.get("manualActions"))
    groups: list[str] = []
    passed = 0
    for label, keys in labels:
        statuses = [
            verification_status(verification[key])
            for key in keys
            if key in verification
        ]
        status = (
            "FAIL"
            if any(value in {"FAIL", "ERROR", "BLOCKED"} for value in statuses)
            else "WARN"
            if any("WARN" in value or "CONDITIONAL" in value for value in statuses)
            else "NOT_APPLICABLE"
            if statuses and all(value == "NOT_APPLICABLE" for value in statuses)
            else "OK"
            if statuses
            and all(
                value in {"OK", "PASS", "PASSED", "NOT_APPLICABLE"}
                for value in statuses
            )
            else "NOT_RUN"
        )
        if status == "OK":
            passed += 1
        details = " · ".join(
            str(rec(verification.get(key)).get("passRate") or status)
            for key in keys
            if key in verification
        ) or "未配置该组验证"
        raw_details = " · ".join(
            f"{key} · status={verification_status(verification[key])}"
            + (
                f" · failed={rec(verification[key]).get('failed')}"
                if rec(verification[key]).get("failed") is not None
                else ""
            )
            for key in keys
            if key in verification
        )
        groups.append(
            f'<article class="verify" title="{esc(raw_details)}"><strong>{esc(label)}</strong>'
            f'<span title="{esc(status)}">{esc(status_label(status))}</span><small>{esc(details)}</small></article>'
        )

    commands = seq(rec(summary.get("reportPipeline")).get("commands"))
    command_rows = "".join(
        f"<tr><td>{esc(item.get('phase') or '-')}</td>"
        f"<td><code>{esc(item.get('command'))}</code></td>"
        f"<td>{esc('OK' if int(item.get('exit_code', item.get('exitCode', 1))) == 0 else 'FAIL')}</td></tr>"
        for item in commands
        if isinstance(item, dict)
    ) or '<tr><td colspan="3">没有命令证据</td></tr>'
    files = seq(summary.get("changedFiles"))
    file_rows = "".join(
        f"<tr><td><code>{esc(item.get('path') or item.get('file'))}</code></td>"
        f"<td>+{esc(item.get('insertions') or 0)}</td>"
        f"<td>-{esc(item.get('deletions') or 0)}</td></tr>"
        for item in files
        if isinstance(item, dict)
    ) or '<tr><td colspan="3">没有变更文件证据</td></tr>'
    risk_rows = "".join(f"<li>{esc(describe(item))}</li>" for item in risks) or "<li>当前没有未处置风险</li>"
    action_rows = "".join(f"<li>{esc(describe(item))}</li>" for item in actions) or "<li>无需人工后续动作</li>"
    release_card = (
        ""
        if record_only
        else "<article class=\"card\"><h2>发布与候选</h2>"
        f"<p>候选证明 / 发布资格：{esc(release.get('decision') or 'NOT_EVALUATED')}</p></article>"
    )
    remote = rec(measurements.get("remoteCost"))
    storage = rec(measurements.get("artifactStorage"))
    remote_totals = rec(remote.get("totals"))
    projection = rec(summary.get("projection"))
    archive_integrity = rec(summary.get("archiveIntegrity"))
    total_files = rec(summary.get("archiveManifest")).get("totalArchiveFiles")
    total_files_text = "" if total_files is None else str(total_files)

    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Harness 最终报告 · {esc(summary.get("changeName"))}</title>
<style>
:root{{--bg:#f4f6f8;--card:#fff;--text:#172033;--muted:#667085;--line:#dfe5ec}}
@media(prefers-color-scheme:dark){{:root{{--bg:#0b1119;--card:#121a26;--text:#eef3f9;--muted:#9aa8ba;--line:#2a384a}}}}
*{{box-sizing:border-box}}html,body{{max-width:100%;overflow-x:hidden}}body{{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 "Segoe UI","Microsoft YaHei",sans-serif}}main{{width:min(1120px,calc(100% - 32px));margin:24px auto}}.hero,.card,.metric,.verify,details{{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}}.hero h1{{margin:4px 0}}.metrics,.groups{{display:grid;grid-template-columns:repeat(5,1fr);gap:9px;margin:10px 0}}.metric strong,.verify strong{{display:block;font-size:17px}}.verify small{{display:block;color:var(--muted)}}.risk{{display:grid;grid-template-columns:1fr 1fr;gap:10px}}.card{{margin:10px 0}}details{{margin:9px 0}}summary{{cursor:pointer;font-weight:700}}details>div{{overflow:auto}}table{{width:100%;border-collapse:collapse}}td,th{{padding:8px;border-bottom:1px solid var(--line);text-align:left}}code{{overflow-wrap:anywhere}}@media(max-width:600px){{main{{width:calc(100% - 18px);margin:9px auto}}.metrics,.groups,.risk{{grid-template-columns:1fr}}}}
</style></head><body><main>
<section class="hero"><small>HARNESS · 管理结论</small><h1>{esc(summary.get("changeName"))}</h1>
<p>{esc(summary.get("businessGoal") or "未记录业务目标")}</p>
<strong title="{esc(current.get("status"))}">{esc(status_label(current.get("status")))}</strong>
<p id="finalStatusReasons">{esc(" · ".join(str(item) for item in seq(current.get("reasons"))))}</p>
{"<p>归档意图：仅记录 · 未请求发布</p>" if record_only else ""}</section>
<section class="metrics"><article class="metric"><small>产品提交</small><strong><code>{esc(str(product_commit)[:10])}</code></strong></article>
<article class="metric"><small>验证概览</small><strong>{passed}/5 组通过</strong></article>
<article class="metric"><small>风险与动作</small><strong>{len(risks)} / {len(actions)}</strong></article>
<article class="metric"><small>全流程耗时</small><strong>{esc(timing.get("workflowWallClockMs") or "N/A")}</strong></article>
<article class="metric"><small>归档文件</small><strong>{esc(total_files_text or "N/A")}</strong></article></section>
<article class="card"><h2>验证概览</h2><div class="groups">{"".join(groups)}</div></article>
<article class="card"><h2>风险与动作</h2><div class="risk"><section><h3>当前风险</h3><ul>{risk_rows}</ul></section><section><h3>人工动作</h3><ul>{action_rows}</ul></section></div></article>
{release_card}
<details><summary>技术证据 · 时间守恒</summary><div><p>conservationDeltaMs={esc(timing.get("conservationDeltaMs") if "conservationDeltaMs" in timing else "N/A")}</p>
<p>workflowWallClock={esc(timing.get("workflowWallClockMs") if "workflowWallClockMs" in timing else "N/A")}</p>
<p>stageActiveExecution={esc(timing.get("stageActiveExecutionMs") if "stageActiveExecutionMs" in timing else "N/A")}</p>
<p>stageWallClockSpan={esc(timing.get("stageWallClockSpanMs") if "stageWallClockSpanMs" in timing else "N/A")}</p>
<p>reportCutoffAt={esc(timing.get("reportCutoffAt") or "N/A")}</p>
<p>远端 runner 成本：{esc(measurement_label(remote_totals.get("runnerMinutes") or remote.get("runnerMinutes")))}</p>
<p>新增制品字节：{esc(measurement_label(storage.get("bytesAdded")))}</p></div></details>
<details><summary>技术证据 · 发布与归档治理</summary><div>
<p>归档完整性：{esc(archive_integrity.get("code") or rec(summary.get("archiveManifest")).get("checksumStatus") or "N/A")}</p>
<p>历史质量：未闭合尝试 {esc(timing.get("unclosedAttemptCount") if "unclosedAttemptCount" in timing else "N/A")}</p>
<p>投影状态：{esc(projection.get("code") or projection.get("mode") or "N/A")}</p></div></details>
<details><summary>技术证据 · 变更文件</summary><div><table><tbody>{file_rows}</tbody></table></div></details>
<details><summary>技术证据 · 命令</summary><div><table><tbody>{command_rows}</tbody></table></div></details>
<details><summary>技术元数据</summary><div><p>productCommit=<code>{esc(product_commit)}</code></p>
<p>schemaVersion={esc(summary.get("schemaVersion"))}</p></div></details>
</main></body></html>
"""


def render_final_summary(
    change_dir: Path,
    summary_path: Path,
) -> dict[str, Any]:
    """Render final-summary.html via Node; fall back to a Python renderer.

    Returns ``{ok, renderer, fallbackReason, out_path}``:
    - Node success -> renderer="node".
    - Node unavailable/timeout/non-zero/no-file -> Python fallback; success ->
      renderer="python-fallback" (fallbackReason carries the node failure cause).
    - Both fail or produce no file -> ok=False (caller must restore + exit non-0).
    """
    out_path = change_dir / "reports" / "final" / "final-summary.html"
    project = find_project_root(change_dir)
    node = resolve_node_path(project)
    fallback_reason = ""

    if node and RENDER_SCRIPT.is_file():
        out_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            proc = subprocess.run(
                [
                    node,
                    str(RENDER_SCRIPT),
                    "--summary",
                    str(summary_path),
                    "--out",
                    str(out_path),
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=60,
                check=False,
            )
            if proc.returncode == 0 and out_path.is_file():
                return {
                    "ok": True,
                    "renderer": "node",
                    "fallbackReason": "",
                    "out_path": str(out_path),
                }
            fallback_reason = (
                f"node render exit {proc.returncode}: "
                f"{(proc.stderr or proc.stdout or '')[:200]}"
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            fallback_reason = f"node render failed: {exc}"
    else:
        fallback_reason = (
            "node unavailable" if not node else f"renderer missing: {RENDER_SCRIPT}"
        )

    # Python fallback
    try:
        summary = read_json(summary_path)
        html = render_fallback_html(summary)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(html, encoding="utf-8", newline="\n")
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        return {
            "ok": False,
            "renderer": "none",
            "fallbackReason": f"{fallback_reason}; fallback failed: {exc}",
            "out_path": str(out_path),
        }
    if out_path.is_file():
        return {
            "ok": True,
            "renderer": "python-fallback",
            "fallbackReason": fallback_reason,
            "out_path": str(out_path),
        }
    return {
        "ok": False,
        "renderer": "none",
        "fallbackReason": f"{fallback_reason}; fallback produced no file",
        "out_path": str(out_path),
    }


# ---------------------------------------------------------------------------
# validate
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
    """Persist one failed finalize attempt on the authoritative change source."""
    if not authoritative_change_dir.is_dir():
        return
    try:
        append_event(
            authoritative_change_dir,
            phase="archive",
            type_="phase.start",
            note=f"finalize operation {operation_id} failed before publish",
        )
        append_event(
            authoritative_change_dir,
            phase="archive",
            type_="phase.end",
            status="FAIL",
            note=f"finalize operation {operation_id} discarded: {message}",
        )
    except OSError:
        pass


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


def validate_summary(
    summary: dict[str, Any],
    html_path: Path | None,
    *,
    render_skipped: bool = False,
) -> dict[str, Any]:
    """Validate final-summary covers summary-data key facts (in-process)."""
    issues: list[dict[str, str]] = []

    change_id = str(summary.get("changeName") or "")
    html = ""
    if html_path and html_path.is_file():
        try:
            html = html_path.read_text(encoding="utf-8-sig")
        except OSError as exc:
            issues.append(
                {
                    "code": "missing-final-report",
                    "severity": "error",
                    "message": f"cannot read final-summary: {exc}",
                }
            )
    else:
        # Task 2 (§4.1 rule 5): 不再存在"没有 HTML 但只 warning"的分支。
        # 缺 final-summary 恒为 error；finalize 会 restore + exit 非 0。
        issues.append(
            {
                "code": "missing-final-report",
                "severity": "error",
                "message": "reports/final/final-summary.html not found",
            }
        )

    def has_text(needle: str) -> bool:
        if not needle or needle == NOT_AVAILABLE:
            return True
        return needle in html

    # change id
    if html and change_id and not has_text(change_id):
        issues.append(
            {
                "code": "missing-change-id",
                "severity": "error",
                "message": f"final-summary missing change id '{change_id}'",
            }
        )

    # key commands — stock render-summary.mjs does not embed reportPipeline.commands.
    # Require commands to be present in summary-data; HTML absence is warning only.
    commands = (summary.get("reportPipeline") or {}).get("commands") or []
    if html:
        for cmd in commands[:8]:
            c = str(cmd.get("command") or "").strip()
            if not c:
                continue
            fragment = c if len(c) <= 60 else c[:60]
            token = c.split()[-1] if c.split() else c
            in_html = (
                fragment in html
                or _html_escape(fragment) in html
                or (len(token) >= 4 and (token in html or _html_escape(token) in html))
            )
            if not in_html:
                issues.append(
                    {
                        "code": "missing-command",
                        "severity": "warning",
                        "message": (
                            f"final-summary HTML omits command (renderer may not "
                            f"embed commands): {c}"
                        ),
                    }
                )

        # verification
        ver = summary.get("verification") or {}
        unit = ver.get("unitTests") or {}
        api = ver.get("apiTests") or {}
        browser = ver.get("browserE2E") or {}
        pass_rate = unit.get("passRate")
        if pass_rate and pass_rate != NOT_AVAILABLE and str(pass_rate) not in html:
            issues.append(
                {
                    "code": "missing-verification",
                    "severity": "warning",
                    "message": f"unitTests.passRate '{pass_rate}' not in final-summary",
                }
            )
        api_status = str(api.get("status") or "")
        if api_status and api_status not in {"", NOT_AVAILABLE} and api_status not in html:
            # Renderer shows api status; soft warning
            if api_status in {"USER_SKIPPED", "BLOCKED_BY_DBA", "NOT_RUN", "PARTIAL"}:
                issues.append(
                    {
                        "code": "missing-verification",
                        "severity": "warning",
                        "message": f"apiTests.status '{api_status}' not visible in final-summary",
                    }
                )
        browser_status = str(browser.get("status") or "")
        if (
            browser_status
            and browser_status not in {"", NOT_AVAILABLE}
            and browser_status not in html
        ):
            issues.append(
                {
                    "code": "missing-verification",
                    "severity": "warning",
                    "message": (
                        f"browserE2E.status '{browser_status}' not visible "
                        "in final-summary"
                    ),
                }
            )

        # artifacts / summary-data path hints
        am = summary.get("archiveManifest") or {}
        total = am.get("totalArchiveFiles")
        if total is not None and str(total) not in html:
            issues.append(
                {
                    "code": "missing-artifact",
                    "severity": "warning",
                    "message": "archiveManifest.totalArchiveFiles not reflected in final-summary",
                }
            )

        # risks / manual actions — empty arrays are OK (placeholder)
        for risk in summary.get("knownRisks") or []:
            # UT-016/RET-28: canonical projection — structured risk objects
            # project to their message; str(dict) never matches rendered HTML.
            if isinstance(risk, dict):
                text = str(risk.get("message") or risk.get("summary") or "").strip()
            else:
                text = str(risk)
            if text and text not in html and _html_escape(text) not in html:
                issues.append(
                    {
                        "code": "missing-risk",
                        "severity": "warning",
                        "message": f"knownRisk not in final-summary: {text[:80]}",
                    }
                )

        # status contradiction
        final_status = str(summary.get("finalStatus") or "")
        browser_conditional = {
            "USER_SKIPPED",
            "BLOCKED",
            "BLOCKED_BY_ENV",
            "NOT_RUN",
            "PARTIAL",
        }
        has_skip = api_status == "USER_SKIPPED" or browser_status in browser_conditional or str(
            ver.get("dbCompatibility") or ""
        ) == "BLOCKED_BY_DBA"
        has_fail_ver = int(unit.get("failures") or 0) > 0 or int(unit.get("errors") or 0) > 0
        has_fail_ver = has_fail_ver or int(api.get("failed") or 0) > 0
        has_fail_ver = (
            has_fail_ver
            or int(browser.get("failed") or 0) > 0
            or browser_status == "FAIL"
        )
        stage = summary.get("stageStatus") or {}
        has_fail_stage = any(str(v).upper() == "FAIL" for v in stage.values())

        if (has_skip or has_fail_ver or has_fail_stage) and final_status == "OK":
            issues.append(
                {
                    "code": "status-contradiction",
                    "severity": "error",
                    "message": (
                        "finalStatus is pure OK but USER_SKIPPED/BLOCKED_BY_DBA/"
                        "failed verification present"
                    ),
                }
            )
        if has_skip and html:
            if re.search(r">\s*OK\s*<", html) and "CONDITIONAL" not in html.upper():
                if final_status != "CONDITIONAL_OK":
                    issues.append(
                        {
                            "code": "status-contradiction",
                            "severity": "error",
                            "message": "final-summary shows pure OK despite USER_SKIPPED/BLOCKED",
                        }
                    )
    else:
        # No HTML (and not render_skipped handled above): still check data-level status rules
        ver = summary.get("verification") or {}
        unit = ver.get("unitTests") or {}
        api = ver.get("apiTests") or {}
        browser = ver.get("browserE2E") or {}
        api_status = str(api.get("status") or "")
        browser_status = str(browser.get("status") or "")
        final_status = str(summary.get("finalStatus") or "")
        has_skip = api_status == "USER_SKIPPED" or browser_status in {
            "USER_SKIPPED",
            "BLOCKED",
            "BLOCKED_BY_ENV",
            "NOT_RUN",
            "PARTIAL",
        } or str(
            ver.get("dbCompatibility") or ""
        ) == "BLOCKED_BY_DBA"
        has_fail_ver = int(unit.get("failures") or 0) > 0 or int(unit.get("errors") or 0) > 0
        has_fail_ver = has_fail_ver or int(api.get("failed") or 0) > 0
        has_fail_ver = (
            has_fail_ver
            or int(browser.get("failed") or 0) > 0
            or browser_status == "FAIL"
        )
        stage = summary.get("stageStatus") or {}
        has_fail_stage = any(str(v).upper() == "FAIL" for v in stage.values())
        if (has_skip or has_fail_ver or has_fail_stage) and final_status == "OK":
            issues.append(
                {
                    "code": "status-contradiction",
                    "severity": "error",
                    "message": (
                        "finalStatus is pure OK but USER_SKIPPED/BLOCKED_BY_DBA/"
                        "failed verification present"
                    ),
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


def _html_escape(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


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
    if final_present and base_missing:
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

    if (
        base
        and base != NOT_AVAILABLE
        and feature_tip
        and feature_tip != NOT_AVAILABLE
        and base == feature_tip
    ):
        issues.append({
            "code": "ARCHIVE_BASE_EQUALS_FEATURE_TIP",
            "severity": "error",
            "message": (
                f"baseCommit equals feature tip ({base}); "
                "archive boundary collapsed to an empty/merge-only delta"
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

    if ownership_count > 0 and changed_count == 0:
        issues.append({
            "code": "ARCHIVE_DIFF_SHRUNK_VS_OWNERSHIP",
            "severity": "error",
            "message": (
                f"ownership diff has {ownership_count} file(s) but report "
                "diff is empty; base/diff pairing is internally consistent "
                "but does not represent the full change"
            ),
        })
    elif ownership_count > 0 and changed_count > 0 and changed_count * 3 < ownership_count:
        issues.append({
            "code": "ARCHIVE_DIFF_SHRUNK_VS_OWNERSHIP",
            "severity": "error",
            "message": (
                f"report diff covers {changed_count} file(s) but ownership "
                f"lists {ownership_count}; suspected merge-delta truncation"
            ),
        })

    merge_parents = summary.get("mergeParents") or summary.get("mergeParentHashes")
    if isinstance(merge_parents, list) and len(merge_parents) >= 2:
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

    return {"ok": not issues, "issues": issues}


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
    for line in events_p.read_text(encoding="utf-8").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict) or event.get("type") != "artifact":
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
            "code": "ARTIFACT_POLICY_INVALID",
            "message": str(exc),
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
    ok = total <= max_total and not oversized and bool(preflight.get("ok"))
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


def run_knowledge_poststeps(project_root: Path) -> dict[str, Any]:
    results: dict[str, Any] = {"ran": False, "steps": [], "warnings": []}
    if not KNOWLEDGE_SCRIPT.is_file():
        results["warnings"].append(f"harness_knowledge.py not found: {KNOWLEDGE_SCRIPT}")
        return results
    results["ran"] = True
    for cmd in ("ingest", "dedupe", "auto-supersede", "reverify-stale"):
        try:
            proc = subprocess.run(
                [
                    sys.executable,
                    str(KNOWLEDGE_SCRIPT),
                    cmd,
                    "--project",
                    str(project_root),
                    "--json",
                ],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=300,
                check=False,
            )
            step = {
                "command": cmd,
                "exit_code": proc.returncode,
                "ok": proc.returncode == 0,
            }
            if proc.returncode != 0:
                step["stderr"] = (proc.stderr or proc.stdout or "")[:500]
                results["warnings"].append(f"knowledge {cmd} exit {proc.returncode}")
            results["steps"].append(step)
        except (OSError, subprocess.TimeoutExpired) as exc:
            results["steps"].append({"command": cmd, "ok": False, "error": str(exc)})
            results["warnings"].append(f"knowledge {cmd} failed: {exc}")
    return results


def enqueue_maintenance_outbox(project_root: Path, archive_dir: Path) -> dict[str, Any]:
    """§8.2: write a pending maintenance-outbox item instead of synchronously
    running the four knowledge subprocesses. Never rolls back the archive."""
    pending_dir = (
        project_root / ".harness" / "knowledge" / "maintenance-outbox" / "pending"
    )
    pending_dir.mkdir(parents=True, exist_ok=True)
    archive_id = archive_dir.name
    manifest = archive_dir / "evidence" / "archive-manifest-after.json"
    manifest_hash = "sha256:" + sha256_file(manifest) if manifest.is_file() else ""
    try:
        rel = archive_dir.resolve().relative_to(project_root.resolve()).as_posix()
    except ValueError:
        rel = str(archive_dir)
    item = {
        "schemaVersion": 1,
        "archiveId": archive_id,
        "archivePath": rel,
        "archiveManifestHash": manifest_hash,
        "status": "pending",
        "attempts": 0,
        "createdAt": now_iso(),
        "lastError": None,
    }
    item_path = pending_dir / f"{archive_id}.json"
    write_json(item_path, item)
    return {
        "queued": True,
        "outboxPath": str(item_path),
        "archiveId": archive_id,
        "status": "pending",
    }


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


# ---------------------------------------------------------------------------
# finalize
# ---------------------------------------------------------------------------


def cmd_finalize(
    change_dir: Path,
    archive_root: Path,
    *,
    skip_ingest: bool = False,
    allow_missing_review: bool = False,
    archive_intent: str = "release-candidate",
) -> tuple[int, dict[str, Any]]:
    """Execute the 9-step finalize pipeline. Returns (exit_code, payload)."""
    if archive_intent not in {"release-candidate", "record-only"}:
        return 1, {
            "ok": False,
            "action": "finalize",
            "error": "archive_intent must be release-candidate or record-only",
        }
    warnings: list[str] = []
    original_change_dir = change_dir.resolve()
    change_name = original_change_dir.name
    archive_root = archive_root.resolve()
    archive_root.mkdir(parents=True, exist_ok=True)
    archive_dir = archive_root / f"{today_date()}-{change_name}"
    project_root = find_project_root(original_change_dir)
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
    operation_id = f"a-{uuid.uuid4().hex[:12]}"
    operation_root = project_root / ".harness" / "archive-operations"
    operation_temp_dir = operation_root / "staging" / operation_id / change_dir.name
    operation_record = operation_root / f"{operation_id}.json"

    def _restore_finalize_failure() -> None:
        shutil.rmtree(operation_temp_dir.parent, ignore_errors=True)
        payload["original_preserved"] = original_change_dir.is_dir()
        payload["finalStatus"] = "FAIL"
        _append_finalize_failure_terminal(
            split_state_dir
            if split_state_dir is not None and split_state_dir.is_dir()
            else original_change_dir,
            str(payload.get("error") or "archive finalize failed"),
            operation_id=operation_id,
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

    exact_byte = check_archive_exact_byte_policy(project_root)
    payload["steps"]["archive_exact_byte"] = exact_byte
    if not exact_byte["ok"]:
        warnings.append(str(exact_byte["remediation"]))

    artifact_budget = evaluate_artifact_budget(original_change_dir)
    payload["steps"]["artifact_budget"] = artifact_budget
    if not artifact_budget.get("ok"):
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
        payload["original_preserved"] = original_change_dir.is_dir()
        payload["finalStatus"] = "FAIL"
        _append_finalize_failure_terminal(
            split_state_dir
            if split_state_dir is not None and split_state_dir.is_dir()
            else original_change_dir,
            payload["error"],
            operation_id=operation_id,
        )
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

    if split_state_dir is not None and split_state_dir.is_dir():
        _merge_runtime_state(split_state_dir, work_dir)
        payload["steps"]["split_state_merge"] = {
            "ok": True,
            "stateDir": str(split_state_dir),
        }

    def _safe_append(**kwargs: Any) -> None:
        nonlocal work_dir
        try:
            append_event(work_dir, **kwargs)
        except OSError as exc:
            warnings.append(f"event append failed: {exc}")

    # Step 9 starts here: phase.start
    _safe_append(phase="archive", type_="phase.start", note="finalize start")

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
    if preflight.get("blocking"):
        payload["error"] = (
            f"artifact preflight blocking: "
            f"{len(preflight['blocking'])} path(s) cannot be archived"
        )
        payload["issues"] = [
            {
                "code": "ARTIFACT_PATH_BLOCKING",
                "severity": "error",
                "message": f"{item.get('path', '')}: {item.get('reason', 'blocking')}",
            }
            for item in preflight["blocking"]
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

    # --- 6. render (Node, else Python fallback) ---
    render_result = render_final_summary(work_dir, summary_path)
    payload["steps"]["render"] = render_result
    if not render_result.get("ok"):
        # 永不关闭一个没有 final-summary 的归档。
        msg = str(render_result.get("fallbackReason") or "render failed")
        payload["error"] = f"final-summary render failed: {msg}"
        _restore_finalize_failure()
        payload["warnings"] = warnings
        payload["ok"] = False
        return 1, payload
    renderer = render_result.get("renderer")
    if renderer == "python-fallback" and render_result.get("fallbackReason"):
        warnings.append(
            f"node render unavailable; used python-fallback: "
            f"{render_result.get('fallbackReason')}"
        )

    html_path = work_dir / "reports" / "final" / "final-summary.html"

    # --- 7. renderer consistency (layer 2) ---
    try:
        summary = read_json(summary_path)
    except (OSError, json.JSONDecodeError):
        pass
    validate_result = validate_summary(
        summary,
        html_path if html_path.is_file() else None,
    )
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

    # --- 9/10. final summary stats + render, then LAST manifest (IA-7) ---
    # Post-manifest rewrites of covered bytes are forbidden. We update summary /
    # HTML first, regenerate after-manifest last, then verify on-disk hashes.
    # If summary/html must still change after that, they are excluded with reasons.
    summary = read_json(summary_path)
    summary["archiveManifest"] = {
        "movedFiles": 0,
        "generatedFiles": 0,
        "totalArchiveFiles": 0,
        "checksumStatus": "PENDING",
    }
    write_json(summary_path, summary)
    render_result = render_final_summary(work_dir, summary_path)
    if not render_result.get("ok"):
        payload["error"] = f"final summary re-render failed: {render_result.get('error')}"
        _restore_finalize_failure()
        return 1, payload
    summary = read_json(summary_path)
    validate_result = validate_summary(summary, html_path if html_path.is_file() else None)
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
        coverage = verify_manifest_byte_coverage(work_dir, after_manifest)
        # Embed compare stats into summary AFTER manifest → must exclude those paths.
        summary = read_json(summary_path)
        summary["archiveManifest"] = {
            "movedFiles": compare_result.get("movedFiles", 0),
            "generatedFiles": compare_result.get("generatedFiles", 0),
            "totalArchiveFiles": compare_result.get("totalArchiveFiles", 0),
            "checksumStatus": coverage.get("checksumStatus", "FAIL"),
            "exclusionReasons": {
                "reports/final/summary-data.json": (
                    "archiveManifest stats written after coverage snapshot"
                ),
                "reports/final/final-summary.html": (
                    "re-rendered after coverage snapshot to display manifest stats"
                ),
            },
            **_manifest_self_stats(work_dir, after_manifest, after_path),
        }
        write_json(summary_path, summary)
        render_result = render_final_summary(work_dir, summary_path)
        if not render_result.get("ok"):
            payload["error"] = (
                f"post-manifest summary render failed: {render_result.get('error')}"
            )
            _restore_finalize_failure()
            return 1, payload
        coverage = verify_manifest_byte_coverage(
            work_dir,
            after_manifest,
            exclude_paths=[
                "reports/final/summary-data.json",
                "reports/final/final-summary.html",
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
        # Re-render once more for checksumStatus display; remain excluded.
        render_final_summary(work_dir, summary_path)
        summary = read_json(summary_path)
        validate_result = validate_summary(
            summary, html_path if html_path.is_file() else None
        )
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

    # Publish only after every validator passes. The archive path is never used
    # as mutable staging, so a failed attempt cannot poison the next retry.
    try:
        archive_root.mkdir(parents=True, exist_ok=True)
        shutil.move(str(operation_temp_dir), str(archive_dir))
        shutil.rmtree(operation_temp_dir.parent, ignore_errors=True)
        work_dir = archive_dir
        summary_path = work_dir / "reports" / "final" / "summary-data.json"
        html_path = work_dir / "reports" / "final" / "final-summary.html"
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

    # --- 12. maintenance outbox + service ---
    if skip_ingest:
        payload["steps"]["knowledge"] = {"skipped": True, "reason": "--skip-ingest"}
        payload["knowledgeMaintenance"] = "SKIPPED"
    else:
        try:
            enqueue = enqueue_maintenance_outbox(project_root, work_dir)
            payload["steps"]["knowledge"] = enqueue
            payload["knowledgeMaintenance"] = "QUEUED"
        except OSError as exc:
            warnings.append(f"maintenance outbox enqueue failed: {exc}")
            payload["steps"]["knowledge"] = {"queued": False, "error": str(exc)}
            payload["knowledgeMaintenance"] = "NOT_QUEUED"

    service_result = run_service_stop(work_dir)
    payload["steps"]["service_stop"] = service_result
    if service_result.get("warning"):
        warnings.append(str(service_result["warning"]))

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
            },
        )
    except OSError as exc:
        warnings.append(f"could not persist completed archive operation: {exc}")

    payload["ok"] = True
    payload["finalStatus"] = "OK"
    payload["warnings"] = warnings
    payload["summary_data"] = str(summary_path)
    payload["final_summary"] = str(html_path) if html_path.is_file() else None
    return 0, payload


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

    html_path = archive_dir / "reports" / "final" / "final-summary.html"
    render_skipped = not html_path.is_file()
    validate_result = validate_summary(
        summary,
        html_path if html_path.is_file() else None,
        render_skipped=render_skipped,
    )
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
    )
    emit_json(result)
    # Checks completed → exit 0; archivable flag conveys the gate result.
    return 0 if result.get("ok") else 1


def cmd_auto_gate_cli(args: argparse.Namespace) -> int:
    result = archive_auto_gate(
        resolve_path(args.change_dir),
        allow_missing_review=bool(getattr(args, "allow_missing_review", False)),
        archive_intent=str(getattr(args, "intent", "release-candidate")),
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
    code, payload = cmd_finalize(
        change_dir,
        archive_root,
        skip_ingest=bool(args.skip_ingest),
        allow_missing_review=bool(getattr(args, "allow_missing_review", False)),
        archive_intent=str(getattr(args, "intent", "release-candidate")),
    )
    emit_json(payload)
    return code


def cmd_replay_cli(args: argparse.Namespace) -> int:
    archive_dir = resolve_path(args.archive_dir)
    out_path = resolve_path(args.out) if getattr(args, "out", None) else None
    code, payload = cmd_replay(archive_dir, out_path=out_path)
    emit_json(payload)
    return code


def _render_html_to(
    change_dir: Path,
    summary_path: Path,
    out_path: Path,
) -> dict[str, Any]:
    """Render summary HTML to an arbitrary path (node first, python fallback).

    Unlike ``render_final_summary`` this never touches the canonical
    ``reports/final/final-summary.html`` — repair renders into staging.
    """
    project = find_project_root(change_dir)
    node = resolve_node_path(project)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if node and RENDER_SCRIPT.is_file():
        try:
            proc = subprocess.run(
                [node, str(RENDER_SCRIPT), "--summary", str(summary_path), "--out", str(out_path)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=60,
                check=False,
            )
            if proc.returncode == 0 and out_path.is_file():
                return {"ok": True, "renderer": "node", "out_path": str(out_path)}
        except (OSError, subprocess.TimeoutExpired):
            pass
    try:
        summary = read_json(summary_path)
        html = render_fallback_html(summary)
        out_path.write_text(html, encoding="utf-8", newline="\n")
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        return {"ok": False, "renderer": "none", "error": str(exc)}
    return {"ok": True, "renderer": "python-fallback", "out_path": str(out_path)}


def cmd_repair(archive_dir: Path) -> tuple[int, dict[str, Any]]:
    """Versioned repair (task 11 / RET-40).

    Re-collect a candidate from the frozen sources, run both validators, and
    only then write an immutable ``derived/v<N>/`` plus a repair record. The
    original summary/HTML/manifest is never overwritten; the authoritative
    pointer moves only when both validators pass.
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

    # 2. stage outside the archive; run both validators on the candidate.
    staging = Path(tempfile.mkdtemp(prefix="harness-repair-"))
    try:
        staged_summary = staging / "summary-data.json"
        write_json(staged_summary, candidate)
        source_result = validate_source_consistency(archive_dir, candidate)
        render_result = _render_html_to(
            archive_dir, staged_summary, staging / "final-summary.html"
        )
        staged_html = staging / "final-summary.html"
        renderer_result = validate_summary(
            candidate,
            staged_html if staged_html.is_file() else None,
        )
        payload["validators"] = {
            "source": source_result,
            "renderer": renderer_result,
        }
        if not (source_result.get("ok") and renderer_result.get("ok")):
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
        if staged_html.is_file():
            shutil.copy2(staged_html, staged_version_dir / "final-summary.html")
        record = {
            "version": version,
            "createdAt": now_iso(),
            "summarySha256": "sha256:" + hashlib.sha256(final_summary.read_bytes()).hexdigest(),
            "baseSummarySha256": "sha256:" + hashlib.sha256(summary_path.read_bytes()).hexdigest(),
            "frozenManifestHashes": frozen_manifest_hashes,
            "validators": {
                "source": {"ok": bool(source_result.get("ok")), "issues": source_result.get("issues") or []},
                "renderer": {"ok": bool(renderer_result.get("ok")), "issues": renderer_result.get("issues") or []},
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
    p_auto_gate.set_defaults(func=cmd_auto_gate_cli)

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

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
