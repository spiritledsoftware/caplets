import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { hashInstalledArtifact } from "../../cli/install";
import {
  parseStrictJsonDocument,
  readCapletsLockfile,
  validateLockfileDestination,
  type CapletsLockEntry,
} from "../../cli/lockfile";
import { CapletsError, toSafeError } from "../../errors";
import { stableJsonStringify } from "../../stable-json";
import {
  mapLegacyRecord,
  type LegacyCanonicalRecord,
  type LegacyDomain,
  type LegacyMappingResult,
} from "./legacy-model";

export type LegacyReviewedSource = Readonly<{
  relativePath: string;
  domain: LegacyDomain;
}>;

export type LegacyPreservedSource = Readonly<{
  relativePath: string;
  kind: "file" | "directory";
}>;

export type VerifiedLegacyTrackedCaplet = Readonly<{
  entry: CapletsLockEntry;
  sourcePath: string;
  installedHash: string;
}>;

export type VerifiedLegacyRecord = Readonly<{
  domain: LegacyDomain;
  sourcePath: string;
  recordIndex: number;
  canonical: LegacyCanonicalRecord;
}>;

export type LegacyQuarantineRecord = Readonly<{
  domain: "operator-activity";
  sourcePath: string;
  recordIndex: number;
  sourceBytes: Buffer;
  rawDigest: string;
  reason: Extract<LegacyMappingResult, { status: "quarantined" }>["reason"];
  fields: readonly string[];
  auditProvenance: Readonly<{
    reader: "strict-legacy-v1";
    disposition: "preserved-in-protected-recovery";
  }>;
}>;

export type LegacySealedSourceIdentity = Readonly<{
  relativePath: string;
  kind: "file" | "directory";
}>;

export type LegacySealedSourceMapping = Readonly<{
  logicalPath: string;
  sealedPath: string;
  kind: "file" | "directory";
}>;

export type VerifiedLegacyMigrationSource = Readonly<{
  trackedCaplets: readonly VerifiedLegacyTrackedCaplet[];
  records: readonly VerifiedLegacyRecord[];
  quarantines: readonly LegacyQuarantineRecord[];
  manifestSha256: string;
}>;

export function readVerifiedLegacyMigrationSource(
  options: Readonly<{
    sealedRoot?: string;
    sealedSourceMappings?: readonly LegacySealedSourceMapping[];
    globalCapletsRoot: string;
    globalLockfilePath: string;
    reviewedSources: readonly LegacyReviewedSource[];
    sealedSourceIdentities: readonly LegacySealedSourceIdentity[];
    preservedSources?: readonly LegacyPreservedSource[];
  }>,
): VerifiedLegacyMigrationSource {
  const sourceResolver = createSealedSourceResolver(options);
  const globalCapletsLogicalRoot = normalizeLogicalSourcePath(
    options.globalCapletsRoot,
    "global Caplets root",
  );
  const globalLockfileLogicalPath = normalizeLogicalSourcePath(
    options.globalLockfilePath,
    "global Caplets lockfile",
  );
  const globalLockfilePath = sourceResolver.resolve(
    globalLockfileLogicalPath,
    "file",
    "global Caplets lockfile",
  );
  assertFatalUtf8(readFileSync(globalLockfilePath), "Global Caplets lockfile");
  const lockfile = readCapletsLockfile(globalLockfilePath);
  assertUniqueTrackedCapletProvenance(globalCapletsLogicalRoot, lockfile.entries);
  const trackedCaplets = lockfile.entries
    .map((entry) => verifyTrackedCaplet(sourceResolver, globalCapletsLogicalRoot, entry))
    .sort((left, right) => left.entry.id.localeCompare(right.entry.id));

  const records: VerifiedLegacyRecord[] = [];
  const quarantines: LegacyQuarantineRecord[] = [];
  const reviewed = [...options.reviewedSources].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  const seenReviewedPaths = new Set<string>();
  for (const source of reviewed) {
    if (seenReviewedPaths.has(source.relativePath)) {
      throw migrationRefusal(`Reviewed legacy source ${source.relativePath} is duplicated`);
    }
    seenReviewedPaths.add(source.relativePath);
    const sourcePath = sourceResolver.resolve(
      source.relativePath,
      "file",
      `reviewed ${source.domain} source`,
    );
    const sourceBytes = readFileSync(sourcePath);
    const raw = parseLegacyJson(sourceBytes, source.relativePath);
    const values = expandCurrentLegacyDocument(source.domain, raw, source.relativePath);
    for (const [recordIndex, value] of values.entries()) {
      const mapped = mapLegacyRecord(source.domain, value, { sourcePath: source.relativePath });
      if (mapped.status === "accepted") {
        records.push({
          domain: source.domain,
          sourcePath: source.relativePath,
          recordIndex,
          canonical: mapped.canonical,
        });
        continue;
      }
      if (source.domain !== "operator-activity") {
        throw migrationRefusal(
          `Authoritative legacy ${source.domain} source ${source.relativePath} is malformed`,
        );
      }
      quarantines.push({
        domain: "operator-activity",
        sourcePath: source.relativePath,
        recordIndex,
        sourceBytes,
        rawDigest: sha256(sourceBytes),
        reason: mapped.reason,
        fields: mapped.fields,
        auditProvenance: {
          reader: "strict-legacy-v1",
          disposition: "preserved-in-protected-recovery",
        },
      });
    }
  }
  const sourceClassification = assertCompleteSourceClassification({
    sourceResolver,
    globalCapletsLogicalRoot,
    globalLockfileLogicalPath,
    reviewed,
    preserved: options.preservedSources ?? [],
    trackedCapletLogicalRoots: lockfile.entries.map((entry) =>
      logicalLockfileDestination(globalCapletsLogicalRoot, entry),
    ),
    sealedSourceIdentities: options.sealedSourceIdentities,
  });

  const manifestSha256 = sha256(
    stableJsonStringify({
      version: 1,
      sourceClassification,
      trackedCaplets: trackedCaplets.map(({ entry, installedHash }) => ({
        entry,
        installedHash,
      })),
      records: records.map(({ domain, sourcePath, recordIndex, canonical }) => ({
        domain,
        sourcePath,
        recordIndex,
        canonical,
      })),
      quarantines: quarantines.map(
        ({ domain, sourcePath, recordIndex, rawDigest, reason, fields, auditProvenance }) => ({
          domain,
          sourcePath,
          recordIndex,
          rawDigest,
          reason,
          fields,
          auditProvenance,
        }),
      ),
    }),
  );
  return { trackedCaplets, records, quarantines, manifestSha256 };
}

