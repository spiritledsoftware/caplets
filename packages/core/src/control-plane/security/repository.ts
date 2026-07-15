import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { StoredOAuthTokenBundle, AuthTokenRepository } from "../../auth/store";
import {
  DASHBOARD_ABSOLUTE_TIMEOUT_MS,
  DASHBOARD_IDLE_TIMEOUT_MS,
  type DashboardSessionRepository,
} from "../../dashboard/session-store";
import {
  sanitizeDashboardActivityEntry,
  type DashboardActivityEntry,
  type DashboardActivityMaintenanceRepository,
  type DashboardActivityRepository,
  type ListDashboardActivityInput,
} from "../../dashboard/activity-log";
import type { DashboardSessionView } from "../../dashboard/types";
import { CapletsError } from "../../errors";
import {
  type RemoteCredentialRepository,
  type RemotePendingApprovalResult,
} from "../../remote/server-credential-store";
import {
  roleAllows,
  type IssuedRemoteClientCredentials,
  type RemoteClientRole,
  type RemoteClientStatus,
  type ValidatedRemoteClient,
} from "../../remote/server-credentials";
import { normalizeVaultGrant, sameOrigin } from "../../vault/access";
import {
  decryptSqlVaultValue,
  encryptSqlVaultValue,
  type SqlVaultEncryptedRecord,
} from "../../vault/crypto";
import { assertSqlVaultKeyProvider, validateVaultKeyName } from "../../vault/keys";
import type {
  VaultAccessGrant,
  VaultAccessGrantFilter,
  VaultAccessGrantInput,
  VaultConfigOrigin,
  VaultValueStatus,
} from "../../vault/types";
import type { VaultRepository } from "../../vault";
import {
  computeFileV1ShortCodeVerifier,
  fileV1AssociatedData,
  hashFileV1HighEntropyVerifier,
  verifyFileV1ShortCode,
  type FileV1KeyProvider,
} from "../key-provider/file-v1";
import { decodeCanonicalJson, encodeCanonicalJson } from "../schema/model-codec";
import type {
  ControlPlaneDatabaseRow,
  ControlPlaneSqlTransaction,
  ControlPlaneTransactionalDialect,
} from "../store";
import type { ControlPlaneStoreIdentity } from "../types";
import type {
  ControlPlaneAuthorizationDecision,
  ControlPlaneAuthorizationRequest,
  ControlPlaneAuthorizer,
} from "../authorization";

const ACCESS_TOKEN_TTL_MS = 15 * 60_000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
const PENDING_APPROVAL_TTL_MS = 10 * 60_000;
const ACTIVITY_RETENTION_MS = 90 * 24 * 60 * 60_000;
const MAX_ACTIVITY_LIMIT = 500;
const VAULT_MAX_VALUE_BYTES = 64 * 1024;

export type ControlPlaneSecurityFailurePoint =
  | "after-vault-value"
  | "after-vault-grant"
  | "after-refresh-consume";

export type ControlPlaneSecurityRepositoryOptions = Readonly<{
  identity: ControlPlaneStoreIdentity;
  dialect: ControlPlaneTransactionalDialect;
  keyProvider: FileV1KeyProvider;
  failureInjector?: ((point: ControlPlaneSecurityFailurePoint) => void | Promise<void>) | undefined;
}>;

export interface ControlPlaneSecurityRepository
  extends
    RemoteCredentialRepository,
    DashboardSessionRepository,
    DashboardActivityRepository,
    AuthTokenRepository,
    VaultRepository,
    ControlPlaneAuthorizer {
  readonly identity: ControlPlaneStoreIdentity;
  readonly backend: "sqlite" | "postgres";
  reencryptVaultValues(): Promise<number>;
}

