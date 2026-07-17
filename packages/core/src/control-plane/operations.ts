import { isDeepStrictEqual } from "node:util";
import { CapletsError } from "../errors";
import {
  type SqliteToPostgresTransferCoordinator,
  type SqlTransferConfirmation,
  type SqlTransferJournalState,
  type SqlTransferPhase,
  type SqlTransferStartRequest,
} from "./migration/transfer";

export type OfflineSqlTransferAdministrationTarget = Readonly<{
  target: "global";
  mode: "offline";
  transport: "local";
}>;

export const LOCAL_GLOBAL_OFFLINE_TRANSFER_TARGET: OfflineSqlTransferAdministrationTarget =
  Object.freeze({ target: "global", mode: "offline", transport: "local" });

export type OfflineSqlTransferGuidance =
  | "continue-transfer"
  | "confirm-cutover"
  | "switch-static-backend"
  | "confirm-finalize"
  | "rollback-available"
  | "roll-forward-only"
  | "complete";

export type OfflineSqlTransferReceipt = Readonly<{
  status: "accepted";
  action: "start" | "cutover" | "rollback" | "finalize";
  target: "global";
  mode: "offline";
  transport: "local";
  transferId: string;
  phase: SqlTransferPhase;
  guidance: OfflineSqlTransferGuidance;
}>;

export type OfflineSqlTransferPreview = Readonly<{
  status: "confirmation-required";
  action: "cutover" | "finalize";
  target: "global";
  mode: "offline";
  transport: "local";
  transferId: string;
  confirmation: SqlTransferConfirmation;
}>;

export type StartOfflineSqlTransferOperation = Readonly<{
  administration: unknown;
  transfer: SqlTransferStartRequest;
}>;

export type PreviewOfflineSqlTransferOperation = Readonly<{
  administration: unknown;
  transferId: string;
}>;

export type ConfirmOfflineSqlTransferOperation = Readonly<{
  administration: unknown;
  transferId: string;
  confirmation: SqlTransferConfirmation | undefined;
}>;

export type RollbackOfflineSqlTransferOperation = Readonly<{
  administration: unknown;
  transferId: string;
}>;

export interface OfflineSqlTransferOperations {
  start(request: StartOfflineSqlTransferOperation): Promise<OfflineSqlTransferReceipt>;
  previewCutover(request: PreviewOfflineSqlTransferOperation): Promise<OfflineSqlTransferPreview>;
  cutover(request: ConfirmOfflineSqlTransferOperation): Promise<OfflineSqlTransferReceipt>;
  previewFinalize(request: PreviewOfflineSqlTransferOperation): Promise<OfflineSqlTransferPreview>;
  finalize(request: ConfirmOfflineSqlTransferOperation): Promise<OfflineSqlTransferReceipt>;
  rollback(request: RollbackOfflineSqlTransferOperation): Promise<OfflineSqlTransferReceipt>;
}

export type OfflineSqlTransferOperationDependencies = Readonly<{
  authorizeLocalGlobalAdministration(
    target: OfflineSqlTransferAdministrationTarget,
  ): boolean | Promise<boolean>;
  /** Resolved only after target validation and local administrator authorization. */
  resolveCoordinator():
    | SqliteToPostgresTransferCoordinator
    | Promise<SqliteToPostgresTransferCoordinator>;
}>;

/**
 * The only administration adapter for the destructive transfer. Keeping dependency resolution lazy
 * makes invalid project/remote/mixed transports fail before credentials or either store are opened.
 */
