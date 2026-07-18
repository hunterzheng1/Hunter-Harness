"""API-004 / RET-14：文档—CLI 契约测试。

扫描 harness skill 文档（SKILL.md / reference.md / checklist.md）与
protocols/*.md 中所有 `harness_<name>.py <subcommand>` 引用，逐一核对：
- 被引用的脚本真实存在；
- 被引用的子命令真实存在于该脚本的 argparse 注册中（优先 build_parser()
  内省，覆盖 harness_integration 的 add() 闭包等 wrapper 注册；无 build_parser
  的脚本退化为 AST 提取 `add_parser("<sub>")` 字面量）；
- 文档不得引用不存在的命令（如已删除的 deploy diff）。
"""

from __future__ import annotations

import ast
import importlib.util
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = ROOT / "harness" / "scripts"
KNOWLEDGE_SCRIPT = (
    ROOT / "harness" / "harness-knowledge-ingest" / "scripts" / "harness_knowledge.py"
)
DOC_DIRS = [ROOT / "harness" / "protocols"] + sorted(
    path for path in (ROOT / "harness").iterdir() if path.is_dir() and path.name.startswith("harness-")
)
DOC_NAMES = {"SKILL.md", "reference.md", "checklist.md"}

# `harness_x.py <sub>`；sub 后不得紧跟标识符字符（排除 render_final_summary 之类的函数引用）。
REF_RE = re.compile(r"harness_([a-z_]+)\.py\s+([a-z][a-z0-9-]*)(?![\w-])")


def _script_paths() -> dict[str, Path]:
    paths = {
        path.stem: path
        for path in SCRIPTS_DIR.glob("harness_*.py")
        if path.name != "__init__.py"
    }
    paths["harness_knowledge"] = KNOWLEDGE_SCRIPT
    return paths


def _import_script(script: Path):
    """以 stem 为模块名导入脚本（注册进 sys.modules，dataclass 注解解析需要）。

    导入失败返回 None（调用方退化为 AST 提取）。脚本目录先入 sys.path，
    以支持脚本间的 sibling import。
    """
    scripts_dir = script.parent
    if str(scripts_dir) not in sys.path:
        sys.path.insert(0, str(scripts_dir))
    spec = importlib.util.spec_from_file_location(script.stem, script)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    sys.modules[script.stem] = module
    try:
        spec.loader.exec_module(module)
    except Exception:
        sys.modules.pop(script.stem, None)
        return None
    return module


def _ast_subcommands(script: Path) -> set[str]:
    """AST 提取所有 `*.add_parser("<literal>", ...)` 子命令名。"""
    tree = ast.parse(script.read_text(encoding="utf-8"))
    subs: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (isinstance(func, ast.Attribute) and func.attr == "add_parser"):
            continue
        if (
            node.args
            and isinstance(node.args[0], ast.Constant)
            and isinstance(node.args[0].value, str)
        ):
            subs.add(node.args[0].value)
    return subs


def _registered_subcommands(script: Path) -> set[str]:
    """优先 build_parser() 内省（覆盖 wrapper 注册，如 harness_integration 的
    `def add(name, func)` 闭包——AST 只能看到变量名，拿不到真实子命令）；
    无 build_parser 的脚本（test_guard/knowledge 在 main 内联构造）退化为
    AST 字面量提取。"""
    module = _import_script(script)
    build_parser = getattr(module, "build_parser", None) if module is not None else None
    if callable(build_parser):
        parser = build_parser()
        group = getattr(parser, "_subparsers", None)
        actions = getattr(group, "_group_actions", []) if group is not None else []
        if actions:
            choices = getattr(actions[0], "choices", None)
            if choices:
                return set(choices.keys())
    return _ast_subcommands(script)


def _doc_files() -> list[Path]:
    files: list[Path] = []
    for directory in DOC_DIRS:
        for name in DOC_NAMES:
            candidate = directory / name
            if candidate.is_file():
                files.append(candidate)
    return files


class DocCliContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.scripts = _script_paths()
        cls.subcommands = {
            name: _registered_subcommands(path) for name, path in cls.scripts.items()
        }

    def test_every_documented_subcommand_exists_in_parser(self) -> None:
        violations: list[str] = []
        checked = 0
        for doc in _doc_files():
            text = doc.read_text(encoding="utf-8")
            for match in REF_RE.finditer(text):
                script_name = f"harness_{match.group(1)}"
                sub = match.group(2)
                checked += 1
                script = self.scripts.get(script_name)
                if script is None or not script.is_file():
                    violations.append(
                        f"{doc.relative_to(ROOT)}: references missing script {script_name}.py"
                    )
                    continue
                registered = self.subcommands[script_name]
                if sub not in registered:
                    violations.append(
                        f"{doc.relative_to(ROOT)}: {script_name}.py {sub} not in "
                        f"registered subcommands {sorted(registered)}"
                    )
        self.assertGreater(checked, 20, "contract scan must cover a meaningful sample")
        self.assertEqual(violations, [])

    def test_removed_deploy_diff_not_referenced(self) -> None:
        """RET-35：raw build diff 已删除，文档不得再引用 `harness_deploy.py diff`。"""
        for doc in _doc_files():
            text = doc.read_text(encoding="utf-8")
            self.assertNotIn("harness_deploy.py diff", text, f"{doc.relative_to(ROOT)}")

    def test_docs_reference_at_least_one_subcommand_per_core_script(self) -> None:
        """核心脚本（archive/events/gate/ledger/change）必须在文档中有真实引用。"""
        referenced: dict[str, set[str]] = {}
        for doc in _doc_files():
            text = doc.read_text(encoding="utf-8")
            for match in REF_RE.finditer(text):
                referenced.setdefault(f"harness_{match.group(1)}", set()).add(match.group(2))
        for core in (
            "harness_archive",
            "harness_events",
            "harness_gate",
            "harness_ledger",
            "harness_change",
        ):
            self.assertIn(core, referenced, f"{core}.py never referenced in docs")
            self.assertTrue(referenced[core], f"{core}.py has no documented subcommand")


if __name__ == "__main__":
    unittest.main()
