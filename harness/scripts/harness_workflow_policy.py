#!/usr/bin/env python3
"""Strict loader for harness/contracts/workflow-policy.json.

Unknown fields at any depth fail validation. Python 3.10+, stdlib only.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

POLICY_REL = Path("harness") / "contracts" / "workflow-policy.json"

TOP_LEVEL_KEYS = frozenset(
    {
        "schemaVersion",
        "riskTiers",
        "skills",
        "requiredArtifacts",
        "requiredValidations",
        "validationPhases",
        "capabilityGates",
        "conditionalStages",
        "interactionWhitelist",
        "checkpointRules",
    }
)

RISK_TIER_KEYS = frozenset(
    {
        "description",
        "defaultPhases",
        "requiredValidations",
        "conditionalStages",
        "upgradeTriggers",
    }
)

SKILL_KEYS = frozenset(
    {
        "phase",
        "inputs",
        "artifacts",
        "events",
        "allowedInteractions",
        "capabilities",
        "profiles",
    }
)

CONDITIONAL_STAGE_KEYS = frozenset({"tiers", "signals"})
CAPABILITY_GATE_KEYS = frozenset(
    {"signals", "requiredStages", "requiredValidations"}
)
CHECKPOINT_RULE_KEYS = frozenset(
    {
        "afterTasks",
        "beforeTasks",
        "blocking",
        "requiredReport",
        "reviewerTool",
    }
)


class PolicyValidationError(ValueError):
    """Raised when workflow-policy.json contains unknown or invalid fields."""


def _reject_unknown(data: dict[str, Any], allowed: frozenset[str], path: str) -> None:
    unknown = sorted(set(data) - allowed)
    if unknown:
        raise PolicyValidationError(
            f"unknown field(s) at {path}: {', '.join(unknown)}"
        )


def _require_type(value: Any, expected: type | tuple[type, ...], path: str) -> None:
    if not isinstance(value, expected):
        names = (
            expected.__name__
            if isinstance(expected, type)
            else "|".join(t.__name__ for t in expected)
        )
        raise PolicyValidationError(f"{path} must be {names}, got {type(value).__name__}")


def validate_policy(data: Any) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise PolicyValidationError("workflow policy root must be an object")
    _reject_unknown(data, TOP_LEVEL_KEYS, "root")
    _require_type(data.get("schemaVersion"), int, "schemaVersion")
    if data["schemaVersion"] != 1:
        raise PolicyValidationError("unsupported schemaVersion")

    risk_tiers = data["riskTiers"]
    _require_type(risk_tiers, dict, "riskTiers")
    for tier_name, tier in risk_tiers.items():
        path = f"riskTiers.{tier_name}"
        _require_type(tier, dict, path)
        _reject_unknown(tier, RISK_TIER_KEYS, path)
        _require_type(tier["description"], str, f"{path}.description")
        _require_type(tier["defaultPhases"], list, f"{path}.defaultPhases")
        _require_type(tier["requiredValidations"], list, f"{path}.requiredValidations")
        _require_type(tier["conditionalStages"], list, f"{path}.conditionalStages")
        _require_type(tier["upgradeTriggers"], list, f"{path}.upgradeTriggers")

    skills = data["skills"]
    _require_type(skills, dict, "skills")
    for skill_name, skill in skills.items():
        path = f"skills.{skill_name}"
        _require_type(skill, dict, path)
        _reject_unknown(skill, SKILL_KEYS, path)
        _require_type(skill["phase"], str, f"{path}.phase")
        for key in ("inputs", "artifacts", "events", "allowedInteractions", "capabilities"):
            _require_type(skill[key], list, f"{path}.{key}")
        profiles = skill.get("profiles", ["general", "java"])
        _require_type(profiles, list, f"{path}.profiles")
        if not profiles or any(item not in {"general", "java"} for item in profiles):
            raise PolicyValidationError(f"{path}.profiles must contain general and/or java")

    for section in ("requiredArtifacts", "requiredValidations"):
        section_data = data[section]
        _require_type(section_data, dict, section)
        for phase, items in section_data.items():
            _require_type(items, list, f"{section}.{phase}")

    validation_phases = data["validationPhases"]
    _require_type(validation_phases, dict, "validationPhases")
    for verification, phase in validation_phases.items():
        _require_type(phase, str, f"validationPhases.{verification}")

    capability_gates = data["capabilityGates"]
    _require_type(capability_gates, dict, "capabilityGates")
    for capability, gate in capability_gates.items():
        path = f"capabilityGates.{capability}"
        _require_type(gate, dict, path)
        _reject_unknown(gate, CAPABILITY_GATE_KEYS, path)
        for key in CAPABILITY_GATE_KEYS:
            _require_type(gate[key], list, f"{path}.{key}")

    conditional = data["conditionalStages"]
    _require_type(conditional, dict, "conditionalStages")
    for stage_name, stage in conditional.items():
        path = f"conditionalStages.{stage_name}"
        _require_type(stage, dict, path)
        _reject_unknown(stage, CONDITIONAL_STAGE_KEYS, path)
        _require_type(stage["tiers"], list, f"{path}.tiers")
        _require_type(stage["signals"], list, f"{path}.signals")

    interaction = data["interactionWhitelist"]
    _require_type(interaction, dict, "interactionWhitelist")
    for key, items in interaction.items():
        _require_type(items, list, f"interactionWhitelist.{key}")

    checkpoints = data["checkpointRules"]
    _require_type(checkpoints, dict, "checkpointRules")
    for checkpoint_id, rule in checkpoints.items():
        path = f"checkpointRules.{checkpoint_id}"
        _require_type(rule, dict, path)
        _reject_unknown(rule, CHECKPOINT_RULE_KEYS, path)
        _require_type(rule["afterTasks"], list, f"{path}.afterTasks")
        _require_type(rule["beforeTasks"], list, f"{path}.beforeTasks")
        _require_type(rule["blocking"], bool, f"{path}.blocking")

    return data


def policy_path_for_repo(repo_root: Path) -> Path:
    return repo_root / POLICY_REL


def load_policy(repo_root: Path) -> dict[str, Any]:
    path = policy_path_for_repo(repo_root)
    if not path.is_file():
        raise FileNotFoundError(f"workflow policy missing: {path}")
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    return validate_policy(data)
