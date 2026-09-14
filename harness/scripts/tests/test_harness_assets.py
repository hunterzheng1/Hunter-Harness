#!/usr/bin/env python3
"""WI-E2（O3/O4）：知识资产消费三态回执——harness_assets.py receipt/receipts。

设计：docs/harness-improvement-roadmap/batch3/design-o3-o4-outcome-assets-2026-09-14.md §6。
回执存储 `.harness/state/local/asset-receipts/<candidate_id>.ndjson`（追加式，
每行一条），按项目隔离；partially_adopted/rejected 强制 reason；写失败显示
不静默（E1 语义）。
"""
from __future__ import annotations

import contextlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_assets as hass  # noqa: E402

KC_ID = "kc_3f66a23f5838a9fcd2f39f17152298e6"
KC_ID_2 = "kc_9152f971f74a41f5158a0c1d01875b26"


class HarnessAssetsFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.project = Path(tempfile.mkdtemp(prefix="harness-assets-project-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.project, ignore_errors=True)

    def _run(self, *argv: str) -> tuple[int, dict]:
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            rc = hass.main(list(argv))
        text = buffer.getvalue().strip()
        return rc, json.loads(text) if text else {}

    def _receipt(self, *extra: str, project: Path | None = None) -> tuple[int, dict]:
        return self._run(
            "receipt", "--project", str(project or self.project),
            "--candidate-id", KC_ID, *extra, "--json",
        )

    def _receipts(self, *extra: str, project: Path | None = None) -> tuple[int, dict]:
        return self._run(
            "receipts", "--project", str(project or self.project), *extra, "--json",
        )


class ReceiptWriteTests(HarnessAssetsFixture):
    def test_receipt_roundtrip_all_fields(self) -> None:
        rc, payload = self._receipt(
            "--verdict", "adopted",
            "--change", "usage-stats-cli-reporting",
            "--detail", "按候选建议修复了 nonScannablePathPrefixes",
        )
        self.assertEqual(rc, 0, payload)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["code"], "ASSET_RECEIPT_RECORDED")

        rc, payload = self._receipts("--candidate-id", KC_ID)
        self.assertEqual(rc, 0, payload)
        receipts = payload["receipts"]
        self.assertEqual(len(receipts), 1)
        record = receipts[0]
        self.assertEqual(record["schema_version"], 1)
        self.assertEqual(record["candidate_id"], KC_ID)
        self.assertEqual(record["verdict"], "adopted")
        self.assertEqual(record["change_id"], "usage-stats-cli-reporting")
        self.assertEqual(record["detail"], "按候选建议修复了 nonScannablePathPrefixes")
        self.assertIsNone(record["reason"])
        self.assertRegex(record["recorded_at"], r"^\d{4}-\d{2}-\d{2}T")

    def test_receipts_append_in_recorded_order(self) -> None:
        rc, _ = self._receipt("--verdict", "retrieved")
        self.assertEqual(rc, 0)
        rc, _ = self._receipt("--verdict", "rejected", "--reason", "不适用于本模块")
        self.assertEqual(rc, 0)
        rc, payload = self._receipts("--candidate-id", KC_ID)
        self.assertEqual(rc, 0)
        self.assertEqual(
            [r["verdict"] for r in payload["receipts"]],
            ["retrieved", "rejected"],
        )
        self.assertEqual(payload["receipts"][1]["reason"], "不适用于本模块")

    def test_receipts_without_filter_lists_every_candidate(self) -> None:
        self._receipt("--verdict", "adopted")
        self._receipt("--candidate-id", KC_ID_2, "--verdict", "verified_effective")
        rc, payload = self._receipts()
        self.assertEqual(rc, 0)
        self.assertEqual(
            {r["candidate_id"] for r in payload["receipts"]}, {KC_ID, KC_ID_2},
        )

    def test_receipts_empty_store_is_ok(self) -> None:
        rc, payload = self._receipts()
        self.assertEqual(rc, 0, payload)
        self.assertEqual(payload["receipts"], [])

    def test_store_lives_under_project_state_local(self) -> None:
        rc, _ = self._receipt("--verdict", "adopted")
        self.assertEqual(rc, 0)
        store = (
            self.project / ".harness" / "state" / "local"
            / "asset-receipts" / f"{KC_ID}.ndjson"
        )
        self.assertTrue(store.is_file())
        lines = store.read_text(encoding="utf-8").splitlines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0])["candidate_id"], KC_ID)


