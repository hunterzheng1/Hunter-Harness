#!/usr/bin/env python3
"""Harness deploy: build core + overlay into self-contained skills tree (D9/D12).

Python 3.10+ stdlib only. UTF-8 without BOM.
"""

from __future__ import annotations

import argparse
import datetime as dt
import filecmp
import hashlib
import json
import os
import re
import shutil
import sys
import uuid
from pathlib import Path
from typing import Any, Iterable

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

INCLUDE_RE = re.compile(r"<!--\s*@include\s+shared/([^\s]+)\s*-->")
# §7.5: overlay anchors support both new section-id and legacy section:"title".
OVERRIDE_RE = re.compile(r'<!--\s*@override\s+(?:section-id:"([^"]+)"|section:"([^"]+)")\s*-->')
APPEND_RE = re.compile(r'<!--\s*@append-after\s+(?:section-id:"([^"]+)"|section:"([^"]+)")\s*-->')
SECTION_ID_RE = re.compile(r"<!--\s*@section-id\s+([\w.-]+)\s*-->")
HEADING_RE = re.compile(r"^(#{2,6})\s+(.+?)\s*$")
FRAGMENT_HINT_RE = re.compile(r"^>\s*片段：\[\[shared/[^\]]+\]\]\s*.*$")

BUILD_MARKER = ".harness-build.json"

SKIP_DIR_NAMES = {
    "__pycache__",
    ".pytest_cache",
    "redesign",
    "shared",
    "overlays",
    ".git",
}
SKIP_TOP_NAMES = {"harness-merge", "harness-report"}


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def emit_json(payload: dict[str, Any], *, ok: bool = True) -> int:
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if ok else 1


def normalize_section_title(title: str) -> str:
    t = title.strip()
    t = re.sub(r"\s*⚠️.*$", "", t)
    t = re.sub(r"\s*（[^）]*）\s*$", "", t)
    return t.strip()


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
    "__pycache__", "*.pyc", ".pytest_cache", "_last_run.txt", "_same_proc_*"
)
RUNTIME_SKIP_FILES = {"_last_run.txt", "_same_proc_pid.txt", "_same_proc_tmp.txt"}


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
    lines = [ln for ln in expanded.splitlines() if not FRAGMENT_HINT_RE.match(ln)]
    return "\n".join(lines) + ("\n" if text.endswith("\n") else "")


def find_section_span(lines: list[str], section: str) -> tuple[int, int, int]:
    target = normalize_section_title(section)
    start = end = level = -1
    for i, line in enumerate(lines):
        m = HEADING_RE.match(line)
        if not m:
            continue
        title = normalize_section_title(m.group(2))
        if title == target or title.startswith(target):
            start = i
            level = len(m.group(1))
            break
    if start < 0:
        raise KeyError(section)
    end = len(lines)
    for j in range(start + 1, len(lines)):
        m = HEADING_RE.match(lines[j])
        if m and len(m.group(1)) <= level:
            end = j
            break
    return start, end, level


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


def apply_overlay_blocks(
    core_text: str, overlay_text: str, section_ids: dict[str, tuple[int, int, int]] | None = None
) -> str:
    lines = core_text.splitlines()
    pos = 0
    while pos < len(overlay_text):
        override = OVERRIDE_RE.search(overlay_text, pos)
        append = APPEND_RE.search(overlay_text, pos)
        candidates = [(m.start(), "override", m) for m in [override] if m]
        candidates += [(m.start(), "append", m) for m in [append] if m]
        if not candidates:
            break
        candidates.sort(key=lambda x: x[0])
        _, kind, match = candidates[0]
        section_id = match.group(1)  # new style, may be None
        section_title = match.group(2)  # legacy style, may be None
        content_start = match.end()
        next_marker = min(
            (
                m.start()
                for m in (
                    OVERRIDE_RE.search(overlay_text, content_start),
                    APPEND_RE.search(overlay_text, content_start),
                )
                if m
            ),
            default=len(overlay_text),
        )
        block = overlay_text[content_start:next_marker].strip("\n")
        if section_id:
            if not section_ids or section_id not in section_ids:
                raise KeyError(f"section-id:{section_id}")
            start, end, _ = section_ids[section_id]
        else:
            start, end, _ = find_section_span(lines, section_title)
        if kind == "override":
            replacement = block.splitlines()
            lines = lines[:start] + replacement + lines[end:]
        else:
            insertion = block.splitlines()
            lines = lines[:end] + insertion + lines[end:]
        pos = next_marker
    return "\n".join(lines) + ("\n" if core_text.endswith("\n") else "")


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


