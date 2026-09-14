#!/usr/bin/env python3
"""Python asset-outbox（WI-E3，O4 异步资产闭环）。

设计：docs/harness-improvement-roadmap/batch3/design-o3-o4-outcome-assets-2026-09-14.md §7。
模式对齐 TS 侧 archive-outbox v2（packages/core/src/archive-outbox/v2-types.ts）：
四动词 claim/ack/nack/reap、capability 只落 hash、迁移 journal、指数退避、死信。

与 v2 的差异（刻意）：记录/文件粒度（v2 用 DurableObject 式端口抽象，本队列直接落盘）、
payload 内嵌（资产是小 JSON，finish 入队时归档尚未发生，payload 必须自包含）、
MAX_ATTEMPTS=5（v2=100 面向重型 zip；小资产快速死信更早暴露系统性故障）。

存储布局（按项目隔离）::

    .harness/state/local/asset-outbox/
      records/<entry_id>.json     记录（原子覆写）
      journal/<entry_id>.ndjson   迁移 journal（追加、先行写）

write-ahead 协议：每次状态迁移先把 {operation_id, kind, state:"prepared"} 追加进
journal，再覆写记录（记录带 last_operation_id）。记录覆写失败时 journal 行保持
未对账状态——status() 以「journal 末行 operation_id != record.last_operation_id」
派生 ambiguous。远端成功但本地回执失败因此可观测，重投以幂等键去重。

容量策略：活动记录（pending/leased/retry_wait）硬上限 MAX_ENTRIES；溢出时逐出
最旧 pending 为 dead_letter(reason=CAPACITY_EVICTION)；无 pending 可逐才报
ASSET_OUTBOX_CAPACITY_EXCEEDED。dead_letter/delivered 是终端证据不占额度。
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, NamedTuple

SCHEMA_VERSION = 1
LEASE_TTL_SECONDS = 60
BACKOFF_BASE_SECONDS = 1
BACKOFF_MAX_SECONDS = 60
MAX_ATTEMPTS = 5
MAX_ENTRIES = 1000
KINDS = ("outcome",)
ACTIVE_STATES = ("pending", "leased", "retry_wait")

ASSET_OUTBOX_RECORD_INVALID = "ASSET_OUTBOX_RECORD_INVALID"
ASSET_OUTBOX_CAPACITY_EXCEEDED = "ASSET_OUTBOX_CAPACITY_EXCEEDED"
ASSET_OUTBOX_CLAIM_CONFLICT = "ASSET_OUTBOX_CLAIM_CONFLICT"
ASSET_OUTBOX_WRITE_FAILED = "ASSET_OUTBOX_WRITE_FAILED"
ASSET_OUTBOX_DELIVERY_FAILED = "ASSET_OUTBOX_DELIVERY_FAILED"
ASSET_OUTBOX_REMOTE_UNCONFIGURED = "ASSET_OUTBOX_REMOTE_UNCONFIGURED"


class AssetOutboxError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


class Claim(NamedTuple):
    record: dict[str, Any]
    capability: str  # 只在此返回值中出现一次；盘上只存 sha256


# --- 基础工具 ---------------------------------------------------------


def _now(now: datetime | None) -> datetime:
    if now is not None:
        return now
    return datetime.now(timezone.utc)


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _parse_iso(raw: str) -> datetime:
    return datetime.fromisoformat(raw.replace("Z", "+00:00"))


def _sha256_text(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def _canonical(doc: Any) -> str:
    return json.dumps(doc, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _outbox_root(project: Path) -> Path:
    return Path(project) / ".harness" / "state" / "local" / "asset-outbox"


def _records_dir(project: Path) -> Path:
    return _outbox_root(project) / "records"


def _journal_dir(project: Path) -> Path:
    return _outbox_root(project) / "journal"


def _record_path(project: Path, entry_id: str) -> Path:
    return _records_dir(project) / f"{entry_id}.json"


def _journal_path(project: Path, entry_id: str) -> Path:
    return _journal_dir(project) / f"{entry_id}.ndjson"


def _new_operation_id() -> str:
    return f"asset_outbox_op_{secrets.token_hex(8)}"


def _append_journal(
    project: Path,
    entry_id: str,
    *,
    kind: str,
    operation_id: str,
    detail: dict[str, Any] | None = None,
    at: datetime,
) -> dict[str, Any]:
    line = {
        "operation_id": operation_id,
        "kind": kind,
        "state": "prepared",
        "detail": detail or {},
        "at": _iso(at),
    }
    path = _journal_path(project, entry_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(line, ensure_ascii=False, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    return line


def _write_record(project: Path, record: dict[str, Any]) -> None:
    """原子覆写记录；失败抛 AssetOutboxError(ASSET_OUTBOX_WRITE_FAILED)。"""
    path = _record_path(project, record["entry_id"])
    tmp = path.with_suffix(".json.tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(
            json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        os.replace(tmp, path)
    except OSError as exc:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise AssetOutboxError(
            ASSET_OUTBOX_WRITE_FAILED,
            f"记录覆写失败（{type(exc).__name__}: {exc}）",
        ) from exc


def read_journal(project: Path, entry_id: str) -> list[dict[str, Any]]:
    path = _journal_path(project, entry_id)
    if not path.is_file():
        return []
    lines = [ln for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]
    return [json.loads(ln) for ln in lines]


def load_records(project: Path) -> list[dict[str, Any]]:
    root = _records_dir(project)
    if not root.is_dir():
        return []
    records = [
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted(root.glob("asset_outbox_*.json"))
    ]
    records.sort(key=lambda item: (item.get("created_at") or "", item.get("entry_id") or ""))
    return records


def _save_journal_then_record(
    project: Path,
    record: dict[str, Any],
    *,
    kind: str,
    detail: dict[str, Any] | None,
    at: datetime,
) -> dict[str, Any]:
    operation_id = _new_operation_id()
    _append_journal(
        project, record["entry_id"], kind=kind, operation_id=operation_id,
        detail=detail, at=at,
    )
    record["last_operation_id"] = operation_id
    record["updated_at"] = _iso(at)
    _write_record(project, record)
    return record


# --- 入队 -------------------------------------------------------------


def _idempotency_key(kind: str, change_id: str, payload: dict[str, Any]) -> str:
    return _sha256_text(f"asset-outbox|{kind}|{change_id}|{_sha256_text(_canonical(payload))}")


def _evict_for_capacity(project: Path, *, max_entries: int, at: datetime) -> None:
    """活动记录超上限时逐出最旧 pending 腾位；无 pending 可逐报错。"""
    records = load_records(project)
    active = [r for r in records if r.get("state") in ACTIVE_STATES]
    overflow = len(active) - max_entries + 1
    if overflow <= 0:
        return
    pending = [r for r in active if r.get("state") == "pending"]
    if len(pending) < overflow:
        raise AssetOutboxError(
            ASSET_OUTBOX_CAPACITY_EXCEEDED,
            f"asset-outbox 活动记录上限 {max_entries}，且无 pending 可逐出"
            f"（leased/retry_wait {len(active) - len(pending)} 条）；"
            "先 drain 或等待租约过期 reap",
        )
    for victim in pending[:overflow]:
        victim["state"] = "dead_letter"
        victim["last_reason_code"] = "CAPACITY_EVICTION"
        _save_journal_then_record(
            project, victim, kind="dead_letter",
            detail={"reason_code": "CAPACITY_EVICTION"}, at=at,
        )


def enqueue(
    project: Path,
    *,
    kind: str,
    change_id: str,
    payload: dict[str, Any],
    max_entries: int = MAX_ENTRIES,
    now: datetime | None = None,
) -> tuple[dict[str, Any], bool]:
    """入队一条资产；同幂等键重放返回 (既有记录, True)，不重复入队。"""
    at = _now(now)
    if kind not in KINDS:
        raise AssetOutboxError(
            ASSET_OUTBOX_RECORD_INVALID,
            f"kind {kind!r} 不在白名单 {KINDS}（敏感内容剔除：只有白名单种类可入队）",
        )
    if not change_id:
        raise AssetOutboxError(ASSET_OUTBOX_RECORD_INVALID, "change_id 不能为空")
    key = _idempotency_key(kind, change_id, payload)
    for existing in load_records(project):
        if existing.get("idempotency_key") == key:
            return existing, True

    _evict_for_capacity(project, max_entries=max_entries, at=at)
    record: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "entry_id": f"asset_outbox_{secrets.token_hex(12)}",
        "kind": kind,
        "idempotency_key": key,
        "payload": payload,
        "state": "pending",
        "attempt_count": 0,
        "generation": 0,
        "lease": None,
        "next_attempt_at": None,
        "last_reason_code": None,
        "durable_receipt": None,
        "last_operation_id": None,
        "created_at": _iso(at),
        "updated_at": _iso(at),
    }
    _save_journal_then_record(
        project, record, kind="enqueue",
        detail={"idempotency_key": key, "asset_kind": kind, "change_id": change_id},
        at=at,
    )
    return record, False


def enqueue_outcome(
    project: Path,
    change_id: str,
    outcome_doc: dict[str, Any],
    *,
    max_entries: int = MAX_ENTRIES,
    now: datetime | None = None,
) -> tuple[dict[str, Any], bool]:
    """finish 原子入队点：payload 内嵌完整 outcome 文档（自包含，不引用将被归档移走的路径）。"""
    payload = {"change_id": change_id, "outcome": outcome_doc}
    return enqueue(
        project, kind="outcome", change_id=change_id, payload=payload,
        max_entries=max_entries, now=now,
    )


# --- 租约 / 迁移 -------------------------------------------------------


def _claimable(record: dict[str, Any], at: datetime) -> bool:
    state = record.get("state")
    if state == "pending":
        return True
    if state == "retry_wait":
        due = record.get("next_attempt_at")
        return bool(due) and _parse_iso(due) <= at
    return False


def claim_due(
    project: Path,
    *,
    owner_id: str,
    limit: int = 100,
    lease_ttl_seconds: int = LEASE_TTL_SECONDS,
    now: datetime | None = None,
) -> list[Claim]:
    at = _now(now)
    claims: list[Claim] = []
    for record in load_records(project):
        if len(claims) >= limit:
            break
        if not _claimable(record, at):
            continue
        capability = "asset_outbox_cap:" + secrets.token_hex(32)
        record["state"] = "leased"
        record["attempt_count"] = int(record.get("attempt_count") or 0) + 1
        record["generation"] = int(record.get("generation") or 0) + 1
        record["lease"] = {
            "owner_id": owner_id,
            "capability_hash": _sha256_text(capability),
            "generation": record["generation"],
            "acquired_at": _iso(at),
            "expires_at": _iso(at + timedelta(seconds=lease_ttl_seconds)),
        }
        record["next_attempt_at"] = None
        _save_journal_then_record(
            project, record, kind="claim",
            detail={"owner_id": owner_id, "attempt": record["attempt_count"]},
            at=at,
        )
        claims.append(Claim(record=record, capability=capability))
    return claims


def _fence(project: Path, claim: Claim, *, at: datetime) -> dict[str, Any]:
    """以 capability hash + generation 围栏确认 claim 仍持有记录。"""
    current = {
        r["entry_id"]: r for r in load_records(project)
    }.get(claim.record["entry_id"])
    if current is None:
        raise AssetOutboxError(
            ASSET_OUTBOX_CLAIM_CONFLICT, f"记录 {claim.record['entry_id']} 已不存在"
        )
    lease = current.get("lease") or {}
    if (
        current.get("state") != "leased"
        or lease.get("capability_hash") != _sha256_text(claim.capability)
        or lease.get("generation") != current.get("generation")
        or current.get("generation") != claim.record.get("generation")
    ):
        raise AssetOutboxError(
            ASSET_OUTBOX_CLAIM_CONFLICT,
            f"记录 {current['entry_id']} 的租约已易主或过期回收（generation "
            f"{claim.record.get('generation')} -> {current.get('generation')}）",
        )
    return current


def ack(
    project: Path,
    claim: Claim,
    receipt: dict[str, Any],
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """确认交付。journal 先行写 ack；记录覆写失败 → journal 行未对账（ambiguous），
    记录留在盘上原态（leased），reap 后以同一幂等键重投。"""
    at = _now(now)
    record = _fence(project, claim, at=at)
    record["state"] = "delivered"
    record["durable_receipt"] = receipt
    record["lease"] = None
    return _save_journal_then_record(
        project, record, kind="ack", detail={"receipt": receipt}, at=at,
    )


def nack(
    project: Path,
    claim: Claim,
    reason_code: str,
    *,
    retryable: bool,
    now: datetime | None = None,
) -> dict[str, Any]:
    at = _now(now)
    record = _fence(project, claim, at=at)
    record["lease"] = None
    record["last_reason_code"] = reason_code
    attempts = int(record.get("attempt_count") or 0)
    if not retryable or attempts >= MAX_ATTEMPTS:
        record["state"] = "dead_letter"
        record["next_attempt_at"] = None
        kind = "dead_letter"
    else:
        record["state"] = "retry_wait"
        backoff = min(
            BACKOFF_MAX_SECONDS, BACKOFF_BASE_SECONDS * (2 ** max(0, attempts - 1))
        )
        record["next_attempt_at"] = _iso(at + timedelta(seconds=backoff))
        kind = "nack"
    return _save_journal_then_record(
        project, record, kind=kind,
        detail={"reason_code": reason_code, "retryable": retryable, "attempt": attempts},
        at=at,
    )


def reap(project: Path, *, now: datetime | None = None) -> list[str]:
    """回收过期租约：leased 且 expires_at <= now → pending（可重投）。"""
    at = _now(now)
    reaped: list[str] = []
    for record in load_records(project):
        lease = record.get("lease") or {}
        expires = lease.get("expires_at")
        if record.get("state") != "leased" or not expires or _parse_iso(expires) > at:
            continue
        record["state"] = "pending"
        record["lease"] = None
        record["generation"] = int(record.get("generation") or 0) + 1
        _save_journal_then_record(
            project, record, kind="reap",
            detail={"previous_owner": lease.get("owner_id")}, at=at,
        )
        reaped.append(record["entry_id"])
    return reaped


def maintenance(project: Path, *, now: datetime | None = None) -> dict[str, Any]:
    """begin 钩子（下次启动续跑）：reap 过期租约 + 队列摘要；本地操作，不触远端。"""
    at = _now(now)
    reaped = reap(project, now=at)
    counts: dict[str, int] = {}
    for record in load_records(project):
        state = str(record.get("state") or "unknown")
        counts[state] = counts.get(state, 0) + 1
    return {
        "reaped": len(reaped),
        "counts": counts,
        "remote": "unconfigured",
        "verification": "pending" if counts.get("pending") or counts.get("retry_wait") else "idle",
    }


def drain(
    project: Path,
    *,
    transport: Any = None,
    owner_id: str = "harness-drain",
    limit: int = 100,
    now: datetime | None = None,
) -> dict[str, Any]:
    """交付到期记录。transport=None（无远端环境）时不领取不烧 attempts，
    显式标注 pending_remote_unconfigured + verification=pending。"""
    at = _now(now)
    maintenance(project, now=at)
    if transport is None:
        pending = sum(
            1
            for r in load_records(project)
            if r.get("state") in ("pending", "retry_wait", "leased")
        )
        return {
            "ok": True,
            "code": ASSET_OUTBOX_REMOTE_UNCONFIGURED,
            "remote": "unconfigured",
            "delivered": 0,
            "pending_remote_unconfigured": pending,
            "verification": "pending",
            "results": [],
        }

    results: list[dict[str, Any]] = []
    delivered = 0
    for claim in claim_due(project, owner_id=owner_id, limit=limit, now=at):
        entry_id = claim.record["entry_id"]
        try:
            receipt = transport.deliver(claim.record)
        except Exception as exc:  # 传输失败一律按可重试退避（attempts 耗尽转死信）
            record = nack(
                project, claim, ASSET_OUTBOX_DELIVERY_FAILED, retryable=True, now=at,
            )
            results.append(
                {
                    "entry_id": entry_id,
                    "outcome": "delivery_failed",
                    "state": record["state"],
                    "error": f"{type(exc).__name__}: {exc}",
                }
            )
            continue
        record = ack(project, claim, receipt, now=at)  # 写失败抛 ASSET_OUTBOX_WRITE_FAILED
        delivered += 1
        results.append({"entry_id": entry_id, "outcome": "delivered", "state": record["state"]})
    return {
        "ok": True,
        "code": "ASSET_OUTBOX_DRAINED",
        "remote": "configured",
        "delivered": delivered,
        "pending_remote_unconfigured": 0,
        "verification": "closed" if delivered else "pending",
        "results": results,
    }


def status(project: Path, *, now: datetime | None = None) -> dict[str, Any]:
    """队列视图：计数、容量、逐记录状态（ambiguous 由 journal 对账派生）。"""
    at = _now(now)
    records = load_records(project)
    counts: dict[str, int] = {}
    views: list[dict[str, Any]] = []
    active = 0
    for record in records:
        state = str(record.get("state") or "unknown")
        counts[state] = counts.get(state, 0) + 1
        if state in ACTIVE_STATES:
            active += 1
        journal = read_journal(project, record["entry_id"])
        last_op = journal[-1]["operation_id"] if journal else None
        ambiguous = bool(last_op) and last_op != record.get("last_operation_id")
        views.append(
            {
                "entry_id": record["entry_id"],
                "kind": record.get("kind"),
                "state": state,
                "change_id": (record.get("payload") or {}).get("change_id"),
                "attempt_count": record.get("attempt_count"),
                "last_reason_code": record.get("last_reason_code"),
                "ambiguous": ambiguous,
                "created_at": record.get("created_at"),
            }
        )
    return {
        "ok": True,
        "code": "ASSET_OUTBOX_STATUS",
        "counts": counts,
        "records": views,
        "capacity": {"max_entries": MAX_ENTRIES, "used": active},
        "now": _iso(at),
    }
