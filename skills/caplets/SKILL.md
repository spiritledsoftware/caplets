---
name: caplets
description: Always use when the user asks to use a capability that may not appear in your visible toolset, or when accessing configured backend capabilities through Caplets, including APIs, CLIs, resources, prompts, backend operations, capability handles, tool schemas, or compact Code Mode CLI results.
---

# Caplets

## Overview

Use `caplets code-mode <<'EOF'` as the default CLI workflow. Put discovery, schema inspection, tool calls, filtering, and summarization inside one TypeScript run, then return only the compact result the user needs.

Do not turn Caplets work into a long sequence of `caplets search-tools`, `get-tool`, and `call-tool` shell commands unless the user specifically asks for progressive CLI commands. Code Mode is the primary surface.

## Run Contract

Before executing Code Mode, run `caplets code-mode types` to inspect the generated handles and method declarations available in the current config.

When showing a reusable CLI script, use `caplets code-mode --json <<'EOF'` and `return` the compact value from the script. Do not use `console.log(...)` as the main output path; Code Mode returns the final expression/envelope for you.

For unknown Caplets, unknown tools, or non-trivial argument shapes, discover first, describe when arguments matter, then call.

## Default Pattern

```sh
caplets code-mode --json <<'EOF'
const h = caplets.<id>;
const ready = await h.check();
if (!ready.ok) return ready;

const tools = await h.searchTools("<intent>", { limit: 5 });
const detail = await h.describeTool("<tool_name>");
if (!detail.ok) return detail;

const result = await h.callTool("<tool_name>", {
  /* exact args from describeTool */
});
if (!result.ok) return result;

return {
  tools: tools.items.map((tool) => tool.name),
  data: result.data,
};
EOF
```

Keep bulky lists, schemas, and raw payloads inside the script. Return names, IDs, counts, selected fields, and error envelopes that drive the next decision.

## Discover Handles

When you do not know the configured Caplet ID, ask Code Mode first:

```sh
caplets code-mode --json <<'EOF'
return Object.keys(caplets).filter((name) => name !== "debug").sort();
EOF
```

For type hints and exact generated handle names:

```sh
caplets code-mode types
```

## Handle API

Use these methods inside the heredoc:

| Need                          | Code Mode call                               |
| ----------------------------- | -------------------------------------------- |
| Inspect Caplet card           | `await h.inspect()`                          |
| Check backend readiness       | `await h.check()`                            |
| List tools                    | `await h.tools()`                            |
| Search tools                  | `await h.searchTools("query", { limit: 5 })` |
| Describe a tool               | `await h.describeTool("tool_name")`          |
| Call a tool                   | `await h.callTool("tool_name", args)`        |
| List resources                | `await h.resources()`                        |
| Search resources              | `await h.searchResources("query")`           |
| List resource templates       | `await h.resourceTemplates()`                |
| Read resource                 | `await h.readResource(uri)`                  |
| List prompts                  | `await h.prompts()`                          |
| Search prompts                | `await h.searchPrompts("query")`             |
| Get prompt                    | `await h.getPrompt("name", args)`            |
| Complete prompt/resource args | `await h.complete(...)`                      |

Never invent handle IDs, tool names, resource URIs, prompt names, argument names, or result fields. Discover first, describe when arguments matter, then call.

## Output Discipline

Return decision-ready JSON:

```ts
return {
  names: items.map((item) => item.name),
  count: items.length,
  nextCursor: page.nextCursor,
};
```

On failure, return the exact Caplets envelope:

```ts
const result = await h.callTool("<tool_name>", args);
if (!result.ok) return result;
```

Do not paste full schemas, full tool lists, logs, or raw downstream responses into chat unless the user asks for them.

## Files And Long Scripts

Use a heredoc for one-off workflows. Use `--file` when the script is long or should be checked into a repo:

```sh
caplets code-mode --file scripts/caplets-workflow.ts --json
```

`--file` paths are relative to the current directory. One-shot CLI Code Mode runs do not reuse heap state across invocations.

## Common Mistakes

| Mistake                                                     | Fix                                                                                                |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Running many progressive CLI commands for a multi-step task | Put discovery, call, and summarization inside one `caplets code-mode` heredoc.                     |
| Calling a guessed tool                                      | `searchTools`, then `describeTool`, then `callTool`.                                               |
| Using `console.log` for the answer                          | `return` the compact object; use `--json` on the CLI when structure matters.                       |
| Returning raw payloads                                      | Project the fields the user needs inside the script.                                               |
| Using direct network or filesystem APIs inside Code Mode    | Use Caplet handles; direct I/O is intentionally unavailable.                                       |
| Confusing CLI and Code Mode names                           | Shell commands are kebab-case; inside Code Mode use methods like `searchTools()` and `callTool()`. |

## References

- `references/troubleshooting.md` for missing Caplets, config paths, MCP registration, auth, and stdio startup checks.
