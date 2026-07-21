import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import { canonicalizeCurrentHostOrigin } from "../current-host/origin";
import { DEFAULT_AUTH_DIR } from "../config/paths";
import { CapletsError } from "../errors";
import { FileRemoteCredentialStore, parseRemoteProfileCredential } from "./credential-store";
import {
  remoteProfileKey,
  remoteProfileStatus,
  type RemoteProfileCredential,
  type RemoteProfileStatus,
} from "./profiles";

const PROFILE_LOCK_DIR = "remote-profiles.lock";
const PROFILE_REFRESH_LOCK_DIR = "remote-profile-refresh-locks";
const DEFAULT_LOCK_TIMEOUT_MS = 20_000;
const DEFAULT_LEASE_DURATION_MS = 5_000;
const DEFAULT_RENEW_INTERVAL_MS = 1_000;
const LOCK_OWNER_FILE = "owner.json";

export type SaveRemoteProfileInput = {
  origin: string;
  hostIdentity?: string | undefined;
  clientId: string;
  clientLabel?: string | undefined;
  credentials: RemoteProfileCredential;
  now?: Date | undefined;
};

export type RemoteProfileLookup = {
  origin: string;
  hostIdentity?: string | undefined;
};

export type RefreshRemoteProfileInput = RemoteProfileLookup & {
  needsRefresh: (credential: RemoteProfileCredential) => boolean;
  refresh: (
    status: RemoteProfileStatus,
    credential: RemoteProfileCredential,
  ) => Promise<SaveRemoteProfileInput>;
};

export type RemoteProfileWithCredential = {
  status: RemoteProfileStatus;
  credential: RemoteProfileCredential;
};
export interface RemoteProfileStore {
  saveRemoteProfile(input: SaveRemoteProfileInput): Promise<RemoteProfileStatus>;
  getRemoteProfileStatus(input: RemoteProfileLookup): Promise<RemoteProfileStatus | undefined>;
  refreshRemoteProfileIfNeeded(
    input: RefreshRemoteProfileInput,
  ): Promise<RemoteProfileWithCredential | undefined>;
  logoutRemoteProfile(input: RemoteProfileLookup): Promise<boolean>;
  listRemoteProfileStatuses(): Promise<RemoteProfileStatus[]>;
}

export type RemoteProfileLeaseOptions = {
  acquireTimeoutMs?: number | undefined;
  durationMs?: number | undefined;
  renewIntervalMs?: number | undefined;
};

type ResolvedRemoteProfileLeaseOptions = {
  acquireTimeoutMs: number;
  durationMs: number;
  renewIntervalMs: number;
};

export type RemoteProfileStoreFaultPoint =
  | "before-credential-write"
  | "after-credential-write"
  | "after-credential-flush"
  | "before-credential-rename"
  | "after-credential-rename"
  | "before-profile-write"
  | "after-profile-write"
  | "after-profile-flush"
  | "before-profile-rename"
  | "after-profile-rename"
  | "before-verification"
  | "after-verification"
  | "before-legacy-profile-delete"
  | "after-legacy-profile-delete"
  | "before-legacy-credential-delete"
  | "after-legacy-credential-delete";

export type RemoteProfileStoreOptions = {
  root?: string | undefined;
  credentials?: FileRemoteCredentialStore | undefined;
  lease?: RemoteProfileLeaseOptions | undefined;
  faultInjection?: ((point: RemoteProfileStoreFaultPoint) => void) | undefined;
};

export type CreateRemoteProfileStoreOptions = {
  authDir?: string | undefined;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined;
};

type StoredRemoteProfile = {
  version: 2;
  key: string;
  origin: string;
  hostIdentity?: string | undefined;
  clientId: string;
  clientLabel?: string | undefined;
  createdAt: string;
  updatedAt: string;
};

type LegacySelfHostedProfile = {
  version: 1;
  kind: "self-hosted";
  key: string;
  hostUrl: string;
  hostIdentity?: string | undefined;
  clientId: string;
  clientLabel?: string | undefined;
  createdAt: string;
  updatedAt: string;
};

