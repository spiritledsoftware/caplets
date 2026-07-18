import { Buffer } from "node:buffer";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { CapletsError } from "../errors";
import { normalizeRemoteProfileHostUrl } from "../remote/options";
import { createPairingCode, parsePairingCode, randomToken } from "../remote/pairing";
import {
  parseRemoteServerCredentialState,
  type CreatePairingCodeInput,
  type CreatePendingLoginInput,
  type ExchangePairingCodeInput,
  type PendingLoginPossessionInput,
  type RefreshClientCredentialsInput,
  type RefreshPendingLoginInput,
  type RemoteServerCredentialState,
  type ValidateAccessTokenInput,
} from "../remote/server-credential-store";
import type {
  IssuedRemoteClientCredentials,
  RemoteClientRole,
  RemoteClientStatus,
  RemotePendingLoginState,
  RemotePendingLoginStatus,
  ValidatedRemoteClient,
} from "../remote/server-credentials";
import { decryptVaultValue, encryptVaultValue, type VaultEncryptedRecord } from "../vault/crypto";
import { stableJsonStringify } from "../stable-json";
import * as postgres from "./schema/postgres";
import * as sqlite from "./schema/sqlite";
import type { HostDatabase, PostgresHostDatabase, SqliteHostDatabase } from "./types";

export type {
  CreatePairingCodeInput,
  CreatePendingLoginInput,
  ExchangePairingCodeInput,
  PendingLoginPossessionInput,
  RefreshClientCredentialsInput,
  RefreshPendingLoginInput,
  ValidateAccessTokenInput,
};

export type OperatorPendingLoginInput = {
  operatorClientId: string;
  operatorCode: string;
  grantedRole?: RemoteClientRole | undefined;
  now?: Date | undefined;
};

export type OperatorPendingLoginFlowInput = {
  operatorClientId: string;
  flowId: string;
  grantedRole?: RemoteClientRole | undefined;
  now?: Date | undefined;
};

export type CompletePendingLoginInput = PendingLoginPossessionInput & {
  hostUrl: string;
  requiredRole?: RemoteClientRole | undefined;
};

export type RevokeRemoteClientInput = {
  operatorClientId: string;
  clientId: string;
  now?: Date | undefined;
};

export type ChangeRemoteClientRoleInput = {
  operatorClientId: string;
  clientId: string;
  role: RemoteClientRole;
  now?: Date | undefined;
};

