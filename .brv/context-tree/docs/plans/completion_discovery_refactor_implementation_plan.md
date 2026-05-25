---
title: Completion Discovery Refactor Implementation Plan
summary: Plan for shared CLI completion metadata, cache-backed discovery, completion config defaults, remote completion routing, and final verification.
tags: []
related: [architecture/remote_control/remote_control_api_shape.md, architecture/remote_control/cli_remote_mode_selection.md, docs/plans/active_caplets_planning_documents.md, docs/plans/completion_local_discovery_and_split_targets.md, docs/plans/context.md, docs/plans/docker_image_publishing_for_release_pipeline.md, docs/plans/pr_71_completion_fix_outcome.md, docs/plans/release-automation-is-gated-by-verified-publish-state-not-just-workflow-success.md]
keywords: []
createdAt: '2026-05-21T17:14:24.407Z'
updatedAt: '2026-05-21T17:14:24.407Z'
---
## Reason
Capture the detailed implementation plan and verification outcome for cache-backed CLI completions

## Raw Concept
**Task:**
Document the completion discovery refactor implementation plan and its final implementation status.

**Changes:**
- Shared CLI command metadata added
- Async cache-backed discovery added for tools, prompts, resources, and resource templates
- Persistent completion cache helpers added
- Platform-native completion cache path helpers added
- completion config defaults added
- Remote complete_cli routed through server-owned discovery
- README docs and changeset updated
- Final verification passed

**Files:**
- packages/core/src/cli/commands.ts
- packages/core/src/cli/completion.ts
- packages/core/src/cli/completion-cache.ts
- packages/core/src/cli/completion-discovery.ts
- packages/core/src/config/paths.ts
- packages/core/src/config.ts
- packages/core/src/engine.ts
- packages/core/src/remote-control/dispatch.ts
- packages/core/test/cli-completion.test.ts
- packages/core/test/cli-completion-cache.test.ts
- packages/core/test/remote-control-dispatch.test.ts
- packages/core/test/cli-remote.test.ts
- packages/core/test/config.test.ts
- README.md
- packages/cli/README.md
- .changeset/cli-completions.md
- schemas/caplets-config.schema.json

**Flow:**
plan -> implement shared metadata -> add config/cache -> wire discovery -> route remote completions -> update docs -> verify

**Timestamp:** 2026-05-21T17:14:04.450Z

**Author:** ByteRover context engineer

## Narrative
### Structure
The plan is organized into nine tasks covering metadata refactor, completion config and paths, persistent cache, discovery orchestration, live cache-backed discovery, MCP resource and prompt contexts, remote server routing, documentation, and final verification.

### Dependencies
The completion discovery layer depends on existing managers such as DownstreamManager, OpenApiManager, GraphQLManager, HttpActionManager, CliToolsManager, and CapletSetManager. It also depends on Commander, Zod, Vitest, and Node filesystem/path APIs.

### Highlights
The refactor preserves secret-free cache entries, uses platform-native cache directories, and ensures remote completions use server-owned state. The implementation status at the end reports that all verification passed.

### Rules
Completion discovery must remain bounded by discovery and overall timeouts. Generated shell scripts suppress completion stderr; run the underlying CLI command directly when debugging completion behavior. Completion never starts interactive login flows.

### Examples
Examples include qualified completions such as caplets call-tool repo.<TAB>, prompt completion via --prompt, and resource template completion via --resource-template.

## Facts
- **completion_refactor_goal**: The goal is to replace duplicated CLI completion command lists with shared metadata and add cache-backed live downstream completions for qualified tools, prompts, resources, and resource templates. [project]
- **completion_refactor_architecture**: The architecture uses a shared command metadata module, a persistent platform-native completion cache, and bounded live discovery through existing managers. [project]
- **completion_config_defaults**: The implementation adds a completion config with discoveryTimeoutMs, overallTimeoutMs, cacheTtlMs, and negativeCacheTtlMs defaults. [project]
- **remote_completion_ownership**: Remote complete_cli is routed through CapletsEngine.completeCliWords so completion discovery uses server-owned config and state. [project]
- **completion_cache_security**: Completion cache entries store only secret-free candidate metadata keyed by backend and config fingerprints. [project]
- **verification_status**: Verification completed successfully with pnpm verify passing, including format, lint, typecheck, schema check, tests, benchmark check, and build. [project]
- **workspace_note**: The working tree note says .brv remained modified from the existing workspace state and was not touched or staged. [project]
