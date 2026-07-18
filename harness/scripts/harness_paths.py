#!/usr/bin/env python3
"""Harness path and identity resolution.

Single owner for:
- repository identity (stable across worktrees of one repo);
- Change contract loading (``meta/change-context.json``);
- dual-root layout resolution (static contract root vs dynamic state root);
- path boundary assertions used by cleanup/integration code.

Python 3.10+, stdlib only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

LIFECYCLE_STATUSES = {"draft", "active", "superseded", "archived", "cancelled"}
CHANGE_CONTEXT_REL = Path("meta") / "change-context.json"


def _git_text(cwd: Path, *args: str) -> str | None:
    proc = subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if proc.returncode != 0:
        return None
    return proc.stdout.strip()


def resolve_main_project_root(cwd: Path | None = None) -> Path:
    """Locate the main project root from a worktree or the main checkout."""
    start = (cwd or Path.cwd()).resolve()
    common_raw = _git_text(start, "rev-parse", "--git-common-dir")
    if not common_raw:
        return start
    common = Path(common_raw)
    if not common.is_absolute():
        common = (start / common).resolve()
    if common.name == ".git":
        return common.parent
    return start


def resolve_worktree_root(cwd: Path | None = None) -> Path:
    """Top-level of the checkout containing ``cwd`` (worktree-aware)."""
    start = (cwd or Path.cwd()).resolve()
    top = _git_text(start, "rev-parse", "--show-toplevel")
    if not top:
        return start
    return Path(top).resolve()


def _git_common_dir(cwd: Path) -> Path | None:
    raw = _git_text(cwd, "rev-parse", "--git-common-dir")
    if not raw:
        return None
    common = Path(raw)
    if not common.is_absolute():
        common = (cwd / common).resolve()
    return common


def _root_commit(cwd: Path) -> str | None:
    raw = _git_text(cwd, "rev-list", "--max-parents=0", "HEAD")
    if not raw:
        return None
    return raw.splitlines()[0].strip()


def _normalize_remote(url: str) -> str:
    """Normalize a git remote URL to ``host/path`` lowercase form."""
    text = url.strip()
    text = re.sub(r"^git@", "", text)
    text = text.replace(":", "/", 1) if "://" not in text else text
    text = re.sub(r"^[a-zA-Z]+://", "", text)
    text = re.sub(r"^[^/@]+@", "", text)  # strip userinfo
    text = text.lower()
    if text.endswith(".git"):
        text = text[: -len(".git")]
    return text.rstrip("/")


def _primary_remote_url(cwd: Path) -> str | None:
    url = _git_text(cwd, "config", "--get", "remote.origin.url")
    if url:
        return url
    remotes = _git_text(cwd, "remote")
    if not remotes:
        return None
    first = remotes.splitlines()[0].strip()
    return _git_text(cwd, "config", "--get", f"remote.{first}.url")


def repository_identity(cwd: Path) -> str:
    """Stable repository identity.

    Preferred: normalized primary remote identity + root commit.
    Fallback (no remote): resolved git common-dir identity + root commit.
    The identity never embeds a worktree absolute path, so linked worktrees of
    one repository share the same id (RET-09).
    """
    cwd = Path(cwd).resolve()
    root_commit = _root_commit(cwd) or "no-root-commit"
    remote = _primary_remote_url(cwd)
    if remote:
        basis = f"remote:{_normalize_remote(remote)}\n{root_commit}"
    else:
        common = _git_common_dir(cwd)
        basis = f"local:{common}\n{root_commit}"
    return "sha256:" + hashlib.sha256(basis.encode("utf-8")).hexdigest()


def load_change_contract(contract_dir: Path) -> dict[str, Any]:
    """Load and validate ``meta/change-context.json`` from a contract dir."""
    contract_dir = Path(contract_dir)
    context_path = contract_dir / CHANGE_CONTEXT_REL
    if not context_path.is_file():
        raise FileNotFoundError(f"change context not found: {context_path}")
    data = json.loads(context_path.read_text(encoding="utf-8-sig"))
    if not isinstance(data, dict):
        raise ValueError(f"change context must be an object: {context_path}")
    lifecycle = data.get("lifecycle")
    if isinstance(lifecycle, dict):
        status = lifecycle.get("status")
        if status is not None and status not in LIFECYCLE_STATUSES:
            raise ValueError(
                f"invalid lifecycle.status {status!r}; expected one of "
                f"{sorted(LIFECYCLE_STATUSES)}"
            )
    return data


def contract_layout_kind(contract: dict[str, Any]) -> str:
    """``split-v1`` when the contract declares a separate runtime root."""
    ownership = contract.get("stateOwnership")
    if isinstance(ownership, dict) and ownership.get("runtimeRoot"):
        return "split-v1"
    return "legacy-colocated"


def _resolve_runtime_root(main_root: Path, change_name: str, runtime_root: Any) -> Path:
    raw = Path(str(runtime_root or ""))
    if not str(runtime_root or "").strip() or raw.is_absolute():
        raise ValueError("stateOwnership.runtimeRoot must be a project-relative path")
    state_parent = (main_root / ".harness" / "state" / "changes").resolve()
    resolved = (main_root / raw).resolve()
    assert_path_within(resolved, state_parent)
    expected = (state_parent / change_name).resolve()
    if resolved != expected:
        raise ValueError(
            "stateOwnership.runtimeRoot must equal "
            f".harness/state/changes/{change_name}"
        )
    return resolved


def resolve_change_layout(
    cwd_hint: Path, change_id_or_dir: str | Path
) -> dict[str, Any]:
    """Resolve the static/dynamic roots for a change.

    ``cwd_hint`` is any directory inside the checkout (main or linked
    worktree); state always anchors at the main project root. Resolution is
    read-only: legacy files are never moved here.
    """
    hint = Path(cwd_hint).resolve()
    main_root = resolve_main_project_root(hint)
    worktree_root = resolve_worktree_root(hint)

    if isinstance(change_id_or_dir, Path):
        contract_dir = change_id_or_dir.resolve()
        change_name = contract_dir.name
        if not contract_dir.is_dir():
            raise FileNotFoundError(f"change contract dir not found: {contract_dir}")
    else:
        change_name = str(change_id_or_dir)
        contract_dir = (main_root / ".harness" / "changes" / change_name).resolve()
        if not contract_dir.is_dir():
            raise FileNotFoundError(f"change not found: {change_name}")

    contract: dict[str, Any] = {}
    if (contract_dir / CHANGE_CONTEXT_REL).is_file():
        contract = load_change_contract(contract_dir)

    layout_kind = contract_layout_kind(contract)
    if layout_kind == "split-v1":
        runtime_rel = contract["stateOwnership"]["runtimeRoot"]
        state_root = _resolve_runtime_root(main_root, change_name, runtime_rel)
    else:
        state_root = contract_dir

    return {
        "schemaVersion": 1,
        "changeName": change_name,
        "repositoryId": repository_identity(main_root),
        "projectRoot": str(main_root),
        "worktreeRoot": str(worktree_root),
        "contractRoot": str(contract_dir),
        "stateRoot": str(state_root),
        "layout": layout_kind,
    }


def resolve_state_dir_for_contract(
    contract_dir: Path, cwd: Path | None = None
) -> Path:
    """Return the dynamic-state root for a change contract dir.

    split-v1 contracts resolve to ``.harness/state/changes/<id>`` under the
    main project root. Legacy contracts, missing/invalid context files and
    non-standard locations return the contract dir unchanged, so colocated
    readers observe zero behaviour change.
    """
    contract_dir = Path(contract_dir).resolve()
    try:
        contract = load_change_contract(contract_dir)
    except (FileNotFoundError, ValueError, json.JSONDecodeError, OSError):
        return contract_dir
    if contract_layout_kind(contract) != "split-v1":
        return contract_dir
    main_root = resolve_main_project_root(cwd or contract_dir)
    expected = (main_root / ".harness" / "changes" / contract_dir.name).resolve()
    if contract_dir != expected:
        return contract_dir
    return _resolve_runtime_root(
        main_root, contract_dir.name, contract["stateOwnership"]["runtimeRoot"]
    )


def assert_path_within(
    path: Path, allowed_root: Path, *, allow_root: bool = False
) -> Path:
    """Resolve ``path`` and require it to stay inside ``allowed_root``.

    Rejects empty paths, parents, sibling-prefix attacks and symlink escapes.
    Returns the resolved path on success.
    """
    raw = str(path)
    if not raw or not raw.strip():
        raise ValueError("empty path is not allowed")
    root = Path(allowed_root).resolve()
    resolved = Path(path).resolve()
    if resolved == root:
        if allow_root:
            return resolved
        raise ValueError(f"path is the allowed root itself: {resolved}")
    if not resolved.is_relative_to(root):
        raise ValueError(f"path escapes allowed root: {resolved} not within {root}")
    return resolved


def cmd_resolve_layout(args: argparse.Namespace) -> int:
    layout = resolve_change_layout(Path.cwd(), args.change)
    sys.stdout.write(json.dumps(layout, ensure_ascii=False, indent=2) + "\n")
    return 0


def cmd_repository_id(args: argparse.Namespace) -> int:
    identity = repository_identity(Path.cwd())
    if args.json:
        sys.stdout.write(
            json.dumps({"ok": True, "repositoryId": identity}, ensure_ascii=False)
            + "\n"
        )
    else:
        sys.stdout.write(identity + "\n")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harness_paths.py")
    sub = parser.add_subparsers(dest="command_name", required=True)

    p_layout = sub.add_parser("resolve-layout")
    p_layout.add_argument("--change", required=True)
    p_layout.set_defaults(func=cmd_resolve_layout)

    p_id = sub.add_parser("repository-id")
    p_id.add_argument("--json", action="store_true")
    p_id.set_defaults(func=cmd_repository_id)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
