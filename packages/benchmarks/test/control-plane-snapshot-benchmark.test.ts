import { describe, expect, it } from "vitest";
import { STORAGE_BENCHMARK_ENVELOPE } from "@caplets/core/control-plane/storage";
import {
  FULL_ENVELOPE_SNAPSHOT_PROFILE,
  createScaledLocalSnapshotProfile,
  runSnapshotLoadBenchmark,
  summarizeSnapshotLoadRuns,
  type SnapshotLoadSample,
} from "../lib/control-plane-snapshot-benchmark";

function sample(totalMs: number): SnapshotLoadSample {
  return {
    sqlReadMs: totalMs / 4,
    decodeMs: totalMs / 4,
    allocationMs: totalMs / 2,
    totalMs,
  };
}

describe("control-plane snapshot benchmark", () => {
  it("keeps the dedicated-CI profile pinned to the immutable U2 envelope", () => {
    expect(FULL_ENVELOPE_SNAPSHOT_PROFILE).toMatchObject({
      profile: "full-envelope",
      evidence: "full-envelope",
      effectiveCaplets: STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets,
      normalizedRows: STORAGE_BENCHMARK_ENVELOPE.maxNormalizedRows,
      encodedSnapshotBytes: STORAGE_BENCHMARK_ENVELOPE.maxEncodedSnapshotBytes,
      managementWritesPerSecond: STORAGE_BENCHMARK_ENVELOPE.managementWritesPerSecond,
      writeBurstSeconds: STORAGE_BENCHMARK_ENVELOPE.writeBurstSeconds,
      writeBurstMutations:
        STORAGE_BENCHMARK_ENVELOPE.managementWritesPerSecond *
        STORAGE_BENCHMARK_ENVELOPE.writeBurstSeconds,
      refreshers: STORAGE_BENCHMARK_ENVELOPE.maxReadyNodes,
      warmupSamples: STORAGE_BENCHMARK_ENVELOPE.warmupSamples,
      measuredSamplesPerRun: STORAGE_BENCHMARK_ENVELOPE.measuredSamplesPerRun,
      independentRuns: STORAGE_BENCHMARK_ENVELOPE.independentRuns,
      maxP99Ms: STORAGE_BENCHMARK_ENVELOPE.maxSnapshotLoadP99Ms,
      notificationMode: "suppressed",
    });
  });

  it("labels bounded local evidence as scaled rather than full-envelope", () => {
    const profile = createScaledLocalSnapshotProfile({
      effectiveCaplets: 20,
      normalizedRows: 1_000,
      encodedSnapshotBytes: 1_048_576,
      warmupSamples: 1,
      measuredSamplesPerRun: 2,
      independentRuns: 1,
    });

    expect(profile).toMatchObject({
      profile: "scaled-local",
      evidence: "scaled-local-not-full-envelope",
      refreshers: 16,
      notificationMode: "suppressed",
    });
    expect(() =>
      createScaledLocalSnapshotProfile({
        effectiveCaplets: STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets,
        normalizedRows: STORAGE_BENCHMARK_ENVELOPE.maxNormalizedRows,
        encodedSnapshotBytes: STORAGE_BENCHMARK_ENVELOPE.maxEncodedSnapshotBytes,
      }),
    ).toThrow(/full-envelope/i);
  });

  it("uses nearest-rank p99 and deterministic all-run pass metadata", () => {
    const profile = createScaledLocalSnapshotProfile({
      effectiveCaplets: 2,
      normalizedRows: 4,
      encodedSnapshotBytes: 128,
      measuredSamplesPerRun: 1,
      independentRuns: 2,
      maxP99Ms: 10,
    });
    const first = Array.from({ length: 16 }, (_, index) => sample(index + 1));
    const second = Array.from({ length: 16 }, () => sample(5));

    expect(summarizeSnapshotLoadRuns(profile, [first, second])).toMatchObject({
      status: "fail",
      passed: false,
      failedRunIndexes: [0],
      methodology: {
        percentile: 0.99,
        percentileMethod: "nearest-rank",
        notificationMode: "suppressed",
        concurrentRefreshers: 16,
      },
      runs: [
        { p99: { totalMs: 16 }, passed: false },
        { p99: { totalMs: 5 }, passed: true },
      ],
    });
  });

  it("measures SQL read, decode, and allocation for all 16 suppressed refreshers", async () => {
    const calls = { burst: 0, read: 0, decode: 0, allocate: 0 };
    const profile = createScaledLocalSnapshotProfile({
      effectiveCaplets: 1,
      normalizedRows: 1,
      encodedSnapshotBytes: 2,
      warmupSamples: 1,
      measuredSamplesPerRun: 2,
      independentRuns: 1,
      maxP99Ms: 1_500,
    });

    const result = await runSnapshotLoadBenchmark({
      profile,
      applyWriteBurst: async ({ mutations }) => {
        calls.burst += 1;
        return mutations;
      },
      readSql: async () => {
        calls.read += 1;
        return new Uint8Array([91, 93]);
      },
      decode: (bytes) => {
        calls.decode += 1;
        return JSON.parse(new TextDecoder().decode(bytes));
      },
      allocate: (decoded) => {
        calls.allocate += 1;
        return [...(decoded as unknown[])];
      },
    });

    expect(calls).toEqual({ burst: 1, read: 48, decode: 48, allocate: 48 });
    expect(result).toMatchObject({
      status: "pass",
      passed: true,
      failedRunIndexes: [],
      profile: { evidence: "scaled-local-not-full-envelope" },
    });
    expect(result.runs[0]?.sampleCount).toBe(32);
  });

  it("executes the immutable full profile for three complete passing runs", async () => {
    const appliedWriteBursts: number[] = [];
    let reads = 0;
    const result = await runSnapshotLoadBenchmark({
      profile: FULL_ENVELOPE_SNAPSHOT_PROFILE,
      applyWriteBurst: async ({ mutations }) => {
        appliedWriteBursts.push(mutations);
        return mutations;
      },
      readSql: async () => {
        reads += 1;
        return new Uint8Array([91, 93]);
      },
      decode: (bytes) => JSON.parse(new TextDecoder().decode(bytes)),
      allocate: (decoded) => [...(decoded as unknown[])],
    });

    expect(appliedWriteBursts).toEqual(
      Array.from(
        { length: STORAGE_BENCHMARK_ENVELOPE.independentRuns },
        () =>
          STORAGE_BENCHMARK_ENVELOPE.managementWritesPerSecond *
          STORAGE_BENCHMARK_ENVELOPE.writeBurstSeconds,
      ),
    );
    expect(reads).toBe(
      (STORAGE_BENCHMARK_ENVELOPE.warmupSamples +
        STORAGE_BENCHMARK_ENVELOPE.measuredSamplesPerRun) *
        STORAGE_BENCHMARK_ENVELOPE.independentRuns *
        STORAGE_BENCHMARK_ENVELOPE.maxReadyNodes,
    );
    expect(result).toMatchObject({
      status: "pass",
      failedRunIndexes: [],
      runs: [
        { sampleCount: 1_600, passed: true },
        { sampleCount: 1_600, passed: true },
        { sampleCount: 1_600, passed: true },
      ],
    });
  });
});
