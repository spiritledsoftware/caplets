---
title: Why Most MCP Clients Suck
description: "Large MCP servers are not the problem. GitHub, Slack, Linear, and Cloudflare should expose everything. The broken part is clients that make the model babysit that whole surface one raw call at a time."
date: 2026-07-01
tags:
  - MCP
  - agents
  - benchmarks
  - Code Mode
---

Everyone keeps complaining about large MCP servers.

GitHub exposes too much.
Slack exposes too much.
Linear exposes too much.
Cloudflare exposes too much.

Honestly?

Bring it on.

I want GitHub's MCP server to expose every issue, PR, workflow run, code search result, discussion, release, branch protection rule, permission, audit event, and weird corner of the API.

I want Slack to expose the whole workspace.
I want Linear to expose the whole product system.
I want Cloudflare to expose the whole platform.

That is the point.

MCP servers should be rich. They should be complete. They should expose the real surface area of the service instead of some tiny toy subset that only works in a demo.

The bloat is not the enemy.

The client is the broken part.

Most MCP clients take a huge server and flatten it straight into the model loop.

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

MCP is good. The protocol is not the villain here.

The mistake is treating the model like it should personally inspect every tool, every response, every follow-up decision, and every noisy intermediate payload.

It should not.

The server should be rich.
The client should be smart.
The model should only see what matters.

That is Caplets.

## Stop shrinking the server

The common reaction to MCP bloat is to make the server smaller.

Expose fewer tools.
Hide parts of the API.
Handcraft a tiny happy-path surface.
Pretend the real product is simpler than it is.

I think that is backwards.

If the service is large, the MCP server should be large too.

GitHub is not small. Cloudflare is not small. Stripe is not small. Linear is not small. Any useful internal platform at a real company is not small.

The agent needs access to the actual surface area eventually.

The problem is not that a server has 200 tools.

The problem is that most clients act like the only two options are:

1. dump all 200 tools into the model's face, or
2. remove most of the capability.

That is a false choice.

You do not fix a rich capability surface by amputating it.

You fix it by giving the agent a better way to move through it.

Search the capability.
Inspect the specific operation.
Call what matters.
Batch the boring middle steps.
Filter the raw backend exhaust.
Return compact evidence.

That is the missing layer.

## The broken loop

Flat MCP aggregation looks fine in demos.

The toy server has a few tools. The names are clean. The responses are small. The happy path works.

Then you point it at a real backend.

Now the agent has broad surfaces, generic operation names, nested schemas, pagination, noisy records, partial failures, and follow-up calls that only make sense after the first result comes back.

The bad client loop looks like this:

1. The model scans a giant initial tool list.
2. It guesses which generic operation belongs to the task.
3. The client sends raw output back into the conversation.
4. The model reads the raw output and decides the next call.
5. The client sends another raw payload back.
6. Repeat until the answer is somewhere in the context window.

That is not capability.

That is remote-controlling an API with a language model.

And it gets worse as the server gets better.

The more complete the server is, the more the naive client punishes you for using it.

That is insane.

A good MCP server should be allowed to be huge. The client should make that hugeness navigable.

The model should not need to see every field in every candidate object just to answer a focused question. It should not need to burn tokens reading intermediate junk that a tiny bit of local logic could have filtered away.

The model should see the evidence.

It does not need to watch the plumbing.

## Caplets is the client-side moat

Caplets is not a plea for smaller MCP servers.

It is the opposite.

Caplets assumes MCP servers are going to be big, messy, useful, and full of stuff.

Good.

The job is to make that surface agent-usable.

Instead of handing the model one giant flattened tool wall, Caplets gives the agent named capability handles. The agent can inspect a capability, search its operations, describe the schema it actually needs, call the operation, join follow-up calls, filter noisy data, and return a decision-ready result.

That changes the shape of the interaction.

The agent is no longer asking the model to babysit every backend call.

It can do the boring middle work near the tools and bring back the answer with the evidence that supports it.

This is the moat.

Not “we made MCP smaller.”

More like: “we made large MCP servers usable without dumping the whole thing into model context.”

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

Not “hide the tools.”

More like: “let the server expose everything, then give the agent a sane way to work with it.”

## What the benchmark actually says

The deterministic benchmark in this repo compares direct flat MCP exposure with Caplets capability exposure over local mock MCP metadata.

It is deliberately boring. No external APIs. No network. No model credentials. No vibes.

In that fixture, Caplets shows:

- 80.5% fewer model/tool round trips in the Code Mode workflow fixture versus equivalent progressive-disclosure sequences, with required evidence fields preserved.
- 96.7% fewer initially visible tools: 215 direct flat tools became 7 Caplets top-level handles.
- 79.9% lower initial serialized tool payload.
- 12,633 fewer approximate initial context tokens.
- 0 top-level duplicate tool-name collisions, compared with repeated direct collisions for generic names such as `get` and `search`.

The important word is “visible.”

Caplets is not saying the downstream capability should disappear.

Those 215 operations can still exist. The server can still be broad. The backend can still expose the real product.

The difference is that the first thing the model sees is not a giant wall of every operation and every schema.

It sees a smaller set of capability handles and can progressively discover what it needs.

The bigger win is workflow shape: batch the investigation, filter before the model sees it, and return compact evidence instead of raw backend exhaust.

These are deterministic context-surface and workflow-shape claims. They are not a promise that every model, every server, and every task gets faster in every environment.

Real MCP servers vary in schema quality, latency, operation count, and error behavior. Live benchmarks are useful, but they are model-dependent and should be treated like local result artifacts, not universal product claims.

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

A capability layer should help the agent get work done. It should not ask the model to survive the blast radius of a rich MCP server.

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

Now let MCP servers be big.

Let them expose everything.

Bring on the giant GitHub server. Bring on the giant Cloudflare server. Bring on the internal platform with 600 weird operations nobody remembers until they need one.

That is not the problem.

The next fight is smarter clients: clients that let agents search, batch, filter, and return evidence without making the model babysit every API call.

Give your agent capabilities, not a junk drawer with schemas.
