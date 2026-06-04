import type { ProjectBindingErrorCode } from "./errors";
import type { ProjectSyncManifestFile } from "./sync-filter";

export type ProjectSyncTier = "free" | "plus" | "pro" | "enterprise" | "self_hosted";

export type ProjectSyncLimits = {
  maxSingleFileBytes: number;
  maxProjectBytes: number;
};

export const DEFAULT_SYNC_LIMITS: Record<ProjectSyncTier, ProjectSyncLimits> = {
  free: { maxSingleFileBytes: 25 * 1024 * 1024, maxProjectBytes: 250 * 1024 * 1024 },
  plus: { maxSingleFileBytes: 100 * 1024 * 1024, maxProjectBytes: 1024 * 1024 * 1024 },
  pro: { maxSingleFileBytes: 250 * 1024 * 1024, maxProjectBytes: 5 * 1024 * 1024 * 1024 },
  enterprise: { maxSingleFileBytes: 250 * 1024 * 1024, maxProjectBytes: 5 * 1024 * 1024 * 1024 },
  self_hosted: { maxSingleFileBytes: 250 * 1024 * 1024, maxProjectBytes: 5 * 1024 * 1024 * 1024 },
};

export type ProjectSyncSizeResult =
  | {
      ok: true;
      totalBytes: number;
      maxSingleFileBytes: number;
      maxProjectBytes: number;
    }
  | {
      ok: false;
      code: ProjectBindingErrorCode;
      totalBytes: number;
      maxSingleFileBytes: number;
      maxProjectBytes: number;
      largestFileBytes?: number | undefined;
      recoveryCommand: string;
    };

export function enforceProjectSyncSizeLimits(input: {
  tier: ProjectSyncTier;
  files: ProjectSyncManifestFile[];
  limits?: Partial<ProjectSyncLimits> | undefined;
}): ProjectSyncSizeResult {
  const defaults = DEFAULT_SYNC_LIMITS[input.tier];
  const limits = { ...defaults, ...input.limits };
  const totalBytes = input.files.reduce((total, file) => total + file.sizeBytes, 0);
  const largestFileBytes = Math.max(0, ...input.files.map((file) => file.sizeBytes));
  if (largestFileBytes > limits.maxSingleFileBytes || totalBytes > limits.maxProjectBytes) {
    return {
      ok: false,
      code: "sync_size_limit_exceeded",
      totalBytes,
      maxSingleFileBytes: limits.maxSingleFileBytes,
      maxProjectBytes: limits.maxProjectBytes,
      largestFileBytes,
      recoveryCommand: "Add exclusions to .capletsignore or upgrade the workspace plan.",
    };
  }
  return {
    ok: true,
    totalBytes,
    maxSingleFileBytes: limits.maxSingleFileBytes,
    maxProjectBytes: limits.maxProjectBytes,
  };
}
