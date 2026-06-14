import { beforeEach } from "vitest";

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
