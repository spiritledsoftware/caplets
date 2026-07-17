import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { StoredOAuthTokenBundle, AuthTokenRepository } from "../../auth/store";
import {
  DASHBOARD_ABSOLUTE_TIMEOUT_MS,
  DASHBOARD_IDLE_TIMEOUT_MS,
  type DashboardSessionRepository,
} from "../../dashboard/session-store";
import {
  sanitizeDashboardActivityEntry,
  roleChangeMetadata,
  type AppendDashboardActivityInput,
  type DashboardActivityEntry,
  type DashboardActivityMaintenanceRepository,
  type DashboardActivityRepository,
  type ListDashboardActivityInput,
} from "../../dashboard/activity-log";
import type { DashboardSessionView } from "../../dashboard/types";
import { CapletsError } from "../../errors";
import type { SetupApproval, SetupAttempt } from "../../setup/types";
import type {
  SetupApprovalInput,
  SetupExecutionLease,
  SetupExecutionRequest,
  SetupStore,
  LegacyLocalSetupState,
} from "../../setup/local-store";
import {
  type ApprovePendingLoginInput,
  type ApprovedPendingLogin,
  type CompletePendingLoginInput,
  type CreatePendingLoginInput,
  type CreatedPendingLogin,
  type DashboardPendingLoginActionInput,
  type PendingLoginPossessionInput,
  type RefreshPendingLoginInput,
  type RemoteCredentialRepository,
  type RemotePendingApprovalResult,
  type RemotePendingLoginRepository,
} from "../../remote/server-credential-store";
import {
  roleAllows,
  type IssuedRemoteClientCredentials,
  type RemoteClientRole,
  type RemoteClientStatus,
  type RemotePendingLoginStatus,
  type ValidatedRemoteClient,
} from "../../remote/server-credentials";
import { normalizeRemoteProfileHostUrl } from "../../remote/options";
import { normalizeVaultGrant, sameOrigin } from "../../vault/access";
import {
  decryptSqlVaultValue,
  decryptVaultValue,
  encryptSqlVaultValue,
  encryptVaultValue,
  type SqlVaultEncryptedRecord,
  type VaultEncryptedRecord,
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
import type { ControlPlaneStoreIdentity, ControlPlaneWriterFence } from "../types";
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

export type ControlPlaneSecurityAdmission = Readonly<{
  securityEpoch: number;
}>;

const securityAdmission = new AsyncLocalStorage<ControlPlaneSecurityAdmission>();

export function runWithControlPlaneSecurityAdmission<T>(
  admission: ControlPlaneSecurityAdmission,
  operation: () => Promise<T>,
): Promise<T> {
  return securityAdmission.run(admission, operation);
}

export type ControlPlaneSecurityFailurePoint =
  | "after-vault-value"
  | "after-vault-grant"
  | "after-refresh-consume";

export type ControlPlaneSecurityMutationAuthority = Readonly<{
  securityEpoch: number;
  writerFence: ControlPlaneWriterFence;
}>;

export type ControlPlaneSecurityRepositoryOptions = Readonly<{
  identity: ControlPlaneStoreIdentity;
  dialect: ControlPlaneTransactionalDialect;
  keyProvider: FileV1KeyProvider;
  mutationAuthority?: (() => ControlPlaneSecurityMutationAuthority | undefined) | undefined;
  failureInjector?: ((point: ControlPlaneSecurityFailurePoint) => void | Promise<void>) | undefined;
}>;

export interface ControlPlaneSecurityRepository
  extends
    RemoteCredentialRepository,
    RemotePendingLoginRepository,
    DashboardSessionRepository,
    DashboardActivityRepository,
    AuthTokenRepository,
    VaultRepository,
    SetupStore,
    ControlPlaneAuthorizer {
  readonly identity: ControlPlaneStoreIdentity;
  readonly backend: "sqlite" | "postgres";
  updateActiveKeyProvider(provider: FileV1KeyProvider): void;
  reencryptVaultValues(): Promise<number>;
  listClients(): Promise<RemoteClientStatus[]>;
  importLegacySetupState(
    state: Pick<LegacyLocalSetupState, "approvals" | "attempts">,
  ): Promise<void>;
}

export function createControlPlaneSecurityRepository(
  options: ControlPlaneSecurityRepositoryOptions,
): ControlPlaneSecurityRepository {
  const { identity, dialect } = options;
  let keyProvider = options.keyProvider;
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
  const mutate = <T>(
    work: (
      transaction: ControlPlaneSqlTransaction,
      authority: ControlPlaneSecurityMutationAuthority | undefined,
      commitSecurityEpoch: (securityEpoch: number) => void,
    ) => Promise<T>,
  ): Promise<T> =>
    dialect.runtimeTransaction(async (transaction) => {
      const authority = options.mutationAuthority
        ? await beginSqlSecurityMutation(transaction, identity, options.mutationAuthority)
        : undefined;
      let finalAuthority = authority;
      const admission = securityAdmission.getStore();
      if (authority && admission && authority.securityEpoch !== admission.securityEpoch) {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          "Security authority changed after request admission.",
        );
      }
      const result = await work(transaction, authority, (securityEpoch) => {
        if (!authority) return;
        if (!Number.isSafeInteger(securityEpoch) || securityEpoch !== authority.securityEpoch + 1) {
          throw unavailableSecurityMutation();
        }
        finalAuthority = { ...authority, securityEpoch };
      });
      if (finalAuthority) {
        await guardSqlSecurityMutation(transaction, identity, finalAuthority);
      }
      return result;
    });

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
    const clientId = input.clientId ?? `rcli_${randomToken(12)}`;
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

    updateActiveKeyProvider(provider) {
      assertSqlVaultKeyProvider(provider, identity);
      keyProvider = provider;
    },

    async issueClient(input) {
      validateClientIssue(input);
      return mutate((transaction) => issueClientInTransaction(transaction, input));
    },

    async validateAccessToken(input) {
      return mutate(async (transaction) => {
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
      const outcome = await mutate(async (transaction, _authority, commitSecurityEpoch) => {
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
          if (revoked > 0) {
            commitSecurityEpoch(await advanceSecurityEpoch(transaction, identity, now));
          }
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
          if (revoked > 0) {
            commitSecurityEpoch(await advanceSecurityEpoch(transaction, identity, now));
          }
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

    async revokeClient(clientId, audit) {
      return mutate(async (transaction, _authority, commitSecurityEpoch) => {
        const now = await transaction.databaseTime();
        await transaction.lock(securityEpochLock(identity));
        const [client] = await transaction.select<ClientRow>(
          "clients",
          scope(identity, { clientId }),
          [],
          1,
        );
        const changed = await revokeClientInTransaction(transaction, identity, clientId, now);
        if (changed > 0) {
          commitSecurityEpoch(await advanceSecurityEpoch(transaction, identity, now));
          if (audit) {
            await insertActivityInTransaction(
              transaction,
              identity,
              {
                actorClientId: audit.actorClientId,
                action: "remote_client_revoked",
                target: { type: "remote_client", id: clientId },
                metadata: { role: client?.role ?? null },
              },
              now,
            );
          }
        }
        return changed > 0;
      });
    },

    async changeClientRole(clientId, role, audit) {
      if (role !== "access" && role !== "operator") {
        throw new CapletsError("REQUEST_INVALID", "Remote client role is invalid.");
      }
      return mutate(async (transaction, _authority, commitSecurityEpoch) => {
        const now = await transaction.databaseTime();
        await transaction.lock(securityEpochLock(identity));
        const [before] = await transaction.select<ClientRow>(
          "clients",
          scope(identity, { clientId, status: "active" }),
          [],
          1,
        );
        const changed = await transaction.update(
          "clients",
          { role, updatedAt: now },
          scope(identity, { clientId, status: "active" }),
        );
        if (changed !== 1) return undefined;
        commitSecurityEpoch(await advanceSecurityEpoch(transaction, identity, now));
        const [row] = await transaction.select<ClientRow>("clients", scope(identity, { clientId }));
        if (audit && before && row) {
          await insertActivityInTransaction(
            transaction,
            identity,
            {
              actorClientId: audit.actorClientId,
              action: "remote_client_role_changed",
              target: { type: "remote_client", id: clientId },
              metadata: roleChangeMetadata(before.role, row.role),
            },
            now,
          );
        }
        return row ? remoteClientStatus(row) : undefined;
      });
    },

    async listClients() {
      return dialect.snapshotTransaction(async (transaction) => {
        const rows = await transaction.select<ClientRow>("clients", scope(identity), [
          { column: "createdAt" },
          { column: "clientId" },
        ]);
        return rows.map(remoteClientStatus);
      });
    },

    async createPendingLogin(input) {
      return dialect.runtimeTransaction((transaction) =>
        createSqlPendingLogin(transaction, identity, keyProvider, options.mutationAuthority, input),
      );
    },

    async pollPendingLogin(input) {
      return dialect.runtimeTransaction((transaction) =>
        pollSqlPendingLogin(transaction, identity, keyProvider, options.mutationAuthority, input),
      );
    },

    async refreshPendingLogin(input) {
      return dialect.runtimeTransaction((transaction) =>
        refreshSqlPendingLogin(
          transaction,
          identity,
          keyProvider,
          options.mutationAuthority,
          input,
        ),
      );
    },

    async approvePendingLogin(input) {
      const status = await dialect.runtimeTransaction((transaction) =>
        decideSqlPendingLoginByCode(
          transaction,
          identity,
          keyProvider,
          options.mutationAuthority,
          input,
          "approve",
        ),
      );
      return approvedSqlPendingLogin(status);
    },

    async approvePendingLoginFlow(input) {
      return dialect.runtimeTransaction((transaction) =>
        decideSqlPendingLoginByFlow(
          transaction,
          identity,
          keyProvider,
          options.mutationAuthority,
          input,
          "approve",
        ),
      );
    },

    async denyPendingLogin(input) {
      return dialect.runtimeTransaction((transaction) =>
        decideSqlPendingLoginByCode(
          transaction,
          identity,
          keyProvider,
          options.mutationAuthority,
          input,
          "deny",
        ),
      );
    },

    async denyPendingLoginFlow(input) {
      return dialect.runtimeTransaction((transaction) =>
        decideSqlPendingLoginByFlow(
          transaction,
          identity,
          keyProvider,
          options.mutationAuthority,
          input,
          "deny",
        ),
      );
    },

    async cancelPendingLogin(input) {
      return dialect.runtimeTransaction((transaction) =>
        cancelSqlPendingLogin(transaction, identity, keyProvider, options.mutationAuthority, input),
      );
    },

    async completePendingLogin(input) {
      return dialect.runtimeTransaction((transaction) =>
        completeSqlPendingLogin(
          transaction,
          identity,
          keyProvider,
          options.mutationAuthority,
          input,
          issueClientInTransaction,
        ),
      );
    },

    async listPendingLogins() {
      return dialect.snapshotTransaction((transaction) =>
        listSqlPendingLogins(transaction, identity, keyProvider),
      );
    },

    async createPendingApproval(input = {}) {
      return mutate(async (transaction) => {
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
      return mutate(async (transaction) => {
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
      return mutate(async (transaction) => {
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
      return mutate(async (transaction) => {
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
      return mutate(async (transaction, _authority, commitSecurityEpoch) => {
        await transaction.lock(securityEpochLock(identity));
        const now = await transaction.databaseTime();
        const changed = await transaction.update(
          "dashboardSessions",
          { revokedAt: now, updatedAt: now },
          scope(identity, { sessionId: parsed.sessionId, revokedAt: null }),
        );
        if (changed === 1) {
          commitSecurityEpoch(await advanceSecurityEpoch(transaction, identity, now));
        }
        return changed === 1;
      });
    },

    async append(input) {
      return mutate(async (transaction) =>
        insertActivityInTransaction(transaction, identity, input, await transaction.databaseTime()),
      );
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
      await mutate(async (transaction) => {
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
      return mutate(
        async (transaction) =>
          (await transaction.delete("oauthTokens", scope(identity, { serverName: server }))) === 1,
      );
    },

    async setWithGrant(input, audit) {
      const key = validateVaultKeyName(input.key);
      if (Buffer.byteLength(input.value, "utf8") > VAULT_MAX_VALUE_BYTES) {
        throw new CapletsError("REQUEST_INVALID", "Vault value exceeds the maximum size.");
      }
      return mutate(async (transaction, _authority, commitSecurityEpoch) => {
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
        commitSecurityEpoch(await advanceSecurityEpoch(transaction, identity, now));
        if (audit) {
          await insertActivityInTransaction(
            transaction,
            identity,
            {
              actorClientId: audit.actorClientId,
              action: "vault_set",
              target: { type: "vault", id: key },
              metadata: { bytesWritten: encrypted.valueBytes },
            },
            now,
          );
          if (input.grant) {
            await insertActivityInTransaction(
              transaction,
              identity,
              {
                actorClientId: audit.actorClientId,
                action: "vault_grant_added",
                target: { type: "vault", id: input.grant.storedKey },
                metadata: {
                  referenceName: input.grant.referenceName,
                  capletId: input.grant.capletId,
                  originKind: input.grant.origin.kind,
                },
              },
              now,
            );
          }
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
          throw new CapletsError("CONFIG_NOT_FOUND", `Vault key ${referenceName} is missing.`);
        return decryptVaultRow(row, keyProvider, identity);
      });
    },

    async deleteValue(key, audit) {
      const referenceName = validateVaultKeyName(key);
      return mutate(async (transaction, _authority, commitSecurityEpoch) => {
        const deleted = await transaction.delete("vaultValues", scope(identity, { referenceName }));
        if (deleted === 1) {
          commitSecurityEpoch(
            await advanceSecurityEpoch(transaction, identity, await transaction.databaseTime()),
          );
        }
        const grants = await transaction.select<VaultGrantRow>(
          "vaultGrants",
          scope(identity, { storedKey: referenceName }),
        );
        if (audit) {
          await insertActivityInTransaction(
            transaction,
            identity,
            {
              actorClientId: audit.actorClientId,
              action: "vault_deleted",
              target: { type: "vault", id: referenceName },
              metadata: { deleted: deleted === 1, grantsRetained: grants.length },
            },
            await transaction.databaseTime(),
          );
        }
        return { key: referenceName, deleted: deleted === 1, grantsRetained: grants.length };
      });
    },

    async grantAccess(input, audit) {
      return mutate(async (transaction, _authority, commitSecurityEpoch) => {
        const now = await transaction.databaseTime();
        const grant = await upsertGrant(transaction, identity, input, now);
        commitSecurityEpoch(await advanceSecurityEpoch(transaction, identity, now));
        if (audit) {
          await insertActivityInTransaction(
            transaction,
            identity,
            {
              actorClientId: audit.actorClientId,
              action: "vault_grant_added",
              target: { type: "vault", id: grant.storedKey },
              metadata: {
                referenceName: grant.referenceName,
                capletId: grant.capletId,
                originKind: grant.origin.kind,
              },
            },
            now,
          );
        }
        return grant;
      });
    },

    async listAccess(filter = {}) {
      return dialect.snapshotTransaction(async (transaction) => {
        const rows = await transaction.select<VaultGrantRow>("vaultGrants", scope(identity));
        return rows.map(grantFromRow).filter((grant) => grantMatches(grant, filter));
      });
    },
    async revokeAccess(filter, audit) {
      return mutate(async (transaction, _authority, commitSecurityEpoch) => {
        await transaction.lock(vaultGrantLock(identity));
        const rows = await transaction.select<VaultGrantRow>("vaultGrants", scope(identity));
        const removed = rows.map(grantFromRow).filter((grant) => grantMatches(grant, filter));
        for (const grant of removed) {
          await transaction.delete("vaultGrants", scope(identity, { id: grantRowId(grant) }));
        }
        if (removed.length > 0) {
          commitSecurityEpoch(
            await advanceSecurityEpoch(transaction, identity, await transaction.databaseTime()),
          );
        }
        if (audit) {
          const activityAt = await transaction.databaseTime();
          for (const grant of removed) {
            await insertActivityInTransaction(
              transaction,
              identity,
              {
                actorClientId: audit.actorClientId,
                action: "vault_grant_revoked",
                target: { type: "vault", id: grant.storedKey },
                metadata: {
                  referenceName: grant.referenceName,
                  capletId: grant.capletId,
                  originKind: grant.origin.kind,
                },
              },
              activityAt,
            );
          }
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
      return mutate(async (transaction, _authority, commitSecurityEpoch) => {
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
        if (changed > 0) {
          commitSecurityEpoch(
            await advanceSecurityEpoch(transaction, identity, await transaction.databaseTime()),
          );
        }
        return changed;
      });
    },
    async getApproval(projectFingerprint, capletId, contentHash, targetKind) {
      return dialect.snapshotTransaction(async (transaction) => {
        const [row] = await transaction.select<SetupApprovalRow>(
          "setupApprovals",
          scope(identity, { projectFingerprint, capletId, contentHash, targetKind }),
          [{ column: "approvedAt", direction: "desc" }],
          1,
        );
        return row ? setupApprovalFromRow(row) : undefined;
      });
    },

    async approve(input: SetupApprovalInput) {
      const projectFingerprint = input.projectFingerprint ?? "default";
      return mutate(async (transaction) => {
        const approval: SetupApproval = { ...input, projectFingerprint };
        const approvalId = setupRecordId("approval", [
          projectFingerprint,
          input.capletId,
          input.contentHash,
          input.targetKind,
        ]);
        await transaction.lock(`setup-approval:${identity.logicalHostId}:${approvalId}`);
        const [existing] = await transaction.select<SetupApprovalRow>(
          "setupApprovals",
          scope(identity, { approvalId }),
          undefined,
          1,
        );
        if (existing) {
          const changed = await transaction.update(
            "setupApprovals",
            {
              actor: input.actor,
              approvedAt: input.approvedAt,
              updatedAt: await transaction.databaseTime(),
            },
            scope(identity, { approvalId, approvedAt: existing.approvedAt }),
          );
          if (changed !== 1) {
            throw new CapletsError("SERVER_UNAVAILABLE", "Setup approval changed concurrently.");
          }
          return approval;
        }
        const now = await transaction.databaseTime();
        await transaction.insert("setupApprovals", {
          ...baseRow(identity, setupRecordId("setup-approval-row", [approvalId]), now),
          approvalId,
          projectFingerprint,
          capletId: input.capletId,
          contentHash: input.contentHash,
          targetKind: input.targetKind,
          actor: input.actor,
          approvedAt: input.approvedAt,
        });
        return approval;
      });
    },

    async importLegacySetupState(state) {
      await mutate(async (transaction) => {
        await transaction.lock(`setup-legacy-import:${identity.logicalHostId}`);
        const now = await transaction.databaseTime();
        for (const approval of state.approvals) {
          const approvalId = setupRecordId("approval", [
            approval.projectFingerprint,
            approval.capletId,
            approval.contentHash,
            approval.targetKind,
          ]);
          const [existing] = await transaction.select<SetupApprovalRow>(
            "setupApprovals",
            scope(identity, { approvalId }),
            [],
            1,
          );
          if (existing) continue;
          await transaction.insert("setupApprovals", {
            ...baseRow(identity, setupRecordId("setup-approval-row", [approvalId]), now),
            approvalId,
            projectFingerprint: approval.projectFingerprint,
            capletId: approval.capletId,
            contentHash: approval.contentHash,
            targetKind: approval.targetKind,
            actor: approval.actor,
            approvedAt: approval.approvedAt,
          });
        }
        for (const attempt of state.attempts) {
          assertSetupRetention(attempt.retention.maxAttempts, attempt.retention.days);
          const [existing] = await transaction.select<SetupAttemptRow>(
            "setupAttempts",
            scope(identity, {
              attemptId: attempt.attemptId,
              projectFingerprint: attempt.projectFingerprint,
              capletId: attempt.capletId,
            }),
            [],
            1,
          );
          if (existing) continue;
          const persistedAttempt = redactSetupAttemptForPersistence(attempt);
          const detail = encodeCanonicalJson(persistedAttempt);
          if (Buffer.byteLength(detail, "utf8") > 1024 * 1024) {
            throw new CapletsError(
              "REQUEST_INVALID",
              "Legacy SQL setup attempt exceeds the 1 MiB limit.",
            );
          }
          await transaction.insert("setupAttempts", {
            ...baseRow(
              identity,
              setupRecordId("setup-attempt-row", [
                attempt.projectFingerprint,
                attempt.capletId,
                attempt.attemptId,
              ]),
              now,
            ),
            attemptId: attempt.attemptId,
            projectFingerprint: attempt.projectFingerprint,
            capletId: attempt.capletId,
            contentHash: attempt.contentHash,
            setupHash: attempt.setupHash ?? null,
            targetKind: attempt.targetKind,
            status: attempt.status,
            detail,
            finishedAt: attempt.finishedAt,
          });
          await pruneSetupAttempts(
            transaction,
            identity,
            attempt.projectFingerprint,
            attempt.capletId,
            attempt.retention.maxAttempts,
            attempt.retention.days,
            now,
          );
        }
      });
    },

    async reserveExecution(input: SetupExecutionRequest) {
      assertSetupLeaseTtl(input.ttlMs);
      const executionId = setupRecordId("execution", [
        input.projectFingerprint,
        input.capletId,
        input.contentHash,
        input.setupHash ?? "",
        input.targetKind,
      ]);
      return mutate(async (transaction, authority) => {
        await transaction.lock(`setup-execution:${identity.logicalHostId}:${executionId}`);
        const now = await transaction.databaseTime();
        const token = await currentSetupExecutionToken(transaction, identity, authority);
        if (
          (authority && !input.snapshotToken) ||
          (input.snapshotToken &&
            (input.snapshotToken.authorityGeneration !== token.authorityGeneration ||
              input.snapshotToken.effectiveGeneration !== token.effectiveGeneration ||
              input.snapshotToken.securityEpoch !== token.securityEpoch))
        ) {
          throw new CapletsError("SERVER_UNAVAILABLE", "Setup plan snapshot authority is stale.");
        }
        const [existing] = await transaction.select<SetupExecutionRow>(
          "setupExecutions",
          scope(identity, { executionId }),
          [],
          1,
        );
        if (
          existing &&
          existing.state === "active" &&
          Date.parse(existing.expiresAt) > Date.parse(now) &&
          Number(existing.authorityVersion) === token.authorityGeneration &&
          Number(existing.effectiveVersion) === token.effectiveGeneration &&
          Number(existing.securityVersion) === token.securityEpoch
        ) {
          throw new CapletsError("SERVER_UNAVAILABLE", "Setup execution is already reserved.");
        }
        if (existing) {
          await transaction.delete(
            "setupExecutions",
            scope(identity, { executionId, leaseId: existing.leaseId }),
          );
        }
        const leaseId = opaqueId("setup_lease");
        const expiresAt = addMilliseconds(now, input.ttlMs);
        await transaction.insert("setupExecutions", {
          ...baseRow(identity, setupRecordId("setup-execution-row", [executionId]), now),
          authorityVersion: token.authorityGeneration,
          effectiveVersion: token.effectiveGeneration,
          securityVersion: token.securityEpoch,
          executionId,
          projectFingerprint: input.projectFingerprint,
          capletId: input.capletId,
          contentHash: input.contentHash,
          setupHash: input.setupHash ?? null,
          targetKind: input.targetKind,
          leaseId,
          reservedAt: now,
          expiresAt,
          state: "active",
        });
        return { ...input, executionId, leaseId, expiresAt };
      });
    },

    async renewExecution(lease: SetupExecutionLease, ttlMs: number) {
      assertSetupLeaseTtl(ttlMs);
      return mutate(async (transaction, authority) => {
        await transaction.lock(`setup-execution:${identity.logicalHostId}:${lease.executionId}`);
        const now = await transaction.databaseTime();
        const row = await requireSetupExecutionLease(transaction, identity, lease, now, authority);
        const expiresAt = addMilliseconds(now, ttlMs);
        const changed = await transaction.update(
          "setupExecutions",
          {
            expiresAt,
            updatedAt: now,
            aggregateVersion: Number(row.aggregateVersion) + 1,
          },
          scope(identity, {
            executionId: lease.executionId,
            leaseId: lease.leaseId,
            expiresAt: row.expiresAt,
            state: "active",
          }),
        );
        if (changed !== 1) {
          throw new CapletsError(
            "SERVER_UNAVAILABLE",
            "Setup execution reservation changed concurrently.",
          );
        }
        return { ...lease, ttlMs, expiresAt };
      });
    },

    async releaseExecution(lease: SetupExecutionLease) {
      await mutate(async (transaction) => {
        await transaction.lock(`setup-execution:${identity.logicalHostId}:${lease.executionId}`);
        await transaction.delete(
          "setupExecutions",
          scope(identity, {
            executionId: lease.executionId,
            leaseId: lease.leaseId,
            state: "active",
          }),
        );
      });
    },

    async recordAttempt(attempt, lease) {
      assertSetupRetention(attempt.retention.maxAttempts, attempt.retention.days);
      const persistedAttempt = redactSetupAttemptForPersistence(attempt);
      const detail = encodeCanonicalJson(persistedAttempt);
      if (Buffer.byteLength(detail, "utf8") > 1024 * 1024) {
        throw new CapletsError("REQUEST_INVALID", "SQL setup attempt exceeds the 1 MiB limit.");
      }
      await mutate(async (transaction, authority) => {
        await transaction.lock(
          `setup-attempt:${identity.logicalHostId}:${attempt.projectFingerprint}:${attempt.capletId}`,
        );
        const now = await transaction.databaseTime();
        if (lease) {
          await transaction.lock(`setup-execution:${identity.logicalHostId}:${lease.executionId}`);
          await requireSetupExecutionLease(transaction, identity, lease, now, authority);
          if (
            lease.projectFingerprint !== attempt.projectFingerprint ||
            lease.capletId !== attempt.capletId ||
            lease.contentHash !== attempt.contentHash ||
            (lease.setupHash ?? undefined) !== (attempt.setupHash ?? undefined) ||
            lease.targetKind !== attempt.targetKind
          ) {
            throw new CapletsError(
              "SERVER_UNAVAILABLE",
              "Setup execution reservation does not match the attempt.",
            );
          }
        } else if (options.mutationAuthority) {
          throw new CapletsError(
            "SERVER_UNAVAILABLE",
            "Activated SQL setup attempts require a live execution reservation.",
          );
        }
        await transaction.insert("setupAttempts", {
          ...baseRow(
            identity,
            setupRecordId("setup-attempt-row", [
              attempt.projectFingerprint,
              attempt.capletId,
              attempt.attemptId,
            ]),
            now,
          ),
          attemptId: attempt.attemptId,
          projectFingerprint: attempt.projectFingerprint,
          capletId: attempt.capletId,
          contentHash: attempt.contentHash,
          setupHash: attempt.setupHash ?? null,
          targetKind: attempt.targetKind,
          status: attempt.status,
          detail,
          finishedAt: attempt.finishedAt,
        });
        await pruneSetupAttempts(
          transaction,
          identity,
          attempt.projectFingerprint,
          attempt.capletId,
          attempt.retention.maxAttempts,
          attempt.retention.days,
          now,
        );
      });
    },

    async listAttempts(projectFingerprint, capletId) {
      return dialect.snapshotTransaction(async (transaction) =>
        (
          await transaction.select<SetupAttemptRow>(
            "setupAttempts",
            scope(identity, { projectFingerprint, capletId }),
            [{ column: "createdAt" }],
          )
        ).map(setupAttemptFromRow),
      );
    },

    async pruneAttempts(projectFingerprint, capletId) {
      await mutate(async (transaction) => {
        await transaction.lock(
          `setup-attempt:${identity.logicalHostId}:${projectFingerprint}:${capletId}`,
        );
        const rows = await transaction.select<SetupAttemptRow>(
          "setupAttempts",
          scope(identity, { projectFingerprint, capletId }),
          [{ column: "createdAt" }],
        );
        const latest = rows.at(-1);
        const retention = latest
          ? setupAttemptFromRow(latest).retention
          : { maxAttempts: 3, days: 7 };
        await pruneSetupAttempts(
          transaction,
          identity,
          projectFingerprint,
          capletId,
          retention.maxAttempts,
          retention.days,
          await transaction.databaseTime(),
        );
      });
    },
    retention() {
      return { maxAttempts: 3, days: 7 };
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

const SQL_PENDING_OPERATOR_CODE_TTL_MS = 10 * 60_000;
const SQL_PENDING_FLOW_TTL_MS = 24 * 60 * 60_000;
const SQL_PENDING_POLL_INTERVAL_SECONDS = 5;
const SQL_PENDING_MAX_ACTIVE_FLOWS = 64;
const SQL_PENDING_MAX_ACTIVE_FLOWS_PER_SOURCE = 8;
const SQL_PENDING_COMPLETION_REPLAY_TTL_MS = 30_000;
const SQL_PENDING_TERMINAL_RETENTION_MS = 24 * 60 * 60_000;
const SQL_PENDING_COMPLETION_REPLAY_MAX_BYTES = 8 * 1024;

type SqlPendingCompletionReplay = Readonly<{
  expiresAt: string;
  encryptedCredentials: VaultEncryptedRecord;
}>;

type SqlPendingLoginMetadata = Readonly<{
  version: 1;
  operatorCodeHash: string;
  pendingCompletionHash: string;
  pendingRefreshHash: string;
  codeExpiresAt: string;
  hostIdentity?: string | undefined;
  clientFingerprint?: string | undefined;
  sourceHint?: string | undefined;
  completionReplay?: SqlPendingCompletionReplay | undefined;
}>;

type MutationAuthorityProvider =
  | (() => ControlPlaneSecurityMutationAuthority | undefined)
  | undefined;

async function createSqlPendingLogin(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  keyProvider: FileV1KeyProvider,
  authorityProvider: MutationAuthorityProvider,
  input: CreatePendingLoginInput,
): Promise<CreatedPendingLogin> {
  const mutationAuthority = await beginSqlSecurityMutation(
    transaction,
    identity,
    authorityProvider,
  );
  await transaction.lock(sqlPendingLoginSetLock(identity));
  const now = await transaction.databaseTime();
  const rows = await transaction.select<PendingApprovalRow>(
    "pendingApprovals",
    scope(identity, { purpose: "pending-login" }),
  );
  const active: Array<{ row: PendingApprovalRow; metadata: SqlPendingLoginMetadata }> = [];
  for (const row of rows) {
    if (row.state !== "pending" && row.state !== "approved") {
      const terminalAt = Date.parse(row.consumedAt ?? row.updatedAt);
      if (
        Number.isFinite(terminalAt) &&
        Date.parse(now) - terminalAt >= SQL_PENDING_TERMINAL_RETENTION_MS
      ) {
        await transaction.delete(
          "pendingApprovals",
          scope(identity, { approvalId: row.approvalId, state: row.state }),
        );
      }
      continue;
    }
    if (isExpired(row.expiresAt, now)) {
      await transaction.update(
        "pendingApprovals",
        { state: "expired", consumedAt: now, updatedAt: now },
        scope(identity, { approvalId: row.approvalId, state: row.state }),
      );
      continue;
    }
    active.push({ row, metadata: decryptSqlPendingLoginMetadata(row, identity, keyProvider) });
  }
  const sourceHint = boundedPendingValue(input.sourceHint, 256);
  if (active.length >= SQL_PENDING_MAX_ACTIVE_FLOWS) {
    throw new CapletsError("AUTH_FAILED", "Too many active pending logins.");
  }
  if (
    sourceHint &&
    active.filter(({ metadata }) => (metadata.sourceHint ?? "") === sourceHint).length >=
      SQL_PENDING_MAX_ACTIVE_FLOWS_PER_SOURCE
  ) {
    throw new CapletsError("AUTH_FAILED", "Too many active pending logins for this source.");
  }

  const flowId = `rlogin_${randomToken(12)}`;
  const operatorCode = `cap_login_${randomToken(5)}`;
  const pendingRefreshSecret = `cap_pending_refresh_${randomToken(32)}`;
  const pendingCompletionSecret = `cap_pending_complete_${randomToken(32)}`;
  const codeExpiresAt = addMilliseconds(now, SQL_PENDING_OPERATOR_CODE_TTL_MS);
  const flowExpiresAt = addMilliseconds(now, SQL_PENDING_FLOW_TTL_MS);
  const clientLabel = boundedPendingValue(input.clientLabel, 120) ?? "Caplets Remote Client";
  const metadata: SqlPendingLoginMetadata = {
    version: 1,
    operatorCodeHash: hashPendingSecret(operatorCode),
    pendingCompletionHash: hashPendingSecret(pendingCompletionSecret),
    pendingRefreshHash: hashPendingSecret(pendingRefreshSecret),
    codeExpiresAt,
    ...(input.hostIdentity ? { hostIdentity: boundedPendingValue(input.hostIdentity, 256) } : {}),
    ...(input.clientFingerprint
      ? { clientFingerprint: boundedPendingValue(input.clientFingerprint, 256) }
      : {}),
    ...(sourceHint ? { sourceHint } : {}),
  };
  const protectedMetadata = encryptSqlPendingLoginMetadata(flowId, metadata, identity, keyProvider);
  await transaction.insert("pendingApprovals", {
    ...baseRow(identity, `pending-login:${flowId}`, now),
    approvalId: flowId,
    clientId: null,
    verifier: protectedMetadata.verifier,
    purpose: "pending-login",
    algorithm: protectedMetadata.algorithm,
    verifierVersion: 1,
    keyVersion: protectedMetadata.keyVersion,
    requestedRole: input.requestedRole ?? "access",
    grantedRole: null,
    hostUrl: normalizeRemoteProfileHostUrl(input.hostUrl),
    clientLabel,
    actorId: null,
    state: "pending",
    expiresAt: flowExpiresAt,
    consumedAt: null,
  });
  await guardSqlSecurityMutation(transaction, identity, mutationAuthority);
  return {
    flowId,
    operatorCode,
    operatorCodeFingerprint: pendingCodeFingerprint(operatorCode),
    pendingRefreshSecret,
    pendingCompletionSecret,
    codeExpiresAt,
    flowExpiresAt,
    intervalSeconds: SQL_PENDING_POLL_INTERVAL_SECONDS,
  };
}

async function pollSqlPendingLogin(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  keyProvider: FileV1KeyProvider,
  authorityProvider: MutationAuthorityProvider,
  input: PendingLoginPossessionInput,
): Promise<Readonly<{ flowId: string; status: RemotePendingLoginStatus["status"] }>> {
  await transaction.lock(sqlPendingLoginLock(input.flowId));
  const { row, now } = await requireSqlPendingLogin(
    transaction,
    identity,
    keyProvider,
    input.flowId,
    input.pendingCompletionSecret,
  );
  if ((row.state === "pending" || row.state === "approved") && isExpired(row.expiresAt, now)) {
    const mutationAuthority = await beginSqlSecurityMutation(
      transaction,
      identity,
      authorityProvider,
    );
    await transaction.update(
      "pendingApprovals",
      { state: "expired", consumedAt: now, updatedAt: now },
      scope(identity, { approvalId: row.approvalId, state: row.state }),
    );
    await guardSqlSecurityMutation(transaction, identity, mutationAuthority);
    return { flowId: row.approvalId, status: "expired" };
  }
  return { flowId: row.approvalId, status: sqlPendingState(row.state) };
}

async function refreshSqlPendingLogin(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  keyProvider: FileV1KeyProvider,
  authorityProvider: MutationAuthorityProvider,
  input: RefreshPendingLoginInput,
): Promise<Omit<CreatedPendingLogin, "pendingCompletionSecret">> {
  const mutationAuthority = await beginSqlSecurityMutation(
    transaction,
    identity,
    authorityProvider,
  );
  await transaction.lock(sqlPendingLoginLock(input.flowId));
  const { row, metadata, now } = await requireSqlPendingLogin(
    transaction,
    identity,
    keyProvider,
    input.flowId,
    input.pendingCompletionSecret,
  );
  if (
    row.state !== "pending" ||
    isExpired(row.expiresAt, now) ||
    !pendingSecretMatches(input.pendingRefreshSecret, metadata.pendingRefreshHash)
  ) {
    throw authFailed();
  }
  const operatorCode = `cap_login_${randomToken(5)}`;
  const pendingRefreshSecret = `cap_pending_refresh_${randomToken(32)}`;
  const codeExpiresAt = addMilliseconds(now, SQL_PENDING_OPERATOR_CODE_TTL_MS);
  const nextMetadata: SqlPendingLoginMetadata = {
    ...metadata,
    operatorCodeHash: hashPendingSecret(operatorCode),
    pendingRefreshHash: hashPendingSecret(pendingRefreshSecret),
    codeExpiresAt,
  };
  const protectedMetadata = encryptSqlPendingLoginMetadata(
    row.approvalId,
    nextMetadata,
    identity,
    keyProvider,
  );
  const changed = await transaction.update(
    "pendingApprovals",
    {
      verifier: protectedMetadata.verifier,
      algorithm: protectedMetadata.algorithm,
      keyVersion: protectedMetadata.keyVersion,
      updatedAt: now,
    },
    scope(identity, { approvalId: row.approvalId, state: "pending" }),
  );
  if (changed !== 1) throw authFailed();
  await guardSqlSecurityMutation(transaction, identity, mutationAuthority);
  return {
    flowId: row.approvalId,
    operatorCode,
    operatorCodeFingerprint: pendingCodeFingerprint(operatorCode),
    pendingRefreshSecret,
    codeExpiresAt,
    flowExpiresAt: row.expiresAt,
    intervalSeconds: SQL_PENDING_POLL_INTERVAL_SECONDS,
  };
}

async function decideSqlPendingLoginByCode(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  keyProvider: FileV1KeyProvider,
  authorityProvider: MutationAuthorityProvider,
  input: ApprovePendingLoginInput,
  decision: "approve" | "deny",
): Promise<RemotePendingLoginStatus> {
  const mutationAuthority = await beginSqlSecurityMutation(
    transaction,
    identity,
    authorityProvider,
  );
  await transaction.lock(sqlPendingLoginSetLock(identity));
  const now = await transaction.databaseTime();
  const rows = await transaction.select<PendingApprovalRow>(
    "pendingApprovals",
    scope(identity, { purpose: "pending-login", state: "pending" }),
    [{ column: "createdAt" }],
    SQL_PENDING_MAX_ACTIVE_FLOWS,
  );
  const match = rows.find((row) => {
    const metadata = decryptSqlPendingLoginMetadata(row, identity, keyProvider);
    return pendingSecretMatches(input.operatorCode, metadata.operatorCodeHash);
  });
  if (!match) throw authFailed();
  return decideSqlPendingLogin(
    transaction,
    identity,
    keyProvider,
    mutationAuthority,
    match,
    now,
    decision,
    true,
    input.grantedRole,
  );
}

async function decideSqlPendingLoginByFlow(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  keyProvider: FileV1KeyProvider,
  authorityProvider: MutationAuthorityProvider,
  input: DashboardPendingLoginActionInput,
  decision: "approve" | "deny",
): Promise<RemotePendingLoginStatus> {
  const mutationAuthority = await beginSqlSecurityMutation(
    transaction,
    identity,
    authorityProvider,
  );
  await transaction.lock(sqlPendingLoginLock(input.flowId));
  const now = await transaction.databaseTime();
  const [row] = await transaction.select<PendingApprovalRow>(
    "pendingApprovals",
    scope(identity, { approvalId: input.flowId, purpose: "pending-login" }),
    [],
    1,
  );
  if (!row) throw authFailed();
  return decideSqlPendingLogin(
    transaction,
    identity,
    keyProvider,
    mutationAuthority,
    row,
    now,
    decision,
    false,
    input.grantedRole,
  );
}

async function decideSqlPendingLogin(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  keyProvider: FileV1KeyProvider,
  mutationAuthority: ControlPlaneSecurityMutationAuthority,
  row: PendingApprovalRow,
  now: string,
  decision: "approve" | "deny",
  requireFreshOperatorCode: boolean,
  grantedRole?: RemoteClientRole | undefined,
): Promise<RemotePendingLoginStatus> {
  const metadata = decryptSqlPendingLoginMetadata(row, identity, keyProvider);
  if (
    row.state !== "pending" ||
    isExpired(row.expiresAt, now) ||
    (requireFreshOperatorCode && isExpired(metadata.codeExpiresAt, now))
  ) {
    throw authFailed();
  }
  const role = grantedRole ?? row.requestedRole ?? "access";
  if (role !== "access" && role !== "operator") throw authFailed();
  const state = decision === "approve" ? "approved" : "denied";
  const changed = await transaction.update(
    "pendingApprovals",
    {
      state,
      grantedRole: decision === "approve" ? role : null,
      consumedAt: decision === "deny" ? now : null,
      updatedAt: now,
    },
    scope(identity, { approvalId: row.approvalId, state: "pending" }),
  );
  if (changed !== 1) throw authFailed();
  await guardSqlSecurityMutation(transaction, identity, mutationAuthority);
  return sqlPendingLoginStatus(
    {
      ...row,
      state,
      grantedRole: decision === "approve" ? role : null,
      consumedAt: decision === "deny" ? now : null,
      updatedAt: now,
    },
    metadata,
    now,
  );
}

async function cancelSqlPendingLogin(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  keyProvider: FileV1KeyProvider,
  authorityProvider: MutationAuthorityProvider,
  input: PendingLoginPossessionInput,
): Promise<Readonly<{ flowId: string; status: "cancelled" }>> {
  const mutationAuthority = await beginSqlSecurityMutation(
    transaction,
    identity,
    authorityProvider,
  );
  await transaction.lock(sqlPendingLoginLock(input.flowId));
  const { row, now } = await requireSqlPendingLogin(
    transaction,
    identity,
    keyProvider,
    input.flowId,
    input.pendingCompletionSecret,
  );
  if (row.state !== "pending" && row.state !== "approved") throw authFailed();
  const changed = await transaction.update(
    "pendingApprovals",
    { state: "cancelled", consumedAt: now, updatedAt: now },
    scope(identity, { approvalId: row.approvalId, state: row.state }),
  );
  if (changed !== 1) throw authFailed();
  await guardSqlSecurityMutation(transaction, identity, mutationAuthority);
  return { flowId: row.approvalId, status: "cancelled" };
}

async function completeSqlPendingLogin(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  keyProvider: FileV1KeyProvider,
  authorityProvider: MutationAuthorityProvider,
  input: CompletePendingLoginInput,
  issueClient: (
    transaction: ControlPlaneSqlTransaction,
    input: Readonly<{
      hostUrl: string;
      clientLabel: string;
      role: RemoteClientRole;
      accessTtlMs?: number | undefined;
      clientId?: string | undefined;
      refreshFamilyId?: string | undefined;
    }>,
  ) => Promise<IssuedRemoteClientCredentials>,
): Promise<IssuedRemoteClientCredentials> {
  const mutationAuthority = await beginSqlSecurityMutation(
    transaction,
    identity,
    authorityProvider,
  );
  await transaction.lock(sqlPendingLoginLock(input.flowId));
  const { row, metadata, now } = await requireSqlPendingLogin(
    transaction,
    identity,
    keyProvider,
    input.flowId,
    input.pendingCompletionSecret,
  );
  if (
    isExpired(row.expiresAt, now) ||
    row.hostUrl !== normalizeRemoteProfileHostUrl(input.hostUrl)
  ) {
    throw authFailed();
  }
  if (row.state === "exchanged") {
    const replay = metadata.completionReplay;
    if (!replay || isExpired(replay.expiresAt, now)) throw authFailed();
    const credentials = decryptSqlPendingCompletionReplay(replay, input.pendingCompletionSecret);
    if (input.requiredRole !== undefined && !roleAllows(credentials.role, input.requiredRole)) {
      throw authFailed();
    }
    return credentials;
  }
  if (row.state !== "approved") throw authFailed();
  const role = row.grantedRole ?? row.requestedRole ?? "access";
  if (
    (role !== "access" && role !== "operator") ||
    (input.requiredRole !== undefined && !roleAllows(role, input.requiredRole))
  ) {
    throw authFailed();
  }
  const credentials = await issueClient(transaction, {
    hostUrl: row.hostUrl,
    clientLabel: row.clientLabel ?? "Caplets Remote Client",
    role,
  });
  const completionReplay = encryptSqlPendingCompletionReplay(
    credentials,
    input.pendingCompletionSecret,
    now,
  );
  const protectedMetadata = encryptSqlPendingLoginMetadata(
    row.approvalId,
    { ...metadata, completionReplay },
    identity,
    keyProvider,
  );
  const changed = await transaction.update(
    "pendingApprovals",
    {
      state: "exchanged",
      consumedAt: now,
      updatedAt: now,
      verifier: protectedMetadata.verifier,
      algorithm: protectedMetadata.algorithm,
      keyVersion: protectedMetadata.keyVersion,
    },
    scope(identity, { approvalId: row.approvalId, state: "approved" }),
  );
  if (changed !== 1) throw authFailed();
  await guardSqlSecurityMutation(transaction, identity, mutationAuthority);
  return credentials;
}

async function listSqlPendingLogins(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  keyProvider: FileV1KeyProvider,
): Promise<RemotePendingLoginStatus[]> {
  const now = await transaction.databaseTime();
  const rows = await transaction.select<PendingApprovalRow>(
    "pendingApprovals",
    scope(identity, { purpose: "pending-login" }),
    [{ column: "createdAt", direction: "desc" }],
    SQL_PENDING_MAX_ACTIVE_FLOWS,
  );
  return rows.map((row) =>
    sqlPendingLoginStatus(row, decryptSqlPendingLoginMetadata(row, identity, keyProvider), now),
  );
}

async function requireSqlPendingLogin(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  keyProvider: FileV1KeyProvider,
  flowId: string,
  pendingCompletionSecret: string,
): Promise<
  Readonly<{
    row: PendingApprovalRow;
    metadata: SqlPendingLoginMetadata;
    now: string;
  }>
> {
  const now = await transaction.databaseTime();
  const [row] = await transaction.select<PendingApprovalRow>(
    "pendingApprovals",
    scope(identity, { approvalId: flowId, purpose: "pending-login" }),
    [],
    1,
  );
  if (!row) throw authFailed();
  const metadata = decryptSqlPendingLoginMetadata(row, identity, keyProvider);
  if (!pendingSecretMatches(pendingCompletionSecret, metadata.pendingCompletionHash)) {
    throw authFailed();
  }
  return { row, metadata, now };
}

async function beginSqlSecurityMutation(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  authorityProvider: (() => ControlPlaneSecurityMutationAuthority | undefined) | undefined,
): Promise<ControlPlaneSecurityMutationAuthority> {
  const authority = authorityProvider?.();
  if (
    !authority ||
    !Number.isSafeInteger(authority.securityEpoch) ||
    authority.securityEpoch < 0 ||
    !Number.isSafeInteger(authority.writerFence.writerEpoch) ||
    authority.writerFence.writerEpoch < 1 ||
    !Number.isSafeInteger(authority.writerFence.authorityGeneration) ||
    authority.writerFence.authorityGeneration < 0
  ) {
    throw unavailableSecurityMutation();
  }
  await checkSqlSecurityMutation(transaction, identity, authority);
  return authority;
}

async function checkSqlSecurityMutation(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  authority: ControlPlaneSecurityMutationAuthority,
): Promise<void> {
  const now = await transaction.databaseTime();
  const [[authorityRow], [security], [fence]] = await Promise.all([
    transaction.select<ControlPlaneDatabaseRow & { generation: number; bindingState: string }>(
      "authorityVersions",
      scope(identity, {
        generation: authority.writerFence.authorityGeneration,
        bindingState: "active",
      }),
      [],
      1,
    ),
    transaction.select<SecurityVersionRow>(
      "securityVersions",
      scope(identity),
      [{ column: "epoch", direction: "desc" }],
      1,
    ),
    transaction.select<WriterFenceRow>(
      "writerFences",
      scope(identity, {
        leaseId: authority.writerFence.leaseId,
        writerEpoch: authority.writerFence.writerEpoch,
        authorityGeneration: authority.writerFence.authorityGeneration,
        state: "active",
      }),
      [],
      1,
    ),
  ]);
  if (
    !authorityRow ||
    !security ||
    Number(security.epoch) !== authority.securityEpoch ||
    !fence ||
    isExpired(fence.expiresAt, now)
  ) {
    throw unavailableSecurityMutation();
  }
}

async function guardSqlSecurityMutation(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  authority: ControlPlaneSecurityMutationAuthority,
): Promise<void> {
  const [authorityRow] = await transaction.select<
    ControlPlaneDatabaseRow & { generation: number; bindingState: string }
  >(
    "authorityVersions",
    scope(identity, {
      generation: authority.writerFence.authorityGeneration,
      bindingState: "active",
    }),
    [],
    1,
  );
  const [security] = await transaction.select<SecurityVersionRow>(
    "securityVersions",
    scope(identity),
    [{ column: "epoch", direction: "desc" }],
    1,
  );
  if (!authorityRow || !security || Number(security.epoch) !== authority.securityEpoch) {
    throw unavailableSecurityMutation();
  }
  const changed = await transaction.finalWriterFenceGuard({
    logicalHostId: identity.logicalHostId,
    storeId: identity.storeId,
    leaseId: authority.writerFence.leaseId,
    writerEpoch: authority.writerFence.writerEpoch,
    authorityGeneration: authority.writerFence.authorityGeneration,
  });
  if (changed !== 1) throw unavailableSecurityMutation();
}

function encryptSqlPendingLoginMetadata(
  flowId: string,
  metadata: SqlPendingLoginMetadata,
  identity: ControlPlaneStoreIdentity,
  keyProvider: FileV1KeyProvider,
): Readonly<{ verifier: Buffer; algorithm: string; keyVersion: number }> {
  const encrypted = encryptSqlVaultValue({
    plaintext: encodeCanonicalJson(metadata),
    provider: keyProvider,
    logicalHostId: identity.logicalHostId,
    storeId: identity.storeId,
    referenceName: `pending-login:${flowId}`,
  });
  return {
    verifier: Buffer.from(
      encodeCanonicalJson({
        version: 1,
        nonce: encrypted.nonce.toString("base64url"),
        ciphertext: encrypted.ciphertext.toString("base64url"),
        authTag: encrypted.authTag.toString("base64url"),
        valueBytes: encrypted.valueBytes,
      }),
      "utf8",
    ),
    algorithm: "AES-256-GCM-BUNDLE",
    keyVersion: encrypted.keyVersion,
  };
}

function decryptSqlPendingLoginMetadata(
  row: PendingApprovalRow,
  identity: ControlPlaneStoreIdentity,
  keyProvider: FileV1KeyProvider,
): SqlPendingLoginMetadata {
  if (row.algorithm !== "AES-256-GCM-BUNDLE" || row.verifierVersion !== 1) {
    throw authFailed();
  }
  const decoded = decodeCanonicalJson(bytes(row.verifier).toString("utf8"));
  if (!isRecord(decoded)) throw authFailed();
  const plaintext = decryptSqlVaultValue(
    {
      algorithm: "AES-256-GCM",
      keyVersion: row.keyVersion,
      aadVersion: 1,
      nonce: Buffer.from(requiredMetadataString(decoded, "nonce"), "base64url"),
      ciphertext: Buffer.from(requiredMetadataString(decoded, "ciphertext"), "base64url"),
      authTag: Buffer.from(requiredMetadataString(decoded, "authTag"), "base64url"),
      valueBytes: requiredMetadataNumber(decoded, "valueBytes"),
    },
    {
      provider: keyProvider,
      logicalHostId: identity.logicalHostId,
      storeId: identity.storeId,
      referenceName: `pending-login:${row.approvalId}`,
    },
  );
  const metadata = decodeCanonicalJson(plaintext);
  if (
    !isRecord(metadata) ||
    metadata.version !== 1 ||
    typeof metadata.operatorCodeHash !== "string" ||
    typeof metadata.pendingCompletionHash !== "string" ||
    typeof metadata.pendingRefreshHash !== "string" ||
    typeof metadata.codeExpiresAt !== "string"
  ) {
    throw authFailed();
  }
  return {
    version: 1,
    operatorCodeHash: metadata.operatorCodeHash,
    pendingCompletionHash: metadata.pendingCompletionHash,
    pendingRefreshHash: metadata.pendingRefreshHash,
    codeExpiresAt: metadata.codeExpiresAt,
    ...(typeof metadata.hostIdentity === "string" ? { hostIdentity: metadata.hostIdentity } : {}),
    ...(typeof metadata.clientFingerprint === "string"
      ? { clientFingerprint: metadata.clientFingerprint }
      : {}),
    ...(typeof metadata.sourceHint === "string" ? { sourceHint: metadata.sourceHint } : {}),
    ...(metadata.completionReplay === undefined
      ? {}
      : { completionReplay: parseSqlPendingCompletionReplay(metadata.completionReplay) }),
  };
}
function encryptSqlPendingCompletionReplay(
  credentials: IssuedRemoteClientCredentials,
  pendingCompletionSecret: string,
  now: string,
): SqlPendingCompletionReplay {
  const plaintext = encodeCanonicalJson(credentials);
  if (Buffer.byteLength(plaintext, "utf8") > SQL_PENDING_COMPLETION_REPLAY_MAX_BYTES) {
    throw authFailed();
  }
  return {
    expiresAt: addMilliseconds(now, SQL_PENDING_COMPLETION_REPLAY_TTL_MS),
    encryptedCredentials: encryptVaultValue({
      plaintext,
      key: sqlPendingReplayEncryptionKey(pendingCompletionSecret),
      now: new Date(now),
    }),
  };
}

function decryptSqlPendingCompletionReplay(
  replay: SqlPendingCompletionReplay,
  pendingCompletionSecret: string,
): IssuedRemoteClientCredentials {
  if (replay.encryptedCredentials.valueBytes > SQL_PENDING_COMPLETION_REPLAY_MAX_BYTES) {
    throw authFailed();
  }
  try {
    const parsed = decodeCanonicalJson(
      decryptVaultValue(
        replay.encryptedCredentials,
        sqlPendingReplayEncryptionKey(pendingCompletionSecret),
      ),
    );
    if (
      !isRecord(parsed) ||
      typeof parsed.clientId !== "string" ||
      typeof parsed.clientLabel !== "string" ||
      typeof parsed.hostUrl !== "string" ||
      (parsed.role !== "access" && parsed.role !== "operator") ||
      typeof parsed.accessToken !== "string" ||
      typeof parsed.refreshToken !== "string" ||
      typeof parsed.expiresAt !== "string" ||
      typeof parsed.createdAt !== "string" ||
      parsed.tokenType !== "Bearer"
    ) {
      throw authFailed();
    }
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
    };
  } catch {
    throw authFailed();
  }
}

function parseSqlPendingCompletionReplay(value: unknown): SqlPendingCompletionReplay {
  if (!isRecord(value) || typeof value.expiresAt !== "string") throw authFailed();
  const encrypted = value.encryptedCredentials;
  if (
    !isRecord(encrypted) ||
    encrypted.version !== 1 ||
    encrypted.algorithm !== "aes-256-gcm" ||
    typeof encrypted.nonce !== "string" ||
    typeof encrypted.ciphertext !== "string" ||
    typeof encrypted.authTag !== "string" ||
    typeof encrypted.valueBytes !== "number" ||
    !Number.isSafeInteger(encrypted.valueBytes) ||
    encrypted.valueBytes < 0 ||
    encrypted.valueBytes > SQL_PENDING_COMPLETION_REPLAY_MAX_BYTES ||
    typeof encrypted.createdAt !== "string" ||
    typeof encrypted.updatedAt !== "string"
  ) {
    throw authFailed();
  }
  return { expiresAt: value.expiresAt, encryptedCredentials: encrypted as VaultEncryptedRecord };
}

function sqlPendingReplayEncryptionKey(pendingCompletionSecret: string): Buffer {
  return createHash("sha256")
    .update(`caplets-pending-login-replay:${pendingCompletionSecret}`)
    .digest();
}

function sqlPendingLoginStatus(
  row: PendingApprovalRow,
  metadata: SqlPendingLoginMetadata,
  now: string,
): RemotePendingLoginStatus {
  const status =
    (row.state === "pending" || row.state === "approved") && isExpired(row.expiresAt, now)
      ? "expired"
      : sqlPendingState(row.state);
  const transitionAt = row.consumedAt ?? row.updatedAt;
  return {
    flowId: row.approvalId,
    hostUrl: row.hostUrl ?? "",
    ...(metadata.hostIdentity ? { hostIdentity: metadata.hostIdentity } : {}),
    status,
    requestedRole: row.requestedRole ?? "access",
    ...(row.grantedRole ? { grantedRole: row.grantedRole } : {}),
    operatorCodeFingerprint: metadata.operatorCodeHash.slice(0, 8),
    clientLabel: row.clientLabel ?? "Caplets Remote Client",
    ...(metadata.clientFingerprint ? { clientFingerprint: metadata.clientFingerprint } : {}),
    ...(metadata.sourceHint ? { sourceHint: metadata.sourceHint } : {}),
    createdAt: row.createdAt,
    codeExpiresAt: metadata.codeExpiresAt,
    flowExpiresAt: row.expiresAt,
    ...(status === "approved" ? { approvedAt: row.updatedAt } : {}),
    ...(status === "denied" ? { deniedAt: transitionAt } : {}),
    ...(status === "cancelled" ? { cancelledAt: transitionAt } : {}),
    ...(status === "exchanged" ? { exchangedAt: transitionAt } : {}),
  };
}

function approvedSqlPendingLogin(status: RemotePendingLoginStatus): ApprovedPendingLogin {
  if (status.status !== "approved" || !status.grantedRole) throw authFailed();
  return {
    flowId: status.flowId,
    status: "approved",
    clientLabel: status.clientLabel,
    requestedRole: status.requestedRole,
    grantedRole: status.grantedRole,
    ...(status.clientFingerprint ? { clientFingerprint: status.clientFingerprint } : {}),
    ...(status.sourceHint ? { sourceHint: status.sourceHint } : {}),
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sqlPendingState(state: string): RemotePendingLoginStatus["status"] {
  if (
    state === "pending" ||
    state === "approved" ||
    state === "denied" ||
    state === "cancelled" ||
    state === "expired" ||
    state === "exchanged"
  ) {
    return state;
  }
  throw authFailed();
}

function sqlPendingLoginSetLock(identity: ControlPlaneStoreIdentity): string {
  return `pending-logins:${identity.logicalHostId}:${identity.storeId}`;
}

function sqlPendingLoginLock(flowId: string): string {
  return `pending-login:${flowId}`;
}

function hashPendingSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

function pendingSecretMatches(secret: string, expected: string): boolean {
  return safeEqual(Buffer.from(hashPendingSecret(secret)), Buffer.from(expected));
}

function pendingCodeFingerprint(code: string): string {
  return hashPendingSecret(code).slice(0, 8);
}

function boundedPendingValue(value: string | undefined, maxLength: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function requiredMetadataString(value: Readonly<Record<string, unknown>>, key: string): string {
  const item = value[key];
  if (typeof item !== "string") throw authFailed();
  return item;
}

function requiredMetadataNumber(value: Readonly<Record<string, unknown>>, key: string): number {
  const item = value[key];
  if (typeof item !== "number" || !Number.isSafeInteger(item) || item < 0) throw authFailed();
  return item;
}

function unavailableSecurityMutation(): CapletsError {
  return new CapletsError(
    "SERVER_UNAVAILABLE",
    "Control-plane live authority changed before the security mutation committed.",
  );
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
  purpose: string;
  algorithm: string;
  verifierVersion: number;
  keyVersion: number;
  requestedRole: RemoteClientRole | null;
  grantedRole: RemoteClientRole | null;
  hostUrl: string | null;
  clientLabel: string | null;
  state: RemotePendingApprovalResult["state"] | RemotePendingLoginStatus["status"];
  expiresAt: string;
  consumedAt: string | null;
  createdAt: string;
  updatedAt: string;
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
type SetupExecutionRow = ControlPlaneDatabaseRow & {
  executionId: string;
  projectFingerprint: string;
  capletId: string;
  contentHash: string;
  setupHash: string | null;
  targetKind: SetupAttempt["targetKind"];
  leaseId: string;
  reservedAt: string;
  expiresAt: string;
  state: string;
};
type SetupApprovalRow = ControlPlaneDatabaseRow & {
  approvalId: string;
  projectFingerprint: string;
  capletId: string;
  contentHash: string;
  targetKind: SetupApproval["targetKind"];
  actor: SetupApproval["actor"];
  approvedAt: string;
};
type SetupAttemptRow = ControlPlaneDatabaseRow & {
  id: string;
  createdAt: string;
  attemptId: string;
  projectFingerprint: string;
  capletId: string;
  contentHash: string;
  setupHash: string | null;
  targetKind: SetupAttempt["targetKind"];
  status: SetupAttempt["status"];
  detail: string;
  finishedAt: string;
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
  state: string;
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
function setupRecordId(prefix: string, parts: readonly string[]): string {
  const digest = createHash("sha256").update(encodeCanonicalJson(parts), "utf8").digest("hex");
  return `${prefix}:${digest}`;
}

async function insertActivityInTransaction(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  input: AppendDashboardActivityInput,
  now: string,
): Promise<DashboardActivityEntry> {
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
}

function setupApprovalFromRow(row: SetupApprovalRow): SetupApproval {
  return {
    projectFingerprint: row.projectFingerprint,
    capletId: row.capletId,
    contentHash: row.contentHash,
    targetKind: row.targetKind,
    actor: row.actor,
    approvedAt: row.approvedAt,
  };
}

async function currentSetupExecutionToken(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  authority: ControlPlaneSecurityMutationAuthority | undefined,
): Promise<
  Readonly<{
    authorityGeneration: number;
    effectiveGeneration: number;
    securityEpoch: number;
  }>
> {
  await transaction.lock(`effective-generation:${identity.logicalHostId}:${identity.storeId}`);
  await transaction.lock(`authority-generation:${identity.logicalHostId}:${identity.storeId}`);
  await transaction.lock(securityEpochLock(identity));
  const [[authorityRow], [effectiveRow], [securityRow]] = await Promise.all([
    transaction.select<ControlPlaneDatabaseRow & { generation: number; bindingState: string }>(
      "authorityVersions",
      scope(identity, { bindingState: "active" }),
      [{ column: "generation", direction: "desc" }],
      1,
    ),
    transaction.select<ControlPlaneDatabaseRow & { generation: number }>(
      "effectiveVersions",
      scope(identity),
      [{ column: "generation", direction: "desc" }],
      1,
    ),
    transaction.select<SecurityVersionRow>(
      "securityVersions",
      scope(identity),
      [{ column: "epoch", direction: "desc" }],
      1,
    ),
  ]);
  if (!authorityRow || !effectiveRow || !securityRow) throw unavailableSecurityMutation();
  const token = {
    authorityGeneration: Number(authorityRow.generation),
    effectiveGeneration: Number(effectiveRow.generation),
    securityEpoch: Number(securityRow.epoch),
  };
  if (
    authority &&
    (token.authorityGeneration !== authority.writerFence.authorityGeneration ||
      token.securityEpoch !== authority.securityEpoch)
  ) {
    throw unavailableSecurityMutation();
  }
  return token;
}

async function requireSetupExecutionLease(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  lease: SetupExecutionLease,
  now: string,
  authority: ControlPlaneSecurityMutationAuthority | undefined,
): Promise<SetupExecutionRow> {
  const [row] = await transaction.select<SetupExecutionRow>(
    "setupExecutions",
    scope(identity, {
      executionId: lease.executionId,
      leaseId: lease.leaseId,
      state: "active",
    }),
    [],
    1,
  );
  const token = await currentSetupExecutionToken(transaction, identity, authority);
  if (
    !row ||
    Date.parse(row.expiresAt) <= Date.parse(now) ||
    row.projectFingerprint !== lease.projectFingerprint ||
    row.capletId !== lease.capletId ||
    row.contentHash !== lease.contentHash ||
    (row.setupHash ?? undefined) !== (lease.setupHash ?? undefined) ||
    row.targetKind !== lease.targetKind ||
    (authority && !lease.snapshotToken) ||
    (lease.snapshotToken &&
      (lease.snapshotToken.authorityGeneration !== token.authorityGeneration ||
        lease.snapshotToken.effectiveGeneration !== token.effectiveGeneration ||
        lease.snapshotToken.securityEpoch !== token.securityEpoch)) ||
    Number(row.authorityVersion) !== token.authorityGeneration ||
    Number(row.effectiveVersion) !== token.effectiveGeneration ||
    Number(row.securityVersion) !== token.securityEpoch
  ) {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "Setup execution reservation is expired, revoked, or stale.",
    );
  }
  return row;
}

function redactSetupAttemptForPersistence(attempt: SetupAttempt): SetupAttempt {
  return {
    ...attempt,
    argv: attempt.argv.map(() => "[REDACTED]"),
    stdout: attempt.stdout.length > 0 ? "[REDACTED]" : "",
    stderr: attempt.stderr.length > 0 ? "[REDACTED]" : "",
    redacted: true,
  };
}

function assertSetupLeaseTtl(ttlMs: number): void {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 24 * 60 * 60_000) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Setup execution lease duration is outside safe bounds.",
    );
  }
}

function setupAttemptFromRow(row: SetupAttemptRow): SetupAttempt {
  const decoded = decodeCanonicalJson(row.detail);
  if (
    !isRecord(decoded) ||
    decoded.attemptId !== row.attemptId ||
    decoded.projectFingerprint !== row.projectFingerprint ||
    decoded.capletId !== row.capletId ||
    decoded.contentHash !== row.contentHash ||
    decoded.targetKind !== row.targetKind ||
    decoded.status !== row.status ||
    decoded.finishedAt !== row.finishedAt ||
    typeof decoded.redacted !== "boolean" ||
    !isRecord(decoded.retention) ||
    !Number.isSafeInteger(decoded.retention.maxAttempts) ||
    !Number.isSafeInteger(decoded.retention.days)
  ) {
    throw new CapletsError("CONFIG_INVALID", "SQL setup attempt state is malformed.");
  }
  assertSetupRetention(decoded.retention.maxAttempts as number, decoded.retention.days as number);
  return decoded as SetupAttempt;
}

function assertSetupRetention(maxAttempts: number, days: number): void {
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 100 ||
    !Number.isSafeInteger(days) ||
    days < 1 ||
    days > 365
  ) {
    throw new CapletsError("REQUEST_INVALID", "Setup attempt retention is outside safe bounds.");
  }
}

async function pruneSetupAttempts(
  transaction: ControlPlaneSqlTransaction,
  identity: ControlPlaneStoreIdentity,
  projectFingerprint: string,
  capletId: string,
  maxAttempts: number,
  days: number,
  now: string,
): Promise<void> {
  assertSetupRetention(maxAttempts, days);
  const rows = await transaction.select<SetupAttemptRow>(
    "setupAttempts",
    scope(identity, { projectFingerprint, capletId }),
    [{ column: "createdAt" }],
  );
  const cutoff = Date.parse(now) - days * 24 * 60 * 60_000;
  const retainedIds = new Set(
    rows
      .filter((row) => Date.parse(row.createdAt) >= cutoff)
      .slice(-maxAttempts)
      .map((row) => row.id),
  );
  for (const row of rows) {
    if (retainedIds.has(row.id)) continue;
    await transaction.delete("setupAttempts", scope(identity, { id: row.id }));
  }
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
  if (
    row.state !== "pending" &&
    row.state !== "approved" &&
    row.state !== "cancelled" &&
    row.state !== "expired" &&
    row.state !== "invalidated"
  ) {
    throw authFailed();
  }
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
