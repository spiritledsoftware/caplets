import { CapletsError } from "../errors";
import {
  authoritySnapshotForMutation,
  commitCurrentHostMutation,
  currentHostMutationReplayValue,
  lookupCurrentHostMutationReceipt,
  type CurrentHostOperation,
  type CurrentHostOperationOutcome,
  type CurrentHostOperatorPrincipal,
  type CurrentHostOperationsDependencies,
} from "./operations";

export type CurrentHostServeSettings = {
  host?: string;
  port?: number;
  path?: string;
  publicOrigins?: string[];
  trustProxy?: boolean;
};

export type CurrentHostCompletionSettings = {
  discoveryTimeoutMs?: number;
  overallTimeoutMs?: number;
  cacheTtlMs?: number;
  negativeCacheTtlMs?: number;
};

export type CurrentHostOptionsSettings = {
  exposure?:
    | "direct"
    | "progressive"
    | "code_mode"
    | "direct_and_code_mode"
    | "progressive_and_code_mode";
  exposureDiscoveryTimeoutMs?: number;
  exposureDiscoveryConcurrency?: number;
};

/** Structured settings intentionally exclude authority, credentials, and Caplet maps. */
export type CurrentHostSettingsPatch = {
  telemetry?: boolean;
  defaultSearchLimit?: number;
  maxSearchLimit?: number;
  serve?: CurrentHostServeSettings;
  completion?: CurrentHostCompletionSettings;
  options?: CurrentHostOptionsSettings;
};

type SettingsGetOperation = Extract<CurrentHostOperation, { kind: "settings_get" }>;
type SettingsUpdateOperation = Extract<CurrentHostOperation, { kind: "settings_update" }>;
type SetupOperation = Extract<CurrentHostOperation, { kind: "setup_grant" | "setup_revoke" }>;
type SettingsGetOutcome = Extract<CurrentHostOperationOutcome, { kind: "settings_get" }>;
type SettingsUpdateOutcome = Extract<CurrentHostOperationOutcome, { kind: "settings_update" }>;
type SetupOutcome = Extract<CurrentHostOperationOutcome, { kind: "setup_grant" | "setup_revoke" }>;
type SetupApproval = SetupOutcome["approval"];

export interface CurrentHostSettingsOperations {
  get(operation: SettingsGetOperation): Promise<SettingsGetOutcome>;
  update(
    principal: CurrentHostOperatorPrincipal,
    operation: SettingsUpdateOperation,
  ): Promise<SettingsUpdateOutcome>;
  setup(principal: CurrentHostOperatorPrincipal, operation: SetupOperation): Promise<SetupOutcome>;
}

