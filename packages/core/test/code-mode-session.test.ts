import { describe, expect, it, vi } from "vitest";
import {
  CodeModeDiagnosticsSession,
  diagnoseCodeModeTypeScript,
} from "../src/code-mode/diagnostics";
import { QuickJsCodeModeSandbox } from "../src/code-mode/sandbox";

const invoke = vi.fn(async () => ({ ok: true }));

describe("QuickJsCodeModeSandbox sessions", () => {
  it("reuses named helpers across cells in one session", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "function double(value: number) { return value * 2; }\nreturn double(3);",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return double(5);",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: 6 });
      expect(second).toMatchObject({ ok: true, value: 10 });
    } finally {
      session.dispose();
    }
  });

  it("keeps one-shot runs draining pending timer work before returning", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const localInvoke = vi.fn(async () => ({ ok: true }));

    const result = await sandbox.run({
      code: "setTimeout(() => { void caplets.alpha.inspect(); }, 0);\nreturn 'done';",
      capletIds: ["alpha"],
      timeoutMs: 1_000,
      invoke: localInvoke,
    });

    expect(result).toMatchObject({ ok: true, value: "done" });
    expect(localInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ capletId: "alpha", method: "inspect" }),
    );
  });

  it("keeps a session reusable after a runtime error without global changes", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const failed = await session.run({
        code: 'throw new Error("boom");',
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const recovered = await session.run({
        code: "return 2 + 2;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "boom" });
      expect(recovered).toMatchObject({ ok: true, value: 4 });
    } finally {
      session.dispose();
    }
  });

  it("preserves same-cell closures for reusable named helpers", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "const factor = 2;\nfunction double(v) { return v * factor; }\nreturn double(3);",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return double(4);",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: 6 });
      expect(second).toMatchObject({ ok: true, value: 8 });
    } finally {
      session.dispose();
    }
  });

  it("preserves same-cell function hoisting for reusable named helpers", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const result = await session.run({
        code: "const before = double(3);\nfunction double(v) { return v * 2; }\nreturn before;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const reused = await session.run({
        code: "return double(4);",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(result).toMatchObject({ ok: true, value: 6 });
      expect(reused).toMatchObject({ ok: true, value: 8 });
    } finally {
      session.dispose();
    }
  });

  it("persists helpers declared after an early return", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "return double(3);\nfunction double(v) { return v * 2; }",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return double(4);",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: 6 });
      expect(second).toMatchObject({ ok: true, value: 8 });
    } finally {
      session.dispose();
    }
  });

  it("persists helpers before returns inside top-level control flow", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "function double(v) { return v * 2; }\nif (true) return double(3);\nreturn 0;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return double(4);",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: 6 });
      expect(second).toMatchObject({ ok: true, value: 8 });
    } finally {
      session.dispose();
    }
  });

  it("persists same-cell helper reassignments", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "function f() { return 1; }\nf = () => 2;\nreturn f();",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return f();",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: 2 });
      expect(second).toMatchObject({ ok: true, value: 2 });
    } finally {
      session.dispose();
    }
  });

  it("persists helper reassignments inside return expressions", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "function f() { return 1; }\nreturn (f = () => 2, f());",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return f();",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: 2 });
      expect(second).toMatchObject({ ok: true, value: 2 });
    } finally {
      session.dispose();
    }
  });

  it("persists helper reassignments from finally blocks", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "function f() { return 1; }\ntry { return f(); } finally { f = () => 2; }",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return f();",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: 1 });
      expect(second).toMatchObject({ ok: true, value: 2 });
    } finally {
      session.dispose();
    }
  });

  it("reuses top-level const bindings across cells", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "const gmail = caplets.gmail;\nreturn gmail.id;",
        capletIds: ["gmail"],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return gmail.id;",
        capletIds: ["gmail"],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: "gmail" });
      expect(second).toMatchObject({ ok: true, value: "gmail" });
    } finally {
      session.dispose();
    }
  });
  it("preserves lexical semantics and live closures across cells", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "let count = 1;\nconst step = 2;\nfunction read() { return count + step; }\nclass Box { value() { return read(); } }\nreturn new Box().value();",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "count = 3;\nreturn { direct: read(), boxed: new Box().value() };",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const reassignedConst = await session.run({
        code: "step = 4;\nreturn step;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const redeclaredConst = await session.run({
        code: "const step = 5;\nreturn step;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: 3 });
      expect(second).toMatchObject({ ok: true, value: { direct: 5, boxed: 5 } });
      expect(reassignedConst).toMatchObject({
        ok: false,
        error: expect.stringContaining("constant"),
      });
      expect(redeclaredConst).toMatchObject({
        ok: false,
        error: expect.stringContaining("already been declared"),
      });
    } finally {
      session.dispose();
    }
  });

  it("keeps awaited const bindings immutable across cells", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "const value = await Promise.resolve(3);\nreturn value;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const reassigned = await session.run({
        code: "value = 4;\nreturn value;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const persisted = await session.run({
        code: "return value;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: 3 });
      expect(reassigned).toMatchObject({
        ok: false,
        error: expect.stringContaining("constant"),
      });
      expect(persisted).toMatchObject({ ok: true, value: 3 });
    } finally {
      session.dispose();
    }
  });

  it("retains completed bindings and mutations after ordinary runtime errors", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var counter = 1;\nvar state = { count: 0 };",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const failed = await session.run({
        code: "let after = 4;\ncounter = 2;\nstate.count = 3;\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const persisted = await session.run({
        code: "return { after, counter, count: state.count };",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "boom" });
      expect(persisted).toMatchObject({
        ok: true,
        value: { after: 4, counter: 2, count: 3 },
      });
    } finally {
      session.dispose();
    }
  });

  it("settles failed lexical initializers like Node REPL bindings", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const failed = await session.run({
        code: "const blocked = await Promise.reject(new Error('nope'));",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const read = await session.run({
        code: "return typeof blocked;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const assigned = await session.run({
        code: "blocked = 1;\nreturn blocked;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const redeclared = await session.run({
        code: "const blocked = 2;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "nope" });
      expect(read).toMatchObject({ ok: true, value: "undefined" });
      expect(assigned).toMatchObject({ ok: true, value: 1 });
      expect(redeclared).toMatchObject({
        ok: false,
        error: expect.stringContaining("already been declared"),
      });
    } finally {
      session.dispose();
    }
  });

  it("reuses destructured lexical bindings with ordered defaults", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "const { a = 1, b = a + 1 } = {};\nlet [c] = [3];\nreturn { a, b, c };",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "c += 1;\nreturn { a, b, c };",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: { a: 1, b: 2, c: 3 } });
      expect(second).toMatchObject({ ok: true, value: { a: 1, b: 2, c: 4 } });
    } finally {
      session.dispose();
    }
  });

  it("reuses TypeScript enum and namespace values across cells", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: 'enum Status { Ready = "ready" }\nnamespace Values { export let count = 1; }\nreturn `${Status.Ready}:${Values.count}`;',
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "Values.count += 1;\nreturn `${Status.Ready}:${Values.count}`;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: "ready:1" });
      expect(second).toMatchObject({ ok: true, value: "ready:2" });
    } finally {
      session.dispose();
    }
  });

  it("reuses var bindings across cells in one session", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "var counter = 1;\nreturn counter;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "counter += 1;\nreturn counter;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: 1 });
      expect(second).toMatchObject({ ok: true, value: 2 });
    } finally {
      session.dispose();
    }
  });

  it("persists mutations to existing var bindings", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "var counter = 1;\nreturn counter;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "counter += 1;\nreturn counter;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const third = await session.run({
        code: "return counter;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: 1 });
      expect(second).toMatchObject({ ok: true, value: 2 });
      expect(third).toMatchObject({ ok: true, value: 2 });
    } finally {
      session.dispose();
    }
  });

  it("keeps existing persisted vars across same-cell var redeclarations", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var x = 1;\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const redeclared = await session.run({
        code: "var x;\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const incremented = await session.run({
        code: "var x = x + 1;\nif (true) { let x = 0; }\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(redeclared).toMatchObject({ ok: true, value: 1 });
      expect(incremented).toMatchObject({ ok: true, value: 2 });
    } finally {
      session.dispose();
    }
  });

  it("rejects lexical redeclarations of persisted var bindings", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var x = 1;\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const shadowed = await session.run({
        code: "let x = 2;\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const persisted = await session.run({
        code: "return x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(shadowed).toMatchObject({
        ok: false,
        error: expect.stringContaining("already been declared"),
      });
      expect(persisted).toMatchObject({ ok: true, value: 1 });
    } finally {
      session.dispose();
    }
  });

  it("does not snapshot block-local lexical shadows over persisted vars", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var x = 1;\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const shadowed = await session.run({
        code: "if (true) { let x = 2; return x; }\nreturn 0;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const persisted = await session.run({
        code: "return x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(shadowed).toMatchObject({ ok: true, value: 2 });
      expect(persisted).toMatchObject({ ok: true, value: 1 });
    } finally {
      session.dispose();
    }
  });

  it("persists mutations to existing helper bindings", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "function f() { return 1; }\nreturn f();",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "f = () => 3;\nreturn f();",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const third = await session.run({
        code: "return f();",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(second).toMatchObject({ ok: true, value: 3 });
      expect(third).toMatchObject({ ok: true, value: 3 });
    } finally {
      session.dispose();
    }
  });

  it("reuses top-level awaited var initializers across cells", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "var value = await Promise.resolve(3);\nreturn value;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return value;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: 3 });
      expect(second).toMatchObject({ ok: true, value: 3 });
    } finally {
      session.dispose();
    }
  });

  it("reuses destructured top-level awaited var initializers across cells", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "var { value } = await Promise.resolve({ value: 3 });\nreturn value;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return value;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: 3 });
      expect(second).toMatchObject({ ok: true, value: 3 });
    } finally {
      session.dispose();
    }
  });

  it("reuses var bindings declared inside top-level control flow", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "if (true) { var inner = 7; }\nreturn inner;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return inner;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: 7 });
      expect(second).toMatchObject({ ok: true, value: 7 });
    } finally {
      session.dispose();
    }
  });

  it("reuses var bindings declared in for initializers", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "for (var i = 0; i < 3; i += 1) {}\nreturn i;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return i;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: 3 });
      expect(second).toMatchObject({ ok: true, value: 3 });
    } finally {
      session.dispose();
    }
  });

  it("preserves strict-mode this semantics in session cells", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const result = await session.run({
        code: "function f() { return this === undefined; }\nreturn f();",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(result).toMatchObject({ ok: true, value: true });
    } finally {
      session.dispose();
    }
  });

  it("keeps caplets read-only like one-shot cells", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "caplets = null;\nreturn caplets;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return typeof caplets.debug.readLogs;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: false });
      expect(first.ok === false ? first.error : "").toContain("read-only");
      expect(second).toMatchObject({ ok: true, value: "function" });
    } finally {
      session.dispose();
    }
  });

  it("keeps debug helpers additive on a real debug Caplet handle", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    const localInvoke = vi.fn(async (input) => ({
      capletId: input.capletId,
      method: input.method,
    }));
    try {
      const result = await session.run({
        code: "return { inspect: await caplets.debug.inspect(), readLogs: typeof caplets.debug.readLogs };",
        capletIds: ["debug"],
        timeoutMs: 1_000,
        invoke: localInvoke,
      });

      expect(result).toMatchObject({
        ok: true,
        value: {
          inspect: { capletId: "debug", method: "inspect" },
          readLogs: "function",
        },
      });
    } finally {
      session.dispose();
    }
  });

  it("allows synthetic debug recovery reads without an active debug Caplet", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    const localInvoke = vi.fn(async (input) => ({
      capletId: input.capletId,
      method: input.method,
      args: input.args,
    }));
    try {
      const result = await session.run({
        code: 'return await caplets.debug.readRecovery({ recoveryRef: "recovery-1" });',
        capletIds: [],
        timeoutMs: 1_000,
        invoke: localInvoke,
      });

      expect(result).toMatchObject({
        ok: true,
        value: {
          capletId: "debug",
          method: "readRecovery",
          args: [{ recoveryRef: "recovery-1" }],
        },
      });
      expect(localInvoke).toHaveBeenCalledWith(
        expect.objectContaining({ capletId: "debug", method: "readRecovery" }),
      );
    } finally {
      session.dispose();
    }
  });

  it("preserves duplicate var and let binding errors inside a cell", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const result = await session.run({
        code: "var x;\nlet x = 2;\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(result).toMatchObject({ ok: false });
    } finally {
      session.dispose();
    }
  });

  it("removes caplet handles that are unavailable in later session cells", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "return typeof caplets.alpha;",
        capletIds: ["alpha"],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return typeof caplets.alpha;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: "object" });
      expect(second).toMatchObject({ ok: true, value: "undefined" });
    } finally {
      session.dispose();
    }
  });

  it("prevents user code from replacing internal bridge handle factories", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "globalThis.__caplets_handle = () => ({ marker: 'fake' });\nreturn typeof globalThis.__caplets_handle;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return caplets.alpha.id;",
        capletIds: ["alpha"],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: false });
      expect(second).toMatchObject({ ok: true, value: "alpha" });
    } finally {
      session.dispose();
    }
  });

  it("prevents user code from replacing the internal invoke bridge", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    const localInvoke = vi.fn(async () => ({ ok: true, source: "host" }));
    try {
      const first = await session.run({
        code: "globalThis.__caplets_invoke = () => JSON.stringify({ ok: true, source: 'fake' });\nreturn typeof globalThis.__caplets_invoke;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke: localInvoke,
      });
      const second = await session.run({
        code: "return caplets.alpha.inspect();",
        capletIds: ["alpha"],
        timeoutMs: 1_000,
        invoke: localInvoke,
      });

      expect(first).toMatchObject({ ok: true, value: "function" });
      expect(second).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
      expect(localInvoke).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
  });

  it("prevents user code from replacing the internal JSON invoke bridge", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    const localInvoke = vi.fn(async () => ({ ok: true, source: "host" }));
    try {
      const first = await session.run({
        code: "globalThis.__caplets_invoke_json = () => ({ ok: true, source: 'fake' });\nreturn typeof globalThis.__caplets_invoke_json;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke: localInvoke,
      });
      const second = await session.run({
        code: "return caplets.alpha.inspect();",
        capletIds: ["alpha"],
        timeoutMs: 1_000,
        invoke: localInvoke,
      });

      expect(first).toMatchObject({ ok: false });
      expect(second).toMatchObject({ ok: true, value: { ok: true, source: "host" } });
      expect(localInvoke).toHaveBeenCalledWith(
        expect.objectContaining({ capletId: "alpha", method: "inspect" }),
      );
    } finally {
      session.dispose();
    }
  });

  it("does not let user code poison the result channel", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const poisoned = await session.run({
        code: "Object.defineProperty(globalThis, '__caplets_result', { configurable: false, writable: false, value: Promise.resolve('masked') });\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "throw new Error('still failed');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(poisoned).toMatchObject({ ok: false });
      expect(next).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("restores Promise internals while retaining completed failed-cell mutations", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var state = { count: 0 };\nreturn state.count;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const poisoned = await session.run({
        code: "Promise.prototype.then = function(onFulfilled) { onFulfilled('masked'); return { then() {} }; };\nstate.count = 1;\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return state.count;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(poisoned).toMatchObject({ ok: false });
      expect(next).toMatchObject({ ok: true, value: 1 });
    } finally {
      session.dispose();
    }
  });

  it("blocks promise observer enumeration without changing existing state", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var state = { count: 0 };\nreturn state.count;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const poisoned = await session.run({
        code: "const key = Reflect.ownKeys(globalThis).find((k) => String(k).startsWith('__caplets_observe_'));\nObject.defineProperty(globalThis, key, { configurable: true, value: () => ({ settled: true, value: 'masked' }) });\nstate.count = 1;\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return state.count;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(poisoned).toMatchObject({ ok: false });
      expect(next).toMatchObject({ ok: true, value: 0 });
    } finally {
      session.dispose();
    }
  });

  it("prevents user code from replacing the internal log bridge", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "globalThis.__caplets_log = () => undefined;\nreturn 'mutated';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "console.log('host log');\nreturn 'ok';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: false });
      expect(second).toMatchObject({
        ok: true,
        value: "ok",
        logs: [expect.objectContaining({ level: "log", message: "host log" })],
      });
    } finally {
      session.dispose();
    }
  });

  it("rejects invalid direct invoke bridge methods", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    const localInvoke = vi.fn(async () => ({ ok: true }));
    try {
      const result = await session.run({
        code: "return await __caplets_invoke_json('debug', 'callTool', []);",
        capletIds: [],
        timeoutMs: 1_000,
        invoke: localInvoke,
      });

      expect(result).toMatchObject({ ok: false });
      expect(result.ok === false ? result.error : "").toContain("Method callTool is not available");
      expect(localInvoke).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
  });

  it("rejects debug-only methods on direct non-debug caplet bridge calls", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    const localInvoke = vi.fn(async () => ({ ok: true }));
    try {
      const result = await session.run({
        code: "return await __caplets_invoke_json('alpha', 'readLogs', []);",
        capletIds: ["alpha"],
        timeoutMs: 1_000,
        invoke: localInvoke,
      });

      expect(result).toMatchObject({ ok: false });
      expect(result.ok === false ? result.error : "").toContain("Method readLogs is not available");
      expect(localInvoke).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
  });

  it("prevents user code from corrupting host result parsing", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    const localInvoke = vi.fn(async () => ({ ok: true, source: "host" }));
    try {
      const first = await session.run({
        code: "JSON.parse = () => ({ ok: true, source: 'fake' });\nreturn 'mutated';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke: localInvoke,
      });
      const second = await session.run({
        code: "return caplets.alpha.inspect();",
        capletIds: ["alpha"],
        timeoutMs: 1_000,
        invoke: localInvoke,
      });

      expect(first).toMatchObject({ ok: true, value: "mutated" });
      expect(second).toMatchObject({ ok: true, value: { ok: true, source: "host" } });
    } finally {
      session.dispose();
    }
  });

  it("rejects overlapping runs on the same session", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    const firstInvoke = vi.fn(async () => ({ run: "first" }));
    const secondInvoke = vi.fn(async () => ({ run: "second" }));
    try {
      const firstPromise = session.run({
        code: "await new Promise((resolve) => setTimeout(resolve, 20));\nreturn await caplets.alpha.inspect();",
        capletIds: ["alpha"],
        timeoutMs: 1_000,
        invoke: firstInvoke,
      });
      const second = await session.run({
        code: "return await caplets.alpha.inspect();",
        capletIds: ["alpha"],
        timeoutMs: 1_000,
        invoke: secondInvoke,
      });
      const first = await firstPromise;

      expect(second).toMatchObject({
        ok: false,
        error: "Code Mode session is already running.",
      });
      expect(first).toMatchObject({ ok: true, value: { run: "first" } });
      expect(firstInvoke).toHaveBeenCalledWith(
        expect.objectContaining({ capletId: "alpha", method: "inspect" }),
      );
      expect(secondInvoke).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
  });

  it("defers disposal until an active run settles", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const running = session.run({
        code: "await new Promise((resolve) => setTimeout(resolve, 20));\nreturn 'settled';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      session.dispose();
      const result = await running;
      const next = await session.run({
        code: "return 'after-dispose';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(result).toMatchObject({ ok: true, value: "settled" });
      expect(next).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("restores platform globals between session cells", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "fetch = async () => 'fake';\nreturn await fetch('https://example.com');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "const f = fetch;\nreturn await f('https://example.com');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: "fake" });
      expect(second).toMatchObject({ ok: false });
      expect(second.ok === false ? second.error : "").toContain("Direct fetch is not available");
    } finally {
      session.dispose();
    }
  });

  it("restores platform globals with protected intrinsics", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "Object.defineProperty = (target) => target;\nfetch = async () => 'fake';\nreturn 'poisoned';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "const f = fetch;\nreturn await f('https://example.com');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: "poisoned" });
      expect(second).toMatchObject({ ok: false });
      expect(second.ok === false ? second.error : "").toContain("Direct fetch is not available");
    } finally {
      session.dispose();
    }
  });

  it("keeps platform snapshots private between session cells", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "globalThis.__caplets_platform_snapshot = { fetch: async () => 'fake' };\nreturn 'poisoned';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "const f = fetch;\nreturn await f('https://example.com');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: "poisoned" });
      expect(second).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("keeps bare platform snapshots private between session cells", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "__caplets_platform_snapshot.fetch = async () => 'fake';\nreturn 'poisoned';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "const f = fetch;\nreturn await f('https://example.com');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: false });
      expect(second).toMatchObject({ ok: false });
      expect(second.ok === false ? second.error : "").toContain("Direct fetch is not available");
    } finally {
      session.dispose();
    }
  });

  it("restores platform prototypes between session cells", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "URL.prototype.toString = () => 'fake-url';\nreturn new URL('https://example.com').toString();",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return new URL('https://example.com').toString();",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: "fake-url" });
      expect(second).toMatchObject({ ok: true, value: "https://example.com/" });
    } finally {
      session.dispose();
    }
  });

  it("restores intrinsic prototypes between session cells", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "Array.prototype.map = function() { return ['poisoned']; };\nObject.prototype.extra = 'polluted';\nreturn [1, 2].map((x) => x * 2);",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return { mapped: [1, 2].map((x) => x * 2), extra: ({}).extra ?? null };",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: ["poisoned"] });
      expect(second).toMatchObject({ ok: true, value: { mapped: [2, 4], extra: null } });
    } finally {
      session.dispose();
    }
  });

  it("restores standard intrinsic objects between session cells", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "JSON.parse = () => ({ poisoned: true });\nMath.max = () => -1;\nreturn JSON.parse('{\"ok\":true}');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return { parsed: JSON.parse('{\"ok\":true}'), max: Math.max(1, 2) };",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: { poisoned: true } });
      expect(second).toMatchObject({ ok: true, value: { parsed: { ok: true }, max: 2 } });
    } finally {
      session.dispose();
    }
  });

  it("restores runtime globals that are not in the static platform allowlist", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "globalThis.eval = () => 123;\nAggregateError.prototype.pwned = 7;\nFloat32Array.prototype.floatLeak = 8;\nreturn { evalResult: globalThis.eval('1+1'), aggregate: new AggregateError([]).pwned, float: new Float32Array(1).floatLeak };",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return { evalResult: eval('1+1'), aggregate: new AggregateError([]).pwned ?? 'clean', float: new Float32Array(1).floatLeak ?? 'clean' };",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({
        ok: true,
        value: { evalResult: 123, aggregate: 7, float: 8 },
      });
      expect(second).toMatchObject({
        ok: true,
        value: { evalResult: 2, aggregate: "clean", float: "clean" },
      });
    } finally {
      session.dispose();
    }
  });

  it("restores primitive constructor prototypes between session cells", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "String.prototype.includes = () => true;\nNumber.prototype.toFixed = () => 'poison';\nreturn { string: 'a'.includes('z'), number: (1).toFixed() };",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return { string: 'a'.includes('z'), number: (1).toFixed() };",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: { string: true, number: "poison" } });
      expect(second).toMatchObject({ ok: true, value: { string: false, number: "1" } });
    } finally {
      session.dispose();
    }
  });

  it("restores platform prototype chains between session cells", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "Object.setPrototypeOf(Array.prototype, { inheritedPoison: 42 });\nObject.setPrototypeOf(String.prototype, { pwned() { return 'yes'; } });\nreturn { array: [1].inheritedPoison, string: 'a'.pwned() };",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return { array: [2].inheritedPoison ?? 'clean', string: typeof ''.pwned === 'function' ? ''.pwned() : 'clean' };",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: { array: 42, string: "yes" } });
      expect(second).toMatchObject({ ok: true, value: { array: "clean", string: "clean" } });
    } finally {
      session.dispose();
    }
  });

  it("restores global prototype changes between session cells", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "Object.setPrototypeOf(globalThis, { inheritedLeak: 77 });\nreturn inheritedLeak;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return globalThis.inheritedLeak ?? 'clean';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: 77 });
      expect(second).toMatchObject({ ok: true, value: "clean" });
    } finally {
      session.dispose();
    }
  });

  it("restores existing symbol global descriptor mutations between session cells", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "Object.defineProperty(globalThis, Symbol.toStringTag, { value: 'sticky', configurable: false });\nreturn Object.prototype.toString.call(globalThis);",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return Object.prototype.toString.call(globalThis);",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: "[object sticky]" });
      expect(second).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("disposes after failed cells mutate existing symbol globals", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const failed = await session.run({
        code: "Object.defineProperty(globalThis, Symbol.toStringTag, { value: 'failed-sticky', configurable: false });\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return Object.prototype.toString.call(globalThis);",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "boom" });
      expect(second).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("restores deleted existing symbol globals between session cells", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "delete globalThis[Symbol.toStringTag];\nreturn Object.prototype.toString.call(globalThis);",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return Object.prototype.toString.call(globalThis);",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: "[object Object]" });
      expect(second).toMatchObject({ ok: true, value: "[object global]" });
    } finally {
      session.dispose();
    }
  });

  it("disposes after failed cells change the global prototype", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const failed = await session.run({
        code: "Object.setPrototypeOf(globalThis, { inheritedLeak: 88 });\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return globalThis.inheritedLeak ?? 'clean';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "boom" });
      expect(second).toMatchObject({ ok: true, value: "clean" });
    } finally {
      session.dispose();
    }
  });

  it("disposes after hidden intrinsic prototypes become non-restorable", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "Object.defineProperty(Object.getPrototypeOf(async function(){}), 'pwned', { value: 7, configurable: false });\nreturn 'ok';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return (async function(){}).pwned ?? 'clean';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: "ok" });
      expect(second).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("restores hidden parent intrinsic prototypes between session cells", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())).pwned = 7;\nObject.getPrototypeOf(Int8Array.prototype).typedLeak = 42;\nreturn { iterator: Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())).pwned, typed: new Int8Array(1).typedLeak };",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return { iterator: Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())).pwned ?? 'clean', typed: new Uint8Array(1).typedLeak ?? 'clean' };",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: { iterator: 7, typed: 42 } });
      expect(second).toMatchObject({ ok: true, value: { iterator: "clean", typed: "clean" } });
    } finally {
      session.dispose();
    }
  });

  it("restores generator and regexp iterator hidden prototypes between session cells", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "Object.getPrototypeOf(Object.getPrototypeOf((function*(){})())).pwned = 7;\nObject.getPrototypeOf(Object.getPrototypeOf((async function*(){})())).asyncPwned = 8;\nObject.getPrototypeOf('a'.matchAll(/a/g)).regexPwned = 9;\nreturn { generator: Object.getPrototypeOf(Object.getPrototypeOf((function*(){})())).pwned, asyncGenerator: Object.getPrototypeOf(Object.getPrototypeOf((async function*(){})())).asyncPwned, regexp: Object.getPrototypeOf('a'.matchAll(/a/g)).regexPwned };",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return { generator: Object.getPrototypeOf(Object.getPrototypeOf((function*(){})())).pwned ?? 'clean', asyncGenerator: Object.getPrototypeOf(Object.getPrototypeOf((async function*(){})())).asyncPwned ?? 'clean', regexp: Object.getPrototypeOf('b'.matchAll(/b/g)).regexPwned ?? 'clean' };",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({
        ok: true,
        value: { generator: 7, asyncGenerator: 8, regexp: 9 },
      });
      expect(second).toMatchObject({
        ok: true,
        value: { generator: "clean", asyncGenerator: "clean", regexp: "clean" },
      });
    } finally {
      session.dispose();
    }
  });

  it("restores hidden intrinsic constructor objects between session cells", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "Object.getPrototypeOf(Int8Array).pwned = 7;\nObject.getPrototypeOf(async function(){}).constructor.asyncPwned = 8;\nObject.getPrototypeOf(function*(){}).constructor.generatorPwned = 9;\nObject.getPrototypeOf(async function*(){}).constructor.asyncGeneratorPwned = 10;\nreturn { typed: Object.getPrototypeOf(Uint8Array).pwned, async: Object.getPrototypeOf(async function(){}).constructor.asyncPwned, generator: Object.getPrototypeOf(function*(){}).constructor.generatorPwned, asyncGenerator: Object.getPrototypeOf(async function*(){}).constructor.asyncGeneratorPwned };",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return { typed: Object.getPrototypeOf(Float32Array).pwned ?? 'clean', async: Object.getPrototypeOf(async function(){}).constructor.asyncPwned ?? 'clean', generator: Object.getPrototypeOf(function*(){}).constructor.generatorPwned ?? 'clean', asyncGenerator: Object.getPrototypeOf(async function*(){}).constructor.asyncGeneratorPwned ?? 'clean' };",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({
        ok: true,
        value: { typed: 7, async: 8, generator: 9, asyncGenerator: 10 },
      });
      expect(second).toMatchObject({
        ok: true,
        value: { typed: "clean", async: "clean", generator: "clean", asyncGenerator: "clean" },
      });
    } finally {
      session.dispose();
    }
  });

  it("disposes with a clear error when frozen prototypes block platform restore", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "Array.prototype.map = function() { return ['poisoned']; };\nObject.freeze(Array.prototype);\nreturn [1].map((x) => x);",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return [1, 2].map((x) => x * 2);",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const third = await session.run({
        code: "return 'after-corruption';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: ["poisoned"] });
      expect(second).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
      expect(third).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("disposes with a clear error when non-extensible prototypes block platform restore", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "Object.preventExtensions(Array.prototype);\nreturn Object.isExtensible(Array.prototype);",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return [1, 2].map((x) => x * 2);",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: false });
      expect(second).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("disposes after successful cells make platform prototypes non-restorable", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "Object.preventExtensions(Array.prototype);\nreturn 'ok';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return [1].length;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: "ok" });
      expect(next).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("disposes after failed cells add non-configurable platform prototype properties", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const failed = await session.run({
        code: "Object.defineProperty(Array.prototype, 'stickyLeak', { configurable: false, value: 7 });\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return [2].stickyLeak ?? 'clean';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "boom" });
      expect(next).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("prevents direct invoke bridge calls after the caplet is unavailable", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    const localInvoke = vi.fn(async ({ capletId }) => ({ ok: true, capletId }));
    try {
      const first = await session.run({
        code: "var raw = (id) => __caplets_invoke_json(id, 'inspect', []);\nreturn await raw('alpha');",
        capletIds: ["alpha"],
        timeoutMs: 1_000,
        invoke: localInvoke,
      });
      const reused = await session.run({
        code: "return await raw('alpha');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke: localInvoke,
      });

      expect(first).toMatchObject({ ok: true, value: { ok: true, capletId: "alpha" } });
      expect(reused).toMatchObject({ ok: false });
      expect(reused.ok === false ? reused.error : "").toContain(
        "Caplet alpha is not available in this Code Mode session cell.",
      );
      expect(localInvoke).toHaveBeenCalledTimes(1);
    } finally {
      session.dispose();
    }
  });

  it("disposes after successful cells make globalThis non-extensible", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "queueMicrotask(() => Object.preventExtensions(globalThis));\nawait Promise.resolve();\nreturn 'locked';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return 2 + 2;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: "locked" });
      expect(second).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("restores timer platform globals between session cells", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "setTimeout = () => 123;\nreturn setTimeout();",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return await new Promise((resolve) => setTimeout(() => resolve('timer'), 0));",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: 123 });
      expect(second).toMatchObject({ ok: true, value: "timer" });
    } finally {
      session.dispose();
    }
  });

  it("clears unawaited timers from successful cells before later runs", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    const localInvoke = vi.fn(async () => ({ ok: true }));
    try {
      const first = await session.run({
        code: "setTimeout(() => {}, 500);\nreturn 'first';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke: localInvoke,
      });
      const second = await session.run({
        code: "return await caplets.alpha.inspect();",
        capletIds: ["alpha"],
        timeoutMs: 100,
        invoke: localInvoke,
      });

      expect(first).toMatchObject({ ok: true, value: "first" });
      expect(second).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("restores mutable platform object globals between session cells", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "crypto.randomUUID = () => 'fake';\nreturn crypto.randomUUID();",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return crypto.randomUUID();",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: "fake" });
      expect(second).toMatchObject({
        ok: true,
        value: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      });
    } finally {
      session.dispose();
    }
  });

  it("prevents persisted caplet handles from invoking after the caplet is unavailable", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    const localInvoke = vi.fn(async () => ({ ok: true }));
    try {
      const first = await session.run({
        code: "var saved = caplets.alpha;\nreturn saved.id;",
        capletIds: ["alpha"],
        timeoutMs: 1_000,
        invoke: localInvoke,
      });
      const hidden = await session.run({
        code: "return typeof caplets.alpha;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke: localInvoke,
      });
      const reused = await session.run({
        code: "return await saved.inspect();",
        capletIds: [],
        timeoutMs: 1_000,
        invoke: localInvoke,
      });

      expect(first).toMatchObject({ ok: true, value: "alpha" });
      expect(hidden).toMatchObject({ ok: true, value: "undefined" });
      expect(reused).toMatchObject({ ok: false });
      expect(reused.ok === false ? reused.error : "").toContain(
        "Caplet alpha is not available in this Code Mode session cell.",
      );
      expect(localInvoke).not.toHaveBeenCalled();
    } finally {
      session.dispose();
    }
  });

  it("keeps var declarations introduced before an ordinary runtime error", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const failed = await session.run({
        code: "var leaked = 7;\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return typeof leaked;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "boom" });
      expect(next).toMatchObject({ ok: true, value: "number" });
    } finally {
      session.dispose();
    }
  });

  it("disposes after failed cells add globals", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const failed = await session.run({
        code: "globalThis.leaked = 7;\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return leaked;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "boom" });
      expect(next).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("disposes after failed cells forge the global checkpoint", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const failed = await session.run({
        code: "globalThis.leaked = 7;\nglobalThis.__caplets_global_checkpoint = new Set(['leaked']);\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return globalThis.leaked ?? 'clean';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false });
      expect(next).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("disposes after failed cells poison global key enumeration", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const failed = await session.run({
        code: "Reflect.ownKeys = () => [];\nglobalThis.leaked = 7;\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return globalThis.leaked ?? 'clean';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "boom" });
      expect(next).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("disposes after failed cells poison key filtering", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const failed = await session.run({
        code: "Array.prototype.filter = () => [];\nglobalThis.leaked = 7;\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return globalThis.leaked ?? 'clean';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "boom" });
      expect(next).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("disposes after failed cells add caplets-prefixed globals", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const failed = await session.run({
        code: "globalThis.__caplets_user_leak = 7;\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return globalThis.__caplets_user_leak ?? 'clean';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "boom" });
      expect(next).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("disposes after failed cells add symbol globals", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const failed = await session.run({
        code: "globalThis[Symbol.for('leak')] = 7;\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return globalThis[Symbol.for('leak')] ?? 'clean';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "boom" });
      expect(next).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("disposes after failed cells add symbol globals that stringify like existing symbols", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const failed = await session.run({
        code: "globalThis[Symbol.for('Symbol.toStringTag')] = 'leaked';\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return globalThis[Symbol.for('Symbol.toStringTag')] ?? 'clean';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "boom" });
      expect(next).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("keeps persisted bindings after clean runtime errors", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var counter = 1;\nreturn counter;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const failed = await session.run({
        code: "throw new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const recovered = await session.run({
        code: "return counter;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "boom" });
      expect(recovered).toMatchObject({ ok: true, value: 1 });
    } finally {
      session.dispose();
    }
  });

  it("does not restore from forged persistent checkpoints", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var x = 1;\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const failed = await session.run({
        code: "globalThis.__caplets_persist_checkpoint = { x: 99 };\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false });
      expect(next).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("does not expose a usable persistent checkpoint helper to user code", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var x = 1;\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const failed = await session.run({
        code: "__caplets_snapshot_persist('user-token', ['x']);",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false });
      expect(failed.ok === false ? failed.error : "").toContain(
        "Code Mode persistence checkpoint token is invalid",
      );
      expect(next).toMatchObject({ ok: true, value: 1 });
    } finally {
      session.dispose();
    }
  });

  it("does not expose persistent checkpoint internals to user code", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var x = 1;\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const failed = await session.run({
        code: "__caplets_persist_checkpoint_state.current = Object.fromEntries([['x', 99]]);\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const token = await session.run({
        code: "return typeof __caplets_persist_checkpoint_token;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false });
      expect(failed.ok === false ? failed.error : "").toContain(
        "__caplets_persist_checkpoint_state",
      );
      expect(token).toMatchObject({ ok: true, value: "undefined" });
      expect(next).toMatchObject({ ok: true, value: 1 });
    } finally {
      session.dispose();
    }
  });

  it("keeps persisted bindings that shadow platform globals", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "var JSON = 1;\nreturn JSON;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return JSON;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: 1 });
      expect(second).toMatchObject({ ok: true, value: 1 });
    } finally {
      session.dispose();
    }
  });

  it("keeps persisted bindings that shadow dynamically snapshotted platform globals", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "var Float32Array = 'shadow';\nvar AggregateError = 'aggregate-shadow';\nreturn { float: Float32Array, aggregate: AggregateError };",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return { float: Float32Array, aggregate: AggregateError };",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({
        ok: true,
        value: { float: "shadow", aggregate: "aggregate-shadow" },
      });
      expect(second).toMatchObject({
        ok: true,
        value: { float: "shadow", aggregate: "aggregate-shadow" },
      });
    } finally {
      session.dispose();
    }
  });

  it("keeps persisted bindings named like internal return temps", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const first = await session.run({
        code: "var __caplets_return = 'persisted';\nreturn 'actual';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const second = await session.run({
        code: "return __caplets_return;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(first).toMatchObject({ ok: true, value: "actual" });
      expect(second).toMatchObject({ ok: true, value: "persisted" });
    } finally {
      session.dispose();
    }
  });

  it("does not overwrite persisted bindings from catch parameter shadows", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var err = 'persisted';\nreturn err;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const caught = await session.run({
        code: "try { throw 'shadow'; } catch (err) { return err; }",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return err;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(caught).toMatchObject({ ok: true, value: "shadow" });
      expect(next).toMatchObject({ ok: true, value: "persisted" });
    } finally {
      session.dispose();
    }
  });

  it("does not overwrite persisted bindings from finally lexical shadows", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var x = 1;\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const returned = await session.run({
        code: "try { return x; } finally { let x = 2; }",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(returned).toMatchObject({ ok: true, value: 1 });
      expect(next).toMatchObject({ ok: true, value: 1 });
    } finally {
      session.dispose();
    }
  });

  it("disposes after failed cells make globalThis non-extensible", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const failed = await session.run({
        code: "Object.preventExtensions(globalThis);\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return 2 + 2;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false });
      expect(next).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("drains successful cells that persist pending host promises before later runs", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    const localInvoke = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { ok: true };
    });
    try {
      const first = await session.run({
        code: "var p = caplets.alpha.inspect();\nreturn 'stored';",
        capletIds: ["alpha"],
        timeoutMs: 1_000,
        invoke: localInvoke,
      });
      const second = await session.run({
        code: "return await p;",
        capletIds: ["alpha"],
        timeoutMs: 1_000,
        invoke: localInvoke,
      });

      expect(first).toMatchObject({ ok: true, value: "stored" });
      expect(second).toMatchObject({ ok: true, value: { ok: true } });
    } finally {
      session.dispose();
    }
  });

  it("keeps new var bindings introduced before an ordinary runtime error", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const failed = await session.run({
        code: "var leaked = 7;\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "leaked = 3;\nreturn leaked;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "boom" });
      expect(next).toMatchObject({ ok: true, value: 3 });
    } finally {
      session.dispose();
    }
  });

  it("keeps assignments completed before an ordinary runtime error", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var x = 1;\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const failed = await session.run({
        code: "try { x = 2; throw new Error('boom'); } finally {}",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false });
      expect(next).toMatchObject({ ok: true, value: 2 });
    } finally {
      session.dispose();
    }
  });

  it("rejects persisted global descriptor changes without corrupting state", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var x = 1;\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const failed = await session.run({
        code: "Object.defineProperty(globalThis, 'x', { writable: false });\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "x = 2;\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "property is not configurable" });
      expect(next).toMatchObject({ ok: true, value: 2 });
    } finally {
      session.dispose();
    }
  });

  it("keeps object mutations completed before an ordinary runtime error", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var state = { count: 0 };\nreturn state.count;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const failed = await session.run({
        code: "state.count = 1;\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return state.count;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "boom" });
      expect(next).toMatchObject({ ok: true, value: 1 });
    } finally {
      session.dispose();
    }
  });

  it("keeps method mutations completed before an ordinary runtime error", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var state = { items: [] };\nreturn state.items.length;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const failed = await session.run({
        code: "state.items.push(1);\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return state.items.length;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "boom" });
      expect(next).toMatchObject({ ok: true, value: 1 });
    } finally {
      session.dispose();
    }
  });

  it("keeps nested callback mutations completed before an ordinary runtime error", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var state = { count: 0 };\nreturn state.count;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const failed = await session.run({
        code: "(() => { state.count = 1; })();\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return state.count;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "boom" });
      expect(next).toMatchObject({ ok: true, value: 1 });
    } finally {
      session.dispose();
    }
  });

  it("keeps computed global mutations completed before an ordinary runtime error", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var state = { count: 0 };\nreturn state.count;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const failed = await session.run({
        code: "globalThis['st' + 'ate'].count = 1;\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return state.count;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "boom" });
      expect(next).toMatchObject({ ok: true, value: 1 });
    } finally {
      session.dispose();
    }
  });

  it("keeps eval mutations completed before an ordinary runtime error", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var state = { count: 0 };\nreturn state.count;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const failed = await session.run({
        code: "eval('state.count = 1');\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return state.count;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "boom" });
      expect(next).toMatchObject({ ok: true, value: 1 });
    } finally {
      session.dispose();
    }
  });

  it("keeps indirect Function mutations completed before an ordinary runtime error", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var state = { count: 0 };\nreturn state.count;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const failed = await session.run({
        code: "({}).constructor.constructor('state.count = 1')();\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return state.count;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "boom" });
      expect(next).toMatchObject({ ok: true, value: 1 });
    } finally {
      session.dispose();
    }
  });

  it("disposes after failed cells mutate persistence map descriptors", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var x = 1;\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const failed = await session.run({
        code: "Object.defineProperty(__caplets_persist, 'x', { configurable: true, get() { return 99; }, set(v) {} });\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "boom" });
      expect(next).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("does not leak failed state through the internal return temp name", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const failed = await session.run({
        code: "globalThis.__caplets_return = { leaked: 7 };\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return globalThis.__caplets_return?.leaked ?? 'clean';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "boom" });
      expect(next).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("disposes after failed cells write directly to the persistence map", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const failed = await session.run({
        code: "__caplets_persist.leak = 7;\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return __caplets_persist.leak ?? 'clean';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "boom" });
      expect(next).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("rejects persistence descriptor poisoning and disposes the session", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var x = 1;\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const poisoned = await session.run({
        code: "Object.defineProperty(__caplets_persist, 'x', { configurable: true, get() { return 99; }, set(v) {} });\nObject.getOwnPropertyDescriptor = () => ({ value: 1, writable: true, configurable: true });\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(poisoned).toMatchObject({ ok: false });
      expect(next).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("blocks lexical redeclarations before direct persistence writes execute", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var x = 'persisted';\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const shadowed = await session.run({
        code: "let x = 'shadow';\n__caplets_persist.x = 'poisoned';\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(shadowed).toMatchObject({
        ok: false,
        error: expect.stringContaining("already been declared"),
      });
      expect(next).toMatchObject({ ok: true, value: "persisted" });
    } finally {
      session.dispose();
    }
  });

  it("disposes after nested lexical shadows write directly to persisted state", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var x = 'persisted';\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const shadowed = await session.run({
        code: "if (true) { let x = 'shadow'; __caplets_persist.x = 'poisoned'; return x; }\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(shadowed).toMatchObject({ ok: true, value: "shadow" });
      expect(next).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("disposes after microtasks write directly to persisted state", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var x = 'persisted';\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const queued = await session.run({
        code: "queueMicrotask(() => { __caplets_persist.x = 'poisoned'; });\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(queued).toMatchObject({ ok: true, value: "persisted" });
      expect(next).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("keeps primitive state changed by drained microtasks", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var x = 1;\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const queued = await session.run({
        code: "queueMicrotask(() => { x = 2; });\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(queued).toMatchObject({ ok: true, value: 1 });
      expect(next).toMatchObject({ ok: true, value: 2 });
    } finally {
      session.dispose();
    }
  });

  it("does not restore persisted names inside switch blocks shadowed by later clauses", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var x = 'persisted';\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const result = await session.run({
        code: 'const kind = "a";\nswitch (kind) { case "a": return 1; case "b": let x = 2; return x; }\nreturn 0;',
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(result).toMatchObject({ ok: true, value: 1 });
    } finally {
      session.dispose();
    }
  });

  it("preserves comma-expression return values while snapshotting persisted state", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var x = 0;\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const result = await session.run({
        code: "return x = 1, x + 1;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const followup = await session.run({
        code: "return x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(result).toMatchObject({ ok: true, value: 2 });
      expect(followup).toMatchObject({ ok: true, value: 1 });
    } finally {
      session.dispose();
    }
  });

  it("waits for unawaited Caplet calls before returning session results", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    const calls: string[] = [];
    try {
      const result = await session.run({
        code: 'void caplets.github.check();\nreturn "done";',
        capletIds: ["github"],
        timeoutMs: 1_000,
        invoke: async (input) => {
          await Promise.resolve();
          calls.push(`${input.capletId}.${input.method}`);
          return { ok: true };
        },
      });

      expect(result).toMatchObject({ ok: true, value: "done" });
      expect(calls).toEqual(["github.check"]);
    } finally {
      session.dispose();
    }
  });

  it("keeps mutations from drained unawaited Caplet callbacks", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const result = await session.run({
        code: "var x = 1;\nvoid caplets.github.check().then(() => { x = 2; });\nreturn x;",
        capletIds: ["github"],
        timeoutMs: 1_000,
        invoke: async () => {
          await Promise.resolve();
          return { ok: true };
        },
      });
      const followup = await session.run({
        code: "return x;",
        capletIds: ["github"],
        timeoutMs: 1_000,
        invoke,
      });

      expect(result).toMatchObject({ ok: true, value: 1 });
      expect(followup).toMatchObject({ ok: true, value: 2 });
    } finally {
      session.dispose();
    }
  });

  it("keeps sessions reusable when drained callbacks only mutate local shadows", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const result = await session.run({
        code: "var x = 1;\nvoid caplets.github.check().then(() => { let x = 2; x += 1; });\nreturn x;",
        capletIds: ["github"],
        timeoutMs: 1_000,
        invoke: async () => {
          await Promise.resolve();
          return { ok: true };
        },
      });
      const followup = await session.run({
        code: "return x;",
        capletIds: ["github"],
        timeoutMs: 1_000,
        invoke,
      });

      expect(result).toMatchObject({ ok: true, value: 1 });
      expect(followup).toMatchObject({ ok: true, value: 1 });
    } finally {
      session.dispose();
    }
  });

  it("keeps mutations from named callbacks after drained invokes", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const result = await session.run({
        code: [
          "var x = 1;",
          "const update = () => { x = 2; };",
          "void caplets.github.check().then(update);",
          "return x;",
        ].join("\n"),
        capletIds: ["github"],
        timeoutMs: 1_000,
        invoke: async () => {
          await Promise.resolve();
          return { ok: true };
        },
      });
      const followup = await session.run({
        code: "return x;",
        capletIds: ["github"],
        timeoutMs: 1_000,
        invoke,
      });

      expect(result).toMatchObject({ ok: true, value: 1 });
      expect(followup).toMatchObject({ ok: true, value: 2 });
    } finally {
      session.dispose();
    }
  });

  it("disposes after nested lexical shadows write to persisted state through computed access", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var x = 'persisted';\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const shadowed = await session.run({
        code: "if (true) { let x = 'shadow'; globalThis['__caplets_' + 'persist'].x = 'poisoned'; return x; }\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(shadowed).toMatchObject({ ok: true, value: "shadow" });
      expect(next).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("disposes after microtasks write to persisted state through computed access", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var x = 'persisted';\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const queued = await session.run({
        code: "queueMicrotask(() => { globalThis['__caplets_' + 'persist'].x = 'poisoned'; });\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(queued).toMatchObject({ ok: true, value: "persisted" });
      expect(next).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("disposes after persistence map prototype poisoning through computed access", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const poisoned = await session.run({
        code: "Object.setPrototypeOf(globalThis['__caplets_' + 'persist'], { y: 'poisoned' });\nreturn 'ok';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "var y;\nreturn y;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(poisoned).toMatchObject({ ok: true, value: "ok" });
      expect(next).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("disposes after rejected persistence map descriptor changes", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var x = 1;\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const poisoned = await session.run({
        code: "Object.defineProperty(__caplets_persist, 'x', { configurable: true, get() { return 99; }, set(v) {} });\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "x = 2;\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(poisoned).toMatchObject({ ok: false });
      expect(next).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("disposes after failed cells try to replace the persistence map", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var x = 1;\nreturn x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const failed = await session.run({
        code: "globalThis.__caplets_persist = Object.freeze(Object.create(null));\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return x;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false });
      expect(next).toMatchObject({ ok: true, value: 1 });
    } finally {
      session.dispose();
    }
  });

  it("keeps aliased object mutations completed before an ordinary runtime error", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "var state = { count: 0 };\nreturn state.count;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const failed = await session.run({
        code: "const alias = state;\nalias.count = 1;\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const next = await session.run({
        code: "return state.count;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "boom" });
      expect(next).toMatchObject({ ok: true, value: 1 });
    } finally {
      session.dispose();
    }
  });

  it("returns immediate runtime errors before pending timers time out", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const failed = await session.run({
        code: "setTimeout(() => {}, 10_000);\nthrow new Error('boom');",
        capletIds: [],
        timeoutMs: 100,
        invoke,
      });
      const next = await session.run({
        code: "return 'after pending failure';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(failed).toMatchObject({ ok: false, error: "boom" });
      expect(next).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("does not snapshot block-local function shadows over persisted helpers", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      await session.run({
        code: "function f() { return 1; }\nreturn f();",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const shadowed = await session.run({
        code: "if (true) { function f() { return 2; } return f(); }\nreturn 0;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });
      const persisted = await session.run({
        code: "return f();",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(shadowed).toMatchObject({ ok: true, value: 2 });
      expect(persisted).toMatchObject({ ok: true, value: 1 });
    } finally {
      session.dispose();
    }
  });

  it("isolates helper and var bindings between sessions", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const firstSession = await sandbox.createSession();
    const secondSession = await sandbox.createSession();
    try {
      await firstSession.run({
        code: "function hidden() { return 42; }\nvar secret = 7;\nreturn hidden() + secret;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      const result = await secondSession.run({
        code: "return typeof hidden + ':' + typeof secret;",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(result).toMatchObject({ ok: true, value: "undefined:undefined" });
    } finally {
      firstSession.dispose();
      secondSession.dispose();
    }
  });

  it("cleans up timed-out sessions when disposed", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    const result = await session.run({
      code: "await new Promise((resolve) => setTimeout(resolve, 10_000));",
      capletIds: [],
      timeoutMs: 100,
      invoke,
    });

    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false ? result.error : "").toContain("timed out");
    session.dispose();

    const fresh = await sandbox.createSession();
    try {
      await expect(
        fresh.run({ code: "return 'fresh';", capletIds: [], timeoutMs: 1_000, invoke }),
      ).resolves.toMatchObject({ ok: true, value: "fresh" });
    } finally {
      fresh.dispose();
    }
  });

  it("makes a timed-out session unusable before stale async work can leak", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    try {
      const timedOut = await session.run({
        code: "setTimeout(() => { globalThis.leaked = 'stale'; }, 0);\nwhile (true) {}",
        capletIds: [],
        timeoutMs: 100,
        invoke,
      });
      const reused = await session.run({
        code: "return globalThis.leaked ?? 'clean';",
        capletIds: [],
        timeoutMs: 1_000,
        invoke,
      });

      expect(timedOut).toMatchObject({ ok: false });
      expect(timedOut.ok === false ? timedOut.error : "").toContain("timed out");
      expect(reused).toMatchObject({ ok: false, error: "Code Mode session is disposed." });
    } finally {
      session.dispose();
    }
  });

  it("keeps platform APIs equivalent in one-shot and session runs", async () => {
    const sandbox = new QuickJsCodeModeSandbox();
    const session = await sandbox.createSession();
    const code = `
      const id = crypto.randomUUID();
      let timer = await new Promise((resolve) => setTimeout(() => resolve("timer"), 0));
      let fetchError = "";
      try {
        await fetch("https://example.com");
      } catch (error) {
        fetchError = error instanceof Error ? error.message : String(error);
      }
      return { id, timer, fetchError };
    `;
    try {
      const oneShot = await sandbox.run({ code, capletIds: [], timeoutMs: 1_000, invoke });
      const reused = await session.run({ code, capletIds: [], timeoutMs: 1_000, invoke });

      expect(oneShot).toMatchObject({
        ok: true,
        value: {
          id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
          timer: "timer",
          fetchError: expect.stringContaining("Direct fetch is not available"),
        },
      });
      expect(reused).toMatchObject({
        ok: true,
        value: {
          id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
          timer: "timer",
          fetchError: expect.stringContaining("Direct fetch is not available"),
        },
      });
    } finally {
      session.dispose();
    }
  });
});

describe("CodeModeDiagnosticsSession", () => {
  it("allows later cells to reference helpers from prior successful cells", () => {
    const session = new CodeModeDiagnosticsSession();
    const declaration = "declare const caplets: {};";

    const first = diagnoseCodeModeTypeScript({
      declaration,
      code: "function double(value: number) { return value * 2; }\nreturn double(3);",
      session,
    });
    session.recordCell("function double(value: number) { return value * 2; }\nreturn double(3);");
    const second = diagnoseCodeModeTypeScript({
      declaration,
      code: "return double(5);",
      session,
    });

    expect(first.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(second.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  });

  it("allows later cells to reference generic helpers from prior successful cells", () => {
    const session = new CodeModeDiagnosticsSession();
    const declaration = "declare const caplets: {};";

    session.recordCell("function id<T>(x: T): T { return x; }\nreturn id(1);");
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: 'return id("ok");',
      session,
    });

    expect(diagnostics).toEqual([]);
  });

  it("allows later cells to reference helpers with default parameters", () => {
    const session = new CodeModeDiagnosticsSession();
    const declaration = "declare const caplets: {};";

    session.recordCell("function f(x = 1): number { return x; }\nreturn f();");
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: "return f();",
      session,
    });

    expect(diagnostics).toEqual([]);
  });

  it("preserves inferred primitive var types for later session diagnostics", () => {
    const session = new CodeModeDiagnosticsSession();
    const declaration = "declare const caplets: {};";

    session.recordCell("var workflowRuns = 1;\nreturn workflowRuns;");
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: "workflowRuns += 1;\nreturn workflowRuns;",
      session,
    });

    expect(diagnostics).toEqual([]);
  });

  it("preserves explicit var annotations for later session diagnostics", () => {
    const session = new CodeModeDiagnosticsSession();
    const declaration = "declare const caplets: {};";

    session.recordCell('var items: string[] = [];\nitems.push("a");\nreturn items;');
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: 'items.push("b");\nreturn items.join(",");',
      session,
    });

    expect(diagnostics).toEqual([]);
  });

  it("preserves inferred object and array var types for later session diagnostics", () => {
    const session = new CodeModeDiagnosticsSession();
    const declaration = "declare const caplets: {};";

    session.recordCell('var summary = { count: 1, label: "one" };\nvar numbers = [1, 2, 3];');
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: "summary.count += numbers[0] ?? 0;\nreturn `${summary.label}:${summary.count}`;",
      session,
    });

    expect(diagnostics).toEqual([]);
  });

  it("preserves checker-inferred destructured var binding types when available", () => {
    const session = new CodeModeDiagnosticsSession();
    const declaration = "declare const caplets: {};";

    session.recordCell('var { count, label } = { count: 1, label: "ready" };\nreturn label;');
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: "count += 1;\nreturn label.toUpperCase();",
      session,
    });

    expect(diagnostics).toEqual([]);
  });

  it("updates var ambient types when successful cells redeclare a binding", () => {
    const session = new CodeModeDiagnosticsSession();
    const declaration = "declare const caplets: {};";

    session.recordCell("var mutable = 1;\nreturn mutable;");
    session.recordCell('var mutable = "ready";\nreturn mutable;');
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: "const numeric: number = mutable;\nreturn numeric;",
      session,
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "2322",
          message: expect.stringContaining("not assignable to type 'number'"),
        }),
      ]),
    );
  });

  it("keeps the previous var ambient type for uninitialized redeclarations", () => {
    const session = new CodeModeDiagnosticsSession();
    const declaration = "declare const caplets: {};";

    session.recordCell("var counter = 1;\nreturn counter;");
    session.recordCell("var counter;\nreturn counter;");
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: "counter += 1;\nreturn counter;",
      session,
    });

    expect(diagnostics).toEqual([]);
  });

  it("keeps the previous var ambient type for annotated uninitialized redeclarations", () => {
    const session = new CodeModeDiagnosticsSession();
    const declaration = "declare const caplets: {};";

    session.recordCell("var counter = 1;\nreturn counter;");
    session.recordCell('var counter: string;\nreturn "ok";');
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: "counter += 1;\nreturn counter;",
      session,
    });

    expect(diagnostics).toEqual([]);
  });

  it("updates var ambient types for annotated redeclarations with same-cell writes", () => {
    const session = new CodeModeDiagnosticsSession();
    const declaration = "declare const caplets: {};";

    session.recordCell("var counter = 1;\nreturn counter;");
    session.recordCell('var counter: string;\ncounter = "ready";\nreturn counter;');
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: "return counter.toUpperCase();",
      session,
    });

    expect(diagnostics).toEqual([]);
  });

  it("allows later cells to reference destructured var bindings", () => {
    const session = new CodeModeDiagnosticsSession();
    const declaration = "declare const caplets: {};";

    session.recordCell("var { value } = await Promise.resolve({ value: 3 });");
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: "return value;",
      session,
    });

    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  });

  it("allows later cells to reference var bindings from top-level control flow", () => {
    const session = new CodeModeDiagnosticsSession();
    const declaration = "declare const caplets: {};";

    session.recordCell("if (true) { var inner = 7; }");
    session.recordCell("for (var i = 0; i < 3; i += 1) {}");
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: "return inner + i;",
      session,
    });

    expect(diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  });

  it("falls back to unknown for unresolved or excessively complex var types", () => {
    const session = new CodeModeDiagnosticsSession();
    const declaration = "declare const caplets: {};";

    session.recordCell("var unresolved = JSON.parse('{\"value\":1}');\nreturn unresolved;");
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: "return unresolved.value;",
      session,
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "18046",
          message: expect.stringContaining("'unresolved' is of type 'unknown'"),
        }),
      ]),
    );
  });

  it("falls back to unknown for var types that reference cell-local classes", () => {
    const session = new CodeModeDiagnosticsSession();
    const declaration = "declare const caplets: {};";

    session.recordCell("class Local { value = 1; }\nvar saved = new Local();");
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: "return saved.value;",
      session,
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "18046",
          message: expect.stringContaining("'saved' is of type 'unknown'"),
        }),
      ]),
    );
  });

  it("falls back to unknown for excessively large var types", () => {
    const session = new CodeModeDiagnosticsSession();
    const declaration = "declare const caplets: {};";

    session.recordCell(
      `var large = { ${Array.from({ length: 60 }, (_, index) => `p${index}: ${index}`).join(", ")} };`,
    );
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: "return large.p1;",
      session,
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "18046",
          message: expect.stringContaining("'large' is of type 'unknown'"),
        }),
      ]),
    );
  });

  it("preserves top-level let and const types for later diagnostics", () => {
    const session = new CodeModeDiagnosticsSession();
    const declaration =
      'declare const caplets: { gmail: { readonly id: "gmail"; searchTools(query: string): Promise<string[]> } };';

    session.recordCell("const gmail = caplets.gmail;\nlet count = 1;", declaration);
    const valid = diagnoseCodeModeTypeScript({
      declaration,
      code: 'count += 1;\nreturn gmail.searchTools("inbox");',
      session,
    });
    const invalid = diagnoseCodeModeTypeScript({
      declaration,
      code: 'count = "wrong";\nreturn count;',
      session,
    });
    const redeclared = diagnoseCodeModeTypeScript({
      declaration,
      code: "const gmail = caplets.gmail;",
      session,
    });

    expect(valid).toEqual([]);
    expect(invalid).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "2322",
          message: expect.stringContaining("not assignable to type 'number'"),
        }),
      ]),
    );
    expect(redeclared).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "2451",
          message: expect.stringContaining("Cannot redeclare"),
        }),
      ]),
    );
  });

  it("preserves runtime and type-only TypeScript declarations", () => {
    const session = new CodeModeDiagnosticsSession();
    const declaration = "declare const caplets: {};";

    session.recordCell(
      'type Item = { id: string };\ninterface Named { name: string }\nclass Box { constructor(readonly item: Item) {} }\nenum Mode { Ready }\nnamespace Helpers { export const value = 1; }\nreturn "ready";',
    );
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: 'const item: Item = { id: "x" };\nconst named: Named = { name: "n" };\nconst box = new Box(item);\nconst mode: Mode = Mode.Ready;\nreturn Helpers.value + box.item.id.length + named.name.length + mode;',
      session,
    });

    expect(diagnostics).toEqual([]);
  });

  it("blocks duplicate type aliases while allowing interface merging", () => {
    const session = new CodeModeDiagnosticsSession();
    const declaration = "declare const caplets: {};";

    session.recordCell("type Item = { id: string };\ninterface Named { name: string }");
    const duplicateType = diagnoseCodeModeTypeScript({
      declaration,
      code: "type Item = { value: number };",
      session,
    });
    const sameCellDuplicate = diagnoseCodeModeTypeScript({
      declaration,
      code: "type Other = string;\ntype Other = number;",
      session,
    });
    const mergedInterface = diagnoseCodeModeTypeScript({
      declaration,
      code: 'interface Named { id: string }\nreturn "ok";',
      session,
    });
    session.recordCell("interface Named { id: string }");
    const mergedUsage = diagnoseCodeModeTypeScript({
      declaration,
      code: 'const named: Named = { id: "1", name: "one" };\nreturn named;',
      session,
    });

    expect(duplicateType).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "2300",
          severity: "error",
          message: expect.stringContaining("Duplicate identifier 'Item'"),
        }),
      ]),
    );
    expect(sameCellDuplicate).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "2300",
          severity: "error",
          message: expect.stringContaining("Duplicate identifier 'Other'"),
        }),
      ]),
    );
    expect(mergedInterface).toEqual([]);
    expect(mergedUsage).toEqual([]);
  });

  it("does not carry control-flow narrowing across cell boundaries", () => {
    const session = new CodeModeDiagnosticsSession();
    const declaration = "declare const caplets: {};";

    session.recordCell("let value: string | undefined;");
    session.recordCell('value = "ready";');
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: "return value.toUpperCase();",
      session,
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "18048",
          message: expect.stringContaining("possibly 'undefined'"),
        }),
      ]),
    );
  });

  it("uses the latest helper declaration for later diagnostics", () => {
    const session = new CodeModeDiagnosticsSession();
    const declaration = "declare const caplets: {};";

    session.recordCell("function f(x: number): number { return x; }");
    session.recordCell("function f(x: string): string { return x; }");
    const diagnostics = diagnoseCodeModeTypeScript({
      declaration,
      code: "const value: number = f('ok');\nreturn value;",
      session,
    });

    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "2322",
          message: expect.stringContaining("not assignable to type 'number'"),
        }),
      ]),
    );
  });
});