export function createControlPlaneSecurityRepository(
  options: ControlPlaneSecurityRepositoryOptions,
): ControlPlaneSecurityRepository {
  const { identity, dialect, keyProvider } = options;
  assertSqlVaultKeyProvider(keyProvider, identity);
  const fail = async (point: ControlPlaneSecurityFailurePoint): Promise<void> => {
    await options.failureInjector?.(point);
  };
  const binding = (
    purpose: "active-record" | "credential-verifier" | "vault-record",
    recordId: string,
  ) =>
    ({
      logicalHostId: identity.logicalHostId,
      storeId: identity.storeId,
      purpose,
      recordId,
    }) as const;

  const authorizeInTransaction = async (
    transaction: ControlPlaneSqlTransaction,
    request: ControlPlaneAuthorizationRequest,
  ): Promise<ControlPlaneAuthorizationDecision> => {
    if (request.logicalHostId !== identity.logicalHostId || request.storeId !== identity.storeId) {
      return { status: "denied", reason: "target-mismatch" };
    }
    if (request.operationNamespace !== identity.operationNamespace) {
      return { status: "denied", reason: "namespace-mismatch" };
    }
    await transaction.lock(securityEpochLock(identity));
    const now = await transaction.databaseTime();
    const [client] = await transaction.select<ClientRow>(
      "clients",
      scope(identity, { clientId: request.actorId, status: "active" }),
    );
    if (!client || client.revokedAt) return { status: "denied", reason: "revoked" };
    if (!roleAllows(client.role, request.requiredRole)) {
      return { status: "denied", reason: "role-insufficient" };
    }
    const [security] = await transaction.select<SecurityVersionRow>(
      "securityVersions",
      scope(identity),
      [{ column: "epoch", direction: "desc" }],
      1,
    );
    const [fence] = await transaction.select<WriterFenceRow>(
      "writerFences",
      scope(identity, { state: "active" }),
      [{ column: "writerEpoch", direction: "desc" }],
      1,
    );
    if (!security || !fence || isExpired(fence.expiresAt, now)) {
      return { status: "denied", reason: "unavailable" };
    }
    return {
      status: "authorized",
      authorization: {
        ...identity,
        actorId: client.clientId,
        role: client.role,
        securityEpoch: security.epoch,
        writerFence: {
          leaseId: fence.leaseId,
          writerEpoch: fence.writerEpoch,
          authorityGeneration: fence.authorityGeneration,
        },
      },
    };
  };

  const issueClientInTransaction = async (
    transaction: ControlPlaneSqlTransaction,
    input: Readonly<{
      hostUrl: string;
      clientLabel: string;
      role: RemoteClientRole;
      accessTtlMs?: number | undefined;
      clientId?: string | undefined;
      refreshFamilyId?: string | undefined;
    }>,
  ): Promise<IssuedRemoteClientCredentials> => {
    const now = await transaction.databaseTime();
    const clientId = input.clientId ?? opaqueId("client");
    const refreshFamilyId = input.refreshFamilyId ?? opaqueId("refresh-family");
    const accessCredentialId = opaqueId("credential");
    const refreshCredentialId = opaqueId("credential");
    const accessToken = `caplets_access.${accessCredentialId}.${randomToken(32)}`;
    const refreshToken = `caplets_refresh.${refreshCredentialId}.${randomToken(32)}`;
    const expiresAt = addMilliseconds(now, input.accessTtlMs ?? ACCESS_TOKEN_TTL_MS);
    const clientRows = await transaction.select<ClientRow>(
      "clients",
      scope(identity, { clientId }),
    );
    if (clientRows.length === 0) {
      await transaction.insert("clients", {
        ...baseRow(identity, `client:${clientId}`, now),
        clientId,
        role: input.role,
        status: "active",
        hostUrl: input.hostUrl,
        clientLabel: input.clientLabel,
        ownerId: null,
        lastAuthenticatedAt: null,
        revokedAt: null,
      });
    }
    await insertHighEntropyCredential(transaction, identity, {
      clientId,
      credentialId: accessCredentialId,
      purpose: "remote-access",
      secret: accessToken,
      expiresAt,
      refreshFamilyId,
      now,
    });
    await insertHighEntropyCredential(transaction, identity, {
      clientId,
      credentialId: refreshCredentialId,
      purpose: "remote-refresh",
      secret: refreshToken,
      expiresAt: addMilliseconds(now, REFRESH_TOKEN_TTL_MS),
      refreshFamilyId,
      now,
    });
    return {
      hostUrl: input.hostUrl,
      clientId,
      clientLabel: input.clientLabel,
      role: input.role,
      accessToken,
      refreshToken,
      tokenType: "Bearer",
      expiresAt,
      createdAt: now,
    };
  };

  const repository: ControlPlaneSecurityRepository = {
    identity,
    backend: dialect.backend,

    async issueClient(input) {
      validateClientIssue(input);
      return dialect.runtimeTransaction((transaction) =>
        issueClientInTransaction(transaction, input),
      );
    },

    async validateAccessToken(input) {
      return dialect.runtimeTransaction(async (transaction) => {
        await transaction.lock(securityEpochLock(identity));
        const now = await transaction.databaseTime();
        const match = await findCredentialBySecret(transaction, identity, {
          purpose: "remote-access",
          secret: input.accessToken,
        });
        if (!match || match.consumedAt || isExpired(match.expiresAt, now)) throw authFailed();
        const client = await liveClient(transaction, identity, match.clientId, input.hostUrl);
        if (!client || (input.requiredRole && !roleAllows(client.role, input.requiredRole))) {
          throw authFailed();
        }
        await transaction.update(
          "clients",
          { lastAuthenticatedAt: now, updatedAt: now },
          scope(identity, { clientId: client.clientId, status: "active" }),
        );
        return validatedClient(client, now);
      });
    },

    async refreshClientCredentials(input) {
      const outcome = await dialect.runtimeTransaction(async (transaction) => {
        await transaction.lock(securityEpochLock(identity));
        const now = await transaction.databaseTime();
        const match = await findCredentialBySecret(transaction, identity, {
          purpose: "remote-refresh",
          secret: input.refreshToken,
        });
        if (!match || isExpired(match.expiresAt, now)) return { status: "denied" } as const;
        await transaction.lock(`refresh-family:${match.refreshFamilyId ?? match.clientId}`);
        const [current] = await transaction.select<CredentialRow>(
          "credentials",
          scope(identity, { credentialId: match.credentialId }),
        );
        if (!current || current.consumedAt) {
          await transaction.lock(securityEpochLock(identity));
          const revoked = await revokeClientInTransaction(
            transaction,
            identity,
            match.clientId,
            now,
          );
          if (revoked > 0) await advanceSecurityEpoch(transaction, identity, now);
          return { status: "replayed" } as const;
        }
        const client = await liveClient(transaction, identity, current.clientId, input.hostUrl);
        if (!client) return { status: "denied" } as const;
        const consumed = await transaction.update(
          "credentials",
          { consumedAt: now, updatedAt: now },
          scope(identity, { credentialId: current.credentialId, consumedAt: null }),
        );
        if (consumed !== 1) {
          await transaction.lock(securityEpochLock(identity));
          const revoked = await revokeClientInTransaction(
            transaction,
            identity,
            current.clientId,
            now,
          );
          if (revoked > 0) await advanceSecurityEpoch(transaction, identity, now);
          return { status: "replayed" } as const;
        }
        await transaction.update(
          "credentials",
          { consumedAt: now, updatedAt: now },
          scope(identity, {
            clientId: current.clientId,
            purpose: "remote-access",
            consumedAt: null,
          }),
        );
        await fail("after-refresh-consume");
        return {
          status: "issued",
          credentials: await issueClientInTransaction(transaction, {
            hostUrl: client.hostUrl,
            clientLabel: client.clientLabel,
            role: client.role,
            clientId: client.clientId,
            refreshFamilyId: current.refreshFamilyId ?? opaqueId("refresh-family"),
          }),
        } as const;
      });
      if (outcome.status !== "issued") throw authFailed();
      return outcome.credentials;
    },

    async revokeClient(clientId) {
      return dialect.runtimeTransaction(async (transaction) => {
        const now = await transaction.databaseTime();
        await transaction.lock(securityEpochLock(identity));
        const changed = await revokeClientInTransaction(transaction, identity, clientId, now);
        if (changed > 0) await advanceSecurityEpoch(transaction, identity, now);
        return changed > 0;
      });
    },

    async changeClientRole(clientId, role) {
      if (role !== "access" && role !== "operator") {
        throw new CapletsError("REQUEST_INVALID", "Remote client role is invalid.");
      }
      return dialect.runtimeTransaction(async (transaction) => {
        const now = await transaction.databaseTime();
        await transaction.lock(securityEpochLock(identity));
        const changed = await transaction.update(
          "clients",
          { role, updatedAt: now },
          scope(identity, { clientId, status: "active" }),
        );
        if (changed !== 1) return undefined;
        await advanceSecurityEpoch(transaction, identity, now);
        const [row] = await transaction.select<ClientRow>("clients", scope(identity, { clientId }));
        return row ? remoteClientStatus(row) : undefined;
      });
    },

    async createPendingApproval(input = {}) {
      return dialect.runtimeTransaction(async (transaction) => {
        const now = await transaction.databaseTime();
        const approvalId = opaqueId("approval");
        const code = randomToken(8).toUpperCase();
        const verifier = computeFileV1ShortCodeVerifier(keyProvider, {
          ...binding("credential-verifier", `pending-approval:${approvalId}`),
          code,
        });
        const expiresAt = addMilliseconds(now, input.ttlMs ?? PENDING_APPROVAL_TTL_MS);
        await transaction.insert("pendingApprovals", {
          ...baseRow(identity, `pending-approval:${approvalId}`, now),
          approvalId,
          clientId: null,
          verifier: verifier.bytes,
          purpose: "pending-approval",
          algorithm: verifier.algorithm,
          verifierVersion: verifier.verifierVersion,
          keyVersion: verifier.keyVersion,
          requestedRole: null,
          grantedRole: null,
          hostUrl: null,
          clientLabel: null,
          actorId: null,
          state: "pending",
          expiresAt,
          consumedAt: null,
        });
        return { approvalId, code, state: "pending", expiresAt };
      });
    },

    async resolvePendingApproval(input) {
      return dialect.runtimeTransaction(async (transaction) => {
        const now = await transaction.databaseTime();
        await transaction.lock(`pending-approval:${input.approvalId}`);
        const [row] = await transaction.select<PendingApprovalRow>(
          "pendingApprovals",
          scope(identity, { approvalId: input.approvalId }),
        );
        if (!row) throw authFailed();
        if (row.state !== "pending") return pendingApprovalResult(row);
        if (isExpired(row.expiresAt, now)) {
          await transaction.update(
            "pendingApprovals",
            { state: "expired", consumedAt: now, updatedAt: now },
            scope(identity, { approvalId: row.approvalId, state: "pending" }),
          );
          return { ...pendingApprovalResult(row), state: "expired" };
        }
        if (
          row.algorithm !== "HMAC-SHA-256" ||
          row.verifierVersion !== 1 ||
          !verifyFileV1ShortCode(keyProvider, {
            ...binding("credential-verifier", `pending-approval:${row.approvalId}`),
            code: input.code,
            keyVersion: row.keyVersion,
            expected: bytes(row.verifier),
          })
        ) {
          throw authFailed();
        }
        const state = input.action === "approve" ? "approved" : "cancelled";
        const changed = await transaction.update(
          "pendingApprovals",
          { state, consumedAt: now, updatedAt: now },
          scope(identity, { approvalId: row.approvalId, state: "pending" }),
        );
        if (changed !== 1) {
          const [winner] = await transaction.select<PendingApprovalRow>(
            "pendingApprovals",
            scope(identity, { approvalId: row.approvalId }),
          );
          if (!winner) throw authFailed();
          return pendingApprovalResult(winner);
        }
        return { approvalId: row.approvalId, state, expiresAt: row.expiresAt };
      });
    },

    async invalidatePendingApprovalsForMigration() {
      return dialect.runtimeTransaction(async (transaction) => {
        const now = await transaction.databaseTime();
        const rows = await transaction.select<PendingApprovalRow>(
          "pendingApprovals",
          scope(identity),
        );
        let invalidated = 0;
        for (const row of rows) {
          if (row.state !== "pending" && row.state !== "approved") continue;
          invalidated += await transaction.update(
            "pendingApprovals",
            { state: "invalidated", consumedAt: now, updatedAt: now },
            scope(identity, { approvalId: row.approvalId, state: row.state }),
          );
        }
        return invalidated;
      });
    },

    async create(input) {
      return dialect.runtimeTransaction(async (transaction) => {
        await transaction.lock(securityEpochLock(identity));
        const now = await transaction.databaseTime();
        const client = await liveClient(transaction, identity, input.operatorClientId);
        if (!client || client.role !== "operator") throw authFailed();
        const sessionId = opaqueId("dashboard-session");
        const secret = `dash_secret_${randomToken(32)}`;
        const cookieValue = `${sessionId}.${secret}`;
        const csrfToken = deriveCsrfToken(identity, sessionId, secret);
        const absoluteExpiresAt = addMilliseconds(now, DASHBOARD_ABSOLUTE_TIMEOUT_MS);
        const idleExpiresAt = addMilliseconds(now, DASHBOARD_IDLE_TIMEOUT_MS);
        await transaction.insert("dashboardSessions", {
          ...baseRow(identity, `dashboard-session:${sessionId}`, now),
          sessionId,
          clientId: input.operatorClientId,
          verifier: hashFileV1HighEntropyVerifier({
            ...binding("credential-verifier", `dashboard-session:${sessionId}:cookie`),
            secret,
          }),
          algorithm: "SHA-256",
          verifierVersion: 1,
          keyVersion: 0,
          csrfVerifier: hashFileV1HighEntropyVerifier({
            ...binding("credential-verifier", `dashboard-session:${sessionId}:csrf`),
            secret: csrfToken,
          }),
          csrfAlgorithm: "SHA-256",
          csrfKeyVersion: 0,
          absoluteExpiresAt,
          idleExpiresAt,
          expiresAt: absoluteExpiresAt,
          lastSeenAt: now,
          revokedAt: null,
        });
        return {
          cookieValue,
          session: dashboardSessionView(
            { sessionId, clientId: client.clientId, absoluteExpiresAt, lastSeenAt: now },
            csrfToken,
          ),
        };
      });
    },

    async validate(input) {
      const parsed = parseSessionCookie(input.cookieValue);
      if (!parsed) throw authFailed();
      return dialect.runtimeTransaction(async (transaction) => {
        await transaction.lock(securityEpochLock(identity));
        const now = await transaction.databaseTime();
        const [row] = await transaction.select<DashboardSessionRow>(
          "dashboardSessions",
          scope(identity, { sessionId: parsed.sessionId }),
        );
        if (!row || row.revokedAt) throw authFailed();
        const actual = hashFileV1HighEntropyVerifier({
          ...binding("credential-verifier", `dashboard-session:${row.sessionId}:cookie`),
          secret: parsed.secret,
        });
        if (!safeEqual(actual, bytes(row.verifier))) throw authFailed();
        if (isExpired(row.absoluteExpiresAt, now) || isIdleExpired(row.idleExpiresAt, now)) {
          await transaction.update(
            "dashboardSessions",
            { revokedAt: now, updatedAt: now },
            scope(identity, { sessionId: row.sessionId, revokedAt: null }),
          );
          throw authFailed();
        }
        const client = await liveClient(transaction, identity, row.clientId);
        if (!client || client.role !== "operator") {
          await transaction.update(
            "dashboardSessions",
            { revokedAt: now, updatedAt: now },
            scope(identity, { sessionId: row.sessionId, revokedAt: null }),
          );
          throw authFailed();
        }
        const csrfToken = deriveCsrfToken(identity, row.sessionId, parsed.secret);
        const csrfVerifier = hashFileV1HighEntropyVerifier({
          ...binding("credential-verifier", `dashboard-session:${row.sessionId}:csrf`),
          secret: csrfToken,
        });
        if (!safeEqual(csrfVerifier, bytes(row.csrfVerifier))) throw authFailed();
        if (
          input.requireCsrf &&
          (input.csrfToken === undefined ||
            !safeEqual(Buffer.from(input.csrfToken), Buffer.from(csrfToken)))
        ) {
          throw new CapletsError("REQUEST_INVALID", "Dashboard CSRF token is invalid.");
        }
        const idleExpiresAt = addMilliseconds(now, DASHBOARD_IDLE_TIMEOUT_MS);
        const touched = await transaction.update(
          "dashboardSessions",
          { lastSeenAt: now, idleExpiresAt, updatedAt: now },
          scope(identity, { sessionId: row.sessionId, revokedAt: null }),
        );
        if (touched !== 1) throw authFailed();
        return dashboardSessionView({ ...row, lastSeenAt: now }, csrfToken);
      });
    },

    async deleteSession(cookieValue) {
      const parsed = parseSessionCookie(cookieValue);
      if (!parsed) return false;
      return dialect.runtimeTransaction(async (transaction) => {
        const now = await transaction.databaseTime();
        return (
          (await transaction.update(
            "dashboardSessions",
            { revokedAt: now, updatedAt: now },
            scope(identity, { sessionId: parsed.sessionId, revokedAt: null }),
          )) === 1
        );
      });
    },

    async append(input) {
      return dialect.runtimeTransaction(async (transaction) => {
        const now = await transaction.databaseTime();
        const entry = sanitizeDashboardActivityEntry({
          id: opaqueId("activity"),
          createdAt: now,
          actorClientId: input.actorClientId,
          action: input.action,
          outcome: input.outcome ?? "success",
          target: input.target,
          ...(input.metadata ? { metadata: input.metadata } : {}),
        });
        await transaction.insert("operatorActivities", {
          ...baseRow(identity, `operator-activity:${entry.id}`, now),
          activityId: entry.id,
          actorId: entry.actorClientId,
          action: entry.action,
          outcome: entry.outcome,
          target: encodeCanonicalJson(entry.target),
          redactedDetail: encodeCanonicalJson(entry.metadata ?? {}),
          occurredAt: now,
          expiresAt: addMilliseconds(now, ACTIVITY_RETENTION_MS),
        });
        return entry;
      });
    },

    async list(input: ListDashboardActivityInput = {}) {
      return dialect.snapshotTransaction(async (transaction) => {
        const rows = await transaction.select<ActivityRow>(
          "operatorActivities",
          scope(identity, input.action ? { action: input.action } : {}),
          [{ column: "occurredAt", direction: "desc" }],
        );
        let entries = rows.map(activityFromRow);
        if (input.after) {
          const index = entries.findIndex((entry) => entry.id === input.after);
          if (index >= 0) entries = entries.slice(index + 1);
        }
        const limit = Math.min(MAX_ACTIVITY_LIMIT, Math.max(1, Math.trunc(input.limit ?? 100)));
        const page = entries.slice(0, limit);
        const nextCursor = entries.length > limit ? page.at(-1)?.id : undefined;
        return { entries: page, ...(nextCursor ? { nextCursor } : {}) };
      });
    },

    async writeTokenBundle(bundle) {
      validateOAuthBundle(bundle);
      await dialect.runtimeTransaction(async (transaction) => {
        const now = await transaction.databaseTime();
        const [existing] = await transaction.select<OAuthRow>(
          "oauthTokens",
          scope(identity, { serverName: bundle.server }),
        );
        const recordVersion = (existing?.recordVersion ?? 0) + 1;
        const nonce = randomBytes(12);
        const protectedValue = keyProvider.encrypt(
          "active-record",
          Buffer.from(encodeCanonicalJson(bundle), "utf8"),
          nonce,
          fileV1AssociatedData(binding("active-record", `oauth-token:${bundle.server}`)),
        );
        await transaction.insert(
          "oauthTokens",
          {
            ...baseRow(identity, `oauth-token:${bundle.server}`, now),
            serverName: bundle.server,
            ownerId: null,
            accessCiphertext: protectedValue.ciphertext,
            nonce,
            authTag: protectedValue.authenticationTag,
            refreshCiphertext: null,
            authType: null,
            idTokenCiphertext: null,
            issuer: null,
            subject: null,
            clientId: null,
            clientSecretCiphertext: null,
            protectedResourceOrigin: null,
            metadata: null,
            tokenType: null,
            scope: null,
            expiresAt: bundle.expiresAt ?? null,
            keyVersion: protectedValue.keyVersion,
            recordVersion,
            algorithm: "AES-256-GCM",
            aadVersion: 1,
          },
          {
            target: ["logicalHostId", "id"],
            update: {
              accessCiphertext: protectedValue.ciphertext,
              nonce,
              authTag: protectedValue.authenticationTag,
              expiresAt: bundle.expiresAt ?? null,
              keyVersion: protectedValue.keyVersion,
              recordVersion,
              algorithm: "AES-256-GCM",
              aadVersion: 1,
              updatedAt: now,
            },
          },
        );
      });
    },

    async readTokenBundle(server) {
      return dialect.snapshotTransaction(async (transaction) => {
        const [row] = await transaction.select<OAuthRow>(
          "oauthTokens",
          scope(identity, { serverName: server }),
        );
        return row ? decryptOAuthBundle(row, keyProvider, identity) : undefined;
      });
    },

    async listTokenBundles() {
      return dialect.snapshotTransaction(async (transaction) => {
        const rows = await transaction.select<OAuthRow>("oauthTokens", scope(identity), [
          { column: "serverName" },
        ]);
        return rows.map((row) => decryptOAuthBundle(row, keyProvider, identity));
      });
    },

    async deleteTokenBundle(server) {
      return dialect.runtimeTransaction(
        async (transaction) =>
          (await transaction.delete("oauthTokens", scope(identity, { serverName: server }))) === 1,
      );
    },

    async setWithGrant(input) {
      const key = validateVaultKeyName(input.key);
      if (Buffer.byteLength(input.value, "utf8") > VAULT_MAX_VALUE_BYTES) {
        throw new CapletsError("REQUEST_INVALID", "Vault value exceeds the maximum size.");
      }
      return dialect.runtimeTransaction(async (transaction) => {
        const now = await transaction.databaseTime();
        await transaction.lock(`vault:${key}`);
        const [existing] = await transaction.select<VaultValueRow>(
          "vaultValues",
          scope(identity, { referenceName: key }),
        );
        if (existing && !input.force) {
          throw new CapletsError("CONFIG_EXISTS", `Vault key ${key} already exists.`);
        }
        const encrypted = encryptSqlVaultValue({
          plaintext: input.value,
          provider: keyProvider,
          logicalHostId: identity.logicalHostId,
          storeId: identity.storeId,
          referenceName: key,
        });
        await transaction.insert("vaultValues", vaultRow(identity, key, encrypted, now, existing), {
          target: ["logicalHostId", "referenceName"],
          update: {
            recordVersion: (existing?.recordVersion ?? 0) + 1,
            algorithm: encrypted.algorithm,
            ciphertext: encrypted.ciphertext,
            nonce: encrypted.nonce,
            authTag: encrypted.authTag,
            valueBytes: encrypted.valueBytes,
            keyVersion: encrypted.keyVersion,
            aadVersion: encrypted.aadVersion,
            updatedAt: now,
          },
        });
        await fail("after-vault-value");
        if (input.grant) {
          if (validateVaultKeyName(input.grant.storedKey) !== key) {
            throw new CapletsError("REQUEST_INVALID", "Vault grant must target the written key.");
          }
          await upsertGrant(transaction, identity, input.grant, now);
          await fail("after-vault-grant");
        }
        return vaultStatus(key, encrypted.valueBytes, existing?.createdAt ?? now, now);
      });
    },

    async getStatus(key) {
      const referenceName = validateVaultKeyName(key);
      return dialect.snapshotTransaction(async (transaction) => {
        const [row] = await transaction.select<VaultValueRow>(
          "vaultValues",
          scope(identity, { referenceName }),
        );
        return row
          ? vaultStatus(referenceName, row.valueBytes, row.createdAt, row.updatedAt)
          : { key: referenceName, present: false };
      });
    },

    async listValues() {
      return dialect.snapshotTransaction(async (transaction) =>
        (
          await transaction.select<VaultValueRow>("vaultValues", scope(identity), [
            { column: "referenceName" },
          ])
        ).map((row) =>
          vaultStatus(row.referenceName, row.valueBytes, row.createdAt, row.updatedAt),
        ),
      );
    },

    async revealValue(key) {
      const referenceName = validateVaultKeyName(key);
      return dialect.snapshotTransaction(async (transaction) => {
        const [row] = await transaction.select<VaultValueRow>(
          "vaultValues",
          scope(identity, { referenceName }),
        );
        if (!row)
          throw new CapletsError("CONFIG_INVALID", `Vault key ${referenceName} is missing.`);
        return decryptVaultRow(row, keyProvider, identity);
      });
    },

    async deleteValue(key) {
      const referenceName = validateVaultKeyName(key);
      return dialect.runtimeTransaction(async (transaction) => {
        const deleted = await transaction.delete("vaultValues", scope(identity, { referenceName }));
        const grants = await transaction.select<VaultGrantRow>(
          "vaultGrants",
          scope(identity, { storedKey: referenceName }),
        );
        return { key: referenceName, deleted: deleted === 1, grantsRetained: grants.length };
      });
    },

    async grantAccess(input) {
      return dialect.runtimeTransaction(async (transaction) => {
        const now = await transaction.databaseTime();
        return upsertGrant(transaction, identity, input, now);
      });
    },

    async listAccess(filter = {}) {
      return dialect.snapshotTransaction(async (transaction) => {
        const rows = await transaction.select<VaultGrantRow>("vaultGrants", scope(identity));
        return rows.map(grantFromRow).filter((grant) => grantMatches(grant, filter));
      });
    },

    async revokeAccess(filter) {
      return dialect.runtimeTransaction(async (transaction) => {
        await transaction.lock(vaultGrantLock(identity));
        const rows = await transaction.select<VaultGrantRow>("vaultGrants", scope(identity));
        const removed = rows.map(grantFromRow).filter((grant) => grantMatches(grant, filter));
        for (const grant of removed) {
          await transaction.delete("vaultGrants", scope(identity, { id: grantRowId(grant) }));
        }
        return removed;
      });
    },

    async resolveGrantedValue(input) {
      const referenceName = validateVaultKeyName(input.referenceName);
      return dialect.snapshotTransaction(async (transaction) => {
        const candidates = await transaction.select<VaultGrantRow>(
          "vaultGrants",
          scope(identity, { referenceName, capletId: input.capletId }),
        );
        const grant = candidates
          .map(grantFromRow)
          .find((candidate) => sameOrigin(candidate.origin, input.origin));
        if (!grant) return { reason: "ungranted", ...input };
        const [row] = await transaction.select<VaultValueRow>(
          "vaultValues",
          scope(identity, { referenceName: grant.storedKey }),
        );
        if (!row) return { reason: "missing", storedKey: grant.storedKey, ...input };
        return {
          storedKey: grant.storedKey,
          value: decryptVaultRow(row, keyProvider, identity),
        };
      });
    },

    async reencryptVaultValues() {
      return dialect.runtimeTransaction(async (transaction) => {
        const rows = await transaction.select<VaultValueRow>("vaultValues", scope(identity));
        let changed = 0;
        for (const row of rows) {
          const plaintext = decryptVaultRow(row, keyProvider, identity);
          const encrypted = encryptSqlVaultValue({
            plaintext,
            provider: keyProvider,
            logicalHostId: identity.logicalHostId,
            storeId: identity.storeId,
            referenceName: row.referenceName,
          });
          if (encrypted.keyVersion === row.keyVersion) continue;
          changed += await transaction.update(
            "vaultValues",
            {
              recordVersion: row.recordVersion + 1,
              ciphertext: encrypted.ciphertext,
              nonce: encrypted.nonce,
              authTag: encrypted.authTag,
              keyVersion: encrypted.keyVersion,
              updatedAt: await transaction.databaseTime(),
            },
            scope(identity, { referenceName: row.referenceName, keyVersion: row.keyVersion }),
          );
        }
        return changed;
      });
    },

    async authorize(
      request: ControlPlaneAuthorizationRequest,
    ): Promise<ControlPlaneAuthorizationDecision> {
      try {
        return await dialect.runtimeTransaction((transaction) =>
          authorizeInTransaction(transaction, request),
        );
      } catch {
        return { status: "denied", reason: "unavailable" };
      }
    },
    authorizeInTransaction,
  };
  return Object.freeze(repository);
}

