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
      join(repoRoot, "apps/landing/src/components/landing/Hero.astro"),
      "utf8",
    );
    const dataSource = readFileSync(join(repoRoot, "apps/landing/src/data/landing.ts"), "utf8");

    expect(componentSource).toContain('id="setup"');
    expect(componentSource).toContain("<TabsList");
    expect(componentSource).toContain("<TabsTrigger");
    expect(componentSource).toContain('label: "Manual"');
    expect(componentSource).toContain('label: "Agent"');
    expect(componentSource).toContain('copyLabel: "agent setup prompt"');
    expect(componentSource).toContain("data-copy-attribution={String(option.copyAttribution)}");
    expect(dataSource).toContain("agentSetupPrompt");
    expect(dataSource).toContain(
      "https://raw.githubusercontent.com/spiritledsoftware/caplets/main/skills/installing-caplets/SKILL.md",
    );
    expect(componentSource).not.toContain("Read and follow this Caplets bootstrap skill");
    expect(componentSource).not.toContain("First route the agent sees");
  });
});
