import { performance } from "node:perf_hooks";
import { STORAGE_BENCHMARK_ENVELOPE, nearestRank } from "@caplets/core/control-plane/storage";

export type SnapshotBenchmarkProfile = Readonly<{
  profile: "full-envelope" | "scaled-local";
  evidence: "full-envelope" | "scaled-local-not-full-envelope";
  effectiveCaplets: number;
  normalizedRows: number;
  encodedSnapshotBytes: number;
  managementWritesPerSecond: number;
  writeBurstSeconds: number;
  writeBurstMutations: number;
  refreshers: 16;
  warmupSamples: number;
  measuredSamplesPerRun: number;
  independentRuns: number;
  maxP99Ms: number;
  notificationMode: "suppressed";
}>;

export type ScaledLocalSnapshotProfileOptions = Partial<
  Pick<
    SnapshotBenchmarkProfile,
    | "effectiveCaplets"
    | "normalizedRows"
    | "encodedSnapshotBytes"
    | "managementWritesPerSecond"
    | "writeBurstSeconds"
    | "warmupSamples"
    | "measuredSamplesPerRun"
    | "independentRuns"
    | "maxP99Ms"
  >
>;

export type SnapshotLoadSample = Readonly<{
  sqlReadMs: number;
  decodeMs: number;
  allocationMs: number;
  totalMs: number;
}>;

type SnapshotLoadP99 = SnapshotLoadSample;

export type SnapshotLoadBenchmarkResult = Readonly<{
  schemaVersion: 1;
  benchmark: "control-plane-snapshot-sql-read-decode-allocation";
  status: "pass" | "fail";
  passed: boolean;
  failedRunIndexes: readonly number[];
  profile: SnapshotBenchmarkProfile;
  methodology: Readonly<{
    percentile: 0.99;
    percentileMethod: "nearest-rank";
    notificationMode: "suppressed";
    concurrentRefreshers: 16;
    passRule: "every-independent-run";
  }>;
  runs: readonly Readonly<{
    runIndex: number;
    sampleCount: number;
    p99: SnapshotLoadP99;
    passed: boolean;
  }>[];
}>;

export type SnapshotLoadBenchmarkOptions<Encoded, Decoded, Allocated> = Readonly<{
  profile: SnapshotBenchmarkProfile;
  applyWriteBurst(
    context: Readonly<{
      runIndex: number;
      mutations: number;
    }>,
  ): number | Promise<number>;
  readSql(
    context: Readonly<{ runIndex: number; sampleIndex: number; refresherIndex: number }>,
  ): Encoded | Promise<Encoded>;
  decode(encoded: Encoded): Decoded;
  allocate(decoded: Decoded): Allocated;
  now?: () => number;
}>;

