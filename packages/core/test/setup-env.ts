import { beforeEach } from "vitest";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

// macOS reports subprocess working directories through the canonical /private/var alias.
if (process.platform === "darwin") {
  process.env.TMPDIR = realpathSync(tmpdir());
}

const REMOTE_ENV_KEYS = [
  "CAPLETS_REMOTE_URL",
  "CAPLETS_REMOTE_USER",
  "CAPLETS_REMOTE_PASSWORD",
  "CAPLETS_REMOTE_TOKEN",
  "CAPLETS_REMOTE_WORKSPACE",
] as const;

beforeEach(() => {
  for (const key of REMOTE_ENV_KEYS) {
    delete process.env[key];
  }
});
