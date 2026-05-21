#!/usr/bin/env bash
set -euo pipefail

SUBMODULE_PATH=".brv"
SUBMODULE_REMOTE="origin"
COMMIT_MESSAGE="chore: update memory"
PUSH=false
COMMITTED_MEMORY=false

if [[ "${1:-}" == "--push" ]]; then
  PUSH=true
fi

if [[ ! -d "$SUBMODULE_PATH" ]]; then
  exit 0
fi

if ! git -C "$SUBMODULE_PATH" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

git_path() {
  git -C "$SUBMODULE_PATH" rev-parse --git-path "$1"
}

# Do not try to auto-commit while the submodule is in the middle of a manual
# operation. That state needs human resolution.
if [[ -d "$(git_path rebase-merge)" || -d "$(git_path rebase-apply)" || -f "$(git_path MERGE_HEAD)" ]]; then
  echo "Skipping $SUBMODULE_PATH auto-commit: submodule has an in-progress git operation." >&2
  exit 1
fi

if [[ -n "$(git -C "$SUBMODULE_PATH" status --porcelain --untracked-files=all)" ]]; then
  echo "Auto-committing ByteRover memory changes in $SUBMODULE_PATH"
  git -C "$SUBMODULE_PATH" add -A
  git -C "$SUBMODULE_PATH" commit -m "$COMMIT_MESSAGE"
  git add "$SUBMODULE_PATH"
  COMMITTED_MEMORY=true
fi

if [[ "$PUSH" == true ]]; then
  branch="$(git -C "$SUBMODULE_PATH" branch --show-current)"
  if [[ -n "$branch" ]]; then
    # Push any new memory commits before the parent repo publishes a gitlink that
    # points at them.
    git -C "$SUBMODULE_PATH" push "$SUBMODULE_REMOTE" "$branch"
  fi

  if [[ "$COMMITTED_MEMORY" == true ]]; then
    if ! git diff --quiet -- "$SUBMODULE_PATH" || ! git diff --cached --quiet -- "$SUBMODULE_PATH"; then
      git add "$SUBMODULE_PATH"
      git commit --no-verify -m "chore: update byterover memory pointer"
      echo "Committed new $SUBMODULE_PATH gitlink. Re-run git push so the new parent commit is sent." >&2
      exit 1
    fi
  fi
fi