function expandCurrentLegacyDocument(
  domain: LegacyDomain,
  raw: unknown,
  sourcePath: string,
): unknown[] {
  if (domain === "remote-server-state" && isPlainRecord(raw)) {
    const keys = Object.keys(raw).sort();
    if (
      keys.join(",") !== "clients,pairingCodes,pendingLogins,version" ||
      raw.version !== 1 ||
      !Array.isArray(raw.clients) ||
      !Array.isArray(raw.pairingCodes) ||
      !Array.isArray(raw.pendingLogins)
    ) {
      throw migrationRefusal(
        `Authoritative legacy remote-server-state source ${sourcePath} is malformed`,
      );
    }
    if (raw.pairingCodes.length > 0 || raw.pendingLogins.length > 0) {
      throw migrationRefusal(
        `Authoritative legacy remote-server-state source ${sourcePath} contains live pending authority`,
      );
    }
    return raw.clients.map((client) => {
      if (!isPlainRecord(client)) {
        throw migrationRefusal(
          `Authoritative legacy remote-server-state source ${sourcePath} is malformed`,
        );
      }
      return {
        serverId: client.clientId,
        role: client.role,
        status: client.revokedAt ? "revoked" : "active",
        hostUrl: client.hostUrl,
        clientLabel: client.clientLabel,
        lastAuthenticatedAt: client.lastUsedAt,
        revokedAt: client.revokedAt,
      };
    });
  }
  if (domain === "dashboard-session" && isPlainRecord(raw)) {
    if (
      Object.keys(raw).sort().join(",") !== "sessions,version" ||
      raw.version !== 1 ||
      !Array.isArray(raw.sessions)
    ) {
      throw migrationRefusal(
        `Authoritative legacy dashboard-session source ${sourcePath} is malformed`,
      );
    }
    return raw.sessions.map((session) => {
      if (!isPlainRecord(session)) {
        throw migrationRefusal(
          `Authoritative legacy dashboard-session source ${sourcePath} is malformed`,
        );
      }
      return {
        id: session.sessionId,
        clientId: session.operatorClientId,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        absoluteExpiresAt: session.expiresAt,
        idleExpiresAt: session.expiresAt,
        lastSeenAt: session.lastUsedAt,
        verifier: session.secretHash,
        csrfVerifier: session.csrfToken,
      };
    });
  }
  if (domain === "vault-value" && isPlainRecord(raw)) {
    const encodedName = basename(sourcePath, ".json");
    let referenceName: string;
    try {
      referenceName = decodeURIComponent(encodedName);
    } catch {
      throw migrationRefusal(
        `Authoritative legacy vault-value source ${sourcePath} has an invalid key name`,
      );
    }
    return [{ ...raw, referenceName, keyVersion: raw.keyVersion ?? 1 }];
  }
  if (domain === "remote-profile" && isPlainRecord(raw)) {
    if (typeof raw.profileKey === "string") {
      return [
        {
          id: `remote-profile-selection:${raw.profileKey}`,
          name: "Selected cloud workspace",
          url: raw.hostUrl,
          selectedWorkspace: raw.workspace,
          createdAt: raw.selectedAt,
          updatedAt: raw.selectedAt,
        },
      ];
    }
    const key = raw.key;
    const label =
      typeof raw.clientLabel === "string"
        ? raw.clientLabel
        : typeof raw.workspaceSlug === "string"
          ? raw.workspaceSlug
          : typeof raw.hostIdentity === "string"
            ? raw.hostIdentity
            : String(key);
    return [
      {
        id: `remote-profile:${key}`,
        name: label,
        url: raw.hostUrl,
        selectedWorkspace: raw.workspaceId,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
        ownerId: raw.workspaceId ?? raw.clientId,
      },
    ];
  }
  if (domain === "remote-profile-credential" && isPlainRecord(raw)) {
    let profileId: string;
    try {
      profileId = decodeURIComponent(basename(sourcePath, ".json"));
    } catch {
      throw migrationRefusal(
        `Authoritative legacy remote-profile-credential source ${sourcePath} has an invalid profile identity`,
      );
    }
    return [
      {
        profileId: `remote-profile-credential:${profileId}`,
        credential: stableJsonStringify(raw),
        expiresAt: raw.expiresAt,
        keyVersion: raw.keyVersion,
        ownerId: raw.ownerId,
      },
    ];
  }
  if (domain === "cloud-auth" && isPlainRecord(raw)) {
    return [
      {
        profileId: `cloud-auth:${raw.credentialFamilyId ?? raw.workspaceId}`,
        accessToken: raw.accessToken,
        refreshToken: raw.refreshToken,
        expiresAt: raw.expiresAt,
        workspace: raw.workspaceId,
        version: raw.version,
        keyVersion: raw.keyVersion,
      },
    ];
  }
  return Array.isArray(raw) ? raw : [raw];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function verifyTrackedCaplet(
  sourceResolver: SealedSourceResolver,
  globalCapletsLogicalRoot: string,
  entry: CapletsLockEntry,
): VerifiedLegacyTrackedCaplet {
  const logicalPath = logicalLockfileDestination(globalCapletsLogicalRoot, entry);
  const sourcePath = sourceResolver.resolve(
    logicalPath,
    entry.kind,
    `tracked global Caplet ${entry.id}`,
  );
  const stats = lstatForMigration(sourcePath, `tracked global Caplet ${entry.id}`);
  const expectedKind = entry.kind === "file" ? stats.isFile() : stats.isDirectory();
  if (!expectedKind || stats.isSymbolicLink()) {
    throw migrationRefusal(`Tracked global Caplet ${entry.id} does not match lockfile kind`);
  }
  assertNoSymlinks(sourcePath, entry.id);
  const installedHash = hashInstalledArtifact(sourcePath);
  if (installedHash !== entry.installedHash) {
    throw migrationRefusal(`Tracked global Caplet ${entry.id} does not match its installed hash`);
  }
  return { entry, sourcePath, installedHash };
}
function assertUniqueTrackedCapletProvenance(
  globalCapletsLogicalRoot: string,
  entries: readonly CapletsLockEntry[],
): void {
  const destinations: string[] = [];
  const sourceIdentities = new Set<string>();
  for (const entry of entries) {
    const destinationIdentity = logicalLockfileDestination(globalCapletsLogicalRoot, entry);
    if (
      destinations.some(
        (existing) =>
          existing === destinationIdentity ||
          logicalPathContains(existing, destinationIdentity) ||
          logicalPathContains(destinationIdentity, existing),
      )
    ) {
      throw migrationRefusal("Global Caplets lockfile contains a duplicate destination");
    }
    destinations.push(destinationIdentity);

    const sourceIdentity = stableJsonStringify(entry.source);
    if (sourceIdentities.has(sourceIdentity)) {
      throw migrationRefusal("Global Caplets lockfile contains a duplicate source identity");
    }
    sourceIdentities.add(sourceIdentity);
  }
}

type SealedSourceResolver = Readonly<{
  mapped: boolean;
  resolve(relativePath: string, kind: "file" | "directory", label: string): string;
}>;

function assertCompleteSourceClassification(
  input: Readonly<{
    sourceResolver: SealedSourceResolver;
    globalCapletsLogicalRoot: string;
    globalLockfileLogicalPath: string;
    reviewed: readonly LegacyReviewedSource[];
    preserved: readonly LegacyPreservedSource[];
    trackedCapletLogicalRoots: readonly string[];
    sealedSourceIdentities: readonly LegacySealedSourceIdentity[];
  }>,
): LegacySealedSourceIdentity[] {
  const reviewedPaths = input.reviewed.map((source) => ({
    ...source,
    logicalPath: normalizeLogicalSourcePath(
      source.relativePath,
      `reviewed ${source.domain} source`,
    ),
    path: input.sourceResolver.resolve(
      source.relativePath,
      "file",
      `reviewed ${source.domain} source`,
    ),
  }));
  const preservedPaths = input.preserved.map((source) => ({
    ...source,
    logicalPath: normalizeLogicalSourcePath(source.relativePath, "preserved legacy source"),
    path: input.sourceResolver.resolve(source.relativePath, source.kind, "preserved legacy source"),
  }));
  const classifiedFiles = new Set([
    ...reviewedPaths.map((source) => resolve(source.path)),
    ...preservedPaths.map((source) => resolve(source.path)),
  ]);
  const seenLogicalIdentities = new Set<string>();
  let globalRootClassified = false;
  let lockfileClassified = false;
  const preservedClassified = new Set<string>();
  const reviewedClassified = new Set<string>();
  const sourceClassification = [...input.sealedSourceIdentities].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );

  for (const identity of sourceClassification) {
    const rootIdentity = identity.relativePath === ".";
    if (rootIdentity) {
      if (identity.kind !== "directory" || seenLogicalIdentities.has(".")) {
        throw migrationRefusal("Sealed legacy source classification contains an invalid root");
      }
      seenLogicalIdentities.add(".");
      continue;
    }
    const logicalIdentity = normalizeLogicalSourcePath(
      identity.relativePath,
      "sealed source classification entry",
    );
    input.sourceResolver.resolve(
      logicalIdentity,
      identity.kind,
      "sealed source classification entry",
    );
    if (seenLogicalIdentities.has(logicalIdentity)) {
      throw migrationRefusal("Sealed legacy source classification contains a duplicate identity");
    }
    seenLogicalIdentities.add(logicalIdentity);
    let classified = false;
    if (logicalIdentity === input.globalCapletsLogicalRoot && identity.kind === "directory") {
      globalRootClassified = true;
      classified = true;
    } else if (
      logicalPathContains(input.globalCapletsLogicalRoot, logicalIdentity) &&
      input.trackedCapletLogicalRoots.some(
        (trackedRoot) =>
          logicalIdentity === trackedRoot ||
          logicalPathContains(trackedRoot, logicalIdentity) ||
          logicalPathContains(logicalIdentity, trackedRoot),
      )
    ) {
      globalRootClassified = true;
      classified = true;
    }
    if (logicalIdentity === input.globalLockfileLogicalPath && identity.kind === "file") {
      lockfileClassified = true;
      classified = true;
    }
    for (const reviewed of reviewedPaths) {
      if (
        logicalIdentity === reviewed.logicalPath ||
        (identity.kind === "directory" &&
          logicalPathContains(logicalIdentity, reviewed.logicalPath))
      ) {
        if (logicalIdentity === reviewed.logicalPath) reviewedClassified.add(reviewed.logicalPath);
        classified = true;
      }
    }
    for (const preserved of preservedPaths) {
      if (
        (logicalIdentity === preserved.logicalPath && identity.kind === preserved.kind) ||
        (identity.kind === "directory" &&
          logicalPathContains(logicalIdentity, preserved.logicalPath))
      ) {
        if (logicalIdentity === preserved.logicalPath)
          preservedClassified.add(preserved.logicalPath);
        classified = true;
      }
    }
    if (!classified) {
      throw migrationRefusal("Sealed legacy source classification contains an extra source");
    }
  }

  if (
    !globalRootClassified ||
    !lockfileClassified ||
    reviewedClassified.size !== reviewedPaths.length ||
    preservedClassified.size !== preservedPaths.length
  ) {
    throw migrationRefusal("Sealed legacy source classification is incomplete");
  }

  if (!input.sourceResolver.mapped) {
    const reviewedParents = new Set(reviewedPaths.map((source) => resolve(source.path, "..")));
    for (const parent of reviewedParents) {
      for (const path of listRegularFiles(parent, "reviewed legacy source directory")) {
        if (!classifiedFiles.has(resolve(path))) {
          throw migrationRefusal("Sealed legacy source contains an unclassified runtime source");
        }
      }
    }
  }
  return sourceClassification;
}

