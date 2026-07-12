import { Buffer } from "node:buffer";
import { createAuthorityBackup, decodeAuthorityBackup } from "../src/storage/backup";
import { AuthorityOAuthTokenStore, type StoredOAuthTokenBundle } from "../src/auth/store";
import { AuthorityRemoteServerCredentialStore } from "../src/remote/server-credential-store";
import { LocalSetupStore, type SetupApprovalAuthority } from "../src/setup/local-store";
import { AuthorityVaultStore } from "../src/vault/index";
import type {
  AuthorityGenerationIdentity,
  SemanticCommandEnvelope,
  WritableAuthority,
} from "../src/storage/types";

export type ProviderContractInput = {
  authority: WritableAuthority<unknown, unknown>;
  authorityId: string;
  namespace: string;
  provider: string;
  authorityProvider?: string | undefined;
  makeReplica?: (() => Promise<WritableAuthority<unknown, unknown>>) | undefined;
  makeRestoreTarget?: (() => Promise<WritableAuthority<unknown, unknown>>) | undefined;
  now?: (() => Date) | undefined;
};

export type ProviderContractResult = {
  provider: string;
  steps: string[];
  generationSequence: number;
  auxiliaryWatermark: string;
};

const VAULT_KEY = Buffer.alloc(32, 17);
const BACKUP_KEY = Buffer.alloc(32, 29);
const HOST_URL = "https://u9.invalid";
const SESSION_ID = "u9-dashboard-session";
const CAPLET_ID = "u9-caplet";
const SERVER_NAME = "u9-oauth-server";

function identity(value: AuthorityGenerationIdentity | null): AuthorityGenerationIdentity | null {
  if (!value) return null;
  return {
    authorityId: value.authorityId,
    id: value.id,
    sequence: value.sequence,
    predecessorId: value.predecessorId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}
function securityEventList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.events)) return value.events;
  return [];
}
function snapshotRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("provider contract: authority snapshot is not an object");
  return value;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`provider contract: ${message}`);
}

async function expectFailure(
  operation: () => Promise<unknown>,
  expectedCode?: string,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (expectedCode && errorCode(error) !== expectedCode) {
      throw new Error(
        `provider contract: expected ${expectedCode}, received ${errorCode(error) ?? "unknown"}`,
      );
    }
    return;
  }
  throw new Error(`provider contract: expected failure${expectedCode ? ` (${expectedCode})` : ""}`);
}

function envelope(
  authorityId: string,
  expectedGeneration: AuthorityGenerationIdentity | null,
  idempotencyKey: string,
  requestDigest: string,
  snapshot: Record<string, unknown>,
): SemanticCommandEnvelope<Record<string, unknown>> {
  return {
    authorityId,
    currentHostId: "u9-host",
    principalId: "u9-principal",
    expectedGeneration,
    idempotencyKey,
    requestDigest,
    command: { kind: "replace_snapshot", snapshot, result: { accepted: true } },
  };
}

function authorityForDomain(
  authority: WritableAuthority<unknown, unknown>,
): WritableAuthority<unknown, never> & { readonly authorityId?: string } {
  return authority as unknown as WritableAuthority<unknown, never> & {
    readonly authorityId?: string;
  };
}

/**
 * Run the provider-neutral U9 contract. The same function is used by the
 * executable matrix runner and Vitest parity tests; provider setup and cleanup
 * remain outside this trace.
 */
