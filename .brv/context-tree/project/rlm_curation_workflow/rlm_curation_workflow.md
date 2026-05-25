---
title: RLM Curation Workflow
summary: RLM curation workflow uses recon-first analysis, single-pass extraction for small contexts, optional chunked mapExtract for larger contexts, UPSERT-based curation, and verification through applied file paths and result summaries.
tags: []
related: [facts/conventions/context.md]
keywords: []
createdAt: '2026-05-22T10:24:48.339Z'
updatedAt: '2026-05-22T10:45:13.936Z'
---
## Reason
Document the RLM curation approach, runtime constraints, and verification rules from the current context.

## Raw Concept
**Task:**
Curate the RLM curation workflow and runtime guidance.

**Changes:**
- Use precomputed recon output to select single-pass mode
- Proceed directly to extraction when single-pass is suggested
- Verify curation through applied file paths and summary status
- Reinforced single-pass handling when recon suggests single-pass mode
- Captured the requirement to avoid printing raw context
- Captured extraction and verification requirements for curation runs
- Captured the agreed completion behavior for call-tool, get-tool, and get-prompt
- Recorded that call-tool completions distinguish backend IDs from tool names based on prefix
- Recorded that failures and timeouts must degrade to safe fallbacks without surfacing errors
- Followed the RLM workflow without recomputing recon
- Applied single-pass curation for a small context
- Captured verification requirements and execution constraints
- Use precomputed recon results and proceed directly to extraction when suggestedMode is single-pass
- Use mapExtract only for chunked extraction when needed
- Use dedup and groupBySubject to organize extracted facts
- Verify curation via result.applied[].filePath without readFile
- Defined the single-pass path after recon.
- Captured the timeout requirement for mapExtract calls.
- Captured verification guidance using applied file paths.
- Use precomputed recon when available and proceed directly to extraction for single-pass contexts
- Use mapExtract only for chunked extraction when suggested by recon
- Verify curation via result.applied[].filePath instead of readFile
- Opened PR #74 for fix/cli-completions.
- Used main as the base branch.
- Confirmed verification succeeded via the push hook.
- Left unrelated local dirty files untouched.
- Captured recon-first workflow guidance for curation.
- Recorded single-pass and chunked extraction decision rules.
- Preserved verification and timeout requirements for mapExtract usage.

**Files:**
- caplets/github-cli/CAPLET.md
- caplets/repo-cli/CAPLET.md
- caplets/context7.md
- .brv
- .opencode/opencode.json

**Flow:**
recon -> choose single-pass or chunked extraction -> dedup/group facts -> curate -> verify applied file paths

**Timestamp:** 2026-05-22T10:45:06.051Z

**Author:** ByteRover context engineer

## Narrative
### Structure
This knowledge describes how to curate context using the RLM workflow, including when to skip chunking, how to extract facts, and how to validate results after curation.

### Dependencies
Depends on recon output, the curate tool, and optional mapExtract for larger contexts.

### Highlights
The context emphasizes a single-pass path for compact inputs and requires explicit verification from curate results rather than rereading files.

### Rules
IMPORTANT: Do NOT print raw context. Do NOT call tools.curation.recon — it has been pre-computed. Proceed directly to extraction. For chunked extraction use tools.curation.mapExtract(). Pass taskId as a bare variable, not a string. Any code_exec call containing mapExtract MUST use timeout: 300000 on the code_exec tool call itself (not inside mapExtract options). Verify via result.applied[].filePath — do NOT call readFile for verification.

### Examples
Opened PR: https://github.com/spiritledsoftware/caplets/pull/74

## Facts
- **curation_mode**: Single-pass mode should be used when recon suggests single-pass. [convention]
- **mapextract_taskid**: When using mapExtract in curation, the taskId must be passed as a bare variable. [convention]
- **mapextract_timeout**: Any code_exec call containing mapExtract must use timeout: 300000 on the code_exec tool call itself. [convention]
- **verification_method**: Verification should use result.applied[].filePath and should not call readFile for verification. [convention]

---

title: RLM Curation Workflow
summary: RLM curation workflow for small contexts and runtime conventions: recon-first, single-pass when suggested, use mapExtract for chunked contexts, dedup/groupBySubject, and verify via applied file paths or curate result status.
tags: []
related: [project/rlm_curation_workflow/context.md, facts/conventions/task_7_remote_mutation_routing_review.md, facts/project/rlm_curation_workflow.md]
keywords: []
createdAt: '2026-05-21T16:05:21.915Z'
updatedAt: '2026-05-21T17:56:16.143Z'

---

## Cross-References
- project/rlm_curation_workflow/context.md
- facts/conventions/task_7_remote_mutation_routing_review.md
- facts/project/rlm_curation_workflow.md
