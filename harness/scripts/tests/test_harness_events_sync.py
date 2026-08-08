from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock


SCRIPTS_DIR = Path(__file__).resolve().parents[1]


def load_module(name: str, filename: str):
    path = SCRIPTS_DIR / filename
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


hes = load_module("harness_events_sync_test", "harness_events_sync.py")
he = load_module("harness_events_test_sync", "harness_events.py")


class HarnessEventsSyncTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="hh-events-sync-")
        self.project = Path(self._tmp.name)
        self.change_dir = self.project / ".harness" / "changes" / "demo"
        self.change_dir.mkdir(parents=True)
        (self.project / ".harness" / "credentials.local.yaml").write_text(
            "server_url: https://platform.example.test\n"
            "token: test-token\n"
            "project_id: prj_demo\n",
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def write_events(self, count: int) -> None:
        lines = []
        for index in range(1, count + 1):
            lines.append(json.dumps({
                "schema_version": 3,
                "id": f"evt-{index}",
                "timestamp": f"2026-08-08T10:00:{index % 60:02d}+08:00",
                "type": "decision",
                "phase": "plan",
                "attempt": 1,
                "decision": f"decision-{index}",
                "reason": "test",
                "note": "",
            }))
        (self.change_dir / "events.ndjson").write_text(
            "\n".join(lines) + "\n", encoding="utf-8"
        )

    def test_preserves_canonical_event_time_and_schema_fields(self) -> None:
        event = {
            "id": "evt-1",
            "timestamp": "2026-08-08T10:00:00+08:00",
            "schema_version": 3,
            "type": "phase.start",
            "phase": "plan",
        }

        payload = hes.sanitize(event)

        self.assertIn("timestamp", payload)
        self.assertIn("schema_version", payload)
        self.assertEqual(payload["timestamp"], event["timestamp"])
        self.assertEqual(payload["schema_version"], 3)

    def test_sends_bounded_batches_and_advances_the_cursor(self) -> None:
        self.write_events(501)
        batch_sizes: list[int] = []

        def post_json(_endpoint, path: str, body: dict):
            if path.endswith("/heartbeats"):
                return {"ok": True}
            events = body["events"]
            batch_sizes.append(len(events))
            return {
                "items": [
                    {"id": event["event_id"], "status": "accepted"}
                    for event in events
                ]
            }

        with mock.patch.object(hes, "post_json", side_effect=post_json):
            result = hes.sync_change(self.project, self.change_dir)

        self.assertTrue(result["ok"], result)
        self.assertEqual(sum(batch_sizes), 501)
        self.assertLessEqual(max(batch_sizes), 100)
        self.assertEqual(hes.load_cursor(self.change_dir), 501)

    def test_quarantines_one_conflict_without_blocking_later_events(self) -> None:
        self.write_events(3)

        def post_json(_endpoint, path: str, body: dict):
            if path.endswith("/heartbeats"):
                return {"ok": True}
            events = body["events"]
            return {
                "items": [
                    {"id": events[0]["event_id"], "status": "accepted"},
                    {
                        "id": events[1]["event_id"],
                        "status": "id_conflict",
                        "error_code": "ID_CONFLICT",
                    },
                    {"id": events[2]["event_id"], "status": "accepted"},
                ]
            }

        with mock.patch.object(hes, "post_json", side_effect=post_json):
            result = hes.sync_change(self.project, self.change_dir)

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["uploaded"], 2)
        self.assertEqual(result["quarantined"], 1)
        self.assertEqual(hes.load_cursor(self.change_dir), 3)
        quarantine = self.change_dir / "meta" / "events-sync-quarantine.ndjson"
        record = json.loads(quarantine.read_text(encoding="utf-8").strip())
        self.assertEqual(record["event_id"], "evt-2")
        self.assertEqual(record["error_code"], "ID_CONFLICT")

    def test_quarantines_rejected_schema_without_blocking_later_events(self) -> None:
        self.write_events(3)

        def post_json(_endpoint, path: str, body: dict):
            if path.endswith("/heartbeats"):
                return {"ok": True}
            events = body["events"]
            return {
                "items": [
                    {"id": events[0]["event_id"], "status": "accepted"},
                    {
                        "id": events[1]["event_id"],
                        "status": "rejected_schema",
                        "error_code": "INVALID_EVENT",
                    },
                    {"id": events[2]["event_id"], "status": "accepted"},
                ]
            }

        with mock.patch.object(hes, "post_json", side_effect=post_json):
            result = hes.sync_change(self.project, self.change_dir)

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["uploaded"], 2)
        self.assertEqual(result["quarantined"], 1)
        self.assertEqual(hes.load_cursor(self.change_dir), 3)

    def test_repairs_invalid_or_out_of_bounds_cursor_before_upload(self) -> None:
        self.write_events(2)
        cursor = hes.cursor_path(self.change_dir)
        cursor.parent.mkdir(parents=True, exist_ok=True)

        for invalid in ("not-a-number", 999999, -1, True):
            with self.subTest(invalid=invalid):
                cursor.write_text(
                    json.dumps({"schemaVersion": 1, "acked_lines": invalid}),
                    encoding="utf-8",
                )
                uploaded: list[str] = []

                def post_json(_endpoint, path: str, body: dict):
                    if path.endswith("/heartbeats"):
                        return {"ok": True}
                    uploaded.extend(event["event_id"] for event in body["events"])
                    return {
                        "items": [
                            {"id": event["event_id"], "status": "accepted"}
                            for event in body["events"]
                        ]
                    }

                with mock.patch.object(hes, "post_json", side_effect=post_json):
                    result = hes.sync_change(self.project, self.change_dir)

                self.assertTrue(result["ok"], result)
                self.assertEqual(uploaded, ["evt-1", "evt-2"])
                self.assertEqual(hes.load_cursor(self.change_dir), 2)

    def test_cursor_persistence_uses_atomic_replace_and_fsync(self) -> None:
        with (
            mock.patch.object(hes.os, "replace", wraps=os.replace) as replace,
            mock.patch.object(hes.os, "fsync", wraps=os.fsync) as fsync,
        ):
            hes.save_cursor(self.change_dir, 7)

        self.assertTrue(replace.called)
        self.assertTrue(fsync.called)
        self.assertEqual(hes.load_cursor(self.change_dir), 7)

    def test_snapshot_waits_for_writer_lock_instead_of_quarantining_a_partial_tail(self) -> None:
        event = {
            "schema_version": 3,
            "id": "evt-concurrent",
            "timestamp": "2026-08-08T10:00:00+08:00",
            "type": "decision",
            "phase": "plan",
            "decision": "complete only after unlock",
        }
        encoded = (json.dumps(event) + "\n").encode("utf-8")
        split_at = len(encoded) // 2
        events_file = self.change_dir / "events.ndjson"
        lock_path = events_file.with_name(events_file.name + ".lock")
        batch_called = threading.Event()
        results: list[dict] = []

        def post_json(_endpoint, path: str, body: dict):
            if path.endswith("/heartbeats"):
                return {"ok": True}
            batch_called.set()
            return {
                "items": [
                    {"id": item["event_id"], "status": "accepted"}
                    for item in body["events"]
                ]
            }

        with mock.patch.object(hes, "post_json", side_effect=post_json):
            with he.event_file_lock(lock_path):
                with events_file.open("wb") as stream:
                    stream.write(encoded[:split_at])
                    stream.flush()
                    os.fsync(stream.fileno())
                reader = threading.Thread(
                    target=lambda: results.append(hes.sync_change(self.project, self.change_dir)),
                    daemon=True,
                )
                reader.start()
                time.sleep(0.05)
                self.assertFalse(batch_called.is_set())
                with events_file.open("ab") as stream:
                    stream.write(encoded[split_at:])
                    stream.flush()
                    os.fsync(stream.fileno())
            reader.join(timeout=2)
        self.assertFalse(reader.is_alive())
        self.assertTrue(results[0]["ok"], results[0])
        self.assertEqual(results[0]["uploaded"], 1)
        self.assertEqual(results[0]["quarantined"], 0)
        self.assertEqual(hes.load_cursor(self.change_dir), 1)

    def test_split_v1_append_syncs_from_state_root_and_keeps_sync_state_there(self) -> None:
        subprocess.run(
            ["git", "init", "--quiet"], cwd=self.project, check=True,
            capture_output=True,
        )
        contract_dir = self.project / ".harness" / "changes" / "split-demo"
        (contract_dir / "meta").mkdir(parents=True)
        (contract_dir / "meta" / "change-context.json").write_text(
            json.dumps({
                "schemaVersion": 2,
                "changeId": "split-demo",
                "stateOwnership": {
                    "contractRoot": ".harness/changes/split-demo",
                    "runtimeRoot": ".harness/state/changes/split-demo",
                },
            }),
            encoding="utf-8",
        )
        state_dir = self.project / ".harness" / "state" / "changes" / "split-demo"
        with mock.patch.object(he, "_nudge_remote_sync"):
            appended = he.append_event(
                contract_dir,
                phase="plan",
                type_="decision",
                note="split routing",
            )
        self.assertTrue(appended["ok"], appended)
        self.assertTrue((state_dir / "events.ndjson").is_file())
        self.assertFalse((contract_dir / "events.ndjson").exists())

        def post_json(_endpoint, path: str, body: dict):
            if path.endswith("/heartbeats"):
                return {"ok": True}
            return {
                "items": [
                    {"id": item["event_id"], "status": "accepted"}
                    for item in body["events"]
                ]
            }

        with mock.patch.object(hes, "post_json", side_effect=post_json):
            result = hes.sync_change(self.project, contract_dir)

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["uploaded"], 1)
        self.assertEqual(hes.cursor_path(contract_dir), state_dir / "meta" / "events-sync-cursor.json")
        self.assertEqual(
            hes.quarantine_path(contract_dir),
            state_dir / "meta" / "events-sync-quarantine.ndjson",
        )
        self.assertEqual(hes.load_cursor(contract_dir), 1)

    def test_exit_boundary_nudge_waits_for_current_worker_and_is_processed(self) -> None:
        primary = hes._CrossProcessLock(hes._agent_lock_path(self.project))
        self.assertTrue(primary.acquire(blocking=False))
        observed_generations: list[str] = []
        results: list[dict] = []

        def session(project_root: Path) -> dict:
            observed_generations.append(hes._read_nudge_generation(project_root))
            return {"ok": True, "uploaded": 0, "quarantined": 0, "attempts": 1}

        with (
            mock.patch.object(hes, "_run_agent_session", side_effect=session),
            mock.patch.object(hes.subprocess, "Popen"),
        ):
            self.assertTrue(hes.schedule_events_sync(self.project, self.change_dir))
            expected = hes._read_nudge_generation(self.project)
            follower = threading.Thread(
                target=lambda: results.append(hes.run_agent(self.project)), daemon=True
            )
            follower.start()
            time.sleep(0.05)
            self.assertTrue(follower.is_alive(), "handoff worker must wait instead of dropping the nudge")
            primary.release()
            follower.join(timeout=2)

        self.assertFalse(follower.is_alive())
        self.assertEqual(observed_generations, [expected])
        self.assertTrue(results[0]["ok"])

    def test_live_slow_worker_lock_is_never_stolen_by_age(self) -> None:
        primary_path = hes._agent_lock_path(self.project)
        primary = hes._CrossProcessLock(primary_path)
        self.assertTrue(primary.acquire(blocking=False))
        old = time.time() - 3600
        os.utime(primary_path, (old, old))
        entered = threading.Event()

        def session(_project_root: Path) -> dict:
            entered.set()
            return {"ok": True, "uploaded": 0, "quarantined": 0, "attempts": 1}

        with mock.patch.object(hes, "_run_agent_session", side_effect=session):
            follower = threading.Thread(target=lambda: hes.run_agent(self.project), daemon=True)
            follower.start()
            time.sleep(0.05)
            self.assertFalse(entered.is_set(), "mtime must never permit stealing a live OS lock")
            primary.release()
            follower.join(timeout=2)

        self.assertTrue(entered.is_set())
        self.assertFalse(follower.is_alive())

    def test_every_durable_append_nudges_background_sync_when_bound(self) -> None:
        with mock.patch("subprocess.Popen") as popen:
            result = he.append_event(
                self.change_dir,
                phase="plan",
                type_="phase.start",
                run_id="run-demo",
            )

        self.assertTrue(result["ok"], result)
        self.assertTrue(popen.called, "durable append must wake the finite sync worker")
        command = popen.call_args.args[0]
        self.assertIn("harness_events_sync.py", " ".join(str(part) for part in command))
        self.assertIn("--agent", command)


if __name__ == "__main__":
    unittest.main()