function normalizeLogicalSourcePath(path: string, label: string): string {
  const normalized = path.split(/[\\/]/u).join("/");
  if (
    !normalized ||
    isAbsolute(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw migrationRefusal(`${label} must be a confined logical path`);
  }
  return normalized;
}

function logicalPathContains(parent: string, candidate: string): boolean {
  return candidate.startsWith(`${parent}/`);
}

function logicalLockfileDestination(
  globalCapletsLogicalRoot: string,
  entry: CapletsLockEntry,
): string {
  const virtualRoot = resolve(".caplets-sealed-logical-root");
  let destination: string;
  try {
    destination = validateLockfileDestination(virtualRoot, entry.destination);
  } catch (error) {
    throw migrationRefusal(`Tracked global Caplet ${entry.id} has an unsafe destination`, error);
  }
  const suffix = relative(virtualRoot, destination).split(sep).join("/");
  return normalizeLogicalSourcePath(
    `${globalCapletsLogicalRoot}/${suffix}`,
    `tracked global Caplet ${entry.id}`,
  );
}

function listRegularFiles(path: string, label: string): string[] {
  const stats = lstatForMigration(path, label);
  if (stats.isSymbolicLink()) throw migrationRefusal(`${label} contains a symbolic link`);
  if (stats.isFile()) return [path];
  if (!stats.isDirectory()) throw migrationRefusal(`${label} contains an unsupported file kind`);
  const files: string[] = [];
  for (const entry of readdirSync(path).sort()) {
    files.push(...listRegularFiles(join(path, entry), label));
  }
  return files;
}

function createSealedSourceResolver(
  options: Readonly<{
    sealedRoot?: string;
    sealedSourceMappings?: readonly LegacySealedSourceMapping[];
  }>,
): SealedSourceResolver {
  if (!options.sealedSourceMappings?.length) {
    if (!options.sealedRoot) {
      throw migrationRefusal("A sealed legacy root or canonical source mapping is required");
    }
    const root = requireSealedRoot(options.sealedRoot);
    return {
      mapped: false,
      resolve(relativePath, kind, label) {
        return confinedExistingPath(root, relativePath, kind, label);
      },
    };
  }
  if (options.sealedRoot !== undefined) {
    throw migrationRefusal(
      "A sealed legacy root cannot be combined with canonical source mappings",
    );
  }
  const mappings = options.sealedSourceMappings
    .map((mapping) => ({
      logicalPath: mapping.logicalPath.split(/[\\/]/u).join("/"),
      sealedPath: resolve(mapping.sealedPath),
      kind: mapping.kind,
    }))
    .sort((left, right) => right.logicalPath.length - left.logicalPath.length);
  for (const [index, mapping] of mappings.entries()) {
    const isRootMapping = mapping.logicalPath === ".";
    if (
      !mapping.logicalPath ||
      isAbsolute(mapping.logicalPath) ||
      (!isRootMapping &&
        mapping.logicalPath.split("/").some((part) => !part || part === "." || part === "..")) ||
      mappings.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          (isRootMapping ||
            other.logicalPath === "." ||
            other.logicalPath === mapping.logicalPath ||
            other.logicalPath.startsWith(`${mapping.logicalPath}/`) ||
            mapping.logicalPath.startsWith(`${other.logicalPath}/`)),
      )
    ) {
      throw migrationRefusal("Canonical sealed source mappings must be unique and non-overlapping");
    }
    const stats = lstatForMigration(mapping.sealedPath, "canonical sealed source mapping");
    if (
      stats.isSymbolicLink() ||
      (mapping.kind === "file" ? !stats.isFile() : !stats.isDirectory())
    ) {
      throw migrationRefusal("Canonical sealed source mapping does not match its reviewed type");
    }
    assertNoSymlinksInMappedSource(mapping.sealedPath, "canonical sealed source mapping");
  }
  return {
    mapped: true,
    resolve(relativePath, kind, label) {
      const logicalPath = relativePath.split(/[\\/]/u).join("/");
      if (
        !logicalPath ||
        isAbsolute(logicalPath) ||
        logicalPath.split("/").some((part) => !part || part === "." || part === "..")
      ) {
        throw migrationRefusal(`${label} must be a confined logical path`);
      }
      const mapping = mappings.find(
        (candidate) =>
          candidate.logicalPath === "." ||
          logicalPath === candidate.logicalPath ||
          logicalPath.startsWith(`${candidate.logicalPath}/`),
      );
      if (!mapping || (mapping.kind === "file" && logicalPath !== mapping.logicalPath)) {
        throw migrationRefusal(`${label} is absent from the canonical sealed source mapping`);
      }
      const suffix =
        mapping.logicalPath === "."
          ? logicalPath
          : logicalPath === mapping.logicalPath
            ? ""
            : logicalPath.slice(mapping.logicalPath.length + 1);
      const candidate = suffix ? resolve(mapping.sealedPath, suffix) : mapping.sealedPath;
      if (suffix)
        assertPathChainHasNoSymlink(mapping.sealedPath, suffix.split("/").join(sep), label);
      const stats = lstatForMigration(candidate, label);
      if ((kind === "file" && !stats.isFile()) || (kind === "directory" && !stats.isDirectory())) {
        throw migrationRefusal(`${label} is not a ${kind}`);
      }
      return candidate;
    },
  };
}

