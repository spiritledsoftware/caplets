import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  artifactUri,
  readMediaInput,
  resolveMediaArtifact,
  writeMediaArtifact,
} from "../src/media";

describe("media artifacts", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(prefix: string) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  it("writes artifact files with stable metadata", async () => {
    const root = tempDir("caplets-artifacts-");
    const artifact = await writeMediaArtifact({
      rootDir: root,
      capletId: "google-drive",
      suggestedFilename: "report.pdf",
      mimeType: "application/pdf",
      bytes: Buffer.from("pdf-bytes"),
    });

    expect(artifact).toMatchObject({
      mimeType: "application/pdf",
      byteLength: 9,
      filename: "report.pdf",
    });
    expect(artifact.path).toContain(join(root, "google-drive"));
    expect(artifact.sha256).toHaveLength(64);
    expect(readFileSync(artifact.path, "utf8")).toBe("pdf-bytes");
  });

  it("rejects output paths outside an allowed root", async () => {
    const root = tempDir("caplets-artifacts-");
    await expect(
      writeMediaArtifact({
        rootDir: root,
        capletId: "drive",
        outputPath: join(root, "..", "escape.bin"),
        bytes: Buffer.from("x"),
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("resolves explicit output paths and rejects unsafe artifact path segments", async () => {
    const root = tempDir("caplets-artifacts-");
    const outputPath = join(root, "drive", "call-1", "report.pdf");
    const artifact = await writeMediaArtifact({
      rootDir: root,
      capletId: "drive",
      outputPath,
      mimeType: "application/pdf",
      bytes: Buffer.from("pdf"),
    });

    expect(resolveMediaArtifact(artifact.uri, { artifactRoot: root })).toMatchObject({
      path: outputPath,
      filename: "report.pdf",
      mimeType: "application/pdf",
      byteLength: 3,
    });

    await expect(
      writeMediaArtifact({
        rootDir: root,
        capletId: "drive",
        outputPath: join(root, "drive", "bad call", "report.pdf"),
        bytes: Buffer.from("x"),
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("clears stale artifact metadata when overwriting without a MIME type", async () => {
    const root = tempDir("caplets-artifacts-");
    const outputPath = join(root, "drive", "call-1", "report.pdf");
    const first = await writeMediaArtifact({
      rootDir: root,
      capletId: "drive",
      outputPath,
      mimeType: "application/pdf",
      bytes: Buffer.from("pdf"),
    });
    await writeMediaArtifact({
      rootDir: root,
      capletId: "drive",
      outputPath,
      bytes: Buffer.from("plain"),
    });

    expect(resolveMediaArtifact(first.uri, { artifactRoot: root })).toMatchObject({
      filename: "report.pdf",
      byteLength: 5,
    });
    expect(resolveMediaArtifact(first.uri, { artifactRoot: root }).mimeType).toBeUndefined();
  });

  it("rejects oversized artifact and data URL inputs before reading decoded bytes", async () => {
    const root = tempDir("caplets-artifacts-");
    const artifact = await writeMediaArtifact({
      rootDir: root,
      capletId: "drive",
      suggestedFilename: "large.txt",
      bytes: Buffer.from("large"),
    });

    await expect(
      readMediaInput({ artifact: artifact.uri }, { artifactRoot: root, maxBytes: 4 }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    await expect(
      readMediaInput(
        { dataUrl: "data:text/plain;base64,bGFyZ2U=", filename: "large.txt" },
        { artifactRoot: root, maxBytes: 4 },
      ),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("applies the default size limit to artifact inputs", async () => {
    const root = tempDir("caplets-artifacts-");
    const artifactPath = join(root, "drive", "call-1", "large.txt");
    mkdirSync(join(root, "drive", "call-1"), { recursive: true });
    writeFileSync(artifactPath, "");
    truncateSync(artifactPath, 100 * 1024 * 1024 + 1);
    const artifact = artifactUri("drive", "call-1", "large.txt");

    await expect(readMediaInput({ artifact }, { artifactRoot: root })).rejects.toMatchObject({
      code: "REQUEST_INVALID",
    });
  });

  it("rejects invalid base64 data URL padding", async () => {
    const root = tempDir("caplets-artifacts-");
    await expect(
      readMediaInput({ dataUrl: "data:text/plain;base64,====" }, { artifactRoot: root }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    await expect(
      readMediaInput({ dataUrl: "data:text/plain;base64,a===" }, { artifactRoot: root }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("rejects artifact paths that escape the root through symlinks", async () => {
    const root = tempDir("caplets-artifacts-");
    const outside = tempDir("caplets-artifacts-outside-");
    mkdirSync(join(root, "drive"), { recursive: true });
    symlinkSync(outside, join(root, "drive", "linked"));

    await expect(
      writeMediaArtifact({
        rootDir: root,
        capletId: "drive",
        outputPath: join(root, "drive", "linked", "escape.bin"),
        bytes: Buffer.from("x"),
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("rejects symlinked artifact roots", async () => {
    const realRoot = tempDir("caplets-artifacts-real-");
    const parent = tempDir("caplets-artifacts-parent-");
    const linkedRoot = join(parent, "linked-root");
    symlinkSync(realRoot, linkedRoot);

    await expect(
      writeMediaArtifact({
        rootDir: linkedRoot,
        capletId: "drive",
        suggestedFilename: "file.bin",
        bytes: Buffer.from("x"),
      }),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });

  it("reads media input from path, artifact reference, and data URL", async () => {
    const root = tempDir("caplets-artifacts-");
    const file = join(root, "image.png");
    writeFileSync(file, Buffer.from("png"));
    const artifact = await writeMediaArtifact({
      rootDir: root,
      capletId: "drive",
      suggestedFilename: "existing.png",
      mimeType: "image/png",
      bytes: Buffer.from("artifact"),
    });
    expect(resolveMediaArtifact(artifact.uri, { artifactRoot: root })).toMatchObject({
      filename: "existing.png",
      byteLength: 8,
    });
    await expect(readMediaInput({ path: file }, { artifactRoot: root })).resolves.toMatchObject({
      bytes: Buffer.from("png"),
      filename: "image.png",
    });
    await expect(
      readMediaInput({ artifact: artifact.uri }, { artifactRoot: root }),
    ).resolves.toMatchObject({
      bytes: Buffer.from("artifact"),
      filename: "existing.png",
      mimeType: "image/png",
    });
    await expect(
      readMediaInput(
        { dataUrl: "data:text/plain;base64,aGVsbG8=", filename: "hello.txt" },
        { artifactRoot: root },
      ),
    ).resolves.toMatchObject({
      bytes: Buffer.from("hello"),
      filename: "hello.txt",
      mimeType: "text/plain",
    });
  });

  it("rejects multiple media input sources and non-base64 data URLs", async () => {
    const root = tempDir("caplets-artifacts-");
    await expect(
      readMediaInput(
        { path: "/tmp/a", dataUrl: "data:text/plain;base64,eA==" },
        {
          artifactRoot: root,
        },
      ),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
    await expect(
      readMediaInput(
        { dataUrl: "data:text/plain,hello" },
        {
          artifactRoot: root,
        },
      ),
    ).rejects.toMatchObject({ code: "REQUEST_INVALID" });
  });
});
