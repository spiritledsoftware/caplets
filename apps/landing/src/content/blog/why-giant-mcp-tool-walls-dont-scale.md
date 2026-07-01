---
title: Why Most MCP Clients Suck
description: "MCP is a good protocol. Most clients still dump every tool into the model up front, then act surprised when the agent gets slower, noisier, and easier to confuse."
date: 2026-07-01
tags:
  - MCP
  - agents
  - benchmarks
  - Code Mode
---

The problem is not MCP.
MCP made it easy to connect agents to tools, and that part is good.
The problem is what most clients do next: they take every operation from every server, flatten it into one giant menu, shove the whole thing into the model, and call that “capabilities.”

That sucks.
Not because tools are bad.
Because a wall of tools is not a capability.
It is a junk drawer with schemas.

Most clients turn it into a junk drawer: `get`, `search`, `list`, `create`, `delete`, repeated across every backend, all visible before the agent knows what it needs.
The model burns context just reading the menu, guesses which generic verb belongs to which service, then burns more turns recovering from the wrong first choice.

Caplets exists because tool access and usable capability are different things.
A coding agent should start with a focused capability, inspect only what matters, call the exact backend operation it needs, and return compact evidence without dragging the whole backend universe into the prompt.

## The tool wall problem

Flat MCP aggregation feels fine in demos because the tool count is small.
It starts falling apart when real servers show up with broad surfaces and generic names like `get`, `search`, and `list_recent_changes`.
Now the model has to reason over too much surface too early, schemas compete with the user’s task for context, and multi-step discovery turns into repeated model/tool round trips.

Caplets changes the starting shape.
Instead of flattening every downstream operation into the first tool list, each backend becomes a named capability handle.
The agent can inspect the capability, search its operations, describe the schema it actually needs, call the operation, filter the result, and summarize the answer in one bounded workflow.

## What the deterministic benchmark shows

The deterministic benchmark in this repo compares direct flat MCP exposure with Caplets capability exposure over local mock MCP metadata.
It is intentionally reproducible: it does not call external APIs, depend on network access, or require model credentials.

In that fixture, Caplets shows:

- 96.7% fewer initially visible tools: 215 direct flat tools became 7 Caplets top-level handles.
- 79.9% lower initial serialized tool payload.
- 12,633 fewer approximate initial context tokens.
- 0 top-level duplicate tool-name collisions, compared with repeated direct collisions for generic names such as `get` and `search`.

The Code Mode workflow fixture also showed 80.5% fewer model/tool round trips versus equivalent progressive-disclosure sequences, with required evidence fields preserved.

These are deterministic context-surface and workflow-shape claims, not a universal live model win-rate claim.
Real MCP servers vary in schema quality, latency, operation count, and error behavior.
Live benchmark runs are useful for product direction, but they are model-dependent and belong in local result artifacts rather than deterministic product claims.

## Why Code Mode is the wedge

Progressive discovery helps because it stops spraying every downstream operation into the initial prompt.
Code Mode goes further: it lets the agent do discovery, inspection, execution, filtering, joining, and synthesis inside one bounded TypeScript workflow.

That matters because many backend tasks are not one tool call.
They are small investigations: find the right operation, inspect the schema, fetch candidate records, preserve evidence fields, filter noise, and return a decision-ready answer.
Code Mode keeps bulky exploration inside the script and returns only the compact result the user needs.

## Try it

Install Caplets and wire it into your agent:

```sh
npm install -g caplets
caplets setup
```

Then install a no-auth example Caplet:

```sh
caplets install spiritledsoftware/caplets osv
```

Ask your coding agent to use Caplets Code Mode to query OSV for a package version and return compact JSON.
A successful run should use the visible `caplets__code_mode` tool and inspect a handle such as `caplets.osv`.

## Reproduce the benchmark

The committed benchmark report is in `docs/benchmarks/coding-agent.md`.
To regenerate it locally from the repository, run:

```sh
pnpm benchmark
```

The benchmark is useful precisely because it is narrow.
It measures the initial tool surface, serialized payload size, approximate context-token proxy, duplicate-name pressure, and deterministic workflow shape.
It does not pretend to prove that every model, server, or task is faster in every environment.

## The claim

MCP made tool connection easy.
The next fight is making those tools usable without turning every agent session into a schema landfill.

Give your agent capabilities, not giant tool walls.
