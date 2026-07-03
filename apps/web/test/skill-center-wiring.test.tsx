// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SkillDetail } from "../components/registry";
import { WorkflowCenter } from "../components/workflow-center";
import { ApiClientError } from "../lib/api";
import type { HunterApi } from "../lib/api";
import type {
  DraftState,
  RegistrySkillDetail,
  RegistrySkillVersion,
  SkillCheckResult,
  SkillDiffFile
} from "@hunter-harness/contracts";

const SKILL_DESCRIPTION = "Wiring end-to-end test skill";
const skillMd = `---
name: wiring-skill
description: ${SKILL_DESCRIPTION}
kind: tooling
triggers: ["wire"]
inputs: ["source"]
outputs: ["artifact"]
forbidden_actions: ["automatic_git_write"]
required_context: ["AGENTS.md"]
version: "1.2.0"
---

# Wiring Skill

Published source.`;

const skill: RegistrySkillDetail = {
  skill_id: "skl_wiring",
  slug: "wiring-skill",
  name: "wiring-skill",
  description: SKILL_DESCRIPTION,
  kind: "tooling",
  tags: ["test"],
  status: "published",
  latest_version: "1.2.0",
  defaultAgent: "claude-code",
  agents: [
    {
      agent: "claude-code",
      enabled: true,
      isDefault: true,
      installTarget: ".claude/skills/wiring-skill",
      latestVersion: "1.2.0",
      draftVersion: null,
      sourcePackagePath: null
    }
  ],
  revision: 1,
  created_at: "2026-06-20T00:00:00Z",
  updated_at: "2026-06-21T00:00:00Z",
  sourceFiles: [{ path: "SKILL.md", content: skillMd }],
  examples: [
    {
      title: "Demo run",
      description: "Invoke from a workflow",
      request: "wire this skill",
      result: "staged draft produced",
      files: ["SKILL.md"]
    }
  ]
};

const checksResult: SkillCheckResult = {
  items: [
    { id: "c1", label: "Entry check", status: "green", message: "Found SKILL.md.", filePath: null, fixable: false },
    { id: "c2", label: "Secret scan", status: "yellow", message: "Token-like value; confirm.", filePath: "reference.md", fixable: true },
    { id: "c3", label: "Publish gate", status: "red", message: "Write boundary unclear.", filePath: "SKILL.md", fixable: true }
  ],
  summary: { green: 1, yellow: 1, red: 1 },
  checkedAt: "2026-06-25T12:00:00Z"
};

const runtimeChecks: SkillCheckResult = {
  items: [
    ...checksResult.items,
    { id: "c4", label: "Runtime scan", status: "green", message: "Re-checked against server.", filePath: null, fixable: false }
  ],
  summary: { green: 2, yellow: 1, red: 1 },
  checkedAt: "2026-06-25T12:01:00Z"
};

const draft: DraftState = {
  slug: "wiring-skill",
  agent: "claude-code",
  sourceFiles: [{ path: "SKILL.md", content: "# Wiring Skill\n\nDraft source." }],
  examples: skill.examples,
  draftVersion: "1.3.0-draft",
  checks: checksResult,
  aiChecks: null,
  releaseNote: null,
  revision: 3,
  created_at: "2026-06-25T00:00:00Z",
  updated_at: "2026-06-25T12:00:00Z"
};

const draftWithoutChecks: DraftState = { ...draft, checks: null };

const diffFiles: SkillDiffFile[] = [
  { path: "SKILL.md", status: "modified", publishedContent: "# old", draftContent: "# new" },
  { path: "new-file.md", status: "added", publishedContent: null, draftContent: "# added content" },
  { path: "gone.md", status: "removed", publishedContent: "# gone content", draftContent: null }
];

const versions: RegistrySkillVersion[] = [
  {
    skill_slug: "wiring-skill",
    version: "1.2.0",
    agent: "claude-code",
    artifacts: [],
    source_proposal_id: "skp_w1",
    sourceFiles: [{ path: "SKILL.md", content: "# v1.2.0 published" }],
    examples: [],
    changeNote: "First publish",
    created_at: "2026-06-21T00:00:00Z"
  }
];

const publishedVersion: RegistrySkillVersion = {
  skill_slug: "wiring-skill",
  version: "1.3.0",
  agent: "claude-code",
  artifacts: [],
  source_proposal_id: "skp_w2",
  sourceFiles: [{ path: "SKILL.md", content: "# v1.3.0 published" }],
  examples: [],
  changeNote: "Published from draft",
  created_at: "2026-06-26T00:00:00Z"
};

