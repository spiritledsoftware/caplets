import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CloudAuthStore } from "../cloud-auth/store";
import type { CloudAuthCredentials } from "../cloud-auth/store";
import { DEFAULT_AUTH_DIR } from "../config/paths";
import { CapletsError } from "../errors";
import { FileRemoteCredentialStore } from "./credential-store";
import {
  remoteProfileKey,
  remoteProfileStatus,
  selectedWorkspaceKey,
  type RemoteProfileCredential,
  type RemoteProfileStatus,
} from "./profiles";
import { hostedCloudWorkspaceFromRemoteUrl, normalizeRemoteProfileHostUrl } from "./options";

const PROFILE_LOCK_DIR = "remote-profiles.lock";
const PROFILE_REFRESH_LOCK_DIR = "remote-profile-refresh-locks";
const PROFILE_LOCK_TIMEOUT_MS = 20_000;

type StoredRemoteProfile = {
  version: 1;
  kind: "cloud" | "self-hosted";
  key: string;
  hostUrl: string;
  hostIdentity?: string | undefined;
  workspaceId?: string | undefined;
  workspaceSlug?: string | undefined;
  clientId?: string | undefined;
  clientLabel?: string | undefined;
  createdAt: string;
  updatedAt: string;
};

type SelectedCloudWorkspace = {
  version: 1;
  hostUrl: string;
  workspace: string;
  profileKey: string;
  selectedAt: string;
};

export type SaveCloudProfileInput = {
  hostUrl: string;
  workspaceId: string;
  workspaceSlug?: string | undefined;
  clientLabel?: string | undefined;
  credentials: RemoteProfileCredential;
  now?: Date | undefined;
};

export type CloudProfileLookup = {
  hostUrl: string;
  workspace?: string | undefined;
};

export type SaveSelfHostedProfileInput = {
  hostUrl: string;
  hostIdentity?: string | undefined;
  clientId: string;
  clientLabel?: string | undefined;
  credentials: RemoteProfileCredential;
  now?: Date | undefined;
};

export type SelfHostedProfileLookup = {
  hostUrl: string;
  hostIdentity?: string | undefined;
};

export type RefreshSelfHostedProfileInput = SelfHostedProfileLookup & {
  needsRefresh: (credential: RemoteProfileCredential) => boolean;
  refresh: (
    status: RemoteProfileStatus,
    credential: RemoteProfileCredential,
  ) => Promise<SaveSelfHostedProfileInput>;
};

export type RefreshCloudProfileInput = CloudProfileLookup & {
  needsRefresh: (credential: RemoteProfileCredential) => boolean;
  refresh: (
    status: RemoteProfileStatus,
    credential: RemoteProfileCredential,
  ) => Promise<SaveCloudProfileInput>;
};

export type RemoteProfileStoreOptions = {
  root?: string | undefined;
  credentials?: FileRemoteCredentialStore | undefined;
  legacyCloudAuthStore?: CloudAuthStore | undefined;
};

export type CreateRemoteProfileStoreOptions = {
  authDir?: string | undefined;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined;
  legacyCloudAuthStore?: CloudAuthStore | undefined;
};

export function createRemoteProfileStore(
  options: CreateRemoteProfileStoreOptions = {},
): FileRemoteProfileStore {
  const env = options.env ?? process.env;
  const authRoot =
    options.authDir ??
    (env.CAPLETS_CLOUD_AUTH_PATH ? dirname(env.CAPLETS_CLOUD_AUTH_PATH) : undefined);
  return new FileRemoteProfileStore({
    root: join(authRoot ?? DEFAULT_AUTH_DIR, "remote-profiles"),
    legacyCloudAuthStore:
      options.legacyCloudAuthStore ??
      new CloudAuthStore(
        options.authDir ? { path: join(options.authDir, "cloud-auth.json") } : { env },
      ),
  });
}

export function cloudCredentialsFromRemoteProfile(
  status: RemoteProfileStatus,
  credential: RemoteProfileCredential,
): CloudAuthCredentials {
  return {
    version: 2,
    cloudUrl: status.hostUrl,
    workspaceId: status.workspaceId ?? "",
    ...(status.workspaceSlug ? { workspaceSlug: status.workspaceSlug } : {}),
    accessToken: credential.accessToken ?? "",
    refreshToken: credential.refreshToken ?? "",
    expiresAt: credential.expiresAt ?? new Date(0).toISOString(),
    scope: credential.scope,
    tokenType: credential.tokenType,
    deviceName: status.clientLabel,
    createdAt: status.createdAt,
    lastRefreshAt: status.updatedAt,
  };
}

