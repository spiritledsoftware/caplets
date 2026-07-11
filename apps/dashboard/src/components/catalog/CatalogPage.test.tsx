// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dashboardApi, DashboardApiError } = vi.hoisted(() => {
  class MockDashboardApiError extends Error {
    status: number;
    body: unknown;
    constructor(message: string, options: { status: number; body: unknown }) {
      super(message);
      this.status = options.status;
      this.body = options.body;
    }
  }
  return { dashboardApi: vi.fn(), DashboardApiError: MockDashboardApiError };
});
vi.mock("@/lib/api", () => ({ dashboardApi, DashboardApiError }));

import { CatalogPage } from "./CatalogPage";
import type { CatalogCompactEntry } from "./catalog-state";

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };
let root: Root;
let host: HTMLDivElement;

function deferred<T>(): Deferred<T> {
  return Promise.withResolvers<T>();
}

function entry(index: number, overrides: Partial<CatalogCompactEntry> = {}): CatalogCompactEntry {
  return {
    entryKey: `entry-${index}`,
    id: `entry-${index}`,
    name: `Entry ${String(index).padStart(3, "0")}`,
    description: `Description ${index}`,
    tags: [index % 2 ? "odd" : "even"],
    trustLevel: index % 2 ? "community" : "official",
    setupReadiness: index % 2 ? "required" : "ready",
    installCommand: { text: `server command ${index}`, copyable: true },
    rankScore: index,
    ...overrides,
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<CatalogPage data={{ updates: { ready: true } }} action={vi.fn()} />);
  });
}
function setValue(element: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  dashboardApi.mockReset();
  window.history.replaceState({}, "", "/dashboard/catalog");
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  host?.remove();
});

