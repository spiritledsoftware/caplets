import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDarwinSecureFilesystemAdapter } from "../src/control-plane/native/darwin-secure-filesystem";
import {
  assertSecureStateDirectory,
  createOrOpenSecureStateRoot,
  readBoundedSecureFile,
  readBoundedSecureFileWithMetadata,
  replaceSecureFileAtomically,
  writeSecureFileExclusive,
  withSecureMutableRegularFile,
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

  it("allows expected content changes while preserving a mutable file identity", async () => {
    const root = tempRoot();
    const path = join(root, "live.sqlite");
    await writeSecureFileExclusive(path, Buffer.from("before"));

    const result = await withSecureMutableRegularFile(path, {}, async () => {
      appendFileSync(path, "-after");
      return "verified";
    });

    expect(result.value).toBe("verified");
    expect((await readBoundedSecureFile(path, { maxBytes: 32 })).toString()).toBe("before-after");
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

  it("creates, reopens, and atomically replaces state through the Darwin fd-relative adapter", async () => {
    const parent = tempRoot();
    const stateRoot = join(parent, "darwin-state");
    const filesystem = {
      platform: "darwin" as const,
      expectedUid: process.getuid!(),
      nativeAdapter: createDarwinSecureFilesystemAdapter(),
    };
    await expect(createOrOpenSecureStateRoot(stateRoot, filesystem)).resolves.toMatchObject({
      path: stateRoot,
      fresh: true,
    });
    const path = join(stateRoot, "authority.json");
    const original = await writeSecureFileExclusive(path, Buffer.from("unbound"), filesystem);
    await expect(
      replaceSecureFileAtomically(path, original.revision, Buffer.from("bound"), filesystem),
    ).resolves.toBe(true);
    await expect(createOrOpenSecureStateRoot(stateRoot, filesystem)).resolves.toMatchObject({
      path: stateRoot,
      fresh: false,
    });
    await expect(readBoundedSecureFile(path, filesystem)).resolves.toEqual(Buffer.from("bound"));
  });

  it("routes Windows create, reopen, no-follow opens, and DACL checks through its native adapter", async () => {
    const parent = tempRoot();
    const stateRoot = join(parent, "windows-state");
    const calls: string[] = [];
    const expectedServiceSid = "S-1-5-21-1000";
    const nativeAdapter = {
      platform: "win32" as const,
      async withPinnedDirectory<T>(
        path: string,
        action: (pinnedPath: string) => Promise<T>,
      ): Promise<T> {
        calls.push(`pin:${path}`);
        return action(path);
      },
      openPinnedPath(path: string, flags: number, mode?: number) {
        calls.push(`open:${path}`);
        return mode === undefined ? open(path, flags) : open(path, flags, mode);
      },
      async createDirectory(path: string) {
        calls.push(`mkdir:${path}`);
        try {
          mkdirSync(path, { mode: 0o700 });
          return "created" as const;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          return "exists" as const;
        }
      },
      async syncDirectory(path: string) {
        calls.push(`sync:${path}`);
      },
    };
    const filesystem = {
      platform: "win32" as const,
      expectedServiceSid,
      nativeAdapter,
      verifyWindowsDacl(path: string, sid?: string) {
        calls.push(`dacl:${path}:${sid}`);
        return sid === expectedServiceSid;
      },
    };
    await expect(createOrOpenSecureStateRoot(stateRoot, filesystem)).resolves.toMatchObject({
      path: stateRoot,
      fresh: true,
    });
    const path = join(stateRoot, "authority.json");
    await writeSecureFileExclusive(path, Buffer.from("windows-bound"), filesystem);
    await expect(createOrOpenSecureStateRoot(stateRoot, filesystem)).resolves.toMatchObject({
      path: stateRoot,
      fresh: false,
    });
    await expect(readBoundedSecureFile(path, filesystem)).resolves.toEqual(
      Buffer.from("windows-bound"),
    );
    expect(calls.some((call) => call.startsWith("mkdir:"))).toBe(true);
    expect(calls.some((call) => call.startsWith("pin:"))).toBe(true);
    expect(calls.some((call) => call.startsWith("open:"))).toBe(true);
    expect(calls.some((call) => call.includes(`dacl:${stateRoot}:${expectedServiceSid}`))).toBe(
      true,
    );
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