export class FileRemoteProfileStore {
  readonly root: string;
  readonly credentials: FileRemoteCredentialStore;
  readonly legacyCloudAuthStore?: CloudAuthStore | undefined;

  constructor(options: RemoteProfileStoreOptions = {}) {
    this.root = options.root ?? join(DEFAULT_AUTH_DIR, "remote-profiles");
    this.credentials =
      options.credentials ??
      new FileRemoteCredentialStore({ root: join(this.root, "credentials") });
    this.legacyCloudAuthStore = options.legacyCloudAuthStore;
  }

  async saveSelfHostedProfile(input: SaveSelfHostedProfileInput): Promise<RemoteProfileStatus> {
    return await this.withMutationLock(async () => await this.writeSelfHostedProfile(input));
  }

  async getSelfHostedProfileStatus(
    input: SelfHostedProfileLookup,
  ): Promise<RemoteProfileStatus | undefined> {
    const key = remoteProfileKey({
      kind: "self-hosted",
      hostUrl: normalizeRemoteProfileHostUrl(input.hostUrl),
    });
    const status = await this.statusByKey(key, false);
    assertHostIdentityMatches(status, input.hostIdentity);
    return status;
  }

  async logoutSelfHostedProfile(input: SelfHostedProfileLookup): Promise<boolean> {
    return await this.withMutationLock(async () => {
      const key = remoteProfileKey({
        kind: "self-hosted",
        hostUrl: normalizeRemoteProfileHostUrl(input.hostUrl),
      });
      const profile = this.readProfile(key);
      if (!profile) return false;
      await this.credentials.delete(key);
      rmSync(this.profilePath(key), { force: true });
      return true;
    });
  }

  async refreshSelfHostedProfileIfNeeded(
    input: RefreshSelfHostedProfileInput,
  ): Promise<{ status: RemoteProfileStatus; credential: RemoteProfileCredential } | undefined> {
    const key = remoteProfileKey({
      kind: "self-hosted",
      hostUrl: normalizeRemoteProfileHostUrl(input.hostUrl),
    });
    const snapshot = await this.withMutationLock(async () =>
      this.selfHostedRefreshSnapshot(key, input),
    );
    if (!snapshot || !snapshot.needsRefresh) return snapshot?.result;

    return await this.withRefreshLock(key, async () => {
      const lockedSnapshot = await this.withMutationLock(async () =>
        this.selfHostedRefreshSnapshot(key, input),
      );
      if (!lockedSnapshot || !lockedSnapshot.needsRefresh) return lockedSnapshot?.result;

      const refreshed = await input.refresh(
        lockedSnapshot.result.status,
        lockedSnapshot.result.credential,
      );
      return await this.withMutationLock(async () => {
        const current = await this.selfHostedRefreshSnapshot(key, input);
        if (!current || !current.needsRefresh) return current?.result;
        const refreshedStatus = await this.writeSelfHostedProfile(refreshed);
        const refreshedCredential = await this.credentials.load(refreshedStatus.key);
        if (!refreshedCredential?.accessToken) return undefined;
        return { status: refreshedStatus, credential: refreshedCredential };
      });
    });
  }

  async refreshCloudProfileIfNeeded(
    input: RefreshCloudProfileInput,
  ): Promise<{ status: RemoteProfileStatus; credential: RemoteProfileCredential } | undefined> {
    const snapshot = await this.withMutationLock(async () => this.cloudRefreshSnapshot(input));
    if (!snapshot || !snapshot.needsRefresh) return snapshot?.result;

    return await this.withRefreshLock(snapshot.result.status.key, async () => {
      const lockedSnapshot = await this.withMutationLock(async () =>
        this.cloudRefreshSnapshot(input),
      );
      if (!lockedSnapshot || !lockedSnapshot.needsRefresh) return lockedSnapshot?.result;

      const refreshed = await input.refresh(
        lockedSnapshot.result.status,
        lockedSnapshot.result.credential,
      );
      return await this.withMutationLock(async () => {
        const current = await this.cloudRefreshSnapshot(input);
        if (!current || !current.needsRefresh) return current?.result;
        const refreshedStatus = await this.writeCloudProfile(refreshed, {
          select: current.result.status.selected,
        });
        const refreshedCredential = await this.credentials.load(refreshedStatus.key);
        if (!refreshedCredential?.accessToken) return undefined;
        return { status: refreshedStatus, credential: refreshedCredential };
      });
    });
  }

