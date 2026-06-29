// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SkillDetail, SkillRegistry, WorkflowRegistry } from "../components/registry";
import type { HunterApi } from "../lib/api";

const ir = {
  name: "harness-review",
  kind: "governance" as const,
  description: "Evidence based review",
  triggers: ["review"],
  inputs: ["change_ref"],
  outputs: ["review_report"],
  forbidden_actions: ["automatic_git_write"],
  required_context: ["AGENTS.md"],
  profiles: { general: { enabled: true } },
  adapters: { "claude-code": { enabled: true } },
  version: "1.1.0"
};

const skill = {
  skill_id: "skl_review",
  slug: "harness-review",
  name: "harness-review",
  description: ir.description,
  tags: ["security"],
  status: "published" as const,
  latest_version: "1.1.0",
  defaultAgent: "claude-code" as const,
  agents: [{ agent: "claude-code" as const, enabled: true, isDefault: true, installTarget: ".claude/skills/harness-review", latestVersion: "1.1.0", draftVersion: null, sourcePackagePath: null }],
  revision: 2,
  created_at: "2026-06-20T00:00:00Z",
  updated_at: "2026-06-21T00:00:00Z",
  ir,
  sourceFiles: [],
  examples: []
};

const securityTag = {
  tag_id: "tag_security",
  slug: "security",
  label: "Security",
  active: true,
  revision: 1,
  usageCount: 0,
  created_at: "2026-06-20T00:00:00Z",
  updated_at: "2026-06-20T00:00:00Z"
};

const workflow = {
  workflow_id: "wf_review",
  key: "review",
  name: "Review",
  description: "Review workflow",
  profile: "general",
  default_agent: "claude-code" as const,
  enabled: true,
  skill_slugs: ["harness-review"],
  revision: 1,
  created_at: "2026-06-20T00:00:00Z",
  updated_at: "2026-06-20T00:00:00Z"
};

const draft = {
  slug: skill.slug,
  sourceFiles: [],
  ir,
  examples: [],
  draftVersion: "0.1.0",
  checks: null,
  aiChecks: null,
  releaseNote: null,
  revision: 1,
  created_at: "2026-06-21T00:00:00Z",
  updated_at: "2026-06-21T00:00:00Z"
};

const draftChecks = {
  items: [
    { id: "c1", label: "Entry check", status: "green" as const, message: "ok", filePath: null, fixable: false },
    { id: "c2", label: "Secret scan", status: "yellow" as const, message: "warn", filePath: "reference.md", fixable: true }
  ],
  summary: { green: 1, yellow: 1, red: 0 },
  checkedAt: "2026-06-21T00:00:00Z"
};

const draftAiChecks = {
  items: [
    { id: "AI_TRIGGER_QUALITY", label: "AI 触发质量", status: "green" as const, message: "AI ok", filePath: null, fixable: false }
  ],
  summary: { green: 1, yellow: 0, red: 0 },
  checkedAt: "2026-06-21T00:00:00Z"
};

function api(overrides: Partial<HunterApi> = {}): HunterApi {
  return {
    listSkills: vi.fn(async () => [skill]),
    getSkill: vi.fn(async () => skill),
    listSkillVersions: vi.fn(async () => [{
      skill_slug: skill.slug,
      version: "1.1.0",
      ir,
      artifacts: [],
      source_proposal_id: "skp_review",
      sourceFiles: [],
      examples: [],
      changeNote: null,
      created_at: "2026-06-21T00:00:00Z"
    }]),
    listSkillProposals: vi.fn(async () => []),
    getSkillAdapterPreview: vi.fn(async () => ({
      path: ".claude/skills/harness-review/SKILL.md",
      content: "# harness-review\n",
      sourceIrHash: "sha256:" + "a".repeat(64),
      compilerVersion: "1.0.0",
      adapter: "claude-code"
    })),
    listTags: vi.fn(async () => [securityTag]),
    listWorkflows: vi.fn(async () => [workflow]),
    getSkillDraft: vi.fn(async () => draft),
    runSkillDraftChecks: vi.fn(async () => draftChecks),
    diffSkillDraft: vi.fn(async () => []),
    publishSkillDraft: vi.fn(async () => ({
      skill_slug: skill.slug,
      version: "1.2.0",
      ir,
      artifacts: [],
      source_proposal_id: "skp_new",
      sourceFiles: [],
      examples: [],
      changeNote: "published",
      created_at: "2026-06-22T00:00:00Z"
    })),
    discardSkillDraft: vi.fn(async () => ({ slug: skill.slug, discarded: true })),
    ...overrides
  } as unknown as HunterApi;
}

afterEach(cleanup);

