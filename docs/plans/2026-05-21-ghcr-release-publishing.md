# GHCR Release Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the Caplets Docker image to GitHub Container Registry when the existing Changesets release workflow publishes npm packages.

**Architecture:** Extend `.github/workflows/release.yml` in-place. The release job keeps the current install, verify, and Changesets publish flow, then runs Docker metadata/login/build-push steps only when `changesets/action` reports `published == 'true'` and the published package list includes the `caplets` CLI package. The image is pushed to `ghcr.io/spiritledsoftware/caplets` with `latest`, semantic version, `v`-prefixed semantic version, and short SHA tags.

**Tech Stack:** GitHub Actions, Changesets, Docker Buildx, GHCR, `docker/login-action`, `docker/metadata-action`, `docker/build-push-action`, Node.js 24, pnpm 11.0.9.

---

## File Structure

- Modify: `.github/workflows/release.yml`
  - Add job-scoped `packages: write` permission for GHCR publishing.
  - Add an `id: changesets` to the existing Changesets action step.
  - Add a step to check whether the `caplets` CLI package was published, then read `packages/cli/package.json` version for Docker metadata.
  - Add Docker Buildx, GHCR login, metadata, and build-push steps gated on published releases.
- Verify only: `Dockerfile`
  - Existing source-build image is the image pushed by the workflow.

---

### Task 1: Add GHCR permissions and Changesets output ID

**Files:**

- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Update workflow permissions and Changesets step ID**

In `.github/workflows/release.yml`, change the permissions block from:

```yaml
permissions:
  contents: write
  pull-requests: write
  id-token: write
```

to keep workflow-level permissions unchanged and add job-scoped package publishing permission:

```yaml
permissions:
  contents: write
  pull-requests: write
  id-token: write

jobs:
  release:
    permissions:
      contents: write
      pull-requests: write
      id-token: write
      packages: write
```

Then change the Changesets step from:

```yaml
- name: Create release PR or publish
  uses: changesets/action@v1
```

to:

```yaml
- name: Create release PR or publish
  id: changesets
  uses: changesets/action@v1
```

- [ ] **Step 2: Verify workflow formatting**

Run:

```bash
pnpm format:check .github/workflows/release.yml
```

Expected: command exits `0` and reports all matched files use the correct format.

- [ ] **Step 3: Commit workflow release output plumbing**

Run:

```bash
git add .github/workflows/release.yml
git commit -m "ci: expose release publish result"
```

Expected: commit succeeds and includes only `.github/workflows/release.yml`.

---

### Task 2: Add Docker image metadata and publishing steps

**Files:**

- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Insert Docker publish steps after Changesets**

Immediately after the existing `Create release PR or publish` step, insert:

```yaml
- name: Check whether CLI package was published
  if: steps.changesets.outputs.published == 'true'
  id: cli-package
  env:
    PUBLISHED_PACKAGES: ${{ steps.changesets.outputs.publishedPackages }}
  run: |
    cli_published=$(node <<'NODE'
    const publishedPackages = JSON.parse(process.env.PUBLISHED_PACKAGES || '[]');
    const cliPublished = publishedPackages.some((pkg) => pkg && pkg.name === 'caplets');
    process.stdout.write(cliPublished ? 'true' : 'false');
    NODE
    )
    echo "published=${cli_published}" >> "$GITHUB_OUTPUT"

- name: Read Docker image version
  if: steps.changesets.outputs.published == 'true' && steps.cli-package.outputs.published == 'true'
  id: image-version
  run: echo "version=$(node -p \"require('./packages/cli/package.json').version\")" >> "$GITHUB_OUTPUT"

- name: Setup Docker Buildx
  if: steps.changesets.outputs.published == 'true' && steps.cli-package.outputs.published == 'true'
  uses: docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f

- name: Log in to GitHub Container Registry
  if: steps.changesets.outputs.published == 'true' && steps.cli-package.outputs.published == 'true'
  uses: docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9
  with:
    registry: ghcr.io
    username: ${{ github.actor }}
    password: ${{ secrets.GITHUB_TOKEN }}

- name: Generate Docker metadata
  if: steps.changesets.outputs.published == 'true' && steps.cli-package.outputs.published == 'true'
  id: docker-meta
  uses: docker/metadata-action@c299e40c65443455700f0fdfc63efafe5b349051
  with:
    images: ghcr.io/spiritledsoftware/caplets
    tags: |
      type=raw,value=latest
      type=raw,value=${{ steps.image-version.outputs.version }}
      type=raw,value=v${{ steps.image-version.outputs.version }}
      type=sha,format=short,prefix=sha-

- name: Publish Docker image
  if: steps.changesets.outputs.published == 'true' && steps.cli-package.outputs.published == 'true'
  uses: docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8
  with:
    context: .
    file: ./Dockerfile
    platforms: linux/amd64,linux/arm64
    push: true
    tags: ${{ steps.docker-meta.outputs.tags }}
    labels: ${{ steps.docker-meta.outputs.labels }}
```

