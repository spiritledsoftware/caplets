import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "../../..");

describe("activation links", () => {
  it("sends the browse-more Caplets action to the public catalog", () => {
    const source = readFileSync(
      join(repoRoot, "apps/landing/src/components/landing/Activation.astro"),
      "utf8",
    );

    expect(source).toContain('href="https://catalog.caplets.dev"');
    expect(source).not.toContain(
      'href="https://github.com/spiritledsoftware/caplets/tree/main/caplets"',
    );
  });

  it("offers manual and agent setup modes without rendering the full agent prompt", () => {
    const componentSource = readFileSync(
      join(repoRoot, "apps/landing/src/components/landing/Activation.astro"),
      "utf8",
    );
    const dataSource = readFileSync(join(repoRoot, "apps/landing/src/data/landing.ts"), "utf8");

    expect(componentSource).toContain('TabsTrigger value="manual"');
    expect(componentSource).toContain('TabsTrigger value="agent"');
    expect(componentSource).toContain("Copy setup prompt");
    expect(dataSource).toContain("agentSetupPrompt");
    expect(dataSource).toContain(
      "https://raw.githubusercontent.com/spiritledsoftware/caplets/main/skills/installing-caplets/SKILL.md",
    );
    expect(componentSource).not.toContain("Read and follow this Caplets bootstrap skill");
  });
});