describe("governed workflow and Skill Center", () => {
  it("loads the canonical registry, exposes governance metadata, and applies compound filters", async () => {
    render(<SkillRegistry api={api()} />);
    expect(await screen.findByText("harness-review")).toBeInTheDocument();
    expect(screen.getByText(/技能列表|Skill list/i)).toBeInTheDocument();
    expect(screen.getByText(/技能统计|Skill stats/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Security" }));
    expect(screen.getByText("harness-review")).toBeInTheDocument();
    const statusFilter = screen.getAllByLabelText(/状态|Status/i).at(0);
    expect(statusFilter).toBeDefined();
    fireEvent.change(statusFilter as HTMLElement, { target: { value: "unpublished" } });
    expect(screen.queryByText("harness-review")).not.toBeInTheDocument();
  });

  it("renders canonical IR, version history, and an agent-specific install command", async () => {
    const client = api();
    client.getSkill = vi.fn(function (this: HunterApi) {
      if (this !== client) throw new Error("API method lost its client binding");
      return Promise.resolve(skill);
    });
    render(<SkillDetail api={client} skillId="harness-review" />);
    expect(await screen.findByRole("heading", { name: "harness-review" })).toBeInTheDocument();
    expect(screen.getAllByText(/规范技能 IR|Canonical Skill IR/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1\.1\.0/).length).toBeGreaterThan(0);
    expect(await screen.findByText((content) => content.includes('"name": "harness-review"'))).toBeInTheDocument();
    expect(screen.getByText(/npx @hunter-harness\/skill-cli install harness-review --agent claude-code/)).toBeInTheDocument();
  });

  it("removes a Skill tag locally without creating a proposal", async () => {
    const bindSkillTag = vi.fn(async () => ({ ...skill, tags: [] }));
    render(<SkillDetail api={api({ bindSkillTag })} skillId="harness-review" />);
    const remove = await screen.findByRole("button", { name: /security/ });
    fireEvent.click(remove);
    await waitFor(() => expect(screen.queryByRole("button", { name: /security/ })).not.toBeInTheDocument());
    expect(bindSkillTag).not.toHaveBeenCalled();
  });

  it("creates workflows directly without a review proposal", async () => {
    const createWorkflow = vi.fn(async (input) => ({
      ...input,
      workflow_id: "wf_general",
      revision: 1,
      created_at: "2026-06-21T00:00:00Z",
      updated_at: "2026-06-21T00:00:00Z"
    }));
    render(<WorkflowRegistry api={api({ createWorkflow, listWorkflows: vi.fn(async () => []) })} />);
    await screen.findByText(/暂无工作流|No workflows/i);
    expect(screen.getByLabelText(/搜索工作流|Search workflows/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/搜索可用技能|Search available skills/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /新建工作流|New workflow/i }));
    fireEvent.change(screen.getByLabelText(/名称|Name/i), { target: { value: "General" } });
    fireEvent.change(screen.getByLabelText(/标识|Key/i), { target: { value: "general" } });
    fireEvent.change(screen.getByLabelText(/描述|Description/i), { target: { value: "Default workflow" } });
    fireEvent.click(screen.getByRole("button", { name: /保存|Save/i }));
    await waitFor(() => expect(createWorkflow).toHaveBeenCalledTimes(1));
  });

  it("uploads a skill draft via the API as FormData and refreshes the list", async () => {
    const uploadSkillDraft = vi.fn(async () => ({
      slug: "harness-review",
      sourceFiles: [],
      ir,
      examples: [],
      draftVersion: "0.1.0",
      checks: null,
      aiChecks: null,
      releaseNote: null,
      revision: 1,
      created_at: "2026-06-21T00:00:00Z",
      updated_at: "2026-06-21T00:00:00Z"
    }));
    const listSkills = vi.fn(async () => [skill]);
    render(<SkillRegistry api={api({ uploadSkillDraft, listSkills })} />);
    await screen.findByText("harness-review");
    const input = screen.getByLabelText(/选择文件|choose file/i);
    fireEvent.change(input, { target: { files: [new File([JSON.stringify(ir)], "skill.json")] } });
    const uploadButton = await screen.findByRole("button", { name: /添加为未发布|add as unpublished/i });
    await waitFor(() => expect(uploadButton).not.toBeDisabled());
    fireEvent.click(uploadButton);
    await waitFor(() => expect(uploadSkillDraft).toHaveBeenCalledTimes(1));
    const fd = (uploadSkillDraft.mock.calls as unknown as [FormData][])[0]?.[0];
    expect(fd).toBeInstanceOf(FormData);
    expect(fd?.getAll("file")).toHaveLength(1);
    expect(listSkills).toHaveBeenCalledTimes(2);
  });

  it("deletes a skill via the API and refreshes the list", async () => {
    const deleteSkill = vi.fn(async () => ({ slug: "harness-review", deleted: true }));
    const listSkills = vi.fn(async () => [skill]);
    render(<SkillRegistry api={api({ deleteSkill, listSkills })} />);
    await screen.findByText("harness-review");
    fireEvent.click(screen.getByRole("button", { name: /^删除$|^delete$/i }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^删除$|^delete$/i }));
    await waitFor(() => expect(deleteSkill).toHaveBeenCalledWith("harness-review"));
    expect(listSkills).toHaveBeenCalledTimes(2);
  });

  it("runs draft checks via the API and renders the result in the checks tab", async () => {
    const runSkillDraftChecks = vi.fn(async () => draftChecks);
    render(<SkillDetail api={api({ runSkillDraftChecks, getSkillDraft: vi.fn(async () => ({ ...draft, checks: null })) })} skillId="harness-review" />);
    await screen.findByRole("heading", { name: "harness-review" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    fireEvent.click(screen.getByRole("button", { name: /^检查$|^check$/i }));
    await waitFor(() => expect(runSkillDraftChecks).toHaveBeenCalledWith("harness-review"));
    expect(await screen.findByText("Entry check")).toBeInTheDocument();
  });

  it("runs AI checks via the API and merges with program checks (INT-002)", async () => {
    const runSkillDraftChecks = vi.fn(async () => draftChecks);
    const runSkillAiChecks = vi.fn(async () => draftAiChecks);
    render(<SkillDetail api={api({ runSkillDraftChecks, runSkillAiChecks, getSkillDraft: vi.fn(async () => ({ ...draft, checks: null, aiChecks: null })) })} skillId="harness-review" />);
    await screen.findByRole("heading", { name: "harness-review" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    fireEvent.click(screen.getByRole("button", { name: /^检查$|^check$/i }));
    await waitFor(() => expect(runSkillDraftChecks).toHaveBeenCalledWith("harness-review"));
    fireEvent.click(screen.getByRole("button", { name: /^AI 检查$|^AI check$/i }));
    await waitFor(() => expect(runSkillAiChecks).toHaveBeenCalledWith("harness-review"));
    expect(await screen.findByText("AI 触发质量")).toBeInTheDocument();
    expect(screen.getByText("Entry check")).toBeInTheDocument();
  });

  it("applyFix button triggers fix preview via the API (INT-004)", async () => {
    const previewSkillFix = vi.fn(async () => ({
      items: [{ checkId: "c2", action: "confirm" as const, label: "Secret scan", affectedPaths: ["skill-ir.json"], riskDelta: null, message: "narrowed" }],
      mergedFiles: [{ path: "skill-ir.json", status: "modified" as const, publishedContent: "{}", draftContent: "{}\n" }],
      summary: { autoCount: 0, confirmCount: 1, suggestCount: 0, changedFiles: 1, changedLines: 1 }
    }));
    const applySkillFix = vi.fn(async () => ({ ...draft, checks: null, aiChecks: null, revision: 2 }));
    render(<SkillDetail api={api({
      runSkillDraftChecks: vi.fn(async () => draftChecks),
      previewSkillFix, applySkillFix,
      getSkillDraft: vi.fn(async () => ({ ...draft, checks: null }))
    })} skillId="harness-review" />);
    await screen.findByRole("heading", { name: "harness-review" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    fireEvent.click(screen.getByRole("button", { name: /^检查$|^check$/i }));
    await waitFor(() => expect(screen.getByText("Secret scan")).toBeInTheDocument());
    const applyFixBtn = await screen.findByRole("button", { name: /应用修复|apply fix/i });
    fireEvent.click(applyFixBtn);
    await waitFor(() => expect(previewSkillFix).toHaveBeenCalledWith("harness-review", ["c2"]));
  });

  it("AI generate button fills release note textarea (T15 #1)", async () => {
    const generateReleaseNote = vi.fn(async () => ({
      releaseNote: "AI: 新增触发质量检查与发布校验",
      generatedAt: "2026-06-29T00:00:00Z"
    }));
    render(<SkillDetail api={api({ generateReleaseNote })} skillId="harness-review" />);
    await screen.findByRole("heading", { name: "harness-review" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    const publishBtn = await screen.findByRole("button", { name: /^发布$|^Publish$/i });
    fireEvent.click(publishBtn);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^AI 生成$|^AI generate$/i }));
    await waitFor(() => expect(generateReleaseNote).toHaveBeenCalledWith("harness-review"));
    expect(await screen.findByDisplayValue("AI: 新增触发质量检查与发布校验")).toBeInTheDocument();
  });

  it("AI generate degraded shows aiGenerateFailed notice (T15 #1)", async () => {
    const generateReleaseNote = vi.fn(async () => ({
      releaseNote: null,
      generatedAt: "2026-06-29T00:00:00Z",
      degraded: true,
      reason: "AI_TIMEOUT"
    }));
    render(<SkillDetail api={api({ generateReleaseNote })} skillId="harness-review" />);
    await screen.findByRole("heading", { name: "harness-review" });
    fireEvent.click(screen.getByRole("tab", { name: /检查与发布|checks & publish/i }));
    const publishBtn = await screen.findByRole("button", { name: /^发布$|^Publish$/i });
    fireEvent.click(publishBtn);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /^AI 生成$|^AI generate$/i }));
    await waitFor(() => expect(generateReleaseNote).toHaveBeenCalledWith("harness-review"));
    expect(await screen.findByText(/AI 生成失败|AI generation failed/i)).toBeInTheDocument();
  });
});
