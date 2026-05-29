---
target: apps/landing/src/pages/index.astro
total_score: 26
p0_count: 0
p1_count: 2
timestamp: 2026-05-29T10-04-14Z
slug: apps-landing-src-pages-index-astro
---

#### Design Health Score

| #         | Heuristic                         | Score     | Key Issue                                                                                                                                                                    |
| --------- | --------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1         | Visibility of System Status       | 3         | Copy buttons have feedback and tabs expose selected state, but there is no visible install success path or live state beyond copy feedback.                                  |
| 2         | Match System / Real World         | 3         | The core metaphor, capabilities instead of tool walls, is concrete for agent builders. Some labels still assume MCP fluency.                                                 |
| 3         | User Control and Freedom          | 3         | Anchor navigation, copy fallback, and tab keyboard controls are solid. Hidden inactive panels create many invisible buttons in the DOM, but not user-visible traps.          |
| 4         | Consistency and Standards         | 3         | Visual system is cohesive, but numbered top nav and repeated eyebrow cadence conflict with the otherwise product-specific voice.                                             |
| 5         | Error Prevention                  | 2         | Install commands are copyable, but there is no guardrail for prerequisites, failed installs, or what users should verify after `caplets serve`.                              |
| 6         | Recognition Rather Than Recall    | 3         | The trace, proof panel, and install path make the model visible. Some advanced terms, `get_caplet`, `structuredContent`, and MCP client setup, rely on prior knowledge.      |
| 7         | Flexibility and Efficiency of Use | 3         | Agent-specific tabs and copy buttons support fast use. The page does not yet expose a shortest path for experienced users above the fold.                                    |
| 8         | Aesthetic and Minimalist Design   | 2         | Strong editorial direction, but the page is long, card-heavy, and still carries AI-pattern residue: numbered nav, eyebrow chips, wide shadows, and many bordered containers. |
| 9         | Error Recovery                    | 2         | The product concept explains scoped error recovery, but the landing page does not help users recover from install or setup failure.                                          |
| 10        | Help and Documentation            | 2         | GitHub/config links exist, but contextual help is light and task-focused docs are not surfaced near the install commands.                                                    |
| **Total** |                                   | **26/40** | **Acceptable: strong message, needs hierarchy and activation polish before broad launch.**                                                                                   |

#### Anti-Patterns Verdict

**LLM assessment**: This does not look like generic AI slop at first glance. The message is specific, the trace card is relevant, and the benchmark proof creates a sharper story than a normal SaaS landing page. The slop risk is structural rather than visual: too many sections use the same formula of small label, large heading, bordered container, and explanatory prose. The page says progressive disclosure, but the page itself asks visitors to process a long sequence of similarly weighted proof blocks.

**Deterministic scan**: The CLI detector found 2 issues in `apps/landing/src/pages/index.astro`:

- `em-dash-overuse`, warning, line 0: reported 5 `--` sequences. This is mostly a false positive from command-line flags like `--command` and frontmatter delimiters, not body copy.
- `numbered-section-markers`, advisory, line 0: top navigation uses `01`, `02`, `03`, which matches the numbered editorial scaffold ban.

**Browser overlay / console evidence**: Injection succeeded on the live page at `http://127.0.0.1:4321/`. The detector console reported: uppercase body text, hero eyebrow chip, oversized H1, 1px border plus 100px shadow blur, wide tracking, long line length around 143 chars, and overused primary font. Several are advisory or noisy, but two align with the manual review: the eyebrow/numbered scaffold and the thin-border plus wide-shadow pattern.

#### Overall Impression

The landing page has a real argument: Caplets reduces tool-wall overload with progressive discovery. The best parts are the hero trace, the before/after comparison, and the deterministic benchmark proof. The biggest opportunity is to make the page behave like the product promise: one clear capability story first, then deeper evidence only as needed. Right now it still feels like every section is competing to prove the same point.

#### What's Working

1. **The core claim is memorable and specific.** “Capabilities, not giant tool walls” names the pain and the mechanism. It is much stronger than a vague agent-platform tagline.
2. **The trace card demonstrates the product instead of decorating it.** The hero’s `get_caplet → search_tools → get_tool → call_tool` flow helps technical readers understand the mental model quickly.
3. **The benchmark proof has launch value.** “106 flat tools became 3 capability cards” is concrete enough for Reddit, HN, and agent-builder audiences, provided the visual treatment stays sober.

