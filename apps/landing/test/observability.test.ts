// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

describe("landing observability", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  it("adds only categorical attribution to copied commands", async () => {
    document.body.innerHTML = `
      <button data-copy-value="pnpm dlx caplets setup" data-copy-label="install command"></button>
      <div data-copy-status></div>
    `;

    await import("../src/scripts/copy");
    document.querySelector("button")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "CAPLETS_INSTALL_ATTRIBUTION=landing_install pnpm dlx caplets setup",
    );
  });

  it("loads without initializing providers when env is absent", async () => {
    await expect(import("../src/scripts/observability")).resolves.toBeDefined();
  });
});
