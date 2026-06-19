import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { join } from "node:path";
import { CapletsError } from "../errors";
import { normalizeRemoteProfileHostUrl } from "./options";
import { createPairingCode, parsePairingCode, randomToken } from "./pairing";
import type {
  IssuedRemoteClientCredentials,
  RemoteClientStatus,
  ValidatedRemoteClient,
} from "./server-credentials";

export type RemoteServerCredentialStoreOptions = {
  dir: string;
};

export type CreatePairingCodeInput = {
  hostUrl: string;
  clientLabel?: string | undefined;
  ttlMs?: number | undefined;
  maxAttempts?: number | undefined;
  now?: Date | undefined;
};

export type ExchangePairingCodeInput = {
  hostUrl: string;
  code: string;
  clientLabel?: string | undefined;
  now?: Date | undefined;
};

export type ValidateAccessTokenInput = {
  hostUrl: string;
  accessToken: string;
  now?: Date | undefined;
};

export type RefreshClientCredentialsInput = {
  hostUrl: string;
  refreshToken: string;
  now?: Date | undefined;
};

type StoredPairingCode = {
  codeId: string;
  hostUrl: string;
  secretHash: string;
  clientLabel?: string | undefined;
  createdAt: string;
  expiresAt: string;
  attempts: number;
  maxAttempts: number;
  usedAt?: string | undefined;
};

type StoredRemoteClient = {
  clientId: string;
  clientLabel: string;
  hostUrl: string;
  accessTokenHash: string;
  accessExpiresAt: string;
  refreshTokenHash: string;
  supersededRefreshTokenHashes: SupersededRefreshToken[];
  refreshFamilyId: string;
  createdAt: string;
  lastUsedAt?: string | undefined;
  revokedAt?: string | undefined;
};

type SupersededRefreshToken = {
  hash: string;
  supersededAt: string;
};

type RemoteServerCredentialState = {
  version: 1;
  pairingCodes: StoredPairingCode[];
  clients: StoredRemoteClient[];
};

const DEFAULT_PAIRING_CODE_TTL_MS = 10 * 60_000;
const DEFAULT_PAIRING_CODE_MAX_ATTEMPTS = 5;
const DEFAULT_ACCESS_TOKEN_TTL_MS = 15 * 60_000;
const STALE_REFRESH_REVOKE_GRACE_MS = 30_000;
const SUPERSEDED_REFRESH_TOKEN_RETENTION_MS = 24 * 60 * 60_000;
const STATE_FILE = "remote-server-credentials.json";
const LOCK_DIR = "remote-server-credentials.lock";
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_STALE_MS = 30_000;

export class RemoteServerCredentialStore {
  readonly dir: string;

  constructor(options: RemoteServerCredentialStoreOptions) {
    this.dir = options.dir;
  }

  createPairingCode(input: CreatePairingCodeInput): {
    codeId: string;
    code: string;
    expiresAt: string;
  } {
    return this.withStateLock(() => {
      const now = input.now ?? new Date();
      const issued = createPairingCode();
      const state = this.loadState();
      state.pairingCodes.push({
        codeId: issued.codeId,
        hostUrl: normalizeRemoteProfileHostUrl(input.hostUrl),
        secretHash: hashSecret(issued.secret),
        ...(input.clientLabel ? { clientLabel: input.clientLabel } : {}),
        createdAt: now.toISOString(),
        expiresAt: new Date(
          now.getTime() + (input.ttlMs ?? DEFAULT_PAIRING_CODE_TTL_MS),
        ).toISOString(),
        attempts: 0,
        maxAttempts: input.maxAttempts ?? DEFAULT_PAIRING_CODE_MAX_ATTEMPTS,
      });
      this.saveState(state);
      return {
        codeId: issued.codeId,
        code: issued.code,
        expiresAt: state.pairingCodes.at(-1)!.expiresAt,
      };
    });
  }

