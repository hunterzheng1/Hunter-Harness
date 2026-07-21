#!/usr/bin/env python3
"""Harness preflight: build-profile detect/check + quirk recording + agent precheck.

变更簇 4：detect/check 委托 ``harness_profile``（profile v2 公共内核），不再保留
v1 重复探测逻辑与 ``buildCommands`` 扁平字符串。record-quirk 适配 v2 ``commands``
结构：``fix-command`` 写 ``source=user`` override（spec §3.1 显式保留），跨 detect
保留；``skip-not-block`` 仍写 ``knownPreexistingErrors``。check-agents 与 pitfalls
附录为本 skill 独有，保留。

Implements DESIGN.md D5 (build-profile) and D8 (subagent precheck).
Python 3.10+ stdlib only. UTF-8 without BOM. Windows path friendly.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import shlex
import sys
from pathlib import Path
from typing import Any


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


import harness_change as hc  # noqa: E402
import harness_profile as hprof  # noqa: E402


PITFALLS_REL = Path(".harness") / "pitfalls.md"
PITFALLS_APPENDIX_HEADER = "## Preflight 附录（自动追加）"

VALID_QUIRK_ACTIONS = {"skip-not-block", "fix-command"}

_DETECT_HINT = "python harness_preflight.py detect --project <root> --json"


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def emit_json(payload: dict[str, Any], *, ok: bool = True) -> int:
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if ok else 1


# ---------------------------------------------------------------------------
# detect / check — 委托 harness_profile（profile v2 公共内核）
# ---------------------------------------------------------------------------

def cmd_detect(project: Path) -> dict[str, Any]:
    """Full probe and write build-profile.json (v2). 委托 hprof.detect。"""
    return hprof.detect(project)


def cmd_check(project: Path) -> dict[str, Any]:
    """Fast stale check (missing/invalid/stale/ready). 委托 hprof.check。

    兼容：stale 时补 ``hint``（skill canonical 读 hint 引导重新 detect）。
    """
    result = hprof.check(project)
    if result.get("stale") and "hint" not in result:
        result["hint"] = _DETECT_HINT
    return result


def check_concurrency(project: Path) -> dict[str, Any]:
    """Report the configured concurrency mode and active Change landscape.

    Retro §5.2: preflight must surface concurrencyMode, activeChanges, and
    allowedParallelLevels so agents don't have to guess whether parallel
    Changes are supported.
    """
    mode = hc.read_concurrency_mode(project)
    active = hc.list_active_changes(project)
    shared_conflicts: list[dict[str, Any]] = []
    # In isolated-multi-active, surface any shared-state conflicts (e.g. same
    # worktree path) so callers know isolation is incomplete.
    if mode == "isolated-multi-active" and len(active) > 1:
        seen_worktrees: dict[str, str] = {}
        for entry in active:
            change_dir = Path(entry["path"])
            worktree_meta = change_dir / "meta" / "worktree.json"
            if not worktree_meta.is_file():
                continue
            try:
                meta = json.loads(worktree_meta.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            wt = meta.get("path") if isinstance(meta, dict) else None
            if isinstance(wt, str) and wt:
                if wt in seen_worktrees:
                    shared_conflicts.append({
                        "kind": "worktree",
                        "path": wt,
                        "changes": [seen_worktrees[wt], entry["changeId"]],
                    })
                else:
                    seen_worktrees[wt] = entry["changeId"]
    levels = ["change-internal"] if mode == "single-active" else [
        "change-internal",
        "multi-change",
    ]
    return {
        "ok": True,
        "concurrencyMode": mode,
        "activeChanges": active,
        "sharedStateConflicts": shared_conflicts,
        "allowedParallelLevels": levels,
    }


# ---------------------------------------------------------------------------
# record-quirk — 适配 v2 commands（source=user override）
# ---------------------------------------------------------------------------

def ensure_pitfalls_appendix(project: Path) -> Path:
    path = project / PITFALLS_REL
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        content = (
            "# 项目避坑记录\n\n"
            "> 由 harness_preflight.py record-quirk 自动维护附录。\n\n"
            f"{PITFALLS_APPENDIX_HEADER}\n\n"
        )
        path.write_text(content, encoding="utf-8")
        return path
    text = path.read_text(encoding="utf-8")
    if PITFALLS_APPENDIX_HEADER not in text:
        if not text.endswith("\n"):
            text += "\n"
        text += f"\n{PITFALLS_APPENDIX_HEADER}\n\n"
        path.write_text(text, encoding="utf-8")
    return path


def append_pitfalls_line(project: Path, line: str) -> Path:
    path = ensure_pitfalls_appendix(project)
    text = path.read_text(encoding="utf-8")
    if not text.endswith("\n"):
        text += "\n"
    text += line.rstrip() + "\n"
    path.write_text(text, encoding="utf-8")
    return path


def _load_or_skeleton(project: Path) -> tuple[dict[str, Any], Path]:
    """加载 v2 profile；缺失时返回空 skeleton（不自动 detect，避免副作用）。"""
    profile_path = project / hprof.PROFILE_REL
    if profile_path.is_file():
        try:
            profile = hprof.read_json(profile_path)
            if isinstance(profile, dict):
                return profile, profile_path
        except (OSError, json.JSONDecodeError):
            pass
    profile = hprof.empty_profile_skeleton(hprof.DEFAULT_EXCLUDED_ROOTS)
    profile["detectedAt"] = now_iso()
    return profile, profile_path


def cmd_record_quirk(
    project: Path,
    pattern: str,
    reason: str,
    action: str,
    fixed_command: str | None = None,
) -> dict[str, Any]:
    project = project.resolve()
    if action not in VALID_QUIRK_ACTIONS:
        return {
            "ok": False,
            "action": "record-quirk",
            "issues": [f"invalid action: {action}; expected one of {sorted(VALID_QUIRK_ACTIONS)}"],
        }

    profile, profile_path = _load_or_skeleton(project)

    profile.setdefault("knownPreexistingErrors", [])
    profile.setdefault("shellQuirks", [])
    profile.setdefault("commands", {})
    if not isinstance(profile["knownPreexistingErrors"], list):
        profile["knownPreexistingErrors"] = []
    if not isinstance(profile["shellQuirks"], list):
        profile["shellQuirks"] = []
    if not isinstance(profile["commands"], dict):
        profile["commands"] = {}

    changed: list[str] = []

    if action == "skip-not-block":
        entry = {"pattern": pattern, "reason": reason, "action": "skip-not-block"}
        existing_patterns = {
            e.get("pattern")
            for e in profile["knownPreexistingErrors"]
            if isinstance(e, dict)
        }
        if pattern not in existing_patterns:
            profile["knownPreexistingErrors"].append(entry)
            changed.append("knownPreexistingErrors")
        else:
            # Append-only: do not overwrite existing entry; still sync pitfalls
            changed.append("knownPreexistingErrors(already-present)")
    else:  # fix-command
        if pattern not in profile["shellQuirks"]:
            profile["shellQuirks"].append(pattern)
            changed.append("shellQuirks")
        else:
            changed.append("shellQuirks(already-present)")
        if fixed_command:
            # v2：写 commands.<key> 为 source=user override（spec §3.1 显式保留）。
            # 已知 verification key 覆写其 command；否则存 namespaced custom key。
            if pattern in hprof.VERIFICATION_KEYS:
                key = pattern
            else:
                key = f"custom:{pattern}"
            existing_cmd = profile["commands"].get(key, {})
            if not isinstance(existing_cmd, dict):
                existing_cmd = {}
            new_cmd = dict(existing_cmd)
            new_cmd["command"] = fixed_command
            try:
                new_cmd["argvTemplate"] = shlex.split(fixed_command)
            except ValueError:
                # 不平衡引号回退到空格切分（best-effort；record-quirk 是人工逃逸口）
                new_cmd["argvTemplate"] = fixed_command.split()
            new_cmd["source"] = "user"
            profile["commands"][key] = new_cmd
            changed.append(f"commands.{key}")
            # 重派 verificationInputs 兼容字段，保持与 commands 一致
            hprof._derive_verification_inputs(profile)

    hprof.write_json(profile_path, profile)

    date_str = dt.date.today().isoformat()
    pitfalls_line = f"- {date_str}: `{pattern}` — {reason} （action={action}"
    if fixed_command:
        pitfalls_line += f"; fixed-command=`{fixed_command}`"
    pitfalls_line += "）"
    pitfalls_path = append_pitfalls_line(project, pitfalls_line)

    return {
        "ok": True,
        "action": "record-quirk",
        "project": str(project),
        "pattern": pattern,
        "reason": reason,
        "quirkAction": action,
        "fixedCommand": fixed_command,
        "changed": changed,
        "profilePath": str(profile_path),
        "pitfallsPath": str(pitfalls_path),
        "pitfallsLine": pitfalls_line,
        "profile": profile,
    }


# ---------------------------------------------------------------------------
# check-agents — agent 定义可用性校验（本 skill 独有，不涉及 profile）
# ---------------------------------------------------------------------------

def parse_frontmatter(text: str) -> tuple[dict[str, Any] | None, str | None]:
    """Parse YAML-ish frontmatter between leading --- fences.

    Returns (meta, error_reason). Supports simple scalars, lists, and
    nested list items used by harness agent definitions.
    """
    if not text.startswith("---"):
        return None, "missing frontmatter start ---"
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return None, "missing frontmatter start ---"
    end_idx = None
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end_idx = i
            break
    if end_idx is None:
        return None, "missing frontmatter end ---"

    body = "\n".join(lines[1:end_idx])
    meta: dict[str, Any] = {}
    current_list_key: str | None = None

    for raw in body.splitlines():
        if not raw.strip():
            continue
        # list item under previous key
        list_item = re.match(r"^-\s+(.*)$", raw)
        if list_item and current_list_key:
            meta.setdefault(current_list_key, [])
            if not isinstance(meta[current_list_key], list):
                meta[current_list_key] = []
            meta[current_list_key].append(_parse_scalar(list_item.group(1).strip()))
            continue

        m = re.match(r"^([A-Za-z0-9_]+):\s*(.*)$", raw)
        if not m:
            current_list_key = None
            continue
        key, val = m.group(1), m.group(2).strip()
        if val == "":
            current_list_key = key
            meta[key] = []
            continue
        current_list_key = None
        if val.startswith("[") and val.endswith("]"):
            inner = val[1:-1].strip()
            if not inner:
                meta[key] = []
            else:
                parts = _split_flow_list(inner)
                meta[key] = [_parse_scalar(p.strip()) for p in parts]
        else:
            meta[key] = _parse_scalar(val)
    return meta, None


def _split_flow_list(inner: str) -> list[str]:
    """Split YAML flow list respecting nested brackets like Bash(powershell.exe:*)."""
    parts: list[str] = []
    buf: list[str] = []
    depth = 0
    for ch in inner:
        if ch == "[":
            depth += 1
            buf.append(ch)
        elif ch == "]":
            depth = max(0, depth - 1)
            buf.append(ch)
        elif ch == "(":
            depth += 1
            buf.append(ch)
        elif ch == ")":
            depth = max(0, depth - 1)
            buf.append(ch)
        elif ch == "," and depth == 0:
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
    if buf:
        parts.append("".join(buf))
    return parts


def _parse_scalar(val: str) -> Any:
    if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
        return val[1:-1]
    if val.lower() in ("true", "false"):
        return val.lower() == "true"
    if re.fullmatch(r"-?\d+", val):
        return int(val)
    return val


def _resolve_agents_root(skills_root: Path, agents_root: Path | None) -> tuple[Path | None, str | None]:
    """Resolve agent definitions without confusing a skills root with its sibling."""
    if agents_root is not None:
        return agents_root.resolve(), None
    if skills_root.name == "skills" and skills_root.parent.name in (".claude", ".codebuddy"):
        return (skills_root.parent / "agents").resolve(), None
    if skills_root.name == "skills" and skills_root.parent.name in (".agents", ".cursor"):
        # These adapters (Codex/Cursor) may provide agent roles via host
        # capability manifest rather than local .md files. Return None without
        # a hard error; the caller checks runtime.json for host capabilities.
        return None, None
    return (skills_root / "agents").resolve(), None


def _read_host_capabilities(skills_root: Path) -> set[str]:
    """Read agent capabilities declared by the host adapter (retro §5.3).

    Adapter installs may declare available agent roles in
    `meta/runtime.json` under `agentCapabilities` (list of role names).
    Returns an empty set if the file or field is absent.
    """
    # runtime.json lives in the change's meta/ dir, but agent capabilities are
    # project-level. Check the adapter's runtime.json at the project root.
    candidates = [
        skills_root.parent / "runtime.json",
        skills_root / "runtime.json",
    ]
    for path in candidates:
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(data, dict):
            continue
        caps = data.get("agentCapabilities")
        if isinstance(caps, list):
            return {str(c) for c in caps if isinstance(c, str)}
    return set()


def cmd_check_agents(
    skills_root: Path,
    agent: str,
    *,
    agents_root: Path | None = None,
) -> dict[str, Any]:
    skills_root = skills_root.resolve()
    agent_name = agent.strip()
    if not agent_name:
        return {
            "ok": False,
            "action": "check-agents",
            "agent": agent,
            "usable": False,
            "reason": "agent name is empty",
        }

    resolved_agents_root, _ = _resolve_agents_root(skills_root, agents_root)
    host_capabilities = _read_host_capabilities(skills_root)
    host_callable = agent_name in host_capabilities

    # Three independent fields (retro §5.3):
    # - definitionPresent: local .md file exists
    # - hostCallable: host adapter declares this agent role
    # - toolContractValid: tools declaration is valid (non-empty list)
    definition_present = False
    tool_contract_valid = False
    agent_path: Path | None = None
    meta: dict[str, Any] | None = None

    if resolved_agents_root is not None:
        filename = agent_name if agent_name.endswith(".md") else f"{agent_name}.md"
        agent_path = resolved_agents_root / filename
        definition_present = agent_path.is_file()

    # If no local definition and host doesn't declare the role, we can't
    # determine usability. Distinguish "host says no" from "unknown".
    if not definition_present and not host_callable:
        # Check if this adapter is known to not support custom agents
        adapter_name = skills_root.parent.name
        if adapter_name in (".agents", ".cursor"):
            # Codex/Cursor: may support via host manifest. If runtime.json
            # has agentCapabilities but this role isn't listed, it's a
            # genuine "not available". If no agentCapabilities field at all,
            # we can't know — return UNKNOWN.
            runtime_path = skills_root.parent / "runtime.json"
            if not runtime_path.is_file():
                return {
                    "ok": True,
                    "action": "check-agents",
                    "agent": agent_name,
                    "usable": False,
                    "definitionPresent": False,
                    "hostCallable": False,
                    "toolContractValid": False,
                    "reasonCode": "UNKNOWN",
                    "reason": (
                        "no local agent definition and no host capability manifest; "
                        "cannot determine agent availability"
                    ),
                }
        return {
            "ok": False,
            "action": "check-agents",
            "agent": agent_name,
            "path": str(agent_path) if agent_path else None,
            "agentsRoot": str(resolved_agents_root) if resolved_agents_root else None,
            "usable": False,
            "definitionPresent": False,
            "hostCallable": False,
            "toolContractValid": False,
            "reasonCode": "AGENT_DEFINITION_NOT_FOUND",
            "reason": f"agent file not found and host does not declare role: {agent_name}",
        }

    # If definition present, validate frontmatter and tools
    if definition_present and agent_path is not None:
        try:
            text = agent_path.read_text(encoding="utf-8")
        except OSError as exc:
            return {
                "ok": False,
                "action": "check-agents",
                "agent": agent_name,
                "path": str(agent_path),
                "usable": False,
                "definitionPresent": True,
                "hostCallable": host_callable,
                "toolContractValid": False,
                "reason": f"cannot read agent file: {exc}",
            }

        meta, err = parse_frontmatter(text)
        if err or meta is None:
            return {
                "ok": False,
                "action": "check-agents",
                "agent": agent_name,
                "path": str(agent_path),
                "usable": False,
                "definitionPresent": True,
                "hostCallable": host_callable,
                "toolContractValid": False,
                "reason": f"frontmatter parse failed: {err or 'unknown'}",
            }

        tools = meta.get("tools")
        if tools is None:
            tool_contract_valid = False
        elif isinstance(tools, list) and len(tools) > 0:
            tool_contract_valid = True
        else:
            tool_contract_valid = False

    # usable = hostCallable (host provides the agent role, tools validated by host)
    # OR definitionPresent AND toolContractValid (definition-based adapters)
    usable = host_callable or (
        definition_present and tool_contract_valid
    )

    name_field = meta.get("name") if meta else None
    tools_field = meta.get("tools") if meta else None

    reason_code = "READY" if usable else "AGENT_DEFINITION_NOT_FOUND"
    if not definition_present and host_callable:
        reason_code = "DEFINITION_NOT_FOUND_HOST_CAPABLE"

    return {
        "ok": True,
        "action": "check-agents",
        "agent": agent_name,
        "path": str(agent_path) if agent_path else None,
        "agentsRoot": str(resolved_agents_root) if resolved_agents_root else None,
        "usable": usable,
        "definitionPresent": definition_present,
        "hostCallable": host_callable,
        "toolContractValid": tool_contract_valid,
        "reasonCode": reason_code,
        "reason": (
            "agent available; "
            f"definition={'present' if definition_present else 'absent'}, "
            f"hostCallable={host_callable}, "
            f"tools={'valid' if tool_contract_valid else 'invalid'}"
        ),
        "name": name_field,
        "tools": tools_field,
        "frontmatterKeys": sorted(meta.keys()) if meta else [],
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Harness preflight: build-profile + agent availability checks.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable JSON (always on for subcommands; kept for contract).",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_detect = sub.add_parser("detect", help="Full probe and write build-profile.json")
    p_detect.add_argument("--project", required=True, type=Path)
    p_detect.add_argument("--json", action="store_true")

    p_check = sub.add_parser("check", help="Fast stale check of build-profile")
    p_check.add_argument("--project", required=True, type=Path)
    p_check.add_argument("--json", action="store_true")

    p_quirk = sub.add_parser("record-quirk", help="Append quirk without overwriting peers")
    p_quirk.add_argument("--project", required=True, type=Path)
    p_quirk.add_argument("--pattern", required=True)
    p_quirk.add_argument("--reason", required=True)
    p_quirk.add_argument(
        "--action",
        required=True,
        choices=sorted(VALID_QUIRK_ACTIONS),
    )
    p_quirk.add_argument("--fixed-command", default=None)
    p_quirk.add_argument("--json", action="store_true")

    p_agents = sub.add_parser("check-agents", help="Validate agent definition usability")
    p_agents.add_argument("--skills-root", required=True, type=Path)
    p_agents.add_argument("--agents-root", type=Path)
    p_agents.add_argument("--agent", required=True)
    p_agents.add_argument("--json", action="store_true")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.command == "detect":
        result = cmd_detect(args.project)
        return emit_json(result, ok=bool(result.get("ok", True)))
    if args.command == "check":
        result = cmd_check(args.project)
        # missing/invalid = hard failure (exit 1); stale/ready exit 0 (callers branch on JSON)
        hard = result.get("status") in ("missing", "invalid")
        return emit_json(result, ok=not hard)
    if args.command == "record-quirk":
        result = cmd_record_quirk(
            args.project,
            pattern=args.pattern,
            reason=args.reason,
            action=args.action,
            fixed_command=args.fixed_command,
        )
        return emit_json(result, ok=bool(result.get("ok", False)))
    if args.command == "check-agents":
        result = cmd_check_agents(
            args.skills_root,
            args.agent,
            agents_root=args.agents_root,
        )
        return emit_json(result, ok=True)

    parser.error(f"unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
