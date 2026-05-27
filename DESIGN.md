---
name: Caplets
description: Capability cards for coding agents, precise progressive disclosure for sprawling tool stacks.
colors:
  ember: "#E0582F"
  parchment: "#F6E8C8"
  charred-ink: "#1F2018"
  linen: "#FBF7EC"
  paper: "#FFF8EA"
  ash: "#E3D8C0"
  muted-olive: "#686B4E"
  danger: "#B33A2E"
  success: "#3F7A52"
typography:
  display:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "2rem"
    fontWeight: 650
    lineHeight: 1.08
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 650
    lineHeight: 1.15
    letterSpacing: "-0.025em"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "1rem"
    fontWeight: 620
    lineHeight: 1.3
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 450
    lineHeight: 1.55
    letterSpacing: "normal"
  label:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "0.035em"
rounded:
  xs: "4px"
  sm: "6px"
  md: "10px"
  lg: "14px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "18px"
  xl: "28px"
components:
  button-primary:
    backgroundColor: "{colors.charred-ink}"
    textColor: "{colors.parchment}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
  button-primary-hover:
    backgroundColor: "{colors.ember}"
    textColor: "{colors.paper}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
  button-secondary:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.charred-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
  chip-neutral:
    backgroundColor: "{colors.parchment}"
    textColor: "{colors.charred-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.lg}"
    padding: "5px 9px"
  capability-card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.charred-ink}"
    rounded: "{rounded.lg}"
    padding: "18px"
---

# Design System: Caplets

## 1. Overview

**Creative North Star: "The Tool Cartographer"**

Caplets is a map for agent capability space. The interface should make many backends feel legible without flattening their differences. It uses warm technical surfaces, compact labels, and restrained ember accents to help users orient, inspect, and act.

The system is product-first: precise, calm, capable. It should feel like an expert tool that has already sorted the sprawl into useful regions. Avoid theatrical intelligence. Avoid visual fog. Every surface should answer one of three questions: what capability is this, what can I inspect next, and what is safe to call.

The physical scene is a developer reviewing an agent setup at a desk during focused work, with docs, terminal output, and a browser open side by side. The theme stays light and warm because this surface is read for long stretches, compared with documentation, and used during configuration rather than incident response.

**Key Characteristics:**

- Warm light surfaces with ink-like text and a rare ember accent.
- Tonal layering instead of decorative shadows.
- Compact product typography with monospace reserved for labels, tool names, command fragments, and schema snippets.
- Capability cards that feel like map regions and audited records, not marketing cards.
- State-rich interactions with visible focus, non-color-only status cues, and reduced-motion-safe transitions.

## 2. Colors

The palette is charred ink, parchment, and ember: warm enough to avoid default developer grayscale, restrained enough to preserve product trust.

### Primary

- **Ember Signal**: The primary accent from existing README badges. Use it for primary action emphasis, selected states, important status markers, and the smallest wayfinding details. It must stay rare.
- **Charred Ink**: The main text and high-emphasis control color. Use it instead of pure black so dense UI stays warm and less brittle.

### Secondary

- **Muted Olive**: A quiet secondary cue for metadata, inactive map regions, and neutral categorization. Use it when ember would imply action or urgency.

### Tertiary

- **Parchment Surface**: The brand-tinted neutral used for chips, badges, secondary panels, and documentation-adjacent blocks.

### Neutral

- **Linen Field**: The main application background, a tinted neutral for long reading and configuration work.
- **Paper Panel**: The raised tonal surface for cards, inputs, popovers, and focused content blocks.
- **Ash Rule**: The border and divider color. Use it as a quiet structural line, never as decoration.

### Named Rules

**The Rare Ember Rule.** Ember is a signal, not atmosphere. Keep it below 10% of any product surface; if everything glows orange, nothing is selected.

**The No Pure Extremes Rule.** Never use pure black or pure white. All neutrals must carry a warm tint so product screens remain readable and owned by Caplets.

## 3. Typography

**Display Font:** Inter, with system sans fallbacks  
**Body Font:** Inter, with system sans fallbacks  
**Label/Mono Font:** System monospace stack

**Character:** The type system is practical and exact. Sans-serif carries the product surface; monospace appears only where the content is machine-facing: tool names, command snippets, schema keys, capability IDs, and compact labels.

### Hierarchy

