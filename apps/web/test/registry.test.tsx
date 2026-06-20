// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SkillDetail, SkillRegistry, WorkflowRegistry } from "../components/registry";

afterEach(cleanup);

describe("bootstrap workflow and skill registry", () => {
  it("shows an ordered profile workflow and its profile-specific coverage", () => {
    render(<WorkflowRegistry />);

    expect(screen.getByRole("heading", { name: /harness workflows/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /java/i }));
    expect(screen.getByText("harness-sync")).toBeInTheDocument();
    expect(screen.getAllByText(/profile-specific/i).length).toBeGreaterThan(0);
    expect(screen.getByText("harness-apidoc")).toBeInTheDocument();
  });

  it("filters skills by text, profile, and adapter", () => {
    render(<SkillRegistry />);

    fireEvent.change(screen.getByLabelText(/search skills/i), {
      target: { value: "codebase" }
    });
    expect(screen.getByText("harness-codebase-map")).toBeInTheDocument();
    expect(screen.queryByText("harness-plan")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/search skills/i), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText(/profile/i), { target: { value: "personal-automation" } });
    expect(screen.getByText("harness-skill-optimizer")).toBeInTheDocument();
    expect(screen.queryByText("harness-plan")).not.toBeInTheDocument();
  });

  it("renders canonical IR and a Claude Code adapter preview", () => {
    render(<SkillDetail skillId="harness-review" />);

    expect(screen.getByRole("heading", { name: "harness-review" })).toBeInTheDocument();
    expect(screen.getByText(/canonical skill ir/i)).toBeInTheDocument();
    expect(screen.getByText(/claude code output preview/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /forbidden actions/i })).toBeInTheDocument();
  });
});
