export type RateLimitDecision = {
  allowed: boolean;
  retryAfterSeconds?: number | undefined;
};

export function refractoryWindowAllows(input: {
  nowMs: number;
  previousAcceptedAtMs?: number | undefined;
  windowMs: number;
}): RateLimitDecision {
  if (input.previousAcceptedAtMs === undefined) {
    return { allowed: true };
  }
  const nextAllowedAt = input.previousAcceptedAtMs + input.windowMs;
  if (input.nowMs >= nextAllowedAt) {
    return { allowed: true };
  }
  return {
    allowed: false,
    retryAfterSeconds: Math.ceil((nextAllowedAt - input.nowMs) / 1000),
  };
}
