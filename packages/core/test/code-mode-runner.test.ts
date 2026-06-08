import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCodeMode } from "../src/code-mode/runner";
import { CodeModeLogStore } from "../src/code-mode/logs";
import type { NativeCapletTool, NativeCapletsService } from "../src/native/service";

function service(): NativeCapletsService {
  const tools: NativeCapletTool[] = [
    {
      caplet: "github",
      toolName: "caplets_github",
      title: "GitHub",
      description: "GitHub repo operations.",
      promptGuidance: [],
    },
  ];
  return {
    listTools: () => tools,
    execute: vi.fn(async (capletId: string, request: unknown) => ({
      ok: true,
      capletId,
      request,
    })),
    reload: vi.fn(async () => true),
    onToolsChanged: vi.fn(() => () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe("runCodeMode", () => {
  it("returns an ok envelope for JSON-serializable values", async () => {
    const result = await runCodeMode({
      code: "return { ok: true, count: 2 + 2 };",
      service: service(),
      runtimeScope: "test",
    });

    expect(result).toMatchObject({
      ok: true,
      value: { ok: true, count: 4 },
      diagnostics: [],
      meta: { timeoutMs: 10_000 },
    });
  });

  it("blocks diagnostics before Caplet calls", async () => {
    const native = service();
    const result = await runCodeMode({
      code: 'await caplets.github.call("listIssues", {});',
      service: native,
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
    expect(native.execute).not.toHaveBeenCalled();
  });

  it("blocks direct fetch and imports", async () => {
    const fetchResult = await runCodeMode({
      code: 'return await fetch("https://example.com");',
      service: service(),
    });
    const importResult = await runCodeMode({
      code: 'return await import("node:fs");',
      service: service(),
    });

    expect(fetchResult.ok).toBe(false);
    expect(importResult.ok).toBe(false);
    expect(fetchResult.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain(
      "Cannot find name 'fetch'",
    );
    expect(importResult.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toContain(
      "Imports are not available in Code Mode",
    );
  });

  it("captures redacted logs and expands them through debug.readLogs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-code-mode-runner-"));
    try {
      const logStore = new CodeModeLogStore({
        stateDir: dir,
        now: () => new Date("2026-06-07T12:00:00.000Z"),
      });
      const result = await runCodeMode({
        code: `
          console.log("token", "Bearer secret-token-value", "ian@example.com");
          return "done";
        `,
        service: service(),
        logStore,
      });

      expect(result.ok).toBe(true);
      expect(JSON.stringify(result)).not.toContain("secret-token-value");
      expect(JSON.stringify(result)).not.toContain("ian@example.com");
      expect(result.logs.stored).toBe(true);
      expect(result.logs.logRef).toMatch(/^[a-f0-9]{48}$/u);
      const expanded = await logStore.read({ logRef: result.logs.logRef ?? "", limit: 10 });
      expect(expanded.entries).toMatchObject([
        {
          level: "log",
          message: "token Bearer [REDACTED:token] [REDACTED:email]",
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes Caplet callTool through NativeCapletsService.execute", async () => {
    const native = service();
    const result = await runCodeMode({
      code: 'return await caplets.github.callTool("listIssues", { state: "open" });',
      service: native,
    });

    expect(result.ok).toBe(true);
    expect(native.execute).toHaveBeenCalledWith("github", {
      operation: "call_tool",
      name: "listIssues",
      args: { state: "open" },
    });
  });

  it("fails non-JSON return values with a structured serialization diagnostic", async () => {
    const result = await runCodeMode({
      code: "return 1n;",
      service: service(),
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "SERIALIZATION_ERROR",
    );
  });
});
