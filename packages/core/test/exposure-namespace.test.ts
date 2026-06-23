import { describe, expect, it } from "vitest";
import { resolveNamespaceExposure, type NamespaceSourceEntry } from "../src/exposure/namespace";

type Route = { source: string };

function entry(
  baseId: string,
  sourceKind: "local" | "upstream",
  source: string,
  shadowing: NamespaceSourceEntry<Route>["shadowing"] = "namespace",
  options: Partial<NamespaceSourceEntry<Route>> = {},
): NamespaceSourceEntry<Route> {
  return {
    baseId,
    sourceKind,
    sourceLabel: sourceKind === "local" ? "local" : "remote",
    durableSourceIdentity: source,
    shadowing,
    route: { source },
    ...options,
  };
}

describe("namespace exposure resolver", () => {
  it("qualifies local and upstream namespace collisions and suppresses the bare ID", () => {
    const result = resolveNamespaceExposure([
      entry("github", "upstream", "https://remote.example.com"),
      entry("github", "local", "/Users/me/.caplets"),
    ]);

    expect(result.visibleRecords.map((record) => record.id)).toEqual([
      "remote-d4b6__github",
      "local-3cbc__github",
    ]);
    expect(result.routes.get("remote-d4b6__github")).toEqual({
      source: "https://remote.example.com",
    });
    expect(result.routes.get("local-3cbc__github")).toEqual({ source: "/Users/me/.caplets" });
    expect(result.routes.has("github")).toBe(false);
    expect(result.suppressedBareIds.get("github")).toMatchObject({
      requestedId: "github",
      reason: "namespace_collision",
      alternatives: ["remote-d4b6__github", "local-3cbc__github"],
    });
  });

  it("keeps non-colliding Caplet IDs bare", () => {
    const result = resolveNamespaceExposure([
      entry("linear", "upstream", "https://remote.example.com"),
    ]);

    expect(result.visibleRecords).toEqual([
      expect.objectContaining({ id: "linear", baseId: "linear", namespaced: false }),
    ]);
    expect(result.routes.get("linear")).toEqual({ source: "https://remote.example.com" });
    expect(result.suppressedBareIds.size).toBe(0);
  });

  it("uses aliases as replacement labels for local and upstream sources", () => {
    const result = resolveNamespaceExposure([
      entry("github", "upstream", "https://remote.example.com", "namespace", {
        namespaceAlias: "vps",
      }),
      entry("github", "local", "/Users/me/.caplets", "namespace", {
        namespaceAlias: "mac",
      }),
    ]);

    expect(result.visibleRecords.map((record) => record.id)).toEqual([
      "vps-d4b6__github",
      "mac-3cbc__github",
    ]);
    expect(result.visibleRecords.map((record) => record.label)).toEqual(["vps", "mac"]);
  });

  it("qualifies multiple upstream namespace sources", () => {
    const result = resolveNamespaceExposure([
      entry("github", "upstream", "https://one.example.com"),
      entry("github", "upstream", "https://two.example.com"),
    ]);

    expect(result.visibleRecords.map((record) => record.id)).toEqual([
      "remote-933c__github",
      "remote-5d6c__github",
    ]);
    expect(result.suppressedBareIds.get("github")?.alternatives).toEqual([
      "remote-933c__github",
      "remote-5d6c__github",
    ]);
  });

  it("fails closed when a namespace collision source lacks durable identity", () => {
    const result = resolveNamespaceExposure([
      entry("github", "upstream", "https://remote.example.com"),
      entry("github", "local", "", "namespace", { durableSourceIdentity: undefined }),
    ]);

    expect(result.visibleRecords).toEqual([]);
    expect(result.routes.size).toBe(0);
    expect(result.unavailableDiagnostics).toEqual([
      expect.objectContaining({
        requestedId: "github",
        reason: "missing_durable_source_identity",
      }),
    ]);
  });

  it("preserves existing forbid and allow semantics without namespace alternatives", () => {
    const forbid = resolveNamespaceExposure([
      entry("github", "upstream", "https://remote.example.com", "forbid"),
      entry("github", "local", "/Users/me/.caplets", "namespace"),
    ]);
    const allow = resolveNamespaceExposure([
      entry("github", "upstream", "https://remote.example.com", "allow"),
      entry("github", "local", "/Users/me/.caplets", "namespace"),
    ]);

    expect(forbid.visibleRecords).toEqual([
      expect.objectContaining({ id: "github", sourceKind: "upstream", namespaced: false }),
    ]);
    expect(forbid.suppressedBareIds.size).toBe(0);
    expect(allow.visibleRecords).toEqual([
      expect.objectContaining({ id: "github", sourceKind: "local", namespaced: false }),
    ]);
    expect(allow.suppressedBareIds.size).toBe(0);
  });

  it("fails closed when a generated qualified ID collides with an existing bare ID", () => {
    const result = resolveNamespaceExposure(
      [
        entry("github", "upstream", "https://remote.example.com", "namespace", {
          namespaceAlias: "remote-d4b6-github",
        }),
        entry("github", "local", "/Users/me/.caplets"),
        entry("remote-d4b6-github-d4b6__github", "upstream", "https://other.example.com"),
      ],
      { maxHashLength: 4 },
    );

    expect(result.visibleRecords).toEqual([
      expect.objectContaining({ id: "remote-d4b6-github-d4b6__github" }),
    ]);
    expect(result.unavailableDiagnostics).toEqual([
      expect.objectContaining({
        requestedId: "github",
        reason: "generated_id_collision",
      }),
    ]);
  });

  it("reports invalid alias labels as resolver diagnostics", () => {
    const result = resolveNamespaceExposure([
      entry("github", "upstream", "https://remote.example.com", "namespace", {
        namespaceAlias: "bad.alias",
      }),
      entry("github", "local", "/Users/me/.caplets"),
    ]);

    expect(result.visibleRecords).toEqual([]);
    expect(result.unavailableDiagnostics).toEqual([
      expect.objectContaining({
        requestedId: "github",
        reason: "namespace_alias_invalid",
      }),
    ]);
  });
});