type PreparedMigration = {
  legacyKey: string;
  legacyProfilePath: string;
  legacyCredentialPath: string;
  rawCredential: Buffer;
  profile: StoredRemoteProfile;
  destinationProfilePath: string;
  destinationCredentialPath: string;
  state: "new" | "credential-committed" | "committed";
};

type LockOwner = {
  version: 1;
  token: string;
  pid: number;
  hostname: string;
  processStartedAt?: string | undefined;
  acquiredAt: number;
  leaseExpiresAt: number;
};

type Lease = {
  path: string;
  owner: LockOwner;
  timer: NodeJS.Timeout;
  lost: CapletsError | undefined;
};

export function createRemoteProfileStore(
  options: CreateRemoteProfileStoreOptions = {},
): FileRemoteProfileStore {
  return new FileRemoteProfileStore({
    root: join(options.authDir ?? DEFAULT_AUTH_DIR, "remote-profiles"),
  });
}

export class FileRemoteProfileStore implements RemoteProfileStore {
  readonly root: string;
  private readonly credentialStore: FileRemoteCredentialStore;
  private readonly leaseOptions: ResolvedRemoteProfileLeaseOptions;
  private readonly faultInjection: ((point: RemoteProfileStoreFaultPoint) => void) | undefined;

  constructor(options: RemoteProfileStoreOptions = {}) {
    this.root = options.root ?? join(DEFAULT_AUTH_DIR, "remote-profiles");
    this.credentialStore =
      options.credentials ??
      new FileRemoteCredentialStore({ root: join(this.root, "credentials") });
    this.leaseOptions = {
      acquireTimeoutMs: options.lease?.acquireTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      durationMs: options.lease?.durationMs ?? DEFAULT_LEASE_DURATION_MS,
      renewIntervalMs: options.lease?.renewIntervalMs ?? DEFAULT_RENEW_INTERVAL_MS,
    };
    this.faultInjection = options.faultInjection;
  }

  async saveRemoteProfile(input: SaveRemoteProfileInput): Promise<RemoteProfileStatus> {
    const origin = canonicalizeCurrentHostOrigin(input.origin);
    return await this.withMutationLock(async (assertOwned) => {
      await this.migrateLegacyProfiles();
      assertOwned();
      return await this.writeRemoteProfile({ ...input, origin });
    });
  }

  async getRemoteProfileStatus(
    input: RemoteProfileLookup,
  ): Promise<RemoteProfileStatus | undefined> {
    const origin = canonicalizeCurrentHostOrigin(input.origin);
    return await this.withMutationLock(async () => {
      await this.migrateLegacyProfiles();
      const status = await this.statusByKey(remoteProfileKey({ origin }));
      assertHostIdentityMatches(status, input.hostIdentity);
      return status;
    });
  }

  async refreshRemoteProfileIfNeeded(
    input: RefreshRemoteProfileInput,
  ): Promise<RemoteProfileWithCredential | undefined> {
    const origin = canonicalizeCurrentHostOrigin(input.origin);
    const key = remoteProfileKey({ origin });
    const snapshot = await this.withMutationLock(async () => {
      await this.migrateLegacyProfiles();
      return await this.refreshSnapshot(key, input);
    });
    if (!snapshot || !snapshot.needsRefresh) return snapshot?.result;

    return await this.withRefreshLock(key, async (assertRefreshOwned) => {
      const lockedSnapshot = await this.withMutationLock(async () => {
        await this.migrateLegacyProfiles();
        return await this.refreshSnapshot(key, input);
      });
      if (!lockedSnapshot || !lockedSnapshot.needsRefresh) return lockedSnapshot?.result;

      const refreshed = await input.refresh(
        lockedSnapshot.result.status,
        lockedSnapshot.result.credential,
      );
      const refreshedOrigin = canonicalizeCurrentHostOrigin(refreshed.origin);
      if (refreshedOrigin !== origin) {
        throw new CapletsError(
          "AUTH_FAILED",
          "Refreshed Remote Profile belongs to a different origin.",
        );
      }
      assertRefreshOwned();
      return await this.withMutationLock(async (assertMutationOwned) => {
        const current = await this.refreshSnapshot(key, input);
        if (!current || !current.needsRefresh) return current?.result;
        assertRefreshOwned();
        assertMutationOwned();
        const status = await this.writeRemoteProfile({ ...refreshed, origin });
        const credential = await this.credentialStore.load(status.key);
        if (!credential?.accessToken) return undefined;
        return { status, credential };
      });
    });
  }

