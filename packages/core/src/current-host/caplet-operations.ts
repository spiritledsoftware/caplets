import { SERVER_ID_PATTERN } from "../config/validation";
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
import { currentHostInstalledCaplets, type CurrentHostInstalledCapletProjection } from "./catalog";
import type { AuthorityCapletRecord } from "../storage/bundle-cache";
import { authorityRecords, type AuthoritySnapshot } from "../storage/composition";

type CapletCreateOperation = Extract<CurrentHostOperation, { kind: "caplet_create" }>;
type CapletUpdateOperation = Extract<CurrentHostOperation, { kind: "caplet_update" }>;
type CapletDeleteOperation = Extract<CurrentHostOperation, { kind: "caplet_delete" }>;
type CapletsListOperation = Extract<CurrentHostOperation, { kind: "caplets_list" }>;

type CapletMutationOutcome = Extract<
  CurrentHostOperationOutcome,
  { kind: "caplet_create" | "caplet_update" | "caplet_delete" }
>;
type CapletsListOutcome = Extract<CurrentHostOperationOutcome, { kind: "caplets_list" }>;

export interface CurrentHostCapletOperations {
  list(operation: CapletsListOperation): CapletsListOutcome;
  create(
    principal: CurrentHostOperatorPrincipal,
    operation: CapletCreateOperation,
  ): Promise<CapletMutationOutcome>;
  update(
    principal: CurrentHostOperatorPrincipal,
    operation: CapletUpdateOperation,
  ): Promise<CapletMutationOutcome>;
  delete(
    principal: CurrentHostOperatorPrincipal,
    operation: CapletDeleteOperation,
  ): Promise<CapletMutationOutcome>;
}

export function createCurrentHostCapletOperations(
  dependencies: CurrentHostOperationsDependencies,
): CurrentHostCapletOperations {
  return {
    list: (_operation) => {
      const listed = currentHostInstalledCaplets(dependencies.engine.enabledServers(), {
        globalLockfilePath: dependencies.control?.globalLockfilePath,
      });
      return {
        kind: "caplets_list",
        caplets: listed.map((caplet) => {
          const staged = dependencies.stagedProvenance?.[caplet.id];
          const authority = isAuthorityCaplet(dependencies.activeGeneration?.snapshot, caplet.id);
          return {
            ...caplet,
            ...(staged
              ? {
                  mutable: false,
                  reserved: true,
                  provenance: { kind: staged.kind, ...(staged.path ? { path: staged.path } : {}) },
                }
              : authority
                ? {
                    mutable: true,
                    reserved: false,
                    provenance: {
                      kind: "authority",
                      authorityId: dependencies.activeGeneration?.authorityId ?? "current-host",
                      generationId: dependencies.activeGeneration?.id ?? "unknown",
                    },
                  }
                : {}),
          } as CurrentHostInstalledCapletProjection;
        }),
      };
    },
    create: async (principal, operation) =>
      await mutateCaplet(dependencies, principal, operation, "caplet_create"),
    update: async (principal, operation) =>
      await mutateCaplet(dependencies, principal, operation, "caplet_update"),
    delete: async (principal, operation) => {
      assertCapletId(operation.id);
      const preflight = await lookupCurrentHostMutationReceipt(dependencies, principal, operation);
      const snapshot = authoritySnapshotForMutation(dependencies);
      if (preflight) {
        const receipt = await commitCurrentHostMutation(
          dependencies,
          principal,
          operation,
          { kind: "delete_caplet", id: operation.id },
          snapshot,
          preflight,
          { deleted: true },
        );
        return {
          kind: "caplet_delete",
          deleted: true,
          ...receipt,
        };
      }
      assertNotStaged(dependencies, operation.id);
      const caplets = capletRecords(snapshot);
      if (!caplets[operation.id]) {
        throw new CapletsError(
          "CONFIG_NOT_FOUND",
          `Authority Caplet ${operation.id} does not exist.`,
        );
      }
      delete caplets[operation.id];
      snapshot.caplets = caplets;
      const receipt = await commitCurrentHostMutation(
        dependencies,
        principal,
        operation,
        { kind: "delete_caplet", id: operation.id },
        snapshot,
        undefined,
        { deleted: true },
      );
      return {
        kind: "caplet_delete",
        deleted: true,
        ...receipt,
      };
    },
  };
}