def core_content_hash(skills_root: Path, overlay_dir: Path | None) -> str:
    """SHA-256 over the actual core/shared/protocol/script/overlay files that
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
                if p.is_file() and "__pycache__" not in p.parts
                and not p.name.endswith(".pyc") and p.name not in RUNTIME_SKIP_FILES
            )
    if overlay_dir and overlay_dir.is_dir():
        files.extend(p for p in overlay_dir.rglob("*") if p.is_file())
    for f in sorted(set(files)):
        rel = f.resolve().relative_to(skills_root.resolve()).as_posix()
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update(sha256_file(f).encode("ascii"))
        h.update(b"\0")
    return h.hexdigest()[:16]


def synthesis_header(skills_root: Path, overlay_dir: Path | None) -> str:
    """Deterministic synth header: no absolute path, no timestamp (§7.3)."""
    core_hash = core_content_hash(skills_root, overlay_dir)
    overlay_name = overlay_dir.name if overlay_dir else "none"
    return (
        f"<!-- generated by harness_deploy.py; core={core_hash}; "
        f"overlay={overlay_name}; do not edit -->\n"
    )


def inject_header(text: str, header: str) -> str:
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            body = parts[2].lstrip("\n")
            return f"---{parts[1]}---\n{header}{body}"
    return header + text


def process_skill_md(
    path: Path,
    shared_dir: Path,
    overlay_path: Path | None,
    header: str,
) -> None:
    text = path.read_text(encoding="utf-8")
    text = expand_includes(text, shared_dir)
    section_ids = parse_section_ids(text)  # §7.5: raises on duplicate section-id
    if overlay_path and overlay_path.is_file():
        overlay = overlay_path.read_text(encoding="utf-8")
        text = apply_overlay_blocks(text, overlay, section_ids)
    text = inject_header(text, header)
    if INCLUDE_RE.search(text):
        raise RuntimeError(f"unexpanded include placeholder remains in {path}")
    path.write_text(text, encoding="utf-8")


def overlay_for_skill(overlay_dir: Path, skill_name: str) -> Path | None:
    candidate = overlay_dir / f"{skill_name}.overlay.md"
    return candidate if candidate.is_file() else None


def copy_overlay_unique_skills(overlay_dir: Path, out_dir: Path) -> list[str]:
    added: list[str] = []
    for entry in sorted(overlay_dir.iterdir()):
        if not entry.is_dir():
            continue
        if not entry.name.startswith("harness-"):
            continue
        if not (entry / "SKILL.md").is_file():
            continue
        if (out_dir / entry.name).exists():
            continue
        shutil.copytree(
            entry,
            out_dir / entry.name,
            ignore=shutil.ignore_patterns("__pycache__", "*.pyc"),
        )
        added.append(entry.name + "/")
    return added


def merge_overlay_skill_extras(overlay_dir: Path, out_dir: Path) -> list[str]:
    """Copy overlays/java/harness-<name>/* into existing out/harness-<name>/ (reference, etc.)."""
    merged: list[str] = []
    unique = {
        p.name
        for p in overlay_dir.iterdir()
        if p.is_dir() and (p / "SKILL.md").is_file()
    }
    for entry in sorted(overlay_dir.iterdir()):
        if not entry.is_dir() or not entry.name.startswith("harness-"):
            continue
        if entry.name in unique:
            continue
        dest_skill = out_dir / entry.name
        if not dest_skill.is_dir():
            continue
        for src in entry.rglob("*"):
            if src.is_dir() or "__pycache__" in src.parts:
                continue
            rel = src.relative_to(entry)
            dest = dest_skill / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest)
            merged.append(f"{entry.name}/{rel.as_posix()}")
    return merged


def copy_overlay_extras(overlay_dir: Path, out_dir: Path) -> list[str]:
    extras: list[str] = []
    # §7.4: PROJECT-PROFILE-EXAMPLE.md stays a Vault doc (UDP real values);
    # it must NOT be installed to runtime. Only pitfalls-java.md is runtime.
    pitfalls = overlay_dir / "pitfalls-java.md"
    if pitfalls.is_file():
        test_pit = out_dir / "harness-test" / "pitfalls-java.md"
        test_pit.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(pitfalls, test_pit)
        extras.append("harness-test/pitfalls-java.md")
    return extras


def cmd_build(
    skills_root: Path,
    out_dir: Path,
    overlay: str | None,
) -> dict[str, Any]:
    skills_root, out_dir = validate_build_paths(skills_root, out_dir)
    shared_dir = skills_root / "shared"
    if not shared_dir.is_dir():
        raise FileNotFoundError(f"shared/ missing under {skills_root}")
    overlay_dir = skills_root / "overlays" / overlay if overlay else None
    if overlay and (not overlay_dir or not overlay_dir.is_dir()):
        raise FileNotFoundError(f"overlay not found: overlays/{overlay}")

    # §7.2: build entirely in a staging dir; out_dir is untouched until the
    # atomic swap. Never `shutil.rmtree(out_dir)` at build start.
    staging = out_dir.parent / f".{out_dir.name}.staging-{uuid.uuid4().hex[:8]}"
    if staging.exists():
        shutil.rmtree(staging)
    try:
        copied = copy_tree(skills_root, staging)
        if overlay:
            copied.extend(copy_overlay_unique_skills(overlay_dir, staging))
            copied.extend(copy_overlay_extras(overlay_dir, staging))
            copied.extend(merge_overlay_skill_extras(overlay_dir, staging))

        header = synthesis_header(skills_root, overlay_dir)
        processed: list[str] = []
        for skill_md in sorted(staging.glob("harness-*/SKILL.md")):
            ov = overlay_for_skill(overlay_dir, skill_md.parent.name) if overlay_dir else None
            try:
                process_skill_md(skill_md, shared_dir, ov, header)
            except KeyError as exc:
                raise KeyError(
                    f"overlay anchor not found: {exc.args[0]} ({skill_md})"
                ) from exc
            processed.append(str(skill_md.relative_to(staging)))

        for skill_md in sorted(staging.glob("harness-*/SKILL.md")):
            if INCLUDE_RE.search(skill_md.read_text(encoding="utf-8")):
                raise RuntimeError(f"include placeholder remains: {skill_md}")

        # deterministic build marker (no timestamp -> byte-identical builds)
        core_hash = core_content_hash(skills_root, overlay_dir)
        (staging / BUILD_MARKER).write_text(
            json.dumps(
                {"schemaVersion": 1, "overlay": overlay or "none", "coreHash": core_hash},
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
            os.replace(out_dir, old_backup)
        else:
            shutil.rmtree(staging, ignore_errors=True)
            raise ValueError(f"refusing to overwrite unmarked out_dir: {out_dir}")
    try:
        os.replace(staging, out_dir)
    except OSError:
        if old_backup is not None and old_backup.exists():
            os.replace(old_backup, out_dir)
        raise
    if old_backup is not None:
        shutil.rmtree(old_backup, ignore_errors=True)

    return {
        "ok": True,
        "action": "build",
        "skillsRoot": str(skills_root),
        "outDir": str(out_dir),
        "overlay": overlay,
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


def cmd_install(build_out: Path, project: Path, target: Path | None) -> dict[str, Any]:
    build_out = build_out.resolve()
    project = project.resolve()
    dest = (target or project / ".claude" / "skills").resolve()
    if not (build_out / BUILD_MARKER).is_file():
        raise ValueError(f"install source is not a marked harness build: {build_out}")
    backup: str | None = None
    staging = dest.parent / f".{dest.name}.staging-{uuid.uuid4().hex[:8]}"
    shutil.copytree(build_out, staging)
    if dest.exists() and any(dest.iterdir()):
        stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_path = dest.parent / f"skills-backup-{stamp}"
        os.replace(dest, backup_path)
        backup = str(backup_path)
    try:
        os.replace(staging, dest)
    except OSError:
        shutil.rmtree(staging, ignore_errors=True)
        if backup:
            os.replace(Path(backup), dest)
        raise

    agents_src = build_out / "agents"
    agents_dest = project / ".claude" / "agents"
    if agents_src.is_dir():
        agents_dest.mkdir(parents=True, exist_ok=True)
        for agent in agents_src.glob("*.md"):
            shutil.copy2(agent, agents_dest / agent.name)

    return {
        "ok": True,
        "action": "install",
        "from": str(build_out),
        "project": str(project),
        "target": str(dest),
        "backup": backup,
        "installedAt": now_iso(),
    }


def cmd_diff(build_out: Path, project: Path, target: Path | None) -> dict[str, Any]:
    build_out = build_out.resolve()
    project = project.resolve()
    installed = (target or project / ".claude" / "skills").resolve()
    if not installed.is_dir():
        return {
            "ok": True,
            "action": "diff",
            "stale": True,
            "missingInstall": True,
            "outdated": [],
            "missing": [],
            "extra": [],
        }

    built = collect_files(build_out)
    current = collect_files(installed)
    outdated = [p for p, h in built.items() if p in current and current[p] != h]
    missing = [p for p in built if p not in current]
    extra = [p for p in current if p not in built]
    return {
        "ok": True,
        "action": "diff",
        "stale": bool(outdated or missing),
        "outdated": sorted(outdated),
        "missing": sorted(missing),
        "extra": sorted(extra),
        "comparedAt": now_iso(),
    }


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Harness skills deploy (build/install/diff)")
    sub = p.add_subparsers(dest="command", required=True)

    b = sub.add_parser("build", help="Synthesize core + overlay into output dir")
    b.add_argument("--skills-root", type=Path, required=True)
    b.add_argument("--out", type=Path, required=True)
    b.add_argument("--overlay")
    b.add_argument("--json", action="store_true")

    i = sub.add_parser("install", help="Install build output to project .claude/skills")
    i.add_argument("--from", dest="from_dir", type=Path, required=True)
    i.add_argument("--project", type=Path, required=True)
    i.add_argument("--target", type=Path)
    i.add_argument("--json", action="store_true")

    d = sub.add_parser("diff", help="Compare installed skills vs build output")
    d.add_argument("--from", dest="from_dir", type=Path, required=True)
    d.add_argument("--project", type=Path, required=True)
    d.add_argument("--target", type=Path)
    d.add_argument("--json", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "build":
            result = cmd_build(args.skills_root, args.out, args.overlay)
            return emit_json(result) if args.json else 0
        if args.command == "install":
            result = cmd_install(args.from_dir, args.project, args.target)
            return emit_json(result) if args.json else 0
        if args.command == "diff":
            result = cmd_diff(args.from_dir, args.project, args.target)
            return emit_json(result) if args.json else 0
    except (FileNotFoundError, KeyError, RuntimeError, ValueError) as exc:
        if getattr(args, "json", False):
            return emit_json({"ok": False, "error": str(exc)}, ok=False)
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
