#!/usr/bin/env python3
"""Tests for harness_adoption_metrics.py（roadmap 14 采纳度度量）。"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]


def load_module(name: str, filename: str):
    path = SCRIPTS_DIR / filename
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


metrics = load_module("harness_adoption_metrics", "harness_adoption_metrics.py")


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def _make_change(
    root: Path,
    name: str,
    *,
    transactions: list[tuple[str, str, str]] | None = None,
    manifest: dict | None = None,
    ledger: dict | None = None,
    events_text: str | None = None,
    legacy: bool = False,
) -> Path:
    """构造一个 change 目录。

    transactions: (operation_id, status, created_at) 列表。
    """
    change = root / ".harness" / "changes" / name
    change.mkdir(parents=True, exist_ok=True)
    for index, (operation_id, status, created_at) in enumerate(transactions or []):
        _write_json(
            change / "meta" / "plan-finalization-transactions" / f"{operation_id}.json",
            {
                "operation_id": operation_id,
                "change_key": name,
                "status": status,
                "created_at": created_at,
                "attempt": index + 1,
            },
        )
    if manifest is not None:
        _write_json(change / "meta" / "scenario-manifest.json", manifest)
    if ledger is not None:
        _write_json(change / "evidence" / "verification-ledger.json", ledger)
    if events_text is not None:
        events = change / "events.ndjson"
        events.parent.mkdir(parents=True, exist_ok=True)
        events.write_text(events_text, encoding="utf-8")
    if legacy:
        _write_json(change / "meta" / "plan-finalization.json", {"status": "finalized"})
    return change


_LEDGER_MANIFEST = {
    "scenarios": [
        {
            "id": "S1",
            "requiredEvidenceKind": "ledger",
            "executableTestId": "t1",
            "testFile": "a.test.ts",
            "testTitle": "works",
        }
    ]
}

_LEDGER_OK = {
    "declared": ["t1"],
    "selected": ["t1"],
    "collected": [{"testId": "t1", "file": "a.test.ts", "title": "works"}],
}


def _tree_snapshot(root: Path) -> dict[str, str]:
    snapshot: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if path.is_file():
            snapshot[str(path.relative_to(root))] = hashlib.sha256(
                path.read_bytes()
            ).hexdigest()
    return snapshot


class AdoptionMetricsTests(unittest.TestCase):
    def _criterion(self, report: dict, criterion_id: str) -> dict:
        for item in report["criteria"]:
            if item["id"] == criterion_id:
                return item
        self.fail(f"criterion not found: {criterion_id}")

    def test_all_pass(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for index in range(10):
                name = f"chg-{index:02d}"
                ops = [("op-1", "publication_committed_event_complete",
                        f"2026-08-{index + 1:02d}T00:00:00Z")]
                if index % 2 == 0:
                    # 多 operation（重试过）但首次即成功，仍算 first-try-ok。
                    ops.append(("op-2", "publication_committed_event_complete",
                                f"2026-08-{index + 1:02d}T01:00:00Z"))
                _make_change(
                    root, name,
                    transactions=ops,
                    manifest=_LEDGER_MANIFEST,
                    ledger=_LEDGER_OK,
                    events_text='{"event": "phase.close"}\n',
                    legacy=(index == 0),
                )
            report = metrics.collect_metrics([root])
            self.assertEqual(report["overall"], "pass")
            first_try = self._criterion(report, "finalize_first_try")
            self.assertEqual(first_try["status"], "pass")
            self.assertEqual(first_try["sample"], 10)
            closure = self._criterion(report, "evidence_closure")
            self.assertEqual(closure["status"], "pass")
            legacy = self._criterion(report, "legacy_fallback")
            self.assertEqual(legacy["status"], "pass")
            self.assertEqual(legacy["legacy_changes"], ["chg-00"])

    def test_first_try_fail(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for index in range(10):
                # 3 个 change 首次 attempt 失败 → 7/10 < 8
                first_status = (
                    "publication_failed" if index < 3
                    else "publication_committed_event_complete"
                )
                _make_change(
                    root, f"chg-{index:02d}",
                    transactions=[
                        ("op-1", first_status, f"2026-08-{index + 1:02d}T00:00:00Z"),
                        ("op-2", "publication_committed_event_complete",
                         f"2026-08-{index + 1:02d}T01:00:00Z"),
                    ],
                )
            criterion = self._criterion(
                metrics.collect_metrics([root]), "finalize_first_try"
            )
            self.assertEqual(criterion["status"], "fail")
            self.assertEqual(criterion["reading"], "7/10")

    def test_evidence_closure_fail_on_scenario_manifest_block(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for index in range(5):
                events = '{"event": "phase.close"}\n'
                if index == 4:
                    events = '{"code": "SCENARIO_MANIFEST_INVALID"}\n'
                _make_change(
                    root, f"chg-{index:02d}",
                    transactions=[("op-1", "publication_committed_event_complete",
                                   f"2026-08-{index + 1:02d}T00:00:00Z")],
                    manifest=_LEDGER_MANIFEST,
                    ledger=_LEDGER_OK,
                    events_text=events,
                )
            criterion = self._criterion(
                metrics.collect_metrics([root]), "evidence_closure"
            )
            self.assertEqual(criterion["status"], "fail")
            blocked = [c for c in criterion["changes"] if not c["clean"]]
            self.assertEqual(len(blocked), 1)
            self.assertEqual(blocked[0]["blocked_by"], "SCENARIO_MANIFEST_*")

    def test_evidence_closure_uncovered_when_ledger_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for index in range(5):
                _make_change(
                    root, f"chg-{index:02d}",
                    transactions=[("op-1", "publication_committed_event_complete",
                                   f"2026-08-{index + 1:02d}T00:00:00Z")],
                    manifest=_LEDGER_MANIFEST,
                    ledger=None if index == 4 else _LEDGER_OK,
                )
            criterion = self._criterion(
                metrics.collect_metrics([root]), "evidence_closure"
            )
            self.assertEqual(criterion["status"], "fail")
            uncovered = [c for c in criterion["changes"] if not c["clean"]]
            self.assertEqual(len(uncovered), 1)
            self.assertIn("verification-ledger.json", uncovered[0]["uncovered"][0])

    def test_legacy_fallback_fail(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for index in range(10):
                _make_change(root, f"chg-{index:02d}", legacy=(index >= 7))
            criterion = self._criterion(
                metrics.collect_metrics([root]), "legacy_fallback"
            )
            self.assertEqual(criterion["status"], "fail")
            self.assertEqual(len(criterion["legacy_changes"]), 3)

    def test_indeterminate_on_insufficient_samples(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for index in range(2):
                _make_change(
                    root, f"chg-{index:02d}",
                    transactions=[("op-1", "publication_committed_event_complete",
                                   f"2026-08-{index + 1:02d}T00:00:00Z")],
                )
            report = metrics.collect_metrics([root])
            self.assertEqual(report["overall"], "indeterminate")
            for criterion in report["criteria"]:
                self.assertEqual(criterion["status"], "indeterminate")
                self.assertIn("判据不可判定", criterion["detail"])

    def test_empty_project_root_yields_indeterminate(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            report = metrics.collect_metrics([Path(tmp)])
            self.assertEqual(report["overall"], "indeterminate")
            for criterion in report["criteria"]:
                self.assertEqual(criterion["sample"], 0)

    def test_multi_project_window_merges_by_created_at(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root_a = Path(tmp) / "a"
            root_b = Path(tmp) / "b"
            # 交错 created_at：b 的最新样本比 a 的一半都新。
            for index in range(6):
                _make_change(
                    root_a, f"a-{index:02d}",
                    transactions=[("op-1", "publication_failed",
                                   f"2026-08-{index + 1:02d}T00:00:00Z")],
                )
                _make_change(
                    root_b, f"b-{index:02d}",
                    transactions=[("op-1", "publication_committed_event_complete",
                                   f"2026-08-{index + 1:02d}T12:00:00Z")],
                )
            criterion = self._criterion(
                metrics.collect_metrics([root_a, root_b]), "finalize_first_try"
            )
            # 12 个样本按 created_at 交错（a 在 00:00、b 在 12:00），窗口 10
            # 丢掉最旧的 a-00/b-00 → 剩 5 失败 + 5 成功。
            self.assertEqual(criterion["sample"], 10)
            self.assertEqual(criterion["reading"], "5/10")
            self.assertEqual(criterion["status"], "fail")
            names = {item["change"] for item in criterion["changes"]}
            self.assertIn("a-01", names)
            self.assertIn("b-05", names)
            self.assertNotIn("a-00", names)
            self.assertNotIn("b-00", names)

    def test_readonly_and_bad_json_skipped(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            change = _make_change(
                root, "chg-00",
                transactions=[("op-1", "publication_committed_event_complete",
                               "2026-08-01T00:00:00Z")],
            )
            bad = change / "meta" / "plan-finalization-transactions" / "bad.json"
            bad.write_text("{not json", encoding="utf-8")
            before = _tree_snapshot(root)
            report = metrics.collect_metrics([root])
            after = _tree_snapshot(root)
            self.assertEqual(before, after)
            criterion = self._criterion(report, "finalize_first_try")
            self.assertEqual(criterion["sample"], 1)
            self.assertEqual(criterion["changes"][0]["retry_count"], 0)

    def test_strict_exit_codes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for index in range(10):
                _make_change(
                    root, f"chg-{index:02d}",
                    transactions=[("op-1", "publication_committed_event_complete",
                                   f"2026-08-{index + 1:02d}T00:00:00Z")],
                    manifest=_LEDGER_MANIFEST,
                    ledger=_LEDGER_OK,
                )
            self.assertEqual(metrics.main(["--project", str(root), "--strict"]), 0)
            self.assertEqual(
                metrics.main(["--project", str(root), "--strict", "--json"]), 0
            )
        with tempfile.TemporaryDirectory() as tmp:
            # 空项目 → indeterminate → strict 下 exit 1
            self.assertEqual(metrics.main(["--project", tmp, "--strict"]), 1)
            self.assertEqual(metrics.main(["--project", tmp]), 0)


if __name__ == "__main__":
    unittest.main()
