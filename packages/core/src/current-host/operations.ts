import { createHash, randomUUID } from "node:crypto";
import type { CatalogCompactEntry, CatalogEntry } from "../catalog";
import {
  DashboardActivityLog,
  createDashboardActivityEntry,
  type DashboardActivityAction,
  type DashboardActivityEntry,
} from "../dashboard/activity-log";
import { stableJsonStringify } from "../stable-json";
import type { CapletsEngine } from "../engine";
import { CapletsError, toSafeError, type SafeErrorSummary } from "../errors";
import type {
  AuthorityCommitResult,
  AuthorityGeneration,
  AuthorityGenerationIdentity,
  AuthorityReceipt,
  SemanticCommandEnvelope,
} from "../storage/types";
import type { AuthorityCapletRecord } from "../storage/bundle-cache";
import type { RuntimeEpochLease } from "../storage/coordinator";
import type {
  RemoteServerCredentialStore,
  AuthorityRemoteServerCredentialStore,
} from "../remote/server-credential-store";
import type {
  RemoteClientRole,
  RemoteClientStatus,
  RemotePendingLoginStatus,
} from "../remote/server-credentials";
import type { VaultAdministrationStore, VaultDeleteStatus, VaultValueStatus } from "../vault";
import {
  type CurrentHostCatalogInstallResult as CatalogInstallResult,
  type CurrentHostInstalledCapletProjection as InstalledCapletProjection,
  type CurrentHostInstalledCatalogCaplet as InstalledCatalogCaplet,
  type CurrentHostSetupAction as SetupAction,
} from "./catalog";
import {
  createCurrentHostCapletOperations,
  type CurrentHostCapletOperations,
} from "./caplet-operations";
import {
  createCurrentHostCatalogOperations,
  type CurrentHostCatalogOperations,
} from "./catalog-operations";
import {
  createCurrentHostClientOperations,
  type CurrentHostClientOperations,
} from "./client-operations";
import {
  createCurrentHostSettingsOperations,
  type CurrentHostSettingsOperations,
  type CurrentHostSettingsPatch,
} from "./settings-operations";
import {
  createCurrentHostVaultOperations,
  type CurrentHostVaultOperations,
} from "./vault-operations";

type CurrentHostReplayedCommit = {
  kind: "replayed";
  generation: AuthorityGenerationIdentity;
  receipt: AuthorityReceipt<unknown>;
};
const TRUSTED_DEVELOPMENT_PRINCIPAL = Symbol("trusted-development-principal");

export type CurrentHostPrincipal = {
  clientId: string;
  clientLabel?: string | undefined;
  hostUrl: string;
  /** Stable server identity, when supplied by remote credentials. */
  hostIdentity?: string | undefined;
  role: RemoteClientRole;
};

export type CurrentHostOperatorPrincipal = CurrentHostPrincipal & {
  role: "operator";
  [TRUSTED_DEVELOPMENT_PRINCIPAL]?: true;
};

export type CurrentHostMutationFields = {
  /** Expected Authority Generation for compare-and-swap. */
  expectedGeneration?: AuthorityGenerationIdentity | null | undefined;
  /** Stable caller intent. Reusing it with a different payload is rejected. */
  idempotencyKey?: string | undefined;
};

export type CurrentHostActivation = {
  status: "active" | "pending" | "degraded";
  activeGeneration: AuthorityGenerationIdentity | null;
  observedGeneration: AuthorityGenerationIdentity | null;
  exposureGeneration: number | null;
  lag: number | null;
};

export type CurrentHostMutationReceipt = {
  status: CurrentHostActivation["status"];
  generation: AuthorityGenerationIdentity;
  committedGeneration: AuthorityGenerationIdentity;
  activation: CurrentHostActivation["status"];
  idempotencyKey: string;
  replayed?: boolean | undefined;
  operation: string;
};

export function trustedDevelopmentOperatorPrincipal(hostUrl: string): CurrentHostOperatorPrincipal {
  if (!isHttpUrl(hostUrl)) {
    throw new CapletsError("AUTH_FAILED", "Current Host administration requires a valid host URL.");
  }
  return {
    clientId: "development_unauthenticated",
    hostUrl,
    role: "operator",
    [TRUSTED_DEVELOPMENT_PRINCIPAL]: true,
  };
}

export function toCurrentHostSafeError(error: unknown): SafeErrorSummary {
  const safe =
    error instanceof CapletsError
      ? toSafeError(error, error.code)
      : toSafeError(
          new CapletsError("INTERNAL_ERROR", "Current Host administration failed."),
          "INTERNAL_ERROR",
        );
  return {
    ...safe,
    message: redactCurrentHostErrorMessage(safe.message),
  };
}