export const FULL_ENVELOPE_SNAPSHOT_PROFILE: SnapshotBenchmarkProfile = Object.freeze({
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

export function createScaledLocalSnapshotProfile(
  options: ScaledLocalSnapshotProfileOptions = {},
): SnapshotBenchmarkProfile {
  const profile: SnapshotBenchmarkProfile = {
    profile: "scaled-local",
    evidence: "scaled-local-not-full-envelope",
    effectiveCaplets: options.effectiveCaplets ?? 20,
    normalizedRows: options.normalizedRows ?? 1_000,
    encodedSnapshotBytes: options.encodedSnapshotBytes ?? 1024 * 1024,
    managementWritesPerSecond:
      options.managementWritesPerSecond ?? STORAGE_BENCHMARK_ENVELOPE.managementWritesPerSecond,
    writeBurstSeconds: options.writeBurstSeconds ?? STORAGE_BENCHMARK_ENVELOPE.writeBurstSeconds,
    writeBurstMutations:
      (options.managementWritesPerSecond ?? STORAGE_BENCHMARK_ENVELOPE.managementWritesPerSecond) *
      (options.writeBurstSeconds ?? STORAGE_BENCHMARK_ENVELOPE.writeBurstSeconds),
    refreshers: STORAGE_BENCHMARK_ENVELOPE.maxReadyNodes,
    warmupSamples: options.warmupSamples ?? 1,
    measuredSamplesPerRun: options.measuredSamplesPerRun ?? 5,
    independentRuns: options.independentRuns ?? 1,
    maxP99Ms: options.maxP99Ms ?? STORAGE_BENCHMARK_ENVELOPE.maxSnapshotLoadP99Ms,
    notificationMode: "suppressed",
  };

  assertPositiveInteger("effectiveCaplets", profile.effectiveCaplets);
  assertPositiveInteger("normalizedRows", profile.normalizedRows);
  assertPositiveInteger("encodedSnapshotBytes", profile.encodedSnapshotBytes);
  assertNonNegativeInteger("warmupSamples", profile.warmupSamples);
  assertPositiveInteger("measuredSamplesPerRun", profile.measuredSamplesPerRun);
  assertPositiveInteger("independentRuns", profile.independentRuns);
  assertPositiveFinite("maxP99Ms", profile.maxP99Ms);
  assertAtMost(
    "effectiveCaplets",
    profile.effectiveCaplets,
    STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets,
  );
  assertAtMost(
    "normalizedRows",
    profile.normalizedRows,
    STORAGE_BENCHMARK_ENVELOPE.maxNormalizedRows,
  );
  assertAtMost(
    "encodedSnapshotBytes",
    profile.encodedSnapshotBytes,
    STORAGE_BENCHMARK_ENVELOPE.maxEncodedSnapshotBytes,
  );
  assertPositiveInteger("managementWritesPerSecond", profile.managementWritesPerSecond);
  assertPositiveInteger("writeBurstSeconds", profile.writeBurstSeconds);
  assertPositiveInteger("writeBurstMutations", profile.writeBurstMutations);
  assertAtMost(
    "managementWritesPerSecond",
    profile.managementWritesPerSecond,
    STORAGE_BENCHMARK_ENVELOPE.managementWritesPerSecond,
  );
  assertAtMost(
    "writeBurstSeconds",
    profile.writeBurstSeconds,
    STORAGE_BENCHMARK_ENVELOPE.writeBurstSeconds,
  );

  if (
    profile.effectiveCaplets === STORAGE_BENCHMARK_ENVELOPE.maxEffectiveCaplets &&
    profile.normalizedRows === STORAGE_BENCHMARK_ENVELOPE.maxNormalizedRows &&
    profile.encodedSnapshotBytes === STORAGE_BENCHMARK_ENVELOPE.maxEncodedSnapshotBytes
  ) {
    throw new Error("The full-envelope workload must use FULL_ENVELOPE_SNAPSHOT_PROFILE.");
  }

  return Object.freeze(profile);
}

export async function runSnapshotLoadBenchmark<Encoded, Decoded, Allocated>(
  options: SnapshotLoadBenchmarkOptions<Encoded, Decoded, Allocated>,
): Promise<SnapshotLoadBenchmarkResult> {
  assertProfile(options.profile);
  const now = options.now ?? performance.now.bind(performance);
  const measuredRuns: SnapshotLoadSample[][] = [];

  for (let runIndex = 0; runIndex < options.profile.independentRuns; runIndex += 1) {
    const appliedMutations = await options.applyWriteBurst({
      runIndex,
      mutations: options.profile.writeBurstMutations,
    });
    if (appliedMutations !== options.profile.writeBurstMutations) {
      throw new Error("Snapshot benchmark write burst did not apply the declared mutation count.");
    }
    for (let sampleIndex = 0; sampleIndex < options.profile.warmupSamples; sampleIndex += 1) {
      await measureConcurrentRefreshers(options, now, runIndex, sampleIndex);
    }

    const samples: SnapshotLoadSample[] = [];
    for (
      let sampleIndex = 0;
      sampleIndex < options.profile.measuredSamplesPerRun;
      sampleIndex += 1
    ) {
      samples.push(...(await measureConcurrentRefreshers(options, now, runIndex, sampleIndex)));
    }
    measuredRuns.push(samples);
  }

  return summarizeSnapshotLoadRuns(options.profile, measuredRuns);
}

export function summarizeSnapshotLoadRuns(
  profile: SnapshotBenchmarkProfile,
  measuredRuns: readonly (readonly SnapshotLoadSample[])[],
): SnapshotLoadBenchmarkResult {
  assertProfile(profile);
  if (measuredRuns.length !== profile.independentRuns) {
    throw new Error("Snapshot benchmark run count does not match the selected profile.");
  }
  const expectedSamples = profile.refreshers * profile.measuredSamplesPerRun;
  const runs = measuredRuns.map((samples, runIndex) => {
    if (samples.length !== expectedSamples) {
      throw new Error(
        `Snapshot benchmark run ${runIndex} does not contain ${expectedSamples} samples.`,
      );
    }
    samples.forEach(assertSample);
    const p99 = {
      sqlReadMs: nearestRank(
        samples.map((sample) => sample.sqlReadMs),
        0.99,
      ),
      decodeMs: nearestRank(
        samples.map((sample) => sample.decodeMs),
        0.99,
      ),
      allocationMs: nearestRank(
        samples.map((sample) => sample.allocationMs),
        0.99,
      ),
      totalMs: nearestRank(
        samples.map((sample) => sample.totalMs),
        0.99,
      ),
    };
    return Object.freeze({
      runIndex,
      sampleCount: samples.length,
      p99: Object.freeze(p99),
      passed: p99.totalMs <= profile.maxP99Ms,
    });
  });
  const failedRunIndexes = runs.filter((run) => !run.passed).map((run) => run.runIndex);
  const passed = failedRunIndexes.length === 0;

  return Object.freeze({
    schemaVersion: 1,
    benchmark: "control-plane-snapshot-sql-read-decode-allocation",
    status: passed ? "pass" : "fail",
    passed,
    failedRunIndexes: Object.freeze(failedRunIndexes),
    profile,
    methodology: Object.freeze({
      percentile: 0.99,
      percentileMethod: "nearest-rank",
      notificationMode: "suppressed",
      concurrentRefreshers: STORAGE_BENCHMARK_ENVELOPE.maxReadyNodes,
      passRule: "every-independent-run",
    }),
    runs: Object.freeze(runs),
  });
}

async function measureConcurrentRefreshers<Encoded, Decoded, Allocated>(
  options: SnapshotLoadBenchmarkOptions<Encoded, Decoded, Allocated>,
  now: () => number,
  runIndex: number,
  sampleIndex: number,
): Promise<SnapshotLoadSample[]> {
  return Promise.all(
    Array.from({ length: options.profile.refreshers }, async (_, refresherIndex) => {
      const readStarted = now();
      const encoded = await options.readSql({ runIndex, sampleIndex, refresherIndex });
      const readFinished = now();
      const decoded = options.decode(encoded);
      const decodeFinished = now();
      const allocated = options.allocate(decoded);
      const allocationFinished = now();
      void allocated;
      const sqlReadMs = readFinished - readStarted;
      const decodeMs = decodeFinished - readFinished;
      const allocationMs = allocationFinished - decodeFinished;
      return {
        sqlReadMs,
        decodeMs,
        allocationMs,
        totalMs: sqlReadMs + decodeMs + allocationMs,
      };
    }),
  );
}

function assertProfile(profile: SnapshotBenchmarkProfile): void {
  if (profile.refreshers !== STORAGE_BENCHMARK_ENVELOPE.maxReadyNodes) {
    throw new Error("Snapshot benchmarks require exactly 16 concurrent refreshers.");
  }
  if (profile.notificationMode !== "suppressed") {
    throw new Error("Snapshot benchmarks require notifications to be suppressed.");
  }
  if (profile.profile === "full-envelope") {
    for (const key of Object.keys(
      FULL_ENVELOPE_SNAPSHOT_PROFILE,
    ) as (keyof SnapshotBenchmarkProfile)[]) {
      if (profile[key] !== FULL_ENVELOPE_SNAPSHOT_PROFILE[key]) {
        throw new Error(
          "Full-envelope benchmark profile must remain pinned to the immutable U2 envelope.",
        );
      }
    }
  }
}

function assertSample(sample: SnapshotLoadSample): void {
  for (const [name, value] of Object.entries(sample)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Snapshot benchmark ${name} must be a finite non-negative duration.`);
    }
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer.`);
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${name} must be positive and finite.`);
}

function assertAtMost(name: string, value: number, maximum: number): void {
  if (value > maximum) throw new Error(`${name} exceeds the immutable U2 envelope maximum.`);
}
