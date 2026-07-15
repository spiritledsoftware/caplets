import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CatalogCompactEntry, CatalogEntry } from "../catalog";
import {
  DashboardActivityLog,
  type DashboardActivityAction,
  type DashboardActivityEntry,
} from "../dashboard/activity-log";
import type { CapletsEngine } from "../engine";
import { CapletsError, toSafeError, type SafeErrorSummary } from "../errors";
import type { RemoteServerCredentialStore } from "../remote/server-credential-store";
import type {
  RemoteClientRole,
  RemoteClientStatus,
  RemotePendingLoginStatus,
} from "../remote/server-credentials";
import type { VaultDeleteStatus, VaultValueStatus } from "../vault";
import {
  type CurrentHostCatalogInstallResult as CatalogInstallResult,
  type CurrentHostInstalledCapletProjection as InstalledCapletProjection,
  type CurrentHostInstalledCatalogCaplet as InstalledCatalogCaplet,
  type CurrentHostSetupAction as SetupAction,
} from "./catalog";
import { createCurrentHostCatalogOperations } from "./catalog-operations";
import { createCurrentHostClientOperations } from "./client-operations";
import { createCurrentHostVaultOperations } from "./vault-operations";

const TRUSTED_DEVELOPMENT_PRINCIPAL = Symbol("trusted-development-principal");
const FINAL_AUTHORIZATION = Symbol("current-host-final-authorization");

export type CurrentHostPrincipal = {
  clientId: string;
  clientLabel?: string | undefined;
  hostUrl: string;
  role: RemoteClientRole;
};

export type CurrentHostOperatorPrincipal = CurrentHostPrincipal & {
  role: "operator";
  [TRUSTED_DEVELOPMENT_PRINCIPAL]?: true;
  [FINAL_AUTHORIZATION]?: (() => void | Promise<void>) | undefined;
};

export function withCurrentHostFinalAuthorization(
  principal: CurrentHostOperatorPrincipal,
  authorize: () => void | Promise<void>,
): CurrentHostOperatorPrincipal {
  return Object.defineProperty({ ...principal }, FINAL_AUTHORIZATION, {
    value: authorize,
    enumerable: false,
  });
}

export function finalAuthorizeCurrentHostMutation(
  principal: CurrentHostOperatorPrincipal,
): void | Promise<void> {
  return principal[FINAL_AUTHORIZATION]?.();
}

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
};

export type CurrentHostMutationTarget = "project" | "global" | "remote";

export type CurrentHostOperationClass = "logical-state" | "security-authority" | "external-effect";

export type CurrentHostOperationBinding = {
  operationId: string;
  target: CurrentHostMutationTarget;
  logicalHostId: string;
  storeId: string;
  operationNamespace: string;
  actorId: string;
  requestIdentity: string;
  operationClass: CurrentHostOperationClass;
};

export type CurrentHostAuthorityToken = {
  authorityGeneration: number;
  effectiveGeneration: number;
};

export type CurrentHostOperationReceipt = {
  status: "committed";
  binding: CurrentHostOperationBinding;
  aggregateVersion: number;
  authorityToken: CurrentHostAuthorityToken;
  localApplication: "applied" | "pending" | "not-applicable";
  convergence:
    | { kind: "single-node" }
    | { kind: "pending"; deadline: string }
    | { kind: "converged"; appliedNodes: number };
};

export type CurrentHostOperationLookupOutcome =
  | { status: "committed"; receipt: CurrentHostOperationReceipt }
  | {
      status: "not_committed";
      binding: CurrentHostOperationBinding;
      retryReservationId: string;
    }
  | {
      status: "unknown" | "unavailable" | "wrong_target" | "stale_namespace";
      binding: CurrentHostOperationBinding;
    };

export type CurrentHostOperationIndeterminateOutcome = {
  status: "indeterminate";
  binding: CurrentHostOperationBinding;
};

