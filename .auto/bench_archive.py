#!/usr/bin/env python3
"""Benchmark the full archive execute flow on a synthetic change tree.

Seeds a realistic project (real git history: base commit -> feature commit),
a change dir (ledger + candidate CI + events + review + a 600-file / ~14MB
artifact tree), captures the archive-boundary state snapshot, then times one

  `harness_archive.py execute --intent record-only --skip-ingest --durable-root`

run in a subprocess and verifies the intermediate artifacts the flow promises:

- stdout JSON must be one complete parseable object (no lost JSON output)
- summary-data.json must exist, parse, and carry real identity fields
- meta/archive-execute-result.json must exist (execute result receipt)
- evidence/archive-manifest-before/after.json must exist
- durable archive + receipt must exist outside the project
- operation record + terminal event must exist

Emits METRIC lines for run_experiment.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SCRIPTS = REPO / "harness" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import harness_events as he  # noqa: E402

GIT_ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "bench",
    "GIT_AUTHOR_EMAIL": "bench@example.com",
    "GIT_COMMITTER_NAME": "bench",
    "GIT_COMMITTER_EMAIL": "bench@example.com",
}


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def _write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )


def _git(project: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", "-C", str(project), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=GIT_ENV,
        check=True,
    )
    return proc.stdout.strip()


def _seed_events(change_dir: Path, feature_hash: str) -> None:
    seq = [
        ["--phase", "plan", "--type", "phase.start", "--note", "开始"],
        ["--phase", "plan", "--type", "phase.end", "--status", "OK"],
        ["--phase", "execute", "--type", "phase.start"],
        [
            "--phase",
            "execute",
            "--type",
            "command",
            "--command",
            "python -m unittest",
            "--exit-code",
            "0",
            "--duration-ms",
            "500",
            "--note",
            "unit green",
        ],
        [
            "--phase",
            "execute",
            "--type",
            "verification",
            "--name",
            "unitTest",
            "--status",
            "ok",
        ],
        ["--phase", "execute", "--type", "phase.end", "--status", "OK"],
        ["--phase", "execute", "--type", "phase.start"],
        ["--phase", "execute", "--type", "phase.end", "--status", "OK"],
        ["--phase", "submit", "--type", "phase.start"],
        [
            "--phase",
            "submit",
            "--type",
            "command",
            "--command",
            "git push origin HEAD",
            "--exit-code",
            "0",
            "--note",
            f"final pushed hash {feature_hash}",
        ],
        ["--phase", "submit", "--type", "phase.end", "--status", "OK"],
    ]
    for args in seq:
        with contextlib.redirect_stdout(io.StringIO()):
            code = he.main(["--json", "append", "--change-dir", str(change_dir), *args])
        if code != 0:
            raise SystemExit(f"event seed failed: {args}")


def _build_tree(change_dir: Path, files: int, file_kb: int) -> tuple[int, int]:
    """Deterministic pseudo-random artifact tree under artifacts/."""
    total_bytes = 0
    for i in range(files):
        rel = Path("artifacts") / f"batch-{i // 50:03d}" / f"file-{i:05d}.dat"
        block = hashlib.sha256(f"bench:{i}".encode()).digest()
        data = block * (file_kb * 1024 // len(block))
        path = change_dir / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        total_bytes += len(data)
    return files, total_bytes


def run_scenario(args: argparse.Namespace, run_index: int) -> tuple[float, list[str], dict | None]:
    tmp = Path(tempfile.mkdtemp(prefix=f"harness-bench-archive-{run_index}-"))
    try:
        project = tmp / "proj"
        change = project / ".harness" / "changes" / "bench-change"
        archive_root = project / ".harness" / "archive"
        durable_root = tmp / "durable-store"
        change.mkdir(parents=True)
        archive_root.mkdir(parents=True)
        durable_root.mkdir(parents=True)

        # --- git history: base -> feature (real identity anchors) ---
        _write(project / ".gitattributes", ".harness/archive/** -text\n")
        _write(project / "f.txt", "0\n")
        _git(project, "init", "-q")
        _git(project, "add", ".gitattributes", "f.txt")
        _git(project, "commit", "-q", "-m", "base")
        base_hash = _git(project, "rev-parse", "HEAD")

        # --- change fixture (before snapshot so boundary = plan start) ---
        _write(change / "plans" / "demo-plan.md", "# plan\n\ngoal: demo archive\n")
        _write(
            change / "tests" / "test-report-20260710.md",
            "# Test Report\n\nunit: 3/3 passed\n",
        )
        _write(
            change / "reports" / "review" / "review-report-20260710.md",
            "# Review\n\nADVISORY: no blocking issues\n",
        )
        tree_files, tree_bytes = _build_tree(change, args.files, args.file_kb)

        # archive-boundary state snapshot (real flow requirement)
        capture = subprocess.run(
            [
                sys.executable,
                str(SCRIPTS / "harness_state.py"),
                "capture",
                "--project",
                str(project),
                "--change-dir",
                str(change),
                "--json",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=str(REPO),
            timeout=300,
        )
        if capture.returncode != 0:
            raise SystemExit(f"state snapshot capture failed: {capture.stderr[:2000]}")

        # feature commit
        _write(project / "f.txt", "1\n")
        _write(project / "feature.txt", "feature\n")
        _git(project, "add", "f.txt", "feature.txt")
        _git(project, "commit", "-q", "-m", "change")
        feature_hash = _git(project, "rev-parse", "HEAD")

        # --- ledger + candidate CI with real identity ---
        _write_json(
            change / "evidence" / "verification-ledger.json",
            {
                "changeName": change.name,
                "baseCommit": base_hash,
                "finalCommit": feature_hash,
                "mergeFinalHash": feature_hash,
                "productCommit": feature_hash,
                "archiveCommit": feature_hash,
                "validations": {
                    "unitTest": {
                        "status": "OK",
                        "command": "python -m unittest",
                        "evidence": {
                            "run": 3,
                            "failures": 0,
                            "errors": 0,
                            "skipped": 0,
                            "passRate": "3/3",
                        },
                    },
                    "apiTest": {
                        "status": "OK",
                        "total": 1,
                        "passed": 1,
                        "failed": 0,
                        "blocked": 0,
                        "passRate": "1/1",
                    },
                    "dbCompatibility": {
                        "status": "OK",
                        "metrics": {
                            "applicability": "NOT_APPLICABLE",
                            "reason": "archive unit fixture has no database surface",
                        },
                    },
                },
            },
        )
        _write_json(
            change / "evidence" / "product-candidate-ci.json",
            {
                "schemaVersion": 1,
                "conclusion": "success",
                "commit": feature_hash,
                "runUrl": "https://ci.example/runs/seed",
            },
        )
        _seed_events(change, feature_hash)

        t0 = time.perf_counter()
        run_cmd = [
            sys.executable,
            str(SCRIPTS / "harness_archive.py"),
            "execute",
            "--intent",
            "record-only",
            "--skip-ingest",
            "--change-dir",
            str(change),
            "--archive-root",
            str(archive_root),
            "--durable-root",
            str(durable_root),
            "--json",
        ]
        profile_out = tmp / "archive.prof"
        if os.environ.get("BENCH_PROFILE"):
            run_cmd = [
                sys.executable,
                "-m",
                "cProfile",
                "-o",
                str(profile_out),
                str(SCRIPTS / "harness_archive.py"),
                *run_cmd[2:],
            ]
        proc = subprocess.run(
            run_cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=str(REPO),
            timeout=600,
        )
        elapsed = time.perf_counter() - t0
        if os.environ.get("BENCH_PROFILE") and profile_out.is_file():
            shutil.copyfile(profile_out, REPO / ".auto" / "last_archive.prof")
            print("# profile: .auto/last_archive.prof", file=sys.stderr)

        failures: list[str] = []
        stdout = proc.stdout.strip()
        payload: dict | None = None
        try:
            payload = json.loads(stdout)
        except (json.JSONDecodeError, ValueError) as exc:
            failures.append(f"stdout-json-invalid: {exc}; head={stdout[:200]!r}")
        if payload is not None:
            if not payload.get("ok"):
                failures.append(
                    f"payload-not-ok: {payload.get('reasonCode')} {payload.get('error')}"
                )
            archive_dir = Path(str(payload.get("archive_dir") or ""))
            if not archive_dir.is_dir():
                failures.append("archive-dir-missing")
            else:
                summary_path = archive_dir / "reports" / "final" / "summary-data.json"
                if not summary_path.is_file():
                    failures.append("summary-data-missing")
                else:
                    try:
                        summary = json.loads(summary_path.read_text(encoding="utf-8"))
                    except (OSError, json.JSONDecodeError) as exc:
                        failures.append(f"summary-data-unparseable: {exc}")
                        summary = {}
                    if summary.get("baseCommit") != base_hash:
                        failures.append(
                            f"identity-baseCommit-drift: {summary.get('baseCommit')}"
                        )
                    if summary.get("finalCommit") != feature_hash:
                        failures.append(
                            f"identity-finalCommit-drift: {summary.get('finalCommit')}"
                        )
                    diff_stat = summary.get("diffStat") or {}
                    if not diff_stat.get("filesChanged"):
                        failures.append("identity-diffStat-empty")
                for rel in (
                    "meta/archive-execute-result.json",
                    "evidence/archive-manifest-before.json",
                    "evidence/archive-manifest-after.json",
                ):
                    if not (archive_dir / rel).is_file():
                        failures.append(f"artifact-missing:{rel}")
                    else:
                        try:
                            json.loads((archive_dir / rel).read_text(encoding="utf-8"))
                        except (OSError, json.JSONDecodeError) as exc:
                            failures.append(f"artifact-unparseable:{rel}: {exc}")
            durability = payload.get("archiveDurability") or {}
            if durability.get("status") not in {"ARCHIVED_DURABLE", "ARCHIVED_LOCAL_ONLY"}:
                failures.append(f"durability-unexpected: {durability.get('status')}")
            steps = payload.get("steps") or {}
            for step in (
                "before_manifest",
                "after_manifest",
                "collect",
                "source_consistency",
                "report_adequacy",
                "validate",
            ):
                if not isinstance(steps.get(step), dict):
                    failures.append(f"step-missing:{step}")
        if proc.returncode != 0:
            failures.append(f"exit-code-nonzero: {proc.returncode}")
        if not failures and payload is not None:
            # Per-step info (analysis only, not a METRIC).
            print(f"# run{run_index} steps: {json.dumps(sorted(payload.get('steps') or {}))}")
            print(
                f"# run{run_index} durability: "
                f"{(payload.get('archiveDurability') or {}).get('status')}"
            )
        if proc.stderr.strip():
            head = proc.stderr.strip()[:2000]
            print(f"# run{run_index} stderr head: {head}", file=sys.stderr)
        return elapsed, failures, payload
    finally:
        if args.keep:
            print(f"# fixture kept at {tmp}", file=sys.stderr)
        else:
            shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--files", type=int, default=600)
    parser.add_argument("--file-kb", type=int, default=24)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--keep", action="store_true", help="keep fixture for debugging")
    args = parser.parse_args()

    elapsed_values: list[float] = []
    all_failures: list[str] = []
    for run_index in range(args.runs):
        elapsed, failures, _payload = run_scenario(args, run_index)
        elapsed_values.append(elapsed)
        print(f"# run {run_index + 1}/{args.runs}: {elapsed:.2f}s failures={len(failures)}")
        all_failures.extend(f"run{run_index + 1}:{item}" for item in failures)
        if failures:
            break
    elapsed_values.sort()
    median = elapsed_values[len(elapsed_values) // 2]
    print(f"METRIC archive_seconds={median:.2f}")
    print(f"METRIC integrity_failures={len(all_failures)}")
    print(f"METRIC tree_files={args.files}")
    print(f"METRIC tree_mb={(args.files * args.file_kb) / 1024:.1f}")
    for failure in all_failures:
        print(f"INTEGRITY-FAILURE {failure}", file=sys.stderr)
    return 0 if not all_failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