export function createOfflineSqlTransferOperations(
  dependencies: OfflineSqlTransferOperationDependencies,
): OfflineSqlTransferOperations {
  const authorize = async (
    administration: unknown,
  ): Promise<SqliteToPostgresTransferCoordinator> => {
    assertLocalGlobalOfflineTransferTarget(administration);
    if (
      !(await dependencies.authorizeLocalGlobalAdministration(LOCAL_GLOBAL_OFFLINE_TRANSFER_TARGET))
    ) {
      throw new CapletsError("AUTH_FAILED", "Offline SQL transfer administration is unauthorized.");
    }
    return dependencies.resolveCoordinator();
  };

  return Object.freeze({
    async start(request: StartOfflineSqlTransferOperation): Promise<OfflineSqlTransferReceipt> {
      const coordinator = await authorize(request.administration);
      return transferReceipt("start", await coordinator.start(request.transfer));
    },
    async previewCutover(
      request: PreviewOfflineSqlTransferOperation,
    ): Promise<OfflineSqlTransferPreview> {
      const coordinator = await authorize(request.administration);
      const confirmation = await coordinator.previewCutover(request.transferId);
      return transferPreview("cutover", confirmation);
    },
    async cutover(request: ConfirmOfflineSqlTransferOperation): Promise<OfflineSqlTransferReceipt> {
      const coordinator = await authorize(request.administration);
      return transferReceipt(
        "cutover",
        await coordinator.cutover(request.transferId, request.confirmation),
      );
    },
    async previewFinalize(
      request: PreviewOfflineSqlTransferOperation,
    ): Promise<OfflineSqlTransferPreview> {
      const coordinator = await authorize(request.administration);
      const confirmation = await coordinator.previewFinalize(request.transferId);
      return transferPreview("finalize", confirmation);
    },
    async finalize(
      request: ConfirmOfflineSqlTransferOperation,
    ): Promise<OfflineSqlTransferReceipt> {
      const coordinator = await authorize(request.administration);
      return transferReceipt(
        "finalize",
        await coordinator.finalize(request.transferId, request.confirmation),
      );
    },
    async rollback(
      request: RollbackOfflineSqlTransferOperation,
    ): Promise<OfflineSqlTransferReceipt> {
      const coordinator = await authorize(request.administration);
      return transferReceipt("rollback", await coordinator.rollback(request.transferId));
    },
  });
}

export function assertLocalGlobalOfflineTransferTarget(
  value: unknown,
): asserts value is OfflineSqlTransferAdministrationTarget {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !isDeepStrictEqual(Object.keys(value).sort(), ["mode", "target", "transport"]) ||
    !isDeepStrictEqual(value, LOCAL_GLOBAL_OFFLINE_TRANSFER_TARGET)
  ) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "SQLite-to-Postgres transfer requires local --global offline administration.",
    );
  }
}

function transferReceipt(
  action: OfflineSqlTransferReceipt["action"],
  state: SqlTransferJournalState,
): OfflineSqlTransferReceipt {
  return Object.freeze({
    status: "accepted",
    action,
    ...LOCAL_GLOBAL_OFFLINE_TRANSFER_TARGET,
    transferId: state.transferId,
    phase: state.phase,
    guidance: transferGuidance(state.phase),
  });
}

function transferPreview(
  action: OfflineSqlTransferPreview["action"],
  confirmation: SqlTransferConfirmation,
): OfflineSqlTransferPreview {
  if (confirmation.action !== action) {
    throw new CapletsError(
      "INTERNAL_ERROR",
      "Offline SQL transfer confirmation action mismatched.",
    );
  }
  return Object.freeze({
    status: "confirmation-required",
    action,
    ...LOCAL_GLOBAL_OFFLINE_TRANSFER_TARGET,
    transferId: confirmation.transferId,
    confirmation,
  });
}

function transferGuidance(phase: SqlTransferPhase): OfflineSqlTransferGuidance {
  switch (phase) {
    case "destination-verified":
      return "confirm-cutover";
    case "seal-fence-acquired":
    case "source-sealed":
    case "descriptor-pending":
    case "destination-pending":
      return "continue-transfer";
    case "destination-ready":
      return "confirm-finalize";
    case "destination-activated":
    case "descriptor-rebound":
    case "destination-hydrated":
    case "destruction-intents-durable":
      return "roll-forward-only";
    case "completed":
    case "rolled-back":
      return "complete";
    default:
      return "rollback-available";
  }
}
