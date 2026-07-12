import { describe, expect, it } from "vitest";

import {
  ExternalFetchError,
  fetchExternalSnapshot,
  fetchGithubSnapshot,
  fetchNpmSnapshot,
  normalizeGithubRef,
  normalizeNpmRef
} from "../src/external/fetchers.js";

describe("external skill source normalization", () => {
  it("normalizes npm and github refs", () => {
    expect(normalizeNpmRef(" @scope/pkg ")).toBe("@scope/pkg");
    expect(normalizeGithubRef("https://github.com/acme/widget.git")).toEqual({
      owner: "acme",
      repo: "widget",
      ref: "acme/widget"
    });
    expect(normalizeGithubRef("acme/widget")).toEqual({
      owner: "acme",
      repo: "widget",
      ref: "acme/widget"
    });
  });

  it("rejects invalid refs", () => {
    expect(() => normalizeNpmRef("")).toThrow(ExternalFetchError);
    expect(() => normalizeGithubRef("not-a-repo")).toThrow(ExternalFetchError);
  });
});

describe("external skill fetchers", () => {
  it("fetches npm metadata snapshot via injected fetch", async () => {
    const snapshot = await fetchNpmSnapshot("@acme/widget", {
      now: () => "2026-07-12T00:00:00.000Z",
      fetch: async (input) => {
        expect(String(input)).toBe("https://registry.npmjs.org/%40acme%2Fwidget");
        return new Response(JSON.stringify({
          name: "@acme/widget",
          description: "A widget",
          license: "MIT",
          homepage: "https://example.com",
          readme: "# Widget\n",
          "dist-tags": { latest: "1.2.3" }
        }), { status: 200 });
      }
    });
    expect(snapshot).toEqual({
      name: "@acme/widget",
      description: "A widget",
      version: "1.2.3",
      readme: "# Widget\n",
      installCommand: "npm install @acme/widget",
      license: "MIT",
      homepage: "https://example.com",
      releaseUrl: "https://example.com",
      fetchedAt: "2026-07-12T00:00:00.000Z"
    });
  });

  it("fetches github metadata snapshot via injected fetch", async () => {
    const calls: string[] = [];
    const snapshot = await fetchGithubSnapshot("acme", "widget", {
      now: () => "2026-07-12T01:00:00.000Z",
      githubToken: "ghp_test",
      fetch: async (input, init) => {
        const url = String(input);
        calls.push(url);
        const headers = init?.headers as Record<string, string>;
        expect(headers.authorization).toBe("Bearer ghp_test");
        if (url.endsWith("/repos/acme/widget")) {
          return new Response(JSON.stringify({
            full_name: "acme/widget",
            description: "GitHub widget",
            html_url: "https://github.com/acme/widget",
            homepage: "",
            default_branch: "main",
            license: { spdx_id: "Apache-2.0" }
          }), { status: 200 });
        }
        if (url.endsWith("/releases/latest")) {
          return new Response(JSON.stringify({
            tag_name: "v2.0.0",
            html_url: "https://github.com/acme/widget/releases/tag/v2.0.0"
          }), { status: 200 });
        }
        if (url.endsWith("/readme")) {
          return new Response(JSON.stringify({
            encoding: "base64",
            content: Buffer.from("# Hello\n").toString("base64")
          }), { status: 200 });
        }
        return new Response("not found", { status: 404 });
      }
    });
    expect(calls).toEqual([
      "https://api.github.com/repos/acme/widget",
      "https://api.github.com/repos/acme/widget/releases/latest",
      "https://api.github.com/repos/acme/widget/readme"
    ]);
    expect(snapshot).toMatchObject({
      name: "acme/widget",
      description: "GitHub widget",
      version: "v2.0.0",
      readme: "# Hello\n",
      installCommand: "https://github.com/acme/widget",
      license: "Apache-2.0",
      releaseUrl: "https://github.com/acme/widget/releases/tag/v2.0.0"
    });
  });

  it("maps missing upstream to EXTERNAL_SOURCE_NOT_FOUND", async () => {
    await expect(fetchNpmSnapshot("missing-pkg", {
      fetch: async () => new Response("missing", { status: 404 })
    })).rejects.toMatchObject({ code: "EXTERNAL_SOURCE_NOT_FOUND", statusCode: 404 });

    await expect(fetchExternalSnapshot(
      { type: "github", ref: "https://github.com/no/such" },
      { fetch: async () => new Response("missing", { status: 404 }) }
    )).rejects.toMatchObject({ code: "EXTERNAL_SOURCE_NOT_FOUND" });
  });
});
