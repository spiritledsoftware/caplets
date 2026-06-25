import { gt, parse, prerelease, rcompare, valid } from "semver";

export type PackageVersionMetadata = {
  packageName: string;
  distTags: Record<string, string>;
  versions: string[];
};

export type AvailableUpdate =
  | { available: true; runningVersion: string; latestVersion: string }
  | { available: false; reason: "invalid-running-version" | "no-eligible-version" };

export function findAvailableUpdate(
  runningVersion: string | undefined,
  metadata: PackageVersionMetadata,
): AvailableUpdate {
  const normalizedRunning = runningVersion ? valid(runningVersion) : null;
  if (!normalizedRunning) {
    return { available: false, reason: "invalid-running-version" };
  }

  const runningPrerelease = prerelease(normalizedRunning);
  const candidates =
    runningPrerelease && runningPrerelease.length > 0
      ? prereleaseCandidates(normalizedRunning, metadata.versions)
      : stableCandidates(metadata);
  const latestVersion = candidates.find((candidate) => gt(candidate, normalizedRunning));

  if (!latestVersion) {
    return { available: false, reason: "no-eligible-version" };
  }

  return { available: true, runningVersion: normalizedRunning, latestVersion };
}

function stableCandidates(metadata: PackageVersionMetadata): string[] {
  const versions = new Set<string>();
  const latest = valid(metadata.distTags.latest);
  if (latest && !prerelease(latest)) versions.add(latest);
  for (const version of metadata.versions) {
    const normalized = valid(version);
    if (normalized && !prerelease(normalized)) versions.add(normalized);
  }
  return [...versions].sort(rcompare);
}

function prereleaseCandidates(runningVersion: string, versions: string[]): string[] {
  const running = parse(runningVersion);
  const runningPrerelease = prerelease(runningVersion);
  if (!running || !runningPrerelease?.length) return [];
  const runningIdentifier = String(runningPrerelease[0]);

  return versions
    .map((version) => valid(version))
    .filter((version): version is string => Boolean(version))
    .filter((version) => {
      const candidate = parse(version);
      const candidatePrerelease = prerelease(version);
      return (
        Boolean(candidate) &&
        candidate!.major === running.major &&
        candidate!.minor === running.minor &&
        candidate!.patch === running.patch &&
        candidatePrerelease?.length !== undefined &&
        candidatePrerelease.length > 0 &&
        String(candidatePrerelease[0]) === runningIdentifier
      );
    })
    .sort(rcompare);
}
