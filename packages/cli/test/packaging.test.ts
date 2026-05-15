import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { version as packageVersion } from "../package.json";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("caplets package entrypoint", () => {
  it("can start far enough to print its version from the built bin", async () => {
    await execFileAsync("pnpm", ["build"], { cwd: packageRoot });

    const { stdout } = await execFileAsync(process.execPath, ["dist/index.js", "--version"], {
      cwd: packageRoot,
    });

    expect(stdout.trim()).toBe(packageVersion);
  });
});
