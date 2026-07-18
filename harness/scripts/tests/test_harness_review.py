#!/usr/bin/env python3
"""harness_review.py sidecar tests (cluster B, task 7).

Covers UT-007/RET-17:
- findings/dispositions JSON schema validation and atomic writes;
- stable finding IDs (run + dimension + canonical path + line + normalized title);
- dispositions must reference existing finding IDs;
- missing disposition reports UNKNOWN — never silently counted as fixed;
- RED/YELLOW counts come from findings, not Markdown parsing.
"""

from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]


def load_module(name: str, filename: str):
    path = SCRIPTS_DIR / filename
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


review = load_module("harness_review", "harness_review.py")


def git(cwd: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=check,
    )


class ReviewFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-review-"))
        self.project = self.tmp / "project"
        self.project.mkdir(parents=True)
        git(self.project, "init")
        git(self.project, "config", "user.email", "test@example.com")
        git(self.project, "config", "user.name", "Test")
        (self.project / "README.md").write_text("demo\n", encoding="utf-8")
        git(self.project, "add", "README.md")
        git(self.project, "commit", "-m", "init")
        self.change_dir = self.project / ".harness" / "changes" / "demo"
        (self.change_dir / "meta").mkdir(parents=True)
        (self.change_dir / "meta" / "change-context.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 2,
                    "changeId": "demo",
                    "lifecycle": {"status": "active"},
                    "stateOwnership": {
                        "contractRoot": ".harness/changes/demo",
                        "runtimeRoot": ".harness/state/changes/demo",
                    },
                }
            ),
            encoding="utf-8",
        )
        self.state_dir = self.project / ".harness" / "state" / "changes" / "demo"

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def sample_findings(self) -> dict:
        return {
            "schemaVersion": 1,
            "runId": "review-run-1",
            "changeName": "demo",
            "findings": [
                {
                    "dimension": "architecture",
                    "severity": "RED",
                    "path": "src/app.py",
                    "line": 42,
                    "title": "God object accumulates responsibilities",
                    "detail": "split required",
                },
                {
                    "dimension": "security",
                    "severity": "RED",
                    "path": "src/auth.py",
                    "line": 7,
                    "title": "Token logged in plaintext",
                    "detail": "redact",
                },
                {
                    "dimension": "tests",
                    "severity": "YELLOW",
                    "path": "tests/test_app.py",
                    "line": 1,
                    "title": "Missing edge-case coverage",
                    "detail": "add cases",
                },
            ],
        }


class FindingIdTests(ReviewFixture):
    def test_stable_id_ignores_whitespace_and_case(self) -> None:
        one = review.stable_finding_id(
            "run-1", "security", "src/app.py", 10, "Token  Logged   Plaintext"
        )
        two = review.stable_finding_id(
            "run-1", "security", "src/app.py", 10, "token logged plaintext"
        )
        self.assertEqual(one, two)

    def test_id_changes_with_run(self) -> None:
        one = review.stable_finding_id("run-1", "security", "a.py", 1, "t")
        two = review.stable_finding_id("run-2", "security", "a.py", 1, "t")
        self.assertNotEqual(one, two)

    def test_id_changes_with_path_and_line(self) -> None:
        base = review.stable_finding_id("run-1", "security", "a.py", 1, "t")
        self.assertNotEqual(
            base, review.stable_finding_id("run-1", "security", "b.py", 1, "t")
        )
        self.assertNotEqual(
            base, review.stable_finding_id("run-1", "security", "a.py", 2, "t")
        )


class FindingsWriteTests(ReviewFixture):
    def test_write_findings_assigns_ids_and_atomic(self) -> None:
        doc = self.sample_findings()
        result = review.write_findings(self.change_dir, doc)
        self.assertTrue(result["ok"], result)
        out_path = self.state_dir / "reports" / "review" / "review-findings.json"
        self.assertTrue(out_path.is_file(), out_path)
        written = json.loads(out_path.read_text(encoding="utf-8"))
        ids = [f["id"] for f in written["findings"]]
        self.assertEqual(len(ids), len(set(ids)), "finding IDs must be unique")
        for fid in ids:
            self.assertTrue(fid.startswith("f-"), fid)

    def test_validate_findings_rejects_bad_severity(self) -> None:
        doc = self.sample_findings()
        doc["findings"][0]["severity"] = "CRITICAL"
        problems = review.validate_findings(doc)
        self.assertTrue(any("severity" in p for p in problems), problems)

    def test_validate_findings_requires_fields(self) -> None:
        problems = review.validate_findings({"findings": [{"title": "x"}]})
        self.assertTrue(problems)

    def test_write_findings_refuses_invalid_doc(self) -> None:
        doc = self.sample_findings()
        doc["findings"][0]["severity"] = "BOGUS"
        result = review.write_findings(self.change_dir, doc)
        self.assertFalse(result["ok"])
        out_path = self.state_dir / "reports" / "review" / "review-findings.json"
        self.assertFalse(out_path.exists())