function assertNoSymlinksInMappedSource(path: string, label: string): void {
  const stats = lstatForMigration(path, label);
  if (stats.isSymbolicLink()) throw migrationRefusal(`${label} contains a symbolic link`);
  if (!stats.isDirectory()) return;
  for (const entry of readdirSync(path).sort()) {
    assertNoSymlinksInMappedSource(join(path, entry), label);
  }
}

function requireSealedRoot(path: string): string {
  const root = resolve(path);
  const stats = lstatForMigration(root, "sealed legacy root");
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw migrationRefusal("Sealed legacy root must be a real directory");
  }
  return realpathSync(root);
}

function assertFatalUtf8(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw migrationRefusal(`${label} is not valid UTF-8`, error);
  }
}

function confinedExistingPath(
  root: string,
  relativePath: string,
  kind: "file" | "directory",
  label: string,
): string {
  if (!relativePath || isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes("..")) {
    throw migrationRefusal(`${label} must be a confined relative path`);
  }
  const candidate = resolve(root, relativePath);
  const relativeCandidate = relative(root, candidate);
  if (
    relativeCandidate === "" ||
    relativeCandidate.startsWith(`..${sep}`) ||
    relativeCandidate === ".." ||
    isAbsolute(relativeCandidate)
  ) {
    throw migrationRefusal(`${label} escapes the sealed legacy root`);
  }
  assertPathChainHasNoSymlink(root, relativeCandidate, label);
  const stats = lstatForMigration(candidate, label);
  if ((kind === "file" && !stats.isFile()) || (kind === "directory" && !stats.isDirectory())) {
    throw migrationRefusal(`${label} is not a ${kind}`);
  }
  return candidate;
}

function assertPathChainHasNoSymlink(root: string, relativePath: string, label: string): void {
  let current = root;
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    current = join(current, segment);
    const stats = lstatForMigration(current, label);
    if (stats.isSymbolicLink()) throw migrationRefusal(`${label} traverses a symbolic link`);
  }
}

function assertNoSymlinks(path: string, capletId: string): void {
  const stats = lstatForMigration(path, `tracked global Caplet ${capletId}`);
  if (stats.isSymbolicLink()) {
    throw migrationRefusal(`Tracked global Caplet ${capletId} contains a symbolic link`);
  }
  if (!stats.isDirectory()) return;
  for (const entry of readdirSync(path).sort()) assertNoSymlinks(join(path, entry), capletId);
}

function lstatForMigration(path: string, label: string): Stats {
  try {
    return lstatSync(path);
  } catch (error) {
    throw migrationRefusal(`${label} is missing or unreadable`, error);
  }
}

function parseLegacyJson(bytes: Buffer, sourcePath: string): unknown {
  return parseStrictJsonDocument(
    assertFatalUtf8(bytes, `Reviewed legacy source ${sourcePath}`),
    `Reviewed legacy source ${sourcePath}`,
  );
}

function migrationRefusal(message: string, cause?: unknown): CapletsError {
  return new CapletsError(
    "CONFIG_INVALID",
    message,
    cause ? { cause: toSafeError(cause) } : undefined,
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export type LegacyMigrationMutexLease = Readonly<{
  release(): Promise<void>;
}>;

export async function acquireLegacyMigrationMutex(
  path: string,
): Promise<LegacyMigrationMutexLease> {
  const processStart = readProcessStartIdentity(process.pid);
  if (!processStart) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Legacy storage migration mutex cannot prove the current process identity",
    );
  }

  let descriptor: number | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      descriptor = openSync(path, "wx", 0o600);
      const lock = { version: 1, pid: process.pid, processStart, lockId: randomUUID() };
      writeFileSync(descriptor, `${stableJsonStringify(lock)}\n`, { encoding: "utf8" });
      fsyncSync(descriptor);
      break;
    } catch (error) {
      if (descriptor !== undefined) {
        const ownedIdentity = fstatSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        removeMutexIfIdentityMatches(path, ownedIdentity);
      } else if (isNodeErrorCode(error, "EEXIST") && removeCrashStaleMutex(path)) {
        continue;
      }
      throw mutexUnavailable();
    }
  }
  if (descriptor === undefined) throw mutexUnavailable();

  const identity = fstatSync(descriptor);
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      closeSync(descriptor);
      try {
        const current = lstatSync(path);
        if (current.dev !== identity.dev || current.ino !== identity.ino) {
          throw new CapletsError(
            "REQUEST_INVALID",
            "Legacy storage migration mutex identity changed before release",
          );
        }
        unlinkSync(path);
      } catch (error) {
        if (error instanceof CapletsError) throw error;
        throw new CapletsError(
          "REQUEST_INVALID",
          "Legacy storage migration mutex could not be released safely",
        );
      }
    },
  };
}

