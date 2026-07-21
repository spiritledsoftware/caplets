import { describe, expect, it } from "vitest";
import { catalogDetailHref, catalogListHref, catalogLocationFromPath } from "./catalog-route";

describe("catalog route helpers", () => {
  it("round-trips a safe encoded entry key only under the fixed dashboard path", () => {
    const entryKey = "github:spiritledsoftware:caplets:sample%2FCAPLET.md";

    const href = catalogDetailHref(entryKey);

    expect(href).toBe(`/dashboard/catalog/${encodeURIComponent(entryKey)}`);
    expect(catalogLocationFromPath(href)).toEqual({ mode: "detail", entryKey });
    expect(catalogListHref()).toBe("/dashboard/catalog");
  });

  it("rejects malformed, empty, nested, dot, and slash-decoding path identities", () => {
    expect(catalogLocationFromPath("/dashboard/catalog")).toEqual({ mode: "list" });
    expect(catalogLocationFromPath("/dashboard/catalog/%")).toEqual({ mode: "list" });
    expect(catalogLocationFromPath("/dashboard/catalog/%2e")).toEqual({ mode: "list" });
    expect(catalogLocationFromPath("/dashboard/catalog/%2e%2e")).toEqual({ mode: "list" });
    expect(catalogLocationFromPath("/dashboard/catalog/owner%2Frepo")).toEqual({ mode: "list" });
    expect(catalogLocationFromPath("/dashboard/catalog/key%00value")).toEqual({ mode: "list" });
    expect(catalogLocationFromPath("/dashboard/catalog/key/extra")).toEqual({ mode: "list" });
    expect(catalogLocationFromPath("/removed/dashboard/catalog/safe")).toEqual({ mode: "list" });
    expect(() => catalogDetailHref("owner/repo")).toThrow("safe encoded path segment");
  });
});
