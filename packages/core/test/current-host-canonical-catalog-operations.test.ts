import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as CatalogModule from "../src/current-host/catalog";
import { createCurrentHostOperations } from "../src/current-host/operations";

const mocks = vi.hoisted(() => ({
  installed: vi.fn(),
  page: vi.fn(),
  updates: vi.fn(),
}));

vi.mock("../src/current-host/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof CatalogModule>()),
  currentHostInstalledCaplets: mocks.installed,
  currentHostCatalogEntriesPage: mocks.page,
  currentHostCatalogUpdateReadiness: mocks.updates,
}));

const principal = {
  clientId: "rcli_abcdefghijklmnop",
  hostUrl: "https://caplets.example.com/",
  role: "operator" as const,
};

const entries = ["charlie", "alpha", "bravo"].map((id) => ({
  entryKey: `entry-${id}`,
  id,
  name: id,
  description: `${id} catalog entry`,
  tags: [],
  contentMarkdown: `# ${id}`,
  installCommand: { text: `caplets install ${id}`, copyable: true, revisionBound: true },
}));

describe("Current Host canonical catalog pages", () => {
  beforeEach(() => {
    mocks.installed.mockReset();
    mocks.page.mockReset();
    mocks.updates.mockReset();
    mocks.page.mockImplementation(
      async (input: { limit: number; sort: "asc" | "desc"; after?: { entryKey: string } }) => {
        const direction = input.sort === "asc" ? 1 : -1;
        const ordered = [...entries].sort(
          (left, right) =>
            direction *
            (left.entryKey < right.entryKey ? -1 : left.entryKey > right.entryKey ? 1 : 0),
        );
        const remaining =
          input.after === undefined
            ? ordered
            : ordered.filter(
                (entry) =>
                  direction *
                    (entry.entryKey < input.after!.entryKey
                      ? -1
                      : entry.entryKey > input.after!.entryKey
                        ? 1
                        : 0) >
                  0,
              );
        const items = remaining.slice(0, input.limit);
        return remaining.length > input.limit
          ? { items, nextKey: { entryKey: items.at(-1)!.entryKey } }
          : { items };
      },
    );
    mocks.installed.mockReturnValue([
      { id: "zulu", name: "Zulu" },
      { id: "alpha", name: "Alpha" },
    ]);
    mocks.updates.mockReturnValue({
      updates: [
        { id: "zulu", status: "locked", risk: null },
        { id: "alpha", status: "locked", risk: null },
      ],
    });
  });

  it("returns deterministic bounded catalog, effective Caplet, and update-candidate pages", async () => {
    const operations = createCurrentHostOperations({
      engine: { enabledServers: () => [] },
      activityLog: { append: vi.fn(), list: vi.fn().mockReturnValue({ entries: [] }) },
      version: "test-version",
    });

    const catalog = await operations.execute(principal, {
      kind: "catalog_entries_page",
      source: "official",
      query: "entry",
      limit: 2,
      sort: "asc",
    });
    const catalogNext = await operations.execute(principal, {
      kind: "catalog_entries_page",
      source: "official",
      query: "entry",
      limit: 2,
      sort: "asc",
      after: catalog.page.nextKey,
    });
    const caplets = await operations.execute(principal, {
      kind: "caplets_page",
      limit: 1,
      sort: "asc",
    });
    const candidates = await operations.execute(principal, {
      kind: "catalog_update_candidates_page",
      limit: 1,
      sort: "asc",
    });

    expect(catalog.page.items.map((entry) => entry.entryKey)).toEqual([
      "entry-alpha",
      "entry-bravo",
    ]);
    expect(catalog.page.nextKey).toEqual({ entryKey: "entry-bravo" });
    expect(catalogNext.page.items.map((entry) => entry.entryKey)).toEqual(["entry-charlie"]);
    expect(caplets.page).toEqual({
      items: [expect.objectContaining({ id: "alpha" })],
      nextKey: { id: "alpha" },
    });
    expect(candidates.page).toEqual({
      items: [expect.objectContaining({ id: "alpha" })],
      nextKey: { id: "alpha" },
    });
    const descendingCatalog = await operations.execute(principal, {
      kind: "catalog_entries_page",
      source: "official",
      query: "entry",
      limit: 2,
      sort: "desc",
    });
    const descendingCaplets = await operations.execute(principal, {
      kind: "caplets_page",
      limit: 1,
      sort: "desc",
    });
    const descendingCandidates = await operations.execute(principal, {
      kind: "catalog_update_candidates_page",
      limit: 1,
      sort: "desc",
    });
    expect(descendingCatalog.page.items.map((entry) => entry.entryKey)).toEqual([
      "entry-charlie",
      "entry-bravo",
    ]);
    expect(descendingCaplets.page.items[0]).toEqual(expect.objectContaining({ id: "zulu" }));
    expect(descendingCandidates.page.items[0]).toEqual(expect.objectContaining({ id: "zulu" }));
    expect(mocks.page).toHaveBeenCalledTimes(3);
    expect(mocks.page).toHaveBeenCalledWith({
      source: "official",
      query: "entry",
      limit: 2,
      sort: "asc",
    });
  });

  it("uses code-unit order consistently when advancing catalog cursors", async () => {
    const alternateEntries = [
      {
        ...entries[0]!,
        entryKey: "entry-a",
        id: "a",
      },
      {
        ...entries[1]!,
        entryKey: "entry-Z",
        id: "Z",
      },
    ];
    mocks.page.mockImplementation(
      async (input: { limit: number; sort: "asc" | "desc"; after?: { entryKey: string } }) => {
        const direction = input.sort === "asc" ? 1 : -1;
        const ordered = [...alternateEntries].sort(
          (left, right) =>
            direction *
            (left.entryKey < right.entryKey ? -1 : left.entryKey > right.entryKey ? 1 : 0),
        );
        const remaining =
          input.after === undefined
            ? ordered
            : ordered.filter(
                (entry) =>
                  direction *
                    (entry.entryKey < input.after!.entryKey
                      ? -1
                      : entry.entryKey > input.after!.entryKey
                        ? 1
                        : 0) >
                  0,
              );
        const items = remaining.slice(0, input.limit);
        return remaining.length > input.limit
          ? { items, nextKey: { entryKey: items.at(-1)!.entryKey } }
          : { items };
      },
    );
    const operations = createCurrentHostOperations({
      engine: { enabledServers: () => [] },
      activityLog: { append: vi.fn(), list: vi.fn().mockReturnValue({ entries: [] }) },
      version: "test-version",
    });

    const first = await operations.execute(principal, {
      kind: "catalog_entries_page",
      source: "official",
      query: "entry",
      limit: 1,
      sort: "asc",
    });
    const second = await operations.execute(principal, {
      kind: "catalog_entries_page",
      source: "official",
      query: "entry",
      limit: 1,
      sort: "asc",
      after: first.page.nextKey,
    });
    const descendingFirst = await operations.execute(principal, {
      kind: "catalog_entries_page",
      source: "official",
      query: "entry",
      limit: 1,
      sort: "desc",
    });
    const descendingSecond = await operations.execute(principal, {
      kind: "catalog_entries_page",
      source: "official",
      query: "entry",
      limit: 1,
      sort: "desc",
      after: descendingFirst.page.nextKey,
    });

    expect(first.page.items.map(({ entryKey }) => entryKey)).toEqual(["entry-Z"]);
    expect(second.page.items.map(({ entryKey }) => entryKey)).toEqual(["entry-a"]);
    expect(descendingFirst.page.items.map(({ entryKey }) => entryKey)).toEqual(["entry-a"]);
    expect(descendingSecond.page.items.map(({ entryKey }) => entryKey)).toEqual(["entry-Z"]);
  });
});