const v100Version: RegistrySkillVersion = {
  skill_slug: "wiring-skill",
  version: "1.0.0",
  agent: "claude-code",
  artifacts: [],
  source_proposal_id: "skp_w0",
  sourceFiles: [{ path: "SKILL.md", content: "# v1.0.0 published" }],
  examples: [],
  changeNote: "Bootstrap",
  created_at: "2026-06-20T00:00:00Z"
};

const v120Version: RegistrySkillVersion = {
  skill_slug: "wiring-skill",
  version: "1.2.0",
  agent: "claude-code",
  artifacts: [],
  source_proposal_id: "skp_w1",
  sourceFiles: [{ path: "SKILL.md", content: "# v1.2.0 published" }],
  examples: [],
  changeNote: "First publish",
  created_at: "2026-06-21T00:00:00Z"
};

// 倒序由 VersionHistoryPanel 内部 sort(created_at desc) 保证；fixture 按时序正序构造，与 server 返回顺序无关
const multiVersions: RegistrySkillVersion[] = [v120Version, publishedVersion];
const threeVersions: RegistrySkillVersion[] = [v100Version, v120Version, publishedVersion];

function api(overrides: Partial<HunterApi> = {}): HunterApi {
  return {
    getSkill: vi.fn(async () => skill),
    listSkillVersions: vi.fn(async () => versions),
    listTags: vi.fn(async () => []),
    getSkillDraft: vi.fn(async () => draft),
    runSkillDraftChecks: vi.fn(async () => runtimeChecks),
    diffSkillDraft: vi.fn(async () => diffFiles),
    publishSkillDraft: vi.fn(async () => publishedVersion),
    discardSkillDraft: vi.fn(async () => ({ slug: "wiring-skill", discarded: true })),
    uploadSkillDraft: vi.fn(async () => draft),
    deleteSkill: vi.fn(async () => ({ slug: "wiring-skill", deleted: true })),
    ...overrides
  } as unknown as HunterApi;
}

afterEach(cleanup);

