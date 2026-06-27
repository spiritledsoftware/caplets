// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { manyCatalogSearchRows } from "./fixtures/catalog-search-rows";
import type { CatalogSearchRow } from "../src/lib/search-row";

describe("virtual catalog results", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 720 });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1180 });
    Object.defineProperty(window, "scrollY", { configurable: true, writable: true, value: 0 });
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      media: "(max-width: 680px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
    window.scrollTo = vi.fn((options?: ScrollToOptions | number) => {
      const top = typeof options === "number" ? options : (options?.top ?? 0);
      Object.defineProperty(window, "scrollY", {
        configurable: true,
        writable: true,
        value: top,
      });
      window.dispatchEvent(new Event("scroll"));
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("renders a bounded row window for large result sets", async () => {
    mountSearchShell(manyCatalogSearchRows(10_000));

    const { initVirtualCatalogSearch } = await import("../src/scripts/virtual-results");
    const search = initVirtualCatalogSearch();

    expect(search).toBeDefined();
    expect(document.querySelector("[data-result-status]")?.textContent).toBe("10000 Caplets");
    expect(Number.parseInt(resultSpacer().style.height, 10)).toBe(720_000);
    expect(search?.renderedRowCount()).toBeGreaterThan(0);
    expect(search?.renderedRowCount()).toBeLessThan(40);
  });

  it("filters through the virtual source instead of hiding stale rendered rows", async () => {
    mountSearchShell(manyCatalogSearchRows(200));

    const { initVirtualCatalogSearch } = await import("../src/scripts/virtual-results");
    initVirtualCatalogSearch();
    input().value = "Caplet 199";
    input().dispatchEvent(new Event("input", { bubbles: true }));

    expect(document.querySelector("[data-result-status]")?.textContent).toBe("1 Caplet");
    expect(resultRows().map((row) => row.textContent ?? "")).toEqual([
      expect.stringContaining("Caplet 199"),
    ]);
  });

  it("hydrates filters from the url and resets to the first row", async () => {
    mountSearchShell(manyCatalogSearchRows(80), "http://localhost:3000/?q=caplet-70");

    const { initVirtualCatalogSearch } = await import("../src/scripts/virtual-results");
    initVirtualCatalogSearch();

    expect(input().value).toBe("caplet-70");
    expect(document.querySelector("[data-result-status]")?.textContent).toBe("1 Caplet");
    expect(resultRows()[0]?.textContent).toContain("Caplet 70");
  });

  it("uses the mobile row estimate when the compact layout is active", async () => {
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      media: "(max-width: 680px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
    mountSearchShell(manyCatalogSearchRows(10));

    const { initVirtualCatalogSearch } = await import("../src/scripts/virtual-results");
    initVirtualCatalogSearch();

    expect(resultSpacer().style.height).toBe("1840px");
  });

  it("uses delegated copy handling for virtual rows", async () => {
    mountSearchShell(manyCatalogSearchRows(20));

    await import("../src/scripts/copy");
    const { initVirtualCatalogSearch } = await import("../src/scripts/virtual-results");
    initVirtualCatalogSearch();
    document.querySelector<HTMLButtonElement>("[data-copy-command]")?.click();

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringMatching(/^caplets install spiritledsoftware\/caplets caplet-/),
    );
  });
});

function mountSearchShell(rows: CatalogSearchRow[], url = "http://localhost:3000/"): void {
  window.history.replaceState(null, "", url);
  document.body.innerHTML = `
    <section data-search-shell>
      <input data-search-input type="search" />
      <select data-filter="trust">
        <option value="all">All sources</option>
        <option value="official">Official</option>
        <option value="community">Community</option>
      </select>
      <select data-filter="setup">
        <option value="all">Any setup</option>
        <option value="ready">Ready</option>
        <option value="required">Required</option>
        <option value="unknown">Unknown</option>
      </select>
      <select data-filter="tag">
        <option value="all">Any tag</option>
        <option value="even">Even</option>
        <option value="odd">Odd</option>
      </select>
      <select data-sort>
        <option value="rank">Rank</option>
        <option value="name">Name</option>
      </select>
      <div data-result-status></div>
      <script type="application/json" data-search-index>${JSON.stringify(rows)}</script>
      <div data-result-spacer>
        <div data-result-list></div>
      </div>
      <div data-empty-state hidden>
        <button type="button" data-reset-search>Reset</button>
      </div>
    </section>
    <div data-copy-status></div>
  `;
}

function input(): HTMLInputElement {
  return document.querySelector("[data-search-input]") as HTMLInputElement;
}

function resultSpacer(): HTMLElement {
  return document.querySelector("[data-result-spacer]") as HTMLElement;
}

function resultRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll("[data-result-row]"));
}