export function createControlPlaneActivityMaintenanceRepository(
  options: Readonly<{
    identity: ControlPlaneStoreIdentity;
    dialect: ControlPlaneTransactionalDialect;
  }>,
): DashboardActivityMaintenanceRepository {
  const repository: DashboardActivityMaintenanceRepository = {
    async purgeExpired(input) {
      if (!Number.isSafeInteger(input.watermark) || input.watermark < 0) {
        throw new CapletsError("REQUEST_INVALID", "Activity purge watermark is invalid.");
      }
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) {
        throw new CapletsError("REQUEST_INVALID", "Activity purge batch size is invalid.");
      }
      const receiptId = opaqueId("activity-purge");
      if (options.dialect.maintenancePurgeExpiredOperatorActivity) {
        try {
          const result = await options.dialect.maintenancePurgeExpiredOperatorActivity({
            ...options.identity,
            receiptId,
            watermark: input.watermark,
            limit: input.limit,
          });
          return { deleted: result.deleted, watermark: input.watermark, receiptId };
        } catch (error) {
          if (
            error !== null &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "22023"
          ) {
            throw new CapletsError("REQUEST_INVALID", "Activity purge watermark cannot regress.");
          }
          throw error;
        }
      }
      return options.dialect.maintenanceTransaction(async (transaction) => {
        const now = await transaction.databaseTime();
        await transaction.lock("operator-activity-purge");
        const existing = await transaction.select<RetentionRow>(
          "retentions",
          scope(options.identity, { resourceKind: "operator-activity" }),
          [{ column: "purgeWatermark", direction: "desc" }],
          1,
        );
        const currentWatermark = existing[0]?.purgeWatermark ?? 0;
        if (input.watermark < currentWatermark) {
          throw new CapletsError("REQUEST_INVALID", "Activity purge watermark cannot regress.");
        }
        const candidates = (
          await transaction.select<ActivityRow>("operatorActivities", scope(options.identity), [
            { column: "expiresAt" },
            { column: "activityId" },
          ])
        )
          .filter((row) => isExpired(row.expiresAt, now))
          .slice(0, input.limit);
        for (const row of candidates) {
          await transaction.delete(
            "operatorActivities",
            scope(options.identity, { activityId: row.activityId, expiresAt: row.expiresAt }),
          );
        }
        const sqliteReceiptId = receiptId;
        await transaction.insert("retentions", {
          ...baseRow(options.identity, `retention:${sqliteReceiptId}`, now),
          retentionId: sqliteReceiptId,
          resourceKind: "operator-activity",
          resourceId: "expired-batch",
          policy: "bounded-expired-only",
          purgeWatermark: input.watermark,
          retainUntil: now,
          destroyedAt: now,
        });
        return {
          deleted: candidates.length,
          watermark: input.watermark,
          receiptId: sqliteReceiptId,
        };
      });
    },
  };
  return Object.freeze(repository);
}

