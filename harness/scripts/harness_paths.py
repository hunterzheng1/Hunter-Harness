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
from typing import Any, Sequence

SCRIPTS_DIR = Path(__file__).resolve().parent
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

LIFECYCLE_STATUSES = {"draft", "active", "superseded", "archived", "cancelled"}
CHANGE_CONTEXT_REL = Path("meta") / "change-context.json"

# 工作流阶段的唯一权威清单。这里是叶子模块（不 import 任何 harness_*），所以
# harness_context 与 harness_phase 都能引它而不成环。
#
# 此前这份清单在两个模块各写一遍，靠约定保持同步——直到 harness_phase 少了一个
# merge，worktree 变更走到 merge 阶段就在 target_required_dag 里直接 raise
# "unsupported reconcile target phase"。同一份事实不该有两个副本。
WORKFLOW_PHASES = (
    "plan",
    "execute",
    "review",
    "package",
    "apidoc",
    "submit",
    "merge",
    "archive",
)

# 出现在阶段位置、但不是工作流阶段的名字。它们是真实存在的：
# workflow-policy.json 的 skills.*.phase 用 sync/codebase-map/knowledge-query 标注
# 技能归属，harness_gate.GATE_RELEASE_PHASES 含 release/deploy。把它们与"拼错的
# 阶段名"区分开，调用方才能既不误判也不硬崩。
KNOWN_NON_WORKFLOW_PHASES = frozenset({
    "release",
    "deploy",
    "sync",
    "codebase-map",
    "knowledge-query",
    "knowledge-ingest",
    "push",
    "pull",
})

# 旧阶段名 → 现阶段名。阶段合并/改名时在这里登记，读时映射即可让历史
# gate-policy.json、plannedPhases 与已落盘 transitions 继续可读，不必迁移
# 已落盘的 change。注意：映射只能用在哈希校验之后的业务比较层——对已哈希
# 的 receipt 先映射再重算会断 _payload_hash 链。
# 2026-08 run+test 合并为 execute（方案 c，review 保留独立阶段）。
LEGACY_PHASE_ALIASES: dict[str, str] = {"run": "execute", "test": "execute"}


def resolve_phase_name(phase: Any) -> str | None:
    """把可能是旧名的阶段解析成当前的工作流阶段名；不是工作流阶段则返回 None。"""
    name = str(phase or "").strip()
    if name in WORKFLOW_PHASES:
        return name
    mapped = LEGACY_PHASE_ALIASES.get(name)
    return mapped if mapped in WORKFLOW_PHASES else None


def classify_phase_name(phase: Any) -> str:
    """三态判定：``workflow`` | ``non_workflow`` | ``unknown``。

    调用方需要区分这三者：``workflow`` 照常处理；``non_workflow`` 是别的子系统
    的标注，跳过而不是报错；只有 ``unknown`` 才是真的有问题，值得让人看见。
    """
    if resolve_phase_name(phase) is not None:
        return "workflow"
    if str(phase or "").strip() in KNOWN_NON_WORKFLOW_PHASES:
        return "non_workflow"
    return "unknown"


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


def common_root(project_root: Path) -> Path:
    """Resolve the shared "common" root for a project.

    For a linked worktree, ``git rev-parse --git-common-dir`` points at the
    main repository's ``.git`` directory; its parent is the main project root.
    For the main worktree, the common dir is ``<root>/.git`` so the parent is
    the project root itself. Falls back to the resolved input when not in a
    git repo (e.g. exploratory scratch dirs).
    """
    cwd = Path(project_root).resolve()
    common = _git_common_dir(cwd)
    if common is None:
        return cwd
    # common dir is <root>/.git — its parent is the main project root.
    return common.parent.resolve()


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


def _unpack_v2_gate_policy(wrapper: Any) -> dict[str, Any] | None:
    """meta/plan-profile.json（v2 包装体）→ Python schemaVersion:1 形状。

    门禁权威所需的四个字段（mode/planned_phases/required_gate_dag/
    required_validations_by_phase）缺一即视为不完整快照（0.2.92-era 的发布
    没有门禁 overlay），调用方回退工作副本。返回 None 表示不可用作权威。
    """
    if not isinstance(wrapper, dict):
        return None
    if wrapper.get("artifact_type") != "gate_policy":
        return None
    content = wrapper.get("content")
    if not isinstance(content, dict):
        return None
    planned = content.get("planned_phases")
    dag = content.get("required_gate_dag")
    by_phase = content.get("required_validations_by_phase")
    if (
        not isinstance(content.get("mode"), str)
        or not (isinstance(planned, list) and all(isinstance(p, str) for p in planned))
        or not isinstance(dag, dict)
        or not isinstance(by_phase, dict)
    ):
        return None
    policy: dict[str, Any] = {
        "schemaVersion": 1,
        "tier": content.get("tier"),
        "source": content.get("source"),
        "plannedPhases": list(planned),
        "requiredValidations": list(content.get("required_validations") or []),
        "requiredValidationsByPhase": dict(by_phase),
        "requiredGateDag": dict(dag),
    }
    return policy


