import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSecureStateDirectory,
  createOrOpenSecureStateRoot,
  readBoundedSecureFile,
  readBoundedSecureFileWithMetadata,
  replaceSecureFileAtomically,
  writeSecureFileExclusive,
} from "../src/control-plane/secure-state";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "caplets-secure-state-"));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("secure state filesystem", () => {
  it("creates and reads one owner-only no-follow regular file", async () => {
    const root = tempRoot();
    const path = join(root, "secret.bin");

    await writeSecureFileExclusive(path, Buffer.from("secret"));

    expect((await readBoundedSecureFile(path, { maxBytes: 32 })).toString()).toBe("secret");
    await expect(writeSecureFileExclusive(path, Buffer.from("replacement"))).rejects.toThrow(
      /already exists/i,
    );
  });

  it("rejects symlinks, insecure modes, non-regular files, and oversized input without leaking paths", async () => {
    const root = tempRoot();
    const target = join(root, "target");
    const link = join(root, "link");
    writeFileSync(target, "sentinel-secret", { mode: 0o600 });
    symlinkSync(target, link);

    for (const path of [link, root]) {
      await expect(readBoundedSecureFile(path, { maxBytes: 32 })).rejects.toSatisfy(
        (error: Error) =>
          !error.message.includes(path) && !error.message.includes("sentinel-secret"),
      );
    }
    const realDirectory = join(root, "real-directory");
    mkdirSync(realDirectory, { mode: 0o700 });
    writeFileSync(join(realDirectory, "nested-secret"), "sentinel-secret", { mode: 0o600 });
    const linkedDirectory = join(root, "linked-directory");
    symlinkSync(realDirectory, linkedDirectory);
    await expect(
      readBoundedSecureFile(join(linkedDirectory, "nested-secret"), { maxBytes: 32 }),
    ).rejects.toThrow(/symlink/i);

    chmodSync(target, 0o644);
    await expect(readBoundedSecureFile(target, { maxBytes: 32 })).rejects.toThrow(/permissions/i);
    chmodSync(target, 0o600);
    await expect(readBoundedSecureFile(target, { maxBytes: 4 })).rejects.toThrow(/size limit/i);
  });

  it("rejects insecure or symlinked state roots", async () => {
    const parent = tempRoot();
    const insecure = join(parent, "insecure");
    mkdirSync(insecure, { mode: 0o755 });
    await expect(assertSecureStateDirectory(insecure)).rejects.toThrow(/permissions/i);

    const secure = join(parent, "secure");
    mkdirSync(secure, { mode: 0o700 });
    const link = join(parent, "secure-link");
    symlinkSync(secure, link);
    await expect(assertSecureStateDirectory(link)).rejects.toThrow(/symlink|directory/i);
  });

  it("reports freshness only for the call that creates the final state-root directory", async () => {
    const parent = tempRoot();
    const stateRoot = join(parent, "state");
    await expect(createOrOpenSecureStateRoot(stateRoot)).resolves.toEqual({
      path: stateRoot,
      fresh: true,
    });
    await expect(createOrOpenSecureStateRoot(stateRoot)).resolves.toEqual({
      path: stateRoot,
      fresh: false,
    });
  });

  it("requires a Windows DACL verifier bound to the expected service SID", async () => {
    const root = tempRoot();
    const path = join(root, "state.json");
    await writeSecureFileExclusive(path, Buffer.from("bound"));
    let verifiedSid: string | undefined;
    const bytes = await readBoundedSecureFile(path, {
      platform: "win32",
      expectedServiceSid: "S-1-5-80-caplets",
      verifyWindowsDacl: (_path, expectedServiceSid) => {
        verifiedSid = expectedServiceSid;
        return true;
      },
    });
    expect(bytes.toString()).toBe("bound");
    expect(verifiedSid).toBe("S-1-5-80-caplets");
    await expect(
      readBoundedSecureFile(path, {
        platform: "win32",
        expectedServiceSid: "S-1-5-80-foreign",
        verifyWindowsDacl: () => false,
      }),
    ).rejects.toThrow(/acl/i);
  });

  it("serializes compare-and-swap replacements so only one conflicting pin wins", async () => {
    const root = tempRoot();
    const path = join(root, "authority.json");
    await writeSecureFileExclusive(path, Buffer.from("unbound"));
    const revision = (await readBoundedSecureFileWithMetadata(path)).metadata.revision;

    const results = await Promise.all([
      replaceSecureFileAtomically(path, revision, Buffer.from("bound-a")),
      replaceSecureFileAtomically(path, revision, Buffer.from("bound-b")),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect([Buffer.from("bound-a"), Buffer.from("bound-b")]).toContainEqual(
      await readBoundedSecureFile(path),
    );
  });
});
