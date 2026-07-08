import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PI_PACKAGE_NAME, OPENCODE_PACKAGE_NAME } from "../../../scripts/dev-snapshot-release.mjs";
import {
  assertInstalledSnapshotLine,
  buildValidationCommands,
  createIsolatedValidationEnv,
  derivePackageOnlyTargets,
  deriveValidationPlan,
  type BootstrapManifest,
} from "../../../scripts/check-dev-snapshot-bootstrap.mjs";

const tempPaths: string[] = [];

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("dev snapshot bootstrap helpers", () => {
  it("derives cli bootstrap validation when caplets or core is present", () => {
    const manifest: BootstrapManifest = {
      validation: { kind: "cli-bootstrap", packages: ["caplets", "@caplets/core"] },
      releases: [
        { name: "caplets", newVersion: "0.25.7-dev-abc-20260708120000" },
        { name: "@caplets/core", newVersion: "0.33.0-dev-abc-20260708120000" },
      ],
    };

    expect(deriveValidationPlan(manifest)).toEqual({
      kind: "cli-bootstrap",
      cliPackage: "caplets",
      expectedCorePackage: "@caplets/core",
      packages: ["caplets", "@caplets/core"],
    });
    expect(buildValidationCommands(manifest)).toEqual([
      "npm install -g caplets@0.25.7-dev-abc-20260708120000",
      "caplets --version",
      "caplets setup mcp-client --output ${INSTALL_ROOT}/caplets.mcp.json --format json",
    ]);
  });

  it("derives package-only validation targets and retains peer-host metadata", () => {
    const manifest: BootstrapManifest = {
      validation: { kind: "package-only", packages: [PI_PACKAGE_NAME, OPENCODE_PACKAGE_NAME] },
      releases: [
        { name: PI_PACKAGE_NAME, newVersion: "0.9.14-dev-abc-20260708120000" },
        { name: OPENCODE_PACKAGE_NAME, newVersion: "0.8.15-dev-abc-20260708120000" },
      ],
    };

    const targets = derivePackageOnlyTargets(manifest);
    expect(targets).toEqual([
      {
        name: PI_PACKAGE_NAME,
        peerDependencies: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"],
        validationKind: "install-only",
      },
      {
        name: OPENCODE_PACKAGE_NAME,
        peerDependencies: ["@opencode-ai/plugin"],
        validationKind: "install-only",
      },
    ]);
    expect(buildValidationCommands(manifest)).toEqual([
      "npm install -g @caplets/pi@0.9.14-dev-abc-20260708120000",
      "npm install -g @caplets/opencode@0.8.15-dev-abc-20260708120000",
    ]);
  });

  it("creates an isolated validation environment", () => {
    const isolated = createIsolatedValidationEnv();
    tempPaths.push(isolated.baseDirectory);

    expect(isolated.env.CAPLETS_CONFIG).toContain("caplets-config.json");
    expect(isolated.env.npm_config_prefix).toContain("npm-prefix");
    expect(isolated.env.HOME).toContain("home");
  });

  it("asserts installed exact versions and peer declarations for package-only lines", () => {
    const installRoot = mkdtempSync(join(tmpdir(), "caplets-dev-install-root-"));
    tempPaths.push(installRoot);
    const piDir = join(installRoot, "lib", "node_modules", "@caplets", "pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(
      join(piDir, "package.json"),
      JSON.stringify(
        {
          name: PI_PACKAGE_NAME,
          version: "0.9.14-dev-abc-20260708120000",
          peerDependencies: {
            "@earendil-works/pi-coding-agent": "*",
            "@earendil-works/pi-tui": "*",
          },
        },
        null,
        2,
      ),
    );

    const manifest: BootstrapManifest = {
      validation: { kind: "package-only", packages: [PI_PACKAGE_NAME] },
      releases: [{ name: PI_PACKAGE_NAME, newVersion: "0.9.14-dev-abc-20260708120000" }],
    };

    expect(assertInstalledSnapshotLine(manifest, installRoot)).toEqual([]);
  });

  it("reports missing peer declarations for peer-host package lines", () => {
    const installRoot = mkdtempSync(join(tmpdir(), "caplets-dev-install-root-"));
    tempPaths.push(installRoot);
    const piDir = join(installRoot, "lib", "node_modules", "@caplets", "pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(
      join(piDir, "package.json"),
      JSON.stringify({ name: PI_PACKAGE_NAME, version: "0.9.14-dev-abc-20260708120000" }, null, 2),
    );

    const manifest: BootstrapManifest = {
      validation: { kind: "package-only", packages: [PI_PACKAGE_NAME] },
      releases: [{ name: PI_PACKAGE_NAME, newVersion: "0.9.14-dev-abc-20260708120000" }],
    };

    expect(assertInstalledSnapshotLine(manifest, installRoot)).toEqual([
      `${PI_PACKAGE_NAME} is missing peer dependency declaration for @earendil-works/pi-coding-agent.`,
      `${PI_PACKAGE_NAME} is missing peer dependency declaration for @earendil-works/pi-tui.`,
    ]);
  });

  it("reports missing installed packages as descriptive errors", () => {
    const installRoot = mkdtempSync(join(tmpdir(), "caplets-dev-install-root-"));
    tempPaths.push(installRoot);

    const manifest: BootstrapManifest = {
      validation: { kind: "package-only", packages: [PI_PACKAGE_NAME] },
      releases: [{ name: PI_PACKAGE_NAME, newVersion: "0.9.14-dev-abc-20260708120000" }],
    };

    const errors = assertInstalledSnapshotLine(manifest, installRoot);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      `${PI_PACKAGE_NAME} is not installed at ${join(installRoot, "lib", "node_modules", "@caplets", "pi", "package.json")}`,
    );
    expect(errors[0]).toContain("ENOENT");
  });
});
