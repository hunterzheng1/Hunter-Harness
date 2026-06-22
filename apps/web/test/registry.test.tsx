// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  category: "governance" as const,
  tags: ["security"],
  status: "published" as const,
  latest_version: "1.1.0",
  adapters: ["claude-code" as const],
  revision: 2,
  created_at: "2026-06-20T00:00:00Z",
  updated_at: "2026-06-21T00:00:00Z",
  ir
};

const securityTag = {
  tag_id: "tag_security",
  slug: "security",
  label: "Security",
  active: true,
  revision: 1,
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
    ...overrides
  } as unknown as HunterApi;
}

afterEach(cleanup);

describe("governed workflow and Skill Center", () => {
  it("loads the canonical registry, exposes governance metadata, and applies compound filters", async () => {
    render(<SkillRegistry api={api()} />);
    expect(await screen.findByText("harness-review")).toBeInTheDocument();
    expect(screen.getByText("1 workflow")).toBeInTheDocument();
    expect(screen.getByText(/validated/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/标签|Tag/i), { target: { value: "security" } });
    fireEvent.change(screen.getByLabelText(/Profile/i), { target: { value: "general" } });
    fireEvent.change(screen.getByLabelText(/状态|Status/i), { target: { value: "deprecated" } });
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
    expect(screen.getAllByText(/Canonical Skill IR/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1\.1\.0/).length).toBeGreaterThan(0);
    expect(await screen.findByText("# harness-review")).toBeInTheDocument();
    expect(screen.getByText(/npx @hunter-harness\/skill-cli install harness-review --agent claude-code/)).toBeInTheDocument();
  });

  it("removes a Skill tag directly without creating a proposal", async () => {
    const bindSkillTag = vi.fn(async () => ({ ...skill, tags: [] }));
    render(<SkillDetail api={api({ bindSkillTag })} skillId="harness-review" />);
    const remove = await screen.findByRole("button", { name: "移除标签 security" });
    fireEvent.click(remove);
    await waitFor(() => expect(bindSkillTag).toHaveBeenCalledWith("harness-review", "tag_security", true));
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
    await screen.findByText(/尚无 Workflow|No workflows/i);
    expect(screen.getByLabelText(/搜索 Workflow|Search workflows/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/搜索可用 Skill|Search available skills/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /新建 Workflow|New workflow/i }));
    fireEvent.change(screen.getByLabelText(/名称|Name/i), { target: { value: "General" } });
    fireEvent.change(screen.getByLabelText(/标识|Key/i), { target: { value: "general" } });
    fireEvent.change(screen.getByLabelText(/描述|Description/i), { target: { value: "Default workflow" } });
    fireEvent.click(screen.getByRole("button", { name: /保存|Save/i }));
    await waitFor(() => expect(createWorkflow).toHaveBeenCalledTimes(1));
  });
});
