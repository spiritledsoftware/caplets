---
title: Landing Blog Path - Plan
type: feat
date: 2026-07-01
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Landing Blog Path - Plan

## Goal Capsule

- **Objective:** Add a canonical `/blog` surface to the Caplets landing site so long-form launch and proof content lives on `caplets.dev` and can be syndicated elsewhere.
- **Product authority:** The blog supports the strategy in `STRATEGY.md`: public proof, reproducible claims, and trust in the Code Mode-first capability model.
- **Execution profile:** Standard software plan; implement in small units across the Astro landing app and shared web-observability package.
- **Stop conditions:** Stop and ask if implementation would require a CMS, user accounts, comments, dynamic server rendering, or raw per-post telemetry.
- **Tail ownership:** The implementation owns the initial static blog surface and first launch essay; ongoing editorial cadence remains marketing work outside this plan.

---

## Product Contract

### Summary

Add a minimal, static, repo-owned blog to `apps/landing` with a `/blog` index and canonical post pages.
The first post should be the benchmark-backed “tool wall” launch essay, with strong metadata and CTAs into install, docs, catalog, GitHub, and the reproducible benchmark.
X Articles and social posts remain distribution channels that link back to the canonical Caplets URL.

### Problem Frame

Caplets’ strongest awareness asset is a technical argument backed by reproducible benchmark evidence.
If the launch essay lives only on X Articles, it will be platform-dependent, harder to cite from PR outreach, weaker for search and AI discovery, and disconnected from install/docs/catalog conversion paths.
The landing app already presents the core proof and activation story, so a small static blog path is the right owned-media home without introducing CMS carrying cost.

### Requirements

**Canonical owned media**

- R1. The landing site exposes `/blog` as the canonical home for Caplets long-form marketing and technical proof posts.
- R2. Individual posts have stable slug URLs under `/blog/<slug>/` and include canonical metadata that points to the owned URL.
- R3. X Articles, social posts, and community submissions are treated as syndication that link back to the canonical blog post.

**Static content and editorial scope**

- R4. Blog posts are repo-owned static Markdown/MDX-style content with typed frontmatter and no CMS dependency.
- R5. The initial content set includes the “Why Giant MCP Tool Walls Don’t Scale” launch essay with benchmark claims, limitations, and reproduction links.
- R6. Future recurring content such as “Caplet of the week” is deferred unless it only requires adding more posts to the same static collection.

**Reader experience and conversion**

- R7. The blog index lists posts with title, description, date, category/tag metadata, and a clear path to the canonical post.
- R8. Post pages preserve the landing site visual language while making long-form reading comfortable on mobile and desktop.
- R9. Post pages include calls to action for install/setup, docs, catalog, GitHub, npm, and benchmark reproduction where relevant.

**Search, sharing, and privacy-safe measurement**

- R10. Blog pages include title, description, canonical URL, Open Graph, and social-card metadata suitable for launch sharing.
- R11. Public-site observability classifies blog traffic and blog CTAs categorically without preserving raw slugs, raw URLs, browser identities, or hidden user identifiers.
- R12. Install-copy attribution from blog CTAs uses the existing landing-surface attribution model unless a future product decision creates a distinct blog marker.

### Scope Boundaries

#### In scope

- Static blog collection for `apps/landing`.
- `/blog` index and `/blog/<slug>/` detail route.
- Initial launch essay content.
- Landing navigation/footer links to the blog.
- Privacy-safe route and CTA categorization for blog traffic.
- Source-level tests plus Astro build/typecheck coverage.

#### Deferred to Follow-Up Work

- RSS feed, sitemap customization, and structured Article JSON-LD.
- Dedicated generated Open Graph images per post.
- “Caplet of the week” editorial system or recurring templates beyond adding ordinary posts.
- Search, tags archive, pagination, author pages, comments, newsletter capture, or CMS integration.

#### Outside this product's identity

- Treating X Articles as the canonical source of truth.
- Turning the catalog site into a blog or mixing editorial content into catalog discovery.
- Collecting raw article URLs, raw referrers, or user-identifying marketing telemetry.

### Acceptance Examples