function removeCrashStaleMutex(path: string): boolean {
  let identity: Stats;
  let contents: string;
  try {
    identity = lstatSync(path);
    if (
      !identity.isFile() ||
      identity.isSymbolicLink() ||
      (identity.mode & 0o077) !== 0 ||
      (process.getuid && identity.uid !== process.getuid())
    ) {
      return false;
    }
    contents = readFileSync(path, "utf8");
    const afterRead = lstatSync(path);
    if (afterRead.dev !== identity.dev || afterRead.ino !== identity.ino) return false;
  } catch {
    return false;
  }
  const lock = parseMutexOwner(contents);
  if (!lock) return false;

  const liveStart = readProcessStartIdentity(lock.pid);
  if (liveStart === lock.processStart) return false;
  if (liveStart === undefined && processIsAlive(lock.pid)) return false;

  try {
    const currentContents = readFileSync(path, "utf8");
    const current = lstatSync(path);
    if (
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      currentContents !== contents
    ) {
      return false;
    }
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function parseMutexOwner(contents: string):
  | Readonly<{
      pid: number;
      processStart: string;
      lockId: string;
    }>
  | undefined {
  let value: unknown;
  try {
    value = parseStrictJsonDocument(contents, "Legacy migration mutex");
  } catch {
    return undefined;
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("pid" in value) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !("processStart" in value) ||
    typeof value.processStart !== "string" ||
    value.processStart.length === 0 ||
    !("lockId" in value) ||
    typeof value.lockId !== "string" ||
    value.lockId.length === 0
  ) {
    return undefined;
  }
  return { pid: value.pid, processStart: value.processStart, lockId: value.lockId };
}

const CURRENT_PROCESS_START_IDENTITY =
  readProcProcessStartIdentity(process.pid) ?? `opaque-${randomUUID()}`;

function readProcessStartIdentity(pid: number): string | undefined {
  return (
    readProcProcessStartIdentity(pid) ??
    (pid === process.pid ? CURRENT_PROCESS_START_IDENTITY : undefined)
  );
}

function readProcProcessStartIdentity(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close < 0) return undefined;
    const fields = stat
      .slice(close + 2)
      .trim()
      .split(/\s+/u);
    const start = fields[19];
    return start && /^\d+$/u.test(start) ? start : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeErrorCode(error, "EPERM");
  }
}

function removeMutexIfIdentityMatches(path: string, identity: Stats): void {
  try {
    const current = lstatSync(path);
    if (current.dev === identity.dev && current.ino === identity.ino) unlinkSync(path);
  } catch {
    // The failed acquisition still refuses even if conservative cleanup cannot complete.
  }
}

function mutexUnavailable(): CapletsError {
  return new CapletsError(
    "REQUEST_INVALID",
    "Another legacy storage migration may be running; exclusive migration mutex unavailable",
  );
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}

export type LegacyInitializationFaultPoint =
  | "after-process-handle-exclusion"
  | "after-source-relocation"
  | "after-tombstone-publication"
  | "after-source-rehash"
  | "after-backup-chunk"
  | "after-schema"
  | "after-entity-insert"
  | "after-staged-commit"
  | "after-invalidation"
  | "after-verification"
  | "after-authority-token-activation"
  | "after-finalization";

export type LegacyMigrationMetadata =
  | Readonly<{
      kind: "fresh";
      migrationId: string;
      manifestSha256: string;
      activationId: string;
    }>
  | Readonly<{
      kind: "legacy";
      migrationId: string;
      manifestSha256: string;
      protectedBundleId: string;
      exclusionCleanupId: string;
      activationId: string;
    }>;

export type LegacyMigrationExclusionLease = Readonly<{
  sealedSource: Readonly<{
    path: string;
    manifestSha256: string;
    cleanupId: string;
    identities: readonly LegacySealedSourceIdentity[];
    sources?: readonly Readonly<{
      logicalPath: string;
      path: string;
      kind: "file" | "directory";
      identities: readonly LegacySealedSourceIdentity[];
    }>[];
  }>;
  tombstonePaths: readonly string[];
  initialEvidence: unknown;
  verifyFinalScanAndRehash(): Promise<
    Readonly<{
      manifestSha256: string;
      platformEvidence: unknown;
    }>
  >;
  rollbackBeforeActivation(): Promise<void>;
  completeActivation(
    input: Readonly<{
      protectedRecoveryDurable: true;
      metadata: Extract<LegacyMigrationMetadata, { kind: "legacy" }>;
    }>,
  ): Promise<void>;
  release(): Promise<void>;
}>;

export type U6ProtectedLegacyRecord = Readonly<{
  domain: LegacyDomain;
  sourcePath: string;
  recordIndex: number;
  canonical: LegacyCanonicalRecord;
  protection: Readonly<{
    verifiedBy: "u6";
    commitment: string;
  }>;
}>;

export type LegacyInitializationEntity =
  | Readonly<{ kind: "tracked-caplet"; value: VerifiedLegacyTrackedCaplet }>
  | Readonly<{ kind: "legacy-record"; value: U6ProtectedLegacyRecord }>
  | Readonly<{ kind: "quarantine"; value: LegacyQuarantineRecord }>;

export type LegacyDestinationOperation = Readonly<{
  migrationId: string;
  fencingToken: number;
}>;

export interface LegacyInitializationDestination {
  readonly backend: "sqlite" | "postgres";
  inspect(operation: LegacyDestinationOperation): Promise<
    Readonly<{
      state: "empty" | "inactive" | "active" | "finalized";
      metadata?: LegacyMigrationMetadata | undefined;
    }>
  >;
  assertCanInitialize(
    input: Readonly<{
      operation: LegacyDestinationOperation;
      metadata: LegacyMigrationMetadata;
    }>,
  ): Promise<void>;
  beginInactive(
    input: Readonly<{
      operation: LegacyDestinationOperation;
      metadata: LegacyMigrationMetadata;
    }>,
  ): Promise<void>;
  stageEntity(
    input: Readonly<{
      operation: LegacyDestinationOperation;
      entity: LegacyInitializationEntity;
    }>,
  ): Promise<void>;
  commitInactive(operation: LegacyDestinationOperation): Promise<void>;
  invalidateAuthority(operation: LegacyDestinationOperation): Promise<void>;
  verifyInactive(
    input: Readonly<{
      operation: LegacyDestinationOperation;
      source: VerifiedLegacyMigrationSource;
      protectedRecords: readonly U6ProtectedLegacyRecord[];
    }>,
  ): Promise<void>;
  activateAuthority(
    input: Readonly<{
      operation: LegacyDestinationOperation;
      metadata: LegacyMigrationMetadata;
    }>,
  ): Promise<Readonly<{ authorityToken: string }>>;
  resolveActivation(
    input: Readonly<{
      operation: LegacyDestinationOperation;
      activationId: string;
    }>,
  ): Promise<
    | Readonly<{ status: "activated"; authorityToken: string }>
    | Readonly<{ status: "not-activated" }>
  >;
  finalize(
    input: Readonly<{
      operation: LegacyDestinationOperation;
      metadata: LegacyMigrationMetadata;
    }>,
  ): Promise<void>;
  abortInactive(operation: LegacyDestinationOperation): Promise<void>;
}

export type LegacyMigrationElectionLease = Readonly<{
  fencingToken: number;
  renew(): Promise<boolean>;
  release(): Promise<void>;
}>;

type LegacyMigrationElection = Readonly<{
  tryElect(): Promise<LegacyMigrationElectionLease | undefined>;
}>;