- **Display** (650, 2rem, 1.08): Page titles, onboarding headings, and major empty-state statements. Use sparingly.
- **Headline** (650, 1.5rem, 1.15): Section introductions and major panel headings.
- **Title** (620, 1rem, 1.3): Card titles, form groups, toolbar headings, and table group labels.
- **Body** (450, 0.9375rem, 1.55): Explanatory text, descriptions, and documentation-adjacent prose. Cap prose at 65 to 75 characters per line.
- **Label** (600, 0.75rem, 0.035em): Buttons, chips, capability IDs, state labels, and terse navigation labels.

### Named Rules

**The Machine-Text Rule.** Monospace is reserved for things a user might copy, inspect, or route through an agent. Never use monospace as a vibe.

**The Compact Confidence Rule.** Product text should be smaller and denser than a marketing page, but never cramped. If a line needs more than two clauses, rewrite it.

## 4. Elevation

Caplets uses tonal layering, not ambient shadow. Depth is conveyed through background shifts, thin ash borders, spacing, and state changes. Shadows are reserved for overlays that must float above the map, such as command palettes, popovers, and focused disclosure panels.

### Named Rules

**The Flat Map Rule.** Surfaces are flat at rest. A capability card earns attention through hierarchy, content, and state, not a drop shadow.

**The Border As Structure Rule.** Borders separate scan regions and focus areas. They are never colored side stripes, and they never become decoration.

## 5. Components

### Buttons

- **Shape:** Tactile and calm, with a medium curve (10px radius).
- **Primary:** Charred ink background with parchment text, compact monospace label, and 10px 14px padding. Ember appears on hover or selected action states, not as the default fill everywhere.
- **Hover / Focus:** Use 150 to 200 ms color and transform transitions with an ease-out curve. Focus uses a visible ember outline plus offset, never color alone.
- **Secondary / Ghost:** Paper or transparent backgrounds with ash borders. Use secondary buttons for inspection and navigation actions.

### Chips

- **Style:** Parchment background, charred ink text, compact monospace label, and a 14px pill radius.
- **State:** Selected chips may use ember text or a charred ink fill. Disabled chips must lower contrast through tone and include text or icon state, not color alone.

### Cards / Containers

- **Corner Style:** Calm rounded panels (14px radius) for capability cards and content blocks.
- **Background:** Paper panels on a linen field. Parchment panels are reserved for secondary context, examples, and metadata blocks.
- **Shadow Strategy:** No shadow at rest. Use tonal separation and ash borders.
- **Border:** One-pixel ash border. Side-stripe borders are prohibited.
- **Internal Padding:** Use 18px for standard cards, 28px for explanatory panels, and 12px for dense inspection rows.

### Inputs / Fields

- **Style:** Paper background, ash border, charred ink text, 10px radius, and body typography.
- **Focus:** Ember outline with 2px offset and a subtle paper-to-linen tonal shift.
- **Error / Disabled:** Errors use danger plus text labels. Disabled fields use parchment surface, muted olive text, and no pointer affordance.

### Navigation

- **Style:** Compact labels with clear active state, using charred ink for current location and muted olive for inactive items. Top-level nav should feel like map wayfinding, not a marketing navbar.
- **Hover / Active:** Hover may shift text to charred ink and add a parchment background. Active states combine tone, text weight, and an accessible label or icon.
- **Mobile Treatment:** Collapse navigation structurally into grouped sections or a command palette. Do not hide core actions behind decorative menus.

### Capability Card

A capability card is the signature component. It should lead with the capability name, a compact type or backend chip, and a concise description. Disclosure actions such as `search_tools`, `list_tools`, and `get_tool` should appear as ordered next steps. The card should feel like a region on a map: bounded, labeled, and easy to inspect.

## 6. Do's and Don'ts

### Do:

- **Do** use ember as a rare signal for selected states, primary actions, and important status markers.
- **Do** keep capability cards flat at rest with paper surfaces, ash borders, and precise content hierarchy.
- **Do** reserve monospace for tool names, command fragments, schemas, operation names, and IDs.
- **Do** make every state accessible through text, icon, shape, or focus treatment in addition to color.
- **Do** write compact UI copy that helps the next decision: inspect, search, list, call, configure, or fix.

### Don't:

- **Don't** use generic SaaS cream: beige landing pages, vague AI productivity promises, identical rounded card grids, hero metrics, or decorative gradients.
- **Don't** use neon devtool dark: hacker-dashboard cosplay, glowing terminal aesthetics, saturated cyber palettes, or default dark-mode theatrics.
- **Don't** use raw configuration documentation as the interface. Config details are inspectable, not the whole product surface.
- **Don't** use colored side-stripe borders on cards, callouts, alerts, or list items. Use full borders, background tone, icons, or labels instead.
- **Don't** use gradient text, decorative glassmorphism, bounce motion, or orchestrated page-load choreography.
