import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLI_PACKAGE_NAME,
  CORE_PACKAGE_NAME,
  listPublicPublishablePackages,
  readJson,
} from "./dev-snapshot-release.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function derivePackageOnlyTargets(snapshotManifest, root = repoRoot) {
  const publicPackages = new Map(
    listPublicPublishablePackages(root).map((entry) => [entry.name, entry.manifest]),
  );
  return (
    snapshotManifest.validation?.packages ??
    snapshotManifest.releases.map((release) => release.name)
  ).map((packageName) => {
    const manifest = publicPackages.get(packageName) ?? {};
    const peerDependencies = Object.keys(manifest.peerDependencies ?? {});
    return {
      name: packageName,
      peerDependencies,
      validationKind: "install-only",
    };
  });
}

export function deriveValidationPlan(snapshotManifest) {
  if (snapshotManifest.validation?.kind === "cli-bootstrap") {
    return {
      kind: "cli-bootstrap",
      cliPackage: CLI_PACKAGE_NAME,
      expectedCorePackage: CORE_PACKAGE_NAME,
      packages: snapshotManifest.validation.packages ?? [CLI_PACKAGE_NAME, CORE_PACKAGE_NAME],
    };
  }
  return {
    kind: "package-only",
    packages: derivePackageOnlyTargets(snapshotManifest),
  };
}

export function createIsolatedValidationEnv(
  baseDirectory = mkdtempSync(join(tmpdir(), "caplets-dev-snapshot-")),
) {
  const home = join(baseDirectory, "home");
  const npmPrefix = join(baseDirectory, "npm-prefix");
  const npmCache = join(baseDirectory, "npm-cache");
  const xdgConfig = join(baseDirectory, "xdg-config");
  const xdgState = join(baseDirectory, "xdg-state");
  const capletsConfig = join(baseDirectory, "caplets-config.json");
  return {
    baseDirectory,
    home,
    npmPrefix,
    npmCache,
    xdgConfig,
    xdgState,
    capletsConfig,
    env: {
      HOME: home,
      USERPROFILE: home,
      npm_config_prefix: npmPrefix,
      npm_config_cache: npmCache,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_STATE_HOME: xdgState,
      CAPLETS_CONFIG: capletsConfig,
      NO_COLOR: "1",
    },
  };
}

export function findInstalledPackageJson(installRoot, packageName, parentPackageName) {
  const globalModules = join(installRoot, "lib", "node_modules");
  if (parentPackageName) {
    return join(globalModules, parentPackageName, "node_modules", packageName, "package.json");
  }
  return join(globalModules, packageName, "package.json");
}

export function readInstalledPackageManifest(installRoot, packageName, parentPackageName) {
  const packageJsonPath = findInstalledPackageJson(installRoot, packageName, parentPackageName);
  return JSON.parse(readFileSync(packageJsonPath, "utf8"));
}

export function readInstalledPackageVersion(installRoot, packageName, parentPackageName) {
  const packageJson = readInstalledPackageManifest(installRoot, packageName, parentPackageName);
  return packageJson.version;
}

