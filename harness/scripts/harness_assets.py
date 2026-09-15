#!/usr/bin/env python3
"""Harness 知识资产消费回执（WI-E2，O3/O4）。

设计：docs/harness-improvement-roadmap/batch3/design-o3-o4-outcome-assets-2026-09-14.md §6。

harness_knowledge_candidates.py 把归档经验提取为知识候选（schema_version 1 +
四个资产元数据键）；本脚本记录候选被后续任务**消费**的三态回执：

    retrieved           被检索命中（未表态适用性）
    adopted             采纳
    partially_adopted   部分采纳（必须给 reason）
    rejected            拒绝/不适用（必须给 reason）
    verified_effective  采纳后验证有效

回执落 `.harness/state/local/asset-receipts/<candidate_id>.ndjson`（追加式、
每行一条 JSON），按项目隔离，不进归档包（events.ndjson 归档后不可写且从不
入包，故不挂事件流）。validation_status 与 verdict 是两根轴，本地不做自动
状态迁移（一次 rejected 是「本任务不适用」≠ 知识失效）。

空白不凑数：reason 缺失/全空白时 partially_adopted 与 rejected 拒绝落盘；
写盘失败显示报错（ASSET_RECEIPT_WRITE_FAILED），不静默丢失。

边界（O6-F6，决策点 7）：本脚本只承载**消费语义**回执；**投递语义**的资产
出站队列（status/drain）由 harness_asset_outbox.py 自带 CLI 承载。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1

CANDIDATE_ID_RE = re.compile(r"^kc_[A-Za-z0-9][A-Za-z0-9_-]{0,155}$")
VERDICTS = ("retrieved", "adopted", "partially_adopted", "rejected", "verified_effective")
_REASON_REQUIRED = {"partially_adopted", "rejected"}

ASSET_RECEIPT_INVALID = "ASSET_RECEIPT_INVALID"
ASSET_RECEIPT_REASON_REQUIRED = "ASSET_RECEIPT_REASON_REQUIRED"
ASSET_RECEIPT_WRITE_FAILED = "ASSET_RECEIPT_WRITE_FAILED"
ASSET_RECEIPT_STORE_CORRUPT = "ASSET_RECEIPT_STORE_CORRUPT"


def _emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))


def _error(code: str, message: str, recovery_action: str) -> int:
    _emit(
        {
            "ok": False,
            "code": code,
            "error": {"code": code, "message": message, "recovery_action": recovery_action},
        }
    )
    return 2


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _store_dir(project: Path) -> Path:
    return project / ".harness" / "state" / "local" / "asset-receipts"


def _validate_candidate_id(candidate_id: str) -> str | None:
    if not CANDIDATE_ID_RE.match(candidate_id):
        return (
            f"candidate_id {candidate_id!r} 非法：须匹配 {CANDIDATE_ID_RE.pattern}"
        )
    return None


def cmd_receipt(args: argparse.Namespace) -> int:
    project = Path(args.project).resolve()
    candidate_id = (args.candidate_id or "").strip()
    verdict = (args.verdict or "").strip()
    reason = args.reason.strip() if args.reason else None
    change_id = args.change.strip() if args.change else None
    detail = args.detail.strip() if args.detail else None

    invalid = _validate_candidate_id(candidate_id)
    if invalid:
        return _error(
            ASSET_RECEIPT_INVALID,
            invalid,
            "candidate_id 形如 kc_<32 hex>，由 candidates/knowledge.json 的 candidate_id 字段给出",
        )
    if verdict not in VERDICTS:
        return _error(
            ASSET_RECEIPT_INVALID,
            f"verdict {verdict!r} 非法：可选 {', '.join(VERDICTS)}",
            "retrieved/adopted/partially_adopted/rejected/verified_effective 五选一",
        )
    if verdict in _REASON_REQUIRED and not reason:
        return _error(
            ASSET_RECEIPT_REASON_REQUIRED,
            f"verdict={verdict} 必须给出非空 --reason（采纳了多少/为何拒绝）",
            "补 --reason 后重跑；空白不算数（O3 空白不凑数语义）",
        )

    record: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "candidate_id": candidate_id,
        "verdict": verdict,
        "reason": reason,
        "change_id": change_id,
        "detail": detail,
        "recorded_at": _now_iso(),
    }
    path = _store_dir(project) / f"{candidate_id}.ndjson"
    line = json.dumps(record, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
            handle.flush()
            os.fsync(handle.fileno())
    except OSError as exc:
        return _error(
            ASSET_RECEIPT_WRITE_FAILED,
            f"回执落盘失败（{type(exc).__name__}: {exc}）",
            "检查 .harness/state/local/asset-receipts 是否可写，修复后重跑 receipt",
        )
    _emit(
        {
            "ok": True,
            "code": "ASSET_RECEIPT_RECORDED",
            "receipt": record,
            "path": str(path),
        }
    )
    return 0


def _load_receipts_file(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        records.append(json.loads(line))
    return records


def cmd_receipts(args: argparse.Namespace) -> int:
    project = Path(args.project).resolve()
    candidate_id = (args.candidate_id or "").strip() or None
    if candidate_id:
        invalid = _validate_candidate_id(candidate_id)
        if invalid:
            return _error(
                ASSET_RECEIPT_INVALID,
                invalid,
                "candidate_id 形如 kc_<32 hex>",
            )

    store = _store_dir(project)
    files: list[Path]
    if candidate_id:
        target = store / f"{candidate_id}.ndjson"
        files = [target] if target.is_file() else []
    else:
        files = sorted(store.glob("kc_*.ndjson")) if store.is_dir() else []

    records: list[dict[str, Any]] = []
    try:
        for path in files:
            records.extend(_load_receipts_file(path))
    except (OSError, json.JSONDecodeError) as exc:
        return _error(
            ASSET_RECEIPT_STORE_CORRUPT,
            f"回执存储读取失败（{type(exc).__name__}: {exc}）",
            "检查 .harness/state/local/asset-receipts 下的 ndjson 是否被写坏",
        )
    records.sort(key=lambda item: (item.get("recorded_at") or "", item.get("candidate_id") or ""))
    _emit({"ok": True, "code": "ASSET_RECEIPTS", "receipts": records})
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="harness_assets.py",
        description="知识资产消费回执（WI-E2，O3/O4）",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    receipt = sub.add_parser("receipt", help="记录一条消费回执")
    receipt.add_argument("--project", default=".")
    receipt.add_argument("--candidate-id", required=True)
    receipt.add_argument("--verdict", required=True)
    receipt.add_argument("--reason")
    receipt.add_argument("--change", help="消费该资产的任务 change_id")
    receipt.add_argument("--detail", help="自由补充说明")
    receipt.add_argument("--json", action="store_true")
    receipt.set_defaults(func=cmd_receipt)

    receipts = sub.add_parser("receipts", help="读回消费回执")
    receipts.add_argument("--project", default=".")
    receipts.add_argument("--candidate-id", help="只看该候选；缺省列出全部")
    receipts.add_argument("--json", action="store_true")
    receipts.set_defaults(func=cmd_receipts)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
