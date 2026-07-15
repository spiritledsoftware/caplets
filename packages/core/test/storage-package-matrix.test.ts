import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface StoragePackageMatrix {
  version: 1;
  bunVersion: string;
  supported: Array<{
    id: string;
    runtime: "node" | "bun" | "docker";
    version: string;
    os: "linux" | "darwin" | "win32";
    arch: "x64" | "arm64";
    libc: "glibc" | "system";
    runner: string;
    image?: string;
  }>;
  unsupported: Array<{ os: string; arch: string; reason: string }>;
}

const matrix = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../storage/package-matrix.json"), "utf8"),
) as StoragePackageMatrix;
const ci = readFileSync(resolve(import.meta.dirname, "../../../.github/workflows/ci.yml"), "utf8");

describe("storage package matrix manifest", () => {
  it("declares every supported runtime/OS/architecture tuple exactly once", () => {
    expect(matrix.version).toBe(1);
    expect(matrix.bunVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(matrix.supported).toHaveLength(14);
    expect(new Set(matrix.supported.map((tuple) => tuple.id)).size).toBe(matrix.supported.length);
    expect(matrix.supported.filter((tuple) => tuple.runtime === "node")).toHaveLength(10);
    expect(matrix.supported.filter((tuple) => tuple.runtime === "bun")).toHaveLength(2);
    expect(matrix.supported.every((tuple) => tuple.version.length > 0)).toBe(true);
    expect(matrix.supported.every((tuple) => tuple.runner.length > 0)).toBe(true);
    expect(matrix.supported.filter((tuple) => tuple.runtime === "docker")).toHaveLength(2);
  });

  it("keeps unsupported tuples explicit instead of treating absence as evidence", () => {
    expect(matrix.unsupported).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ os: "linux-musl" }),
        expect.objectContaining({ os: "win32", arch: "arm64" }),
        expect.objectContaining({ os: "win32", reason: expect.stringContaining("Bun") }),
        expect.objectContaining({ arch: "32-bit" }),
      ]),
    );
  });

  it("wires every supported tuple to the blocking package matrix job", () => {
    expect(ci).toContain("storage-package-matrix:");
    expect(ci).toContain("pnpm storage:package:check");
    for (const tuple of matrix.supported) expect(ci).toContain(`id: ${tuple.id}`);
  });
});