export async function runProviderContract(
  input: ProviderContractInput,
): Promise<ProviderContractResult> {
  const steps: string[] = [];
  const clock = input.now ?? (() => new Date());
  const authority = input.authority;
  const initialSnapshot: Record<string, unknown> = {
    caplets: {
      [CAPLET_ID]: {
        id: CAPLET_ID,
        config: { mcpServers: {} },
        provenance: {
          kind: "authority",
          authorityId: input.authorityId,
          recordId: CAPLET_ID,
          generationId: "pending",
        },
      },
    },
    sessions: {
      [SESSION_ID]: { sessionId: SESSION_ID, status: "active" },
    },
    setupApprovals: {},
    setupActivity: [],
  };

  const authorityProvider = input.authorityProvider ?? input.provider;
  const healthy = await authority.health();
  assertCondition(
    healthy.provider === authorityProvider,
    `health selected provider ${healthy.provider}`,
  );
  assertCondition(
    healthy.connectivity === "healthy" && healthy.writable,
    "startup is healthy and writable",
  );
  steps.push("startup-fail-closed");

  await expectFailure(() =>
    authority.commit(
      envelope(
        `${input.authorityId}-wrong`,
        null,
        "u9-wrong-identity",
        "u9-wrong-identity-digest",
        initialSnapshot,
      ),
    ),
  );
  steps.push("wrong-authority-identity");

  const first = await authority.commit(
    envelope(input.authorityId, null, "u9-first", "u9-first-digest", initialSnapshot),
  );
  assertCondition(first.kind === "committed", `initial commit returned ${first.kind}`);
  const firstIdentity = identity(first.generation);
  assertCondition(firstIdentity !== null, "initial generation identity exists");
  const firstGeneration = await authority.readGeneration(first.generation.id);
  assertCondition(
    firstGeneration.provenance.provider === authorityProvider,
    "generation provenance provider",
  );
  assertCondition(
    firstGeneration.provenance.namespace === input.namespace,
    "generation provenance namespace",
  );
  steps.push("conditional-commit-provenance");

  const stale = await authority.commit(
    envelope(input.authorityId, null, "u9-stale", "u9-stale-digest", {
      ...initialSnapshot,
      replacement: "stale-writer",
    }),
  );
  assertCondition(stale.kind === "conflict", `stale commit returned ${stale.kind}`);
  const replay = await authority.commit(
    envelope(input.authorityId, null, "u9-first", "u9-first-digest", initialSnapshot),
  );
  assertCondition(replay.kind === "replayed", `receipt replay returned ${replay.kind}`);
  assertCondition(replay.generation.id === first.generation.id, "receipt replay generation");
  await expectFailure(
    () =>
      authority.commit(
        envelope(input.authorityId, null, "u9-first", "u9-different-digest", initialSnapshot),
      ),
    "REQUEST_INVALID",
  );
  steps.push("conflict-receipt-replay");

  const domain = authorityForDomain(authority);
  const vault = new AuthorityVaultStore({
    authority: domain,
    authorityId: input.authorityId,
    currentHostId: "u9-vault-host",
    principalId: "u9-vault-principal",
    key: VAULT_KEY,
    now: clock,
  });
  const origin = {
    kind: "authority" as const,
    authorityId: input.authorityId,
    recordId: CAPLET_ID,
    generationId: first.generation.id,
  };
  await vault.setWithGrant("API_KEY", "u9-plaintext-secret", {
    grant: {
      storedKey: "API_KEY",
      referenceName: "API_KEY",
      capletId: CAPLET_ID,
      origin,
    },
    idempotencyKey: "u9-vault-set",
  });
  const granted = await vault.resolveGrantedValue({
    referenceName: "API_KEY",
    capletId: CAPLET_ID,
    origin,
  });
  assertCondition(
    "value" in granted && granted.value === "u9-plaintext-secret",
    "Vault grant decrypts at boundary",
  );
  const vaultExport = await authority.exportState();
  const vaultText = JSON.stringify(vaultExport.generation.snapshot);
  assertCondition(
    !vaultText.includes("u9-plaintext-secret"),
    "Vault plaintext is absent from authority snapshot",
  );
  const wrongVault = new AuthorityVaultStore({
    authority: domain,
    authorityId: input.authorityId,
    key: Buffer.alloc(32, 9),
  });
  await expectFailure(() => wrongVault.getStatus("API_KEY"), "CONFIG_INVALID");
  steps.push("encrypted-vault-wrong-key");

  const oauth = new AuthorityOAuthTokenStore({
    authority: domain,
    authorityId: input.authorityId,
    currentHostId: "u9-oauth-host",
    principalId: "u9-oauth-principal",
    key: VAULT_KEY,
    now: clock,
  });
  const token: StoredOAuthTokenBundle = {
    server: SERVER_NAME,
    authType: "oauth2",
    accessToken: "u9-access-token",
    refreshToken: "u9-refresh-token",
    tokenType: "Bearer",
    scope: "read",
  };
  await oauth.write(token);
  assertCondition(
    (await oauth.read(SERVER_NAME))?.accessToken === token.accessToken,
    "OAuth token decrypts at boundary",
  );
  const oauthExport = await authority.exportState();
  const oauthText = JSON.stringify(oauthExport.generation.snapshot);
  assertCondition(
    !oauthText.includes("u9-access-token") && !oauthText.includes("u9-refresh-token"),
    "OAuth plaintext is absent from authority snapshot",
  );
  const wrongOAuth = new AuthorityOAuthTokenStore({
    authority: domain,
    authorityId: input.authorityId,
    key: Buffer.alloc(32, 8),
  });
  await expectFailure(() => wrongOAuth.read(SERVER_NAME), "CONFIG_INVALID");
  steps.push("encrypted-oauth-wrong-key");

  const setupAuthority = authority as unknown as SetupApprovalAuthority;
  const setup = new LocalSetupStore({
    authority: setupAuthority,
    authorityId: input.authorityId,
    currentHostId: "u9-setup-host",
    principalId: "u9-setup-principal",
  });
  const setupInput = {
    projectFingerprint: "u9-project",
    capletId: CAPLET_ID,
    contentHash: "u9-content-hash",
    targetKind: "local_host" as const,
    actor: "automation" as const,
    approvedAt: clock().toISOString(),
  };
  const approval = await setup.approve(setupInput);
  assertCondition(approval.decision === "grant", "setup approval grants");
  const persistedApproval = await setup.getApproval(
    "u9-project",
    CAPLET_ID,
    "u9-content-hash",
    "local_host",
  );
  assertCondition(persistedApproval?.decision === "grant", "setup approval persists");
  const revoked = await setup.revoke(setupInput);
  assertCondition(revoked.decision === "revoke", "setup approval revokes");
  steps.push("setup-approval-revocation");

  const remote = new AuthorityRemoteServerCredentialStore({
    authority: authority as WritableAuthority<unknown, unknown>,
    authorityId: input.authorityId,
    currentHostId: "u9-remote-host",
    principalId: "u9-remote-principal",
    encryptionKey: VAULT_KEY,
  });
  const pending = await remote.createPendingLogin({
    hostUrl: HOST_URL,
    requestedRole: "operator",
    clientLabel: "u9-replica",
    clientFingerprint: "u9-fingerprint",
    sourceHint: "u9-source",
    idempotencyKey: "u9-pending-create",
  });
  const pendingRefresh = await remote.refreshPendingLogin({
    flowId: pending.flowId,
    pendingCompletionSecret: pending.pendingCompletionSecret,
    pendingRefreshSecret: pending.pendingRefreshSecret,
    idempotencyKey: "u9-pending-refresh",
  });
  const pendingRefreshReplay = await remote.refreshPendingLogin({
    flowId: pending.flowId,
    pendingCompletionSecret: pending.pendingCompletionSecret,
    pendingRefreshSecret: pending.pendingRefreshSecret,
    idempotencyKey: "u9-pending-refresh-retry",
  });
  assertCondition(
    pendingRefreshReplay.operatorCode === pendingRefresh.operatorCode,
    "lost refresh hint replays response",
  );
  const approved = await remote.approvePendingLogin({
    operatorCode: pendingRefresh.operatorCode,
    grantedRole: "operator",
  });
  assertCondition(approved.status === "approved", "remote setup approval");
  const credentials = await remote.completePendingLogin({
    flowId: pending.flowId,
    pendingCompletionSecret: pending.pendingCompletionSecret,
    hostUrl: HOST_URL,
    requiredRole: "operator",
  });
  await remote.validateAccessToken({ hostUrl: HOST_URL, accessToken: credentials.accessToken });
  const revokedClient = await remote.revokeClient(credentials.clientId);
  assertCondition(revokedClient, "remote client revokes");
  await expectFailure(() =>
    remote.validateAccessToken({ hostUrl: HOST_URL, accessToken: credentials.accessToken }),
  );
  await expectFailure(
    () =>
      remote.refreshClientCredentials({
        hostUrl: HOST_URL,
        refreshToken: credentials.refreshToken,
      }),
    "REMOTE_CREDENTIALS_REVOKED",
  );
  const postDomainSnapshot = snapshotRecord((await authority.exportState()).generation.snapshot);
  assertCondition(
    !Object.hasOwn(postDomainSnapshot, "snapshot"),
    "domain commits do not retain nested command snapshots",
  );
  steps.push("session-approval-revoke-non-resurrection-lost-hint");

  const headAfterDomain = await authority.readHead();
  assertCondition(headAfterDomain !== null, "head after domain commits");
  const touch = await authority.commitAuxiliary({
    kind: "session_touch",
    sessionId: SESSION_ID,
    lastUsedAt: clock().toISOString(),
    expectedRevision: "",
    expectedGeneration: identity(headAfterDomain),
  });
  assertCondition(touch.kind === "applied", `session touch returned ${touch.kind}`);
  const session = await authority.readAuxiliary({ kind: "session_touch", sessionId: SESSION_ID });
  assertCondition(Boolean(session) && typeof session === "object", "session touch persists");
  const event = await authority.commitAuxiliary({
    kind: "security_event",
    event: { kind: "rejected", occurredAt: clock().toISOString(), code: "U9_DENIED" },
  });
  assertCondition(event.kind === "applied", `security event returned ${event.kind}`);
  const events = await authority.readAuxiliary({ kind: "security_events", limit: 20 });
  const securityEvents = securityEventList(events);
  assertCondition(
    securityEvents.some(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        "code" in value &&
        value.code === "U9_DENIED",
    ),
    `security event persists (${input.provider}): ${JSON.stringify(events)}`,
  );
  steps.push("auxiliary-session-security-events");

  const exported = await authority.exportState();
  const exportedSnapshot = snapshotRecord(exported.generation.snapshot);
  assertCondition(
    Array.isArray(exported.receipts),
    `export preserves semantic receipts (${input.provider})`,
  );
  assertCondition(
    exported.receipts.some((receipt) => receipt.idempotencyKey === "u9-first"),
    "export preserves the initial receipt",
  );
  const exportedAuxiliary = exported.auxiliary;
  assertCondition(
    Boolean(exportedAuxiliary?.sessions?.[SESSION_ID]),
    "export preserves auxiliary session state",
  );
  assertCondition(
    exportedAuxiliary?.securityEvents?.some((entry) => entry.code === "U9_DENIED") === true,
    "export preserves security events",
  );
  const exportedReceiptKeys = exported.receipts.map((receipt) => receipt.idempotencyKey).sort();
  const exportedSecurityEventCount = exportedAuxiliary?.securityEvents?.length ?? 0;
  const backup = await createAuthorityBackup(authority, { key: BACKUP_KEY });
  const decoded = await decodeAuthorityBackup(backup, BACKUP_KEY);
  assertCondition(decoded.header.provider === authorityProvider, "backup provider header");
  assertCondition(
    decoded.state.generation.digest === exported.generation.digest,
    "backup generation digest",
  );
  assertCondition(
    decoded.state.receipts?.length === exported.receipts.length,
    "backup preserves receipts",
  );
  assertCondition(
    decoded.state.auxiliary?.securityEvents?.length === exportedSecurityEventCount,
    "backup preserves security-event watermark",
  );
  await expectFailure(() => decodeAuthorityBackup(backup, Buffer.alloc(32, 7)), "AUTH_FAILED");
  const restoreTarget = input.makeRestoreTarget ? await input.makeRestoreTarget() : authority;
  try {
    const restore = await restoreTarget.restoreState(decoded.state);
    assertCondition(restore.generation.id === exported.generation.id, "restore generation");
    const restoredExport = await restoreTarget.exportState();
    assertCondition(
      restoredExport.receipts
        ?.map((receipt) => receipt.idempotencyKey)
        .sort()
        .join(",") === exportedReceiptKeys.join(","),
      "restore preserves receipts",
    );
    assertCondition(
      restoredExport.auxiliary?.securityEvents?.length === exportedSecurityEventCount,
      "restore preserves security events",
    );
    assertCondition(
      Boolean(restoredExport.auxiliary?.sessions?.[SESSION_ID]),
      "restore preserves session state",
    );
  } finally {
    if (restoreTarget !== authority) await restoreTarget.close();
  }
  steps.push("migration-backup-restore-wrong-key");

  if (input.makeReplica) {
    const replica = await input.makeReplica();
    try {
      const replicaHead = await replica.readHead();
      assertCondition(
        replicaHead?.id === exported.generation.id,
        "replacement replica reads active generation",
      );
      const replicaGeneration = await replica.readGeneration(replicaHead.id);
      assertCondition(
        JSON.stringify(replicaGeneration.snapshot) === JSON.stringify(exported.generation.snapshot),
        "replacement replica snapshot parity",
      );
      const fence = replica.maintenanceFence?.();
      if (fence && authority.maintenanceFence) {
        const sourceFence = authority.maintenanceFence();
        const context = {
          operation: "migration" as const,
          role: "source" as const,
          authorityId: input.authorityId,
          namespace: input.namespace,
          owner: "u9-fence-owner",
        };
        const lease = await sourceFence.acquire(context);
        if (lease) {
          await expectFailure(
            () =>
              replica.commit(
                envelope(
                  input.authorityId,
                  identity(replicaHead),
                  "u9-fenced-write",
                  "u9-fenced-write",
                  {
                    ...exportedSnapshot,
                    fenced: true,
                  },
                ),
              ),
            "SERVER_UNAVAILABLE",
          );
          await sourceFence.release?.(lease, context);
        }
      }
      steps.push("maintenance-fence-replacement");
    } finally {
      await replica.close();
    }
  }

  const finalHead = await authority.readHead();
  assertCondition(finalHead !== null, "final head exists");
  const finalExport = await authority.exportState();
  return {
    provider: input.provider,
    steps,
    generationSequence: finalHead.sequence,
    auxiliaryWatermark: finalExport.auxiliaryWatermark,
  };
}

export const providerContractConstants = {
  vaultKey: VAULT_KEY,
  backupKey: BACKUP_KEY,
  hostUrl: HOST_URL,
  sessionId: SESSION_ID,
  capletId: CAPLET_ID,
};
