from __future__ import annotations

import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[3]
HARNESS = ROOT / "harness"


class GlobalOptimizationContractTests(unittest.TestCase):
    def test_build_profile_v3_contract_declares_dynamic_verification_graph(self) -> None:
        schema = json.loads(
            (HARNESS / "contracts" / "build-profile-v3.schema.json").read_text(
                encoding="utf-8"
            )
        )

        self.assertEqual(schema["properties"]["schemaVersion"]["const"], 3)
        graph = schema["properties"]["verificationGraph"]
        self.assertIn("candidateTarget", graph["required"])
        target = graph["properties"]["targets"]["additionalProperties"]
        self.assertEqual(
            set(target["required"]),
            {
                "commandKey",
                "dependsOn",
                "requiredCoverage",
                "candidate",
                "requiredCapabilities",
            },
        )

    def test_external_platform_contract_separates_state_freshness_and_retry(self) -> None:
        schema = json.loads(
            (HARNESS / "contracts" / "external-platform-observation.schema.json").read_text(
                encoding="utf-8"
            )
        )
        required = set(schema["required"])
        self.assertTrue(
            {
                "subjectIdentity",
                "businessState",
                "observationState",
                "freshness",
                "retryable",
                "reasonCode",
                "observedAt",
            }
            <= required
        )

    def test_doctor_contract_uses_typed_capability_status_and_reason_codes(self) -> None:
        schema = json.loads(
            (HARNESS / "contracts" / "doctor-capability.schema.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(
            schema["properties"]["status"]["enum"],
            ["AVAILABLE", "UNAVAILABLE", "DEGRADED", "UNKNOWN"],
        )
        self.assertIn("reasonCode", schema["required"])
        self.assertIn("evidence", schema["required"])

    def test_protocols_forbid_unverified_success_and_capability_bypass(self) -> None:
        external = (
            HARNESS / "protocols" / "external-platform-protocol.md"
        ).read_text(encoding="utf-8")
        verification = (
            HARNESS / "protocols" / "verification-graph-protocol.md"
        ).read_text(encoding="utf-8")
        registry = (
            HARNESS / "protocols" / "registry-governance-protocol.md"
        ).read_text(encoding="utf-8")
        ci = (HARNESS / "protocols" / "ci-layering-protocol.md").read_text(
            encoding="utf-8"
        )
        memory = (
            HARNESS / "protocols" / "memory-closeout-protocol.md"
        ).read_text(encoding="utf-8")

        self.assertIn("权威终态", external)
        self.assertIn("subjectIdentity", external)
        self.assertIn("仅重试 retryable", external)
        self.assertIn("Build Profile v3", verification)
        self.assertIn("requiredCapabilities", verification)
        self.assertIn("缺失能力不得静默跳过", verification)
        self.assertIn("构建前容量预检", registry)
        self.assertIn("共享 digest", registry)
        self.assertIn("dry-run", registry)
        self.assertIn("fast", ci)
        self.assertIn("candidate", ci)
        self.assertIn("evidence-only", ci)
        self.assertIn("release", ci)
        self.assertIn("canonical state", memory)
        self.assertIn("supersede", memory)
        self.assertIn("TTL", memory)


if __name__ == "__main__":
    unittest.main()
