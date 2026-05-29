---
target: apps/landing/src/pages/index.astro
total_score: 28
p0_count: 0
p1_count: 2
timestamp: 2026-05-29T16-03-18Z
slug: apps-landing-src-pages-index-astro
---

Design Health Score

| #     | Heuristic                       | Score | Key Issue                                                                                                                   |
| ----- | ------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------- |
| 1     | Visibility of System Status     | 3     | The trace status and active step are strong, but remote setup status is not as immediately legible.                         |
| 2     | Match System / Real World       | 3     | The inspect/search/schema/call story maps well to agent behavior; remote server copy is accurate but abstract.              |
| 3     | User Control and Freedom        | 3     | Theme, tabs, copy buttons, and hover interruption are solid; the hero animation still competes with direct scanning.        |
| 4     | Consistency and Standards       | 3     | Radius tokens and tab patterns are much improved; mono labels and pills are now used heavily enough to blur hierarchy.      |
| 5     | Error Prevention                | 2     | Setup snippets are copyable, but commands omit enough real-world auth caveats that users may hit avoidable dead ends.       |
| 6     | Recognition Rather Than Recall  | 3     | The capability trace teaches the model; the remote value still asks visitors to infer why this changes daily use.           |
| 7     | Flexibility and Efficiency      | 3     | Tabs and examples support different agents and caplets; mobile hides too much trace detail to stay educational.             |
| 8     | Aesthetic and Minimalist Design | 3     | The page has a clear point of view, but the dark remote/setup slabs make the middle of the page feel heavier than the hero. |
| 9     | Error Recovery                  | 2     | Copy fallback exists, but no setup troubleshooting path is embedded beyond brief text.                                      |
| 10    | Help and Documentation          | 3     | Benchmark and repo links are present; the page could route users from each example to its exact CAPLET.md.                  |
| Total |                                 | 28/40 | Strong, shippable, still a bit explanation-heavy.                                                                           |

Anti-Patterns Verdict

LLM assessment: This no longer reads like a generic AI landing page. The hero proposition is specific, the trace reactor is a real visual artifact, and the setup content is product-grounded. The remaining slop risk is not visual cliché so much as developer-page density: labels, pills, snippets, terminals, and muted panels repeat until the page starts feeling like a reference doc wearing a campaign outfit.

Deterministic scan: Clean. The bundled detector returned zero findings for apps/landing/src/pages/index.astro.

Visual overlays: Browser overlay injection was not available in this session. Fallback evidence used: live dev-server HTML fetched successfully from http://100.120.25.110:4321/, source inspection, detector output, campaign check, and Astro typecheck.

Overall Impression

The landing page is much stronger than where it started: the motto is crisp, the hero teaches the core mechanism, and the remote/server story finally has a home. The single biggest opportunity is to turn the lower half from "complete documentation preview" into a sharper conversion path. The page proves Caplets works; now it needs to make the next action feel inevitable.

What's Working

1. The hero is finally anchored by the right product sentence: "Give your agent capabilities, not tools" in apps/landing/src/pages/index.astro:264. It is concrete and differentiated.
2. The trace reactor is the page's best asset. It explains progressive disclosure visually, not just verbally, with source/auth/state/steps in apps/landing/src/pages/index.astro:275-323.
3. The new setup sequence is directionally right: integration first, then premade caplet examples, with GitHub/Sourcegraph/OSV showing different value shapes in apps/landing/src/pages/index.astro:417-540.

Priority Issues

[P1] The hero gives away too much educational surface on mobile
Why it matters: At max-width 980px and 720px, CSS hides metadata, step descriptions, and code results from the trace (apps/landing/src/styles/global.css:1469-1473 and 1626-1651). That prevents overflow, but it also strips the hero's main proof object down to labels. A first-time mobile visitor sees the claim, not the mechanism.
Fix: Replace the full reactor with a dedicated mobile trace summary: one compact source/auth row, four tappable steps, and the active result shown in a single fixed output well below the tabs. Do not just hide fields.
Suggested command: $impeccable adapt landing

[P1] The remote story says the value, but does not dramatize the pain it solves
Why it matters: The section explains auth centralization in apps/landing/src/pages/index.astro:343-414, but it does not show the before/after: repeated local auth per client versus one server-held provider token reused everywhere. Users who do not already feel that pain may miss why the remote mode matters.
Fix: Reframe the section around a two-state comparison: "Without remote Caplets" and "With remote Caplets". Keep the snippets, but make the auth reuse the hero of the layout, not a paragraph.
Suggested command: $impeccable clarify landing

[P2] The setup area is useful but visually over-weighted
Why it matters: The integrations section is a large dark block, followed by a lighter activation block with another tab system. Both are valid, but together they create a dense reference-zone after the benchmark. The conversion path becomes: choose integration, read config, pick example, read commands, copy. That is a lot of micro-decisions.
Fix: Make Setup a guided two-step: Step 1 integration, Step 2 first caplet. Keep tabs, but reduce visible chrome and collapse secondary examples until the selected path is understood.
Suggested command: $impeccable distill landing

[P2] The page still relies too much on mono pills as the main explanatory language
Why it matters: Pills are used for nav, integration tabs, example tabs, discovery paths, status, copy buttons, and labels. It creates consistency, but it also makes very different actions and concepts feel equally important.
Fix: Reserve filled pills for selected state and actual capability identity. Use quieter text links or segmented controls for navigation; use plain inline code for discovery operations.
Suggested command: $impeccable typeset landing

[P3] The proof strip underplays the benchmark emotionally
Why it matters: The benchmark is strong, but apps/landing/src/pages/index.astro:327-340 presents it as a thin row. It is easy to scan past despite being one of the most persuasive claims on the page.
Fix: Give the benchmark one decisive sentence and a small before/after payload visualization. Avoid hero-metric cliché; use the actual 106 -> 3 reduction as a compact structural diagram.
Suggested command: $impeccable bolder landing

Persona Red Flags

Jordan, first-time agent tool user: Jordan understands the headline, but the trace loses meaning on mobile because descriptions and results are hidden. The remote section assumes they already know why provider auth spread across clients is annoying.

Riley, power user evaluating install friction: Riley likes copyable snippets and tabs, but wants exact links from each premade example to its source CAPLET.md, plus clearer command/auth expectations before copying.

Sam, skeptical maintainer: Sam is persuaded by the deterministic benchmark, but the proof strip is visually quiet. They may miss the strongest evidence unless they intentionally read the whole page.

Minor Observations

- The kicker "Agent tools without the wall" is clear, but it is close enough to the H1 that it may be redundant.
- The remote endpoints row is accurate, but endpoints are lower-value than the auth reuse story for a landing page.
- The page uses Inter, which is serviceable, but the brand could eventually benefit from a less default technical sans once layout stabilizes.
- The footer motto still says "giant tool walls" while the H1 says "not tools"; the H1 is stronger.

Questions to Consider

- What is the one setup path the page most wants a new user to complete in the first minute: Codex + GitHub, or agent-agnostic install?
- Should the remote story be a proof section, a setup mode, or a hero-adjacent value prop?
- Is the benchmark supposed to reassure after the hero, or should it be the main persuasion engine?
