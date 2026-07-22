import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBundleMultipartStream } from "../src/admin-api/bundle-export";
import {
  DEFAULT_ADMIN_BUNDLE_DOCUMENT_BYTES,
  DEFAULT_ADMIN_BUNDLE_MANIFEST_BYTES,
  type AdminBundleManifest,
} from "../src/admin-api/bundle-contract";
import { materializeRemoteBundleDownload } from "../src/remote-cli/bundle";
import type { ReopenableBundleFileSource } from "../src/storage/bundle-source";
import {
  MAX_BUNDLE_FILES,
  MAX_BUNDLE_FILE_BYTES,
  MAX_BUNDLE_TOTAL_BYTES,
} from "../src/storage/caplet-records";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function source(path: string, content: string, executable = false): ReopenableBundleFileSource {
  const bytes = new TextEncoder().encode(content);
  return {
    path,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    executable,
    open: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.subarray(0, 1));
          controller.enqueue(bytes.subarray(1));
          controller.close();
        },
      }),
  };
}

function manifestFile(path: string, size: number): AdminBundleManifest["files"][number] {
  return {
    path,
    size,
    sha256: createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
    executable: false,
  };
}

function manifestOnlyDownload(manifest: AdminBundleManifest): RemoteBundleFixture {
  const boundary = "caplets-malicious-manifest";
  return downloadFixture(
    boundary,
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: inline; name="manifest"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(manifest)}\r\n--${boundary}--\r\n`,
    ),
  );
}

function rawDownload(manifest: AdminBundleManifest, content: Buffer): RemoteBundleFixture {
  const boundary = "caplets-declared-length";
  return downloadFixture(
    boundary,
    Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: inline; name="manifest"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(manifest)}\r\n--${boundary}\r\nContent-Disposition: attachment; name="file"; filename="file-1"\r\nContent-Type: application/octet-stream\r\nContent-Length: ${manifest.files[0]!.size}\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  );
}

type RemoteBundleFixture = {
  body: ReadableStream<Uint8Array>;
  contentType: string;
};

function downloadFixture(boundary: string, body: Buffer): RemoteBundleFixture {
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    }),
    contentType: `multipart/mixed; boundary=${boundary}`,
  };
}

function chunkedDownload(boundary: string, chunks: readonly Uint8Array[]): RemoteBundleFixture {
  let index = 0;
  return {
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    }),
    contentType: `multipart/mixed; boundary=${boundary}`,
  };
}

function exactLimitManifestDownload(): RemoteBundleFixture {
  const boundary = "caplets-fragmented-manifest";
  const manifest: AdminBundleManifest = {
    version: 1,
    files: [manifestFile("CAPLET.md", 0)],
  };
  const json = Buffer.from(JSON.stringify(manifest));
  const manifestBytes = Buffer.concat([
    json,
    Buffer.alloc(DEFAULT_ADMIN_BUNDLE_MANIFEST_BYTES - json.byteLength, 0x20),
  ]);
  const preamble = Buffer.from(
    `--${boundary}\r\nContent-Disposition: inline; name="manifest"\r\nContent-Type: application/json\r\n\r\n`,
  );
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const fileAndClosingBoundary = Buffer.from(
    `\r\nContent-Disposition: attachment; name="file"; filename="file-1"\r\n` +
      `Content-Type: application/octet-stream\r\nContent-Length: 0\r\n\r\n` +
      `\r\n--${boundary}--\r\n`,
  );
  const fragments = Array.from({ length: 256 }, (_, index) =>
    manifestBytes.subarray(index, index + 1),
  );
  return chunkedDownload(boundary, [
    preamble,
    ...fragments,
    manifestBytes.subarray(fragments.length),
    ...Array.from(delimiter, (byte) => Uint8Array.of(byte)),
    fileAndClosingBoundary,
  ]);
}

describe("remote CLI bundle download", () => {
  it("streams multipart files directly through the explicit local file-writing boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-remote-bundle-"));
    dirs.push(root);
    const destination = join(root, "exported");
    const multipart = createBundleMultipartStream(
      [source("CAPLET.md", "# Remote\n"), source("bin/run.sh", "#!/bin/sh\n", true)],
      { boundary: "caplets-client-test" },
    );
    const reader = multipart.body.getReader();
    const reads = vi.fn(() => reader.read());
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = await reads();
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      },
      cancel: (reason) => reader.cancel(reason),
    });

    await materializeRemoteBundleDownload({
      body,
      contentType: multipart.contentType,
      destination,
    });

    expect(readFileSync(join(destination, "CAPLET.md"), "utf8")).toBe("# Remote\n");
    expect(readFileSync(join(destination, "bin/run.sh"), "utf8")).toBe("#!/bin/sh\n");
    expect(reads.mock.calls.length).toBeGreaterThan(4);
  });

  it.each([
    {
      name: "one auxiliary file over the file-count allowance",
      files: [
        manifestFile("CAPLET.md", 0),
        ...Array.from({ length: MAX_BUNDLE_FILES + 1 }, (_, index) =>
          manifestFile(`assets/${index}`, 0),
        ),
      ],
    },
    {
      name: "one auxiliary byte over the per-file allowance",
      files: [manifestFile("CAPLET.md", 0), manifestFile("asset", MAX_BUNDLE_FILE_BYTES + 1)],
    },
    {
      name: "one document byte over its separate allowance",
      files: [manifestFile("CAPLET.md", DEFAULT_ADMIN_BUNDLE_DOCUMENT_BYTES + 1)],
    },
    {
      name: "one auxiliary byte over the aggregate allowance",
      files: [
        manifestFile("CAPLET.md", 0),
        ...Array.from({ length: 4 }, (_, index) =>
          manifestFile(`assets/${index}`, MAX_BUNDLE_FILE_BYTES),
        ),
        manifestFile("assets/overflow", MAX_BUNDLE_TOTAL_BYTES + 1 - 4 * MAX_BUNDLE_FILE_BYTES),
      ],
    },
    {
      name: "duplicate normalized output paths",
      files: [manifestFile("CAPLET.md", 0), manifestFile("CAPLET.md", 0)],
    },
    {
      name: "an output path outside the destination",
      files: [manifestFile("CAPLET.md", 0), manifestFile("../escape", 0)],
    },
  ])("rejects $name before creating an output tree", async ({ files }) => {
    const root = mkdtempSync(join(tmpdir(), "caplets-remote-bundle-"));
    dirs.push(root);
    const parent = join(root, "not-created");
    const destination = join(parent, "exported");

    await expect(
      materializeRemoteBundleDownload({
        ...manifestOnlyDownload({ version: 1, files }),
        destination,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(existsSync(parent)).toBe(false);
  });

  it("rejects bytes beyond a declared file length instead of writing the destination", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-remote-bundle-"));
    dirs.push(root);
    const destination = join(root, "exported");
    const content = Buffer.from("xy");
    const manifest: AdminBundleManifest = {
      version: 1,
      files: [
        {
          ...manifestFile("CAPLET.md", 1),
          sha256: createHash("sha256").update(content.subarray(0, 1)).digest("hex"),
        },
      ],
    };

    await expect(
      materializeRemoteBundleDownload({
        ...rawDownload(manifest, content),
        destination,
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects an over-limit manifest before a same-chunk delimiter", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-remote-bundle-"));
    dirs.push(root);
    const destination = join(root, "exported");
    const boundary = "caplets-same-chunk-limit";
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: inline; name="manifest"\r\n` +
          "Content-Type: application/json\r\n\r\n",
      ),
      Buffer.alloc(DEFAULT_ADMIN_BUNDLE_MANIFEST_BYTES + 1, 0x20),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    await expect(
      materializeRemoteBundleDownload({
        ...downloadFixture(boundary, body),
        destination,
      }),
    ).rejects.toMatchObject({
      code: "DOWNSTREAM_PROTOCOL_ERROR",
      message: "Remote Caplet Bundle metadata exceeds its byte limit.",
    });
    expect(existsSync(destination)).toBe(false);
  });

  it("accepts an exact-limit manifest fragmented across many chunks and delimiter bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "caplets-remote-bundle-"));
    dirs.push(root);
    const destination = join(root, "exported");

    await materializeRemoteBundleDownload({
      ...exactLimitManifestDownload(),
      destination,
    });

    expect(readFileSync(join(destination, "CAPLET.md"))).toHaveLength(0);
  });
});
