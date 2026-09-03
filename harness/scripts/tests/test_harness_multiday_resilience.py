#!/usr/bin/env python3
"""P1 regression coverage for multi-day execution resilience."""

from __future__ import annotations

import json
import shutil
import subprocess
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
import harness_gate as hg  # noqa: E402
import harness_integration as hi  # noqa: E402
import harness_phase as hp  # noqa: E402


def _write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )


class MultiDayResilienceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-multiday-p1-"))
        self.project = self.tmp / "project"
        self.project.mkdir()
        subprocess.run(
            ["git", "init"],
            cwd=self.project,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "config", "user.email", "tests@example.invalid"],
            cwd=self.project,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Harness Tests"],
            cwd=self.project,
            check=True,
            capture_output=True,
        )
        (self.project / "README.md").write_text("demo\n", encoding="utf-8")
        subprocess.run(
            ["git", "add", "."],
            cwd=self.project,
            check=True,
            capture_output=True,
        )
        subprocess.run(
            ["git", "commit", "-m", "init"],
            cwd=self.project,
            check=True,
            capture_output=True,
        )
        self.change = self.project / ".harness" / "changes" / "demo"
        self.change.mkdir(parents=True)
        self.subject = {
            "productCommit": "a" * 40,
            "productTreeHash": "sha256:" + "b" * 64,
            "environmentHash": "sha256:" + "c" * 64,
        }

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_attempts_are_typed_and_timing_dimensions_conserve_wall_clock(self) -> None:
        events = [
            {
                "phase": "execute",
                "type": "phase.start",
                "attempt": 1,
                "timestamp": "2026-01-01T00:00:00+00:00",
            },
            {
                "phase": "review",
                "type": "phase.start",
                "attempt": 1,
                "timestamp": "2026-01-01T00:00:05+00:00",
            },
            {
                "phase": "execute",
                "type": "phase.end",
                "attempt": 1,
                "status": "OK",
                "timestamp": "2026-01-01T00:00:10+00:00",
            },
            {
                "phase": "review",
                "type": "phase.end",
                "attempt": 1,
                "status": "OK",
                "timestamp": "2026-01-01T00:00:15+00:00",
            },
            {
                "phase": "workflow",
                "type": "external.wait",
                "timestamp": "2026-01-01T00:00:15+00:00",
                "endedAt": "2026-01-01T00:00:20+00:00",
            },
            {
                "phase": "workflow",
                "type": "workflow.pause",
                "timestamp": "2026-01-01T00:00:20+00:00",
            },
            {
                "phase": "workflow",
                "type": "workflow.resume",
                "timestamp": "2026-01-01T00:00:30+00:00",
            },
            {
                "phase": "archive",
                "type": "phase.end",
                "status": "OK",
                "timestamp": "2026-01-01T00:00:40+00:00",
            },
        ]

        timing = ha.build_workflow_timing(
            events,
            report_cutoff_at="2026-01-01T00:00:40+00:00",
        )

        self.assertEqual(timing["workflowWallClockMs"], 40_000)
        self.assertEqual(timing["attributedStageUnionMs"], 15_000)
        self.assertEqual(timing["externalWaitMs"], 5_000)
        self.assertEqual(timing["pausedMs"], 10_000)
        self.assertEqual(timing["agentOrToolUnattributedMs"], 10_000)
        self.assertEqual(timing["conservationDeltaMs"], 0)
        self.assertEqual(len(timing["sessions"]), 2)

        incomplete = he.attempt_invocations(
            [
                {
                    "phase": "review",
                    "type": "phase.start",
                    "attempt": 1,
                    "timestamp": "2026-01-01T00:00:00+00:00",
                },
                {
                    "phase": "review",
                    "type": "phase.start",
                    "attempt": 2,
                    "timestamp": "2026-01-01T00:00:10+00:00",
                },
                {
                    "phase": "review",
                    "type": "phase.end",
                    "attempt": 2,
                    "status": "OK",
                    "timestamp": "2026-01-01T00:00:20+00:00",
                },
            ]
        )
        self.assertEqual(incomplete[0]["terminalStatus"], "RECOVERED")
        self.assertEqual(incomplete[0]["durationMs"], 10_000)

    def test_environment_failures_do_not_create_full_test_results(self) -> None:
        for signature in ("db-empty", "docker-fsync"):
            failed = hp.record_environment_attempt(
                self.change,
                self.subject,
                stage="prepare",
                status="ENVIRONMENT_ERROR",
                duration_ms=1_000,
                failure_signature=signature,
            )
            self.assertFalse(failed["ok"], failed)

        journal = hp.load_environment_execution_journal(self.change)
        self.assertEqual(len(journal["environmentAttempts"]), 2)
        self.assertEqual(journal["fullExecutions"], [])

        self.assertTrue(
            hp.record_environment_attempt(
                self.change,
                self.subject,
                stage="prepare",
                status="OK",
                duration_ms=2_000,
            )["ok"]
        )
        self.assertTrue(
            hp.record_environment_attempt(
                self.change,
                self.subject,
                stage="verify",
                status="OK",
                duration_ms=500,
            )["ok"]
        )
        full = hp.record_full_test_execution(
            self.change,
            self.subject,
            status="OK",
            prepare_ms=2_000,
            test_ms=5_000,
            cleanup_ms=750,
            result_digest="sha256:" + "d" * 64,
        )
        self.assertTrue(full["ok"], full)
        journal = hp.load_environment_execution_journal(self.change)
        self.assertEqual(len(journal["fullExecutions"]), 1)
        self.assertEqual(journal["fullExecutions"][0]["testExecutionMs"], 5_000)

    def test_degraded_projection_blocks_release_phases_only(self) -> None:
        _write_json(
            self.project / ".harness" / "config" / "projection-receipt.json",
            {
                "schemaVersion": 1,
                "status": "degraded",
                "source": {"hash": "sha256:" + "1" * 64},
                "transform": {
                    "version": "project-v2",
                    "hash": "sha256:" + "2" * 64,
                },
                "target": {"hash": "sha256:" + "3" * 64},
                "projectOwnedExclusions": ["local.env"],
                "generatedAt": "2026-01-01T00:00:00Z",
            },
        )

        exploratory = hg.evaluate_projection_gate(self.project, "run")
        self.assertTrue(exploratory["ok"], exploratory)
        self.assertEqual(exploratory["mode"], "fallback")

        release = hg.evaluate_projection_gate(self.project, "submit")
        self.assertFalse(release["ok"], release)
        self.assertEqual(release["code"], "PROJECTION_DEGRADED_BLOCKED")

    def test_artifact_budget_fails_before_staging_and_blobs_are_reused(self) -> None:
        (self.change / "large.bin").write_bytes(b"x" * 64)
        _write_json(
            self.project / ".harness" / "config" / "artifact-policy.json",
            {"schemaVersion": 1, "maxTotalBytes": 32, "maxFileBytes": 128},
        )
        budget = ha.evaluate_artifact_budget(self.change)
        self.assertFalse(budget["ok"], budget)
        self.assertEqual(budget["code"], "ARTIFACT_BUDGET_EXCEEDED")

        archive_root = self.project / ".harness" / "archive"
        # cmd_finalize 的真实门顺序：check_status → sensitive_evidence_refresh →
        # sensitive_evidence_gate → exact_byte → artifact_budget。本测试只关心
        # budget 在 staging 之前触发，mock 掉前序门让流程走到 budget；
        # 门顺序本身的正确性由 test_harness_archive.py 的集成测试覆盖。
        with (
            mock.patch.object(
                ha, "check_status",
                return_value={"archivable": True, "blockers": []},
            ),
            mock.patch.object(
                ha.hruntime, "refresh_sensitive_evidence_scan_receipt",
                return_value={"ok": True, "receipt": None},
            ),
            mock.patch.object(
                ha, "validate_sensitive_evidence_publication_gate",
                return_value={"ok": True},
            ),
        ):
            code, payload = ha.cmd_finalize(
                self.change,
                archive_root,
                archive_intent="record-only",
                skip_ingest=True,
            )
        self.assertEqual(code, 1, payload)
        self.assertEqual(payload["error"], "artifact budget exceeded before staging")
        self.assertFalse(Path(payload["operationTempDir"]).exists())

        (self.project / ".harness" / "config" / "artifact-policy.json").unlink()
        shared = self.project / "shared.bin"
        shared.write_bytes(b"shared-content" * 128)
        first_change = self.change
        second_change = self.project / ".harness" / "changes" / "demo-2"
        second_change.mkdir(parents=True)
        event = {
            "schema_version": 3,
            "id": "artifact-1",
            "phase": "execute",
            "type": "artifact",
            "path": "shared.bin",
            "kind": "test-data",
        }
        for target in (first_change, second_change):
            (target / "events.ndjson").write_text(
                json.dumps(event) + "\n",
                encoding="utf-8",
            )
        first = ha.materialize_repository_artifacts(first_change)
        second = ha.materialize_repository_artifacts(second_change)
        self.assertGreater(first["bytesAdded"], 0)
        self.assertEqual(second["bytesAdded"], 0)
        self.assertEqual(second["bytesReused"], first["bytesAdded"])

    def test_worktree_retirement_blocks_active_capsule_agent_and_junction(self) -> None:
        target = self.project / ".worktrees" / "demo"
        target.mkdir(parents=True)
        capsule = {
            "schemaVersion": 1,
            "phase": "execute",
            "runId": "active",
            "executionRoot": str(target.resolve()),
            "closeTransaction": {"status": "CLOSING"},
        }
        _write_json(
            self.change / "runtime" / "phase-context" / "run-active.json",
            capsule,
        )
        junction_source = self.project / "node_modules"
        blocked = hi.evaluate_worktree_retirement(
            self.project,
            target,
            change_dir=self.change,
            agent_root=target,
            junction_dependencies=[
                {
                    "source": str(junction_source),
                    "target": str(target),
                    "owner": "demo",
                }
            ],
        )
        self.assertFalse(blocked["ok"], blocked)
        blocker_codes = {item["code"] for item in blocked["blockers"]}
        self.assertEqual(
            blocker_codes,
            {
                "ACTIVE_PHASE_CAPSULE",
                "AGENT_STILL_ATTACHED",
                "JUNCTION_DEPENDENCY_ACTIVE",
            },
        )


if __name__ == "__main__":
    unittest.main()