- AE1. Given a visitor opens `/blog`, when the page renders, then they see the launch essay card with title, description, date, and a link to the canonical post.
- AE2. Given a visitor opens `/blog/why-giant-mcp-tool-walls-dont-scale/`, when the page renders, then the article has readable long-form layout, benchmark caveats, reproduction links, and install/docs/catalog CTAs.
- AE3. Given a social crawler previews the launch post URL, when it reads metadata, then it receives the post-specific title, description, canonical URL, and share image fallback.
- AE4. Given PostHog is configured, when a visitor opens or clicks through blog pages, then events use categorical `blog` route/page data and never include the raw slug.
- AE5. Given a post is missing required frontmatter, when the landing app typecheck/build runs, then the content validation fails before deployment.

---

## Planning Contract

### Key Technical Decisions

- KTD1. Use Astro content collections for blog posts. Astro’s current content collection pattern supports typed static Markdown content, `getCollection('blog')`, and static paths without adding a CMS or runtime server.
- KTD2. Keep blog rendering inside `apps/landing`. The blog is owned marketing/proof content and should inherit landing styling, CTAs, and observability rather than living in Starlight docs or the catalog app.
- KTD3. Extend `LandingLayout` for page-specific SEO and social metadata. A shared layout prop surface prevents index and post pages from hand-rolling inconsistent head tags.
- KTD4. Add a categorical `blog` route/page family to `@caplets/web-observability`. Classifying `/blog` as `other` would weaken the public-site intent loop; capturing raw slugs would violate the existing privacy model.
- KTD5. Ship one polished launch post before broader content infrastructure. The first post proves the publishing path and supports the awareness campaign; larger editorial features are deferred until content volume justifies them.

### High-Level Technical Design

```mermaid
flowchart TB
  Content[apps/landing/src/content/blog/*.md] --> Config[apps/landing/src/content.config.ts]
  Config --> Index[apps/landing/src/pages/blog/index.astro]
  Config --> Post[apps/landing/src/pages/blog/[slug].astro]
  Layout[apps/landing/src/layouts/LandingLayout.astro] --> Index
  Layout --> Post
  Nav[Header and Footer links] --> Index
  Obs[packages/web-observability blog categories] --> LandingObs[apps/landing/src/scripts/observability.ts]
  LandingObs --> Index
  LandingObs --> Post
```

The static content collection feeds both the index and post routes.
The shared layout supplies canonical and social metadata, while the observability package constrains blog measurements to categorical values.

### Assumptions

- The canonical domain for generated links is `https://caplets.dev` unless the existing deployment configuration exposes a more specific public origin during implementation.
- The initial share image can reuse an existing landing icon or generic social fallback; bespoke per-post OG images are deferred.
- The launch essay can be written directly in repo content during implementation from the approved marketing plan and benchmark docs.
- Blog install-copy attribution should stay under the existing `landing_install` category for now.

### Sources and Research

- `STRATEGY.md` frames public proof, docs, and reproducible benchmark confidence as an active strategic track.
- `apps/landing/src/pages/index.astro`, `apps/landing/src/layouts/LandingLayout.astro`, and `apps/landing/src/components/landing/*` show the current one-page landing composition and visual conventions.
- `apps/docs/src/content.config.ts` shows this repo already uses Astro content configuration in the docs app.
- `packages/web-observability/src/events.ts` and `packages/web-observability/src/privacy.ts` define the current categorical telemetry contract.
- Astro documentation research confirmed the current static blog pattern: collection content, `getCollection('blog')`, `getStaticPaths()`, and dynamic post routes.
- `docs/plans/2026-07-01-002-marketing-developer-awareness-plan.md` supplies the campaign direction and first-post topic.

---

## Implementation Units

### U1. Define blog content collection and launch post

- **Goal:** Create the repo-owned static content source for landing blog posts and add the initial launch essay content.
- **Requirements:** R1, R2, R4, R5, R10, AE1, AE2, AE5
- **Dependencies:** None
- **Files:**
  - `apps/landing/src/content.config.ts`
  - `apps/landing/src/content/blog/why-giant-mcp-tool-walls-dont-scale.md`
  - `apps/landing/test/blog-content.test.ts`
