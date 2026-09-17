#!/usr/bin/env python3
"""WI-E3（O4）：Python asset-outbox——租约/退避/journal/死信/容量 红测。

设计：docs/roadmap/batches/batch3/design-o3-o4-outcome-assets-2026-09-14.md §7。
存储：.harness/state/local/asset-outbox/{records,journal}/；journal 先行写
（write-ahead），记录覆写失败时 journal 条目保持 ambiguous。
"""
from __future__ import annotations

import contextlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_asset_outbox as outbox  # noqa: E402

T0 = datetime(2026, 9, 14, 12, 0, 0, tzinfo=timezone.utc)

OUTCOME = {
    "schemaVersion": 1,
    "goal": "把改动收束成可提交、可评审的任务",
    "outcome": {
        "summary": "finish 落盘 outcome.json",
        "motivation": "补动机",
        "risk": None,
        "next": [],
        "unverified": [],
    },
    "facts": {"closureReason": "completed"},
}


def _outcome(summary: str) -> dict:
    doc = json.loads(json.dumps(OUTCOME))
    doc["outcome"]["summary"] = summary
    return doc


class FakeTransport:
    """记录每次交付的幂等键；可编程失败。"""

    def __init__(self, fail_times: int = 0) -> None:
        self.calls: list[str] = []
        self.fail_times = fail_times

    def deliver(self, record: dict) -> dict:
        self.calls.append(record["idempotency_key"])
        if self.fail_times > 0:
            self.fail_times -= 1
            raise RuntimeError("remote exploded")
        return {"remote_id": "srv-1", "accepted": True}


class OutboxFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.project = Path(tempfile.mkdtemp(prefix="harness-outbox-project-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.project, ignore_errors=True)

    def _enqueue(self, change: str = "demo-change", doc: dict | None = None, now=T0, **kw):
        return outbox.enqueue_outcome(
            self.project, change, doc if doc is not None else OUTCOME, now=now, **kw
        )


class EnqueueTests(OutboxFixture):
    def test_enqueue_persists_record_and_journal(self) -> None:
        record, replayed = self._enqueue()
        self.assertFalse(replayed)
        self.assertEqual(record["schema_version"], 1)
        self.assertEqual(record["kind"], "outcome")
        self.assertEqual(record["state"], "pending")
        self.assertEqual(record["attempt_count"], 0)
        self.assertEqual(record["payload"]["change_id"], "demo-change")
        self.assertEqual(record["payload"]["outcome"], OUTCOME)
        # 队列重启等价物：全新读取视角仍可见（状态全在盘上）
        reloaded = outbox.load_records(self.project)
        self.assertEqual([r["entry_id"] for r in reloaded], [record["entry_id"]])
        journal = outbox.read_journal(self.project, record["entry_id"])
        self.assertEqual([j["kind"] for j in journal], ["enqueue"])
        # write-ahead 协议：journal 行恒 prepared；record.last_operation_id 对齐
        # 即 committed（由 status 派生），错位即 ambiguous。
        self.assertEqual(journal[0]["state"], "prepared")
        self.assertEqual(record["last_operation_id"], journal[0]["operation_id"])

    def test_duplicate_enqueue_replayed_not_duplicated(self) -> None:
        first, _ = self._enqueue()
        second, replayed = self._enqueue()
        self.assertTrue(replayed)
        self.assertEqual(first["entry_id"], second["entry_id"])
        self.assertEqual(len(outbox.load_records(self.project)), 1)

    def test_conflicting_content_never_deduped(self) -> None:
        # 冲突知识必测项：同 change 不同成果 → 幂等键不同 → 各自独立入队。
        first, _ = self._enqueue(doc=_outcome("版本 A"))
        second, replayed = self._enqueue(doc=_outcome("版本 B"))
        self.assertFalse(replayed)
        self.assertNotEqual(first["entry_id"], second["entry_id"])
        self.assertEqual(len(outbox.load_records(self.project)), 2)

    def test_kind_allowlist_rejects_unknown(self) -> None:
        # 敏感内容剔除的结构性一半：只有白名单种类能进队列。
        with self.assertRaises(outbox.AssetOutboxError) as ctx:
            outbox.enqueue(
                self.project,
                kind="secrets",
                change_id="demo-change",
                payload={"api_key": "x"},
                now=T0,
            )
        self.assertEqual(ctx.exception.code, "ASSET_OUTBOX_RECORD_INVALID")

    def test_cross_project_isolation(self) -> None:
        other = Path(tempfile.mkdtemp(prefix="harness-outbox-other-"))
        try:
            self._enqueue()
            self.assertEqual(len(outbox.load_records(self.project)), 1)
            self.assertEqual(outbox.load_records(other), [])
        finally:
            shutil.rmtree(other, ignore_errors=True)


class LeaseTests(OutboxFixture):
    def test_claim_leases_and_stores_only_capability_hash(self) -> None:
        record, _ = self._enqueue()
        claims = outbox.claim_due(self.project, owner_id="w1", now=T0)
        self.assertEqual(len(claims), 1)
        claim = claims[0]
        self.assertNotEqual(claim.capability, claim.record["lease"]["capability_hash"])
        self.assertNotIn(claim.capability, json.dumps(claim.record))
        self.assertEqual(claim.record["state"], "leased")
        self.assertEqual(claim.record["attempt_count"], 1)

    def test_leased_record_not_claimable_until_reap(self) -> None:
        self._enqueue()
        outbox.claim_due(self.project, owner_id="w1", now=T0)
        self.assertEqual(outbox.claim_due(self.project, owner_id="w2", now=T0), [])
        # 领取后崩溃必测项：租约过期 → reap → 其他 worker 可再领取
        expired = T0 + timedelta(seconds=outbox.LEASE_TTL_SECONDS + 1)
        reaped = outbox.reap(self.project, now=expired)
        self.assertEqual(len(reaped), 1)
        claims = outbox.claim_due(self.project, owner_id="w2", now=expired)
        self.assertEqual(len(claims), 1)

    def test_ack_with_wrong_capability_conflicts(self) -> None:
        record, _ = self._enqueue()
        claim = outbox.claim_due(self.project, owner_id="w1", now=T0)[0]
        forged = outbox.Claim(record=claim.record, capability="asset_outbox_cap:" + "0" * 64)
        with self.assertRaises(outbox.AssetOutboxError) as ctx:
            outbox.ack(self.project, forged, {"remote_id": "x"}, now=T0)
        self.assertEqual(ctx.exception.code, "ASSET_OUTBOX_CLAIM_CONFLICT")
        # 原 capability 仍可 ack
        done = outbox.ack(self.project, claim, {"remote_id": "srv-1"}, now=T0)
        self.assertEqual(done["state"], "delivered")
        self.assertEqual(done["durable_receipt"], {"remote_id": "srv-1"})


class BackoffTests(OutboxFixture):
    def test_nack_backs_off_then_dead_letters(self) -> None:
        self._enqueue()
        now = T0
        for attempt in range(1, outbox.MAX_ATTEMPTS + 1):
            claims = outbox.claim_due(self.project, owner_id="w1", now=now)
            self.assertEqual(len(claims), 1, f"attempt {attempt} 应可领取")
            record = outbox.nack(
                self.project, claims[0], "ASSET_OUTBOX_DELIVERY_FAILED", retryable=True, now=now,
            )
            if attempt < outbox.MAX_ATTEMPTS:
                self.assertEqual(record["state"], "retry_wait")
                due = datetime.fromisoformat(record["next_attempt_at"].replace("Z", "+00:00"))
                self.assertGreater(due, now)
                # 退避窗口内不可领取
                self.assertEqual(outbox.claim_due(self.project, owner_id="w1", now=now), [])
                now = due
            else:
                self.assertEqual(record["state"], "dead_letter")
        self.assertEqual(outbox.claim_due(self.project, owner_id="w1", now=now), [])

    def test_terminal_nack_goes_straight_to_dead_letter(self) -> None:
        self._enqueue()
        claim = outbox.claim_due(self.project, owner_id="w1", now=T0)[0]
        record = outbox.nack(self.project, claim, "REMOTE_REJECTED", retryable=False, now=T0)
        self.assertEqual(record["state"], "dead_letter")
        self.assertEqual(record["last_reason_code"], "REMOTE_REJECTED")


class DrainTests(OutboxFixture):
    def test_drain_without_transport_marks_pending_unconfigured(self) -> None:
        # 离线交付必测项：无远端环境时不领取、不烧 attempts，显式标注待验证。
        record, _ = self._enqueue()
        result = outbox.drain(self.project, transport=None, now=T0)
        self.assertEqual(result["code"], "ASSET_OUTBOX_REMOTE_UNCONFIGURED")
        self.assertEqual(result["delivered"], 0)
        self.assertEqual(result["pending_remote_unconfigured"], 1)
        self.assertEqual(result["verification"], "pending")
        reloaded = outbox.load_records(self.project)[0]
        self.assertEqual(reloaded["state"], "pending")
        self.assertEqual(reloaded["attempt_count"], 0)
        self.assertEqual(reloaded["entry_id"], record["entry_id"])

    def test_drain_delivers_with_transport(self) -> None:
        self._enqueue()
        transport = FakeTransport()
        result = outbox.drain(self.project, transport=transport, now=T0)
        self.assertEqual(result["delivered"], 1)
        self.assertEqual(outbox.load_records(self.project)[0]["state"], "delivered")

    def test_drain_transport_failure_backs_off(self) -> None:
        self._enqueue()
        result = outbox.drain(self.project, transport=FakeTransport(fail_times=1), now=T0)
        self.assertEqual(result["delivered"], 0)
        record = outbox.load_records(self.project)[0]
        self.assertEqual(record["state"], "retry_wait")
        self.assertEqual(record["last_reason_code"], "ASSET_OUTBOX_DELIVERY_FAILED")

    def test_remote_success_but_local_receipt_write_fails(self) -> None:
        # 远端成功但本地回执失败必测项：journal 留下 ambiguous ack，
        # 记录保持 leased；修复后重投用同一幂等键（消费方幂等去重的本地佐证）。
        record, _ = self._enqueue()
        transport = FakeTransport()
        original_write = outbox._write_record
        sabotaged = {"armed": True}

        def flaky(project, rec):
            if sabotaged["armed"] and rec.get("state") == "delivered":
                sabotaged["armed"] = False
                # 与真实 _write_record 的失败形态一致（OSError 已包装）
                raise outbox.AssetOutboxError("ASSET_OUTBOX_WRITE_FAILED", "disk full")
            return original_write(project, rec)

        outbox._write_record = flaky
        try:
            with self.assertRaises(outbox.AssetOutboxError) as ctx:
                outbox.drain(self.project, transport=transport, now=T0)
            self.assertEqual(ctx.exception.code, "ASSET_OUTBOX_WRITE_FAILED")
        finally:
            outbox._write_record = original_write

        on_disk = outbox.load_records(self.project)[0]
        self.assertEqual(on_disk["state"], "leased")
        journal = outbox.read_journal(self.project, record["entry_id"])
        acks = [j for j in journal if j["kind"] == "ack"]
        self.assertEqual(len(acks), 1)
        self.assertEqual(acks[0]["state"], "prepared")
        # 记录覆写失败 → last_operation_id 没推进 → status 派生 ambiguous
        self.assertNotEqual(on_disk["last_operation_id"], acks[0]["operation_id"])
        status = outbox.status(self.project, now=T0)
        self.assertTrue(status["records"][0]["ambiguous"])

        # 修复盘 + 租约过期后重投：远端收到同幂等键的第二次交付
        expired = T0 + timedelta(seconds=outbox.LEASE_TTL_SECONDS + 1)
        result = outbox.drain(self.project, transport=transport, now=expired)
        self.assertEqual(result["delivered"], 1)
        self.assertEqual(len(transport.calls), 2)
        self.assertEqual(transport.calls[0], transport.calls[1])
        self.assertFalse(outbox.status(self.project, now=expired)["records"][0]["ambiguous"])


class CapacityTests(OutboxFixture):
    def test_capacity_eviction_spills_oldest_pending(self) -> None:
        # 容量不足必测项：硬上限 + 溢出降级——最旧 pending 逐出为死信并留痕。
        # 逐出按 created_at 排序，必须给递增时间戳（同刻决胜键是随机 entry_id，
        # 全用 T0 会让被逐出者不确定——本测试曾因此间歇失败）。
        first, _ = self._enqueue(change="c1", max_entries=2, now=T0)
        self._enqueue(change="c2", max_entries=2, now=T0 + timedelta(seconds=1))
        third, replayed = self._enqueue(
            change="c3", max_entries=2, now=T0 + timedelta(seconds=2)
        )
        self.assertFalse(replayed)
        records = {r["payload"]["change_id"]: r for r in outbox.load_records(self.project)}
        # 死信是终端证据保留在盘上；活动额度 = pending c2/c3 两条
        self.assertEqual(len(records), 3)
        self.assertEqual(records["c1"]["state"], "dead_letter")
        self.assertEqual(records["c1"]["last_reason_code"], "CAPACITY_EVICTION")
        journal = outbox.read_journal(self.project, first["entry_id"])
        self.assertEqual(journal[-1]["kind"], "dead_letter")
        self.assertEqual(records["c2"]["state"], "pending")
        self.assertEqual(records["c3"]["state"], "pending")
        self.assertEqual(records["c3"]["entry_id"], third["entry_id"])
        self.assertEqual(outbox.status(self.project, now=T0)["capacity"]["used"], 2)

    def test_capacity_exceeded_when_nothing_evictable(self) -> None:
        self._enqueue(change="c1", max_entries=1)
        outbox.claim_due(self.project, owner_id="w1", now=T0)  # leased 不可逐出
        with self.assertRaises(outbox.AssetOutboxError) as ctx:
            self._enqueue(change="c2", max_entries=1)
        self.assertEqual(ctx.exception.code, "ASSET_OUTBOX_CAPACITY_EXCEEDED")


class StatusTests(OutboxFixture):
    def test_status_counts_and_capacity(self) -> None:
        self._enqueue(change="c1")
        self._enqueue(change="c2", doc=_outcome("另一条"))
        status = outbox.status(self.project, now=T0)
        self.assertEqual(status["counts"]["pending"], 2)
        self.assertEqual(status["capacity"]["max_entries"], outbox.MAX_ENTRIES)
        self.assertEqual(status["capacity"]["used"], 2)
        self.assertFalse(status["records"][0]["ambiguous"])


class CliTests(OutboxFixture):
    """O6-F6：status/drain CLI 归属本模块（迁出 harness_assets.py）。"""

    def _run(self, *argv: str) -> tuple[int, dict]:
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            rc = outbox.main(list(argv))
        text = buffer.getvalue().strip()
        return rc, json.loads(text) if text else {}

    def test_cli_status_empty(self) -> None:
        rc, payload = self._run("status", "--project", str(self.project), "--json")
        self.assertEqual(rc, 0, payload)
        self.assertEqual(payload["code"], "ASSET_OUTBOX_STATUS")
        self.assertEqual(payload["records"], [])
        self.assertEqual(payload["capacity"]["used"], 0)

    def test_cli_drain_without_remote_marks_pending(self) -> None:
        self._enqueue(change="cli-change")
        rc, payload = self._run("drain", "--project", str(self.project), "--json")
        self.assertEqual(rc, 0, payload)
        self.assertEqual(payload["code"], "ASSET_OUTBOX_REMOTE_UNCONFIGURED")
        self.assertEqual(payload["pending_remote_unconfigured"], 1)
        self.assertEqual(payload["verification"], "pending")
        rc, payload = self._run("status", "--project", str(self.project), "--json")
        self.assertEqual(rc, 0)
        self.assertEqual(payload["counts"]["pending"], 1)

    def test_cli_drain_owner_and_limit_flags(self) -> None:
        self._enqueue(change="c1")
        self._enqueue(change="c2", doc=_outcome("另一条"))
        rc, payload = self._run(
            "drain", "--project", str(self.project), "--owner", "cli-owner",
            "--limit", "1", "--json",
        )
        self.assertEqual(rc, 0, payload)
        # transport=None 不领取不烧 attempts，两条都保持 pending
        self.assertEqual(payload["pending_remote_unconfigured"], 2)


if __name__ == "__main__":
    unittest.main()
