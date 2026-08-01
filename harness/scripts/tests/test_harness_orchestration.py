import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "harness_orchestration.py"
if str(SCRIPT.parent) not in sys.path:
    sys.path.insert(0, str(SCRIPT.parent))


def load_module():
    spec = importlib.util.spec_from_file_location(
        "harness_orchestration_test", SCRIPT
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def valid_payload() -> dict:
    return {
        "changeId": "environment-verification-orchestration",
        "productIdentity": "sha256:product",
        "frozenIdentity": "sha256:product",
        "changedFiles": ["packages/ui/src/button.tsx"],
        "verificationGraphIdentity": "sha256:graph-2",
        "previousVerificationGraphIdentity": "sha256:graph-2",
        "previousEnvironmentIdentity": "sha256:environment",
        "environment": {
            "required": True,
            "mode": "change-session",
            "environmentHash": "sha256:environment",
            "contentFingerprint": "sha256:content",
            "lease": {
                "status": "ACTIVE",
                "changeId": "environment-verification-orchestration",
                "mode": "change-session",
                "environmentHash": "sha256:environment",
                "contentFingerprint": "sha256:content",
                "expiresAt": "2099-01-01T00:00:00+00:00",
                "ownerVerified": True,
            },
            "requiredFields": ["databaseIndex"],
            "resolvedFields": {"databaseIndex": "sha256:index"},
        },
        "commands": {
            "unit": {"argv": ["python", "-c", "print('unit')"]},
            "browser": {"argv": ["python", "-c", "print('browser')"]},
        },
        "availableCapabilities": ["python"],
        "targets": [
            {
                "id": "unit",
                "commandKey": "unit",
                "inputs": ["packages/ui/**"],
                "argvTemplate": ["python", "-c", "print('unit')"],
                "dependsOn": [],
                "resourceLocks": ["python:unit"],
            },
            {
                "id": "browser",
                "commandKey": "browser",
                "inputs": ["apps/web/**"],
                "argvTemplate": ["python", "-c", "print('browser')"],
                "dependsOn": ["unit"],
                "resourceLocks": ["browser:host"],
            },
        ],
    }


class OrchestrationTests(unittest.TestCase):
    def test_valid_plan_is_explainable_and_deterministic(self) -> None:
        module = load_module()
        first = module.build_orchestration_plan(valid_payload())
        second = module.build_orchestration_plan(valid_payload())
        self.assertTrue(first["ok"], first)
        self.assertEqual(first, second)
        self.assertEqual(first["environment"]["decision"], "READY")
        self.assertEqual(first["invalidations"][0]["reasonCode"], "PRODUCT_INPUT_CHANGED")
        self.assertTrue(all(item["explanation"] for item in first["verification"]["plan"]))

    def test_missing_command_blocks_target_and_dependents(self) -> None:
        module = load_module()
        payload = valid_payload()
        payload["commands"].pop("browser")
        result = module.build_orchestration_plan(payload)
        self.assertFalse(result["ok"])
        by_id = {item["id"]: item for item in result["verification"]["plan"]}
        self.assertEqual(by_id["browser"]["decision"], "BLOCKED")
        self.assertIn("COMMAND_NOT_DECLARED", by_id["browser"]["reasonCodes"])
        self.assertTrue(by_id["browser"]["explanation"])

    def test_identity_drift_emits_stable_invalidations(self) -> None:
        module = load_module()
        payload = valid_payload()
        payload["productIdentity"] = "sha256:changed"
        payload["previousVerificationGraphIdentity"] = "sha256:graph-1"
        payload["previousEnvironmentIdentity"] = "sha256:environment-old"
        payload["targets"][0]["requiresFrozenIdentity"] = True
        result = module.build_orchestration_plan(payload)
        codes = [item["reasonCode"] for item in result["invalidations"]]
        self.assertEqual(
            codes,
            [
                "ENVIRONMENT_IDENTITY_CHANGED",
                "FROZEN_IDENTITY_DRIFT",
                "PRODUCT_INPUT_CHANGED",
                "VERIFICATION_GRAPH_CHANGED",
            ],
        )
        self.assertFalse(result["ok"])

    def test_invalid_environment_contract_blocks_without_side_effect(self) -> None:
        module = load_module()
        payload = valid_payload()
        payload["environment"]["lease"]["contentFingerprint"] = "sha256:other"
        result = module.build_orchestration_plan(payload)
        self.assertFalse(result["ok"])
        self.assertEqual(result["environment"]["decision"], "BLOCKED")
        self.assertEqual(result["environment"]["reasonCode"], "ENVIRONMENT_CONTENT_IDENTITY_MISMATCH")

    def test_cli_plan_is_side_effect_free(self) -> None:
        module = load_module()
        with tempfile.TemporaryDirectory() as directory:
            input_path = Path(directory) / "input.json"
            input_path.write_text(json.dumps(valid_payload()), encoding="utf-8")
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = module.main(["plan", "--input", str(input_path), "--json"])
            self.assertEqual(code, 0)
            parsed = json.loads(output.getvalue())
            self.assertTrue(parsed["ok"], parsed)
            self.assertNotIn("provider", parsed)


if __name__ == "__main__":
    unittest.main()
