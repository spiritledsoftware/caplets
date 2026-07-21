import type { ProjectBindingErrorCode } from "./errors";
import type { ProjectSyncManifestFile } from "./sync-filter";

export type ProjectSyncLimits = {
  maxSingleFileBytes: number;
  maxProjectBytes: number;
};

export const DEFAULT_SYNC_LIMITS: ProjectSyncLimits = {
  maxSingleFileBytes: 250 * 1024 * 1024,
  maxProjectBytes: 5 * 1024 * 1024 * 1024,
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
  files: ProjectSyncManifestFile[];
  limits?: Partial<ProjectSyncLimits> | undefined;
}): ProjectSyncSizeResult {
  const limits = { ...DEFAULT_SYNC_LIMITS, ...input.limits };
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
      recoveryCommand: "Add exclusions to .capletsignore and retry.",
    };
  }
  return {
    ok: true,
    totalBytes,
    maxSingleFileBytes: limits.maxSingleFileBytes,
    maxProjectBytes: limits.maxProjectBytes,
  };
}
