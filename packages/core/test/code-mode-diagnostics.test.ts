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

  it("blocks direct fetch calls before execution", () => {
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

  it.each([
    ["globalThis bracket fetch", 'await globalThis["fetch"]("https://example.com");'],
    ["window fetch", 'await window.fetch("https://example.com");'],
    ["self fetch", 'await self.fetch("https://example.com");'],
  ])("blocks direct global fetch calls through %s", (_name, code) => {
    const diagnostics = diagnoseCodeModeTypeScript({ declaration, code });

    expect(diagnostics.map((diagnostic) => diagnostic.code)).toContain("FETCH_UNAVAILABLE");
  });

  it("does not block fetch text or non-global fetch member calls", () => {
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: `
        const guidance = "Use the browser Caplet instead of await fetch('https://example.com')";
        const client = { fetch: (value: string) => ({ value }) };
        const result = client.fetch(guidance);
        const f = client.fetch;
        return result;
      `,
    });

    expect(diagnostics.map((diagnostic) => diagnostic.code)).not.toContain("FETCH_UNAVAILABLE");
    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  });

  it("allows standard JavaScript, JSON, console, and Caplet callTool", () => {
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: `
        const state = "open";
        const issue = { state, labels: ["caplets"] };
        console.log(JSON.stringify(issue));
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

  it("keeps platform globals out of generated declarations", () => {
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: `
        new URL("https://example.com");
        Buffer.from("ok");
        crypto.randomUUID();
        setTimeout(() => undefined, 0);
      `,
    });

    const messages = diagnostics.map((diagnostic) => diagnostic.message).join("\n");
    expect(messages).toContain("Cannot find name 'URL'");
    expect(messages).toContain("Cannot find name 'Buffer'");
    expect(messages).toContain("Cannot find name 'crypto'");
    expect(messages).toContain("Cannot find name 'setTimeout'");
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