  async logoutRemoteProfile(input: RemoteProfileLookup): Promise<boolean> {
    const origin = canonicalizeCurrentHostOrigin(input.origin);
    return await this.withMutationLock(async (assertOwned) => {
      const key = remoteProfileKey({ origin });
      const profile = this.readStoredProfile(this.profilePath(key), key, false);
      if (profile) {
        const status = await this.statusFor(profile);
        assertHostIdentityMatches(status, input.hostIdentity);
      }
      assertOwned();
      const removedCredential = await this.credentialStore.delete(key);
      const removedProfile = removePathIfPresent(this.profilePath(key));
      const removedLegacy = this.removeLegacyLeftovers(origin);
      flushDirectory(this.profilesDir());
      flushDirectory(this.credentialStore.root);
      return removedCredential || removedProfile || removedLegacy;
    });
  }

  async listRemoteProfileStatuses(): Promise<RemoteProfileStatus[]> {
    return await this.withMutationLock(async () => {
      await this.migrateLegacyProfiles();
      const statuses = await Promise.all(
        this.qualifiedKeys(this.profilesDir(), "remote:").map(async ({ key, path }) => {
          const profile = this.readStoredProfile(path, key, true);
          if (!profile) throw invalidProfileState();
          return await this.statusFor(profile);
        }),
      );
      return statuses.sort((left, right) => left.origin.localeCompare(right.origin));
    });
  }

  private async refreshSnapshot(
    key: string,
    input: Pick<RefreshRemoteProfileInput, "hostIdentity" | "needsRefresh">,
  ): Promise<{ needsRefresh: boolean; result: RemoteProfileWithCredential } | undefined> {
    const profile = this.readStoredProfile(this.profilePath(key), key, false);
    if (!profile) return undefined;
    const credential = await this.credentialStore.load(key);
    if (!credential?.accessToken) return undefined;
    const status = remoteProfileStatus({ ...profile, credential });
    assertHostIdentityMatches(status, input.hostIdentity);
    return { needsRefresh: input.needsRefresh(credential), result: { status, credential } };
  }

  private async writeRemoteProfile(input: SaveRemoteProfileInput): Promise<RemoteProfileStatus> {
    const origin = canonicalizeCurrentHostOrigin(input.origin);
    const key = remoteProfileKey({ origin });
    const now = (input.now ?? new Date()).toISOString();
    const existing = this.readStoredProfile(this.profilePath(key), key, false);
    const hostIdentity = input.hostIdentity ?? existing?.hostIdentity;
    const profile: StoredRemoteProfile = {
      version: 2,
      key,
      origin,
      ...(hostIdentity ? { hostIdentity } : {}),
      clientId: input.clientId,
      ...(input.clientLabel ? { clientLabel: input.clientLabel } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.credentialStore.save(key, input.credentials);
    this.writeJsonAtomically(this.profilePath(key), profile);
    return remoteProfileStatus({ ...profile, credential: input.credentials });
  }

  private async statusByKey(key: string): Promise<RemoteProfileStatus | undefined> {
    const profile = this.readStoredProfile(this.profilePath(key), key, false);
    return profile ? await this.statusFor(profile) : undefined;
  }

  private async statusFor(profile: StoredRemoteProfile): Promise<RemoteProfileStatus> {
    return remoteProfileStatus({
      ...profile,
      credential: await this.credentialStore.load(profile.key),
    });
  }

  private async migrateLegacyProfiles(): Promise<void> {
    const profileEntries = this.qualifiedKeys(this.profilesDir(), "self-hosted:");
    const credentialEntries = this.qualifiedKeys(this.credentialStore.root, "self-hosted:");
    if (profileEntries.length === 0 && credentialEntries.length === 0) return;

    const credentialsByKey = new Map(credentialEntries.map((entry) => [entry.key, entry.path]));
    const profileKeys = new Set(profileEntries.map((entry) => entry.key));
    const prepared: PreparedMigration[] = [];
    for (const entry of profileEntries) {
      const legacy = this.readLegacyProfile(entry.path, entry.key);
      const legacyCredentialPath = credentialsByKey.get(entry.key);
      if (!legacyCredentialPath) throw invalidLegacyState();
      const rawCredential = readRegularFile(legacyCredentialPath, true);
      validateRawCredential(rawCredential);
      const origin = canonicalizeLegacyOrigin(legacy.hostUrl);
      const key = remoteProfileKey({ origin });
      prepared.push({
        legacyKey: entry.key,
        legacyProfilePath: entry.path,
        legacyCredentialPath,
        rawCredential,
        profile: {
          version: 2,
          key,
          origin,
          ...(legacy.hostIdentity ? { hostIdentity: legacy.hostIdentity } : {}),
          clientId: legacy.clientId,
          ...(legacy.clientLabel ? { clientLabel: legacy.clientLabel } : {}),
          createdAt: legacy.createdAt,
          updatedAt: legacy.updatedAt,
        },
        destinationProfilePath: this.profilePath(key),
        destinationCredentialPath: this.credentialStore.pathForKey(key),
        state: "new",
      });
    }

    const byOrigin = new Map<string, PreparedMigration[]>();
    for (const candidate of prepared) {
      const group = byOrigin.get(candidate.profile.origin) ?? [];
      group.push(candidate);
      byOrigin.set(candidate.profile.origin, group);
    }
    if ([...byOrigin.values()].some((group) => group.length > 1)) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "Multiple legacy Remote Profiles resolve to the same origin.",
      );
    }

    for (const candidate of prepared) this.preflightMigration(candidate);
    const orphans = credentialEntries.filter((entry) => !profileKeys.has(entry.key));
    for (const orphan of orphans) this.preflightOrphanCredential(orphan.key, orphan.path);

    for (const candidate of prepared) this.commitMigration(candidate);
    for (const orphan of orphans) rmSync(orphan.path, { force: true });
  }

