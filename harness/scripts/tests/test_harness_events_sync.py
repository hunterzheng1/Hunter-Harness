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

    def test_adds_a_readable_bounded_summary_without_raw_output(self) -> None:
        event = {
            "id": "evt-decision",
            "timestamp": "2026-08-08T10:00:00+08:00",
            "schema_version": 3,
            "type": "decision",
            "phase": "plan",
            "decision": "采用本地缓存",
            "reason": "减少重复请求",
            "raw_output": "secret command output",
        }

        payload = hes.sanitize(event)

        self.assertEqual(payload["summary"], "采用本地缓存；原因：减少重复请求")
        self.assertNotIn("raw_output", payload)

    def test_adds_a_fallback_summary_for_an_event_without_notes(self) -> None:
        payload = hes.sanitize({
            "type": "phase.start",
            "phase": "plan",
        })

        self.assertEqual(payload["summary"], "开始执行计划阶段。")

    def test_keeps_machine_hash_in_raw_payload_but_not_in_readable_summary(self) -> None:
        digest = "sha256:" + "a" * 64
        payload = hes.sanitize({
            "type": "decision",
            "phase": "plan",
            "decision": (
                "原生规划协议自检通过；finalize ok "
                f"artifactsHash={digest}"
            ),
        })

        self.assertNotIn("artifactsHash", payload["summary"])
        self.assertNotIn(digest, payload["summary"])
        self.assertIn("规划", payload["summary"])
        self.assertIn(digest, payload["decision"])

    def test_translates_review_reason_code_instead_of_using_it_as_summary(self) -> None:
        payload = hes.sanitize({
            "type": "decision",
            "phase": "review",
            "summary": "REVIEW_INLINE_UNAVAILABLE",
            "execution_mode": "inline",
            "fallback_reason_code": "REVIEW_INLINE_UNAVAILABLE",
        })

        self.assertEqual(
            payload["summary"],
            "当前环境没有可用的隔离评审能力，已由主会话完成评审。",
        )
        self.assertEqual(payload["fallback_reason_code"], "REVIEW_INLINE_UNAVAILABLE")

    def test_sends_the_persisted_chinese_display_title(self) -> None:
        title_path = self.change_dir / "meta" / "change-title.json"
        title_path.parent.mkdir(parents=True)
        title_path.write_text(
            json.dumps({"schemaVersion": 1, "displayTitle": "番茄钟计时器"}),
            encoding="utf-8",
        )
        requests: list[dict] = []

        def post_json(_endpoint, _path: str, body: dict):
            requests.append(body)
            return {"ok": True}

        with mock.patch.object(hes, "post_json", side_effect=post_json):
            result = hes.sync_change(
                self.project, self.change_dir, heartbeat_only=True
            )

        self.assertTrue(result["ok"], result)
        self.assertEqual(requests[0]["title"], "番茄钟计时器")

    def test_reports_the_confirmed_phase_plan_and_real_next_phase(self) -> None:
        (self.change_dir / "meta").mkdir(exist_ok=True)
        (self.change_dir / "meta" / "gate-policy.json").write_text(
            json.dumps({
                "schemaVersion": 1,
                "plannedPhases": ["plan", "run", "archive"],
                "skippedPhases": [{"phase": "submit", "reason": "本次不需要提交"}],
            }),
            encoding="utf-8",
        )
        (self.change_dir / "events.ndjson").write_text(
            json.dumps({
                "schema_version": 3,
                "id": "evt-run-end",
                "timestamp": "2026-08-08T10:00:00+08:00",
                "type": "phase.end",
                "phase": "run",
                "status": "OK",
            }) + "\n",
            encoding="utf-8",
        )
        batches: list[dict] = []

        def post_json(_endpoint, path: str, body: dict):
            if path.endswith("/heartbeats"):
                return {"ok": True}
            batches.append(body)
            return {"items": [{"id": "evt-run-end", "status": "accepted"}]}

        with mock.patch.object(hes, "post_json", side_effect=post_json):
            result = hes.sync_change(self.project, self.change_dir)

        self.assertTrue(result["ok"], result)
        payload = batches[0]["events"][0]["payload"]
        self.assertEqual(payload["planned_phases"], ["plan", "run", "archive"])
        self.assertEqual(payload["next_phase"], "archive")
        self.assertEqual(payload["phase_plan_source"], "change")

    def test_uses_the_design_heading_for_a_legacy_change_title(self) -> None:
        design = self.change_dir / "spec" / "demo-design.md"
        design.parent.mkdir(parents=True)
        design.write_text("# 番茄钟计时器 设计文档\n", encoding="utf-8")
        requests: list[dict] = []

        def post_json(_endpoint, _path: str, body: dict):
            requests.append(body)
            return {"ok": True}

        with mock.patch.object(hes, "post_json", side_effect=post_json):
            result = hes.sync_change(
                self.project, self.change_dir, heartbeat_only=True
            )

        self.assertTrue(result["ok"], result)
        self.assertEqual(requests[0]["title"], "番茄钟计时器")

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

    def test_split_v1_keeps_producer_sequence_after_legacy_stream_switch(self) -> None:
        subprocess.run(
            ["git", "init", "--quiet"], cwd=self.project, check=True,
            capture_output=True,
        )
        self.write_events(2)
        accepted_by_sequence: dict[int, str] = {}
        uploaded_sequences: list[int] = []

        def post_json(_endpoint, path: str, body: dict):
            if path.endswith("/heartbeats"):
                return {"ok": True}
            items = []
            for event in body["events"]:
                sequence = event["producer_seq"]
                uploaded_sequences.append(sequence)
                if sequence in accepted_by_sequence:
                    items.append({
                        "id": event["event_id"],
                        "status": "id_conflict",
                        "error_code": "SEQ_CONFLICT",
                    })
                    continue
                accepted_by_sequence[sequence] = event["event_id"]
                items.append({"id": event["event_id"], "status": "accepted"})
            return {"items": items}

        with mock.patch.object(hes, "post_json", side_effect=post_json):
            legacy_result = hes.sync_change(self.project, self.change_dir)

        self.assertTrue(legacy_result["ok"], legacy_result)
        self.assertEqual(uploaded_sequences, [1, 2])

        (self.change_dir / "meta" / "change-context.json").write_text(
            json.dumps({
                "schemaVersion": 2,
                "changeId": "demo",
                "stateOwnership": {
                    "contractRoot": ".harness/changes/demo",
                    "runtimeRoot": ".harness/state/changes/demo",
                },
            }),
            encoding="utf-8",
        )
        state_dir = self.project / ".harness" / "state" / "changes" / "demo"
        state_dir.mkdir(parents=True)
        state_events = []
        for index in range(3, 5):
            state_events.append(json.dumps({
                "schema_version": 3,
                "id": f"evt-{index}",
                "timestamp": f"2026-08-08T10:00:0{index}+08:00",
                "type": "decision",
                "phase": "run",
                "decision": f"decision-{index}",
                "note": "",
            }))
        (state_dir / "events.ndjson").write_text(
            "\n".join(state_events) + "\n", encoding="utf-8"
        )

        with mock.patch.object(hes, "post_json", side_effect=post_json):
            split_result = hes.sync_change(self.project, self.change_dir)

        self.assertTrue(split_result["ok"], split_result)
        self.assertEqual(split_result["uploaded"], 2)
        self.assertEqual(split_result["quarantined"], 0)
        self.assertEqual(uploaded_sequences, [1, 2, 3, 4])
        cursor = json.loads(
            hes.cursor_path(self.change_dir).read_text(encoding="utf-8")
        )
        self.assertEqual(cursor.get("producer_seq_base"), 2)

    def test_split_v1_sync_preserves_unsent_legacy_events_before_new_state_events(self) -> None:
        subprocess.run(
            ["git", "init", "--quiet"], cwd=self.project, check=True,
            capture_output=True,
        )
        self.write_events(2)
        (self.change_dir / "meta").mkdir(exist_ok=True)
        (self.change_dir / "meta" / "change-context.json").write_text(
            json.dumps({
                "schemaVersion": 2,
                "changeId": "demo",
                "stateOwnership": {
                    "contractRoot": ".harness/changes/demo",
                    "runtimeRoot": ".harness/state/changes/demo",
                },
            }),
            encoding="utf-8",
        )
        state_dir = self.project / ".harness" / "state" / "changes" / "demo"
        state_dir.mkdir(parents=True)
        (state_dir / "events.ndjson").write_text(
            "\n".join(json.dumps({
                "schema_version": 3,
                "id": f"evt-{index}",
                "timestamp": f"2026-08-08T10:00:0{index}+08:00",
                "type": "decision",
                "phase": "run",
                "decision": f"decision-{index}",
                "note": "",
            }) for index in range(3, 5)) + "\n",
            encoding="utf-8",
        )
        uploaded_ids: list[str] = []
        uploaded_sequences: list[int] = []

        def post_json(_endpoint, path: str, body: dict):
            if path.endswith("/heartbeats"):
                return {"ok": True}
            uploaded_ids.extend(event["event_id"] for event in body["events"])
            uploaded_sequences.extend(event["producer_seq"] for event in body["events"])
            return {
                "items": [
                    {"id": event["event_id"], "status": "accepted"}
                    for event in body["events"]
                ]
            }

        with mock.patch.object(hes, "post_json", side_effect=post_json):
            result = hes.sync_change(self.project, self.change_dir)

        self.assertTrue(result["ok"], result)
        self.assertEqual(result["uploaded"], 4)
        self.assertEqual(uploaded_ids, ["evt-1", "evt-2", "evt-3", "evt-4"])
        self.assertEqual(uploaded_sequences, [1, 2, 3, 4])
        self.assertFalse((self.change_dir / "events.ndjson").exists())
        self.assertEqual(
            len((state_dir / "events.ndjson").read_text(encoding="utf-8").splitlines()),
            4,
        )

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

    def test_windows_background_sync_prefers_the_venv_windowless_launcher(self) -> None:
        scripts = self.project / "venv" / "Scripts"
        scripts.mkdir(parents=True)
        executable = scripts / "python.exe"
        pythonw = scripts / "pythonw.exe"
        executable.write_bytes(b"launcher")
        pythonw.write_bytes(b"windowless launcher")

        self.assertEqual(
            hes._windowless_python_executable(str(executable), None),
            str(pythonw),
        )

    def test_windows_background_sync_prefers_the_real_windowless_interpreter_over_venv_forwarder(self) -> None:
        launcher = self.project / "venv" / "Scripts" / "python.exe"
        venv_pythonw = launcher.with_name("pythonw.exe")
        base = self.project / "runtime" / "python.exe"
        pythonw = base.with_name("pythonw.exe")
        launcher.parent.mkdir(parents=True)
        base.parent.mkdir(parents=True)
        launcher.write_bytes(b"launcher")
        venv_pythonw.write_bytes(b"windowless forwarding launcher")
        base.write_bytes(b"runtime")
        pythonw.write_bytes(b"windowless runtime")

        self.assertEqual(
            hes._windowless_python_executable(str(launcher), str(base)),
            str(pythonw),
        )

    def test_windows_background_sync_uses_real_console_interpreter_before_venv_forwarder(self) -> None:
        launcher = self.project / "venv" / "Scripts" / "python.exe"
        venv_pythonw = launcher.with_name("pythonw.exe")
        base = self.project / "runtime" / "python.exe"
        launcher.parent.mkdir(parents=True)
        base.parent.mkdir(parents=True)
        launcher.write_bytes(b"launcher")
        venv_pythonw.write_bytes(b"windowless forwarding launcher")
        base.write_bytes(b"runtime")

        self.assertEqual(
            hes._windowless_python_executable(str(launcher), str(base)),
            str(base),
        )

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

    def test_agent_keeps_heartbeating_until_the_open_phase_closes(self) -> None:
        event_path = self.change_dir / "events.ndjson"
        event_path.write_text(
            json.dumps({
                "schema_version": 3,
                "id": "evt-start",
                "timestamp": "2026-08-08T10:00:00+08:00",
                "type": "phase.start",
                "phase": "run",
                "attempt": 1,
            }) + "\n",
            encoding="utf-8",
        )
        calls: list[bool] = []

        def sync(_project: Path, _change: Path, *, heartbeat_only: bool = False):
            calls.append(heartbeat_only)
            if heartbeat_only:
                with event_path.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps({
                        "schema_version": 3,
                        "id": "evt-end",
                        "timestamp": "2026-08-08T10:00:10+08:00",
                        "type": "phase.end",
                        "phase": "run",
                        "attempt": 1,
                        "status": "OK",
                    }) + "\n")
            return {"ok": True, "uploaded": 0, "quarantined": 0}

        with (
            mock.patch.object(hes, "sync_change", side_effect=sync),
            mock.patch.object(hes.time, "sleep"),
        ):
            result = hes._run_agent_session(self.project)

        self.assertTrue(result["ok"], result)
        self.assertIn(True, calls)


if __name__ == "__main__":
    unittest.main()
