---
date: 2026-06-26
topic: caplets-catalog-search-site
---

# Caplets Catalog Search Site Requirements

## Summary

`catalog.caplets.dev` should be a separate search-first catalog site for finding installable Caplets, with inspection-first detail pages and copyable install commands as the conversion action. It should index official Caplets from this repo and community Caplets discovered through public external installs.

---

## Problem Frame

The repo now has a growing Prebuilt Caplets Catalog and lockfile-backed installs, but discovery still depends on knowing a repo and Caplet ID ahead of time. That works for a curated seed set, but it does not help users find useful Caplets across the wider ecosystem.

Skills.sh provides the relevant pattern: installation becomes the discovery signal, search and ranking make useful entries findable, and the page exposes enough source content for users to decide whether to install. Caplets needs the same discovery loop, adapted to Caplets' higher-risk capability surface and existing privacy promises.

---

## Key Decisions

- **Search is the v1 product.** The site should optimize for finding, inspecting, and installing Caplets rather than becoming a full marketplace or security trust hub.
- **Install is the submission mechanism.** Installing a Caplet from a public external source should make that Caplet eligible for indexing without a separate publisher submission flow, subject to public-source fetch boundaries and removal or suppression rules.
- **Community Caplets are unverified by default.** V1 should warn users to inspect community Caplets before install rather than imply that automatic indexing means endorsement.
- **Security scanning is deferred.** V1 should keep only basic ingestion hygiene and avoid claiming semantic, dependency, or supply-chain scanning.
- **Official Caplets get distinct labeling.** Repo-owned catalog entries should be visually and semantically distinct from community entries.
- **Install counts are popularity signals only.** Ranking can use install counts, but copy and UI must not imply that install count proves safety, quality, or endorsement.
- **Public indexing is separate from anonymous telemetry.** The catalog indexing signal publishes source identity and Caplet identity, so it must be modeled and documented separately from ordinary anonymous telemetry.
- **Vault setup belongs in install-time CLI onboarding.** When an installed Caplet requests Vault-backed config, the CLI should help the user grant or set the needed secret for the target runtime without sending secrets to the public catalog or adding a separate site-side consent step.
- **Frontend design must use Impeccable.** The catalog site should be shaped as a precise product-register developer tool through `$impeccable`, using the existing Caplets design system and avoiding generic marketplace UI.

---

## Actors

- A1. **Agent power-user.** Searches the catalog to find a Caplet that solves a concrete integration or agent-workflow need.
- A2. **Installing user.** Installs a Caplet from a public external repository and thereby contributes a public indexing signal.
- A3. **Community Caplet author.** Publishes Caplets in a public repository and gains discovery through installs rather than a manual submission form.
- A4. **Official catalog maintainer.** Maintains repo-owned Caplets under `caplets/` and expects them to be labeled as official.
- A5. **Catalog site visitor.** Reads `CAPLET.md`, source metadata, warnings, and install counts before deciding whether to trust an entry.
- A6. **Catalog indexer.** Receives public-source install signals, fetches public Caplet content, and updates search data and aggregate counts.
- A7. **Implementation agent.** Builds and polishes the catalog frontend using the Caplets design system and `$impeccable`.
- A8. **Vault-using Caplet.** References Caplets Vault values in runtime-resolved config and needs the installing user to set or grant those values before it can execute.

---

## Requirements

**Catalog Site**

- R1. The catalog must live as a separate public site from the landing page and docs site, with `catalog.caplets.dev` as the production domain.
- R2. The catalog must be deployed through the same Cloudflare-backed deployment family as the existing public sites.
- R3. The catalog home surface must make search the primary interaction and make install-copy a conversion action only after the user can inspect the Caplet content and warnings.
- R4. Search results must expose the Caplet name, description, tags, source, official or community status, install count, primary Code Mode workflow, intended agent task, setup or auth readiness, and normalized install command preview.
- R5. A Caplet detail view must expose the indexed `CAPLET.md` content or a readable equivalent before showing the copyable install command as the next action.
- R6. The site must support ranking by aggregate installs while preserving clear official and unverified-community labels.
- R7. Install counts must be presented as popularity and ranking signals only, not as trust, quality, safety, or endorsement signals.
- R8. The site must support v1 filters and sort controls for official/community scope, tags, source owner or repository, setup/auth readiness, relevance, aggregate installs, and reset-to-default.
- R9. The v1 information architecture must include search/results, Caplet detail, official/community scoped views, documentation links, privacy/indexing links, and safety copy near install actions.
- R10. The catalog must keep Caplets framed as a Code Mode-first capability layer for coding agents, not as a generic plugin marketplace.

