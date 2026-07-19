#!/usr/bin/env python3
"""Focused tests for phase reconcile and observability contracts."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest import mock


SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_phase as hp  # noqa: E402
import harness_events as he  # noqa: E402
import harness_archive as ha  # noqa: E402
import harness_gate as hg  # noqa: E402


class ReconcileDagTests(unittest.TestCase):
    def setUp(self) -> None:
        self.dag = {
            "schemaVersion": 1,
            "nodes": [
                {"id": "validation:compile", "kind": "validation", "dependsOn": []},
                {
                    "id": "validation:unitTest",
                    "kind": "validation",
                    "dependsOn": ["validation:compile"],
                },
                {
                    "id": "validation:apiTest",
                    "kind": "validation",
                    "dependsOn": ["validation:unitTest"],
                },
                {
                    "id": "stage:report",
                    "kind": "stage",
                    "dependsOn": ["validation:apiTest"],
                },
            ],
        }

    def test_obs_ut001_all_unchanged_nodes_reuse(self) -> None:
        result = hp.reconcile_dag(
            self.dag,
            {node["id"]: {"reusable": True, "reason": "hash-match"} for node in self.dag["nodes"]},
            identity={"ok": True, "code": "IDENTITY_OK"},
        )

        self.assertTrue(result["canClose"])
        self.assertEqual({node["decision"] for node in result["nodes"]}, {"REUSE"})

    def test_obs_ut002_changed_node_invalidates_only_it_and_downstream(self) -> None:
        evidence = {
            "validation:compile": {"reusable": True, "reason": "hash-match"},
            "validation:unitTest": {"reusable": True, "reason": "hash-match"},
            "validation:apiTest": {"reusable": False, "reason": "inputs-changed"},
            "stage:report": {"reusable": True, "reason": "already-rendered"},
        }

        result = hp.reconcile_dag(
            self.dag, evidence, identity={"ok": True, "code": "IDENTITY_OK"}
        )
        decisions = {node["id"]: node["decision"] for node in result["nodes"]}

        self.assertEqual(decisions["validation:compile"], "REUSE")
        self.assertEqual(decisions["validation:unitTest"], "REUSE")
        self.assertEqual(decisions["validation:apiTest"], "RUN")
        self.assertEqual(decisions["stage:report"], "RUN")

    def test_obs_ut003_identity_mismatch_blocks_every_node(self) -> None:
        result = hp.reconcile_dag(
            self.dag,
            {},
            identity={"ok": False, "code": "HEAD_MISMATCH", "message": "wrong head"},
        )

        self.assertFalse(result["canClose"])
        self.assertEqual({node["decision"] for node in result["nodes"]}, {"BLOCK"})
        self.assertIn("HEAD_MISMATCH", result["blockers"][0]["code"])


class TargetPhaseReconcileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.workflow = json.loads(
            (SCRIPTS_DIR.parent / "contracts" / "workflow-policy.json").read_text(
                encoding="utf-8"
            )
        )

    def _policy(self, tier: str) -> dict:
        classified = hg.classify_defaults(
            self.workflow, change_id=f"{tier}-change", stage="pre-run"
        )
        if tier != "full":
            classified = hg.apply_tier_override(
                classified,
                self.workflow,
                tier=tier,
                override_by="test",
            )
        return hg.gate_policy_document(classified)

    def test_real_classifier_policies_only_require_target_predecessors(self) -> None:
        cases = {
            ("fast", "run"): {"validation:unitTest"},
            ("standard", "test"): {
                "validation:compile",
                "validation:unitTest",
                "validation:unitTestFull",
            },
            ("full", "review"): {
                "validation:compile",
                "validation:unitTest",
                "validation:unitTestFull",
                "validation:apiTest",
            },
        }

        for (tier, phase), expected in cases.items():
            with self.subTest(tier=tier, phase=phase):
                target = hp.target_required_dag(self._policy(tier), phase)
                ids = {node["id"] for node in target["nodes"]}
                self.assertEqual(ids, expected)
                self.assertNotIn(f"stage:{phase}", ids)
                result = hp.reconcile_dag(
                    target,
                    {node_id: {"reusable": True} for node_id in ids},
                    identity={"ok": True, "code": "IDENTITY_OK"},
                )
                self.assertTrue(result["canClose"])

    def test_capsule_selection_is_exact_by_phase_and_run_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            change = project / ".harness" / "changes" / "demo"
            capsule_dir = change / "runtime" / "phase-context"
            capsule_dir.mkdir(parents=True)
            expected = {"schemaVersion": 1, "phase": "run", "runId": "run-a"}
            other = {"schemaVersion": 1, "phase": "review", "runId": "run-b"}
            for phase, run_id, value in (
                ("run", "run-a", expected),
                ("review", "run-b", other),
            ):
                key = hp.hashlib.sha256(f"{phase}\0{run_id}".encode()).hexdigest()[:20]
                (capsule_dir / f"{phase}-{key}.json").write_text(
                    json.dumps(value), encoding="utf-8"
                )

            selected = hp.select_phase_capsule(
                change, project, phase="run", run_id="run-a"
            )
            missing = hp.select_phase_capsule(
                change, project, phase="run", run_id="missing"
            )
            unspecified = hp.select_phase_capsule(
                change, project, phase="run", run_id=None
            )

        self.assertTrue(selected["ok"])
        self.assertEqual(selected["capsule"], expected)
        self.assertEqual(missing["code"], "PHASE_CAPSULE_NOT_FOUND")
        self.assertIn("--run-id missing", missing["remediation"])
        self.assertEqual(unspecified["code"], "PHASE_RUN_ID_REQUIRED")

    def test_reconcile_review_does_not_require_its_own_phase_end(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            change = project / ".harness" / "changes" / "demo"
            (change / "meta").mkdir(parents=True)
            (change / "meta" / "gate-policy.json").write_text(
                json.dumps(self._policy("full")), encoding="utf-8"
            )

            def reusable(dag, *_args):
                return {
                    node["id"]: {"reusable": True, "reason": "current"}
                    for node in dag["nodes"]
                }

            with mock.patch.object(hp.hl, "load_ledger", return_value=({}, None)), \
                 mock.patch.object(
                     hp,
                     "assess_identity",
                     return_value={"ok": True, "code": "IDENTITY_OK"},
                 ), \
                 mock.patch.object(hp, "collect_node_evidence", side_effect=reusable):
                result = hp.reconcile(change, project, target_phase="review")

        self.assertTrue(result["canClose"])
        self.assertNotIn("stage:review", {node["id"] for node in result["nodes"]})


class TimingAndTraceTests(unittest.TestCase):
    def test_obs_ut004_timing_dimensions_are_not_conflated(self) -> None:
        events = [
            {"id": "1", "phase": "run", "attempt": 1, "type": "phase.start", "timestamp": "2026-07-19T10:00:00+00:00"},
            {"id": "2", "phase": "run", "attempt": 1, "type": "command", "timestamp": "2026-07-19T10:01:00+00:00", "duration_ms": 30000},
            {"id": "3", "phase": "run", "attempt": 1, "type": "decision", "timestamp": "2026-07-19T10:02:00+00:00", "user_wait_ms": 120000},
            {"id": "4", "phase": "run", "attempt": 1, "type": "phase.end", "timestamp": "2026-07-19T10:05:00+00:00", "status": "OK"},
            {"id": "5", "phase": "run", "attempt": 1, "type": "artifact", "timestamp": "2026-07-19T10:06:00+00:00"},
        ]

        timing = hp.timing_dimensions(events)[0]

        self.assertEqual(timing["runnerMs"], 30000)
        self.assertEqual(timing["orchestrationActiveMs"], 300000)
        self.assertEqual(timing["wallClockMs"], 360000)
        self.assertEqual(timing["userWaitMs"], 120000)

    def test_obs_ut005_trace_parent_child_is_stable_for_legacy_events(self) -> None:
        events = [
            {"id": "a", "phase": "run", "attempt": 1, "type": "phase.start", "executor_tool": "codex"},
            {"id": "b", "phase": "run", "attempt": 1, "type": "command", "executor_tool": "powershell"},
            {"id": "c", "phase": "run", "attempt": 1, "type": "phase.end", "executor_tool": "codex"},
        ]

        first = hp.build_trace(events, change_id="demo")
        second = hp.build_trace(events, change_id="demo")
        phase = next(span for span in first["spans"] if span["kind"] == "phase-attempt")
        tool = next(span for span in first["spans"] if span["kind"] == "tool")

        self.assertEqual(first, second)
        self.assertEqual(tool["parentSpanId"], phase["spanId"])
        self.assertEqual(len(first["traceId"]), 32)

    def test_obs_com001_event_cli_accepts_trace_and_timing_fields(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp)
            code = he.main(
                [
                    "--json",
                    "append",
                    "--change-dir",
                    str(change),
                    "--phase",
                    "run",
                    "--type",
                    "phase.start",
                    "--trace-id",
                    "a" * 32,
                    "--span-id",
                    "b" * 16,
                    "--parent-span-id",
                    "c" * 16,
                    "--orchestration-active-ms",
                    "25",
                    "--user-wait-ms",
                    "10",
                ]
            )
            event = he.load_events(change / "events.ndjson")[0]

        self.assertEqual(code, 0)
        self.assertEqual(event["trace_id"], "a" * 32)
        self.assertEqual(event["orchestration_active_ms"], 25)


class CiMetricsTests(unittest.TestCase):
    def test_obs_ut006_normalizes_junit_vitest_and_playwright(self) -> None:
        junit = hp.normalize_ci_metrics(
            "<testsuite tests='3' failures='1' errors='0' skipped='1' time='1.5'/>",
            runner="junit",
            head_sha="a" * 40,
        )
        vitest = hp.normalize_ci_metrics(
            {"numTotalTestSuites": 2, "numPassedTests": 4, "numFailedTests": 1,
             "numPendingTests": 1, "testResults": [{"perfStats": {"runtime": 25}}]},
            runner="vitest",
            head_sha="b" * 40,
        )
        playwright = hp.normalize_ci_metrics(
            {"suites": [{"title": "e2e"}], "stats": {"expected": 5, "unexpected": 1,
             "skipped": 2, "duration": 99}},
            runner="playwright",
            head_sha="c" * 40,
        )

        self.assertEqual((junit["passed"], junit["failed"], junit["skipped"]), (1, 1, 1))
        self.assertEqual((vitest["suites"], vitest["passed"], vitest["durationMs"]), (2, 4, 25))
        self.assertEqual((playwright["suites"], playwright["failed"]), (1, 1))

    def test_obs_ut007_missing_metrics_are_unknown_not_zero(self) -> None:
        result = hp.normalize_ci_metrics({}, runner="vitest", head_sha=None)

        self.assertIsNone(result["passed"])
        self.assertIsNone(result["durationMs"])
        self.assertIsNone(result["headSha"])

    def test_playwright_top_level_errors_are_setup_errors(self) -> None:
        result = hp.normalize_ci_metrics(
            {
                "suites": [],
                "errors": [{"message": "fixture failed"}, {"message": "setup failed"}],
                "stats": {"expected": 0, "unexpected": 0, "skipped": 0},
            },
            runner="playwright",
            head_sha="e" * 40,
        )

        self.assertEqual(result["setupErrors"], 2)

    def test_obs_ut007_invalid_head_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "headSha"):
            hp.normalize_ci_metrics({}, runner="vitest", head_sha="HEAD")

    def test_obs_int002_ci_artifact_flows_into_archive_without_human_log(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp)
            input_path = change / "vitest.json"
            output_path = change / "evidence" / "ci-metrics.json"
            input_path.write_text(
                json.dumps(
                    {
                        "numTotalTestSuites": 2,
                        "numPassedTests": 4,
                        "numFailedTests": 0,
                        "numPendingTests": 1,
                    }
                ),
                encoding="utf-8",
            )
            code = hp.main(
                [
                    "metrics",
                    "--input",
                    str(input_path),
                    "--runner",
                    "vitest",
                    "--head-sha",
                    "d" * 40,
                    "--output",
                    str(output_path),
                ]
            )

            summary = ha.collect_summary_data(change, write=False)

        self.assertEqual(code, 0)
        self.assertEqual(summary["verification"]["ciMetrics"]["passed"], 4)
        self.assertIn("evidence/ci-metrics.json", summary["reportPipeline"]["sources"])


class OutputAndCliTests(unittest.TestCase):
    def test_obs_ut008_compact_output_only_shows_changed_and_blocked(self) -> None:
        result = {
            "nodes": [
                {"id": "validation:compile", "decision": "REUSE"},
                {"id": "validation:apiTest", "decision": "RUN", "reason": "inputs-changed"},
            ],
            "blockers": [],
        }

        text = hp.format_compact(result)

        self.assertNotIn("validation:compile", text)
        self.assertIn("RUN validation:apiTest", text)

    def test_obs_ut008_compact_error_never_reports_empty_reuse(self) -> None:
        text = hp.format_compact(
            {"ok": False, "code": "RECONCILE_FAILED", "error": "bad policy"}
        )

        self.assertEqual(text, "BLOCK RECONCILE_FAILED: bad policy")

    def test_obs_cli003_json_contains_identity_trace_and_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            change = root / ".harness" / "changes" / "demo"
            (change / "meta").mkdir(parents=True)
            (change / "meta" / "gate-policy.json").write_text(
                json.dumps(
                    {
                        "requiredGateDag": {
                            "schemaVersion": 1,
                            "nodes": [{"id": "validation:compile", "kind": "validation", "dependsOn": []}],
                            "edges": [],
                        }
                    }
                ),
                encoding="utf-8",
            )
            out = StringIO()
            with redirect_stdout(out):
                code = hp.main(
                    [
                        "reconcile",
                        "--change-dir",
                        str(change),
                        "--project",
                        str(root),
                        "--json",
                    ]
                )
            payload = json.loads(out.getvalue())

        self.assertEqual(code, 0)
        self.assertIn("identity", payload)
        self.assertIn("trace", payload)
        self.assertIn("evidence", payload["nodes"][0])

    def test_obs_cli002_explicit_close_refuses_to_skip_required_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            change = root / ".harness" / "changes" / "demo"
            (change / "meta").mkdir(parents=True)
            (change / "meta" / "gate-policy.json").write_text(
                json.dumps(
                    {
                        "requiredGateDag": {
                            "schemaVersion": 1,
                            "nodes": [{"id": "validation:compile", "kind": "validation", "dependsOn": []}],
                            "edges": [],
                        }
                    }
                ),
                encoding="utf-8",
            )
            out = StringIO()
            with redirect_stdout(out):
                code = hp.main(
                    [
                        "reconcile",
                        "--change-dir",
                        str(change),
                        "--project",
                        str(root),
                        "--close",
                        "--json",
                    ]
                )
            payload = json.loads(out.getvalue())

        self.assertEqual(code, 2)
        self.assertEqual(payload["close"]["code"], "RECONCILE_NOT_CLOSABLE")


class ReconcileIntegrationTests(unittest.TestCase):
    def test_obs_int001_v3_identity_reuses_compile_and_invalidates_only_api(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            subprocess.run(["git", "init"], cwd=project, check=True, capture_output=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=project, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=project, check=True)
            (project / "src").mkdir()
            source_file = project / "src" / "app.py"
            api_file = project / "src" / "api-contract.json"
            source_file.write_text("print('ok')\n", encoding="utf-8")
            api_file.write_text("{}\n", encoding="utf-8")
            subprocess.run(["git", "add", "-A"], cwd=project, check=True)
            subprocess.run(["git", "commit", "-m", "base"], cwd=project, check=True, capture_output=True)
            head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=project, text=True).strip()

            change = project / ".harness" / "changes" / "demo"
            (change / "meta").mkdir(parents=True)
            contract = {
                "schemaVersion": 2,
                "changeId": "demo",
                "lifecycle": {"status": "active"},
                "ownership": {
                    "productPaths": ["src/"],
                    "staticEvidencePaths": [".harness/changes/demo/spec"],
                    "excludedPaths": [".harness/state/"],
                },
                "stateOwnership": {
                    "contractRoot": ".harness/changes/demo",
                    "runtimeRoot": ".harness/state/changes/demo",
                },
            }
            (change / "meta" / "change-context.json").write_text(
                json.dumps(contract), encoding="utf-8"
            )
            dag = {
                "schemaVersion": 1,
                "nodes": [
                    {"id": "validation:compile", "kind": "validation", "dependsOn": []},
                    {"id": "validation:unitTest", "kind": "validation", "dependsOn": ["validation:compile"]},
                    {"id": "validation:apiTest", "kind": "validation", "dependsOn": ["validation:unitTest"]},
                ],
                "edges": [],
            }
            (change / "meta" / "gate-policy.json").write_text(
                json.dumps({"requiredGateDag": dag}), encoding="utf-8"
            )
            source_hash, source_files = hp.hl.compute_inputs_hash([str(source_file)])
            api_hash, api_files = hp.hl.compute_inputs_hash([str(api_file)])

            def entry(command: str, inputs_hash: str, files: list[str]) -> dict:
                return {
                    "status": "OK",
                    "command": command,
                    "evidence": "passed",
                    "inputsHash": inputs_hash,
                    "inputsFiles": files,
                    "algorithmVersion": hp.hl.LEDGER_VERSION,
                    "coverage": "module",
                    "scope": "module",
                }

            ledger = {
                "schemaVersion": 3,
                "repositoryId": hp.hpaths.repository_identity(project),
                "changeName": "demo",
                "baseCommit": head,
                "currentHead": head,
                "diffHash": hp.hl.compute_ownership_diff(
                    project, base=head, change_dir=change
                )["diffHash"],
                "ownershipHash": hp.hl.ownership_hash(contract),
                "validations": {
                    "compile": entry("compile", source_hash, source_files),
                    "unitTest": entry("unit", source_hash, source_files),
                    "apiTest": entry("api", api_hash, api_files),
                },
            }
            ledger_path = hp.hl.preferred_write_path(change)
            ledger_path.parent.mkdir(parents=True, exist_ok=True)
            ledger_path.write_text(json.dumps(ledger), encoding="utf-8")

            unchanged = hp.reconcile(change, project)
            api_file.write_text('{"changed": true}\n', encoding="utf-8")
            changed = hp.reconcile(change, project)

        self.assertTrue(unchanged["canClose"])
        decisions = {node["id"]: node["decision"] for node in changed["nodes"]}
        self.assertEqual(decisions["validation:compile"], "REUSE")
        self.assertEqual(decisions["validation:unitTest"], "REUSE")
        self.assertEqual(decisions["validation:apiTest"], "RUN")


if __name__ == "__main__":
    unittest.main()