function redactCurrentHostErrorMessage(message: string): string {
  return message
    .replace(/\b(?:https?|file):\/\/[^\s,;)"']+/giu, "[REDACTED]")
    .replace(
      /(["'])(authorization|(?:access[_-]?)?token|refresh(?:[_-]?token)?|password|client[_-]?secret|clientsecret|api[-_]?key|apikey|secret|credential|code)\1\s*:\s*(["'])(?:\\.|[^\\])*?\3/giu,
      "$1$2$1:$3[REDACTED]$3",
    )
    .replace(/\b(authorization\s*:\s*(?:basic|bearer)\s+)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(
      /\b((?:access[_-]?)?token|refresh(?:[_-]?token)?|password|client[_-]?secret|clientsecret|api[-_]?key|apikey|secret|credential|code)(\s*[=:]\s*)[^\s,;]+/giu,
      "$1$2[REDACTED]",
    )
    .replace(/(^|[\s("'])\/[^\s,;:)"]+/gu, "$1[REDACTED]")
    .replace(/\b[A-Za-z]:\\[^\s,;")]+/gu, "[REDACTED]");
}

export type CurrentHostControlContext = {
  configPath?: string | undefined;
  projectConfigPath?: string | undefined;
  authDir?: string | undefined;
  globalCapletsRoot?: string | undefined;
  globalLockfilePath?: string | undefined;
  /** Server-derived identity; never accepted from a client request. */
  currentHostId?: string | undefined;
  authorityId?: string | undefined;
  /** Immutable staged IDs and their safe provenance for reservation checks. */
  stagedProvenance?: Record<string, { kind: string; path?: string | undefined }> | undefined;
};

export type CurrentHostSetupMutation = {
  capletId: string;
  contentHash: string;
  targetKind: "local_host" | "remote_host" | "hosted_sandbox";
  projectFingerprint?: string | undefined;
  actor?: "cli-interactive" | "cli-yes" | "ui" | "automation" | undefined;
};

export type CurrentHostOperation =
  | {
      kind: "summary";
      baseUrl: string;
      dashboardUrl: string;
      dashboardPath: string;
    }
  | { kind: "caplets_list" }
  | ({ kind: "caplet_create"; record: AuthorityCapletRecord } & CurrentHostMutationFields)
  | ({
      kind: "caplet_update";
      id: string;
      record: AuthorityCapletRecord;
    } & CurrentHostMutationFields)
  | ({ kind: "caplet_delete"; id: string } & CurrentHostMutationFields)
  | { kind: "settings_get" }
  | ({ kind: "settings_update"; settings: CurrentHostSettingsPatch } & CurrentHostMutationFields)
  | ({
      kind: "setup_grant" | "setup_revoke";
    } & CurrentHostSetupMutation &
      CurrentHostMutationFields)
  | {
      kind: "catalog_search";
      source: string;
      query?: string | undefined;
      limit?: number | undefined;
    }
  | { kind: "catalog_index"; source: string }
  | { kind: "catalog_detail"; source: string; entryKey: string }
  | { kind: "catalog_updates" }
  | ({
      kind: "catalog_install";
      /** A dashboard catalog source. When present, it also determines setup actions. */
      source?: string | undefined;
      /** Stable catalog identity. Requires source and is independently re-resolved before install. */
      entryKey?: string | undefined;
      /** A bearer-compatible repository source. Omit to restore the server lockfile. */
      repo?: string | undefined;
      capletIds?: string[] | undefined;
      force?: boolean | undefined;
      disableCatalogIndexing?: boolean | undefined;
    } & CurrentHostMutationFields)
  | ({
      kind: "catalog_update";
      capletIds?: string[] | undefined;
      force?: boolean | undefined;
      allowRiskIncrease?: boolean | undefined;
      disableCatalogIndexing?: boolean | undefined;
    } & CurrentHostMutationFields)
  | { kind: "clients_list" }
  | { kind: "pending_logins_list" }
  | ({
      kind: "pending_login_approve";
      flowId: string;
      grantedRole?: RemoteClientRole | undefined;
    } & CurrentHostMutationFields)
  | ({ kind: "pending_login_deny"; flowId: string } & CurrentHostMutationFields)
  | ({ kind: "client_revoke"; clientId: string } & CurrentHostMutationFields)
  | ({
      kind: "client_change_role";
      clientId: string;
      role: RemoteClientRole;
    } & CurrentHostMutationFields)
  | {
      kind: "activity_list";
      limit?: number | undefined;
      after?: string | undefined;
      action?: DashboardActivityAction | undefined;
    }
  | ({
      kind: "vault_set";
      name: string;
      value: string;
      grant?: string | undefined;
      referenceName?: string | undefined;
      force?: boolean | undefined;
    } & CurrentHostMutationFields)
  | { kind: "vault_list" }
  | { kind: "vault_get"; name: string }
  | ({ kind: "vault_delete"; name: string } & CurrentHostMutationFields)
  | ({
      kind: "vault_access_grant";
      storedKey: string;
      referenceName: string;
      capletId: string;
    } & CurrentHostMutationFields)
  | ({
      kind: "vault_access_revoke";
      storedKey: string;
      referenceName?: string | undefined;
      capletId?: string | undefined;
    } & CurrentHostMutationFields)
  | {
      kind: "vault_access_list";
      storedKey?: string | undefined;
      capletId?: string | undefined;
    }
  | {
      kind: "runtime";
      baseUrl: string;
      bind: string;
      publicOrigin?: string | null | undefined;
    }
  | { kind: "runtime_restart" }
  | { kind: "logs"; limit?: number | undefined }
  | { kind: "diagnostics" }
  | { kind: "runtime_event" }
  | { kind: "project_binding" };

export type CurrentHostVaultAccessGrant = {
  storedKey: string;
  referenceName: string;
  capletId: string;
  origin: { kind: string };
  createdAt: string;
  updatedAt: string;
};

export type CurrentHostSetupAction = SetupAction;
export type CurrentHostInstalledCaplet = InstalledCapletProjection;
export type CurrentHostInstalledCatalogCaplet = InstalledCatalogCaplet;
export type CurrentHostCatalogInstallResult = CatalogInstallResult;
export type CurrentHostAuthorityHealth = {
  writable: boolean;
  action?: "write" | "read-only" | "unavailable";
  connectivity?: string | undefined;
  authorityId?: string | undefined;
  activeGeneration?: AuthorityGenerationIdentity | null | undefined;
  observedGeneration?: AuthorityGenerationIdentity | null | undefined;
  exposureGeneration?: number | null | undefined;
  lag?: number | null | undefined;
  refresh?: string | undefined;
  lastSafeError?: SafeErrorSummary | undefined;
};

export type CurrentHostSummarySections = {
  caplets: { count: number; href: string };
  catalog: { href: string };
  access: { clients: number; pending: number; href: string };
  vault: { count: number; href: string };
  projectBinding: { state: "disconnected"; href: string };
  runtime: { status: "ok"; href: string };
  logs: { href: string };
  diagnostics: { href: string };
  activity: { href: string };
  settings: { href: string };
};

export type CurrentHostSummary = {
  host: {
    current: true;
    baseUrl: string;
    dashboardUrl: string;
    version: string;
    roleModel: "current-host";
  };
  attention: Array<{
    kind: "pending-login";
    severity: "warning";
    label: string;
    href: string;
  }>;
  sections: CurrentHostSummarySections;
};

export type CurrentHostActivityPage = {
  entries: DashboardActivityEntry[];
  nextCursor?: string | undefined;
};

export type CurrentHostOperationOutcome =
  | ({
      kind: "caplet_create" | "caplet_update" | "caplet_delete";
      caplet?: CurrentHostInstalledCaplet | undefined;
      deleted?: boolean | undefined;
    } & CurrentHostMutationReceipt)
  | { kind: "settings_get"; settings: CurrentHostSettingsPatch }
  | ({ kind: "settings_update"; settings: CurrentHostSettingsPatch } & CurrentHostMutationReceipt)
  | ({
      kind: "setup_grant" | "setup_revoke";
      approval: {
        projectFingerprint: string;
        capletId: string;
        contentHash: string;
        targetKind: "local_host" | "remote_host" | "hosted_sandbox";
        decision: "grant" | "revoke";
        approvedAt: string;
      };
    } & CurrentHostMutationReceipt)
  | { kind: "summary"; summary: CurrentHostSummary }
  | { kind: "caplets_list"; caplets: CurrentHostInstalledCaplet[] }
  | { kind: "catalog_search"; entries: CatalogEntry[] }
  | { kind: "catalog_index"; entries: CatalogCompactEntry[] }
  | {
      kind: "catalog_detail";
      entry: CatalogEntry;
      setupActions: CurrentHostSetupAction[];
      projectScopedInstallAvailable: false;
    }
  | { kind: "catalog_updates"; updates: Array<{ id: string; status: "locked"; risk: unknown }> }
  | ({
      kind: "catalog_install";
      installed: CurrentHostInstalledCatalogCaplet[];
      setupActions: CurrentHostSetupAction[];
    } & Partial<CurrentHostMutationReceipt>)
  | ({
      kind: "catalog_update";
      installed: CurrentHostInstalledCatalogCaplet[];
      setupActions: CurrentHostSetupAction[];
    } & Partial<CurrentHostMutationReceipt>)
  | { kind: "clients_list"; clients: RemoteClientStatus[] }
  | { kind: "pending_logins_list"; pendingLogins: RemotePendingLoginStatus[] }
  | {
      kind: "pending_login_approve";
      pendingLogin: RemotePendingLoginStatus;
    }
  | {
      kind: "pending_login_approve";
      status: "credential_store_unavailable";
    }
  | {
      kind: "pending_login_deny";
      pendingLogin: RemotePendingLoginStatus;
    }
  | {
      kind: "pending_login_deny";
      status: "credential_store_unavailable";
    }
  | { kind: "client_revoke"; revoked: boolean; clientId: string; sessionEnded: boolean }
  | { kind: "client_revoke"; status: "credential_store_unavailable"; clientId: string }
  | {
      kind: "client_change_role";
      status: "not_found";
      clientId: string;
      sessionEnded: false;
    }
  | {
      kind: "client_change_role";
      status: "changed";
      client: RemoteClientStatus;
      sessionEnded: boolean;
    }
  | { kind: "client_change_role"; status: "credential_store_unavailable"; clientId: string }
  | { kind: "activity_list"; activity: CurrentHostActivityPage }
  | { kind: "vault_set"; status: VaultValueStatus }
  | {
      kind: "vault_list";
      values: VaultValueStatus[];
      grants: CurrentHostVaultAccessGrant[];
    }
  | { kind: "vault_get"; status: VaultValueStatus }
  | { kind: "vault_delete"; deleted: VaultDeleteStatus }
  | { kind: "vault_access_grant"; grant: CurrentHostVaultAccessGrant }
  | { kind: "vault_access_revoke"; revoked: CurrentHostVaultAccessGrant[] }
  | { kind: "vault_access_list"; grants: CurrentHostVaultAccessGrant[] }
  | {
      kind: "runtime";
      runtime: {
        status: "ok";
        version: string;
        bind: string;
        baseUrl: string;
        publicOrigin: string | null;
      };
      daemon: { restartAvailable: false; stopAvailable: false; uninstallAvailable: false };
    }
  | { kind: "runtime_restart"; restartAvailable: false; reason: "daemon_manager_unavailable" }
  | { kind: "logs"; entries: []; limit: number; truncated: false }
  | {
      kind: "diagnostics";
      status: "ok" | "degraded" | "unavailable";
      diagnostics: [];
      checks: Array<{ id: "runtime" | "dashboard"; status: "ok" | "degraded" | "unavailable" }>;
      health?: CurrentHostAuthorityHealth | undefined;
    }
  | {
      kind: "runtime_event";
      event: {
        type: "runtime_health";
        runtime: { status: "ok" | "degraded" | "unavailable"; version: string };
        projectBinding: { state: "disconnected" };
        health?: CurrentHostAuthorityHealth | undefined;
      };
    }
  | {
      kind: "project_binding";
      projectBinding: {
        state: "disconnected";
        affectedCaplets: [];
        actions: Array<{ id: string; label: string; enabled: false; reason: string }>;
      };
    };

/** The outcome family determined by a semantic Current Host operation's discriminant. */
export type CurrentHostOperationOutcomeFor<TOperation extends CurrentHostOperation> = Extract<
  CurrentHostOperationOutcome,
  { kind: TOperation["kind"] }
>;

/**
 * The single app-scoped Current Host administration boundary. Adapters authenticate
 * and serialize; this Module owns safe administration policy and outcomes.
 */
export interface CurrentHostOperations {
  execute<const TOperation extends CurrentHostOperation>(
    principal: CurrentHostPrincipal,
    operation: TOperation,
  ): Promise<CurrentHostOperationOutcomeFor<TOperation>>;
}
export type CurrentHostRuntimeRefresh = (
  generation: AuthorityGenerationIdentity,
) => Promise<CurrentHostActivation | boolean>;

export type CurrentHostRuntime = {
  retain(): RuntimeEpochLease;
  refresh(): Promise<boolean>;
  /** Commit one complete semantic snapshot through the active authority. */
  commit?<TResult = unknown>(
    envelope: SemanticCommandEnvelope<unknown>,
  ): Promise<AuthorityCommitResult<TResult>>;
  /** Wait briefly for a committed generation to become active. */
  refreshAtLeast?: CurrentHostRuntimeRefresh | undefined;
  health?: (() => Promise<CurrentHostAuthorityHealth>) | undefined;
  currentHostId?: string | undefined;
  authorityId?: string | undefined;
};

export type CurrentHostOperationsDependencies = {
  engine: Pick<CapletsEngine, "enabledServers">;
  runtime?: CurrentHostRuntime | undefined;
  control?: CurrentHostControlContext | undefined;
  /** Async-safe Vault metadata/mutation facade; raw resolution is not accepted. */
  vaultStore?: VaultAdministrationStore | undefined;
  activityLog: DashboardActivityLog;
  remoteCredentialStore?:
    | RemoteServerCredentialStore
    | AuthorityRemoteServerCredentialStore
    | undefined;
  /** The immutable epoch used for all reads and the next CAS. */
  activeGeneration?: AuthorityGeneration<unknown> | null | undefined;
  stagedProvenance?: Record<string, { kind: string; path?: string | undefined }> | undefined;
  version: string;
};

export function createCurrentHostOperations(
  dependencies: CurrentHostOperationsDependencies,
): CurrentHostOperations {
  return {
    async execute<const TOperation extends CurrentHostOperation>(
      principal: CurrentHostPrincipal,
      operation: TOperation,
    ): Promise<CurrentHostOperationOutcomeFor<TOperation>> {
      assertOperatorPrincipal(principal);
      const lease = dependencies.runtime?.retain();
      const scopedDependencies: CurrentHostOperationsDependencies = lease
        ? {
            ...dependencies,
            engine: lease.view.engine,
            activeGeneration: lease.view.authorityGeneration,
            ...(dependencies.stagedProvenance ? {} : stagedProvenanceFromView(lease.view)),
          }
        : dependencies;
      assertCurrentHostIdentity(scopedDependencies, principal);
      const catalog = createCurrentHostCatalogOperations(scopedDependencies);
      const caplets = createCurrentHostCapletOperations(scopedDependencies);
      const clients = createCurrentHostClientOperations(scopedDependencies);
      const settings = createCurrentHostSettingsOperations(scopedDependencies);
      const vault = createCurrentHostVaultOperations(scopedDependencies);
      try {
        const outcome = await executeCurrentHostOperation(
          scopedDependencies,
          catalog,
          caplets,
          clients,
          settings,
          vault,
          principal,
          operation,
        );
        if (
          dependencies.runtime &&
          isCurrentHostMutation(operation) &&
          !hasMutationReceipt(outcome)
        ) {
          await dependencies.runtime.refresh().catch(() => false);
        }
        return outcome as CurrentHostOperationOutcomeFor<TOperation>;
      } finally {
        lease?.release();
      }
    },
  };
}

async function executeCurrentHostOperation(
  dependencies: CurrentHostOperationsDependencies,
  catalog: CurrentHostCatalogOperations,
  caplets: CurrentHostCapletOperations,
  clients: CurrentHostClientOperations,
  settings: CurrentHostSettingsOperations,
  vault: CurrentHostVaultOperations,
  principal: CurrentHostOperatorPrincipal,
  operation: CurrentHostOperation,
): Promise<CurrentHostOperationOutcome> {
  switch (operation.kind) {
    case "summary":
      return await clients.summary(await vault.valueCount(), operation);
    case "caplets_list":
      return caplets.list(operation);
    case "caplet_create":
      return await caplets.create(principal, operation);
    case "caplet_update":
      return await caplets.update(principal, operation);
    case "caplet_delete":
      return await caplets.delete(principal, operation);
    case "settings_get":
      return await settings.get(operation);
    case "settings_update":
      return await settings.update(principal, operation);
    case "catalog_search":
      return await catalog.search(operation);
    case "catalog_index":
      return await catalog.index(operation);
    case "catalog_detail":
      return await catalog.detail(operation);
    case "catalog_updates":
      return catalog.updates(operation);
    case "catalog_install":
      return await catalog.install(principal, operation);
    case "catalog_update":
      return await catalog.update(principal, operation);
    case "clients_list":
      return await clients.listClients();
    case "pending_logins_list":
      return await clients.listPendingLogins();
    case "pending_login_approve":
      return await clients.approvePendingLogin(principal, operation);
    case "pending_login_deny":
      return await clients.denyPendingLogin(principal, operation);
    case "client_revoke":
      return await clients.revokeClient(principal, operation);
    case "client_change_role":
      return await clients.changeClientRole(principal, operation);
    case "setup_grant":
      return await settings.setup(principal, operation);
    case "setup_revoke":
      return await settings.setup(principal, operation);
    case "activity_list":
      return await activityListOutcome(dependencies, operation);
    case "vault_set":
      return await vault.set(principal, operation);
    case "vault_list":
      return await vault.list(operation);
    case "vault_get":
      return await vault.get(operation);
    case "vault_delete":
      return await vault.delete(principal, operation);
    case "vault_access_grant":
      return await vault.grant(principal, operation);
    case "vault_access_revoke":
      return await vault.revoke(principal, operation);
    case "vault_access_list":
      return await vault.listAccess(operation);
    case "runtime":
      return {
        kind: "runtime",
        runtime: {
          status: "ok",
          version: dependencies.version,
          bind: operation.bind,
          baseUrl: operation.baseUrl,
          publicOrigin: operation.publicOrigin ?? null,
        },
        daemon: { restartAvailable: false, stopAvailable: false, uninstallAvailable: false },
      };
    case "runtime_restart":
      dependencies.activityLog.append({
        actorClientId: principal.clientId,
        action: "runtime_restart_requested",
        outcome: "failure",
        target: { type: "runtime", id: "current-host" },
        metadata: { reason: "daemon_manager_unavailable" },
      });
      return {
        kind: "runtime_restart",
        restartAvailable: false,
        reason: "daemon_manager_unavailable",
      };
    case "logs":
      return {
        kind: "logs",
        entries: [],
        limit: boundedLimit(operation.limit),
        truncated: false,
      };
    case "diagnostics":
      return diagnosticsOutcome(dependencies);
    case "runtime_event":
      return runtimeEventOutcome(dependencies);
    case "project_binding":
      return {
        kind: "project_binding",
        projectBinding: {
          state: "disconnected",
          affectedCaplets: [],
          actions: [
            {
              id: "attach-project",
              label: "Attach project from a client",
              enabled: false,
              reason: "Project Binding sessions are started by Access Clients.",
            },
          ],
        },
      };
    default:
      return assertNever(operation);
  }
}

function isCurrentHostMutation(operation: CurrentHostOperation): boolean {
  switch (operation.kind) {
    case "caplet_create":
    case "caplet_update":
    case "caplet_delete":
    case "settings_update":
    case "setup_grant":
    case "setup_revoke":
    case "catalog_install":
    case "catalog_update":
    case "pending_login_approve":
    case "pending_login_deny":
    case "client_revoke":
    case "client_change_role":
    case "vault_set":
    case "vault_delete":
    case "vault_access_grant":
    case "vault_access_revoke":
    case "runtime_restart":
      return true;
    default:
      return false;
  }
}

function hasMutationReceipt(outcome: CurrentHostOperationOutcome): boolean {
  const candidate: unknown = outcome;
  if (!isRecord(candidate) || typeof candidate.status !== "string") return false;
  return ["active", "pending", "degraded"].includes(candidate.status);
}

export async function commitCurrentHostMutation(
  dependencies: CurrentHostOperationsDependencies,
  principal: CurrentHostOperatorPrincipal,
  operation: CurrentHostMutationFields & { kind: string },
  command: unknown,
  snapshot: Record<string, unknown>,
  preflight?: CurrentHostReplayedCommit,
  receiptResult?: unknown,
): Promise<CurrentHostMutationReceipt> {
  const runtime = dependencies.runtime;
  if (!runtime?.commit) {
    throw new CapletsError(
      "ASYNC_AUTHORITY_REQUIRED",
      "Current Host authority mutations require an active runtime epoch.",
    );
  }
  const active = generationIdentity(dependencies.activeGeneration);
  const expected =
    operation.expectedGeneration === undefined ? active : operation.expectedGeneration;
  if (
    preflight?.kind !== "replayed" &&
    operation.expectedGeneration !== undefined &&
    !sameGenerationIdentity(expected, active)
  ) {
    throw authorityConflict(active);
  }
  const idempotencyKey = operation.idempotencyKey ?? randomUUID();
  const authorityId =
    active?.authorityId ??
    runtime.authorityId ??
    dependencies.control?.authorityId ??
    "current-host";
  const currentHostId =
    runtime.currentHostId ??
    dependencies.control?.currentHostId ??
    principal.hostIdentity ??
    principal.hostUrl;
  let committed: AuthorityCommitResult<unknown>;
  if (preflight?.kind === "replayed") {
    committed = preflight;
  } else {
    const authorityActivity = authoritySuccessActivity(principal, operation, expected);
    const nextSnapshot = snapshotWithAuthorityActivity(snapshot, authorityActivity);
    const envelope: SemanticCommandEnvelope<unknown> = {
      authorityId,
      currentHostId,
      principalId: principal.clientId,
      expectedGeneration: expected,
      idempotencyKey,
      requestDigest: digestCurrentHostRequest(operation.kind, operation),
      command: {
        kind: "replace_snapshot",
        snapshot: nextSnapshot,
        command,
        result: {
          activity: authorityActivity,
          ...(receiptResult === undefined ? {} : { value: receiptResult }),
        },
      },
    };
    committed = await runtime.commit<unknown>(envelope);
  }
  if (committed.kind === "conflict") throw authorityConflict(committed.active);
  if (committed.kind === "rate_limited" || committed.kind === "quota_exhausted") {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "Current Host authority is temporarily unavailable.",
      { retryAfterMs: committed.retryAfterMs },
    );
  }
  if (committed.kind !== "committed" && committed.kind !== "replayed") {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "Current Host authority returned an invalid commit.",
    );
  }
  const activation = await refreshAtLeast(dependencies, committed.generation);
  return {
    status: activation.status,
    generation: committed.generation,
    committedGeneration: committed.generation,
    activation: activation.status,
    idempotencyKey,
    ...(committed.kind === "replayed" ? { replayed: true } : {}),
    operation: operation.kind,
  };
}

/**
 * Ask the authority for an existing receipt before any operation-specific
 * current-state or generation checks. A deliberately impossible expected
 * generation makes a cache miss a conflict without publishing a generation.
 */
export async function lookupCurrentHostMutationReceipt(
  dependencies: CurrentHostOperationsDependencies,
  principal: CurrentHostOperatorPrincipal,
  operation: CurrentHostMutationFields & { kind: string },
): Promise<CurrentHostReplayedCommit | undefined> {
  const idempotencyKey = operation.idempotencyKey;
  if (idempotencyKey === undefined) return undefined;
  const runtime = dependencies.runtime;
  if (!runtime?.commit) return undefined;
  const active = generationIdentity(dependencies.activeGeneration);
  const authorityId =
    active?.authorityId ??
    runtime.authorityId ??
    dependencies.control?.authorityId ??
    "current-host";
  const currentHostId =
    runtime.currentHostId ??
    dependencies.control?.currentHostId ??
    principal.hostIdentity ??
    principal.hostUrl;
  const probe: SemanticCommandEnvelope<unknown> = {
    authorityId,
    currentHostId,
    principalId: principal.clientId,
    expectedGeneration: {
      authorityId,
      id: `receipt-probe-${randomUUID()}`,
      sequence: -1,
      predecessorId: null,
    },
    idempotencyKey,
    requestDigest: digestCurrentHostRequest(operation.kind, operation),
    command: {
      kind: "replace_snapshot",
      snapshot: authoritySnapshotForMutation(dependencies),
      result: null,
    },
  };
  const result = await runtime.commit<unknown>(probe);
  if (result.kind === "replayed") {
    return { kind: "replayed", generation: result.generation, receipt: result.receipt };
  }
  if (result.kind === "conflict") return undefined;
  if (result.kind === "rate_limited" || result.kind === "quota_exhausted") {
    throw new CapletsError(
      "SERVER_UNAVAILABLE",
      "Current Host authority is temporarily unavailable.",
      { retryAfterMs: result.retryAfterMs },
    );
  }
  throw new CapletsError(
    "SERVER_UNAVAILABLE",
    "Current Host authority accepted a receipt probe unexpectedly.",
  );
}

export function currentHostMutationReplayValue(result: unknown): unknown {
  if (!isRecord(result) || !("value" in result)) return undefined;
  return result.value;
}

function authoritySuccessActivity(
  principal: CurrentHostOperatorPrincipal,
  operation: CurrentHostMutationFields & { kind: string },
  expected: AuthorityGenerationIdentity | null,
): DashboardActivityEntry {
  return createDashboardActivityEntry({
    actorClientId: principal.clientId,
    action: activityActionForOperation(operation.kind),
    target: activityTargetForOperation(operation),
    metadata: { generation: (expected?.sequence ?? 0) + 1 },
  });
}

function snapshotWithAuthorityActivity(
  snapshot: Record<string, unknown>,
  activity: DashboardActivityEntry,
): Record<string, unknown> {
  const existing = Array.isArray(snapshot.dashboardActivity)
    ? snapshot.dashboardActivity.filter((entry): entry is DashboardActivityEntry =>
        isDashboardActivityEntry(entry),
      )
    : [];
  return {
    ...snapshot,
    dashboardActivity: [...existing.slice(-9_999), activity],
  };
}

async function activityListOutcome(
  dependencies: CurrentHostOperationsDependencies,
  operation: Extract<CurrentHostOperation, { kind: "activity_list" }>,
): Promise<Extract<CurrentHostOperationOutcome, { kind: "activity_list" }>> {
  const authorityEntries = authorityActivityEntries(dependencies.activeGeneration?.snapshot);
  if (authorityEntries.length === 0) {
    return { kind: "activity_list", activity: await dependencies.activityLog.list(operation) };
  }
  const local = await dependencies.activityLog.list({ limit: 500, action: operation.action });
  const byId = new Map<string, DashboardActivityEntry>();
  for (const entry of local.entries) byId.set(entry.id, entry);
  for (const entry of authorityEntries) byId.set(entry.id, entry);
  let entries = [...byId.values()];
  if (operation.action) entries = entries.filter((entry) => entry.action === operation.action);
  entries.sort((left, right) => {
    const difference = Date.parse(left.createdAt) - Date.parse(right.createdAt);
    return difference === 0 ? left.id.localeCompare(right.id) : difference;
  });
  if (operation.after) {
    const index = entries.findIndex((entry) => entry.id === operation.after);
    if (index >= 0) entries = entries.slice(0, index);
  }
  const newest = entries.slice().reverse();
  const limit = boundedLimit(operation.limit);
  const page = newest.slice(0, limit);
  const nextCursor = newest.length > limit ? page.at(-1)?.id : undefined;
  return {
    kind: "activity_list",
    activity: { entries: page, ...(nextCursor ? { nextCursor } : {}) },
  };
}

function authorityActivityEntries(snapshot: unknown): DashboardActivityEntry[] {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.dashboardActivity)) return [];
  return snapshot.dashboardActivity.filter(isDashboardActivityEntry);
}

function isDashboardActivityEntry(value: unknown): value is DashboardActivityEntry {
  if (!isRecord(value) || !isRecord(value.target)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.actorClientId === "string" &&
    isDashboardActivityAction(value.action) &&
    (value.outcome === "success" || value.outcome === "failure") &&
    typeof value.target.type === "string" &&
    typeof value.target.id === "string"
  );
}

function isDashboardActivityAction(value: unknown): value is DashboardActivityAction {
  return (
    value === "dashboard_login_completed" ||
    value === "dashboard_logout" ||
    value === "pending_login_approved" ||
    value === "pending_login_denied" ||
    value === "remote_client_revoked" ||
    value === "remote_client_role_changed" ||
    value === "catalog_installed" ||
    value === "catalog_updated" ||
    value === "caplet_created" ||
    value === "caplet_updated" ||
    value === "caplet_deleted" ||
    value === "settings_updated" ||
    value === "setup_granted" ||
    value === "setup_revoked" ||
    value === "vault_set" ||
    value === "vault_deleted" ||
    value === "vault_grant_added" ||
    value === "vault_grant_revoked" ||
    value === "vault_value_revealed" ||
    value === "runtime_restart_requested"
  );
}

export function authoritySnapshotForMutation(
  dependencies: CurrentHostOperationsDependencies,
): Record<string, unknown> {
  const snapshot = dependencies.activeGeneration?.snapshot;
  if (isRecord(snapshot)) return structuredClone(snapshot);
  return { caplets: {} };
}

function generationIdentity(
  generation: AuthorityGeneration<unknown> | AuthorityGenerationIdentity | null | undefined,
): AuthorityGenerationIdentity | null {
  if (!generation) return null;
  return {
    authorityId: generation.authorityId,
    id: generation.id,
    sequence: generation.sequence,
    predecessorId: generation.predecessorId,
  };
}

function sameGenerationIdentity(
  left: AuthorityGenerationIdentity | null,
  right: AuthorityGenerationIdentity | null,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.authorityId === right.authorityId &&
    left.id === right.id &&
    left.sequence === right.sequence &&
    left.predecessorId === right.predecessorId
  );
}

function authorityConflict(active: AuthorityGenerationIdentity | null): CapletsError {
  return new CapletsError("REQUEST_INVALID", "Current Host authority generation conflict.", {
    kind: "conflict",
    activeGeneration: active,
  });
}

function digestCurrentHostRequest(kind: string, operation: unknown): string {
  const payload = isRecord(operation)
    ? Object.fromEntries(
        Object.entries(operation).filter(
          ([key]) => key !== "expectedGeneration" && key !== "idempotencyKey",
        ),
      )
    : operation;
  return `sha256:${createHash("sha256")
    .update(stableJsonStringify({ kind, payload }), "utf8")
    .digest("hex")}`;
}

async function refreshAtLeast(
  dependencies: CurrentHostOperationsDependencies,
  generation: AuthorityGenerationIdentity,
): Promise<CurrentHostActivation> {
  const runtime = dependencies.runtime;
  if (runtime?.refreshAtLeast) {
    const result = await runtime.refreshAtLeast(generation).catch(() => false);
    if (typeof result === "object" && result !== null && "status" in result) {
      return normalizeActivation(result);
    }
  } else {
    await runtime?.refresh().catch(() => false);
  }
  const health = await runtime?.health?.().catch(() => undefined);
  const active = health?.activeGeneration ?? generationIdentity(dependencies.activeGeneration);
  const observed = health?.observedGeneration ?? active;
  const isActive = sameGenerationIdentity(active, generation);
  return {
    status: isActive ? "active" : health?.connectivity === "degraded" ? "degraded" : "pending",
    activeGeneration: active,
    observedGeneration: observed,
    exposureGeneration: health?.exposureGeneration ?? null,
    lag: health?.lag ?? null,
  };
}

function normalizeActivation(value: object): CurrentHostActivation {
  const status =
    "status" in value &&
    (value.status === "active" || value.status === "pending" || value.status === "degraded")
      ? value.status
      : "pending";
  const activeGeneration =
    "activeGeneration" in value && isGenerationIdentity(value.activeGeneration)
      ? value.activeGeneration
      : null;
  const observedGeneration =
    "observedGeneration" in value && isGenerationIdentity(value.observedGeneration)
      ? value.observedGeneration
      : null;
  const exposureGeneration =
    "exposureGeneration" in value && typeof value.exposureGeneration === "number"
      ? value.exposureGeneration
      : null;
  const lag = "lag" in value && typeof value.lag === "number" ? value.lag : null;
  return { status, activeGeneration, observedGeneration, exposureGeneration, lag };
}

function isGenerationIdentity(value: unknown): value is AuthorityGenerationIdentity {
  return (
    isRecord(value) &&
    typeof value.authorityId === "string" &&
    typeof value.id === "string" &&
    typeof value.sequence === "number" &&
    Number.isSafeInteger(value.sequence) &&
    (value.predecessorId === null || typeof value.predecessorId === "string")
  );
}

function assertCurrentHostIdentity(
  dependencies: CurrentHostOperationsDependencies,
  principal: CurrentHostOperatorPrincipal,
): void {
  const expected = dependencies.runtime?.currentHostId ?? dependencies.control?.currentHostId;
  if (
    principal.hostIdentity !== undefined &&
    expected !== undefined &&
    principal.hostIdentity !== expected
  ) {
    throw new CapletsError(
      "AUTH_FAILED",
      "Current Host principal belongs to a different host identity.",
    );
  }
}

function stagedProvenanceFromView(
  view: RuntimeEpochLease["view"],
): Pick<CurrentHostOperationsDependencies, "stagedProvenance"> {
  if (!("stagedProvenance" in view) || !isRecord(view.stagedProvenance)) return {};
  const staged: Record<string, { kind: string; path?: string }> = {};
  for (const [id, source] of Object.entries(view.stagedProvenance)) {
    if (!isRecord(source) || typeof source.kind !== "string") continue;
    staged[id] = {
      kind: source.kind,
      ...(typeof source.path === "string" ? { path: source.path } : {}),
    };
  }
  return Object.keys(staged).length > 0 ? { stagedProvenance: staged } : {};
}

async function diagnosticsOutcome(
  dependencies: CurrentHostOperationsDependencies,
): Promise<Extract<CurrentHostOperationOutcome, { kind: "diagnostics" }>> {
  const health = await dependencies.runtime?.health?.().catch(() => undefined);
  const status =
    health?.connectivity === "unavailable"
      ? "unavailable"
      : health?.connectivity === "degraded" || health?.writable === false
        ? "degraded"
        : "ok";
  return {
    kind: "diagnostics",
    status,
    diagnostics: [],
    checks: [
      { id: "runtime", status },
      { id: "dashboard", status: status === "ok" ? "ok" : "degraded" },
    ],
    ...(health ? { health } : {}),
  };
}

async function runtimeEventOutcome(
  dependencies: CurrentHostOperationsDependencies,
): Promise<Extract<CurrentHostOperationOutcome, { kind: "runtime_event" }>> {
  const health = await dependencies.runtime?.health?.().catch(() => undefined);
  const status =
    health?.connectivity === "unavailable"
      ? "unavailable"
      : health?.connectivity === "degraded"
        ? "degraded"
        : "ok";
  return {
    kind: "runtime_event",
    event: {
      type: "runtime_health",
      runtime: { status, version: dependencies.version },
      projectBinding: { state: "disconnected" },
      ...(health ? { health } : {}),
    },
  };
}

function activityActionForOperation(kind: string): DashboardActivityAction {
  switch (kind) {
    case "catalog_install":
      return "catalog_installed";
    case "caplet_create":
      return "caplet_created";
    case "caplet_update":
      return "caplet_updated";
    case "caplet_delete":
      return "caplet_deleted";
    case "settings_update":
      return "settings_updated";
    case "setup_grant":
      return "setup_granted";
    case "setup_revoke":
      return "setup_revoked";
    default:
      return "catalog_updated";
  }
}

function activityTargetForOperation(
  operation: CurrentHostMutationFields & { kind: string; id?: string },
): { type: "catalog" | "runtime" | "vault"; id: string } {
  if (operation.kind.startsWith("setup_")) return { type: "runtime", id: operation.id ?? "setup" };
  if (operation.kind.startsWith("settings")) return { type: "runtime", id: "settings" };
  if (operation.kind.startsWith("caplet_"))
    return { type: "catalog", id: operation.id ?? "caplet" };
  return { type: "runtime", id: "current-host" };
}
function boundedLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 100;
  return Math.min(500, Math.max(1, Math.trunc(value)));
}

function assertOperatorPrincipal(
  principal: unknown,
): asserts principal is CurrentHostOperatorPrincipal {
  if (
    !isRecord(principal) ||
    principal.role !== "operator" ||
    (principal.clientId !== "development_unauthenticated" &&
      (typeof principal.clientId !== "string" ||
        !/^rcli_[A-Za-z0-9_-]{16}$/u.test(principal.clientId))) ||
    (principal.clientId === "development_unauthenticated" &&
      Reflect.get(principal, TRUSTED_DEVELOPMENT_PRINCIPAL) !== true) ||
    typeof principal.hostUrl !== "string" ||
    !isHttpUrl(principal.hostUrl) ||
    (principal.clientLabel !== undefined && typeof principal.clientLabel !== "string")
  ) {
    throw new CapletsError(
      "AUTH_FAILED",
      "Current Host administration requires an Operator principal.",
    );
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new CapletsError(
    "UNKNOWN_OPERATION",
    `Unsupported Current Host operation ${String(value)}`,
  );
}
