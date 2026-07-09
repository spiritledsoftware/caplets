export type WorkspacePackageEntry = {
  name: string;
  version: string | undefined;
  private: boolean;
  publishAccess: string | undefined;
  path: string;
  directory: string;
  manifest: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    publishConfig?: { access?: string };
    private?: boolean;
    version?: string;
  };
};

export type ReleaseEntry = {
  name: string;
  directory: string;
  oldVersion?: string;
  newVersion: string;
  type?: string;
  changesets?: string[];
  direct?: boolean;
  integrity?: string;
  tarball?: string;
};

export type ValidationMode =
  | {
      kind: "cli-bootstrap";
      packages: string[];
    }
  | {
      kind: "package-only";
      packages: string[];
    };

export type SnapshotManifest = {
  hasPublicReleases?: boolean;
  releases: ReleaseEntry[];
  validation?: ValidationMode;
  fingerprint?: string;
  sourceCommit?: string;
  stagingTag?: string;
  recoveryAction?: "fresh" | "reuse-staged" | "skip-promoted";
  changesetFiles?: string[];
};

export type SnapshotIdentityManifest = SnapshotManifest & {
  fingerprint: string;
  sourceCommit: string;
  stagingTag: string;
};

export type RegistryVersion = {
  name?: unknown;
  version?: unknown;
  capletsSnapshot?: unknown;
  dist?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
  peerDependencies?: unknown;
  [key: string]: unknown;
};

export type RegistryPackument = {
  "dist-tags"?: Record<string, unknown>;
  versions?: Record<string, RegistryVersion>;
  [key: string]: unknown;
};

export type RegistryPackuments = Record<string, RegistryPackument>;

export type RecoveredSnapshotManifest = SnapshotIdentityManifest & {
  releases: Array<ReleaseEntry & { integrity: string; tarball: string }>;
};

export type RegistrySnapshotClassification =
  | {
      action: "fresh";
      stagingTag: string;
      manifest: SnapshotIdentityManifest;
    }
  | {
      action: "reuse-staged";
      stagingTag: string;
      manifest: RecoveredSnapshotManifest;
    }
  | {
      action: "skip-promoted";
      stagingTag: string;
      manifest: RecoveredSnapshotManifest;
    };

export type PublicRegistryResponse = {
  ok: boolean;
  status?: number;
  json(): Promise<RegistryPackument>;
};

export type RecoverSnapshotOptions = {
  maxAttempts?: number;
  requiredAction?: RegistrySnapshotClassification["action"];
  pollIntervalMs?: number;
  fetchImplementation?: (
    url: string,
    init: { headers: { Accept: string; "Cache-Control": string } },
  ) => Promise<PublicRegistryResponse>;
};

export const CLI_PACKAGE_NAME: string;
export const CORE_PACKAGE_NAME: string;
export const OPENCODE_PACKAGE_NAME: string;
export const PI_PACKAGE_NAME: string;

export function createStagingTag(fingerprint: string, runIdentity: string): string;
export function readJson(path: string): unknown;
export function writeJson(path: string, value: unknown): void;
export function discoverWorkspacePackageManifests(root?: string): WorkspacePackageEntry[];
export function isPublicPublishableManifest(entry: WorkspacePackageEntry): boolean;
export function listPublicPublishablePackages(root?: string): WorkspacePackageEntry[];
export function expandPublicReleaseClosure(
  releaseNames: string[],
  manifests: WorkspacePackageEntry[],
): string[];
export function buildWorkspaceDependencyGraph(
  manifests: WorkspacePackageEntry[],
): Map<string, Set<string>>;
export function chooseValidationMode(releaseNames: string[]): ValidationMode;
export function toSnapshotVersion(baseVersion: string, commit: string, timestamp: string): string;
export function deriveChangesetManifest(
  statusJson: { releases?: Array<Record<string, unknown>> },
  options?: { manifests?: WorkspacePackageEntry[]; repoRoot?: string },
): SnapshotManifest;
export function listChangesetFiles(root?: string): string[];
export function collectRelevantFingerprintFiles(
  manifest: SnapshotManifest,
  root?: string,
): string[];
export function computeRelevantFingerprint(manifest: SnapshotManifest, root?: string): string;
export function withFingerprint(
  manifest: SnapshotManifest,
  root?: string,
): SnapshotManifest & { fingerprint: string; changesetFiles: string[] };
export function patchSnapshotConfig(root?: string): Record<string, unknown>;
export function writePatchedSnapshotConfig(root?: string): Record<string, unknown>;
export function refreshSnapshotManifestVersions(
  snapshotManifest: SnapshotManifest,
  root?: string,
): SnapshotManifest;
export function rewriteClosureManifests(snapshotManifest: SnapshotManifest, root?: string): void;
export function assertRewrittenClosure(snapshotManifest: SnapshotManifest, root?: string): string[];
export function parseArgs(argv: string[]): { subcommand: string; options: Map<string, string> };
export function stampSnapshotMetadata(
  snapshotManifest: SnapshotIdentityManifest,
  root?: string,
): {
  schema: 1;
  fingerprint: string;
  sourceCommit: string;
  stagingTag: string;
  releases: Record<string, string>;
};
export function classifyRegistrySnapshot(
  snapshotManifest: SnapshotIdentityManifest,
  packuments: RegistryPackuments,
): RegistrySnapshotClassification;
export function fetchPublicPackument(
  packageName: string,
  fetchImplementation?: RecoverSnapshotOptions["fetchImplementation"],
): Promise<RegistryPackument>;
export function recoverSnapshotManifest(
  snapshotManifest: SnapshotIdentityManifest,
  options?: RecoverSnapshotOptions,
): Promise<RegistrySnapshotClassification>;
export function runCli(argv?: string[]): Promise<unknown>;
