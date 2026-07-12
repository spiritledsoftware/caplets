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
import { decryptVaultValue, encryptVaultValue, type VaultEncryptedRecord } from "../vault/crypto";
import {
  AuthorityDomainCodec,
  type AuthorityDomainCodecOptions,
  hashAuthoritySecret,
  safeAuthorityHashEqual,
} from "./authority-codec";
import { normalizeRemoteProfileHostUrl } from "./options";
import { createPairingCode, parsePairingCode, randomToken } from "./pairing";
import type {
  IssuedRemoteClientCredentials,
  RemoteClientRole,
  RemoteClientStatus,
  RemotePendingLoginStatus,
  RemotePendingLoginState,
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

export type CreatePendingLoginInput = {
  hostUrl: string;
  requestedRole?: RemoteClientRole | undefined;
  hostIdentity?: string | undefined;
  clientLabel?: string | undefined;
  clientFingerprint?: string | undefined;
  sourceHint?: string | undefined;
  now?: Date | undefined;
};

export type PendingLoginPossessionInput = {
  flowId: string;
  pendingCompletionSecret: string;
  now?: Date | undefined;
};

export type RefreshPendingLoginInput = PendingLoginPossessionInput & {
  pendingRefreshSecret: string;
};

export type ApprovePendingLoginInput = {
  operatorCode: string;
  grantedRole?: RemoteClientRole | undefined;
  now?: Date | undefined;
};

export type DashboardPendingLoginActionInput = {
  flowId: string;
  grantedRole?: RemoteClientRole | undefined;
  now?: Date | undefined;
};

export type CompletePendingLoginInput = PendingLoginPossessionInput & {
  hostUrl: string;
  requiredRole?: RemoteClientRole | undefined;
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
  role: RemoteClientRole;
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

type PendingLoginStatus = RemotePendingLoginState;

type StoredPendingLogin = {
  flowId: string;
  hostUrl: string;
  hostIdentity?: string | undefined;
  operatorCodeHash: string;
  pendingRefreshHash: string;
  supersededPendingRefreshHashes: SupersededRefreshToken[];
  pendingRefreshReplay?: PendingRefreshReplay | undefined;
  pendingCompletionHash: string;
  completionReplay?: CompletionReplay | undefined;
  clientLabel: string;
  requestedRole: RemoteClientRole;
  grantedRole?: RemoteClientRole | undefined;
  clientFingerprint?: string | undefined;
  sourceHint?: string | undefined;
  createdAt: string;
  codeExpiresAt: string;
  flowExpiresAt: string;
  status: PendingLoginStatus;
  operatorCodeFingerprint?: string | undefined;
  approvedAt?: string | undefined;
  deniedAt?: string | undefined;
  cancelledAt?: string | undefined;
  exchangedAt?: string | undefined;
};

type SupersededRefreshToken = {
  hash: string;
  supersededAt: string;
};

type PendingRefreshReplay = {
  refreshHash: string;
  expiresAt: string;
  encryptedResponse: VaultEncryptedRecord;
};

type CompletionReplay = {
  expiresAt: string;
  encryptedCredentials: VaultEncryptedRecord;
};

type RemoteServerCredentialState = {
  version: 1;
  pairingCodes: StoredPairingCode[];
  pendingLogins: StoredPendingLogin[];
  clients: StoredRemoteClient[];
};

const DEFAULT_PAIRING_CODE_TTL_MS = 10 * 60_000;
const DEFAULT_PAIRING_CODE_MAX_ATTEMPTS = 5;
const DEFAULT_ACCESS_TOKEN_TTL_MS = 15 * 60_000;
const DEFAULT_PENDING_OPERATOR_CODE_TTL_MS = 10 * 60_000;
const DEFAULT_PENDING_FLOW_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_PENDING_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_PENDING_MAX_ACTIVE_FLOWS = 64;
const DEFAULT_PENDING_MAX_ACTIVE_FLOWS_PER_SOURCE = 8;
const PENDING_TERMINAL_RETENTION_MS = 24 * 60 * 60_000;
const STALE_REFRESH_REVOKE_GRACE_MS = 30_000;
const PENDING_SUPERSEDED_REFRESH_HASH_MAX = 16;
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

  createPendingLogin(input: CreatePendingLoginInput): {
    flowId: string;
    operatorCode: string;
    operatorCodeFingerprint: string;
    pendingRefreshSecret: string;
    pendingCompletionSecret: string;
    codeExpiresAt: string;
    flowExpiresAt: string;
    intervalSeconds: number;
  } {
    return this.withStateLock(() => {
      const now = input.now ?? new Date();
      const flowId = `rlogin_${randomToken(12)}`;
      const operatorCode = `cap_login_${randomToken(5)}`;
      const pendingRefreshSecret = `cap_pending_refresh_${randomToken(32)}`;
      const pendingCompletionSecret = `cap_pending_complete_${randomToken(32)}`;
      const codeExpiresAt = new Date(
        now.getTime() + DEFAULT_PENDING_OPERATOR_CODE_TTL_MS,
      ).toISOString();
      const flowExpiresAt = new Date(now.getTime() + DEFAULT_PENDING_FLOW_TTL_MS).toISOString();
      const state = this.loadState();
      cleanupPendingLogins(state, now);
      const clientLabel =
        boundedPendingLoginDisplayValue(input.clientLabel, PENDING_CLIENT_LABEL_MAX_LENGTH) ??
        "Caplets Remote Client";
      const clientFingerprint = boundedPendingLoginDisplayValue(
        input.clientFingerprint,
        PENDING_CLIENT_FINGERPRINT_MAX_LENGTH,
      );
      const sourceHint = boundedPendingLoginDisplayValue(
        input.sourceHint,
        PENDING_SOURCE_HINT_MAX_LENGTH,
      );
      enforcePendingLoginQuota(state, sourceHint);
      state.pendingLogins.push({
        flowId,
        hostUrl: normalizeRemoteProfileHostUrl(input.hostUrl),
        requestedRole: input.requestedRole ?? "access",
        ...(input.hostIdentity ? { hostIdentity: input.hostIdentity } : {}),
        operatorCodeHash: hashSecret(operatorCode),
        pendingRefreshHash: hashSecret(pendingRefreshSecret),
        supersededPendingRefreshHashes: [],
        pendingCompletionHash: hashSecret(pendingCompletionSecret),
        operatorCodeFingerprint: pendingOperatorCodeFingerprint(operatorCode),
        clientLabel,
        ...(clientFingerprint ? { clientFingerprint } : {}),
        ...(sourceHint ? { sourceHint } : {}),
        createdAt: now.toISOString(),
        codeExpiresAt,
        flowExpiresAt,
        status: "pending",
      });
      this.saveState(state);
      return {
        flowId,
        operatorCode,
        operatorCodeFingerprint: pendingOperatorCodeFingerprint(operatorCode),
        pendingRefreshSecret,
        pendingCompletionSecret,
        codeExpiresAt,
        flowExpiresAt,
        intervalSeconds: DEFAULT_PENDING_POLL_INTERVAL_SECONDS,
      };
    });
  }

  pollPendingLogin(input: PendingLoginPossessionInput): {
    flowId: string;
    status: PendingLoginStatus;
  } {
    const now = input.now ?? new Date();
    const flow = this.pendingLoginForCompletion(input.flowId, input.pendingCompletionSecret, now);
    return { flowId: flow.flowId, status: flow.status };
  }

  refreshPendingLogin(input: RefreshPendingLoginInput): {
    flowId: string;
    operatorCode: string;
    operatorCodeFingerprint: string;
    pendingRefreshSecret: string;
    codeExpiresAt: string;
    flowExpiresAt: string;
    intervalSeconds: number;
  } {
    return this.withStateLock(() => {
      const now = input.now ?? new Date();
      const state = this.loadState();
      cleanupPendingLogins(state, now);
      const flow = this.pendingLoginForCompletion(
        input.flowId,
        input.pendingCompletionSecret,
        now,
        state,
      );
      if (flow.status !== "pending") {
        throw new CapletsError("AUTH_FAILED", `Pending login is already ${flow.status}.`);
      }
      const refreshHash = hashSecret(input.pendingRefreshSecret);
      if (!safeHashEqual(refreshHash, flow.pendingRefreshHash)) {
        if (
          flow.pendingRefreshReplay &&
          safeHashEqual(refreshHash, flow.pendingRefreshReplay.refreshHash) &&
          Date.parse(flow.pendingRefreshReplay.expiresAt) > now.getTime()
        ) {
          return decryptPendingRefreshReplay(
            flow.pendingRefreshReplay,
            input.pendingCompletionSecret,
          );
        }
        if (
          flow.supersededPendingRefreshHashes.some((entry) =>
            safeHashEqual(refreshHash, entry.hash),
          )
        ) {
          throw new CapletsError("AUTH_FAILED", "Pending login refresh material is stale.");
        }
        throw new CapletsError("AUTH_FAILED", "Pending login refresh material is invalid.");
      }

      const operatorCode = `cap_login_${randomToken(5)}`;
      const pendingRefreshSecret = `cap_pending_refresh_${randomToken(32)}`;
      const codeExpiresAt = new Date(
        now.getTime() + DEFAULT_PENDING_OPERATOR_CODE_TTL_MS,
      ).toISOString();
      const response = {
        flowId: flow.flowId,
        operatorCode,
        operatorCodeFingerprint: pendingOperatorCodeFingerprint(operatorCode),
        pendingRefreshSecret,
        codeExpiresAt,
        flowExpiresAt: flow.flowExpiresAt,
        intervalSeconds: DEFAULT_PENDING_POLL_INTERVAL_SECONDS,
      };
      flow.operatorCodeHash = hashSecret(operatorCode);
      flow.operatorCodeFingerprint = response.operatorCodeFingerprint;
      flow.supersededPendingRefreshHashes = pruneSupersededRefreshTokens(
        flow.supersededPendingRefreshHashes,
        now,
      );
      flow.pendingRefreshReplay = {
        refreshHash: flow.pendingRefreshHash,
        expiresAt: new Date(now.getTime() + STALE_REFRESH_REVOKE_GRACE_MS).toISOString(),
        encryptedResponse: encryptReplayValue(response, input.pendingCompletionSecret, now),
      };
      flow.supersededPendingRefreshHashes.push({
        hash: flow.pendingRefreshHash,
        supersededAt: now.toISOString(),
      });
      flow.supersededPendingRefreshHashes = capSupersededRefreshTokens(
        flow.supersededPendingRefreshHashes,
      );
      flow.pendingRefreshHash = hashSecret(pendingRefreshSecret);
      flow.codeExpiresAt = codeExpiresAt;
      this.saveState(state);
      return response;
    });
  }

  denyPendingLogin(input: ApprovePendingLoginInput): RemotePendingLoginStatus {
    return this.withStateLock(() => {
      const now = input.now ?? new Date();
      const state = this.loadState();
      cleanupPendingLogins(state, now);
      const operatorCodeHash = hashSecret(input.operatorCode);
      const flow = state.pendingLogins.find((candidate) =>
        safeHashEqual(operatorCodeHash, candidate.operatorCodeHash),
      );
      if (!flow) throw new CapletsError("AUTH_FAILED", "Pending login code is unknown.");
      denyPendingLoginFlow(flow, now);
      this.saveState(state);
      return pendingLoginStatus(flow);
    });
  }

  denyPendingLoginFlow(input: DashboardPendingLoginActionInput): RemotePendingLoginStatus {
    return this.withStateLock(() => {
      const now = input.now ?? new Date();
      const state = this.loadState();
      cleanupPendingLogins(state, now);
      const flow = state.pendingLogins.find((candidate) => candidate.flowId === input.flowId);
      if (!flow) throw new CapletsError("AUTH_FAILED", "Pending login flow is unknown.");
      denyPendingLoginFlow(flow, now);
      this.saveState(state);
      return pendingLoginStatus(flow);
    });
  }

  cancelPendingLogin(input: PendingLoginPossessionInput): {
    flowId: string;
    status: "cancelled";
  } {
    return this.withStateLock(() => {
      const now = input.now ?? new Date();
      const state = this.loadState();
      cleanupPendingLogins(state, now);
      const flow = this.pendingLoginForCompletion(
        input.flowId,
        input.pendingCompletionSecret,
        now,
        state,
      );
      if (flow.status !== "pending" && flow.status !== "approved") {
        throw new CapletsError("AUTH_FAILED", `Pending login is already ${flow.status}.`);
      }
      flow.status = "cancelled";
      flow.cancelledAt = now.toISOString();
      this.saveState(state);
      return { flowId: flow.flowId, status: "cancelled" };
    });
  }

  approvePendingLogin(input: ApprovePendingLoginInput): {
    flowId: string;
    status: "approved";
    clientLabel: string;
    requestedRole: RemoteClientRole;
    grantedRole: RemoteClientRole;
    clientFingerprint?: string | undefined;
    sourceHint?: string | undefined;
  } {
    return this.withStateLock(() => {
      const now = input.now ?? new Date();
      const state = this.loadState();
      cleanupPendingLogins(state, now);
      const operatorCodeHash = hashSecret(input.operatorCode);
      const flow = state.pendingLogins.find((candidate) =>
        safeHashEqual(operatorCodeHash, candidate.operatorCodeHash),
      );
      if (!flow) throw new CapletsError("AUTH_FAILED", "Pending login code is unknown.");
      if (flow.status !== "pending") {
        throw new CapletsError("AUTH_FAILED", `Pending login is already ${flow.status}.`);
      }
      if (Date.parse(flow.flowExpiresAt) <= now.getTime()) {
        flow.status = "expired";
        this.saveState(state);
        throw new CapletsError("AUTH_FAILED", "Pending login has expired.");
      }
      assertPendingOperatorCodeFresh(flow, now);
      flow.status = "approved";
      flow.grantedRole = input.grantedRole ?? flow.requestedRole;
      flow.approvedAt = now.toISOString();
      this.saveState(state);
      return pendingApprovalStatus(flow);
    });
  }

  approvePendingLoginFlow(input: DashboardPendingLoginActionInput): RemotePendingLoginStatus {
    return this.withStateLock(() => {
      const now = input.now ?? new Date();
      const state = this.loadState();
      cleanupPendingLogins(state, now);
      const flow = state.pendingLogins.find((candidate) => candidate.flowId === input.flowId);
      if (!flow) throw new CapletsError("AUTH_FAILED", "Pending login flow is unknown.");
      approvePendingLoginFlow(flow, input.grantedRole, now);
      this.saveState(state);
      return pendingLoginStatus(flow);
    });
  }

  completePendingLogin(input: CompletePendingLoginInput): IssuedRemoteClientCredentials {
    return this.withStateLock(() => {
      const now = input.now ?? new Date();
      const state = this.loadState();
      cleanupPendingLogins(state, now);
      const flow = this.pendingLoginForCompletion(
        input.flowId,
        input.pendingCompletionSecret,
        now,
        state,
      );
      if (flow.hostUrl !== normalizeRemoteProfileHostUrl(input.hostUrl)) {
        throw new CapletsError("AUTH_FAILED", "Pending login belongs to a different host.");
      }
      if (flow.status !== "approved") {
        if (
          flow.status === "exchanged" &&
          flow.completionReplay &&
          Date.parse(flow.completionReplay.expiresAt) > now.getTime()
        ) {
          return decryptCompletionReplay(flow.completionReplay, input.pendingCompletionSecret);
        }
        throw new CapletsError(
          "AUTH_FAILED",
          flow.status === "exchanged"
            ? "Pending login has already been exchanged."
            : `Pending login is ${flow.status}, not approved.`,
        );
      }

      const role = flow.grantedRole ?? flow.requestedRole;
      if (input.requiredRole !== undefined && role !== input.requiredRole) {
        throw new CapletsError("AUTH_FAILED", `${input.requiredRole} role is required.`);
      }

      const accessToken = `cap_remote_access_${randomToken(32)}`;
      const refreshToken = `cap_remote_refresh_${randomToken(32)}`;
      const client: StoredRemoteClient = {
        clientId: `rcli_${randomToken(12)}`,
        clientLabel: flow.clientLabel,
        role,
        hostUrl: flow.hostUrl,
        accessTokenHash: hashSecret(accessToken),
        accessExpiresAt: new Date(now.getTime() + DEFAULT_ACCESS_TOKEN_TTL_MS).toISOString(),
        refreshTokenHash: hashSecret(refreshToken),
        supersededRefreshTokenHashes: [],
        refreshFamilyId: randomUUID(),
        createdAt: now.toISOString(),
      };
      state.clients.push(client);
      flow.status = "exchanged";
      flow.exchangedAt = now.toISOString();
      const credentials = credentialsFromClient(client, accessToken, refreshToken);
      flow.completionReplay = {
        expiresAt: new Date(now.getTime() + STALE_REFRESH_REVOKE_GRACE_MS).toISOString(),
        encryptedCredentials: encryptReplayValue(credentials, input.pendingCompletionSecret, now),
      };
      this.saveState(state);
      return credentials;
    });
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
        role: "access",
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

  listPendingLogins(now = new Date()): RemotePendingLoginStatus[] {
    return this.withStateLock(() => {
      const state = this.loadState();
      if (cleanupPendingLogins(state, now)) this.saveState(state);
      return state.pendingLogins
        .map(pendingLoginStatus)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    });
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

  changeClientRole(clientId: string, role: RemoteClientRole): RemoteClientStatus | undefined {
    return this.withStateLock(() => {
      const state = this.loadState();
      const client = state.clients.find((candidate) => candidate.clientId === clientId);
      if (!client) return undefined;
      client.role = role;
      this.saveState(state);
      return clientStatus(client);
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
          throw new CapletsError(
            "REMOTE_CREDENTIALS_REVOKED",
            "Remote refresh credential is stale.",
          );
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
    if (!existsSync(path)) return { version: 1, pairingCodes: [], pendingLogins: [], clients: [] };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RemoteServerCredentialState>;
    return {
      version: 1,
      pairingCodes: parsed.pairingCodes ?? [],
      pendingLogins: (parsed.pendingLogins ?? []).map((pending) => ({
        ...pending,
        requestedRole: parseRemoteClientRole(pending.requestedRole),
        ...(pending.grantedRole ? { grantedRole: parseRemoteClientRole(pending.grantedRole) } : {}),
        supersededPendingRefreshHashes: parseSupersededRefreshTokens(
          pending.supersededPendingRefreshHashes,
        ),
      })),
      clients: (parsed.clients ?? []).map((client) => ({
        ...client,
        role: parseRemoteClientRole(client.role),
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

  private pendingLoginForCompletion(
    flowId: string,
    pendingCompletionSecret: string,
    now: Date,
    state = this.loadState(),
  ): StoredPendingLogin {
    const flow = state.pendingLogins.find((candidate) => candidate.flowId === flowId);
    if (!flow) throw new CapletsError("AUTH_FAILED", "Pending login is unknown.");
    if (!safeHashEqual(hashSecret(pendingCompletionSecret), flow.pendingCompletionHash)) {
      throw new CapletsError("AUTH_FAILED", "Pending login possession material is invalid.");
    }
    if (Date.parse(flow.flowExpiresAt) <= now.getTime() && isActivePendingLogin(flow)) {
      flow.status = "expired";
    }
    return flow;
  }
}

export type AuthorityRemoteServerCredentialStoreOptions = AuthorityDomainCodecOptions & {
  dir?: string | undefined;
};

type AuthorityMutationOptions = {
  idempotencyKey?: string | undefined;
  principalId?: string | undefined;
};

type AuthorityRemoteStateMutation<TResult> = {
  result: TResult;
  root?: Record<string, unknown> | undefined;
};

const REMOTE_CREDENTIAL_DOMAIN = "remoteCredentials";

/**
 * Shared-authority credential codec. The synchronous store above remains the
 * compatibility path for local filesystem deployments; this codec never
 * exposes plaintext tokens to the authority snapshot or receipt.
 */
export class AuthorityRemoteServerCredentialStore {
  readonly dir: string;
  private readonly codec: AuthorityDomainCodec;

  constructor(options: AuthorityRemoteServerCredentialStoreOptions) {
    this.dir = options.dir ?? "";
    this.codec = new AuthorityDomainCodec(options);
  }

  async createPendingLogin(input: CreatePendingLoginInput & AuthorityMutationOptions): Promise<{
    flowId: string;
    operatorCode: string;
    operatorCodeFingerprint: string;
    pendingRefreshSecret: string;
    pendingCompletionSecret: string;
    codeExpiresAt: string;
    flowExpiresAt: string;
    intervalSeconds: number;
  }> {
    const now = input.now ?? new Date();
    return (
      await this.mutate(
        input,
        "create_pending_login",
        (state, _root) => {
          const flowId = `rlogin_${randomToken(12)}`;
          const operatorCode = `cap_login_${randomToken(5)}`;
          const pendingRefreshSecret = `cap_pending_refresh_${randomToken(32)}`;
          const pendingCompletionSecret = `cap_pending_complete_${randomToken(32)}`;
          const codeExpiresAt = new Date(
            now.getTime() + DEFAULT_PENDING_OPERATOR_CODE_TTL_MS,
          ).toISOString();
          const flowExpiresAt = new Date(now.getTime() + DEFAULT_PENDING_FLOW_TTL_MS).toISOString();
          cleanupPendingLogins(state, now);
          const clientLabel =
            boundedPendingLoginDisplayValue(input.clientLabel, PENDING_CLIENT_LABEL_MAX_LENGTH) ??
            "Caplets Remote Client";
          const clientFingerprint = boundedPendingLoginDisplayValue(
            input.clientFingerprint,
            PENDING_CLIENT_FINGERPRINT_MAX_LENGTH,
          );
          const sourceHint = boundedPendingLoginDisplayValue(
            input.sourceHint,
            PENDING_SOURCE_HINT_MAX_LENGTH,
          );
          enforcePendingLoginQuota(state, sourceHint);
          state.pendingLogins.push({
            flowId,
            hostUrl: normalizeRemoteProfileHostUrl(input.hostUrl),
            requestedRole: input.requestedRole ?? "access",
            ...(input.hostIdentity ? { hostIdentity: input.hostIdentity } : {}),
            operatorCodeHash: hashAuthoritySecret(operatorCode),
            pendingRefreshHash: hashAuthoritySecret(pendingRefreshSecret),
            supersededPendingRefreshHashes: [],
            pendingCompletionHash: hashAuthoritySecret(pendingCompletionSecret),
            operatorCodeFingerprint: pendingOperatorCodeFingerprint(operatorCode),
            clientLabel,
            ...(clientFingerprint ? { clientFingerprint } : {}),
            ...(sourceHint ? { sourceHint } : {}),
            createdAt: now.toISOString(),
            codeExpiresAt,
            flowExpiresAt,
            status: "pending",
          });
          return {
            result: {
              flowId,
              operatorCode,
              operatorCodeFingerprint: pendingOperatorCodeFingerprint(operatorCode),
              pendingRefreshSecret,
              pendingCompletionSecret,
              codeExpiresAt,
              flowExpiresAt,
              intervalSeconds: DEFAULT_PENDING_POLL_INTERVAL_SECONDS,
            },
          };
        },
        now,
      )
    ).result;
  }

  async pollPendingLogin(
    input: PendingLoginPossessionInput & AuthorityMutationOptions,
  ): Promise<{ flowId: string; status: PendingLoginStatus }> {
    const now = input.now ?? new Date();
    const read = await this.codec.read();
    const state = parseAuthorityRemoteState(
      this.codec.domainSnapshot(read, REMOTE_CREDENTIAL_DOMAIN),
    );
    const flow = authorityPendingLoginForCompletion(
      state,
      input.flowId,
      input.pendingCompletionSecret,
      now,
    );
    return { flowId: flow.flowId, status: flow.status };
  }

  async refreshPendingLogin(input: RefreshPendingLoginInput & AuthorityMutationOptions): Promise<{
    flowId: string;
    operatorCode: string;
    operatorCodeFingerprint: string;
    pendingRefreshSecret: string;
    codeExpiresAt: string;
    flowExpiresAt: string;
    intervalSeconds: number;
  }> {
    const now = input.now ?? new Date();
    const read = await this.codec.read();
    const state = parseAuthorityRemoteState(
      this.codec.domainSnapshot(read, REMOTE_CREDENTIAL_DOMAIN),
    );
    cleanupPendingLogins(state, now);
    const flow = authorityPendingLoginForCompletion(
      state,
      input.flowId,
      input.pendingCompletionSecret,
      now,
    );
    if (flow.status !== "pending")
      throw new CapletsError("AUTH_FAILED", `Pending login is already ${flow.status}.`);
    const refreshHash = hashAuthoritySecret(input.pendingRefreshSecret);
    if (!safeAuthorityHashEqual(refreshHash, flow.pendingRefreshHash)) {
      if (
        flow.pendingRefreshReplay &&
        safeAuthorityHashEqual(refreshHash, flow.pendingRefreshReplay.refreshHash) &&
        Date.parse(flow.pendingRefreshReplay.expiresAt) > now.getTime()
      ) {
        return this.codec.decrypt(flow.pendingRefreshReplay.encryptedResponse);
      }
      if (
        flow.supersededPendingRefreshHashes.some((entry) =>
          safeAuthorityHashEqual(refreshHash, entry.hash),
        )
      ) {
        throw new CapletsError("AUTH_FAILED", "Pending login refresh material is stale.");
      }
      throw new CapletsError("AUTH_FAILED", "Pending login refresh material is invalid.");
    }
    return (
      await this.mutate(
        input,
        "refresh_pending_login",
        (nextState) => {
          const nextFlow = nextState.pendingLogins.find(
            (candidate) => candidate.flowId === input.flowId,
          );
          if (!nextFlow) throw new CapletsError("AUTH_FAILED", "Pending login is unknown.");
          const operatorCode = `cap_login_${randomToken(5)}`;
          const pendingRefreshSecret = `cap_pending_refresh_${randomToken(32)}`;
          const codeExpiresAt = new Date(
            now.getTime() + DEFAULT_PENDING_OPERATOR_CODE_TTL_MS,
          ).toISOString();
          const response = {
            flowId: nextFlow.flowId,
            operatorCode,
            operatorCodeFingerprint: pendingOperatorCodeFingerprint(operatorCode),
            pendingRefreshSecret,
            codeExpiresAt,
            flowExpiresAt: nextFlow.flowExpiresAt,
            intervalSeconds: DEFAULT_PENDING_POLL_INTERVAL_SECONDS,
          };
          nextFlow.operatorCodeHash = hashAuthoritySecret(operatorCode);
          nextFlow.operatorCodeFingerprint = response.operatorCodeFingerprint;
          nextFlow.supersededPendingRefreshHashes = capSupersededRefreshTokens(
            pruneSupersededRefreshTokens(nextFlow.supersededPendingRefreshHashes, now),
          );
          nextFlow.pendingRefreshReplay = {
            refreshHash: nextFlow.pendingRefreshHash,
            expiresAt: new Date(now.getTime() + STALE_REFRESH_REVOKE_GRACE_MS).toISOString(),
            encryptedResponse: this.codec.encrypt(response, now),
          };
          nextFlow.supersededPendingRefreshHashes.push({
            hash: nextFlow.pendingRefreshHash,
            supersededAt: now.toISOString(),
          });
          nextFlow.supersededPendingRefreshHashes = capSupersededRefreshTokens(
            nextFlow.supersededPendingRefreshHashes,
          );
          nextFlow.pendingRefreshHash = hashAuthoritySecret(pendingRefreshSecret);
          nextFlow.codeExpiresAt = codeExpiresAt;
          return { result: response };
        },
        now,
      )
    ).result;
  }

  async approvePendingLogin(input: ApprovePendingLoginInput & AuthorityMutationOptions): Promise<{
    flowId: string;
    status: "approved";
    clientLabel: string;
    requestedRole: RemoteClientRole;
    grantedRole: RemoteClientRole;
    clientFingerprint?: string | undefined;
    sourceHint?: string | undefined;
  }> {
    const now = input.now ?? new Date();
    return (
      await this.mutate(
        input,
        "approve_pending_login",
        (state) => {
          cleanupPendingLogins(state, now);
          const hash = hashAuthoritySecret(input.operatorCode);
          const flow = state.pendingLogins.find((candidate) =>
            safeAuthorityHashEqual(hash, candidate.operatorCodeHash),
          );
          if (!flow) throw new CapletsError("AUTH_FAILED", "Pending login code is unknown.");
          approvePendingLoginFlow(flow, input.grantedRole, now);
          return { result: pendingApprovalStatus(flow) };
        },
        now,
      )
    ).result;
  }

  async denyPendingLogin(
    input: ApprovePendingLoginInput & AuthorityMutationOptions,
  ): Promise<RemotePendingLoginStatus> {
    const now = input.now ?? new Date();
    return (
      await this.mutate(
        input,
        "deny_pending_login",
        (state) => {
          cleanupPendingLogins(state, now);
          const hash = hashAuthoritySecret(input.operatorCode);
          const flow = state.pendingLogins.find((candidate) =>
            safeAuthorityHashEqual(hash, candidate.operatorCodeHash),
          );
          if (!flow) throw new CapletsError("AUTH_FAILED", "Pending login code is unknown.");
          denyPendingLoginFlow(flow, now);
          return { result: pendingLoginStatus(flow) };
        },
        now,
      )
    ).result;
  }

  async approvePendingLoginFlow(
    input: DashboardPendingLoginActionInput & AuthorityMutationOptions,
  ): Promise<RemotePendingLoginStatus> {
    const now = input.now ?? new Date();
    return (
      await this.mutate(
        input,
        "approve_pending_login_flow",
        (state) => {
          cleanupPendingLogins(state, now);
          const flow = state.pendingLogins.find((candidate) => candidate.flowId === input.flowId);
          if (!flow) throw new CapletsError("AUTH_FAILED", "Pending login flow is unknown.");
          approvePendingLoginFlow(flow, input.grantedRole, now);
          return { result: pendingLoginStatus(flow) };
        },
        now,
      )
    ).result;
  }

  async denyPendingLoginFlow(
    input: DashboardPendingLoginActionInput & AuthorityMutationOptions,
  ): Promise<RemotePendingLoginStatus> {
    const now = input.now ?? new Date();
    return (
      await this.mutate(
        input,
        "deny_pending_login_flow",
        (state) => {
          cleanupPendingLogins(state, now);
          const flow = state.pendingLogins.find((candidate) => candidate.flowId === input.flowId);
          if (!flow) throw new CapletsError("AUTH_FAILED", "Pending login flow is unknown.");
          denyPendingLoginFlow(flow, now);
          return { result: pendingLoginStatus(flow) };
        },
        now,
      )
    ).result;
  }

  async cancelPendingLogin(
    input: PendingLoginPossessionInput & AuthorityMutationOptions,
  ): Promise<{ flowId: string; status: "cancelled" }> {
    const now = input.now ?? new Date();
    return (
      await this.mutate(
        input,
        "cancel_pending_login",
        (state) => {
          cleanupPendingLogins(state, now);
          const flow = authorityPendingLoginForCompletion(
            state,
            input.flowId,
            input.pendingCompletionSecret,
            now,
          );
          if (flow.status !== "pending" && flow.status !== "approved") {
            throw new CapletsError("AUTH_FAILED", `Pending login is already ${flow.status}.`);
          }
          flow.status = "cancelled";
          flow.cancelledAt = now.toISOString();
          return { result: { flowId: flow.flowId, status: "cancelled" as const } };
        },
        now,
      )
    ).result;
  }

  async completePendingLogin(
    input: CompletePendingLoginInput & AuthorityMutationOptions,
  ): Promise<IssuedRemoteClientCredentials> {
    const now = input.now ?? new Date();
    const read = await this.codec.read();
    const state = parseAuthorityRemoteState(
      this.codec.domainSnapshot(read, REMOTE_CREDENTIAL_DOMAIN),
    );
    const flow = authorityPendingLoginForCompletion(
      state,
      input.flowId,
      input.pendingCompletionSecret,
      now,
    );
    if (flow.hostUrl !== normalizeRemoteProfileHostUrl(input.hostUrl))
      throw new CapletsError("AUTH_FAILED", "Pending login belongs to a different host.");
    if (
      flow.status === "exchanged" &&
      flow.completionReplay &&
      Date.parse(flow.completionReplay.expiresAt) > now.getTime()
    ) {
      return this.codec.decrypt(flow.completionReplay.encryptedCredentials);
    }
    if (flow.status !== "approved") {
      throw new CapletsError(
        "AUTH_FAILED",
        flow.status === "exchanged"
          ? "Pending login has already been exchanged."
          : `Pending login is ${flow.status}, not approved.`,
      );
    }
    const role = flow.grantedRole ?? flow.requestedRole;
    if (input.requiredRole !== undefined && role !== input.requiredRole)
      throw new CapletsError("AUTH_FAILED", `${input.requiredRole} role is required.`);
    return (
      await this.mutate(
        input,
        "complete_pending_login",
        (nextState) => {
          const nextFlow = nextState.pendingLogins.find(
            (candidate) => candidate.flowId === input.flowId,
          );
          if (!nextFlow || nextFlow.status !== "approved")
            throw new CapletsError("AUTH_FAILED", "Pending login is no longer approved.");
          const accessToken = `cap_remote_access_${randomToken(32)}`;
          const refreshToken = `cap_remote_refresh_${randomToken(32)}`;
          const client: StoredRemoteClient = {
            clientId: `rcli_${randomToken(12)}`,
            clientLabel: nextFlow.clientLabel,
            role: nextFlow.grantedRole ?? nextFlow.requestedRole,
            hostUrl: nextFlow.hostUrl,
            accessTokenHash: hashAuthoritySecret(accessToken),
            accessExpiresAt: new Date(now.getTime() + DEFAULT_ACCESS_TOKEN_TTL_MS).toISOString(),
            refreshTokenHash: hashAuthoritySecret(refreshToken),
            supersededRefreshTokenHashes: [],
            refreshFamilyId: randomUUID(),
            createdAt: now.toISOString(),
          };
          nextState.clients.push(client);
          nextFlow.status = "exchanged";
          nextFlow.exchangedAt = now.toISOString();
          const credentials = credentialsFromClient(client, accessToken, refreshToken);
          nextFlow.completionReplay = {
            expiresAt: new Date(now.getTime() + STALE_REFRESH_REVOKE_GRACE_MS).toISOString(),
            encryptedCredentials: this.codec.encrypt(credentials, now),
          };
          return { result: credentials };
        },
        now,
      )
    ).result;
  }

  async revokeClient(
    clientId: string,
    now = new Date(),
    options: AuthorityMutationOptions = {},
  ): Promise<boolean> {
    const read = await this.codec.read();
    const existing = parseAuthorityRemoteState(
      this.codec.domainSnapshot(read, REMOTE_CREDENTIAL_DOMAIN),
    ).clients.find((candidate) => candidate.clientId === clientId);
    if (!existing) return false;
    const sessionIds = authorityDashboardSessionIds(read.snapshot, clientId);
    const result = (
      await this.mutate(
        { ...options, now, payload: { clientId } },
        "revoke_client",
        (state, root) => {
          const client = state.clients.find((candidate) => candidate.clientId === clientId);
          if (!client) return { result: false };
          client.revokedAt = client.revokedAt ?? now.toISOString();
          return { result: true, root: removeAuthorityDashboardSessions(root, clientId) };
        },
        now,
      )
    ).result;
    if (result) await this.removeDashboardSessionTouches(sessionIds);
    return result;
  }

  async changeClientRole(
    clientId: string,
    role: RemoteClientRole,
    now = new Date(),
    options: AuthorityMutationOptions = {},
  ): Promise<RemoteClientStatus | undefined> {
    const read = await this.codec.read();
    const existing = parseAuthorityRemoteState(
      this.codec.domainSnapshot(read, REMOTE_CREDENTIAL_DOMAIN),
    ).clients.find((candidate) => candidate.clientId === clientId);
    if (!existing) return undefined;
    const sessionIds =
      role === "operator" ? [] : authorityDashboardSessionIds(read.snapshot, clientId);
    const result = (
      await this.mutate(
        { ...options, now, payload: { clientId, role } },
        "change_client_role",
        (state, root) => {
          const client = state.clients.find((candidate) => candidate.clientId === clientId);
          if (!client) return { result: undefined };
          client.role = role;
          return {
            result: clientStatus(client),
            root: role === "operator" ? root : removeAuthorityDashboardSessions(root, clientId),
          };
        },
        now,
      )
    ).result;
    if (result && sessionIds.length > 0) await this.removeDashboardSessionTouches(sessionIds);
    return result;
  }

  private async removeDashboardSessionTouches(sessionIds: string[]): Promise<void> {
    await Promise.all(
      sessionIds.map((sessionId) =>
        this.codec.commitAuxiliary({ kind: "remove_session_touch", sessionId }),
      ),
    );
  }

  async listClients(): Promise<RemoteClientStatus[]> {
    const read = await this.codec.read();
    return parseAuthorityRemoteState(this.codec.domainSnapshot(read, REMOTE_CREDENTIAL_DOMAIN))
      .clients.map(clientStatus)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async listPendingLogins(now = new Date()): Promise<RemotePendingLoginStatus[]> {
    const read = await this.codec.read();
    const state = parseAuthorityRemoteState(
      this.codec.domainSnapshot(read, REMOTE_CREDENTIAL_DOMAIN),
    );
    cleanupPendingLogins(state, now);
    return state.pendingLogins
      .map(pendingLoginStatus)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  async validateAccessToken(
    input: ValidateAccessTokenInput & AuthorityMutationOptions,
  ): Promise<ValidatedRemoteClient> {
    const now = input.now ?? new Date();
    const read = await this.codec.read();
    const state = parseAuthorityRemoteState(
      this.codec.domainSnapshot(read, REMOTE_CREDENTIAL_DOMAIN),
    );
    const accessTokenHash = hashAuthoritySecret(input.accessToken);
    const client = state.clients.find((candidate) =>
      safeAuthorityHashEqual(accessTokenHash, candidate.accessTokenHash),
    );
    if (!client) throw new CapletsError("AUTH_FAILED", "Remote client credential is invalid.");
    validateClient(client, normalizeRemoteProfileHostUrl(input.hostUrl), now);
    return { ...clientStatus(client), tokenType: "Bearer" };
  }

  async refreshClientCredentials(
    input: RefreshClientCredentialsInput & AuthorityMutationOptions,
  ): Promise<IssuedRemoteClientCredentials> {
    const now = input.now ?? new Date();
    const read = await this.codec.read();
    const state = parseAuthorityRemoteState(
      this.codec.domainSnapshot(read, REMOTE_CREDENTIAL_DOMAIN),
    );
    const refreshTokenHash = hashAuthoritySecret(input.refreshToken);
    const client = state.clients.find((candidate) =>
      safeAuthorityHashEqual(refreshTokenHash, candidate.refreshTokenHash),
    );
    if (!client) {
      const replayedClient = state.clients.find((candidate) =>
        candidate.supersededRefreshTokenHashes.some((entry) =>
          safeAuthorityHashEqual(refreshTokenHash, entry.hash),
        ),
      );
      if (replayedClient) {
        const superseded = replayedClient.supersededRefreshTokenHashes.find((entry) =>
          safeAuthorityHashEqual(refreshTokenHash, entry.hash),
        );
        const supersededAt = superseded ? Date.parse(superseded.supersededAt) : Number.NaN;
        if (
          Number.isFinite(supersededAt) &&
          now.getTime() - supersededAt >= STALE_REFRESH_REVOKE_GRACE_MS
        )
          replayedClient.revokedAt = now.toISOString();
        throw new CapletsError("REMOTE_CREDENTIALS_REVOKED", "Remote refresh credential is stale.");
      }
      throw new CapletsError("AUTH_FAILED", "Remote refresh credential is invalid.");
    }
    validateClient(client, normalizeRemoteProfileHostUrl(input.hostUrl), now, {
      allowExpiredAccess: true,
    });
    return (
      await this.mutate(
        input,
        "refresh_client_credentials",
        (nextState) => {
          const nextClient = nextState.clients.find(
            (candidate) => candidate.clientId === client.clientId,
          );
          if (!nextClient)
            throw new CapletsError("AUTH_FAILED", "Remote client credential is invalid.");
          const accessToken = `cap_remote_access_${randomToken(32)}`;
          const refreshToken = `cap_remote_refresh_${randomToken(32)}`;
          nextClient.accessTokenHash = hashAuthoritySecret(accessToken);
          nextClient.accessExpiresAt = new Date(
            now.getTime() + DEFAULT_ACCESS_TOKEN_TTL_MS,
          ).toISOString();
          nextClient.supersededRefreshTokenHashes = pruneSupersededRefreshTokens(
            nextClient.supersededRefreshTokenHashes,
            now,
          );
          nextClient.supersededRefreshTokenHashes.push({
            hash: nextClient.refreshTokenHash,
            supersededAt: now.toISOString(),
          });
          nextClient.refreshTokenHash = hashAuthoritySecret(refreshToken);
          nextClient.lastUsedAt = now.toISOString();
          return { result: credentialsFromClient(nextClient, accessToken, refreshToken) };
        },
        now,
      )
    ).result;
  }

  async dumpForTest(): Promise<RemoteCredentialAuthoritySnapshot> {
    const read = await this.codec.read();
    return parseAuthorityRemoteState(this.codec.domainSnapshot(read, REMOTE_CREDENTIAL_DOMAIN));
  }

  private async mutate<TResult>(
    input: AuthorityMutationOptions & { now?: Date | undefined; payload?: unknown },
    kind: string,
    operation: (
      state: RemoteServerCredentialState,
      root: Record<string, unknown>,
    ) => AuthorityRemoteStateMutation<TResult>,
    now = input.now ?? new Date(),
  ): Promise<{ kind: "committed" | "replayed"; result: TResult }> {
    const read = await this.codec.read();
    const state = parseAuthorityRemoteState(
      this.codec.domainSnapshot(read, REMOTE_CREDENTIAL_DOMAIN),
    );
    const root = { ...read.snapshot };
    const mutation = operation(state, root);
    const nextRoot = mutation.root ?? root;
    nextRoot[REMOTE_CREDENTIAL_DOMAIN] = state;
    const committed = await this.codec.commit({
      read,
      domain: REMOTE_CREDENTIAL_DOMAIN,
      command: { kind },
      snapshot: nextRoot,
      result: mutation.result,
      payload: input.payload ?? input,
      idempotencyKey: input.idempotencyKey,
      principalId: input.principalId,
      now,
    });
    return { kind: committed.kind, result: committed.result };
  }
}

export type RemoteCredentialAuthoritySnapshot = RemoteServerCredentialState;

function parseAuthorityRemoteState(value: unknown): RemoteServerCredentialState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { version: 1, pairingCodes: [], pendingLogins: [], clients: [] };
  const parsed = value as Partial<RemoteServerCredentialState>;
  return {
    version: 1,
    pairingCodes: Array.isArray(parsed.pairingCodes) ? parsed.pairingCodes : [],
    pendingLogins: (Array.isArray(parsed.pendingLogins) ? parsed.pendingLogins : []).map(
      (pending) => ({
        ...pending,
        requestedRole: parseRemoteClientRole(pending.requestedRole),
        ...(pending.grantedRole ? { grantedRole: parseRemoteClientRole(pending.grantedRole) } : {}),
        supersededPendingRefreshHashes: parseSupersededRefreshTokens(
          pending.supersededPendingRefreshHashes,
        ),
      }),
    ),
    clients: (Array.isArray(parsed.clients) ? parsed.clients : []).map((client) => ({
      ...client,
      role: parseRemoteClientRole(client.role),
      supersededRefreshTokenHashes: parseSupersededRefreshTokens(
        client.supersededRefreshTokenHashes,
      ),
    })),
  } as RemoteServerCredentialState;
}

function authorityPendingLoginForCompletion(
  state: RemoteServerCredentialState,
  flowId: string,
  pendingCompletionSecret: string,
  now: Date,
): StoredPendingLogin {
  const flow = state.pendingLogins.find((candidate) => candidate.flowId === flowId);
  if (!flow) throw new CapletsError("AUTH_FAILED", "Pending login is unknown.");
  if (
    !safeAuthorityHashEqual(
      hashAuthoritySecret(pendingCompletionSecret),
      flow.pendingCompletionHash,
    )
  ) {
    throw new CapletsError("AUTH_FAILED", "Pending login possession material is invalid.");
  }
  if (Date.parse(flow.flowExpiresAt) <= now.getTime() && isActivePendingLogin(flow))
    flow.status = "expired";
  return flow;
}
export function createAuthorityRemoteServerCredentialStore(
  options: AuthorityRemoteServerCredentialStoreOptions,
): AuthorityRemoteServerCredentialStore {
  return new AuthorityRemoteServerCredentialStore(options);
}

export { AuthorityRemoteServerCredentialStore as AsyncRemoteServerCredentialStore };

function authorityDashboardSessionIds(root: Record<string, unknown>, clientId: string): string[] {
  const sessions = root.dashboardSessions;
  const candidates: Array<{ id: string; value: unknown }> = [];
  if (Array.isArray(sessions)) {
    for (const value of sessions) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const id = (value as Record<string, unknown>).sessionId;
        if (typeof id === "string") candidates.push({ id, value });
      }
    }
  } else if (sessions && typeof sessions === "object" && !Array.isArray(sessions)) {
    const record = sessions as Record<string, unknown>;
    if (Array.isArray(record.sessions)) {
      for (const value of record.sessions) {
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const id = (value as Record<string, unknown>).sessionId;
          if (typeof id === "string") candidates.push({ id, value });
        }
      }
    } else {
      for (const [id, value] of Object.entries(record)) candidates.push({ id, value });
    }
  }
  return candidates
    .filter(
      ({ value }) =>
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).operatorClientId === clientId,
    )
    .map(({ id }) => id);
}

function removeAuthorityDashboardSessions(
  root: Record<string, unknown>,
  clientId: string,
): Record<string, unknown> {
  const sessions = root.dashboardSessions;
  if (Array.isArray(sessions)) {
    return {
      ...root,
      dashboardSessions: sessions.filter(
        (session) =>
          !session ||
          typeof session !== "object" ||
          (session as Record<string, unknown>).operatorClientId !== clientId,
      ),
    };
  }
  if (sessions && typeof sessions === "object" && !Array.isArray(sessions)) {
    const sessionRecord = sessions as { sessions?: unknown };
    if (Array.isArray(sessionRecord.sessions)) {
      return {
        ...root,
        dashboardSessions: {
          ...sessionRecord,
          sessions: sessionRecord.sessions.filter(
            (session) =>
              !session ||
              typeof session !== "object" ||
              (session as Record<string, unknown>).operatorClientId !== clientId,
          ),
        },
      };
    }
    const filtered = Object.fromEntries(
      Object.entries(sessions).filter(
        ([, session]) =>
          !session ||
          typeof session !== "object" ||
          (session as Record<string, unknown>).operatorClientId !== clientId,
      ),
    );
    return { ...root, dashboardSessions: filtered };
  }
  return root;
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
  return capSupersededRefreshTokens(
    entries.filter((entry) => {
      const supersededAt = Date.parse(entry.supersededAt);
      return (
        Number.isFinite(supersededAt) &&
        now.getTime() - supersededAt < SUPERSEDED_REFRESH_TOKEN_RETENTION_MS
      );
    }),
  );
}

function capSupersededRefreshTokens(entries: SupersededRefreshToken[]): SupersededRefreshToken[] {
  return entries.slice(-PENDING_SUPERSEDED_REFRESH_HASH_MAX);
}

function cleanupPendingLogins(state: RemoteServerCredentialState, now: Date): boolean {
  let changed = false;
  for (const flow of state.pendingLogins) {
    if (isActivePendingLogin(flow) && Date.parse(flow.flowExpiresAt) <= now.getTime()) {
      flow.status = "expired";
      changed = true;
    }
  }
  const retained = state.pendingLogins.filter((flow) => shouldRetainPendingLogin(flow, now));
  if (retained.length !== state.pendingLogins.length) changed = true;
  state.pendingLogins = retained;
  return changed;
}

function enforcePendingLoginQuota(
  state: RemoteServerCredentialState,
  sourceHint: string | undefined,
): void {
  const active = state.pendingLogins.filter(isActivePendingLogin);
  if (active.length >= DEFAULT_PENDING_MAX_ACTIVE_FLOWS) {
    throw new CapletsError("AUTH_FAILED", "Too many active pending logins.");
  }
  if (!sourceHint) return;
  const sourceKey = sourceHint;
  const activeForSource = active.filter((flow) => (flow.sourceHint ?? "") === sourceKey);
  if (activeForSource.length >= DEFAULT_PENDING_MAX_ACTIVE_FLOWS_PER_SOURCE) {
    throw new CapletsError("AUTH_FAILED", "Too many active pending logins for this source.");
  }
}

function isActivePendingLogin(flow: StoredPendingLogin): boolean {
  return flow.status === "pending" || flow.status === "approved";
}

function shouldRetainPendingLogin(flow: StoredPendingLogin, now: Date): boolean {
  if (isActivePendingLogin(flow)) return true;
  const terminalAt = pendingLoginTerminalTime(flow);
  return Number.isFinite(terminalAt) && now.getTime() - terminalAt < PENDING_TERMINAL_RETENTION_MS;
}

function pendingLoginTerminalTime(flow: StoredPendingLogin): number {
  switch (flow.status) {
    case "denied":
      return Date.parse(flow.deniedAt ?? flow.flowExpiresAt);
    case "cancelled":
      return Date.parse(flow.cancelledAt ?? flow.flowExpiresAt);
    case "exchanged":
      return Date.parse(flow.exchangedAt ?? flow.flowExpiresAt);
    case "expired":
      return Date.parse(flow.flowExpiresAt);
    default:
      return Number.NaN;
  }
}

function assertPendingOperatorCodeFresh(flow: StoredPendingLogin, now: Date): void {
  if (Date.parse(flow.codeExpiresAt) <= now.getTime()) {
    throw new CapletsError(
      "AUTH_FAILED",
      "Pending login code has expired. Refresh the pending login for a new code.",
    );
  }
}

function encryptReplayValue(
  value: unknown,
  pendingCompletionSecret: string,
  now: Date,
): VaultEncryptedRecord {
  return encryptVaultValue({
    plaintext: JSON.stringify(value),
    key: replayEncryptionKey(pendingCompletionSecret),
    now,
  });
}

function decryptPendingRefreshReplay(
  replay: PendingRefreshReplay,
  pendingCompletionSecret: string,
): {
  flowId: string;
  operatorCode: string;
  operatorCodeFingerprint: string;
  pendingRefreshSecret: string;
  codeExpiresAt: string;
  flowExpiresAt: string;
  intervalSeconds: number;
} {
  const parsed = JSON.parse(
    decryptVaultValue(replay.encryptedResponse, replayEncryptionKey(pendingCompletionSecret)),
  ) as Partial<{
    flowId: unknown;
    operatorCode: unknown;
    operatorCodeFingerprint?: unknown;
    pendingRefreshSecret: unknown;
    codeExpiresAt: unknown;
    flowExpiresAt: unknown;
    intervalSeconds: unknown;
  }>;
  if (
    typeof parsed.flowId !== "string" ||
    typeof parsed.operatorCode !== "string" ||
    typeof parsed.pendingRefreshSecret !== "string" ||
    typeof parsed.codeExpiresAt !== "string" ||
    typeof parsed.flowExpiresAt !== "string" ||
    typeof parsed.intervalSeconds !== "number"
  ) {
    throw new CapletsError("CONFIG_INVALID", "Pending login refresh replay record is malformed.");
  }
  return {
    flowId: parsed.flowId,
    operatorCode: parsed.operatorCode,
    operatorCodeFingerprint:
      typeof parsed.operatorCodeFingerprint === "string"
        ? parsed.operatorCodeFingerprint
        : pendingOperatorCodeFingerprint(parsed.operatorCode),
    pendingRefreshSecret: parsed.pendingRefreshSecret,
    codeExpiresAt: parsed.codeExpiresAt,
    flowExpiresAt: parsed.flowExpiresAt,
    intervalSeconds: parsed.intervalSeconds,
  };
}

function decryptCompletionReplay(
  replay: CompletionReplay,
  pendingCompletionSecret: string,
): IssuedRemoteClientCredentials {
  const parsed = JSON.parse(
    decryptVaultValue(replay.encryptedCredentials, replayEncryptionKey(pendingCompletionSecret)),
  ) as Partial<Record<keyof IssuedRemoteClientCredentials, unknown>>;
  if (
    typeof parsed.clientId !== "string" ||
    typeof parsed.clientLabel !== "string" ||
    typeof parsed.hostUrl !== "string" ||
    typeof parsed.accessToken !== "string" ||
    typeof parsed.refreshToken !== "string" ||
    typeof parsed.expiresAt !== "string" ||
    typeof parsed.createdAt !== "string" ||
    parsed.tokenType !== "Bearer"
  ) {
    throw new CapletsError(
      "CONFIG_INVALID",
      "Pending login completion replay record is malformed.",
    );
  }
  return {
    clientId: parsed.clientId,
    clientLabel: parsed.clientLabel,
    hostUrl: parsed.hostUrl,
    role: parseRemoteClientRole(parsed.role),
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    expiresAt: parsed.expiresAt,
    createdAt: parsed.createdAt,
    tokenType: "Bearer",
  };
}

function replayEncryptionKey(pendingCompletionSecret: string): Buffer {
  return createHash("sha256")
    .update(`caplets-pending-login-replay:${pendingCompletionSecret}`)
    .digest();
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
    throw new CapletsError(
      "REMOTE_CREDENTIALS_REVOKED",
      "Remote client credential has been revoked.",
    );
  }
  if (!options.allowExpiredAccess && Date.parse(client.accessExpiresAt) <= now.getTime()) {
    throw new CapletsError("AUTH_FAILED", "Remote client credential has expired.");
  }
}

function denyPendingLoginFlow(flow: StoredPendingLogin, now: Date): void {
  if (flow.status !== "pending") {
    throw new CapletsError("AUTH_FAILED", `Pending login is already ${flow.status}.`);
  }
  if (Date.parse(flow.flowExpiresAt) <= now.getTime()) {
    flow.status = "expired";
    throw new CapletsError("AUTH_FAILED", "Pending login has expired.");
  }
  flow.status = "denied";
  flow.deniedAt = now.toISOString();
}

function approvePendingLoginFlow(
  flow: StoredPendingLogin,
  grantedRole: RemoteClientRole | undefined,
  now: Date,
): void {
  if (flow.status !== "pending") {
    throw new CapletsError("AUTH_FAILED", `Pending login is already ${flow.status}.`);
  }
  if (Date.parse(flow.flowExpiresAt) <= now.getTime()) {
    flow.status = "expired";
    throw new CapletsError("AUTH_FAILED", "Pending login has expired.");
  }
  assertPendingOperatorCodeFresh(flow, now);
  flow.status = "approved";
  flow.grantedRole = grantedRole ?? flow.requestedRole;
  flow.approvedAt = now.toISOString();
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
    role: client.role,
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
    role: client.role,
    hostUrl: client.hostUrl,
    createdAt: client.createdAt,
    ...(client.lastUsedAt ? { lastUsedAt: client.lastUsedAt } : {}),
    ...(client.revokedAt ? { revokedAt: client.revokedAt } : {}),
  };
}

function pendingLoginStatus(flow: StoredPendingLogin): RemotePendingLoginStatus {
  return {
    flowId: flow.flowId,
    hostUrl: flow.hostUrl,
    ...(flow.hostIdentity ? { hostIdentity: flow.hostIdentity } : {}),
    status: flow.status,
    requestedRole: flow.requestedRole,
    ...(flow.grantedRole ? { grantedRole: flow.grantedRole } : {}),
    ...(flow.operatorCodeFingerprint
      ? { operatorCodeFingerprint: flow.operatorCodeFingerprint }
      : {}),
    clientLabel: flow.clientLabel,
    ...(flow.clientFingerprint ? { clientFingerprint: flow.clientFingerprint } : {}),
    ...(flow.sourceHint ? { sourceHint: flow.sourceHint } : {}),
    createdAt: flow.createdAt,
    codeExpiresAt: flow.codeExpiresAt,
    flowExpiresAt: flow.flowExpiresAt,
    ...(flow.approvedAt ? { approvedAt: flow.approvedAt } : {}),
    ...(flow.deniedAt ? { deniedAt: flow.deniedAt } : {}),
    ...(flow.cancelledAt ? { cancelledAt: flow.cancelledAt } : {}),
    ...(flow.exchangedAt ? { exchangedAt: flow.exchangedAt } : {}),
  };
}

function pendingApprovalStatus(flow: StoredPendingLogin): {
  flowId: string;
  status: "approved";
  clientLabel: string;
  requestedRole: RemoteClientRole;
  grantedRole: RemoteClientRole;
  clientFingerprint?: string | undefined;
  sourceHint?: string | undefined;
} {
  return {
    flowId: flow.flowId,
    status: "approved",
    clientLabel: flow.clientLabel,
    requestedRole: flow.requestedRole,
    grantedRole: flow.grantedRole ?? flow.requestedRole,
    ...(flow.clientFingerprint ? { clientFingerprint: flow.clientFingerprint } : {}),
    ...(flow.sourceHint ? { sourceHint: flow.sourceHint } : {}),
  };
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

const PENDING_CLIENT_LABEL_MAX_LENGTH = 120;
const PENDING_CLIENT_FINGERPRINT_MAX_LENGTH = 256;
const PENDING_SOURCE_HINT_MAX_LENGTH = 256;

function boundedPendingLoginDisplayValue(
  value: string | undefined,
  maxLength: number,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function pendingOperatorCodeFingerprint(operatorCode: string): string {
  return hashSecret(operatorCode).slice(0, 8);
}

function parseRemoteClientRole(value: unknown): RemoteClientRole {
  return value === "operator" ? "operator" : "access";
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