export type LegacyControlPlaneInitializationOptions = {
  backend: "sqlite" | "postgres";
  mode: "automatic" | "offline";
  migrationId: string;
  source: Readonly<{
    sourceBoundaryPath: string;
    mutablePaths: readonly Readonly<{
      relativePath: string;
      kind: "file" | "directory";
    }>[];
    offlineSourcePaths?: readonly Readonly<{
      sourcePath: string;
      logicalPath: string;
      kind: "file" | "directory";
    }>[];
    globalCapletsRoot: string;
    globalLockfilePath: string;
    reviewedSources: readonly LegacyReviewedSource[];
    preservedSources?: readonly LegacyPreservedSource[];
  }>;
  destination: LegacyInitializationDestination;
  election: LegacyMigrationElection;
  mutex: Readonly<{
    acquire(): Promise<Readonly<{ release(): Promise<void> }>>;
  }>;
  acquireExclusion(
    input: Readonly<{
      sourceBoundaryPath: string;
      mutablePaths: readonly Readonly<{
        relativePath: string;
        kind: "file" | "directory";
      }>[];
      offlineSourcePaths?: readonly Readonly<{
        sourcePath: string;
        logicalPath: string;
        kind: "file" | "directory";
      }>[];
      mode: "automatic" | "offline";
    }>,
  ): Promise<LegacyMigrationExclusionLease>;
  resumePostActivation(
    metadata: Extract<LegacyMigrationMetadata, { kind: "legacy" }>,
  ): Promise<void>;
  protectedRecovery: Readonly<{
    protect(
      input: Readonly<{
        migrationId: string;
        source: VerifiedLegacyMigrationSource;
        sealedSource: LegacyMigrationExclusionLease["sealedSource"];
      }>,
    ): Promise<Readonly<{ durable: true; bundleId: string }>>;
  }>;
  credentialProtection: Readonly<{
    protectAndVerify(record: VerifiedLegacyRecord): Promise<U6ProtectedLegacyRecord>;
  }>;
  fault?: (
    point: LegacyInitializationFaultPoint,
    detail?: Readonly<{ entityIndex?: number; entityKind?: LegacyInitializationEntity["kind"] }>,
  ) => void | Promise<void>;
};

export type LegacyControlPlaneInitializationResult =
  | Readonly<{
      status: "migrated" | "already-migrated";
      backend: "sqlite" | "postgres";
      authorityToken?: string | undefined;
      manifestSha256?: string | undefined;
    }>
  | Readonly<{
      status: "not-ready";
      backend: "postgres";
      reason: "migration-election";
    }>;

export type FreshControlPlaneInitializationOptions = Readonly<{
  backend: "sqlite" | "postgres";
  destination: LegacyInitializationDestination;
  election: LegacyMigrationElection;
  mutex: Readonly<{
    acquire(): Promise<Readonly<{ release(): Promise<void> }>>;
  }>;
  fault?: (
    point: LegacyInitializationFaultPoint,
    detail?: Readonly<{ entityIndex?: number; entityKind?: LegacyInitializationEntity["kind"] }>,
  ) => void | Promise<void>;
}>;

export async function runFreshControlPlaneInitialization(
  options: FreshControlPlaneInitializationOptions,
): Promise<LegacyControlPlaneInitializationResult> {
  if (options.destination.backend !== options.backend) {
    throw migrationRefusal("Fresh initialization destination backend does not match configuration");
  }
  const electionLease = await acquireInitializationElection(options.backend, options.election);
  if (options.backend === "postgres" && !electionLease) {
    return { status: "not-ready", backend: "postgres", reason: "migration-election" };
  }
  const electionRenewal = keepInitializationElectionAlive(electionLease);
  let mutex: Readonly<{ release(): Promise<void> }> | undefined;
  let primaryFailure = false;
  const migrationId = "fresh-v1";
  const emptySource: VerifiedLegacyMigrationSource = {
    trackedCaplets: [],
    records: [],
    quarantines: [],
    manifestSha256: sha256(
      stableJsonStringify({ version: 1, trackedCaplets: [], records: [], quarantines: [] }),
    ),
  };
  const metadata: Extract<LegacyMigrationMetadata, { kind: "fresh" }> = {
    kind: "fresh",
    migrationId,
    manifestSha256: emptySource.manifestSha256,
    activationId: activationIdFor({
      kind: "fresh",
      migrationId,
      manifestSha256: emptySource.manifestSha256,
    }),
  };
  let activationMayHaveCommitted = false;
  try {
    mutex = await options.mutex.acquire();
    const existing = await options.destination.inspect(
      await destinationOperation(migrationId, electionLease),
    );
    if (existing.state === "finalized") {
      const existingMetadata = requireFreshMetadata(existing.metadata, migrationId);
      return {
        status: "already-migrated",
        backend: options.backend,
        manifestSha256: existingMetadata.manifestSha256,
      };
    }
    if (existing.state === "active") {
      const existingMetadata = requireFreshMetadata(existing.metadata, migrationId);
      const resolved = await options.destination.resolveActivation({
        operation: await destinationOperation(migrationId, electionLease),
        activationId: existingMetadata.activationId,
      });
      if (resolved.status !== "activated") {
        throw migrationRefusal("Active fresh initialization has no committed activation outcome");
      }
      await options.destination.finalize({
        operation: await destinationOperation(migrationId, electionLease),
        metadata: existingMetadata,
      });
      return {
        status: "already-migrated",
        backend: options.backend,
        authorityToken: resolved.authorityToken,
        manifestSha256: existingMetadata.manifestSha256,
      };
    }
    if (existing.state === "inactive") {
      requireFreshMetadata(existing.metadata, migrationId);
      await options.destination.abortInactive(
        await destinationOperation(migrationId, electionLease),
      );
    }
    await options.destination.assertCanInitialize({
      operation: await destinationOperation(migrationId, electionLease),
      metadata,
    });
    await options.destination.beginInactive({
      operation: await destinationOperation(migrationId, electionLease),
      metadata,
    });
    await options.fault?.("after-schema");
    await options.destination.commitInactive(
      await destinationOperation(migrationId, electionLease),
    );
    await options.fault?.("after-staged-commit");
    await options.destination.invalidateAuthority(
      await destinationOperation(migrationId, electionLease),
    );
    await options.fault?.("after-invalidation");
    await options.destination.verifyInactive({
      operation: await destinationOperation(migrationId, electionLease),
      source: emptySource,
      protectedRecords: [],
    });
    await options.fault?.("after-verification");

    activationMayHaveCommitted = true;
    let activation: Readonly<{ authorityToken: string }>;
    try {
      activation = await options.destination.activateAuthority({
        operation: await destinationOperation(migrationId, electionLease),
        metadata,
      });
    } catch (error) {
      const resolved = await options.destination.resolveActivation({
        operation: await destinationOperation(migrationId, electionLease),
        activationId: metadata.activationId,
      });
      if (resolved.status !== "activated") {
        activationMayHaveCommitted = false;
        throw error;
      }
      activation = resolved;
    }
    await options.fault?.("after-authority-token-activation");
    await options.destination.finalize({
      operation: await destinationOperation(migrationId, electionLease),
      metadata,
    });
    await options.fault?.("after-finalization");
    return {
      status: "migrated",
      backend: options.backend,
      authorityToken: activation.authorityToken,
      manifestSha256: emptySource.manifestSha256,
    };
  } catch (error) {
    primaryFailure = true;
    if (!activationMayHaveCommitted && mutex) {
      await settle(async () => {
        await options.destination.abortInactive(
          await destinationOperation(migrationId, electionLease),
        );
      });
    }
    throw error;
  } finally {
    await electionRenewal.stop();
    await releaseInitializationResources(
      [mutex, electionLease].filter(isReleasable),
      primaryFailure,
    );
  }
}

