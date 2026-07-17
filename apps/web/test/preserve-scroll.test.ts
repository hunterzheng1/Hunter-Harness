import { describe, expect, it, vi } from "vitest";

import { runPreservingWindowScroll } from "../lib/preserve-scroll";

describe("runPreservingWindowScroll", () => {
  it("restores window scroll after the action", () => {
    const scrollTo = vi.fn();
    vi.stubGlobal("window", {
      scrollX: 12,
      scrollY: 640,
      scrollTo
    });
    runPreservingWindowScroll(() => {
      (window as unknown as { scrollY: number }).scrollY = 0;
    });
    expect(scrollTo).toHaveBeenCalledWith(12, 640);
    vi.unstubAllGlobals();
  });
});
