from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import unittest

from jsonschema import Draft202012Validator


ROOT = Path(__file__).resolve().parents[3]
HARNESS = ROOT / "harness"
EXECUTION_FIXTURES = HARNESS / "contracts" / "fixtures" / "managed-execution.json"
EXECUTION_SCHEMAS = {
    "process-identity": HARNESS / "contracts" / "process-identity.schema.json",
    "run-session": HARNESS / "contracts" / "run-session.schema.json",
    "service-session": HARNESS / "contracts" / "service-session.schema.json",
    "service-retirement-receipt": (
        HARNESS / "contracts" / "service-retirement-receipt.schema.json"
    ),
}


def _load_execution_contracts():
    script = HARNESS / "scripts" / "harness_execution_contracts.py"
    spec = importlib.util.spec_from_file_location("harness_execution_contracts_test", script)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class GlobalOptimizationContractTests(unittest.TestCase):
    def test_keeps_python_typescript_and_json_schema_execution_contracts_in_parity(
        self,
    ) -> None:
        fixtures_bytes = EXECUTION_FIXTURES.read_bytes()
        fixtures = json.loads(fixtures_bytes)
        contracts = _load_execution_contracts()

        self.assertEqual(fixtures["schemaVersion"], 1)
        self.assertEqual(
            fixtures["corpusHash"],
            "sha256:" + hashlib.sha256(
                json.dumps(
                    fixtures["fixtures"],
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ).encode("utf-8")
            ).hexdigest(),
        )
        seen: dict[str, set[bool]] = {
            contract: set() for contract in EXECUTION_SCHEMAS
        }
        for contract, path in EXECUTION_SCHEMAS.items():
            schema = json.loads(path.read_text(encoding="utf-8"))
            Draft202012Validator.check_schema(schema)
            validator = Draft202012Validator(schema)
            for fixture in (
                item for item in fixtures["fixtures"] if item["contract"] == contract
            ):
                expected = fixture["valid"]
                schema_accepts = not list(validator.iter_errors(fixture["payload"]))
                python_result = contracts.parse_execution_contract(
                    contract, fixture["payload"]
                )
                self.assertEqual(schema_accepts, expected, fixture["id"])
                self.assertEqual(python_result["ok"], expected, fixture["id"])
                seen[contract].add(expected)

        self.assertEqual(
            seen,
            {contract: {False, True} for contract in EXECUTION_SCHEMAS},
        )

    def test_run_terminal_invariants_are_machine_enforced(self) -> None:
        contracts = _load_execution_contracts()
        ok = contracts.parse_execution_contract(
            "run-session",
            {
                "schemaVersion": 1,
                "sessionId": "run-terminal-ok",
                "status": "OK",
                "reasonCode": "CHILD_EXIT_ZERO",
                "exitCode": 0,
                "processIdentity": None,
                "heartbeat": None,
                "logs": {
                    "stdout": {
                        "cursor": 0,
                        "rawDigest": "sha256:" + "a" * 64,
                        "decodeStatus": "OK",
                    },
                    "stderr": {
                        "cursor": 0,
                        "rawDigest": "sha256:" + "b" * 64,
                        "decodeStatus": "OK",
                    },
                },
                "cleanup": {"complete": True, "reasonCode": None},
                "resultDigest": "sha256:" + "c" * 64,
            },
        )
        incomplete_with_exit = {
            **ok["value"],
            "sessionId": "run-terminal-invalid",
            "status": "INCOMPLETE",
            "reasonCode": "HEARTBEAT_LOST",
            "exitCode": 9,
        }
        self.assertTrue(ok["ok"])
        self.assertFalse(
            contracts.parse_execution_contract(
                "run-session", incomplete_with_exit
            )["ok"]
        )

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
        self.assertTrue(
            {
                "resourceLocks",
                "estimatedDurationSeconds",
                "requiresFrozenIdentity",
                "reusePolicy",
            }
            <= set(target["properties"])
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