export async function runLegacyControlPlaneInitialization(
  options: LegacyControlPlaneInitializationOptions,
): Promise<LegacyControlPlaneInitializationResult> {
  if (options.destination.backend !== options.backend) {
    throw migrationRefusal("Legacy migration destination backend does not match configuration");
  }
  const electionLease = await acquireInitializationElection(options.backend, options.election);
  if (options.backend === "postgres" && !electionLease) {
    return { status: "not-ready", backend: "postgres", reason: "migration-election" };
  }
  const electionRenewal = keepInitializationElectionAlive(electionLease);

  let mutex: Readonly<{ release(): Promise<void> }> | undefined;
  let exclusion: LegacyMigrationExclusionLease | undefined;
  let activationMayHaveCommitted = false;
  let primaryFailure = false;
  try {
    mutex = await options.mutex.acquire();
    const existing = await options.destination.inspect(
      await destinationOperation(options.migrationId, electionLease),
    );
    if (existing.state === "finalized") {
      const metadata = requireLegacyMetadata(existing.metadata, options.migrationId);
      return {
        status: "already-migrated",
        backend: options.backend,
        manifestSha256: metadata.manifestSha256,
      };
    }
    if (existing.state === "active") {
      const metadata = requireLegacyMetadata(existing.metadata, options.migrationId);
      const resolved = await options.destination.resolveActivation({
        operation: await destinationOperation(options.migrationId, electionLease),
        activationId: metadata.activationId,
      });
      if (resolved.status !== "activated") {
        throw migrationRefusal("Active legacy migration has no committed activation outcome");
      }
      await destinationOperation(options.migrationId, electionLease);
      await options.resumePostActivation(metadata);
      await options.destination.finalize({
        operation: await destinationOperation(options.migrationId, electionLease),
        metadata,
      });
      return {
        status: "already-migrated",
        backend: options.backend,
        authorityToken: resolved.authorityToken,
        manifestSha256: metadata.manifestSha256,
      };
    }
    if (existing.state === "inactive") {
      requireLegacyMetadata(existing.metadata, options.migrationId);
      await options.destination.abortInactive(
        await destinationOperation(options.migrationId, electionLease),
      );
    }

    exclusion = await options.acquireExclusion({
      sourceBoundaryPath: options.source.sourceBoundaryPath,
      mutablePaths: options.source.mutablePaths,
      ...(options.source.offlineSourcePaths
        ? { offlineSourcePaths: options.source.offlineSourcePaths }
        : {}),
      mode: options.mode,
    });
    requireNonemptyMetadataValue(exclusion.sealedSource.cleanupId, "exclusion cleanup identity");
    await options.fault?.("after-process-handle-exclusion");
    await options.fault?.("after-source-relocation");
    await options.fault?.("after-tombstone-publication");

    const source = readVerifiedLegacyMigrationSource({
      ...(exclusion.sealedSource.sources?.length
        ? {
            sealedSourceMappings: exclusion.sealedSource.sources.map((mapping) => ({
              logicalPath: mapping.logicalPath,
              sealedPath: mapping.path,
              kind: mapping.kind,
            })),
          }
        : { sealedRoot: exclusion.sealedSource.path }),
      globalCapletsRoot: options.source.globalCapletsRoot,
      globalLockfilePath: options.source.globalLockfilePath,
      reviewedSources: options.source.reviewedSources,
      ...(options.source.preservedSources
        ? { preservedSources: options.source.preservedSources }
        : {}),
      sealedSourceIdentities: exclusion.sealedSource.identities,
    });
    const initialRehash = await exclusion.verifyFinalScanAndRehash();
    if (initialRehash.manifestSha256 !== exclusion.sealedSource.manifestSha256) {
      throw migrationRefusal("Sealed legacy source changed after namespace closure");
    }
    await options.fault?.("after-source-rehash");

    const protectedRecovery = await options.protectedRecovery.protect({
      migrationId: options.migrationId,
      source,
      sealedSource: exclusion.sealedSource,
    });
    if (protectedRecovery.durable !== true) {
      throw migrationRefusal("Protected legacy recovery is not durable");
    }
    requireNonemptyMetadataValue(protectedRecovery.bundleId, "protected recovery bundle identity");
    await options.fault?.("after-backup-chunk");

    const metadataWithoutActivation = {
      kind: "legacy" as const,
      migrationId: options.migrationId,
      manifestSha256: source.manifestSha256,
      protectedBundleId: protectedRecovery.bundleId,
      exclusionCleanupId: exclusion.sealedSource.cleanupId,
    };
    const metadata: Extract<LegacyMigrationMetadata, { kind: "legacy" }> = {
      ...metadataWithoutActivation,
      activationId: activationIdFor(metadataWithoutActivation),
    };
    const protectedRecords = await protectLegacyRecords(
      source.records,
      options.credentialProtection,
    );

    await options.destination.assertCanInitialize({
      operation: await destinationOperation(options.migrationId, electionLease),
      metadata,
    });
    await options.destination.beginInactive({
      operation: await destinationOperation(options.migrationId, electionLease),
      metadata,
    });
    await options.fault?.("after-schema");

    const entities: LegacyInitializationEntity[] = [
      ...source.trackedCaplets.map(
        (value): LegacyInitializationEntity => ({ kind: "tracked-caplet", value }),
      ),
      ...orderedLegacyRecords(protectedRecords).map(
        (value): LegacyInitializationEntity => ({ kind: "legacy-record", value }),
      ),
    ];
    for (const [entityIndex, entity] of entities.entries()) {
      await options.destination.stageEntity({
        operation: await destinationOperation(options.migrationId, electionLease),
        entity,
      });
      await options.fault?.("after-entity-insert", { entityIndex, entityKind: entity.kind });
    }
    await options.destination.commitInactive(
      await destinationOperation(options.migrationId, electionLease),
    );
    await options.fault?.("after-staged-commit");
    await options.destination.invalidateAuthority(
      await destinationOperation(options.migrationId, electionLease),
    );
    await options.fault?.("after-invalidation");
    await options.destination.verifyInactive({
      operation: await destinationOperation(options.migrationId, electionLease),
      source,
      protectedRecords,
    });

    const finalRehash = await exclusion.verifyFinalScanAndRehash();
    if (finalRehash.manifestSha256 !== exclusion.sealedSource.manifestSha256) {
      throw migrationRefusal("Sealed legacy source changed before authority activation");
    }
    await options.fault?.("after-verification");

    activationMayHaveCommitted = true;
    let activation: Readonly<{ authorityToken: string }>;
    try {
      activation = await options.destination.activateAuthority({
        operation: await destinationOperation(options.migrationId, electionLease),
        metadata,
      });
    } catch (error) {
      const resolved = await options.destination.resolveActivation({
        operation: await destinationOperation(options.migrationId, electionLease),
        activationId: metadata.activationId,
      });
      if (resolved.status !== "activated") {
        activationMayHaveCommitted = false;
        throw error;
      }
      activation = resolved;
    }
    await options.fault?.("after-authority-token-activation");
    await exclusion.completeActivation({ protectedRecoveryDurable: true, metadata });
    await options.destination.finalize({
      operation: await destinationOperation(options.migrationId, electionLease),
      metadata,
    });
    await options.fault?.("after-finalization");
    return {
      status: "migrated",
      backend: options.backend,
      authorityToken: activation.authorityToken,
      manifestSha256: source.manifestSha256,
    };
  } catch (error) {
    primaryFailure = true;
    if (!activationMayHaveCommitted && exclusion) {
      const acquiredExclusion = exclusion;
      await settle(async () => {
        await options.destination.abortInactive(
          await destinationOperation(options.migrationId, electionLease),
        );
      });
      await settle(() => acquiredExclusion.rollbackBeforeActivation());
    }
    throw error;
  } finally {
    await electionRenewal.stop();
    await releaseInitializationResources(
      [exclusion, mutex, electionLease].filter(isReleasable),
      primaryFailure,
    );
  }
}

