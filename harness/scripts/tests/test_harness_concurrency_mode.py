#!/usr/bin/env python3
"""Tests for concurrency mode contract (C2/T5-T7, retro §5.2).

single-active (default) must block a second active Change at begin time;
isolated-multi-active must require --change and keep state/events/ledger
scoped per change.
"""
from __future__ import annotations

import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_change as hc  # noqa: E402
import harness_gate as hg  # noqa: E402


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _bootstrap_change(project: Path, change_id: str) -> Path:
    change_dir = project / ".harness" / "changes" / change_id
    (change_dir / "meta").mkdir(parents=True, exist_ok=True)
    (change_dir / "evidence").mkdir(parents=True, exist_ok=True)
    (change_dir / "logs").mkdir(parents=True, exist_ok=True)
    (change_dir / "plans").mkdir(parents=True, exist_ok=True)
    _write(change_dir / "meta" / "worktree.json", json.dumps({"requested": False}))
    _write(change_dir / "meta" / "gate-policy.json", json.dumps({
        "schemaVersion": 1,
        "capabilities": [],
        "signals": [],
        "requiredValidationsByPhase": {"run": ["compile"], "test": ["unitTestFull"]}
    }))
    # Mark as active: a plan file makes list_active_changes detect it.
    _write(change_dir / "plans" / f"{change_id}-plan.md", f"---\nchange-name: {change_id}\nstatus: approved\n---\n# {change_id}\n")
    return change_dir


def _write_config(project: Path, mode: str) -> None:
    cfg = project / ".harness" / "config.json"
    _write(cfg, json.dumps({"concurrencyMode": mode}))


class ConcurrencyModeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-concurrency-"))
        self.project = self.tmp / "project"
        (self.project / ".harness" / "changes").mkdir(parents=True, exist_ok=True)
        _write_config(self.project, "single-active")
        self.skills_root = self.tmp / "skills"
        (self.skills_root / "harness-plan").mkdir(parents=True, exist_ok=True)
        _write(self.skills_root / "harness-plan" / "SKILL.md", "# plan\n")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_single_active_blocks_second_change_begin(self) -> None:
        # Only one active change: begin allowed.
        _bootstrap_change(self.project, "change-a")
        r1 = hc.check_concurrency_block(self.project, "change-a")
        self.assertIsNone(r1)
        # A second active change appears: the second must be blocked.
        _bootstrap_change(self.project, "change-b")
        r2 = hc.check_concurrency_block(self.project, "change-b")
        self.assertIsNotNone(r2)
        self.assertEqual(r2.get("code"), "SINGLE_ACTIVE_BLOCKED")
        self.assertIn("portfolio", (r2.get("message") or "").lower())

    def test_isolated_multi_active_allows_second_change(self) -> None:
        _write_config(self.project, "isolated-multi-active")
        _bootstrap_change(self.project, "change-a")
        _bootstrap_change(self.project, "change-b")
        r1 = hc.check_concurrency_block(self.project, "change-a")
        self.assertIsNone(r1)
        r2 = hc.check_concurrency_block(self.project, "change-b")
        self.assertIsNone(r2)

    def test_resolve_requires_change_when_multi_active(self) -> None:
        _write_config(self.project, "isolated-multi-active")
        _bootstrap_change(self.project, "change-a")
        _bootstrap_change(self.project, "change-b")
        result = hc.resolve_change(self.project, None)
        self.assertFalse(result.get("ok"))
        self.assertEqual(result.get("code"), "CHANGE_SELECTION_REQUIRED")

    def test_preflight_reports_concurrency_mode(self) -> None:
        import harness_preflight as hp
        result = hp.check_concurrency(self.project)
        self.assertEqual(result.get("concurrencyMode"), "single-active")
        self.assertIn("activeChanges", result)
        self.assertIn("allowedParallelLevels", result)


if __name__ == "__main__":
    unittest.main()
