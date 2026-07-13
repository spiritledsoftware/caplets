import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as InstallModule from "../src/cli/install";

const mocks = vi.hoisted(() => ({
  restore: vi.fn(),
}));

vi.mock("../src/cli/install", async (importOriginal) => ({
  ...(await importOriginal<typeof InstallModule>()),
  restoreCapletsFromLockfile: mocks.restore,
}));

import { runCli } from "../src/cli";

const dirs: string[] = [];

afterEach(() => {
  mocks.restore.mockReset();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("install human output", () => {
  it("labels content-only local restores as content updated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-cli-install-output-"));
    dirs.push(dir);
    const destination = join(dir, ".caplets", "github");
    const out: string[] = [];
    mocks.restore.mockReturnValue({
      installed: [
        {
          id: "github",
          destination,
          status: "content_updated",
        },
      ],
    });

    await runCli(["install", "github"], {
      env: {
        CAPLETS_CONFIG: join(dir, "missing-config.json"),
        CAPLETS_PROJECT_CONFIG: join(dir, ".caplets", "missing-config.json"),
        CAPLETS_DISABLE_CATALOG_INDEXING: "1",
      },
      writeOut: (value) => out.push(value),
    });

    expect(out.join("")).toBe(`Content updated github to ${destination}\n`);
  });
});
