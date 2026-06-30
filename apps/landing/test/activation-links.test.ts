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
});
