export type BootstrapReleaseEntry = {
  name: string;
  newVersion: string;
};
export type BootstrapManifest = {
  validation:
    | { kind: "cli-bootstrap"; packages: string[] }
    | { kind: "package-only"; packages: string[] };
  releases: BootstrapReleaseEntry[];
};

export type PackageOnlyTarget = {
  name: string;
  peerDependencies: string[];
  validationKind: "install-only";
};

export type CliBootstrapValidationPlan = {
  kind: "cli-bootstrap";
  cliPackage: string;
  expectedCorePackage: string;
  packages: string[];
};

export type PackageOnlyValidationPlan = {
  kind: "package-only";
  packages: PackageOnlyTarget[];
};

export type ValidationPlan = CliBootstrapValidationPlan | PackageOnlyValidationPlan;

export type IsolatedValidationEnv = {
  baseDirectory: string;
  home: string;
  npmPrefix: string;
  npmCache: string;
  xdgConfig: string;
  xdgState: string;
  capletsConfig: string;
  env: Record<string, string>;
};

export function derivePackageOnlyTargets(
  snapshotManifest: BootstrapManifest,
  root?: string,
): PackageOnlyTarget[];
export function deriveValidationPlan(snapshotManifest: BootstrapManifest): ValidationPlan;
export function createIsolatedValidationEnv(baseDirectory?: string): IsolatedValidationEnv;
export function findInstalledPackageJson(
  installRoot: string,
  packageName: string,
  parentPackageName?: string,
): string;
export function readInstalledPackageManifest(
  installRoot: string,
  packageName: string,
  parentPackageName?: string,
): Record<string, unknown>;
export function readInstalledPackageVersion(
  installRoot: string,
  packageName: string,
  parentPackageName?: string,
): string;
export function assertInstalledSnapshotLine(
  snapshotManifest: BootstrapManifest,
  installRoot: string,
): string[];
export function buildValidationCommands(
  snapshotManifest: BootstrapManifest,
  options?: { installRoot?: string },
): string[];
