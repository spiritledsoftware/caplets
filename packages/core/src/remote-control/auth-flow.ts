import { randomUUID } from "node:crypto";
import type { CapletServerConfig } from "../config";
import {
  backendAuthCompletionCorrelation,
  completeGenericOAuthFlowState,
  completeOAuthFlowState,
  DEFAULT_BACKEND_AUTH_FLOW_TTL_MS,
  startGenericOAuthFlowState,
  startOAuthFlowState,
  type BackendAuthFlowState,
  type BackendAuthCompletionPersistence,
  type GenericAuthTarget,
} from "../auth";
import { CapletsError } from "../errors";
import type { BackendAuthStateStore } from "../storage/backend-auth";
import {
  type BackendAuthFlowClaim,
  type BackendAuthFlowClaimResult,
  type BackendAuthFlowRepository,
  type BackendAuthFlowView,
} from "../storage/backend-auth-flows";

export const DEFAULT_REMOTE_AUTH_CLAIM_ABANDONED_MS = 2 * 60_000;
export const DEFAULT_REMOTE_AUTH_CLAIM_HEARTBEAT_MS = 30_000;
const RETRYABLE_OAUTH_ERROR_CODES: Readonly<Record<string, true>> = {
  server_error: true,
  temporarily_unavailable: true,
  too_many_requests: true,
};

type RemoteAuthTarget = CapletServerConfig | GenericAuthTarget;

export type RemoteAuthFlowCoordinatorOptions = {
  repository: BackendAuthFlowRepository;
  authStore: BackendAuthStateStore;
  resolveTarget(server: string): RemoteAuthTarget | Promise<RemoteAuthTarget>;
  callbackUrl?: ((flowId: string) => string) | undefined;
  operatorClientId?: string | undefined;
  now?: (() => Date) | undefined;
  ttlMs?: number | undefined;
  claimAbandonedAfterMs?: number | undefined;
  claimHeartbeatMs?: number | undefined;
};

export type RemoteAuthFlowStartResult =
  | { server: string; authenticated: true }
  | { server: string; flowId: string; authorizationUrl: string };

export type RemoteAuthFlowCompletionResult = {
  server: string;
  authenticated: true;
};

export class RemoteAuthFlowCoordinator {
  constructor(private readonly options: RemoteAuthFlowCoordinatorOptions) {
    assertPositiveDuration(options.ttlMs, "Remote auth flow TTL");
    assertPositiveDuration(options.claimAbandonedAfterMs, "Remote auth claim abandonment");
    assertPositiveDuration(options.claimHeartbeatMs, "Remote auth claim heartbeat");
    if (
      (options.claimHeartbeatMs ?? DEFAULT_REMOTE_AUTH_CLAIM_HEARTBEAT_MS) >=
      (options.claimAbandonedAfterMs ?? DEFAULT_REMOTE_AUTH_CLAIM_ABANDONED_MS)
    ) {
      throw new CapletsError(
        "REQUEST_INVALID",
        "Remote auth claim heartbeat must be shorter than claim abandonment.",
      );
    }
  }

  async start(input: {
    server: string;
    callbackBaseUrl: string;
  }): Promise<RemoteAuthFlowStartResult> {
    const target = await this.options.resolveTarget(input.server);
    const now = this.now();
    const expiresAt = new Date(
      now.getTime() + (this.options.ttlMs ?? DEFAULT_BACKEND_AUTH_FLOW_TTL_MS),
    );
    const flowId = randomUUID();
    const redirectUri = this.options.callbackUrl
      ? new URL(this.options.callbackUrl(flowId)).toString()
      : new URL(
          `auth/callback/${flowId}`,
          input.callbackBaseUrl.endsWith("/") ? input.callbackBaseUrl : `${input.callbackBaseUrl}/`,
        ).toString();
    const common = {
      redirectUri,
      flowId,
      authStore: this.options.authStore,
      ...(this.options.operatorClientId ? { operatorClientId: this.options.operatorClientId } : {}),
      now,
      expiresAt,
      persist: async (state: BackendAuthFlowState): Promise<void> => {
        await this.options.repository.create({
          flowId: state.flowId,
          server: state.server,
          state,
          expiresAt,
          startingBackendAuthGeneration: state.startingBackendAuthGeneration,
          now,
        });
      },
    };
    const started =
      target.backend === "mcp"
        ? await startOAuthFlowState(target, common)
        : await startGenericOAuthFlowState(target, common);
    if (!started.authorizationUrl) {
      return { server: input.server, authenticated: true };
    }
    if (!started.state) {
      throw new CapletsError("INTERNAL_ERROR", "OAuth flow state was not persisted.");
    }
    return {
      server: input.server,
      flowId: started.state.flowId,
      authorizationUrl: started.authorizationUrl,
    };
  }