async function acquireInitializationElection(
  backend: "sqlite" | "postgres",
  election: LegacyMigrationElection,
): Promise<LegacyMigrationElectionLease | undefined> {
  if (backend === "sqlite") return undefined;
  const lease = await election.tryElect();
  if (lease && (!Number.isSafeInteger(lease.fencingToken) || lease.fencingToken <= 0)) {
    await settle(() => lease.release());
    throw migrationRefusal("Postgres migration election returned an invalid fencing token");
  }
  return lease;
}

type LegacyMigrationElectionRenewal = Readonly<{ stop(): Promise<void> }>;
const expiredElectionLeases = new WeakSet<LegacyMigrationElectionLease>();

function keepInitializationElectionAlive(
  lease: LegacyMigrationElectionLease | undefined,
): LegacyMigrationElectionRenewal {
  if (!lease) return { stop: async () => undefined };
  let stopped = false;
  let renewal = Promise.resolve();
  const timer = setInterval(() => {
    renewal = renewal.then(async () => {
      if (stopped) return;
      try {
        if (!(await lease.renew())) expiredElectionLeases.add(lease);
      } catch {
        expiredElectionLeases.add(lease);
      }
    });
  }, 5_000);
  timer.unref();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await renewal;
    },
  };
}

async function destinationOperation(
  migrationId: string,
  lease: LegacyMigrationElectionLease | undefined,
): Promise<LegacyDestinationOperation> {
  if (lease && (expiredElectionLeases.has(lease) || !(await lease.renew()))) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Postgres migration election lease expired before destination operation",
    );
  }
  return { migrationId, fencingToken: lease?.fencingToken ?? 0 };
}

type ActivationMetadataInput =
  | Omit<Extract<LegacyMigrationMetadata, { kind: "fresh" }>, "activationId">
  | Omit<Extract<LegacyMigrationMetadata, { kind: "legacy" }>, "activationId">;

function activationIdFor(metadata: ActivationMetadataInput): string {
  return sha256(stableJsonStringify(metadata));
}

function requireFreshMetadata(
  metadata: LegacyMigrationMetadata | undefined,
  migrationId: string,
): Extract<LegacyMigrationMetadata, { kind: "fresh" }> {
  if (
    !metadata ||
    metadata.kind !== "fresh" ||
    metadata.migrationId !== migrationId ||
    !isNonemptyMetadataValue(metadata.manifestSha256) ||
    !isNonemptyMetadataValue(metadata.activationId) ||
    metadata.activationId !==
      activationIdFor({
        kind: metadata.kind,
        migrationId: metadata.migrationId,
        manifestSha256: metadata.manifestSha256,
      })
  ) {
    throw migrationRefusal("Fresh initialization metadata is missing or divergent");
  }
  return metadata;
}

function requireLegacyMetadata(
  metadata: LegacyMigrationMetadata | undefined,
  migrationId: string,
): Extract<LegacyMigrationMetadata, { kind: "legacy" }> {
  if (
    !metadata ||
    metadata.kind !== "legacy" ||
    metadata.migrationId !== migrationId ||
    !isNonemptyMetadataValue(metadata.manifestSha256) ||
    !isNonemptyMetadataValue(metadata.protectedBundleId) ||
    !isNonemptyMetadataValue(metadata.exclusionCleanupId) ||
    !isNonemptyMetadataValue(metadata.activationId) ||
    metadata.activationId !==
      activationIdFor({
        kind: metadata.kind,
        migrationId: metadata.migrationId,
        manifestSha256: metadata.manifestSha256,
        protectedBundleId: metadata.protectedBundleId,
        exclusionCleanupId: metadata.exclusionCleanupId,
      })
  ) {
    throw migrationRefusal("Legacy migration metadata is missing or divergent");
  }
  return metadata;
}

function requireNonemptyMetadataValue(value: string, label: string): void {
  if (!isNonemptyMetadataValue(value)) throw migrationRefusal(`${label} is missing`);
}

function isNonemptyMetadataValue(value: string): boolean {
  return value.trim().length > 0;
}

async function protectLegacyRecords(
  records: readonly VerifiedLegacyRecord[],
  protection: LegacyControlPlaneInitializationOptions["credentialProtection"],
): Promise<U6ProtectedLegacyRecord[]> {
  const protectedRecords: U6ProtectedLegacyRecord[] = [];
  for (const record of records) {
    const protectedRecord = await protection.protectAndVerify(record);
    if (
      protectedRecord.domain !== record.domain ||
      protectedRecord.sourcePath !== record.sourcePath ||
      protectedRecord.recordIndex !== record.recordIndex ||
      protectedRecord.canonical.kind !== record.canonical.kind ||
      stableJsonStringify(protectedRecord.canonical.identity) !==
        stableJsonStringify(record.canonical.identity) ||
      protectedRecord.protection.verifiedBy !== "u6" ||
      !isNonemptyMetadataValue(protectedRecord.protection.commitment)
    ) {
      throw migrationRefusal("U6 legacy credential protection proof is missing or divergent");
    }
    protectedRecords.push(protectedRecord);
  }
  return protectedRecords;
}

export function orderedLegacyRecords(
  records: readonly U6ProtectedLegacyRecord[],
): U6ProtectedLegacyRecord[] {
  return [...records].sort(
    (left, right) =>
      legacyEntityStageRank(left.canonical.kind) - legacyEntityStageRank(right.canonical.kind),
  );
}

function legacyEntityStageRank(kind: string): number {
  switch (kind) {
    case "client":
    case "host-setting":
    case "oauth-token":
    case "credential":
    case "vault-value":
    case "project-binding-workspace":
    case "authority-version":
      return 0;
    case "dashboard-session":
    case "vault-grant":
    case "project-binding-lease":
    case "project-binding-receipt":
    case "operator-activity":
    case "caplet-provenance":
      return 1;
    default:
      return 2;
  }
}

async function settle(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch {
    // Preserve the primary migration failure while still attempting ordered rollback.
  }
}

function isReleasable(
  value: Readonly<{ release(): Promise<void> }> | undefined,
): value is Readonly<{ release(): Promise<void> }> {
  return value !== undefined;
}

async function releaseInitializationResources(
  resources: readonly Readonly<{ release(): Promise<void> }>[],
  primaryFailure: boolean,
): Promise<void> {
  const outcomes = await Promise.allSettled(resources.map(async (resource) => resource.release()));
  if (primaryFailure) return;
  const failed = outcomes.find((outcome) => outcome.status === "rejected");
  if (failed?.status === "rejected") {
    throw migrationRefusal("Legacy migration resource release failed", failed.reason);
  }
}
