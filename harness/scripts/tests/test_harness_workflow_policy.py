#!/usr/bin/env python3
"""Tests for strict workflow-policy loader."""

from __future__ import annotations

import importlib.util
import json
import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = SCRIPTS_DIR.parents[1]


def load_module():
    path = SCRIPTS_DIR / "harness_workflow_policy.py"
    spec = importlib.util.spec_from_file_location("harness_workflow_policy", path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules["harness_workflow_policy"] = mod
    spec.loader.exec_module(mod)
    return mod


policy = load_module()


class WorkflowPolicyTests(unittest.TestCase):
    def test_load_canonical_policy(self) -> None:
        loaded = policy.load_policy(REPO_ROOT)
        self.assertEqual(loaded["schemaVersion"], 1)
        self.assertIn("foundation-gate", loaded["checkpointRules"])
        self.assertIn("harness-plan", loaded["skills"])

    def test_unknown_nested_field_fails(self) -> None:
        raw = json.loads((REPO_ROOT / policy.POLICY_REL).read_text(encoding="utf-8"))
        raw["skills"]["harness-plan"]["forbidden"] = True
        with self.assertRaises(policy.PolicyValidationError):
            policy.validate_policy(raw)


if __name__ == "__main__":
    unittest.main()