export function createCurrentHostSettingsOperations(
  dependencies: CurrentHostOperationsDependencies,
): CurrentHostSettingsOperations {
  return {
    get: async (_operation) => ({
      kind: "settings_get",
      settings: settingsFromSnapshot(dependencies.activeGeneration?.snapshot),
    }),
    update: async (principal, operation) => {
      validateSettingsPatch(operation.settings);
      const preflight = await lookupCurrentHostMutationReceipt(dependencies, principal, operation);
      const snapshot = authoritySnapshotForMutation(dependencies);
      const nextSettings = {
        ...settingsFromSnapshot(snapshot),
        ...structuredClone(operation.settings),
      };
      snapshot.settings = nextSettings;
      if (isRecord(snapshot.config)) {
        snapshot.config = applyConfigPatch(snapshot.config, operation.settings);
      }
      const receipt = await commitCurrentHostMutation(
        dependencies,
        principal,
        operation,
        { kind: "settings_update", settings: operation.settings },
        snapshot,
        preflight,
        nextSettings,
      );
      const replayed = currentHostMutationReplayValue(preflight?.receipt.result);
      return {
        kind: "settings_update",
        settings: isRecord(replayed) ? (replayed as CurrentHostSettingsPatch) : nextSettings,
        ...receipt,
      };
    },
    setup: async (principal, operation) => {
      validateSetupOperation(operation);
      const preflight = await lookupCurrentHostMutationReceipt(dependencies, principal, operation);
      const snapshot = authoritySnapshotForMutation(dependencies);
      const approvals = setupApprovals(snapshot);
      const key = setupApprovalKey(operation);
      if (preflight) {
        const receipt = await commitCurrentHostMutation(
          dependencies,
          principal,
          operation,
          { kind: operation.kind, key },
          snapshot,
          preflight,
        );
        const replayed = currentHostMutationReplayValue(preflight.receipt.result);
        const existing = approvals[key];
        const approval = isSetupApproval(replayed)
          ? replayed
          : isSetupApproval(existing)
            ? existing
            : createSetupApproval(operation, new Date().toISOString());
        return { kind: operation.kind, approval, ...receipt };
      }
      const now = new Date().toISOString();
      const approval = createSetupApproval(operation, now);
      approvals[key] = approval;
      snapshot.setupApprovals = approvals;
      const activities = Array.isArray(snapshot.setupActivity)
        ? snapshot.setupActivity.slice()
        : [];
      activities.push({
        kind: "setup_approval",
        decision: approval.decision,
        projectFingerprint: approval.projectFingerprint,
        capletId: approval.capletId,
        contentHash: approval.contentHash,
        targetKind: approval.targetKind,
        actor: operation.actor ?? "ui",
        occurredAt: now,
        expectedGeneration: operation.expectedGeneration ?? null,
      });
      snapshot.setupActivity = activities.slice(-10_000);
      const receipt = await commitCurrentHostMutation(
        dependencies,
        principal,
        operation,
        { kind: operation.kind, key, approval },
        snapshot,
        undefined,
        approval,
      );
      return { kind: operation.kind, approval, ...receipt };
    },
  };
}

function createSetupApproval(operation: SetupOperation, approvedAt: string): SetupApproval {
  return {
    projectFingerprint: operation.projectFingerprint ?? "default",
    capletId: operation.capletId,
    contentHash: operation.contentHash,
    targetKind: operation.targetKind,
    decision: operation.kind === "setup_grant" ? "grant" : "revoke",
    approvedAt,
  };
}

function isSetupApproval(value: unknown): value is SetupApproval {
  if (!isRecord(value)) return false;
  return (
    typeof value.projectFingerprint === "string" &&
    typeof value.capletId === "string" &&
    typeof value.contentHash === "string" &&
    (value.targetKind === "local_host" ||
      value.targetKind === "remote_host" ||
      value.targetKind === "hosted_sandbox") &&
    (value.decision === "grant" || value.decision === "revoke") &&
    typeof value.approvedAt === "string"
  );
}
function settingsFromSnapshot(snapshot: unknown): CurrentHostSettingsPatch {
  if (!isRecord(snapshot)) return {};
  const direct = isRecord(snapshot.settings) ? snapshot.settings : {};
  const config = isRecord(snapshot.config) ? snapshot.config : {};
  const settings: CurrentHostSettingsPatch = {};
  if (typeof direct.telemetry === "boolean") settings.telemetry = direct.telemetry;
  else if (typeof config.telemetry === "boolean") settings.telemetry = config.telemetry;
  for (const key of ["defaultSearchLimit", "maxSearchLimit"] as const) {
    const value = direct[key] ?? config[key];
    if (typeof value === "number") settings[key] = value;
  }
  if (isRecord(direct.serve) || isRecord(config.serve))
    settings.serve = mergeServeSettings(config.serve, direct.serve);
  if (isRecord(direct.completion) || isRecord(config.completion)) {
    settings.completion = mergeNumericSettings(config.completion, direct.completion, [
      "discoveryTimeoutMs",
      "overallTimeoutMs",
      "cacheTtlMs",
      "negativeCacheTtlMs",
    ]);
  }
  if (isRecord(direct.options) || isRecord(config.options)) {
    const numeric = mergeNumericSettings(config.options, direct.options, [
      "exposureDiscoveryTimeoutMs",
      "exposureDiscoveryConcurrency",
    ]);
    const options: CurrentHostOptionsSettings = {
      ...(typeof numeric.exposureDiscoveryTimeoutMs === "number"
        ? { exposureDiscoveryTimeoutMs: numeric.exposureDiscoveryTimeoutMs }
        : {}),
      ...(typeof numeric.exposureDiscoveryConcurrency === "number"
        ? { exposureDiscoveryConcurrency: numeric.exposureDiscoveryConcurrency }
        : {}),
    };
    const directExposure = isRecord(direct.options) ? direct.options.exposure : undefined;
    const configExposure = isRecord(config.options) ? config.options.exposure : undefined;
    if (isExposure(directExposure)) options.exposure = directExposure;
    else if (isExposure(configExposure)) options.exposure = configExposure;
    settings.options = options;
  }
  return settings;
}

