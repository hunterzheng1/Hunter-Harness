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
                    "fixbackAction": "code",
                },
                {
                    "dimension": "security",
                    "severity": "RED",
                    "path": "src/auth.py",
                    "line": 7,
                    "title": "Token logged in plaintext",
                    "detail": "redact",
                    "fixbackAction": "code",
                },
                {
                    "dimension": "tests",
                    "severity": "YELLOW",
                    "path": "tests/test_app.py",
                    "line": 1,
                    "title": "Missing edge-case coverage",
                    "detail": "add cases",
                    "fixbackAction": "code",
                },
            ],
        }


class FindingIdTests(ReviewFixture):
    def test_scaffold_without_findings_emits_findings_template_from_events(self) -> None:
        """无 findings sidecar 时，scaffold 从 events.ndjson 提取 runId 并生成 findings 骨架。"""
        self.state_dir.mkdir(parents=True, exist_ok=True)
        (self.state_dir / "events.ndjson").write_text(
            json.dumps({
                "type": "phase.start", "phase": "review", "run_id": "review-run-99",
            }) + "\n",
            encoding="utf-8",
        )
        res = review.scaffold(self.change_dir, run_id=None)
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["code"], "REVIEW_SCAFFOLD_FINDINGS")
        self.assertEqual(res["runId"], "review-run-99")
        self.assertEqual(res["findingsInput"]["runId"], "review-run-99")
        self.assertEqual(res["findingsInput"]["findings"], [])
        self.assertIn("write-findings", res["writeCommand"])

    def test_scaffold_with_findings_emits_dispositions_template_with_matching_run_id(self) -> None:
        """已有 findings 时，scaffold 为每条 finding 生成 OPEN 处置并复用同轮 runId。"""
        written = review.write_findings(self.change_dir, self.sample_findings())
        self.assertTrue(written["ok"], written)
        res = review.scaffold(self.change_dir, run_id=None)
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["code"], "REVIEW_SCAFFOLD_DISPOSITIONS")
        self.assertEqual(res["runId"], "review-run-1")
        disps = res["dispositionsInput"]["dispositions"]
        self.assertEqual(len(disps), 3)
        self.assertTrue(all(d["disposition"] == "OPEN" for d in disps))
        self.assertTrue(all(d["findingId"].startswith("f-") for d in disps))
        self.assertIn("write-dispositions", res["writeCommand"])

        # 骨架可直接经 validate_dispositions 校验通过（无非法字段/未知 id）
        findings_doc = review._load_findings(self.change_dir)
        known_ids = {f["id"] for f in findings_doc["findings"]}
        problems = review.validate_dispositions(
            res["dispositionsInput"], known_ids, findings_doc["runId"]
        )
        self.assertEqual(problems, [])

    def test_scaffold_fails_cleanly_when_no_run_id_resolvable(self) -> None:
        """无法推断 runId 时报错并提示显式传 --run-id。"""
        res = review.scaffold(self.change_dir, run_id=None)
        self.assertFalse(res["ok"], res)
        self.assertEqual(res["code"], "SCAFFOLD_RUN_ID_REQUIRED")
        self.assertIn("--run-id", res["problems"][0])

    def test_stable_id_ignores_whitespace_and_case(self) -> None:
        one = review.stable_finding_id(
            "security", "src/app.py", 10, "Token  Logged   Plaintext"
        )
        two = review.stable_finding_id(
            "security", "src/app.py", 10, "token logged plaintext"
        )
        self.assertEqual(one, two)

    def test_id_changes_with_path_and_line(self) -> None:
        base = review.stable_finding_id("security", "a.py", 1, "t")
        self.assertNotEqual(
            base, review.stable_finding_id("security", "b.py", 1, "t")
        )
        self.assertNotEqual(
            base, review.stable_finding_id("security", "a.py", 2, "t")
        )

    def test_id_changes_with_dimension_and_title(self) -> None:
        base = review.stable_finding_id("security", "a.py", 1, "t")
        self.assertNotEqual(
            base, review.stable_finding_id("architecture", "a.py", 1, "t")
        )
        self.assertNotEqual(
            base, review.stable_finding_id("security", "a.py", 1, "other")
        )


class CrossRoundIdentityTests(ReviewFixture):
    """WI-3.1 步骤①：finding id 去 runId 化——同一问题跨轮保持同一 id。"""

    def _written(self) -> dict:
        out_path = self.state_dir / "reports" / "review" / "review-findings.json"
        return json.loads(out_path.read_text(encoding="utf-8"))

    def test_same_problem_keeps_id_and_first_seen_across_runs(self) -> None:
        first = review.write_findings(self.change_dir, self.sample_findings())
        self.assertTrue(first["ok"], first)
        ids_round1 = [f["id"] for f in self._written()["findings"]]

        doc = self.sample_findings()
        doc["runId"] = "review-run-2"
        second = review.write_findings(self.change_dir, doc)
        self.assertTrue(second["ok"], second)
        round2 = self._written()

        # WI-3.4：sidecar 升 schemaVersion 3（顶层 diffScope）；
        # id 与 firstSeenRunId 语义不变，跨轮一致性仍须成立。
        self.assertEqual(round2["schemaVersion"], 3)
        ids_round2 = [f["id"] for f in round2["findings"]]
        self.assertEqual(ids_round1, ids_round2, "同一问题跨轮必须保持同一 id")
        for finding in round2["findings"]:
            self.assertEqual(finding["firstSeenRunId"], "review-run-1")
            self.assertEqual(finding["lastSeenRunId"], "review-run-2")

    def test_new_problem_in_later_run_gets_current_run_as_first_seen(self) -> None:
        first = review.write_findings(self.change_dir, self.sample_findings())
        self.assertTrue(first["ok"], first)

        doc = self.sample_findings()
        doc["runId"] = "review-run-2"
        doc["findings"][2]["title"] = "A brand new problem"
        second = review.write_findings(self.change_dir, doc)
        self.assertTrue(second["ok"], second)
        findings = self._written()["findings"]

        self.assertEqual(findings[0]["firstSeenRunId"], "review-run-1")
        self.assertEqual(findings[1]["firstSeenRunId"], "review-run-1")
        self.assertEqual(findings[2]["firstSeenRunId"], "review-run-2")
        self.assertEqual(findings[2]["lastSeenRunId"], "review-run-2")


