import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach } from "vitest";

const REMOTE_ENV_KEYS = [
  "CAPLETS_REMOTE_URL",
  "CAPLETS_REMOTE_USER",
  "CAPLETS_REMOTE_PASSWORD",
  "CAPLETS_REMOTE_TOKEN",
  "CAPLETS_REMOTE_WORKSPACE",
] as const;

const testStateRoot = mkdtempSync(join(tmpdir(), "caplets-core-test-state-"));
process.env.XDG_STATE_HOME = testStateRoot;

afterAll(() => {
  rmSync(testStateRoot, { recursive: true, force: true });
});

beforeEach(() => {
  for (const key of REMOTE_ENV_KEYS) {
    delete process.env[key];
  }
});
