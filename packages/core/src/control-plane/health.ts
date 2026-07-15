import { STORAGE_BENCHMARK_ENVELOPE, nearestRank } from "./storage-benchmark-envelope";
import type { ControlPlaneHealthSummary, ControlPlaneSnapshot } from "./types";

export function assertRedactedControlPlaneHealth(
  summary: ControlPlaneHealthSummary,
): ControlPlaneHealthSummary {
  inspectHealthValue(summary);
  return Object.freeze({ ...summary });
}

function inspectHealthValue(value: unknown): void {
  if (typeof value === "string") {
    if (
      /(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+|(?:postgres(?:ql)?|https?|file):\/\//iu.test(value)
    ) {
      throw new Error("Control-plane health summary contains deployment or credential detail");
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "authorityToken") {
      if (
        !nested ||
        typeof nested !== "object" ||
        Object.keys(nested).some(
          (tokenKey) => !["authorityGeneration", "effectiveGeneration"].includes(tokenKey),
        ) ||
        Object.values(nested).some(
          (tokenValue) => typeof tokenValue !== "number" || !Number.isSafeInteger(tokenValue),
        )
      ) {
        throw new Error("Control-plane health summary contains an invalid authority token");
      }
      continue;
    }
    if (/(?:password|secret|credential|connectionstring|dsn|url|path|endpoint|token)/iu.test(key)) {
      throw new Error("Control-plane health summary contains deployment or credential detail");
    }
    inspectHealthValue(nested);
  }
}

export function assertSnapshotWithinEnvelope(
  snapshot: ControlPlaneSnapshot,
  elapsedSamplesMs: readonly number[],
): Readonly<{ p99Ms: number; withinEnvelope: true }> {
  if (snapshot.caplets.length > STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets) {
    throw new Error("Snapshot exceeded the effective Caplet envelope");
  }
  if (snapshot.normalizedRows > STORAGE_BENCHMARK_ENVELOPE.maxNormalizedRows) {
    throw new Error("Snapshot exceeded the normalized row envelope");
  }
  if (snapshot.encodedBytes > STORAGE_BENCHMARK_ENVELOPE.maxEncodedSnapshotBytes) {
    throw new Error("Snapshot exceeded the encoded byte envelope");
  }
  const p99Ms = nearestRank(elapsedSamplesMs, 0.99);
  if (p99Ms > STORAGE_BENCHMARK_ENVELOPE.maxSnapshotLoadP99Ms) {
    throw new Error("Snapshot load p99 exceeded the immutable U2 threshold");
  }
  return Object.freeze({ p99Ms, withinEnvelope: true });
}
