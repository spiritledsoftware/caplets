import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { createBundleMultipartStream } from "../src/admin-api/bundle-export";
import type { ReopenableBundleFileSource } from "../src/storage/bundle-source";

function source(
  path: string,
  content: string,
  options: { executable?: boolean; onOpen?: () => void; onCancel?: () => void } = {},
): ReopenableBundleFileSource {
  const bytes = new TextEncoder().encode(content);
  return {
    path,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    executable: options.executable ?? false,
    open() {
      options.onOpen?.();
      let sent = false;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) return controller.close();
          sent = true;
          controller.enqueue(bytes);
        },
        cancel() {
          options.onCancel?.();
        },
      });
    },
  };
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const bytes = await new Response(stream).arrayBuffer();
  return new TextDecoder().decode(bytes);
}

describe("Admin Caplet Bundle multipart export", () => {
  it("streams one manifest followed by files in declared order", async () => {
    const opened: string[] = [];
    const first = source("CAPLET.md", "# Caplet", { onOpen: () => opened.push("CAPLET.md") });
    const second = source("scripts/run.ts", "run()", {
      executable: true,
      onOpen: () => opened.push("scripts/run.ts"),
    });

    const multipart = createBundleMultipartStream([first, second], {
      boundary: "caplets-test-boundary",
    });
    expect(multipart.contentType).toBe("multipart/mixed; boundary=caplets-test-boundary");
    expect(opened).toEqual([]);

    const text = await readText(multipart.body);
    expect(opened).toEqual(["CAPLET.md", "scripts/run.ts"]);
    const manifestPosition = text.indexOf('{"version":1,"files"');
    const firstPosition = text.indexOf("# Caplet");
    const secondPosition = text.indexOf("run()");
    expect(manifestPosition).toBeGreaterThanOrEqual(0);
    expect(firstPosition).toBeGreaterThan(manifestPosition);
    expect(secondPosition).toBeGreaterThan(firstPosition);
    expect(text).toContain(
      `{"path":"scripts/run.ts","size":5,"sha256":"${second.sha256}","executable":true}`,
    );
    expect(text.endsWith("--caplets-test-boundary--\r\n")).toBe(true);
  });

  it("never opens a later source before the preceding source is exhausted", async () => {
    const events: string[] = [];
    const gate = Promise.withResolvers<void>();
    const firstBytes = new TextEncoder().encode("first");
    const first: ReopenableBundleFileSource = {
      path: "CAPLET.md",
      size: firstBytes.byteLength,
      sha256: createHash("sha256").update(firstBytes).digest("hex"),
      executable: false,
      open() {
        events.push("first-open");
        let sent = false;
        return new ReadableStream({
          async pull(controller) {
            if (sent) return controller.close();
            sent = true;
            await gate.promise;
            controller.enqueue(firstBytes);
          },
        });
      },
    };
    const second = source("second.txt", "second", { onOpen: () => events.push("second-open") });
    const reader = createBundleMultipartStream([first, second], {
      boundary: "ordered",
    }).body.getReader();

    await reader.read();
    await reader.read();
    expect(events).toEqual(["first-open"]);
    gate.resolve();
    while (!(await reader.read()).done) {}
    expect(events).toEqual(["first-open", "second-open"]);
  });

  it("cancels the active storage read when the response consumer disconnects", async () => {
    const cancelled = vi.fn();
    const bytes = new TextEncoder().encode("payload");
    const pending = Promise.withResolvers<void>();
    const staged: ReopenableBundleFileSource = {
      path: "CAPLET.md",
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      executable: false,
      open() {
        return new ReadableStream({
          async pull(controller) {
            await pending.promise;
            controller.enqueue(bytes);
          },
          cancel: cancelled,
        });
      },
    };
    const reader = createBundleMultipartStream([staged], { boundary: "cancel" }).body.getReader();

    await reader.read();
    await reader.read();
    await Promise.resolve();
    await reader.cancel("disconnected");
    expect(cancelled).toHaveBeenCalled();
    pending.resolve();
  });

  it("fails the stream when a source does not match declared integrity metadata", async () => {
    const invalid = source("CAPLET.md", "payload");
    invalid.sha256 = "0".repeat(64);
    const stream = createBundleMultipartStream([invalid], { boundary: "integrity" }).body;
    await expect(new Response(stream).arrayBuffer()).rejects.toMatchObject({
      code: "REQUEST_INVALID",
    });
  });
});
