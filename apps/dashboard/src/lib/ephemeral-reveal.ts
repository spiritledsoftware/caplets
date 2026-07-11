export const EPHEMERAL_REVEAL_TTL_MS = 30_000;

export type EphemeralRevealScheduler = {
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(handle: number): void;
};

export type EphemeralRevealExpiry = {
  replace(): void;
  cancel(): void;
};

export function createEphemeralRevealExpiry(
  onExpire: () => void,
  scheduler: EphemeralRevealScheduler = globalThis,
  ttlMs = EPHEMERAL_REVEAL_TTL_MS,
): EphemeralRevealExpiry {
  let timeout: number | undefined;

  const cancel = () => {
    if (timeout === undefined) return;
    scheduler.clearTimeout(timeout);
    timeout = undefined;
  };

  return {
    replace() {
      cancel();
      timeout = scheduler.setTimeout(() => {
        timeout = undefined;
        onExpire();
      }, ttlMs);
    },
    cancel,
  };
}
