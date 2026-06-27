import { describe, it, expect, vi, beforeEach } from "vitest";

import { HttpHunterApi, ApiClientError, buildUploadFormData } from "./api.js";

function resMock(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => "",
    blob: async () => new Blob(),
    headers: new Headers()
  } as unknown as Response;
}

describe("buildUploadFormData", () => {
  it("把 File[] 塞 FormData，每个带 filename（webkitRelativePath 优先）", () => {
    const f1 = new File(["a"], "SKILL.md");
    Object.defineProperty(f1, "webkitRelativePath", { value: "my-skill/SKILL.md", configurable: true });
    const f2 = new File(["b"], "ref.md");
    const fd = buildUploadFormData([f1, f2]);
    const files = fd.getAll("file");
    expect(files).toHaveLength(2);
    expect((files[0] as File).name).toBe("my-skill/SKILL.md");
  });

  it("单文件", () => {
    const fd = buildUploadFormData([new File(["x"], "a.md")]);
    expect(fd.getAll("file")).toHaveLength(1);
  });
});

describe("HttpHunterApi skill draft/check/publish/diff/delete", () => {
  let api: HttpHunterApi;
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockClear();
    api = new HttpHunterApi({
      baseUrl: "http://srv",
      tokenProvider: () => "tok",
      fetch: fetchMock as unknown as typeof globalThis.fetch
    });
  });

  async function lastCall(): Promise<{ url: string; init: RequestInit }> {
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    return { url: call[0], init: call[1] };
  }

  it("uploadSkillDraft: POST /skills/draft multipart + Idempotency-Key + Authorization + 无 Content-Type", async () => {
    fetchMock.mockResolvedValueOnce(resMock({ slug: "s", draftVersion: "0.1.0" }));
    const fd = buildUploadFormData([new File(["x"], "SKILL.md")]);
    await api.uploadSkillDraft(fd);
    const { url, init } = await lastCall();
    expect(url).toBe("http://srv/api/v1/skills/draft");
    expect(init.method).toBe("POST");
    const headers = init.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer tok");
    expect(typeof headers.get("Idempotency-Key")).toBe("string");
    expect(headers.get("Content-Type")).toBeNull();
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("getSkillDraft: GET /skills/:slug/draft", async () => {
    fetchMock.mockResolvedValueOnce(resMock({ slug: "s", draftVersion: "0.1.0" }));
    await api.getSkillDraft("s");
    const { url, init } = await lastCall();
    expect(url).toBe("http://srv/api/v1/skills/s/draft");
    expect(init.method).toBe("GET");
  });

  it("discardSkillDraft: DELETE /draft body {revision}", async () => {
    fetchMock.mockResolvedValueOnce(resMock({ slug: "s", discarded: true }));
    await api.discardSkillDraft("s", 3);
    const { url, init } = await lastCall();
    expect(url).toBe("http://srv/api/v1/skills/s/draft");
    expect(init.method).toBe("DELETE");
    expect(init.body).toBe(JSON.stringify({ revision: 3 }));
  });

  it("runSkillDraftChecks: POST /draft/checks 带 Idempotency-Key", async () => {
    fetchMock.mockResolvedValueOnce(resMock({ items: [], summary: { green: 0, yellow: 0, red: 0 }, checkedAt: "" }));
    await api.runSkillDraftChecks("s");
    const { url, init } = await lastCall();
    expect(url).toBe("http://srv/api/v1/skills/s/draft/checks");
    expect(init.method).toBe("POST");
    expect(typeof (init.headers as Headers).get("Idempotency-Key")).toBe("string");
  });

  it("publishSkillDraft: POST /publish body PublishSkillRequest", async () => {
    fetchMock.mockResolvedValueOnce(resMock({ skill_slug: "s", version: "0.1.0" }));
    await api.publishSkillDraft("s", { version: "0.1.0", releaseNote: "n" });
    const { url, init } = await lastCall();
    expect(url).toBe("http://srv/api/v1/skills/s/publish");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ version: "0.1.0", releaseNote: "n" }));
  });

  it("diffSkillDraft: GET /diff 取 .items + null content 透传", async () => {
    fetchMock.mockResolvedValueOnce(resMock({ items: [{ path: "a.md", status: "added", publishedContent: null, draftContent: "x" }] }));
    const r = await api.diffSkillDraft("s");
    const { url, init } = await lastCall();
    expect(url).toBe("http://srv/api/v1/skills/s/diff");
    expect(init.method).toBe("GET");
    expect(r).toHaveLength(1);
    expect(r[0]?.path).toBe("a.md");
    expect(r[0]?.publishedContent).toBeNull();
  });

  it("deleteSkill: DELETE /skills/:slug 带 Idempotency-Key", async () => {
    fetchMock.mockResolvedValueOnce(resMock({ slug: "s", deleted: true }));
    await api.deleteSkill("s");
    const { url, init } = await lastCall();
    expect(url).toBe("http://srv/api/v1/skills/s");
    expect(init.method).toBe("DELETE");
    expect(typeof (init.headers as Headers).get("Idempotency-Key")).toBe("string");
  });

  it("uploadSkillDraft: token 为空抛 AUTH_REQUIRED", async () => {
    const apiNoToken = new HttpHunterApi({
      baseUrl: "http://srv",
      tokenProvider: () => null,
      fetch: fetchMock as unknown as typeof globalThis.fetch
    });
    await expect(apiNoToken.uploadSkillDraft(buildUploadFormData([new File(["x"], "a")]))).rejects.toMatchObject({
      status: 401,
      code: "AUTH_REQUIRED"
    });
  });

  it("diffSkillDraft: 后端 DRAFT_NOT_FOUND 抛 ApiClientError", async () => {
    fetchMock.mockResolvedValueOnce(resMock({ error: { code: "DRAFT_NOT_FOUND", message: "no draft" } }, false, 404));
    await expect(api.diffSkillDraft("s")).rejects.toMatchObject({ status: 404, code: "DRAFT_NOT_FOUND" });
  });

  it("publishSkillDraft: 后端 VERSION_NOT_FORWARD 抛 ApiClientError", async () => {
    fetchMock.mockResolvedValueOnce(resMock({ error: { code: "VERSION_NOT_FORWARD", message: "stale" } }, false, 409));
    await expect(api.publishSkillDraft("s", { version: "0.0.1" })).rejects.toMatchObject({
      status: 409,
      code: "VERSION_NOT_FORWARD"
    });
  });
});
