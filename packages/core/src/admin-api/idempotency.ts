import { CapletsError } from "../errors";
import { stableJsonStringify } from "../stable-json";
import {
  DEFAULT_IDEMPOTENCY_PENDING_TTL_MS,
  type IdempotencyClaimInput,
  type IdempotencyClaimResult,
  type IdempotencyFinalResponse,
  type IdempotencyFinalizeInput,
  type IdempotencyHeartbeatInput,
} from "../storage/idempotency";

export type IdempotencyExecutionStore = {
  claim(input: IdempotencyClaimInput): Promise<IdempotencyClaimResult>;
  heartbeat(input: IdempotencyHeartbeatInput): Promise<boolean>;
  finalize(input: IdempotencyFinalizeInput): Promise<boolean>;
};

export type IdempotencyExecutionOutcome =
  | { outcome: "response"; response: IdempotencyFinalResponse; replayed: boolean }
  | { outcome: "in_progress"; retryAfterSeconds: number }
  | { outcome: "conflict" }
  | { outcome: "unknown"; reconciliationLinks: string[] }
  | { outcome: "capacity_exceeded" }
  | { outcome: "ownership_lost"; reconciliationLinks: string[] };

export type ExecuteWithIdempotencyOptions = {
  store: IdempotencyExecutionStore;
  principalClientId: string;
  operationId: string;
  idempotencyKey: string;
  validatedRequest: unknown;
  reconciliationLinks?: readonly string[] | undefined;
  heartbeatIntervalMs?: number | undefined;
  execute(): Promise<IdempotencyFinalResponse>;
};

const DEFAULT_HEARTBEAT_INTERVAL_MS = Math.floor(DEFAULT_IDEMPOTENCY_PENDING_TTL_MS / 3);

/**
 * Executes work independently of the request connection after atomically acquiring its claim.
 * Callers must convert expected operation failures to final HTTP responses inside `execute`.
 */
export async function executeWithIdempotency(
  options: ExecuteWithIdempotencyOptions,
): Promise<IdempotencyExecutionOutcome> {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
    throw new CapletsError("REQUEST_INVALID", "Idempotency heartbeat interval is invalid.");
  }

  const reconciliationLinks = [...(options.reconciliationLinks ?? [])];
  const key = {
    principalClientId: options.principalClientId,
    operationId: options.operationId,
    idempotencyKey: options.idempotencyKey,
  };
  const claim = await options.store.claim({
    ...key,
    requestFingerprintSource: stableJsonStringify(options.validatedRequest),
    ...(reconciliationLinks.length > 0 ? { reconciliationLinks } : {}),
  });

  switch (claim.outcome) {
    case "replay":
      return { outcome: "response", response: claim.response, replayed: true };
    case "in_progress":
      return { outcome: "in_progress", retryAfterSeconds: claim.retryAfterSeconds };
    case "conflict":
      return { outcome: "conflict" };
    case "unknown":
      return { outcome: "unknown", reconciliationLinks: claim.reconciliationLinks };
    case "capacity_exceeded":
      return { outcome: "capacity_exceeded" };
    case "acquired":
      break;
  }

  const heartbeat = startHeartbeat({
    store: options.store,
    key: { ...key, ownerToken: claim.ownerToken },
    intervalMs: heartbeatIntervalMs,
  });
  let response: IdempotencyFinalResponse;
  try {
    response = await options.execute();
  } catch (error) {
    await heartbeat.stop();
    throw error;
  }

  if (await heartbeat.stop()) {
    return { outcome: "ownership_lost", reconciliationLinks };
  }
  const finalized = await options.store.finalize({
    ...key,
    ownerToken: claim.ownerToken,
    response,
  });
  return finalized
    ? { outcome: "response", response, replayed: false }
    : { outcome: "ownership_lost", reconciliationLinks };
}

type HeartbeatLoop = {
  stop(): Promise<boolean>;
};

function startHeartbeat(options: {
  store: IdempotencyExecutionStore;
  key: IdempotencyHeartbeatInput;
  intervalMs: number;
}): HeartbeatLoop {
  let stopped = false;
  let ownershipLost = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight = Promise.resolve();

  const schedule = (): void => {
    timer = setTimeout(() => {
      inFlight = options.store
        .heartbeat(options.key)
        .then((retained) => {
          if (!retained) ownershipLost = true;
        })
        .catch(() => {
          ownershipLost = true;
        })
        .finally(() => {
          if (!stopped && !ownershipLost) schedule();
        });
    }, options.intervalMs);
    timer.unref?.();
  };
  schedule();

  return {
    async stop(): Promise<boolean> {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
      return ownershipLost;
    },
  };
}
