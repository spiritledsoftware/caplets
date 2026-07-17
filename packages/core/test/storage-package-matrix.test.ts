import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
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
  unsupported: Array<{
    runtime: "node" | "bun" | "any";
    os: string;
    arch: string;
    reason: string;
    guidance: string;
  }>;
}

interface StorageCiWorkflow {
  jobs: {
    "storage-package-matrix": {
      strategy: {
        matrix: {
          include: Array<{
            id: string;
            runner: string;
            runtime: "node" | "bun" | "docker";
            version: string;
            image?: string;
          }>;
        };
      };
    };
    "storage-stack": {
      services: { postgres: { image: string } };
      steps: Array<{ name: string; run?: string }>;
    };
  };
}

const matrix = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../../storage/package-matrix.json"), "utf8"),
) as StoragePackageMatrix;
const ci = parse(
  readFileSync(resolve(import.meta.dirname, "../../../.github/workflows/ci.yml"), "utf8"),
) as StorageCiWorkflow;

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

  it("keeps unsupported tuples explicit and actionable instead of treating absence as evidence", () => {
    expect(matrix.unsupported).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ os: "linux-musl" }),
        expect.objectContaining({ runtime: "node", os: "win32", arch: "arm64" }),
        expect.objectContaining({
          runtime: "bun",
          os: "win32",
          reason: expect.stringContaining("Bun"),
        }),
        expect.objectContaining({ arch: "32-bit" }),
      ]),
    );
    expect(matrix.unsupported.every((tuple) => tuple.reason.length > 0)).toBe(true);
    expect(matrix.unsupported.every((tuple) => tuple.guidance.length > 0)).toBe(true);
  });

  it("wires every supported tuple to the blocking package matrix job", () => {
    const include = ci.jobs["storage-package-matrix"].strategy.matrix.include;
    expect(include.map((tuple) => tuple.id)).toEqual(matrix.supported.map((tuple) => tuple.id));
    for (const tuple of matrix.supported) {
      expect(include).toContainEqual({
        id: tuple.id,
        runner: tuple.runner,
        runtime: tuple.runtime,
        version: tuple.version,
        ...(tuple.image ? { image: tuple.image } : {}),
      });
    }
  });

  it("uses real Postgres and S3-compatible services in the storage stack gate", () => {
    const storageStack = ci.jobs["storage-stack"];
    expect(storageStack.services.postgres.image).toMatch(/^postgres:16/u);
    expect(
      storageStack.steps.some(
        (step) =>
          step.name === "Start S3-compatible fixture" && step.run?.includes("quay.io/minio/minio:"),
      ),
    ).toBe(true);
  });

  it("fails unknown tuples with actionable guidance before attempting a package build", () => {
    const check = spawnSync(
      process.execPath,
      [
        resolve(import.meta.dirname, "../../../scripts/storage-package-check.mjs"),
        "--tuple",
        "nope",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, CAPLETS_STORAGE_RUNTIME_VERSION: "0.0.0" },
      },
    );
    expect(check.status).not.toBe(0);
    const result = JSON.parse(check.stdout) as { status: string; error: string };
    expect(result.status).toBe("fail");
    expect(result.error).toContain("storage/package-matrix.json");
    expect(result.error).toContain("Use ");
    if (process.arch === "x64" || process.arch === "arm64") {
      expect(result.error).not.toContain("32-bit targets are unsupported");
    }
  });
});