class DispositionsTests(ReviewFixture):
    def _write_findings(self) -> dict:
        doc = self.sample_findings()
        result = review.write_findings(self.change_dir, doc)
        self.assertTrue(result["ok"], result)
        out_path = self.state_dir / "reports" / "review" / "review-findings.json"
        return json.loads(out_path.read_text(encoding="utf-8"))

    def test_dispositions_reference_existing_ids(self) -> None:
        written = self._write_findings()
        fid = written["findings"][0]["id"]
        result = review.write_dispositions(
            self.change_dir,
            {
                "schemaVersion": 1,
                "runId": "review-run-1",
                "dispositions": [
                    {"findingId": fid, "disposition": "FIXED", "note": "done"}
                ],
            },
        )
        self.assertTrue(result["ok"], result)

    def test_disposition_unknown_id_rejected(self) -> None:
        self._write_findings()
        result = review.write_dispositions(
            self.change_dir,
            {
                "schemaVersion": 1,
                "runId": "review-run-1",
                "dispositions": [
                    {"findingId": "f-nonexistent", "disposition": "FIXED"}
                ],
            },
        )
        self.assertFalse(result["ok"])

    def test_disposition_value_whitelist(self) -> None:
        written = self._write_findings()
        fid = written["findings"][0]["id"]
        for bad in ("RESOLVED", "WONTFIX", "done", ""):
            result = review.write_dispositions(
                self.change_dir,
                {
                    "schemaVersion": 1,
                    "runId": "review-run-1",
                    "dispositions": [{"findingId": fid, "disposition": bad}],
                },
            )
            self.assertFalse(result["ok"], bad)
        for good in ("OPEN", "FIXED", "ACCEPTED_RISK", "DEFERRED", "UNKNOWN"):
            result = review.write_dispositions(
                self.change_dir,
                {
                    "schemaVersion": 1,
                    "runId": "review-run-1",
                    "dispositions": [{"findingId": fid, "disposition": good}],
                },
            )
            self.assertTrue(result["ok"], good)


class StatusReconcileTests(ReviewFixture):
    def test_missing_disposition_is_unknown_not_fixed_ret17(self) -> None:
        result = review.write_findings(self.change_dir, self.sample_findings())
        self.assertTrue(result["ok"], result)
        status = review.status(self.change_dir)
        self.assertTrue(status["ok"], status)
        self.assertEqual(status["counts"]["RED"], 2)
        self.assertEqual(status["counts"]["YELLOW"], 1)
        dispositions = status["dispositions"]
        self.assertEqual(dispositions.get("FIXED", 0), 0)
        self.assertEqual(dispositions["UNKNOWN"], 3)
        for item in status["items"]:
            self.assertIn(item["disposition"], {"UNKNOWN"})

    def test_partial_dispositions_keep_counts(self) -> None:
        written = None
        result = review.write_findings(self.change_dir, self.sample_findings())
        self.assertTrue(result["ok"], result)
        out_path = self.state_dir / "reports" / "review" / "review-findings.json"
        written = json.loads(out_path.read_text(encoding="utf-8"))
        fid = written["findings"][0]["id"]
        review.write_dispositions(
            self.change_dir,
            {
                "schemaVersion": 1,
                "runId": "review-run-1",
                "dispositions": [{"findingId": fid, "disposition": "FIXED"}],
            },
        )
        status = review.status(self.change_dir)
        self.assertEqual(status["counts"]["RED"], 2)
        self.assertEqual(status["counts"]["YELLOW"], 1)
        self.assertEqual(status["dispositions"]["FIXED"], 1)
        self.assertEqual(status["dispositions"]["UNKNOWN"], 2)


if __name__ == "__main__":
    unittest.main()