- **Approach:** Define a `blog` content collection with required frontmatter for title, description, date, draft/publication state if needed, tags/category, canonical slug, and optional share metadata. Write the first post from the developer-awareness plan and benchmark docs, including benchmark limitations and reproduction links rather than only headline claims.
- **Patterns to follow:** Mirror the repo's existing Astro content configuration shape in `apps/docs/src/content.config.ts`; keep marketing claims aligned with `docs/benchmarks/coding-agent.md` and `STRATEGY.md`.
- **Test scenarios:**
  - Covers AE5. A post without required title, description, date, or slug metadata fails content validation during typecheck/build.
  - The launch post source includes the deterministic benchmark numbers, caveat language that the benchmark is deterministic, and a reproduction reference to `pnpm benchmark` or the benchmark document.
  - The launch post frontmatter slug matches the intended canonical URL segment.
- **Verification:** The content collection is typed, the launch essay is present as the first non-draft post, and malformed required metadata cannot pass the landing app checks.

### U2. Add blog index and post routes

- **Goal:** Render `/blog` and `/blog/<slug>/` from the static blog collection.
- **Requirements:** R1, R2, R7, R8, AE1, AE2
- **Dependencies:** U1
- **Files:**
  - `apps/landing/src/pages/blog/index.astro`
  - `apps/landing/src/pages/blog/[slug].astro`
  - `apps/landing/src/lib/blog.ts`
  - `apps/landing/test/blog-routes.test.ts`
- **Approach:** Add a small blog helper for sorting public posts newest-first and resolving post URLs. The index should render public posts as cards with date, title, description, tags/category, and link. The dynamic route should use static path generation from collection entries and render article content through Astro’s content rendering API.
- **Patterns to follow:** Follow the landing page's `w-[min(1180px,calc(100vw_-_32px))]` container rhythm and existing card/button components where useful.
- **Test scenarios:**
  - Covers AE1. The blog index source or rendered build includes the launch post title, description, date, and `/blog/why-giant-mcp-tool-walls-dont-scale/` link.
  - Covers AE2. The post route is generated by the static build and renders the launch essay body rather than only metadata.
  - Draft or future-hidden posts are excluded from the index and static paths if the schema includes such a state.
  - Unknown slugs rely on Astro’s static routing behavior and do not create a catch-all route.
- **Verification:** Static build output contains `/blog/index.html` and the launch post route, with no runtime server dependency.

### U3. Extend layout metadata and article presentation

- **Goal:** Give blog index and post pages first-class SEO/share metadata and readable long-form presentation.
- **Requirements:** R8, R9, R10, AE2, AE3
- **Dependencies:** U1, U2
- **Files:**
  - `apps/landing/src/layouts/LandingLayout.astro`
  - `apps/landing/src/components/landing/BlogArticle.astro`
  - `apps/landing/src/components/landing/BlogCta.astro`
  - `apps/landing/src/styles/global.css`
  - `apps/landing/test/blog-metadata.test.ts`
- **Approach:** Extend `LandingLayout` with optional canonical URL, Open Graph title/description/type/image, and article date props. Add a blog article component or section classes that make Markdown content readable without diluting the landing aesthetic. Include a reusable CTA block for install/setup, docs, catalog, GitHub, npm, and benchmark reproduction.
- **Patterns to follow:** Reuse `Button`, `Card`, and current muted/foreground/accent token patterns; preserve `skip-link`, header/footer slots, and mobile responsiveness.
- **Test scenarios:**
  - Covers AE3. The launch post output includes post-specific `<title>`, meta description, canonical link, `og:title`, `og:description`, `og:url`, and `og:type` values.
  - Covers AE2. Article layout keeps one primary `<h1>`, visible publication date, and content width suitable for long-form reading.
  - CTA links point to install/docs/catalog/GitHub/npm/benchmark targets without broken relative URLs.
  - Default layout metadata remains valid for the home page when blog-specific props are absent.
- **Verification:** Home page metadata remains unchanged except for intentional layout enhancements, and blog pages produce shareable metadata from post frontmatter.

### U4. Add blog navigation and conversion paths

- **Goal:** Make the blog discoverable from the landing site without disrupting the current single-page conversion flow.
- **Requirements:** R1, R3, R7, R9, AE1, AE2
- **Dependencies:** U2, U3
- **Files:**
  - `apps/landing/src/components/landing/Header.astro`
  - `apps/landing/src/components/landing/Footer.astro`
  - `apps/landing/src/components/landing/Hero.astro`
  - `apps/landing/test/blog-navigation.test.ts`
