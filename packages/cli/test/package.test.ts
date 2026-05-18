import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("caplets package metadata", () => {
  it("declares the published CLI entrypoint", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as { bin?: Record<string, string>; main?: string; files?: string[] };

    expect(packageJson.bin?.caplets).toBe("dist/index.js");
    expect(packageJson.main).toBe("dist/index.js");
    expect(packageJson.files).toContain("dist");
  });
});
