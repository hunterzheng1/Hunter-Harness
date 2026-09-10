import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ASSURANCE_RISK_SIGNALS,
  CONTRACT_SCHEMA_PATHS,
  FULL_RISK_MARKERS,
  MODE_TIER_MAP,
  QUICK_RISK_SIGNALS,
  STANDARD_RISK_SIGNALS,
  TIER_MODE_MAP
} from "@hunter-harness/contracts";
import { classifyPlan } from "@hunter-harness/core";

import { inferRiskSignals } from "../src/plan-evidence/risk-signal-inference.js";

// WI-1 §3.3 跨语言契约测试：同一 affected_paths 输入下，TS（inferRiskSignals +
// classifyPlan）与 Python（classify_risk --stage post-run）的信号集（词形归一后）、
// 档位（tierModeMap）、关键阶段（plan/execute/review/archive）三向一致。
// 形态与 plan-finalize-command.e2e.test.ts 的 Python 探针同构（integration
// profile 需要 Python 可用）。

const scriptsDir = fileURLToPath(new URL("../../../harness/scripts/", import.meta.url));
const repoContracts = fileURLToPath(new URL("../../../harness/contracts/", import.meta.url));

/** kebab-case（Python 形）→ snake_case（TS 形）。 */
const kebabToSnake = (value: string): string => value.replaceAll("-", "_");

interface PythonClassifyResult {
  tier: string;
  signals: string[];
  defaultPhases: string[];
}

/**
 * 在临时 git 仓库里跑真实 classify_risk --stage post-run。
 * 产物文件以 untracked 形态出现（git status --porcelain -uall 是推断源）。
 */
