import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "../../..");

describe("blog navigation", () => {
  it("links to the first-party blog from desktop and mobile header navigation", () => {
    const header = readFileSync(
      join(repoRoot, "apps/landing/src/components/landing/Header.astro"),
      "utf8",
    );

    expect(header.match(/href="\/blog\/"/gu)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(header).toContain(">Blog<");
    expect(header).not.toContain('href="/blog/" target="_blank"');

    const desktopBlogLink = header.match(/<a class="[^"]*" href="\/blog\/">Blog<\/a>/u)?.[0] ?? "";
    const desktopRemoteLink =
      header.match(/<a class="[^"]*" href="#remote">Remote<\/a>/u)?.[0] ?? "";
    expect(desktopBlogLink).toContain("focus-visible:ring-outline/50");
    expect(desktopRemoteLink).toContain("focus-visible:ring-outline/50");
  });

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