**Indexing Sources**

- R11. The index must seed official entries from the repo-owned catalog under `caplets/`.
- R12. The index must add community entries discovered through successful installs from public external sources.
- R13. Public external indexing must publish only the Caplet content, normalized install command, source identity needed to reproduce install, aggregate install count, verification status, and safe catalog metadata.
- R14. Public external indexing must not transmit, persist, log, or publish installer identity, local paths, private config, credentials, raw agent prompts, tool arguments, tool outputs, hostnames, or non-public source URLs.
- R15. The indexer must only fetch community content from normalized supported public providers, and must reject local files, private or auth-only hosts, private IP ranges, and redirects to non-public destinations.
- R16. The indexer must skip indexing when the source is not public, the install command cannot be normalized, or the selected Caplet file cannot be fetched from the public source.
- R17. The indexer must count installs in aggregate form that supports ranking without exposing individual install events, with deduplication, rate limiting, and low-count bucketing or suppression where needed.
- R18. Repeated installs of the same public source and Caplet should update ranking signals without creating duplicate catalog entries for the same source identity.
- R19. V1 must include a lightweight source-owner or operator suppression path for stale sources, abuse, takedown requests, or cases where automatic indexing creates unacceptable risk.

**Trust, Warnings, And Safety**

- R20. Community entries must be labeled as unverified by default.
- R21. Official entries must be labeled distinctly from community entries without implying that all official Caplets are risk-free.
- R22. The site must display a prominent warning that Caplets can grant agents access to APIs, local tools, files, browsers, desktop control, or project state.
- R23. The site must tell users to read the Caplet before installing and to install only from sources they trust.
- R24. V1 must not claim semantic scanning, vulnerability scanning, dependency scanning, secret scanning, moderation review, or safety certification for community entries.
- R25. Basic ingestion hygiene must reject invalid Caplet files, unparseable `CAPLET.md` content, non-normalizable install commands, and non-public sources.
- R26. Indexed Caplet content must render through a sanitized, non-executable Markdown path that strips or escapes unsafe HTML and scripts.
- R27. Install commands shown by the site must be generated from normalized source metadata, not copied out of community-authored Markdown.
- R28. Safety warnings must be visible near install actions, not buried only on secondary pages.
- R29. V1 must have an explicit stop rule: community indexing or affected entries can be suppressed when abuse, private-source leakage, or high-risk behavior appears before scanning or moderation exists.

**Frontend Design**

- R30. The catalog frontend must use `$impeccable` during implementation for product-register shaping, critique, and polish.
- R31. The catalog UI must follow the existing Caplets design system: precise, calm, capability-focused, and state-rich without generic marketplace decoration.
- R32. Search, filters, result cards, detail views, copy actions, empty states, and warnings must be keyboard-accessible, responsive, and readable at mobile and desktop widths.
- R33. Official, community, unverified, warning, loading, empty, and error states must be conveyed with text or icons in addition to color.
- R34. The frontend must define outcomes for loading, empty, no-results, error, unavailable-content, copy-success, copy-failure, filter-reset, and recovery states.
- R35. The frontend must include visible focus states, accessible names for controls, screen-reader announcements for result counts/loading/errors/copy actions, sufficient contrast, reduced-motion handling, and mobile touch targets.
- R36. The frontend must avoid generic SaaS cream, neon developer-tool dark mode, identical decorative card grids, hero metrics, gradient text, and vague AI productivity copy.

**Documentation And CLI Relationship**

- R37. Public docs must explain that catalog indexing is a public-source discovery signal, not ordinary anonymous telemetry.
- R38. Public docs must explain which install metadata can become public when installing from public external sources.
- R39. CLI-facing notices must make public external indexing understandable without adding an interactive confirmation step.
- R40. CLI-facing warnings or notices must not block successful install just because the catalog site or indexer is unavailable.
- R41. Install commands shown by the site must match the supported `caplets install` shape for official and community entries.
- R42. The catalog must not require a hosted Caplets account for search, detail inspection, or copying install commands.
- R43. Public docs and UI copy must state that install counts are ranking signals, not safety signals.
- R44. After install, restore, or update materializes Caplets that reference Caplets Vault values in runtime-resolved config fields, the CLI must surface the missing Vault setup before the user discovers the Caplet is quarantined at runtime.
- R45. If the target Vault already contains a referenced key but the installed Caplet lacks a matching access grant, the CLI must prompt the user to grant that key to the Caplet.
- R46. If the target Vault does not contain a referenced key, the CLI must prompt the user to set the key and grant it to the Caplet in the same target runtime.
- R47. Vault setup prompts must target the runtime that owns the install scope, including local project, local global, and remote global installs, without copying secrets between runtime Vault stores.
- R48. Vault setup must never write raw secret values to lockfiles, public catalog indexing signals, install-count events, logs, JSON install output, or the catalog site.
- R49. Noninteractive, JSON, or otherwise unpromptable installs must not hang or fail solely because Vault setup is unresolved; they must return actionable `caplets vault set` and `caplets vault access grant` recovery guidance while existing Vault quarantine behavior protects runtime execution.