class CarryoverMergeTests(ReviewFixture):
    """WI-3.1 步骤③：重评审轮 write-findings 合并携带项（fail-closed 防丢失）。"""

    def _write_carryover_receipt(self, carried: list[str]) -> None:
        receipt_dir = self.state_dir / "runtime" / "invalidations"
        receipt_dir.mkdir(parents=True, exist_ok=True)
        (receipt_dir / "review-carryover-fb-1.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "batchId": "fb-1",
                    "carriedOverIds": carried,
                    "invalidatedIds": [],
                    "expandedSignals": [],
                    "findings": [],
                }
            ),
            encoding="utf-8",
        )

    def _written(self) -> dict:
        out_path = self.state_dir / "reports" / "review" / "review-findings.json"
        return json.loads(out_path.read_text(encoding="utf-8"))

    def test_carried_finding_absent_from_resubmission_is_merged_back(self) -> None:
        first = review.write_findings(self.change_dir, self.sample_findings())
        self.assertTrue(first["ok"], first)
        round1 = self._written()
        carried_id = round1["findings"][0]["id"]
        self._write_carryover_receipt([carried_id])

        # 第二轮模型只重新上报了后两个 finding，携带项未上报
        doc = self.sample_findings()
        doc["runId"] = "review-run-2"
        doc["findings"] = doc["findings"][1:]
        second = review.write_findings(self.change_dir, doc)
        self.assertTrue(second["ok"], second)

        merged = self._written()
        merged_ids = [f["id"] for f in merged["findings"]]
        self.assertIn(carried_id, merged_ids, "携带项必须合并回来，不能静默丢失")
        carried_entry = next(f for f in merged["findings"] if f["id"] == carried_id)
        self.assertTrue(carried_entry["carriedOver"])
        self.assertEqual(carried_entry["firstSeenRunId"], "review-run-1")
        self.assertEqual(carried_entry["lastSeenRunId"], "review-run-1")

    def test_resubmitted_finding_is_not_marked_carried(self) -> None:
        first = review.write_findings(self.change_dir, self.sample_findings())
        self.assertTrue(first["ok"], first)
        round1 = self._written()
        carried_id = round1["findings"][0]["id"]
        self._write_carryover_receipt([carried_id])

        doc = self.sample_findings()
        doc["runId"] = "review-run-2"
        second = review.write_findings(self.change_dir, doc)
        self.assertTrue(second["ok"], second)

        merged = self._written()
        entry = next(f for f in merged["findings"] if f["id"] == carried_id)
        self.assertNotIn("carriedOver", entry, "重新上报的项不是携带项")


class DispositionInheritanceTests(ReviewFixture):
    """WI-3.1 步骤③：write-dispositions 自动继承携带项的上一轮处置。"""

    def _seed_round1(self) -> dict:
        first = review.write_findings(self.change_dir, self.sample_findings())
        self.assertTrue(first["ok"], first)
        out_path = self.state_dir / "reports" / "review" / "review-findings.json"
        round1 = json.loads(out_path.read_text(encoding="utf-8"))
        dispositions = [
            {"findingId": f["id"], "disposition": "FIXED"}
            for f in round1["findings"]
        ]
        written = review.write_dispositions(
            self.change_dir,
            {"runId": "review-run-1", "dispositions": dispositions},
        )
        self.assertTrue(written["ok"], written)
        return round1

    def _write_carryover_receipt(self, carried: list[str]) -> None:
        receipt_dir = self.state_dir / "runtime" / "invalidations"
        receipt_dir.mkdir(parents=True, exist_ok=True)
        (receipt_dir / "review-carryover-fb-1.json").write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "batchId": "fb-1",
                    "carriedOverIds": carried,
                    "invalidatedIds": [],
                    "expandedSignals": [],
                    "findings": [],
                }
            ),
            encoding="utf-8",
        )

    def _dispositions_doc(self) -> dict:
        path = self.state_dir / "reports" / "review" / "fixback-dispositions.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def _resubmit_round2(self) -> list[dict]:
        """第二轮只重新上报后两个 finding，返回合并后 sidecar 的非携带项。"""
        doc = self.sample_findings()
        doc["runId"] = "review-run-2"
        doc["findings"] = doc["findings"][1:]
        second = review.write_findings(self.change_dir, doc)
        self.assertTrue(second["ok"], second)
        out_path = self.state_dir / "reports" / "review" / "review-findings.json"
        merged = json.loads(out_path.read_text(encoding="utf-8"))
        return [f for f in merged["findings"] if not f.get("carriedOver")]

    def test_carried_disposition_is_inherited_with_provenance(self) -> None:
        round1 = self._seed_round1()
        carried_id = round1["findings"][0]["id"]
        self._write_carryover_receipt([carried_id])

        # 第二轮：携带项未重新上报（合并回 sidecar），模型只处置新发现
        resubmitted = self._resubmit_round2()
        written = review.write_dispositions(
            self.change_dir,
            {
                "runId": "review-run-2",
                "dispositions": [
                    {"findingId": f["id"], "disposition": "OPEN"}
                    for f in resubmitted
                ],
            },
        )
        self.assertTrue(written["ok"], written)

        result = self._dispositions_doc()
        by_id = {d["findingId"]: d for d in result["dispositions"]}
        self.assertIn(carried_id, by_id, "携带项处置必须自动继承")
        self.assertEqual(by_id[carried_id]["disposition"], "FIXED")
        self.assertEqual(by_id[carried_id]["inheritedFromRunId"], "review-run-1")
        self.assertEqual(result["runId"], "review-run-2")

    def test_inherited_entry_not_required_in_model_submission(self) -> None:
        round1 = self._seed_round1()
        carried_id = round1["findings"][0]["id"]
        self._write_carryover_receipt([carried_id])
        resubmitted = self._resubmit_round2()
        written = review.write_dispositions(
            self.change_dir,
            {
                "runId": "review-run-2",
                "dispositions": [
                    {"findingId": f["id"], "disposition": "OPEN"}
                    for f in resubmitted
                ],
            },
        )
        self.assertTrue(written["ok"], written)


