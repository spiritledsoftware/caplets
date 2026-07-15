import envelope from "../../../../../storage/benchmark-envelope.json";

export type StorageBenchmarkEnvelope = Readonly<{
  version: 1;
  maxEffectiveCaplets: 2_000;
  maxNormalizedRows: 100_000;
  maxEncodedSnapshotBytes: 268_435_456;
  managementWritesPerSecond: 100;
  writeBurstSeconds: 10;
  maxReadyNodes: 16;
  warmupSamples: 10;
  measuredSamplesPerRun: 100;
  independentRuns: 3;
  maxSnapshotLoadP99Ms: 1_500;
  maxConvergenceP99Ms: 5_000;
}>;

assertEnvelope(envelope);

export const STORAGE_BENCHMARK_ENVELOPE: StorageBenchmarkEnvelope = Object.freeze({
  ...envelope,
});

export function nearestRank(samples: readonly number[], percentile: number): number {
  if (samples.length === 0) throw new Error("Nearest-rank requires at least one sample.");
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) {
    throw new Error("Nearest-rank percentile must be greater than zero and at most one.");
  }
  if (samples.some((sample) => !Number.isFinite(sample))) {
    throw new Error("Nearest-rank samples must be finite.");
  }
  const ordered = [...samples].sort((left, right) => left - right);
  const rank = Math.ceil(percentile * ordered.length);
  return ordered[rank - 1]!;
}

function assertEnvelope(value: Record<string, number>): asserts value is StorageBenchmarkEnvelope {
  const expected: Record<keyof StorageBenchmarkEnvelope, number> = {
    version: 1,
    maxEffectiveCaplets: 2_000,
    maxNormalizedRows: 100_000,
    maxEncodedSnapshotBytes: 256 * 1024 * 1024,
    managementWritesPerSecond: 100,
    writeBurstSeconds: 10,
    maxReadyNodes: 16,
    warmupSamples: 10,
    measuredSamplesPerRun: 100,
    independentRuns: 3,
    maxSnapshotLoadP99Ms: 1_500,
    maxConvergenceP99Ms: 5_000,
  };
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index]) ||
    expectedKeys.some((key) => value[key] !== expected[key as keyof typeof expected])
  ) {
    throw new Error("Storage benchmark envelope drifted from the immutable U2 contract.");
  }
}
