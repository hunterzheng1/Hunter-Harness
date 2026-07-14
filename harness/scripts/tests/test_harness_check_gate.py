#!/usr/bin/env python3
"""Unittests for harness_check_gate.py — pre-push skip gate (triple check)."""

from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_check_gate as gate  # noqa: E402


class CheckGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="gate-"))
        self.marker = self.tmp / "check-ok.marker"

    def _write_marker(
        self, ts: float | None = None, commit: str = "abc123", command: str = "npm run check"
    ) -> None:
        if ts is None:
            ts = time.time()
        self.marker.write_text(
            json.dumps({"ts": ts, "commitHash": commit, "command": command}) + "\n",
            encoding="utf-8",
        )

    def _run_gate(self, head: str = "abc123") -> int:
        with mock.patch.object(gate, "MARKER", self.marker), mock.patch.object(
            gate, "_current_head", return_value=head
        ):
            return gate.main([])

    def test_skip_when_marker_matches_head(self) -> None:
        # fresh ts + matching HEAD + matching command → skip (exit 0)
        self._write_marker(commit="abc123")
        self.assertEqual(self._run_gate(head="abc123"), 0)

    def test_run_when_no_marker(self) -> None:
        self.assertEqual(self._run_gate(head="abc123"), 1)

    def test_run_when_marker_stale(self) -> None:
        # older than MAX_AGE_S → run (exit 1)
        self._write_marker(ts=time.time() - gate.MAX_AGE_S - 1, commit="abc123")
        self.assertEqual(self._run_gate(head="abc123"), 1)

    def test_run_when_head_moved(self) -> None:
        # marker commit != current HEAD → run (exit 1)
        self._write_marker(commit="abc123")
        self.assertEqual(self._run_gate(head="deadbee"), 1)

    def test_run_when_command_mismatch(self) -> None:
        self._write_marker(commit="abc123", command="npm test")
        self.assertEqual(self._run_gate(head="abc123"), 1)

    def test_run_when_marker_corrupt(self) -> None:
        self.marker.write_text("not json", encoding="utf-8")
        self.assertEqual(self._run_gate(head="abc123"), 1)

    def test_write_marker_writes_current_head_then_skips(self) -> None:
        # --write records current HEAD; a subsequent gate run on the same HEAD skips.
        with mock.patch.object(gate, "MARKER", self.marker), mock.patch.object(
            gate, "_current_head", return_value="feedface"
        ):
            self.assertEqual(gate.main(["--write"]), 0)
            data = json.loads(self.marker.read_text(encoding="utf-8-sig"))
            self.assertEqual(data["commitHash"], "feedface")
            self.assertEqual(data["command"], "npm run check")
            # gate on the same HEAD → skip
            self.assertEqual(gate.main([]), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
