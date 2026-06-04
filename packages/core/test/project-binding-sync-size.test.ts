import { describe, expect, it } from "vitest";

import {
  DEFAULT_SYNC_LIMITS,
  enforceProjectSyncSizeLimits,
} from "../src/project-binding/sync-size";

describe("Project Binding sync size limits", () => {
  it("returns sync_size_limit_exceeded with safe totals for hosted Free", () => {
    const result = enforceProjectSyncSizeLimits({
      tier: "free",
      files: [
        { relativePath: "src/a.ts", sizeBytes: 10 * 1024 * 1024 },
        { relativePath: "data/big.bin", sizeBytes: 30 * 1024 * 1024 },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      code: "sync_size_limit_exceeded",
      maxSingleFileBytes: DEFAULT_SYNC_LIMITS.free.maxSingleFileBytes,
      recoveryCommand: "Add exclusions to .capletsignore or upgrade the workspace plan.",
    });
    expect(JSON.stringify(result)).not.toContain("data/big.bin");
  });
});
