---
"@caplets/core": minor
"@caplets/pi": patch
---

Unify HTTP-like non-inline results behind explicit local-artifact and remote-reference variants, preserve mixed MCP content blocks, and prevent hosted Adapters from exposing managed filesystem paths.

GraphQL operation results now share the Media pipeline with a 1 MiB inline threshold and a 100 MiB artifact cap. Pi renders local artifact paths and remote artifact references according to the result variant.

Replace `handleServerTool`'s positional manager arguments with a named backend runtime. External `@caplets/core` callers now construct that runtime with `createBackendOperationRuntime`; common backend operations dispatch through its `operations` Interface, while MCP-only resource, prompt, and completion methods remain on `runtime.mcp`.