  async complete(flowId: string, callbackUrl: string): Promise<RemoteAuthFlowCompletionResult> {
    const now = this.now();
    const claimed = await this.options.repository.claim<BackendAuthFlowState>({ flowId, now });
    if (!claimed.acquired) {
      return await this.completeUnacquired(flowId, claimed, now);
    }
    const claim = claimed;
    const heartbeat = this.startHeartbeat(claim);
    try {
      try {
        const target = await this.options.resolveTarget(claim.flow.server);
        const persistTokenBundle: BackendAuthCompletionPersistence = async (
          bundle,
          mutationOptions,
        ) => {
          if (mutationOptions.expectedGeneration === undefined) {
            throw new CapletsError(
              "INTERNAL_ERROR",
              "Durable OAuth completion requires an explicit backend auth generation.",
            );
          }
          await heartbeat.stop();
          return await this.options.repository.completeClaim({
            flowId,
            server: claim.flow.server,
            claimToken: claim.claimToken,
            completionCorrelation: claim.completionCorrelation,
            expectedGeneration: mutationOptions.expectedGeneration,
            bundle,
            ...(mutationOptions.operatorClientId
              ? { operatorClientId: mutationOptions.operatorClientId }
              : {}),
            now: this.now(),
          });
        };
        const completionOptions = {
          correlation: {
            flowId,
            completionCorrelation: claim.completionCorrelation,
          },
          persistTokenBundle,
          ...(this.options.operatorClientId
            ? { operatorClientId: this.options.operatorClientId }
            : {}),
          now,
        };
        if (target.backend === "mcp" && claim.state.provider === "mcp") {
          await completeOAuthFlowState(target, claim.state, callbackUrl, completionOptions);
        } else if (target.backend !== "mcp" && claim.state.provider === "generic") {
          await completeGenericOAuthFlowState(target, claim.state, callbackUrl, completionOptions);
        } else {
          throw new CapletsError(
            "AUTH_FAILED",
            "OAuth configuration changed after authorization started. Re-run auth login.",
            { server: claim.flow.server, nextAction: "run_caplets_auth_login" },
          );
        }
      } catch (error) {
        await heartbeat.stop();
        const correlated = await this.correlatedCompletion(claim);
        if (correlated) {
          let flow: BackendAuthFlowView | undefined;
          try {
            flow = await this.options.repository.get(flowId, this.now());
          } catch {
            throw unknownOutcomeError(flowId);
          }
          if (flow?.status !== "completed") await this.finalize(claim, correlated.generation);
          return { server: claim.flow.server, authenticated: true };
        }
        if (
          error instanceof CapletsError &&
          error.details &&
          typeof error.details === "object" &&
          !Array.isArray(error.details) &&
          (error.details as Record<string, unknown>).kind === "backend_auth_flow_claim_lost"
        ) {
          throw error;
        }
        const failure = classifyCompletionFailure(error);
        if (failure === "retryable") {
          let released = false;
          try {
            released = await this.options.repository.release({
              flowId,
              claimToken: claim.claimToken,
              now: this.now(),
            });
          } catch {
            throw unknownOutcomeError(flowId);
          }
          if (!released) throw unknownOutcomeError(flowId);
          throw error;
        }
        let terminalized = false;
        try {
          terminalized = await this.options.repository.terminalizeClaim({
            flowId,
            claimToken: claim.claimToken,
            status: failure === "ambiguous" ? "unknown" : "failed",
            now: this.now(),
          });
        } catch {
          throw unknownOutcomeError(flowId);
        }
        if (!terminalized) throw unknownOutcomeError(flowId);
        if (failure === "ambiguous") throw unknownOutcomeError(flowId);
        throw error;
      }
      return { server: claim.flow.server, authenticated: true };
    } finally {
      await heartbeat.stop();
    }
  }

