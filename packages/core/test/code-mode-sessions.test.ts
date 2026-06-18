import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodeModeJournalStore } from "../src/code-mode/journal";
import { CodeModeSessionManager } from "../src/code-mode/sessions";
import { runCodeMode } from "../src/code-mode/runner";
import type { CodeModeReplSession } from "../src/code-mode/sandbox";
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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("CodeModeSessionManager", () => {
  it("creates and reuses Code Mode state by session id", async () => {
    const manager = new CodeModeSessionManager({ idGenerator: () => "session-1" });
    try {
      const first = await runCodeMode({
        code: "var counter = 1;\nreturn counter;",
        service: service(),
        sessionManager: manager,
        runtimeScope: "test",
      });
      const second = await runCodeMode({
        code: "counter += 1;\nreturn counter;",
        service: service(),
        sessionManager: manager,
        sessionId: "session-1",
        runtimeScope: "test",
      });

      expect(first).toMatchObject({
        ok: true,
        value: 1,
        meta: { sessionId: "session-1", sessionStatus: "created" },
      });
      expect(second).toMatchObject({
        ok: true,
        value: 2,
        meta: {
          sessionId: "session-1",
          sessionStatus: "reused",
          recoveryRef: null,
          recoveryCommand: null,
        },
      });
    } finally {
      manager.close();
    }
  });

  it("rejects unknown session ids before invoking Caplets", async () => {
    const native = service();
    const manager = new CodeModeSessionManager();
    try {
      const result = await runCodeMode({
        code: 'return await caplets.github.callTool("listIssues", {});',
        service: native,
        sessionManager: manager,
        sessionId: "missing",
        runtimeScope: "test",
      });

      expect(result).toMatchObject({
        ok: false,
        error: { code: "SESSION_NOT_FOUND" },
        meta: { sessionId: "missing", sessionStatus: null },
      });
      expect(native.execute).not.toHaveBeenCalled();
    } finally {
      manager.close();
    }
  });

  it("uses prior successful cells for reused-session TypeScript diagnostics", async () => {
    const manager = new CodeModeSessionManager({ idGenerator: () => "session-diagnostics" });
    try {
      const first = await runCodeMode({
        code: "function helper(): number { return 42; }\nreturn helper();",
        service: service(),
        sessionManager: manager,
        runtimeScope: "test",
      });
      const second = await runCodeMode({
        code: "return helper();",
        service: service(),
        sessionManager: manager,
        sessionId: "session-diagnostics",
        runtimeScope: "test",
      });

      expect(first).toMatchObject({ ok: true, value: 42 });
      expect(second).toMatchObject({
        ok: true,
        value: 42,
        meta: {
          sessionId: "session-diagnostics",
          sessionStatus: "reused",
        },
      });
      expect(second.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual(
        [],
      );
    } finally {
      manager.close();
    }
  });

  it("evicts idle sessions by TTL", async () => {
    let now = 0;
    const manager = new CodeModeSessionManager({
      idGenerator: () => "session-ttl",
      now: () => now,
      ttlMs: 10,
    });
    try {
      await runCodeMode({
        code: "var value = 1;\nreturn value;",
        service: service(),
        sessionManager: manager,
        runtimeScope: "test",
      });
      now = 11;
      const result = await runCodeMode({
        code: "return value;",
        service: service(),
        sessionManager: manager,
        sessionId: "session-ttl",
        runtimeScope: "test",
      });

      expect(result).toMatchObject({
        ok: false,
        error: { code: "SESSION_NOT_FOUND" },
      });
    } finally {
      manager.close();
    }
  });

  it("reads retained recovery history with the ref from the original run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-code-mode-session-journal-"));
    let now = 0;
    const manager = new CodeModeSessionManager({
      idGenerator: () => "session-expired",
      now: () => now,
      ttlMs: 10,
    });
    const journalStore = new CodeModeJournalStore({
      stateDir: dir,
      secret: "test-secret",
      now: () => new Date("2026-06-17T12:00:00.000Z"),
    });
    try {
      const first = await runCodeMode({
        code: "function helper() { return 42; }\nreturn helper();",
        service: service(),
        sessionManager: manager,
        journalStore,
        runtimeScope: "test",
      });
      const nextJournalStore = new CodeModeJournalStore({
        stateDir: dir,
        secret: "test-secret",
        now: () => new Date("2026-06-17T12:00:01.000Z"),
      });
      now = 11;
      const expired = await runCodeMode({
        code: "return helper();",
        service: service(),
        sessionManager: manager,
        journalStore: nextJournalStore,
        sessionId: "session-expired",
        runtimeScope: "test",
      });

      expect(expired).toMatchObject({
        ok: false,
        error: { code: "SESSION_NOT_FOUND" },
        meta: {
          sessionId: "session-expired",
          recoveryRef: first.meta.recoveryRef,
          recoveryCommand: expect.stringContaining("caplets.debug.readRecovery"),
        },
      });

      expect(first).toMatchObject({
        ok: true,
        meta: {
          recoveryRef: expect.stringMatching(/^[a-f0-9]{48}$/u),
          recoveryCommand: expect.stringContaining("caplets.debug.readRecovery"),
        },
      });
      const recoveryRef = first.meta.recoveryRef ?? "";
      const recovered = await nextJournalStore.readRecovery({ recoveryRef });
      expect(recovered.entries).toEqual([
        expect.objectContaining({
          code: expect.stringContaining("function helper"),
          recoveryClassification: "setup_like",
        }),
      ]);
    } finally {
      manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns retained recovery history for an old session id in a fresh manager", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-code-mode-session-journal-"));
    const firstManager = new CodeModeSessionManager({ idGenerator: () => "session-restart" });
    const journalStore = new CodeModeJournalStore({
      stateDir: dir,
      secret: "test-secret",
      now: () => new Date("2026-06-17T12:00:00.000Z"),
    });
    try {
      await runCodeMode({
        code: "function helper() { return 42; }\nreturn helper();",
        service: service(),
        sessionManager: firstManager,
        journalStore,
        runtimeScope: "test",
      });
      firstManager.close();
      const freshManager = new CodeModeSessionManager();
      const freshJournalStore = new CodeModeJournalStore({
        stateDir: dir,
        secret: "test-secret",
        now: () => new Date("2026-06-17T12:00:01.000Z"),
      });
      const result = await runCodeMode({
        code: "return helper();",
        service: service(),
        sessionManager: freshManager,
        journalStore: freshJournalStore,
        sessionId: "session-restart",
        runtimeScope: "test",
      });

      expect(result).toMatchObject({
        ok: false,
        error: { code: "SESSION_NOT_FOUND" },
        meta: {
          sessionId: "session-restart",
          recoveryRef: expect.stringMatching(/^[a-f0-9]{48}$/u),
          recoveryCommand: expect.stringContaining("caplets.debug.readRecovery"),
        },
      });
      freshManager.close();
    } finally {
      firstManager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not journal diagnostic-only calls for unknown managed session ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-code-mode-session-journal-"));
    const manager = new CodeModeSessionManager();
    const journalStore = new CodeModeJournalStore({
      stateDir: dir,
      secret: "test-secret",
      now: () => new Date("2026-06-17T12:00:00.000Z"),
    });
    try {
      const diagnostic = await runCodeMode({
        code: 'await caplets.github.call("listIssues", {});',
        service: service(),
        sessionManager: manager,
        journalStore,
        sessionId: "ghost",
        runtimeScope: "test",
      });
      const next = await runCodeMode({
        code: "return 1;",
        service: service(),
        sessionManager: manager,
        journalStore,
        sessionId: "ghost",
        runtimeScope: "test",
      });

      expect(diagnostic).toMatchObject({
        ok: false,
        error: { code: "SESSION_NOT_FOUND" },
        meta: {
          sessionId: "ghost",
          recoveryRef: null,
          recoveryCommand: null,
        },
      });
      expect(next).toMatchObject({
        ok: false,
        error: { code: "SESSION_NOT_FOUND" },
        meta: {
          sessionId: "ghost",
          recoveryRef: null,
          recoveryCommand: null,
        },
      });
      await expect(journalStore.lookupSession("ghost")).resolves.toBeUndefined();
    } finally {
      manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns retained recovery history when the session expires at validation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-code-mode-session-journal-"));
    let now = 0;
    const manager = new CodeModeSessionManager({
      idGenerator: () => "session-diagnostic-expired",
      ttlMs: 10,
      now: () => now,
    });
    const journalStore = new CodeModeJournalStore({
      stateDir: dir,
      secret: "test-secret",
      now: () => new Date("2026-06-17T12:00:00.000Z"),
    });
    try {
      const first = await runCodeMode({
        code: "var saved = 1;\nreturn saved;",
        service: service(),
        sessionManager: manager,
        journalStore,
        runtimeScope: "test",
      });
      const nextJournalStore = new CodeModeJournalStore({
        stateDir: dir,
        secret: "test-secret",
        now: () => new Date("2026-06-17T12:00:01.000Z"),
      });
      now = 11;
      const diagnostic = await runCodeMode({
        code: 'await caplets.github.call("listIssues", {});',
        service: service(),
        sessionManager: manager,
        journalStore: nextJournalStore,
        sessionId: "session-diagnostic-expired",
        runtimeScope: "test",
      });
      const recovery = await nextJournalStore.readRecovery({
        recoveryRef: first.meta.recoveryRef ?? "",
      });

      expect(diagnostic).toMatchObject({
        ok: false,
        error: { code: "SESSION_NOT_FOUND" },
        meta: {
          sessionId: "session-diagnostic-expired",
          recoveryRef: first.meta.recoveryRef,
          recoveryCommand: expect.stringContaining("caplets.debug.readRecovery"),
        },
      });
      expect(recovery.entries).toHaveLength(1);
      await expect(
        nextJournalStore.lookupSession("session-diagnostic-expired"),
      ).resolves.toMatchObject({ recoveryRef: first.meta.recoveryRef });
    } finally {
      manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("journals diagnostic-blocked active session cells under the original recovery ref", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-code-mode-session-journal-"));
    const manager = new CodeModeSessionManager({ idGenerator: () => "session-diagnostic" });
    const journalStore = new CodeModeJournalStore({
      stateDir: dir,
      secret: "test-secret",
      now: () => new Date("2026-06-17T12:00:00.000Z"),
    });
    try {
      const first = await runCodeMode({
        code: "var saved = 1;\nreturn saved;",
        service: service(),
        sessionManager: manager,
        journalStore,
        runtimeScope: "test",
      });
      const diagnostic = await runCodeMode({
        code: 'await caplets.github.call("listIssues", {});',
        service: service(),
        sessionManager: manager,
        journalStore,
        sessionId: "session-diagnostic",
        runtimeScope: "test",
      });
      const recovery = await journalStore.readRecovery({
        recoveryRef: first.meta.recoveryRef ?? "",
      });

      expect(diagnostic).toMatchObject({
        ok: false,
        error: { code: "diagnostic_blocked" },
        meta: {
          sessionId: "session-diagnostic",
          sessionStatus: "reused",
          recoveryRef: null,
          recoveryCommand: null,
        },
      });
      expect(recovery.entries).toHaveLength(2);
      expect(recovery.entries[0]?.code).toContain("var saved");
      expect(recovery.entries[1]?.outcome).toMatchObject({ ok: false, code: "diagnostic_blocked" });
    } finally {
      manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("classifies timer-disposed session cells as unknown recovery history", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-code-mode-session-journal-"));
    const manager = new CodeModeSessionManager({ idGenerator: () => "session-timer" });
    const journalStore = new CodeModeJournalStore({
      stateDir: dir,
      secret: "test-secret",
      now: () => new Date("2026-06-17T12:00:00.000Z"),
    });
    try {
      const result = await runCodeMode({
        code: 'const timer = setTimeout(() => console.log("later"), 1000);\nreturn 1;',
        service: service(),
        sessionManager: manager,
        journalStore,
        runtimeScope: "test",
        timeoutMs: 2_000,
      });
      const recovery = await journalStore.readRecovery({
        recoveryRef: result.meta.recoveryRef ?? "",
      });

      expect(result).toMatchObject({ ok: true, value: 1 });
      expect(recovery.entries).toEqual([
        expect.objectContaining({
          recoveryClassification: "unknown",
        }),
      ]);
      expect(manager.has("session-timer")).toBe(false);
    } finally {
      manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects stale session ids when compatibility changes before executing code", async () => {
    const manager = new CodeModeSessionManager({ idGenerator: () => "session-compat" });
    const changedService = service();
    const native = service();
    changedService.listTools = () => [
      {
        caplet: "linear",
        toolName: "caplets__linear",
        title: "Linear",
        description: "Linear operations.",
        promptGuidance: [],
      },
    ];
    try {
      await runCodeMode({
        code: "var value = 1;\nreturn value;",
        service: native,
        sessionManager: manager,
        runtimeScope: "test",
      });
      const result = await runCodeMode({
        code: "return await caplets.linear.callTool('sideEffect', {});",
        service: changedService,
        sessionManager: manager,
        sessionId: "session-compat",
        runtimeScope: "test",
      });

      expect(result).toMatchObject({
        ok: false,
        error: { code: "SESSION_NOT_FOUND" },
        meta: { sessionId: "session-compat", sessionStatus: null },
      });
      expect(changedService.execute).not.toHaveBeenCalled();
    } finally {
      manager.close();
    }
  });

  it("returns retained recovery history when compatibility changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-code-mode-session-journal-"));
    const manager = new CodeModeSessionManager({ idGenerator: () => "session-compat-journal" });
    const journalStore = new CodeModeJournalStore({
      stateDir: dir,
      secret: "test-secret",
      now: () => new Date("2026-06-17T12:00:00.000Z"),
    });
    const changedService = service();
    changedService.listTools = () => [
      {
        caplet: "linear",
        toolName: "caplets__linear",
        title: "Linear",
        description: "Linear operations.",
        promptGuidance: [],
      },
    ];
    try {
      const first = await runCodeMode({
        code: "var oldValue = 1;\nreturn oldValue;",
        service: service(),
        sessionManager: manager,
        journalStore,
        runtimeScope: "test",
      });
      const nextJournalStore = new CodeModeJournalStore({
        stateDir: dir,
        secret: "test-secret",
        now: () => new Date("2026-06-17T12:00:01.000Z"),
      });
      const second = await runCodeMode({
        code: "var newValue = 2;\nreturn typeof oldValue;",
        service: changedService,
        sessionManager: manager,
        journalStore: nextJournalStore,
        sessionId: "session-compat-journal",
        runtimeScope: "test",
      });

      const oldRecovery = await nextJournalStore.readRecovery({
        recoveryRef: first.meta.recoveryRef ?? "",
      });

      expect(first).toMatchObject({ ok: true, value: 1 });
      expect(second).toMatchObject({
        ok: false,
        error: { code: "SESSION_NOT_FOUND" },
        meta: {
          sessionStatus: null,
          recoveryRef: first.meta.recoveryRef,
          recoveryCommand: expect.stringContaining("caplets.debug.readRecovery"),
        },
      });
      expect(oldRecovery.entries).toHaveLength(1);
      expect(oldRecovery.entries[0]?.code).toContain("var oldValue = 1");
      expect(oldRecovery.entries[0]?.code).not.toContain("newValue");
    } finally {
      manager.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns a busy error for overlapping runs on the same session", async () => {
    const manager = new CodeModeSessionManager({ idGenerator: () => "session-busy" });
    try {
      await runCodeMode({
        code: "var value = 1;\nreturn value;",
        service: service(),
        sessionManager: manager,
        runtimeScope: "test",
      });
      const slow = runCodeMode({
        code: "await new Promise((resolve) => setTimeout(resolve, 50));\nreturn value;",
        service: service(),
        sessionManager: manager,
        sessionId: "session-busy",
        runtimeScope: "test",
        timeoutMs: 1_000,
      });
      const busy = await runCodeMode({
        code: "return value;",
        service: service(),
        sessionManager: manager,
        sessionId: "session-busy",
        runtimeScope: "test",
      });

      expect(busy).toMatchObject({
        ok: false,
        error: { code: "SESSION_BUSY" },
      });
      await slow;
    } finally {
      manager.close();
    }
  });

  it("does not invoke downstream Caplets after close", async () => {
    const manager = new CodeModeSessionManager({ idGenerator: () => "session-close" });
    const native = service();
    try {
      const run = runCodeMode({
        code: 'await new Promise((resolve) => setTimeout(resolve, 80));\nreturn await caplets.github.callTool("afterClose", {});',
        service: native,
        sessionManager: manager,
        runtimeScope: "test",
        timeoutMs: 1_000,
      });
      await delay(20);
      manager.close();
      const result = await run;

      expect(result).toMatchObject({
        ok: false,
        error: { message: "Code Mode session manager is closed." },
      });
      expect(native.execute).not.toHaveBeenCalled();
    } finally {
      manager.close();
    }
  });

  it("disposes a session created after close and returns a closed error", async () => {
    const createStarted = deferred();
    const releaseCreate = deferred();
    const sessionRun = vi.fn(async () => ({
      ok: true as const,
      value: "ran-after-close",
      logs: [],
    }));
    const sessionDispose = vi.fn();
    const fakeSession: CodeModeReplSession = {
      run: sessionRun,
      dispose: sessionDispose,
      isDisposed: () => sessionDispose.mock.calls.length > 0,
    };
    const manager = new CodeModeSessionManager({
      idGenerator: () => "session-race",
      sandboxFactory: () => ({
        createSession: async () => {
          createStarted.resolve();
          await releaseCreate.promise;
          return fakeSession;
        },
      }),
    });

    const run = runCodeMode({
      code: 'return "ran-after-close";',
      service: service(),
      sessionManager: manager,
      runtimeScope: "test",
    });
    await createStarted.promise;
    manager.close();
    releaseCreate.resolve();
    const result = await run;

    expect(result).toMatchObject({
      ok: false,
      error: { code: "SESSION_CLOSED" },
      meta: { sessionId: "session-race", sessionStatus: null },
    });
    expect(sessionDispose).toHaveBeenCalledOnce();
    expect(sessionRun).not.toHaveBeenCalled();
    expect(manager.has("session-race")).toBe(false);
  });

  it("enforces maxSessions after overlapping fresh runs become idle", async () => {
    let nextId = 0;
    const manager = new CodeModeSessionManager({
      maxSessions: 1,
      idGenerator: () => `session-${++nextId}`,
    });
    try {
      const first = runCodeMode({
        code: "await new Promise((resolve) => setTimeout(resolve, 80));\nreturn 1;",
        service: service(),
        sessionManager: manager,
        runtimeScope: "test",
        timeoutMs: 1_000,
      });
      await delay(20);
      const second = runCodeMode({
        code: "await new Promise((resolve) => setTimeout(resolve, 80));\nreturn 2;",
        service: service(),
        sessionManager: manager,
        runtimeScope: "test",
        timeoutMs: 1_000,
      });

      await Promise.all([first, second]);

      expect([manager.has("session-1"), manager.has("session-2")].filter(Boolean)).toHaveLength(1);
    } finally {
      manager.close();
    }
  });

  it("forgets sessions that dispose themselves after a run", async () => {
    const manager = new CodeModeSessionManager({ idGenerator: () => "session-disposed" });
    try {
      await runCodeMode({
        code: "var x = 'persisted';\nreturn x;",
        service: service(),
        sessionManager: manager,
        runtimeScope: "test",
      });
      const tainted = await runCodeMode({
        code: "__caplets_persist.x = 'poisoned';\nreturn x;",
        service: service(),
        sessionManager: manager,
        sessionId: "session-disposed",
        runtimeScope: "test",
      });
      const next = await runCodeMode({
        code: "return x;",
        service: service(),
        sessionManager: manager,
        sessionId: "session-disposed",
        runtimeScope: "test",
      });

      expect(tainted).toMatchObject({ ok: true, value: "persisted" });
      expect(next).toMatchObject({
        ok: false,
        error: { code: "SESSION_NOT_FOUND" },
      });
    } finally {
      manager.close();
    }
  });

  it("uses prior successful cells for reused session diagnostics", async () => {
    const manager = new CodeModeSessionManager({ idGenerator: () => "session-diagnostics-reuse" });
    try {
      const first = await runCodeMode({
        code: "function helper() { return 42; }\nreturn helper();",
        service: service(),
        sessionManager: manager,
        runtimeScope: "test",
      });
      const rejected = await runCodeMode({
        code: 'await caplets.github.call("listIssues", {});',
        service: service(),
        sessionManager: manager,
        sessionId: "session-diagnostics-reuse",
        runtimeScope: "test",
      });
      const second = await runCodeMode({
        code: "return helper();",
        service: service(),
        sessionManager: manager,
        sessionId: "session-diagnostics-reuse",
        runtimeScope: "test",
      });

      expect(first).toMatchObject({ ok: true, value: 42 });
      expect(rejected).toMatchObject({ ok: false, error: { code: "diagnostic_blocked" } });
      expect(second).toMatchObject({ ok: true, value: 42 });
      expect(second.diagnostics).toEqual([]);
    } finally {
      manager.close();
    }
  });
});
