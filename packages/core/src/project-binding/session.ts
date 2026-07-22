import { fingerprintProjectRoot } from "@caplets/sdk/project-binding/node";
import { currentHostAttachUrl } from "../current-host/topology";
import { CapletsError } from "../errors";
import {
  withProjectBindingMutationDeadline,
  type ProjectBindingMutationDeadlineOptions,
  type ProjectBindingSessionAdapter,
} from "./lifecycle";

export const REMOTE_PROJECT_BINDING_UNSUPPORTED_MESSAGE =
  "Remote Project Binding sessions are not implemented by this runtime.";

export type RemoteProjectBindingSessionManagerOptions = ProjectBindingMutationDeadlineOptions & {
  origin: URL;
  requestInit: RequestInit;
  fetch?: typeof fetch | undefined;
  projectRoot: string;
  heartbeatIntervalMs: number;
  writeErr?: ((value: string) => void) | undefined;
};

export class RemoteProjectBindingSessionManager implements ProjectBindingSessionAdapter {
  private bindingId: string | undefined;
  private sessionId: string | undefined;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private mutationChain: Promise<void> = Promise.resolve();
  private startInFlight: Promise<boolean> | undefined;
  private closeInFlight: Promise<void> | undefined;
  private mutationSequence = 0;
  private closeMutationBoundary = 0;
  private unsupported = false;
  private preparingClose = false;
  private closing = false;
  private closed = false;
  private timerHeartbeatQueued = false;

  constructor(private readonly options: RemoteProjectBindingSessionManagerOptions) {}

  hasActiveSession(): boolean {
    return this.bindingId !== undefined && this.sessionId !== undefined;
  }

  async start(): Promise<boolean> {
    if (this.unsupported || this.closed || this.closing || this.bindingId) return false;
    if (this.startInFlight) return await this.startInFlight;

    const mutationSequence = ++this.mutationSequence;
    const start = this.enqueue(async (): Promise<boolean> => {
      if (
        this.unsupported ||
        this.closed ||
        this.bindingId ||
        (this.closing && mutationSequence > this.closeMutationBoundary)
      ) {
        return false;
      }
      const response = await this.fetchJson<{
        binding?: { bindingId?: string | undefined };
        sessionId?: string | undefined;
      }>(projectBindingUrl(this.options.origin, "sessions"), {
        method: "POST",
        body: {
          projectRoot: this.options.projectRoot,
          projectFingerprint: fingerprintProjectRoot(this.options.projectRoot),
        },
      });
      if (!response.binding?.bindingId || !response.sessionId) {
        throw new CapletsError(
          "SERVER_UNAVAILABLE",
          "Project Binding session response was invalid.",
        );
      }
      this.bindingId = response.binding.bindingId;
      this.sessionId = response.sessionId;
      if (!this.preparingClose) this.startHeartbeat();
      return true;
    });
    this.startInFlight = start;
    void start.catch((error) => {
      if (isUnsupportedRemoteProjectBinding(error)) this.unsupported = true;
    });
    try {
      return await start;
    } finally {
      if (this.startInFlight === start) this.startInFlight = undefined;
    }
  }

  async updateAllowedCapletIds(): Promise<void> {
    if (this.closed || this.closing) return;
    const mutationSequence = ++this.mutationSequence;
    try {
      await this.enqueue(async () => {
        if (this.closed || (this.closing && mutationSequence > this.closeMutationBoundary)) return;
        await this.heartbeat();
      });
    } catch (error) {
      this.disconnect();
      this.options.writeErr?.(`Remote Project Binding heartbeat failed: ${errorMessage(error)}\n`);
      throw error;
    }
  }

  prepareClose(): void {
    this.preparingClose = true;
    this.stopHeartbeat();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closeInFlight) return await this.closeInFlight;

    this.prepareClose();
    this.closeMutationBoundary = this.mutationSequence;
    this.closing = true;
    const close = this.enqueue(async () => {
      const bindingId = this.bindingId;
      const sessionId = this.sessionId;
      if (bindingId && sessionId) {
        await this.fetchJson(projectBindingUrl(this.options.origin, bindingId, "session"), {
          method: "DELETE",
          body: {
            sessionId,
            terminalReason: { code: "completed", message: "Binding Session completed." },
          },
        });
      }
      this.bindingId = undefined;
      this.sessionId = undefined;
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
    this.bindingId = undefined;
    this.sessionId = undefined;
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
    if (this.preparingClose || this.closed || this.closing) return;
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
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
        await this.heartbeat();
      })
        .catch((error) => {
          this.disconnect();
          this.options.writeErr?.(
            `Remote Project Binding heartbeat failed: ${errorMessage(error)}\n`,
          );
        })
        .finally(() => {
          this.timerHeartbeatQueued = false;
        });
    }, this.options.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private disconnect(): void {
    this.stopHeartbeat();
    if (this.preparingClose || this.closing) return;
    this.bindingId = undefined;
    this.sessionId = undefined;
    this.startInFlight = undefined;
  }

  private async heartbeat(): Promise<void> {
    if (!this.bindingId || !this.sessionId) return;
    await this.fetchJson(projectBindingUrl(this.options.origin, this.bindingId, "heartbeat"), {
      method: "POST",
      body: {
        sessionId: this.sessionId,
        state: "ready",
        syncState: "idle",
      },
    });
  }

  private async fetchJson<T = unknown>(
    url: URL,
    input: { method: "POST" | "DELETE"; body: unknown },
  ): Promise<T> {
    return await withProjectBindingMutationDeadline(
      (signal) => this.fetchJsonWithinDeadline<T>(url, input, signal),
      this.options,
    );
  }

  private async fetchJsonWithinDeadline<T>(
    url: URL,
    input: { method: "POST" | "DELETE"; body: unknown },
    signal: AbortSignal,
  ): Promise<T> {
    const headers = new Headers(this.options.requestInit.headers);
    headers.set("content-type", "application/json");
    const response = await (this.options.fetch ?? fetch)(url, {
      ...this.options.requestInit,
      method: input.method,
      headers,
      body: JSON.stringify(input.body),
      signal,
    });
    if (input.method === "DELETE" && response.status === 404) return {} as T;
    if (!response.ok) {
      let payload: unknown;
      try {
        payload = (await response.json()) as unknown;
      } catch {
        payload = undefined;
      }
      const error = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
      if (error?.code === "UNSUPPORTED_CAPABILITY" && typeof error.message === "string") {
        throw new CapletsError("UNSUPPORTED_CAPABILITY", error.message);
      }
      throw new CapletsError(
        "SERVER_UNAVAILABLE",
        `Project Binding request failed (${response.status}).`,
      );
    }
    return (await response.json().catch(() => ({}))) as T;
  }
}

export function isUnsupportedRemoteProjectBinding(error: unknown): boolean {
  return (
    isRecord(error) &&
    error.code === "UNSUPPORTED_CAPABILITY" &&
    error.message === REMOTE_PROJECT_BINDING_UNSUPPORTED_MESSAGE
  );
}

function projectBindingUrl(origin: URL, ...segments: string[]): URL {
  const url = currentHostAttachUrl(origin);
  const base = url.pathname;
  url.pathname = [base, "project-bindings", ...segments.map(encodeURIComponent)].join("/");
  url.search = "";
  url.hash = "";
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