  async saveCloudProfile(input: SaveCloudProfileInput): Promise<RemoteProfileStatus> {
    return await this.withMutationLock(async () => await this.writeCloudProfile(input));
  }

  async getCloudProfileStatus(input: CloudProfileLookup): Promise<RemoteProfileStatus | undefined> {
    const hostUrl = normalizeRemoteProfileHostUrl(input.hostUrl);
    const workspace = input.workspace ?? hostedCloudWorkspaceFromRemoteUrl(input.hostUrl);
    if (workspace) {
      const found = await this.findCloudStatus(hostUrl, workspace);
      if (found) return found;
      return this.migrateLegacyCloudProfile(hostUrl, workspace);
    }

    const selected = this.readSelectedWorkspace(hostUrl);
    if (selected) return this.statusByKey(selected.profileKey, true);
    if (this.listProfilesForHost(hostUrl).length > 0) {
      throw cloudWorkspaceAmbiguityError();
    }
    return this.migrateLegacyCloudProfile(hostUrl);
  }

  async listCloudProfileStatuses(hostUrlInput: string): Promise<RemoteProfileStatus[]> {
    const hostUrl = normalizeRemoteProfileHostUrl(hostUrlInput);
    const selected = this.readSelectedWorkspace(hostUrl)?.profileKey;
    const statuses = await Promise.all(
      this.listProfilesForHost(hostUrl).map(async (profile) =>
        this.statusFor(profile, undefined, profile.key === selected),
      ),
    );
    return statuses.sort((left, right) =>
      (left.workspaceSlug ?? left.workspaceId ?? "").localeCompare(
        right.workspaceSlug ?? right.workspaceId ?? "",
      ),
    );
  }