type ClientRow = ControlPlaneDatabaseRow & {
  clientId: string;
  role: RemoteClientRole;
  status: string;
  hostUrl: string;
  clientLabel: string;
  createdAt: string;
  lastAuthenticatedAt: string | null;
  revokedAt: string | null;
};
type CredentialRow = ControlPlaneDatabaseRow & {
  credentialId: string;
  clientId: string;
  purpose: string;
  verifierOrCiphertext: Buffer;
  algorithm: string;
  verifierVersion: number;
  expiresAt: string | null;
  refreshFamilyId: string | null;
  consumedAt: string | null;
};
type PendingApprovalRow = ControlPlaneDatabaseRow & {
  approvalId: string;
  verifier: Buffer;
  algorithm: string;
  verifierVersion: number;
  keyVersion: number;
  state: RemotePendingApprovalResult["state"];
  expiresAt: string;
};
type DashboardSessionRow = ControlPlaneDatabaseRow & {
  sessionId: string;
  clientId: string;
  verifier: Buffer;
  csrfVerifier: Buffer;
  absoluteExpiresAt: string;
  idleExpiresAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
};
type ActivityRow = ControlPlaneDatabaseRow & {
  activityId: string;
  actorId: string;
  action: DashboardActivityEntry["action"];
  outcome: DashboardActivityEntry["outcome"];
  target: string;
  redactedDetail: string;
  occurredAt: string;
  expiresAt: string;
};
type OAuthRow = ControlPlaneDatabaseRow & {
  serverName: string;
  accessCiphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  keyVersion: number;
  recordVersion: number;
  algorithm: string;
  aadVersion: number;
};
type VaultValueRow = ControlPlaneDatabaseRow & {
  id: string;
  referenceName: string;
  recordVersion: number;
  algorithm: "AES-256-GCM";
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
  valueBytes: number;
  keyVersion: number;
  aadVersion: 1;
  createdAt: string;
  updatedAt: string;
};
type VaultGrantRow = ControlPlaneDatabaseRow & {
  id: string;
  referenceName: string;
  capletId: string;
  origin: string;
  storedKey: string;
  scope: string | null;
  createdAt: string;
  updatedAt: string;
};
type SecurityVersionRow = ControlPlaneDatabaseRow & {
  epoch: number;
  minimumKeyVersion: number;
  revocationWatermark: number;
};
type WriterFenceRow = ControlPlaneDatabaseRow & {
  leaseId: string;
  writerEpoch: number;
  authorityGeneration: number;
  expiresAt: string;
};
type RetentionRow = ControlPlaneDatabaseRow & { purgeWatermark: number };

