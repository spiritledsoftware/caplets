import { createCatalogEntry } from "@caplets/core/catalog";
import { describe, expect, it } from "vitest";
import { catalogSearchRowFromEntry } from "../src/lib/search-row";
import type { CatalogEntryRecord } from "../src/lib/catalog-store";

describe("catalog search rows", () => {
  it("adapts catalog records into compact searchable rows", () => {
    const row = catalogSearchRowFromEntry(
      catalogRecord({
        id: "ast-grep",
        name: "ast-grep",
        description: "Search and rewrite code structurally.",
        tags: ["search", "code"],
        icon: { type: "url", url: "https://example.com/ast-grep.svg" },
        setupRequired: true,
        projectBindingRequired: true,
        localControl: true,
      }),
    );

    expect(row).toMatchObject({
      id: "github:spiritledsoftware:caplets:caplets%2Fast-grep%2Fcaplet.md:ast-grep",
      name: "ast-grep",
      description: "Search and rewrite code structurally.",
      trust: "official",
      setup: "required",
      installCountDisplay: "<10",
      sourceRepository: "spiritledsoftware/caplets",
      workflowLabel: "MCP server",
      detailHref:
        "/caplets/github%3Aspiritledsoftware%3Acaplets%3Acaplets%252Fast-grep%252Fcaplet.md%3Aast-grep/",
      installCommandText: "caplets install spiritledsoftware/caplets ast-grep",
      installCommandPreview: "caplets install spiritledsoftware/caplets ast-grep",
      installCommandCopyable: true,
      icon: { type: "url", url: "https://example.com/ast-grep.svg" },
    });
    expect(row.statuses.map((status) => status.code)).toEqual([
      "local_control",
      "setup_required",
      "project_binding_required",
      "readiness_unknown",
    ]);
    expect(row.searchText).toContain("caplets install spiritledsoftware/caplets ast-grep");
  });

  it("does not invent vault warnings when catalog data has no vault signal", () => {
    const row = catalogSearchRowFromEntry(
      catalogRecord({
        id: "github",
        name: "GitHub",
        description: "Work with GitHub.",
        tags: ["github"],
        authRequired: true,
      }),
    );

    expect(row.statuses.map((status) => status.code)).not.toContain("vault_required");
  });

  it("marks non-copyable install commands without discarding the display text", () => {
    const entry = catalogRecord({
      id: "deploy",
      name: "Deploy",
      description: "Deploy from a community repo.",
      tags: ["deploy"],
      trustLevel: "community",
    });

    const row = catalogSearchRowFromEntry(entry);

    expect(row.installCommandCopyable).toBe(false);
    expect(row.installCommandText).toBe("caplets install community/tools deploy");
  });
});

function catalogRecord(input: {
  id: string;
  name: string;
  description: string;
  tags: string[];
  icon?: CatalogEntryRecord["icon"] | undefined;
  trustLevel?: "official" | "community" | undefined;
  setupRequired?: boolean | undefined;
  authRequired?: boolean | undefined;
  projectBindingRequired?: boolean | undefined;
  localControl?: boolean | undefined;
}): CatalogEntryRecord {
  const trustLevel = input.trustLevel ?? "official";
  const source =
    trustLevel === "official"
      ? {
          provider: "github" as const,
          owner: "spiritledsoftware",
          repo: "caplets",
          repository: "spiritledsoftware/caplets",
          canonicalUrl: "https://github.com/spiritledsoftware/caplets",
        }
      : {
          provider: "github" as const,
          owner: "community",
          repo: "tools",
          repository: "community/tools",
          canonicalUrl: "https://github.com/community/tools",
        };
  return {
    ...createCatalogEntry({
      id: input.id,
      name: input.name,
      description: input.description,
      source,
      sourcePath: `caplets/${input.id}/CAPLET.md`,
      trustLevel,
      icon: input.icon,
      tags: input.tags,
      workflow: { kind: "mcp", label: "MCP server" },
      setupRequired: input.setupRequired,
      authRequired: input.authRequired,
      projectBindingRequired: input.projectBindingRequired,
      localControl: input.localControl,
    }),
    installCount: 0,
    installCountDisplay: "<10",
    rankScore: 0,
  };
}
