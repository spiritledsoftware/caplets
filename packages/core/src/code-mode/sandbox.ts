import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten";
import ts from "typescript";
import { installCodeModePlatformHost } from "./platform-host";
import { CODE_MODE_PLATFORM_RUNTIME_SOURCE } from "./platform-runtime.generated";
import type { CodeModeLogEntry } from "./types";

export type CodeModeSandboxInvokeInput = {
  capletId: string;
  method:
    | "inspect"
    | "check"
    | "tools"
    | "searchTools"
    | "describeTool"
    | "callTool"
    | "resources"
    | "searchResources"
    | "resourceTemplates"
    | "readResource"
    | "prompts"
    | "searchPrompts"
    | "getPrompt"
    | "complete"
    | "readLogs";
  args: unknown[];
};

export type CodeModeSandboxInput = {
  code: string;
  capletIds: string[];
  timeoutMs: number;
  invoke: (input: CodeModeSandboxInvokeInput) => Promise<unknown>;
};

export type CodeModeSandboxResult =
  | { ok: true; value: unknown; logs: CodeModeLogEntry[] }
  | { ok: false; error: string; logs: CodeModeLogEntry[]; stack?: string };

export interface CodeModeSandbox {
  run(input: CodeModeSandboxInput): Promise<CodeModeSandboxResult>;
}

export class QuickJsCodeModeSandbox implements CodeModeSandbox {
  async run(input: CodeModeSandboxInput): Promise<CodeModeSandboxResult> {
    return await evaluateInQuickJs(input);
  }
}

async function evaluateInQuickJs(input: CodeModeSandboxInput): Promise<CodeModeSandboxResult> {
  const timeoutMs = Math.max(100, input.timeoutMs);
  const deadlineMs = Date.now() + timeoutMs;
  const logs: CodeModeLogEntry[] = [];
  const pendingDeferreds = new Set<QuickJSDeferredPromise>();
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadlineMs));
  runtime.setMemoryLimit(64 * 1024 * 1024);
  runtime.setMaxStackSize(1 * 1024 * 1024);

  try {
    const context = runtime.newContext();
    try {
      const logBridge = context.newFunction("__caplets_log", (levelHandle, messageHandle) => {
        logs.push({
          level: logLevel(context.getString(levelHandle)),
          message: context.getString(messageHandle),
          timestamp: new Date().toISOString(),
        });
        return context.undefined;
      });
      context.setProp(context.global, "__caplets_log", logBridge);
      logBridge.dispose();

      const platformHost = installCodeModePlatformHost(context, pendingDeferreds, {});
      const invokeBridge = createInvokeBridge(
        context,
        pendingDeferreds,
        input.invoke,
        deadlineMs,
        timeoutMs,
      );
      context.setProp(context.global, "__caplets_invoke", invokeBridge);
      invokeBridge.dispose();

      const evaluated = context.evalCode(buildExecutionSource(input.code, input.capletIds));
      if (evaluated.error) {
        const error = context.dump(evaluated.error);
        evaluated.error.dispose();
        return {
          ok: false,
          error: normalizeError(error, deadlineMs, timeoutMs),
          logs,
          ...optionalStack(stackFromDump(error)),
        };
      }

      context.setProp(context.global, "__caplets_result", evaluated.value);
      evaluated.value.dispose();

      const stateResult = context.evalCode(
        [
          "(function(p) {",
          "  var s = { settled: false, value: void 0, error: void 0 };",
          "  var formatError = function(e) {",
          "    if (e && typeof e === 'object' && typeof e.message === 'string') return e.message;",
          "    return String(e);",
          "  };",
          "  p.then(function(value) { s.value = value; s.settled = true; },",
          "         function(error) { s.error = formatError(error); s.settled = true; });",
          "  return s;",
          "})(__caplets_result)",
        ].join("\n"),
      );
      if (stateResult.error) {
        const error = context.dump(stateResult.error);
        stateResult.error.dispose();
        return {
          ok: false,
          error: normalizeError(error, deadlineMs, timeoutMs),
          logs,
          ...optionalStack(stackFromDump(error)),
        };
      }

      const stateHandle = stateResult.value;
      try {
        await drainAsync(context, runtime, pendingDeferreds, deadlineMs, timeoutMs);
        const settled = readProp(context, stateHandle, "settled") === true;
        if (!settled) {
          return { ok: false, error: timeoutMessage(timeoutMs), logs };
        }
        const error = readProp(context, stateHandle, "error");
        if (typeof error !== "undefined") {
          return { ok: false, error: normalizeError(error, deadlineMs, timeoutMs), logs };
        }
        return { ok: true, value: readProp(context, stateHandle, "value"), logs };
      } finally {
        stateHandle.dispose();
        platformHost.dispose();
      }
    } finally {
      for (const deferred of pendingDeferreds) {
        if (deferred.alive) {
          deferred.dispose();
        }
      }
      pendingDeferreds.clear();
      context.dispose();
    }
  } catch (error) {
    return {
      ok: false,
      error: normalizeError(error, deadlineMs, timeoutMs),
      logs,
      ...optionalStack(stackFromError(error)),
    };
  } finally {
    runtime.dispose();
  }
}