---

## Key Flows

- F1. Search for a Caplet
  - **Trigger:** A user lands on `catalog.caplets.dev` with an integration or workflow in mind.
  - **Actors:** A1, A5
  - **Steps:** The user searches, scans results with labels, counts, workflow metadata, and install command previews, opens a promising entry, reads the Caplet content and warnings, then copies the install command.
  - **Covered by:** R3, R4, R5, R22, R23, R28, R41

- F2. Index an official Caplet
  - **Trigger:** The repo-owned catalog contains an installable Caplet.
  - **Actors:** A4, A6
  - **Steps:** The index includes the official Caplet, marks it as official, exposes its source content, and produces the supported install command.
  - **Covered by:** R5, R11, R21, R41

- F3. Index a community Caplet from install
  - **Trigger:** A user successfully installs a Caplet from a public external source.
  - **Actors:** A2, A3, A6
  - **Steps:** The install reports public source metadata to the catalog indexer, the indexer fetches the public Caplet file from a supported public provider, validates ingestion hygiene, updates aggregate count, and makes the entry searchable as unverified community content.
  - **Covered by:** R12, R13, R15, R17, R18, R20, R25

- F4. Skip a private or invalid source
  - **Trigger:** An install source is private, not fetchable, invalid, or non-normalizable.
  - **Actors:** A2, A6
  - **Steps:** The install can continue locally, but the public indexer does not publish the entry and does not leak source details.
  - **Covered by:** R14, R15, R16, R25, R40

- F5. Use catalog during implementation
  - **Trigger:** A future agent builds the catalog frontend.
  - **Actors:** A7
  - **Steps:** The agent uses `$impeccable`, follows the Caplets product design system, and verifies the search and install surfaces across accessibility and responsive states.
  - **Covered by:** R30, R31, R32, R33, R34, R35, R36

- F6. Install a Caplet that needs Vault setup
  - **Trigger:** A user installs, restores, or updates a Caplet whose runtime config references Caplets Vault.
  - **Actors:** A2, A3, A8
  - **Steps:** The CLI completes the catalog lifecycle operation, detects target-runtime Vault references, prompts to grant an existing key or set a missing key, creates the needed access grant, and keeps secret values out of catalog indexing and install output.
  - **Covered by:** R44, R45, R46, R47, R48, R49

---

## Acceptance Examples

- AE1. **Covers R3, R4, R5, R23.** Given a user searches for "sentry", when results appear, then each matching result shows source, label, install count, workflow metadata, and install command preview, and the detail view lets the user read the Caplet before copying the install command.
- AE2. **Covers R5, R11, R21, R41.** Given `sentry` is in the repo-owned catalog, when it appears on the site, then it is marked official, exposes readable source content, and shows a supported `caplets install spiritledsoftware/caplets sentry` command.
- AE3. **Covers R12, R13, R17, R20.** Given a user installs `owner/repo my-caplet` from a public repo, when indexing succeeds, then the site can show the public `CAPLET.md` content, normalized install command, aggregate installs, and unverified community label.
- AE4. **Covers R14, R15, R16.** Given a user installs from a private repo, local path, private IP-backed source, or unsupported redirect, when the install completes locally, then the public catalog does not publish that source or Caplet identity.
- AE5. **Covers R22, R24, R28.** Given a community Caplet exposes local browser control, when the detail page shows the install command, then a visible warning tells users to inspect and trust the source, without claiming scanner approval.
- AE6. **Covers R26, R27.** Given a community `CAPLET.md` contains unsafe HTML or a hand-written install snippet, when the detail page renders, then unsafe content is stripped or escaped and the copy command comes from normalized source metadata.
- AE7. **Covers R30, R32, R33, R34, R35.** Given the catalog frontend is implemented, when it is reviewed with Impeccable, then search, filters, result cards, warnings, empty states, and copy actions are responsive, state-complete, and accessible without relying only on color.
- AE8. **Covers R37, R38, R39, R43.** Given a user reads catalog documentation, when it describes public indexing, then it distinguishes public-source catalog indexing from ordinary anonymous telemetry, names the metadata that may become public, and explains that install counts are not safety signals.
- AE9. **Covers R44, R45, R46, R47, R48, R49.** Given a user installs a Caplet that references `$vault:GH_TOKEN`, when the target Vault already has `GH_TOKEN`, then install prompts to grant it to the Caplet; when the key is missing, install prompts to set and grant it; and when the command is noninteractive, install returns recovery commands without leaking the secret or blocking on a prompt.

