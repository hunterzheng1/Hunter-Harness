#!/usr/bin/env python3
"""Cluster C tests: freeze-first finalize, source/renderer consistency,
versioned repair, knowledge publication gate.

Scenarios: INT-006 (finalize cutoff), UT-001 (event-ID merge),
UT-002 (derived projection rebuild), UT-003 (immutable artifact conflict),
UT-005/UT-006 (typed metrics projection), UT-008 (canonical timing),
UT-011 (manifest self-exclusion), UT-013 (PARTIAL risk propagation),
UT-014 (source consistency), UT-015 (business objective section),
UT-016 (renderer projection), API-006 (knowledge gate).
"""

from __future__ import annotations

import hashlib
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_archive as ha  # noqa: E402
import harness_events as he  # noqa: E402

from test_harness_archive import _run, _seed_change_dir, _write, _write_json  # noqa: E402

KNOWLEDGE_SCRIPTS = (
    Path(__file__).resolve().parents[2] / "harness-knowledge-ingest" / "scripts"
)
if str(KNOWLEDGE_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(KNOWLEDGE_SCRIPTS))

import harness_knowledge as hk  # noqa: E402


def _events_in(change_dir: Path) -> list[dict]:
    path = he.events_path(change_dir)
    if not path.is_file():
        return []
    return he.load_events(path)


class _FinalizeFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-archiveC-"))
        self.project = self.tmp / "proj"
        self.change = self.project / ".harness" / "changes" / "demo-change"
        self.archive_root = self.project / ".harness" / "archive"
        self.change.mkdir(parents=True)
        self.archive_root.mkdir(parents=True)
        _seed_change_dir(self.change)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _finalize(self) -> tuple[int, dict, Path]:
        code, payload = _run(
            [
                "finalize",
                "--change-dir",
                str(self.change),
                "--archive-root",
                str(self.archive_root),
                "--skip-ingest",
                "--json",
            ]
        )
        archive_dir = Path(payload.get("archive_dir") or self.archive_root / "x")
        return code, payload, archive_dir


