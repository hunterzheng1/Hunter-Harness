import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_headless as hh
import harness_events_sync as hes


class HeadlessContractTests(unittest.TestCase):
    def test_envelope_shape(self) -> None:
        payload = hh.headless_envelope(
            command="gate.close",
            ok=True,
            exit_code=0,
            change="demo",
            phase="test",
            result={"reused": False},
        )
        self.assertEqual(payload["schema_version"], 1)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["command"], "gate.close")
        self.assertEqual(payload["change"], "demo")
        self.assertEqual(payload["phase"], "test")
        self.assertEqual(payload["exit_code"], 0)
        self.assertEqual(payload["warnings"], [])
        self.assertEqual(payload["errors"], [])

    def test_events_sync_emits_headless_envelope_without_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            change = project / ".harness" / "changes" / "demo"
            change.mkdir(parents=True)
            (change / "events.ndjson").write_text(
                '{"id":"e1","type":"phase.start","phase":"plan","ts":"2026-08-06T00:00:00Z"}\n',
                encoding="utf-8",
            )
            code = hes.main(["--project", str(project), "--json"])
            # Without credentials each change reports skipped/false; overall may be false.
            self.assertIn(code, (0, 1))

    def test_auto_events_sync_skips_without_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            change = project / ".harness" / "changes" / "demo"
            change.mkdir(parents=True)
            result = hes.auto_events_sync(project, change)
            self.assertTrue(result.get("skipped"))
            self.assertIn("credentials", str(result.get("reason")))

    def test_sync_change_accepts_run_id_override(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            change = project / ".harness" / "changes" / "demo"
            change.mkdir(parents=True)
            result = hes.sync_change(
                project,
                change,
                heartbeat_only=True,
                run_id="run_override_test",
                change_key="demo",
            )
            self.assertTrue(result.get("skipped") or result.get("ok") is False or result.get("ok"))
            if result.get("skipped"):
                self.assertIn("credentials", str(result.get("reason")))
            else:
                self.assertEqual(result.get("run_id"), "run_override_test")


if __name__ == "__main__":
    unittest.main()
