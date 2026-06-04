---
target: cloud UI
total_score: 22
p0_count: 1
p1_count: 2
timestamp: 2026-05-31T12-57-16Z
slug: apps-cloud-ui-src-routes-workspace-tsx
---

# Design Health Score

| #         | Heuristic                       | Score     | Key Issue                                                                                                                                  |
| --------- | ------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1         | Visibility of System Status     | 1         | The intended UI has status panels, but the live page is replaced by a Vite import error.                                                   |
| 2         | Match System / Real World       | 3         | Developer-tool concepts mostly map well, though `local presence`, `sync/apply receipts`, and `tool surface` need more user-facing framing. |
| 3         | User Control and Freedom        | 2         | Copy, retry, and anchor navigation exist, but there is no clear active route, current step control, or way back from blocked setup states. |
| 4         | Consistency and Standards       | 3         | The component vocabulary is restrained and consistent, but the repeated panel-header pattern flattens sections.                            |
| 5         | Error Prevention                | 1         | Missing modules block rendering, and status copy can imply health even while required setup is incomplete.                                 |
| 6         | Recognition Rather Than Recall  | 3         | The setup path, metrics, and command callouts reduce recall, but several commands are detached from their exact next action.               |
| 7         | Flexibility and Efficiency      | 2         | Sidebar anchors and copy buttons help, but there are no power-user shortcuts, filters, or compact inspection affordances.                  |
| 8         | Aesthetic and Minimalist Design | 3         | Quiet, usable product styling, with some panel sameness and cool-token drift from the stated design system.                                |
| 9         | Error Recovery                  | 2         | Source includes a recovery panel, retry, and diagnostics, but the actual browser error bypasses it entirely.                               |
| 10        | Help and Documentation          | 2         | Inline instructions exist, but the UI lacks contextual help for local presence, connector authorization, and audit interpretation.         |
| **Total** |                                 | **22/40** | **Promising, currently blocked**                                                                                                           |

# Anti-Patterns Verdict

**LLM assessment**: This does not read as instant AI slop. It has a credible developer-tool shell, restrained borders, compact typography, and useful non-color status shapes. The weak spots are product-specific: too many equal panels, repeated eyebrow-plus-title headers, and a first screen that describes the system more than it drives the next task.

**Deterministic scan**: `detect.mjs --json apps/cloud-ui/src/routes/workspace.tsx apps/cloud-ui/src/components apps/cloud-ui/src/styles/global.css` returned `[]`. No bundled detector findings.

**Visual overlays**: No reliable user-visible overlay is available. The Vite page fails before the app renders because `src/routes/workspace.tsx` cannot resolve `../lib/cloud-api`; browser evidence is the Vite import-analysis overlay, not the intended UI.

# Overall Impression

The design direction is right for Caplets Cloud: calm, technical, inspectable. The app shell wants to be a focused cloud workspace dashboard, not a marketing page, and the source mostly honors that. The biggest opportunity is to make the first screen operational: one current blocker, one primary next action, then inspectable detail.

# What's Working

1. The visual system is product-appropriate. The sidebar, flat panels, tight radii, visible focus style, and reduced-motion handling support a serious developer tool.
2. The source includes real state thinking: loading, error, empty, ready, connector status, local presence, sync receipts, runtime rows, and audit rows.
3. Copy is mostly concrete. Labels like `Copy endpoint`, `Retry workspace load`, and `Open OAuth metadata` describe actions rather than vague confirmations.

# Priority Issues

**[P0] The cloud UI does not render**

**Why it matters**: A user never reaches the workspace dashboard. Vite shows `[plugin:vite:import-analysis] Failed to resolve import "../lib/cloud-api" from "src/routes/workspace.tsx"` at `apps/cloud-ui/src/routes/workspace.tsx:16`.

**Fix**: Restore or create `apps/cloud-ui/src/lib/cloud-api.ts` and `apps/cloud-ui/src/lib/mock-workspace.ts`, then make `pnpm --filter @caplets/cloud-ui typecheck` and the Vite route pass before any visual polish.

**Suggested command**: `$impeccable harden cloud UI`

**[P1] The first screen lacks a single next step**

**Why it matters**: The UI presents endpoint copy, a four-step setup rail, connectors, runtime, local presence, receipts, and audit as peers. A first-time workspace owner has to infer which blocker matters now.

**Fix**: Promote a state-driven "Next action" area directly under the header. When Sourcegraph needs OAuth, make that the primary action. When local presence is missing, make the doctor command the primary action. Move completed proof into compact secondary detail.

**Suggested command**: `$impeccable layout cloud UI`

**[P1] Sidebar health can contradict workspace blockers**

**Why it matters**: The sidebar says `OAuth active` and `tool surface verified` while the setup rail can still show `Authorize connector` and `Start local presence` as needing action. That undermines trust in the status model.

**Fix**: Replace the static sidebar health block with a summarized blocker count and the current highest-severity state. Add active section styling to the sidebar anchors so navigation communicates location.

**Suggested command**: `$impeccable clarify cloud UI`

**[P2] Panel hierarchy is too even**

**Why it matters**: Connector catalog, tool surface, runtime, presence, receipts, and audit all use the same bordered panel language. The user cannot tell which panels are operational, which are proof, and which are historical.

**Fix**: Create three section weights: primary task, live status, and audit/history. Give the task panel stronger action placement, make live status denser, and let audit/history become quieter table/detail content.

**Suggested command**: `$impeccable distill cloud UI`

**[P2] Design tokens drift from the documented warmth**

**Why it matters**: `DESIGN.md` describes ember, parchment, charred ink, and warm technical surfaces. The CSS tokens use cool hue values for parchment, linen, paper, ash, and focus. The result risks reading as generic cool admin UI rather than Caplets' owned warm map language.

**Fix**: Bring the CSS OKLCH hues back toward the documented palette, keep ember rare, and reserve cool tones only where they carry specific state meaning.

**Suggested command**: `$impeccable colorize cloud UI`

# Persona Red Flags

**Alex, agent power user**: Alex cannot use the UI at all until the missing imports are fixed. Once rendered, the equal panel grid and missing active nav state slow scanning. The audit table has no filter or search, so repeated operational checks become manual.

**Jordan, first-time connector setup user**: Jordan sees a slogan, endpoint, setup path, connector catalog, local presence, and audit trail, but no single "do this now" control. `Use connector setup to authorize Sourcegraph` is instructional text, not an actionable button.

**Sam, security-conscious workspace admin**: Sam needs a trustworthy status summary. Static `OAuth active` sidebar copy conflicts with visible warning states, and the audit table is readable but lacks severity, actor, filtering, or export affordances.

# Minor Observations

- The loading state is a centered panel, not a skeleton, so it does not prepare the user for the workspace layout.
- `Copy endpoint` succeeds through a screen-reader-only live region, but visual users get no visible confirmation.
- `runtimeReasons[row.label]` can render empty explanatory text if a new runtime row label appears.
- The `ConnectorList` status lookup is repeated several times per row; deriving it once would reduce fragility.
- The mobile table conversion is thoughtful, but the audit rows need stronger labels or grouping when they become cards.

# Questions To Consider

1. What is the one action a workspace owner should take after opening this page when two blockers exist?
2. Should Caplets Cloud sell the concept on this screen, or assume the user is already here to configure and verify?
3. Which state should the sidebar summarize: authentication, connector readiness, local presence, or overall workspace health?
