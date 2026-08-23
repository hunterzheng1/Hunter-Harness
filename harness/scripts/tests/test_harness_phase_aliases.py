#!/usr/bin/env python3
"""run/test → execute 别名兼容测试（在途 change 场景）。

两条不变量的冻结：
1. 写边界归一化——公共动词入口把旧名归一为 execute，新凭证一律 canonical。
2. 读侧不迁移——落盘的 transitions/events/capsule 不改写，_payload_hash 与
   哈希链对原始字节校验，别名只在哈希校验之后的业务比较层生效。
"""

from __future__ import annotations

import datetime as dt
import importlib.util
import json
import subprocess
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


CONTEXT = load_module("harness_context", "harness_context.py")
GATE = load_module("harness_gate_aliases_test", "harness_gate.py")
LEDGER = load_module("harness_ledger", "harness_ledger.py")
PHASE = load_module("harness_phase", "harness_phase.py")
ARCHIVE = load_module("harness_archive", "harness_archive.py")
hpaths = CONTEXT.hpaths


def make_change(project: Path, name: str, status: str = "active") -> Path:
    change = project / ".harness/changes" / name
    (change / "meta").mkdir(parents=True)
    (change / "meta/change-context.json").write_text(
        json.dumps(
            {
                "schemaVersion": 2,
                "changeName": name,
                "lifecycle": {"status": status},
                "stateOwnership": {
                    "runtimeRoot": f".harness/state/changes/{name}"
                },
            }
        ),
        encoding="utf-8",
    )
    return change


def init_repo(project: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=project, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=project, check=True)
    subprocess.run(["git", "config", "user.name", "tester"], cwd=project, check=True)
    subprocess.run(["git", "config", "commit.gpgsign", "false"], cwd=project, check=True)
    (project / "tracked.txt").write_text("base\n", encoding="utf-8")
    subprocess.run(["git", "add", "tracked.txt"], cwd=project, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "base"], cwd=project, check=True)


def head_sha(project: Path) -> str:
    proc = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=project, check=True, capture_output=True, text=True
    )
    return proc.stdout.strip()


def _legacy_receipt(
    change: str,
    from_phase: str,
    to_phase: str,
    *,
    attempt: int = 1,
    previous_hash: str | None = None,
    product_commit: str | None = None,
    trigger: str | None = None,
    closed_at: str = "2026-08-20T10:00:00+00:00",
) -> dict:
    """按合并前的形状造一张旧名凭证（含正确 _payload_hash）。"""
    receipt: dict = {
        "schemaVersion": 1,
        "changeName": change,
        "fromPhase": from_phase,
        "toPhase": to_phase,
        "status": "OK",
        "executor": "codex",
        "productCommit": product_commit,
        "artifacts": [],
        "attempt": attempt,
        "closedAt": closed_at,
        "previousReceiptHash": previous_hash,
    }
    if trigger:
        receipt["trigger"] = trigger
    receipt["receiptHash"] = CONTEXT._payload_hash(receipt)
    return receipt


