import { describe, expect, it } from "vitest";
import {
  catalogTags,
  catalogStateFromLocation,
  filterCatalogEntries,
  defaultCatalogState,
  parseCatalogState,
  serializeCatalogState,
  updateCatalogUrl,
  type CatalogCompactEntry,
} from "./catalog-state";

const entries: CatalogCompactEntry[] = [
  {
    entryKey: "community-low",
    id: "community-low",
    name: "Zulu Tool",
    description: "Handles pull-requests",
    tags: ["GitHub Apps"],
    trustLevel: "community",
    setupReadiness: "required",
    installCommand: { text: "caplets install community-low", copyable: true },
    installCount: 1,
    rankScore: 1,
  },
  {
    entryKey: "official-high",
    id: "official-high",
    name: "Alpha Tool",
    description: "Issue tracker",
    tags: ["Issues"],
    trustLevel: "official",
    setupReadiness: "ready",
    installCommand: { text: "caplets install official-high", copyable: true },
    installCount: 50,
    rankScore: 50,
  },
  {
    entryKey: "official-tie",
    id: "official-tie",
    name: "Beta Tool",
    description: "GitHub automation",
    tags: ["GitHub Apps"],
    trustLevel: "official",
    setupReadiness: "ready",
    installCommand: { text: "caplets install official-tie", copyable: true },
    installCount: 50,
    rankScore: 50,
  },
  {
    entryKey: "unknown-source",
    id: "unknown-source",
    name: "Opaque Tool",
    description: "No obvious terms",
    tags: [],
    trustLevel: "official",
    setupReadiness: "unknown",
    installCommand: { text: "caplets add hidden-source", copyable: true },
    source: { repository: "acme/catalog-repository" },
    workflow: { label: "Release automation" },
  },
];

describe("catalog discovery state", () => {
  it("uses defaults when no browser location exists during SSR", () => {
    expect(catalogStateFromLocation(undefined)).toEqual({
      query: "",
      scope: "all",
      setup: "all",
      tag: "all",
      sort: "rank",
    });
  });

  it("hydrates all five URL dimensions and omits defaults when serializing", () => {
    const state = parseCatalogState(
      new URLSearchParams("q=github&scope=official&setup=ready&tag=GitHub+Apps&sort=name"),
      catalogTags(entries),
    );
    expect(state).toEqual({
      query: "github",
      scope: "official",
      setup: "ready",
      tag: "GitHub Apps",
      sort: "name",
    });
    expect(serializeCatalogState(state).toString()).toBe(
      "q=github&scope=official&setup=ready&tag=GitHub+Apps&sort=name",
    );
    expect(
      serializeCatalogState(
        parseCatalogState(new URLSearchParams(), catalogTags(entries)),
      ).toString(),
    ).toBe("");

    const unknown = parseCatalogState(new URLSearchParams("setup=unknown"));
    expect(unknown.setup).toBe("unknown");
    expect(serializeCatalogState(unknown).toString()).toBe("setup=unknown");
  });

  it("normalizes unknown values and preserves unrelated query parameters", () => {
    const state = parseCatalogState(
      new URLSearchParams("scope=nope&setup=nope&tag=missing&sort=nope"),
      catalogTags(entries),
    );
    expect(state).toEqual({ query: "", scope: "all", setup: "all", tag: "all", sort: "rank" });
    expect(updateCatalogUrl("/dashboard/catalog?keep=1&scope=nope#results", state)).toBe(
      "/dashboard/catalog?keep=1#results",
    );
  });

  it("derives stable tags and applies query, scope, setup, partial tag, rank, and name behavior", () => {
    expect(catalogTags(entries)).toEqual(["GitHub Apps", "Issues"]);
    expect(
      filterCatalogEntries(entries, {
        query: "pull requests",
        scope: "all",
        setup: "all",
        tag: "all",
        sort: "rank",
      }).map((entry) => entry.entryKey),
    ).toEqual(["community-low"]);
    expect(
      filterCatalogEntries(entries, {
        query: "",
        scope: "official",
        setup: "ready",
        tag: "github",
        sort: "rank",
      }).map((entry) => entry.entryKey),
    ).toEqual(["official-tie"]);
    expect(
      filterCatalogEntries(entries, {
        query: "",
        scope: "all",
        setup: "all",
        tag: "all",
        sort: "rank",
      }).map((entry) => entry.name),
    ).toEqual(["Alpha Tool", "Beta Tool", "Zulu Tool", "Opaque Tool"]);
    expect(
      filterCatalogEntries(entries, {
        query: "",
        scope: "all",
        setup: "all",
        tag: "all",
        sort: "name",
      }).map((entry) => entry.name),
    ).toEqual(["Alpha Tool", "Beta Tool", "Opaque Tool", "Zulu Tool"]);
  });

  it("matches the public compact search corpus fields", () => {
    const base = { ...defaultCatalogState, setup: "all" };
    for (const query of ["catalog repository", "release automation", "caplets add hidden source"]) {
      expect(
        filterCatalogEntries(entries, { ...base, query }).map((entry) => entry.entryKey),
      ).toEqual(["unknown-source"]);
    }
    expect(
      filterCatalogEntries(entries, { ...base, query: "", setup: "unknown" }).map(
        (entry) => entry.entryKey,
      ),
    ).toEqual(["unknown-source"]);
  });
});
