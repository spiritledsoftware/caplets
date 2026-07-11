import type { CapletsCloudClient, PresenceRequestOptions, RegisterPresenceInput } from "./client";
import {
  withProjectBindingMutationDeadline,
  type ProjectBindingMutationDeadlineOptions,
  type ProjectBindingSessionAdapter,
} from "../native/project-binding-lifecycle";

type PresenceClient = Pick<CapletsCloudClient, "registerPresence"> & {
  heartbeatPresence?: (presenceId: string, options?: PresenceRequestOptions) => Promise<unknown>;
  stopPresence?: (presenceId: string, options?: PresenceRequestOptions) => Promise<void>;
  updatePresenceCaplets?: (
    presenceId: string,
    allowedCapletIds: string[],
    options?: PresenceRequestOptions,
  ) => Promise<void>;
};

export type ProjectBindingSessionManagerOptions = RegisterPresenceInput &
  ProjectBindingMutationDeadlineOptions & {
    client: PresenceClient;
    heartbeatIntervalMs?: number;
    setInterval?: typeof setInterval;
    clearInterval?: typeof clearInterval;
    onError?: (error: unknown) => void;
  };

export class ProjectBindingSessionManager implements ProjectBindingSessionAdapter {
  private presenceId: string | undefined;
  private allowedCapletIds: string[];
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private mutationChain: Promise<void> = Promise.resolve();
  private startInFlight: Promise<boolean> | undefined;
  private closeInFlight: Promise<void> | undefined;
  private preparingClose = false;
  private closing = false;
  private closed = false;
  private mutationSequence = 0;
  private closeMutationBoundary = 0;
  private timerHeartbeatQueued = false;

  constructor(private readonly options: ProjectBindingSessionManagerOptions) {
    this.allowedCapletIds = [...options.allowedCapletIds];
  }

  hasActiveSession(): boolean {
    return this.presenceId !== undefined;
  }

  async start(allowedCapletIds = this.allowedCapletIds): Promise<boolean> {
    this.allowedCapletIds = [...allowedCapletIds];
    if (this.closed || this.closing || this.presenceId) return false;
    if (this.startInFlight) {
      return await this.startInFlight;
    }

    const mutationSequence = ++this.mutationSequence;
    const start = this.enqueue(async (): Promise<boolean> => {
      if (
        this.closed ||
        this.presenceId ||
        (this.closing && mutationSequence > this.closeMutationBoundary)
      ) {
        return false;
      }
      const result = await withProjectBindingMutationDeadline(
        (signal) =>
          this.options.client.registerPresence(
            {
              workspaceId: this.options.workspaceId,
              projectRoot: this.options.projectRoot,
              projectFingerprint: this.options.projectFingerprint,
              allowedCapletIds: this.allowedCapletIds,
              projectFiles: this.options.projectFiles,
              fallbackConsent: this.options.fallbackConsent ?? "deny",
            },
            { signal },
          ),
        this.options,
      );
      this.presenceId = result.presenceId;
      if (!this.preparingClose) this.startHeartbeat();
      return true;
    });
    this.startInFlight = start;
    try {
      return await start;
    } finally {
      if (this.startInFlight === start) this.startInFlight = undefined;
    }
  }

  async updateAllowedCapletIds(allowedCapletIds: string[]): Promise<void> {
    this.allowedCapletIds = [...allowedCapletIds];
    if (this.closed || this.closing) return;
    const mutationSequence = ++this.mutationSequence;
    await this.enqueue(async () => {
      if (this.closed || (this.closing && mutationSequence > this.closeMutationBoundary)) return;
      const presenceId = this.presenceId;
      if (!presenceId || !this.options.client.updatePresenceCaplets) return;
      await withProjectBindingMutationDeadline(
        (signal) =>
          this.options.client.updatePresenceCaplets?.(presenceId, this.allowedCapletIds, {
            signal,
          }) ?? Promise.resolve(),
        this.options,
      );
    });
  }

  prepareClose(): void {
    this.preparingClose = true;
    this.stopHeartbeat();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closeInFlight) {
      await this.closeInFlight;
      return;
    }

    this.prepareClose();
    this.closeMutationBoundary = this.mutationSequence;
    this.closing = true;
    const close = this.enqueue(async () => {
      const presenceId = this.presenceId;
      if (presenceId && this.options.client.stopPresence) {
        await withProjectBindingMutationDeadline(
          (signal) =>
            this.options.client.stopPresence?.(presenceId, { signal }) ?? Promise.resolve(),
          this.options,
        );
      }
      this.presenceId = undefined;
      this.closed = true;
    });
    this.closeInFlight = close;
    try {
      await close;
    } finally {
      if (this.closeInFlight === close && !this.closed) this.closeInFlight = undefined;
    }
  }

  dispose(): void {
    this.preparingClose = true;
    this.closing = true;
    this.closed = true;
    this.presenceId = undefined;
    this.stopHeartbeat();
  }

  private enqueue<T>(mutation: () => Promise<T>): Promise<T> {
    const next = this.mutationChain.then(mutation, mutation);
    this.mutationChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private startHeartbeat(): void {
    if (
      this.preparingClose ||
      !this.options.client.heartbeatPresence ||
      this.options.heartbeatIntervalMs === undefined
    ) {
      return;
    }
    const setIntervalImpl = this.options.setInterval ?? setInterval;
    this.heartbeatTimer = setIntervalImpl(() => {
      if (this.timerHeartbeatQueued) return;
      this.timerHeartbeatQueued = true;
      const mutationSequence = ++this.mutationSequence;
      void this.enqueue(async () => {
        if (
          this.preparingClose ||
          this.closed ||
          (this.closing && mutationSequence > this.closeMutationBoundary)
        ) {
          return;
        }
        const presenceId = this.presenceId;
        if (!presenceId || !this.options.client.heartbeatPresence) return;
        await withProjectBindingMutationDeadline(
          (signal) =>
            this.options.client.heartbeatPresence?.(presenceId, { signal }) ?? Promise.resolve(),
          this.options,
        );
      })
        .catch((error) => {
          this.options.onError?.(error);
        })
        .finally(() => {
          this.timerHeartbeatQueued = false;
        });
    }, this.options.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    const timer = this.heartbeatTimer;
    this.heartbeatTimer = undefined;
    if (timer) {
      (this.options.clearInterval ?? clearInterval)(timer);
    }
  }
}