- [ ] **Step 2: Verify workflow formatting**

Run:

```bash
pnpm format:check .github/workflows/release.yml
```

Expected: command exits `0` and reports all matched files use the correct format.

- [ ] **Step 3: Commit Docker publishing steps**

Run:

```bash
git add .github/workflows/release.yml
git commit -m "ci: publish docker image on release"
```

Expected: commit succeeds and includes only `.github/workflows/release.yml`.

---

### Task 3: Verify release workflow and Docker image build

**Files:**

- Verify: `.github/workflows/release.yml`
- Verify: `Dockerfile`

- [ ] **Step 1: Run workflow formatting check**

Run:

```bash
pnpm format:check .github/workflows/release.yml
```

Expected: command exits `0` and reports all matched files use the correct format.

- [ ] **Step 2: Check workflow contains required release gates and tags**

Run:

```bash
node <<'NODE'
const fs = require('node:fs');
const workflow = fs.readFileSync('.github/workflows/release.yml', 'utf8');
const required = [
  'packages: write',
  'id: changesets',
  "if: steps.changesets.outputs.published == 'true' && steps.cli-package.outputs.published == 'true'",
  'id: cli-package',
  'uses: docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9',
  'uses: docker/metadata-action@c299e40c65443455700f0fdfc63efafe5b349051',
  'uses: docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8',
  'images: ghcr.io/spiritledsoftware/caplets',
  'type=raw,value=latest',
  'type=raw,value=${{ steps.image-version.outputs.version }}',
  'type=raw,value=v${{ steps.image-version.outputs.version }}',
  'type=sha,format=short,prefix=sha-',
];
const missing = required.filter((entry) => !workflow.includes(entry));
if (missing.length > 0) {
  console.error(`Missing workflow entries:\n${missing.join('\n')}`);
  process.exit(1);
}
NODE
```

Expected: command exits `0` with no missing workflow entries.

- [ ] **Step 3: Verify the Docker image still builds**

Run:

```bash
docker build -t caplets:self-host-test .
```

Expected: command exits `0` and creates image `caplets:self-host-test`.

If Docker is unavailable, record the exact Docker error in task notes and continue; do not claim Docker build verification passed.

- [ ] **Step 4: Run focused repo checks**

Run:

```bash
pnpm verify
```

Expected: command exits `0`.

- [ ] **Step 5: Commit verification fixes if needed**

If verification required fixes, run:

```bash
git add .github/workflows/release.yml
git commit -m "fix: polish docker release publishing"
```

Expected: commit succeeds only if fixes were made. If no fixes were required, do not create an empty commit.

---

## Self-Review

### Spec coverage

- GHCR target image `ghcr.io/spiritledsoftware/caplets`: Task 2.
- Publish only after a real CLI package release: Tasks 1 and 2 gate on both `steps.changesets.outputs.published == 'true'` and `steps.cli-package.outputs.published == 'true'`.
- Use repository-scoped token and no extra long-lived registry secret: Task 2 uses `docker/login-action` pinned to a full commit SHA with `secrets.GITHUB_TOKEN`.
- Add required GitHub Packages permission: Task 1.
- Tags for `latest`, semantic version, `v` semantic version, and short SHA: Task 2 and Task 3.
- Local verification of workflow and Dockerfile: Task 3.

### Placeholder scan

No placeholder markers are present. Every edit step includes exact YAML or exact verification commands.

### Type and name consistency

- Changesets step ID is consistently `changesets`.
- Version step ID is consistently `image-version`.
- Docker metadata step ID is consistently `docker-meta`.
- Image name is consistently `ghcr.io/spiritledsoftware/caplets`.