  private async completeUnacquired(
    flowId: string,
    claim: Exclude<BackendAuthFlowClaimResult<BackendAuthFlowState>, { acquired: true }>,
    now: Date,
  ): Promise<RemoteAuthFlowCompletionResult> {
    if (claim.reason === "not_found") {
      throw new CapletsError("REQUEST_INVALID", `Unknown auth flow ${flowId}`);
    }
    if (claim.reason === "expired") {
      throw new CapletsError("AUTH_FAILED", `Auth flow ${flowId} has expired.`);
    }
    if (claim.reason === "terminal") {
      throw terminalFlowError(flowId, claim.flow);
    }
    const reconciled = await this.reconcileAbandoned(flowId, claim.flow, now);
    if (reconciled?.status === "completed") {
      return { server: reconciled.server, authenticated: true };
    }
    if (reconciled) throw terminalFlowError(flowId, reconciled);
    throw new CapletsError("AUTH_FAILED", `Auth flow ${flowId} is already being completed.`);
  }

  private async reconcileAbandoned(
    flowId: string,
    flow: BackendAuthFlowView | undefined,
    now: Date,
  ): Promise<BackendAuthFlowView | undefined> {
    if (!flow?.claimedAt) return undefined;
    const abandonedBefore = new Date(
      now.getTime() -
        (this.options.claimAbandonedAfterMs ?? DEFAULT_REMOTE_AUTH_CLAIM_ABANDONED_MS),
    );
    if (Date.parse(flow.claimedAt) > abandonedBefore.getTime()) return undefined;
    let observed;
    try {
      observed = await this.options.authStore.readTokenBundle(flow.server);
    } catch {
      throw unknownOutcomeError(flowId);
    }
    const correlation = observed ? backendAuthCompletionCorrelation(observed.bundle) : undefined;
    return await this.options.repository.reconcileAbandoned({
      flowId,
      abandonedBefore,
      ...(observed && correlation?.flowId === flowId
        ? {
            observedCompletionCorrelation: correlation.completionCorrelation,
            observedBackendAuthGeneration: observed.generation,
          }
        : {}),
      now,
    });
  }

  private async correlatedCompletion(
    claim: BackendAuthFlowClaim<BackendAuthFlowState>,
  ): Promise<{ generation: number } | undefined> {
    let observed;
    try {
      observed = await this.options.authStore.readTokenBundle(claim.flow.server);
    } catch {
      try {
        await this.options.repository.terminalizeClaim({
          flowId: claim.flow.flowId,
          claimToken: claim.claimToken,
          status: "unknown",
          now: this.now(),
        });
      } catch {
        // Reconciliation will fail the abandoned claim closed if storage becomes available again.
      }
      throw unknownOutcomeError(claim.flow.flowId);
    }
    if (!observed) return undefined;
    const correlation = backendAuthCompletionCorrelation(observed.bundle);
    const startingGeneration =
      claim.startingBackendAuthGeneration ?? claim.state.startingBackendAuthGeneration;
    return correlation?.flowId === claim.flow.flowId &&
      correlation.completionCorrelation === claim.completionCorrelation &&
      observed.generation > startingGeneration
      ? { generation: observed.generation }
      : undefined;
  }

  private async finalize(
    claim: BackendAuthFlowClaim<BackendAuthFlowState>,
    backendAuthGeneration: number,
  ): Promise<void> {
    let finalized = false;
    try {
      finalized = await this.options.repository.finalize({
        flowId: claim.flow.flowId,
        claimToken: claim.claimToken,
        completionCorrelation: claim.completionCorrelation,
        backendAuthGeneration,
        now: this.now(),
      });
    } catch {
      throw unknownOutcomeError(claim.flow.flowId);
    }
    if (!finalized) throw unknownOutcomeError(claim.flow.flowId);
  }

