import { describe, expect, it, vi } from "vitest";
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
        meta: { sessionId: "session-1", sessionStatus: "reused" },
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

  it("creates a fresh session when compatibility changes", async () => {
    const manager = new CodeModeSessionManager({ idGenerator: () => "session-compat" });
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
      await runCodeMode({
        code: "var value = 1;\nreturn value;",
        service: service(),
        sessionManager: manager,
        runtimeScope: "test",
      });
      const result = await runCodeMode({
        code: "return typeof value;",
        service: changedService,
        sessionManager: manager,
        sessionId: "session-compat",
        runtimeScope: "test",
      });

      expect(result).toMatchObject({
        ok: true,
        value: "undefined",
        meta: { sessionId: "session-compat", sessionStatus: "created" },
      });
    } finally {
      manager.close();
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
});