export type CurrentHostOperationRecovery =
  | { kind: "return-receipt"; receipt: CurrentHostOperationReceipt }
  | {
      kind: "resubmit";
      priorOperationId: string;
      retryReservationId: string;
      binding: CurrentHostOperationBinding;
    }
  | {
      kind: "not-retryable";
      outcome: Exclude<
        CurrentHostOperationLookupOutcome,
        { status: "committed" | "not_committed" }
      >;
    };

/**
 * The implementation must serialize this operation with dispatch commit: returning not_committed
 * durably reserves the original identity so an already-running dispatch can no longer commit.
 */
export interface CurrentHostOperationLookupPort {
  lookupOrReserveNotCommitted(
    binding: CurrentHostOperationBinding,
  ): CurrentHostOperationLookupOutcome | Promise<CurrentHostOperationLookupOutcome>;
}

export type CurrentHostOperationReservationState =
  | { status: "in_flight"; binding: CurrentHostOperationBinding }
  | { status: "committed"; receipt: CurrentHostOperationReceipt }
  | {
      status: "retry_reserved";
      binding: CurrentHostOperationBinding;
      retryReservationId: string;
      canOriginalCommit: false;
    }
  | { status: "unknown"; binding: CurrentHostOperationBinding }
  | { status: "stale_namespace"; binding: CurrentHostOperationBinding };

export type CurrentHostIrreversibleActionPreview = {
  version: 1;
  action: string;
  logicalHostId: string;
  storeId: string;
  authorityToken: CurrentHostAuthorityToken;
  affectedVersions: string[];
  expiresAt: string;
  consequences: string[];
};

export type CurrentHostConfirmationToken = CurrentHostIrreversibleActionPreview & {
  tokenId: string;
  consumed: false;
};

export type CurrentHostConfirmationExpectation = Pick<
  CurrentHostConfirmationToken,
  "action" | "logicalHostId" | "storeId" | "authorityToken" | "affectedVersions"
>;

export function allocateCurrentHostOperationBinding(
  input: Omit<CurrentHostOperationBinding, "operationId">,
  allocateOperationId: () => string = () => `operation_${randomUUID()}`,
): CurrentHostOperationBinding {
  const operationId = allocateOperationId();
  if (operationId.length === 0) {
    throw new CapletsError("REQUEST_INVALID", "Current Host operation ID is required.");
  }
  return { operationId, ...input };
}

export function createCurrentHostOperationIndeterminateOutcome(
  binding: CurrentHostOperationBinding,
): CurrentHostOperationIndeterminateOutcome {
  return { status: "indeterminate", binding };
}

export async function recoverCurrentHostOperation(
  indeterminate: CurrentHostOperationIndeterminateOutcome,
  port: CurrentHostOperationLookupPort,
  allocateOperationId: () => string = () => `operation_${randomUUID()}`,
): Promise<CurrentHostOperationRecovery> {
  const outcome = await port.lookupOrReserveNotCommitted(indeterminate.binding);
  const outcomeBinding = outcome.status === "committed" ? outcome.receipt.binding : outcome.binding;
  if (!isDeepStrictEqual(outcomeBinding, indeterminate.binding)) {
    return {
      kind: "not-retryable",
      outcome: { status: "wrong_target", binding: indeterminate.binding },
    };
  }
  if (outcome.status === "committed") {
    return { kind: "return-receipt", receipt: outcome.receipt };
  }
  if (outcome.status === "not_committed") {
    return {
      kind: "resubmit",
      priorOperationId: indeterminate.binding.operationId,
      retryReservationId: outcome.retryReservationId,
      binding: allocateCurrentHostOperationBinding(
        {
          target: indeterminate.binding.target,
          logicalHostId: indeterminate.binding.logicalHostId,
          storeId: indeterminate.binding.storeId,
          operationNamespace: indeterminate.binding.operationNamespace,
          actorId: indeterminate.binding.actorId,
          requestIdentity: indeterminate.binding.requestIdentity,
          operationClass: indeterminate.binding.operationClass,
        },
        allocateOperationId,
      ),
    };
  }
  return { kind: "not-retryable", outcome };
}

