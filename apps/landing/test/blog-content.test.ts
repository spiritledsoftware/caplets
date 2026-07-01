import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "../../..");
const contentConfigPath = join(repoRoot, "apps/landing/src/content.config.ts");
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
});
