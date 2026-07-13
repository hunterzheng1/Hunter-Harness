#!/usr/bin/env python3
"""Harness preflight: build-profile detect/check + quirk recording + agent precheck.

Implements DESIGN.md D5 (build-profile) and D8 (subagent precheck).
Python 3.10+ stdlib only. UTF-8 without BOM. Windows path friendly.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


SCHEMA_VERSION = 1
PROFILE_REL = Path(".harness") / "config" / "build-profile.json"
PITFALLS_REL = Path(".harness") / "pitfalls.md"
PITFALLS_APPENDIX_HEADER = "## Preflight 附录（自动追加）"

DEFAULT_BUILD_COMMANDS: dict[str, str] = {
    "compile": "",
    "unitTest": "",
    "unitTestFull": "",
    "install": "",
    "package": "",
}

VALID_QUIRK_ACTIONS = {"skip-not-block", "fix-command"}


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def emit_json(payload: dict[str, Any], *, ok: bool = True) -> int:
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if ok else 1


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    path.write_text(text, encoding="utf-8")


def sha256_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def find_root_pom(project: Path) -> Path | None:
    candidates = [project / "pom.xml", project / "pom.xml.example"]
    for c in candidates:
        if c.is_file():
            return c
    return None


def which_tool(name: str) -> str | None:
    found = shutil.which(name)
    if found:
        return str(Path(found).resolve())
    # Windows: try .cmd / .bat / .exe explicitly
    if os.name == "nt":
        for ext in (".cmd", ".bat", ".exe"):
            found = shutil.which(name + ext)
            if found:
                return str(Path(found).resolve())
    return None


def run_version(tool_path: str | None, args: list[str], timeout: float = 8.0) -> str:
    """Best-effort version probe. Empty string if unavailable."""
    if not tool_path:
        return ""
    try:
        completed = subprocess.run(
            [tool_path, *args],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    text = (completed.stdout or "") + "\n" + (completed.stderr or "")
    return _extract_version(text)


def _extract_version(text: str) -> str:
    # node: v20.11.0 / Apache Maven 3.9.6
    m = re.search(r"\bv?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\b", text)
    if m:
        return m.group(1)
    m = re.search(r"version\s+([^\s,]+)", text, re.IGNORECASE)
    if m:
        return m.group(1).strip()
    line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    return line[:120]


def is_executable_path(path_str: str | None) -> bool:
    if not path_str:
        return False
    p = Path(path_str)
    if not p.exists():
        return False
    if p.is_file():
        if os.name == "nt":
            return True
        return os.access(p, os.X_OK)
    # On Windows, shutil.which may return .cmd wrappers that exist
    return p.exists()


def load_existing_profile(project: Path) -> dict[str, Any] | None:
    path = project / PROFILE_REL
    if not path.is_file():
        return None
    try:
        data = read_json(path)
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def parse_claude_hints(project: Path) -> dict[str, str]:
    """Extract optional build command hints from CLAUDE.md / AGENTS.md."""
    hints: dict[str, str] = {}
    for name in ("CLAUDE.md", "AGENTS.md", ".claude/CLAUDE.md"):
        path = project / name
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        # Look for fenced or inline mvn/npm command examples
        for key, pattern in (
            ("compile", r"(?:compile|编译)[^\n`]*`([^`]+)`"),
            ("unitTest", r"(?:unit.?test|单元测试)[^\n`]*`([^`]+)`"),
            ("package", r"(?:package|打包)[^\n`]*`([^`]+)`"),
            ("install", r"(?:install|安装依赖)[^\n`]*`([^`]+)`"),
        ):
            m = re.search(pattern, text, re.IGNORECASE)
            if m and key not in hints:
                hints[key] = m.group(1).strip()
        # Direct mvn lines
        for m in re.finditer(r"`(mvn[^`]+)`", text):
            cmd = m.group(1).strip()
            if "compile" in cmd and "compile" not in hints:
                hints["compile"] = cmd
            elif re.search(r"\btest\b", cmd) and "unitTest" not in hints:
                hints["unitTest"] = cmd
            elif "package" in cmd and "package" not in hints:
                hints["package"] = cmd
            elif "install" in cmd and "install" not in hints:
                hints["install"] = cmd
    return hints


def empty_profile_skeleton() -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "detectedAt": "",
        "toolPaths": {"node": "", "mvn": ""},
        "buildCommands": dict(DEFAULT_BUILD_COMMANDS),
        "verificationInputs": {},
        "serviceStart": {
            "command": "",
            "healthUrl": "",
            "startTimeoutSec": 120,
            "inputFiles": [],
            "profile": "",
            "overlayPath": "",
        },
        "knownPreexistingErrors": [],
        "shellQuirks": [],
        "fingerprint": {"mvnVersion": "", "nodeVersion": "", "pomHash": ""},
    }


def merge_preserve_quirks(
    base: dict[str, Any],
    existing: dict[str, Any] | None,
) -> dict[str, Any]:
    """Keep human-curated quirks/errors/commands when re-detecting."""
    if not existing:
        return base
    # Preserve knownPreexistingErrors / shellQuirks / filled buildCommands / serviceStart
    if isinstance(existing.get("knownPreexistingErrors"), list):
        base["knownPreexistingErrors"] = list(existing["knownPreexistingErrors"])
    if isinstance(existing.get("shellQuirks"), list):
        base["shellQuirks"] = list(existing["shellQuirks"])
    existing_cmds = existing.get("buildCommands")
    if isinstance(existing_cmds, dict):
        for k, v in existing_cmds.items():
            if isinstance(v, str) and v.strip():
                base["buildCommands"][k] = v
    existing_svc = existing.get("serviceStart")
    if isinstance(existing_svc, dict):
        merged_svc = dict(base.get("serviceStart") or {})
        for k, v in existing_svc.items():
            if v not in (None, ""):
                merged_svc[k] = v
        base["serviceStart"] = merged_svc
    # 保留用户已配置的 verificationInputs（可能含 module 专属 glob），不覆盖。
    if isinstance(existing.get("verificationInputs"), dict):
        base["verificationInputs"] = dict(existing["verificationInputs"])
    return base


def build_fingerprint(project: Path, node_path: str | None, mvn_path: str | None) -> dict[str, str]:
    pom = find_root_pom(project)
    pom_hash = sha256_file(pom) if pom else ""
    return {
        "mvnVersion": run_version(mvn_path, ["--version"]) if mvn_path else "",
        "nodeVersion": run_version(node_path, ["--version"]) if node_path else "",
        "pomHash": pom_hash or "",
    }


def current_pom_hash(project: Path) -> str:
    pom = find_root_pom(project)
    return (sha256_file(pom) if pom else "") or ""


def cmd_detect(project: Path) -> dict[str, Any]:
    project = project.resolve()
    existing = load_existing_profile(project)
    profile = empty_profile_skeleton()

    node_path = which_tool("node")
    mvn_path = which_tool("mvn")
    profile["toolPaths"] = {
        "node": node_path or "",
        "mvn": mvn_path or "",
    }
    profile["fingerprint"] = build_fingerprint(project, node_path, mvn_path)
    profile["detectedAt"] = now_iso()

    hints = parse_claude_hints(project)
    cmds = dict(DEFAULT_BUILD_COMMANDS)
    cmds.update({k: v for k, v in hints.items() if k in cmds})
    # Sensible Java placeholders when pom exists but no hints
    if find_root_pom(project) and not any(cmds.values()):
        cmds["compile"] = "mvn -f pom.xml compile -o -q"
        cmds["unitTest"] = "mvn -f pom.xml test -Dtest={testClasses} -o"
        cmds["unitTestFull"] = "mvn -f pom.xml test -o"
        cmds["install"] = "mvn install -pl {modules} -am -DskipTests -nsu"
        cmds["package"] = "mvn -f pom.xml package '-Dmaven.test.skip=true'"
    profile["buildCommands"] = cmds

    # Java 项目给 verificationInputs.unitTestFull 一个根级默认闭包
    # （多 module 项目用户可改为 module/pom.xml + module/src/**）。通用/无 pom
    # 项目保持空 {} —— can-reuse --profile-input unitTestFull 会返回
    # insufficient-evidence，执行全量测试但不允许缓存复用，直到 profile 配置好。
    if find_root_pom(project):
        # A reactor-level Maven test can run every module, so its reuse
        # fingerprint must include every module's pom and source roots.
        module_poms = sorted(
            pom.relative_to(project).as_posix()
            for pom in project.rglob("pom.xml")
            if pom.is_file() and ".harness" not in pom.parts and ".git" not in pom.parts
        )
        full_inputs: list[str] = []
        for pom in module_poms:
            full_inputs.append(pom)
            parent = Path(pom).parent
            prefix = "" if str(parent) == "." else f"{parent.as_posix()}/"
            full_inputs.extend([f"{prefix}src/main/**", f"{prefix}src/test/**"])
        profile["verificationInputs"] = {"unitTestFull": full_inputs}

    profile = merge_preserve_quirks(profile, existing)

    # Idempotent fingerprint/toolPaths overwrite from fresh detect;
    # detectedAt updates each run (tests compare ignoring it).
    out_path = project / PROFILE_REL
    write_json(out_path, profile)

    return {
        "ok": True,
        "action": "detect",
        "project": str(project),
        "profilePath": str(out_path),
        "profile": profile,
        "created": existing is None,
        "updated": True,
    }


def cmd_check(project: Path) -> dict[str, Any]:
    """Second-run fast check: existence + executability + fingerprint compare.

    Does NOT run mvn/node full version probes (≤5s target).
    """
    project = project.resolve()
    profile_path = project / PROFILE_REL
    issues: list[str] = []
    stale = False

    if not profile_path.is_file():
        return {
            "ok": False,
            "hardFailure": True,
            "action": "check",
            "project": str(project),
            "stale": True,
            "issues": ["build-profile.json missing; run detect"],
            "hint": "python harness_preflight.py detect --project <root> --json",
        }

    try:
        profile = read_json(profile_path)
    except (OSError, json.JSONDecodeError) as exc:
        return {
            "ok": False,
            "hardFailure": True,
            "action": "check",
            "project": str(project),
            "stale": True,
            "issues": [f"build-profile.json unreadable: {exc}"],
            "hint": "python harness_preflight.py detect --project <root> --json",
        }

    if not isinstance(profile, dict):
        return {
            "ok": False,
            "hardFailure": True,
            "action": "check",
            "project": str(project),
            "stale": True,
            "issues": ["build-profile.json is not an object"],
            "hint": "python harness_preflight.py detect --project <root> --json",
        }

    tool_paths = profile.get("toolPaths") or {}
    if not isinstance(tool_paths, dict):
        tool_paths = {}

    for tool_name in ("node", "mvn"):
        path_str = tool_paths.get(tool_name) or ""
        if not path_str:
            # Empty is allowed (tool not present at detect time)
            continue
        if not is_executable_path(path_str):
            stale = True
            issues.append(f"toolPaths.{tool_name} missing or not executable: {path_str}")

    fp = profile.get("fingerprint") or {}
    if not isinstance(fp, dict):
        fp = {}
    stored_pom = fp.get("pomHash") or ""
    current_pom = current_pom_hash(project)
    if stored_pom != current_pom:
        stale = True
        issues.append(
            f"fingerprint.pomHash changed: stored={stored_pom or '(empty)'} "
            f"current={current_pom or '(empty)'}"
        )

    # If profile recorded a tool version but path is now gone → already covered.
    # If pom appeared/disappeared relative to empty hash → covered above.

    result = {
        "ok": not stale,
        "action": "check",
        "project": str(project),
        "stale": stale,
        "issues": issues,
        "fingerprint": {
            "stored": {"pomHash": stored_pom, "mvnVersion": fp.get("mvnVersion", ""), "nodeVersion": fp.get("nodeVersion", "")},
            "current": {"pomHash": current_pom},
        },
    }
    if stale:
        result["hint"] = "python harness_preflight.py detect --project <root> --json"
    return result


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
    # Append after appendix header block (end of file is fine for append-only)
    text += line.rstrip() + "\n"
    path.write_text(text, encoding="utf-8")
    return path


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

    profile_path = project / PROFILE_REL
    if profile_path.is_file():
        try:
            profile = read_json(profile_path)
            if not isinstance(profile, dict):
                profile = empty_profile_skeleton()
        except (OSError, json.JSONDecodeError):
            profile = empty_profile_skeleton()
    else:
        profile = empty_profile_skeleton()
        profile["detectedAt"] = now_iso()

    profile.setdefault("knownPreexistingErrors", [])
    profile.setdefault("shellQuirks", [])
    profile.setdefault("buildCommands", dict(DEFAULT_BUILD_COMMANDS))

    if not isinstance(profile["knownPreexistingErrors"], list):
        profile["knownPreexistingErrors"] = []
    if not isinstance(profile["shellQuirks"], list):
        profile["shellQuirks"] = []
    if not isinstance(profile["buildCommands"], dict):
        profile["buildCommands"] = dict(DEFAULT_BUILD_COMMANDS)

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
            # Known buildCommands key → update it; otherwise store under a
            # namespaced custom key to avoid polluting the standard key space.
            if pattern in DEFAULT_BUILD_COMMANDS:
                key = pattern
            else:
                key = f"custom:{pattern}"
            profile["buildCommands"][key] = fixed_command
            changed.append(f"buildCommands.{key}")

    write_json(profile_path, profile)

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
        # stale=true with a readable profile still exits 0 (callers branch on JSON);
        # hard failures (profile missing / unreadable / not an object) exit 1.
        return emit_json(result, ok=not result.get("hardFailure", False))
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
