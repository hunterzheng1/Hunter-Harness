#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS_DIR = Path(__file__).resolve().parents[1]


def load_module(name: str, filename: str):
    path = SCRIPTS_DIR / filename
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


finalizer = load_module("harness_plan_finalize", "harness_plan_finalize.py")


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def valid_markdown(change: str, title: str) -> str:
    return (
        "---\n"
        f"change-name: {change}\n"
        "status: approved\n"
        "---\n\n"
        f"# {title}\n"
    )


def seed_staging(root: Path, change: str = "demo") -> None:
    write(root / "spec" / f"{change}-design.md", valid_markdown(change, "Design"))
    write(root / "plans" / f"{change}-plan.md", valid_markdown(change, "Plan"))
    write(
        root / "plans" / f"{change}-implementation-detail.md",
        valid_markdown(change, "Implementation"),
    )
    write(
        root / "plans" / f"{change}-test-scenarios.md",
        valid_markdown(change, "Scenarios"),
    )
    write(root / "meta" / "gate-policy.json", json.dumps({"schemaVersion": 1}))
    write(
        root / "meta" / "worktree.json",
        json.dumps({"requested": False, "agent": "codex"}),
    )


class PlanFinalizeTests(unittest.TestCase):
    def test_invalid_staging_publishes_nothing_and_writes_no_terminal(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            staging = root / "staging"
            change_dir = root / ".harness" / "changes" / "demo"
            seed_staging(staging)
            write(staging / "meta" / "gate-policy.json", "{invalid")

            result = finalizer.finalize_plan(
                change_dir,
                staging,
                change_name="demo",
                run_id="plan-run",
                attempt=1,
            )

            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "PLAN_ARTIFACT_INVALID_JSON")
            self.assertFalse((change_dir / "spec").exists())
            self.assertFalse((change_dir / "events.ndjson").exists())
            self.assertFalse((change_dir / "logs" / "execution-log.md").exists())

            write(
                staging / "meta" / "gate-policy.json",
                json.dumps({"schemaVersion": 1}),
            )
            recovered = finalizer.finalize_plan(
                change_dir,
                staging,
                change_name="demo",
                run_id="plan-run",
                attempt=1,
            )
            self.assertTrue(recovered["ok"])
            self.assertTrue((change_dir / "spec" / "demo-design.md").is_file())

    def test_success_is_idempotent_and_has_one_terminal_event(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            staging = root / "staging"
            change_dir = root / ".harness" / "changes" / "demo"
            seed_staging(staging)

            first = finalizer.finalize_plan(
                change_dir,
                staging,
                change_name="demo",
                run_id="plan-run",
                attempt=1,
            )
            second = finalizer.finalize_plan(
                change_dir,
                staging,
                change_name="demo",
                run_id="plan-run",
                attempt=1,
            )

            self.assertTrue(first["ok"])
            self.assertTrue(second["ok"])
            self.assertTrue(second["idempotent"])
            lines = (change_dir / "events.ndjson").read_text(encoding="utf-8").splitlines()
            events = [json.loads(line) for line in lines if line.strip()]
            terminals = [event for event in events if event.get("type") == "phase.end"]
            self.assertEqual(len(terminals), 1)
            self.assertEqual(terminals[0]["status"], "OK")
            self.assertTrue((change_dir / "logs" / "execution-log.md").is_file())
            receipt = json.loads(
                (change_dir / "meta" / "plan-finalization.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(receipt["status"], "finalized")
            self.assertEqual(receipt["artifactsHash"], first["artifactsHash"])

    def test_conflicting_existing_target_is_rejected_without_overwrite(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            staging = root / "staging"
            change_dir = root / ".harness" / "changes" / "demo"
            seed_staging(staging)
            target = change_dir / "spec" / "demo-design.md"
            write(target, "user-owned\n")
            before = target.read_bytes()

            result = finalizer.finalize_plan(
                change_dir,
                staging,
                change_name="demo",
                run_id="plan-run",
                attempt=1,
            )

            self.assertFalse(result["ok"])
            self.assertEqual(result["code"], "PLAN_TARGET_CONFLICT")
            self.assertEqual(target.read_bytes(), before)
            self.assertFalse((change_dir / "events.ndjson").exists())

    def test_final_receipt_failure_preserves_recoverable_terminal_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            staging = root / "staging"
            change_dir = root / ".harness" / "changes" / "demo"
            seed_staging(staging)
            real_write = finalizer._atomic_write_json
            writes = 0

            def fail_final_receipt(path: Path, payload: dict[str, object]) -> None:
                nonlocal writes
                writes += 1
                if writes == 2:
                    raise OSError("injected finalized receipt failure")
                real_write(path, payload)

            with mock.patch.object(
                finalizer, "_atomic_write_json", side_effect=fail_final_receipt
            ):
                failed = finalizer.finalize_plan(
                    change_dir,
                    staging,
                    change_name="demo",
                    run_id="plan-run",
                    attempt=1,
                )

            self.assertFalse(failed["ok"])
            self.assertEqual(failed["code"], "PLAN_FINALIZATION_RECOVERY_REQUIRED")
            self.assertTrue((change_dir / "spec" / "demo-design.md").is_file())
            receipt_path = change_dir / "meta" / "plan-finalization.json"
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            self.assertEqual(receipt["status"], "publishing")
            lines = (change_dir / "events.ndjson").read_text(encoding="utf-8").splitlines()
            terminals = [
                json.loads(line)
                for line in lines
                if line.strip() and json.loads(line).get("type") == "phase.end"
            ]
            self.assertEqual(len(terminals), 1)

            recovered = finalizer.finalize_plan(
                change_dir,
                staging,
                change_name="demo",
                run_id="plan-run",
                attempt=1,
            )

            self.assertTrue(recovered["ok"])
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            self.assertEqual(receipt["status"], "finalized")
            lines = (change_dir / "events.ndjson").read_text(encoding="utf-8").splitlines()
            self.assertEqual(
                sum(json.loads(line).get("type") == "phase.end" for line in lines),
                1,
            )


if __name__ == "__main__":
    unittest.main()
