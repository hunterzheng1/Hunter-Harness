#!/usr/bin/env python3
"""Unittests for harness_state.py (cluster 3 §3.6 state/context snapshot).

Snapshot 采集 project/worktree/git/profile/rules/map/knowledge/diff 各段指纹；
各段独立失效，缓存失效只重采受影响段；不得仅凭缓存跳过代码或验证门禁。
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

import harness_state as hst  # noqa: E402
from harness_ledger import compute_inputs_hash  # noqa: E402


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


class SnapshotCaptureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="harness-state-"))
        self.change = self.tmp / "change-1"
        self.change.mkdir(parents=True)
        self.project = self.tmp / "project"
        self.project.mkdir(parents=True)
        _write(self.project / "Svc.java", "class Svc {}\n")
        _write(
            self.project / ".harness" / "config" / "build-profile.json",
            json.dumps({"schemaVersion": 2, "serviceStart": {"command": "x"}}),
        )

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _profile_file(self) -> str:
        return str(self.project / ".harness" / "config" / "build-profile.json")

    def _svc_file(self) -> str:
        return str(self.project / "Svc.java")

    def test_capture_snapshot_records_all_segments(self) -> None:
        snap = hst.capture_snapshot(
            self.change,
            change_name="change-1",
            project=self.project,
            worktree_root=self.tmp / "wt",
            segment_files={
                "profile": [self._profile_file()],
                "rules": [self._svc_file()],
            },
        )
        self.assertEqual(snap["schemaVersion"], 1)
        self.assertEqual(snap["changeName"], "change-1")
        self.assertEqual(snap["project"]["root"], str(self.project.resolve()))
        self.assertEqual(snap["worktree"]["root"], str((self.tmp / "wt").resolve()))
        segs = snap["segments"]
        for name in ("profile", "rules"):
            self.assertIn(name, segs, msg=f"missing segment {name}")
            self.assertTrue(segs[name]["fingerprint"].startswith("sha256:"), msg=name)
            self.assertIn("capturedAt", segs[name], msg=name)
            self.assertIsInstance(segs[name]["files"], list, msg=name)

    def test_segment_stale_detection_is_independent(self) -> None:
        snap = hst.capture_snapshot(
            self.change,
            change_name="c",
            project=self.project,
            worktree_root=self.tmp,
            segment_files={
                "profile": [self._profile_file()],
                "rules": [self._svc_file()],
            },
        )
        fp_profile = snap["segments"]["profile"]["fingerprint"]
        # profile 段未变 → not stale；变化 → stale
        self.assertFalse(hst.is_segment_stale(snap, "profile", fp_profile))
        self.assertTrue(hst.is_segment_stale(snap, "profile", "sha256:different"))
        # 修改 rules 文件后：profile 段指纹不变 → not stale；rules 段 → stale
        _write(self.project / "Svc.java", "class Svc { int v = 2; }\n")
        new_rules_fp, _ = compute_inputs_hash([self._svc_file()])
        self.assertFalse(hst.is_segment_stale(snap, "profile", fp_profile))
        self.assertTrue(hst.is_segment_stale(snap, "rules", new_rules_fp))
        # 不存在的段 → stale（需采集）
        self.assertTrue(hst.is_segment_stale(snap, "map", "sha256:whatever"))

    def test_refresh_only_updates_requested_segments(self) -> None:
        snap = hst.capture_snapshot(
            self.change,
            change_name="c",
            project=self.project,
            worktree_root=self.tmp,
            segment_files={
                "profile": [self._profile_file()],
                "rules": [self._svc_file()],
            },
        )
        profile_captured_before = snap["segments"]["profile"]["capturedAt"]
        rules_fingerprint_before = snap["segments"]["rules"]["fingerprint"]
        # 修改 rules 文件，只重采 rules 段
        _write(self.project / "Svc.java", "class Svc { int v = 2; }\n")
        refreshed = hst.refresh_segments(
            self.change,
            snap,
            project=self.project,
            worktree_root=self.tmp,
            segment_files={"rules": [self._svc_file()]},
            segments=["rules"],
        )
        # rules 段指纹变化
        self.assertNotEqual(
            refreshed["segments"]["rules"]["fingerprint"], rules_fingerprint_before
        )
        # profile 段未重采：capturedAt 不变
        self.assertEqual(
            refreshed["segments"]["profile"]["capturedAt"], profile_captured_before
        )

    def test_snapshot_persist_and_reload(self) -> None:
        snap = hst.capture_snapshot(
            self.change,
            change_name="c",
            project=self.project,
            worktree_root=self.tmp,
            segment_files={"profile": [self._profile_file()]},
        )
        path = hst.write_snapshot(self.change, snap)
        self.assertTrue(path.is_file())
        loaded = hst.load_snapshot(self.change)
        self.assertIsNotNone(loaded)
        assert loaded is not None
        self.assertEqual(loaded["schemaVersion"], snap["schemaVersion"])
        self.assertEqual(
            loaded["segments"]["profile"]["fingerprint"],
            snap["segments"]["profile"]["fingerprint"],
        )

    def test_load_missing_snapshot_returns_none(self) -> None:
        self.assertIsNone(hst.load_snapshot(self.change))

    def test_capture_current_state_reuses_unchanged_segments(self) -> None:
        first, first_changed = hst.capture_current_state(
            project=self.project,
            change_dir=self.change,
            change_name="change-1",
            worktree_root=self.project,
        )
        second, second_changed = hst.capture_current_state(
            project=self.project,
            change_dir=self.change,
            change_name="change-1",
            worktree_root=self.project,
        )
        self.assertIn("profile", first_changed)
        self.assertEqual(second_changed, [])
        self.assertEqual(
            first["segments"]["profile"]["capturedAt"],
            second["segments"]["profile"]["capturedAt"],
        )

    def test_discovery_without_git_keeps_code_segment_empty(self) -> None:
        segments = hst.discover_segment_files(
            self.project, self.change, base="missing-base", head="HEAD"
        )
        self.assertIn(self._profile_file(), segments["profile"])
        self.assertEqual(segments["code"], [])


if __name__ == "__main__":
    unittest.main()
