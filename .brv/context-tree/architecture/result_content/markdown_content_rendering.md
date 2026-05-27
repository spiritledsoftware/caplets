---
title: Markdown Content Rendering
summary: Guidelines for converting structuredContent to Markdown, handling size thresholds, and preserving full data
tags: []
related: []
keywords: []
createdAt: '2026-05-27T11:35:37.132Z'
updatedAt: '2026-05-27T11:35:37.132Z'
---
## Reason
Document design for rendering structuredContent as Markdown in content field

## Raw Concept
**Task:**
Define rendering strategy for structuredContent to Markdown content

**Changes:**
- Add Markdown projection for small/medium results
- Truncate large results with pointer to structuredContent
- Preserve full structuredContent unchanged

**Files:**
- packages/core/src/result-content.ts

**Flow:**
structuredContent -> renderer -> Markdown content

**Timestamp:** 2026-05-27T11:35:37.129Z

## Narrative
### Structure
Renderer functions produce Markdown sections, bullet rows, and JSON code fences

### Highlights
Improves readability for content-only MCP clients, maintains data integrity

### Rules
Large results must include explicit truncation marker and pointer to structuredContent

### Examples
Example Markdown output with status and body sections

## Facts
- **structuredContent rendering**: Convert `structuredContent` into readable Markdown for `content`, while keeping the original full object in `structuredContent`. [project]
- **result size handling**: For small/medium structured results: include full Markdown-rendered structured content. [project]
- **large result handling**: For large results: include important scalar fields plus truncated JSON sections with a clear marker: `… truncated; full value is available in structuredContent.body`. [project]
- **data integrity**: Preserve full `structuredContent` unchanged. [project]
- **downstream MCP handling**: Keep downstream MCP `content` unchanged when proxying downstream MCP tools, unless Caplets generated the structured result itself or field selection is applied. [project]
- **renderer reuse**: Pi/OpenCode can use the same Markdown renderer for consistency. [project]
- **markdown projection**: Best compatibility with content-only MCP clients. [project]
- **markdown projection**: Much better for LLMs than raw minified JSON. [project]
- **markdown projection**: Avoids reverting fully to noisy pretty-JSON duplication for everything. [project]
- **resultContent**: Add config like `{ "resultContent": { "mode": "markdown", "maxBytes": 12000 } }`. [project]
- **renderer module**: Create a shared renderer in `packages/core/src/result-content.ts` with functions `structuredContentMarkdown(value, options): string` and `structuredContentMarkdownBlocks(value, options): TextContentBlock[]`. [project]
- **renderer behavior**: Renderer should render plain objects as Markdown sections, scalar fields as bullet rows, and nested arrays/objects as fenced JSON blocks. [project]
- **renderer truncation**: Renderer should enforce a max text size and mark truncation explicitly, pointing to `structuredContent.<path>`. [project]
- **default behavior**: Default policy: For Caplets-generated structured results, `content` is Markdown projection of meaningful `structuredContent` and `structuredContent` remains full original data. [project]
- **metadata handling**: Metadata-only discovery responses should stay compact/empty unless discovery must be visible to content-only clients. [project]
- **downstream call_tool handling**: For downstream MCP-backed `call_tool`, preserve downstream `content` as-is and optionally project empty/useless `content` from `structuredContent` into Markdown. [project]
- **test cases**: Add tests to verify small HTTP/OpenAPI/GraphQL/CLI structured results expose body/stdout/etc in Markdown `content` while full data remains in `structuredContent`. [project]
- **test cases**: Add tests to verify large nested bodies truncate with an explicit pointer. [project]
- **plan location**: Implementation plan file should be saved at `docs/plans/2026-05-27-structured-content-markdown-content.md`. [project]
