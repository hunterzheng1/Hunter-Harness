from __future__ import annotations

import json
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]


class HarnessPlanPerformanceContractTests(unittest.TestCase):
    def test_scenario_contract_requires_execution_cost_fields(self) -> None:
        reference = (
            REPO_ROOT / "harness" / "harness-plan" / "reference.md"
        ).read_text(encoding="utf-8")
        skill = (
            REPO_ROOT / "harness" / "harness-plan" / "SKILL.md"
        ).read_text(encoding="utf-8")

        for token in (
            "执行层级",
            "预计时长",
            "资源预算",
            "可复用证据",
            "超时",
        ):
            self.assertIn(token, reference)
        self.assertIn("测试执行成本", skill)
        self.assertIn("快速反馈", skill)


class RootCheckScriptTests(unittest.TestCase):
    def test_check_does_not_compile_typescript_twice(self) -> None:
        package = json.loads(
            (REPO_ROOT / "package.json").read_text(encoding="utf-8")
        )
        scripts = package["scripts"]

        self.assertIn("tsc -b", scripts["build"])
        self.assertIn("build:artifacts", scripts)
        self.assertIn("npm run build:artifacts", scripts["check"])
        check_steps = [item.strip() for item in scripts["check"].split("&&")]
        self.assertNotIn("npm run build", check_steps)

    def test_default_test_command_caps_worker_concurrency(self) -> None:
        package = json.loads(
            (REPO_ROOT / "package.json").read_text(encoding="utf-8")
        )

        self.assertIn("--maxWorkers=2", package["scripts"]["test"])

    def test_web_build_caps_static_generation_concurrency(self) -> None:
        config = (
            REPO_ROOT / "apps" / "web" / "next.config.ts"
        ).read_text(encoding="utf-8")

        self.assertIn("cpus: 2", config)
        self.assertIn("staticGenerationMaxConcurrency: 2", config)

    def test_pack_smoke_uses_isolated_npm_cache(self) -> None:
        smoke = (
            REPO_ROOT / "scripts" / "smoke-pack.mjs"
        ).read_text(encoding="utf-8")

        self.assertIn("npm_config_cache:", smoke)
        self.assertIn('join(rootDir, ".cache", "npm-smoke")', smoke)


if __name__ == "__main__":
    unittest.main()