class AnchorTests(ReviewFixture):
    """WI-3.1 步骤①：finding 锚点（行 ±2 行规范化文本哈希）。"""

    def _write_source(self) -> None:
        src = self.project / "src"
        src.mkdir(exist_ok=True)
        content = "".join(f"line {i}\n" for i in range(1, 11))
        (src / "app.py").write_text(content, encoding="utf-8")

    def _doc(self, *, path: str = "src/app.py", line: int = 5) -> dict:
        return {
            "schemaVersion": 1,
            "runId": "review-run-1",
            "changeName": "demo",
            "findings": [
                {
                    "dimension": "correctness",
                    "severity": "YELLOW",
                    "path": path,
                    "line": line,
                    "title": "some problem",
                    "fixbackAction": "code",
                }
            ],
        }

    def _written_anchor(self) -> dict:
        out_path = self.state_dir / "reports" / "review" / "review-findings.json"
        doc = json.loads(out_path.read_text(encoding="utf-8"))
        return doc["findings"][0]["anchors"]

    def test_resolvable_anchor_captures_context_window(self) -> None:
        self._write_source()
        result = review.write_findings(self.change_dir, self._doc())
        self.assertTrue(result["ok"], result)
        anchor = self._written_anchor()
        self.assertEqual(anchor["path"], "src/app.py")
        self.assertFalse(anchor["unresolvable"])
        self.assertTrue(str(anchor["contextHash"]).startswith("sha256:"))

    def test_anchor_ignores_changes_outside_context_window(self) -> None:
        self._write_source()
        review.write_findings(self.change_dir, self._doc(line=1))
        before = self._written_anchor()["contextHash"]
        # 第 10 行在 line=1 的 ±2 窗口之外
        path = self.project / "src" / "app.py"
        text = path.read_text(encoding="utf-8").replace("line 10", "line ten")
        path.write_text(text, encoding="utf-8")
        review.write_findings(self.change_dir, self._doc(line=1))
        after = self._written_anchor()["contextHash"]
        self.assertEqual(before, after)

    def test_anchor_drifts_when_context_window_changes(self) -> None:
        self._write_source()
        review.write_findings(self.change_dir, self._doc(line=5))
        before = self._written_anchor()["contextHash"]
        path = self.project / "src" / "app.py"
        text = path.read_text(encoding="utf-8").replace("line 5", "line five")
        path.write_text(text, encoding="utf-8")
        review.write_findings(self.change_dir, self._doc(line=5))
        after = self._written_anchor()["contextHash"]
        self.assertNotEqual(before, after)

    def test_anchor_unresolvable_for_missing_file(self) -> None:
        review.write_findings(self.change_dir, self._doc(path="src/nope.py"))
        anchor = self._written_anchor()
        self.assertTrue(anchor["unresolvable"])
        self.assertIsNone(anchor["contextHash"])

    def test_anchor_unresolvable_for_directory_path(self) -> None:
        self._write_source()
        review.write_findings(self.change_dir, self._doc(path="src/"))
        self.assertTrue(self._written_anchor()["unresolvable"])

    def test_anchor_unresolvable_for_out_of_range_line(self) -> None:
        self._write_source()
        review.write_findings(self.change_dir, self._doc(line=99))
        self.assertTrue(self._written_anchor()["unresolvable"])


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

    def test_validate_findings_requires_a_supported_fixback_action(self) -> None:
        doc = self.sample_findings()
        del doc["findings"][0]["fixbackAction"]
        doc["findings"][1]["fixbackAction"] = "advice"
        problems = review.validate_findings(doc)
        self.assertTrue(any("fixbackAction is required" in item for item in problems), problems)
        self.assertTrue(any("fixbackAction must be one of" in item for item in problems), problems)

    def test_write_findings_refuses_invalid_doc(self) -> None:
        doc = self.sample_findings()
        doc["findings"][0]["severity"] = "BOGUS"
        result = review.write_findings(self.change_dir, doc)
        self.assertFalse(result["ok"])
        out_path = self.state_dir / "reports" / "review" / "review-findings.json"
        self.assertFalse(out_path.exists())

    def test_write_findings_auto_fills_run_id_from_events(self) -> None:
        """B2-6：缺 runId 时自动取当前 review run（events 最近一轮 phase.start）。"""
        self.state_dir.mkdir(parents=True, exist_ok=True)
        (self.state_dir / "events.ndjson").write_text(
            json.dumps({
                "type": "phase.start", "phase": "review", "run_id": "review-run-77",
            }) + "\n",
            encoding="utf-8",
        )
        doc = self.sample_findings()
        del doc["runId"]
        result = review.write_findings(self.change_dir, doc)
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["runIdAutoFilled"], "review-run-77")
        out_path = self.state_dir / "reports" / "review" / "review-findings.json"
        written = json.loads(out_path.read_text(encoding="utf-8"))
        self.assertEqual(written["runId"], "review-run-77")

    def test_write_findings_explicit_run_id_wins_over_events(self) -> None:
        """显式给出的 runId 始终优先，自动回填不覆盖。"""
        self.state_dir.mkdir(parents=True, exist_ok=True)
        (self.state_dir / "events.ndjson").write_text(
            json.dumps({
                "type": "phase.start", "phase": "review", "run_id": "review-run-77",
            }) + "\n",
            encoding="utf-8",
        )
        result = review.write_findings(self.change_dir, self.sample_findings())
        self.assertTrue(result["ok"], result)
        self.assertNotIn("runIdAutoFilled", result)
        out_path = self.state_dir / "reports" / "review" / "review-findings.json"
        written = json.loads(out_path.read_text(encoding="utf-8"))
        self.assertEqual(written["runId"], "review-run-1")

    def test_write_findings_invalid_without_run_id_reports_current_run(self) -> None:
        """B2-6：无 events 可回填且文档无效时，错误信封带 currentRunId（如有）。"""
        self.state_dir.mkdir(parents=True, exist_ok=True)
        (self.state_dir / "events.ndjson").write_text(
            json.dumps({
                "type": "phase.start", "phase": "review", "run_id": "review-run-88",
            }) + "\n",
            encoding="utf-8",
        )
        doc = self.sample_findings()
        del doc["runId"]
        doc["findings"][0]["severity"] = "BOGUS"
        result = review.write_findings(self.change_dir, doc)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "FINDINGS_INVALID")
        self.assertEqual(result["currentRunId"], "review-run-88")
        out_path = self.state_dir / "reports" / "review" / "review-findings.json"
        self.assertFalse(out_path.exists())


