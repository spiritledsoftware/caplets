# Plan 008: Trigger Site Deploys for Shared-Package Changes

> Status: TODO
> Planned against: `ac12a174`
> Finding: #8 — deploy path filters omit shared package dependencies
> Priority: P1
> Effort: S
> Fix risk: LOW

## Why this matters

The catalog app imports `@caplets/core/catalog`, and other public apps share workspace packages. The Deploy and PR Preview workflows trigger on app/infra files but not `packages/**`. A shared package can change a deployed site without starting either a production deploy or preview, leaving the public artifact stale after CI passes.

## Scope

### In scope

- `.github/workflows/deploy.yml`
- `.github/workflows/pr-preview-deploy.yml`
- Path-filtered release/deploy workflow entries only when they build the same public apps
- Existing workflow/document validation commands

### Out of scope

- Changing Alchemy resources, domains, or secrets
- Deploying on every repository change
- Release-package publishing triggers
- New workflow actions or third-party path-filter dependencies

## Current state

`.github/workflows/deploy.yml:4-15` includes:

```yaml
paths:
  - .github/workflows/deploy.yml
  - alchemy.run.ts
  - apps/**
  - infra/**
  - package.json
  - pnpm-lock.yaml
  - pnpm-workspace.yaml
  - scripts/alchemy*.ts
```

`pr-preview-deploy.yml` has the analogous list. Neither includes `packages/**`, although `apps/catalog/package.json` declares `"@caplets/core": "workspace:*"` and its source imports `@caplets/core/catalog`.

## Required design

Add `packages/**` to every push/pull-request path filter that builds one or more public apps through `alchemy.run.ts`. Keep filters explicit; do not replace them with an unbounded trigger.

Also include `turbo.json` and the root TypeScript/build configuration files only if the workflow's build command consumes them and they are currently omitted. Derive that list from `alchemy.run.ts`, package scripts, and the workflow command—not from guesswork.

## Implementation steps

### 1. Inventory affected workflow filters

Read all workflow triggers and identify jobs that call `pnpm alchemy:*`, build `apps/catalog`, `apps/docs`, or `apps/landing`, or publish their preview URLs. Produce a short PR-description table with workflow, event, and missing dependency path.

Do not change `ci.yml`; it already runs on all pull requests/pushes.

### 2. Update production and preview filters

Add the same shared dependency paths in deterministic order to:

- `.github/workflows/deploy.yml`
- `.github/workflows/pr-preview-deploy.yml`

If `.github/workflows/release.yml` only publishes packages/Docker artifacts and is already unfiltered, leave it unchanged. If another deployment workflow has an equivalent app filter, update it in the same patch.

Run:

```sh
pnpm format:check
pnpm lint
```

Expected: exit 0.

### 3. Verify with representative changed paths

Use GitHub's workflow trigger view or a draft PR containing a harmless plan-only commit touching a representative `packages/core` file. Confirm:

- Deploy/preview workflow is selected for the event;
- app-only changes still trigger;
- unrelated docs/plans changes do not start deployment unless already intended.

Do not merge a synthetic source change solely for this check. Record the observed workflow URL in the PR description.

No changeset is required; this changes automation only.

## Done criteria

- A change under `packages/core/**` starts every workflow that builds a public app consuming `@caplets/core`.
- Production and preview filters stay aligned.
- Existing app/infra/root-manifest triggers remain.
- Unrelated repository changes remain filtered out.
- `pnpm format:check` and `pnpm lint` exit 0.
- A real PR event demonstrates the preview/deploy workflow is selected for a shared-package change.

## Escape hatches

- If GitHub does not schedule deploy workflows for a test PR because repository/environment policy blocks forks, verify with a same-repository branch and report the limitation; do not weaken secret protections.
- If a shared package is provably build-time-only for non-deployed packages, still prefer `packages/**` over a fragile hand-maintained package allowlist unless measured deployment cost is unacceptable.
- If `alchemy.run.ts` dynamically discovers additional workspace apps, include their shared dependency root in the same filter update.

## Maintenance note

Path filters are a dependency graph encoded by hand. Any new deployed app or workspace dependency must update production and preview filters together; reviewers should compare them side by side.
