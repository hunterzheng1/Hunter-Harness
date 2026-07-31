#!/usr/bin/env python3
"""Harness profile v3 — module/command/verification graph resolver, recommender and migrator.

Change cluster 1 of harness-deterministic-performance.

Spec §3.1：每个 verification 声明 command/argvTemplate/scope/inputs/coverage/
source/basis；持久 profile 只保存模板，不含具体 change-name/worktree 路径或已解析
overlay；运行期 resolve 结果写入 change runtime/session。

兼容性：保留顶层 `verificationInputs`（派生自 commands.<key>.inputs）供旧调用方
展开输入闭包；`verificationGraph.targets` 是动态验证目标的权威声明。

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

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

import harness_paths  # noqa: E402


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


SCHEMA_VERSION = 3
PROFILE_REL = Path(".harness") / "config" / "build-profile.json"


def recommend(project: Path) -> dict[str, Any]:
    """Return a reviewable profile recommendation without writing it."""
    project = Path(project).resolve()
    project_type = detect_project_type(project)
    modules: list[dict[str, Any]] = []
    targets: list[dict[str, Any]] = []
    if project_type == "java-maven":
        reactor = [item for item in find_reactor_modules(project, DEFAULT_EXCLUDED_ROOTS) if item != "."]
        modules = [
            {
                "id": module,
                "path": module,
                "type": "java-maven",
                "ownedPaths": [f"{module}/src/**", f"{module}/pom.xml"],
                "dependsOn": [],
            }
            for module in sorted(reactor)
        ]
        if modules:
            targets.append(
                {
                    "id": "unitTest-module",
                    "verification": "unitTestFull",
                    "level": "module",
                    "command": "mvn test -pl {modules} -am -o",
                    "inputs": [f"{module['path']}/src/**" for module in modules],
                    "sharedConsumer": False,
                }
            )
        targets.append(
            {
                "id": "unitTest-candidate",
                "verification": "unitTestFull",
                "level": "candidate",
                "command": "mvn -f pom.xml test -o",
                "inputs": ["pom.xml", "**/src/**"],
                "sharedConsumer": True,
            }
        )
    elif project_type == "node":
        try:
            package = read_json(project / "package.json")
        except (OSError, json.JSONDecodeError):
            package = {}
        workspaces = package.get("workspaces", []) if isinstance(package, dict) else []
        if isinstance(workspaces, dict):
            workspaces = workspaces.get("packages", [])
        paths: set[str] = set()
        for pattern in workspaces if isinstance(workspaces, list) else []:
            for match in project.glob(str(pattern)):
                if match.is_dir() and (match / "package.json").is_file():
                    paths.add(match.relative_to(project).as_posix())
        modules = [
            {
                "id": path.replace("/", "-"),
                "path": path,
                "type": "node-workspace",
                "ownedPaths": [f"{path}/src/**", f"{path}/test/**"],
                "dependsOn": [],
            }
            for path in sorted(paths)
        ]
        targets.extend(
            {
                "id": f"{module['id']}-test",
                "verification": "unitTest",
                "level": "module",
                "command": f"npm test -w {module['path']}",
                "inputs": module["ownedPaths"],
                "sharedConsumer": False,
            }
            for module in modules
        )
        node_commands = _node_commands(project)
        if "unitTestFull" in node_commands:
            targets.append(
                {
                    "id": "workspace-candidate",
                    "verification": "unitTestFull",
                    "level": "candidate",
                    "command": node_commands["unitTestFull"]["command"],
                    "inputs": node_commands["unitTestFull"]["inputs"],
                    "sharedConsumer": True,
                }
            )
    boundaries_proven = bool(modules) or project_type in {"node", "java-maven"}
    return {
        "ok": True,
        "code": "PROFILE_RECOMMENDED",
        "schemaVersion": SCHEMA_VERSION,
        "projectType": project_type,
        "modules": modules,
        "targets": targets,
        "moduleGraph": {
            "modules": modules,
            "boundariesProven": boundaries_proven,
            "needsReview": not boundaries_proven,
        },
        "needsReview": not boundaries_proven,
        "applied": False,
    }


def project_profile_v3(profile: dict[str, Any]) -> dict[str, Any]:
    """Compatibility projection for review before a protected v3 update."""
    projected = json.loads(json.dumps(profile))
    source_version = projected.get("schemaVersion")
    if source_version == SCHEMA_VERSION:
        return projected
    if source_version != 2:
        return projected
    projected["schemaVersion"] = SCHEMA_VERSION
    commands = projected.get("commands") if isinstance(projected.get("commands"), dict) else {}
    legacy_verification_inputs = {
        key: list(patterns)
        for key, patterns in (
            projected.get("verificationInputs")
            if isinstance(projected.get("verificationInputs"), dict)
            else {}
        ).items()
        if isinstance(key, str) and isinstance(patterns, list)
    }
    projected.setdefault(
        "moduleGraph",
        {"modules": [], "boundariesProven": False, "needsReview": True},
    )
    projected["commandGraph"] = {
        "targets": [
            {
                "id": key,
                "verification": key,
                "command": command.get("command"),
                "scope": command.get("scope"),
                "inputs": list(command.get("inputs") or []),
                "coverage": command.get("coverage"),
                "source": command.get("source"),
            }
            for key, command in sorted(commands.items())
            if isinstance(command, dict)
        ]
    }
    projected["migration"] = {
        "fromSchemaVersion": 2,
        "projected": True,
        "needsReview": True,
        "protectedUserCommands": sorted(
            key
            for key, command in commands.items()
            if isinstance(command, dict) and command.get("source") == "user"
        ),
    }
    projected["defaultsFingerprint"] = profile_defaults_fingerprint()
    _derive_verification_inputs(projected)
    projected["verificationInputs"] = {
        **legacy_verification_inputs,
        **projected["verificationInputs"],
    }
    _derive_verification_graph(projected)
    return projected


def audit_profile(project: Path) -> dict[str, Any]:
    path = Path(project).resolve() / PROFILE_REL
    if not path.is_file():
        return {
            "ok": False,
            "code": "PROFILE_MISSING",
            "needsReview": True,
            "issues": ["build-profile.json missing"],
        }
    try:
        profile = read_json(path)
    except (OSError, json.JSONDecodeError) as exc:
        return {
            "ok": False,
            "code": "PROFILE_INVALID",
            "needsReview": True,
            "issues": [str(exc)],
        }
    issues: list[str] = []
    if profile.get("schemaVersion") != SCHEMA_VERSION:
        issues.append("profile schema requires migration")
    module_graph = profile.get("moduleGraph")
    if not isinstance(module_graph, dict) or module_graph.get("boundariesProven") is not True:
        issues.append("module boundaries are not proven")
    if not isinstance(profile.get("commandGraph"), dict):
        issues.append("command graph missing")
    needs_review = bool(issues)
    return {
        "ok": not needs_review,
        "code": "PROFILE_REVIEW_REQUIRED" if needs_review else "PROFILE_AUDITED",
        "needsReview": needs_review,
        "issues": issues,
    }

# 排除策略（spec §3.1）：所有路径必须位于 project root，排除以下目录。
# 兄弟 worktree、构建产物、依赖目录、缓存一律不进入 verification inputs。
DEFAULT_EXCLUDED_ROOTS: tuple[str, ...] = (
    ".git",
    ".harness",
    ".worktrees",
    ".claude/worktrees",
    ".codex/worktrees",
    ".cursor/worktrees",
    ".codebuddy/worktrees",
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


def profile_defaults_fingerprint() -> str:
    """Fingerprint generated defaults so old profiles are refreshed safely."""
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "excludedRoots": list(DEFAULT_EXCLUDED_ROOTS),
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"

# 覆盖层级（spec §3.2）：unitTest ⊂ unitTestFull；package 独立；submit 复用 unitTestFull。
VERIFICATION_KEYS: tuple[str, ...] = (
    "compile",
    "unitTest",
    "unitTestFull",
    "install",
    "package",
)

VALID_SOURCES = ("detected", "user")
TARGET_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")


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
    if any(
        (project / marker).is_file()
        for marker in (
            "build.gradle",
            "build.gradle.kts",
            "settings.gradle",
            "settings.gradle.kts",
        )
    ):
        return "java-gradle"
    if (project / "package.json").is_file():
        return "node"
    return "unknown"


def discover_nested_components(
    project: Path, excluded: tuple[str, ...] | list[str]
) -> list[str]:
    """Return deterministic type:path labels for supported nested projects."""
    markers = {
        "pyproject.toml": "python",
        "package.json": "node",
        "pom.xml": "java-maven",
        "build.gradle": "java-gradle",
        "build.gradle.kts": "java-gradle",
    }
    found: list[tuple[str, str]] = []
    for marker, kind in markers.items():
        for path in project.rglob(marker):
            if not path.is_file():
                continue
            rel = path.relative_to(project)
            if rel.parent == Path(".") or is_path_excluded(rel.as_posix(), excluded):
                continue
            found.append((rel.parent.as_posix(), kind))
    return [f"{kind}:{rel}" for rel, kind in sorted(set(found))]


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
            "dependsOn": [],
            "requiredCapabilities": ["java", "maven"],
            "source": "detected",
            "basis": dict(basis),
        },
        "unitTest": {
            "command": "mvn -f pom.xml test -Dtest={testClasses} -o",
            "argvTemplate": ["mvn", "-f", "pom.xml", "test", "-Dtest={testClasses}", "-o"],
            "scope": "incremental",
            "inputs": _cmd_inputs(reactor_modules, pom=True, main=False, test=True),
            "coverage": "unitTest",
            "dependsOn": ["compile"],
            "requiredCapabilities": ["java", "maven"],
            "source": "detected",
            "basis": dict(basis),
        },
        "unitTestFull": {
            "command": "mvn -f pom.xml test -o",
            "argvTemplate": ["mvn", "-f", "pom.xml", "test", "-o"],
            "scope": "full",
            "inputs": full_inputs,
            "coverage": "unitTestFull",
            "dependsOn": ["compile"],
            "requiredCapabilities": ["java", "maven"],
            "source": "detected",
            "basis": dict(basis),
        },
        "install": {
            "command": "mvn install -pl {modules} -am -DskipTests -nsu",
            "argvTemplate": ["mvn", "install", "-pl", "{modules}", "-am", "-DskipTests", "-nsu"],
            "scope": "module-am",
            "inputs": _cmd_inputs(reactor_modules, pom=True, main=False, test=False),
            "coverage": "install",
            "dependsOn": ["compile"],
            "requiredCapabilities": ["java", "maven"],
            "source": "detected",
            "basis": dict(basis),
        },
        "package": {
            "command": "mvn -f pom.xml clean package '-Dmaven.test.skip=true'",
            "argvTemplate": ["mvn", "-f", "pom.xml", "clean", "package", "-Dmaven.test.skip=true"],
            "scope": "module",
            "inputs": _cmd_inputs(reactor_modules, pom=True, main=True, test=True),
            "coverage": "package",
            "dependsOn": ["compile"],
            "requiredCapabilities": ["java", "maven"],
            "source": "detected",
            "basis": dict(basis),
        },
    }


def _gradle_commands(project: Path) -> dict[str, Any]:
    if (project / "gradlew").is_file():
        executable = "./gradlew"
        required_capabilities = ["java"]
    elif (project / "gradlew.bat").is_file():
        executable = "gradlew.bat"
        required_capabilities = ["java"]
    else:
        executable = "gradle"
        required_capabilities = ["java", "gradle"]
    build_inputs = [
        "build.gradle",
        "build.gradle.kts",
        "settings.gradle",
        "settings.gradle.kts",
        "gradle.properties",
        "gradle/wrapper/**",
        "gradlew",
        "gradlew.bat",
    ]
    full_inputs = build_inputs + ["src/main/**", "src/test/**"]
    basis = {
        "buildSystem": "gradle",
        "wrapper": executable != "gradle",
    }

    def command(
        task: str,
        *,
        scope: str,
        inputs: list[str],
        coverage: str,
        depends_on: list[str],
        extra: list[str] | None = None,
    ) -> dict[str, Any]:
        argv = [executable, task, *(extra or []), "--offline"]
        return {
            "command": " ".join(argv),
            "argvTemplate": argv,
            "scope": scope,
            "inputs": inputs,
            "coverage": coverage,
            "dependsOn": depends_on,
            "requiredCapabilities": list(required_capabilities),
            "source": "detected",
            "basis": dict(basis),
        }

    return {
        "compile": command(
            "classes",
            scope="module",
            inputs=build_inputs + ["src/main/**"],
            coverage="compile",
            depends_on=[],
        ),
        "unitTest": command(
            "test",
            scope="incremental",
            inputs=build_inputs + ["src/main/**", "src/test/**"],
            coverage="unitTest",
            depends_on=["compile"],
            extra=["--tests", "{testClasses}"],
        ),
        "unitTestFull": command(
            "test",
            scope="full",
            inputs=full_inputs,
            coverage="unitTestFull",
            depends_on=["compile"],
        ),
        "package": command(
            "build",
            scope="module",
            inputs=full_inputs,
            coverage="package",
            depends_on=["compile"],
            extra=["-x", "test"],
        ),
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
    declared_package_manager = data.get("packageManager")
    package_manager = (
        "pnpm"
        if (
            isinstance(declared_package_manager, str)
            and declared_package_manager.split("@", 1)[0] == "pnpm"
        )
        or (project / "pnpm-lock.yaml").is_file()
        else "npm"
    )
    # Precise globs (avoid node_modules/** which would make the inputs hash unstable).
    inputs = [
        "package.json",
        "package-lock.json",
        "pnpm-lock.yaml",
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
            "dependsOn": [],
            "requiredCapabilities": ["node", package_manager],
            "source": "detected",
            "basis": {
                "packageScript": script_key,
                "packageManager": package_manager,
            },
        }
    }


def empty_profile_skeleton(excluded: tuple[str, ...] | list[str]) -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "defaultsFingerprint": profile_defaults_fingerprint(),
        "detectedAt": "",
        "projectType": "unknown",
        "toolPaths": {"node": "", "mvn": "", "gradle": "", "npm": "", "pnpm": ""},
        "excludedRoots": list(excluded),
        "commands": {},
        # 兼容字段：由 commands 派生，供旧调用方展开输入闭包。
        "verificationInputs": {},
        "verificationGraph": {
            "schemaVersion": 1,
            "source": "detected",
            "candidateTarget": None,
            "targets": {},
        },
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
    """C7: 分层读取 — 先读 common_root 的 build-profile.json，再叠加 execution root 的 override。

    common_root 是 worktree 共享的主项目根（git common dir 的父目录）；
    execution root 是当前工作目录（可能是 linked worktree）。
    override 合并策略：execution 的 buildCommands 覆盖 common 的同名 key；
    common 独有的 key 保留。
    """
    project = Path(project).resolve()
    common = harness_paths.common_root(project)
    common_path = common / PROFILE_REL
    exec_path = project / PROFILE_REL

    common_data: dict[str, Any] | None = None
    if common_path.is_file():
        try:
            data = read_json(common_path)
            if isinstance(data, dict):
                common_data = data
        except (OSError, json.JSONDecodeError):
            pass

    exec_data: dict[str, Any] | None = None
    if exec_path.is_file():
        try:
            data = read_json(exec_path)
            if isinstance(data, dict):
                exec_data = data
        except (OSError, json.JSONDecodeError):
            pass

    if common_data is not None and common_data.get("schemaVersion") == 2:
        common_data = project_profile_v3(common_data)
    if exec_data is not None and exec_data.get("schemaVersion") == 2:
        exec_data = project_profile_v3(exec_data)
    if common_data is None and exec_data is None:
        return None
    if common_data is None:
        return exec_data
    if exec_data is None:
        return common_data

    # Merge: start from common, overlay execution's current commands.
    merged = dict(common_data)
    common_current = common_data.get("commands") or {}
    exec_current = exec_data.get("commands") or {}
    if common_current or exec_current:
        merged_current = (
            dict(common_current) if isinstance(common_current, dict) else {}
        )
        if isinstance(exec_current, dict):
            merged_current.update(exec_current)
        merged["commands"] = merged_current
    # Legacy v1 aliases remain readable during migration.
    common_cmds = common_data.get("buildCommands") or {}
    exec_cmds = exec_data.get("buildCommands") or {}
    if common_cmds or exec_cmds:
        merged_cmds = dict(common_cmds) if isinstance(common_cmds, dict) else {}
        if isinstance(exec_cmds, dict):
            merged_cmds.update(exec_cmds)
        merged["buildCommands"] = merged_cmds
    if isinstance(merged.get("commands"), dict):
        _derive_verification_inputs(merged)
    for field in ("moduleGraph", "commandGraph", "migration"):
        if field in exec_data:
            merged[field] = exec_data[field]
    exec_graph = exec_data.get("verificationGraph")
    if isinstance(exec_graph, dict):
        merged["verificationGraph"] = dict(exec_graph)
    return merged


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
    graph = existing.get("verificationGraph")
    if isinstance(graph, dict) and graph.get("source") == "user":
        profile["verificationGraph"] = dict(graph)
    # verificationInputs 由 commands 重新派生。knownPreexistingErrors /
    # shellQuirks 是人工标注，保留。


def _derive_verification_inputs(profile: dict[str, Any]) -> None:
    """从 commands 派生 verificationInputs.<key>，兼容 ledger v1 消费。"""
    cmds = profile.get("commands") or {}
    vi: dict[str, list[str]] = {}
    for key, cmd in cmds.items():
        if isinstance(cmd, dict) and isinstance(cmd.get("inputs"), list):
            vi[key] = list(cmd["inputs"])
    profile["verificationInputs"] = vi


def _required_coverage(scope: Any) -> str:
    value = str(scope or "").strip()
    if value == "incremental":
        return "incremental"
    if value == "module-am":
        return "module-am"
    if value in {"module", "full"}:
        # A full command may satisfy the module-or-broader candidate gate.
        return "module"
    return "module"


def _derive_verification_graph(profile: dict[str, Any]) -> None:
    existing = profile.get("verificationGraph")
    if isinstance(existing, dict) and existing.get("source") == "user":
        return
    commands = profile.get("commands")
    targets: dict[str, dict[str, Any]] = {}
    if isinstance(commands, dict):
        for key, command in sorted(commands.items()):
            if not isinstance(key, str) or not TARGET_NAME.fullmatch(key):
                continue
            if not isinstance(command, dict):
                continue
            depends_on = command.get("dependsOn")
            if not isinstance(depends_on, list):
                depends_on = []
            required_capabilities = command.get("requiredCapabilities")
            if not isinstance(required_capabilities, list):
                required_capabilities = []
            targets[key] = {
                "id": key,
                "commandKey": key,
                "argvTemplate": list(command.get("argvTemplate") or []),
                "inputs": list(command.get("inputs") or []),
                "coverage": command.get("coverage"),
                "coverageLevel": str(command.get("scope") or "module"),
                "dependsOn": [
                    item
                    for item in depends_on
                    if isinstance(item, str) and TARGET_NAME.fullmatch(item)
                ],
                "requiredCoverage": _required_coverage(command.get("scope")),
                "candidate": key == "unitTestFull",
                "requiredCapabilities": [
                    item
                    for item in required_capabilities
                    if isinstance(item, str) and item.strip()
                ],
                "resourceLocks": [],
                "estimatedDurationSeconds": 0,
                "requiresFrozenIdentity": key == "unitTestFull",
                "reusePolicy": "ledger-exact",
            }
    profile["verificationGraph"] = {
        "schemaVersion": 1,
        "source": "detected",
        "candidateTarget": (
            "unitTestFull" if "unitTestFull" in targets else None
        ),
        "targets": targets,
    }


def detect(project: Path) -> dict[str, Any]:
    project = project.resolve()
    existing = load_profile(project)
    excluded = DEFAULT_EXCLUDED_ROOTS
    project_type = detect_project_type(project)
    components = discover_nested_components(project, excluded)
    component_types = {item.split(":", 1)[0] for item in components}
    if project_type != "unknown":
        component_types.add(project_type)
    if (project_type == "unknown" and components) or len(component_types) > 1:
        return {
            "ok": False,
            "code": "DETECTION_AMBIGUOUS",
            "action": "detect",
            "project": str(project),
            "profilePath": str(project / PROFILE_REL),
            "applied": False,
            "detectedComponents": components,
            "message": "multiple or nested project components require an explicit profile",
        }
    if project_type == "unknown" and existing:
        return {
            "ok": False,
            "code": "DETECTION_INCONCLUSIVE",
            "action": "detect",
            "project": str(project),
            "profilePath": str(project / PROFILE_REL),
            "applied": False,
            "detectedComponents": [],
            "message": "detection was inconclusive; existing profile was preserved",
        }

    profile = empty_profile_skeleton(excluded)
    profile["projectType"] = project_type
    profile["detectedAt"] = now_iso()

    node_path = which_tool("node")
    mvn_path = which_tool("mvn")
    profile["toolPaths"] = {
        "node": node_path,
        "mvn": mvn_path,
        "gradle": which_tool("gradle"),
        "npm": which_tool("npm"),
        "pnpm": which_tool("pnpm"),
    }

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
    elif project_type == "java-gradle":
        profile["commands"] = _gradle_commands(project)
        profile["testTracking"]["paths"] = ["src/test/**"]
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
    recommendation = recommend(project)
    profile["moduleGraph"] = recommendation["moduleGraph"]
    profile["commandGraph"] = {
        "targets": [
            {
                "id": key,
                "verification": key,
                "command": command.get("command"),
                "scope": command.get("scope"),
                "inputs": list(command.get("inputs") or []),
                "coverage": command.get("coverage"),
                "source": command.get("source"),
            }
            for key, command in sorted(profile["commands"].items())
            if isinstance(command, dict)
        ]
        + list(recommendation["targets"])
    }
    _derive_verification_graph(profile)

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
        "applied": True,
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

    expected_defaults_fingerprint = profile_defaults_fingerprint()
    if profile.get("defaultsFingerprint") != expected_defaults_fingerprint:
        stale = True
        issues.append(
            "defaultsFingerprint is missing or outdated; run detect to refresh generated defaults"
        )

    excluded_roots = {
        str(item).replace("\\", "/").strip("/")
        for item in (profile.get("excludedRoots") or [])
        if isinstance(item, str) and item.strip("/")
    }
    missing_excluded_roots = [
        item for item in DEFAULT_EXCLUDED_ROOTS if item not in excluded_roots
    ]
    if missing_excluded_roots:
        stale = True
        issues.append(
            "excludedRoots missing generated defaults: "
            + ", ".join(missing_excluded_roots)
        )

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

    structural_issues = validate_profile(profile, project)
    if structural_issues:
        stale = True
        issues.extend(structural_issues)

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
    graph = profile.get("verificationGraph")
    targets = graph.get("targets") if isinstance(graph, dict) else None
    if (
        not isinstance(graph, dict)
        or graph.get("schemaVersion") != 1
        or not isinstance(targets, dict)
    ):
        issues.append("verificationGraph schemaVersion=1 and targets object required")
        return issues
    dependencies: dict[str, list[str]] = {}
    for name, target in targets.items():
        if not isinstance(name, str) or not TARGET_NAME.fullmatch(name):
            issues.append(f"verification target name invalid: {name}")
            continue
        if not isinstance(target, dict):
            issues.append(f"verification target {name} must be an object")
            continue
        command_key = target.get("commandKey")
        if command_key not in commands:
            issues.append(
                f"verification target {name} references missing command {command_key}"
            )
        required = target.get("requiredCoverage")
        if required not in {"incremental", "module", "module-am", "full"}:
            issues.append(
                f"verification target {name} requiredCoverage invalid: {required}"
            )
        resource_locks = target.get("resourceLocks", [])
        if not isinstance(resource_locks, list) or any(
            not isinstance(item, str) or not item.strip()
            for item in resource_locks
        ):
            issues.append(
                f"verification target {name} resourceLocks must be non-empty strings"
            )
        estimated = target.get("estimatedDurationSeconds", 0)
        if (
            not isinstance(estimated, (int, float))
            or isinstance(estimated, bool)
            or estimated < 0
        ):
            issues.append(
                f"verification target {name} estimatedDurationSeconds invalid: {estimated}"
            )
        if target.get("reusePolicy", "ledger-exact") not in {
            "never",
            "identity-exact",
            "ledger-exact",
        }:
            issues.append(
                f"verification target {name} reusePolicy invalid"
            )
        raw_dependencies = target.get("dependsOn")
        if not isinstance(raw_dependencies, list):
            issues.append(f"verification target {name} dependsOn must be a list")
            continue
        dependencies[name] = []
        for dependency in raw_dependencies:
            if dependency not in targets:
                issues.append(
                    f"verification target {name} depends on unknown target {dependency}"
                )
            elif isinstance(dependency, str):
                dependencies[name].append(dependency)
    candidate = graph.get("candidateTarget")
    if candidate is not None and candidate not in targets:
        issues.append(f"verificationGraph candidateTarget missing: {candidate}")

    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(name: str) -> None:
        if name in visiting:
            issues.append(f"verification target dependency cycle at {name}")
            return
        if name in visited:
            return
        visiting.add(name)
        for dependency in dependencies.get(name, []):
            visit(dependency)
        visiting.remove(name)
        visited.add(name)

    for target_name in dependencies:
        visit(target_name)
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
    common_root: Path | None = None,
    execution_root: Path | None = None,
) -> dict[str, Any]:
    cmd = (profile.get("commands") or {}).get(key)
    if not isinstance(cmd, dict):
        raise KeyError(f"command '{key}' not found in profile")
    replacements: dict[str, str] = {}
    if test_classes is not None:
        replacements["{testClasses}"] = ",".join(test_classes)
    if modules is not None:
        replacements["{modules}"] = ",".join(modules)
    if common_root is not None:
        replacements["{commonRoot}"] = str(common_root)
    if execution_root is not None:
        replacements["{executionRoot}"] = str(execution_root)

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
# migrate（v1/v2 → v3，dry-run/apply/备份）
# ---------------------------------------------------------------------------

def _backup_path(profile_path: Path, schema_version: int) -> Path:
    return profile_path.with_suffix(
        profile_path.suffix + f".v{schema_version}.bak"
    )


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
    if sv not in {1, 2}:
        return {
            "ok": False,
            "action": "migrate",
            "dry_run": dry_run,
            "needsMigration": False,
            "error": f"unsupported schemaVersion: {sv}",
        }

    # v1/v2 → v3 迁移清单
    changes = [
        f"schemaVersion {sv} → {SCHEMA_VERSION}",
        "新增 moduleGraph（模块边界/owned paths/dependency）",
        "新增 commandGraph（dynamic verification targets）",
        "source=user 命令字节语义保持不变并列入 protectedUserCommands",
    ]
    if sv == 1:
        changes.extend(
            [
                "buildCommands → commands（含 argvTemplate/scope/inputs/coverage/source/basis）",
                "excludedRoots 显式声明（.git/.harness/worktrees/target/build/node_modules/...）",
                "identifier 约束（pattern/maxLength/prefix）",
            ]
        )
    changes.append("commands → verificationGraph.targets 动态验证图")
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
        projected = project_profile_v3(existing) if sv == 2 else None
        return {
            "ok": True,
            "code": "PROFILE_MIGRATION_PLANNED",
            "action": "migrate",
            "dry_run": True,
            "needsMigration": True,
            "changes": changes,
            "droppedFields": dropped,
            "profilePath": str(profile_path),
            "projectedProfile": projected,
            "protectedUserCommands": (
                projected.get("migration", {}).get("protectedUserCommands", [])
                if isinstance(projected, dict)
                else []
            ),
        }

    # apply：先备份旧 profile。v2 结构兼容投影，不重新 detect，避免覆盖 user command。
    backup = _backup_path(profile_path, int(sv))
    if not backup.is_file():
        backup.write_text(profile_path.read_text(encoding="utf-8-sig"), encoding="utf-8", newline="\n")
    if sv == 2:
        projected = project_profile_v3(existing)
        projected.setdefault("migration", {})["appliedAt"] = now_iso()
        write_json(profile_path, projected)
    else:
        detect(project)
    return {
        "ok": True,
        "code": "PROFILE_MIGRATED",
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
        description="Harness Build Profile v3: recommend/detect/audit/validate/resolve/migrate",
    )
    parser.add_argument("--json", action="store_true", help="emit JSON")
    sub = parser.add_subparsers(dest="command", required=True)

    p_detect = sub.add_parser("detect", help="probe and write build-profile.json")
    p_detect.add_argument("--project", required=True, type=Path)
    p_detect.add_argument("--json", action="store_true")

    p_recommend = sub.add_parser(
        "recommend", help="analyze modules/targets without writing canonical profile"
    )
    p_recommend.add_argument("--project", required=True, type=Path)
    p_recommend.add_argument("--json", action="store_true")

    p_audit = sub.add_parser(
        "audit", help="fail closed when module or command boundaries are unproven"
    )
    p_audit.add_argument("--project", required=True, type=Path)
    p_audit.add_argument("--json", action="store_true")

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

    p_migrate = sub.add_parser("migrate", help="migrate v1/v2 → v3")
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
    if args.command == "recommend":
        result = recommend(args.project)
        sys.stdout.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        return 0 if result.get("ok") else 1
    if args.command == "audit":
        result = audit_profile(args.project)
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
