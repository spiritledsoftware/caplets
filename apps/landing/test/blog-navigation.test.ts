import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "../../..");

describe("blog navigation", () => {
  it("links to the first-party blog from the footer without external-link treatment", () => {
    const footer = readFileSync(
      join(repoRoot, "apps/landing/src/components/landing/Footer.astro"),
      "utf8",
    );

    expect(footer).toContain('href="/blog/"');
    expect(footer).toContain("Blog");
    expect(footer).not.toContain('href="/blog/" target="_blank"');
  });
});