class FreezeFirstTests(_FinalizeFixture):
    """INT-006 / RET-19: freeze-first finalize."""

    def test_event_count_equals_cutoff_total(self) -> None:
        code, payload, archive_dir = self._finalize()
        self.assertEqual(code, 0, msg=json.dumps(payload, ensure_ascii=False))
        events = _events_in(archive_dir)
        summary = json.loads(
            (archive_dir / "reports" / "final" / "summary-data.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(
            summary["reportPipeline"]["event_count"],
            len(events),
            "summary event_count must equal the frozen cutoff total (no 55/63 drift)",
        )

    def test_evidence_cutoff_written_and_matches_final_events(self) -> None:
        code, payload, archive_dir = self._finalize()
        self.assertEqual(code, 0, msg=json.dumps(payload, ensure_ascii=False))
        cutoff_path = archive_dir / "evidence" / "evidence-cutoff.json"
        self.assertTrue(cutoff_path.is_file(), "evidence-cutoff.json must be written")
        cutoff = json.loads(cutoff_path.read_text(encoding="utf-8"))
        events_file = he.events_path(archive_dir)
        raw = events_file.read_bytes()
        events = _events_in(archive_dir)
        self.assertEqual(cutoff.get("eventCount"), len(events))
        self.assertEqual(
            cutoff.get("sha256"),
            "sha256:" + hashlib.sha256(raw).hexdigest(),
            "cutoff hash must cover the final events file (no post-cutoff appends)",
        )

    def test_last_event_is_phase_end(self) -> None:
        code, payload, archive_dir = self._finalize()
        self.assertEqual(code, 0, msg=json.dumps(payload, ensure_ascii=False))
        events = _events_in(archive_dir)
        self.assertTrue(events)
        self.assertEqual(events[-1].get("type"), "phase.end")
        self.assertEqual(events[-1].get("phase"), "archive")

    def test_patch_archive_stage_deleted(self) -> None:
        self.assertFalse(
            hasattr(ha, "_patch_archive_stage"),
            "_patch_archive_stage must be deleted (freeze-first makes it impossible)",
        )

    def test_finalize_success_still_green(self) -> None:
        code, payload, archive_dir = self._finalize()
        self.assertEqual(code, 0, msg=json.dumps(payload, ensure_ascii=False))
        self.assertTrue(payload.get("ok"))
        self.assertFalse(self.change.exists())
        self.assertTrue(
            (archive_dir / "reports" / "final" / "final-summary.html").is_file()
        )

    def test_split_v1_runtime_state_is_merged_into_archive(self) -> None:
        (self.change / "meta").mkdir(exist_ok=True)
        _write_json(
            self.change / "meta" / "change-context.json",
            {
                "schemaVersion": 2,
                "changeId": "demo-change",
                "stateOwnership": {
                    "contractRoot": ".harness/changes/demo-change",
                    "runtimeRoot": ".harness/state/changes/demo-change",
                },
            },
        )
        state = self.project / ".harness" / "state" / "changes" / "demo-change"
        state.mkdir(parents=True)
        for name in ("events.ndjson", "logs", "evidence", "reports"):
            source = self.change / name
            if source.exists():
                shutil.move(str(source), str(state / name))
        marker = state / "evidence" / "runtime-marker.json"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text('{"runtime":true}\n', encoding="utf-8")

        code, payload, archive_dir = self._finalize()

        self.assertEqual(code, 0, msg=json.dumps(payload, ensure_ascii=False))
        self.assertTrue((archive_dir / "evidence" / "runtime-marker.json").is_file())
        after = json.loads(
            (archive_dir / "evidence" / "archive-manifest-after.json").read_text(
                encoding="utf-8"
            )
        )
        paths = {item["path"] for item in after["files"]}
        self.assertIn("evidence/runtime-marker.json", paths)
        self.assertFalse(state.exists(), "split runtime state must be consumed on success")

    def test_split_v1_failure_restores_separate_contract_and_runtime(self) -> None:
        (self.change / "meta").mkdir(exist_ok=True)
        _write_json(
            self.change / "meta" / "change-context.json",
            {
                "schemaVersion": 2,
                "changeId": "demo-change",
                "stateOwnership": {
                    "contractRoot": ".harness/changes/demo-change",
                    "runtimeRoot": ".harness/state/changes/demo-change",
                },
            },
        )
        state = self.project / ".harness" / "state" / "changes" / "demo-change"
        state.mkdir(parents=True)
        for name in ("events.ndjson", "logs", "evidence", "reports"):
            source = self.change / name
            if source.exists():
                shutil.move(str(source), str(state / name))
        marker = state / "evidence" / "runtime-marker.json"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text('{"runtime":true}\n', encoding="utf-8")
        forced = {
            "ok": False,
            "issues": [{"code": "forced", "severity": "error", "message": "x"}],
            "error_count": 1,
            "warning_count": 0,
        }
        with mock.patch.object(ha, "validate_source_consistency", return_value=forced):
            code, _payload, _archive_dir = self._finalize()
        self.assertNotEqual(code, 0)
        self.assertTrue(marker.is_file())
        self.assertFalse((self.change / "evidence").exists())


class SourceConsistencyTests(_FinalizeFixture):
    """UT-014 / RET-26: source consistency validator."""

    def test_validator_flags_event_count_mismatch(self) -> None:
        code, payload, archive_dir = self._finalize()
        self.assertEqual(code, 0, msg=json.dumps(payload, ensure_ascii=False))
        summary_path = archive_dir / "reports" / "final" / "summary-data.json"
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
        summary["reportPipeline"]["event_count"] = 999999
        result = ha.validate_source_consistency(archive_dir, summary)
        self.assertFalse(result.get("ok"))
        codes = {i.get("code") for i in result.get("issues") or []}
        self.assertIn("event-count-mismatch", codes)

    def test_validator_flags_unit_metrics_mismatch(self) -> None:
        code, payload, archive_dir = self._finalize()
        self.assertEqual(code, 0, msg=json.dumps(payload, ensure_ascii=False))
        # Ledger claims 52 passed; corrupt the summary to show 0.
        ledger_path = archive_dir / "evidence" / "verification-ledger.json"
        ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
        ledger["validations"]["unitTest"]["metrics"] = {
            "total": 52,
            "passed": 52,
            "failed": 0,
            "errors": 0,
            "skipped": 0,
        }
        ledger_path.write_text(json.dumps(ledger), encoding="utf-8")
        summary_path = archive_dir / "reports" / "final" / "summary-data.json"
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
        summary["verification"]["unitTests"] = {"run": 0, "failures": 0}
        result = ha.validate_source_consistency(archive_dir, summary)
        self.assertFalse(result.get("ok"))
        codes = {i.get("code") for i in result.get("issues") or []}
        self.assertIn("verification-mismatch", codes)

    def test_validator_checks_typed_metrics_without_artifacts(self) -> None:
        code, payload, archive_dir = self._finalize()
        self.assertEqual(code, 0, msg=json.dumps(payload, ensure_ascii=False))
        ledger_path = archive_dir / "evidence" / "verification-ledger.json"
        ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
        ledger["validations"]["apiContract"] = {
            "status": "OK",
            "metrics": {"scenariosTotal": 4, "passed": 4, "failed": 0},
        }
        ledger_path.write_text(json.dumps(ledger), encoding="utf-8")
        summary = json.loads(
            (archive_dir / "reports" / "final" / "summary-data.json").read_text(
                encoding="utf-8"
            )
        )
        summary["artifacts"] = []
        summary["verification"]["apiContract"] = {"total": 0, "passed": 0}
        result = ha.validate_source_consistency(archive_dir, summary)
        self.assertFalse(result.get("ok"), result)
        self.assertIn(
            "verification-mismatch",
            {item.get("code") for item in result.get("issues") or []},
        )

    def test_validator_flags_review_sidecar_mismatch(self) -> None:
        code, payload, archive_dir = self._finalize()
        self.assertEqual(code, 0, msg=json.dumps(payload, ensure_ascii=False))
        review_dir = archive_dir / "reports" / "review"
        review_dir.mkdir(parents=True, exist_ok=True)
        _write_json(
            review_dir / "review-findings.json",
            {
                "schemaVersion": 1,
                "runId": "review-1",
                "findings": [
                    {
                        "id": "f-red",
                        "dimension": "architecture",
                        "severity": "RED",
                        "path": "src/app.py",
                        "line": 1,
                        "title": "broken",
                    }
                ],
            },
        )
        summary = json.loads(
            (archive_dir / "reports" / "final" / "summary-data.json").read_text(
                encoding="utf-8"
            )
        )
        summary["reviewSummary"]["red"] = 0
        result = ha.validate_source_consistency(archive_dir, summary)
        self.assertFalse(result["ok"], result)
        self.assertIn("review-mismatch", {i["code"] for i in result["issues"]})

    def test_validator_flags_cutoff_hash_manifest_and_artifact_mismatch(self) -> None:
        code, payload, archive_dir = self._finalize()
        self.assertEqual(code, 0, msg=json.dumps(payload, ensure_ascii=False))
        summary = json.loads(
            (archive_dir / "reports" / "final" / "summary-data.json").read_text(
                encoding="utf-8"
            )
        )
        cutoff_path = archive_dir / "evidence" / "evidence-cutoff.json"
        cutoff = json.loads(cutoff_path.read_text(encoding="utf-8"))
        cutoff["sha256"] = "sha256:" + "0" * 64
        cutoff_path.write_text(json.dumps(cutoff), encoding="utf-8")
        manifest_path = archive_dir / "evidence" / "archive-manifest-before.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["fileCount"] = int(manifest["fileCount"]) + 1
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        summary["artifacts"] = [
            {"path": "evidence/does-not-exist.json", "kind": "probe", "phase": "test"}
        ]
        result = ha.validate_source_consistency(archive_dir, summary)
        codes = {i["code"] for i in result["issues"]}
        self.assertFalse(result["ok"], result)
        self.assertIn("cutoff-hash-mismatch", codes)
        self.assertIn("manifest-invalid", codes)
        self.assertIn("artifact-missing", codes)

    def test_validator_flags_risk_and_phase_timing_mismatch(self) -> None:
        code, payload, archive_dir = self._finalize()
        self.assertEqual(code, 0, msg=json.dumps(payload, ensure_ascii=False))
        summary = json.loads(
            (archive_dir / "reports" / "final" / "summary-data.json").read_text(
                encoding="utf-8"
            )
        )
        summary["knownRisks"] = [{"severity": "error", "message": "invented"}]
        summary["durations"]["stages"][0]["activeExecutionMs"] = 999999999
        result = ha.validate_source_consistency(archive_dir, summary)
        codes = {i["code"] for i in result["issues"]}
        self.assertFalse(result["ok"], result)
        self.assertIn("risk-mismatch", codes)
        self.assertIn("phase-timing-mismatch", codes)

    def test_finalize_aborts_on_source_consistency_error(self) -> None:
        forced = {
            "ok": False,
            "issues": [
                {
                    "code": "verification-mismatch",
                    "severity": "error",
                    "message": "forced mismatch",
                }
            ],
            "error_count": 1,
            "warning_count": 0,
        }
        with mock.patch.object(
            ha, "validate_source_consistency", return_value=forced
        ):
            code, payload = _run(
                [
                    "finalize",
                    "--change-dir",
                    str(self.change),
                    "--archive-root",
                    str(self.archive_root),
                    "--skip-ingest",
                    "--json",
                ]
            )
        self.assertNotEqual(code, 0, "finalize must not green-close on source mismatch")
        self.assertTrue(
            self.change.is_dir(), "original change dir must be restored on failure"
        )


class OwnershipProjectionTests(unittest.TestCase):
    def test_summary_changed_files_uses_declared_product_scope(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="harness-archiveC-ownership-"))
        self.addCleanup(lambda: shutil.rmtree(tmp, ignore_errors=True))
        project = tmp / "project"
        project.mkdir()
        import subprocess

        def git(*args: str) -> str:
            proc = subprocess.run(
                ["git", *args], cwd=project, capture_output=True, text=True,
                encoding="utf-8", check=True
            )
            return proc.stdout.strip()

        git("init")
        git("config", "user.email", "test@example.com")
        git("config", "user.name", "Test")
        (project / "README.md").write_text("base\n", encoding="utf-8")
        git("add", "README.md")
        git("commit", "-m", "base")
        base = git("rev-parse", "HEAD")
        change = project / ".harness" / "changes" / "demo"
        (change / "meta").mkdir(parents=True)
        _write_json(
            change / "meta" / "change-context.json",
            {
                "schemaVersion": 2,
                "changeId": "demo",
                "ownership": {
                    "productPaths": ["src/"],
                    "staticEvidencePaths": [".harness/changes/demo/"],
                },
            },
        )
        (project / "src").mkdir()
        (project / "src" / "app.py").write_text("value = 1\n", encoding="utf-8")
        (project / "docs").mkdir()
        (project / "docs" / "unrelated.md").write_text("foreign\n", encoding="utf-8")
        git("add", "src/app.py", "docs/unrelated.md")
        git("commit", "-m", "mixed")
        head = git("rev-parse", "HEAD")
        _write_json(
            change / "evidence" / "verification-ledger.json",
            {"baseCommit": base, "finalCommit": head, "validations": {}},
        )

        summary = ha.collect_summary_data(change, write=False)

        self.assertEqual(
            [item["path"] for item in summary["changedFiles"]], ["src/app.py"]
        )
        self.assertIn("docs/unrelated.md", summary["ownershipDiff"]["foreignPaths"])