class DispositionsTests(ReviewFixture):
    def _write_findings(self) -> dict:
        doc = self.sample_findings()
        result = review.write_findings(self.change_dir, doc)
        self.assertTrue(result["ok"], result)
        out_path = self.state_dir / "reports" / "review" / "review-findings.json"
        return json.loads(out_path.read_text(encoding="utf-8"))

    def test_dispositions_without_a_run_id_are_refused(self) -> None:
        """写入端以前完全不看 runId，写 None 都能落盘。

        整条 sidecar 的强制力压在 gate 关门时的一行断言上，而那条断言防的是
        fixback 循环里的跨轮重放：sidecar 是 per-change 单文件、不带 runId 后缀，
        第二轮 review 关门时磁盘上躺着第一轮那份（finding 全已 FIXED）。
        """
        written = self._write_findings()
        fid = written["findings"][0]["id"]

        result = review.write_dispositions(
            self.change_dir,
            {"schemaVersion": 1, "dispositions": [
                {"findingId": fid, "disposition": "FIXED", "note": "done"}]},
        )

        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "DISPOSITIONS_INVALID")
        self.assertIn("runId is required", result["problems"])
        # 拒绝必须发生在落盘之前。
        self.assertFalse(
            (self.state_dir / "reports" / "review" / "fixback-dispositions.json").is_file()
        )

    def test_dispositions_from_another_round_are_refused(self) -> None:
        """跨轮重放在写入端就挡住，而不是等到关门。"""
        written = self._write_findings()
        fid = written["findings"][0]["id"]

        result = review.write_dispositions(
            self.change_dir,
            {"schemaVersion": 1, "runId": "review-run-0", "dispositions": [
                {"findingId": fid, "disposition": "FIXED", "note": "done"}]},
        )

        self.assertFalse(result["ok"], result)
        self.assertEqual(result["code"], "DISPOSITIONS_INVALID")
        self.assertTrue(
            any("does not match review findings runId" in p for p in result["problems"]),
            result["problems"],
        )

    def test_a_blank_run_id_is_not_a_run_id(self) -> None:
        written = self._write_findings()
        fid = written["findings"][0]["id"]

        result = review.write_dispositions(
            self.change_dir,
            {"schemaVersion": 1, "runId": "   ", "dispositions": [
                {"findingId": fid, "disposition": "FIXED"}]},
        )

        self.assertFalse(result["ok"], result)

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
        for good in (
            "OPEN",
            "FIXED",
            "ACCEPTED_RISK",
            "DEFERRED",
            "NOT_APPLICABLE",
            "UNKNOWN",
        ):
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

    def test_current_risks_exclude_fixed_and_not_applicable_findings(self) -> None:
        self.assertTrue(
            review.write_findings(self.change_dir, self.sample_findings())["ok"]
        )
        written = json.loads(
            (
                self.state_dir / "reports" / "review" / "review-findings.json"
            ).read_text(encoding="utf-8")
        )
        dispositions = [
            {"findingId": written["findings"][0]["id"], "disposition": "FIXED"},
            {
                "findingId": written["findings"][1]["id"],
                "disposition": "NOT_APPLICABLE",
            },
            {"findingId": written["findings"][2]["id"], "disposition": "OPEN"},
        ]
        self.assertTrue(
            review.write_dispositions(
                self.change_dir,
                {
                    "schemaVersion": 1,
                    "runId": "review-run-1",
                    "dispositions": dispositions,
                },
            )["ok"]
        )
        status = review.status(self.change_dir)
        self.assertEqual(status["currentRiskCount"], 1)
        self.assertEqual(
            [item["disposition"] for item in status["currentRisks"]],
            ["OPEN"],
        )