class ReceiptValidationTests(HarnessAssetsFixture):
    def test_invalid_verdict_rejected(self) -> None:
        rc, payload = self._receipt("--verdict", "helpful")
        self.assertEqual(rc, 2)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["code"], "ASSET_RECEIPT_INVALID")
        rc, payload = self._receipts()
        self.assertEqual(payload["receipts"], [])

    def test_invalid_candidate_id_rejected(self) -> None:
        for bad in ("pcc_wrong_namespace", "not-an-id", "kc_", "kc_中文"):
            rc, payload = self._receipt("--verdict", "adopted", "--candidate-id", bad)
            self.assertEqual(rc, 2, bad)
            self.assertEqual(payload["code"], "ASSET_RECEIPT_INVALID", bad)

    def test_reason_required_for_partially_adopted_and_rejected(self) -> None:
        for verdict in ("partially_adopted", "rejected"):
            rc, payload = self._receipt("--verdict", verdict)
            self.assertEqual(rc, 2, verdict)
            self.assertEqual(
                payload["code"], "ASSET_RECEIPT_REASON_REQUIRED", verdict,
            )
            # 空白 reason 同样拒绝（空白不凑数）
            rc, payload = self._receipt("--verdict", verdict, "--reason", "   ")
            self.assertEqual(rc, 2, verdict)
            self.assertEqual(
                payload["code"], "ASSET_RECEIPT_REASON_REQUIRED", verdict,
            )
        rc, payload = self._receipts()
        self.assertEqual(payload["receipts"], [])

    def test_reason_optional_for_other_verdicts(self) -> None:
        for verdict in ("retrieved", "adopted", "verified_effective"):
            rc, payload = self._receipt("--verdict", verdict)
            self.assertEqual(rc, 0, (verdict, payload))

    def test_write_failure_is_loud(self) -> None:
        # 用「文件占据目录路径」制造写失败：asset-receipts 被建成普通文件，
        # 追加写必抛 OSError——必须报错而非静默丢失（E1 语义）。
        state_dir = self.project / ".harness" / "state" / "local"
        state_dir.mkdir(parents=True)
        (state_dir / "asset-receipts").write_text("blocked", encoding="utf-8")
        rc, payload = self._receipt("--verdict", "adopted")
        self.assertEqual(rc, 2)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["code"], "ASSET_RECEIPT_WRITE_FAILED")


class ReceiptIsolationTests(unittest.TestCase):
    def test_receipts_are_isolated_per_project(self) -> None:
        project_a = Path(tempfile.mkdtemp(prefix="harness-assets-a-"))
        project_b = Path(tempfile.mkdtemp(prefix="harness-assets-b-"))
        try:
            fixture = HarnessAssetsFixture()
            rc, payload = fixture._receipt(
                "--verdict", "adopted", project=project_a,
            )
            self.assertEqual(rc, 0, payload)
            rc, payload = fixture._receipts(project=project_b)
            self.assertEqual(rc, 0)
            self.assertEqual(payload["receipts"], [])
            rc, payload = fixture._receipts(project=project_a)
            self.assertEqual(len(payload["receipts"]), 1)
        finally:
            shutil.rmtree(project_a, ignore_errors=True)
            shutil.rmtree(project_b, ignore_errors=True)


class OutboxCliTests(HarnessAssetsFixture):
    """WI-E3：outbox-status / outbox-drain CLI 冒烟。"""

    def test_outbox_status_empty(self) -> None:
        rc, payload = self._run(
            "outbox-status", "--project", str(self.project), "--json",
        )
        self.assertEqual(rc, 0, payload)
        self.assertEqual(payload["code"], "ASSET_OUTBOX_STATUS")
        self.assertEqual(payload["records"], [])
        self.assertEqual(payload["capacity"]["used"], 0)

    def test_outbox_drain_without_remote_marks_pending(self) -> None:
        # finish 之外手动造一条待交付记录，验证 CLI drain 的显式待验证标注。
        import harness_asset_outbox as outbox_mod

        outbox_mod.enqueue_outcome(
            self.project, "cli-change",
            {"schemaVersion": 1, "goal": "g", "outcome": {"summary": "s"}},
        )
        rc, payload = self._run(
            "outbox-drain", "--project", str(self.project), "--json",
        )
        self.assertEqual(rc, 0, payload)
        self.assertEqual(payload["code"], "ASSET_OUTBOX_REMOTE_UNCONFIGURED")
        self.assertEqual(payload["pending_remote_unconfigured"], 1)
        self.assertEqual(payload["verification"], "pending")
        rc, payload = self._run(
            "outbox-status", "--project", str(self.project), "--json",
        )
        self.assertEqual(rc, 0)
        self.assertEqual(payload["counts"]["pending"], 1)


if __name__ == "__main__":
    unittest.main()