function assertInstalledTarget(errors, expectedVersions, installRoot, target, parentPackageName) {
  const expectedVersion = expectedVersions.get(target.name);
  if (!expectedVersion) return;
  try {
    const installedVersion = readInstalledPackageVersion(
      installRoot,
      target.name,
      parentPackageName,
    );
    if (installedVersion !== expectedVersion) {
      errors.push(
        `${target.name} installed version ${installedVersion} did not match expected ${expectedVersion}.`,
      );
    }
    if (target.peerDependencies.length > 0) {
      const installedManifest = readInstalledPackageManifest(
        installRoot,
        target.name,
        parentPackageName,
      );
      const installedPeers = installedManifest.peerDependencies ?? {};
      for (const peerDependency of target.peerDependencies) {
        if (typeof installedPeers[peerDependency] !== "string") {
          errors.push(
            `${target.name} is missing peer dependency declaration for ${peerDependency}.`,
          );
        }
      }
    }
  } catch (error) {
    errors.push(
      `${target.name} is not installed at ${findInstalledPackageJson(installRoot, target.name, parentPackageName)} (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

export function assertInstalledSnapshotLine(snapshotManifest, installRoot) {
  const errors = [];
  const expectedVersions = new Map(
    snapshotManifest.releases.map((release) => [release.name, release.newVersion]),
  );
  const plan = deriveValidationPlan(snapshotManifest);
  if (plan.kind === "cli-bootstrap") {
    for (const packageName of [CLI_PACKAGE_NAME, CORE_PACKAGE_NAME]) {
      if (!expectedVersions.get(packageName)) {
        errors.push(`Snapshot manifest is missing an expected version for ${packageName}.`);
      }
    }
  }
  for (const target of derivePackageOnlyTargets(snapshotManifest)) {
    const parentPackageName =
      plan.kind === "cli-bootstrap" && target.name === CORE_PACKAGE_NAME
        ? CLI_PACKAGE_NAME
        : undefined;
    assertInstalledTarget(errors, expectedVersions, installRoot, target, parentPackageName);
  }
  return errors;
}

export function buildValidationCommands(snapshotManifest, options = {}) {
  const versionByName = new Map(
    snapshotManifest.releases.map((release) => [release.name, release.newVersion]),
  );
  const installCommand = (packageName) => {
    const version = versionByName.get(packageName);
    if (!version) {
      throw new Error(`Missing snapshot version for ${packageName}.`);
    }
    return `npm install -g ${packageName}@${version}`;
  };
  const plan = deriveValidationPlan(snapshotManifest);
  const installRoot = options.installRoot ?? "${INSTALL_ROOT}";
  if (plan.kind === "cli-bootstrap") {
    if (!versionByName.get(CORE_PACKAGE_NAME)) {
      throw new Error(`Missing snapshot version for ${CORE_PACKAGE_NAME}.`);
    }
    return [
      installCommand(CLI_PACKAGE_NAME),
      `${CLI_PACKAGE_NAME} --version`,
      `${CLI_PACKAGE_NAME} setup mcp-client --output ${join(installRoot, "caplets.mcp.json")} --format json`,
      ...plan.packages
        .filter(
          (packageName) => packageName !== CLI_PACKAGE_NAME && packageName !== CORE_PACKAGE_NAME,
        )
        .map(installCommand),
    ];
  }
  return plan.packages.map((target) => installCommand(target.name));
}

function printJson(result) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseOptionMap(args) {
  const optionMap = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key?.startsWith("--")) continue;
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      optionMap.set(key.replace(/^--/, ""), "true");
      continue;
    }
    optionMap.set(key.replace(/^--/, ""), next);
    index += 1;
  }
  return optionMap;
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  const [subcommand = "plan", ...args] = process.argv.slice(2);
  const optionMap = parseOptionMap(args);
  if (subcommand === "plan") {
    const manifestPath = optionMap.get("manifest");
    if (!manifestPath) {
      console.error("Missing required --manifest option.");
      process.exit(1);
    }
    const manifest = readJson(manifestPath);
    printJson({
      validation: deriveValidationPlan(manifest),
      commands: buildValidationCommands(manifest),
    });
  } else if (subcommand === "assert-installed") {
    const manifestPath = optionMap.get("manifest");
    const installRoot = optionMap.get("install-root");
    if (!manifestPath) {
      console.error("Missing required --manifest option.");
      process.exit(1);
    }
    if (!installRoot) {
      console.error("Missing required --install-root option.");
      process.exit(1);
    }
    const manifest = readJson(manifestPath);
    const errors = assertInstalledSnapshotLine(manifest, installRoot);
    if (errors.length > 0) {
      console.error(errors.join("\n"));
      process.exit(1);
    }
    printJson({ ok: true });
  } else {
    console.error(`Unknown subcommand: ${subcommand}`);
    process.exit(1);
  }
}
