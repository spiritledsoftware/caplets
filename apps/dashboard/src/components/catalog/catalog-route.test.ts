import { describe, expect, it } from "vitest";
import { catalogDetailHref, catalogListHref, catalogLocationFromPath } from "./catalog-route";

describe("catalog route helpers", () => {
  it("round-trips repository-qualified entry keys under root and configured base paths", () => {
    const entryKey = "github:spiritledsoftware/caplets:google-workspace/CAPLET.md";

    const rootHref = catalogDetailHref(entryKey, "/dashboard/catalog");
    const baseHref = catalogDetailHref(entryKey, "/caplets/dashboard/catalog");

    expect(rootHref).toBe(`/dashboard/catalog/${encodeURIComponent(entryKey)}`);
    expect(baseHref).toBe(`/caplets/dashboard/catalog/${encodeURIComponent(entryKey)}`);
    expect(catalogLocationFromPath(rootHref)).toEqual({ mode: "detail", entryKey });
    expect(catalogLocationFromPath(baseHref)).toEqual({ mode: "detail", entryKey });
    expect(catalogListHref(baseHref)).toBe("/caplets/dashboard/catalog");
  });

  it("keeps catalog list mode for malformed, empty, or nested path identities", () => {
    expect(catalogLocationFromPath("/dashboard/catalog")).toEqual({ mode: "list" });
    expect(catalogLocationFromPath("/dashboard/catalog/%")).toEqual({ mode: "list" });
    expect(catalogLocationFromPath("/dashboard/catalog/%2e%2e%2fsecret")).toEqual({
      mode: "list",
    });
    expect(catalogLocationFromPath("/dashboard/catalog/key%00value")).toEqual({ mode: "list" });
    expect(catalogLocationFromPath("/dashboard/catalog/key/extra")).toEqual({ mode: "list" });
  });
});