function securityEpochLock(identity: ControlPlaneStoreIdentity): string {
  return `security-epoch:${identity.logicalHostId}:${identity.storeId}`;
}

async function advanceSecurityEpoch(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  now: string,
): Promise<number> {
  const [current] = await transaction.select<SecurityVersionRow>(
    "securityVersions",
    scope(identity),
    [{ column: "epoch", direction: "desc" }],
    1,
  );
  if (!current) {
    throw new CapletsError("SERVER_UNAVAILABLE", "SQL security versions are not initialized.");
  }
  const epoch = current.epoch + 1;
  const revocationWatermark = current.revocationWatermark + 1;
  if (!Number.isSafeInteger(epoch) || !Number.isSafeInteger(revocationWatermark)) {
    throw new CapletsError("SERVER_UNAVAILABLE", "SQL security epoch is exhausted.");
  }
  await transaction.insert("securityVersions", {
    ...baseRow(identity, `security-version:${epoch}`, now),
    aggregateVersion: epoch,
    authorityVersion: current.authorityVersion,
    effectiveVersion: current.effectiveVersion,
    securityVersion: epoch,
    epoch,
    minimumKeyVersion: current.minimumKeyVersion,
    revocationWatermark,
    advancedAt: now,
  });
  return epoch;
}

function baseRow(identity: ControlPlaneStoreIdentity, id: string, now: string) {
  return {
    modelVersion: 1,
    id,
    logicalHostId: identity.logicalHostId,
    storeId: identity.storeId,
    createdAt: now,
    updatedAt: now,
    aggregateVersion: 0,
    authorityVersion: 0,
    effectiveVersion: 0,
    securityVersion: 0,
  } as const;
}

