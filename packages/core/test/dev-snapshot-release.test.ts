import { Buffer } from "node:buffer";

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as snapshotRelease from "../../../scripts/dev-snapshot-release.mjs";
import {
  computeRelevantFingerprint,
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

type SnapshotRelease = {
  name: string;
  directory: string;
  newVersion: string;
};

type SnapshotManifest = {
  fingerprint: string;
  sourceCommit: string;
  stagingTag: string;
  releases: SnapshotRelease[];
};

type RegistryPackuments = Record<string, Record<string, unknown>>;

function requiredSnapshotExport<T>(name: string): T {
  const candidate = (snapshotRelease as Record<string, unknown>)[name];
  expect(candidate, `expected ${name} to be exported`).toBeTypeOf("function");
  return candidate as T;
}

function snapshotManifest(fingerprint = "a".repeat(64)): SnapshotManifest {
  return {
    fingerprint,
    sourceCommit: "1234567890abcdef1234567890abcdef12345678",
    stagingTag: `dev-staged-${fingerprint}-run-1`,
    releases: [
      { name: "@fixture/core", directory: "core", newVersion: "1.2.3-dev-fixture" },
      { name: "fixture-cli", directory: "cli", newVersion: "4.5.6-dev-fixture" },
    ],
  };
}

function validRegistryPackuments(manifest: SnapshotManifest): RegistryPackuments {
  const stagingTag = manifest.stagingTag;
  const releases = Object.fromEntries(
    manifest.releases.map((release) => [release.name, release.newVersion]),
  );
  return Object.fromEntries(
    manifest.releases.map((release) => [
      release.name,
      {
        "dist-tags": { [stagingTag]: release.newVersion },
        versions: {
          [release.newVersion]: {
            name: release.name,
            version: release.newVersion,
            capletsSnapshot: {
              schema: 1,
              fingerprint: manifest.fingerprint,
              sourceCommit: manifest.sourceCommit,
              stagingTag,
              releases,
            },
            dist: {
              integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
              tarball: `https://registry.example.invalid/${encodeURIComponent(release.name)}`,
            },
            ...(release.name === "fixture-cli"
              ? { dependencies: { "@fixture/core": releases["@fixture/core"] } }
              : {}),
          },
        },
      },
    ]),
  );
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

  it("derives safe staging-generation tags only from full lowercase SHA-256 fingerprints", () => {
    const fingerprint = "0123456789abcdef".repeat(4);
    const createFingerprintStagingTag = createStagingTag as (
      fingerprint: string,
      runIdentity: string,
    ) => string;
    expect(createFingerprintStagingTag(fingerprint, "run-42")).toBe(
      `dev-staged-${fingerprint}-run-42`,
    );
    for (const [invalidFingerprint, runIdentity] of [
      ["", "run-42"],
      ["a".repeat(63), "run-42"],
      ["a".repeat(65), "run-42"],
      ["A".repeat(64), "run-42"],
      ["g".repeat(64), "run-42"],
      [fingerprint, ""],
      [fingerprint, "run/42"],
      [fingerprint, "run 42"],
      [fingerprint, "../unsafe"],
    ] as const) {
      expect(() => createFingerprintStagingTag(invalidFingerprint, runIdentity)).toThrow();
    }
  });

  it("fingerprints the lockfile and dashboard sources for a core-and-CLI release closure", () => {
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
    ]);
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    mkdirSync(join(root, "apps", "dashboard", "src"), { recursive: true });
    writeFileSync(
      join(root, "apps", "dashboard", "src", "release-panel.ts"),
      "export const panel = 1;\n",
    );

    const manifest = deriveChangesetManifest(
      {
        releases: [
          {
            name: "@caplets/core",
            type: "patch",
            oldVersion: "1.0.0",
            newVersion: "1.0.1",
            changesets: ["core-release"],
          },
        ],
      },
      { repoRoot: root },
    );
    expect(manifest.releases.map((release) => release.name)).toEqual(["@caplets/core", "caplets"]);

    const original = computeRelevantFingerprint(manifest, root);
    writeFileSync(
      join(root, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: false\n",
    );
    const afterLockfileChange = computeRelevantFingerprint(manifest, root);
    writeFileSync(
      join(root, "apps", "dashboard", "src", "release-panel.ts"),
      "export const panel = 2;\n",
    );
    const afterDashboardChange = computeRelevantFingerprint(manifest, root);

    expect(afterLockfileChange).not.toBe(original);
    expect(afterDashboardChange).not.toBe(afterLockfileChange);
  });

  it("fingerprints release artifacts and intent while ignoring non-artifact inputs", () => {
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
        directory: "unrelated",
        manifest: {
          name: "@fixture/unrelated",
          version: "1.0.0",
          publishConfig: { access: "public" },
        },
      },
    ]);
    mkdirSync(join(root, ".changeset"), { recursive: true });
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "packages", "cli", "src"), { recursive: true });
    mkdirSync(join(root, "packages", "cli", "test"), { recursive: true });
    writeFileSync(join(root, "README.md"), "# Caplets\n");
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    writeFileSync(join(root, ".changeset", "config.json"), "{}\n");
    writeFileSync(
      join(root, ".changeset", "cli-release.md"),
      '---\n"caplets": patch\n---\n\nCLI release.\n',
    );
    writeFileSync(join(root, ".changeset", "unrelated.md"), "---\n---\n\nUnrelated.\n");
    writeFileSync(
      join(root, ".github", "workflows", "dev-snapshot-release.yml"),
      "name: release\n",
    );
    writeFileSync(join(root, "scripts", "check-package-runtime.mjs"), "export default 1;\n");
    writeFileSync(join(root, "scripts", "check-dev-snapshot-bootstrap.mjs"), "export default 1;\n");
    writeFileSync(join(root, "scripts", "dev-snapshot-release.mjs"), "export default 1;\n");
    writeFileSync(
      join(root, "scripts", "runtime-sentry-rolldown.ts"),
      "export const sentry = 1;\n",
    );
    writeFileSync(
      join(root, "packages", "cli", "src", "release.ts"),
      "export const release = 1;\n",
    );
    writeFileSync(
      join(root, "packages", "cli", "test", "release.test.ts"),
      "export const testOnly = 1;\n",
    );

    const manifest = deriveChangesetManifest(
      {
        releases: [
          {
            name: "caplets",
            type: "patch",
            oldVersion: "1.0.0",
            newVersion: "1.0.1",
            changesets: ["cli-release"],
          },
        ],
      },
      { repoRoot: root },
    );
    const baseline = computeRelevantFingerprint(manifest, root);
    const unrelatedManifest = deriveChangesetManifest(
      {
        releases: [
          {
            name: "@fixture/unrelated",
            type: "patch",
            oldVersion: "1.0.0",
            newVersion: "1.0.1",
            changesets: ["unrelated"],
          },
        ],
      },
      { repoRoot: root },
    );
    const unrelatedBaseline = computeRelevantFingerprint(unrelatedManifest, root);

    const assertFileMutation = (
      relativePath: string,
      contents: string,
      changesFingerprint: boolean,
    ) => {
      writeFileSync(join(root, relativePath), contents);
      const fingerprint = computeRelevantFingerprint(manifest, root);
      if (changesFingerprint) {
        expect(fingerprint).not.toBe(baseline);
      } else {
        expect(fingerprint).toBe(baseline);
      }
      writeFileSync(
        join(root, relativePath),
        {
          "README.md": "# Caplets\n",
          "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
          "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
          ".changeset/cli-release.md": '---\n"caplets": patch\n---\n\nCLI release.\n',
          ".changeset/unrelated.md": "---\n---\n\nUnrelated.\n",
          ".github/workflows/dev-snapshot-release.yml": "name: release\n",
          "scripts/check-package-runtime.mjs": "export default 1;\n",
          "scripts/check-dev-snapshot-bootstrap.mjs": "export default 1;\n",
          "scripts/dev-snapshot-release.mjs": "export default 1;\n",
          "scripts/runtime-sentry-rolldown.ts": "export const sentry = 1;\n",
          "packages/cli/src/release.ts": "export const release = 1;\n",
          "packages/cli/test/release.test.ts": "export const testOnly = 1;\n",
        }[relativePath]!,
      );
    };

    assertFileMutation("README.md", "# Caplets v2\n", true);
    writeFileSync(join(root, "README.md"), "# Caplets v2\n");
    expect(computeRelevantFingerprint(unrelatedManifest, root)).toBe(unrelatedBaseline);
    writeFileSync(join(root, "README.md"), "# Caplets\n");
    assertFileMutation("pnpm-lock.yaml", "lockfileVersion: '9.1'\n", true);
    assertFileMutation("pnpm-workspace.yaml", "packages:\n  - packages/*\n  - tools/*\n", true);
    assertFileMutation(
      ".changeset/cli-release.md",
      '---\n"caplets": patch\n---\n\nCLI release, revised.\n',
      true,
    );
    assertFileMutation("scripts/runtime-sentry-rolldown.ts", "export const sentry = 2;\n", true);
    assertFileMutation("packages/cli/src/release.ts", "export const release = 2;\n", true);
    assertFileMutation("scripts/dev-snapshot-release.mjs", "export default 2;\n", true);
    assertFileMutation(".github/workflows/dev-snapshot-release.yml", "name: release v2\n", false);
    assertFileMutation("scripts/check-package-runtime.mjs", "export default 2;\n", false);
    assertFileMutation("scripts/check-dev-snapshot-bootstrap.mjs", "export default 2;\n", false);
    assertFileMutation(".changeset/unrelated.md", "---\n---\n\nStill unrelated.\n", false);
    assertFileMutation("packages/cli/test/release.test.ts", "export const testOnly = 2;\n", false);

    for (const { name, changes } of [
      { name: "release name", changes: { name: "caplets-renamed" } },
      { name: "base version", changes: { oldVersion: "1.0.1" } },
      { name: "release type", changes: { type: "minor" } },
      { name: "direct release marker", changes: { direct: false } },
      {
        name: "relevant Changeset identifiers",
        changes: { changesets: ["cli-release", "intent-change"] },
      },
    ]) {
      const alteredIntent = {
        ...manifest,
        releases: manifest.releases.map((release) =>
          release.name === "caplets" ? { ...release, ...changes } : release,
        ),
      };
      expect(computeRelevantFingerprint(alteredIntent, root), name).not.toBe(baseline);
    }
  });

  it("stamps every released package with the same complete snapshot identity", () => {
    const root = createWorkspaceFixture([
      {
        directory: "core",
        manifest: {
          name: "@fixture/core",
          version: "1.2.3-dev-fixture",
          publishConfig: { access: "public" },
        },
      },
      {
        directory: "cli",
        manifest: {
          name: "fixture-cli",
          version: "4.5.6-dev-fixture",
          publishConfig: { access: "public" },
          dependencies: { "@fixture/core": "1.2.3-dev-fixture" },
        },
      },
    ]);
    const manifest = snapshotManifest();
    const stampSnapshotMetadata =
      requiredSnapshotExport<(manifest: SnapshotManifest, root?: string) => unknown>(
        "stampSnapshotMetadata",
      );

    stampSnapshotMetadata(manifest, root);

    const expectedMetadata = {
      schema: 1,
      fingerprint: manifest.fingerprint,
      sourceCommit: manifest.sourceCommit,
      stagingTag: manifest.stagingTag,
      releases: {
        "@fixture/core": "1.2.3-dev-fixture",
        "fixture-cli": "4.5.6-dev-fixture",
      },
    };
    for (const release of manifest.releases) {
      const packageJson = JSON.parse(
        readFileSync(join(root, "packages", release.directory, "package.json"), "utf8"),
      ) as { capletsSnapshot?: unknown };
      expect(packageJson.capletsSnapshot).toEqual(expectedMetadata);
    }
  });

  it("classifies empty, coherently staged, and fully promoted registry lines", () => {
    const classifyRegistrySnapshot = requiredSnapshotExport<
      (
        manifest: SnapshotManifest,
        packuments: RegistryPackuments,
      ) => {
        action: "fresh" | "reuse-staged" | "skip-promoted";
        stagingTag: string;
        manifest: {
          fingerprint: string;
          sourceCommit: string;
          releases: Array<SnapshotRelease & { integrity?: string; tarball?: string }>;
        };
      }
    >("classifyRegistrySnapshot");
    const stagedManifest = snapshotManifest();
    const recoveryRequest = {
      ...stagedManifest,
      sourceCommit: "fedcba0987654321fedcba0987654321fedcba09",
      stagingTag: `dev-staged-${stagedManifest.fingerprint}-run-2`,
      releases: stagedManifest.releases.map((release) => ({
        ...release,
        newVersion: "0.0.0-pending",
      })),
    };

    const untaggedPackuments = validRegistryPackuments(stagedManifest);
    for (const release of stagedManifest.releases) {
      delete (untaggedPackuments[release.name]!["dist-tags"] as Record<string, string>)[
        stagedManifest.stagingTag
      ];
    }
    const fresh = classifyRegistrySnapshot(stagedManifest, untaggedPackuments);
    expect(fresh).toMatchObject({
      action: "fresh",
      stagingTag: stagedManifest.stagingTag,
      manifest: {
        fingerprint: stagedManifest.fingerprint,
        sourceCommit: stagedManifest.sourceCommit,
      },
    });

    const reused = classifyRegistrySnapshot(
      recoveryRequest,
      validRegistryPackuments(stagedManifest),
    );
    expect(reused).toMatchObject({
      action: "reuse-staged",
      stagingTag: stagedManifest.stagingTag,
      manifest: {
        sourceCommit: stagedManifest.sourceCommit,
        releases: [
          {
            name: "@fixture/core",
            newVersion: "1.2.3-dev-fixture",
            integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
            tarball: "https://registry.example.invalid/%40fixture%2Fcore",
          },
          {
            name: "fixture-cli",
            newVersion: "4.5.6-dev-fixture",
            integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
            tarball: "https://registry.example.invalid/fixture-cli",
          },
        ],
      },
    });

    const promotedPackuments = validRegistryPackuments(stagedManifest);
    for (const release of stagedManifest.releases) {
      (promotedPackuments[release.name]!["dist-tags"] as Record<string, string>).dev =
        release.newVersion;
    }
    const promoted = classifyRegistrySnapshot(recoveryRequest, promotedPackuments);
    expect(promoted).toMatchObject({
      action: "skip-promoted",
      stagingTag: stagedManifest.stagingTag,
      manifest: {
        releases: stagedManifest.releases.map((release) => ({
          name: release.name,
          newVersion: release.newVersion,
        })),
      },
    });
  });

  it("waits past repeated fresh registry scans for a required staged snapshot", async () => {
    const recoverSnapshotManifest = requiredSnapshotExport<
      (
        manifest: SnapshotManifest,
        options: {
          requiredAction: "reuse-staged";
          maxAttempts: number;
          pollIntervalMs: number;
          fetchImplementation: (url: string) => Promise<{
            ok: boolean;
            status: number;
            json?: () => Promise<Record<string, unknown>>;
          }>;
        },
      ) => Promise<{
        action: "fresh" | "reuse-staged" | "skip-promoted";
        stagingTag: string;
        manifest: SnapshotManifest;
      }>
    >("recoverSnapshotManifest");
    const manifest = snapshotManifest();
    const stagedPackuments = validRegistryPackuments(manifest);
    let requests = 0;

    const recovery = await recoverSnapshotManifest(manifest, {
      requiredAction: "reuse-staged",
      maxAttempts: 5,
      pollIntervalMs: 0,
      fetchImplementation: async (url) => {
        const scan = Math.floor(requests / manifest.releases.length);
        requests += 1;
        if (scan < 2) return { ok: false, status: 404 };
        const packageName = decodeURIComponent(new URL(url).pathname.slice(1));
        return {
          ok: true,
          status: 200,
          json: async () => stagedPackuments[packageName]!,
        };
      },
    });

    expect(recovery).toMatchObject({
      action: "reuse-staged",
      stagingTag: manifest.stagingTag,
      manifest: {
        fingerprint: manifest.fingerprint,
        releases: manifest.releases,
      },
    });
    expect(requests).toBeGreaterThanOrEqual(manifest.releases.length * 3);
    expect(recovery.manifest.releases).toContainEqual(
      expect.objectContaining({
        name: "@fixture/core",
        integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
        tarball: "https://registry.example.invalid/%40fixture%2Fcore",
      }),
    );
  });

  it("treats orphaned partial staging generations as fresh work", () => {
    const classifyRegistrySnapshot = requiredSnapshotExport<
      (
        manifest: SnapshotManifest,
        packuments: RegistryPackuments,
      ) => { action: "fresh" | "reuse-staged" | "skip-promoted"; stagingTag: string }
    >("classifyRegistrySnapshot");
    const manifest = {
      ...snapshotManifest(),
      stagingTag: `dev-staged-${"a".repeat(64)}-new-run`,
    };
    const orphanedManifest = {
      ...manifest,
      stagingTag: `dev-staged-${manifest.fingerprint}-old-run`,
    };
    const packuments = validRegistryPackuments(orphanedManifest);
    delete (packuments["fixture-cli"]!["dist-tags"] as Record<string, string>)[
      orphanedManifest.stagingTag
    ];

    expect(classifyRegistrySnapshot(manifest, packuments)).toMatchObject({
      action: "fresh",
      stagingTag: manifest.stagingTag,
    });
  });
  it("treats verified older dev targets as prior state without a current-fingerprint staging candidate", () => {
    const classifyRegistrySnapshot = requiredSnapshotExport<
      (
        manifest: SnapshotManifest,
        packuments: RegistryPackuments,
      ) => { action: "fresh" | "reuse-staged" | "skip-promoted"; stagingTag: string }
    >("classifyRegistrySnapshot");
    const manifest = snapshotManifest();
    const priorManifest: SnapshotManifest = {
      ...snapshotManifest("b".repeat(64)),
      stagingTag: `dev-staged-${"b".repeat(64)}-prior-run`,
      releases: [
        { name: "@fixture/core", directory: "core", newVersion: "1.1.0-dev-prior" },
        { name: "fixture-cli", directory: "cli", newVersion: "4.4.0-dev-prior" },
      ],
    };
    const packuments = validRegistryPackuments(priorManifest);
    for (const release of priorManifest.releases) {
      (packuments[release.name]!["dist-tags"] as Record<string, string>).dev = release.newVersion;
    }

    expect(classifyRegistrySnapshot(manifest, packuments)).toMatchObject({
      action: "fresh",
      stagingTag: manifest.stagingTag,
    });
  });

  it("treats mixed verified older dev fingerprints across an expanded closure as prior state", () => {
    const classifyRegistrySnapshot = requiredSnapshotExport<
      (
        manifest: SnapshotManifest,
        packuments: RegistryPackuments,
      ) => { action: "fresh" | "reuse-staged" | "skip-promoted"; stagingTag: string }
    >("classifyRegistrySnapshot");
    const manifest: SnapshotManifest = {
      ...snapshotManifest(),
      releases: [
        { name: "@fixture/core", directory: "core", newVersion: "1.2.3-dev-current" },
        { name: "fixture-cli", directory: "cli", newVersion: "4.5.6-dev-current" },
        {
          name: "@fixture/closure-only",
          directory: "closure-only",
          newVersion: "7.8.9-dev-current",
        },
      ],
    };
    const priorGenerations: SnapshotManifest[] = [
      {
        ...manifest,
        fingerprint: "b".repeat(64),
        stagingTag: `dev-staged-${"b".repeat(64)}-prior-core`,
        releases: [
          { name: "@fixture/core", directory: "core", newVersion: "1.1.0-dev-prior-core" },
          { name: "fixture-cli", directory: "cli", newVersion: "4.4.0-dev-prior-core" },
          {
            name: "@fixture/closure-only",
            directory: "closure-only",
            newVersion: "7.7.0-dev-prior-core",
          },
        ],
      },
      {
        ...manifest,
        fingerprint: "c".repeat(64),
        stagingTag: `dev-staged-${"c".repeat(64)}-prior-cli`,
        releases: [
          { name: "@fixture/core", directory: "core", newVersion: "1.0.0-dev-prior-cli" },
          { name: "fixture-cli", directory: "cli", newVersion: "4.3.0-dev-prior-cli" },
          {
            name: "@fixture/closure-only",
            directory: "closure-only",
            newVersion: "7.6.0-dev-prior-cli",
          },
        ],
      },
      {
        ...manifest,
        fingerprint: "d".repeat(64),
        stagingTag: `dev-staged-${"d".repeat(64)}-prior-closure`,
        releases: [
          { name: "@fixture/core", directory: "core", newVersion: "0.9.0-dev-prior-closure" },
          { name: "fixture-cli", directory: "cli", newVersion: "4.2.0-dev-prior-closure" },
          {
            name: "@fixture/closure-only",
            directory: "closure-only",
            newVersion: "7.5.0-dev-prior-closure",
          },
        ],
      },
    ];
    const packuments = validRegistryPackuments(priorGenerations[0]!);
    for (const priorManifest of priorGenerations.slice(1)) {
      const priorPackuments = validRegistryPackuments(priorManifest);
      for (const release of manifest.releases) {
        Object.assign(
          packuments[release.name]!.versions as Record<string, unknown>,
          priorPackuments[release.name]!.versions as Record<string, unknown>,
        );
        Object.assign(
          packuments[release.name]!["dist-tags"] as Record<string, string>,
          priorPackuments[release.name]!["dist-tags"] as Record<string, string>,
        );
      }
    }
    for (const [index, release] of manifest.releases.entries()) {
      (packuments[release.name]!["dist-tags"] as Record<string, string>).dev =
        priorGenerations[index]!.releases[index]!.newVersion;
    }

    expect(classifyRegistrySnapshot(manifest, packuments)).toMatchObject({
      action: "fresh",
      stagingTag: manifest.stagingTag,
    });
  });

  it("rejects registry recovery with a partial promotion or incoherent common generation", () => {
    const classifyRegistrySnapshot = requiredSnapshotExport<
      (manifest: SnapshotManifest, packuments: RegistryPackuments) => unknown
    >("classifyRegistrySnapshot");
    const manifest = snapshotManifest();
    const versionRecord = (packuments: RegistryPackuments, packageName: string) =>
      (packuments[packageName]!.versions as Record<string, Record<string, unknown>>)[
        manifest.releases.find((release) => release.name === packageName)!.newVersion
      ]!;
    const corruptionCases: Array<{
      name: string;
      corrupt: (packuments: RegistryPackuments) => void;
    }> = [
      {
        name: "partial dev tags for a complete current-fingerprint staging candidate",
        corrupt: (packuments) => {
          (packuments["@fixture/core"]!["dist-tags"] as Record<string, string>).dev =
            "1.2.3-dev-fixture";
        },
      },
      {
        name: "wrong metadata schema",
        corrupt: (packuments) => {
          (
            versionRecord(packuments, "@fixture/core").capletsSnapshot as Record<string, unknown>
          ).schema = 2;
        },
      },
      {
        name: "wrong metadata staging tag",
        corrupt: (packuments) => {
          (
            versionRecord(packuments, "@fixture/core").capletsSnapshot as Record<string, unknown>
          ).stagingTag = `dev-staged-${manifest.fingerprint}-other-run`;
        },
      },
      {
        name: "wrong metadata fingerprint",
        corrupt: (packuments) => {
          (
            versionRecord(packuments, "@fixture/core").capletsSnapshot as Record<string, unknown>
          ).fingerprint = "b".repeat(64);
        },
      },
      {
        name: "wrong metadata release map",
        corrupt: (packuments) => {
          (
            (versionRecord(packuments, "fixture-cli").capletsSnapshot as Record<string, unknown>)
              .releases as Record<string, string>
          )["@fixture/core"] = "9.9.9-dev-mismatch";
        },
      },
      {
        name: "mismatched package identity",
        corrupt: (packuments) => {
          versionRecord(packuments, "fixture-cli").name = "not-fixture-cli";
        },
      },
      {
        name: "mismatched version identity",
        corrupt: (packuments) => {
          versionRecord(packuments, "fixture-cli").version = "9.9.9-dev-mismatch";
        },
      },
      {
        name: "missing integrity",
        corrupt: (packuments) => {
          delete (versionRecord(packuments, "@fixture/core").dist as Record<string, unknown>)
            .integrity;
        },
      },
      {
        name: "invalid integrity",
        corrupt: (packuments) => {
          (versionRecord(packuments, "@fixture/core").dist as Record<string, unknown>).integrity =
            "sha512-not-a-digest";
        },
      },
      {
        name: "missing tarball",
        corrupt: (packuments) => {
          delete (versionRecord(packuments, "@fixture/core").dist as Record<string, unknown>)
            .tarball;
        },
      },
      {
        name: "invalid tarball",
        corrupt: (packuments) => {
          (versionRecord(packuments, "@fixture/core").dist as Record<string, unknown>).tarball =
            "not a URL";
        },
      },
      {
        name: "mismatched internal closure dependency",
        corrupt: (packuments) => {
          (versionRecord(packuments, "fixture-cli").dependencies as Record<string, string>)[
            "@fixture/core"
          ] = "9.9.9-dev-mismatch";
        },
      },
    ];

    for (const { name, corrupt } of corruptionCases) {
      const packuments = validRegistryPackuments(manifest);
      corrupt(packuments);
      expect(() => classifyRegistrySnapshot(manifest, packuments), name).toThrow();
    }
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
    expect(workflow).not.toMatch(/^  reconcile_promoted_cli_failure:$/m);
    expect(workflow).not.toMatch(/^  verify_promoted_cli:$/m);
    expect(workflow).toContain("createStagingTag(manifest.fingerprint");
    expect(workflow).toContain("recovery_action");
    expect(workflow.split('export PATH="$INSTALL_ROOT/bin:$PATH"').length - 1).toBe(2);
    expect(workflow.split("persist-credentials: false").length - 1).toBe(6);
    expect(workflow).not.toContain('eval "$command"');
    expect(workflow).not.toContain("Stop when dry run is requested");
    expect(workflow).toContain(
      "if: always() && github.ref == 'refs/heads/main' && needs.plan.outputs.has_public_releases == 'true'",
    );
    expect(publish).toContain(`if: ${mainOnlyCondition}`);
    const promoteJobCondition =
      promote.match(/^    if: (?<condition>.+)$/m)?.groups?.condition ?? "";
    expect(promoteJobCondition).toContain("always()");
    expect(promoteJobCondition).toContain(mainOnlyCondition);
    expect(promoteJobCondition).toContain("needs.plan.result == 'success'");
    expect(promoteJobCondition).toContain("needs.publish.result == 'success'");
    expect(promoteJobCondition).toContain("needs.publish.result == 'skipped'");
    expect(promoteJobCondition).toContain("needs.validation_complete.result == 'success'");
    const promotionTransactionMarkerName = "Mark promotion transaction started";
    const promoteMutationStepName = "Promote validated versions to dev with reconciliation";
    const promotionTransactionMarker = workflowStep(promote, promotionTransactionMarkerName);
    const promoteStepNames = [...promote.matchAll(/^      - name: (?<name>.+)$/gm)].map(
      (match) => match.groups?.name ?? "",
    );
    const postPublishRecovery = workflowStep(
      publish,
      "Verify published snapshot registry identity",
    );
    expect(postPublishRecovery).toMatch(
      /recoverSnapshotManifest\(\s*readJson\(manifestPath\),\s*\{\s*requiredAction:\s*["']reuse-staged["']\s*,?\s*\}\s*\)/,
    );
    const promotedCliSmoke = workflowStep(promote, "Smoke promoted caplets@dev line");
    const restorePromotedTags = workflowStep(
      promote,
      "Restore dev tags after promoted smoke failure",
    );
    expect(promote.indexOf("Smoke promoted caplets@dev line")).toBeLessThan(
      promote.indexOf("Restore dev tags after promoted smoke failure"),
    );
    expect(promotedCliSmoke).toContain("id: smoke_promoted_cli");
    expect(promotionTransactionMarker).toContain("id: promotion_transaction_started");
    expect(promotionTransactionMarker).toContain('echo "started=true" >> "$GITHUB_OUTPUT"');
    expect(promoteStepNames[promoteStepNames.indexOf(promotionTransactionMarkerName) + 1]).toBe(
      promoteMutationStepName,
    );
    expect(restorePromotedTags).toContain("if: ${{ always()");
    expect(restorePromotedTags).toContain(
      "steps.promotion_transaction_started.outputs.started == 'true'",
    );
    expect(restorePromotedTags).toMatch(
      /steps\.promotion_transaction_started\.outputs\.started == 'true'\s*&&\s*\(\s*(?:steps\.promote_dev_tags\.outcome != 'success'\s*\|\|\s*\(\s*needs\.plan\.outputs\.validation_kind == 'cli-bootstrap'\s*&&\s*steps\.smoke_promoted_cli\.outcome != 'success'\s*\)|\(\s*needs\.plan\.outputs\.validation_kind == 'cli-bootstrap'\s*&&\s*steps\.smoke_promoted_cli\.outcome != 'success'\s*\)\s*\|\|\s*steps\.promote_dev_tags\.outcome != 'success')\s*\)/,
    );
    expect(restorePromotedTags).not.toContain(
      "if: ${{ always() && needs.plan.outputs.validation_kind == 'cli-bootstrap'",
    );
    expect(restorePromotedTags).toContain(
      "for (const release of [...manifest.releases].reverse()) {",
    );
    expect(restorePromotedTags).not.toMatch(
      /if\s*\(\s*tags\.dev\s*!==\s*release\.newVersion\s*\)\s*(?:\{\s*)?continue\b/,
    );
    expect(restorePromotedTags).toContain("const previousDev = preRunTags[release.name]?.dev;");
    expect(restorePromotedTags).toContain(
      "['dist-tag', 'add', `${release.name}@${previousDev}`, 'dev']",
    );
    expect(restorePromotedTags).toContain("['dist-tag', 'rm', release.name, 'dev']");
    expect(restorePromotedTags).toContain(
      "if (readTags(release.name).dev !== undefined) throw error;",
    );
    expect(restorePromotedTags).toContain("(candidate) => candidate.dev === previousDev");
    expect(restorePromotedTags).toContain("(candidate) => candidate.dev === undefined");
    expect(promotedCliSmoke).not.toContain("NODE_AUTH_TOKEN");
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

  it("routes fresh, reusable, and promoted snapshot states without publishing an unverified line", () => {
    const workflow = readFileSync(
      join(repoRoot, ".github/workflows/dev-snapshot-release.yml"),
      "utf8",
    );
    const plan = workflowJob(workflow, "plan");
    const publish = workflowJob(workflow, "publish");
    const validationJobs = [
      workflowJob(workflow, "validate_cli"),
      workflowJob(workflow, "validate_packages"),
    ];
    const promote = workflowJob(workflow, "promote");
    const devImage = workflowJob(workflow, "dev_image");
    const artifactUpload = workflowStep(plan, "Upload manifest artifact");

    expect(plan).toContain("recovery_action");
    expect(plan).toContain("staging_tag");
    expect(plan).not.toContain("NODE_AUTH_TOKEN");
    expect(plan.indexOf("classifyRegistrySnapshot")).toBeLessThan(plan.indexOf(artifactUpload));
    expect(publish).toContain("needs.plan.outputs.recovery_action == 'fresh'");
    expect(publish).toContain("stampSnapshotMetadata");
    expect(publish.indexOf("stampSnapshotMetadata")).toBeLessThan(publish.indexOf("pnpm build"));
    expect(publish.indexOf("stampSnapshotMetadata")).toBeLessThan(
      publish.indexOf("pnpm changeset publish"),
    );
    expect(publish.lastIndexOf("classifyRegistrySnapshot")).toBeGreaterThan(
      publish.indexOf("pnpm changeset publish"),
    );
    expect(publish.lastIndexOf("classifyRegistrySnapshot")).toBeLessThan(
      publish.lastIndexOf("actions/upload-artifact@v4"),
    );
    expect(publish).toMatch(
      /if\s*\(\s*\w+\.action\s*!==\s*["']reuse-staged["']\s*\)\s*(?:\{\s*)?throw/,
    );
    expect(publish).toMatch(/writeJson\([^,]+,\s*\w+\.manifest\)/);
    expect(publish.lastIndexOf("writeJson(")).toBeGreaterThan(
      publish.lastIndexOf("classifyRegistrySnapshot"),
    );
    expect(publish.lastIndexOf("writeJson(")).toBeLessThan(
      publish.lastIndexOf("actions/upload-artifact@v4"),
    );
    expect(publish).toContain("overwrite: true");

    for (const validation of validationJobs) {
      expect(validation).toContain("needs.plan.outputs.recovery_action == 'fresh'");
      expect(validation).toContain("needs.plan.outputs.recovery_action == 'reuse-staged'");
      expect(validation).not.toContain("needs.plan.outputs.recovery_action == 'skip-promoted'");
    }
    expect(promote).toContain("needs.plan.outputs.recovery_action == 'fresh'");
    expect(promote).toContain("needs.plan.outputs.recovery_action == 'reuse-staged'");
    expect(promote).not.toContain("needs.plan.outputs.recovery_action == 'skip-promoted'");
    expect(devImage).toContain("needs.promote.result == 'success'");
  });

  it("prepares pinned QEMU before Buildx for multi-platform dev image publishing", () => {
    const snapshotWorkflow = readFileSync(
      join(repoRoot, ".github/workflows/dev-snapshot-release.yml"),
      "utf8",
    );
    const devImage = workflowJob(snapshotWorkflow, "dev_image");
    const qemu = workflowStep(devImage, "Setup QEMU");
    const buildx = workflowStep(devImage, "Setup Docker Buildx");
    const publishDevImage = workflowStep(devImage, "Publish dev image tags");

    expect(qemu).toContain(
      "uses: docker/setup-qemu-action@06116385d9baf250c9f4dcb4858b16962ea869c3",
    );
    expect(devImage.indexOf(qemu)).toBeLessThan(devImage.indexOf(buildx));
    expect(publishDevImage).toContain("platforms: linux/amd64,linux/arm64");
  });

  it("limits snapshot release authority to the reusable protected jobs", () => {
    const snapshotWorkflow = readFileSync(
      join(repoRoot, ".github/workflows/dev-snapshot-release.yml"),
      "utf8",
    );
    const releaseWorkflow = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");
    const stableRelease = workflowJob(releaseWorkflow, "release");
    const publish = workflowJob(snapshotWorkflow, "publish");
    const promote = workflowJob(snapshotWorkflow, "promote");
    const devImage = workflowJob(snapshotWorkflow, "dev_image");
    const environmentProtectedJobs = [publish, promote, devImage];
    const registryJobs = [publish, promote];
    const jobsWithoutNpmToken = [
      workflowJob(snapshotWorkflow, "plan"),
      publish,
      workflowJob(snapshotWorkflow, "validate_cli"),
      workflowJob(snapshotWorkflow, "validate_packages"),
      workflowJob(snapshotWorkflow, "validation_complete"),
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
        unprivilegedSteps: [
          "Checkout",
          "Setup Node",
          "Download manifest artifact",
          "Create install root for promoted smoke",
          "Smoke promoted caplets@dev line",
        ],
      },
      {
        job: promote,
        mutationStep: workflowStep(promote, "Restore dev tags after promoted smoke failure"),
        unprivilegedSteps: [
          "Checkout",
          "Setup Node",
          "Download manifest artifact",
          "Create install root for promoted smoke",
          "Smoke promoted caplets@dev line",
        ],
      },
    ];

    expect(snapshotWorkflow).toContain("  workflow_call:");
    expect(snapshotWorkflow).not.toMatch(/^ {2}push:$/m);
    expect(snapshotWorkflow).not.toContain("workflow_dispatch:");
    expect(releaseWorkflow).toContain("workflow_dispatch:");
    expect(stableRelease).toContain("if: github.ref == 'refs/heads/main'");
    expect(releaseWorkflow).toContain("uses: ./.github/workflows/dev-snapshot-release.yml");

    const snapshotCall = workflowJobContaining(
      releaseWorkflow,
      "uses: ./.github/workflows/dev-snapshot-release.yml",
    );
    expect(snapshotCall).toContain("needs: release");
    expect(snapshotCall).toContain("if: github.ref == 'refs/heads/main'");
    expect(snapshotCall).toContain("contents: read");
    expect(snapshotCall).toContain("id-token: write");
    expect(snapshotCall).toContain("packages: write");

    expect(publish).toContain("id-token: write");
    expect(promote).not.toContain("id-token: write");
    expect(
      workflowStep(promote, "Promote validated versions to dev with reconciliation"),
    ).toContain("id: promote_dev_tags");
    expect(publish).not.toContain("NODE_AUTH_TOKEN");

    for (const job of environmentProtectedJobs) {
      expect(job).toContain("environment: npm-release");
    }
    expect(snapshotWorkflow.split("environment: npm-release").length - 1).toBe(3);

    for (const job of registryJobs) {
      expect(job).toMatch(npmRegistryUrl);
    }
    expect(
      snapshotWorkflow.match(/registry-url: "?https:\/\/registry\.npmjs\.org"?/g) ?? [],
    ).toHaveLength(2);

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
    expect(snapshotWorkflow).not.toContain("reconcile_promoted_cli_failure");
    expect(snapshotWorkflow).not.toContain("verify_promoted_cli");
    for (const job of jobsWithoutNpmRegistry) {
      expect(job).not.toMatch(npmRegistryUrl);
    }
  });
});
