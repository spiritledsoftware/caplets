---
title: Markdown Rendering Design
summary: Design rules for converting JSON results into hierarchical Markdown with headings, arrays handling, and size limits
tags: []
related: []
keywords: []
createdAt: '2026-05-27T11:38:52.107Z'
updatedAt: '2026-05-27T11:38:52.107Z'
---
## Reason
Capture design decisions and conventions for structural Markdown rendering of Caplets results

## Raw Concept
**Task:**
Document structural Markdown rendering design for Caplets results

**Flow:**
Define rendering rules and conventions

**Timestamp:** 2026-05-27T11:38:52.105Z

## Narrative
### Structure
Rendering rules for titles, headings, arrays, deep fallback, size limits

### Highlights
The conversion should be a JSON structure where H1 is the title of the result, top-level keys are H2, and nested keys use sequential headings when feasible. The user wants a structural Markdown rendering, not a prose summary. Revised design direction JSON: { "status": 200, "statusText": "OK", "body": { "vulns": [] } } Use an H1 as the result title in Markdown. Potential title sources, in order: Caplets metadata (e.g., '# OSV Vulnerabilities query_purl', '# HTTP action ping'), then generic fallback '# Result'. Each top-level object key becomes a second-level heading (## key). Nested object keys become progressively deeper headings when feasible, capped at heading level ######. Arrays of scalars are rendered as bullet lists under a heading. Arrays of objects are rendered with headings using label candidates such as id, name, title, summary, key, or tool. If no good label exists for array items, use index headings like '#### Item 1'. When nesting gets too deep or output too large, render that subtree as fenced JSON under its heading. Enforce a maximum content size; when truncated, include a notice indicating truncation and where the full value can be found. `structuredContent` remains unchanged and complete, preserving full structured data. Implementation plan should replace compact label previews with this structural Markdown renderer for Caplets-generated structured results, including HTTP actions, OpenAPI actions, GraphQL actions, CLI tools, field-selected results, Pi/OpenCode agent content, and possibly generated JSON wrapper results. Generated structured results include HTTP actions, OpenAPI actions, GraphQL actions, CLI tools, field-selected results, Pi/OpenCode agent content, and possibly generated JSON wrapper results where useful. It should preserve downstream MCP content unless Caplets must synthesize content from downstream structuredContent. Does this revised structural Markdown direction look right?

## Facts
- **conversion_design**: The conversion should be a JSON structure where H1 is the title of the result, top-level keys are H2, and nested keys use sequential headings when feasible. [preference]
- **user_intent**: The user wants a structural Markdown rendering, not a prose summary. [other]
- **revised_design**: Revised design direction JSON: { "status": 200, "statusText": "OK", "body": { "vulns": [] } } [project]
- **title**: Use an H1 as the result title in Markdown. [convention]
- **title_sources**: Potential title sources, in order: Caplets metadata (e.g., '# OSV Vulnerabilities query_purl', '# HTTP action ping'), then generic fallback '# Result'. [convention]
- **top_level_keys**: Each top-level object key becomes a second-level heading (## key). [convention]
- **nested_keys**: Nested object keys become progressively deeper headings when feasible, capped at heading level ######. [convention]
- **arrays_scalars**: Arrays of scalars are rendered as bullet lists under a heading. [convention]
- **arrays_objects**: Arrays of objects are rendered with headings using label candidates such as id, name, title, summary, key, or tool. [convention]
- **index_headings**: If no good label exists for array items, use index headings like '#### Item 1'. [convention]
- **deep_fallback**: When nesting gets too deep or output too large, render that subtree as fenced JSON under its heading. [convention]
- **size_limits**: Enforce a maximum content size; when truncated, include a notice indicating truncation and where the full value can be found. [convention]
- **structured_content**: `structuredContent` remains unchanged and complete, preserving full structured data. [other]
- **plan_scope**: Implementation plan should replace compact label previews with this structural Markdown renderer for Caplets-generated structured results, including HTTP actions, OpenAPI actions, GraphQL actions, CLI tools, field-selected results, Pi/OpenCode agent content, and possibly generated JSON wrapper results. [project]
- **structured_results**: Generated structured results include HTTP actions, OpenAPI actions, GraphQL actions, CLI tools, field-selected results, Pi/OpenCode agent content, and possibly generated JSON wrapper results where useful. [project]
- **preserve_mcp_content**: It should preserve downstream MCP content unless Caplets must synthesize content from downstream structuredContent. [project]
- **revised_structural_markdown_direction**: Does this revised structural Markdown direction look right? [other]