function scope(
  identity: ControlPlaneStoreIdentity,
  equals: Readonly<Record<string, unknown>> = {},
) {
  return { equals: { logicalHostId: identity.logicalHostId, ...equals } } as const;
}

function opaqueId(prefix: string): string {
  return `${prefix}_${randomToken(18)}`;
}

function randomToken(bytesCount: number): string {
  return randomBytes(bytesCount).toString("base64url");
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function isExpired(timestamp: string | null, now: string): boolean {
  return timestamp !== null && Date.parse(timestamp) <= Date.parse(now);
}

function isIdleExpired(timestamp: string, now: string): boolean {
  return Date.parse(timestamp) < Date.parse(now);
}

function safeEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function bytes(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new CapletsError("CONFIG_INVALID", "Encrypted SQL security state is malformed.");
}

function authFailed(): CapletsError {
  return new CapletsError("AUTH_FAILED", "SQL security credential is invalid or unavailable.");
}

function validateClientIssue(input: {
  hostUrl: string;
  clientLabel: string;
  role: RemoteClientRole;
}): void {
  if (
    !input.hostUrl ||
    !input.clientLabel ||
    (input.role !== "access" && input.role !== "operator")
  ) {
    throw new CapletsError("REQUEST_INVALID", "Remote client issue request is invalid.");
  }
}

async function insertHighEntropyCredential(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  input: Readonly<{
    credentialId: string;
    clientId: string;
    purpose: "remote-access" | "remote-refresh";
    secret: string;
    expiresAt: string;
    refreshFamilyId: string;
    now: string;
  }>,
): Promise<void> {
  await transaction.insert("credentials", {
    ...baseRow(identity, `credential:${input.credentialId}`, input.now),
    credentialId: input.credentialId,
    clientId: input.clientId,
    purpose: input.purpose,
    protection: "verifier",
    verifierOrCiphertext: hashFileV1HighEntropyVerifier({
      logicalHostId: identity.logicalHostId,
      storeId: identity.storeId,
      purpose: "credential-verifier",
      recordId: `${input.purpose}:${input.credentialId}`,
      secret: input.secret,
    }),
    algorithm: "SHA-256",
    verifierVersion: 1,
    accessCiphertext: null,
    refreshCiphertext: null,
    workspace: null,
    recordVersion: 1,
    ownerId: null,
    keyVersion: 0,
    expiresAt: input.expiresAt,
    refreshFamilyId: input.refreshFamilyId,
    consumedAt: null,
  });
}

async function findCredentialBySecret(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  input: Readonly<{ purpose: string; secret: string }>,
): Promise<CredentialRow | undefined> {
  const credentialId = parseCredentialToken(input.secret, input.purpose);
  if (!credentialId) return undefined;
  const [row] = await transaction.select<CredentialRow>(
    "credentials",
    scope(identity, { purpose: input.purpose, credentialId }),
  );
  if (!row || row.algorithm !== "SHA-256" || row.verifierVersion !== 1) return undefined;
  const candidate = hashFileV1HighEntropyVerifier({
    logicalHostId: identity.logicalHostId,
    storeId: identity.storeId,
    purpose: "credential-verifier",
    recordId: `${input.purpose}:${row.credentialId}`,
    secret: input.secret,
  });
  return safeEqual(candidate, bytes(row.verifierOrCiphertext)) ? row : undefined;
}

function parseCredentialToken(secret: string, purpose: string): string | undefined {
  const expectedPrefix =
    purpose === "remote-access"
      ? "caplets_access"
      : purpose === "remote-refresh"
        ? "caplets_refresh"
        : undefined;
  if (!expectedPrefix) return undefined;
  const [prefix, credentialId, material, extra] = secret.split(".");
  if (
    prefix !== expectedPrefix ||
    extra !== undefined ||
    !credentialId ||
    !/^credential_[A-Za-z0-9_-]{24}$/u.test(credentialId) ||
    !material ||
    !/^[A-Za-z0-9_-]{43}$/u.test(material)
  ) {
    return undefined;
  }
  return credentialId;
}

async function liveClient(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  clientId: string,
  hostUrl?: string,
): Promise<ClientRow | undefined> {
  const [client] = await transaction.select<ClientRow>(
    "clients",
    scope(identity, { clientId, status: "active" }),
  );
  if (!client || client.revokedAt || (hostUrl !== undefined && client.hostUrl !== hostUrl)) {
    return undefined;
  }
  return client;
}

async function revokeClientInTransaction(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  clientId: string,
  now: string,
): Promise<number> {
  const changed = await transaction.update(
    "clients",
    { status: "revoked", revokedAt: now, updatedAt: now },
    scope(identity, { clientId, status: "active" }),
  );
  await transaction.update(
    "credentials",
    { consumedAt: now, updatedAt: now },
    scope(identity, { clientId, consumedAt: null }),
  );
  await transaction.update(
    "dashboardSessions",
    { revokedAt: now, updatedAt: now },
    scope(identity, { clientId, revokedAt: null }),
  );
  return changed;
}

function remoteClientStatus(row: ClientRow): RemoteClientStatus {
  return {
    clientId: row.clientId,
    clientLabel: row.clientLabel,
    role: row.role,
    hostUrl: row.hostUrl,
    createdAt: row.createdAt,
    ...(row.lastAuthenticatedAt ? { lastUsedAt: row.lastAuthenticatedAt } : {}),
    ...(row.revokedAt ? { revokedAt: row.revokedAt } : {}),
  };
}

function validatedClient(row: ClientRow, lastUsedAt: string): ValidatedRemoteClient {
  return {
    ...remoteClientStatus({ ...row, lastAuthenticatedAt: lastUsedAt }),
    tokenType: "Bearer",
  };
}

function pendingApprovalResult(row: PendingApprovalRow): RemotePendingApprovalResult {
  return { approvalId: row.approvalId, state: row.state, expiresAt: row.expiresAt };
}

function parseSessionCookie(
  cookieValue: string,
): { sessionId: string; secret: string } | undefined {
  const separator = cookieValue.indexOf(".");
  if (separator < 1) return undefined;
  const sessionId = cookieValue.slice(0, separator);
  const secret = cookieValue.slice(separator + 1);
  return secret ? { sessionId, secret } : undefined;
}

function deriveCsrfToken(
  identity: ControlPlaneStoreIdentity,
  sessionId: string,
  secret: string,
): string {
  return `csrf_${createHash("sha256")
    .update(
      fileV1AssociatedData({
        logicalHostId: identity.logicalHostId,
        storeId: identity.storeId,
        purpose: "credential-verifier",
        recordId: `dashboard-session:${sessionId}:csrf-derivation`,
      }),
    )
    .update("\0")
    .update(secret)
    .digest("base64url")}`;
}

function dashboardSessionView(
  row: Pick<DashboardSessionRow, "sessionId" | "clientId" | "absoluteExpiresAt" | "lastSeenAt">,
  csrfToken: string,
): DashboardSessionView {
  return {
    sessionId: row.sessionId,
    operatorClientId: row.clientId,
    role: "operator",
    csrfToken,
    createdAt:
      "createdAt" in row && typeof row.createdAt === "string" ? row.createdAt : row.lastSeenAt,
    expiresAt: row.absoluteExpiresAt,
    lastUsedAt: row.lastSeenAt,
  };
}

function activityFromRow(row: ActivityRow): DashboardActivityEntry {
  return sanitizeDashboardActivityEntry({
    id: row.activityId,
    createdAt: row.occurredAt,
    actorClientId: row.actorId,
    action: row.action,
    outcome: row.outcome,
    target: decodeCanonicalJson(row.target) as DashboardActivityEntry["target"],
    metadata: decodeCanonicalJson(row.redactedDetail) as DashboardActivityEntry["metadata"],
  });
}

function validateOAuthBundle(bundle: StoredOAuthTokenBundle): void {
  if (!bundle.server || !bundle.accessToken) {
    throw new CapletsError("REQUEST_INVALID", "OAuth token bundle is invalid.");
  }
}

function decryptOAuthBundle(
  row: OAuthRow,
  provider: FileV1KeyProvider,
  identity: ControlPlaneStoreIdentity,
): StoredOAuthTokenBundle {
  if (row.algorithm !== "AES-256-GCM" || row.aadVersion !== 1) {
    throw new CapletsError("CONFIG_INVALID", "OAuth token protection metadata is unsupported.");
  }
  const plaintext = provider.decrypt(
    "active-record",
    row.keyVersion,
    bytes(row.accessCiphertext),
    bytes(row.nonce),
    bytes(row.authTag),
    fileV1AssociatedData({
      logicalHostId: identity.logicalHostId,
      storeId: identity.storeId,
      purpose: "active-record",
      recordId: `oauth-token:${row.serverName}`,
      aadVersion: row.aadVersion,
    }),
  );
  return decodeCanonicalJson(plaintext.toString("utf8")) as StoredOAuthTokenBundle;
}

function vaultRow(
  identity: ControlPlaneStoreIdentity,
  referenceName: string,
  encrypted: SqlVaultEncryptedRecord,
  now: string,
  existing: VaultValueRow | undefined,
) {
  return {
    ...baseRow(identity, `vault-value:${referenceName}`, existing?.createdAt ?? now),
    updatedAt: now,
    referenceName,
    recordVersion: (existing?.recordVersion ?? 0) + 1,
    algorithm: encrypted.algorithm,
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.nonce,
    authTag: encrypted.authTag,
    valueBytes: encrypted.valueBytes,
    keyVersion: encrypted.keyVersion,
    aadVersion: encrypted.aadVersion,
    ownerId: null,
  };
}

function decryptVaultRow(
  row: VaultValueRow,
  provider: FileV1KeyProvider,
  identity: ControlPlaneStoreIdentity,
): string {
  return decryptSqlVaultValue(
    {
      algorithm: row.algorithm,
      keyVersion: row.keyVersion,
      aadVersion: row.aadVersion,
      nonce: bytes(row.nonce),
      ciphertext: bytes(row.ciphertext),
      authTag: bytes(row.authTag),
      valueBytes: row.valueBytes,
    },
    {
      provider,
      logicalHostId: identity.logicalHostId,
      storeId: identity.storeId,
      referenceName: row.referenceName,
    },
  );
}

function vaultStatus(
  key: string,
  valueBytes: number,
  createdAt: string,
  updatedAt: string,
): VaultValueStatus {
  return { key, present: true, valueBytes, createdAt, updatedAt };
}

async function upsertGrant(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  input: VaultAccessGrantInput,
  now: string,
): Promise<VaultAccessGrant> {
  await transaction.lock(vaultGrantLock(identity));
  const normalized = normalizeVaultGrant({ ...input, now: new Date(now) });
  const candidates = await transaction.select<VaultGrantRow>(
    "vaultGrants",
    scope(identity, {
      referenceName: normalized.referenceName,
      capletId: normalized.capletId,
    }),
  );
  const existing = candidates.find((row) =>
    sameOrigin(grantFromRow(row).origin, normalized.origin),
  );
  const rowId = existing?.id ?? grantRowId(normalized);
  if (existing) {
    await transaction.update(
      "vaultGrants",
      { storedKey: normalized.storedKey, updatedAt: now },
      scope(identity, { id: existing.id }),
    );
  } else {
    await transaction.insert("vaultGrants", {
      ...baseRow(identity, rowId, now),
      referenceName: normalized.referenceName,
      capletId: normalized.capletId,
      origin: encodeCanonicalJson(normalized.origin),
      storedKey: normalized.storedKey,
      scope: null,
      ownerId: null,
    });
  }
  return { ...normalized, createdAt: existing?.createdAt ?? now, updatedAt: now };
}

function vaultGrantLock(identity: ControlPlaneStoreIdentity): string {
  return `vault-grants:${identity.logicalHostId}:${identity.storeId}`;
}

function grantFromRow(row: VaultGrantRow): VaultAccessGrant {
  return {
    storedKey: row.storedKey,
    referenceName: row.referenceName,
    capletId: row.capletId,
    origin: decodeCanonicalJson(row.origin) as VaultConfigOrigin,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function grantMatches(grant: VaultAccessGrant, filter: VaultAccessGrantFilter): boolean {
  return (
    (filter.storedKey === undefined || filter.storedKey === grant.storedKey) &&
    (filter.referenceName === undefined || filter.referenceName === grant.referenceName) &&
    (filter.capletId === undefined || filter.capletId === grant.capletId) &&
    (filter.origin === undefined || sameOrigin(filter.origin, grant.origin))
  );
}

function grantRowId(
  grant: Pick<VaultAccessGrant, "referenceName" | "capletId" | "origin">,
): string {
  return `vault-grant:${createHash("sha256")
    .update(
      encodeCanonicalJson({
        referenceName: grant.referenceName,
        capletId: grant.capletId,
        origin: grant.origin,
      }),
    )
    .digest("hex")}`;
}
