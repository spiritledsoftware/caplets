import type { D1Database } from "@cloudflare/workers-types";
import { describe, expect, it } from "vitest";
import { getCatalogEntry, listCatalogEntries } from "../src/lib/catalog-store";

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
