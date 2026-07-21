export type ProjectBindingSessionAdapter = {
  start(allowedCapletIds: string[]): Promise<boolean | void>;
  updateAllowedCapletIds(allowedCapletIds: string[]): Promise<void>;
  hasActiveSession?(): boolean;
  prepareClose?(): void;
  close(): Promise<void>;
  dispose?(): void;
};

export interface ProjectBindingLifecycle {
  start(): Promise<void>;
  updateAllowedCapletIds(allowedCapletIds: string[]): Promise<void>;
  replace(
    adapter: ProjectBindingSessionAdapter | undefined,
    beforeStart?: (() => Promise<void>) | undefined,
  ): Promise<void>;
  isCleanupFailed(): boolean;
  close(): Promise<void>;
}

export const PROJECT_BINDING_MUTATION_TIMEOUT_MS = 10_000;

export type ProjectBindingMutationDeadlineOptions = {
  mutationTimeoutMs?: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

export function withProjectBindingMutationDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: ProjectBindingMutationDeadlineOptions = {},
): Promise<T> {
  const timeoutMs = options.mutationTimeoutMs ?? PROJECT_BINDING_MUTATION_TIMEOUT_MS;
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    const clearTimeoutImpl = options.clearTimeout ?? clearTimeout;
    const timeout = (options.setTimeout ?? setTimeout)(() => {
      clearTimeoutImpl(timeout);
      controller.abort();
      reject(new Error(`Project Binding mutation timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    void Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        (value) => {
          clearTimeoutImpl(timeout);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeoutImpl(timeout);
          reject(error);
        },
      );
  });
}

export class NativeProjectBindingLifecycle implements ProjectBindingLifecycle {
  private adapter: ProjectBindingSessionAdapter | undefined;
  private acceptedAllowedCapletIds: string[];
  private activeAllowedCapletIds: string[];
  private sentAllowedCapletIds: string[] | undefined;
  private started = false;
  private closing = false;
  private closed = false;
  private replacing = false;
  private cleanupFailed = false;
  private startInFlight: Promise<void> | undefined;
  private updateInFlight: Promise<void> | undefined;
  private closeInFlight: Promise<void> | undefined;
  private replacementInFlight: Promise<void> | undefined;

  constructor(adapter: ProjectBindingSessionAdapter | undefined, allowedCapletIds: string[]) {
    this.adapter = adapter;
    this.acceptedAllowedCapletIds = normalizeAllowedCapletIds(allowedCapletIds);
    this.activeAllowedCapletIds = [...this.acceptedAllowedCapletIds];
  }

  async start(): Promise<void> {
    if (!this.adapter || this.closing || this.closed || this.replacing || this.cleanupFailed) {
      return;
    }
    if (this.startInFlight) {
      await this.startInFlight;
      return;
    }
    const adapter = this.adapter;
    const start = this.startAdapter(adapter, false);
    this.startInFlight = start;
    try {
      await start;
    } finally {
      if (this.startInFlight === start) this.startInFlight = undefined;
    }
  }

  async updateAllowedCapletIds(allowedCapletIds: string[]): Promise<void> {
    const normalized = normalizeAllowedCapletIds(allowedCapletIds);
    if (sameAllowedCapletIds(normalized, this.acceptedAllowedCapletIds)) return;
    if (this.closing || this.closed || this.cleanupFailed) return;

    this.acceptedAllowedCapletIds = normalized;
    if (!this.replacing) {
      this.activeAllowedCapletIds = [...normalized];
    }
    if (!this.started || this.replacing) return;
    await this.flushAllowedCapletIds();
  }

  async replace(
    adapter: ProjectBindingSessionAdapter | undefined,
    beforeStart?: (() => Promise<void>) | undefined,
  ): Promise<void> {
    if (this.closed || this.closing) {
      adapter?.dispose?.();
      return;
    }
    if (this.replacementInFlight) {
      adapter?.dispose?.();
      await this.replacementInFlight;
      return;
    }

    const previous = this.adapter;
    this.replacing = true;
    previous?.prepareClose?.();
    const replacement = this.replaceAdapter(previous, adapter, beforeStart);
    this.replacementInFlight = replacement;
    try {
      await replacement;
    } finally {
      if (this.replacementInFlight === replacement) {
        this.replacementInFlight = undefined;
        this.replacing = false;
      }
    }
  }

  isCleanupFailed(): boolean {
    return this.cleanupFailed;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closeInFlight) {
      await this.closeInFlight;
      return;
    }

    this.closing = true;
    this.adapter?.prepareClose?.();
    const close = this.closeAdapter();
    this.closeInFlight = close;
    try {
      await close;
    } catch (error) {
      this.cleanupFailed = true;
      throw error;
    } finally {
      if (this.closeInFlight === close && !this.closed) this.closeInFlight = undefined;
    }
  }

  private async startAdapter(
    adapter: ProjectBindingSessionAdapter,
    allowReplacement: boolean,
  ): Promise<void> {
    // Yield once so an accepted source update in the construction turn seeds registration.
    await Promise.resolve();
    if (
      this.adapter !== adapter ||
      this.closed ||
      this.closing ||
      (!allowReplacement && this.replacing)
    ) {
      return;
    }

    const allowedCapletIds = [...this.activeAllowedCapletIds];
    const wasStarted = this.started;
    const registered = await adapter.start(allowedCapletIds);
    if (this.adapter !== adapter) return;
    if (registered === false && adapter.hasActiveSession?.() === false) {
      this.started = false;
      return;
    }

    this.started = true;
    if (!wasStarted || registered === true) {
      this.sentAllowedCapletIds = allowedCapletIds;
    }
    if (!this.closing && !this.replacing) {
      await this.flushAllowedCapletIds();
    }
  }

  private async flushAllowedCapletIds(): Promise<void> {
    if (!this.adapter || !this.started || this.closed || this.cleanupFailed) return;
    if (this.updateInFlight) {
      await this.updateInFlight;
      return;
    }

    const adapter = this.adapter;
    let lastAttempted: string[] | undefined;
    const update = (async () => {
      while (
        this.adapter === adapter &&
        this.started &&
        !this.closed &&
        !this.cleanupFailed &&
        !sameAllowedCapletIds(this.sentAllowedCapletIds, this.activeAllowedCapletIds)
      ) {
        const allowedCapletIds = [...this.activeAllowedCapletIds];
        if (adapter.hasActiveSession?.() === false) {
          const registered = await adapter.start(allowedCapletIds);
          if (this.adapter !== adapter) return;
          if (registered !== true) {
            this.started = false;
            return;
          }
          this.sentAllowedCapletIds = allowedCapletIds;
          continue;
        }
        lastAttempted = allowedCapletIds;
        await adapter.updateAllowedCapletIds(allowedCapletIds);
        if (this.adapter !== adapter) return;
        this.sentAllowedCapletIds = allowedCapletIds;
      }
    })();
    this.updateInFlight = update;
    let retryLatestAllowedCapletIds = false;
    try {
      await update;
    } catch (error) {
      retryLatestAllowedCapletIds =
        lastAttempted !== undefined &&
        !sameAllowedCapletIds(lastAttempted, this.activeAllowedCapletIds);
      throw error;
    } finally {
      if (this.updateInFlight === update) this.updateInFlight = undefined;
      if (
        retryLatestAllowedCapletIds &&
        this.adapter === adapter &&
        this.started &&
        !this.closed &&
        !this.cleanupFailed
      ) {
        void this.flushAllowedCapletIds().catch(() => undefined);
      }
    }
  }

  private async flushAcceptedAllowedCapletIds(): Promise<void> {
    while (this.adapter && this.started && !this.closed && !this.cleanupFailed) {
      this.activeAllowedCapletIds = [...this.acceptedAllowedCapletIds];
      await this.flushAllowedCapletIds();
      if (sameAllowedCapletIds(this.activeAllowedCapletIds, this.acceptedAllowedCapletIds)) return;
    }
  }

  private async replaceAdapter(
    previous: ProjectBindingSessionAdapter | undefined,
    candidate: ProjectBindingSessionAdapter | undefined,
    beforeStart: (() => Promise<void>) | undefined,
  ): Promise<void> {
    await this.startInFlight?.catch(() => undefined);
    if (previous && this.started) {
      await this.flushAllowedCapletIds().catch(() => undefined);
    }

    if (this.closed) {
      candidate?.dispose?.();
      return;
    }

    if (previous && (this.started || previous.hasActiveSession?.())) {
      try {
        await previous.close();
      } catch (error) {
        this.cleanupFailed = true;
        candidate?.dispose?.();
        throw error;
      }
      previous.dispose?.();
    } else {
      previous?.dispose?.();
    }
    if (this.adapter === previous) {
      this.adapter = undefined;
    }
    this.started = false;
    this.sentAllowedCapletIds = undefined;
    this.cleanupFailed = false;
    if (this.closing) {
      candidate?.dispose?.();
      this.closed = true;
      return;
    }
    try {
      await beforeStart?.();
    } catch (error) {
      candidate?.dispose?.();
      throw error;
    }
    this.adapter = candidate;
    this.activeAllowedCapletIds = [...this.acceptedAllowedCapletIds];
    if (!candidate) return;

    try {
      await this.startAdapter(candidate, true);
    } catch (error) {
      candidate.dispose?.();
      if (this.adapter === candidate) this.adapter = undefined;
      this.started = false;
      this.sentAllowedCapletIds = undefined;
      throw error;
    }
    await this.flushAcceptedAllowedCapletIds();
    if (!this.closing) return;

    candidate.prepareClose?.();
    if (this.started) {
      await candidate.close();
    }
    candidate.dispose?.();
    if (this.adapter === candidate) this.adapter = undefined;
    this.started = false;
    this.sentAllowedCapletIds = undefined;
    this.closed = true;
  }

  private async closeAdapter(): Promise<void> {
    const replacement = this.replacementInFlight;
    if (replacement) {
      await replacement;
      return;
    }

    await this.startInFlight?.catch(() => undefined);
    const adapter = this.adapter;
    if (!adapter || (!this.started && !adapter.hasActiveSession?.())) {
      adapter?.dispose?.();
      if (this.adapter === adapter) this.adapter = undefined;
      this.closed = true;
      return;
    }

    await this.flushAllowedCapletIds().catch(() => undefined);
    await adapter.close();
    adapter.dispose?.();
    if (this.adapter === adapter) this.adapter = undefined;
    this.started = false;
    this.sentAllowedCapletIds = undefined;
    this.closed = true;
  }
}

function normalizeAllowedCapletIds(allowedCapletIds: string[]): string[] {
  return [...new Set(allowedCapletIds)].sort();
}

function sameAllowedCapletIds(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