export function reserveCurrentHostOperationLookup(
  state: CurrentHostOperationReservationState,
  allocateReservationId: () => string,
): {
  state: CurrentHostOperationReservationState;
  outcome: CurrentHostOperationLookupOutcome;
} {
  switch (state.status) {
    case "committed":
      return { state, outcome: { status: "committed", receipt: state.receipt } };
    case "in_flight": {
      const retryReservationId = allocateReservationId();
      const reserved: CurrentHostOperationReservationState = {
        status: "retry_reserved",
        binding: state.binding,
        retryReservationId,
        canOriginalCommit: false,
      };
      return {
        state: reserved,
        outcome: { status: "not_committed", binding: state.binding, retryReservationId },
      };
    }
    case "retry_reserved":
      return {
        state,
        outcome: {
          status: "not_committed",
          binding: state.binding,
          retryReservationId: state.retryReservationId,
        },
      };
    case "unknown":
    case "stale_namespace":
      return { state, outcome: { status: state.status, binding: state.binding } };
  }
}

export function validateCurrentHostConfirmation(
  confirmation: CurrentHostConfirmationToken,
  expected: CurrentHostConfirmationExpectation,
  now = new Date(),
): CurrentHostConfirmationToken {
  const matches =
    confirmation.version === 1 &&
    confirmation.consumed === false &&
    confirmation.action === expected.action &&
    confirmation.logicalHostId === expected.logicalHostId &&
    confirmation.storeId === expected.storeId &&
    isDeepStrictEqual(confirmation.authorityToken, expected.authorityToken) &&
    isDeepStrictEqual(
      [...confirmation.affectedVersions].sort(),
      [...expected.affectedVersions].sort(),
    ) &&
    Number.isFinite(Date.parse(confirmation.expiresAt)) &&
    Date.parse(confirmation.expiresAt) > now.getTime();
  if (!matches) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Current Host confirmation is absent, stale, consumed, or mismatched.",
    );
  }
  return confirmation;
}

