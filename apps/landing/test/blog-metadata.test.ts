import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "../../..");

describe("blog metadata and article presentation", () => {
  it("lets landing pages provide canonical and social metadata", () => {
    const layout = readFileSync(
      join(repoRoot, "apps/landing/src/layouts/LandingLayout.astro"),
      "utf8",
    );

    expect(layout).toContain("canonicalUrl");
    expect(layout).toContain('rel="canonical"');
    expect(layout).toContain('property="og:title"');
    expect(layout).toContain('property="og:description"');
    expect(layout).toContain('property="og:url"');
    expect(layout).toContain('property="og:type"');
    expect(layout).toContain("ogImageUrl");
    expect(layout).toContain('name="twitter:card"');
    expect(layout).toContain('name="twitter:image"');
  });

  it("sets canonical metadata on the blog index and post pages", () => {
    const indexRoute = readFileSync(
      join(repoRoot, "apps/landing/src/pages/blog/index.astro"),
      "utf8",
    );
    const postRoute = readFileSync(
      join(repoRoot, "apps/landing/src/pages/blog/[slug].astro"),
      "utf8",
    );

    expect(indexRoute).toContain("canonicalUrl={blogIndexUrl()}");
    expect(postRoute).toContain("canonicalUrl={canonicalUrl}");
    expect(postRoute).toContain("canonicalPath={canonicalPath}");
    expect(postRoute).toContain("absoluteBlogPostUrl(entry.slug)");
  });

  it("uses article and CTA components on blog post pages", () => {
    const postRoute = readFileSync(
      join(repoRoot, "apps/landing/src/pages/blog/[slug].astro"),
      "utf8",
    );
    const article = readFileSync(
      join(repoRoot, "apps/landing/src/components/landing/BlogArticle.astro"),
      "utf8",
    );
    const cta = readFileSync(
      join(repoRoot, "apps/landing/src/components/landing/BlogCta.astro"),
      "utf8",
    );

    expect(postRoute).toContain("BlogArticle");
    expect(postRoute).toContain("BlogCta");
    expect(article).toContain("blog-prose");
    expect(cta).toContain("npm install -g caplets");
    expect(cta).toContain("https://docs.caplets.dev");
    expect(cta).toContain("https://catalog.caplets.dev");
    expect(cta).toContain("https://github.com/spiritledsoftware/caplets");
    expect(cta).toContain("https://www.npmjs.com/package/caplets");
    expect(cta).toContain("docs/benchmarks/coding-agent.md");
  });
});