type SupersededRefreshToken = { hash: string; supersededAt: string };
type PendingRefreshReplay = {
  refreshHash: string;
  expiresAt: string;
  encryptedResponse: VaultEncryptedRecord;
};
type CompletionReplay = { expiresAt: string; encryptedCredentials: VaultEncryptedRecord };
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
  status: RemotePendingLoginState;
  operatorCodeFingerprint?: string | undefined;
  approvedAt?: string | undefined;
  deniedAt?: string | undefined;
  cancelledAt?: string | undefined;
  exchangedAt?: string | undefined;
};
type RemoteSecurityState = {
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
const PENDING_CLIENT_LABEL_MAX_LENGTH = 120;
const PENDING_CLIENT_FINGERPRINT_MAX_LENGTH = 256;
const PENDING_SOURCE_HINT_MAX_LENGTH = 256;

export class RemoteSecurityStore {
  constructor(private readonly database: HostDatabase) {}

  async createPendingLogin(input: CreatePendingLoginInput) {
    return await this.update((state) => {
      const now = input.now ?? new Date();
      cleanupPendingLogins(state, now);
      const flowId = `rlogin_${randomToken(12)}`;
      const operatorCode = `cap_login_${randomToken(5)}`;
      const pendingRefreshSecret = `cap_pending_refresh_${randomToken(32)}`;
      const pendingCompletionSecret = `cap_pending_complete_${randomToken(32)}`;
      const codeExpiresAt = new Date(
        now.getTime() + DEFAULT_PENDING_OPERATOR_CODE_TTL_MS,
      ).toISOString();
      const flowExpiresAt = new Date(now.getTime() + DEFAULT_PENDING_FLOW_TTL_MS).toISOString();
      const clientLabel =
        bounded(input.clientLabel, PENDING_CLIENT_LABEL_MAX_LENGTH) ?? "Caplets Remote Client";
      const clientFingerprint = bounded(
        input.clientFingerprint,
        PENDING_CLIENT_FINGERPRINT_MAX_LENGTH,
      );
      const sourceHint = bounded(input.sourceHint, PENDING_SOURCE_HINT_MAX_LENGTH);
      enforcePendingLoginQuota(state, sourceHint);
      state.pendingLogins.push({
        flowId,
        hostUrl: normalizeRemoteProfileHostUrl(input.hostUrl),
        ...(input.hostIdentity ? { hostIdentity: input.hostIdentity } : {}),
        operatorCodeHash: hashSecret(operatorCode),
        pendingRefreshHash: hashSecret(pendingRefreshSecret),
        supersededPendingRefreshHashes: [],
        pendingCompletionHash: hashSecret(pendingCompletionSecret),
        clientLabel,
        requestedRole: input.requestedRole ?? "access",
        ...(clientFingerprint ? { clientFingerprint } : {}),
        ...(sourceHint ? { sourceHint } : {}),
        createdAt: now.toISOString(),
        codeExpiresAt,
        flowExpiresAt,
        status: "pending",
        operatorCodeFingerprint: operatorCodeFingerprint(operatorCode),
      });
      return {
        value: {
          flowId,
          operatorCode,
          operatorCodeFingerprint: operatorCodeFingerprint(operatorCode),
          pendingRefreshSecret,
          pendingCompletionSecret,
          codeExpiresAt,
          flowExpiresAt,
          intervalSeconds: DEFAULT_PENDING_POLL_INTERVAL_SECONDS,
        },
      };
    });
  }

  async pollPendingLogin(
    input: PendingLoginPossessionInput,
  ): Promise<{ flowId: string; status: RemotePendingLoginState }> {
    const now = input.now ?? new Date();
    const state = await this.readState();
    const flow = pendingLoginForCompletion(state, input.flowId, input.pendingCompletionSecret, now);
    return { flowId: flow.flowId, status: flow.status };
  }

  async refreshPendingLogin(input: RefreshPendingLoginInput) {
    return await this.update((state) => {
      const now = input.now ?? new Date();
      cleanupPendingLogins(state, now);
      const flow = pendingLoginForCompletion(
        state,
        input.flowId,
        input.pendingCompletionSecret,
        now,
      );
      if (flow.status !== "pending")
        throw new CapletsError("AUTH_FAILED", `Pending login is already ${flow.status}.`);
      const refreshHash = hashSecret(input.pendingRefreshSecret);
      if (!safeHashEqual(refreshHash, flow.pendingRefreshHash)) {
        if (
          flow.pendingRefreshReplay &&
          safeHashEqual(refreshHash, flow.pendingRefreshReplay.refreshHash) &&
          Date.parse(flow.pendingRefreshReplay.expiresAt) > now.getTime()
        ) {
          return {
            value: decryptPendingRefreshReplay(
              flow.pendingRefreshReplay,
              input.pendingCompletionSecret,
            ),
            save: false,
          };
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
        operatorCodeFingerprint: operatorCodeFingerprint(operatorCode),
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
      return { value: response };
    });
  }

  async denyPendingLogin(input: OperatorPendingLoginInput): Promise<RemotePendingLoginStatus> {
    return await this.operatorUpdate(
      input.operatorClientId,
      "remote_pending_login_denied",
      "pending_login",
      (state) => {
        const now = input.now ?? new Date();
        cleanupPendingLogins(state, now);
        const codeHash = hashSecret(input.operatorCode);
        const flow = state.pendingLogins.find((candidate) =>
          safeHashEqual(codeHash, candidate.operatorCodeHash),
        );
        if (!flow) throw new CapletsError("AUTH_FAILED", "Pending login code is unknown.");
        denyFlow(flow, now);
        return { value: pendingLoginStatus(flow), targetKey: flow.flowId };
      },
    );
  }

  async denyPendingLoginFlow(
    input: OperatorPendingLoginFlowInput,
  ): Promise<RemotePendingLoginStatus> {
    return await this.operatorUpdate(
      input.operatorClientId,
      "remote_pending_login_denied",
      "pending_login",
      (state) => {
        const now = input.now ?? new Date();
        cleanupPendingLogins(state, now);
        const flow = requireFlow(state, input.flowId);
        denyFlow(flow, now);
        return { value: pendingLoginStatus(flow), targetKey: flow.flowId };
      },
    );
  }

  async cancelPendingLogin(
    input: PendingLoginPossessionInput,
  ): Promise<{ flowId: string; status: "cancelled" }> {
    return await this.update((state) => {
      const now = input.now ?? new Date();
      cleanupPendingLogins(state, now);
      const flow = pendingLoginForCompletion(
        state,
        input.flowId,
        input.pendingCompletionSecret,
        now,
      );
      if (flow.status !== "pending" && flow.status !== "approved")
        throw new CapletsError("AUTH_FAILED", `Pending login is already ${flow.status}.`);
      flow.status = "cancelled";
      flow.cancelledAt = now.toISOString();
      return { value: { flowId: flow.flowId, status: "cancelled" as const } };
    });
  }

  async approvePendingLogin(input: OperatorPendingLoginInput) {
    return await this.operatorUpdate(
      input.operatorClientId,
      "remote_pending_login_approved",
      "pending_login",
      (state) => {
        const now = input.now ?? new Date();
        cleanupPendingLogins(state, now);
        const codeHash = hashSecret(input.operatorCode);
        const flow = state.pendingLogins.find((candidate) =>
          safeHashEqual(codeHash, candidate.operatorCodeHash),
        );
        if (!flow) throw new CapletsError("AUTH_FAILED", "Pending login code is unknown.");
        approveFlow(flow, input.grantedRole, now);
        return {
          value: pendingApprovalStatus(flow),
          targetKey: flow.flowId,
          metadata: { grantedRole: flow.grantedRole },
        };
      },
    );
  }

  async approvePendingLoginFlow(
    input: OperatorPendingLoginFlowInput,
  ): Promise<RemotePendingLoginStatus> {
    return await this.operatorUpdate(
      input.operatorClientId,
      "remote_pending_login_approved",
      "pending_login",
      (state) => {
        const now = input.now ?? new Date();
        cleanupPendingLogins(state, now);
        const flow = requireFlow(state, input.flowId);
        approveFlow(flow, input.grantedRole, now);
        return {
          value: pendingLoginStatus(flow),
          targetKey: flow.flowId,
          metadata: { grantedRole: flow.grantedRole },
        };
      },
    );
  }

  async completePendingLogin(
    input: CompletePendingLoginInput,
  ): Promise<IssuedRemoteClientCredentials> {
    return await this.update((state) => {
      const now = input.now ?? new Date();
      cleanupPendingLogins(state, now);
      const flow = pendingLoginForCompletion(
        state,
        input.flowId,
        input.pendingCompletionSecret,
        now,
      );
      if (flow.hostUrl !== normalizeRemoteProfileHostUrl(input.hostUrl))
        throw new CapletsError("AUTH_FAILED", "Pending login belongs to a different host.");
      if (flow.status !== "approved") {
        if (
          flow.status === "exchanged" &&
          flow.completionReplay &&
          Date.parse(flow.completionReplay.expiresAt) > now.getTime()
        ) {
          return {
            value: decryptCompletionReplay(flow.completionReplay, input.pendingCompletionSecret),
            save: false,
          };
        }
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
      const accessToken = `cap_remote_access_${randomToken(32)}`;
      const refreshToken = `cap_remote_refresh_${randomToken(32)}`;
      const client = createClient(
        flow.hostUrl,
        flow.clientLabel,
        role,
        accessToken,
        refreshToken,
        now,
      );
      state.clients.push(client);
      flow.status = "exchanged";
      flow.exchangedAt = now.toISOString();
      const credentials = credentialsFromClient(client, accessToken, refreshToken);
      flow.completionReplay = {
        expiresAt: new Date(now.getTime() + STALE_REFRESH_REVOKE_GRACE_MS).toISOString(),
        encryptedCredentials: encryptReplayValue(credentials, input.pendingCompletionSecret, now),
      };
      return { value: credentials };
    });
  }

  async createPairingCode(
    input: CreatePairingCodeInput,
  ): Promise<{ codeId: string; code: string; expiresAt: string }> {
    return await this.update((state) => {
      const now = input.now ?? new Date();
      const issued = createPairingCode();
      const expiresAt = new Date(
        now.getTime() + (input.ttlMs ?? DEFAULT_PAIRING_CODE_TTL_MS),
      ).toISOString();
      state.pairingCodes.push({
        codeId: issued.codeId,
        hostUrl: normalizeRemoteProfileHostUrl(input.hostUrl),
        secretHash: hashSecret(issued.secret),
        ...(input.clientLabel ? { clientLabel: input.clientLabel } : {}),
        createdAt: now.toISOString(),
        expiresAt,
        attempts: 0,
        maxAttempts: input.maxAttempts ?? DEFAULT_PAIRING_CODE_MAX_ATTEMPTS,
      });
      return { value: { codeId: issued.codeId, code: issued.code, expiresAt } };
    });
  }

  async exchangePairingCode(
    input: ExchangePairingCodeInput,
  ): Promise<IssuedRemoteClientCredentials> {
    return await this.update<IssuedRemoteClientCredentials>((state) => {
      const now = input.now ?? new Date();
      const parsed = parsePairingCode(input.code);
      if (!parsed) throw new CapletsError("AUTH_FAILED", "Pairing Code format is invalid.");
      const pairingCode = state.pairingCodes.find(
        (candidate) => candidate.codeId === parsed.codeId,
      );
      if (!pairingCode) throw new CapletsError("AUTH_FAILED", "Pairing Code is unknown.");
      const hostUrl = normalizeRemoteProfileHostUrl(input.hostUrl);
      if (pairingCode.hostUrl !== hostUrl)
        throw new CapletsError("AUTH_FAILED", "Pairing Code belongs to a different host.");
      if (pairingCode.usedAt)
        throw new CapletsError("AUTH_FAILED", "Pairing Code has already been used.");
      if (Date.parse(pairingCode.expiresAt) <= now.getTime())
        throw new CapletsError("AUTH_FAILED", "Pairing Code has expired.");
      if (pairingCode.attempts >= pairingCode.maxAttempts)
        throw new CapletsError("AUTH_FAILED", "Pairing Code attempts exhausted.");
      if (!safeHashEqual(hashSecret(parsed.secret), pairingCode.secretHash)) {
        pairingCode.attempts += 1;
        return {
          error: new CapletsError(
            "AUTH_FAILED",
            pairingCode.attempts >= pairingCode.maxAttempts
              ? "Pairing Code attempts exhausted."
              : "Pairing Code is invalid.",
          ),
        };
      }
      pairingCode.usedAt = now.toISOString();
      const accessToken = `cap_remote_access_${randomToken(32)}`;
      const refreshToken = `cap_remote_refresh_${randomToken(32)}`;
      const client = createClient(
        hostUrl,
        input.clientLabel ?? pairingCode.clientLabel ?? "Caplets Remote Client",
        "access",
        accessToken,
        refreshToken,
        now,
      );
      state.clients.push(client);
      return { value: credentialsFromClient(client, accessToken, refreshToken) };
    });
  }

  async listClients(): Promise<RemoteClientStatus[]> {
    const state = await this.readState();
    return state.clients
      .map(clientStatus)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async listPendingLogins(now = new Date()): Promise<RemotePendingLoginStatus[]> {
    return await this.update((state) => {
      const changed = cleanupPendingLogins(state, now);
      return {
        value: state.pendingLogins
          .map(pendingLoginStatus)
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
        save: changed,
      };
    });
  }

  async revokeClient(input: RevokeRemoteClientInput): Promise<boolean> {
    return await this.operatorUpdate(
      input.operatorClientId,
      "remote_client_revoked",
      "remote_client",
      (state) => {
        const client = state.clients.find((candidate) => candidate.clientId === input.clientId);
        if (!client) return { value: false, save: false };
        client.revokedAt ??= (input.now ?? new Date()).toISOString();
        return { value: true, targetKey: client.clientId };
      },
    );
  }

  async changeClientRole(
    input: ChangeRemoteClientRoleInput,
  ): Promise<RemoteClientStatus | undefined> {
    return await this.operatorUpdate(
      input.operatorClientId,
      "remote_client_role_changed",
      "remote_client",
      (state) => {
        const client = state.clients.find((candidate) => candidate.clientId === input.clientId);
        if (!client) return { value: undefined, save: false };
        const previousRole = client.role;
        client.role = input.role;
        return {
          value: clientStatus(client),
          targetKey: client.clientId,
          metadata: { previousRole, role: input.role },
        };
      },
    );
  }

  async validateAccessToken(input: ValidateAccessTokenInput): Promise<ValidatedRemoteClient> {
    const state = await this.readState();
    const tokenHash = hashSecret(input.accessToken);
    const client = state.clients.find((candidate) =>
      safeHashEqual(tokenHash, candidate.accessTokenHash),
    );
    if (!client) throw new CapletsError("AUTH_FAILED", "Remote client credential is invalid.");
    validateClient(client, normalizeRemoteProfileHostUrl(input.hostUrl), input.now ?? new Date());
    return { ...clientStatus(client), tokenType: "Bearer" };
  }

  async refreshClientCredentials(
    input: RefreshClientCredentialsInput,
  ): Promise<IssuedRemoteClientCredentials> {
    return await this.update<IssuedRemoteClientCredentials>((state) => {
      const now = input.now ?? new Date();
      const tokenHash = hashSecret(input.refreshToken);
      const client = state.clients.find((candidate) =>
        safeHashEqual(tokenHash, candidate.refreshTokenHash),
      );
      if (!client) {
        const replayed = state.clients.find((candidate) =>
          candidate.supersededRefreshTokenHashes.some((entry) =>
            safeHashEqual(tokenHash, entry.hash),
          ),
        );
        if (replayed) {
          const entry = replayed.supersededRefreshTokenHashes.find((candidate) =>
            safeHashEqual(tokenHash, candidate.hash),
          );
          const supersededAt = Date.parse(entry?.supersededAt ?? "");
          if (
            Number.isFinite(supersededAt) &&
            now.getTime() - supersededAt >= STALE_REFRESH_REVOKE_GRACE_MS
          )
            replayed.revokedAt = now.toISOString();
          return {
            error: new CapletsError(
              "REMOTE_CREDENTIALS_REVOKED",
              "Remote refresh credential is stale.",
            ),
          };
        }
        throw new CapletsError("AUTH_FAILED", "Remote refresh credential is invalid.");
      }
      validateClient(client, normalizeRemoteProfileHostUrl(input.hostUrl), now, true);
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
      return { value: credentialsFromClient(client, accessToken, refreshToken) };
    });
  }

  async assertLegacySnapshotImportable(snapshot: RemoteServerCredentialState): Promise<void> {
    mergeLegacyRemoteSecurityState(
      await this.readState(),
      parseRemoteServerCredentialState(snapshot),
    );
  }

  async importLegacySnapshot(snapshot: RemoteServerCredentialState): Promise<void> {
    const validated = parseRemoteServerCredentialState(snapshot);
    await this.update((current) => {
      const merged = mergeLegacyRemoteSecurityState(current, validated);
      current.pairingCodes = merged.state.pairingCodes;
      current.pendingLogins = merged.state.pendingLogins;
      current.clients = merged.state.clients;
      return { value: undefined, save: merged.changed };
    });
  }

  async verifyLegacySnapshot(snapshot: RemoteServerCredentialState): Promise<void> {
    const result = mergeLegacyRemoteSecurityState(
      await this.readState(),
      parseRemoteServerCredentialState(snapshot),
    );
    if (result.changed) {
      throw new CapletsError(
        "INTERNAL_ERROR",
        "Remote security state failed post-migration verification.",
      );
    }
  }

  async dumpForTest(): Promise<RemoteSecurityState> {
    return await this.readState();
  }

  private async readState(): Promise<RemoteSecurityState> {
    return this.database.dialect === "sqlite"
      ? loadSqliteState(this.database.db)
      : await loadPostgresState(this.database.db);
  }

  private async update<R>(
    transition: (state: RemoteSecurityState) => TransitionResult<R>,
  ): Promise<R> {
    const result =
      this.database.dialect === "sqlite"
        ? this.database.db.transaction((transaction) => {
            const state = loadSqliteState(transaction);
            const transitionResult = transition(state);
            if ("error" in transitionResult) {
              saveSqliteState(transaction, state);
              return transitionResult.error;
            }
            if (transitionResult.save !== false) saveSqliteState(transaction, state);
            return transitionResult.value;
          })
        : await this.database.db.transaction(async (transaction) => {
            await lockPostgresRemoteSecurity(transaction);
            const state = await loadPostgresState(transaction, true);
            const transitionResult = transition(state);
            if ("error" in transitionResult) {
              await savePostgresState(transaction, state);
              return transitionResult.error;
            }
            if (transitionResult.save !== false) await savePostgresState(transaction, state);
            return transitionResult.value;
          });
    if (result instanceof Error) throw result;
    return result;
  }

  private async operatorUpdate<R>(
    operatorClientId: string,
    action: string,
    targetKind: string,
    transition: (state: RemoteSecurityState) => OperatorTransitionResult<R>,
  ): Promise<R> {
    if (this.database.dialect === "sqlite") {
      return this.database.db.transaction((transaction) => {
        const state = loadSqliteState(transaction);
        const result = transition(state);
        if (result.save === false) return result.value;
        saveSqliteState(transaction, state);
        transaction
          .insert(sqlite.operatorActivity)
          .values(
            activityValues(
              operatorClientId,
              action,
              targetKind,
              result.targetKey!,
              result.metadata,
            ),
          )
          .run();
        return result.value;
      });
    }
    return await this.database.db.transaction(async (transaction) => {
      await lockPostgresRemoteSecurity(transaction);
      const state = await loadPostgresState(transaction, true);
      const result = transition(state);
      if (result.save === false) return result.value;
      await savePostgresState(transaction, state);
      await transaction
        .insert(postgres.operatorActivity)
        .values(
          activityValues(operatorClientId, action, targetKind, result.targetKey!, result.metadata),
        );
      return result.value;
    });
  }
}

function mergeLegacyRemoteSecurityState(
  current: RemoteSecurityState,
  legacy: RemoteServerCredentialState,
): { state: RemoteSecurityState; changed: boolean } {
  const pairingCodes = mergeLegacyRemoteCollection(
    current.pairingCodes,
    legacy.pairingCodes,
    (entry) => entry.codeId,
  );
  const pendingLogins = mergeLegacyRemoteCollection(
    current.pendingLogins,
    legacy.pendingLogins,
    (entry) => entry.flowId,
  );
  const clients = mergeLegacyRemoteCollection(
    current.clients,
    legacy.clients,
    (entry) => entry.clientId,
  );
  const state = parseRemoteServerCredentialState({
    version: 1,
    pairingCodes: pairingCodes.values,
    pendingLogins: pendingLogins.values,
    clients: clients.values,
  });
  return {
    state,
    changed: pairingCodes.changed || pendingLogins.changed || clients.changed,
  };
}

function mergeLegacyRemoteCollection<T>(
  current: T[],
  legacy: T[],
  identity: (entry: T) => string,
): { values: T[]; changed: boolean } {
  const values = [...current];
  const byIdentity = new Map(current.map((entry) => [identity(entry), entry]));
  let changed = false;
  for (const entry of legacy) {
    const key = identity(entry);
    const existing = byIdentity.get(key);
    if (existing && stableJsonStringify(existing) !== stableJsonStringify(entry)) {
      throw new CapletsError(
        "CONFIG_EXISTS",
        "Remote security state conflicts with the legacy snapshot.",
      );
    }
    if (!existing) {
      values.push(entry);
      byIdentity.set(key, entry);
      changed = true;
    }
  }
  return { values, changed };
}

type TransitionResult<R> = { value: R; save?: boolean } | { error: Error };
type OperatorTransitionResult<R> = {
  value: R;
  save?: boolean;
  targetKey?: string;
  metadata?: Record<string, unknown>;
};

type SqliteTransaction = Parameters<Parameters<SqliteHostDatabase["transaction"]>[0]>[0];
type PostgresTransaction = Parameters<Parameters<PostgresHostDatabase["transaction"]>[0]>[0];

function loadSqliteState(database: SqliteHostDatabase | SqliteTransaction): RemoteSecurityState {
  return assembleState({
    pairingCodes: database.select().from(sqlite.remotePairingCodes).all(),
    clients: database.select().from(sqlite.remoteClients).all(),
    tokenFamilies: database.select().from(sqlite.remoteClientTokenFamilies).all(),
    supersededRefreshes: database.select().from(sqlite.remoteClientSupersededRefreshTokens).all(),
    pendingLogins: database.select().from(sqlite.remotePendingLogins).all(),
    pendingSupersededRefreshes: database
      .select()
      .from(sqlite.remotePendingSupersededRefreshTokens)
      .all(),
  });
}

async function loadPostgresState(
  database: PostgresHostDatabase | PostgresTransaction,
  forUpdate = false,
): Promise<RemoteSecurityState> {
  const pairingQuery = database.select().from(postgres.remotePairingCodes);
  const clientsQuery = database.select().from(postgres.remoteClients);
  const familiesQuery = database.select().from(postgres.remoteClientTokenFamilies);
  const supersededQuery = database.select().from(postgres.remoteClientSupersededRefreshTokens);
  const pendingQuery = database.select().from(postgres.remotePendingLogins);
  const pendingSupersededQuery = database
    .select()
    .from(postgres.remotePendingSupersededRefreshTokens);
  const [
    pairingCodes,
    clients,
    tokenFamilies,
    supersededRefreshes,
    pendingLogins,
    pendingSupersededRefreshes,
  ] = await Promise.all([
    forUpdate ? pairingQuery.for("update") : pairingQuery,
    forUpdate ? clientsQuery.for("update") : clientsQuery,
    forUpdate ? familiesQuery.for("update") : familiesQuery,
    forUpdate ? supersededQuery.for("update") : supersededQuery,
    forUpdate ? pendingQuery.for("update") : pendingQuery,
    forUpdate ? pendingSupersededQuery.for("update") : pendingSupersededQuery,
  ]);
  return assembleState({
    pairingCodes,
    clients,
    tokenFamilies,
    supersededRefreshes,
    pendingLogins,
    pendingSupersededRefreshes,
  });
}

type RelationalRemoteSecurityRows = {
  pairingCodes: Array<typeof sqlite.remotePairingCodes.$inferSelect>;
  clients: Array<typeof sqlite.remoteClients.$inferSelect>;
  tokenFamilies: Array<typeof sqlite.remoteClientTokenFamilies.$inferSelect>;
  supersededRefreshes: Array<typeof sqlite.remoteClientSupersededRefreshTokens.$inferSelect>;
  pendingLogins: Array<typeof sqlite.remotePendingLogins.$inferSelect>;
  pendingSupersededRefreshes: Array<
    typeof sqlite.remotePendingSupersededRefreshTokens.$inferSelect
  >;
};

function assembleState(rows: RelationalRemoteSecurityRows): RemoteSecurityState {
  const families = new Map(rows.tokenFamilies.map((family) => [family.clientId, family]));
  const supersededByFamily = groupBy(rows.supersededRefreshes, (entry) => entry.familyId);
  const pendingSupersededByFlow = groupBy(rows.pendingSupersededRefreshes, (entry) => entry.flowId);
  return {
    version: 1,
    pairingCodes: rows.pairingCodes.map((row) => ({
      codeId: row.codeId,
      hostUrl: row.hostUrl,
      secretHash: row.secretHash,
      ...(row.clientLabel ? { clientLabel: row.clientLabel } : {}),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      ...(row.usedAt ? { usedAt: row.usedAt } : {}),
    })),
    clients: rows.clients.map((row) => {
      const family = families.get(row.clientId);
      if (!family) {
        throw new CapletsError(
          "CONFIG_INVALID",
          `Remote client ${row.clientId} has no token family.`,
        );
      }
      return {
        clientId: row.clientId,
        clientLabel: row.clientLabel,
        role: parseRole(row.role),
        hostUrl: row.hostUrl,
        accessTokenHash: row.accessTokenHash,
        accessExpiresAt: row.accessExpiresAt,
        refreshTokenHash: family.refreshTokenHash,
        supersededRefreshTokenHashes: (supersededByFamily.get(family.familyId) ?? []).map(
          (entry) => ({ hash: entry.tokenHash, supersededAt: entry.supersededAt }),
        ),
        refreshFamilyId: family.familyId,
        createdAt: row.createdAt,
        ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {}),
        ...(row.revokedAt || family.revokedAt
          ? { revokedAt: row.revokedAt ?? family.revokedAt! }
          : {}),
      };
    }),
    pendingLogins: rows.pendingLogins.map((row) => ({
      flowId: row.flowId,
      hostUrl: row.hostUrl,
      ...(row.hostIdentity ? { hostIdentity: row.hostIdentity } : {}),
      operatorCodeHash: row.operatorCodeHash,
      pendingRefreshHash: row.pendingRefreshHash,
      supersededPendingRefreshHashes: (pendingSupersededByFlow.get(row.flowId) ?? []).map(
        (entry) => ({ hash: entry.tokenHash, supersededAt: entry.supersededAt }),
      ),
      ...(row.pendingRefreshReplay
        ? { pendingRefreshReplay: parsePendingRefreshReplay(row.pendingRefreshReplay) }
        : {}),
      pendingCompletionHash: row.pendingCompletionHash,
      ...(row.completionReplay
        ? { completionReplay: parseCompletionReplay(row.completionReplay) }
        : {}),
      clientLabel: row.clientLabel,
      requestedRole: parseRole(row.requestedRole),
      ...(row.grantedRole ? { grantedRole: parseRole(row.grantedRole) } : {}),
      ...(row.clientFingerprint ? { clientFingerprint: row.clientFingerprint } : {}),
      ...(row.sourceHint ? { sourceHint: row.sourceHint } : {}),
      createdAt: row.createdAt,
      codeExpiresAt: row.codeExpiresAt,
      flowExpiresAt: row.flowExpiresAt,
      status: parsePendingStatus(row.status),
      ...(row.operatorCodeFingerprint
        ? { operatorCodeFingerprint: row.operatorCodeFingerprint }
        : {}),
      ...(row.approvedAt ? { approvedAt: row.approvedAt } : {}),
      ...(row.deniedAt ? { deniedAt: row.deniedAt } : {}),
      ...(row.cancelledAt ? { cancelledAt: row.cancelledAt } : {}),
      ...(row.exchangedAt ? { exchangedAt: row.exchangedAt } : {}),
    })),
  };
}
function groupBy<T>(values: T[], keyFor: (value: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const group = grouped.get(key);
    if (group) group.push(value);
    else grouped.set(key, [value]);
  }
  return grouped;
}

function saveSqliteState(database: SqliteTransaction, state: RemoteSecurityState): void {
  database.delete(sqlite.remotePendingSupersededRefreshTokens).run();
  database.delete(sqlite.remoteClientSupersededRefreshTokens).run();
  database.delete(sqlite.remoteClientTokenFamilies).run();
  database.delete(sqlite.remotePendingLogins).run();
  database.delete(sqlite.remotePairingCodes).run();
  database.delete(sqlite.remoteClients).run();
  const values = relationalValues(state);
  if (values.pairingCodes.length > 0) {
    database.insert(sqlite.remotePairingCodes).values(values.pairingCodes).run();
  }
  if (values.clients.length > 0) {
    database.insert(sqlite.remoteClients).values(values.clients).run();
    database.insert(sqlite.remoteClientTokenFamilies).values(values.tokenFamilies).run();
  }
  if (values.supersededRefreshes.length > 0) {
    database
      .insert(sqlite.remoteClientSupersededRefreshTokens)
      .values(values.supersededRefreshes)
      .run();
  }
  if (values.pendingLogins.length > 0) {
    database.insert(sqlite.remotePendingLogins).values(values.pendingLogins).run();
  }
  if (values.pendingSupersededRefreshes.length > 0) {
    database
      .insert(sqlite.remotePendingSupersededRefreshTokens)
      .values(values.pendingSupersededRefreshes)
      .run();
  }
}

async function savePostgresState(
  database: PostgresTransaction,
  state: RemoteSecurityState,
): Promise<void> {
  await database.delete(postgres.remotePendingSupersededRefreshTokens);
  await database.delete(postgres.remoteClientSupersededRefreshTokens);
  await database.delete(postgres.remoteClientTokenFamilies);
  await database.delete(postgres.remotePendingLogins);
  await database.delete(postgres.remotePairingCodes);
  await database.delete(postgres.remoteClients);
  const values = relationalValues(state);
  if (values.pairingCodes.length > 0) {
    await database.insert(postgres.remotePairingCodes).values(values.pairingCodes);
  }
  if (values.clients.length > 0) {
    await database.insert(postgres.remoteClients).values(values.clients);
    await database.insert(postgres.remoteClientTokenFamilies).values(values.tokenFamilies);
  }
  if (values.supersededRefreshes.length > 0) {
    await database
      .insert(postgres.remoteClientSupersededRefreshTokens)
      .values(values.supersededRefreshes);
  }
  if (values.pendingLogins.length > 0) {
    await database.insert(postgres.remotePendingLogins).values(values.pendingLogins);
  }
  if (values.pendingSupersededRefreshes.length > 0) {
    await database
      .insert(postgres.remotePendingSupersededRefreshTokens)
      .values(values.pendingSupersededRefreshes);
  }
}

function relationalValues(state: RemoteSecurityState) {
  return {
    pairingCodes: state.pairingCodes.map((code) => ({
      codeId: code.codeId,
      hostUrl: code.hostUrl,
      secretHash: code.secretHash,
      clientLabel: code.clientLabel ?? null,
      createdAt: code.createdAt,
      expiresAt: code.expiresAt,
      attempts: code.attempts,
      maxAttempts: code.maxAttempts,
      usedAt: code.usedAt ?? null,
    })),
    clients: state.clients.map((client) => ({
      clientId: client.clientId,
      clientLabel: client.clientLabel,
      role: client.role,
      hostUrl: client.hostUrl,
      accessTokenHash: client.accessTokenHash,
      accessExpiresAt: client.accessExpiresAt,
      createdAt: client.createdAt,
      lastUsedAt: client.lastUsedAt ?? null,
      revokedAt: client.revokedAt ?? null,
    })),
    tokenFamilies: state.clients.map((client) => ({
      familyId: client.refreshFamilyId,
      clientId: client.clientId,
      refreshTokenHash: client.refreshTokenHash,
      createdAt: client.createdAt,
      revokedAt: client.revokedAt ?? null,
    })),
    supersededRefreshes: state.clients.flatMap((client) =>
      client.supersededRefreshTokenHashes.map((entry) => ({
        familyId: client.refreshFamilyId,
        tokenHash: entry.hash,
        supersededAt: entry.supersededAt,
      })),
    ),
    pendingLogins: state.pendingLogins.map((flow) => ({
      flowId: flow.flowId,
      hostUrl: flow.hostUrl,
      hostIdentity: flow.hostIdentity ?? null,
      operatorCodeHash: flow.operatorCodeHash,
      pendingRefreshHash: flow.pendingRefreshHash,
      pendingRefreshReplay: flow.pendingRefreshReplay ?? null,
      pendingCompletionHash: flow.pendingCompletionHash,
      completionReplay: flow.completionReplay ?? null,
      clientLabel: flow.clientLabel,
      requestedRole: flow.requestedRole,
      grantedRole: flow.grantedRole ?? null,
      clientFingerprint: flow.clientFingerprint ?? null,
      sourceHint: flow.sourceHint ?? null,
      createdAt: flow.createdAt,
      codeExpiresAt: flow.codeExpiresAt,
      flowExpiresAt: flow.flowExpiresAt,
      status: flow.status,
      operatorCodeFingerprint: flow.operatorCodeFingerprint ?? null,
      approvedAt: flow.approvedAt ?? null,
      deniedAt: flow.deniedAt ?? null,
      cancelledAt: flow.cancelledAt ?? null,
      exchangedAt: flow.exchangedAt ?? null,
    })),
    pendingSupersededRefreshes: state.pendingLogins.flatMap((flow) =>
      flow.supersededPendingRefreshHashes.map((entry) => ({
        flowId: flow.flowId,
        tokenHash: entry.hash,
        supersededAt: entry.supersededAt,
      })),
    ),
  };
}

async function lockPostgresRemoteSecurity(database: PostgresTransaction): Promise<void> {
  await database.execute(sql`select pg_advisory_xact_lock(hashtextextended('remote_security', 0))`);
}

function activityValues(
  operatorClientId: string,
  action: string,
  targetKind: string,
  targetKey: string,
  metadata?: Record<string, unknown>,
) {
  return {
    activityKey: randomUUID(),
    operatorClientId,
    action,
    targetKind,
    targetKey,
    outcome: "succeeded",
    metadata: metadata ?? {},
    createdAt: new Date().toISOString(),
  };
}

function parseRole(value: unknown): RemoteClientRole {
  if (value === "access" || value === "operator") return value;
  throw new CapletsError("CONFIG_INVALID", "Stored remote client role is malformed.");
}

function parsePendingStatus(value: unknown): RemotePendingLoginState {
  if (
    value === "pending" ||
    value === "approved" ||
    value === "denied" ||
    value === "cancelled" ||
    value === "exchanged" ||
    value === "expired"
  ) {
    return value;
  }
  throw new CapletsError("CONFIG_INVALID", "Stored pending login status is malformed.");
}

function parsePendingRefreshReplay(value: unknown): PendingRefreshReplay {
  if (
    !isObject(value) ||
    typeof value.refreshHash !== "string" ||
    typeof value.expiresAt !== "string" ||
    !isEncryptedRecord(value.encryptedResponse)
  ) {
    throw new CapletsError("CONFIG_INVALID", "Pending refresh replay is malformed.");
  }
  return {
    refreshHash: value.refreshHash,
    expiresAt: value.expiresAt,
    encryptedResponse: value.encryptedResponse,
  };
}

function parseCompletionReplay(value: unknown): CompletionReplay {
  if (
    !isObject(value) ||
    typeof value.expiresAt !== "string" ||
    !isEncryptedRecord(value.encryptedCredentials)
  ) {
    throw new CapletsError("CONFIG_INVALID", "Pending completion replay is malformed.");
  }
  return {
    expiresAt: value.expiresAt,
    encryptedCredentials: value.encryptedCredentials,
  };
}

function isEncryptedRecord(value: unknown): value is VaultEncryptedRecord {
  return (
    isObject(value) &&
    value.version === 1 &&
    value.algorithm === "aes-256-gcm" &&
    typeof value.nonce === "string" &&
    typeof value.ciphertext === "string" &&
    typeof value.authTag === "string" &&
    typeof value.valueBytes === "number" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.every((key) => typeof value[key] === "string");
}

function isRole(value: unknown): value is RemoteClientRole {
  return value === "access" || value === "operator";
}

function createClient(
  hostUrl: string,
  clientLabel: string,
  role: RemoteClientRole,
  accessToken: string,
  refreshToken: string,
  now: Date,
): StoredRemoteClient {
  return {
    clientId: `rcli_${randomToken(12)}`,
    clientLabel,
    role,
    hostUrl,
    accessTokenHash: hashSecret(accessToken),
    accessExpiresAt: new Date(now.getTime() + DEFAULT_ACCESS_TOKEN_TTL_MS).toISOString(),
    refreshTokenHash: hashSecret(refreshToken),
    supersededRefreshTokenHashes: [],
    refreshFamilyId: randomUUID(),
    createdAt: now.toISOString(),
  };
}
function requireFlow(state: RemoteSecurityState, flowId: string): StoredPendingLogin {
  const flow = state.pendingLogins.find((candidate) => candidate.flowId === flowId);
  if (!flow) throw new CapletsError("AUTH_FAILED", "Pending login flow is unknown.");
  return flow;
}
function pendingLoginForCompletion(
  state: RemoteSecurityState,
  flowId: string,
  secret: string,
  now: Date,
): StoredPendingLogin {
  const flow = state.pendingLogins.find((candidate) => candidate.flowId === flowId);
  if (!flow) throw new CapletsError("AUTH_FAILED", "Pending login is unknown.");
  if (!safeHashEqual(hashSecret(secret), flow.pendingCompletionHash))
    throw new CapletsError("AUTH_FAILED", "Pending login possession material is invalid.");
  if (Date.parse(flow.flowExpiresAt) <= now.getTime() && isActivePendingLogin(flow))
    flow.status = "expired";
  return flow;
}
function denyFlow(flow: StoredPendingLogin, now: Date): void {
  if (flow.status !== "pending")
    throw new CapletsError("AUTH_FAILED", `Pending login is already ${flow.status}.`);
  if (Date.parse(flow.flowExpiresAt) <= now.getTime()) {
    flow.status = "expired";
    throw new CapletsError("AUTH_FAILED", "Pending login has expired.");
  }
  flow.status = "denied";
  flow.deniedAt = now.toISOString();
}
function approveFlow(
  flow: StoredPendingLogin,
  role: RemoteClientRole | undefined,
  now: Date,
): void {
  if (flow.status !== "pending")
    throw new CapletsError("AUTH_FAILED", `Pending login is already ${flow.status}.`);
  if (Date.parse(flow.flowExpiresAt) <= now.getTime()) {
    flow.status = "expired";
    throw new CapletsError("AUTH_FAILED", "Pending login has expired.");
  }
  assertPendingOperatorCodeFresh(flow, now);
  flow.status = "approved";
  flow.grantedRole = role ?? flow.requestedRole;
  flow.approvedAt = now.toISOString();
}
function assertPendingOperatorCodeFresh(flow: StoredPendingLogin, now: Date): void {
  if (Date.parse(flow.codeExpiresAt) <= now.getTime())
    throw new CapletsError(
      "AUTH_FAILED",
      "Pending login code has expired. Refresh the pending login for a new code.",
    );
}

function cleanupPendingLogins(state: RemoteSecurityState, now: Date): boolean {
  let changed = false;
  for (const flow of state.pendingLogins)
    if (isActivePendingLogin(flow) && Date.parse(flow.flowExpiresAt) <= now.getTime()) {
      flow.status = "expired";
      changed = true;
    }
  const retained = state.pendingLogins.filter((flow) => shouldRetain(flow, now));
  if (retained.length !== state.pendingLogins.length) changed = true;
  state.pendingLogins = retained;
  return changed;
}
function isActivePendingLogin(flow: StoredPendingLogin): boolean {
  return flow.status === "pending" || flow.status === "approved";
}
function shouldRetain(flow: StoredPendingLogin, now: Date): boolean {
  if (isActivePendingLogin(flow)) return true;
  const terminal = terminalTime(flow);
  return Number.isFinite(terminal) && now.getTime() - terminal < PENDING_TERMINAL_RETENTION_MS;
}
function terminalTime(flow: StoredPendingLogin): number {
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
function enforcePendingLoginQuota(
  state: RemoteSecurityState,
  sourceHint: string | undefined,
): void {
  const active = state.pendingLogins.filter(isActivePendingLogin);
  if (active.length >= DEFAULT_PENDING_MAX_ACTIVE_FLOWS)
    throw new CapletsError("AUTH_FAILED", "Too many active pending logins.");
  if (
    sourceHint &&
    active.filter((flow) => flow.sourceHint === sourceHint).length >=
      DEFAULT_PENDING_MAX_ACTIVE_FLOWS_PER_SOURCE
  )
    throw new CapletsError("AUTH_FAILED", "Too many active pending logins for this source.");
}
function pruneSupersededRefreshTokens(
  entries: SupersededRefreshToken[],
  now: Date,
): SupersededRefreshToken[] {
  return capSupersededRefreshTokens(
    entries.filter((entry) => {
      const time = Date.parse(entry.supersededAt);
      return Number.isFinite(time) && now.getTime() - time < SUPERSEDED_REFRESH_TOKEN_RETENTION_MS;
    }),
  );
}
function capSupersededRefreshTokens(entries: SupersededRefreshToken[]): SupersededRefreshToken[] {
  return entries.slice(-PENDING_SUPERSEDED_REFRESH_HASH_MAX);
}

function encryptReplayValue(value: unknown, secret: string, now: Date): VaultEncryptedRecord {
  return encryptVaultValue({
    plaintext: JSON.stringify(value),
    key: replayEncryptionKey(secret),
    now,
  });
}
function replayEncryptionKey(secret: string): Buffer {
  return createHash("sha256").update(`caplets-pending-login-replay:${secret}`).digest();
}
function decryptPendingRefreshReplay(replay: PendingRefreshReplay, secret: string) {
  const parsed: unknown = JSON.parse(
    decryptVaultValue(replay.encryptedResponse, replayEncryptionKey(secret)),
  );
  if (
    !isObject(parsed) ||
    !strings(
      parsed,
      "flowId",
      "operatorCode",
      "pendingRefreshSecret",
      "codeExpiresAt",
      "flowExpiresAt",
    ) ||
    typeof parsed.intervalSeconds !== "number"
  )
    throw new CapletsError("CONFIG_INVALID", "Pending login refresh replay record is malformed.");
  return {
    flowId: parsed.flowId as string,
    operatorCode: parsed.operatorCode as string,
    operatorCodeFingerprint:
      typeof parsed.operatorCodeFingerprint === "string"
        ? parsed.operatorCodeFingerprint
        : operatorCodeFingerprint(parsed.operatorCode as string),
    pendingRefreshSecret: parsed.pendingRefreshSecret as string,
    codeExpiresAt: parsed.codeExpiresAt as string,
    flowExpiresAt: parsed.flowExpiresAt as string,
    intervalSeconds: parsed.intervalSeconds,
  };
}
function decryptCompletionReplay(
  replay: CompletionReplay,
  secret: string,
): IssuedRemoteClientCredentials {
  const parsed: unknown = JSON.parse(
    decryptVaultValue(replay.encryptedCredentials, replayEncryptionKey(secret)),
  );
  if (
    !isObject(parsed) ||
    !strings(
      parsed,
      "clientId",
      "clientLabel",
      "hostUrl",
      "accessToken",
      "refreshToken",
      "expiresAt",
      "createdAt",
    ) ||
    !isRole(parsed.role) ||
    parsed.tokenType !== "Bearer"
  )
    throw new CapletsError(
      "CONFIG_INVALID",
      "Pending login completion replay record is malformed.",
    );
  return {
    clientId: parsed.clientId,
    clientLabel: parsed.clientLabel,
    hostUrl: parsed.hostUrl,
    role: parsed.role,
    accessToken: parsed.accessToken,
    refreshToken: parsed.refreshToken,
    expiresAt: parsed.expiresAt,
    createdAt: parsed.createdAt,
    tokenType: "Bearer",
  } as IssuedRemoteClientCredentials;
}
function validateClient(
  client: StoredRemoteClient,
  hostUrl: string,
  now: Date,
  allowExpiredAccess = false,
): void {
  if (client.hostUrl !== hostUrl)
    throw new CapletsError("AUTH_FAILED", "Remote client credential is for a different host.");
  if (client.revokedAt)
    throw new CapletsError(
      "REMOTE_CREDENTIALS_REVOKED",
      "Remote client credential has been revoked.",
    );
  if (!allowExpiredAccess && Date.parse(client.accessExpiresAt) <= now.getTime())
    throw new CapletsError("AUTH_FAILED", "Remote client credential has expired.");
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
function pendingApprovalStatus(flow: StoredPendingLogin) {
  return {
    flowId: flow.flowId,
    status: "approved" as const,
    clientLabel: flow.clientLabel,
    requestedRole: flow.requestedRole,
    grantedRole: flow.grantedRole ?? flow.requestedRole,
    ...(flow.clientFingerprint ? { clientFingerprint: flow.clientFingerprint } : {}),
    ...(flow.sourceHint ? { sourceHint: flow.sourceHint } : {}),
  };
}
function bounded(value: string | undefined, maxLength: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}
function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}
function operatorCodeFingerprint(code: string): string {
  return hashSecret(code).slice(0, 8);
}
function safeHashEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
