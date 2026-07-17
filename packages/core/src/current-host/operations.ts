import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CatalogCompactEntry, CatalogEntry } from "../catalog";
import {
  DashboardActivityLog,
  type DashboardActivityAction,
  type DashboardActivityEntry,
  type DashboardActivityRepository,
} from "../dashboard/activity-log";
import type { CapletsEngine } from "../engine";
import { MutableHostSettingSchema } from "../config-runtime";
import {
  resolveControlPlaneCapletMutationTarget,
  resolveControlPlaneHostSettingMutationTarget,
  type ControlPlaneRuntimeSnapshot,
  type RuntimeOwnershipLayer,
} from "../control-plane/snapshot";
import type {
  ControlPlaneHealthSummary,
  ControlPlaneMutationResult,
  ControlPlaneOperationReservationResult,
  ControlPlaneSnapshot,
  UntrustedCapletManagementMutation,
  UntrustedHostSettingManagementMutation,
} from "../control-plane/types";
import type {
  CanonicalCapletAggregate,
  CanonicalCapletRelationalProjection,
  CapletActivationState,
} from "../control-plane/caplets/model";
import { CapletsError, toSafeError, type SafeErrorSummary } from "../errors";
import type {
  RemoteCredentialRepository,
  RemotePendingLoginRepository,
  RemoteServerCredentialStore,
} from "../remote/server-credential-store";
import type {
  RemoteClientRole,
  RemoteClientStatus,
  RemotePendingLoginStatus,
} from "../remote/server-credentials";
import type { VaultDeleteStatus, VaultRepository, VaultValueStatus } from "../vault";
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

export type CurrentHostOwnershipLayer = Readonly<{
  owner: "sql" | "filesystem";
  source: Readonly<{ kind: string }>;
  provenance?: Readonly<{ id?: string | undefined }> | undefined;
}>;

export type CurrentHostManagementTargetDetail = Readonly<{
  resource: "caplet" | "host-setting";
  id: string;
  selector: "effective" | "underlying-sql";
  owner: "sql" | "filesystem";
  source: Readonly<{ kind: string }>;
  effective: boolean;
  effectiveChanged: boolean;
  shadowChain: readonly CurrentHostOwnershipLayer[];
  underlyingSqlAvailable: boolean;
  consequence: "effective-runtime-changes" | "no-effective-change-while-shadowed";
}>;

