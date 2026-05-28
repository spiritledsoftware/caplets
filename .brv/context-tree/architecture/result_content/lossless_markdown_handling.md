---
title: Lossless Markdown Handling
summary: Result content renders full markdown losslessly; UI preview collapses with ctrl+O (full details below)
tags: []
related: []
keywords: []
createdAt: '2026-05-27T13:46:25.141Z'
updatedAt: '2026-05-27T13:46:25.141Z'
consolidated_at: '2026-05-27T23:37:51.482Z'
consolidated_from: [{date: '2026-05-27T23:37:51.482Z', path: architecture/result_content/lossless_markdown_handling.abstract.md, reason: 'These files cover the same topic – lossless markdown handling – with the markdown file providing the full description, the abstract giving a one‑sentence summary, and the overview offering a bullet‑point overview. Merging creates a single authoritative file that includes the detailed content plus the concise abstract and overview sections.'}, {date: '2026-05-27T23:37:51.483Z', path: architecture/result_content/lossless_markdown_handling.overview.md, reason: 'These files cover the same topic – lossless markdown handling – with the markdown file providing the full description, the abstract giving a one‑sentence summary, and the overview offering a bullet‑point overview. Merging creates a single authoritative file that includes the detailed content plus the concise abstract and overview sections.'}]
---
## Reason
Curate extracted facts from RLM extraction

## Raw Concept
**Task:**
Document lossless markdown result content handling

**Flow:**
Render result content without truncation, UI handles preview

**Timestamp:** 2026-05-27T13:46:25.138Z

## Narrative
### Structure
Result content module retains full markdown; Pi UI shows collapsed preview with ctrl+O to expand

### Dependencies
Pi UI component, result‑content renderer

### Highlights
Lossless markdown preserved, UI preview hint added

{{abstract_summary}}
{{overview_summary}}

### Examples
Collapsed view shows "..." and hint, expanded shows full markdown