class ReviewSkillWiringTests(unittest.TestCase):
    def test_canonical_skill_writes_structured_sidecars(self) -> None:
        text = (SCRIPTS_DIR.parent / "harness-review" / "SKILL.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("harness_review.py write-findings", text)
        self.assertIn("harness_review.py write-dispositions", text)
        self.assertIn("review-findings.json", text)


class DispatchReviewTests(ReviewFixture):
    """C11: dispatch_review 有界等待 — 返回 reviewTaskId/deadline/heartbeatAt。"""

    def test_dispatch_returns_required_fields(self) -> None:
        result = review.dispatch_review(
            change_dir=self.change_dir,
            run_id="review-run-1",
            budget_seconds=300,
        )
        self.assertTrue(result.get("ok"))
        self.assertIn("reviewTaskId", result)
        self.assertIn("deadline", result)
        self.assertIn("heartbeatAt", result)
        # reviewTaskId is non-empty
        self.assertTrue(str(result["reviewTaskId"]))
        # deadline is ISO-format after now
        self.assertTrue(str(result["deadline"]))

    def test_dispatch_default_budget_300s(self) -> None:
        result = review.dispatch_review(
            change_dir=self.change_dir,
            run_id="review-run-1",
        )
        self.assertTrue(result.get("ok"))
        # default budget is 300s — deadline should be ~300s in the future
        import datetime as dt
        deadline = dt.datetime.fromisoformat(result["deadline"])
        now = dt.datetime.now(deadline.tzinfo)
        delta = (deadline - now).total_seconds()
        # allow some slack
        self.assertGreater(delta, 280)
        self.assertLess(delta, 310)


class PartialFindingsTests(ReviewFixture):
    """C11: 超时后收集 partial findings + 降级矩阵。"""

    def test_collect_partial_findings_on_timeout(self) -> None:
        # Simulate a partial review: some dimensions completed, some not
        partial = review.collect_partial_findings(
            change_dir=self.change_dir,
            run_id="review-run-1",
            completed_dimensions=["architecture", "security"],
            pending_dimensions=["tests", "performance"],
        )
        self.assertTrue(partial.get("ok"))
        self.assertEqual(partial["code"], "PARTIAL_FINDINGS")
        self.assertIn("completedDimensions", partial)
        self.assertEqual(partial["completedDimensions"], ["architecture", "security"])
        self.assertIn("degradationMatrix", partial)

    def test_degradation_matrix_subagent_timeout_falls_back_to_main(self) -> None:
        matrix = review.degradation_matrix(
            subagent_timed_out=True,
            main_session_available=True,
        )
        self.assertEqual(matrix["fallback"], "main-session")
        self.assertEqual(matrix["status"], "DEGRADED")

    def test_degradation_matrix_main_session_fails_advisory(self) -> None:
        matrix = review.degradation_matrix(
            subagent_timed_out=True,
            main_session_available=False,
        )
        self.assertEqual(matrix["fallback"], "advisory")
        self.assertEqual(matrix["status"], "ADVISORY")


class CodeGraphIdentityTests(ReviewFixture):
    """C12: CodeGraph identity 校验。"""

    def test_validate_identity_passes_on_match(self) -> None:
        result = review.validate_codegraph_identity(
            response={
                "repositoryId": "sha256:abc",
                "rootPath": str(self.project),
                "worktreeId": None,
                "head": "def456",
                "indexSnapshotAt": "2026-07-21T10:00:00+08:00",
            },
            expected_repository_id="sha256:abc",
            expected_head="def456",
            expected_root=self.project,
            expected_worktree_id=None,
        )
        self.assertTrue(result.get("ok"))
        self.assertEqual(result["code"], "IDENTITY_OK")
        self.assertEqual(result["evidence"]["rootPath"], str(self.project))
        self.assertIn("worktreeId", result["evidence"])
        self.assertIn("head", result["evidence"])
        self.assertIn("indexSnapshotAt", result["evidence"])

    def test_cg_identity_01_main_evidence_rejected_for_feature_worktree(self) -> None:
        """CG-IDENTITY-01: identical repository/head never masks a root mismatch."""
        result = review.validate_codegraph_identity(
            response={
                "repositoryId": "sha256:abc",
                "rootPath": str(self.project),
                "worktreeId": None,
                "head": "def456",
                "indexSnapshotAt": "2026-07-21T10:00:00+08:00",
            },
            expected_repository_id="sha256:abc",
            expected_head="def456",
            expected_root=self.project / "feature-worktree",
            expected_worktree_id="sha256:feature-worktree",
        )
        self.assertFalse(result.get("ok"))
        self.assertEqual(result["code"], "IDENTITY_MISMATCH")
        self.assertEqual(result["fallback"], "grep-glob-read")
        self.assertEqual(result["actual"]["rootPath"], str(self.project))
        self.assertEqual(result["expected"]["worktreeId"], "sha256:feature-worktree")

    def test_validate_identity_missing_fields_triggers_warning(self) -> None:
        result = review.validate_codegraph_identity(
            response={"repositoryId": "sha256:abc"},
            expected_repository_id="sha256:abc",
            expected_head="def456",
            expected_root=self.project,
            expected_worktree_id=None,
        )
        self.assertFalse(result.get("ok"))
        self.assertEqual(result["code"], "IDENTITY_MISMATCH")


class StdinInputTests(unittest.TestCase):
    """为了把一段 JSON 交给命令，先在 runtime/ 落一个临时文件——这一步没有必要。"""

    def test_write_findings_accepts_stdin(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp)
            doc = {
                "runId": "run-1",
                "changeName": "demo",
                "findings": [
                    {
                        "dimension": "correctness",
                        "severity": "YELLOW",
                        "path": "a.ts",
                        "line": 1,
                        "title": "t",
                        "fixbackAction": "code",
                    }
                ],
            }
            code = review.main([
                "write-findings", "--change-dir", str(change), "--stdin"
            ], stdin_text=json.dumps(doc))

            self.assertEqual(code, 0)
            self.assertTrue(review.findings_path(change).is_file())

    def test_input_and_stdin_together_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            code = review.main([
                "write-findings",
                "--change-dir", tmp,
                "--input", "x.json",
                "--stdin",
            ], stdin_text="{}")
            self.assertNotEqual(code, 0)


class DiffScopeFixture(ReviewFixture):
    """WI-3.4 公共基建：.gitignore 隔离 .harness/，产品文件写入/提交/findings 辅助。"""

    def setUp(self) -> None:
        super().setUp()
        (self.project / ".gitignore").write_text(".harness/\n", encoding="utf-8")
        git(self.project, "add", ".gitignore")
        git(self.project, "commit", "-m", "gitignore")

    def _write_product(self, rel: str, content: str) -> None:
        path = self.project / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def _commit_all(self, msg: str = "wip") -> None:
        git(self.project, "add", "-A")
        git(self.project, "commit", "-m", msg)

    def _write_findings(
        self, findings: list[dict] | None = None, run_id: str = "review-run-1"
    ) -> dict:
        doc = {
            "runId": run_id,
            "changeName": "demo",
            "findings": findings
            if findings is not None
            else [
                {
                    "dimension": "architecture",
                    "severity": "RED",
                    "path": "src/app.py",
                    "line": 42,
                    "title": "God object accumulates responsibilities",
                    "fixbackAction": "code",
                }
            ],
        }
        result = review.write_findings(self.change_dir, doc)
        assert result["ok"], result
        return result

    def _sidecar(self) -> dict:
        return json.loads(
            review.findings_path(self.change_dir).read_text(encoding="utf-8-sig")
        )

    def _save_sidecar(self, doc: dict) -> None:
        review.findings_path(self.change_dir).write_text(
            json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    def _diff_scope(self) -> dict:
        return review.diff_scope(self.change_dir)


class DiffScopeTests(DiffScopeFixture):
    """WI-3.4：diff-scope 增量/全量判定（任务书 O2 §9.2 必测矩阵）。"""

    def test_first_round_no_sidecar_returns_full(self) -> None:
        self._write_product("src/a.py", "a = 1\n")
        out = self._diff_scope()
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["mode"], "full")
        self.assertEqual(out["reason"], "NO_PREVIOUS_SCOPE")
        self.assertIn("src/a.py", out["fullFiles"])

    def test_v2_sidecar_without_scope_returns_full(self) -> None:
        path = review.findings_path(self.change_dir)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {"schemaVersion": 2, "runId": "r1", "changeName": "demo",
                 "findings": []}
            ),
            encoding="utf-8",
        )
        out = self._diff_scope()
        self.assertEqual(out["mode"], "full")
        self.assertEqual(out["reason"], "NO_PREVIOUS_SCOPE")

    def test_incremental_lists_only_changed_files(self) -> None:
        """无关模块不重审：a.py 改动、b.py 未动 → 增量只列 a.py。"""
        self._write_product("src/a.py", "a = 1\n")
        self._write_product("src/b.py", "b = 1\n")
        self._write_findings()
        self._write_product("src/a.py", "a = 2\n")
        out = self._diff_scope()
        self.assertEqual(out["mode"], "incremental", out)
        self.assertEqual(out["incrementalFiles"], ["src/a.py"])

    def test_new_file_is_incremental(self) -> None:
        self._write_findings()
        self._write_product("src/new.py", "n = 1\n")
        out = self._diff_scope()
        self.assertEqual(out["mode"], "incremental", out)
        self.assertIn("src/new.py", out["incrementalFiles"])

    def test_deleted_tracked_file_is_incremental(self) -> None:
        """base 中已跟踪的文件被删除也是须审的增量（state-snapshot 钉 base）。"""
        self._write_product("src/a.py", "a = 1\n")
        self._commit_all("add a")
        head = git(self.project, "rev-parse", "HEAD").stdout.strip()
        snapshot = {"git": {"base": head, "head": head}}
        (self.change_dir / "meta" / "state-snapshot.json").write_text(
            json.dumps(snapshot), encoding="utf-8"
        )
        self._write_findings()  # 相对 base 工作区干净 → files={}
        git(self.project, "rm", "-q", "src/a.py")
        out = self._diff_scope()
        self.assertEqual(out["mode"], "incremental", out)
        self.assertIn("src/a.py", out["incrementalFiles"])

    def test_shared_state_marker_expands_to_full(self) -> None:
        """全局配置/共享状态变化触发扩大（O2 §9.2 必测）。"""
        self._write_findings()
        self._write_product("src/shared/pool.py", "x = 1\n")
        out = self._diff_scope()
        self.assertEqual(out["mode"], "full")
        self.assertEqual(out["reason"], "EXPANDED_SIGNALS:shared-state")

    def test_contract_schema_path_expands_to_full(self) -> None:
        """接口/契约邻接变化正确扩展（O2 §9.2 必测）。"""
        self._write_findings()
        self._write_product("harness/scripts/harness_gate.py", "# change\n")
        out = self._diff_scope()
        self.assertEqual(out["mode"], "full")
        self.assertEqual(out["reason"], "EXPANDED_SIGNALS:contract-schema")

    def test_head_unresolvable_returns_full(self) -> None:
        self._write_findings()
        sidecar = self._sidecar()
        sidecar["diffScope"]["head"] = "0" * 40
        self._save_sidecar(sidecar)
        self._write_product("src/a.py", "a = 1\n")
        out = self._diff_scope()
        self.assertEqual(out["mode"], "full")
        self.assertEqual(out["reason"], "HEAD_UNRESOLVABLE")

    def test_unexplained_drift_returns_full(self) -> None:
        """per-file 无差异但整体 diffHash 不一致 → fail-closed 全量。"""
        self._write_product("src/a.py", "a = 1\n")
        self._write_findings()
        sidecar = self._sidecar()
        sidecar["diffScope"]["diffHash"] = "sha256:forged"
        self._save_sidecar(sidecar)
        out = self._diff_scope()
        self.assertEqual(out["mode"], "full")
        self.assertEqual(out["reason"], "UNEXPLAINED_DRIFT")

    def test_no_change_incremental_empty_and_open_findings_listed(self) -> None:
        """无变化仍是 incremental（空清单）；上轮 OPEN finding 不因局部输入消失。"""
        self._write_product("src/a.py", "a = 1\n")
        self._write_findings()
        out = self._diff_scope()
        self.assertEqual(out["mode"], "incremental", out)
        self.assertEqual(out["incrementalFiles"], [])
        paths = [f["path"] for f in out["openFindings"]]
        self.assertIn("src/app.py", paths)

    def test_open_findings_exclude_fixed(self) -> None:
        """已修复发现不重复出现在增量输入。"""
        self._write_product("src/a.py", "a = 1\n")
        self._write_findings()
        fid = self._sidecar()["findings"][0]["id"]
        dispo = review.write_dispositions(
            self.change_dir,
            {
                "schemaVersion": 1,
                "runId": "review-run-1",
                "dispositions": [{"findingId": fid, "disposition": "FIXED"}],
            },
        )
        assert dispo["ok"], dispo
        out = self._diff_scope()
        self.assertEqual(out["openFindings"], [])

    def test_commit_does_not_disturb_incremental(self) -> None:
        """checkpoint commit 不冲掉内容身份：提交后新改 b.py，增量只列 b.py。"""
        self._write_product("src/a.py", "a = 1\n")
        self._write_findings()
        self._commit_all("checkpoint")
        self._write_product("src/b.py", "b = 1\n")
        out = self._diff_scope()
        self.assertEqual(out["mode"], "incremental", out)
        self.assertEqual(out["incrementalFiles"], ["src/b.py"])

    def test_context_files_pair_tests(self) -> None:
        """受影响上下文：增量源文件配对的测试文件纳入 contextFiles。"""
        self._write_product("tests/test_a.py", "def test_a():\n    pass\n")
        self._commit_all("add test")
        self._write_findings()
        self._write_product("src/a.py", "a = 1\n")
        out = self._diff_scope()
        self.assertEqual(out["mode"], "incremental", out)
        self.assertIn("tests/test_a.py", out.get("contextFiles") or [])


