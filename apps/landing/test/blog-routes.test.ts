import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { blogPostUrl, sortBlogPostsNewestFirst } from "../src/lib/blog";

const repoRoot = join(import.meta.dirname, "../../..");

describe("landing blog routes", () => {
  it("builds canonical post URLs with trailing slashes", () => {
    expect(blogPostUrl("why-giant-mcp-tool-walls-dont-scale")).toBe(
      "/blog/why-giant-mcp-tool-walls-dont-scale/",
    );
  });

  it("sorts public posts newest first", () => {
    const posts = sortBlogPostsNewestFirst([
      { slug: "older", data: { date: new Date("2026-01-01"), draft: false } },
      { slug: "draft", data: { date: new Date("2026-12-01"), draft: true } },
      { slug: "newer", data: { date: new Date("2026-07-01"), draft: false } },
    ]);

    expect(posts.map((post) => post.slug)).toEqual(["newer", "older"]);
  });

  it("defines a blog index and static post route from the blog collection", () => {
    const indexSource = readFileSync(
      join(repoRoot, "apps/landing/src/pages/blog/index.astro"),
      "utf8",
    );
    const postSource = readFileSync(
      join(repoRoot, "apps/landing/src/pages/blog/[slug].astro"),
      "utf8",
    );

    expect(indexSource).toContain('getCollection("blog")');
    expect(indexSource).toContain("Why Giant MCP Tool Walls Don’t Scale");
    expect(postSource).toContain("getStaticPaths");
    expect(postSource).toContain('getCollection("blog")');
    expect(postSource).toContain("render(entry)");
  });
});