export type CurrentHostOperation =
  | {
      kind: "summary";
      baseUrl: string;
      dashboardUrl: string;
      dashboardPath: string;
    }
  | { kind: "caplets_list" }
  | {
      kind: "catalog_search";
      source: string;
      query?: string | undefined;
      limit?: number | undefined;
    }
  | { kind: "catalog_index"; source: string }
  | { kind: "catalog_detail"; source: string; entryKey: string }
  | { kind: "catalog_updates" }
  | {
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
    }
  | {
      kind: "catalog_update";
      capletIds?: string[] | undefined;
      force?: boolean | undefined;
      allowRiskIncrease?: boolean | undefined;
      disableCatalogIndexing?: boolean | undefined;
    }
  | { kind: "clients_list" }
  | { kind: "pending_logins_list" }
  | {
      kind: "pending_login_approve";
      flowId: string;
      grantedRole?: RemoteClientRole | undefined;
    }
  | { kind: "pending_login_deny"; flowId: string }
  | { kind: "client_revoke"; clientId: string }
  | { kind: "client_change_role"; clientId: string; role: RemoteClientRole }
  | {
      kind: "activity_list";
      limit?: number | undefined;
      after?: string | undefined;
      action?: DashboardActivityAction | undefined;
    }
  | {
      kind: "vault_set";
      name: string;
      value: string;
      grant?: string | undefined;
      referenceName?: string | undefined;
      force?: boolean | undefined;
    }
  | { kind: "vault_list" }
  | { kind: "vault_get"; name: string }
  | { kind: "vault_delete"; name: string }
  | {
      kind: "vault_access_grant";
      storedKey: string;
      referenceName: string;
      capletId: string;
    }
  | {
      kind: "vault_access_revoke";
      storedKey: string;
      referenceName?: string | undefined;
      capletId?: string | undefined;
    }
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
  | {
      kind: "catalog_install";
      installed: CurrentHostInstalledCatalogCaplet[];
      setupActions: CurrentHostSetupAction[];
    }
  | {
      kind: "catalog_update";
      installed: CurrentHostInstalledCatalogCaplet[];
      setupActions: CurrentHostSetupAction[];
    }
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
      status: "ok";
      diagnostics: [];
      checks: Array<{ id: "runtime" | "dashboard"; status: "ok" }>;
    }
  | {
      kind: "runtime_event";
      event: {
        type: "runtime_health";
        runtime: { status: "ok"; version: string };
        projectBinding: { state: "disconnected" };
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

export type CurrentHostOperationsDependencies = {
  engine: Pick<CapletsEngine, "enabledServers">;
  control?: CurrentHostControlContext | undefined;
  activityLog: DashboardActivityLog;
  remoteCredentialStore?: RemoteServerCredentialStore | undefined;
  version: string;
};

export function createCurrentHostOperations(
  dependencies: CurrentHostOperationsDependencies,
): CurrentHostOperations {
  const catalog = createCurrentHostCatalogOperations(dependencies);
  const clients = createCurrentHostClientOperations(dependencies);
  const vault = createCurrentHostVaultOperations(dependencies);

  return {
    async execute<const TOperation extends CurrentHostOperation>(
      principal: CurrentHostPrincipal,
      operation: TOperation,
    ): Promise<CurrentHostOperationOutcomeFor<TOperation>> {
      assertOperatorPrincipal(principal);
      const finalAuthorization = finalAuthorizeCurrentHostMutation(principal);
      if (finalAuthorization instanceof Promise) await finalAuthorization;
      const outcome = await executeCurrentHostOperation(
        dependencies,
        catalog,
        clients,
        vault,
        principal,
        operation,
      );
      return outcome as CurrentHostOperationOutcomeFor<TOperation>;
    },
  };
}

async function executeCurrentHostOperation(
  dependencies: CurrentHostOperationsDependencies,
  catalog: ReturnType<typeof createCurrentHostCatalogOperations>,
  clients: ReturnType<typeof createCurrentHostClientOperations>,
  vault: ReturnType<typeof createCurrentHostVaultOperations>,
  principal: CurrentHostOperatorPrincipal,
  operation: CurrentHostOperation,
): Promise<CurrentHostOperationOutcome> {
  switch (operation.kind) {
    case "summary":
      return clients.summary(vault.valueCount(), operation);
    case "caplets_list":
      return catalog.capletsList(operation);
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
      return clients.listClients();
    case "pending_logins_list":
      return clients.listPendingLogins();
    case "pending_login_approve":
      return clients.approvePendingLogin(principal, operation);
    case "pending_login_deny":
      return clients.denyPendingLogin(principal, operation);
    case "client_revoke":
      return clients.revokeClient(principal, operation);
    case "client_change_role":
      return clients.changeClientRole(principal, operation);
    case "activity_list":
      return { kind: "activity_list", activity: dependencies.activityLog.list(operation) };
    case "vault_set":
      return vault.set(principal, operation);
    case "vault_list":
      return vault.list(operation);
    case "vault_get":
      return vault.get(operation);
    case "vault_delete":
      return vault.delete(principal, operation);
    case "vault_access_grant":
      return vault.grant(principal, operation);
    case "vault_access_revoke":
      return vault.revoke(principal, operation);
    case "vault_access_list":
      return vault.listAccess(operation);
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
      return {
        kind: "diagnostics",
        status: "ok",
        diagnostics: [],
        checks: [
          { id: "runtime", status: "ok" },
          { id: "dashboard", status: "ok" },
        ],
      };
    case "runtime_event":
      return {
        kind: "runtime_event",
        event: {
          type: "runtime_health",
          runtime: { status: "ok", version: dependencies.version },
          projectBinding: { state: "disconnected" },
        },
      };
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
