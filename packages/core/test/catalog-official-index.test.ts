import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { generateOfficialCatalogEntries } from "../../../scripts/generate-catalog-index";

const repoRoot = resolve(import.meta.dirname, "../../..");

describe("official catalog index generation", () => {
  it("derives official entries from checked-in Caplet files without catalog metadata", async () => {
    const entries = await generateOfficialCatalogEntries(repoRoot);
    const github = entries.find((entry) => entry.id === "github");

    expect(entries.length).toBeGreaterThan(10);
    expect(github).toMatchObject({
      id: "github",
      name: "GitHub",
      sourcePath: "github/CAPLET.md",
      trustLevel: "official",
      source: {
        provider: "github",
        repository: "spiritledsoftware/caplets",
      },
      installCommand: {
        text: "caplets install spiritledsoftware/caplets github",
        copyable: true,
      },
      authReadiness: "required",
    });
    expect(github?.contentMarkdown).toContain("# GitHub");
    expect(JSON.stringify(entries)).not.toContain('"shadowing"');
    expect(JSON.stringify(entries)).not.toContain(repoRoot);
  });

  it("matches the checked-in deterministic seed file", async () => {
    const outputPath = join(repoRoot, "apps/catalog/src/data/official-catalog.json");

    expect(existsSync(outputPath)).toBe(true);
    expect(readFileSync(outputPath, "utf8")).toBe(
      `${JSON.stringify(await generateOfficialCatalogEntries(repoRoot), null, 2)}\n`,
    );
  });
});
