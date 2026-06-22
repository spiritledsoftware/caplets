import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CapletsError } from "../src/errors";
import {
  FileVaultStore,
  VAULT_MAX_VALUE_BYTES,
  validateVaultKeyName,
  type VaultConfigOrigin,
} from "../src/vault";

const tempDirs: string[] = [];
const origin: VaultConfigOrigin = {
  kind: "global-file",
  path: "/home/ian/.config/caplets/github/CAPLET.md",
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Caplets Vault local store", () => {
  it("rejects invalid Vault key names before mutations", () => {
    const invalid = [
      "",
      "gh_token",
      "9TOKEN",
      "GH/TOKEN",
      "GH:TOKEN",
      "$vault:GH_TOKEN",
      "${vault:GH_TOKEN}",
      "GH TOKEN",
      "GH\tTOKEN",
      "A".repeat(129),
    ];

    for (const name of invalid) {
      expect(() => validateVaultKeyName(name)).toThrow(
        expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
      );
    }
    expect(validateVaultKeyName("GH_TOKEN_2")).toBe("GH_TOKEN_2");
  });

  it("mints owner-only key material and stores encrypted values without plaintext", () => {
    const dir = tempDir();
    const store = new FileVaultStore({ root: dir });

    const status = store.set("GH_TOKEN", "plain_fixture_secret");

    expect(status).toMatchObject({
      key: "GH_TOKEN",
      present: true,
      valueBytes: "plain_fixture_secret".length,
    });
    expect(JSON.stringify(status)).not.toContain("plain_fixture_secret");
    expect(readFileSync(store.paths.keyFile, "utf8")).toMatch(
      /^caplets-vault-key-v1\.[A-Za-z0-9_-]+\n$/,
    );
    expect(readFileSync(store.valuePath("GH_TOKEN"), "utf8")).not.toContain("plain_fixture_secret");
    expect(store.resolveValue("GH_TOKEN")).toBe("plain_fixture_secret");

    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(store.paths.keyFile).mode & 0o777).toBe(0o600);
      expect(statSync(store.valuePath("GH_TOKEN")).mode & 0o777).toBe(0o600);
    }
  });

  it("uses CAPLETS_ENCRYPTION_KEY when it decodes to exactly 32 bytes", () => {
    const dir = tempDir();
    const key = Buffer.alloc(32, 7).toString("base64url");
    const store = new FileVaultStore({
      root: dir,
      env: { CAPLETS_ENCRYPTION_KEY: key },
    });

    store.set("GH_TOKEN", "env_key_secret");

    expect(existsSync(store.paths.keyFile)).toBe(false);
    expect(store.resolveValue("GH_TOKEN")).toBe("env_key_secret");
  });

  it("fails closed for invalid key sources and tampered encrypted records", () => {
    const invalidKeyStore = new FileVaultStore({
      root: tempDir(),
      env: { CAPLETS_ENCRYPTION_KEY: "not-a-32-byte-key" },
    });

    expect(() => invalidKeyStore.set("GH_TOKEN", "secret")).toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
    );

    const dir = tempDir();
    const store = new FileVaultStore({ root: dir });
    store.set("GH_TOKEN", "tamper_secret");
    const envelope = JSON.parse(readFileSync(store.valuePath("GH_TOKEN"), "utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(
      store.valuePath("GH_TOKEN"),
      `${JSON.stringify({ ...envelope, ciphertext: "AAAA" }, null, 2)}\n`,
    );

    expect(() => store.resolveValue("GH_TOKEN")).toThrow(
      expect.objectContaining({ code: "CONFIG_INVALID" }) as CapletsError,
    );
  });

  it("reports malformed Vault metadata through CapletsError", () => {
    const dir = tempDir();
    const store = new FileVaultStore({ root: dir });
    store.set("GH_TOKEN", "secret");

    writeFileSync(store.valuePath("GH_TOKEN"), "{");
    expect(() => store.getStatus("GH_TOKEN")).toThrow(
      expect.objectContaining({
        code: "CONFIG_INVALID",
        message: "Vault value record for GH_TOKEN is not valid JSON.",
      }) as CapletsError,
    );

    const grantsStore = new FileVaultStore({ root: tempDir() });
    writeFileSync(grantsStore.paths.grantsFile, "{}\n");
    expect(() => grantsStore.listAccess()).toThrow(
      expect.objectContaining({
        code: "CONFIG_INVALID",
        message: "Vault access grants file must contain an array.",
      }) as CapletsError,
    );

    writeFileSync(grantsStore.paths.grantsFile, "{");
    expect(() => grantsStore.listAccess()).toThrow(
      expect.objectContaining({
        code: "CONFIG_INVALID",
        message: "Vault access grants file is not valid JSON.",
      }) as CapletsError,
    );
  });

  it("rejects overly broad minted key-file permissions on POSIX platforms", () => {
    if (process.platform === "win32") return;
    const dir = tempDir();
    const store = new FileVaultStore({ root: dir });
    store.set("GH_TOKEN", "secret");
    chmodSync(store.paths.keyFile, 0o644);

    expect(store.keySourceStatus()).toMatchObject({
      available: false,
      reason: "wrong-permissions",
    });
    expect(() => store.resolveValue("GH_TOKEN")).toThrow(
      expect.objectContaining({ code: "CONFIG_INVALID" }) as CapletsError,
    );
  });

  it("lists grant metadata without raw values and scopes resolution by origin", () => {
    const store = new FileVaultStore({ root: tempDir() });
    store.set("GH_TOKEN_PERSONAL", "personal_secret");
    store.grantAccess({
      storedKey: "GH_TOKEN_PERSONAL",
      referenceName: "GH_TOKEN",
      capletId: "github-personal",
      origin,
      now: new Date("2026-06-22T12:00:00.000Z"),
    });

    const grants = store.listAccess({ capletId: "github-personal" });

    expect(grants).toEqual([
      {
        storedKey: "GH_TOKEN_PERSONAL",
        referenceName: "GH_TOKEN",
        capletId: "github-personal",
        origin,
        createdAt: "2026-06-22T12:00:00.000Z",
        updatedAt: "2026-06-22T12:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(grants)).not.toContain("personal_secret");
    expect(
      store.resolveGrantedValue({
        referenceName: "GH_TOKEN",
        capletId: "github-personal",
        origin,
      }),
    ).toEqual({ storedKey: "GH_TOKEN_PERSONAL", value: "personal_secret" });
    expect(
      store.resolveGrantedValue({
        referenceName: "GH_TOKEN",
        capletId: "github-personal",
        origin: { ...origin, path: "/different/CAPLET.md" },
      }),
    ).toEqual({
      reason: "ungranted",
      referenceName: "GH_TOKEN",
      capletId: "github-personal",
      origin: { ...origin, path: "/different/CAPLET.md" },
    });
  });

  it("replaces the stored key when granting the same Caplet reference again", () => {
    const store = new FileVaultStore({ root: tempDir() });
    store.set("GH_TOKEN_PERSONAL", "personal_secret");
    store.set("GH_TOKEN_WORK", "work_secret");
    store.grantAccess({
      storedKey: "GH_TOKEN_PERSONAL",
      referenceName: "GH_TOKEN",
      capletId: "github",
      origin,
      now: new Date("2026-06-22T12:00:00.000Z"),
    });

    store.grantAccess({
      storedKey: "GH_TOKEN_WORK",
      referenceName: "GH_TOKEN",
      capletId: "github",
      origin,
      now: new Date("2026-06-22T13:00:00.000Z"),
    });

    expect(store.listAccess({ referenceName: "GH_TOKEN", capletId: "github", origin })).toEqual([
      expect.objectContaining({
        storedKey: "GH_TOKEN_WORK",
        referenceName: "GH_TOKEN",
        capletId: "github",
        createdAt: "2026-06-22T12:00:00.000Z",
        updatedAt: "2026-06-22T13:00:00.000Z",
      }),
    ]);
    expect(
      store.resolveGrantedValue({ referenceName: "GH_TOKEN", capletId: "github", origin }),
    ).toEqual({
      storedKey: "GH_TOKEN_WORK",
      value: "work_secret",
    });
  });

  it("overwrites only with force, preserves grants, and deletes without reveal", () => {
    const store = new FileVaultStore({ root: tempDir() });
    store.set("GH_TOKEN", "first_secret");
    store.grantAccess({
      storedKey: "GH_TOKEN",
      referenceName: "GH_TOKEN",
      capletId: "github",
      origin,
    });

    expect(() => store.set("GH_TOKEN", "second_secret")).toThrow(
      expect.objectContaining({ code: "CONFIG_EXISTS" }) as CapletsError,
    );
    const before = readFileSync(store.valuePath("GH_TOKEN"), "utf8");
    store.set("GH_TOKEN", "second_secret", { force: true });
    const after = readFileSync(store.valuePath("GH_TOKEN"), "utf8");

    expect(after).not.toBe(before);
    expect(store.resolveValue("GH_TOKEN")).toBe("second_secret");
    expect(store.listAccess({ storedKey: "GH_TOKEN" })).toHaveLength(1);

    const deleted = store.delete("GH_TOKEN");

    expect(deleted).toEqual({ key: "GH_TOKEN", deleted: true, grantsRetained: 1 });
    expect(JSON.stringify(deleted)).not.toContain("second_secret");
    expect(
      store.resolveGrantedValue({ referenceName: "GH_TOKEN", capletId: "github", origin }),
    ).toMatchObject({
      reason: "missing",
      storedKey: "GH_TOKEN",
    });
  });

  it("rejects values over 64 KiB before writing encrypted records", () => {
    const store = new FileVaultStore({ root: tempDir() });
    const tooLarge = "x".repeat(VAULT_MAX_VALUE_BYTES + 1);

    expect(() => store.set("GH_TOKEN", tooLarge)).toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }) as CapletsError,
    );
    expect(existsSync(store.valuePath("GH_TOKEN"))).toBe(false);
  });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "caplets-vault-"));
  tempDirs.push(dir);
  return dir;
}
