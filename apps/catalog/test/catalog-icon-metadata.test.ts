import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CatalogEntryRecord } from "../src/lib/catalog-store";

const catalogPath = join(import.meta.dirname, "../src/data/official-catalog.json");

const stableIconUrls = new Map([
  ["Neon", "https://neon.com/apple-touch-icon.png"],
  ["Notion", "https://www.notion.so/images/favicon.ico"],
  ["Sourcegraph", "https://sourcegraph.com/.assets/img/sourcegraph-mark.svg"],
  ["Supabase", "https://supabase.com/favicon/favicon-32x32.png"],
  ["Terraform", "https://developer.hashicorp.com/favicon.ico"],
]);

describe("catalog icon metadata", () => {
  it("uses stable renderable icon urls for providers with broken favicons", () => {
    const entries = JSON.parse(readFileSync(catalogPath, "utf8")) as CatalogEntryRecord[];

    for (const [name, expectedUrl] of stableIconUrls) {
      const entry = entries.find((candidate) => candidate.name === name);
      expect(entry?.icon?.url, name).toBe(expectedUrl);
    }
  });
});
