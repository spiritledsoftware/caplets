// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { success, error } = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success, error } }));

import { CATALOG_RESULTS_OVERSCAN, CatalogResults, catalogRowEstimate } from "./CatalogResults";
import type { CatalogCompactEntry } from "./catalog-state";

let root: Root;
let host: HTMLDivElement;
const install = vi.fn();

function entry(index: number): CatalogCompactEntry {
  return {
    entryKey: `key-${index}`,
    id: `id-${index}`,
    name: `Entry ${index}`,
    description: `Description ${index}`,
    tags: [],
    trustLevel: index % 2 ? "community" : "official",
    setupReadiness: "ready",
    installCommand: { text: `server install command ${index}`, copyable: true },
    installCount: index,
  };
}

async function render(entries: CatalogCompactEntry[], discoveryKey = "initial") {
  await act(async () =>
    root.render(
      <CatalogResults
        discoveryKey={discoveryKey}
        visible={entries}
        onInstall={install}
        onCopy={async (command, item) => {
          try {
            await navigator.clipboard.writeText(command);
            success(`Copied install command for ${item.name}`);
          } catch (reason) {
            error(reason instanceof Error ? `Copy failed: ${reason.message}` : "Copy failed");
            throw reason;
          }
        }}
      />,
    ),
  );
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperties(window, {
    innerWidth: { configurable: true, value: 1200 },
    innerHeight: { configurable: true, value: 768 },
    scrollY: { configurable: true, value: 0 },
  });
  window.matchMedia = vi.fn((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  window.scrollTo = vi.fn();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  success.mockReset();
  error.mockReset();
  install.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("CatalogResults", () => {
  it("uses fixed-height estimates aligned to Tailwind sm and lg boundaries", () => {
    expect([1200, 1024, 1023, 960, 640, 639, 500, 421, 420, 320].map(catalogRowEstimate)).toEqual([
      112, 112, 188, 188, 188, 320, 320, 320, 320, 320,
    ]);
  });

  it("keeps 10,000 results bounded and exposes table count and row indices", async () => {
    await render(Array.from({ length: 10_000 }, (_, index) => entry(index)));
    const rows = document.querySelectorAll<HTMLElement>("[data-result-row]");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(
      Math.ceil(768 / catalogRowEstimate(1200)) + CATALOG_RESULTS_OVERSCAN * 2 + 2,
    );
    expect(document.querySelector('[role="table"]')?.getAttribute("aria-rowcount")).toBe("10001");
    expect(rows[0]?.getAttribute("aria-rowindex")).toBe("2");
    expect(rows[0]?.style.height).toBe("112px");
    expect(rows[0]?.className).toContain("overflow-hidden");
    expect(document.querySelector("[data-result-spacer]")?.getAttribute("class")).not.toContain(
      "overflow-y",
    );
  });

  it("uses stable entry keys across ordering changes and resets without stealing control focus", async () => {
    const entries = Array.from({ length: 100 }, (_, index) => entry(index));
    await render(entries);
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    await render([...entries].reverse());
    expect(document.activeElement).toBe(input);
    const mountedKeys = [...document.querySelectorAll<HTMLElement>("[data-result-row]")].map(
      (row) => row.dataset.entryKey,
    );
    expect(new Set(mountedKeys).size).toBe(mountedKeys.length);
    expect(window.scrollTo).toHaveBeenCalled();
    input.remove();
  });

  it("resets scroll when discovery changes without changing result identity", async () => {
    const entries = [entry(1), entry(2)];
    await render(entries, "q=one");
    vi.mocked(window.scrollTo).mockClear();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    await render(entries, "q=two");
    expect(window.scrollTo).toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    input.remove();
  });

  it("isolates links and actions from row navigation and keeps Install non-authorizing", async () => {
    await render([entry(1)]);
    const link = document.querySelector<HTMLAnchorElement>("[data-result-row] a")!;
    link.addEventListener("click", (event) => event.preventDefault());
    await act(async () => link.click());
    expect(install).not.toHaveBeenCalled();
    await act(async () =>
      (document.querySelector('[aria-label="Install Entry 1"]') as HTMLButtonElement).click(),
    );
    expect(install).toHaveBeenCalledWith(expect.objectContaining({ entryKey: "key-1" }));
  });
  it("renders server icon metadata with failure fallback and bounded safety signals", async () => {
    await render([
      {
        ...entry(3),
        icon: { type: "url", url: "https://cdn.example/icon.png" },
        projectBindingReadiness: "required",
        warnings: [
          { code: "one", severity: "caution", label: "Inspect", message: "Review source" },
          { code: "two", severity: "danger", label: "Mutates", message: "Changes external state" },
          { code: "three", severity: "info", label: "More", message: "Additional warning" },
        ],
      },
    ]);
    const icon = document.querySelector<HTMLImageElement>("img");
    expect(icon?.src).toBe("https://cdn.example/icon.png");
    expect(icon?.loading).toBe("lazy");
    expect(icon?.referrerPolicy).toBe("no-referrer");
    expect(document.body.textContent).toContain("Project: required");
    expect(document.querySelector('[aria-label="Inspect: Review source"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="1 more warnings"]')).not.toBeNull();
    await act(async () => icon?.dispatchEvent(new Event("error")));
    expect(document.querySelector("[data-icon-fallback]")?.textContent).toBe("E");
  });

  it("copies commands and exposes the full selectable command on rejection", async () => {
    await render([entry(1)]);
    const copy = document.querySelector(
      '[aria-label="Copy install command for Entry 1"]',
    ) as HTMLButtonElement;
    await act(async () => copy.click());
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("server install command 1");
    expect(success).toHaveBeenCalled();
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(new Error("denied"));
    await act(async () => copy.click());
    const command = document.querySelector("code[role=status]")!;
    expect(command.textContent).toBe("server install command 1");
    expect(command.className).toContain("select-all");
    expect(command.getAttribute("aria-live")).toBe("assertive");
    expect(error).toHaveBeenCalledWith("Copy failed: denied");
  });
  it("does not offer Copy when the server marks its command non-copyable", async () => {
    await render([
      { ...entry(2), installCommand: { text: "server-only command", copyable: false } },
    ]);
    expect(document.querySelector('[aria-label="Copy install command for Entry 2"]')).toBeNull();
    expect(document.querySelector("code")?.textContent).toBe("server-only command");
  });

  it("remeasures on resize/media changes and removes every listener on cleanup", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    await render([entry(1)]);
    await act(async () => window.dispatchEvent(new Event("resize")));
    await act(async () => root.unmount());
    expect(add.mock.calls.some(([name]) => name === "resize")).toBe(true);
    expect(remove.mock.calls.some(([name]) => name === "resize")).toBe(true);
    root = createRoot(host);
  });
});