describe("skill-center 前端接线端到端（mock API）", () => {
  it("source/examples Tab 读 getSkill 返回的 sourceFiles/examples（API-025）", async () => {
    render(<SkillDetail api={api()} skillId="wiring-skill" />);
    await screen.findByRole("heading", { name: "wiring-skill" });
    // source Tab 默认展示 published sourceFiles
    expect(await screen.findByText("SKILL.md")).toBeInTheDocument();
    expect(await screen.findByText(/Published source/)).toBeInTheDocument();
    // examples Tab
    fireEvent.click(screen.getByRole("tab", { name: /使用示例|usage examples/i }));
    expect(await screen.findByText("Demo run")).toBeInTheDocument();
  });

  it("checks Tab 由 getSkillDraft 填充草稿检查（API-022/027）", async () => {
    render(<SkillDetail api={api({ getSkillDraft: vi.fn(async () => draft) })} skillId="wiring-skill" />);
    await screen.findByRole("heading", { name: "wiring-skill" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    // draft.checks 的检查项直接渲染
    expect(await screen.findByText("Entry check")).toBeInTheDocument();
    expect(await screen.findByText("Secret scan")).toBeInTheDocument();
    expect(await screen.findByText("Publish gate")).toBeInTheDocument();
  });

  it("点检查按钮调 runSkillDraftChecks 并渲染绿黄红检查结果（API-008/UT-014）", async () => {
    const client = api({ getSkillDraft: vi.fn(async () => draftWithoutChecks), runSkillDraftChecks: vi.fn(async () => runtimeChecks) });
    render(<SkillDetail api={client} skillId="wiring-skill" />);
    await screen.findByRole("heading", { name: "wiring-skill" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    // 草稿无 checks 时初始不展示 Runtime scan
    expect(screen.queryByText("Runtime scan")).not.toBeInTheDocument();
    const checkButton = screen.getByRole("button", { name: /^检查$|^check$/i });
    fireEvent.click(checkButton);
    await waitFor(() => expect(client.runSkillDraftChecks).toHaveBeenCalledWith("wiring-skill", "claude-code"));
    // 检查结果项渲染（含运行后新增的 Runtime scan）
    expect(await screen.findByText("Runtime scan")).toBeInTheDocument();
    expect(await screen.findByText("Entry check")).toBeInTheDocument();
  });

  it("点 diff 按钮调 diffSkillDraft 并渲染 SkillDiffFile，null content 不崩（API-015/UT-015/016）", async () => {
    const client = api();
    render(<SkillDetail api={client} skillId="wiring-skill" />);
    await screen.findByRole("heading", { name: "wiring-skill" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    const diffButton = screen.getByRole("button", { name: /版本差异|version diff/i });
    fireEvent.click(diffButton);
    await waitFor(() => expect(client.diffSkillDraft).toHaveBeenCalledWith("wiring-skill", "claude-code"));
    // 三个差异文件路径均渲染（含 publishedContent=null 的 added 与 draftContent=null 的 removed）
    expect(await screen.findByText("new-file.md")).toBeInTheDocument();
    expect(await screen.findByText("gone.md")).toBeInTheDocument();
  });

  it("无差异时显空态（API-016）", async () => {
    const client = api({ diffSkillDraft: vi.fn(async () => []) });
    render(<SkillDetail api={client} skillId="wiring-skill" />);
    await screen.findByRole("heading", { name: "wiring-skill" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    fireEvent.click(screen.getByRole("button", { name: /版本差异|version diff/i }));
    await waitFor(() => expect(client.diffSkillDraft).toHaveBeenCalledWith("wiring-skill", "claude-code"));
    expect(await screen.findByText(/无差异|no difference/i)).toBeInTheDocument();
  });

  it("点发布调 publishSkillDraft({version, releaseNote}) 并刷新版本记录（API-011）", async () => {
    const client = api({ publishSkillDraft: vi.fn(async () => publishedVersion) });
    render(<SkillDetail api={client} skillId="wiring-skill" />);
    await screen.findByRole("heading", { name: "wiring-skill" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    fireEvent.click(screen.getByRole("button", { name: /^发布$|^publish$/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/新版本号|new version/i), { target: { value: "1.3.0" } });
    fireEvent.change(within(dialog).getByLabelText(/变更信息|change note/i), { target: { value: "release text" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /确认发布|confirm publish/i }));
    await waitFor(() => expect(client.publishSkillDraft).toHaveBeenCalledWith("wiring-skill", "claude-code", { version: "1.3.0", releaseNote: "release text" }));
    // 发布后刷新版本记录
    await waitFor(() => expect(client.listSkillVersions).toHaveBeenCalledTimes(2));
  });

  it("versions Tab 调 listSkillVersions 展示版本列表与选中版本 vs 上一版本 diff（API-018/019/UT-001/UT-003）", async () => {
    const client = api({ listSkillVersions: vi.fn(async () => multiVersions) });
    render(<SkillDetail api={client} skillId="wiring-skill" />);
    await screen.findByRole("heading", { name: "wiring-skill" });
    fireEvent.click(screen.getByRole("tab", { name: /版本记录|version history/i }));
    await waitFor(() => expect(client.listSkillVersions).toHaveBeenCalledWith("wiring-skill", "claude-code"));
    // 默认选中最新 v1.3.0，previous=v1.2.0 → releaseNote + diff 双栏 + diffStats
    expect(await screen.findByText("Published from draft")).toBeInTheDocument();
    expect(screen.getAllByText(/1\.3\.0/).length).toBeGreaterThan(0);
    expect(screen.getByText("# v1.2.0 published")).toBeInTheDocument();
    expect(screen.getByText("# v1.3.0 published")).toBeInTheDocument();
    expect(screen.getByText(/变更文件|changed files/i)).toBeInTheDocument();
  });

  it("选中首版本展示初始版本空状态（UT-004/COM-002）", async () => {
    const client = api({ listSkillVersions: vi.fn(async () => versions) });
    render(<SkillDetail api={client} skillId="wiring-skill" />);
    await screen.findByRole("heading", { name: "wiring-skill" });
    fireEvent.click(screen.getByRole("tab", { name: /版本记录|version history/i }));
    await waitFor(() => expect(client.listSkillVersions).toHaveBeenCalledWith("wiring-skill", "claude-code"));
    expect(await screen.findByText(/初始版本|initial version/i)).toBeInTheDocument();
    expect(screen.queryByText("# v1.2.0 published")).not.toBeInTheDocument();
  });

  it("切换版本 diff 重新计算（UT-005）", async () => {
    const client = api({ listSkillVersions: vi.fn(async () => threeVersions) });
    render(<SkillDetail api={client} skillId="wiring-skill" />);
    await screen.findByRole("heading", { name: "wiring-skill" });
    fireEvent.click(screen.getByRole("tab", { name: /版本记录|version history/i }));
    // 默认选中 v1.3.0，previous=v1.2.0
    expect(await screen.findByText("# v1.3.0 published")).toBeInTheDocument();
    expect(screen.getByText("# v1.2.0 published")).toBeInTheDocument();
    // 切换到 v1.2.0 → previous=v1.0.0
    fireEvent.click(screen.getByRole("button", { name: /v1\.2\.0/ }));
    expect(await screen.findByText("# v1.0.0 published")).toBeInTheDocument();
    expect(screen.queryByText("# v1.3.0 published")).not.toBeInTheDocument();
  });

  it("版本 diff 文件树切换显示对应文件 published/draft（UT-002）", async () => {
    const prevMulti: RegistrySkillVersion = {
      skill_slug: "wiring-skill",
      version: "1.0.0",
      agent: "claude-code",
      artifacts: [],
      source_proposal_id: "skp_m0",
      sourceFiles: [
        { path: "SKILL.md", content: "# old skill" },
        { path: "reference.md", content: "ref v1" }
      ],
      examples: [],
      changeNote: "multi prev",
      created_at: "2026-06-20T00:00:00Z"
    };
    const currMulti: RegistrySkillVersion = {
      skill_slug: "wiring-skill",
      version: "1.1.0",
      agent: "claude-code",
      artifacts: [],
      source_proposal_id: "skp_m1",
      sourceFiles: [
        { path: "SKILL.md", content: "# new skill" },
        { path: "reference.md", content: "ref v2" }
      ],
      examples: [],
      changeNote: "multi curr",
      created_at: "2026-06-22T00:00:00Z"
    };
    const client = api({ listSkillVersions: vi.fn(async () => [prevMulti, currMulti]) });
    render(<SkillDetail api={client} skillId="wiring-skill" />);
    await screen.findByRole("heading", { name: "wiring-skill" });
    fireEvent.click(screen.getByRole("tab", { name: /版本记录|version history/i }));
    // 默认选中 v1.1.0，diff 含 SKILL.md + reference.md（均 modified），默认显示 SKILL.md
    expect(await screen.findByText("# old skill")).toBeInTheDocument();
    expect(screen.getByText("# new skill")).toBeInTheDocument();
    // 切换到 reference.md
    fireEvent.click(screen.getByRole("button", { name: /reference\.md/ }));
    expect(await screen.findByText("ref v1")).toBeInTheDocument();
    expect(screen.getByText("ref v2")).toBeInTheDocument();
    expect(screen.queryByText("# old skill")).not.toBeInTheDocument();
  });

  it("per-agent 过滤：仅当前 agent 版本参与 diff（UT-006）", async () => {
    const cursorSkill: RegistrySkillDetail = {
      ...skill,
      defaultAgent: "cursor",
      agents: [{ agent: "cursor", enabled: true, isDefault: true, installTarget: ".claude/skills/wiring-skill", latestVersion: "1.1.0", draftVersion: null, sourcePackagePath: null }]
    };
    const cursorV100: RegistrySkillVersion = {
      skill_slug: "wiring-skill", version: "1.0.0", agent: "cursor", artifacts: [],
      source_proposal_id: "skp_c0",
      sourceFiles: [{ path: "SKILL.md", content: "# cursor v1.0.0" }],
      examples: [], changeNote: "cursor first", created_at: "2026-06-20T00:00:00Z"
    };
    const cursorV110: RegistrySkillVersion = {
      skill_slug: "wiring-skill", version: "1.1.0", agent: "cursor", artifacts: [],
      source_proposal_id: "skp_c1",
      sourceFiles: [{ path: "SKILL.md", content: "# cursor v1.1.0" }],
      examples: [], changeNote: "cursor second", created_at: "2026-06-22T00:00:00Z"
    };
    const ccV999: RegistrySkillVersion = {
      skill_slug: "wiring-skill", version: "9.9.9", agent: "claude-code", artifacts: [],
      source_proposal_id: "skp_cc9",
      sourceFiles: [{ path: "SKILL.md", content: "# cc v9.9.9" }],
      examples: [], changeNote: "cc other", created_at: "2026-06-25T00:00:00Z"
    };
    const client = api({
      getSkill: vi.fn(async () => cursorSkill),
      listSkillVersions: vi.fn(async () => [cursorV100, cursorV110, ccV999]),
      getSkillDraft: vi.fn(async () => draft)
    });
    render(<SkillDetail api={client} skillId="wiring-skill" />);
    await screen.findByRole("heading", { name: "wiring-skill" });
    fireEvent.click(screen.getByRole("tab", { name: /版本记录|version history/i }));
    // currentAgent 同步到 cursor 后，仅 cursor 版本参与 diff（cc v9.9.9 被过滤）
    expect(await screen.findByText("# cursor v1.0.0")).toBeInTheDocument();
    expect(screen.getByText("# cursor v1.1.0")).toBeInTheDocument();
    expect(screen.queryByText("# cc v9.9.9")).not.toBeInTheDocument();
    expect(screen.queryByText(/v9\.9\.9/)).not.toBeInTheDocument();
  });

  it("草稿不存在时 checks Tab 显空态 + 上传入口（API-028/COM-005）", async () => {
    const client = api({
      getSkillDraft: vi.fn(async () => { throw new ApiClientError(404, "DRAFT_NOT_FOUND", "no draft"); })
    });
    render(<SkillDetail api={client} skillId="wiring-skill" />);
    await screen.findByRole("heading", { name: "wiring-skill" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    expect(await screen.findByText(/暂无暂存草稿|no staged draft/i)).toBeInTheDocument();
    // 上传入口存在
    expect(screen.getByLabelText(/上传技能|upload skill/i)).toBeInTheDocument();
  });

  it("认证 401 显友好提示（INT-004）", async () => {
    const client = api({
      getSkillDraft: vi.fn(async () => draftWithoutChecks),
      runSkillDraftChecks: vi.fn(async () => { throw new ApiClientError(401, "AUTH_REQUIRED", "no token"); })
    });
    render(<SkillDetail api={client} skillId="wiring-skill" />);
    await screen.findByRole("heading", { name: "wiring-skill" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    fireEvent.click(screen.getByRole("button", { name: /^检查$|^check$/i }));
    await waitFor(() => expect(client.runSkillDraftChecks).toHaveBeenCalledWith("wiring-skill", "claude-code"));
    expect(await screen.findByText(/需要认证|authentication required/i)).toBeInTheDocument();
  });

  it("点丢弃按钮调 discardSkillDraft(slug, revision) 并刷新（API-023）", async () => {
    const discardSkillDraft = vi.fn(async () => ({ slug: "wiring-skill", discarded: true }));
    const listSkillVersions = vi.fn(async () => versions);
    const client = api({ discardSkillDraft, listSkillVersions, getSkillDraft: vi.fn(async () => draft) });
    render(<SkillDetail api={client} skillId="wiring-skill" />);
    await screen.findByRole("heading", { name: "wiring-skill" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    fireEvent.click(await screen.findByRole("button", { name: /丢弃草稿|discard draft/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /确认丢弃|confirm discard/i }));
    await waitFor(() => expect(discardSkillDraft).toHaveBeenCalledWith("wiring-skill", "claude-code", draft.revision));
    await waitFor(() => expect(listSkillVersions).toHaveBeenCalledTimes(2));
  });

  it("已有草稿时上传先弹覆盖确认，确认后才调 uploadSkillDraft（#6）", async () => {
    const uploadSkillDraft = vi.fn(async () => draft);
    const client = api({ uploadSkillDraft, getSkillDraft: vi.fn(async () => draft) });
    render(<SkillDetail api={client} skillId="wiring-skill" />);
    await screen.findByRole("heading", { name: "wiring-skill" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    const input = screen.getByLabelText(/上传技能|upload skill/i);
    fireEvent.change(input, { target: { files: [new File(["x"], "SKILL.md")] } });
    expect(uploadSkillDraft).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /覆盖并上传|overwrite and upload/i }));
    await waitFor(() => expect(uploadSkillDraft).toHaveBeenCalledTimes(1));
  });

  it("publish 失败时弹窗保持开放且保留已输入版本号（#7）", async () => {
    const publishSkillDraft = vi.fn(async () => { throw new ApiClientError(409, "VERSION_NOT_FORWARD", "stale"); });
    const client = api({ publishSkillDraft, getSkillDraft: vi.fn(async () => draft) });
    render(<SkillDetail api={client} skillId="wiring-skill" />);
    await screen.findByRole("heading", { name: "wiring-skill" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    fireEvent.click(screen.getByRole("button", { name: /^发布$|^publish$/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/新版本号|new version/i), { target: { value: "1.3.0" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /确认发布|confirm publish/i }));
    await waitFor(() => expect(publishSkillDraft).toHaveBeenCalledWith("wiring-skill", "claude-code", expect.objectContaining({ version: "1.3.0" })));
    const openDialog = await screen.findByRole("dialog");
    expect(within(openDialog).getByLabelText(/新版本号|new version/i)).toHaveValue("1.3.0");
  });

  it("definition Tab 渲染 AgentConfigsOverview 显示 agents（API-026）", async () => {
    render(<SkillDetail api={api()} skillId="wiring-skill" />);
    await screen.findByRole("heading", { name: "wiring-skill" });
    fireEvent.click(screen.getByRole("tab", { name: /系统配置|system config/i }));
    const agentChips = await screen.findAllByText("claude-code");
    expect(agentChips.some((el) => el.closest(".default-agent-actions") !== null)).toBe(true);
  });

  it("diff 401 显友好提示（401 全路径，INT-004 扩展）", async () => {
    const diffSkillDraft = vi.fn(async () => { throw new ApiClientError(401, "AUTH_REQUIRED", "no token"); });
    const client = api({ diffSkillDraft, getSkillDraft: vi.fn(async () => draftWithoutChecks) });
    render(<SkillDetail api={client} skillId="wiring-skill" />);
    await screen.findByRole("heading", { name: "wiring-skill" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    fireEvent.click(screen.getByRole("button", { name: /版本差异|version diff/i }));
    await waitFor(() => expect(diffSkillDraft).toHaveBeenCalledWith("wiring-skill", "claude-code"));
    expect(await screen.findByText(/需要认证|authentication required/i)).toBeInTheDocument();
  });

  it("publish 401 显友好提示（401 全路径）", async () => {
    const publishSkillDraft = vi.fn(async () => { throw new ApiClientError(401, "AUTH_REQUIRED", "no token"); });
    const client = api({ publishSkillDraft, getSkillDraft: vi.fn(async () => draft) });
    render(<SkillDetail api={client} skillId="wiring-skill" />);
    await screen.findByRole("heading", { name: "wiring-skill" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    fireEvent.click(screen.getByRole("button", { name: /^发布$|^publish$/i }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /确认发布|confirm publish/i }));
    await waitFor(() => expect(publishSkillDraft).toHaveBeenCalled());
    expect(await screen.findByText(/需要认证|authentication required/i)).toBeInTheDocument();
  });

  it("AgentContextSelector 渲染 agents、切换触发 getSkillDraft(agent)、set as default 调 setDefaultAgent（T27）", async () => {
    const multiSkill: RegistrySkillDetail = {
      ...skill,
      agents: [
        { agent: "claude-code", enabled: true, isDefault: true, installTarget: ".claude/skills/wiring-skill", latestVersion: "1.2.0", draftVersion: null, sourcePackagePath: null },
        { agent: "codex", enabled: true, isDefault: false, installTarget: ".harness/generated/codex/wiring-skill", latestVersion: null, draftVersion: null, sourcePackagePath: null }
      ]
    };
    const setDefaultAgent = vi.fn(async () => multiSkill);
    const getSkillDraft = vi.fn(async () => draft);
    const listSkillVersions = vi.fn(async () => versions);
    const client = api({ getSkill: vi.fn(async () => multiSkill), setDefaultAgent, getSkillDraft, listSkillVersions });
    render(<SkillDetail api={client} skillId="wiring-skill" />);
    await screen.findByRole("heading", { name: "wiring-skill" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    const agentSelect = screen.getByRole("combobox", { name: /当前 Agent|Current Agent/i });
    expect(agentSelect.querySelectorAll("option")).toHaveLength(2);
    fireEvent.change(agentSelect, { target: { value: "codex" } });
    await waitFor(() => expect(getSkillDraft).toHaveBeenCalledWith("wiring-skill", "codex"));
    const setDefaultBtn = await screen.findByRole("button", { name: /设为默认.*Codex|Set default.*Codex/i });
    fireEvent.click(setDefaultBtn);
    await waitFor(() => expect(setDefaultAgent).toHaveBeenCalledWith("wiring-skill", "codex", multiSkill.revision));
  });
});

describe("workflow center 前端接线（T19）", () => {
  function wpApi(overrides: Partial<HunterApi> = {}): HunterApi {
    return {
      listWorkflowPackages: vi.fn(async () => []),
      listWorkflowPackageVersions: vi.fn(async () => []),
      ...overrides
    } as unknown as HunterApi;
  }

  it("WorkflowCenter 挂载并调用 listWorkflowPackages", async () => {
    const a = wpApi();
    render(<WorkflowCenter api={a} />);
    await waitFor(() => expect(a.listWorkflowPackages).toHaveBeenCalledTimes(1));
  });
});