async function mutateCaplet(
  dependencies: CurrentHostOperationsDependencies,
  principal: CurrentHostOperatorPrincipal,
  operation: CapletCreateOperation | CapletUpdateOperation,
  kind: "caplet_create" | "caplet_update",
): Promise<CapletMutationOutcome> {
  assertCapletId(operation.record.id);
  if (kind === "caplet_update") {
    const updateOperation = operation as CapletUpdateOperation;
    assertCapletId(updateOperation.id);
    if (updateOperation.id !== updateOperation.record.id) {
      throw new CapletsError("REQUEST_INVALID", "Caplet update id must match record.id.");
    }
  }
  const preflight = await lookupCurrentHostMutationReceipt(dependencies, principal, operation);
  const snapshot = authoritySnapshotForMutation(dependencies);
  if (preflight) {
    const receipt = await commitCurrentHostMutation(
      dependencies,
      principal,
      operation,
      { kind, id: operation.record.id, record: operation.record },
      snapshot,
      preflight,
      projectionForRecord(operation.record),
    );
    const replayed = currentHostMutationReplayValue(preflight.receipt.result);
    return {
      kind,
      caplet: isRecord(replayed)
        ? (replayed as CurrentHostInstalledCapletProjection)
        : projectionForRecord(operation.record),
      ...receipt,
    };
  }
  assertNotStaged(dependencies, operation.record.id);
  const caplets = capletRecords(snapshot);
  const exists = Boolean(caplets[operation.record.id]);
  if (kind === "caplet_create" && exists) {
    throw new CapletsError(
      "CONFIG_EXISTS",
      `Authority Caplet ${operation.record.id} already exists.`,
    );
  }
  if (kind === "caplet_update" && !exists) {
    throw new CapletsError(
      "CONFIG_NOT_FOUND",
      `Authority Caplet ${operation.record.id} does not exist.`,
    );
  }
  const nextRecord = normalizeDashboardRecord(operation.record, caplets[operation.record.id]);
  caplets[operation.record.id] = nextRecord;
  snapshot.caplets = caplets;
  const receipt = await commitCurrentHostMutation(
    dependencies,
    principal,
    operation,
    { kind, id: operation.record.id, record: nextRecord },
    snapshot,
    undefined,
    projectionForRecord(nextRecord),
  );
  return {
    kind,
    caplet: projectionForRecord(nextRecord),
    ...receipt,
  };
}
function normalizeDashboardRecord(
  record: AuthorityCapletRecord,
  existing: AuthorityCapletRecord | undefined,
): AuthorityCapletRecord {
  const requestedConfig = isRecord(record.config) ? record.config : undefined;
  const existingConfig = isRecord(existing?.config) ? existing.config : undefined;
  const requestedMcp = requestedConfig ? mcpConfigForRecord(requestedConfig, record.id) : undefined;
  const existingMcp = existingConfig ? mcpConfigForRecord(existingConfig, record.id) : undefined;
  if (!requestedMcp || !existingMcp || !existingConfig) return structuredClone(record);
  const existingServers = isRecord(existingConfig.mcpServers) ? existingConfig.mcpServers : {};
  return {
    ...structuredClone(record),
    config: {
      ...structuredClone(existingConfig),
      mcpServers: {
        ...structuredClone(existingServers),
        [record.id]: { ...structuredClone(existingMcp), ...structuredClone(requestedMcp) },
      },
    },
  };
}

function capletRecords(snapshot: Record<string, unknown>): Record<string, AuthorityCapletRecord> {
  return Object.fromEntries(authorityRecords(snapshot as AuthoritySnapshot));
}

function projectionForRecord(record: AuthorityCapletRecord): CurrentHostInstalledCapletProjection {
  const config = isRecord(record.config) ? record.config : {};
  const mcp = mcpConfigForRecord(config, record.id);
  const name =
    typeof record.name === "string"
      ? record.name
      : typeof mcp?.name === "string"
        ? mcp.name
        : typeof config.name === "string"
          ? config.name
          : record.id;
  const description =
    typeof record.description === "string"
      ? record.description
      : typeof mcp?.description === "string"
        ? mcp.description
        : typeof config.description === "string"
          ? config.description
          : "Authority-managed Caplet";
  const backend = mcp ? "mcp" : typeof config.backend === "string" ? config.backend : "authority";
  const backendConfig: CurrentHostInstalledCapletProjection["backendConfig"] =
    mcp && (mcp.transport === "stdio" || mcp.transport === "http" || mcp.transport === "sse")
      ? {
          transport: mcp.transport as "stdio" | "http" | "sse",
          ...(typeof mcp.command === "string" ? { command: mcp.command } : {}),
          ...(Array.isArray(mcp.args)
            ? { args: mcp.args.filter((value): value is string => typeof value === "string") }
            : {}),
          ...(typeof mcp.url === "string" ? { url: mcp.url } : {}),
        }
      : undefined;
  return {
    id: record.id,
    name,
    description,
    backend,
    exposure: (typeof mcp?.exposure === "string"
      ? mcp.exposure
      : "code_mode") as CurrentHostInstalledCapletProjection["exposure"],
    setupRequired: Boolean(mcp?.setup ?? config.setup),
    authRequired: Boolean(mcp?.auth ?? config.auth),
    projectBindingRequired: Boolean(mcp?.projectBinding ?? config.projectBinding),
    ...(backendConfig ? { backendConfig } : {}),
    source: `authority://${record.id}`,
    updateState: "unknown",
    setupActions: [],
    mutable: true,
    reserved: false,
    provenance: { kind: "authority" },
  };
}

function mcpConfigForRecord(
  config: Record<string, unknown>,
  id: string,
): Record<string, unknown> | undefined {
  const servers = config.mcpServers;
  if (!isRecord(servers) || !isRecord(servers[id])) return undefined;
  return servers[id];
}

function isAuthorityCaplet(snapshot: unknown, id: string): boolean {
  if (!isRecord(snapshot)) return false;
  return authorityRecords(snapshot as AuthoritySnapshot).some(([recordId]) => recordId === id);
}

function assertCapletId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !SERVER_ID_PATTERN.test(value)) {
    throw new CapletsError("REQUEST_INVALID", "Caplet ID is invalid.");
  }
}

function assertNotStaged(dependencies: CurrentHostOperationsDependencies, id: string): void {
  const provenance = dependencies.stagedProvenance?.[id];
  if (!provenance) return;
  throw new CapletsError(
    "CONFIG_INVALID",
    `Caplet ID ${id} is reserved by a staged filesystem source.`,
    {
      id,
      staged: true,
      authority: false,
      provenance: {
        kind: provenance.kind,
        ...(provenance.path ? { path: provenance.path } : {}),
      },
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
