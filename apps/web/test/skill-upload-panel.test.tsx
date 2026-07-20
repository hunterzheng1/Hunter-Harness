// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SkillUploadPanel } from "../components/skill-upload-panel";
import { ApiClientError, type HunterApi } from "../lib/api";

afterEach(cleanup);

const finding = {
  rule_id: "HH_PASSWORD_VALUE",
  severity: "medium" as const,
  path: "scripts/check.ps1",
  line: 4,
  column: 6,
  fingerprint: "sha256:" + "a".repeat(64),
  redacted_preview: "[REDACTED:HH_PASSWORD_VALUE]",
  overridable: true
};

describe("SkillUploadPanel", () => {
  it("separates folder and ZIP selection and immediately shows a package summary", async () => {
    const api = { uploadSkillDraft: vi.fn() } as unknown as HunterApi;
    render(<SkillUploadPanel api={api} agent="claude-code" onUploaded={() => undefined} />);
    const skillFile = new File(["---\nname: frontend-ui-beautify\ndescription: UI\n---\n"], "SKILL.md");
    Object.defineProperty(skillFile, "webkitRelativePath", { value: "frontend-ui-beautify/SKILL.md" });
    const script = new File(["Write-Host ok"], "check.ps1");
    Object.defineProperty(script, "webkitRelativePath", { value: "frontend-ui-beautify/scripts/check.ps1" });

    fireEvent.change(screen.getByLabelText(/选择文件夹|choose folder/i), {
      target: { files: [skillFile, script] }
    });
    expect(await screen.findByText("frontend-ui-beautify")).toBeInTheDocument();
    expect(screen.getByText(/2 个文件|2 files/i)).toBeInTheDocument();
    expect(screen.getByText(/SKILL\.md/)).toBeInTheDocument();
    expect(screen.getByLabelText(/选择 ZIP|choose zip/i)).toHaveAttribute("accept", ".zip");
  });

  it("keeps submission disabled when the selected ZIP cannot be inspected", async () => {
    const uploadSkillDraft = vi.fn();
    const api = { uploadSkillDraft } as unknown as HunterApi;
    render(<SkillUploadPanel api={api} agent="claude-code" onUploaded={() => undefined} />);

    fireEvent.change(screen.getByLabelText(/选择 ZIP|choose zip/i), {
      target: { files: [new File(["not-a-zip"], "broken.zip", { type: "application/zip" })] }
    });

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: /添加为未发布技能|add as unpublished/i });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(uploadSkillDraft).not.toHaveBeenCalled();
  });

  it("keeps selected files while reviewing safe findings and retries with evidence", async () => {
    const uploadSkillDraft = vi.fn()
      .mockRejectedValueOnce(new ApiClientError(422, "SENSITIVE_CONTENT_REVIEW_REQUIRED", "review", {
        scanner_version: "1.1.0",
        findings: [finding]
      }))
      .mockResolvedValueOnce({
        slug: "frontend-ui-beautify",
        agent: "claude-code",
        sourceFiles: [],
        examples: [],
        draftVersion: "0.1.0",
        checks: null,
        aiChecks: null,
        releaseNote: null,
        revision: 1,
        created_at: "2026-07-20T00:00:00Z",
        updated_at: "2026-07-20T00:00:00Z"
      });
    const onUploaded = vi.fn();
    const api = { uploadSkillDraft } as unknown as HunterApi;
    render(<SkillUploadPanel api={api} agent="claude-code" onUploaded={onUploaded} />);
    const skillFile = new File(["---\nname: frontend-ui-beautify\ndescription: UI\n---\n"], "SKILL.md");
    fireEvent.change(screen.getByLabelText(/选择文件夹|choose folder/i), { target: { files: [skillFile] } });
    const submit = screen.getByRole("button", { name: /添加为未发布|add as unpublished/i });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    expect(await screen.findByText("HH_PASSWORD_VALUE")).toBeInTheDocument();
    expect(screen.getByText("scripts/check.ps1:4")).toBeInTheDocument();
    expect(screen.queryByText(/sample-password/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/复核理由|review reason/i), {
      target: { value: "这是示例内容，确认不是真实凭证" }
    });
    fireEvent.click(screen.getByRole("button", { name: /确认并重试|confirm and retry/i }));

    await waitFor(() => expect(uploadSkillDraft).toHaveBeenCalledTimes(2));
    const retryForm = uploadSkillDraft.mock.calls[1]?.[0] as FormData;
    expect(retryForm.getAll("file")).toHaveLength(1);
    expect(JSON.parse(String(retryForm.get("sensitive_review")))).toMatchObject({
      scanner_version: "1.1.0",
      finding_fingerprints: [finding.fingerprint]
    });
    expect(onUploaded).toHaveBeenCalledWith(expect.objectContaining({ slug: "frontend-ui-beautify" }));
  });
});
