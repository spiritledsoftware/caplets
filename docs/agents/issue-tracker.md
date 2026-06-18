# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues in `spiritledsoftware/caplets`. Use the `gh` CLI for all issue operations.

## Conventions

- **Create an issue**: `gh issue create --repo spiritledsoftware/caplets --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --repo spiritledsoftware/caplets --comments`, filtering comments by `jq` and also fetching labels when needed.
- **List issues**: `gh issue list --repo spiritledsoftware/caplets --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --repo spiritledsoftware/caplets --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --repo spiritledsoftware/caplets --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --repo spiritledsoftware/caplets --comment "..."`

`gh` can infer the repo from the current clone, but commands in skills should include `--repo spiritledsoftware/caplets` when practical so worktree location does not change the target repository.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `spiritledsoftware/caplets`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --repo spiritledsoftware/caplets --comments`.
