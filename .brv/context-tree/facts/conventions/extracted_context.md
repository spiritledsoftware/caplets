---
title: extracted_context
summary: Extracted factual statements from provided context
tags: []
related: []
keywords: []
createdAt: '2026-05-27T11:31:02.665Z'
updatedAt: '2026-05-27T11:31:02.665Z'
---
## Reason
Curate extracted facts from RLM extraction

## Raw Concept
**Task:**
Curate extracted factual statements from provided context

**Flow:**
Extract -> Dedup -> Group -> Curate

**Timestamp:** 2026-05-27T11:31:02.662Z

## Narrative
### Structure
Facts organized by subject

### Highlights
MCP client, structuredContent, content, Pi/OpenCode integration, MCP server, MCP content generation

## Facts
- **MCP client**: For pure MCP clients, the full body is in the MCP response as `structuredContent`, but not necessarily in `content[0].text`.
- **structuredContent**: `structuredContent` contains the full parsed response body, including status, headers, and body JSON.
- **content**: `content` provides a human‑readable compact preview, e.g., "status 200; OK; body {\"vulns\":[...truncated...]}".
- **MCP client**: MCP clients that pass `structuredContent` to the model see the full body.
- **MCP client**: MCP clients that only pass `content` text to the model see only the compact/truncated preview, not the full body.
- **Pi/OpenCode integration**: Pi/OpenCode native integrations are now fixed to prefer `structuredContent`, so agents see the full body there.
- **MCP server**: The pure MCP server path already returns full structured data; the remaining risk is client‑side behavior.
- **MCP content generation**: To support content‑only MCP clients robustly, core MCP `content` generation would need to include full JSON or a `fullTextContent` mode, which would increase output noise.
