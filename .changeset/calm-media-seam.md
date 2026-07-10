---
"@caplets/core": minor
"@caplets/pi": patch
---

Unify HTTP-like non-inline results behind explicit local-artifact and remote-reference variants, preserve mixed MCP content blocks, and prevent hosted Adapters from exposing managed filesystem paths.

GraphQL operation results now share the Media pipeline with a 1 MiB inline threshold and a 100 MiB artifact cap. Pi renders local artifact paths and remote artifact references according to the result variant.
