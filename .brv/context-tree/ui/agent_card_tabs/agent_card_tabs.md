---
title: Agent Card Tabs
summary: Design for turning agent pills into configurable tabs with commands and settings
tags: []
related: []
keywords: []
createdAt: '2026-05-27T23:18:59.168Z'
updatedAt: '2026-05-27T23:18:59.168Z'
---
## Reason
Document design decision for agent pills as tabs

## Raw Concept
**Task:**
Design UI where each agent pill acts as a tab showing configuration/commands

**Changes:**
- Agent pills become tab triggers
- Detail area shows install command, config snippet, usage note
- Data modeled per agent for extensibility
- Tests added for tab functionality

**Flow:**
User selects pill -> UI swaps detail area to show agent-specific info

**Timestamp:** 2026-05-27T23:18:59.161Z

## Narrative
### Structure
Agents card layout unchanged; pills act as tabs triggering detail pane

### Highlights
Preserves existing layout, adds configurability, supports future agents

### Examples
Click on "Agent A" pill to view its install command and config snippet

## Facts
- **card and agent pills**: I want it to be the card as it currently is, but each agent's pill is a tab showing the configuration/commands.
- **agents card layout**: Keep the agents card layout exactly as-is structurally.
- **agent pill behavior**: Treat each existing agent pill as a tab trigger.
- **pill interaction**: Selecting a pill swaps the detail area below/near the pills to show that agent’s install command, configuration snippet, and short usage note if needed.
- **active pill appearance**: The active pill should be visually distinct but still look like the existing pill style, not a new heavy tab component.
- **data modeling**: Data should be modeled per agent so future agents can add setup content without changing rendering logic.
- **test cases**: Tests should verify tab labels render, default selected agent content appears, and switching pills reveals the matching commands/configuration.