def seed_transitions(project: Path, change: str, receipts: list[dict]) -> Path:
    state = project / ".harness/state/changes" / change / "runtime"
    state.mkdir(parents=True, exist_ok=True)
    path = state / "transitions.ndjson"
    path.write_text(
        "".join(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n" for item in receipts),
        encoding="utf-8",
    )
    return path


def chain(change: str, *legs: tuple[str, str], product_commit: str | None = None) -> list[dict]:
    """把 [(from,to), ...] 连成一条哈希链正确的旧名凭证序列。"""
    receipts: list[dict] = []
    previous: str | None = None
    for index, (from_phase, to_phase) in enumerate(legs):
        receipt = _legacy_receipt(
            change,
            from_phase,
            to_phase,
            attempt=1,
            previous_hash=previous,
            product_commit=product_commit,
            closed_at=f"2026-08-20T10:{index:02d}:00+00:00",
        )
        receipts.append(receipt)
        previous = receipt["receiptHash"]
    return receipts


class InFlightChangeAliasTests(unittest.TestCase):
    """在途 change 的落盘数据保持旧名，业务逻辑经别名层继续工作。"""

    def test_change_parked_at_run_can_begin_and_close_as_execute(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            init_repo(project)
            make_change(project, "change")
            seed_transitions(
                project, "change",
                chain("change", ("plan", "run"), product_commit=head_sha(project)),
            )
            snapshot = (project / ".harness/state/changes/change/runtime/transitions.ndjson").read_bytes()

            prepared = CONTEXT.prepare_context(project, change="change", phase="execute", executor="codex")
            self.assertTrue(prepared["ok"], prepared)
            begun = CONTEXT.begin_transition(project, "change", phase="execute", executor="codex")
            self.assertTrue(begun["ok"], begun)
            closed = CONTEXT.close_transition(
                project, "change", from_phase="execute", to_phase="review", executor="codex"
            )

            self.assertTrue(closed["ok"], closed)
            receipt = closed["receipt"]
            self.assertEqual(receipt["fromPhase"], "execute")
            self.assertEqual(receipt["toPhase"], "review")
            self.assertEqual(receipt["attempt"], 1)
            # 链在旧凭证后续接，不改写旧字节。
            self.assertEqual(
                receipt["previousReceiptHash"],
                json.loads(snapshot.decode().splitlines()[-1])["receiptHash"],
            )
            self.assertTrue(
                (project / ".harness/state/changes/change/runtime/transitions.ndjson")
                .read_bytes().startswith(snapshot)
            )

    def test_change_parked_at_test_closes_with_legacy_and_canonical_names(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            init_repo(project)
            make_change(project, "change")
            seed_transitions(
                project, "change",
                chain(
                    "change", ("plan", "run"), ("run", "test"),
                    product_commit=head_sha(project),
                ),
            )
            CONTEXT.prepare_context(project, change="change", phase="execute", executor="codex")

            closed = CONTEXT.close_transition(
                project, "change", from_phase="test", to_phase="review", executor="codex"
            )
            self.assertTrue(closed["ok"], closed)
            self.assertEqual(closed["receipt"]["fromPhase"], "execute")

            # 换个叫法重复关门：幂等命中同一张 canonical 凭证。
            again = CONTEXT.close_transition(
                project, "change", from_phase="execute", to_phase="review", executor="codex"
            )
            self.assertTrue(again["ok"], again)
            self.assertEqual(again["code"], "TRANSITION_ALREADY_CLOSED")
            self.assertEqual(again["receipt"]["receiptHash"], closed["receipt"]["receiptHash"])

    def test_fixback_attempt_count_is_continuous_across_the_merge(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            init_repo(project)
            make_change(project, "change")
            seed_transitions(
                project, "change",
                chain(
                    "change",
                    ("plan", "run"), ("run", "test"), ("test", "run"),
                    product_commit=head_sha(project),
                ),
            )
            CONTEXT.prepare_context(project, change="change", phase="execute", executor="codex")

            closed = CONTEXT.close_transition(
                project, "change", from_phase="execute", to_phase="execute", executor="codex"
            )

            self.assertTrue(closed["ok"], closed)
            # 旧 run→test 与 test→run 两条腿都折叠进 execute→execute 家族，
            # attempt 是该家族的序数：1 + 2 = 3（单调唯一即可，无语义门禁）。
            self.assertEqual(closed["receipt"]["attempt"], 3)
            self.assertIsNotNone(closed.get("invalidation"))

    def test_review_fixback_reselect_recognizes_legacy_receipts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            init_repo(project)
            make_change(project, "change")
            legacy = _legacy_receipt(
                "change", "review", "run",
                previous_hash=None,
                product_commit=head_sha(project),
                trigger="review-fixback",
            )
            seed_transitions(project, "change", [legacy])

            selected = CONTEXT.prepare_context(
                project, change="change", phase="execute",
                executor="codex", trigger="review-fixback",
            )
            self.assertTrue(selected["ok"], selected)
            self.assertEqual(selected["branchSelection"]["code"], "FIXBACK_BRANCH_ALREADY_SELECTED")

    def test_review_fixback_reselect_writes_canonical_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            init_repo(project)
            make_change(project, "change")
            seed_transitions(
                project, "change",
                chain("change", ("plan", "review"), ("review", "submit"),
                      product_commit=head_sha(project)),
            )

            selected = CONTEXT.prepare_context(
                project, change="change", phase="execute",
                executor="codex", trigger="review-fixback",
            )

            self.assertTrue(selected["ok"], selected)
            reselection = selected["branchSelection"]
            self.assertEqual(reselection["code"], "FIXBACK_BRANCH_RESELECTED")
            self.assertEqual(reselection["receipt"]["fromPhase"], "review")
            self.assertEqual(reselection["receipt"]["toPhase"], "execute")

    def test_phase_plan_dedupes_merged_legacy_names(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            init_repo(project)
            change = make_change(project, "change")
            (change / "meta/gate-policy.json").write_text(
                json.dumps({
                    "schemaVersion": 1,
                    "plannedPhases": ["plan", "run", "test", "review", "archive"],
                }),
                encoding="utf-8",
            )

            planned, source = CONTEXT._phase_plan(change)
            self.assertEqual(planned, ["plan", "execute", "review", "archive"])
            self.assertEqual(source, "change")

            # 旧名 close test→review 在这个计划下合法（不判 TRANSITION_ILLEGAL）。
            seed_transitions(
                project, "change",
                chain(
                    "change", ("plan", "run"), ("run", "test"),
                    product_commit=head_sha(project),
                ),
            )
            CONTEXT.prepare_context(project, change="change", phase="execute", executor="codex")
            closed = CONTEXT.close_transition(
                project, "change", from_phase="test", to_phase="review", executor="codex"
            )
            self.assertTrue(closed["ok"], closed)

    def test_target_required_dag_reads_legacy_node_phases(self) -> None:
        policy = {
            "requiredGateDag": {
                "schemaVersion": 1,
                "nodes": [
                    {"id": "validation:compile", "kind": "validation", "phase": "run"},
                    {"id": "validation:unitTest", "kind": "validation", "phase": "run",
                     "dependsOn": ["validation:compile"]},
                    {"id": "validation:unitTestFull", "kind": "validation", "phase": "test",
                     "dependsOn": ["validation:unitTest"]},
                    {"id": "stage:review", "kind": "stage", "phase": "review"},
                ],
                "edges": [
                    {"from": "validation:compile", "to": "validation:unitTest"},
                    {"from": "validation:unitTest", "to": "validation:unitTestFull"},
                ],
            }
        }

        dag = PHASE.target_required_dag(policy, "execute")

        selected = {node["id"]: node["phase"] for node in dag["nodes"]}
        self.assertEqual(
            selected,
            {
                "validation:compile": "execute",
                "validation:unitTest": "execute",
                "validation:unitTestFull": "execute",
            },
        )
        self.assertEqual(dag["targetPhase"], "execute")

    def test_scenario_owner_phase_rank_reads_legacy_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp)
            (change / "meta").mkdir(parents=True)
            (change / "meta/scenario-manifest.json").write_text(
                json.dumps({
                    "schemaVersion": 1,
                    "scenarios": [
                        {"id": "OLD-1", "priority": "P0", "ownerPhase": "test",
                         "requiredEvidenceKind": "ledger"},
                        {"id": "LATER-1", "priority": "P0", "ownerPhase": "review",
                         "requiredEvidenceKind": "ledger"},
                    ],
                }),
                encoding="utf-8",
            )
            (change / "evidence").mkdir()
            (change / "evidence/verification-ledger.json").write_text(
                json.dumps({"changeName": "x", "validations": {}}), encoding="utf-8"
            )

            result = GATE._validate_scenario_coverage(change, "execute")

            # 旧 ownerPhase=test 归一到 execute：到期（不延期）；review 仍顺延。
            self.assertEqual(result["deferred"], ["LATER-1"])
            self.assertIn("OLD-1", result["missing"])

    def test_frozen_ownership_reads_legacy_and_canonical_capsules(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp) / "change"
            (change / "meta").mkdir(parents=True)
            (change / "meta/change-context.json").write_text(
                json.dumps({
                    "schemaVersion": 2,
                    "changeName": "change",
                    "ownership": {"productPaths": ["src/"]},
                }),
                encoding="utf-8",
            )
            contract = hpaths.load_change_contract(change)
            ownership = LEDGER.ownership_hash(contract)
            capsule_root = change / "runtime" / "phase-context"
            capsule_root.mkdir(parents=True)
            for name, phase in (("run-abc.json", "run"), ("execute-def.json", "execute")):
                (capsule_root / name).write_text(
                    json.dumps({
                        "schemaVersion": 1,
                        "phase": phase,
                        "runId": f"{phase}-1",
                        "ownershipHash": ownership,
                        "createdAt": "2026-08-20T10:00:00+00:00",
                    }),
                    encoding="utf-8",
                )

            result = LEDGER.frozen_ownership_check(change)

            # 旧名与新名 capsule 都纳入冻结检查，不是 NOT_APPLICABLE。
            self.assertEqual(result["code"], "OWNERSHIP_FROZEN", result)

    def test_unknown_phase_is_rejected_with_the_legal_names(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            make_change(project, "change")

            result = CONTEXT.prepare_context(project, change="change", phase="rerun", executor="codex")

            self.assertFalse(result["ok"], result)
            self.assertEqual(result["code"], "PHASE_UNKNOWN")
            self.assertIn("execute", result["allowedPhases"])
            self.assertEqual(result["legacyAliases"], {"run": "execute", "test": "execute"})
            self.assertEqual(hpaths.classify_phase_name("run"), "workflow")
            self.assertEqual(hpaths.classify_phase_name("test"), "workflow")
            self.assertEqual(hpaths.classify_phase_name("sync"), "non_workflow")
            self.assertEqual(hpaths.classify_phase_name("teleport"), "unknown")

    def test_archive_folds_legacy_phase_events_into_execute(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            change = Path(tmp)
            events = [
                {"type": "phase.end", "phase": "run", "status": "FAIL", "id": "e1"},
                {"type": "phase.end", "phase": "test", "status": "OK", "id": "e2"},
            ]

            status = ARCHIVE._stage_status_from_sources(events, None, change)

            # 2026-10 起：服务端 CLI schema 2.3 要求 run/test 必需键，旧名事件
            # 在折叠进 execute 的同时按原名还原到 run/test 键上。
            self.assertEqual(status["run"], "FAIL")
            self.assertEqual(status["test"], "OK")
            # 按事件序后写胜：run 的 FAIL 先写、test 的 OK 后写。
            self.assertEqual(status["execute"], "OK")

            summary = {
                "phases": {
                    "run": {"duration_ms": 100, "event_count": 1},
                    "test": {"duration_ms": 200, "event_count": 2},
                }
            }
            folded = ARCHIVE._phases_from_events_summary(summary)
            self.assertNotIn("run", folded)
            self.assertNotIn("test", folded)
            self.assertEqual(folded["execute"]["event_count"], 3)
            self.assertEqual(folded["execute"]["duration_ms"], 200)


if __name__ == "__main__":
    unittest.main()