function applyConfigPatch(
  config: Record<string, unknown>,
  patch: CurrentHostSettingsPatch,
): Record<string, unknown> {
  const next = structuredClone(config);
  for (const key of ["telemetry", "defaultSearchLimit", "maxSearchLimit"] as const) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  if (patch.serve) next.serve = { ...(isRecord(next.serve) ? next.serve : {}), ...patch.serve };
  if (patch.completion)
    next.completion = {
      ...(isRecord(next.completion) ? next.completion : {}),
      ...patch.completion,
    };
  if (patch.options)
    next.options = { ...(isRecord(next.options) ? next.options : {}), ...patch.options };
  return next;
}

function validateSettingsPatch(patch: CurrentHostSettingsPatch): void {
  if (!isRecord(patch))
    throw new CapletsError("REQUEST_INVALID", "Settings must be a structured object.");
  const allowed = new Set([
    "telemetry",
    "defaultSearchLimit",
    "maxSearchLimit",
    "serve",
    "completion",
    "options",
  ]);
  for (const key of Object.keys(patch))
    if (!allowed.has(key))
      throw new CapletsError("REQUEST_INVALID", `Setting ${key} is not editable.`);
  if (patch.telemetry !== undefined && typeof patch.telemetry !== "boolean")
    throw new CapletsError("REQUEST_INVALID", "telemetry must be a boolean.");
  validatePositiveInteger(patch.defaultSearchLimit, "defaultSearchLimit", 50);
  validatePositiveInteger(patch.maxSearchLimit, "maxSearchLimit", 50);
  if (
    patch.defaultSearchLimit !== undefined &&
    patch.maxSearchLimit !== undefined &&
    patch.defaultSearchLimit > patch.maxSearchLimit
  ) {
    throw new CapletsError("REQUEST_INVALID", "defaultSearchLimit must be <= maxSearchLimit.");
  }
  if (patch.serve !== undefined) {
    const allowedServe = new Set(["host", "port", "path", "publicOrigins", "trustProxy"]);
    for (const key of Object.keys(patch.serve))
      if (!allowedServe.has(key))
        throw new CapletsError("REQUEST_INVALID", `Serve setting ${key} is not editable.`);
    if (
      patch.serve.host !== undefined &&
      (typeof patch.serve.host !== "string" || patch.serve.host.length === 0)
    )
      throw new CapletsError("REQUEST_INVALID", "serve.host must be a non-empty string.");
    if (
      patch.serve.path !== undefined &&
      (typeof patch.serve.path !== "string" ||
        patch.serve.path.length === 0 ||
        !patch.serve.path.startsWith("/"))
    )
      throw new CapletsError("REQUEST_INVALID", "serve.path must be an absolute path.");
    if (patch.serve.port !== undefined)
      validatePositiveInteger(patch.serve.port, "serve.port", 65_535);
    if (
      patch.serve.publicOrigins !== undefined &&
      (!Array.isArray(patch.serve.publicOrigins) ||
        !patch.serve.publicOrigins.every((value) => typeof value === "string"))
    )
      throw new CapletsError("REQUEST_INVALID", "serve.publicOrigins must be an array of strings.");
    if (patch.serve.trustProxy !== undefined && typeof patch.serve.trustProxy !== "boolean")
      throw new CapletsError("REQUEST_INVALID", "serve.trustProxy must be a boolean.");
  }
  validateNumericSettings(patch.completion, "completion", [
    "discoveryTimeoutMs",
    "overallTimeoutMs",
    "cacheTtlMs",
    "negativeCacheTtlMs",
  ]);
  validateNumericSettings(
    patch.options,
    "options",
    ["exposureDiscoveryTimeoutMs", "exposureDiscoveryConcurrency"],
    ["exposure"],
  );
  if (
    patch.options?.exposure !== undefined &&
    ![
      "direct",
      "progressive",
      "code_mode",
      "direct_and_code_mode",
      "progressive_and_code_mode",
    ].includes(patch.options.exposure)
  )
    throw new CapletsError("REQUEST_INVALID", "options.exposure is invalid.");
}