  exchangePairingCode(input: ExchangePairingCodeInput): IssuedRemoteClientCredentials {
    return this.withStateLock(() => {
      const now = input.now ?? new Date();
      const parsed = parsePairingCode(input.code);
      if (!parsed) {
        throw new CapletsError("AUTH_FAILED", "Pairing Code format is invalid.");
      }
      const state = this.loadState();
      const pairingCode = state.pairingCodes.find(
        (candidate) => candidate.codeId === parsed.codeId,
      );
      if (!pairingCode) {
        throw new CapletsError("AUTH_FAILED", "Pairing Code is unknown.");
      }
      const hostUrl = normalizeRemoteProfileHostUrl(input.hostUrl);
      if (pairingCode.hostUrl !== hostUrl) {
        throw new CapletsError("AUTH_FAILED", "Pairing Code belongs to a different host.");
      }
      if (pairingCode.usedAt) {
        throw new CapletsError("AUTH_FAILED", "Pairing Code has already been used.");
      }
      if (Date.parse(pairingCode.expiresAt) <= now.getTime()) {
        throw new CapletsError("AUTH_FAILED", "Pairing Code has expired.");
      }
      if (pairingCode.attempts >= pairingCode.maxAttempts) {
        throw new CapletsError("AUTH_FAILED", "Pairing Code attempts exhausted.");
      }
      if (!safeHashEqual(hashSecret(parsed.secret), pairingCode.secretHash)) {
        pairingCode.attempts += 1;
        this.saveState(state);
        throw new CapletsError(
          "AUTH_FAILED",
          pairingCode.attempts >= pairingCode.maxAttempts
            ? "Pairing Code attempts exhausted."
            : "Pairing Code is invalid.",
        );
      }

      pairingCode.usedAt = now.toISOString();
      const clientId = `rcli_${randomToken(12)}`;
      const accessToken = `cap_remote_access_${randomToken(32)}`;
      const refreshToken = `cap_remote_refresh_${randomToken(32)}`;
      const client: StoredRemoteClient = {
        clientId,
        clientLabel: input.clientLabel ?? pairingCode.clientLabel ?? "Caplets Remote Client",
        hostUrl,
        accessTokenHash: hashSecret(accessToken),
        accessExpiresAt: new Date(now.getTime() + DEFAULT_ACCESS_TOKEN_TTL_MS).toISOString(),
        refreshTokenHash: hashSecret(refreshToken),
        supersededRefreshTokenHashes: [],
        refreshFamilyId: randomUUID(),
        createdAt: now.toISOString(),
      };
      state.clients.push(client);
      this.saveState(state);
      return credentialsFromClient(client, accessToken, refreshToken);
    });
  }