  private preflightMigration(candidate: PreparedMigration): void {
    const destinationProfile = readOptionalRegularFile(candidate.destinationProfilePath);
    const destinationCredential = readOptionalRegularFile(candidate.destinationCredentialPath);
    if (destinationProfile) {
      if (!destinationCredential) throw invalidProfileState();
      const parsed = parseStoredRemoteProfileJson(destinationProfile, candidate.profile.key);
      validateRawCredential(destinationCredential);
      if (
        !storedProfilesEqual(parsed, candidate.profile) ||
        !destinationCredential.equals(candidate.rawCredential)
      ) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "Legacy Remote Profile conflicts with an existing generic profile.",
        );
      }
      candidate.state = "committed";
      return;
    }
    if (destinationCredential) {
      validateRawCredential(destinationCredential);
      if (!destinationCredential.equals(candidate.rawCredential)) {
        throw new CapletsError(
          "REQUEST_INVALID",
          "Legacy Remote Profile conflicts with an existing generic credential.",
        );
      }
      candidate.state = "credential-committed";
    }
  }

  private preflightOrphanCredential(legacyKey: string, path: string): void {
    const origin = canonicalizeLegacyOrigin(legacyKey.slice("self-hosted:".length));
    const key = remoteProfileKey({ origin });
    const rawLegacy = readRegularFile(path, true);
    const destinationProfile = readOptionalRegularFile(this.profilePath(key));
    const destinationCredential = readOptionalRegularFile(this.credentialStore.pathForKey(key));
    if (!destinationProfile || !destinationCredential) throw invalidLegacyState();
    const profile = parseStoredRemoteProfileJson(destinationProfile, key);
    validateRawCredential(rawLegacy);
    validateRawCredential(destinationCredential);
    if (profile.origin !== origin || !rawLegacy.equals(destinationCredential)) {
      throw invalidLegacyState();
    }
  }

  private commitMigration(candidate: PreparedMigration): void {
    const tempId = createHash("sha256").update(candidate.legacyKey).digest("hex").slice(0, 16);
    if (candidate.state === "new") {
      this.writeMigrationFile(
        candidate.destinationCredentialPath,
        candidate.rawCredential,
        tempId,
        "credential",
      );
    }
    if (candidate.state !== "committed") {
      const profileBytes = Buffer.from(`${JSON.stringify(candidate.profile, null, 2)}\n`);
      this.writeMigrationFile(candidate.destinationProfilePath, profileBytes, tempId, "profile");
    }

    this.fault("before-verification");
    const verifiedProfile = this.readStoredProfile(
      candidate.destinationProfilePath,
      candidate.profile.key,
      true,
    );
    const verifiedCredential = readRegularFile(candidate.destinationCredentialPath, true);
    if (
      !verifiedProfile ||
      !storedProfilesEqual(verifiedProfile, candidate.profile) ||
      !verifiedCredential.equals(candidate.rawCredential) ||
      !parseRemoteProfileCredentialJson(verifiedCredential)?.accessToken
    ) {
      throw invalidProfileState();
    }
    this.fault("after-verification");

    this.fault("before-legacy-profile-delete");
    rmSync(candidate.legacyProfilePath, { force: true });
    this.fault("after-legacy-profile-delete");
    this.fault("before-legacy-credential-delete");
    rmSync(candidate.legacyCredentialPath, { force: true });
    this.fault("after-legacy-credential-delete");
    flushDirectory(this.profilesDir());
    flushDirectory(this.credentialStore.root);
  }

  private writeMigrationFile(
    destination: string,
    bytes: Buffer,
    tempId: string,
    kind: "credential" | "profile",
  ): void {
    ensurePrivateDirectory(dirname(destination));
    const tempPath = `${destination}.${tempId}.migration.tmp`;
    if (lstatOptional(tempPath)) {
      assertRegularFile(tempPath, false);
      rmSync(tempPath, { force: true });
    }
    this.fault(kind === "credential" ? "before-credential-write" : "before-profile-write");
    const descriptor = openSync(tempPath, "wx", 0o600);
    try {
      writeSync(descriptor, bytes);
      this.fault(kind === "credential" ? "after-credential-write" : "after-profile-write");
      fsyncSync(descriptor);
      this.fault(kind === "credential" ? "after-credential-flush" : "after-profile-flush");
    } finally {
      closeSync(descriptor);
    }
    this.fault(kind === "credential" ? "before-credential-rename" : "before-profile-rename");
    if (lstatOptional(destination)) {
      rmSync(tempPath, { force: true });
      throw invalidProfileState();
    }
    renameSync(tempPath, destination);
    flushDirectory(dirname(destination));
    this.fault(kind === "credential" ? "after-credential-rename" : "after-profile-rename");
  }

  private readLegacyProfile(path: string, expectedKey: string): LegacySelfHostedProfile {
    const bytes = readRegularFile(path, true);
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw invalidLegacyState();
    }
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      value.kind !== "self-hosted" ||
      value.key !== expectedKey ||
      typeof value.hostUrl !== "string" ||
      `self-hosted:${value.hostUrl}` !== expectedKey ||
      typeof value.clientId !== "string" ||
      typeof value.createdAt !== "string" ||
      typeof value.updatedAt !== "string"
    ) {
      throw invalidLegacyState();
    }
    return {
      version: 1,
      kind: "self-hosted",
      key: value.key,
      hostUrl: value.hostUrl,
      ...(typeof value.hostIdentity === "string" ? { hostIdentity: value.hostIdentity } : {}),
      clientId: value.clientId,
      ...(typeof value.clientLabel === "string" ? { clientLabel: value.clientLabel } : {}),
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    };
  }

  private readStoredProfile(
    path: string,
    expectedKey: string,
    required: boolean,
  ): StoredRemoteProfile | undefined {
    const bytes = readOptionalRegularFile(path);
    if (!bytes) {
      if (required) throw invalidProfileState();
      return undefined;
    }
    return parseStoredRemoteProfileJson(bytes, expectedKey);
  }

  private qualifiedKeys(
    directory: string,
    prefix: "remote:" | "self-hosted:",
  ): Array<{ key: string; path: string }> {
    if (!lstatOptional(directory)) return [];
    assertDirectory(directory);
    const entries: Array<{ key: string; path: string }> = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.name.endsWith(".json")) continue;
      const encodedKey = entry.name.slice(0, -".json".length);
      let key: string;
      try {
        key = decodeURIComponent(encodedKey);
      } catch {
        continue;
      }
      if (!key.startsWith(prefix)) continue;
      if (`${encodeURIComponent(key)}.json` !== entry.name) throw invalidProfileState();
      entries.push({ key, path: join(directory, entry.name) });
    }
    return entries;
  }

  private removeLegacyLeftovers(origin: string): boolean {
    let removed = false;
    for (const directory of [this.profilesDir(), this.credentialStore.root]) {
      for (const entry of this.qualifiedKeys(directory, "self-hosted:")) {
        let candidateOrigin: string;
        try {
          candidateOrigin = canonicalizeLegacyOrigin(entry.key.slice("self-hosted:".length));
        } catch {
          continue;
        }
        if (candidateOrigin !== origin) continue;
        const stat = lstatOptional(entry.path);
        if (!stat) continue;
        if (!stat.isFile() && !stat.isSymbolicLink()) throw invalidLegacyState();
        rmSync(entry.path, { force: true });
        removed = true;
      }
    }
    return removed;
  }

  private writeJsonAtomically(path: string, value: unknown): void {
    ensurePrivateDirectory(dirname(path));
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const descriptor = openSync(tempPath, "wx", 0o600);
    try {
      writeSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      chmodSync(tempPath, 0o600);
      renameSync(tempPath, path);
      flushDirectory(dirname(path));
    } catch (error) {
      rmSync(tempPath, { force: true });
      throw error;
    }
  }

  private async withMutationLock<T>(
    operation: (assertOwned: () => void) => Promise<T>,
  ): Promise<T> {
    return await this.withLease(this.lockPath(), "Remote Profile store is locked.", operation);
  }

  private async withRefreshLock<T>(
    key: string,
    operation: (assertOwned: () => void) => Promise<T>,
  ): Promise<T> {
    return await this.withLease(
      this.refreshLockPath(key),
      "Remote Profile refresh is locked.",
      operation,
    );
  }

  private async withLease<T>(
    path: string,
    message: string,
    operation: (assertOwned: () => void) => Promise<T>,
  ): Promise<T> {
    const lease = await this.acquireLease(path, message);
    const assertOwned = () => this.assertLeaseOwned(lease, message);
    let result!: T;
    let operationFailed = false;
    let operationError: unknown;
    try {
      result = await operation(assertOwned);
      assertOwned();
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    let releaseFailed = false;
    let releaseError: unknown;
    try {
      this.releaseLease(lease, message);
    } catch (error) {
      releaseFailed = true;
      releaseError = error;
    }
    if (operationFailed) throw operationError;
    if (releaseFailed) throw releaseError;
    return result;
  }

  private async acquireLease(path: string, message: string): Promise<Lease> {
    ensurePrivateDirectory(this.root);
    ensurePrivateDirectory(dirname(path));
    const started = Date.now();
    while (true) {
      const startedAt = processStartedAt(process.pid);
      const owner: LockOwner = {
        version: 1,
        token: randomUUID(),
        pid: process.pid,
        hostname: hostname(),
        ...(startedAt ? { processStartedAt: startedAt } : {}),
        acquiredAt: Date.now(),
        leaseExpiresAt: Date.now() + this.leaseOptions.durationMs,
      };
      try {
        mkdirSync(path, { recursive: false, mode: 0o700 });
        try {
          writeFileSync(join(path, LOCK_OWNER_FILE), `${JSON.stringify(owner)}\n`, {
            flag: "wx",
            mode: 0o600,
          });
          flushDirectory(path);
        } catch (error) {
          rmSync(path, { recursive: true, force: true });
          throw error;
        }
        let lease: Lease;
        const timer = setInterval(
          () => this.renewLease(lease, message),
          this.leaseOptions.renewIntervalMs,
        );
        lease = { path, owner, lost: undefined, timer };
        lease.timer.unref();
        return lease;
      } catch (error) {
        if (!isFileExistsError(error)) {
          throw new CapletsError("SERVER_UNAVAILABLE", message);
        }
        if (this.reclaimExpiredDeadLease(path)) continue;
        if (Date.now() - started >= this.leaseOptions.acquireTimeoutMs) {
          throw new CapletsError("SERVER_UNAVAILABLE", message);
        }
        await sleep(Math.min(10, this.leaseOptions.renewIntervalMs));
      }
    }
  }

  private renewLease(lease: Lease, message: string): void {
    if (lease.lost) return;
    try {
      const owner = readLockOwner(lease.path);
      if (owner.token !== lease.owner.token) throw new Error("owner token changed");
      lease.owner.leaseExpiresAt = Date.now() + this.leaseOptions.durationMs;
      const ownerPath = join(lease.path, LOCK_OWNER_FILE);
      const tempPath = `${ownerPath}.${lease.owner.token}.renew`;
      writeFileSync(tempPath, `${JSON.stringify(lease.owner)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(tempPath, ownerPath);
      flushDirectory(lease.path);
    } catch {
      lease.lost = new CapletsError("SERVER_UNAVAILABLE", message);
    }
  }

  private assertLeaseOwned(lease: Lease, message: string): void {
    if (lease.lost) throw lease.lost;
    try {
      const owner = readLockOwner(lease.path);
      if (owner.token !== lease.owner.token) throw new Error("owner token changed");
    } catch {
      lease.lost = new CapletsError("SERVER_UNAVAILABLE", message);
      throw lease.lost;
    }
  }

  private releaseLease(lease: Lease, message: string): void {
    clearInterval(lease.timer);
    this.assertLeaseOwned(lease, message);
    const releasedPath = `${lease.path}.release.${lease.owner.token}`;
    renameSync(lease.path, releasedPath);
    try {
      if (readLockOwner(releasedPath).token !== lease.owner.token) {
        throw new CapletsError("SERVER_UNAVAILABLE", message);
      }
      rmSync(releasedPath, { recursive: true, force: true });
      flushDirectory(dirname(lease.path));
    } catch (error) {
      if (!existsSync(lease.path) && existsSync(releasedPath)) {
        try {
          renameSync(releasedPath, lease.path);
        } catch {
          // Leave the token-bearing directory in place rather than deleting uncertain ownership.
        }
      }
      throw error;
    }
  }

  private reclaimExpiredDeadLease(path: string): boolean {
    let owner: LockOwner;
    try {
      owner = readLockOwner(path);
    } catch {
      return false;
    }
    if (owner.leaseExpiresAt > Date.now() || !isProvenDead(owner)) return false;
    try {
      const confirmed = readLockOwner(path);
      if (confirmed.token !== owner.token || confirmed.leaseExpiresAt !== owner.leaseExpiresAt) {
        return false;
      }
      const reclaimedPath = `${path}.reclaim.${owner.token}.${randomUUID()}`;
      renameSync(path, reclaimedPath);
      if (readLockOwner(reclaimedPath).token !== owner.token) return false;
      rmSync(reclaimedPath, { recursive: true, force: true });
      flushDirectory(dirname(path));
      return true;
    } catch {
      return false;
    }
  }

  private fault(point: RemoteProfileStoreFaultPoint): void {
    this.faultInjection?.(point);
  }

  private profilePath(key: string): string {
    return join(this.profilesDir(), `${encodeURIComponent(key)}.json`);
  }

  private profilesDir(): string {
    return join(this.root, "profiles");
  }

  private lockPath(): string {
    return join(this.root, PROFILE_LOCK_DIR);
  }

  private refreshLockPath(key: string): string {
    return join(this.root, PROFILE_REFRESH_LOCK_DIR, `${encodeURIComponent(key)}.lock`);
  }
}

function canonicalizeLegacyOrigin(value: string): string {
  try {
    return canonicalizeCurrentHostOrigin(value);
  } catch {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Legacy Remote Profile URL must be a Current Host origin. Remove the path-bearing profile and run caplets remote login with the Current Host origin.",
    );
  }
}

function parseStoredRemoteProfileJson(bytes: Buffer, expectedKey: string): StoredRemoteProfile {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw invalidProfileState();
  }
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    value.key !== expectedKey ||
    typeof value.origin !== "string" ||
    remoteProfileKey({ origin: value.origin }) !== expectedKey ||
    typeof value.clientId !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    throw invalidProfileState();
  }
  return {
    version: 2,
    key: value.key,
    origin: canonicalizeCurrentHostOrigin(value.origin),
    ...(typeof value.hostIdentity === "string" ? { hostIdentity: value.hostIdentity } : {}),
    clientId: value.clientId,
    ...(typeof value.clientLabel === "string" ? { clientLabel: value.clientLabel } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parseRemoteProfileCredentialJson(bytes: Buffer): RemoteProfileCredential | undefined {
  try {
    return parseRemoteProfileCredential(JSON.parse(bytes.toString("utf8")));
  } catch {
    return undefined;
  }
}

function validateRawCredential(bytes: Buffer): void {
  if (!parseRemoteProfileCredentialJson(bytes)?.accessToken) throw invalidLegacyState();
}

function storedProfilesEqual(left: StoredRemoteProfile, right: StoredRemoteProfile): boolean {
  return (
    left.version === right.version &&
    left.key === right.key &&
    left.origin === right.origin &&
    left.hostIdentity === right.hostIdentity &&
    left.clientId === right.clientId &&
    left.clientLabel === right.clientLabel &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt
  );
}

function readRegularFile(path: string, requirePrivate: boolean): Buffer {
  assertRegularFile(path, requirePrivate);
  return readFileSync(path);
}

function readOptionalRegularFile(path: string): Buffer | undefined {
  const stat = lstatOptional(path);
  if (!stat) return undefined;
  assertRegularStat(stat, path, false);
  return readFileSync(path);
}

function assertRegularFile(path: string, requirePrivate: boolean): void {
  const stat = lstatOptional(path);
  if (!stat) throw invalidLegacyState();
  assertRegularStat(stat, path, requirePrivate);
}

function assertRegularStat(stat: Stats, _path: string, requirePrivate: boolean): void {
  if (!stat.isFile() || stat.isSymbolicLink()) throw invalidLegacyState();
  if (requirePrivate && process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw invalidLegacyState();
  }
}

function assertDirectory(path: string): void {
  const stat = lstatOptional(path);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw invalidProfileState();
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertDirectory(path);
  try {
    chmodSync(path, 0o700);
  } catch {
    // Best effort on platforms without POSIX permissions.
  }
}

function lstatOptional(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

function removePathIfPresent(path: string): boolean {
  if (!lstatOptional(path)) return false;
  rmSync(path, { force: true });
  return true;
}

function readLockOwner(lockPath: string): LockOwner {
  assertDirectory(lockPath);
  const ownerPath = join(lockPath, LOCK_OWNER_FILE);
  const bytes = readRegularFile(ownerPath, false);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("invalid lock owner");
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.token !== "string" ||
    typeof value.pid !== "number" ||
    typeof value.hostname !== "string" ||
    typeof value.acquiredAt !== "number" ||
    typeof value.leaseExpiresAt !== "number"
  ) {
    throw new Error("invalid lock owner");
  }
  return {
    version: 1,
    token: value.token,
    pid: value.pid,
    hostname: value.hostname,
    ...(typeof value.processStartedAt === "string"
      ? { processStartedAt: value.processStartedAt }
      : {}),
    acquiredAt: value.acquiredAt,
    leaseExpiresAt: value.leaseExpiresAt,
  };
}

function isProvenDead(owner: LockOwner): boolean {
  if (owner.hostname !== hostname()) return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return isMissingProcessError(error);
  }
  if (!owner.processStartedAt) return false;
  const currentStartedAt = processStartedAt(owner.pid);
  return currentStartedAt !== undefined && currentStartedAt !== owner.processStartedAt;
}

function processStartedAt(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u);
    return fields[19];
  } catch {
    return undefined;
  }
}

function flushDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch {
    // Directory fsync is unavailable on some supported platforms and filesystems.
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function invalidLegacyState(): CapletsError {
  return new CapletsError("REQUEST_INVALID", "Legacy Remote Profile state is invalid.");
}

function invalidProfileState(): CapletsError {
  return new CapletsError("REQUEST_INVALID", "Remote Profile state is invalid.");
}

function assertHostIdentityMatches(
  status: RemoteProfileStatus | undefined,
  expectedHostIdentity: string | undefined,
): void {
  if (!status || !expectedHostIdentity || !status.hostIdentity) return;
  if (status.hostIdentity === expectedHostIdentity) return;
  throw new CapletsError("AUTH_FAILED", "Remote Profile belongs to a different host identity.");
}

function isFileExistsError(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function isMissingFileError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isMissingProcessError(error: unknown): boolean {
  return errorCode(error) === "ESRCH";
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