- **Approach:** Add a `/blog` link to desktop and mobile navigation plus footer. Consider one lightweight home-page link from the benchmark/proof area or hero secondary action only if it does not crowd the existing install/docs/catalog actions.
- **Patterns to follow:** Match existing header link classes, mobile sheet behavior, footer link style, and external-link icon conventions only for off-site links.
- **Test scenarios:**
  - The desktop header, mobile sheet, and footer contain a first-party `/blog` link.
  - `/blog` links do not use `target="_blank"` or external-link icons.
  - Existing catalog, docs, GitHub, npm, and hash-section links remain present.
  - If a home-page proof link is added, it points to the launch post or blog index and does not replace benchmark reproduction links.
- **Verification:** Visitors can navigate from home to blog and back, while existing landing section navigation still works.

### U5. Preserve privacy-safe observability for blog traffic

- **Goal:** Classify blog pageviews and blog CTAs categorically without raw post slugs or URLs.
- **Requirements:** R11, R12, AE4
- **Dependencies:** U2, U4
- **Files:**
  - `packages/web-observability/src/events.ts`
  - `packages/web-observability/src/privacy.ts`
  - `packages/web-observability/test/web-observability.test.ts`
  - `apps/landing/src/scripts/observability.ts`
  - `apps/landing/test/observability.test.ts`
- **Approach:** Add `blog` as an allowed route/page family and navigation/CTA category where needed. Classify `/blog` and `/blog/<slug>` as `blog`, but never pass the actual slug into event properties. Keep install copy attribution under the existing landing surface unless a later product decision adds a separate blog marker.
- **Patterns to follow:** Follow the categorical allowlist design in `packages/web-observability/src/privacy.ts` and existing route tests in `packages/web-observability/test/web-observability.test.ts`.
- **Test scenarios:**
  - Covers AE4. `classifyRouteFamily('/blog')` and `classifyRouteFamily('/blog/why-giant-mcp-tool-walls-dont-scale')` return `blog` without preserving slug values.
  - Blog links in landing observability produce categorical blog navigation/CTA values.
  - Unsafe raw URLs and unknown telemetry properties remain rejected after adding blog categories.
  - Blog install-copy CTAs still emit `landing_install` attribution and do not introduce a raw article identifier.
- **Verification:** Blog observability enriches public-site intent with categorical data while preserving the Anonymous Telemetry and Anonymous Install Attribution constraints in `CONCEPTS.md`.

---

## Verification Contract

| Gate                                                 | Scope                                        | Done signal                                                                   |
| ---------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------- |
| `pnpm --filter @caplets/landing test`                | U1-U4 and landing observability pieces of U5 | New and existing landing tests pass.                                          |
| `pnpm --filter @caplets/landing typecheck`           | U1-U4                                        | Astro content collection, routes, and layout props typecheck.                 |
| `pnpm --filter @caplets/landing build`               | U1-U4                                        | Static `/blog` and launch-post pages build successfully.                      |
| `pnpm --filter @caplets/web-observability test`      | U5                                           | Shared route/privacy contract accepts `blog` and still rejects unsafe values. |
| `pnpm --filter @caplets/web-observability typecheck` | U5                                           | Shared observability type changes compile.                                    |
| `pnpm format:check`                                  | All units                                    | New Markdown, Astro, CSS, and TypeScript files match repo formatting.         |
| `pnpm lint`                                          | All units                                    | No lint regressions from route, component, or telemetry changes.              |

---

## Definition of Done

- `/blog` and `/blog/why-giant-mcp-tool-walls-dont-scale/` are generated by the landing build.
- The launch post is the canonical source for the tool-wall essay and includes benchmark evidence, limitations, reproduction path, and conversion CTAs.
- Home, header, mobile menu, and footer navigation still work and expose the blog intentionally.
- Blog metadata is post-specific and suitable for social sharing.
- Observability classifies blog traffic categorically and does not preserve raw slugs, URLs, identities, or hidden identifiers.
- All Verification Contract gates pass.
- Any abandoned prototype/CMS/RSS/OG-image experimentation is removed from the final diff.
