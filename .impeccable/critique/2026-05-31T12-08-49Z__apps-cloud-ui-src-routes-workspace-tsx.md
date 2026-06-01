---
target: cloud ui
total_score: 22
p0_count: 1
p1_count: 2
timestamp: 2026-05-31T12-08-49Z
slug: apps-cloud-ui-src-routes-workspace-tsx
---

# Caplets Cloud UI Critique

## Design Health Score

| #         | Heuristic                       | Score     | Key Issue                                                                                                                                                                  |
| --------- | ------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1         | Visibility of System Status     | 2         | The live app shows an error state, but successful workspace health is split across status, presence, receipts, and audit without a clear current state summary.            |
| 2         | Match System / Real World       | 3         | The product language is credible for MCP and Caplets users, but terms such as local presence, sandbox leases, and implicit apply arrive before enough operational framing. |
| 3         | User Control and Freedom        | 2         | Primary actions are mostly disabled or copy-only, and there is no visible way to retry, reconnect, authorize, revoke, or inspect details from the error/current states.    |
| 4         | Consistency and Standards       | 3         | Components are visually consistent and restrained, though every panel uses the same eyebrow/title/card rhythm.                                                             |
| 5         | Error Prevention                | 2         | The UI explains OAuth-only and local presence concepts, but does not prevent dead-end states such as disabled Add connector and Run caplets doctor buttons.                |
| 6         | Recognition Rather Than Recall  | 2         | Users must infer how Endpoint, Connectors, Runtime, Presence, Receipts, and Audit relate to the setup path.                                                                |
| 7         | Flexibility and Efficiency      | 2         | The dashboard lacks compact drill-downs, filters, copyable commands beyond the endpoint, or direct remediation actions for power users.                                    |
| 8         | Aesthetic and Minimalist Design | 3         | The palette and density fit Caplets, but the grid background and repeated panel pattern flatten the page into a static spec sheet.                                         |
| 9         | Error Recovery                  | 1         | The live error exposes a browser implementation message and gives no retry, fallback, or useful next step.                                                                 |
| 10        | Help and Documentation          | 2         | Copy is precise, but contextual help is too sparse for high-risk setup concepts like project-bound execution and apply receipts.                                           |
| **Total** |                                 | **22/40** | **Needs focused product polish**                                                                                                                                           |

## Anti-Patterns Verdict

**LLM assessment**: This does not look like generic AI SaaS. It avoids hero metrics, gradient text, glass, huge rounded cards, and neon developer theater. The slop risk is subtler: repeated panel headers, disabled buttons, and a dashboard made from similarly weighted boxes make the workspace feel mocked rather than operated.

**Deterministic scan**: CLI detector over `apps/cloud-ui/src` returned `[]`. Browser overlay on the live error state reported one `hero-eyebrow-chip` finding for `Workspace unavailable` above `Could not load workspace`. That is a fair warning because the error card inherits the same label treatment used elsewhere, making failure feel like another marketing/info panel instead of a recovery state.

**Visual overlays**: Injection succeeded in the browser session after the live app loaded, and the console reported the eyebrow-chip issue on the error page. The overlay could only evaluate the error state because the app failed before the workspace UI rendered.

## Overall Impression

The intended direction is right: quiet, technical, dense, and specific to Caplets Cloud. The problem is that the running UI currently fails before users can reach it, and the designed workspace state does not yet behave like a control plane. It communicates the product thesis, but it does not yet help a developer complete setup, diagnose availability, or recover from failure.

## What's Working

- The visual register is aligned with Caplets: warm light surfaces, restrained ember, compact type, thin borders, and no theatrical dark-mode or generic SaaS polish.
- The copy has real product proof: `3 visible Caplets`, `106 hidden downstream tools`, OAuth-only hosted MCP, local presence, and sync/apply receipts are concrete.
- The information model includes the right control-plane objects: endpoint, connector catalog, tool surface report, runtime status, local presence, receipts, and audit trail.

