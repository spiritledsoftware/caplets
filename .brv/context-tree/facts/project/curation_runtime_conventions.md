---
title: Curation Runtime Conventions
summary: Runtime conventions for using the RLM curation workflow, including recon-first processing, single-pass handling for small contexts, and verification through applied file paths.
tags: []
related: []
keywords: []
createdAt: '2026-05-20T14:56:37.757Z'
updatedAt: '2026-05-21T09:55:42.936Z'
---
## Reason
Curate the runtime conventions and curation workflow from the provided RLM context.

## Raw Concept
**Task:**
Document the RLM curation runtime conventions and workflow rules for this session

**Changes:**
- Use precomputed recon results when available
- Proceed directly to extraction for single-pass contexts
- Verify curated outputs through applied file paths
- Defined immediate execution behavior for operations
- Established UPSERT as the preferred default curation action
- Captured RLM workflow guidance for variable-based curation prompts
- Recorded single-pass recon handling for small contexts
- Use the precomputed recon result instead of calling recon again
- Proceed directly to extraction in single-pass mode
- Use groupBySubject and dedup to organize extracted facts
- Verify curated outputs through result.applied[].filePath
- Established the single-pass path when recon recommends it
- Documented the required timeout for mapExtract-based extraction
- Captured the verification rule using result.applied[].filePath
- Prefer single-pass processing for compact contexts
- Verify curation via applied file paths

**Flow:**
recon -> extract -> curate -> verify

**Timestamp:** 2026-05-21T09:55:37.086Z

**Author:** ByteRover context engineering workflow

## Narrative
### Structure
This context defines the operational workflow for curating compact RLM inputs and emphasizes immediate execution without confirmation.

### Dependencies
Depends on precomputed recon metadata, task ID scoping, and the curate tool result object for verification.

### Highlights
Single-pass mode is recommended for small contexts, and verification should rely on result.applied[].filePath rather than file rereads.

### Rules
Do NOT print raw context. Do NOT call tools.curation.recon when recon is already precomputed. For chunked extraction, pass taskId as a bare variable. Any code_exec call containing mapExtract MUST use timeout: 300000 on the code_exec tool call itself.

## Facts
- **curation_context_line**: The following is a conversation between a user and an AI assistant. [other]
- **curation_context_line**: Curate only information with lasting value: facts, decisions, technical details, preferences, or notable outcomes. [other]
- **curation_context_line**: Skip trivial messages such as greetings, acknowledgments ("ok", "thanks", "sure", "got it"), one-word replies, anything with no substantive content. [other]
- **curation_context_line**: Conversation: [other]
- **curation_context_line**: --- [other]
- **curation_context_line**: [user]: Implement the plan @docs/plans/2026-05-21-docker-self-hosting.md entirely. Implement inline, no worktree or subagents required [other]
- **curation_context_line**: [assistant]: I'm using the executing-plans skill to implement this plan. [other]
- **curation_context_line**: [assistant]: Implemented the Docker self-hosting plan inline. [other]
- **curation_context_line**: Changed files: [other]
- **curation_context_line**: - `.dockerignore` [other]
- **curation_context_line**: - `Dockerfile` [other]
- **curation_context_line**: - `docker-compose.yml` [other]
- **curation_context_line**: - `README.md` [other]
- **curation_context_line**: Commits created: [other]
- **curation_context_line**: - `35de342 build: add docker ignore rules` [other]
- **curation_context_line**: - `10cf86a build: add caplets docker image` [other]
- **curation_context_line**: - `2d62990 build: add docker compose service` [other]
- **curation_context_line**: - `a4be4f8 docs: document docker self-hosting` [other]
- **curation_context_line**: - `9f6fc07 fix: polish docker self-hosting setup` [other]
- **curation_context_line**: Verification run: [other]
