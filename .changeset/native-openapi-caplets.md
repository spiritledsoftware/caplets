---
"caplets": minor
---

Add native OpenAPI-backed Caplets alongside MCP server backends.

OpenAPI endpoint configs can now expose one generated Caplet tool per API spec, progressively disclose operations as tools, and execute HTTP calls through the existing `call_tool` flow. The implementation includes explicit OpenAPI auth configuration, safe spec loading, guarded request construction, generated schema updates, and documentation for `openapiEndpoints`.