class FindingsV3Tests(DiffScopeFixture):
    """WI-3.4：findings sidecar schemaVersion 3 + diffScope 捕获。"""

    def test_write_findings_captures_diff_scope(self) -> None:
        self._write_product("src/a.py", "a = 1\n")
        self._write_findings()
        sidecar = self._sidecar()
        self.assertEqual(sidecar["schemaVersion"], 3)
        scope = sidecar["diffScope"]
        for key in ("base", "head", "diffHash", "files", "mode", "capturedAt"):
            self.assertIn(key, scope)
        self.assertEqual(scope["mode"], "full")  # 首轮无上一轮边界
        self.assertIn("src/a.py", scope["files"])
        self.assertTrue(str(scope["diffHash"]).startswith("sha256:"))

    def test_second_round_write_mode_incremental(self) -> None:
        self._write_findings(run_id="r1")
        self._write_findings(run_id="r2")
        self.assertEqual(self._sidecar()["diffScope"]["mode"], "incremental")

    def test_explicit_diff_mode_override(self) -> None:
        self._write_findings(run_id="r1")
        result = review.write_findings(
            self.change_dir, {"runId": "r2", "findings": [], "diffMode": "full"}
        )
        assert result["ok"], result
        self.assertEqual(self._sidecar()["diffScope"]["mode"], "full")


