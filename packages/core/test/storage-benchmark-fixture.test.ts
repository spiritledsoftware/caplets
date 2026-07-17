import { describe, expect, it } from "vitest";
import {
  STORAGE_BENCHMARK_ENVELOPE,
  nearestRank,
} from "../src/control-plane/storage-benchmark-envelope";

describe("immutable storage benchmark envelope", () => {
  it("freezes the declared maximum workload and methodology", () => {
    expect(STORAGE_BENCHMARK_ENVELOPE).toEqual({
      version: 1,
      maxEffectiveCaplets: 2_000,
      maxNormalizedRows: 100_000,
      maxEncodedSnapshotBytes: 256 * 1024 * 1024,
      managementWritesPerSecond: 100,
      minimumMeasuredManagementWritesPerSecond: 25,
      writeBurstSeconds: 10,
      maxReadyNodes: 16,
      warmupSamples: 10,
      measuredSamplesPerRun: 100,
      independentRuns: 3,
      maxSnapshotLoadP99Ms: 1_500,
      maxConvergenceP99Ms: 5_000,
    });
    expect(Object.isFrozen(STORAGE_BENCHMARK_ENVELOPE)).toBe(true);
  });

  it("uses nearest-rank boundary math without interpolation", () => {
    expect(nearestRank([40, 10, 30, 20], 0.5)).toBe(20);
    expect(
      nearestRank(
        Array.from({ length: 100 }, (_, index) => index + 1),
        0.99,
      ),
    ).toBe(99);
    expect(nearestRank([7], 0.99)).toBe(7);
    expect(() => nearestRank([], 0.99)).toThrow(/sample/i);
    expect(() => nearestRank([1, 2], 0)).toThrow(/percentile/i);
    expect(() => nearestRank([1, Number.NaN], 0.99)).toThrow(/finite/i);
  });
});
