import { describe, expect, it } from "vitest";
import { generateCodeModeDeclarations } from "../src/code-mode/declarations";
import { diagnoseCodeModeTypeScript } from "../src/code-mode/diagnostics";

const declaration = generateCodeModeDeclarations({
  caplets: [{ id: "github", name: "GitHub", description: "GitHub repo operations." }],
});

describe("diagnoseCodeModeTypeScript", () => {
  it("blocks unknown CapletHandle methods before execution", () => {
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: 'await caplets.github.call("listIssues", {});',
    });

    expect(diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
    expect(diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain(
      "CapletHandle does not expose call()",
    );
    expect(diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain("callTool");
  });

  it("blocks direct fetch even though fetch is declared as unavailable", () => {
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: 'await fetch("https://example.com");',
    });

    expect(diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain("FETCH_UNAVAILABLE");
    expect(diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain(
      "Direct fetch is not available",
    );
  });

  it("blocks direct globalThis.fetch calls", () => {
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: 'await globalThis.fetch("https://example.com");',
    });

    expect(diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain("FETCH_UNAVAILABLE");
    expect(diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain(
      "Direct fetch is not available",
    );
  });

  it("does not block fetch text or non-global fetch member calls", () => {
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: `
        const guidance = "Use the browser Caplet instead of await fetch('https://example.com')";
        const client = { fetch: (value: string) => ({ value }) };
        const result = client.fetch(guidance);
        return result;
      `,
    });

    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain("FETCH_UNAVAILABLE");
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  });

  it("allows standard JavaScript, platform globals, JSON, and Caplet callTool", () => {
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: `
        const url = new URL("https://example.com/issues?state=open");
        const params = new URLSearchParams([["q", "caplets"]]);
        params.append("state", "open");
        const utf8 = new TextEncoder().encode(url.searchParams.get("state") ?? "");
        const decoded = new TextDecoder().decode(utf8);
        const bytes = Buffer.from(btoa(decoded), "base64");
        const clone = structuredClone({ decoded, params: params.toString() });
        const random = crypto.getRandomValues(new Uint8Array(4));
        const uuid = crypto.randomUUID();
        const headers = new Headers({ accept: "application/json" });
        headers.append("x-code-mode", "true");
        const blob = new Blob([bytes.toString()], { type: "text/plain" });
        const file = new File([blob], "state.txt", { type: blob.type });
        const form = new FormData();
        form.append("file", file, file.name);
        const request = new Request(url, { method: "POST", headers, body: form });
        const response = Response.json({ ok: true, clone, uuid, random: random.length });
        const reader = new ReadableStream<string>({
          start(controller) {
            controller.enqueue("ready");
            controller.close();
          },
        }).getReader();
        const writer = new WritableStream<string>({ write() {} }).getWriter();
        const transform = new TransformStream<string, string>({
          transform(chunk, controller) {
            controller.enqueue(chunk);
          },
        });
        const controller = new AbortController();
        controller.abort("done");
        controller.signal.throwIfAborted();
        const timeout = setTimeout(() => undefined, 0);
        clearTimeout(timeout);
        const interval = setInterval(() => undefined, 1);
        clearInterval(interval);
        queueMicrotask(() => undefined);
        console.log(JSON.stringify({ state: url.searchParams.get("state") }));
        await reader.read();
        await writer.write(request.method);
        await writer.close();
        transform.readable.getReader();
        await response.text();
        const result = await caplets.github.callTool("listIssues", { state: "open" });
        return result;
      `,
    });

    expect(diagnostics).toEqual([]);
  });

  it("blocks static and dynamic imports", () => {
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: `
        import fs from "node:fs";
        await import("node:process");
      `,
    });

    expect(
      diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
    ).toBeGreaterThanOrEqual(1);
    expect(diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain(
      "Imports are not available in Code Mode",
    );
  });

  it("keeps Node process and require unavailable", () => {
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: `
        process.cwd();
        require("fs");
      `,
    });

    const codes = diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain("2591");
    expect(diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain(
      "Cannot find name 'process'",
    );
    expect(diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain(
      "Cannot find name 'require'",
    );
  });

  it("honors per-line @ts-ignore for TypeScript diagnostics", () => {
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: `
        // @ts-ignore
        caplets.github.notARealMethod();
        return true;
      `,
    });

    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain("2339");
  });

  it("honors per-line @ts-expect-error and reports unused directives", () => {
    const suppressed = diagnoseCodeModeTypeScript({
      declaration,
      code: `
        // @ts-expect-error
        caplets.github.notARealMethod();
        return true;
      `,
    });
    const unused = diagnoseCodeModeTypeScript({
      declaration,
      code: `
        // @ts-expect-error
        return true;
      `,
    });

    expect(suppressed.map((diagnostic) => diagnostic.code)).not.toContain("2339");
    expect(unused.map((diagnostic) => diagnostic.code)).toContain("2578");
  });

  it("honors whole-script @ts-nocheck line and block comments", () => {
    const lineComment = diagnoseCodeModeTypeScript({
      declaration,
      code: `
        // @ts-nocheck
        caplets.github.notARealMethod();
        return true;
      `,
    });
    const blockComment = diagnoseCodeModeTypeScript({
      declaration,
      code: `
        /* @ts-nocheck */
        caplets.github.notARealMethod();
        return true;
      `,
    });

    expect(lineComment.map((diagnostic) => diagnostic.code)).toContain("ts_nocheck_applied");
    expect(lineComment.map((diagnostic) => diagnostic.code)).not.toContain("2339");
    expect(blockComment.map((diagnostic) => diagnostic.code)).toContain("ts_nocheck_applied");
    expect(blockComment.map((diagnostic) => diagnostic.code)).not.toContain("2339");
  });

  it("does not allow TypeScript comments to suppress Code Mode safety checks", () => {
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: `
        // @ts-ignore
        await fetch("https://example.com");
      `,
    });

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain("FETCH_UNAVAILABLE");
  });
});