  private startHeartbeat(claim: BackendAuthFlowClaim<BackendAuthFlowState>): {
    stop(): Promise<void>;
  } {
    let stopped = false;
    let queued = false;
    let inFlight: Promise<void> | undefined;
    const trigger = (): void => {
      if (stopped) return;
      if (inFlight) {
        queued = true;
        return;
      }
      const attempt = (async () => {
        try {
          await this.options.repository.heartbeat({
            flowId: claim.flow.flowId,
            claimToken: claim.claimToken,
            now: this.now(),
          });
        } catch {
          // A guarded completion mutation will determine whether the claim is still owned.
        }
      })();
      inFlight = attempt;
      void attempt.then(() => {
        if (inFlight !== attempt) return;
        inFlight = undefined;
        if (queued && !stopped) {
          queued = false;
          trigger();
        }
      });
    };
    const interval = setInterval(
      trigger,
      this.options.claimHeartbeatMs ?? DEFAULT_REMOTE_AUTH_CLAIM_HEARTBEAT_MS,
    );
    interval.unref?.();
    return {
      stop: async () => {
        if (!stopped) {
          stopped = true;
          queued = false;
          clearInterval(interval);
        }
        if (inFlight) await inFlight;
      },
    };
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

function terminalFlowError(flowId: string, flow: BackendAuthFlowView | undefined): CapletsError {
  if (flow?.status === "completed") {
    return new CapletsError("AUTH_FAILED", `Auth flow ${flowId} has already been completed.`);
  }
  if (flow?.status === "expired") {
    return new CapletsError("AUTH_FAILED", `Auth flow ${flowId} has expired.`);
  }
  if (flow?.status === "failed") {
    return new CapletsError("AUTH_FAILED", `Auth flow ${flowId} failed and cannot be retried.`);
  }
  return unknownOutcomeError(flowId);
}

function unknownOutcomeError(flowId: string): CapletsError {
  return new CapletsError("AUTH_FAILED", `Auth flow ${flowId} has an unknown completion outcome.`);
}

function classifyCompletionFailure(error: unknown): "retryable" | "ambiguous" | "terminal" {
  const oauthFailure = classifyOAuthFailure(error);
  if (oauthFailure) return oauthFailure;
  if (error instanceof CapletsError) {
    if (error.details && typeof error.details === "object" && !Array.isArray(error.details)) {
      const status = (error.details as Record<string, unknown>).status;
      if (
        typeof status === "number" &&
        (status === 408 || status === 429 || (status >= 500 && status <= 599))
      ) {
        return "retryable";
      }
      if ((error.details as Record<string, unknown>).kind === "stale_generation") {
        return "ambiguous";
      }
    }
    if (
      error.code === "SERVER_UNAVAILABLE" ||
      error.code === "SERVER_START_TIMEOUT" ||
      error.code === "INTERNAL_ERROR"
    ) {
      return "ambiguous";
    }
    return "terminal";
  }
  if (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return "ambiguous";
  }
  if (error instanceof TypeError && /\bfetch\b|\bnetwork\b/iu.test(error.message)) {
    return "ambiguous";
  }
  let current = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current || typeof current !== "object") break;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (
      typeof candidate.code === "string" &&
      (candidate.code === "ECONNREFUSED" ||
        candidate.code === "ECONNRESET" ||
        candidate.code === "EHOSTUNREACH" ||
        candidate.code === "ENETUNREACH" ||
        candidate.code === "EPIPE" ||
        candidate.code === "ETIMEDOUT" ||
        candidate.code === "EAI_AGAIN" ||
        candidate.code.startsWith("UND_ERR_") ||
        candidate.code.startsWith("08"))
    ) {
      return "ambiguous";
    }
    current = candidate.cause;
  }
  return "terminal";
}

function classifyOAuthFailure(error: unknown): "retryable" | "terminal" | undefined {
  if (!(error instanceof Error)) return undefined;
  const errorCode = (error as Error & { errorCode?: unknown }).errorCode;
  if (typeof errorCode !== "string" || !RETRYABLE_OAUTH_ERROR_CODES[errorCode]) {
    return undefined;
  }
  const fallbackStatus = /^HTTP (?<status>\d{3}):/u.exec(error.message)?.groups?.status;
  if (fallbackStatus === undefined) return "retryable";
  const status = Number(fallbackStatus);
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
    ? "retryable"
    : "terminal";
}

function assertPositiveDuration(value: number | undefined, label: string): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `${label} must be a positive duration in milliseconds.`,
    );
  }
}
