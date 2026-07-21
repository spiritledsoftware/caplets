import type { D1Database } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import {
  getCatalogEntry,
  listCatalogEntries,
  listCompactCatalogEntries,
  listCompactCatalogEntriesPage,
} from "../src/lib/catalog-store";

describe("catalog read model", () => {
  it("serves official entries with low-count display and generated install commands", async () => {
    const entries = await listCatalogEntries();
    const github = entries.find((entry) => entry.id === "github");

    expect(github).toMatchObject({
      installCount: 0,
      installCountDisplay: "<10",
      installCommand: {
        text: "caplets install spiritledsoftware/caplets github",
        copyable: true,
      },
      trustLevel: "official",
    });
    expect(await getCatalogEntry(github?.entryKey ?? "")).toMatchObject({ id: "github" });
  });

  it("projects a complete compact index without readable content", async () => {
    const full = await listCatalogEntries();
    const compact = await listCompactCatalogEntries();

    expect(compact).toHaveLength(full.length);
    expect(compact[0]).toMatchObject({
      entryKey: expect.any(String),
      installCount: expect.any(Number),
      installCountDisplay: expect.any(String),
      rankScore: expect.any(Number),
      tags: expect.any(Array),
      warnings: expect.any(Array),
      source: expect.objectContaining({ repository: expect.any(String) }),
      installCommand: expect.objectContaining({ text: expect.any(String) }),
    });
    expect(compact.some((entry) => "contentMarkdown" in entry)).toBe(false);
  });

  it("returns deterministic keyset pages without materializing the complete index", async () => {
    const first = await listCompactCatalogEntriesPage({
      limit: 2,
      sort: "asc",
      query: "a",
    });
    expect(first.entries).toHaveLength(2);
    expect(first.nextEntryKey).toBe(first.entries.at(-1)?.entryKey);

    const second = await listCompactCatalogEntriesPage({
      limit: 2,
      sort: "asc",
      query: "a",
      after: first.nextEntryKey,
    });
    expect(second.entries.every((entry) => entry.entryKey > first.nextEntryKey!)).toBe(true);
    expect(new Set([...first.entries, ...second.entries].map((entry) => entry.entryKey)).size).toBe(
      first.entries.length + second.entries.length,
    );
  });

  it("hides suppressed entries from list and detail reads", async () => {
    const githubEntryKey = "github:spiritledsoftware:caplets:github%2Fcaplet.md:github";
    const entries = await listCatalogEntries({
      CATALOG_DB: fakeD1([githubEntryKey]),
    });
    expect(entries.some((entry) => entry.id === "github")).toBe(false);
    await expect(
      getCatalogEntry(githubEntryKey, {
        CATALOG_DB: fakeD1([githubEntryKey]),
      }),
    ).resolves.toBeUndefined();
  });
});

function fakeD1(suppressedEntryKeys: string[]) {
  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            first: async () => {
              if (sql.includes("catalog_suppressions")) {
                return suppressedEntryKeys.includes(String(values[0]))
                  ? { entry_key: values[0] }
                  : null;
              }
              return null;
            },
          };
        },
        all: async () => {
          if (sql.includes("catalog_suppressions")) {
            return { results: suppressedEntryKeys.map((entryKey) => ({ entryKey })) };
          }
          return { results: [] };
        },
      };
    },
  } as unknown as D1Database;
}
