#!/usr/bin/env python3
"""09-M4 知识查询门禁测试（plan 关门 fail-closed）。

覆盖阶段 09 文档锁定的测试矩阵：
- fast 档豁免并记录跳过原因；
- standard/full 档无收据 fail-closed；项目未绑定 fail-closed；
- 合法收据通过（0 命中同样满足——门禁查「执行并留证」不是「必须命中」）；
- 伪造/跨项目收据拒绝；查询失败留下失败收据并按配置放行或阻断；
- 第二次定向查询受预算约束（≤2 条，第二槽位须 directed_evidence_followup）；
- 降级配置 knowledgeGateMode=warn 把阻断降级为警告。
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_gate as gate  # noqa: E402
import harness_plan_finalize as hpf  # noqa: E402

REPO_ROOT = SCRIPTS_DIR.parent.parent
KNOWLEDGE_ENV = "HUNTER_HARNESS_KNOWLEDGE_GATE_MODE"


def _hex(seed: str) -> str:
    return (seed * 64)[:64]


def _payload(
    query_hex: str,
    project_id: str = "prj_demo",
    *,
    status: str = "succeeded",
    reason_code: str = "initial_intent",
    result_count: int = 1,
    receipt_hex: str | None = None,
) -> dict:
    receipt = {
        "schema_version": 1,
        "receipt_id": "knowledge_query_receipt:" + _hex(receipt_hex or "b"),
        "query_hash": "sha256:" + query_hex,
        "project_id": project_id,
        "index_generation": "gen-1",
        "result_ids": [f"res_{index}" for index in range(result_count)],
        "source_versions": ["v1"],
        "result_set_hash": "sha256:" + _hex("9"),
        "status": status,
        "executed_at": "2026-09-17T00:00:00Z",
        "reason_code": reason_code,
    }
    if status == "failed":
        receipt["failure_code"] = "http_error"
        receipt["result_ids"] = []
    return {
        "schema_version": 1,
        "command": "knowledge query",
        "ok": status == "succeeded",
        "exit_code": 0 if status == "succeeded" else 3,
        "source": "remote",
        "fallback": False,
        "project_id": project_id,
        "query_id": "knowledge_query:" + query_hex,
        "receipt": receipt,
        "query": "harness gate knowledge query",
        "count": result_count if status == "succeeded" else 0,
        "items": [],
        "request_id": "req_1",
    }


class KnowledgeGateCase(unittest.TestCase):
    """带 .harness/changes/demo 布局 + 项目绑定（prj_demo）的基座。"""

    def setUp(self) -> None:
        self._env = mock.patch.dict(os.environ, {}, clear=False)
        self._env.start()
        self.addCleanup(self._env.stop)
        os.environ.pop(KNOWLEDGE_ENV, None)
        self.project = Path(tempfile.mkdtemp(prefix="harness-kg-project-"))
        self.addCleanup(shutil.rmtree, self.project, True)
        self.change_dir = self.project / ".harness" / "changes" / "demo"
        self.change_dir.mkdir(parents=True)
        self._bind_project()

    def _bind_project(self) -> None:
        (self.project / ".harness" / "project.yaml").write_text(
            "project:\n  project_id: prj_demo\n", encoding="utf-8"
        )

    def _unbind_project(self) -> None:
        (self.project / ".harness" / "project.yaml").unlink(missing_ok=True)

    def _set_policy(self, **fields: object) -> None:
        policy = {"schemaVersion": 1, **fields}
        meta = self.change_dir / "meta"
        meta.mkdir(parents=True, exist_ok=True)
        (meta / "gate-policy.json").write_text(
            json.dumps(policy, indent=2) + "\n", encoding="utf-8"
        )

    def _write_anchor(self, queries: list[object]) -> Path:
        path = self.change_dir / "meta" / "knowledge-query-receipt.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"schema_version": 1, "queries": queries}, indent=2) + "\n",
            encoding="utf-8",
        )
        return path

    def _validate(self) -> dict:
        return hpf.validate_knowledge_query_gate(self.project, self.change_dir)


class KnowledgeGateModeTests(KnowledgeGateCase):
    def test_default_is_strict(self) -> None:
        self.assertEqual(hpf.knowledge_gate_mode(self.project, self.change_dir), "strict")

    def test_change_policy_warn(self) -> None:
        self._set_policy(knowledgeGateMode="warn")
        self.assertEqual(hpf.knowledge_gate_mode(self.project, self.change_dir), "warn")

    def test_project_config_warn(self) -> None:
        config = self.project / ".harness" / "config" / "gate-policy.json"
        config.parent.mkdir(parents=True, exist_ok=True)
        config.write_text('{"schemaVersion": 1, "knowledgeGateMode": "warn"}\n', encoding="utf-8")
        self.assertEqual(hpf.knowledge_gate_mode(self.project, self.change_dir), "warn")

    def test_change_beats_project(self) -> None:
        config = self.project / ".harness" / "config" / "gate-policy.json"
        config.parent.mkdir(parents=True, exist_ok=True)
        config.write_text('{"schemaVersion": 1, "knowledgeGateMode": "warn"}\n', encoding="utf-8")
        self._set_policy(knowledgeGateMode="strict")
        self.assertEqual(hpf.knowledge_gate_mode(self.project, self.change_dir), "strict")

    def test_env_beats_everything(self) -> None:
        self._set_policy(knowledgeGateMode="warn")
        os.environ[KNOWLEDGE_ENV] = "strict"
        self.assertEqual(hpf.knowledge_gate_mode(self.project, self.change_dir), "strict")

    def test_invalid_values_are_ignored(self) -> None:
        self._set_policy(knowledgeGateMode="lenient")
        self.assertEqual(hpf.knowledge_gate_mode(self.project, self.change_dir), "strict")
        os.environ[KNOWLEDGE_ENV] = "bogus"
        self.assertEqual(hpf.knowledge_gate_mode(self.project, self.change_dir), "strict")


class KnowledgeGateTierTests(KnowledgeGateCase):
    def test_no_policy_defaults_to_fast(self) -> None:
        self.assertEqual(hpf.knowledge_gate_tier(self.change_dir), "fast")

    def test_working_copy_tier(self) -> None:
        self._set_policy(tier="standard")
        self.assertEqual(hpf.knowledge_gate_tier(self.change_dir), "standard")

    def test_tier_is_case_insensitive(self) -> None:
        self._set_policy(tier="FULL")
        self.assertEqual(hpf.knowledge_gate_tier(self.change_dir), "full")

    def test_unknown_tier_defaults_to_fast(self) -> None:
        self._set_policy(tier="enterprise")
        self.assertEqual(hpf.knowledge_gate_tier(self.change_dir), "fast")

    def test_v2_plan_profile_tier_wins(self) -> None:
        wrapper = {
            "artifact_type": "gate_policy",
            "content": {
                "mode": "change",
                "tier": "full",
                "planned_phases": ["plan", "execute"],
                "required_gate_dag": {},
                "required_validations_by_phase": {},
            },
        }
        (self.change_dir / "meta").mkdir(parents=True, exist_ok=True)
        (self.change_dir / "meta" / "plan-profile.json").write_text(
            json.dumps(wrapper, indent=2) + "\n", encoding="utf-8"
        )
        self._set_policy(tier="standard")
        self.assertEqual(hpf.knowledge_gate_tier(self.change_dir), "full")


class RecordKnowledgeReceiptTests(KnowledgeGateCase):
    def test_records_first_query(self) -> None:
        result = hpf.record_knowledge_receipt(self.change_dir, _payload(_hex("a")))
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["code"], "KNOWLEDGE_RECEIPT_RECORDED")
        self.assertFalse(result["replaced"])
        anchor = json.loads(
            (self.change_dir / "meta" / "knowledge-query-receipt.json").read_text(encoding="utf-8")
        )
        self.assertEqual(anchor["schema_version"], 1)
        self.assertEqual(len(anchor["queries"]), 1)
        self.assertEqual(anchor["queries"][0]["query_id"], "knowledge_query:" + _hex("a"))

    def test_upsert_same_query_is_idempotent_replay(self) -> None:
        first = _payload(_hex("a"))
        self.assertTrue(hpf.record_knowledge_receipt(self.change_dir, first)["ok"])
        again = hpf.record_knowledge_receipt(self.change_dir, first)
        self.assertTrue(again["ok"], again)
        self.assertTrue(again["replaced"])
        self.assertEqual(again["queryCount"], 1)

    def test_second_query_must_be_directed_followup(self) -> None:
        self.assertTrue(hpf.record_knowledge_receipt(self.change_dir, _payload(_hex("a")))["ok"])
        rejected = hpf.record_knowledge_receipt(self.change_dir, _payload(_hex("b")))
        self.assertFalse(rejected["ok"])
        self.assertEqual(rejected["code"], "KNOWLEDGE_GATE_REASON_INVALID")
        followup = hpf.record_knowledge_receipt(
            self.change_dir,
            _payload(_hex("b"), reason_code="directed_evidence_followup"),
        )
        self.assertTrue(followup["ok"], followup)
        self.assertEqual(followup["queryCount"], 2)

    def test_failed_second_attempt_is_recordable_but_uses_a_slot(self) -> None:
        self.assertTrue(hpf.record_knowledge_receipt(self.change_dir, _payload(_hex("a")))["ok"])
        failed = hpf.record_knowledge_receipt(
            self.change_dir,
            _payload(
                _hex("b"),
                status="failed",
                reason_code="remote_knowledge_unavailable",
                result_count=0,
            ),
        )
        self.assertTrue(failed["ok"], failed)
        self.assertEqual(failed["queryCount"], 2)

    def test_budget_is_two_queries(self) -> None:
        self.assertTrue(hpf.record_knowledge_receipt(self.change_dir, _payload(_hex("a")))["ok"])
        self.assertTrue(
            hpf.record_knowledge_receipt(
                self.change_dir,
                _payload(_hex("b"), reason_code="directed_evidence_followup"),
            )["ok"]
        )
        third = hpf.record_knowledge_receipt(
            self.change_dir,
            _payload(_hex("c"), reason_code="directed_evidence_followup"),
        )
        self.assertFalse(third["ok"])
        self.assertEqual(third["code"], "KNOWLEDGE_GATE_BUDGET_EXCEEDED")

    def test_rejects_payload_without_receipt(self) -> None:
        forged = _payload(_hex("a"))
        forged.pop("receipt")
        result = hpf.record_knowledge_receipt(self.change_dir, forged)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "KNOWLEDGE_GATE_RECEIPT_INVALID")

    def test_rejects_cross_project_receipt(self) -> None:
        result = hpf.record_knowledge_receipt(
            self.change_dir, _payload(_hex("a"), project_id="prj_other")
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "KNOWLEDGE_GATE_PROJECT_MISMATCH")

    def test_rejects_identity_mismatch(self) -> None:
        forged = _payload(_hex("a"))
        forged["receipt"]["query_hash"] = "sha256:" + _hex("f")
        result = hpf.record_knowledge_receipt(self.change_dir, forged)
        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "KNOWLEDGE_GATE_IDENTITY_MISMATCH")

    def test_cli_records_from_payload_and_file(self) -> None:
        payload = _payload(_hex("a"))
        inline = hpf.main([
            "record-knowledge-receipt",
            "--change-dir", str(self.change_dir),
            "--payload", json.dumps(payload),
            "--json",
        ])
        self.assertEqual(inline, 0)
        payload_file = self.project / "query.json"
        payload_file.write_text(json.dumps(_payload(_hex("c"))) + "\n", encoding="utf-8")
        via_file = hpf.main([
            "record-knowledge-receipt",
            "--change-dir", str(self.change_dir),
            "--payload-file", str(payload_file),
            "--json",
        ])
        self.assertEqual(via_file, 1)  # 第二条不是定向追查 → 拒绝
        self.assertEqual(
            hpf.main([
                "record-knowledge-receipt",
                "--change-dir", str(self.change_dir),
                "--json",
            ]),
            1,
        )


class ValidateKnowledgeGateTests(KnowledgeGateCase):
    def test_fast_tier_is_exempt_with_recorded_skip_reason(self) -> None:
        verdict = self._validate()
        self.assertTrue(verdict["ok"], verdict)
        self.assertEqual(verdict["code"], "KNOWLEDGE_GATE_SKIPPED")
        self.assertTrue(verdict["skipped"])
        self.assertTrue(verdict["skipReason"])
        self.assertEqual(verdict["tier"], "fast")
        self.assertEqual(verdict["mode"], "strict")

    def test_standard_tier_without_receipt_fails_closed(self) -> None:
        self._set_policy(tier="standard")
        verdict = self._validate()
        self.assertFalse(verdict["ok"])
        self.assertEqual(verdict["code"], "KNOWLEDGE_GATE_RECEIPT_MISSING")

    def test_full_tier_without_receipt_fails_closed(self) -> None:
        self._set_policy(tier="full")
        verdict = self._validate()
        self.assertFalse(verdict["ok"])
        self.assertEqual(verdict["code"], "KNOWLEDGE_GATE_RECEIPT_MISSING")

    def test_unbound_project_fails_closed(self) -> None:
        self._set_policy(tier="standard")
        self._unbind_project()
        verdict = self._validate()
        self.assertFalse(verdict["ok"])
        self.assertEqual(verdict["code"], "KNOWLEDGE_GATE_PROJECT_UNBOUND")

    def test_valid_receipt_passes(self) -> None:
        self._set_policy(tier="standard")
        self.assertTrue(hpf.record_knowledge_receipt(self.change_dir, _payload(_hex("a")))["ok"])
        verdict = self._validate()
        self.assertTrue(verdict["ok"], verdict)
        self.assertEqual(verdict["code"], "KNOWLEDGE_GATE_OK")
        self.assertEqual(verdict["queryCount"], 1)
        self.assertEqual(verdict["receiptIds"], ["knowledge_query_receipt:" + _hex("b")])
        self.assertFalse(verdict["skipped"])

    def test_zero_hit_query_still_satisfies_the_gate(self) -> None:
        # 门禁查「执行并留证」不是「必须命中」：0 命中的成功收据同样放行。
        self._set_policy(tier="full")
        self.assertTrue(
            hpf.record_knowledge_receipt(
                self.change_dir, _payload(_hex("a"), result_count=0)
            )["ok"]
        )
        verdict = self._validate()
        self.assertTrue(verdict["ok"], verdict)
        self.assertEqual(verdict["resultCounts"], [0])

    def test_two_queries_with_directed_second_pass(self) -> None:
        self._set_policy(tier="standard")
        self.assertTrue(hpf.record_knowledge_receipt(self.change_dir, _payload(_hex("a")))["ok"])
        self.assertTrue(
            hpf.record_knowledge_receipt(
                self.change_dir,
                _payload(_hex("b"), reason_code="directed_evidence_followup"),
            )["ok"]
        )
        verdict = self._validate()
        self.assertTrue(verdict["ok"], verdict)
        self.assertEqual(verdict["queryCount"], 2)
        self.assertEqual(
            verdict["reasonCodes"], ["initial_intent", "directed_evidence_followup"]
        )

    def test_second_query_without_directed_reason_is_rejected(self) -> None:
        self._set_policy(tier="standard")
        self._write_anchor([_payload(_hex("a")), _payload(_hex("b"))])
        verdict = self._validate()
        self.assertFalse(verdict["ok"])
        self.assertEqual(verdict["code"], "KNOWLEDGE_GATE_REASON_INVALID")

    def test_more_than_two_queries_is_rejected(self) -> None:
        self._set_policy(tier="standard")
        self._write_anchor([
            _payload(_hex("a")),
            _payload(_hex("b"), reason_code="directed_evidence_followup"),
            _payload(_hex("c"), reason_code="directed_evidence_followup"),
        ])
        verdict = self._validate()
        self.assertFalse(verdict["ok"])
        self.assertEqual(verdict["code"], "KNOWLEDGE_GATE_BUDGET_EXCEEDED")

    def test_forged_identity_is_rejected(self) -> None:
        self._set_policy(tier="standard")
        forged = _payload(_hex("a"))
        forged["receipt"]["query_hash"] = "sha256:" + _hex("f")
        self._write_anchor([forged])
        verdict = self._validate()
        self.assertFalse(verdict["ok"])
        self.assertEqual(verdict["code"], "KNOWLEDGE_GATE_IDENTITY_MISMATCH")

    def test_cross_project_receipt_is_rejected(self) -> None:
        self._set_policy(tier="standard")
        self._write_anchor([_payload(_hex("a"), project_id="prj_other")])
        verdict = self._validate()
        self.assertFalse(verdict["ok"])
        self.assertEqual(verdict["code"], "KNOWLEDGE_GATE_PROJECT_MISMATCH")

    def test_malformed_anchor_is_rejected(self) -> None:
        self._set_policy(tier="standard")
        path = self.change_dir / "meta" / "knowledge-query-receipt.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{not json\n", encoding="utf-8")
        verdict = self._validate()
        self.assertFalse(verdict["ok"])
        self.assertEqual(verdict["code"], "KNOWLEDGE_GATE_RECEIPT_INVALID")

    def test_empty_anchor_is_treated_as_missing(self) -> None:
        self._set_policy(tier="standard")
        self._write_anchor([])
        verdict = self._validate()
        self.assertFalse(verdict["ok"])
        self.assertEqual(verdict["code"], "KNOWLEDGE_GATE_RECEIPT_MISSING")

    def test_all_queries_failed_blocks_in_strict_mode(self) -> None:
        self._set_policy(tier="standard")
        self.assertTrue(
            hpf.record_knowledge_receipt(
                self.change_dir,
                _payload(
                    _hex("a"),
                    status="failed",
                    reason_code="remote_knowledge_unavailable",
                    result_count=0,
                ),
            )["ok"]
        )
        verdict = self._validate()
        self.assertFalse(verdict["ok"])
        self.assertEqual(verdict["code"], "KNOWLEDGE_GATE_QUERY_FAILED")

    def test_mixed_failure_and_success_passes(self) -> None:
        # 失败收据 + 成功收据 = 查询恢复后成功，不构成「全部失败」。
        self._set_policy(tier="standard")
        self._write_anchor([
            _payload(
                _hex("a"),
                status="failed",
                reason_code="remote_knowledge_unavailable",
                result_count=0,
            ),
            _payload(_hex("b"), reason_code="directed_evidence_followup"),
        ])
        verdict = self._validate()
        self.assertTrue(verdict["ok"], verdict)
        self.assertEqual(verdict["failedCount"], 1)


class VerifyPlanKnowledgeGateTests(KnowledgeGateCase):
    def test_failed_verify_result_is_not_decorated(self) -> None:
        result = hpf._with_knowledge_gate_verdict(
            self.change_dir, {"ok": False, "code": "RECEIPT_MISSING"}
        )
        self.assertNotIn("knowledgeGate", result)

    def test_fast_change_reports_skipped_verdict(self) -> None:
        result = hpf._with_knowledge_gate_verdict(self.change_dir, {"ok": True})
        self.assertTrue(result["ok"])
        self.assertEqual(result["knowledgeGate"]["code"], "KNOWLEDGE_GATE_SKIPPED")

    def test_standard_change_without_receipt_keeps_ok_but_reports_failure(self) -> None:
        # verify 是只读交接路径：判定事实挂在 knowledgeGate 上，不翻转 ok；
        # 阻断点只有 plan 关门门禁。
        self._set_policy(tier="standard")
        result = hpf._with_knowledge_gate_verdict(self.change_dir, {"ok": True})
        self.assertTrue(result["ok"])
        self.assertFalse(result["knowledgeGate"]["ok"])
        self.assertEqual(
            result["knowledgeGate"]["code"], "KNOWLEDGE_GATE_RECEIPT_MISSING"
        )

    def test_standard_change_with_receipt_reports_ok(self) -> None:
        self._set_policy(tier="standard")
        self.assertTrue(hpf.record_knowledge_receipt(self.change_dir, _payload(_hex("a")))["ok"])
        result = hpf._with_knowledge_gate_verdict(self.change_dir, {"ok": True})
        self.assertTrue(result["knowledgeGate"]["ok"])

    def test_verify_cli_on_unfinalized_change_fails_without_gate_fields(self) -> None:
        code = hpf.main(["verify", "--change-dir", str(self.change_dir), "--json"])
        self.assertEqual(code, 1)


class PlanCloseKnowledgeGateTests(unittest.TestCase):
    """harness_gate close --phase plan 的端到端接线测试。"""

    def setUp(self) -> None:
        self._env = mock.patch.dict(os.environ, {}, clear=False)
        self._env.start()
        self.addCleanup(self._env.stop)
        os.environ.pop(KNOWLEDGE_ENV, None)
        self.project = Path(tempfile.mkdtemp(prefix="harness-kg-close-"))
        self.addCleanup(shutil.rmtree, self.project, True)
        self.change_dir = self.project / ".harness" / "changes" / "demo"
        self.change_dir.mkdir(parents=True)
        (self.project / ".harness" / "project.yaml").write_text(
            "project:\n  project_id: prj_demo\n", encoding="utf-8"
        )
        self._write_checkpoints("approved")
        policy_target = self.project / "harness" / "contracts" / "workflow-policy.json"
        policy_target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(
            REPO_ROOT / "harness" / "contracts" / "workflow-policy.json", policy_target
        )
        subprocess.run(["git", "init"], cwd=self.project, check=True, capture_output=True)
        subprocess.run(
            ["git", "config", "user.email", "test@example.com"],
            cwd=self.project, check=True, capture_output=True,
        )
        subprocess.run(
            ["git", "config", "user.name", "Test"],
            cwd=self.project, check=True, capture_output=True,
        )
        (self.project / "README.md").write_text("demo\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=self.project, check=True, capture_output=True)
        subprocess.run(
            ["git", "commit", "-m", "init"], cwd=self.project, check=True, capture_output=True
        )

    def _write_checkpoints(self, status: str) -> None:
        payload = {
            "schemaVersion": 1,
            "changeName": "demo",
            "checkpoints": [
                {
                    "id": "foundation-gate",
                    "afterTasks": [1, 2, 3, 4],
                    "beforeTasks": [6, 7, 8, 9, 10],
                    "status": status,
                    "blocking": True,
                    "reviewerTool": "codex",
                    "requiredReport": "reports/review/foundation-gate-review.md",
                }
            ],
        }
        path = self.change_dir / "meta" / "implementation-checkpoints.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    def _set_policy(self, **fields: object) -> None:
        policy = {"schemaVersion": 1, **fields}
        (self.change_dir / "meta" / "gate-policy.json").write_text(
            json.dumps(policy, indent=2) + "\n", encoding="utf-8"
        )

    def _close_args(self) -> object:
        return gate.build_parser().parse_args([
            "close", "--phase", "plan", "--change", "demo", "--run-id", "run-1",
            "--status", "OK", "--json",
        ])

    def _run_close(self, args: object) -> tuple[int, dict | None, str]:
        resolved = {"ok": True, "changeId": "demo", "changeDir": str(self.change_dir)}
        out, err = io.StringIO(), io.StringIO()
        self.last_blocked: list[dict] = []
        with mock.patch.object(gate.hc, "resolve_main_project_root", return_value=self.project), \
             mock.patch.object(gate.hc, "resolve_change", return_value=resolved), \
             mock.patch.object(gate.hc, "inspect_lease", return_value={"runId": "run-1", "phase": "plan"}), \
             mock.patch.object(gate.hc, "release_lease", return_value={"ok": True}), \
             mock.patch.object(gate, "validate_ledger_for_phase_close", return_value={"ok": True, "code": "LEDGER_OK"}), \
             mock.patch.object(gate, "_phase_event_exists", return_value=False), \
             mock.patch.object(gate, "append_phase_event", return_value={"ok": True}), \
             mock.patch.object(
                 gate,
                 "record_gate_blocked",
                 side_effect=lambda *a, **k: (self.last_blocked.append(k) or {"ok": True}),
             ), \
             contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = gate.cmd_close(args)
        payload = None
        if out.getvalue().strip():
            payload = json.loads(out.getvalue())
        return code, payload, err.getvalue()

    def test_standard_tier_without_receipt_blocks_close(self) -> None:
        self._set_policy(tier="standard")
        code, payload, err = self._run_close(self._close_args())
        self.assertEqual(code, 1)
        self.assertIsNone(payload)
        failure = json.loads(err.strip().splitlines()[-1])
        self.assertEqual(failure["code"], "KNOWLEDGE_GATE_RECEIPT_MISSING")
        self.assertEqual(len(self.last_blocked), 1)
        self.assertEqual(self.last_blocked[0]["code"], "KNOWLEDGE_GATE_RECEIPT_MISSING")
        self.assertEqual(self.last_blocked[0]["phase"], "plan")

    def test_warn_mode_downgrades_to_gate_warning(self) -> None:
        self._set_policy(tier="standard", knowledgeGateMode="warn")
        warnings: list[dict] = []
        real_record = gate.record_gate_warning
        with mock.patch.object(
            gate,
            "record_gate_warning",
            side_effect=lambda *a, **k: (warnings.append(k) or real_record(*a, **k)),
        ):
            code, payload, _ = self._run_close(self._close_args())
        self.assertEqual(code, 0)
        self.assertEqual(len(warnings), 1)
        self.assertEqual(warnings[0]["site"], "knowledge-gate")
        self.assertEqual(warnings[0]["code"], "KNOWLEDGE_GATE_RECEIPT_MISSING")
        self.assertIsNotNone(payload)
        self.assertEqual(payload["knowledgeGate"]["mode"], "warn")
        self.assertFalse(payload["knowledgeGate"]["ok"])

    def test_fast_tier_close_records_skip_reason(self) -> None:
        code, payload, _ = self._run_close(self._close_args())
        self.assertEqual(code, 0)
        self.assertIsNotNone(payload)
        self.assertTrue(payload["knowledgeGate"]["ok"])
        self.assertTrue(payload["knowledgeGate"]["skipped"])
        self.assertTrue(payload["knowledgeGate"]["skipReason"])

    def test_standard_tier_with_valid_receipt_closes(self) -> None:
        self._set_policy(tier="standard")
        self.assertTrue(hpf.record_knowledge_receipt(self.change_dir, _payload(_hex("a")))["ok"])
        code, payload, _ = self._run_close(self._close_args())
        self.assertEqual(code, 0)
        self.assertIsNotNone(payload)
        self.assertTrue(payload["knowledgeGate"]["ok"])
        self.assertEqual(payload["knowledgeGate"]["queryCount"], 1)

    def test_all_failed_queries_block_close_in_strict_mode(self) -> None:
        self._set_policy(tier="standard")
        self.assertTrue(
            hpf.record_knowledge_receipt(
                self.change_dir,
                _payload(
                    _hex("a"),
                    status="failed",
                    reason_code="remote_knowledge_unavailable",
                    result_count=0,
                ),
            )["ok"]
        )
        code, _, err = self._run_close(self._close_args())
        self.assertEqual(code, 1)
        self.assertIn("KNOWLEDGE_GATE_QUERY_FAILED", err)


if __name__ == "__main__":
    unittest.main()
