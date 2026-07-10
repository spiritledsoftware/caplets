---
"@caplets/core": minor
"@caplets/pi": patch
---

Unify HTTP-like non-inline results behind explicit local-artifact and remote-reference variants, preserve mixed MCP content blocks, and prevent hosted Adapters from exposing managed filesystem paths.

GraphQL operation results now share the Media pipeline with a 1 MiB inline threshold and a 100 MiB artifact cap. Pi renders local artifact paths and remote artifact references according to the result variant.

Replace `handleServerTool`'s positional manager arguments with a named backend runtime. External `@caplets/core` callers now construct that runtime with `createBackendOperationRuntime`; common backend operations dispatch through its `operations` Interface, while MCP-only resource, prompt, and completion methods remain on `runtime.mcp`.

Make exposure projection the generation-bound callable-surface authority. MCP, Attach, and native adapters now render registration facts and Code Mode identities from the same projection, reject stale callbacks across reloads, discard out-of-order discovery, and keep hidden or unresolved Caplets out of declarations and execution allowlists.

Concentrate Current Host administration behind one typed operations Interface shared by dashboard and Operator bearer adapters. Operator activity now records the real acting Client, exact Access and Operator route roles are enforced, both Client roles can revoke only their own credential, and self-revocation or demotion ends the acting dashboard session. Raw Vault Reveal remains dashboard-only and expires from browser memory.