## Priority Issues

### [P0] Live workspace route fails before showing the dashboard

**Why it matters**: A user sees `Failed to execute fetch on Window: Illegal invocation` instead of the workspace. That destroys trust and prevents evaluation of every other design decision.

**Fix**: Bind or wrap the default fetch implementation in `CloudApiClient` instead of storing the unbound browser `fetch`, then render a product-safe error only for real API failures. Add retry and a fallback diagnostic line that says which workspace/API URL failed.

**Suggested command**: `$impeccable harden cloud ui`

### [P1] Error recovery is raw, non-actionable, and visually under-prioritized

**Why it matters**: Cloud setup failures are expected: auth, workspace creation, API reachability, local presence, connector auth. The current error state exposes implementation text and gives no path forward.

**Fix**: Replace raw exception copy with a recovery panel: failed target, retry button, sign in/authorize action when relevant, workspace slug, API base URL, and a compact details disclosure for developer diagnostics.

**Suggested command**: `$impeccable harden cloud ui`

### [P1] The successful workspace state reads like a static product proof, not an operational workflow

**Why it matters**: The page proves the thesis but does not guide the user through the next action. Disabled Add connector and Run caplets doctor controls signal unfinished product rather than unavailable state.

**Fix**: Promote a setup/status rail above the panels: Connect MCP client, Add or authorize connector, Start local presence, Verify tool surface. Disabled actions need reasons and adjacent enabled alternatives, such as copy CLI command or open OAuth flow.

**Suggested command**: `$impeccable onboard cloud ui`

### [P2] Panel hierarchy is too even

**Why it matters**: Endpoint, connectors, surface report, runtime, presence, receipts, and audit all compete at similar weight. Users cannot quickly tell what needs attention now.

**Fix**: Make the endpoint/current health area the primary operational header, use a compact two-column health summary, and demote receipts/audit into tabs or collapsible inspection sections. Keep connectors as the main editable surface.

**Suggested command**: `$impeccable layout cloud ui`

### [P2] State cues rely too much on color and terse labels

**Why it matters**: `Ready`, `Needs OAuth`, `Local required`, `presence required`, and colored dots are meaningful only after the user already understands the system.

**Fix**: Pair every status with an icon/shape and a one-line action or reason. Example: `Needs OAuth: authorize Sourcegraph to expose this Caplet`. Use warning styling for actual action-required states, not just a yellow dot.

**Suggested command**: `$impeccable clarify cloud ui`

## Persona Red Flags

**Morgan, agent power user**: They want to connect the endpoint and verify what agents will see. They can copy the endpoint, but cannot inspect the exact capability cards, simulate a client session, filter hidden tools, or see why a project-bound Caplet is unavailable.

**Riley, first-time cloud user**: They land on an implementation error in the live app. Even in the intended state, `local presence`, `project-bound remote execution`, and `implicit apply pending` appear without enough action framing. The next step is unclear.

**Sam, security-conscious team lead**: OAuth-only is visible, and audit exists, but there is no obvious token/session revocation, connector credential boundary, local presence revocation, or policy blocker detail. Trust signals are present but not inspectable enough.

## Minor Observations

- The global grid background is tasteful but constant. On long product surfaces it adds visual texture without improving scanability.
- The disabled buttons need `aria-describedby` reasons or inline explanatory text.
- The sidebar nav has no active section state, so it works as a table of contents rather than workspace navigation.
- The audit table is readable, but on mobile it becomes horizontal scroll. A stacked event list would be more usable below 640px.
- `Tool Surface Report` has one duplicated concept: `106 hidden downstream tools` appears in both `dt` and `dd`.

## Questions to Consider

- What is the one setup state Caplets Cloud should make impossible to miss?
- Should the first screen optimize for connecting an MCP client, authorizing connectors, or proving tool-surface reduction?
- Which trust details need to be inspectable before a developer lets project-bound execution touch a local repo?
