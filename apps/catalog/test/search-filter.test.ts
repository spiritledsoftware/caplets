import { describe, expect, it } from "vitest";
import { filterCatalogSearchRecords, type CatalogSearchRecord } from "../src/lib/search-filter";

const records: CatalogSearchRecord[] = [
  {
    id: "ast-grep",
    name: "ast-grep",
    description: "Search, scan, test, rewrite, and scaffold ast-grep rules.",
    tags: ["mcp", "code", "search"],
    trust: "official",
    setup: "ready",
    count: 0,
  },
  {
    id: "browser-use",
    name: "Browser Use",
    description: "Drive the user's real browser through Playwright MCP for local control.",
    tags: ["browser", "mcp", "playwright"],
    trust: "official",
    setup: "required",
    count: 8,
  },
  {
    id: "community-search",
    name: "Community Search",
    description: "Query a hosted community search API.",
    tags: ["search", "api"],
    trust: "community",
    setup: "unknown",
    count: 12,
  },
];

describe("catalog search filtering", () => {
  it("returns only records matching the search query", () => {
    expect(
      filterCatalogSearchRecords(records, {
        query: "ast-grep",
        trust: "all",
        setup: "all",
        tag: "all",
        sort: "rank",
      }).map((record) => record.id),
    ).toEqual(["ast-grep"]);
  });

  it("treats common separators as equivalent in search queries", () => {
    expect(
      filterCatalogSearchRecords(records, {
        query: "ast_grep",
        trust: "all",
        setup: "all",
        tag: "all",
        sort: "rank",
      }).map((record) => record.id),
    ).toEqual(["ast-grep"]);
  });

  it("uses precomputed search text for compact row fields", () => {
    expect(
      filterCatalogSearchRecords(
        [
          ...records,
          {
            id: "copy-only",
            name: "Copy Only",
            description: "A row with install command search content.",
            tags: [],
            trust: "official",
            setup: "ready",
            count: 1,
            searchText: "copy only caplets install community/tools deploy-runner",
          },
        ],
        {
          query: "deploy-runner",
          trust: "all",
          setup: "all",
          tag: "all",
          sort: "rank",
        },
      ).map((record) => record.id),
    ).toEqual(["copy-only"]);
  });

  it("matches tags and composes scope filters", () => {
    expect(
      filterCatalogSearchRecords(records, {
        query: "search",
        trust: "community",
        setup: "all",
        tag: "api",
        sort: "rank",
      }).map((record) => record.id),
    ).toEqual(["community-search"]);
  });

  it("sorts by rank or name", () => {
    expect(
      filterCatalogSearchRecords(records, {
        query: "",
        trust: "all",
        setup: "all",
        tag: "all",
        sort: "rank",
      }).map((record) => record.id),
    ).toEqual(["community-search", "browser-use", "ast-grep"]);

    expect(
      filterCatalogSearchRecords(records, {
        query: "",
        trust: "all",
        setup: "all",
        tag: "all",
        sort: "name",
      }).map((record) => record.id),
    ).toEqual(["ast-grep", "browser-use", "community-search"]);
  });
});
