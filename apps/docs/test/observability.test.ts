// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

describe("docs observability", () => {
  it("loads without provider env and handles navigation clicks", async () => {
    document.body.innerHTML = `<a href="/install/">Install</a>`;

    await expect(import("../src/scripts/observability")).resolves.toBeDefined();
    document.querySelector("a")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(vi.isMockFunction(document.addEventListener)).toBe(false);
  });
});
