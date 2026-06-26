import { describe, expect, it } from "vitest";

import { computeDiff } from "../src/index.js";

describe("computeDiff", () => {
  it("marks added and modified", () => {
    const d = computeDiff(
      [{ path: "a.md", content: "1" }],
      [{ path: "b.md", content: "2" }, { path: "a.md", content: "1x" }]
    );
    expect(d.find((f) => f.path === "b.md")?.status).toBe("added");
    expect(d.find((f) => f.path === "a.md")?.status).toBe("modified");
  });

  it("marks all added when no published", () => {
    const d = computeDiff([], [{ path: "x.md", content: "y" }]);
    expect(d[0]?.status).toBe("added");
  });

  it("returns empty when content identical", () => {
    expect(computeDiff([{ path: "a.md", content: "1" }], [{ path: "a.md", content: "1" }])).toEqual([]);
  });

  it("marks removed when only published has the file", () => {
    const d = computeDiff([{ path: "a.md", content: "1" }], []);
    expect(d.find((f) => f.path === "a.md")?.status).toBe("removed");
  });
});