describe("CatalogPage", () => {
  it("keeps server and first client render list-safe for a nested detail route", () => {
    window.history.replaceState({}, "", "/dashboard/catalog/deep-link");
    const markup = renderToString(
      <CatalogPage data={{ updates: { ready: true } }} action={vi.fn()} />,
    );
    expect(markup).toContain("Catalog");
    expect(markup).not.toContain("Loading Caplet details");
  });

  it("fetches one complete snapshot without q/limit and finds entries beyond 100", async () => {
    dashboardApi.mockResolvedValue({
      entries: Array.from({ length: 150 }, (_, index) =>
        entry(index, index === 149 ? { name: "Deep Match" } : {}),
      ),
    });
    await mount();
    await flush();
    expect(dashboardApi).toHaveBeenCalledTimes(1);
    expect(dashboardApi).toHaveBeenCalledWith(
      "catalog/search?source=official",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search Caplets"]')!;
    await act(async () => setValue(search, "Deep Match"));
    expect(document.body.textContent).toContain("1 Caplet");
    expect(document.body.textContent).toContain("Deep Match");
  });

  it("hydrates all controls, preserves unrelated params, uses replaceState, and replays popstate without rewriting", async () => {
    window.history.replaceState(
      {},
      "",
      "/dashboard/catalog?keep=1&q=entry&scope=official&setup=ready&tag=even&sort=name",
    );
    dashboardApi.mockResolvedValue({ entries: [entry(2)] });
    const replace = vi.spyOn(window.history, "replaceState");
    await mount();
    await flush();
    expect(
      (document.querySelector('[aria-label="Search Caplets"]') as HTMLInputElement).value,
    ).toBe("entry");
    expect(
      (document.querySelector('[aria-label="Catalog scope"]') as HTMLSelectElement).value,
    ).toBe("official");
    expect(
      (document.querySelector('[aria-label="Catalog setup"]') as HTMLSelectElement).value,
    ).toBe("ready");
    expect((document.querySelector('[aria-label="Catalog tag"]') as HTMLSelectElement).value).toBe(
      "even",
    );
    expect((document.querySelector('[aria-label="Catalog sort"]') as HTMLSelectElement).value).toBe(
      "name",
    );
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search Caplets"]')!;
    const writesBeforeChange = replace.mock.calls.length;
    await act(async () => setValue(search, "changed"));
    expect(window.location.search).toContain("keep=1");
    expect(replace.mock.calls.length).toBe(writesBeforeChange + 1);
    const writes = replace.mock.calls.length;
    window.history.replaceState({}, "", "/dashboard/catalog?keep=1&q=back");
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    expect(search.value).toBe("back");
    expect(replace.mock.calls.length).toBe(writes + 1);
  });

  it("normalizes unknown URL values and Reset restores defaults and search focus", async () => {
    window.history.replaceState(
      {},
      "",
      "/dashboard/catalog?keep=1&scope=x&setup=x&tag=x&sort=x&q=none",
    );
    dashboardApi.mockResolvedValue({ entries: [entry(1)] });
    await mount();
    await flush();
    expect(document.body.textContent).toContain("No Caplets found");
    await act(async () =>
      (
        Array.from(document.querySelectorAll("button")).find(
          (node) => node.textContent === "Reset",
        ) as HTMLButtonElement
      ).click(),
    );
    expect(window.location.search).toBe("?keep=1");
    expect(document.activeElement).toBe(document.querySelector('[aria-label="Search Caplets"]'));
    expect(document.body.textContent).toContain("1 Caplet");
  });

  it("offers Retry after first-load failure", async () => {
    dashboardApi
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ entries: [entry(1)] });
    await mount();
    await flush();
    expect(document.body.textContent).toContain("offline");
    await act(async () =>
      (
        Array.from(document.querySelectorAll("button")).find(
          (node) => node.textContent === "Retry",
        ) as HTMLButtonElement
      ).click(),
    );
    await flush();
    expect(dashboardApi).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Entry 001");
  });

  it("suppresses stale requests after retry", async () => {
    const first = deferred<{ entries: CatalogCompactEntry[] }>();
    const second = deferred<{ entries: CatalogCompactEntry[] }>();
    dashboardApi.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await mount();
    const firstSignal = dashboardApi.mock.calls[0]?.[1]?.signal as AbortSignal;
    await act(async () =>
      (document.querySelector('[aria-label="Retry loading catalog"]') as HTMLButtonElement).click(),
    );
    expect(firstSignal.aborted).toBe(true);
    await act(async () => second.resolve({ entries: [entry(2, { name: "Current" })] }));
    await act(async () => first.resolve({ entries: [entry(1, { name: "Stale" })] }));
    expect(document.body.textContent).toContain("Current");
    expect(document.body.textContent).not.toContain("Stale");
  });

  it("aborts a retry-created catalog request on unmount", async () => {
    const first = deferred<{ entries: CatalogCompactEntry[] }>();
    const retry = deferred<{ entries: CatalogCompactEntry[] }>();
    dashboardApi.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    await mount();
    await act(async () =>
      (document.querySelector('[aria-label="Retry loading catalog"]') as HTMLButtonElement).click(),
    );
    const retrySignal = dashboardApi.mock.calls[1]?.[1]?.signal as AbortSignal;
    await act(async () => root.unmount());
    expect(retrySignal.aborted).toBe(true);
    host.remove();
  });
  it("loads a stable deep link independently of the compact index", async () => {
    window.history.replaceState({}, "", "/dashboard/catalog/stable%3Akey");
    const complete = {
      entry: {
        ...entry(7, { entryKey: "stable:key", id: "stable" }),
        contentMarkdown: "# Stable",
        resolvedRevision: "abc123",
        indexedContentHash: "sha256:abc",
      },
      setupActions: [],
    };
    dashboardApi.mockImplementation((path: string) =>
      path.startsWith("catalog/detail?")
        ? Promise.resolve(complete)
        : Promise.resolve({ entries: [] }),
    );
    await mount();
    await flush();
    expect(host.textContent).toContain("Entry 007");
    expect(host.textContent).toContain("abc123");
    expect(document.title).toBe("Entry 007 · Catalog · Caplets Dashboard");
    expect(dashboardApi).toHaveBeenCalledWith(
      "catalog/detail?source=official&entryKey=stable%3Akey",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("aborts active detail work on unmount", async () => {
    window.history.replaceState({}, "", "/dashboard/catalog/pending");
    const detail = deferred<unknown>();
    dashboardApi.mockImplementation((path: string) =>
      path.startsWith("catalog/detail?") ? detail.promise : Promise.resolve({ entries: [] }),
    );
    await mount();
    await flush();
    const signal = dashboardApi.mock.calls.find(([path]) =>
      String(path).startsWith("catalog/detail?"),
    )?.[1]?.signal as AbortSignal;
    await act(async () => root.unmount());
    expect(signal.aborted).toBe(true);
    host.remove();
  });

  it("distinguishes missing and unreadable detail responses", async () => {
    window.history.replaceState({}, "", "/dashboard/catalog/missing");
    dashboardApi.mockImplementation((path: string) =>
      path.startsWith("catalog/detail?")
        ? Promise.reject(new DashboardApiError("missing", { status: 404, body: {} }))
        : Promise.resolve({ entries: [] }),
    );
    await mount();
    await flush();
    expect(host.textContent).toContain("This Caplet is missing or unavailable.");
    await act(async () => root.unmount());
    host.remove();

    window.history.replaceState({}, "", "/dashboard/catalog/unreadable");
    dashboardApi.mockImplementation((path: string) =>
      path.startsWith("catalog/detail?")
        ? Promise.resolve({ entry: { ...entry(8), contentMarkdown: "" }, setupActions: [] })
        : Promise.resolve({ entries: [] }),
    );
    await mount();
    await flush();
    expect(host.textContent).toContain("Entry 008");
    expect(host.textContent).toContain("Caplet content unreadable");
    expect(host.querySelector<HTMLButtonElement>("button:not([disabled])")?.textContent).not.toBe(
      "Install",
    );
  });
  it("revalidates a row before exact typed confirmation and posts the stable entry key", async () => {
    const compact = entry(3, { entryKey: "stable:three", id: "three" });
    const complete = { entry: { ...compact, contentMarkdown: "# Three" }, setupActions: [] };
    const confirmTyped = vi.fn().mockResolvedValue(true);
    const action = vi.fn(
      async (_label: string, callback: () => Promise<unknown>): Promise<void> => {
        await callback();
      },
    );
    dashboardApi.mockImplementation((path: string) => {
      if (path === "catalog/search?source=official") return Promise.resolve({ entries: [compact] });
      if (path.startsWith("catalog/detail?")) return Promise.resolve(complete);
      if (path === "catalog/install") return Promise.resolve({ installed: [] });
      return Promise.resolve({});
    });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root.render(<CatalogPage data={{}} action={action} confirmTyped={confirmTyped} />),
    );
    await flush();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[aria-label="Install Entry 003"]')?.click(),
    );
    await flush();
    expect(confirmTyped).toHaveBeenCalledWith(
      "Install Entry 003",
      expect.any(String),
      "install three",
    );
    expect(dashboardApi).toHaveBeenCalledWith("catalog/install", {
      method: "POST",
      body: JSON.stringify({ source: "official", entryKey: "stable:three" }),
    });
  });

  it("keeps transient server failures non-installable and exposes Retry", async () => {
    window.history.replaceState({}, "", "/dashboard/catalog/server-error");
    dashboardApi.mockImplementation((path: string) =>
      path.startsWith("catalog/detail?")
        ? Promise.reject(new DashboardApiError("upstream failed", { status: 500, body: {} }))
        : Promise.resolve({ entries: [] }),
    );
    await mount();
    await flush();
    expect(host.textContent).toContain("upstream failed");
    expect(document.title).toBe("Caplet unavailable · Catalog · Caplets Dashboard");
    expect(
      Array.from(host.querySelectorAll("button")).some((button) => button.textContent === "Retry"),
    ).toBe(true);
    expect(
      Array.from(host.querySelectorAll("button")).some(
        (button) => button.textContent === "Install",
      ),
    ).toBe(false);
  });
  it("suppresses duplicate detail installs and clears the lock after action rejection", async () => {
    window.history.replaceState({}, "", "/dashboard/catalog/stable");
    const complete = {
      entry: { ...entry(1, { entryKey: "stable", id: "stable" }), contentMarkdown: "# Stable" },
      setupActions: [],
    };
    const confirmation = deferred<boolean>();
    const confirmTyped = vi.fn(() => confirmation.promise);
    const action = vi
      .fn()
      .mockRejectedValueOnce(new Error("rejected"))
      .mockResolvedValue(undefined);
    dashboardApi.mockImplementation((path: string) =>
      path.startsWith("catalog/detail?")
        ? Promise.resolve(complete)
        : Promise.resolve({ entries: [] }),
    );
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () =>
      root.render(<CatalogPage data={{}} action={action} confirmTyped={confirmTyped} />),
    );
    await flush();
    const install = Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "Install",
    );
    await act(async () => {
      install?.click();
      install?.click();
    });
    expect(confirmTyped).toHaveBeenCalledTimes(1);
    await act(async () => confirmation.resolve(true));
    await flush();
    await act(async () => install?.click());
    await flush();
    expect(confirmTyped).toHaveBeenCalledTimes(2);
  });

  it("ignores a late A detail response after client navigation to B", async () => {
    const a = deferred<unknown>();
    const b = deferred<unknown>();
    const entries = [
      entry(1, { entryKey: "A", name: "Alpha" }),
      entry(2, { entryKey: "B", name: "Beta" }),
    ];
    dashboardApi.mockImplementation((path: string) =>
      path.includes("entryKey=A")
        ? a.promise
        : path.includes("entryKey=B")
          ? b.promise
          : Promise.resolve({ entries }),
    );
    await mount();
    await flush();
    await act(async () => host.querySelector<HTMLAnchorElement>('a[href$="/A"]')?.click());
    const aSignal = dashboardApi.mock.calls.find(([path]) =>
      String(path).includes("entryKey=A"),
    )?.[1]?.signal as AbortSignal;
    window.history.pushState({ catalogListHref: "/dashboard/catalog" }, "", "/dashboard/catalog/B");
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    await flush();
    expect(aSignal.aborted).toBe(true);
    await act(async () =>
      b.resolve({ entry: { ...entries[1], contentMarkdown: "# B" }, setupActions: [] }),
    );
    await flush();
    await act(async () =>
      a.resolve({ entry: { ...entries[0], contentMarkdown: "# A" }, setupActions: [] }),
    );
    await flush();
    expect(host.textContent).toContain("Beta");
    expect(host.textContent).not.toContain("Alpha");
  });

  it("preserves list query across breadcrumb and focuses the originating row or heading fallback", async () => {
    window.history.replaceState({}, "", "/dashboard/catalog?q=Entry");
    dashboardApi
      .mockResolvedValueOnce({ entries: [entry(1)] })
      .mockResolvedValue({ entry: { ...entry(1), contentMarkdown: "# One" }, setupActions: [] });
    await mount();
    await flush();
    await act(async () => host.querySelector<HTMLAnchorElement>('a[href$="/entry-1"]')?.click());
    await flush();
    await act(async () =>
      Array.from(host.querySelectorAll("button"))
        .find((button) => button.textContent === "Catalog")
        ?.click(),
    );
    await flush();
    expect(window.location.search).toBe("?q=Entry");
    expect(document.activeElement?.textContent).toBe("Entry 001");
    window.history.pushState(
      { catalogListHref: "/dashboard/catalog?q=missing" },
      "",
      "/dashboard/catalog/missing",
    );
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    await flush();
    window.history.pushState({}, "", "/dashboard/catalog?q=missing");
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    await flush();
    expect(document.activeElement?.id).toBe("catalog-title");
  });
  it("offers unknown setup readiness and restores the list title", async () => {
    document.title = "Operator";
    dashboardApi.mockResolvedValue({ entries: [entry(1, { setupReadiness: "unknown" })] });
    await mount();
    await flush();
    expect(document.title).toBe("Catalog · Caplets Dashboard");
    const setup = document.querySelector<HTMLSelectElement>('[aria-label="Catalog setup"]')!;
    expect(Array.from(setup.options, (option) => option.value)).toContain("unknown");
    await act(async () => setValue(setup, "unknown"));
    expect(host.textContent).toContain("Entry 001");
  });
});
