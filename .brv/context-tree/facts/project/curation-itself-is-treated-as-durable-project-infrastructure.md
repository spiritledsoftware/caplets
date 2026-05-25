---
confidence: 0.91
sources: [facts/_index.md, docs/_index.md]
synthesized_at: '2026-05-21T23:23:26.222Z'
type: synthesis
title: Curation itself is treated as durable project infrastructure
summary: The knowledge base records curation rules and project facts as first-class runtime knowledge, not chat-only notes.
tags: [curation, runtime, knowledge-base, conventions]
related: [facts/project/curation_context_facts.md, facts/project/curation_input_notes.md]
keywords: [upsert, durable, facts, narrative, verification, knowledge, curation, policy]
createdAt: '2026-05-21T23:23:26.222Z'
updatedAt: '2026-05-21T23:23:26.222Z'
---

# Curation itself is treated as durable project infrastructure

The facts and docs domains both preserve curation/runtime conventions as durable operational knowledge: use UPSERT by default, keep structured rawConcept/narrative content, extract facts explicitly, and verify results before considering curation complete. This means the knowledge base is maintaining its own operating policy alongside product knowledge.

## Evidence

- **facts**: The curation/runtime conventions require UPSERT as the preferred operation, structured `rawConcept` and `narrative` fields, preserving lasting facts and notable outcomes, and verifying success with `result.summary.failed === 0`.
- **docs**: Planning knowledge is organized as durable roadmap material tied to architecture and release pipeline work, showing that project knowledge is curated as a maintained asset rather than ephemeral commentary.