class TypedMetricsProjectionTests(unittest.TestCase):
    """UT-005 / RET-15, UT-006 / RET-16: typed metrics canonical projection."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-archiveC-metrics-"))
        self.change = self.tmp / "proj" / ".harness" / "changes" / "m"
        self.change.mkdir(parents=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_v3_typed_unit_metrics_projected(self) -> None:
        """真实中文 Vitest 证据 + typed metrics：unit 必须显示 52/52，不得回落 0。"""
        _write_json(
            self.change / "evidence" / "verification-ledger.json",
            {
                "changeName": "m",
                "validations": {
                    "unitTest": {
                        "status": "OK",
                        "command": "npx vitest run",
                        "evidence": "测试通过：52 个用例全部成功",
                        "metrics": {
                            "total": 52,
                            "passed": 52,
                            "failed": 0,
                            "errors": 0,
                            "skipped": 0,
                        },
                    }
                },
            },
        )
        unit = ha._ledger_unit_tests(
            json.loads(
                (self.change / "evidence" / "verification-ledger.json").read_text(
                    encoding="utf-8"
                )
            )
        )
        self.assertEqual(unit["run"], 52)
        self.assertEqual(unit["failures"], 0)
        self.assertEqual(unit["errors"], 0)

    def test_api_contract_and_browser_e2e_are_distinct(self) -> None:
        """apiContract 与 browserE2E 分别投影，字段互不覆盖。"""
        ledger = {
            "changeName": "m",
            "validations": {
                "apiContract": {
                    "status": "OK",
                    "metrics": {
                        "scenariosTotal": 7,
                        "passed": 7,
                        "failed": 0,
                        "blocked": 0,
                    },
                },
                "browserE2E": {
                    "status": "OK",
                    "metrics": {
                        "total": 9,
                        "passed": 9,
                        "failed": 0,
                        "skipped": 0,
                        "retries": 0,
                    },
                },
            },
        }
        _write_json(self.change / "evidence" / "verification-ledger.json", ledger)
        projection = ha.build_verification_projection(ledger, change_dir=self.change)
        api = projection.get("apiContract") or {}
        e2e = projection.get("browserE2E") or {}
        self.assertEqual(api.get("total"), 7)
        self.assertEqual(api.get("passed"), 7)
        self.assertEqual(e2e.get("total"), 9)
        self.assertEqual(e2e.get("passed"), 9)


class BusinessGoalTests(unittest.TestCase):
    """UT-015 / RET-27: structured objective section beats first task row."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-archiveC-goal-"))
        self.change = self.tmp / "proj" / ".harness" / "changes" / "g"
        (self.change / "plans").mkdir(parents=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_objective_section_body_preferred_over_first_task(self) -> None:
        _write(
            self.change / "plans" / "g-plan.md",
            "# Plan\n\n## 1. 目标\n\n修复复盘发现的归档一致性问题。\n\n"
            "## 任务表\n\n| # | 任务 |\n| 1 | 为复盘 1-40 场景建立失败夹具 |\n",
        )
        goal = ha._business_goal_from_sources(self.change, [])
        self.assertEqual(goal, "修复复盘发现的归档一致性问题。")

    def test_first_task_fallback_only_when_no_objective(self) -> None:
        _write(
            self.change / "plans" / "g-plan.md",
            "# Plan\n\n## 任务表\n\n| # | 任务 |\n| 1 | 建立失败夹具和基线断言 |\n",
        )
        goal = ha._business_goal_from_sources(self.change, [])
        self.assertIn("建立失败夹具", goal)


class RendererProjectionTests(unittest.TestCase):
    """UT-016 / RET-28: renderer & validator share canonical risk projection."""

    def test_structured_risk_objects_no_false_missing_risk(self) -> None:
        summary = {
            "changeName": "x",
            "finalStatus": "CONDITIONAL_OK",
            "verification": {},
            "knownRisks": [
                {"phase": "test", "severity": "high", "message": "DB 兼容性未验证"}
            ],
        }
        html_path = Path(tempfile.mkdtemp(prefix="harness-archiveC-html-")) / "h.html"
        html_path.write_text(
            "<html><body>x DB 兼容性未验证 CONDITIONAL_OK</body></html>",
            encoding="utf-8",
        )
        try:
            result = ha.validate_summary(summary, html_path)
            codes = {i.get("code") for i in result.get("issues") or []}
            self.assertNotIn(
                "missing-risk",
                codes,
                "structured risk whose message is rendered must not warn missing-risk",
            )
        finally:
            shutil.rmtree(html_path.parent, ignore_errors=True)

    def test_missing_structured_risk_still_warns(self) -> None:
        summary = {
            "changeName": "x",
            "finalStatus": "CONDITIONAL_OK",
            "verification": {},
            "knownRisks": [
                {"phase": "test", "severity": "high", "message": "真实风险未渲染"}
            ],
        }
        html_path = Path(tempfile.mkdtemp(prefix="harness-archiveC-html-")) / "h.html"
        html_path.write_text("<html><body>x</body></html>", encoding="utf-8")
        try:
            result = ha.validate_summary(summary, html_path)
            codes = {i.get("code") for i in result.get("issues") or []}
            self.assertIn("missing-risk", codes)
        finally:
            shutil.rmtree(html_path.parent, ignore_errors=True)


class ManifestStatsTests(_FinalizeFixture):
    """UT-011 / RET-23: manifest physical/entries/selfExcluded/coverage 字段分离。"""

    def test_manifest_stats_expose_self_exclusion(self) -> None:
        code, payload, archive_dir = self._finalize()
        self.assertEqual(code, 0, msg=json.dumps(payload, ensure_ascii=False))
        summary = json.loads(
            (archive_dir / "reports" / "final" / "summary-data.json").read_text(
                encoding="utf-8"
            )
        )
        am = summary.get("archiveManifest") or {}
        physical = am.get("physicalFileCount")
        entries = am.get("entryCount")
        self.assertIsInstance(physical, int, "physicalFileCount must be present")
        self.assertIsInstance(entries, int, "entryCount must be present")
        self.assertTrue(am.get("selfExcluded") is True)
        self.assertGreaterEqual(physical, entries)
        coverage = am.get("coveragePercent")
        self.assertIsNotNone(coverage)


class PartialScenarioTests(unittest.TestCase):
    """UT-013 / RET-25: PARTIAL scenarios enter knownRisks/manualActions with IDs."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-archiveC-partial-"))
        self.change = self.tmp / "proj" / ".harness" / "changes" / "p"
        self.change.mkdir(parents=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_partial_scenarios_propagate(self) -> None:
        _write_json(
            self.change / "runtime" / "api-test-results.json",
            {
                "total": 5,
                "passed": 2,
                "failed": 0,
                "blocked": 0,
                "scenarios": [
                    {"id": "SC-01", "status": "PASS"},
                    {"id": "SC-02", "status": "PARTIAL", "note": "依赖服务未起"},
                    {"id": "SC-03", "status": "PARTIAL", "note": "只验证只读路径"},
                    {"id": "SC-04", "status": "PARTIAL", "note": "数据准备失败"},
                    {"id": "SC-05", "status": "PASS"},
                ],
            },
        )
        risks, actions = ha._risks_from_test_results(self.change)
        text = json.dumps({"risks": risks, "actions": actions}, ensure_ascii=False)
        for scenario_id in ("SC-02", "SC-03", "SC-04"):
            self.assertIn(scenario_id, text)
        self.assertEqual(len(risks), 3)
        statuses = {r.get("status") for r in risks}
        self.assertEqual(statuses, {"PARTIAL"})


class ImmutableArtifactTests(unittest.TestCase):
    """UT-003 / RET-07: same path with different hash -> conflict blocks."""

    def test_conflicting_artifact_hashes_blocked(self) -> None:
        entries = [
            {"path": "reports/final/summary-data.json", "sha256": "a" * 64},
            {"path": "reports/final/summary-data.json", "sha256": "b" * 64},
        ]
        result = ha.validate_artifact_immutability(entries)
        self.assertFalse(result.get("ok"))
        codes = {i.get("code") for i in result.get("issues") or []}
        self.assertIn("artifact-hash-conflict", codes)

    def test_identical_entries_pass(self) -> None:
        entries = [
            {"path": "a.txt", "sha256": "a" * 64},
            {"path": "a.txt", "sha256": "a" * 64},
        ]
        result = ha.validate_artifact_immutability(entries)
        self.assertTrue(result.get("ok"))


class EventMergeTests(unittest.TestCase):
    """UT-001 / RET-05: event-ID merge yields union, each ID exactly once."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-archiveC-merge-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_event_id_merge_union_exactly_once(self) -> None:
        def _evt(i: int) -> dict:
            return {"id": f"evt-{i:04d}", "timestamp": f"2026-07-18T10:{i:02d}:00", "type": "command"}

        file_a = self.tmp / "a.ndjson"
        file_b = self.tmp / "b.ndjson"
        file_a.write_text(
            "".join(json.dumps(_evt(i)) + "\n" for i in (1, 2, 3, 4)), encoding="utf-8"
        )
        file_b.write_text(
            "".join(json.dumps(_evt(i)) + "\n" for i in (3, 4, 5, 6)), encoding="utf-8"
        )
        merged = he.merge_event_files([file_a, file_b])
        ids = [e["id"] for e in merged]
        self.assertEqual(len(ids), len(set(ids)), "each event ID must appear exactly once")
        self.assertEqual(set(ids), {f"evt-{i:04d}" for i in (1, 2, 3, 4, 5, 6)})


class ExecutionLogRebuildTests(unittest.TestCase):
    """UT-002 / RET-06: derived projection rebuild equals standard renderer."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-archiveC-log-"))
        self.change = self.tmp / "proj" / ".harness" / "changes" / "l"
        self.change.mkdir(parents=True)
        for args in (
            ["--phase", "run", "--type", "phase.start"],
            ["--phase", "run", "--type", "command", "--command", "pytest -q",
             "--exit-code", "0", "--duration-ms", "100"],
            ["--phase", "run", "--type", "phase.end"],
        ):
            code = he.main(["--json", "append", "--change-dir", str(self.change), *args])
            assert code == 0

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_rebuild_equals_standard_renderer(self) -> None:
        log_path = self.change / "logs" / "execution-log.md"
        he.main(["--json", "render", "--change-dir", str(self.change)])
        self.assertTrue(log_path.is_file())
        first = log_path.read_bytes()
        log_path.unlink()
        he.main(["--json", "render", "--change-dir", str(self.change)])
        second = log_path.read_bytes()
        self.assertEqual(first, second, "rebuilt log must equal standard renderer output")


class CanonicalTimingTests(_FinalizeFixture):
    """UT-008 / RET-20: archive views use canonical transaction timing."""

    def test_durations_carry_canonical_fields(self) -> None:
        code, payload, archive_dir = self._finalize()
        self.assertEqual(code, 0, msg=json.dumps(payload, ensure_ascii=False))
        summary = json.loads(
            (archive_dir / "reports" / "final" / "summary-data.json").read_text(
                encoding="utf-8"
            )
        )
        stages = (summary.get("durations") or {}).get("stages") or []
        self.assertTrue(stages, "seeded events produce stage durations")
        for stage in stages:
            self.assertIn("wallClockSpanMs", stage)
            self.assertIn("activeExecutionMs", stage)


class RepairTests(unittest.TestCase):
    """Task 11: versioned repair; original never overwritten (cluster gate)."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-archiveC-repair-"))
        self.project = self.tmp / "proj"
        self.change = self.project / ".harness" / "changes" / "demo-change"
        self.archive_root = self.project / ".harness" / "archive"
        self.change.mkdir(parents=True)
        self.archive_root.mkdir(parents=True)
        _seed_change_dir(self.change)
        code, payload = _run(
            [
                "finalize",
                "--change-dir",
                str(self.change),
                "--archive-root",
                str(self.archive_root),
                "--skip-ingest",
                "--json",
            ]
        )
        assert code == 0, json.dumps(payload, ensure_ascii=False)
        self.archive_dir = Path(payload["archive_dir"])

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_repair_creates_versioned_derived_keeps_original(self) -> None:
        summary_path = self.archive_dir / "reports" / "final" / "summary-data.json"
        original_bytes = summary_path.read_bytes()
        code, payload = _run(["repair", "--archive-dir", str(self.archive_dir), "--json"])
        self.assertEqual(code, 0, msg=json.dumps(payload, ensure_ascii=False))
        derived = self.archive_dir / "derived"
        self.assertTrue(derived.is_dir())
        versions = [p for p in derived.iterdir() if p.is_dir() and p.name.startswith("v")]
        self.assertTrue(versions, "repair must write an immutable derived version")
        v1 = sorted(versions)[0]
        self.assertTrue((v1 / "summary-data.json").is_file())
        self.assertTrue((v1 / "repair-record.json").is_file())
        self.assertEqual(
            summary_path.read_bytes(),
            original_bytes,
            "repair must not overwrite the original summary (cluster gate)",
        )
        pointer = json.loads(
            (derived / "authoritative.json").read_text(encoding="utf-8")
        )
        self.assertEqual(pointer.get("version"), v1.name)

    def test_repair_record_hashes_match_written_files(self) -> None:
        code, payload = _run(["repair", "--archive-dir", str(self.archive_dir), "--json"])
        self.assertEqual(code, 0, msg=json.dumps(payload, ensure_ascii=False))
        pointer = json.loads(
            (self.archive_dir / "derived" / "authoritative.json").read_text(
                encoding="utf-8"
            )
        )
        version_dir = self.archive_dir / "derived" / pointer["version"]
        record = json.loads((version_dir / "repair-record.json").read_text(encoding="utf-8"))
        summary_bytes = (version_dir / "summary-data.json").read_bytes()
        self.assertEqual(
            record.get("summarySha256"),
            "sha256:" + hashlib.sha256(summary_bytes).hexdigest(),
        )
        self.assertEqual(record.get("validators", {}).get("source", {}).get("ok"), True)
        self.assertEqual(record.get("validators", {}).get("renderer", {}).get("ok"), True)


