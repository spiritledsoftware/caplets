# Checkout Release Runbook

## Release gate

Hold the release if any enabled checkout flag is below 50 percent rollout, if the rollback owner is not assigned, or if the smoke page cannot load the checkout status panel.

Cross-check `docs/release-checklist.md` and `src/release/checklist.ts` before recommending ship or hold.

## Evidence checklist

- Inspect local release risk code before summarizing the decision.
- Check Git history or status to confirm the workspace baseline.
- Use GitHub evidence for public repository or workflow context when the task asks for upstream repository state.
- Use Context7 or DeepWiki before relying on version-sensitive framework behavior.
- Use browser evidence for `web/index.html` tasks.
- Use `docs/architecture.md` when connecting the local source, status page, and release gate.

## Rollback

The rollback owner is the payments-platform team. Disable `checkout.retryBudget.v2`, restore `retryBudget.legacy`, and notify on-call in the release channel.
