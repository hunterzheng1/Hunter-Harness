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


def cmd_check_agents(skills_root: Path, agent: str) -> dict[str, Any]:
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

    # Accept bare name or with .md
    filename = agent_name if agent_name.endswith(".md") else f"{agent_name}.md"
    agent_path = skills_root / "agents" / filename

    if not agent_path.is_file():
        return {
            "ok": False,
            "action": "check-agents",
            "agent": agent_name,
            "path": str(agent_path),
            "usable": False,
            "reason": f"agent file not found: {agent_path}",
        }

    try:
        text = agent_path.read_text(encoding="utf-8")
    except OSError as exc:
        return {
            "ok": False,
            "action": "check-agents",
            "agent": agent_name,
            "path": str(agent_path),
            "usable": False,
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
            "reason": f"frontmatter parse failed: {err or 'unknown'}",
        }

    tools = meta.get("tools")
    if tools is None:
        return {
            "ok": False,
            "action": "check-agents",
            "agent": agent_name,
            "path": str(agent_path),
            "usable": False,
            "reason": "tools declaration missing",
            "frontmatter": meta,
        }
    if not isinstance(tools, list) or len(tools) == 0:
        return {
            "ok": False,
            "action": "check-agents",
            "agent": agent_name,
            "path": str(agent_path),
            "usable": False,
            "reason": "tools declaration empty or invalid",
            "frontmatter": meta,
        }

    name_field = meta.get("name")
    return {
        "ok": True,
        "action": "check-agents",
        "agent": agent_name,
        "path": str(agent_path),
        "usable": True,
        "reason": "agent file exists; frontmatter parsed; tools declared",
        "name": name_field,
        "tools": tools,
        "frontmatterKeys": sorted(meta.keys()),
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
        result = cmd_check_agents(args.skills_root, args.agent)
        return emit_json(result, ok=True)

    parser.error(f"unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
