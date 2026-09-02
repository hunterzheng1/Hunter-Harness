#!/usr/bin/env python3
"""Profile one archive execute with a realistic 1.3MB events.ndjson."""
import sys, os, json, shutil, tempfile, subprocess, time, cProfile, pstats
from pathlib import Path
REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "harness" / "scripts"))
sys.path.insert(0, str(REPO / ".auto"))
import bench_archive as ba
import harness_archive as ha
import harness_events as he

def seed_big_events(change: Path, feat: str, n_filler: int) -> None:
    note = "x" * 1400
    lines = []
    def ev(phase, type_, **kw):
        e = {"schema_version": 3, "id": he.new_event_id(), "timestamp": "2026-09-02T10:00:00+08:00",
             "phase": phase, "type": type_, "attempt": 1, "executor_tool": "codex", "note": ""}
        e.update(kw)
        lines.append(json.dumps(e, ensure_ascii=False))
    ev("plan", "phase.start", note="开始")
    ev("plan", "phase.end", status="OK")
    ev("execute", "phase.start")
    for i in range(n_filler):
        ev("execute", "command", command=f"python -m unittest batch-{i}", exit_code=0,
           duration_ms=120 + i, note=note)
    ev("execute", "verification", name="unitTest", status="ok")
    ev("execute", "phase.end", status="OK")
    ev("submit", "phase.start")
    ev("submit", "command", command="git push origin HEAD", exit_code=0,
       note=f"final pushed hash {feat}")
    ev("submit", "phase.end", status="OK")
    (change / "events.ndjson").write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")

tmp = Path(tempfile.mkdtemp(prefix="prof-biglog-"))
try:
    project = tmp / "proj"
    change = project / ".harness" / "changes" / "bench-change"
    archive_root = project / ".harness" / "archive"
    durable_root = tmp / "durable-store"
    change.mkdir(parents=True); archive_root.mkdir(); durable_root.mkdir()
    ba._write(project / ".gitattributes", ".harness/archive/** -text\n")
    ba._write(project / "f.txt", "0\n")
    ba._git(project, "init", "-q"); ba._git(project, "add", ".gitattributes", "f.txt")
    ba._git(project, "commit", "-q", "-m", "base")
    base = ba._git(project, "rev-parse", "HEAD")
    ba._write(change / "plans" / "demo-plan.md", "# plan\n\ngoal: demo archive\n")
    ba._write(change / "tests" / "test-report-20260710.md", "# Test Report\n\nunit: 3/3 passed\n")
    ba._write(change / "reports" / "review" / "review-report-20260710.md", "# Review\n\nADVISORY: no blocking issues\n")
    ba._build_tree(change, 100, 24)
    cap = subprocess.run([sys.executable, str(REPO/"harness/scripts/harness_state.py"), "capture", "--project", str(project), "--change-dir", str(change), "--json"], capture_output=True, text=True)
    assert cap.returncode == 0
    ba._write(project / "f.txt", "1\n"); ba._write(project / "feature.txt", "feature\n")
    ba._git(project, "add", "f.txt", "feature.txt"); ba._git(project, "commit", "-q", "-m", "change")
    feat = ba._git(project, "rev-parse", "HEAD")
    ba._write_json(change / "evidence" / "verification-ledger.json", {
        "changeName": change.name, "baseCommit": base, "finalCommit": feat,
        "mergeFinalHash": feat, "productCommit": feat, "archiveCommit": feat,
        "validations": {
            "unitTest": {"status": "OK", "command": "python -m unittest", "evidence": {"run": 3, "failures": 0, "errors": 0, "skipped": 0, "passRate": "3/3"}},
            "apiTest": {"status": "OK", "total": 1, "passed": 1, "failed": 0, "blocked": 0, "passRate": "1/1"},
            "dbCompatibility": {"status": "OK", "metrics": {"applicability": "NOT_APPLICABLE", "reason": "fixture"}},
        }})
    ba._write_json(change / "evidence" / "product-candidate-ci.json", {"schemaVersion": 1, "conclusion": "success", "commit": feat, "runUrl": "https://ci.example/runs/seed"})
    seed_big_events(change, feat, 790)
    from contextlib import redirect_stdout
    from io import StringIO
    buf = StringIO()
    prof = cProfile.Profile()
    t0 = time.perf_counter()
    prof.enable()
    with redirect_stdout(buf):
        code = ha.main(["execute", "--intent", "record-only", "--skip-ingest",
                        "--change-dir", str(change), "--archive-root", str(archive_root),
                        "--durable-root", str(durable_root), "--json"])
    prof.disable()
    el = time.perf_counter() - t0
    payload = json.loads(buf.getvalue())
    print("ok:", payload.get("ok"), f"TOTAL={el:.2f}s")
    prof.dump_stats(str(REPO / ".auto" / "biglog.prof"))
finally:
    shutil.rmtree(tmp, ignore_errors=True)