def load_change_gate_policy(change_dir: Path) -> dict[str, Any]:
    """v2-first 的每 change 门禁策略加载（权威切换 2026-08）。

    meta/plan-profile.json（v2 发布快照，门禁字段已哈希绑定）优先于
    meta/gate-policy.json（classify 在 0.5 写的工作副本）。v2 快照不完整
    或缺失 → 回退工作副本。两者并存且 plannedPhases（canonical 归一去重
    后）不一致 → drift 报告，策略以 v2 为准（已审批定稿 > 工作副本；
    发布后改写工作副本本身就是异常）。

    返回 ``{"policy": <schemaVersion:1 dict 或 None>, "source":
    "v2-plan-profile" | "gate-policy-json" | None, "drift": dict | None,
    "working_error": bool}``——``working_error`` 区分"工作副本不存在"与
    "存在但不可读"（`_phase_plan` 的 legacy:policy-unreadable 语义靠它）。
    """
    change_dir = Path(change_dir)
    v2_policy: dict[str, Any] | None = None
    v2_path = change_dir / "meta" / "plan-profile.json"
    if v2_path.is_file():
        try:
            v2_policy = _unpack_v2_gate_policy(
                json.loads(v2_path.read_text(encoding="utf-8-sig"))
            )
        except (OSError, ValueError, json.JSONDecodeError):
            v2_policy = None

    working: dict[str, Any] | None = None
    working_error = False
    working_path = change_dir / "meta" / "gate-policy.json"
    if working_path.is_file():
        try:
            candidate = json.loads(working_path.read_text(encoding="utf-8-sig"))
            # 工作副本保持与历史一致的宽松接受：任何 dict 都交给下游各自的
            # 形状校验（effective_workflow_policy 查 schemaVersion，reconcile
            # 查 requiredGateDag），加载器不提前收紧。
            if isinstance(candidate, dict):
                working = candidate
            else:
                working_error = True
        except (OSError, ValueError, json.JSONDecodeError):
            working_error = True

    drift: dict[str, Any] | None = None
    if v2_policy is not None and working is not None:
        canonical = lambda names: sorted(
            {name for raw in (names or []) if (name := resolve_phase_name(raw))}
        )
        v2_phases = canonical(v2_policy.get("plannedPhases"))
        working_phases = canonical(working.get("plannedPhases"))
        if v2_phases != working_phases:
            drift = {
                "kind": "plannedPhases",
                "v2": v2_phases,
                "gate_policy_json": working_phases,
                "resolution": "v2-plan-profile wins (approved publication snapshot)",
            }

    if v2_policy is not None:
        return {
            "policy": v2_policy,
            "source": "v2-plan-profile",
            "drift": drift,
            "working_error": working_error,
        }
    if working is not None:
        return {
            "policy": working,
            "source": "gate-policy-json",
            "drift": None,
            "working_error": False,
        }
    return {
        "policy": None,
        "source": None,
        "drift": None,
        "working_error": working_error,
    }


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


class CleanupTopologyError(ValueError):
    """Raised when cleanup would delete or traverse into state/archive roots."""

    code = "CLEANUP_TOPOLOGY_REFUSED"


# Skip descending into these when scanning for junction/symlink escapes.
# Matches integration HEAVY_WORKTREE_ROOTS plus .git (topology scan only).
CLEANUP_WALK_SKIP_DIRS = frozenset(
    {
        "node_modules",
        ".venv",
        "venv",
        "build",
        "dist",
        "target",
        ".cache",
        "__pycache__",
        ".git",
    }
)


def assert_cleanup_safe(
    cleanup_root: Path,
    state_roots: Sequence[Path] | None = None,
    archive_roots: Sequence[Path] | None = None,
) -> Path:
    """Refuse cleanup when state/archive roots resolve inside the cleanup tree.

    Also refuses when a junction/symlink under ``cleanup_root`` resolves into a
    protected state/archive root (Windows junction / symlink escape).
    """
    cleanup = Path(cleanup_root).resolve()
    protected: list[Path] = []
    for raw in [*(state_roots or ()), *(archive_roots or ())]:
        try:
            protected.append(Path(raw).resolve())
        except OSError as exc:
            raise CleanupTopologyError(
                f"CLEANUP_TOPOLOGY_REFUSED: cannot resolve protected path {raw}: {exc}"
            ) from exc

    for prot in protected:
        if prot == cleanup or prot.is_relative_to(cleanup):
            raise CleanupTopologyError(
                "CLEANUP_TOPOLOGY_REFUSED: protected path "
                f"{prot} is inside cleanup root {cleanup}"
            )

    if cleanup.is_dir():
        for dirpath, dirnames, filenames in os.walk(cleanup, followlinks=False):
            # Inspect this level (including heavy names) for link escapes, then
            # prune descent so we do not walk install/cache trees.
            entries = [*dirnames, *filenames]
            dirnames[:] = [d for d in dirnames if d not in CLEANUP_WALK_SKIP_DIRS]
            for name in entries:
                child = Path(dirpath) / name
                try:
                    is_link = child.is_symlink()
                except OSError:
                    continue
                # Junctions often report as directories; resolve and compare.
                try:
                    resolved_child = child.resolve()
                except OSError:
                    continue
                escaped = not (
                    resolved_child == cleanup or resolved_child.is_relative_to(cleanup)
                )
                if not (is_link or escaped):
                    continue
                for prot in protected:
                    if (
                        resolved_child == prot
                        or resolved_child.is_relative_to(prot)
                        or prot.is_relative_to(resolved_child)
                    ):
                        raise CleanupTopologyError(
                            "CLEANUP_TOPOLOGY_REFUSED: cleanup path "
                            f"{child} resolves to protected {resolved_child}"
                        )
    return cleanup


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
