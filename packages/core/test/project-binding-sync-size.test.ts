import { describe, expect, it } from "vitest";

import {
  DEFAULT_SYNC_LIMITS,
  enforceProjectSyncSizeLimits,
} from "../src/project-binding/sync-size";

describe("Project Binding sync size limits", () => {
  it("enforces one bounded generic remote policy with neutral recovery", () => {
    const result = enforceProjectSyncSizeLimits({
      files: [
        { relativePath: "src/a.ts", sizeBytes: 10 * 1024 * 1024 },
        { relativePath: "data/big.bin", sizeBytes: DEFAULT_SYNC_LIMITS.maxSingleFileBytes + 1 },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      code: "sync_size_limit_exceeded",
      maxSingleFileBytes: DEFAULT_SYNC_LIMITS.maxSingleFileBytes,
      maxProjectBytes: DEFAULT_SYNC_LIMITS.maxProjectBytes,
      recoveryCommand: "Add exclusions to .capletsignore and retry.",
    });
    expect(JSON.stringify(result)).not.toContain("data/big.bin");
    expect(DEFAULT_SYNC_LIMITS).toEqual({
      maxSingleFileBytes: 250 * 1024 * 1024,
      maxProjectBytes: 5 * 1024 * 1024 * 1024,
    });
  });
});
