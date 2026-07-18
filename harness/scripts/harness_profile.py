#!/usr/bin/env python3
"""Harness profile v2 — public deterministic profile resolver/validator/migrator.

Change cluster 1 of harness-deterministic-performance.

Spec §3.1：每个 verification 声明 command/argvTemplate/scope/inputs/coverage/
source/basis；持久 profile 只保存模板，不含具体 change-name/worktree 路径或已解析
overlay；运行期 resolve 结果写入 change runtime/session。

兼容性：保留顶层 `verificationInputs`（派生自 commands.<key>.inputs）以兼容
harness_ledger.py v1 的 expand_profile_input_files，直到 cluster 2 升级 ledger。

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


SCHEMA_VERSION = 2
PROFILE_REL = Path(".harness") / "config" / "build-profile.json"

# 排除策略（spec §3.1）：所有路径必须位于 project root，排除以下目录。
# 兄弟 worktree、构建产物、依赖目录、缓存一律不进入 verification inputs。
DEFAULT_EXCLUDED_ROOTS: tuple[str, ...] = (
    ".git",
    ".harness",
    ".claude/worktrees",
    ".cursor/worktrees",
    ".codeium/worktrees",
    "target",
    "build",
    "dist",
    "node_modules",
    ".gradle",
    ".idea",
    ".vscode",
    "__pycache__",
    ".pytest_cache",
    ".cache",
)

# 覆盖层级（spec §3.2）：unitTest ⊂ unitTestFull；package 独立；submit 复用 unitTestFull。
VERIFICATION_KEYS: tuple[str, ...] = (
    "compile",
    "unitTest",
    "unitTestFull",
    "install",
    "package",
)

VALID_SOURCES = ("detected", "user")


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def read_json(path: Path) -> Any:
    # utf-8-sig 兼容可能残留的 BOM（与 harness_ledger.py 保持一致）。
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    # 强制 LF，UTF-8 无 BOM（spec §3.4 字节级指纹一致性）。
    # 原子写 temp+os.replace：崩溃后不留半写文件（与 runtime-helpers.mjs writeJsonUtf8NoBom 一致）。
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(text, encoding="utf-8", newline="\n")
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def sha256_file(path: Path) -> str:
    if not path.is_file():
        return ""
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------------------
# 排除策略与路径逃逸校验
# ---------------------------------------------------------------------------

def _excluded_segments(excluded: tuple[str, ...] | list[str]) -> tuple[tuple[str, ...], ...]:
    return tuple(tuple(e.split("/")) for e in excluded)


def is_path_excluded(rel_path: str, excluded: tuple[str, ...] | list[str]) -> bool:
    """rel_path 是否落在某个 excluded root 下。

    rel_path 用 posix 斜杠；支持多段 excluded root（如 .claude/worktrees）。
    """
    parts = Path(rel_path).parts
    for segs in _excluded_segments(excluded):
        if len(parts) >= len(segs) and parts[: len(segs)] == segs:
            return True
    return False


# ---------------------------------------------------------------------------
# 探测
# ---------------------------------------------------------------------------

def detect_project_type(project: Path) -> str:
    if (project / "pom.xml").is_file():
        return "java-maven"
    if (project / "package.json").is_file():
        return "node"
    return "unknown"


def which_tool(name: str) -> str:
    found = shutil.which(name)
    if found:
        return str(Path(found).resolve())
    if os.name == "nt":
        for ext in (".cmd", ".bat", ".exe"):
            found = shutil.which(name + ext)
            if found:
                return str(Path(found).resolve())
    return ""


def find_reactor_modules(project: Path, excluded: tuple[str, ...] | list[str]) -> list[str]:
    """发现当前 checkout 内含 pom.xml 的模块（repo-relative，排序去重）。

    兄弟 worktree、target/build/node_modules 等排除目录内的 POM 一律排除
    （UT-003/UT-004）。root pom → "."；子模块 → "module-a"。
    """
    project = project.resolve()
    modules: set[str] = set()
    for pom in project.rglob("pom.xml"):
        if not pom.is_file():
            continue
        rel = pom.relative_to(project)
        if is_path_excluded(rel.as_posix(), excluded):
            continue
        parent = rel.parent
        mod = "." if str(parent) == "." else parent.as_posix()
        modules.add(mod)
    return sorted(modules)


def _cmd_inputs(
    modules: list[str], *, pom: bool, main: bool, test: bool
) -> list[str]:
    """按 reactor modules 生成 verification inputs（排序去重）。"""
    result: list[str] = []
    for m in modules:
        prefix = "" if m == "." else f"{m}/"
        if pom:
            result.append(f"{prefix}pom.xml")
        if main:
            result.append(f"{prefix}src/main/**")
        if test:
            result.append(f"{prefix}src/test/**")
    return sorted(set(result))


def _java_commands(reactor_modules: list[str], pom_hash: str) -> dict[str, Any]:
    basis = {"reactorModules": list(reactor_modules), "pomHash": pom_hash}
    full_inputs = _cmd_inputs(reactor_modules, pom=True, main=True, test=True)
    return {
        "compile": {
            "command": "mvn -f pom.xml compile -o -q",
            "argvTemplate": ["mvn", "-f", "pom.xml", "compile", "-o", "-q"],
            "scope": "module",
            "inputs": _cmd_inputs(reactor_modules, pom=True, main=True, test=False),
            "coverage": "compile",
            "source": "detected",
            "basis": dict(basis),
        },
        "unitTest": {
            "command": "mvn -f pom.xml test -Dtest={testClasses} -o",
            "argvTemplate": ["mvn", "-f", "pom.xml", "test", "-Dtest={testClasses}", "-o"],
            "scope": "incremental",
            "inputs": _cmd_inputs(reactor_modules, pom=True, main=False, test=True),
            "coverage": "unitTest",
            "source": "detected",
            "basis": dict(basis),
        },
        "unitTestFull": {
            "command": "mvn -f pom.xml test -o",
            "argvTemplate": ["mvn", "-f", "pom.xml", "test", "-o"],
            "scope": "full",
            "inputs": full_inputs,
            "coverage": "unitTestFull",
            "source": "detected",
            "basis": dict(basis),
        },
        "install": {
            "command": "mvn install -pl {modules} -am -DskipTests -nsu",
            "argvTemplate": ["mvn", "install", "-pl", "{modules}", "-am", "-DskipTests", "-nsu"],
            "scope": "module-am",
            "inputs": _cmd_inputs(reactor_modules, pom=True, main=False, test=False),
            "coverage": "install",
            "source": "detected",
            "basis": dict(basis),
        },
        "package": {
            "command": "mvn -f pom.xml clean package '-Dmaven.test.skip=true'",
            "argvTemplate": ["mvn", "-f", "pom.xml", "clean", "package", "-Dmaven.test.skip=true"],
            "scope": "module",
            "inputs": _cmd_inputs(reactor_modules, pom=True, main=True, test=True),
            "coverage": "package",
            "source": "detected",
            "basis": dict(basis),
        },
    }


def _node_commands(project: Path) -> dict[str, Any]:
    """commands for a node project: unitTestFull = `npm run check` (or `npm test`)
    with an input closure covering TS sources/tests + config (+ harness Python/.mjs
    when the project dogfoods harness). Lets can-reuse --profile-input unitTestFull
    reuse a green full check instead of forcing insufficient-evidence."""
    pkg = project / "package.json"
    if not pkg.is_file():
        return {}
    try:
        data = json.loads(pkg.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return {}
    scripts = data.get("scripts") if isinstance(data, dict) else None
    if not isinstance(scripts, dict):
        return {}
    script_key = "check" if "check" in scripts else ("test" if "test" in scripts else None)
    if not script_key:
        return {}
    full_cmd = scripts[script_key]
    # Precise globs (avoid node_modules/** which would make the inputs hash unstable).
    inputs = [
        "package.json",
        "tsconfig.json",
        "tsconfig.*.json",
        "vitest.config.*",
        "eslint.config.*",
        "src/**/*.ts",
        "src/**/*.tsx",
        "test/**/*.ts",
        "test/**/*.tsx",
        "packages/*/src/**/*.ts",
        "packages/*/src/**/*.tsx",
        "packages/*/test/**/*.ts",
        "packages/*/test/**/*.tsx",
        "apps/*/src/**/*.ts",
        "apps/*/src/**/*.tsx",
        "apps/*/test/**/*.ts",
    ]
    # harness dogfood: canonical Python + .mjs sources feed npm run check (vitest
    # imports harness-test/scripts; smoke:pack runs sync-harness.mjs).
    if (project / "harness").is_dir():
        inputs.extend(
            [
                "harness/scripts/*.py",
                "harness/harness-knowledge-ingest/scripts/*.py",
                "harness/harness-test/scripts/*.mjs",
                "harness/harness-test/scripts/tests/*.mjs",
                "scripts/*.mjs",
            ]
        )
    return {
        "unitTestFull": {
            "command": full_cmd,
            "argvTemplate": full_cmd.split(),
            "scope": "full",
            "inputs": inputs,
            "coverage": "unitTestFull",
            "source": "detected",
            "basis": {"packageScript": script_key},
        }
    }


def empty_profile_skeleton(excluded: tuple[str, ...] | list[str]) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "detectedAt": "",
        "projectType": "unknown",
        "toolPaths": {"node": "", "mvn": ""},
        "excludedRoots": list(excluded),
        "commands": {},
        # 兼容字段：cluster 2 升级 ledger 后由 commands 派生；期间保持 v1 可消费。
        "verificationInputs": {},
        "serviceStart": {
            "command": "",
            "healthUrl": "",
            "startTimeoutSec": 120,
            "inputFiles": [],
            "source": "detected",
            "profile": "",
            "overlayPath": "",
        },
        "identifier": {
            "pattern": r"^[A-Za-z][A-Za-z0-9_-]*$",
            "maxLength": 64,
            "prefix": "",
        },
        "knownPreexistingErrors": [],
        "shellQuirks": [],
        "fingerprint": {"mvnVersion": "", "nodeVersion": "", "pomHash": ""},
        "testTracking": {
            "source": "detected",
            "mode": "force-track-touched",
            "paths": [],
            "staleTestPolicy": "safe-repair",
            "forbidTemporaryExclusion": True,
        },
    }


def load_profile(project: Path) -> dict[str, Any] | None:
    path = project / PROFILE_REL
    if not path.is_file():
        return None
    try:
        data = read_json(path)
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _merge_user_overrides(
    profile: dict[str, Any], existing: dict[str, Any] | None
) -> None:
    """只保留 source=user 的 command 覆写；detected 字段每次 fresh 重建。

    spec §3.1：user override 显式 source=user 才永久保留；detected basis 过期自动重探测。
    v1 profile 无 provenance 字段，buildCommands 不当 user override 保留（由 migrate 报告）。
    """
    if not existing:
        return
    cmds = existing.get("commands")
    if isinstance(cmds, dict):
        for key, cmd in cmds.items():
            if isinstance(cmd, dict) and cmd.get("source") == "user":
                profile["commands"][key] = dict(cmd)
    if isinstance(existing.get("knownPreexistingErrors"), list):
        profile["knownPreexistingErrors"] = list(existing["knownPreexistingErrors"])
    if isinstance(existing.get("shellQuirks"), list):
        profile["shellQuirks"] = list(existing["shellQuirks"])
    test_tracking = existing.get("testTracking")
    if isinstance(test_tracking, dict) and test_tracking.get("source") == "user":
        profile["testTracking"] = dict(test_tracking)
    # 兼容字段：用户在 v1 配置的 verificationInputs 不保留（无 provenance），
    # 由 commands 重新派生。knownPreexistingErrors/shellQuirks 是人工标注，保留。


def _derive_verification_inputs(profile: dict[str, Any]) -> None:
    """从 commands 派生 verificationInputs.<key>，兼容 ledger v1 消费。"""
    cmds = profile.get("commands") or {}
    vi: dict[str, list[str]] = {}
    for key, cmd in cmds.items():
        if isinstance(cmd, dict) and isinstance(cmd.get("inputs"), list):
            vi[key] = list(cmd["inputs"])
    profile["verificationInputs"] = vi


def detect(project: Path) -> dict[str, Any]:
    project = project.resolve()
    existing = load_profile(project)
    excluded = DEFAULT_EXCLUDED_ROOTS
    project_type = detect_project_type(project)

    profile = empty_profile_skeleton(excluded)
    profile["projectType"] = project_type
    profile["detectedAt"] = now_iso()

    node_path = which_tool("node")
    mvn_path = which_tool("mvn")
    profile["toolPaths"] = {"node": node_path, "mvn": mvn_path}

    pom_hash = sha256_file(project / "pom.xml") if (project / "pom.xml").is_file() else ""
    profile["fingerprint"] = {"mvnVersion": "", "nodeVersion": "", "pomHash": pom_hash}

    if project_type == "java-maven":
        reactor_modules = find_reactor_modules(project, excluded)
        if reactor_modules:
            profile["commands"] = _java_commands(reactor_modules, pom_hash)
            profile["testTracking"]["paths"] = sorted(
                "src/test/**" if module == "." else f"{module}/src/test/**"
                for module in reactor_modules
            )
    elif project_type == "node":
        node_cmds = _node_commands(project)
        if node_cmds:
            profile["commands"] = node_cmds
        profile["testTracking"]["paths"] = [
            pattern
            for extension in ("js", "jsx", "ts", "tsx", "mjs", "cjs")
            for pattern in (
                f"apps/*/test/**/*.{extension}",
                f"apps/*/tests/**/*.{extension}",
                f"packages/*/test/**/*.{extension}",
                f"packages/*/tests/**/*.{extension}",
                f"test/**/*.{extension}",
                f"tests/**/*.{extension}",
                f"**/*.test.{extension}",
                f"**/*.spec.{extension}",
            )
        ]

    _merge_user_overrides(profile, existing)
    _derive_verification_inputs(profile)

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


# ---------------------------------------------------------------------------
# check（missing/invalid/stale/ready）
# ---------------------------------------------------------------------------

def check(project: Path) -> dict[str, Any]:
    project = project.resolve()
    path = project / PROFILE_REL
    hint = "python harness_profile.py detect --project <root> --json"

    if not path.is_file():
        return {
            "ok": False,
            "action": "check",
            "project": str(project),
            "status": "missing",
            "stale": True,
            "issues": ["build-profile.json missing; run detect"],
            "hint": hint,
        }

    try:
        profile = read_json(path)
    except (OSError, json.JSONDecodeError) as exc:
        return {
            "ok": False,
            "action": "check",
            "project": str(project),
            "status": "invalid",
            "stale": True,
            "issues": [f"build-profile.json unreadable: {exc}"],
            "hint": hint,
        }
    if not isinstance(profile, dict):
        return {
            "ok": False,
            "action": "check",
            "project": str(project),
            "status": "invalid",
            "stale": True,
            "issues": ["build-profile.json is not an object"],
            "hint": hint,
        }
    if profile.get("schemaVersion") != SCHEMA_VERSION:
        return {
            "ok": False,
            "action": "check",
            "project": str(project),
            "status": "invalid",
            "stale": True,
            "issues": [
                f"schemaVersion={profile.get('schemaVersion')} != {SCHEMA_VERSION}; run migrate"
            ],
            "hint": "python harness_profile.py migrate --project <root> --apply --json",
        }

    issues: list[str] = []
    stale = False

    fp = profile.get("fingerprint") or {}
    stored_pom = fp.get("pomHash") or "" if isinstance(fp, dict) else ""
    current_pom = sha256_file(project / "pom.xml") if (project / "pom.xml").is_file() else ""
    if stored_pom != current_pom:
        stale = True
        issues.append(
            f"fingerprint.pomHash changed: stored={stored_pom or '(empty)'} "
            f"current={current_pom or '(empty)'}"
        )

    # toolPaths 失效检查（空允许，路径不存在则 stale）
    tool_paths = profile.get("toolPaths") or {}
    if isinstance(tool_paths, dict):
        for tool_name in ("node", "mvn"):
            p = tool_paths.get(tool_name) or ""
            if p and not Path(p).exists():
                stale = True
                issues.append(f"toolPaths.{tool_name} missing: {p}")

    status = "stale" if stale else "ready"
    return {
        "ok": not stale,
        "action": "check",
        "project": str(project),
        "status": status,
        "stale": stale,
        "issues": issues,
    }


# ---------------------------------------------------------------------------
# validate_profile（路径逃逸 + excluded root）
# ---------------------------------------------------------------------------

def validate_profile(profile: dict[str, Any], project: Path) -> list[str]:
    issues: list[str] = []
    excluded = tuple(profile.get("excludedRoots") or DEFAULT_EXCLUDED_ROOTS)
    commands = profile.get("commands") or {}
    for key, cmd in commands.items():
        if not isinstance(cmd, dict):
            continue
        for inp in cmd.get("inputs") or []:
            if not isinstance(inp, str) or not inp.strip():
                continue
            segments = inp.split("/")
            if ".." in segments:
                issues.append(
                    f"command {key} input escapes project root: {inp}"
                )
            elif is_path_excluded(inp, excluded):
                issues.append(
                    f"command {key} input in excluded root: {inp}"
                )
    return issues


# ---------------------------------------------------------------------------
# resolve_command（运行期占位替换，不写回持久 profile）
# ---------------------------------------------------------------------------

def resolve_command(
    profile: dict[str, Any],
    key: str,
    *,
    test_classes: list[str] | None = None,
    modules: list[str] | None = None,
) -> dict[str, Any]:
    cmd = (profile.get("commands") or {}).get(key)
    if not isinstance(cmd, dict):
        raise KeyError(f"command '{key}' not found in profile")
    replacements: dict[str, str] = {}
    if test_classes is not None:
        replacements["{testClasses}"] = ",".join(test_classes)
    if modules is not None:
        replacements["{modules}"] = ",".join(modules)

    command = cmd.get("command", "")
    for placeholder, val in replacements.items():
        command = command.replace(placeholder, val)

    argv: list[str] = []
    for tok in cmd.get("argvTemplate") or []:
        for placeholder, val in replacements.items():
            tok = tok.replace(placeholder, val)
        argv.append(tok)

    return {
        "command": command,
        "argv": argv,
        "scope": cmd.get("scope"),
        "inputs": cmd.get("inputs"),
        "coverage": cmd.get("coverage"),
        "source": cmd.get("source"),
    }


# ---------------------------------------------------------------------------
# migrate（v1 → v2，dry-run/apply/备份）
# ---------------------------------------------------------------------------

def _backup_path(profile_path: Path) -> Path:
    return profile_path.with_suffix(profile_path.suffix + ".v1.bak")


def migrate(project: Path, *, dry_run: bool = True) -> dict[str, Any]:
    project = project.resolve()
    profile_path = project / PROFILE_REL

    if not profile_path.is_file():
        return {
            "ok": True,
            "action": "migrate",
            "dry_run": dry_run,
            "needsMigration": False,
            "reason": "no profile to migrate",
        }

    try:
        existing = read_json(profile_path)
    except (OSError, json.JSONDecodeError) as exc:
        return {
            "ok": False,
            "action": "migrate",
            "dry_run": dry_run,
            "needsMigration": False,
            "error": f"profile unreadable: {exc}",
        }
    if not isinstance(existing, dict):
        return {
            "ok": False,
            "action": "migrate",
            "dry_run": dry_run,
            "needsMigration": False,
            "error": "profile is not an object",
        }

    sv = existing.get("schemaVersion")
    if sv == SCHEMA_VERSION:
        return {
            "ok": True,
            "action": "migrate",
            "dry_run": dry_run,
            "needsMigration": False,
            "reason": f"already schemaVersion {SCHEMA_VERSION}",
        }
    if sv != 1:
        return {
            "ok": False,
            "action": "migrate",
            "dry_run": dry_run,
            "needsMigration": False,
            "error": f"unsupported schemaVersion: {sv}",
        }

    # v1 → v2 迁移清单
    changes = [
        f"schemaVersion 1 → {SCHEMA_VERSION}",
        "buildCommands → commands（含 argvTemplate/scope/inputs/coverage/source/basis）",
        "excludedRoots 显式声明（.git/.harness/worktrees/target/build/node_modules/...）",
        "identifier 约束（pattern/maxLength/prefix）",
    ]
    dropped: list[str] = []
    v1_svc = existing.get("serviceStart") or {}
    if isinstance(v1_svc, dict):
        # 具体 worktree/change 路径必须清除（不属于持久 profile 模板）
        for field in ("profile", "overlayPath"):
            val = v1_svc.get(field, "")
            if isinstance(val, str) and val.strip():
                dropped.append(f"serviceStart.{field}={val!r}（具体路径，已清除）")
        # 用户配置的服务命令/healthUrl 无 provenance，记录待确认（COM-007）
        for field in ("command", "healthUrl"):
            val = v1_svc.get(field, "")
            if isinstance(val, str) and val.strip():
                dropped.append(f"serviceStart.{field}（无 provenance，已备份；请用 record-quirk 重配）")

    if dry_run:
        return {
            "ok": True,
            "action": "migrate",
            "dry_run": True,
            "needsMigration": True,
            "changes": changes,
            "droppedFields": dropped,
            "profilePath": str(profile_path),
        }

    # apply：先备份原 v1（不覆盖已有备份），再重新 detect 生成 v2
    backup = _backup_path(profile_path)
    if not backup.is_file():
        backup.write_text(profile_path.read_text(encoding="utf-8-sig"), encoding="utf-8", newline="\n")
    detect(project)
    return {
        "ok": True,
        "action": "migrate",
        "dry_run": False,
        "needsMigration": False,
        "changes": changes,
        "droppedFields": dropped,
        "backupPath": str(backup),
        "profilePath": str(profile_path),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="harness_profile.py",
        description="Harness profile v2: detect/check/validate/resolve/migrate",
    )
    parser.add_argument("--json", action="store_true", help="emit JSON")
    sub = parser.add_subparsers(dest="command", required=True)

    p_detect = sub.add_parser("detect", help="probe and write build-profile.json")
    p_detect.add_argument("--project", required=True, type=Path)
    p_detect.add_argument("--json", action="store_true")

    p_check = sub.add_parser("check", help="missing/invalid/stale/ready")
    p_check.add_argument("--project", required=True, type=Path)
    p_check.add_argument("--json", action="store_true")

    p_validate = sub.add_parser("validate", help="validate profile containment")
    p_validate.add_argument("--project", required=True, type=Path)
    p_validate.add_argument("--json", action="store_true")

    p_resolve = sub.add_parser(
        "resolve", help="resolve command template by key (runtime placeholder substitution)"
    )
    p_resolve.add_argument("--project", required=True, type=Path)
    p_resolve.add_argument("--key", required=True, help="command key in profile.commands")
    p_resolve.add_argument(
        "--test-classes",
        default=None,
        help="comma-separated test classes substituting {testClasses}",
    )
    p_resolve.add_argument(
        "--modules",
        default=None,
        help="comma-separated modules substituting {modules}",
    )
    p_resolve.add_argument("--json", action="store_true")

    p_migrate = sub.add_parser("migrate", help="migrate v1 → v2")
    p_migrate.add_argument("--project", required=True, type=Path)
    p_migrate.add_argument("--apply", action="store_true", help="apply (default: dry-run)")
    p_migrate.add_argument("--json", action="store_true")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    as_json = bool(getattr(args, "json", False))

    if args.command == "detect":
        result = detect(args.project)
        sys.stdout.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        return 0 if result.get("ok") else 1
    if args.command == "check":
        result = check(args.project)
        sys.stdout.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        return 0 if result.get("ok") and not result.get("stale") else 1
    if args.command == "validate":
        profile = load_profile(args.project.resolve())
        if profile is None:
            payload = {"ok": False, "issues": ["profile missing"]}
        else:
            issues = validate_profile(profile, args.project.resolve())
            payload = {"ok": not issues, "issues": issues}
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        return 0 if payload["ok"] else 1
    if args.command == "resolve":
        project = args.project.resolve()
        profile = load_profile(project)
        if profile is None:
            sys.stdout.write(
                json.dumps({"ok": False, "error": "profile missing"}, ensure_ascii=False) + "\n"
            )
            return 1
        test_classes = (
            [item for item in args.test_classes.split(",") if item]
            if args.test_classes
            else None
        )
        modules = (
            [item for item in args.modules.split(",") if item] if args.modules else None
        )
        try:
            resolved = resolve_command(
                profile, args.key, test_classes=test_classes, modules=modules
            )
        except KeyError as exc:
            sys.stdout.write(
                json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False) + "\n"
            )
            return 1
        payload = {"ok": True, "key": args.key, **resolved}
        sys.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        return 0
    if args.command == "migrate":
        result = migrate(args.project, dry_run=not args.apply)
        sys.stdout.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        return 0 if result.get("ok") else 1

    parser.error(f"unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
