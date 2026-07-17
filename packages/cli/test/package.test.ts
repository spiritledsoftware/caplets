import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "@caplets/core";
import { main } from "../src/index";

vi.mock("@caplets/core", () => ({ runCli: vi.fn(async () => undefined) }));

describe("caplets package metadata", () => {
  it("declares the published CLI entrypoint", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as { bin?: Record<string, string>; main?: string; files?: string[] };

    expect(packageJson.bin?.caplets).toBe("dist/index.js");
    expect(packageJson.main).toBe("dist/index.js");
    expect(packageJson.files).toContain("dist");
  });

  it("delegates shipped commands to the production core CLI without private client injection", async () => {
    await main(["storage", "management", "status", "--global"]);

    expect(runCli).toHaveBeenCalledWith(
      ["storage", "management", "status", "--global"],
      expect.objectContaining({
        version: expect.any(String),
      }),
    );
    expect(vi.mocked(runCli).mock.calls[0]?.[1]).not.toHaveProperty(
      "internalCurrentHostManagement",
    );
    expect(vi.mocked(runCli).mock.calls[0]?.[1]).not.toHaveProperty(
      "internalCurrentHostOfflineTransfer",
    );
  });
});
