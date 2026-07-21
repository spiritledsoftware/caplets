import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const prepareKeyPath = fileURLToPath(
  new URL("../../../deploy/postgres/prepare-encryption-key.mjs", import.meta.url),
);
const directories: string[] = [];

const RETAINED_KEY = Buffer.alloc(32, 51).toString("base64url");
const DIFFERENT_KEY = Buffer.alloc(32, 52).toString("base64url");

type KeyFixture = {
  root: string;
  legacy: string;
  prepared: string;
  external: string;
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("PostgreSQL encryption-key preparation", () => {
  it("imports the retained prefixed Vault key during an upgrade", () => {
    const fixture = keyFixture();
    writePrivate(fixture.legacy, `caplets-vault-key-v1.${RETAINED_KEY}\n`);

    prepare(fixture);

    expect(readFileSync(fixture.prepared, "utf8")).toBe(RETAINED_KEY);
    expect(readFileSync(fixture.legacy, "utf8")).toBe(`caplets-vault-key-v1.${RETAINED_KEY}\n`);
    if (process.platform !== "win32") {
      expect(statSync(fixture.prepared).mode & 0o777).toBe(0o400);
    }
  });

  it("generates a key only when retained, prepared, and external sources are absent", () => {
    const fixture = keyFixture();

    prepare(fixture);

    const generated = readFileSync(fixture.prepared, "utf8");
    expect(generated).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Buffer.from(generated, "base64url")).toHaveLength(32);
    prepare(fixture);
    expect(readFileSync(fixture.prepared, "utf8")).toBe(generated);
  });

  it("fails closed when retained and external key material conflict", () => {
    const fixture = keyFixture();
    writePrivate(fixture.legacy, `caplets-vault-key-v1.${RETAINED_KEY}\n`);
    writePrivate(fixture.external, DIFFERENT_KEY);

    expect(() => prepare(fixture, true)).toThrow();
    expect(existsSync(fixture.prepared)).toBe(false);
  });

  it("fails closed for malformed retained or prepared key material", () => {
    const retainedFixture = keyFixture();
    writePrivate(retainedFixture.legacy, "caplets-vault-key-v1.not-a-key\n");
    expect(() => prepare(retainedFixture)).toThrow();
    expect(existsSync(retainedFixture.prepared)).toBe(false);

    const preparedFixture = keyFixture();
    writePrivate(preparedFixture.prepared, "not-a-key");
    expect(() => prepare(preparedFixture)).toThrow();
  });
});

function keyFixture(): KeyFixture {
  const root = mkdtempSync(join(tmpdir(), "caplets-postgres-encryption-key-"));
  directories.push(root);
  const external = join(root, "external-key");
  writeFileSync(external, "", { mode: 0o600 });
  return {
    root,
    legacy: join(root, "vault-key"),
    prepared: join(root, "prepared", "key"),
    external,
  };
}

function prepare(fixture: KeyFixture, externalConfigured = false): void {
  execFileSync(process.execPath, [prepareKeyPath], {
    env: {
      CAPLETS_LEGACY_ENCRYPTION_KEY_FILE: fixture.legacy,
      CAPLETS_PREPARED_ENCRYPTION_KEY_FILE: fixture.prepared,
      CAPLETS_EXTERNAL_ENCRYPTION_KEY_FILE: fixture.external,
      CAPLETS_EXTERNAL_ENCRYPTION_KEY_CONFIGURED: externalConfigured ? "1" : "0",
      CAPLETS_KEY_OWNER_UID: String(process.getuid?.() ?? 0),
      CAPLETS_KEY_OWNER_GID: String(process.getgid?.() ?? 0),
    },
    stdio: "pipe",
  });
}

function writePrivate(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}
