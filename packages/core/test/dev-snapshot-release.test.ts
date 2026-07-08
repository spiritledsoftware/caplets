import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLI_PACKAGE_NAME,
  CORE_PACKAGE_NAME,
  createStagingTag,
  deriveChangesetManifest,
  discoverWorkspacePackageManifests,
  expandPublicReleaseClosure,
  listPublicPublishablePackages,
  patchSnapshotConfig,
  readJson,
} from "../../../scripts/dev-snapshot-release.mjs";

const repoRoot = resolve(import.meta.dirname, "../../..");
const tempPaths: string[] = [];

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("dev snapshot release helpers", () => {
  it("discovers the public publishable package universe", () => {
    const publicPackages = listPublicPublishablePackages(repoRoot)
      .map((entry) => entry.name)
      .sort();

    expect(publicPackages).toEqual([
      "@caplets/core",
      "@caplets/opencode",
      "@caplets/pi",
      "caplets",
    ]);
  });

  it("expands release closure through workspace dependencies", () => {
    const manifests = discoverWorkspacePackageManifests(repoRoot);
    expect(expandPublicReleaseClosure([CORE_PACKAGE_NAME], manifests)).toEqual([
      "@caplets/core",
      "@caplets/opencode",
      "@caplets/pi",
      "caplets",
    ]);
  });

  it("derives a manifest with cli bootstrap validation for core changes", () => {
    const manifest = deriveChangesetManifest(
      {
        releases: [
          {
            name: CORE_PACKAGE_NAME,
            type: "minor",
            oldVersion: "0.32.4",
            newVersion: "0.33.0",
            changesets: ["admin-dashboard"],
          },
        ],
      },
      { repoRoot },
    );

    expect(manifest.hasPublicReleases).toBe(true);
    expect(manifest.validation).toEqual({
      kind: "cli-bootstrap",
      packages: [CLI_PACKAGE_NAME, CORE_PACKAGE_NAME],
    });
    expect(manifest.releases.map((entry) => entry.name).sort()).toEqual([
      "@caplets/core",
      "@caplets/opencode",
      "@caplets/pi",
      "caplets",
    ]);
  });

  it("returns no public releases when status contains only ignored or private workspaces", () => {
    const manifest = deriveChangesetManifest(
      {
        releases: [
          {
            name: "@caplets/catalog",
            type: "none",
            oldVersion: "0.1.0",
            newVersion: "0.1.0",
            changesets: [],
          },
        ],
      },
      { repoRoot },
    );

    expect(manifest.hasPublicReleases).toBe(false);
    expect(manifest.releases).toEqual([]);
  });

  it("creates a run-scoped staging tag", () => {
    expect(createStagingTag("123-4")).toBe("dev-staged-123-4");
    expect(() => createStagingTag("")).toThrow(/run identifier/i);
  });

  it("patches changeset snapshot config for calculated versions", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "caplets-dev-snapshot-config-"));
    tempPaths.push(tempRoot);
    const changesetDir = join(tempRoot, ".changeset");
    mkdirSync(changesetDir, { recursive: true });
    writeFileSync(join(tempRoot, "package.json"), "{}\n");
    writeFileSync(
      join(changesetDir, "config.json"),
      `${JSON.stringify(readJson(join(repoRoot, ".changeset/config.json")), null, 2)}\n`,
    );

    const patched = patchSnapshotConfig(tempRoot);
    expect(patched.snapshot).toMatchObject({
      useCalculatedVersion: true,
      prereleaseTemplate: "dev-{commit}-{datetime}",
    });
  });

  it("wires the dev snapshot workflow with separate validation and promotion barriers", () => {
    const workflow = readFileSync(
      join(repoRoot, ".github/workflows/dev-snapshot-release.yml"),
      "utf8",
    );

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
    expect(workflow).not.toContain("registry-url: https://registry.npmjs.org");
    expect(workflow).not.toContain("Stop when dry run is requested");
    expect(workflow).toContain(
      "if: always() && needs.plan.outputs.has_public_releases == 'true' && !(github.event_name == 'workflow_dispatch' && inputs.dry_run)",
    );
  });
});