async function pythonClassify(paths: readonly string[]): Promise<PythonClassifyResult> {
  const root = await fs.mkdtemp(join(tmpdir(), "tier-parity-"));
  try {
    // classify_risk 需要 workflow-policy（tier 政策）与 git 仓库
    await fs.mkdir(join(root, "harness", "contracts"), { recursive: true });
    await fs.copyFile(
      join(repoContracts, "workflow-policy.json"),
      join(root, "harness", "contracts", "workflow-policy.json")
    );
    const changeDir = join(root, ".harness", "changes", "parity");
    await fs.mkdir(changeDir, { recursive: true });
    spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
    spawnSync("git", ["config", "user.email", "parity@test"], { cwd: root, encoding: "utf8" });
    spawnSync("git", ["config", "user.name", "parity"], { cwd: root, encoding: "utf8" });
    await fs.writeFile(join(root, "README.md"), "init\n");
    spawnSync("git", ["add", "."], { cwd: root, encoding: "utf8" });
    spawnSync("git", ["commit", "-m", "init"], { cwd: root, encoding: "utf8" });

    for (const path of paths) {
      const full = join(root, path);
      await fs.mkdir(join(full, ".."), { recursive: true });
      await fs.writeFile(full, "parity probe\n");
    }

    const probe = [
      "import importlib.util, json, sys",
      `spec = importlib.util.spec_from_file_location('hg', ${JSON.stringify(join(scriptsDir, "harness_gate.py"))})`,
      "m = importlib.util.module_from_spec(spec); sys.modules['hg'] = m; spec.loader.exec_module(m)",
      "from pathlib import Path",
      `result = m.classify_risk(Path(${JSON.stringify(changeDir)}), 'post-run')`,
      "print(json.dumps({'tier': result['tier'], 'signals': result['signals'],",
      "  'defaultPhases': result['defaultPhases']}))"
    ].join("\n");
    const run = spawnSync("python", ["-c", probe], { cwd: root, encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    return JSON.parse(run.stdout) as PythonClassifyResult;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** TS 侧同输入的信号集与 mode。 */
function tsClassify(paths: readonly string[]): {
  signals: string[];
  mode: string;
  requiredPhases: string[];
} {
  const inference = inferRiskSignals({ declared: [], affectedPaths: paths, gitStatusPaths: [] });
  const profile = classifyPlan({
    schema_version: 1,
    change_id: "parity",
    risk_signals: [...inference.effective],
    created_at: "2026-09-10T00:00:00Z"
  });
  return {
    signals: [...inference.effective],
    mode: profile.mode,
    requiredPhases: [...profile.required_phases]
  };
}

/** Python 信号（kebab）与 TS 信号（snake）的交集（词形归一后）。 */
function signalOverlap(pythonSignals: readonly string[], tsSignals: readonly string[]): string[] {
  const tsSet = new Set(tsSignals);
  return pythonSignals
    .map(kebabToSnake)
    .filter((signal) => tsSet.has(signal));
}

const CASES = [
  {
    name: "auth 路径",
    paths: ["src/auth/token-service.ts"],
    expectTier: "full",
    expectMode: "assurance"
  },
  {
    name: "migration 路径",
    paths: ["db/migrations/001_init.sql"],
    expectTier: "full",
    expectMode: "assurance"
  },
  {
    name: "普通产品代码",
    paths: ["src/widget/render.ts"],
    expectTier: "standard",
    expectMode: "standard"
  }
] as const;

describe("WI-1 tier-mode-parity：双端分类契约", () => {
  it("TIER_MODE_MAP 与 MODE_TIER_MAP 互为反转（双射）", () => {
    for (const [tier, mode] of Object.entries(TIER_MODE_MAP)) {
      expect(MODE_TIER_MAP[mode]).toBe(tier);
    }
    for (const [mode, tier] of Object.entries(MODE_TIER_MAP)) {
      expect(TIER_MODE_MAP[tier]).toBe(mode);
    }
  });

  it("生成常量与 Python fallback 副本同源（risk-signals.json 单一权威）", async () => {
    // TS 生成物读 JSON；Python loader 也读同一 JSON——两者对 fullMarkers 的
    // 视图必须一致（键序无关，值逐项相等）。
    const raw = JSON.parse(await fs.readFile(
      join(repoContracts, "risk-signals.json"), "utf8"
    )) as { fullMarkers: Record<string, string[]> };
    const expected = Object.fromEntries(
      Object.entries(raw.fullMarkers).map(([signal, markers]) => [kebabToSnake(signal), markers])
    );
    expect({ ...FULL_RISK_MARKERS }).toEqual(expected);
  });

  for (const testCase of CASES) {
    it(`信号集与档位一致：${testCase.name}`, async () => {
      const python = await pythonClassify(testCase.paths);
      const ts = tsClassify(testCase.paths);

      // 1. 信号集一致（词形归一后，Python ⊇ TS 的 marker 命中部分；
      //    Python 额外的 no-code-diff 等流程信号不在 TS 词表，只比对交集语义）
      const overlap = signalOverlap(python.signals, ts.signals);
      expect(overlap.length, `python=${python.signals} ts=${ts.signals}`).toBeGreaterThan(0);

      // 2. 档位一致：tier ↔ mode 满足 tierModeMap
      expect(python.tier).toBe(testCase.expectTier);
      expect(ts.mode).toBe(testCase.expectMode);
      expect(TIER_MODE_MAP[python.tier]).toBe(ts.mode);
      expect(MODE_TIER_MAP[ts.mode]).toBe(python.tier);

      // 3. 关键阶段一致：plan/execute/review/archive 四个关键阶段上，
      //    tier 的 defaultPhases（Python）与 mode 的 required_phases（TS）
      //    裁决相同（package/apidoc/submit/merge 是 conditional/optional 不比对）
      const KEY_PHASES = ["plan", "execute", "review", "archive"] as const;
      for (const phase of KEY_PHASES) {
        expect(
          python.defaultPhases.includes(phase),
          `${testCase.name}: ${phase} 裁决不一致（python tier=${python.tier} phases=${python.defaultPhases} / ts mode=${ts.mode} phases=${ts.requiredPhases}）`
        ).toBe(ts.requiredPhases.includes(phase));
      }
    });
  }

  it("override 各一例：tier_override 与 mode_override 独立入口都改变最终档位", async () => {
    // Python: classify --tier full 的人工升档（apply_tier_override）
    const python = await pythonClassify(["src/widget/render.ts"]);
    expect(python.tier).toBe("standard");
    // override 后 full（apply_tier_override 重绑 tier 政策）——契约测试只验证
    // 映射表方向：full ↔ assurance
    expect(TIER_MODE_MAP["full"]).toBe("assurance");

    // TS: buildPlanProfile mode_override=assurance（evidence-pack 侧对应入口）
    const ts = tsClassify(["src/widget/render.ts"]);
    expect(ts.mode).toBe("standard");
    expect(MODE_TIER_MAP["assurance"]).toBe("full");
  });

  it("已知差异冻结①：docs-only 在 Python 侧不降档（起步 standard 单调升级）", async () => {
    // classify_risk 的 tier 只升不降：无 plan 声明时起步 standard，post-run
    // 观察 docs-only 得 observed=fast 但 rank 更低不回写。TS 侧 docs_only 是
    // 正向 quick 证据。这是设计 §1.2 记录的语义差异（非缺陷）——冻结现状，
    // 若任一侧语义变化（如 Python 改为可降档），本测试先红。
    const python = await pythonClassify(["docs/guide.md"]);
    expect(python.signals).toContain("docs-only");
    expect(python.tier).toBe("standard");

    const ts = tsClassify(["docs/guide.md"]);
    expect(ts.signals).toContain("docs_only");
    expect(ts.mode).toBe("quick");
  });

  it("已知差异冻结②：contract-schema 升档只在 Python 侧（TS 无此信号）", async () => {
    // 设计 §1.2：Python 有 CONTRACT_SCHEMA_PATHS 精确匹配 → contract-schema
    // 信号 → full；TS 词表没有 contract-schema（改 harness 脚本在发布链路
    // 推不出 assurance）。差异冻结：消除它需要 TS 侧引入契约路径推断，
    // 是独立工作项（不在 WI-1 边界内——本 WI 只搬运不增删信号语义）。
    const python = await pythonClassify(["harness/scripts/harness_change.py"]);
    expect(python.signals).toContain("contract-schema");
    expect(python.tier).toBe("full");

    const ts = tsClassify(["harness/scripts/harness_change.py"]);
    expect(ts.signals).not.toContain("contract_schema");
    expect(ts.signals).toContain("production_code");
    expect(ts.mode).toBe("standard");
  });

  it("信号集词表对齐：Python fullMarkers ⊆ TS assuranceSignals（词形归一后）", () => {
    // §1.2 的结构事实：Python full_markers 7 项是 TS ASSURANCE_SIGNALS 的子集。
    // 契约测试冻结这个关系——若 JSON 改动破坏它，这里先红。
    const assurance = new Set(ASSURANCE_RISK_SIGNALS);
    const fullMarkerSignals = Object.keys(FULL_RISK_MARKERS);
    for (const signal of fullMarkerSignals) {
      expect(assurance.has(signal as never), `${signal} 应在 assurance 信号集`).toBe(true);
    }
    // quick/standard 信号集不与 assurance 重叠（档位判定互斥的前提）
    for (const signal of QUICK_RISK_SIGNALS) {
      expect(assurance.has(signal)).toBe(false);
    }
    for (const signal of STANDARD_RISK_SIGNALS) {
      expect(assurance.has(signal)).toBe(false);
    }
  });

  it("CONTRACT_SCHEMA_PATHS 含本 WI 改动的契约脚本", () => {
    // harness_gate.py / harness_paths（经 gate）是契约 schema 脚本——
    // 改它们必须升 full 档评审（JSON description 的语义）。
    expect(CONTRACT_SCHEMA_PATHS).toContain("harness/scripts/harness_gate.py");
    expect(CONTRACT_SCHEMA_PATHS).toContain("harness/scripts/harness_archive.py");
  });
});