function createInvokeBridge(
  context: QuickJSContext,
  pendingDeferreds: Set<QuickJSDeferredPromise>,
  invoke: (input: CodeModeSandboxInvokeInput) => Promise<unknown>,
  deadlineMs: number,
  timeoutMs: number,
): QuickJSHandle {
  return context.newFunction("__caplets_invoke", (capletHandle, methodHandle, argsHandle) => {
    const capletId = context.getString(capletHandle);
    const method = context.getString(methodHandle) as CodeModeSandboxInvokeInput["method"];
    const args = context.dump(argsHandle) as unknown[];
    const deferred = context.newPromise();
    pendingDeferreds.add(deferred);
    deferred.settled.finally(() => pendingDeferreds.delete(deferred));

    void invoke({ capletId, method, args }).then(
      (value) => {
        if (!deferred.alive) {
          return;
        }
        try {
          const serialized = JSON.stringify(value);
          const valueHandle = context.newString(serialized === undefined ? "null" : serialized);
          deferred.resolve(valueHandle);
          valueHandle.dispose();
        } catch (error) {
          const errorHandle = context.newError(errorMessage(error));
          deferred.reject(errorHandle);
          errorHandle.dispose();
        }
      },
      (error) => {
        if (!deferred.alive) {
          return;
        }
        const message = Date.now() >= deadlineMs ? timeoutMessage(timeoutMs) : errorMessage(error);
        const errorHandle = context.newError(message);
        deferred.reject(errorHandle);
        errorHandle.dispose();
      },
    );
    return deferred.handle;
  });
}

function buildExecutionSource(code: string, capletIds: string[]): string {
  const javascript = ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    },
  }).outputText;
  return [
    '"use strict";',
    CODE_MODE_PLATFORM_RUNTIME_SOURCE,
    "const __invoke = (capletId, method, args) => Promise.resolve(__caplets_invoke(capletId, method, args)).then(JSON.parse);",
    "const __handle = (capletId) => ({",
    "  id: capletId,",
    "  inspect: () => __invoke(capletId, 'inspect', []),",
    "  check: () => __invoke(capletId, 'check', []),",
    "  tools: (input) => __invoke(capletId, 'tools', [input]),",
    "  searchTools: (query, input) => __invoke(capletId, 'searchTools', [query, input]),",
    "  describeTool: (name) => __invoke(capletId, 'describeTool', [name]),",
    "  callTool: (name, args) => __invoke(capletId, 'callTool', [name, args]),",
    "  resources: (input) => __invoke(capletId, 'resources', [input]),",
    "  searchResources: (query, input) => __invoke(capletId, 'searchResources', [query, input]),",
    "  resourceTemplates: (input) => __invoke(capletId, 'resourceTemplates', [input]),",
    "  readResource: (uri) => __invoke(capletId, 'readResource', [uri]),",
    "  prompts: (input) => __invoke(capletId, 'prompts', [input]),",
    "  searchPrompts: (query, input) => __invoke(capletId, 'searchPrompts', [query, input]),",
    "  getPrompt: (name, args) => __invoke(capletId, 'getPrompt', [name, args]),",
    "  complete: (input) => __invoke(capletId, 'complete', [input]),",
    "});",
    "const caplets = {};",
    ...capletIds.map(
      (capletId) => `caplets[${JSON.stringify(capletId)}] = __handle(${JSON.stringify(capletId)});`,
    ),
    "caplets.debug = caplets.debug || {};",
    "caplets.debug.readLogs = (input) => __invoke('debug', 'readLogs', [input]);",
    "(async () => {",
    javascript,
    "})()",
  ].join("\n");
}

async function drainAsync(
  context: QuickJSContext,
  runtime: QuickJSRuntime,
  pendingDeferreds: ReadonlySet<QuickJSDeferredPromise>,
  deadlineMs: number,
  timeoutMs: number,
): Promise<void> {
  drainJobs(context, runtime, deadlineMs, timeoutMs);
  while (pendingDeferreds.size > 0) {
    await waitForDeferreds(pendingDeferreds, deadlineMs, timeoutMs);
    drainJobs(context, runtime, deadlineMs, timeoutMs);
  }
  drainJobs(context, runtime, deadlineMs, timeoutMs);
}

function drainJobs(
  context: QuickJSContext,
  runtime: QuickJSRuntime,
  deadlineMs: number,
  timeoutMs: number,
): void {
  while (runtime.hasPendingJob()) {
    if (Date.now() >= deadlineMs) {
      throw new Error(timeoutMessage(timeoutMs));
    }
    const pending = runtime.executePendingJobs();
    if (pending.error) {
      const error = context.dump(pending.error);
      pending.error.dispose();
      throw new Error(errorMessage(error));
    }
  }
}

async function waitForDeferreds(
  pendingDeferreds: ReadonlySet<QuickJSDeferredPromise>,
  deadlineMs: number,
  timeoutMs: number,
): Promise<void> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    throw new Error(timeoutMessage(timeoutMs));
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.race([...pendingDeferreds].map((deferred) => deferred.settled)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage(timeoutMs))), remainingMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function readProp(context: QuickJSContext, handle: QuickJSHandle, key: string): unknown {
  const prop = context.getProp(handle, key);
  try {
    return context.dump(prop);
  } finally {
    prop.dispose();
  }
}

function timeoutMessage(timeoutMs: number): string {
  return `Code Mode execution timed out after ${timeoutMs}ms`;
}

function normalizeError(error: unknown, deadlineMs: number, timeoutMs: number): string {
  const message = errorMessage(error);
  return Date.now() >= deadlineMs && /\binterrupted\b/iu.test(message)
    ? timeoutMessage(timeoutMs)
    : message;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stackFromError(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

function stackFromDump(error: unknown): string | undefined {
  if (error && typeof error === "object" && "stack" in error) {
    const stack = (error as { stack?: unknown }).stack;
    return typeof stack === "string" ? stack : undefined;
  }
  return undefined;
}

function optionalStack(stack: string | undefined): { stack?: string } {
  return stack === undefined ? {} : { stack };
}

function logLevel(value: string): CodeModeLogEntry["level"] {
  return value === "info" ||
    value === "warn" ||
    value === "error" ||
    value === "debug" ||
    value === "log"
    ? value
    : "log";
}
