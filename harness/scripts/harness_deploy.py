#!/usr/bin/env python3
"""Harness deploy: build the canonical skills tree for one projection surface.

v1.0 起无 profile、无 overlay、无 adapters 矩阵：codex 与 codebuddy 两个
surface 构建出内容完全相同的 bundle，仅构建标记中的 agent 字段不同
（gate 按 agent 字段匹配 context-index 的 skills_root）。SKILL.md
frontmatter 在构建时收敛为仅 name+description。

Python 3.10+ stdlib only. UTF-8 without BOM.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Iterable

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

INCLUDE_RE = re.compile(r"<!--\s*@include\s+shared/([^\s]+)\s*-->")
# retro §5.17: wiki links [[shared/xxx.md|alias]] reference shared fragments
# that are inlined by expand_includes. After expansion, replace the wiki link
# with the alias text (the shared content is already in the document).
WIKI_LINK_RE = re.compile(r"\[\[shared/([^\]|]+)\|([^\]]*)\]\]")
# §7.5: source files may carry section-id anchors; the build validates they are
# unique per file (no overlay application anymore — anchors are inert markers).
SECTION_ID_RE = re.compile(r"<!--\s*@section-id\s+([\w.-]+)\s*-->")
HEADING_RE = re.compile(r"^(#{2,6})\s+(.+?)\s*$")
FRAGMENT_HINT_RE = re.compile(r"^>\s*片段：\[\[shared/[^\]]+\]\]\s*.*$")
FRONTMATTER_RE = re.compile(r"^---\r?\n(.*?)\r?\n---\r?\n", re.DOTALL)

BUILD_MARKER = ".harness-build.json"
_REPLACE_RETRY_DELAYS_SECONDS = (0.05, 0.1, 0.2, 0.4, 0.8)

SKIP_DIR_NAMES = {
    "__pycache__",
    ".pytest_cache",
    "redesign",
    "shared",
    "overlays",
    "adapters",
    "agents",  # 可选委派角色源（check-agents 预检用）；规范 bundle 不携带（core 投影跳过 agents/）
    ".git",
}
SKIP_TOP_NAMES = {"harness-merge", "harness-report"}
# v1.0 投影 surface：构建标记的 agent 字段取 surface 名（gate 按此匹配
# context-index 的 project.adapters[agent].skills_root）。
PROJECTION_SURFACES = ("codex", "codebuddy")


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def replace_with_retry(source: Path, target: Path) -> None:
    """Bounded retry for transient directory locks during atomic swaps.

    Windows indexers and antivirus scanners may briefly hold a newly generated
    bundle directory. Retrying only ``PermissionError`` keeps real path and
    contract failures fail-fast while avoiding an expensive full bundle rerun.
    """
    for attempt in range(len(_REPLACE_RETRY_DELAYS_SECONDS) + 1):
        try:
            os.replace(source, target)
            return
        except PermissionError:
            if attempt >= len(_REPLACE_RETRY_DELAYS_SECONDS):
                raise
            time.sleep(_REPLACE_RETRY_DELAYS_SECONDS[attempt])


def emit_json(payload: dict[str, Any], *, ok: bool = True) -> int:
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if ok else 1


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def iter_copy_entries(skills_root: Path) -> Iterable[Path]:
    for entry in sorted(skills_root.iterdir()):
        if entry.name in SKIP_TOP_NAMES:
            continue
        if entry.is_dir() and entry.name in SKIP_DIR_NAMES:
            continue
        if entry.is_file() and entry.name.startswith("."):
            continue
        yield entry


RUNTIME_IGNORE = shutil.ignore_patterns(
    "tests", "__pycache__", "*.pyc", ".pytest_cache", "_last_run.txt", "_same_proc_*"
)
# README.md / CONTEXT.md 是源树开发文档（含 .claude/ 等历史路径字面量），不进运行时 bundle。
RUNTIME_SKIP_FILES = {"_last_run.txt", "_same_proc_pid.txt", "_same_proc_tmp.txt", "README.md", "CONTEXT.md"}


def copy_tree(skills_root: Path, out_dir: Path) -> list[str]:
    copied: list[str] = []
    out_dir.mkdir(parents=True, exist_ok=True)
    for entry in iter_copy_entries(skills_root):
        dest = out_dir / entry.name
        if entry.is_dir():
            if entry.name == "scripts":
                # §7.4: runtime keeps only scripts/*.py; scripts/tests/ excluded.
                # harness_acceptance.py is an acceptance meta-tool (not a runtime
                # skill script) and is excluded from the deployed tree.
                dest.mkdir(parents=True, exist_ok=True)
                for py in sorted(entry.glob("*.py")):
                    if py.name == "harness_acceptance.py":
                        continue
                    shutil.copy2(py, dest / py.name)
                    copied.append(f"scripts/{py.name}")
            else:
                shutil.copytree(entry, dest, ignore=RUNTIME_IGNORE)
                copied.append(entry.name + "/")
        else:
            if entry.name in RUNTIME_SKIP_FILES or entry.name.endswith(".pyc"):
                continue
            shutil.copy2(entry, dest)
            copied.append(entry.name)
    return copied


def expand_includes(text: str, shared_dir: Path) -> str:
    def repl(match: re.Match[str]) -> str:
        rel = match.group(1)
        inc_path = shared_dir / rel
        if not inc_path.is_file():
            raise FileNotFoundError(f"shared include not found: {rel}")
        body = inc_path.read_text(encoding="utf-8").rstrip()
        return body

    expanded = INCLUDE_RE.sub(repl, text)
    # §5.17: replace [[shared/xxx.md|alias]] wiki links with the alias text,
    # since the shared content has been inlined by @include expansion above.
    expanded = WIKI_LINK_RE.sub(lambda m: m.group(2), expanded)
    lines = [ln for ln in expanded.splitlines() if not FRAGMENT_HINT_RE.match(ln)]
    return "\n".join(lines) + ("\n" if text.endswith("\n") else "")


def parse_section_ids(text: str) -> dict[str, tuple[int, int, int]]:
    """Parse ``<!-- @section-id name -->`` markers; map id -> (start, end, level)
    of the heading that follows. Raise ValueError on duplicate ids (§7.5)."""
    lines = text.splitlines()
    ids: dict[str, tuple[int, int, int]] = {}
    pending: str | None = None
    for i, line in enumerate(lines):
        m = SECTION_ID_RE.search(line)
        if m:
            sid = m.group(1)
            if sid in ids:
                raise ValueError(f"duplicate section-id: {sid}")
            pending = sid
            continue
        hm = HEADING_RE.match(line)
        if hm and pending is not None:
            level = len(hm.group(1))
            start = i
            end = len(lines)
            for j in range(i + 1, len(lines)):
                m2 = HEADING_RE.match(lines[j])
                if m2 and len(m2.group(1)) <= level:
                    end = j
                    break
            ids[pending] = (start, end, level)
            pending = None
    return ids


def _is_relative_to(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def validate_build_paths(skills_root: Path, out_dir: Path) -> tuple[Path, Path]:
    """Return resolved safe paths; raise ValueError for every forbidden relation.

    §7.1: refuse out==source, out as ancestor of source, out inside source,
    an existing non-empty out without the build marker, and obvious danger
    dirs (user home).
    """
    skills_root = skills_root.resolve()
    out_dir = out_dir.resolve()

    if out_dir == skills_root:
        raise ValueError(f"out_dir must not equal skills_root: {out_dir}")
    if _is_relative_to(skills_root, out_dir):
        raise ValueError(f"out_dir must not be an ancestor of skills_root: {out_dir}")
    if _is_relative_to(out_dir, skills_root):
        raise ValueError(f"out_dir must not be inside skills_root: {out_dir}")
    try:
        home = Path.home().resolve()
    except OSError:
        home = None
    if home is not None and out_dir == home:
        raise ValueError(f"out_dir must not be the user home: {out_dir}")

    if out_dir.exists() and out_dir.is_dir():
        has_marker = (out_dir / BUILD_MARKER).is_file()
        has_user_files = any(p.name != BUILD_MARKER for p in out_dir.iterdir())
        if has_user_files and not has_marker:
            raise ValueError(
                f"out_dir exists with user files and no {BUILD_MARKER} marker: {out_dir}"
            )
    return skills_root, out_dir


def core_content_hash(skills_root: Path) -> str:
    """SHA-256 over the actual core/shared/protocol/script files that
    participate in the build (path-relative + content). Deterministic across
    time and machine paths (§7.3)."""
    h = hashlib.sha256()
    files: list[Path] = []
    # Hash exactly the runtime source universe copied by copy_tree, including
    # references/templates/checklists rather than only SKILL.md files.
    for entry in iter_copy_entries(skills_root):
        if entry.is_file():
            if entry.name not in RUNTIME_SKIP_FILES and not entry.name.endswith(".pyc"):
                files.append(entry)
        elif entry.name == "scripts":
            files.extend(p for p in entry.glob("*.py") if p.name != "harness_acceptance.py")
        else:
            files.extend(
                p for p in entry.rglob("*")
                if p.is_file() and "__pycache__" not in p.parts and "tests" not in p.parts
                and not p.name.endswith(".pyc") and p.name not in RUNTIME_SKIP_FILES
            )
    skills_root_resolved = skills_root.resolve()
    files_by_relative_path = {
        f.resolve().relative_to(skills_root_resolved).as_posix(): f
        for f in files
    }
    for rel in sorted(files_by_relative_path):
        f = files_by_relative_path[rel]
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        # Hash the actual build input with one algorithm regardless of whether the
        # source happens to live inside a Git checkout. Relative POSIX-path sorting
        # keeps the order identical on case-insensitive Windows and Linux.
        h.update(sha256_file(f).encode("ascii"))
        h.update(b"\0")
    return h.hexdigest()[:16]


def synthesis_header(skills_root: Path, surface: str) -> str:
    """Deterministic synth header: no absolute path, no timestamp (§7.3)."""
    core_hash = core_content_hash(skills_root)
    return (
        f"<!-- generated by harness_deploy.py; core={core_hash}; "
        f"agent={surface}; do not edit -->\n"
    )


def inject_header(text: str, header: str) -> str:
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            body = parts[2].lstrip("\n")
            return f"---{parts[1]}---\n{header}{body}"
    return header + text


# ---------------------------------------------------------------------------
# SKILL.md frontmatter 收敛 + 语义校验（移植自已删除的 adapt-agent-bundle.mjs；
# v1.0 单 bundle 后这是唯一的 frontmatter/语义出口）。
# ---------------------------------------------------------------------------

_KEY_LINE_RE = re.compile(r"^(name|description)\s*:(.*)$")
_ANY_KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*\s*:")

# codex 规则全集（单 surface 后所有 bundle 统一适用）：禁 .claude/* 路径引用、
# 禁自定义 agent spawn 语法、禁未替换占位符。
_FORBIDDEN_SEMANTIC: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"<!--\s*@include"), "unexpanded include placeholder"),
    (re.compile(r"\{\{[A-Z][A-Z0-9_]*\}\}"), "unfinished placeholder"),
    (re.compile(r"\.claude/rules/"), "forbidden path"),
    (re.compile(r"\.claude/agents/"), "forbidden path"),
    (re.compile(r"\.claude/skills/"), "forbidden path"),
    (re.compile(r"subagent_type:\s*harness-"), "custom agent call in a canonical bundle"),
    (re.compile(r"spawn\s+`harness-"), "custom agent spawn syntax in a canonical bundle"),
    (re.compile(r"spawn\s+harness-"), "custom agent spawn syntax in a canonical bundle"),
)


def canonicalize_skill_frontmatter(text: str, skill_name: str, rel_path: str) -> str:
    """Collapse SKILL.md frontmatter to ``name`` + ``description`` only.

    源文件可带 Claude 时代字段（allowed-tools / effort / argument-hint …），
    两个 surface 的运行时都只读 name+description；构建是唯一的收敛点。
    值为单行时逐行原样保留（不重序列化 YAML），多行值直接报错（源受控，
    fail-fast 优于静默截断）。
    """
    match = FRONTMATTER_RE.match(text)
    if not match:
        raise RuntimeError(f"SKILL.md missing frontmatter: {rel_path}")
    lines = match.group(1).split("\n")
    found: dict[str, str] = {}
    current_key: str | None = None
    for line in lines:
        key_match = _ANY_KEY_RE.match(line)
        if key_match:
            current_key = None
            pair = _KEY_LINE_RE.match(line)
            if pair:
                current_key = pair.group(1)
                found[current_key] = line.rstrip()
            continue
        if current_key is not None and line.strip():
            raise RuntimeError(
                f"multi-line {current_key} value is not supported in {rel_path}; "
                "keep name/description on a single line"
            )
    name = found.get("name")
    description = found.get("description")
    if name is None or description is None:
        raise RuntimeError(f"SKILL.md frontmatter missing name/description: {rel_path}")
    if name.split(":", 1)[1].strip() != skill_name:
        raise RuntimeError(f"SKILL.md name must equal directory name: {rel_path}")
    if not description.split(":", 1)[1].strip().strip('"'):
        raise RuntimeError(f"SKILL.md description must not be empty: {rel_path}")
    canonical = f"---\n{name}\n{description}\n---\n"
    return canonical + text[match.end():]


def scan_forbidden_semantics(rel_path: str, text: str) -> list[str]:
    problems: list[str] = []
    for pattern, label in _FORBIDDEN_SEMANTIC:
        if pattern.search(text):
            problems.append(f"{rel_path}: {label}")
    return problems


def validate_bundle_semantics(out_dir: Path) -> list[str]:
    """Scan built bundle docs for forbidden paths/tokens; return problems.

    与 adapt-agent-bundle.mjs 旧校验范围一致：只扫 .md（Python 脚本如
    harness_gate.py 合法引用 .claude/skills/ 等字面量做路径分类）。
    """
    problems: list[str] = []
    for path in sorted(out_dir.rglob("*.md")):
        if "__pycache__" in path.parts:
            continue
        rel = path.relative_to(out_dir).as_posix()
        problems.extend(scan_forbidden_semantics(rel, path.read_text(encoding="utf-8")))
    return problems


def process_skill_md(
    path: Path,
    shared_dir: Path,
    header: str,
    skill_name: str,
) -> None:
    text = path.read_text(encoding="utf-8")
    text = expand_includes(text, shared_dir)
    parse_section_ids(text)  # §7.5: raises on duplicate section-id
    text = canonicalize_skill_frontmatter(text, skill_name, path.name)
    text = inject_header(text, header)
    if INCLUDE_RE.search(text):
        raise RuntimeError(f"unexpanded include placeholder remains in {path}")
    path.write_text(text, encoding="utf-8", newline="\n")


def cmd_build(
    skills_root: Path,
    out_dir: Path,
    surface: str,
) -> dict[str, Any]:
    skills_root, out_dir = validate_build_paths(skills_root, out_dir)
    shared_dir = skills_root / "shared"
    if not shared_dir.is_dir():
        raise FileNotFoundError(f"shared/ missing under {skills_root}")
    if surface not in PROJECTION_SURFACES:
        raise ValueError(
            f"unknown surface: {surface} (expected one of {', '.join(PROJECTION_SURFACES)})"
        )

    # §7.2: build entirely in a staging dir; out_dir is untouched until the
    # atomic swap. Never `shutil.rmtree(out_dir)` at build start.
    staging = out_dir.parent / f".{out_dir.name}.staging-{uuid.uuid4().hex[:8]}"
    if staging.exists():
        shutil.rmtree(staging)
    try:
        copied = copy_tree(skills_root, staging)

        header = synthesis_header(skills_root, surface)
        processed: list[str] = []
        for skill_md in sorted(staging.glob("harness-*/SKILL.md")):
            process_skill_md(skill_md, shared_dir, header, skill_md.parent.name)
            processed.append(str(skill_md.relative_to(staging)))

        for skill_md in sorted(staging.glob("harness-*/SKILL.md")):
            if INCLUDE_RE.search(skill_md.read_text(encoding="utf-8")):
                raise RuntimeError(f"include placeholder remains: {skill_md}")

        semantic_problems = validate_bundle_semantics(staging)
        if semantic_problems:
            raise RuntimeError(
                "forbidden content in bundle:\n  " + "\n  ".join(semantic_problems)
            )

        # deterministic build marker (no timestamp -> byte-identical builds)
        core_hash = core_content_hash(skills_root)
        (staging / BUILD_MARKER).write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "overlay": "none",
                    "agent": surface,
                    "coreHash": core_hash,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
            newline="\n",
        )
    except Exception:
        # build failed: clean staging, leave out_dir completely untouched
        shutil.rmtree(staging, ignore_errors=True)
        raise

    # atomic swap: move old out aside (if a valid build), rename staging -> out
    old_backup = None
    if out_dir.exists():
        if (out_dir / BUILD_MARKER).is_file():
            old_backup = out_dir.parent / f".{out_dir.name}.old-{uuid.uuid4().hex[:8]}"
            replace_with_retry(out_dir, old_backup)
        else:
            shutil.rmtree(staging, ignore_errors=True)
            raise ValueError(f"refusing to overwrite unmarked out_dir: {out_dir}")
    try:
        replace_with_retry(staging, out_dir)
    except OSError:
        if old_backup is not None and old_backup.exists():
            replace_with_retry(old_backup, out_dir)
        raise
    if old_backup is not None:
        shutil.rmtree(old_backup, ignore_errors=True)

    return {
        "ok": True,
        "action": "build",
        "skillsRoot": str(skills_root),
        "outDir": str(out_dir),
        "overlay": None,
        "agent": surface,
        "copied": copied,
        "processedSkills": processed,
    }


def collect_files(root: Path) -> dict[str, str]:
    files: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if path.is_file() and "__pycache__" not in path.parts:
            rel = path.relative_to(root).as_posix()
            files[rel] = sha256_file(path)
    return files


# --- Per-file bundle manifest (retro 2026-07-20 §5.1/5.25) -----------------
#
# registry_version + bundle_hash alone cannot prove every installed file
# belongs to the declared bundle. The bundle therefore ships a per-file
# manifest (relpath/sha256/size/mode/adapterTransformationId); install
# verifies staging content against it BEFORE the atomic switch and never
# updates metadata on partial failure.

BUNDLE_MANIFEST_NAME = "bundle-manifest.json"
_MANIFEST_EXCLUDED = frozenset({BUILD_MARKER, BUNDLE_MANIFEST_NAME})


def build_manifest(root: Path, transformation_id: str = "raw") -> list[dict[str, Any]]:
    """Return per-file manifest entries for every bundle file under ``root``.

    Install metadata (build marker, managed manifests, the manifest itself)
    is excluded. Entries are sorted by relpath for deterministic output.
    """
    root = root.resolve()
    entries: list[dict[str, Any]] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or "__pycache__" in path.parts:
            continue
        rel = path.relative_to(root).as_posix()
        if rel in _MANIFEST_EXCLUDED:
            continue
        stat = path.stat()
        entries.append(
            {
                "relpath": rel,
                "sha256": sha256_file(path),
                "size": stat.st_size,
                "mode": stat.st_mode,
                "adapterTransformationId": transformation_id,
            }
        )
    return entries


def compute_bundle_manifest_hash(entries: list[dict[str, Any]]) -> str:
    """Deterministic aggregate hash over manifest entries (order-independent).

    Must match packages/contracts/src/bundle-manifest.ts computeBundleManifestHash.
    """
    ordered = sorted(entries, key=lambda entry: entry["relpath"])
    lines = [
        f"{entry['relpath']}:{entry['sha256']}:{entry['size']}:{entry['mode']}:{entry['adapterTransformationId']}"
        for entry in ordered
    ]
    return hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()


def aggregate_installed_content_hash(files: dict[str, str]) -> str:
    """Deterministic aggregate hash over actually-installed relpath->sha256."""
    lines = [f"{rel}:{files[rel]}" for rel in sorted(files)]
    return hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()


def _verify_tree_against_manifest(
    root: Path, entries: list[dict[str, Any]]
) -> list[dict[str, str]]:
    """Return mismatch details for files under ``root`` vs manifest entries."""
    mismatches: list[dict[str, str]] = []
    actual = collect_files(root)
    declared = {entry["relpath"]: entry["sha256"] for entry in entries}
    for rel, expected in sorted(declared.items()):
        if rel not in actual:
            mismatches.append({"relpath": rel, "expected": expected, "actual": "<missing>"})
        elif actual[rel] != expected:
            mismatches.append(
                {"relpath": rel, "expected": expected, "actual": actual[rel]}
            )
    return mismatches


def cmd_verify_installed(
    installed_dir: Path, entries: list[dict[str, Any]], bundle_version: str
) -> dict[str, Any]:
    """Verify installed content against the bundle manifest, per file."""
    installed_dir = installed_dir.resolve()
    mismatches = _verify_tree_against_manifest(installed_dir, entries)
    actual = collect_files(installed_dir)
    declared = {entry["relpath"] for entry in entries}
    content = {
        rel: digest
        for rel, digest in actual.items()
        if rel not in _MANIFEST_EXCLUDED and rel in declared
    }
    return {
        "ok": not mismatches,
        "action": "verify-installed",
        "bundleVersion": bundle_version,
        "verificationStatus": "verified" if not mismatches else "degraded",
        "installedContentHash": aggregate_installed_content_hash(content),
        "verifiedAt": now_iso(),
        "mismatchDetails": mismatches,
    }


def cmd_validate_manifest(
    bundle_dir: Path, manifest_entries: list[dict[str, Any]]
) -> dict[str, Any]:
    """Compare a bundle directory's actual file set against the manifest's
    declared set. Both missing (declared but absent) and extra (present but
    undeclared) fail validation (design §3.8 要点2)."""
    bundle_dir = bundle_dir.resolve()
    actual = collect_files(bundle_dir)
    declared: dict[str, str] = {}
    for entry in manifest_entries:
        path = entry.get("path")
        sha = entry.get("sha256")
        if isinstance(path, str) and isinstance(sha, str):
            declared[path] = sha
    missing = sorted(p for p in declared if p not in actual)
    extra = sorted(p for p in actual if p not in declared)
    hash_mismatch = sorted(
        p for p in declared if p in actual and actual[p] != declared[p]
    )
    return {
        "ok": not (missing or extra or hash_mismatch),
        "action": "validate-manifest",
        "missing": missing,
        "extra": extra,
        "hashMismatch": hash_mismatch,
        "comparedAt": now_iso(),
    }


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Harness skills deploy (canonical bundle build)")
    sub = p.add_subparsers(dest="command", required=True)

    b = sub.add_parser("build", help="Build the canonical skills tree for one surface")
    b.add_argument("--skills-root", type=Path, required=True)
    b.add_argument("--out", type=Path, required=True)
    b.add_argument("--surface", required=True, choices=PROJECTION_SURFACES)
    b.add_argument("--json", action="store_true")

    v = sub.add_parser(
        "validate-manifest", help="Validate bundle dir vs manifest (missing/extra/hash)"
    )
    v.add_argument("--bundle", type=Path, required=True)
    v.add_argument("--manifest", type=Path, required=True)
    v.add_argument("--json", action="store_true")

    g = sub.add_parser(
        "generate-manifest",
        help="Generate per-file bundle-manifest.json for a bundle dir",
    )
    g.add_argument("--bundle", type=Path, required=True)
    g.add_argument("--bundle-version", required=True)
    g.add_argument(
        "--transformation",
        choices=["raw", "adapted", "workflow-packaged"],
        default="raw",
    )
    g.add_argument("--out", type=Path)
    g.add_argument("--json", action="store_true")

    vi = sub.add_parser(
        "verify-installed",
        help="Verify installed tree content against bundle-manifest.json",
    )
    vi.add_argument("--installed", type=Path, required=True)
    vi.add_argument("--manifest", type=Path, required=True)
    vi.add_argument("--json", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "build":
            result = cmd_build(args.skills_root, args.out, args.surface)
            return emit_json(result) if args.json else 0
        if args.command == "validate-manifest":
            manifest_data = json.loads(args.manifest.read_text(encoding="utf-8"))
            entries = (
                manifest_data.get("files", [])
                if isinstance(manifest_data, dict)
                else []
            )
            result = cmd_validate_manifest(args.bundle, entries)
            if args.json:
                return emit_json(result)
            return 0 if result["ok"] else 1
        if args.command == "generate-manifest":
            entries = build_manifest(args.bundle, transformation_id=args.transformation)
            manifest = {
                "schemaVersion": 1,
                "bundleVersion": args.bundle_version,
                "bundleManifestHash": compute_bundle_manifest_hash(entries),
                "files": entries,
            }
            text = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
            if args.out is not None:
                args.out.parent.mkdir(parents=True, exist_ok=True)
                args.out.write_text(text, encoding="utf-8", newline="\n")
            result = {
                "ok": True,
                "action": "generate-manifest",
                "bundleVersion": args.bundle_version,
                "bundleManifestHash": manifest["bundleManifestHash"],
                "fileCount": len(entries),
                "out": str(args.out) if args.out is not None else None,
            }
            if args.json:
                return emit_json(result)
            if args.out is None:
                print(text, end="")
            return 0
        if args.command == "verify-installed":
            manifest_data = json.loads(args.manifest.read_text(encoding="utf-8"))
            if not isinstance(manifest_data, dict):
                raise ValueError("manifest must be a JSON object")
            result = cmd_verify_installed(
                args.installed,
                manifest_data.get("files", []),
                str(manifest_data.get("bundleVersion", "")),
            )
            if args.json:
                return emit_json(result)
            return 0 if result["ok"] else 1
    except (FileNotFoundError, KeyError, RuntimeError, ValueError) as exc:
        if getattr(args, "json", False):
            return emit_json({"ok": False, "error": str(exc)}, ok=False)
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
