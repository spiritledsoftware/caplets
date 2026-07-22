import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCodeMode } from "../src/code-mode/runner";
import { CodeModeJournalStore } from "../src/code-mode/journal";
import { CodeModeLogStore } from "../src/code-mode/logs";
import { CodeModeSessionManager } from "../src/code-mode/sessions";
import type { NativeCapletTool, NativeCapletsService } from "../src/native/service";

function service(): NativeCapletsService {
  const tools: NativeCapletTool[] = [
    {
      caplet: "github",
      toolName: "caplets__github",
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
      meta: { timeoutMs: 10_000, maxTimeoutMs: 120_000 },
    });
  });
  it.each([
    ["the default maximum", undefined],
    ["an attempted higher override", Number.MAX_SAFE_INTEGER],
    ["an attempted infinite override", Number.POSITIVE_INFINITY],
  ])(
    "rejects direct timeouts above 120 seconds before sandbox execution with %s",
    async (_label, maxTimeoutMs) => {
      const sandbox = {
        run: vi.fn(async () => ({ ok: true as const, value: null, logs: [] })),
      };

      const result = await runCodeMode({
        code: "return true;",
        service: service(),
        timeoutMs: 120_001,
        ...(maxTimeoutMs === undefined ? {} : { maxTimeoutMs }),
        sandbox,
      });

      expect(result).toMatchObject({
        ok: false,
        error: { code: "diagnostic_blocked" },
        diagnostics: [{ code: "TIMEOUT_POLICY_EXCEEDED", severity: "error" }],
        meta: { timeoutMs: 120_001, maxTimeoutMs: 120_000 },
      });
      expect(sandbox.run).not.toHaveBeenCalled();
    },
  );
  it("rejects timeout policy before allocating a session sandbox", async () => {
    const createSession = vi.fn(async () => {
      throw new Error("Session sandbox must not be allocated.");
    });
    const sandboxFactory = vi.fn(() => ({ createSession }));
    const sessionManager = new CodeModeSessionManager({ sandboxFactory });
    try {
      const result = await runCodeMode({
        code: "return true;",
        service: service(),
        timeoutMs: 120_001,
        sessionManager,
      });

      expect(result).toMatchObject({
        ok: false,
        error: { code: "diagnostic_blocked" },
        diagnostics: [{ code: "TIMEOUT_POLICY_EXCEEDED", severity: "error" }],
      });
      expect(sandboxFactory).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
    } finally {
      sessionManager.close();
    }
  });

  it.each([
    ["a NaN timeout", { timeoutMs: Number.NaN }],
    ["a positive-infinite timeout", { timeoutMs: Number.POSITIVE_INFINITY }],
    ["a negative-infinite timeout", { timeoutMs: Number.NEGATIVE_INFINITY }],
    ["a NaN lower policy", { timeoutMs: 1_000, maxTimeoutMs: Number.NaN }],
    [
      "a negative-infinite lower policy",
      { timeoutMs: 1_000, maxTimeoutMs: Number.NEGATIVE_INFINITY },
    ],
  ])("rejects %s before sandbox execution", async (_label, policy) => {
    const sandbox = {
      run: vi.fn(async () => ({ ok: true as const, value: null, logs: [] })),
    };

    const result = await runCodeMode({
      code: "return true;",
      service: service(),
      ...policy,
      sandbox,
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "diagnostic_blocked" },
      diagnostics: [{ code: "TIMEOUT_POLICY_EXCEEDED", severity: "error" }],
    });
    expect(Number.isFinite(result.meta.timeoutMs)).toBe(true);
    expect(Number.isFinite(result.meta.maxTimeoutMs)).toBe(true);
    expect(sandbox.run).not.toHaveBeenCalled();
  });

  it("accepts exactly 120 seconds through the direct runner seam", async () => {
    const sandbox = {
      run: vi.fn(async () => ({ ok: true as const, value: "accepted", logs: [] })),
    };

    const result = await runCodeMode({
      code: 'return "accepted";',
      service: service(),
      timeoutMs: 120_000,
      sandbox,
    });

    expect(result).toMatchObject({
      ok: true,
      value: "accepted",
      meta: { timeoutMs: 120_000, maxTimeoutMs: 120_000 },
    });
    expect(sandbox.run).toHaveBeenCalledOnce();
  });

  it("retains a lower direct maximum as the effective policy", async () => {
    const sandbox = {
      run: vi.fn(async () => ({ ok: true as const, value: null, logs: [] })),
    };

    const result = await runCodeMode({
      code: "return true;",
      service: service(),
      timeoutMs: 5_001,
      maxTimeoutMs: 5_000,
      sandbox,
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ code: "TIMEOUT_POLICY_EXCEEDED", severity: "error" }],
      meta: { timeoutMs: 5_001, maxTimeoutMs: 5_000 },
    });
    expect(sandbox.run).not.toHaveBeenCalled();
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

  it("allows import syntax inside returned documentation strings", async () => {
    const result = await runCodeMode({
      code: `
        return {
          guidance: [
            "import { McpServer } from '@modelcontextprotocol/server';",
            "import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';",
            "const server = new McpServer({ name: 'demo', version: '1.0.0' });",
          ],
        };
      `,
      service: service(),
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        guidance: [
          "import { McpServer } from '@modelcontextprotocol/server';",
          "import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';",
          "const server = new McpServer({ name: 'demo', version: '1.0.0' });",
        ],
      },
    });
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
    expect(result.meta.anyCapletInvoked).toBe(true);
    expect(native.execute).toHaveBeenCalledWith("github", {
      operation: "call_tool",
      name: "listIssues",
      args: { state: "open" },
    });
  });

  it("rejects session ids when no session manager is available", async () => {
    const native = service();
    const result = await runCodeMode({
      code: "return missingFromSession;",
      service: native,
      sessionId: "expired-session",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "SESSION_NOT_FOUND" },
      diagnostics: [],
      meta: { sessionId: "expired-session", sessionStatus: null },
    });
    expect(native.execute).not.toHaveBeenCalled();
  });

  it("journals Caplet execution as side-effecting recovery history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-code-mode-runner-journal-"));
    try {
      const journalStore = new CodeModeJournalStore({
        stateDir: dir,
        secret: "test-secret",
        now: () => new Date("2026-06-17T12:00:00.000Z"),
      });
      const sessionManager = new CodeModeSessionManager({ idGenerator: () => "session-journal" });
      const result = await runCodeMode({
        code: 'return await caplets.github.callTool("listIssues", { state: "open" });',
        service: service(),
        sessionManager,
        journalStore,
      });

      expect(result.ok).toBe(true);
      const recovery = await journalStore.readRecovery({
        recoveryRef: result.meta.recoveryRef ?? "",
      });

      expect(recovery.entries).toEqual([
        expect.objectContaining({
          recoveryClassification: "side_effecting",
          code: expect.stringContaining("caplets.github.callTool"),
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not replace Code Mode results when journal storage fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-code-mode-runner-journal-link-"));
    const outside = mkdtempSync(join(tmpdir(), "caplets-code-mode-runner-journal-outside-"));
    try {
      mkdirSync(join(dir, "code-mode"));
      symlinkSync(outside, join(dir, "code-mode", "journal"));
      const journalStore = new CodeModeJournalStore({
        stateDir: dir,
        secret: "test-secret",
      });
      const native = service();
      const sessionManager = new CodeModeSessionManager({
        idGenerator: () => "session-journal-failure",
      });
      const success = await runCodeMode({
        code: 'return await caplets.github.callTool("listIssues", { state: "open" });',
        service: native,
        sessionManager,
        journalStore,
      });
      const diagnostic = await runCodeMode({
        code: 'await caplets.github.call("listIssues", {});',
        service: service(),
        sessionManager,
        sessionId: "session-journal-failure",
        journalStore,
      });

      expect(success).toMatchObject({ ok: true });
      expect(native.execute).toHaveBeenCalled();
      expect(diagnostic).toMatchObject({
        ok: false,
        error: { code: "diagnostic_blocked" },
      });
      sessionManager.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
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

  it("records successful session cells before serialization errors return", async () => {
    const manager = new CodeModeSessionManager({ idGenerator: () => "session-serialization" });
    try {
      const first = await runCodeMode({
        code: "function helper() { return 1n; }\nreturn helper();",
        service: service(),
        sessionManager: manager,
        runtimeScope: "test",
      });
      const second = await runCodeMode({
        code: "return typeof helper;",
        service: service(),
        sessionManager: manager,
        sessionId: "session-serialization",
        runtimeScope: "test",
      });

      expect(first).toMatchObject({ ok: false, error: { code: "SERIALIZATION_ERROR" } });
      expect(second).toMatchObject({ ok: true, value: "function", diagnostics: [] });
    } finally {
      manager.close();
    }
  });
});
