import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const resources = join(root, "packages", "workflow-data-harness", "harness");
const packagedResources = join(root, "packages", "workflow-data-harness");
const harnessSource = join(root, "harness");
const AGENTS = ["claude-code", "codex", "cursor", "codebuddy"] as const;
const PROFILES = ["general", "java"] as const;

interface ManifestV2 {
  schema_version: 2;
  profile: "general" | "java";
  adapter: string;
  files: Array<{ path: string; sha256: string }>;
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function filePaths(directory: string, base = directory): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await filePaths(full, base));
    if (entry.isFile()) paths.push(full.slice(base.length + 1).replaceAll("\\", "/"));
  }
  return paths;
}

describe("embedded Harness Bundles", () => {
  it("keeps ignored-test repair and exact tracking contracts complete", async () => {
    const runSkill = await readFile(join(harnessSource, "harness-run", "SKILL.md"), "utf8");
    const testSkill = await readFile(join(harnessSource, "harness-test", "SKILL.md"), "utf8");
    const submitSkill = await readFile(join(harnessSource, "harness-submit", "SKILL.md"), "utf8");
    const ledgerProtocol = await readFile(
      join(harnessSource, "protocols", "ledger-protocol.md"), "utf8"
    );
    const javaProfile = await readFile(
      join(harnessSource, "overlays", "java", "PROJECT-PROFILE-EXAMPLE.md"), "utf8"
    );

    for (const text of [runSkill, testSkill]) {
      expect(text).toContain("stale-test-repair");
      expect(text).toContain("BLOCKED_PREEXISTING");
      expect(text).toContain("harness_test_guard.py record");
      expect(text).toContain("禁止临时排除测试");
    }
    expect(submitSkill).toContain("harness_test_guard.py stage");
    expect(submitSkill).toContain("禁止全局 force-add");
    expect(ledgerProtocol).toContain("diff-hash --repo <projectRoot> --base <baseCommit> --change-dir");
    expect(ledgerProtocol).toContain("content-changeset-2");
    expect(javaProfile).toContain('"testTracking"');
    expect(await exists(join(harnessSource, "scripts", "harness_test_guard.py"))).toBe(true);
  });

  it.each(PROFILES)("ships test tracking guard and policies to every %s adapter", async (profile) => {
    for (const agent of AGENTS) {
      const bundleRoot = join(resources, "bundles", profile, agent);
      expect(
        await exists(join(bundleRoot, "scripts", "harness_test_guard.py")),
        `${profile}/${agent} missing harness_test_guard.py`
      ).toBe(true);
      const runSkill = await readFile(join(bundleRoot, "harness-run", "SKILL.md"), "utf8");
      const testSkill = await readFile(join(bundleRoot, "harness-test", "SKILL.md"), "utf8");
      const submitSkill = await readFile(join(bundleRoot, "harness-submit", "SKILL.md"), "utf8");
      expect(runSkill).toContain("stale-test-repair");
      expect(testSkill).toContain("BLOCKED_PREEXISTING");
      expect(submitSkill).toContain("harness_test_guard.py stage");
    }
  });

  it("keeps plan logging, ordering, and conditional delegation contracts unambiguous", async () => {
    const planSkill = await readFile(join(harnessSource, "harness-plan", "SKILL.md"), "utf8");
    const planProtocols = await readFile(join(harnessSource, "harness-plan", "protocols.md"), "utf8");
    const planChecklist = await readFile(join(harnessSource, "harness-plan", "checklist.md"), "utf8");
    const planReference = await readFile(join(harnessSource, "harness-plan", "reference.md"), "utf8");
    const runProtocols = await readFile(join(harnessSource, "harness-run", "protocols.md"), "utf8");

    expect(planSkill).toContain("effort: medium");
    expect(planSkill).toContain("先初始化 change-name + `phase.start`");
    expect(planSkill).toContain("歧义优先检查");
    expect(planSkill).toContain("简单修复探索预算");
    expect(planSkill).toContain("阶段 3 探索默认 inline");
    expect(planSkill).toContain("仅高复杂度探索考虑委派");
    expect(planSkill).toContain("executionMode=delegated");
    expect(planSkill).toContain("fallbackPolicy=inline-no-retry");
    expect(planSkill.indexOf("先初始化 change-name + `phase.start`")).toBeLessThan(
      planSkill.indexOf("`harness-knowledge-query` 单次 query")
    );

    for (const text of [planProtocols, planChecklist, planReference, runProtocols]) {
      expect(text).not.toMatch(/(?:写入|更新|创建)[^\n]{0,80}logs\/execution-log\.md/);
      expect(text).not.toMatch(/logs\/execution-log\.md[^\n]{0,80}(?:写入|更新|创建)/);
    }
    expect(planReference).not.toContain("# 执行日志 — <change-name>");
    expect(planChecklist).toContain("确认事件早于 approved 设计文档");
    for (const text of [planChecklist, planReference]) {
      expect(text).not.toMatch(/阶段 ?5[^\n]{0,30}设计(?:审批|文档)/);
      expect(text).not.toMatch(/阶段 ?2[^\n]{0,30}Worktree 决策/);
      expect(text).not.toContain("阶段5已审核设计文档");
    }
  });

  it.each(PROFILES)(
    "routes fixed subagents only on supported %s adapters",
    async (profile) => {
      for (const agent of ["codex", "cursor"] as const) {
        const bundleRoot = join(resources, "bundles", profile, agent);
        const planSkill = await readFile(join(bundleRoot, "harness-plan", "SKILL.md"), "utf8");
        const reviewSkill = await readFile(join(bundleRoot, "harness-review", "SKILL.md"), "utf8");
        expect(planSkill).toContain("无固定 agent 预检");
        expect(planSkill).toContain("不运行 `check-agents --agent harness-explorer`");
        expect(reviewSkill).toContain("不运行固定 `harness-reviewer` 预检");
        expect(planSkill).not.toContain(
          "harness_preflight.py check-agents --skills-root <skills-root> --agent harness-explorer"
        );
        expect(reviewSkill).not.toContain(
          "harness_preflight.py check-agents --skills-root <skills-root> --agent harness-reviewer"
        );
      }

      for (const agent of ["claude-code", "codebuddy"] as const) {
        const bundleRoot = join(resources, "bundles", profile, agent);
        const planSkill = await readFile(join(bundleRoot, "harness-plan", "SKILL.md"), "utf8");
        const reviewSkill = await readFile(join(bundleRoot, "harness-review", "SKILL.md"), "utf8");
        expect(planSkill).toContain(
          "check-agents --skills-root <skills-root> --agent harness-explorer"
        );
        expect(reviewSkill).toContain(
          "check-agents --skills-root <skills-root> --agent harness-reviewer"
        );
        expect(planSkill).toContain("仅高复杂度探索考虑委派");
        expect(reviewSkill).toContain("审查执行（风险分级、inline 优先）");
      }
    }
  );

  it("documents knowledge query as one ensure-current invocation", async () => {
    const querySkill = await readFile(
      join(harnessSource, "harness-knowledge-query", "SKILL.md"), "utf8"
    );
    expect(querySkill).toContain("query 命令内部执行一次 ensure-current");
    expect(querySkill).not.toContain("sync --project <root>");
    expect(querySkill).not.toContain("sync --update");
  });

  it("keeps archive event ownership single-process", async () => {
    const archiveSkill = await readFile(join(harnessSource, "harness-archive", "SKILL.md"), "utf8");
    const archiveReference = await readFile(join(harnessSource, "harness-archive", "reference.md"), "utf8");
    const archiveChecklist = await readFile(join(harnessSource, "harness-archive", "checklist.md"), "utf8");
    const readme = await readFile(join(harnessSource, "README.md"), "utf8");

    for (const text of [archiveSkill, archiveReference, archiveChecklist, readme]) {
      expect(text).toContain("finalize 内部负责且仅负责一次 `phase.start` / `phase.end`");
      expect(text).not.toMatch(/(?:模型|skill|阶段|后续).*append `phase\.end`/);
      expect(text).not.toContain("每个阶段开始和结束都用 Edit 追加");
    }
  });

  it.each(PROFILES)("ships every Claude planning agent in the %s bundle", async (profile) => {
    const bundleRoot = join(resources, "bundles", profile, "claude-code", "agents");
    for (const agent of ["harness-explorer.md", "harness-evaluator.md", "harness-reviewer.md"]) {
      expect(await exists(join(bundleRoot, agent)), `${profile}/claude-code missing ${agent}`).toBe(true);
    }
  });

  it.each(PROFILES)("matches every %s agent manifest hash", async (profile) => {
    for (const agent of AGENTS) {
      const manifest = JSON.parse(await readFile(
        join(resources, "manifests", profile, `${agent}.json`), "utf8"
      )) as ManifestV2;
      expect(manifest.schema_version).toBe(2);
      expect(manifest.profile).toBe(profile);
      expect(manifest.adapter).toBe(agent);
      expect(manifest.files.length).toBeGreaterThan(0);
      for (const item of manifest.files) {
        const bytes = await readFile(join(resources, "bundles", profile, agent, item.path));
        expect(createHash("sha256").update(bytes).digest("hex"), `${agent}:${item.path}`)
          .toBe(item.sha256);
      }
    }
  });

  it("keeps source-only material out of runtime bundles", async () => {
    for (const profile of PROFILES) {
      for (const agent of AGENTS) {
        const bundleRoot = join(resources, "bundles", profile, agent);
        expect(await exists(join(bundleRoot, "redesign"))).toBe(false);
        expect(await exists(join(bundleRoot, "scripts", "tests"))).toBe(false);
        expect(await exists(join(bundleRoot, "shared"))).toBe(false);
        expect(await exists(join(bundleRoot, "overlays"))).toBe(false);
        expect((await filePaths(bundleRoot)).some((path) =>
          path.split("/").includes("tests")
        )).toBe(false);
      }
    }
  });

  it("keeps legacy bootstrap resources out of the workflow data package staging tree", async () => {
    expect(await exists(join(
      resources, "bundles", "general", "claude-code", "harness-plan", "SKILL.md"
    ))).toBe(true);
    expect(await exists(join(packagedResources, "bootstrap-ir"))).toBe(false);
    expect(await exists(join(packagedResources, "skills"))).toBe(false);
  });

  it("bundle actual file set equals manifest declared set — API-012/UT-030", async () => {
    for (const profile of PROFILES) {
      for (const agent of AGENTS) {
        const manifest = JSON.parse(await readFile(
          join(resources, "manifests", profile, `${agent}.json`), "utf8"
        )) as ManifestV2;
        const bundleRoot = join(resources, "bundles", profile, agent);
        const actual = new Set(await filePaths(bundleRoot));
        const declared = new Set(manifest.files.map((f) => f.path));
        const extra = [...actual].filter((p) => !declared.has(p));
        const missing = [...declared].filter((p) => !actual.has(p));
        expect(extra, `${profile}/${agent} extra files`).toEqual([]);
        expect(missing, `${profile}/${agent} missing files`).toEqual([]);
      }
    }
  });

  it.each(PROFILES)(
    "every adapter bundle carries skill-referenced support files — UT-033",
    async (profile) => {
      // design §3.8: every adapter (incl. codex) must carry the reference.md /
      // checklist.md / protocols.md a Skill's SKILL.md references. Guards
      // against the ".agents/skills/harness-plan only has SKILL.md" regression.
      // Only progressive-disclosure "Read `xxx.md`" references count — a skill
      // that declares "暂无 reference.md" (rules inline in SKILL.md) is fine.
      for (const agent of AGENTS) {
        const bundleRoot = join(resources, "bundles", profile, agent);
        const entries = await readdir(bundleRoot, { withFileTypes: true });
        const skills = entries
          .filter((e) => e.isDirectory() && e.name.startsWith("harness-"))
          .map((e) => e.name);
        expect(skills.length, `${profile}/${agent} has harness-* skills`).toBeGreaterThan(0);
        for (const skill of skills) {
          const skillMd = await readFile(join(bundleRoot, skill, "SKILL.md"), "utf8");
          const refs = new Set<string>();
          for (const m of skillMd.matchAll(/Read\s+`?([a-zA-Z0-9_.-]+\.md)`?/g)) {
            refs.add(m[1]);
          }
          for (const ref of refs) {
            if (ref === "SKILL.md") continue;
            expect(
              await exists(join(bundleRoot, skill, ref)),
              `${profile}/${agent}/${skill} references ${ref} but it is missing`
            ).toBe(true);
          }
        }
      }
    }
  );
});
