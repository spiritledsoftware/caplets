# Agent card setup tabs design

## Context

The landing page has an agents/integrations card that currently uses agent pills to show supported agent integrations. The desired change is to keep the card's current layout and visual model, but make each agent pill act as a tab that reveals setup instructions for that specific agent.

## Goals

- Preserve the existing agents card structure and overall visual treatment.
- Turn each existing agent pill into a tab trigger.
- Show the selected agent's install command and configuration snippet in the card.
- Keep setup content copy-pasteable and easy to scan.
- Make the data model extensible for additional agents.

## Non-goals

- Do not redesign the entire integrations section.
- Do not add a modal, accordion, or separate setup page.
- Do not change the core Caplets runtime behavior.

## UX design

The agents card remains visually recognizable. The current agent pills become tab controls. One pill is selected by default, and its setup content appears in a shared detail area inside the same card. Selecting another pill swaps the detail content without navigating away.

The active pill should use the existing pill style with a clear selected state. The inactive pills should remain lightweight. The detail area should contain a short label, the install command, and the configuration snippet. Commands and snippets should be styled as code blocks and fit the existing landing page aesthetic.

## Data model

Represent each agent as structured data with fields similar to:

```ts
{
  name: string;
  summary: string;
  installCommand: string;
  configSnippet: string;
  note?: string;
}
```

Rendering should map over this data rather than hardcoding per-agent markup. That keeps future agent additions localized to the data list.

## Interaction and accessibility

Use tab semantics where practical: each pill should behave like a tab, the selected setup area should behave like a tab panel, and keyboard navigation should not regress from the current page. If the page remains mostly static Astro output, the tab behavior can be implemented with minimal client-side JavaScript scoped to this card.

## Testing

Add focused coverage for the landing page source or component behavior where the repo's current test setup supports it:

- Agent tab labels render.
- The default selected agent's install command and configuration snippet render.
- Selecting another pill reveals the matching command/configuration.
- Agent setup data remains centralized rather than duplicated in separate markup blocks.

## Implementation notes

The likely implementation target is `apps/landing/src/pages/index.astro` plus any supporting CSS in `apps/landing/src/styles/global.css`. The change should respect the current landing page style and avoid unrelated cleanup.
