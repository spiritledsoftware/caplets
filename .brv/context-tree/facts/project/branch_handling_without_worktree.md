---
title: Branch Handling Without Worktree
summary: The user switched branches and wants subsequent work to proceed without using a worktree.
tags: []
related: []
keywords: []
createdAt: '2026-05-27T09:46:08.810Z'
updatedAt: '2026-05-27T09:46:08.810Z'
---
## Reason
Capture the user instruction about operating on the switched branch directly

## Raw Concept
**Task:**
Record the branch state and execution preference for future operations

**Changes:**
- Switched branch
- Continue without a worktree

**Flow:**
branch switched -> continue operations directly on the branch

**Timestamp:** 2026-05-27T09:45:53.888Z

**Author:** user

## Narrative
### Structure
A short operational instruction that affects how future work should be performed in the repository.

### Highlights
Indicates the active branch has changed and work should proceed without worktree isolation.

## Facts
- **branch_state**: The user switched the branch [project]
- **worktree_usage**: Proceed without a worktree [project]