class CarryoverV3CompatTests(DiffScopeFixture):
    """WI-3.4：v3 sidecar 与 WI-3.1 携带判定兼容（锚点/id 语义不变）。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.fixback = load_module("harness_fixback", "harness_fixback.py")

    def test_v3_sidecar_carryover_still_classified(self) -> None:
        lines = "".join(f"line {i}\n" for i in range(1, 60))
        self._write_product("src/app.py", lines)
        self._write_findings()  # v3 sidecar，finding path=src/app.py line=42
        out = self.fixback.classify_review_carryover(
            self.change_dir,
            changed_files=["other.py"],
            batch_id="b1",
            repo_root=self.project,
        )
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["code"], "REVIEW_CARRYOVER_CLASSIFIED", out)
        self.assertEqual(len(out["carriedOverIds"]), 1)


class ScenarioChainTests(ReviewFixture):
    """15-M4：scenario→finding→fixback 三链闭环状态表。"""

    def _write_manifest(self, scenarios: list[dict]) -> None:
        (self.change_dir / "meta" / "scenario-manifest.json").write_text(
            json.dumps(
                {"schemaVersion": 2, "changeName": "demo", "scenarios": scenarios}
            ),
            encoding="utf-8",
        )

    def _write_findings(self, findings: list[dict]) -> None:
        path = self.state_dir / "reports" / "review" / "review-findings.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "runId": "r1",
                    "changeName": "demo",
                    "findings": findings,
                }
            ),
            encoding="utf-8",
        )

    def _write_dispositions(self, dispositions: list[dict]) -> None:
        path = self.state_dir / "reports" / "review" / "fixback-dispositions.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"schemaVersion": 1, "dispositions": dispositions}),
            encoding="utf-8",
        )

    def _write_fixback_batch(self, batch_id: str, issues: list[dict]) -> None:
        path = self.state_dir / "fixback" / "batches" / f"{batch_id}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {"batchId": batch_id, "status": "in-progress", "issues": issues}
            ),
            encoding="utf-8",
        )

    @staticmethod
    def _finding(fid: str, severity: str, path: str, **extra) -> dict:
        base = {
            "id": fid,
            "dimension": "architecture",
            "severity": severity,
            "path": path,
            "line": 1,
            "title": f"finding {fid}",
            "fixbackAction": "code",
        }
        base.update(extra)
        return base

    def test_missing_manifest_degrades_gracefully(self) -> None:
        self._write_findings([self._finding("f1", "RED", "src/app.py")])
        result = review.status(self.change_dir)
        chain = result["scenarioChain"]
        self.assertFalse(chain["available"])
        self.assertEqual(chain["reason"], "scenario-manifest-missing")
        # 既有字段不受影响
        self.assertEqual(result["counts"]["RED"], 1)

    def test_declared_scenario_refs_join(self) -> None:
        self._write_manifest(
            [
                {"id": "UT-001", "priority": "P1", "ownerPhase": "execute",
                 "requiredEvidenceKind": "ledger"},
                {"id": "API-001", "priority": "P1", "ownerPhase": "review",
                 "requiredEvidenceKind": "ledger"},
            ]
        )
        self._write_findings(
            [
                self._finding("f1", "RED", "src/app.py", scenarioRefs=["UT-001"]),
                self._finding("f2", "YELLOW", "src/other.py"),
            ]
        )
        self._write_dispositions(
            [{"findingId": "f1", "disposition": "FIXED", "recordedAt": "t1"}]
        )
        self._write_fixback_batch(
            "fb-1",
            [{"issueId": "f1", "status": "CLOSED", "severity": "RED",
              "path": "src/app.py", "line": 1, "summary": "s"}],
        )
        result = review.status(self.change_dir)
        chain = result["scenarioChain"]
        self.assertTrue(chain["available"], chain)
        by_id = {s["id"]: s for s in chain["scenarios"]}
        ut = by_id["UT-001"]
        self.assertEqual(len(ut["findings"]), 1)
        f1 = ut["findings"][0]
        self.assertEqual(f1["id"], "f1")
        self.assertEqual(f1["linkage"], "declared")
        self.assertEqual(f1["disposition"], "FIXED")
        self.assertEqual(f1["fixback"]["batchId"], "fb-1")
        self.assertEqual(f1["fixback"]["issueStatus"], "CLOSED")
        self.assertEqual(ut["findingCounts"], {"RED": 1})
        self.assertEqual(by_id["API-001"]["findings"], [])
        self.assertEqual(chain["unlinkedFindings"], ["f2"])

    def test_heuristic_path_linkage(self) -> None:
        self._write_manifest(
            [{"id": "UT-001", "priority": "P1", "ownerPhase": "execute",
              "testFile": "tests/test_app.py"}]
        )
        self._write_findings(
            [self._finding("f1", "YELLOW", "tests/test_app.py")]
        )
        result = review.status(self.change_dir)
        chain = result["scenarioChain"]
        f1 = chain["scenarios"][0]["findings"][0]
        self.assertEqual(f1["linkage"], "heuristic")
        self.assertEqual(chain["unlinkedFindings"], [])

    def test_change_alias_resolves_project_layout(self) -> None:
        """--change 别名与 --change-dir 等价（经 cmd_status 解析）。"""
        import argparse

        self._write_findings([self._finding("f1", "RED", "src/app.py")])
        args = argparse.Namespace(
            change_dir=None, change="demo", project=str(self.project)
        )
        import io
        import contextlib

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = review.cmd_status(args)
        self.assertEqual(rc, 0)
        payload = json.loads(buf.getvalue())
        self.assertEqual(payload["counts"]["RED"], 1)

    def test_change_alias_missing_dir_errors(self) -> None:
        import argparse
        import io
        import contextlib

        args = argparse.Namespace(
            change_dir=None, change="ghost", project=str(self.project)
        )
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = review.cmd_status(args)
        self.assertEqual(rc, 1)
        self.assertEqual(json.loads(buf.getvalue())["code"], "CHANGE_DIR_MISSING")


if __name__ == "__main__":
    unittest.main()