  listClients(): RemoteClientStatus[] {
    return this.loadState()
      .clients.map(clientStatus)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  revokeClient(clientId: string, now = new Date()): boolean {
    return this.withStateLock(() => {
      const state = this.loadState();
      const client = state.clients.find((candidate) => candidate.clientId === clientId);
      if (!client) return false;
      client.revokedAt = client.revokedAt ?? now.toISOString();
      this.saveState(state);
      return true;
    });
  }

  validateAccessToken(input: ValidateAccessTokenInput): ValidatedRemoteClient {
    const now = input.now ?? new Date();
    const state = this.loadState();
    const accessTokenHash = hashSecret(input.accessToken);
    const client = state.clients.find((candidate) =>
      safeHashEqual(accessTokenHash, candidate.accessTokenHash),
    );
    if (!client) {
      throw new CapletsError("AUTH_FAILED", "Remote client credential is invalid.");
    }
    validateClient(client, normalizeRemoteProfileHostUrl(input.hostUrl), now);
    return { ...clientStatus(client), tokenType: "Bearer" };
  }

  refreshClientCredentials(input: RefreshClientCredentialsInput): IssuedRemoteClientCredentials {
    return this.withStateLock(() => {
      const now = input.now ?? new Date();
      const state = this.loadState();
      const refreshTokenHash = hashSecret(input.refreshToken);
      const client = state.clients.find((candidate) =>
        safeHashEqual(refreshTokenHash, candidate.refreshTokenHash),
      );
      if (!client) {
        const replayedClient = state.clients.find((candidate) =>
          candidate.supersededRefreshTokenHashes.some((superseded) =>
            safeHashEqual(refreshTokenHash, superseded.hash),
          ),
        );
        if (replayedClient) {
          const superseded = replayedClient.supersededRefreshTokenHashes.find((entry) =>
            safeHashEqual(refreshTokenHash, entry.hash),
          );
          const supersededAt = superseded ? Date.parse(superseded.supersededAt) : Number.NaN;
          if (
            Number.isFinite(supersededAt) &&
            now.getTime() - supersededAt >= STALE_REFRESH_REVOKE_GRACE_MS
          ) {
            replayedClient.revokedAt = now.toISOString();
          }
          this.saveState(state);
          throw new CapletsError("AUTH_FAILED", "Remote refresh credential is stale.");
        }
        throw new CapletsError("AUTH_FAILED", "Remote refresh credential is invalid.");
      }
      validateClient(client, normalizeRemoteProfileHostUrl(input.hostUrl), now, {
        allowExpiredAccess: true,
      });

      const accessToken = `cap_remote_access_${randomToken(32)}`;
      const refreshToken = `cap_remote_refresh_${randomToken(32)}`;
      client.accessTokenHash = hashSecret(accessToken);
      client.accessExpiresAt = new Date(now.getTime() + DEFAULT_ACCESS_TOKEN_TTL_MS).toISOString();
      client.supersededRefreshTokenHashes = pruneSupersededRefreshTokens(
        client.supersededRefreshTokenHashes,
        now,
      );
      client.supersededRefreshTokenHashes.push({
        hash: client.refreshTokenHash,
        supersededAt: now.toISOString(),
      });
      client.refreshTokenHash = hashSecret(refreshToken);
      client.lastUsedAt = now.toISOString();
      this.saveState(state);
      return credentialsFromClient(client, accessToken, refreshToken);
    });
  }

  dumpForTest(): RemoteServerCredentialState {
    return this.loadState();
  }

  private loadState(): RemoteServerCredentialState {
    const path = this.statePath();
    if (!existsSync(path)) return { version: 1, pairingCodes: [], clients: [] };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RemoteServerCredentialState>;
    return {
      version: 1,
      pairingCodes: parsed.pairingCodes ?? [],
      clients: (parsed.clients ?? []).map((client) => ({
        ...client,
        supersededRefreshTokenHashes: parseSupersededRefreshTokens(
          client.supersededRefreshTokenHashes,
        ),
      })),
    };
  }

  private saveState(state: RemoteServerCredentialState): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.dir, 0o700);
    } catch {
      // Best effort on platforms without POSIX permissions.
    }
    const path = this.statePath();
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(tempPath, 0o600);
    } catch {
      // Best effort on platforms without POSIX permissions.
    }
    renameSync(tempPath, path);
  }

  private statePath(): string {
    return join(this.dir, STATE_FILE);
  }

  private lockPath(): string {
    return join(this.dir, LOCK_DIR);
  }

  private withStateLock<T>(operation: () => T): T {
    this.acquireLock();
    try {
      return operation();
    } finally {
      this.releaseLock();
    }
  }

  private acquireLock(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const started = Date.now();
    while (true) {
      try {
        mkdirSync(this.lockPath(), { mode: 0o700 });
        return;
      } catch (error) {
        if (isFileExistsError(error) && this.clearStaleLock()) {
          continue;
        }
        if (!isFileExistsError(error) || Date.now() - started >= LOCK_TIMEOUT_MS) {
          throw new CapletsError("SERVER_UNAVAILABLE", "Remote credential state is locked.");
        }
        sleepSync(10);
      }
    }
  }

  private releaseLock(): void {
    rmSync(this.lockPath(), { recursive: true, force: true });
  }

  private clearStaleLock(): boolean {
    try {
      if (Date.now() - statSync(this.lockPath()).mtimeMs < LOCK_STALE_MS) return false;
      rmSync(this.lockPath(), { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isFileExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

function pruneSupersededRefreshTokens(
  entries: SupersededRefreshToken[],
  now: Date,
): SupersededRefreshToken[] {
  return entries.filter((entry) => {
    const supersededAt = Date.parse(entry.supersededAt);
    return (
      Number.isFinite(supersededAt) &&
      now.getTime() - supersededAt < SUPERSEDED_REFRESH_TOKEN_RETENTION_MS
    );
  });
}

function validateClient(
  client: StoredRemoteClient,
  hostUrl: string,
  now: Date,
  options: { allowExpiredAccess?: boolean } = {},
): void {
  if (client.hostUrl !== hostUrl) {
    throw new CapletsError("AUTH_FAILED", "Remote client credential is for a different host.");
  }
  if (client.revokedAt) {
    throw new CapletsError("AUTH_FAILED", "Remote client credential has been revoked.");
  }
  if (!options.allowExpiredAccess && Date.parse(client.accessExpiresAt) <= now.getTime()) {
    throw new CapletsError("AUTH_FAILED", "Remote client credential has expired.");
  }
}

function credentialsFromClient(
  client: StoredRemoteClient,
  accessToken: string,
  refreshToken: string,
): IssuedRemoteClientCredentials {
  return {
    hostUrl: client.hostUrl,
    clientId: client.clientId,
    clientLabel: client.clientLabel,
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    expiresAt: client.accessExpiresAt,
    createdAt: client.createdAt,
  };
}

function clientStatus(client: StoredRemoteClient): RemoteClientStatus {
  return {
    clientId: client.clientId,
    clientLabel: client.clientLabel,
    hostUrl: client.hostUrl,
    createdAt: client.createdAt,
    ...(client.lastUsedAt ? { lastUsedAt: client.lastUsedAt } : {}),
    ...(client.revokedAt ? { revokedAt: client.revokedAt } : {}),
  };
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

function safeHashEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseSupersededRefreshTokens(value: unknown): SupersededRefreshToken[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      return [{ hash: entry, supersededAt: new Date(0).toISOString() }];
    }
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { hash?: unknown }).hash === "string" &&
      typeof (entry as { supersededAt?: unknown }).supersededAt === "string"
    ) {
      return [
        {
          hash: (entry as { hash: string }).hash,
          supersededAt: (entry as { supersededAt: string }).supersededAt,
        },
      ];
    }
    return [];
  });
}
