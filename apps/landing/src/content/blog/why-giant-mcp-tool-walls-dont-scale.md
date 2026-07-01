---
title: Why Most MCP Clients Suck
description: "MCP is not the problem. The problem is clients that make the model babysit API calls one at a time, drag raw blobs into context, and call that an agent workflow."
date: 2026-07-01
tags:
  - MCP
  - agents
  - benchmarks
  - Code Mode
---

Give your agent capabilities, not giant tool walls.

That is the whole pitch.

MCP is good. The protocol is not the villain here.

It solved a real problem: give agents a standard way to reach tools. That part matters. I am glad it exists.

But most MCP clients take that good idea and make the model do the dumbest possible version of the work.

They turn every task into this loop:

Pick a tool.
Read the schema.
Call it.
Get a blob back.
Read the blob.
Pick another tool.
Call it.
Get another blob.
Try to remember which three fields mattered from the last six calls.

That is not an agent workflow.
That is making the model manually drive an API client through a chat window.

And yes, the giant tool wall is annoying. Nobody wants to dump 200 tools into the first prompt and ask the model to squint at a pile of `get`, `search`, `list`, `create`, and `delete` operations.

But the tool wall is only the obvious symptom.

The deeper problem is the loop.

Most clients keep forcing every intermediate step through the most expensive part of the system: model context. Every schema read, every candidate record, every noisy response, every follow-up decision gets dragged back into chat.

That is the part that really sucks.

Caplets exists because I do not think “show the model every tool and every response” is the end state for agent capabilities.

The better shape is simple:

- batch the investigation
- run the boring middle steps close to the tools
- filter the output before it hits the model
- return compact evidence instead of a transcript full of plumbing

Fewer visible tools helps. But if all you do is hide the tool list and still make the model babysit every backend call, you did not fix the workflow. You just moved the clutter.

## The broken loop

Flat MCP aggregation looks fine in demos.

The toy server has a few tools. The names are clean. The responses are small. The happy path works.

Then you point it at real backends.

Now the agent has broad surfaces, generic operation names, nested schemas, pagination, noisy records, partial failures, and follow-up calls that only make sense after the first result comes back.

The common loop looks like this:

1. The model scans a giant initial tool list.
2. It guesses which generic operation belongs to the task.
3. The client sends raw output back into the conversation.
4. The model reads the raw output and decides the next call.
5. The client sends another raw payload back.
6. Repeat until the answer is somewhere in the context window.

That is not capability.

That is remote-controlling an API with a language model.

The model should not need to see every field in every candidate object just to answer a focused question. It should not need to burn tokens reading intermediate junk that a tiny bit of local logic could have filtered away.

This is why Caplets is built around capability handles instead of one giant flattened tool list.

The agent can inspect a capability, search for the right operation, describe the schema it actually needs, call the operation, join follow-up calls, filter noisy data, and return a decision-ready result.

The key difference is not cosmetic.

The model sees the evidence.
It does not have to watch the plumbing.

## Batching is the point

The thing I keep coming back to is that most useful backend tasks are not one call.

They are small investigations.

Find the right operation. Inspect the shape. Fetch candidates. Throw away irrelevant records. Preserve the fields that matter. Maybe make a follow-up call. Then come back with the answer and the evidence.

A normal MCP client tends to spread that whole investigation across the chat transcript.

Caplets Code Mode lets the agent do it as one bounded workflow.

Inside Code Mode, the agent can write a compact TypeScript script that discovers, filters, joins, and summarizes before returning anything to the model. The final output can be small JSON with the exact facts needed for the decision.

That changes the cost profile.

Instead of paying model-context rent for every intermediate object, you keep bulky exploration inside the workflow and only bring back the useful part.

That is the wedge.

Not “we made the tool list prettier.”

More like: “we stopped making the model narrate every database/API/browser step back to itself.”

## What the benchmark actually says

The deterministic benchmark in this repo compares direct flat MCP exposure with Caplets capability exposure over local mock MCP metadata.

It is deliberately boring. No external APIs. No network. No model credentials. No vibes.

In that fixture, Caplets shows:

- 80.5% fewer model/tool round trips in the Code Mode workflow fixture versus equivalent progressive-disclosure sequences, with required evidence fields preserved.
- 96.7% fewer initially visible tools: 215 direct flat tools became 7 Caplets top-level handles.
- 79.9% lower initial serialized tool payload.
- 12,633 fewer approximate initial context tokens.
- 0 top-level duplicate tool-name collisions, compared with repeated direct collisions for generic names such as `get` and `search`.

The headline is not just “fewer tools.”

Fewer tools are nice. They make the first prompt less chaotic. They reduce name collisions. They make discovery less ridiculous.

But the more important claim is workflow shape: batch the investigation, filter before the model sees it, and return compact evidence instead of raw backend exhaust.

These are deterministic context-surface and workflow-shape claims. They are not a promise that every model, every server, and every task gets faster in every environment.

Real MCP servers are messy. Schema quality varies. Latency varies. Error behavior varies. Live benchmarks are useful, but they are model-dependent and should be treated like local result artifacts, not universal product claims.

## Why Code Mode matters

Progressive discovery is a good start because it stops spraying every downstream operation into the initial prompt.

Code Mode is where it gets interesting.

It gives the agent a place to do the middle of the job without dumping every intermediate result into chat.

That middle is where a lot of agent work actually lives:

- discover the right operation
- inspect the schema
- fetch candidate records
- keep the evidence fields
- drop the noise
- join follow-up calls
- return the smallest useful answer

That is not glamorous. It is plumbing.

But good plumbing is the difference between an agent that feels sharp and an agent that feels like it is reading logs out loud.

A capability layer should help the agent get work done. It should not just expose tools and hope the model survives the blast radius.

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

The benchmark is narrow on purpose.

It measures initial tool surface, serialized payload size, approximate context-token proxy, duplicate-name pressure, preserved evidence fields, and deterministic workflow shape.

It does not pretend to prove that every model, server, or task is faster in every environment.

## The claim

MCP made tool connection easy.

The next fight is making those tools usable without forcing the model to babysit API calls and sift raw payloads all day.

Give your agent capabilities, not a junk drawer with schemas.
