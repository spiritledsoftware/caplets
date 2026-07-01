import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "../../..");
const contentConfigPath = join(repoRoot, "apps/landing/src/content.config.ts");
const launchPostPath = join(
  repoRoot,
  "apps/landing/src/content/blog/why-giant-mcp-tool-walls-dont-scale.md",
);

describe("landing blog content", () => {
  it("defines a typed blog content collection with required launch metadata", () => {
    const source = readFileSync(contentConfigPath, "utf8");

    expect(source).toContain("blog: defineCollection");
    expect(source).toContain("title:");
    expect(source).toContain("description:");
    expect(source).toContain("date:");
    expect(source).not.toContain("canonicalPath:");
    expect(source).toContain("tags:");
  });

  it("ships the tool-wall launch essay as the first canonical blog post", () => {
    const post = readFileSync(launchPostPath, "utf8");

    expect(post).toContain("title: Why Giant MCP Tool Walls Don’t Scale");
    expect(post).not.toContain("canonicalPath:");
    expect(post).toContain("96.7% fewer initially visible tools");
    expect(post).toContain("79.9% lower initial serialized tool payload");
    expect(post).toContain("deterministic benchmark");
    expect(post).toContain("pnpm benchmark");
  });
});
