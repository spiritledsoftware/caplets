---
title: MCP Capability Discovery and Use
summary: MCP-native resource, prompt, and completion operations are exposed only for MCP-backed Caplets; non-MCP backends remain tool-only and unsupported capabilities return structured errors.
tags: []
related: [architecture/remote_control/remote_control_api_shape.md, architecture/remote_control/caplets_remote_control_module.md, docs/plans/active_caplets_planning_documents.md, architecture/remote_control/working_module.md, architecture/remote_control/context.md]
keywords: []
createdAt: '2026-05-21T12:32:53.461Z'
updatedAt: '2026-05-21T12:34:13.344Z'
---
## Reason
Document the design choice that MCP-specific operations should only be exposed for MCP-backed Caplets, with backend-specific generated schemas.

## Raw Concept
**Task:**
Document capability exposure rules for Caplets across MCP and non-MCP backends.

**Changes:**
- Expand Caplets beyond tool-only MCP indexing
- Add resources, prompts, templates, and completions to the capability model
- Keep progressive disclosure by preserving one top-level Caplet tool
- Separated MCP-native operations from tool-only backends
- Established per-backend generated schema behavior
- Defined unsupported capability handling for downstream MCP servers

**Flow:**
backend type detected -> schema generated for that backend -> MCP backends expose native operations -> non-MCP backends remain tool-only -> unsupported downstream capability returns structured error

**Timestamp:** 2026-05-21T12:33:58.234Z

**Author:** assistant

**Patterns:**
- `UNSUPPORTED_CAPABILITY` - Structured error code returned when a downstream MCP capability is unavailable

## Narrative
### Structure
This topic records the backend-specific Caplets schema design, distinguishing MCP-native surfaces from tool-only surfaces.

### Dependencies
Depends on backend detection during schema generation and on downstream MCP capability advertisement at connection time.

### Highlights
The design prevents non-MCP agents from seeing unsupported resource and prompt actions while preserving MCP ergonomics where capabilities exist.

### Rules
Caplets exposes MCP-native resource/prompt/completion operations only for MCP-backed Caplets. Native OpenAPI, GraphQL, HTTP, and CLI Caplets remain action/tool surfaces and do not advertise unsupported MCP-specific operations in their generated schemas.

### Examples
Example: an OpenAPI-backed Caplet should expose get_tool and call_tool, but not read_resource or list_prompts.

## Facts
- **non_mcp_backends_supported_operations**: Non-MCP backends should not advertise resource, prompt, or completion operations. [project]
- **mcp_backed_caplet_operations**: MCP-backed Caplets may expose list_resources, search_resources, list_resource_templates, read_resource, list_prompts, search_prompts, get_prompt, and complete. [project]
- **schema_generation_strategy**: The generated input schema should be produced per Caplet/backend instead of using one universal schema for every Caplet. [project]
- **backend_surface_policy**: OpenAPI, GraphQL, HTTP, and CLI backends should expose tools only. [project]
- **caplet_set_surface_policy**: Caplet set backends should expose the child Caplets’ generated tool surface and only forward MCP operations when the child is MCP-backed and forwarding is explicitly chosen. [project]
- **unsupported_capability_handling**: If a downstream MCP server does not advertise a capability, the operation should return a structured UNSUPPORTED_CAPABILITY response. [project]