export type CurrentHostOperationReceipt = {
  status: "committed";
  binding: CurrentHostOperationBinding;
  aggregateVersion: number;
  authorityToken: CurrentHostAuthorityToken;
  localApplication: "applied" | "pending" | "not-applicable";
  convergence:
    | { kind: "single-node" }
    | { kind: "pending"; deadline: string; requiredNodes: number }
    | { kind: "overdue"; deadline: string; requiredNodes: number }
    | { kind: "converged"; appliedNodes: number };
  management?: CurrentHostManagementTargetDetail | undefined;
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

export function parseCurrentHostOperationBinding(value: unknown): CurrentHostOperationBinding {
  if (!isRecord(value)) {
    throw new CapletsError("REQUEST_INVALID", "Current Host operation binding is invalid.");
  }
  const target = value.target;
  const operationClass = value.operationClass;
  if (
    typeof value.operationId !== "string" ||
    !/^[A-Za-z0-9_-]{1,160}$/u.test(value.operationId) ||
    (target !== "global" && target !== "remote" && target !== "project") ||
    typeof value.logicalHostId !== "string" ||
    typeof value.storeId !== "string" ||
    typeof value.operationNamespace !== "string" ||
    typeof value.actorId !== "string" ||
    typeof value.requestIdentity !== "string" ||
    value.requestIdentity.length === 0 ||
    (operationClass !== "logical-state" &&
      operationClass !== "security-authority" &&
      operationClass !== "external-effect")
  ) {
    throw new CapletsError("REQUEST_INVALID", "Current Host operation binding is invalid.");
  }
  return {
    operationId: value.operationId,
    target,
    logicalHostId: value.logicalHostId,
    storeId: value.storeId,
    operationNamespace: value.operationNamespace,
    actorId: value.actorId,
    requestIdentity: value.requestIdentity,
    operationClass,
  };
}

export function parseCurrentHostManagementMutation(value: unknown): CurrentHostManagementMutation {
  if (!isRecord(value)) {
    throw new CapletsError("REQUEST_INVALID", "Current Host management mutation is invalid.");
  }
  const selector = value.selector;
  if (selector !== "effective" && selector !== "underlying-sql") {
    throw new CapletsError("REQUEST_INVALID", "Current Host management selector is invalid.");
  }
  const expectedAggregateVersion =
    value.expectedAggregateVersion === undefined
      ? undefined
      : boundedNonNegativeInteger(value.expectedAggregateVersion);
  const expectedAuthorityToken = parseExpectedAuthorityToken(value.expectedAuthorityToken);
  if (value.kind === "host-setting-set" && typeof value.key === "string") {
    return {
      kind: "host-setting-set",
      key: value.key,
      value: value.value,
      selector,
      ...(expectedAggregateVersion === undefined ? {} : { expectedAggregateVersion }),
      ...(expectedAuthorityToken === undefined ? {} : { expectedAuthorityToken }),
    };
  }
  if (
    value.kind === "caplet-set-activation" &&
    typeof value.id === "string" &&
    (value.activation === "active" ||
      value.activation === "setup-required" ||
      value.activation === "dormant-shadowed" ||
      value.activation === "disabled")
  ) {
    return {
      kind: "caplet-set-activation",
      id: value.id,
      activation: value.activation,
      selector,
      ...(expectedAggregateVersion === undefined ? {} : { expectedAggregateVersion }),
      ...(expectedAuthorityToken === undefined ? {} : { expectedAuthorityToken }),
    };
  }
  throw new CapletsError("REQUEST_INVALID", "Current Host management mutation is invalid.");
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

export type CurrentHostManagementResource = "caplet" | "host-setting";

export type CurrentHostManagementMutation =
  | Readonly<{
      kind: "caplet-set-activation";
      id: string;
      activation: CapletActivationState;
      selector: "effective" | "underlying-sql";
      expectedAggregateVersion?: number | undefined;
      expectedAuthorityToken?: CurrentHostAuthorityToken | undefined;
    }>
  | Readonly<{
      kind: "host-setting-set";
      key: string;
      value: unknown;
      selector: "effective" | "underlying-sql";
      expectedAggregateVersion?: number | undefined;
      expectedAuthorityToken?: CurrentHostAuthorityToken | undefined;
    }>;

export type CurrentHostManagementFailure =
  | Readonly<{
      status: "denied";
      binding: CurrentHostOperationBinding;
      reason: "wrong-host" | "wrong-store" | "stale-authority" | "stale-security" | "revoked-role";
    }>
  | Readonly<{ status: "unavailable"; binding: CurrentHostOperationBinding }>
  | Readonly<{
      status: "conflict";
      binding: CurrentHostOperationBinding;
      reason:
        | "aggregate-version"
        | "operation-reservation"
        | "writer-fence"
        | "authority-generation"
        | "effective-generation"
        | "security-epoch";
    }>;

export type CurrentHostManagementListResult =
  | Readonly<{
      status: "ok";
      binding: CurrentHostOperationBinding;
      resource: CurrentHostManagementResource;
      items: readonly CurrentHostManagementTargetDetail[];
    }>
  | CurrentHostManagementFailure;

export type CurrentHostManagementInspectResult =
  | Readonly<{
      status: "ok";
      binding: CurrentHostOperationBinding;
      target: CurrentHostManagementTargetDetail;
      record: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      status: "not_found";
      binding: CurrentHostOperationBinding;
      resource: CurrentHostManagementResource;
      id: string;
      selector: "effective" | "underlying-sql";
    }>
  | CurrentHostManagementFailure;

export type CurrentHostManagementPreviewResult =
  | Readonly<{
      status: "preview";
      binding: CurrentHostOperationBinding;
      target: CurrentHostManagementTargetDetail;
      expectedAggregateVersion: number;
      authorityToken: CurrentHostAuthorityToken;
      consequence: CurrentHostManagementTargetDetail["consequence"];
    }>
  | Readonly<{
      status: "rejected";
      binding: CurrentHostOperationBinding;
      reason: "filesystem-owned";
      target: CurrentHostManagementTargetDetail;
    }>
  | Readonly<{
      status: "not_found";
      binding: CurrentHostOperationBinding;
      resource: CurrentHostManagementResource;
      id: string;
      selector: "effective" | "underlying-sql";
    }>
  | CurrentHostManagementFailure;

export type CurrentHostManagementMutationResult =
  | Readonly<{
      status: "committed";
      binding: CurrentHostOperationBinding;
      receipt: CurrentHostOperationReceipt;
      localApplicationError?: SafeErrorSummary | undefined;
    }>
  | Readonly<{
      status: "unknown";
      binding: CurrentHostOperationBinding;
      retryAllowed: false;
      guidance: "lookup-original-target";
    }>
  | Extract<CurrentHostManagementPreviewResult, { status: "rejected" | "not_found" }>
  | CurrentHostManagementFailure;

export type CurrentHostManagementStatusResult =
  | Readonly<{
      status: "ok";
      binding: CurrentHostOperationBinding;
      health: ControlPlaneHealthSummary;
    }>
  | CurrentHostManagementFailure;

export interface CurrentHostManagementStorage {
  readonly identity: Readonly<{
    logicalHostId: string;
    storeId: string;
    operationNamespace: string;
  }>;
  reserveOperation(
    binding: CurrentHostOperationBinding,
    aggregateId: string,
  ): Promise<
    | ControlPlaneOperationReservationResult
    | Exclude<CurrentHostManagementFailure, { status: "conflict" }>
  >;
  loadSnapshot(
    binding: CurrentHostOperationBinding,
  ): Promise<
    | Readonly<{ status: "ok"; snapshot: ControlPlaneSnapshot }>
    | Exclude<CurrentHostManagementFailure, { status: "conflict" }>
  >;
  mutateCaplet(input: UntrustedCapletManagementMutation): Promise<ControlPlaneMutationResult>;
  mutateHostSetting(
    input: UntrustedHostSettingManagementMutation,
  ): Promise<ControlPlaneMutationResult>;
  lookupOperation(binding: CurrentHostOperationBinding): Promise<CurrentHostOperationLookupOutcome>;
  status(
    binding: CurrentHostOperationBinding,
  ): Promise<
    | Readonly<{ status: "ok"; health: ControlPlaneHealthSummary }>
    | Exclude<CurrentHostManagementFailure, { status: "conflict" }>
  >;
}

export type CurrentHostManagementDependencies = Readonly<{
  storage: CurrentHostManagementStorage;
  loadRuntimeSnapshot(): Promise<ControlPlaneRuntimeSnapshot>;
  applyCommitted?: ((receipt: CurrentHostOperationReceipt) => void | Promise<void>) | undefined;
  now?: (() => Date) | undefined;
}>;

export type CurrentHostManagementListRequest = Readonly<{
  binding: CurrentHostOperationBinding;
  resource: CurrentHostManagementResource;
}>;

export type CurrentHostManagementInspectRequest = Readonly<{
  binding: CurrentHostOperationBinding;
  resource: CurrentHostManagementResource;
  id: string;
  selector: "effective" | "underlying-sql";
}>;

export type CurrentHostManagementPreviewRequest = Readonly<{
  binding: CurrentHostOperationBinding;
  mutation: CurrentHostManagementMutation;
}>;

export type CurrentHostManagementMutateRequest = CurrentHostManagementPreviewRequest;

/**
 * The single app-scoped Current Host administration boundary. Adapters authenticate
 * and serialize; this Module owns safe administration policy and outcomes.
 */
export interface CurrentHostOperations {
  execute<const TOperation extends CurrentHostOperation>(
    principal: CurrentHostPrincipal,
    operation: TOperation,
  ): Promise<CurrentHostOperationOutcomeFor<TOperation>>;
  list(
    principal: CurrentHostPrincipal,
    request: CurrentHostManagementListRequest,
  ): Promise<CurrentHostManagementListResult>;
  inspect(
    principal: CurrentHostPrincipal,
    request: CurrentHostManagementInspectRequest,
  ): Promise<CurrentHostManagementInspectResult>;
  preview(
    principal: CurrentHostPrincipal,
    request: CurrentHostManagementPreviewRequest,
  ): Promise<CurrentHostManagementPreviewResult>;
  mutate(
    principal: CurrentHostPrincipal,
    request: CurrentHostManagementMutateRequest,
  ): Promise<CurrentHostManagementMutationResult>;
  status(
    principal: CurrentHostPrincipal,
    binding: CurrentHostOperationBinding,
  ): Promise<CurrentHostManagementStatusResult>;
  lookupOperation(
    principal: CurrentHostPrincipal,
    binding: CurrentHostOperationBinding,
  ): Promise<CurrentHostOperationLookupOutcome>;
}

export type CurrentHostOperationsDependencies = {
  engine: Pick<CapletsEngine, "enabledServers">;
  control?: CurrentHostControlContext | undefined;
  activityLog: DashboardActivityLog | DashboardActivityRepository;
  remoteCredentialStore?: RemoteServerCredentialStore | undefined;
  remoteCredentialRepository?:
    | (RemoteCredentialRepository & { listClients(): Promise<RemoteClientStatus[]> })
    | undefined;
  remotePendingLoginRepository?: RemotePendingLoginRepository | undefined;
  vaultRepository?: VaultRepository | undefined;
  management?: CurrentHostManagementDependencies | undefined;
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
    async list(principal, request) {
      const operator = await authorizeCurrentHostManagementPrincipal(principal, request.binding);
      return executeCurrentHostManagementList(requireManagement(dependencies), operator, request);
    },
    async inspect(principal, request) {
      const operator = await authorizeCurrentHostManagementPrincipal(principal, request.binding);
      return executeCurrentHostManagementInspect(
        requireManagement(dependencies),
        operator,
        request,
      );
    },
    async preview(principal, request) {
      const operator = await authorizeCurrentHostManagementPrincipal(principal, request.binding);
      return executeCurrentHostManagementPreview(
        requireManagement(dependencies),
        operator,
        request,
      );
    },
    async mutate(principal, request) {
      const operator = await authorizeCurrentHostManagementPrincipal(principal, request.binding);
      return executeCurrentHostManagementMutation(
        requireManagement(dependencies),
        operator,
        request,
      );
    },
    async status(principal, binding) {
      await authorizeCurrentHostManagementPrincipal(principal, binding);
      const result = await requireManagement(dependencies).storage.status(binding);
      return result.status === "ok"
        ? { status: "ok", binding, health: result.health }
        : { ...result, binding };
    },
    async lookupOperation(principal, binding) {
      await authorizeCurrentHostManagementPrincipal(principal, binding);
      return requireManagement(dependencies).storage.lookupOperation(binding);
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
      return await clients.summary(await vault.valueCount(), operation);
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
    case "activity_list":
      return { kind: "activity_list", activity: await dependencies.activityLog.list(operation) };
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
      await dependencies.activityLog.append({
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

async function authorizeCurrentHostManagementPrincipal(
  principal: CurrentHostPrincipal,
  binding: CurrentHostOperationBinding,
): Promise<CurrentHostOperatorPrincipal> {
  assertOperatorPrincipal(principal);
  if (
    binding.actorId !== principal.clientId ||
    binding.target === "project" ||
    !binding.operationId ||
    !binding.logicalHostId ||
    !binding.storeId ||
    !binding.operationNamespace ||
    !binding.requestIdentity
  ) {
    throw new CapletsError(
      "AUTH_FAILED",
      "Current Host management requires an authorized target-bound operation.",
    );
  }
  const finalAuthorization = finalAuthorizeCurrentHostMutation(principal);
  if (finalAuthorization instanceof Promise) await finalAuthorization;
  return principal;
}

function requireManagement(
  dependencies: CurrentHostOperationsDependencies,
): CurrentHostManagementDependencies {
  if (dependencies.management) return dependencies.management;
  throw new CapletsError(
    "SERVER_UNAVAILABLE",
    "SQL Current Host management is unavailable before storage activation.",
  );
}

async function executeCurrentHostManagementList(
  management: CurrentHostManagementDependencies,
  _principal: CurrentHostOperatorPrincipal,
  request: CurrentHostManagementListRequest,
): Promise<CurrentHostManagementListResult> {
  const runtime = await loadAuthorizedManagementRuntime(management, request.binding);
  if ("status" in runtime) return runtime;
  const rows =
    request.resource === "caplet"
      ? Object.values(runtime.caplets).map((row) =>
          managementTargetDetail("caplet", row.id, "effective", row),
        )
      : Object.values(runtime.hostSettings).map((row) =>
          managementTargetDetail("host-setting", row.key, "effective", row),
        );
  return {
    status: "ok",
    binding: request.binding,
    resource: request.resource,
    items: rows.toSorted((left, right) => left.id.localeCompare(right.id)),
  };
}

async function executeCurrentHostManagementInspect(
  management: CurrentHostManagementDependencies,
  _principal: CurrentHostOperatorPrincipal,
  request: CurrentHostManagementInspectRequest,
): Promise<CurrentHostManagementInspectResult> {
  const loaded = await loadAuthorizedManagementSnapshots(management, request.binding);
  if ("status" in loaded) return loaded;
  const target = resolveManagementTarget(
    loaded.runtime,
    request.resource,
    request.id,
    request.selector,
  );
  if (!target) {
    return {
      status: "not_found",
      binding: request.binding,
      resource: request.resource,
      id: request.id,
      selector: request.selector,
    };
  }
  return {
    status: "ok",
    binding: request.binding,
    target: target.detail,
    record: managementRecord(loaded.sql, request.resource, request.id, request.selector),
  };
}

async function executeCurrentHostManagementPreview(
  management: CurrentHostManagementDependencies,
  _principal: CurrentHostOperatorPrincipal,
  request: CurrentHostManagementPreviewRequest,
): Promise<CurrentHostManagementPreviewResult> {
  const prepared = await prepareCurrentHostManagementMutation(management, request);
  if (prepared.kind === "replay") {
    return {
      status: "conflict",
      binding: request.binding,
      reason: "operation-reservation",
    };
  }
  if (prepared.kind === "result") return prepared.result;
  return {
    status: "preview",
    binding: request.binding,
    target: prepared.target,
    expectedAggregateVersion: prepared.expectedAggregateVersion,
    authorityToken: {
      authorityGeneration: prepared.runtime.authorityGeneration,
      effectiveGeneration: prepared.runtime.effectiveGeneration,
    },
    consequence: prepared.target.consequence,
  };
}

async function executeCurrentHostManagementMutation(
  management: CurrentHostManagementDependencies,
  _principal: CurrentHostOperatorPrincipal,
  request: CurrentHostManagementMutateRequest,
): Promise<CurrentHostManagementMutationResult> {
  const prepared = await prepareCurrentHostManagementMutation(management, request);
  if (prepared.kind === "replay") {
    return {
      status: "committed",
      binding: request.binding,
      receipt: prepared.receipt,
    };
  }
  if (prepared.kind === "result") {
    if (prepared.result.status === "preview") {
      throw new CapletsError("INTERNAL_ERROR", "Unexpected management preview result.");
    }
    return prepared.result;
  }
  const common = {
    binding: request.binding,
    aggregateId: managementMutationId(request.mutation),
    expectedAggregateVersion: prepared.expectedAggregateVersion,
    expectedAuthorityGeneration: prepared.runtime.authorityGeneration,
    expectedSecurityEpoch: prepared.runtime.securityEpoch,
    localApplication: management.applyCommitted
      ? ("pending" as const)
      : ("not-applicable" as const),
    managementTarget: prepared.target,
    provenance: {
      id: `provenance:${request.binding.operationId}`,
      sourceKind: "current-host-management",
      source: {
        surface: request.binding.target,
        resource: prepared.target.resource,
        selector: prepared.target.selector,
      },
      contentHash: managementRequestHash(request.mutation),
      installedAt: (management.now?.() ?? new Date()).toISOString(),
      ownerId: request.binding.actorId,
    },
    activity: {
      id: `activity:${request.binding.operationId}`,
      action: request.mutation.kind,
      target: {
        type: prepared.target.resource,
        id: prepared.target.id,
        selector: prepared.target.selector,
      },
      detail: {
        owner: prepared.target.owner,
        source: prepared.target.source.kind,
        effectiveChanged: prepared.target.effectiveChanged,
      },
    },
  };
  const result =
    request.mutation.kind === "host-setting-set"
      ? await management.storage.mutateHostSetting({
          ...common,
          setting: {
            version: 1,
            ...MutableHostSettingSchema.parse({
              key: request.mutation.key,
              value: request.mutation.value,
            }),
            updatedAt: (management.now?.() ?? new Date()).toISOString(),
          },
        })
      : await management.storage.mutateCaplet({
          ...common,
          ...capletMutationDocuments(
            prepared.sql,
            prepared.runtime,
            request.mutation,
            prepared.target,
            request.binding,
          ),
        });
  if (result.status === "indeterminate") {
    return {
      status: "unknown",
      binding: result.binding,
      retryAllowed: false,
      guidance: "lookup-original-target",
    };
  }
  if (result.status !== "committed") return { ...result, binding: request.binding };
  let localApplicationError: SafeErrorSummary | undefined;
  if (management.applyCommitted) {
    try {
      await management.applyCommitted(result.receipt);
    } catch (error) {
      localApplicationError = toCurrentHostSafeError(error);
    }
  }
  return {
    status: "committed",
    binding: request.binding,
    receipt: result.receipt,
    ...(localApplicationError ? { localApplicationError } : {}),
  };
}

type PreparedManagementMutation =
  | Readonly<{
      kind: "prepared";
      sql: ControlPlaneSnapshot;
      runtime: ControlPlaneRuntimeSnapshot;
      target: CurrentHostManagementTargetDetail;
      expectedAggregateVersion: number;
    }>
  | Readonly<{
      kind: "replay";
      receipt: CurrentHostOperationReceipt;
    }>
  | Readonly<{
      kind: "result";
      result: CurrentHostManagementPreviewResult;
    }>;

async function prepareCurrentHostManagementMutation(
  management: CurrentHostManagementDependencies,
  request: CurrentHostManagementPreviewRequest,
): Promise<PreparedManagementMutation> {
  validateManagementMutation(request.mutation);
  const aggregateId = managementMutationId(request.mutation);
  const reservation = await management.storage.reserveOperation(request.binding, aggregateId);
  if (reservation.status === "unavailable") {
    return { kind: "result", result: { status: "unavailable", binding: request.binding } };
  }
  if (reservation.status === "conflict") {
    return {
      kind: "result",
      result: {
        status: "conflict",
        binding: request.binding,
        reason: "operation-reservation",
      },
    };
  }
  if (reservation.status === "committed") {
    return { kind: "replay", receipt: reservation.receipt };
  }
  const loaded = await loadAuthorizedManagementSnapshots(management, request.binding);
  if ("status" in loaded) return { kind: "result", result: loaded };
  const resource = managementMutationResource(request.mutation);
  const id = managementMutationId(request.mutation);
  const target = resolveManagementTarget(loaded.runtime, resource, id, request.mutation.selector);
  if (!target) {
    return {
      kind: "result",
      result: {
        status: "not_found",
        binding: request.binding,
        resource,
        id,
        selector: request.mutation.selector,
      },
    };
  }
  if (target.rejected) {
    return {
      kind: "result",
      result: {
        status: "rejected",
        binding: request.binding,
        reason: "filesystem-owned",
        target: target.detail,
      },
    };
  }
  if (
    request.mutation.expectedAuthorityToken &&
    (request.mutation.expectedAuthorityToken.authorityGeneration !==
      loaded.runtime.authorityGeneration ||
      request.mutation.expectedAuthorityToken.effectiveGeneration !==
        loaded.runtime.effectiveGeneration)
  ) {
    return {
      kind: "result",
      result: {
        status: "conflict",
        binding: request.binding,
        reason:
          request.mutation.expectedAuthorityToken.authorityGeneration !==
          loaded.runtime.authorityGeneration
            ? "authority-generation"
            : "effective-generation",
      },
    };
  }
  const expectedAggregateVersion =
    request.mutation.expectedAggregateVersion ??
    aggregateVersionForManagement(loaded.sql, resource, id);
  return {
    kind: "prepared",
    sql: loaded.sql,
    runtime: loaded.runtime,
    target: target.detail,
    expectedAggregateVersion,
  };
}

async function loadAuthorizedManagementSnapshots(
  management: CurrentHostManagementDependencies,
  binding: CurrentHostOperationBinding,
): Promise<
  | Readonly<{ sql: ControlPlaneSnapshot; runtime: ControlPlaneRuntimeSnapshot }>
  | CurrentHostManagementFailure
> {
  const loaded = await management.storage.loadSnapshot(binding);
  if (loaded.status !== "ok") return loaded;
  const runtime = await loadAuthorizedManagementRuntime(management, binding);
  if ("status" in runtime) return runtime;
  return { sql: loaded.snapshot, runtime };
}

async function loadAuthorizedManagementRuntime(
  management: CurrentHostManagementDependencies,
  binding: CurrentHostOperationBinding,
): Promise<ControlPlaneRuntimeSnapshot | CurrentHostManagementFailure> {
  try {
    const runtime = await management.loadRuntimeSnapshot();
    if (
      runtime.identity.logicalHostId !== binding.logicalHostId ||
      runtime.identity.storeId !== binding.storeId ||
      runtime.identity.operationNamespace !== binding.operationNamespace
    ) {
      return { status: "denied", binding, reason: "stale-authority" };
    }
    return runtime;
  } catch {
    return { status: "unavailable", binding };
  }
}

function resolveManagementTarget(
  runtime: ControlPlaneRuntimeSnapshot,
  resource: CurrentHostManagementResource,
  id: string,
  selector: "effective" | "underlying-sql",
): Readonly<{ detail: CurrentHostManagementTargetDetail; rejected: boolean }> | undefined {
  const row = resource === "caplet" ? runtime.caplets[id] : runtime.hostSettings[id];
  if (!row) return undefined;
  const resolution =
    resource === "caplet"
      ? resolveControlPlaneCapletMutationTarget(runtime, id, {
          underlyingSql: selector === "underlying-sql",
        })
      : resolveControlPlaneHostSettingMutationTarget(runtime, id, {
          underlyingSql: selector === "underlying-sql",
        });
  if (resolution.status === "not-found") return undefined;
  return {
    detail: managementTargetDetail(
      resource,
      id,
      selector,
      row,
      resolution.status === "allowed" ? resolution.effectiveChanged : false,
    ),
    rejected: resolution.status === "rejected",
  };
}

function managementTargetDetail(
  resource: CurrentHostManagementResource,
  id: string,
  selector: "effective" | "underlying-sql",
  row: Readonly<{
    owner: "sql" | "filesystem";
    source: RuntimeOwnershipLayer["source"];
    effective: boolean;
    shadowChain: readonly RuntimeOwnershipLayer[];
    underlyingSql?: RuntimeOwnershipLayer | undefined;
  }>,
  effectiveChanged = row.owner === "sql" && row.effective,
): CurrentHostManagementTargetDetail {
  const selected =
    selector === "underlying-sql" && row.owner === "filesystem" ? row.underlyingSql : row;
  if (!selected) {
    throw new CapletsError("REQUEST_INVALID", "The underlying SQL record does not exist.");
  }
  const consequence = effectiveChanged
    ? "effective-runtime-changes"
    : "no-effective-change-while-shadowed";
  return Object.freeze({
    resource,
    id,
    selector,
    owner: selected.owner,
    source: { kind: selected.source.kind },
    effective: row.effective,
    effectiveChanged,
    shadowChain: row.shadowChain.map(safeOwnershipLayer),
    underlyingSqlAvailable: row.owner === "sql" || row.underlyingSql !== undefined,
    consequence,
  });
}

function safeOwnershipLayer(layer: RuntimeOwnershipLayer): CurrentHostOwnershipLayer {
  return {
    owner: layer.owner,
    source: { kind: layer.source.kind },
    ...(layer.provenance?.id ? { provenance: { id: layer.provenance.id } } : {}),
  };
}

function managementRecord(
  snapshot: ControlPlaneSnapshot,
  resource: CurrentHostManagementResource,
  id: string,
  selector: "effective" | "underlying-sql",
): Readonly<Record<string, unknown>> {
  if (resource === "host-setting") {
    const setting = snapshot.hostSettings.find((row) => row.key === id);
    return setting && selector === "underlying-sql"
      ? {
          key: setting.key,
          value: setting.value,
          updatedAt: setting.updatedAt,
          aggregateVersion: snapshot.hostSettingVersions?.[id] ?? 0,
        }
      : {};
  }
  const caplet = snapshot.caplets.find((row) => row.aggregate.id === id)?.aggregate;
  return caplet && selector === "underlying-sql"
    ? {
        id: caplet.id,
        name: caplet.portable.name,
        description: caplet.portable.description,
        activation: caplet.activation,
        updateState: caplet.updateState,
        aggregateVersion: caplet.aggregateVersion,
      }
    : {};
}

function aggregateVersionForManagement(
  snapshot: ControlPlaneSnapshot,
  resource: CurrentHostManagementResource,
  id: string,
): number {
  if (resource === "caplet") {
    return snapshot.caplets.find((row) => row.aggregate.id === id)?.aggregate.aggregateVersion ?? 0;
  }
  return snapshot.hostSettingVersions?.[id] ?? 0;
}

function capletMutationDocuments(
  snapshot: ControlPlaneSnapshot,
  runtime: ControlPlaneRuntimeSnapshot,
  mutation: Extract<CurrentHostManagementMutation, { kind: "caplet-set-activation" }>,
  target: CurrentHostManagementTargetDetail,
  binding: CurrentHostOperationBinding,
): Readonly<{
  aggregate: CanonicalCapletAggregate;
  projection: CanonicalCapletRelationalProjection;
}> {
  const stored = snapshot.caplets.find((row) => row.aggregate.id === mutation.id);
  if (!stored) throw new CapletsError("REQUEST_INVALID", "The SQL Caplet does not exist.");
  const aggregateVersion = stored.aggregate.aggregateVersion + 1;
  const wasEffective = target.effectiveChanged && stored.aggregate.activation === "active";
  const willBeEffective = target.effectiveChanged && mutation.activation === "active";
  const aggregate: CanonicalCapletAggregate = {
    ...stored.aggregate,
    aggregateVersion,
    ownership: "sql",
    activation: mutation.activation,
    effective: willBeEffective,
  };
  const previous = stored.projection.activationHistory.at(-1);
  const projection: CanonicalCapletRelationalProjection = {
    ...stored.projection,
    activationHistory: [
      ...stored.projection.activationHistory,
      {
        capletId: mutation.id,
        sequence: stored.projection.activationHistory.length + 1,
        from: previous?.to ?? stored.aggregate.activation,
        to: mutation.activation,
        reason: activationReason(mutation.activation),
        actorId: binding.actorId,
        aggregateVersion,
        authorityVersion: runtime.authorityGeneration,
        effectiveVersion: runtime.effectiveGeneration + (wasEffective === willBeEffective ? 0 : 1),
        occurredAt: new Date().toISOString(),
      },
    ],
  };
  return { aggregate, projection };
}

function activationReason(
  activation: CapletActivationState,
): CanonicalCapletRelationalProjection["activationHistory"][number]["reason"] {
  switch (activation) {
    case "active":
      return "enabled";
    case "disabled":
      return "disabled";
    case "setup-required":
      return "setup-required";
    case "dormant-shadowed":
      return "filesystem-shadowed";
  }
}

function validateManagementMutation(mutation: CurrentHostManagementMutation): void {
  if (mutation.kind === "host-setting-set") {
    MutableHostSettingSchema.parse({ key: mutation.key, value: mutation.value });
  } else if (
    !["active", "setup-required", "dormant-shadowed", "disabled"].includes(mutation.activation)
  ) {
    throw new CapletsError("REQUEST_INVALID", "Unsupported SQL Caplet activation state.");
  }
  if (mutation.selector !== "effective" && mutation.selector !== "underlying-sql") {
    throw new CapletsError("REQUEST_INVALID", "Unsupported Current Host mutation selector.");
  }
}

function managementMutationResource(
  mutation: CurrentHostManagementMutation,
): CurrentHostManagementResource {
  return mutation.kind === "host-setting-set" ? "host-setting" : "caplet";
}

function managementMutationId(mutation: CurrentHostManagementMutation): string {
  return mutation.kind === "host-setting-set" ? mutation.key : mutation.id;
}

function managementRequestHash(mutation: CurrentHostManagementMutation): string {
  return createHash("sha256").update(JSON.stringify(mutation)).digest("hex");
}

function parseExpectedAuthorityToken(value: unknown): CurrentHostAuthorityToken | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.authorityGeneration) ||
    Number(value.authorityGeneration) < 0 ||
    !Number.isSafeInteger(value.effectiveGeneration) ||
    Number(value.effectiveGeneration) < 0
  ) {
    throw new CapletsError("REQUEST_INVALID", "Current Host expected authority token is invalid.");
  }
  return {
    authorityGeneration: Number(value.authorityGeneration),
    effectiveGeneration: Number(value.effectiveGeneration),
  };
}

function boundedNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Current Host aggregate version must be a non-negative integer.",
    );
  }
  return Number(value);
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