function validateNumericSettings(
  value: Record<string, unknown> | undefined,
  name: string,
  keys: string[],
  stringKeys: string[] = [],
): void {
  if (value === undefined) return;
  const allowed = new Set([...keys, ...stringKeys]);
  for (const key of Object.keys(value))
    if (!allowed.has(key))
      throw new CapletsError("REQUEST_INVALID", `${name}.${key} is not editable.`);
  for (const key of keys) {
    const entry = value[key];
    if (entry !== undefined)
      validatePositiveInteger(entry, `${name}.${key}`, Number.MAX_SAFE_INTEGER);
  }
}

function validatePositiveInteger(value: unknown, name: string, max: number): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max)
    throw new CapletsError("REQUEST_INVALID", `${name} must be a positive integer.`);
}

function mergeServeSettings(configValue: unknown, directValue: unknown): CurrentHostServeSettings {
  const config = isRecord(configValue) ? configValue : {};
  const direct = isRecord(directValue) ? directValue : {};
  const merged: CurrentHostServeSettings = {};
  for (const key of ["host", "path"] as const) {
    const value = direct[key] ?? config[key];
    if (typeof value === "string") merged[key] = value;
  }
  for (const key of ["port"] as const) {
    const value = direct[key] ?? config[key];
    if (typeof value === "number") merged[key] = value;
  }
  const origins = direct.publicOrigins ?? config.publicOrigins;
  if (Array.isArray(origins) && origins.every((value) => typeof value === "string"))
    merged.publicOrigins = origins;
  const trustProxy = direct.trustProxy ?? config.trustProxy;
  if (typeof trustProxy === "boolean") merged.trustProxy = trustProxy;
  return merged;
}

function mergeNumericSettings(
  configValue: unknown,
  directValue: unknown,
  keys: string[],
): Record<string, number> {
  const config = isRecord(configValue) ? configValue : {};
  const direct = isRecord(directValue) ? directValue : {};
  const merged: Record<string, number> = {};
  for (const key of keys) {
    const value = direct[key] ?? config[key];
    if (typeof value === "number") merged[key] = value;
  }
  return merged;
}

function setupApprovals(
  snapshot: Record<string, unknown>,
): Record<string, Record<string, unknown>> {
  const value = snapshot.setupApprovals;
  if (!isRecord(value)) return {};
  const approvals: Record<string, Record<string, unknown>> = {};
  for (const [key, approval] of Object.entries(value))
    if (isRecord(approval)) approvals[key] = approval;
  return approvals;
}

function setupApprovalKey(operation: SetupOperation): string {
  return [
    operation.projectFingerprint ?? "default",
    operation.capletId,
    operation.contentHash,
    operation.targetKind,
  ]
    .map((value) => encodeURIComponent(value))
    .join("/");
}

function validateSetupOperation(operation: SetupOperation): void {
  if (!/^[A-Za-z0-9._:-]{1,256}$/u.test(operation.capletId))
    throw new CapletsError("REQUEST_INVALID", "Setup Caplet ID is invalid.");
  if (
    typeof operation.contentHash !== "string" ||
    operation.contentHash.length < 8 ||
    operation.contentHash.length > 256
  )
    throw new CapletsError("REQUEST_INVALID", "Setup content hash is invalid.");
  if (!["local_host", "remote_host", "hosted_sandbox"].includes(operation.targetKind))
    throw new CapletsError("REQUEST_INVALID", "Setup target kind is invalid.");
}

function isExposure(value: unknown): value is NonNullable<CurrentHostOptionsSettings["exposure"]> {
  return (
    value === "direct" ||
    value === "progressive" ||
    value === "code_mode" ||
    value === "direct_and_code_mode" ||
    value === "progressive_and_code_mode"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
