---
title: Why Giant MCP Tool Walls Don’t Scale
description: "MCP made it easy to connect agents to tools. Caplets tackles the next scaling problem: keeping agents effective when those tools become a wall of hundreds of operations."
date: 2026-07-01
canonicalPath: /blog/why-giant-mcp-tool-walls-dont-scale/
tags:
  - MCP
  - agents
  - benchmarks
  - Code Mode
---

MCP made it easy to give coding agents tools.
That created the next problem: once every server exposes every operation up front, the agent starts each task staring at a giant tool wall.

Caplets exists because tool access is not the same thing as usable capability.
A coding agent should be able to start with a focused capability, inspect only what matters, call the exact backend operation it needs, and return compact evidence without carrying the whole backend universe in its prompt.

## The tool wall problem

Flat MCP aggregation works well while the tool count is small.
It starts to break down when useful servers expose broad surfaces with generic names like `get`, `search`, and `list_recent_changes`.
The model has to reason over too much surface too early, schemas compete with the user's task for context, and multi-step discovery often turns into repeated model/tool round trips.

Caplets changes that initial shape.
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

Progressive discovery is useful because it hides downstream operations until the agent asks for them.
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
Caplets focuses on the next layer: making connected tools usable by coding agents without turning the prompt into a giant tool wall.

Give your agent capabilities, not giant tool walls.
