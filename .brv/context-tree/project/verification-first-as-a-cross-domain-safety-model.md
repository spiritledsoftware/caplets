---
confidence: 0.97
sources: [architecture/_index.md, docs/_index.md, facts/_index.md, project/_index.md]
synthesized_at: '2026-05-27T23:38:23.761Z'
type: synthesis
title: Verification‑First as a Cross‑Domain Safety Model
summary: All major project areas treat explicit verification as the true completion signal, not just workflow success.
tags: [verification, safety, ci-cd]
related: []
keywords: [verification, compliance, testing, release, curation, workflow, safety, automation, policy, validation]
createdAt: '2026-05-27T23:38:23.761Z'
updatedAt: '2026-05-27T23:38:23.761Z'
---

# Verification‑First as a Cross‑Domain Safety Model

The project enforces a verification‑first policy that spans architecture, documentation, facts, and project workflows, ensuring changes are only considered complete after passing automated verification tests and review outcomes.

## Evidence

- **architecture**: Verification and compliance are listed as a core pillar ("Task 1 Spec Compliance Review").
- **docs**: Release automation and completion pipelines are gated by verified publish state, not merely successful workflow runs.
- **facts**: Curation/runtime conventions require recon → extraction → curate with UPSERT and verification that `result.summary.failed === 0`.
- **project**: The shared safety model explicitly states that verification is the real completion signal across the project.
