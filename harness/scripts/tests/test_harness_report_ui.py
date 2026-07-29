import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
RENDERER = ROOT / "harness-archive/templates/render-summary.mjs"
ARCHIVE_SCRIPT = ROOT / "scripts/harness_archive.py"
SPEC = importlib.util.spec_from_file_location("harness_archive_ui_test", ARCHIVE_SCRIPT)
assert SPEC is not None and SPEC.loader is not None
ARCHIVE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ARCHIVE)


def record_only_summary() -> dict:
    return {
        "schemaVersion": "2.3",
        "changeName": "executive-report-fixture",
        "businessGoal": "让管理者先看到结论，再按需展开技术证据。",
        "finalStatus": "CONDITIONAL_OK",
        "finalStatusReasons": ["浏览器验证完成，存在一个已接受风险"],
        "archiveIntent": "record-only",
        "productCommit": "a" * 40,
        "diffStat": {"filesChanged": 7, "insertions": 120, "deletions": 18},
        "knownRisks": [{"message": "Geo 缓存回源延迟仍需观察"}],
        "manualActions": ["下个工作日复核监控"],
        "changedFiles": [
            {"path": "apps/web/report.tsx", "insertions": 80, "deletions": 10}
        ],
        "reportPipeline": {
            "commands": [{"phase": "test", "command": "npm run check", "exit_code": 0}]
        },
        "normalizedReport": {
            "schemaVersion": 1,
            "identity": {"productCommit": "a" * 40},
            "outcomes": {
                "current": {
                    "status": "CONDITIONAL_OK",
                    "reasons": ["浏览器验证完成，存在一个已接受风险"],
                    "stages": {"run": "OK", "test": "OK", "review": "ADVISORY"},
                    "findings": [
                        {
                            "severity": "YELLOW",
                            "title": "Geo 缓存回源延迟仍需观察",
                            "disposition": "ACCEPTED_RISK",
                        }
                    ],
                    "knownRisks": [{"message": "Geo 缓存回源延迟仍需观察"}],
                },
                "history": {"timeline": [], "attempts": []},
                "release": {
                    "decision": "NOT_REQUESTED",
                    "eligible": False,
                    "candidate": {"ok": False, "code": "CANDIDATE_NOT_RUN"},
                    "intent": "record-only",
                },
            },
            "verification": {
                "unitTests": {
                    "status": "OK",
                    "run": 155,
                    "failures": 0,
                    "passRate": "155/155",
                },
                "apiTests": {
                    "status": "OK",
                    "total": 3,
                    "passed": 3,
                    "passRate": "3/3",
                },
                "browserE2E": {
                    "status": "OK",
                    "total": 5,
                    "passed": 5,
                },
                "frontend": {"status": "OK", "checks": 4},
                "geo": {"status": "WARN", "checks": 2},
            },
            "timing": {
                "workflowWallClockMs": 540000,
                "stageActiveExecutionMs": 310000,
                "externalWaitMs": 120000,
                "pausedMs": 30000,
                "agentOrToolUnattributedMs": 80000,
                "conservationDeltaMs": 0,
            },
            "measurements": {
                "remoteCost": {
                    "runnerMinutes": {"state": "unknown", "value": None}
                },
                "artifactStorage": {
                    "bytesAdded": {"state": "zero", "value": 0}
                },
            },
        },
    }


class ReportUiTest(unittest.TestCase):
    def render_node(self, summary: dict) -> str:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "summary.json"
            output = Path(tmp) / "summary.html"
            source.write_text(json.dumps(summary, ensure_ascii=False), encoding="utf-8")
            subprocess.run(
                ["node", str(RENDERER), "--summary", str(source), "--out", str(output)],
                check=True,
            )
            return output.read_text(encoding="utf-8")

    def assert_executive_contract(self, html: str) -> None:
        for text in (
            "管理结论",
            "产品提交",
            "验证概览",
            "风险与动作",
            "全流程耗时",
            "后端",
            "Geo",
            "前端",
            "浏览器",
            "API",
            "技术证据",
        ):
            self.assertIn(text, html)
        self.assertNotIn("Candidate Claim / Attestation", html)
        self.assertNotIn("Release Eligibility", html)
        self.assertNotIn("候选证明", html)
        self.assertNotIn("发布资格", html)
        self.assertIn("未请求发布", html)
        self.assertIn("N/A", html)
        self.assertIn("@media(max-width:600px)", html)
        self.assertIn("prefers-color-scheme:dark", html)
        self.assertIn("overflow-x:hidden", html)

    def test_record_only_node_report_is_executive_chinese_and_responsive(self) -> None:
        self.assert_executive_contract(self.render_node(record_only_summary()))

    def test_python_fallback_has_same_record_only_information_architecture(self) -> None:
        self.assert_executive_contract(
            ARCHIVE.render_fallback_html(record_only_summary())
        )

    def test_not_applicable_verification_is_not_rendered_as_not_run(self) -> None:
        summary = record_only_summary()
        summary["normalizedReport"]["verification"]["geo"] = {
            "status": "NOT_APPLICABLE",
            "checks": 0,
        }
        for html in (
            self.render_node(summary),
            ARCHIVE.render_fallback_html(summary),
        ):
            self.assertIn('title="NOT_APPLICABLE">不适用', html)


if __name__ == "__main__":
    unittest.main()
