import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertInstalledSnapshotLine,
  buildValidationCommands,
  derivePackageOnlyTargets,
  createIsolatedValidationEnv,
  deriveValidationPlan,
  type BootstrapManifest,
} from "../../../scripts/check-dev-snapshot-bootstrap.mjs";

const tempPaths: string[] = [];

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function createTempDirectory(prefix: string) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempPaths.push(path);
  return path;
}

function writeInstalledPackage(
  installRoot: string,
  packageName: string,
  manifest: Record<string, unknown>,
  parentPackageName?: string,
) {
  const packageDirectory = parentPackageName
    ? join(installRoot, "lib", "node_modules", parentPackageName, "node_modules", packageName)
    : join(installRoot, "lib", "node_modules", packageName);
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(join(packageDirectory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function fullCliSnapshotManifest(): BootstrapManifest {
  return {
    validation: {
      kind: "cli-bootstrap",
      packages: ["caplets", "@caplets/core", "@caplets/pi", "@caplets/opencode"],
    },
    releases: [
      { name: "caplets", newVersion: "1.0.0-dev-fixture-20260708120000" },
      { name: "@caplets/core", newVersion: "2.0.0-dev-fixture-20260708120000" },
      { name: "@caplets/pi", newVersion: "3.0.0-dev-fixture-20260708120000" },
      { name: "@caplets/opencode", newVersion: "4.0.0-dev-fixture-20260708120000" },
    ],
  };
}

describe("dev snapshot bootstrap helpers", () => {
  it("installs every promoted CLI closure package after bootstrapping caplets", () => {
    const manifest = fullCliSnapshotManifest();

    expect(deriveValidationPlan(manifest)).toEqual({
      kind: "cli-bootstrap",
      cliPackage: "caplets",
      expectedCorePackage: "@caplets/core",
      packages: ["caplets", "@caplets/core", "@caplets/pi", "@caplets/opencode"],
    });
    expect(buildValidationCommands(manifest)).toEqual([
      "npm install -g caplets@1.0.0-dev-fixture-20260708120000",
      "caplets --version",
      "caplets setup mcp-client --output ${INSTALL_ROOT}/caplets.mcp.json --format json",
      "npm install -g @caplets/pi@3.0.0-dev-fixture-20260708120000",
      "npm install -g @caplets/opencode@4.0.0-dev-fixture-20260708120000",
    ]);
  });

  it("propagates peer declarations from a synthetic public package", () => {
    const root = createTempDirectory("caplets-dev-snapshot-workspace-");
    const packageDirectory = join(root, "packages", "peer-host");
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(
      join(packageDirectory, "package.json"),
      `${JSON.stringify(
        {
          name: "@fixture/peer-host",
          version: "1.0.0",
          publishConfig: { access: "public" },
          peerDependencies: { "@fixture/agent-api": ">=2" },
        },
        null,
        2,
      )}\n`,
    );
    const manifest: BootstrapManifest = {
      validation: { kind: "package-only", packages: ["@fixture/peer-host"] },
      releases: [{ name: "@fixture/peer-host", newVersion: "1.0.1-dev-fixture" }],
    };

    expect(derivePackageOnlyTargets(manifest, root)).toEqual([
      {
        name: "@fixture/peer-host",
        peerDependencies: ["@fixture/agent-api"],
        validationKind: "install-only",
      },
    ]);
    expect(buildValidationCommands(manifest)).toEqual([
      "npm install -g @fixture/peer-host@1.0.1-dev-fixture",
    ]);
  });

  it("accepts npm's shallow global CLI layout with nested core and root closure packages", () => {
    const manifest = fullCliSnapshotManifest();
    const installRoot = createTempDirectory("caplets-dev-install-root-");
    const targets = new Map(
      derivePackageOnlyTargets(manifest).map((target) => [target.name, target]),
    );
    const installedManifest = (packageName: string, version: string) => ({
      name: packageName,
      version,
      peerDependencies: Object.fromEntries(
        (targets.get(packageName)?.peerDependencies ?? []).map((peerDependency) => [
          peerDependency,
          "*",
        ]),
      ),
    });

    writeInstalledPackage(
      installRoot,
      "caplets",
      installedManifest("caplets", "1.0.0-dev-fixture-20260708120000"),
    );
    writeInstalledPackage(
      installRoot,
      "@caplets/core",
      installedManifest("@caplets/core", "2.0.0-dev-fixture-20260708120000"),
      "caplets",
    );
    writeInstalledPackage(
      installRoot,
      "@caplets/pi",
      installedManifest("@caplets/pi", "3.0.0-dev-fixture-20260708120000"),
    );
    writeInstalledPackage(
      installRoot,
      "@caplets/opencode",
      installedManifest("@caplets/opencode", "4.0.0-dev-fixture-20260708120000"),
    );

    expect(assertInstalledSnapshotLine(manifest, installRoot)).toEqual([]);
  });

  it("rejects CLI manifests that omit an expected caplets or core snapshot version", () => {
    const completeManifest = fullCliSnapshotManifest();
    for (const missingPackage of ["caplets", "@caplets/core"]) {
      const installRoot = createTempDirectory("caplets-dev-install-root-");
      writeInstalledPackage(installRoot, "caplets", {
        name: "caplets",
        version: "1.0.0-dev-fixture-20260708120000",
      });
      writeInstalledPackage(
        installRoot,
        "@caplets/core",
        {
          name: "@caplets/core",
          version: "2.0.0-dev-fixture-20260708120000",
        },
        "caplets",
      );
      const manifest: BootstrapManifest = {
        ...completeManifest,
        releases: completeManifest.releases.filter((release) => release.name !== missingPackage),
      };

      const errors = assertInstalledSnapshotLine(manifest, installRoot);
      expect(errors.join("\n")).toMatch(
        new RegExp(
          `${missingPackage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*(?:version|release)|(?:version|release).*${missingPackage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
          "i",
        ),
      );
    }
  });

  it("keeps a caller-supplied validation root isolated across npm and user state", () => {
    const root = createTempDirectory("caplets-dev-validation-root-");
    const isolated = createIsolatedValidationEnv(root);

    const isolatedPaths = [
      isolated.env.HOME,
      isolated.env.USERPROFILE,
      isolated.env.npm_config_prefix,
      isolated.env.npm_config_cache,
      isolated.env.XDG_CONFIG_HOME,
      isolated.env.XDG_STATE_HOME,
      isolated.env.CAPLETS_CONFIG,
    ];
    expect(
      isolatedPaths.every(
        (path): path is string => typeof path === "string" && path.startsWith(root),
      ),
    ).toBe(true);
    expect(isolated.env.NO_COLOR).toBe("1");
  });

  it("reports the missing locations for globally installed CLI packages", () => {
    const installRoot = createTempDirectory("caplets-dev-install-root-");
    const errors = assertInstalledSnapshotLine(fullCliSnapshotManifest(), installRoot);

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          `caplets is not installed at ${join(installRoot, "lib", "node_modules", "caplets", "package.json")}`,
        ),
        expect.stringContaining(
          `@caplets/core is not installed at ${join(installRoot, "lib", "node_modules", "caplets", "node_modules", "@caplets", "core", "package.json")}`,
        ),
      ]),
    );
  });

  it("reports installed peer hosts that omit the package manifest's peer declarations", () => {
    const packageName = "@caplets/pi";
    const installRoot = createTempDirectory("caplets-dev-install-root-");
    const expectedPeers = Object.keys(
      JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "pi", "package.json"), "utf8"))
        .peerDependencies ?? {},
    );
    const manifest: BootstrapManifest = {
      validation: { kind: "package-only", packages: [packageName] },
      releases: [{ name: packageName, newVersion: "3.0.0-dev-fixture-20260708120000" }],
    };
    writeInstalledPackage(installRoot, packageName, {
      name: packageName,
      version: "3.0.0-dev-fixture-20260708120000",
    });

    expect(assertInstalledSnapshotLine(manifest, installRoot)).toEqual(
      expectedPeers.map(
        (peerDependency) =>
          `${packageName} is missing peer dependency declaration for ${peerDependency}.`,
      ),
    );
  });
});