class KnowledgeGateTests(unittest.TestCase):
    """API-006 / RET-40: publication gate blocks invalid archives."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-archiveC-gate-"))
        self.project = self.tmp / "proj"
        self.archive_dir = self.project / ".harness" / "archive" / "2026-07-18-demo"
        (self.archive_dir / "reports" / "final").mkdir(parents=True)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_summary(self, consistency: dict | None, final_status: str = "OK") -> Path:
        summary = {
            "changeName": "demo",
            "schemaVersion": "2.3",
            "finalStatus": final_status,
            "reportPipeline": {},
        }
        if consistency is not None:
            summary["reportPipeline"]["sourceConsistency"] = consistency
        path = self.archive_dir / "reports" / "final" / "summary-data.json"
        path.write_text(json.dumps(summary), encoding="utf-8")
        return path

    def test_gate_blocks_failed_source_consistency(self) -> None:
        self._write_summary({"ok": False, "issues": [{"code": "verification-mismatch"}]})
        status = hk.archive_publication_status(
            self.project, ".harness/archive/2026-07-18-demo"
        )
        self.assertFalse(status.get("allowed"))
        self.assertIn("failed", str(status.get("status")))

    def test_gate_blocks_missing_consistency_record(self) -> None:
        self._write_summary(None)
        status = hk.archive_publication_status(
            self.project, ".harness/archive/2026-07-18-demo"
        )
        self.assertFalse(status.get("allowed"))
        self.assertEqual(status.get("status"), "unverified")

    def test_gate_allows_consistent_archive(self) -> None:
        self._write_summary({"ok": True, "issues": []})
        status = hk.archive_publication_status(
            self.project, ".harness/archive/2026-07-18-demo"
        )
        self.assertTrue(status.get("allowed"))
        self.assertEqual(status.get("status"), "ok")

    def test_gate_blocks_degraded_even_when_consistent(self) -> None:
        self._write_summary({"ok": True, "issues": []}, final_status="DEGRADED")
        status = hk.archive_publication_status(
            self.project, ".harness/archive/2026-07-18-demo"
        )
        self.assertFalse(status.get("allowed"), status)
        self.assertEqual(status.get("status"), "degraded")

    def test_gate_uses_hash_valid_authoritative_repair(self) -> None:
        self._write_summary({"ok": False, "issues": [{"code": "old"}]}, final_status="DEGRADED")
        version_dir = self.archive_dir / "derived" / "v1"
        version_dir.mkdir(parents=True)
        repaired = {
            "changeName": "demo",
            "schemaVersion": "2.3",
            "finalStatus": "OK",
            "reportPipeline": {"sourceConsistency": {"ok": True, "issues": []}},
        }
        summary_path = version_dir / "summary-data.json"
        summary_path.write_text(json.dumps(repaired), encoding="utf-8")
        digest = "sha256:" + hashlib.sha256(summary_path.read_bytes()).hexdigest()
        _write_json(version_dir / "repair-record.json", {"summarySha256": digest})
        _write_json(
            self.archive_dir / "derived" / "authoritative.json",
            {"version": "v1", "summarySha256": digest},
        )
        status = hk.archive_publication_status(
            self.project, ".harness/archive/2026-07-18-demo"
        )
        self.assertTrue(status.get("allowed"), status)
        self.assertEqual(status.get("authoritativeVersion"), "v1")

    def test_gate_rejects_hash_valid_non_object_authoritative_summary(self) -> None:
        self._write_summary("DEGRADED")
        version_dir = self.archive_dir / "derived" / "v1"
        version_dir.mkdir(parents=True)
        summary_bytes = b"[]"
        digest = "sha256:" + hashlib.sha256(summary_bytes).hexdigest()
        (version_dir / "summary-data.json").write_bytes(summary_bytes)
        _write_json(version_dir / "repair-record.json", {"summarySha256": digest})
        _write_json(
            self.archive_dir / "derived" / "authoritative.json",
            {"version": "v1", "summarySha256": digest},
        )
        status = hk.archive_publication_status(
            self.project, self.archive_dir.relative_to(self.project).as_posix()
        )
        self.assertFalse(status["allowed"])
        self.assertEqual(status["status"], "degraded")

    def test_should_auto_promote_honors_publication_block(self) -> None:
        policy = {
            "enabled": True,
            "allowedTypes": {"requirement"},
            "allowStale": False,
            "minConfidence": 0.0,
            "requireValidators": False,
            "maxPerRun": 5,
        }
        entry = {
            "type": "requirement",
            "status": "candidate",
            "confidence": {"score": 0.9},
            "lifecycle": {"publishBlocked": ["archive source consistency failed"]},
        }
        self.assertFalse(hk.should_auto_promote(entry, policy))


if __name__ == "__main__":
    unittest.main()