#### Priority Issues

**[P1] The page contradicts its own progressive-disclosure premise**

- **Why it matters**: The product says agents should not see every operation up front, but the landing page gives humans many similarly weighted sections, cards, proof blocks, tabs, trust details, and install steps. The message is right, but the experience still feels like a tool wall translated into marketing sections.
- **Fix**: Collapse the middle of the page into a tighter narrative: hero trace, benchmark proof, one trust strip, then install. Move secondary explanatory cards into expandable details or lower-priority documentation links.
- **Suggested command**: `$impeccable distill apps/landing/`

**[P1] The activation path is too late and too similar in weight to the rest of the page**

- **Why it matters**: Agent power users want the quickest route to proof. They should be able to install, add Context7, and recognize the aha moment without scrolling past multiple conceptual sections.
- **Fix**: Promote the Context7 aha path closer to the hero, or add a compact “Try it in 60 seconds” strip immediately after the hero/proof pair. Keep the final install card, but make it the expanded version, not the first activation cue.
- **Suggested command**: `$impeccable onboard apps/landing/`

**[P2] AI-pattern residue weakens an otherwise specific brand**

- **Why it matters**: The audience is agent power users and MCP server builders, exactly the people most sensitive to AI-generated landing-page tropes. Numbered nav markers, repeated eyebrow labels, wide tracking, and bordered card repetition make the page feel more templated than the product deserves.
- **Fix**: Remove `01/02/03` from nav, reduce eyebrow frequency, replace at least one card grid with a more native artifact, such as a config diff, terminal transcript, or source manifest.
- **Suggested command**: `$impeccable quieter apps/landing/`

**[P2] Setup confidence is incomplete**

- **Why it matters**: The page gets users to `caplets serve`, but does not answer “what should I see next?” or “what if it fails?” That creates a trust gap at the exact moment activation should peak.
- **Fix**: Add expected output and verification after the commands: one capability appears, then `get_caplet`, then scoped discovery. Add one concise troubleshooting line for Node version, missing `npx`, or MCP client connection.
- **Suggested command**: `$impeccable harden apps/landing/`

**[P3] The hero visual treatment still has a heavy SaaS-card smell**

- **Why it matters**: The trace card is conceptually good, but the 1px border plus broad soft shadow pattern is a known AI/devtool visual tell. It makes the strongest artifact feel more generic than it needs to.
- **Fix**: Either commit to a flatter technical artifact, like a real terminal/config panel with minimal shadow, or make it feel like a source manifest with sharper borders and less blur.
- **Suggested command**: `$impeccable polish apps/landing/`

#### Persona Red Flags

**Jordan, first-time agent-tool user**

- Primary action: understand what Caplets does, then try it.
- Red flags: `MCP`, `structuredContent`, `get_caplet`, `search_tools`, and `call_tool` appear before enough plain-language anchoring for a new user. Jordan understands the headline but may not know whether Caplets is a CLI, MCP server, plugin, or framework until later.

**Riley, deliberate stress tester**

- Primary action: verify the claims before installing.
- Red flags: the benchmark claim is strong, but the page does not directly link from the proof asset to the deterministic benchmark report. Riley will want the source of “106 flat tools” and the exact test conditions.

**Casey, distracted mobile user**

- Primary action: scan on a phone, save or try later.
- Red flags: mobile has no horizontal overflow, which is good, but the hero alone is very tall and the full page is long. Casey reaches the install section only after several large sections. The top nav is available, but the primary “try it” cue is not persistent or early enough.

#### Minor Observations

- Touch targets are generally good, with most links and buttons at or above 44px.
- The hidden copy buttons in inactive tab panels show as 0×0 in measurement because panels are hidden. That is acceptable if screen reader exposure is also hidden by the `hidden` attribute.
- The repeated section-note/kicker pattern is useful in moderation, but the page uses it often enough to become a rhythm rather than a decision.
- The installed command now uses `context7`, which matches the activation story better than the older `docs` alias.
- The body background and warm tokens are established identity in this repo, but they still sit close to the current AI “paper” default. The dark integrations section helps break that pattern.

#### Questions to Consider

- What if the page had only one deep technical artifact above the fold, then let proof and install orbit around it?
- What would change if “try Context7 in 60 seconds” were the second thing users saw?
- Which details belong on the landing page, and which belong in docs for users already convinced?