  async listProfileStatuses(): Promise<RemoteProfileStatus[]> {
    const dir = this.profilesDir();
    if (!existsSync(dir)) return [];
    const statuses = await Promise.all(
      readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => this.readProfileFile(join(dir, entry.name)))
        .filter((profile): profile is StoredRemoteProfile => Boolean(profile))
        .map(async (profile) => {
          const selected =
            profile.kind === "cloud"
              ? this.readSelectedWorkspace(profile.hostUrl)?.profileKey === profile.key
              : false;
          return await this.statusFor(profile, undefined, selected);
        }),
    );
    return statuses.sort((left, right) => {
      const host = left.hostUrl.localeCompare(right.hostUrl);
      if (host !== 0) return host;
      return (left.workspaceSlug ?? left.workspaceId ?? "").localeCompare(
        right.workspaceSlug ?? right.workspaceId ?? "",
      );
    });
  }

  async logoutCloudProfile(input: CloudProfileLookup): Promise<boolean> {
    return await this.withMutationLock(async () => {
      const hostUrl = normalizeRemoteProfileHostUrl(input.hostUrl);
      const workspace = input.workspace ?? hostedCloudWorkspaceFromRemoteUrl(input.hostUrl);
      const selected = this.readSelectedWorkspace(hostUrl);
      let key: string | undefined;
      if (workspace) {
        key = this.listProfilesForHost(hostUrl).find((profile) =>
          profileMatchesWorkspace(profile, workspace),
        )?.key;
      } else if (selected) {
        key = selected.profileKey;
      } else if (this.listProfilesForHost(hostUrl).length > 0) {
        throw cloudWorkspaceAmbiguityError();
      }
      if (!key) return false;
      const profile = this.readProfile(key);
      await this.credentials.delete(key);
      rmSync(this.profilePath(key), { force: true });
      if (selected?.profileKey === key)
        rmSync(this.selectedWorkspacePath(hostUrl), { force: true });
      await this.clearMatchingLegacyCloudAuth(hostUrl, profile);
      return true;
    });
  }

  async clearSelectedCloudWorkspace(hostUrlInput: string): Promise<boolean> {
    return await this.withMutationLock(async () => {
      const path = this.selectedWorkspacePath(normalizeRemoteProfileHostUrl(hostUrlInput));
      if (!existsSync(path)) return false;
      rmSync(path, { force: true });
      return true;
    });
  }

  private async selfHostedRefreshSnapshot(
    key: string,
    input: RefreshSelfHostedProfileInput,
  ): Promise<
    | {
        needsRefresh: boolean;
        result: { status: RemoteProfileStatus; credential: RemoteProfileCredential };
      }
    | undefined
  > {
    const profile = this.readProfile(key);
    if (!profile) return undefined;
    const credential = await this.credentials.load(key);
    if (!credential?.accessToken) return undefined;
    const status = await this.statusFor(profile, credential, false);
    return { needsRefresh: input.needsRefresh(credential), result: { status, credential } };
  }

  private async cloudRefreshSnapshot(input: RefreshCloudProfileInput): Promise<
    | {
        needsRefresh: boolean;
        result: { status: RemoteProfileStatus; credential: RemoteProfileCredential };
      }
    | undefined
  > {
    const hostUrl = normalizeRemoteProfileHostUrl(input.hostUrl);
    const workspace = input.workspace ?? hostedCloudWorkspaceFromRemoteUrl(input.hostUrl);
    let status: RemoteProfileStatus | undefined;
    if (workspace) {
      status = await this.findCloudStatus(hostUrl, workspace);
    } else {
      const selected = this.readSelectedWorkspace(hostUrl);
      if (selected) status = await this.statusByKey(selected.profileKey, true);
      else if (this.listProfilesForHost(hostUrl).length > 0) {
        throw cloudWorkspaceAmbiguityError();
      }
    }
    if (!status) return undefined;
    const credential = await this.credentials.load(status.key);
    if (!credential?.accessToken) return undefined;
    return { needsRefresh: input.needsRefresh(credential), result: { status, credential } };
  }

  private async findCloudStatus(
    hostUrl: string,
    workspace: string,
  ): Promise<RemoteProfileStatus | undefined> {
    const selected = this.readSelectedWorkspace(hostUrl)?.profileKey;
    const profile = this.listProfilesForHost(hostUrl).find((candidate) =>
      profileMatchesWorkspace(candidate, workspace),
    );
    if (!profile) return undefined;
    return this.statusFor(profile, undefined, profile.key === selected);
  }

  private async migrateLegacyCloudProfile(
    hostUrl: string,
    workspace?: string,
  ): Promise<RemoteProfileStatus | undefined> {
    const legacy = await this.legacyCloudAuthStore?.load();
    if (!legacy) return undefined;
    if (normalizeRemoteProfileHostUrl(legacy.cloudUrl) !== hostUrl) return undefined;
    if (workspace && workspace !== legacy.workspaceSlug && workspace !== legacy.workspaceId) {
      return undefined;
    }
    return this.saveCloudProfile({
      hostUrl,
      workspaceId: legacy.workspaceId,
      ...(legacy.workspaceSlug ? { workspaceSlug: legacy.workspaceSlug } : {}),
      clientLabel: legacy.deviceName,
      credentials: legacyCredential(legacy),
      now: legacy.createdAt ? new Date(legacy.createdAt) : undefined,
    });
  }

  private async clearMatchingLegacyCloudAuth(
    hostUrl: string,
    profile: StoredRemoteProfile | undefined,
  ): Promise<void> {
    const legacy = await this.legacyCloudAuthStore?.load();
    if (!legacy) return;
    if (normalizeRemoteProfileHostUrl(legacy.cloudUrl) !== hostUrl) return;
    if (!profile) return;
    const workspaceIdMatches = legacy.workspaceId === profile.workspaceId;
    const workspaceSlugMatches = Boolean(
      legacy.workspaceSlug &&
      profile.workspaceSlug &&
      legacy.workspaceSlug === profile.workspaceSlug,
    );
    if (!workspaceIdMatches && !workspaceSlugMatches) return;
    await this.legacyCloudAuthStore?.clear();
  }

  private async statusByKey(
    key: string,
    selected: boolean,
  ): Promise<RemoteProfileStatus | undefined> {
    const profile = this.readProfile(key);
    if (!profile) return undefined;
    return this.statusFor(profile, undefined, selected);
  }

  private async statusFor(
    profile: StoredRemoteProfile,
    credential: RemoteProfileCredential | undefined,
    selected: boolean,
  ): Promise<RemoteProfileStatus> {
    const build = (loadedCredential: RemoteProfileCredential | undefined): RemoteProfileStatus =>
      remoteProfileStatus({
        kind: profile.kind,
        key: profile.key,
        hostUrl: profile.hostUrl,
        hostIdentity: profile.hostIdentity,
        workspaceId: profile.workspaceId,
        workspaceSlug: profile.workspaceSlug,
        clientId: profile.clientId,
        clientLabel: profile.clientLabel,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
        selected,
        credential: loadedCredential,
      });
    if (credential !== undefined) return build(credential);
    return build(await this.credentials.load(profile.key));
  }

  private async writeSelfHostedProfile(
    input: SaveSelfHostedProfileInput,
  ): Promise<RemoteProfileStatus> {
    const hostUrl = normalizeRemoteProfileHostUrl(input.hostUrl);
    const key = remoteProfileKey({ kind: "self-hosted", hostUrl });
    const now = (input.now ?? new Date()).toISOString();
    const existing = this.readProfile(key);
    const hostIdentity = input.hostIdentity ?? existing?.hostIdentity;
    const profile: StoredRemoteProfile = {
      version: 1,
      kind: "self-hosted",
      key,
      hostUrl,
      ...(hostIdentity ? { hostIdentity } : {}),
      clientId: input.clientId,
      ...(input.clientLabel ? { clientLabel: input.clientLabel } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.credentials.save(key, input.credentials);
    this.writeJson(this.profilePath(key), profile);
    return await this.statusFor(profile, input.credentials, false);
  }

  private async writeCloudProfile(
    input: SaveCloudProfileInput,
    options: { select?: boolean } = {},
  ): Promise<RemoteProfileStatus> {
    const hostUrl = normalizeRemoteProfileHostUrl(input.hostUrl);
    const workspace = cloudWorkspace(input);
    const key = remoteProfileKey({ kind: "cloud", hostUrl, workspace });
    const now = (input.now ?? new Date()).toISOString();
    const existing = this.readProfile(key);
    const select = options.select ?? true;
    const profile: StoredRemoteProfile = {
      version: 1,
      kind: "cloud",
      key,
      hostUrl,
      workspaceId: input.workspaceId,
      ...(input.workspaceSlug ? { workspaceSlug: input.workspaceSlug } : {}),
      ...(input.clientLabel ? { clientLabel: input.clientLabel } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await this.credentials.save(key, input.credentials);
    this.writeJson(this.profilePath(key), profile);
    if (select) {
      this.writeJson(this.selectedWorkspacePath(hostUrl), {
        version: 1,
        hostUrl,
        workspace,
        profileKey: key,
        selectedAt: now,
      } satisfies SelectedCloudWorkspace);
    }

    return await this.statusFor(profile, input.credentials, select);
  }

  private listProfilesForHost(hostUrl: string): StoredRemoteProfile[] {
    const dir = this.profilesDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => this.readProfileFile(join(dir, entry.name)))
      .filter((profile): profile is StoredRemoteProfile => Boolean(profile))
      .filter((profile) => profile.kind === "cloud" && profile.hostUrl === hostUrl);
  }

  private readProfile(key: string): StoredRemoteProfile | undefined {
    return this.readProfileFile(this.profilePath(key));
  }

  private readProfileFile(path: string): StoredRemoteProfile | undefined {
    if (!existsSync(path)) return undefined;
    return parseStoredRemoteProfile(JSON.parse(readFileSync(path, "utf8")));
  }

  private readSelectedWorkspace(hostUrl: string): SelectedCloudWorkspace | undefined {
    const path = this.selectedWorkspacePath(hostUrl);
    if (!existsSync(path)) return undefined;
    return parseSelectedCloudWorkspace(JSON.parse(readFileSync(path, "utf8")), hostUrl);
  }

  private profilePath(key: string): string {
    return join(this.profilesDir(), `${encodeURIComponent(key)}.json`);
  }

  private selectedWorkspacePath(hostUrl: string): string {
    return join(this.selectionsDir(), `${encodeURIComponent(selectedWorkspaceKey(hostUrl))}.json`);
  }

  private profilesDir(): string {
    return join(this.root, "profiles");
  }

  private selectionsDir(): string {
    return join(this.root, "selections");
  }

  private writeJson(path: string, value: unknown): void {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Best effort on platforms without POSIX permissions.
    }
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(tempPath, 0o600);
    } catch {
      // Best effort on platforms without POSIX permissions.
    }
    renameSync(tempPath, path);
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquireLock(this.lockPath(), "Remote Profile store is locked.");
    try {
      return await operation();
    } finally {
      this.releaseLock(this.lockPath());
    }
  }

  private async withRefreshLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const lockPath = this.refreshLockPath(key);
    await this.acquireLock(lockPath, "Remote Profile refresh is locked.");
    try {
      return await operation();
    } finally {
      this.releaseLock(lockPath);
    }
  }

  private async acquireLock(lockPath: string, message: string): Promise<void> {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    const started = Date.now();
    while (true) {
      try {
        mkdirSync(lockPath, { recursive: false, mode: 0o700 });
        return;
      } catch (error) {
        if (isFileExistsError(error) && this.clearStaleLock(lockPath)) {
          continue;
        }
        if (!isFileExistsError(error) || Date.now() - started >= PROFILE_LOCK_TIMEOUT_MS) {
          throw new CapletsError("SERVER_UNAVAILABLE", message);
        }
        await sleep(10);
      }
    }
  }

  private releaseLock(lockPath: string): void {
    rmSync(lockPath, { recursive: true, force: true });
  }

  private clearStaleLock(lockPath: string): boolean {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs < PROFILE_LOCK_TIMEOUT_MS) return false;
      rmSync(lockPath, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  private lockPath(): string {
    return join(this.root, PROFILE_LOCK_DIR);
  }

  private refreshLockPath(key: string): string {
    return join(this.root, PROFILE_REFRESH_LOCK_DIR, `${encodeURIComponent(key)}.lock`);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function cloudWorkspace(input: SaveCloudProfileInput): string {
  return (
    input.workspaceSlug ??
    input.workspaceId ??
    hostedCloudWorkspaceFromRemoteUrl(input.hostUrl) ??
    ""
  );
}

function profileMatchesWorkspace(profile: StoredRemoteProfile, workspace: string): boolean {
  return profile.workspaceSlug === workspace || profile.workspaceId === workspace;
}

function legacyCredential(credentials: CloudAuthCredentials): RemoteProfileCredential {
  return {
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    expiresAt: credentials.expiresAt,
    ...(credentials.scope ? { scope: credentials.scope } : {}),
    ...(credentials.tokenType ? { tokenType: credentials.tokenType } : {}),
  };
}

function assertHostIdentityMatches(
  status: RemoteProfileStatus | undefined,
  expectedHostIdentity: string | undefined,
): void {
  if (!status || !expectedHostIdentity || !status.hostIdentity) return;
  if (status.hostIdentity === expectedHostIdentity) return;
  throw new CapletsError("AUTH_FAILED", "Remote Profile belongs to a different host identity.");
}

function cloudWorkspaceAmbiguityError(): CapletsError {
  return new CapletsError(
    "REQUEST_INVALID",
    "Cloud Remote Profile requires a selected or explicit workspace.",
    { reason: "cloud_workspace_ambiguous" },
  );
}

function parseStoredRemoteProfile(value: unknown): StoredRemoteProfile | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== 1) return undefined;
  if (value.kind !== "cloud" && value.kind !== "self-hosted") return undefined;
  if (
    typeof value.key !== "string" ||
    typeof value.hostUrl !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string"
  ) {
    return undefined;
  }
  if (value.kind === "cloud" && typeof value.workspaceId !== "string") return undefined;
  if (value.kind === "self-hosted" && typeof value.clientId !== "string") return undefined;
  return {
    version: 1,
    kind: value.kind,
    key: value.key,
    hostUrl: value.hostUrl,
    ...(typeof value.hostIdentity === "string" ? { hostIdentity: value.hostIdentity } : {}),
    ...(typeof value.workspaceId === "string" ? { workspaceId: value.workspaceId } : {}),
    ...(typeof value.workspaceSlug === "string" ? { workspaceSlug: value.workspaceSlug } : {}),
    ...(typeof value.clientId === "string" ? { clientId: value.clientId } : {}),
    ...(typeof value.clientLabel === "string" ? { clientLabel: value.clientLabel } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parseSelectedCloudWorkspace(
  value: unknown,
  expectedHostUrl: string,
): SelectedCloudWorkspace | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.version !== 1 ||
    value.hostUrl !== expectedHostUrl ||
    typeof value.workspace !== "string" ||
    typeof value.profileKey !== "string" ||
    typeof value.selectedAt !== "string"
  ) {
    return undefined;
  }
  return {
    version: 1,
    hostUrl: value.hostUrl,
    workspace: value.workspace,
    profileKey: value.profileKey,
    selectedAt: value.selectedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