---

## Success Criteria

- Users can search official and community Caplets from a dedicated `catalog.caplets.dev` site.
- A user can read the indexed Caplet content and copy a supported install command without leaving the catalog detail page.
- Official and community entries are visually and semantically distinguishable.
- Community entries are labeled unverified and warn users to inspect Caplets before install.
- Public external installs can create or update catalog entries without a manual submission workflow.
- Install counts support ranking without exposing individual installation details or implying safety.
- The catalog does not claim scanner coverage in v1.
- Installs of Caplets that request Vault-backed config guide users to grant existing Vault keys or set missing keys for the correct runtime without exposing secret values to catalog systems.
- The indexer has a clear suppression path for stale, abusive, leaked, or high-risk community entries.
- The frontend design pass uses Impeccable and lands as a precise developer-tool surface rather than a generic marketplace.

---

## Scope Boundaries

- Semantic security scanning, dependency scanning, secret scanning, OpenSSF Scorecard, Socket-style partner audits, and LLM malicious-intent review are deferred.
- Ratings, reviews, comments, report-abuse flows, manual moderation queues, publisher profiles, and verified publisher programs are deferred.
- Lightweight entry suppression, source-owner removal handling, and an operator stop rule remain in scope as ingestion safety controls, not as a full moderation system.
- Hosted account features, personalized recommendations, saved Caplets, and user dashboards are deferred.
- The catalog should not become the primary docs site or replace `docs.caplets.dev`.
- The catalog should not imply that installing a community Caplet is safe merely because it is indexed.

---

## Dependencies / Assumptions

- The current repo-owned catalog under `caplets/` remains the source of official entries.
- Lockfile-backed install and update behavior remains the install lifecycle foundation.
- Public external indexing needs an explicit public-source signal because ordinary anonymous telemetry forbids publishing source and Caplet identity.
- External community indexing is limited to sources that can be publicly fetched and normalized.
- The first release can use basic ingestion hygiene without blocking future scanner integration.
- Caplets Vault remains runtime-owned state, so install-time setup must create grants in the same runtime that will execute the installed Caplet.
- Public-source install notices can be non-blocking, but the user must be able to learn that public external installs may contribute to the public catalog.
- The existing Caplets product design context is the right design foundation for the catalog site.

---

## Sources / Research

- `STRATEGY.md` for the Code Mode-first product frame.
- `CONCEPTS.md` for Prebuilt Caplets Catalog, Catalog-Grade Caplet, Caplets Lockfile, and Anonymous Telemetry vocabulary.
- `alchemy.run.ts` and `infra/alchemy-domains.ts` for the existing landing/docs Cloudflare deployment shape.
- `apps/landing/PRODUCT.md`, `apps/landing/DESIGN.md`, and `apps/landing/src/styles/starwind.css` for Caplets frontend design context.
- `caplets/` for official catalog source files.
- `apps/docs/src/content/docs/install.mdx` for current lockfile-aware install and update docs.
- `packages/core/src/cli.ts` and `packages/core/src/cli/install.ts` for current install, restore, update, and lockfile behavior.
- `docs/product/caplets-vault.md` for Vault references, runtime-owned stores, and access grants.
- `docs/product/anonymous-telemetry.md` and `packages/core/src/telemetry/privacy.ts` for telemetry privacy boundaries.
- `skills/writing-caplets/SKILL.md` for catalog-grade Caplet authoring expectations.
- `https://www.skills.sh/` for the search and install-count discovery pattern.
- `https://github.com/vercel-labs/skills` for the public skills CLI install telemetry and audit-display shape.
- `https://socket.dev/blog/socket-brings-supply-chain-security-to-skills` for the security-scanning model intentionally deferred from v1.
