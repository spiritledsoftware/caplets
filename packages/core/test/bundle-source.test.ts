import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  bufferBundleFileSource,
  readVerifiedBundleFile,
  stagedBundleFileSource,
} from "../src/storage/bundle-source";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("reopenable Caplet Bundle file sources", () => {
  it("opens a Buffer-backed file repeatedly with stable verified metadata", async () => {
    const source = bufferBundleFileSource({
      path: "assets/tool.js",
      content: Buffer.from("console.log('ok')"),
      executable: true,
    });

    expect(source).toMatchObject({
      path: "assets/tool.js",
      size: 17,
      executable: true,
      sha256: createHash("sha256").update("console.log('ok')").digest("hex"),
    });
    await expect(readText(source.open())).resolves.toBe("console.log('ok')");
    await expect(readText(source.open())).resolves.toBe("console.log('ok')");
    await expect(readVerifiedBundleFile(source, { maxBytes: 17 })).resolves.toEqual(
      Buffer.from("console.log('ok')"),
    );
  });

  it("opens staged files repeatedly without trusting staged metadata", async () => {
    const directory = mkdtempSync(join(tmpdir(), "caplets-bundle-source-"));
    directories.push(directory);
    const stagedPath = join(directory, "part-0");
    const content = Buffer.from("staged payload");
    writeFileSync(stagedPath, content, { mode: 0o600 });
    const source = stagedBundleFileSource({
      path: "payload.bin",
      stagedPath,
      size: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      executable: false,
    });

    await expect(readVerifiedBundleFile(source, { maxBytes: content.byteLength })).resolves.toEqual(
      content,
    );
    await expect(readVerifiedBundleFile(source, { maxBytes: content.byteLength })).resolves.toEqual(
      content,
    );
  });

  it("rejects actual sizes and hashes that differ from declared metadata", async () => {
    const valid = bufferBundleFileSource({
      path: "payload.bin",
      content: Buffer.from("payload"),
      executable: false,
    });

    await expect(
      readVerifiedBundleFile({ ...valid, size: valid.size + 1 }, { maxBytes: 100 }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    await expect(
      readVerifiedBundleFile({ ...valid, sha256: "0".repeat(64) }, { maxBytes: 100 }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("stops reading when the configured bound is exceeded", async () => {
    const source = bufferBundleFileSource({
      path: "payload.bin",
      content: Buffer.alloc(16, 1),
      executable: false,
    });

    await expect(readVerifiedBundleFile(source, { maxBytes: 15 })).rejects.toMatchObject({
      code: "REQUEST_INVALID",
    });
  });
});

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}
