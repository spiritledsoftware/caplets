---
title: Why Most MCP Clients Suck
description: "MCP is a good protocol. Most clients still make the model play air-traffic controller: pick tools one at a time, read raw output, ask again, and drag every intermediate result back into chat."
date: 2026-07-01
tags:
  - MCP
  - agents
  - benchmarks
  - Code Mode
---

The problem is not MCP.
MCP made it easy to connect agents to tools, and that part is good.
The problem is what most clients do next: they make the model orchestrate everything in public.

Pick a tool.
Read the schema.
Call it.
Get back a blob.
Read the blob.
Pick another tool.
Call it.
Get another blob.
Now ask the model to remember which pieces mattered.

That sucks.
Not because tools are bad.
Because the client is forcing the model to do backend orchestration through a chat transcript.

Most clients turn MCP into a junk drawer: `get`, `search`, `list`, `create`, `delete`, repeated across every backend, with raw responses dumped back into the conversation after every step.
The visible tool wall is part of the problem, but it is not the whole problem.
The deeper failure is that the agent has to shuttle every intermediate decision and every noisy payload through the most expensive part of the system: the model context.

Caplets exists because usable capability is not “show the model every tool.”
A useful capability should let the agent batch the investigation, execute the boring middle steps close to the tools, filter the output before it hits the model, and return compact evidence instead of a transcript full of plumbing.

## The real problem is the loop

Flat MCP aggregation feels fine in demos because the tool count is small and the response shapes are clean.
It starts falling apart when real servers show up with broad surfaces, generic names, pagination, nested records, noisy fields, and follow-up calls.

The bad loop looks like this:

1. The model scans a giant list of tools.
2. It guesses which generic operation belongs to the job.
3. The client sends the raw response back into chat.
4. The model reads the response, decides what to do next, and asks for another call.
5. The process repeats until enough context has been burned to answer the original question.

That is not capability.
That is an agent manually driving an API client through a keyhole.

Caplets changes the loop.
Instead of flattening every downstream operation into the first tool list, each backend becomes a named capability handle.
The agent can inspect the capability, search its operations, describe the schema it actually needs, call the operation, filter the result, join follow-up calls, and summarize the answer inside one bounded workflow.
The model sees the decision-ready result, not every irrelevant field the backend happened to return.

## What the deterministic benchmark shows

The deterministic benchmark in this repo compares direct flat MCP exposure with Caplets capability exposure over local mock MCP metadata.
It is intentionally reproducible: it does not call external APIs, depend on network access, or require model credentials.

In that fixture, Caplets shows:

- 80.5% fewer model/tool round trips in the Code Mode workflow fixture versus equivalent progressive-disclosure sequences, with required evidence fields preserved.
- 96.7% fewer initially visible tools: 215 direct flat tools became 7 Caplets top-level handles.
- 79.9% lower initial serialized tool payload.
- 12,633 fewer approximate initial context tokens.
- 0 top-level duplicate tool-name collisions, compared with repeated direct collisions for generic names such as `get` and `search`.

The win is not just fewer tools.
Surface reduction helps, but the bigger point is workflow shape: batch the investigation, keep bulky exploration out of the model loop, and filter noisy backend output down to the evidence the answer actually needs.

These are deterministic context-surface and workflow-shape claims, not a universal live model win-rate claim.
Real MCP servers vary in schema quality, latency, operation count, and error behavior.
Live benchmark runs are useful for product direction, but they are model-dependent and belong in local result artifacts rather than deterministic product claims.

## Why Code Mode is the wedge

Progressive discovery helps because it stops spraying every downstream operation into the initial prompt.
Code Mode goes further: it lets the agent do discovery, inspection, execution, filtering, joining, and synthesis inside one bounded TypeScript workflow.

That matters because many backend tasks are not one tool call.
They are small investigations: find the right operation, inspect the schema, fetch candidate records, preserve evidence fields, filter noise, and return a decision-ready answer.
Code Mode keeps bulky exploration inside the script and returns only the compact result the user needs.

That is the difference between an MCP client that merely exposes tools and a capability layer that helps the agent get work done.

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
It measures initial tool surface, serialized payload size, approximate context-token proxy, duplicate-name pressure, preserved evidence fields, and deterministic workflow shape.
It does not pretend to prove that every model, server, or task is faster in every environment.

## The claim

MCP made tool connection easy.
The next fight is making those tools usable without forcing the model to babysit every API call and sift every raw payload.

Give your agent capabilities, not a junk drawer with schemas.
