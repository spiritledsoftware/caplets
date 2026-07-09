import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStagingTag,
  deriveChangesetManifest,
  discoverWorkspacePackageManifests,
  expandPublicReleaseClosure,
  listPublicPublishablePackages,
  patchSnapshotConfig,
  refreshSnapshotManifestVersions,
  writePatchedSnapshotConfig,
} from "../../../scripts/dev-snapshot-release.mjs";

const repoRoot = resolve(import.meta.dirname, "../../..");
const tempPaths: string[] = [];

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function writeWorkspacePackage(root: string, directory: string, manifest: Record<string, unknown>) {
  const packageDirectory = join(root, "packages", directory);
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(join(packageDirectory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function createWorkspaceFixture(
  packages: Array<{ directory: string; manifest: Record<string, unknown> }>,
) {
  const root = mkdtempSync(join(tmpdir(), "caplets-dev-snapshot-workspace-"));
  tempPaths.push(root);
  for (const entry of packages) {
    writeWorkspacePackage(root, entry.directory, entry.manifest);
  }
  return root;
}

function gitFixtureEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8" })
    .trim()
    .split("\n")) {
    delete env[name];
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  return env;
}

function workflowJob(workflow: string, jobName: string) {
  const start = workflow.indexOf(`  ${jobName}:\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const remainder = workflow.slice(start + 1);
  const nextJob = remainder.search(/\n  [a-z_][a-z0-9_]*:\n/);
  return nextJob === -1 ? remainder : remainder.slice(0, nextJob);
}

function workflowStep(job: string, stepName: string) {
  const start = job.indexOf(`      - name: ${stepName}\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const remainder = job.slice(start);
  const nextStep = remainder.indexOf("\n      - name: ", 1);
  return nextStep === -1 ? remainder : remainder.slice(0, nextStep);
}
function workflowJobContaining(workflow: string, content: string) {
  const jobNames = [...workflow.matchAll(/^  ([a-z_][a-z0-9_-]*):$/gm)].map((match) => match[1]!);
  const matchingJobs = jobNames
    .map((jobName) => workflowJob(workflow, jobName))
    .filter((job) => job.includes(content));
  expect(matchingJobs).toHaveLength(1);
  return matchingJobs[0]!;
}

describe("dev snapshot release helpers", () => {
  it("filters public workspace packages and expands their dependent release closure", () => {
    const root = createWorkspaceFixture([
      {
        directory: "core",
        manifest: {
          name: "@fixture/core",
          version: "1.0.0",
          publishConfig: { access: "public" },
        },
      },
      {
        directory: "cli",
        manifest: {
          name: "fixture-cli",
          version: "1.0.0",
          publishConfig: { access: "public" },
          dependencies: { "@fixture/core": "workspace:^" },
        },
      },
      {
        directory: "peer-host",
        manifest: {
          name: "@fixture/peer-host",
          version: "1.0.0",
          publishConfig: { access: "public" },
          peerDependencies: { "@fixture/core": "workspace:*" },
        },
      },
      {
        directory: "private-dependent",
        manifest: {
          name: "@fixture/private-dependent",
          version: "1.0.0",
          private: true,
          publishConfig: { access: "public" },
          dependencies: { "@fixture/core": "workspace:^" },
        },
      },
      {
        directory: "restricted",
        manifest: { name: "@fixture/restricted", version: "1.0.0" },
      },
    ]);

    expect(
      listPublicPublishablePackages(root)
        .map((entry) => entry.name)
        .sort(),
    ).toEqual(["@fixture/core", "@fixture/peer-host", "fixture-cli"]);
    expect(
      expandPublicReleaseClosure(["@fixture/core"], discoverWorkspacePackageManifests(root)),
    ).toEqual(["@fixture/core", "@fixture/peer-host", "fixture-cli"]);
  });

  it("derives a CLI bootstrap manifest from a synthetic public dependency closure", () => {
    const root = createWorkspaceFixture([
      {
        directory: "core",
        manifest: {
          name: "@caplets/core",
          version: "1.0.0",
          publishConfig: { access: "public" },
        },
      },
      {
        directory: "cli",
        manifest: {
          name: "caplets",
          version: "1.0.0",
          publishConfig: { access: "public" },
          dependencies: { "@caplets/core": "workspace:^" },
        },
      },
      {
        directory: "native-host",
        manifest: {
          name: "@fixture/native-host",
          version: "1.0.0",
          publishConfig: { access: "public" },
          peerDependencies: { "@caplets/core": "workspace:*" },
        },
      },
    ]);

    const manifest = deriveChangesetManifest(
      {
        releases: [
          {
            name: "@caplets/core",
            type: "minor",
            oldVersion: "1.0.0",
            newVersion: "1.1.0",
            changesets: ["core-feature"],
          },
        ],
      },
      { repoRoot: root },
    );

    expect(manifest).toMatchObject({
      hasPublicReleases: true,
      validation: {
        kind: "cli-bootstrap",
        packages: ["@caplets/core", "@fixture/native-host", "caplets"],
      },
    });
    expect(manifest.releases.map((entry) => entry.name)).toEqual([
      "@caplets/core",
      "@fixture/native-host",
      "caplets",
    ]);
    expect(manifest.releases.find((entry) => entry.name === "@caplets/core")).toMatchObject({
      newVersion: "1.1.0",
      direct: true,
    });
    expect(manifest.releases.find((entry) => entry.name === "caplets")).toMatchObject({
      newVersion: "1.0.0",
      direct: false,
    });
  });

  it("seeds core for a caplets-only release and snapshots the complete public line", () => {
    const root = createWorkspaceFixture([
      {
        directory: "core",
        manifest: {
          name: "@caplets/core",
          version: "1.0.0",
          publishConfig: { access: "public" },
        },
      },
      {
        directory: "cli",
        manifest: {
          name: "caplets",
          version: "1.0.0",
          publishConfig: { access: "public" },
          dependencies: { "@caplets/core": "workspace:^" },
        },
      },
      {
        directory: "pi",
        manifest: {
          name: "@caplets/pi",
          version: "1.0.0",
          publishConfig: { access: "public" },
          dependencies: { "@caplets/core": "workspace:^" },
        },
      },
      {
        directory: "opencode",
        manifest: {
          name: "@caplets/opencode",
          version: "1.0.0",
          publishConfig: { access: "public" },
          dependencies: { "@caplets/core": "workspace:^" },
        },
      },
    ]);

    const manifest = deriveChangesetManifest(
      {
        releases: [
          {
            name: "caplets",
            type: "patch",
            oldVersion: "1.0.0",
            newVersion: "1.0.1",
            changesets: ["cli-only"],
          },
        ],
      },
      { repoRoot: root },
    );

    expect(manifest.releases.map((entry) => entry.name)).toEqual([
      "@caplets/core",
      "@caplets/opencode",
      "@caplets/pi",
      "caplets",
    ]);
    expect(manifest.validation).toEqual({
      kind: "cli-bootstrap",
      packages: ["@caplets/core", "@caplets/opencode", "@caplets/pi", "caplets"],
    });
  });

  it("gives closure-only packages the snapshot suffix produced for direct releases", () => {
    const root = createWorkspaceFixture([
      {
        directory: "core",
        manifest: {
          name: "@fixture/core",
          version: "1.1.0-dev-abc123-20260708120000",
          publishConfig: { access: "public" },
        },
      },
      {
        directory: "closure-only",
        manifest: {
          name: "@fixture/closure-only",
          version: "1.0.0",
          publishConfig: { access: "public" },
          dependencies: { "@fixture/core": "workspace:^" },
        },
      },
    ]);

    const snapshotManifest = deriveChangesetManifest(
      {
        releases: [
          {
            name: "@fixture/core",
            type: "minor",
            oldVersion: "1.0.0",
            newVersion: "1.1.0",
            changesets: ["core-snapshot"],
          },
        ],
      },
      { repoRoot: root },
    );
    const refreshed = refreshSnapshotManifestVersions(snapshotManifest, root);

    expect(
      Object.fromEntries(refreshed.releases.map((release) => [release.name, release.newVersion])),
    ).toEqual({
      "@fixture/core": "1.1.0-dev-abc123-20260708120000",
      "@fixture/closure-only": "1.0.0-dev-abc123-20260708120000",
    });
  });

  it("returns no public releases when status contains only unknown workspaces", () => {
    const root = createWorkspaceFixture([
      {
        directory: "public",
        manifest: {
          name: "@fixture/public",
          version: "1.0.0",
          publishConfig: { access: "public" },
        },
      },
    ]);

    const manifest = deriveChangesetManifest(
      {
        releases: [
          {
            name: "@fixture/unknown",
            type: "patch",
            oldVersion: "0.1.0",
            newVersion: "0.1.1",
            changesets: ["unrelated"],
          },
        ],
      },
      { repoRoot: root },
    );

    expect(manifest.hasPublicReleases).toBe(false);
    expect(manifest.releases).toEqual([]);
  });

  it("creates a run-scoped staging tag", () => {
    expect(createStagingTag("123-4")).toBe("dev-staged-123-4");
    expect(() => createStagingTag("")).toThrow(/run identifier/i);
  });

  it("patches Changesets config and composes a dev snapshot prerelease", () => {
    const root = createWorkspaceFixture([
      {
        directory: "snapshot-target",
        manifest: {
          name: "@fixture/snapshot-target",
          version: "1.2.3",
          publishConfig: { access: "public" },
        },
      },
    ]);
    const changesetDirectory = join(root, ".changeset");
    mkdirSync(changesetDirectory, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify(
        {
          name: "snapshot-fixture",
          private: true,
          packageManager: "pnpm@11.9.0",
          workspaces: ["packages/*"],
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    writeFileSync(
      join(changesetDirectory, "config.json"),
      `${JSON.stringify(
        {
          changelog: false,
          commit: false,
          fixed: [],
          linked: [],
          access: "public",
          baseBranch: "main",
          updateInternalDependencies: "patch",
          ignore: [],
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(changesetDirectory, "snapshot.md"),
      '---\n"@fixture/snapshot-target": patch\n---\n\nSnapshot fixture.\n',
    );

    expect(patchSnapshotConfig(root).snapshot).toMatchObject({
      useCalculatedVersion: true,
      prereleaseTemplate: "{tag}-{commit}-{datetime}",
    });
    writePatchedSnapshotConfig(root);

    execFileSync("git", ["init", "--initial-branch=main", root], {
      env: gitFixtureEnv(),
      stdio: "pipe",
    });
    execFileSync("git", ["-C", root, "config", "user.email", "tests@example.invalid"], {
      env: gitFixtureEnv(),
    });
    execFileSync("git", ["-C", root, "config", "user.name", "Snapshot Test"], {
      env: gitFixtureEnv(),
    });
    execFileSync("git", ["-C", root, "add", "."], { env: gitFixtureEnv() });
    execFileSync("git", ["-C", root, "commit", "-m", "snapshot fixture"], {
      env: gitFixtureEnv(),
      stdio: "pipe",
    });
    execFileSync(
      process.execPath,
      [
        join(repoRoot, "node_modules", "@changesets", "cli", "bin.js"),
        "version",
        "--snapshot",
        "dev",
      ],
      { cwd: root, env: gitFixtureEnv(), stdio: "pipe" },
    );

    const snapshotPackage = JSON.parse(
      readFileSync(join(root, "packages", "snapshot-target", "package.json"), "utf8"),
    ) as { version: string };
    expect(snapshotPackage.version).toMatch(/^1\.2\.4-dev-[0-9a-f]+-\d{14}$/);
  });

  it("requires the main ref and a fresh main commit before publishing and promotion", () => {
    const workflow = readFileSync(
      join(repoRoot, ".github/workflows/dev-snapshot-release.yml"),
      "utf8",
    );
    const publish = workflowJob(workflow, "publish");
    const promote = workflowJob(workflow, "promote");
    const mainOnlyCondition =
      "github.ref == 'refs/heads/main' && needs.plan.outputs.has_public_releases == 'true'";

    expect(workflow).toContain("name: Dev Snapshot Release");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).not.toContain("cancel-in-progress: true");
    expect(workflow).toContain("needs: [plan, publish, validation_complete]");
    expect(workflow).toContain("name: Validation barrier");
    expect(workflow).toContain("name: Verify promoted caplets@dev line");
    expect(workflow).toContain("name: Reconcile failed promoted dev line");
    expect(workflow).toContain("needs: [plan, promote, verify_promoted_cli]");
    expect(workflow).toContain(
      "staging_tag=dev-staged-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}",
    );
    expect(workflow.split('export PATH="$INSTALL_ROOT/bin:$PATH"').length - 1).toBe(2);
    expect(workflow.split("persist-credentials: false").length - 1).toBe(8);
    expect(workflow).not.toContain('eval "$command"');
    expect(workflow).not.toContain("Stop when dry run is requested");
    expect(workflow).toContain(
      "if: always() && github.ref == 'refs/heads/main' && needs.plan.outputs.has_public_releases == 'true'",
    );
    expect(publish).toContain(`if: ${mainOnlyCondition}`);
    expect(promote).toContain(`if: ${mainOnlyCondition}`);
    for (const job of [publish, promote]) {
      expect(job).toMatch(
        /git fetch --no-tags origin main\n\s+current_main="\$\(git rev-parse origin\/main\)"\n\s+test "\$GITHUB_SHA" = "\$current_main"/,
      );
    }
    expect(publish.indexOf("Require current main commit before publishing")).toBeLessThan(
      publish.indexOf("Publish exact snapshots"),
    );
    expect(promote.indexOf("Require current main commit before promotion")).toBeLessThan(
      promote.indexOf("Promote validated versions"),
    );
  });

  it("limits snapshot release authority to the reusable protected jobs", () => {
    const snapshotWorkflow = readFileSync(
      join(repoRoot, ".github/workflows/dev-snapshot-release.yml"),
      "utf8",
    );
    const releaseWorkflow = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");
    const publish = workflowJob(snapshotWorkflow, "publish");
    const promote = workflowJob(snapshotWorkflow, "promote");
    const reconcilePromotedCliFailure = workflowJob(
      snapshotWorkflow,
      "reconcile_promoted_cli_failure",
    );
    const devImage = workflowJob(snapshotWorkflow, "dev_image");
    const environmentProtectedJobs = [publish, promote, reconcilePromotedCliFailure, devImage];
    const registryJobs = [publish, promote, reconcilePromotedCliFailure];
    const jobsWithoutNpmToken = [
      workflowJob(snapshotWorkflow, "plan"),
      publish,
      workflowJob(snapshotWorkflow, "validate_cli"),
      workflowJob(snapshotWorkflow, "validate_packages"),
      workflowJob(snapshotWorkflow, "validation_complete"),
      workflowJob(snapshotWorkflow, "verify_promoted_cli"),
      devImage,
    ];
    const jobsWithoutNpmRegistry = jobsWithoutNpmToken.filter((job) => job !== publish);
    const npmRegistryUrl = /registry-url: "?https:\/\/registry\.npmjs\.org"?/;

    const tokenScopedSteps = [
      {
        job: promote,
        mutationStep: workflowStep(
          promote,
          "Promote validated versions to dev with reconciliation",
        ),
        unprivilegedSteps: ["Checkout", "Setup Node", "Download manifest artifact"],
      },
      {
        job: reconcilePromotedCliFailure,
        mutationStep: workflowStep(
          reconcilePromotedCliFailure,
          "Restore dev tags after promoted smoke failure",
        ),
        unprivilegedSteps: [
          "Checkout",
          "Setup Node",
          "Download manifest artifact",
          "Download pre-run tag snapshot",
        ],
      },
    ];

    expect(snapshotWorkflow).toContain("  workflow_call:");
    expect(snapshotWorkflow).not.toMatch(/^ {2}push:$/m);
    expect(snapshotWorkflow).not.toContain("workflow_dispatch:");
    expect(releaseWorkflow).not.toContain("workflow_dispatch:");
    expect(releaseWorkflow).toContain("uses: ./.github/workflows/dev-snapshot-release.yml");

    const snapshotCall = workflowJobContaining(
      releaseWorkflow,
      "uses: ./.github/workflows/dev-snapshot-release.yml",
    );
    expect(snapshotCall).toContain("needs: release");
    expect(snapshotCall).toContain("contents: read");
    expect(snapshotCall).toContain("id-token: write");
    expect(snapshotCall).toContain("packages: write");

    expect(publish).toContain("id-token: write");
    expect(promote).not.toContain("id-token: write");
    expect(reconcilePromotedCliFailure).not.toContain("id-token: write");
    expect(publish).not.toContain("NODE_AUTH_TOKEN");

    for (const job of environmentProtectedJobs) {
      expect(job).toContain("environment: npm-release");
    }
    expect(snapshotWorkflow.split("environment: npm-release").length - 1).toBe(4);

    for (const job of registryJobs) {
      expect(job).toMatch(npmRegistryUrl);
    }
    expect(
      snapshotWorkflow.match(/registry-url: "?https:\/\/registry\.npmjs\.org"?/g) ?? [],
    ).toHaveLength(3);

    for (const { job, mutationStep, unprivilegedSteps } of tokenScopedSteps) {
      const jobDefinition = job.slice(0, job.indexOf("    steps:\n"));
      expect(jobDefinition).not.toContain("NODE_AUTH_TOKEN");
      expect(mutationStep).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_DIST_TAG_TOKEN }}");
      for (const stepName of unprivilegedSteps) {
        expect(workflowStep(job, stepName)).not.toContain("NODE_AUTH_TOKEN");
      }
    }
    expect(
      snapshotWorkflow.split("NODE_AUTH_TOKEN: ${{ secrets.NPM_DIST_TAG_TOKEN }}").length - 1,
    ).toBe(2);

    for (const job of jobsWithoutNpmToken) {
      expect(job).not.toContain("NODE_AUTH_TOKEN");
    }
    for (const job of jobsWithoutNpmRegistry) {
      expect(job).not.toMatch(npmRegistryUrl);
    }
  });
});
