// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ProjectRegistry } from "../components/project-registry";
import type { HunterApi, ProjectSummary } from "../lib/api";
import {
  formatProjectDateTime,
  paginateProjects,
  PROJECT_LIST_PAGE_SIZE,
  projectMatchesQuery,
  sortProjectsByUpdatedDesc
} from "../lib/project-list";

afterEach(cleanup);

function project(partial: Partial<ProjectSummary> & Pick<ProjectSummary, "project_id" | "display_name">): ProjectSummary {
  return {
    role: "owner",
    latest_project_version: "v1.0.0",
    latest_artifact_id: "art_x",
    created_at: "2026-01-01T00:00:00Z",
    current_file_count: 1,
    ...partial
  };
}

describe("project-list helpers", () => {
  it("sorts by updated_at descending and falls back to created_at", () => {
    const items = [
      project({ project_id: "a", display_name: "Alpha", updated_at: "2026-07-01T10:00:00Z" }),
      project({ project_id: "b", display_name: "Beta", created_at: "2026-07-10T12:00:00Z" }),
      project({ project_id: "c", display_name: "Charlie", updated_at: "2026-07-15T08:00:05Z" })
    ];
    expect(sortProjectsByUpdatedDesc(items).map((item) => item.project_id)).toEqual(["c", "b", "a"]);
  });

  it("formats datetime with seconds", () => {
    const formatted = formatProjectDateTime("2026-07-17T06:42:18Z", "zh");
    expect(formatted).toMatch(/2026/);
    expect(formatted).toMatch(/42/);
    expect(formatted).toMatch(/18/);
  });

  it("paginates with a safe page clamp", () => {
    const items = Array.from({ length: 13 }, (_, index) => index);
    expect(paginateProjects(items, 0, 6).pageItems).toHaveLength(6);
    expect(paginateProjects(items, 1, 6).pageItems).toEqual(items.slice(6, 12));
    expect(paginateProjects(items, 99, 6).safePage).toBe(2);
    expect(paginateProjects(items, 99, 6).pageItems).toEqual(items.slice(12));
  });

  it("matches display name or project id", () => {
    const item = project({ project_id: "agent-harness", display_name: "Agent Harness" });
    expect(projectMatchesQuery(item, "agent")).toBe(true);
    expect(projectMatchesQuery(item, "harness")).toBe(true);
    expect(projectMatchesQuery(item, "nope")).toBe(false);
  });
});

describe("ProjectRegistry list UX", () => {
  it("shows newest projects first with second-precision timestamps and pages at 6", async () => {
    const items = Array.from({ length: PROJECT_LIST_PAGE_SIZE + 3 }, (_, index) => {
      const n = index + 1;
      return project({
        project_id: `prj_${String(n).padStart(2, "0")}`,
        display_name: `Project ${String(n).padStart(2, "0")}`,
        updated_at: `2026-07-${String(Math.min(17, n)).padStart(2, "0")}T${String(n % 24).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}:${String((n * 3) % 60).padStart(2, "0")}Z`
      });
    });
    // Make Project 01 the newest explicitly.
    items[0] = project({
      project_id: "prj_01",
      display_name: "Project 01",
      updated_at: "2026-07-17T23:59:59Z"
    });
    items[1] = project({
      project_id: "prj_02",
      display_name: "Project 02",
      updated_at: "2026-07-17T22:00:00Z"
    });

    const listProjects = vi.fn(async (state: "active" | "archived" = "active") => state === "active" ? items : []);
    const api = {
      listProjects,
      listWorkflowFamilies: vi.fn(async () => []),
      getProjectWorkflowBinding: vi.fn(async () => null)
    } as unknown as HunterApi;

    render(<ProjectRegistry api={api} />);

    expect(await screen.findByRole("heading", { name: "Project 01" })).toBeInTheDocument();
    const cards = screen.getAllByRole("article").filter((node) => node.classList.contains("project-list-card"));
    expect(cards).toHaveLength(PROJECT_LIST_PAGE_SIZE);
    const firstCard = cards[0];
    expect(firstCard).toBeTruthy();
    if (firstCard === undefined) throw new Error("expected first project card");
    expect(within(firstCard).getByRole("heading", { name: "Project 01" })).toBeInTheDocument();
    // Local timezone may shift the hour; seconds must still render.
    expect(within(firstCard).getByText(/:59\b/)).toBeInTheDocument();
    expect(screen.getAllByText(/第 1\/2 页|Page 1\/2/i).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /下一页|Next/i }));
    const pageTwo = screen.getAllByRole("article").filter((node) => node.classList.contains("project-list-card"));
    expect(pageTwo).toHaveLength(3);
    expect(screen.getAllByText(/第 2\/2 页|Page 2\/2/i).length).toBeGreaterThan(0);
  });

  it("hides the pager on a single page and shows version badges", async () => {
    const items = [
      project({ project_id: "a", display_name: "Alpha", latest_project_version: "v2.4.1", updated_at: "2026-07-17T12:00:00Z" }),
      project({ project_id: "b", display_name: "Beta", latest_project_version: null, updated_at: "2026-07-16T12:00:00Z" })
    ];
    const listProjects = vi.fn(async (state: "active" | "archived" = "active") => state === "active" ? items : []);
    const api = {
      listProjects,
      listWorkflowFamilies: vi.fn(async () => []),
      getProjectWorkflowBinding: vi.fn(async () => null)
    } as unknown as HunterApi;

    render(<ProjectRegistry api={api} />);
    expect(await screen.findByText("v2.4.1")).toBeInTheDocument();
    expect(screen.getByText(/等待首次同步|Awaiting first sync/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /下一页|Next/i })).toBeNull();
    expect(document.querySelector(".project-registry-toolbar > span")?.textContent).toMatch(/2/);
  });

  it("filters by project id and closes the confirm dialog with Escape", async () => {
    const items = [
      project({ project_id: "agent-harness", display_name: "Agent Harness", updated_at: "2026-07-17T12:00:00Z" }),
      project({ project_id: "skill-registry", display_name: "Skill Registry", updated_at: "2026-07-16T12:00:00Z" })
    ];
    const listProjects = vi.fn(async (state: "active" | "archived" = "active") => state === "active" ? items : []);
    const api = {
      listProjects,
      listWorkflowFamilies: vi.fn(async () => []),
      getProjectWorkflowBinding: vi.fn(async () => null)
    } as unknown as HunterApi;

    render(<ProjectRegistry api={api} />);
    expect(await screen.findByRole("heading", { name: "Agent Harness" })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: /搜索项目|Search projects/i }), {
      target: { value: "skill-reg" }
    });
    expect(screen.getByRole("heading", { name: "Skill Registry" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Agent Harness" })).toBeNull();

    fireEvent.change(screen.getByRole("textbox", { name: /搜索项目|Search projects/i }), {
      target: { value: "" }
    });
    const archiveButtons = screen.getAllByRole("button", { name: /移到回收站|Move to recycle bin/i });
    const firstArchive = archiveButtons[0];
    expect(firstArchive).toBeTruthy();
    if (firstArchive === undefined) throw new Error("expected archive button");
    fireEvent.click(firstArchive);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    const metrics = document.querySelectorAll(".project-registry-metrics > article");
    expect(metrics).toHaveLength(3);
  });
});
