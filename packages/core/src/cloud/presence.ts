import type { CapletsCloudClient, RegisterPresenceInput } from "./client";

type PresenceClient = Pick<CapletsCloudClient, "registerPresence"> & {
  heartbeatPresence?: (presenceId: string) => Promise<unknown>;
  stopPresence?: (presenceId: string) => Promise<void>;
  updatePresenceCaplets?: (presenceId: string, allowedCapletIds: string[]) => Promise<void>;
};

export type LocalPresenceManagerOptions = RegisterPresenceInput & {
  client: PresenceClient;
  heartbeatIntervalMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  onError?: (error: unknown) => void;
};

export class LocalPresenceManager {
  private presenceId: string | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private startPromise: Promise<void> | undefined;

  constructor(private readonly options: LocalPresenceManagerOptions) {}

  async start(): Promise<void> {
    if (this.startPromise) {
      return await this.startPromise;
    }
    this.startPromise = this.register();
    return await this.startPromise;
  }

  private async register(): Promise<void> {
    const result = await this.options.client.registerPresence({
      workspaceId: this.options.workspaceId,
      projectRoot: this.options.projectRoot,
      projectFingerprint: this.options.projectFingerprint,
      allowedCapletIds: this.options.allowedCapletIds,
      fallbackConsent: this.options.fallbackConsent ?? "deny",
    });
    this.presenceId = result.presenceId;
    this.startHeartbeat();
  }

  async close(): Promise<void> {
    await this.startPromise?.catch(() => undefined);
    const presenceId = this.presenceId;
    this.presenceId = undefined;
    this.stopHeartbeat();
    if (presenceId && this.options.client.stopPresence) {
      await this.options.client.stopPresence(presenceId);
    }
  }

  async updateAllowedCapletIds(allowedCapletIds: string[]): Promise<void> {
    await this.startPromise?.catch(() => undefined);
    const presenceId = this.presenceId;
    if (!presenceId || !this.options.client.updatePresenceCaplets) {
      return;
    }
    await this.options.client.updatePresenceCaplets(presenceId, allowedCapletIds);
  }

  private startHeartbeat(): void {
    if (!this.options.client.heartbeatPresence || this.options.heartbeatIntervalMs === undefined) {
      return;
    }
    const setIntervalImpl = this.options.setInterval ?? setInterval;
    this.heartbeatTimer = setIntervalImpl(() => {
      const presenceId = this.presenceId;
      if (!presenceId || !this.options.client.heartbeatPresence) return;
      void this.options.client.heartbeatPresence(presenceId).catch((error) => {
        this.options.onError?.(error);
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
