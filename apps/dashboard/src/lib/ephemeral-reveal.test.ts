import { describe, expect, it, vi } from "vitest";
import { EPHEMERAL_REVEAL_TTL_MS, createEphemeralRevealExpiry } from "./ephemeral-reveal";

describe("createEphemeralRevealExpiry", () => {
  it("expires once after the configured TTL", () => {
    vi.useFakeTimers();
    try {
      const onExpire = vi.fn();
      const expiry = createEphemeralRevealExpiry(onExpire);

      expiry.replace();
      vi.advanceTimersByTime(EPHEMERAL_REVEAL_TTL_MS - 1);
      expect(onExpire).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(onExpire).toHaveBeenCalledOnce();

      vi.advanceTimersByTime(EPHEMERAL_REVEAL_TTL_MS);
      expect(onExpire).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces a pending expiry without letting the older timer expire the replacement", () => {
    vi.useFakeTimers();
    try {
      const onExpire = vi.fn();
      const expiry = createEphemeralRevealExpiry(onExpire);

      expiry.replace();
      vi.advanceTimersByTime(10_000);
      expiry.replace();

      vi.advanceTimersByTime(20_000);
      expect(onExpire).not.toHaveBeenCalled();

      vi.advanceTimersByTime(10_000);
      expect(onExpire).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending expiry idempotently", () => {
    vi.useFakeTimers();
    try {
      const onExpire = vi.fn();
      const expiry = createEphemeralRevealExpiry(onExpire);

      expiry.replace();
      expiry.cancel();
      expiry.cancel();
      vi.advanceTimersByTime(EPHEMERAL_REVEAL_TTL_MS);

      expect(onExpire).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
