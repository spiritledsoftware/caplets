# GHCR Release Publishing Design

## Goal

Publish the source-build Caplets Docker image to GitHub Container Registry as part of the existing Changesets release pipeline, only when a real package release is published.

## Current release flow

The existing `.github/workflows/release.yml` workflow runs on pushes to `main` and manual dispatch. It installs dependencies, runs `pnpm verify`, then uses `changesets/action@v1` to either create/update the version PR or publish npm packages with `pnpm release`.

## Design

Use the existing release job and add GHCR publishing steps after the Changesets action. The Docker image publish steps are gated on both `steps.changesets.outputs.published == 'true'` and `steps.cli-package.outputs.published == 'true'`, so they do not run while the workflow is merely creating or updating a version PR or when only non-CLI packages are published.

The release job will grant `packages: write`, log in to `ghcr.io` using `GITHUB_TOKEN`, register QEMU for multi-platform builds, generate image metadata, and push the existing root `Dockerfile` image to:

- `ghcr.io/spiritledsoftware/caplets:latest`
- `ghcr.io/spiritledsoftware/caplets:v<package-version>`
- `ghcr.io/spiritledsoftware/caplets:<package-version>`
- `ghcr.io/spiritledsoftware/caplets:sha-<short-sha>`

The package version is read from `packages/cli/package.json` after Changesets has published, because the Docker image represents the CLI service runtime.

## Security and permissions

The workflow uses the repository-scoped `GITHUB_TOKEN` and GitHub Actions package permissions. No new long-lived registry token is required. The release job adds only `packages: write`; existing `contents`, `pull-requests`, and `id-token` permissions remain unchanged.

## Validation

Validation should cover YAML formatting, workflow syntax sanity, QEMU/Buildx setup ordering, and Docker metadata behavior where practical. Full GHCR push verification can only happen in GitHub Actions on a release publish. Local verification should include `pnpm format:check .github/workflows/release.yml` and a Docker build of the existing image.
