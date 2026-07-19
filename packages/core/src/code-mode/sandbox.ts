import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
} from "quickjs-emscripten";
import { randomUUID } from "node:crypto";
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
    | "readLogs"
    | "readRecovery";
  args: unknown[];
};

export type CodeModeSandboxInput = {
  code: string;
  capletIds: string[];
  timeoutMs: number;
  invoke: (input: CodeModeSandboxInvokeInput) => Promise<unknown>;
};

const CODE_MODE_SANDBOX_METHODS = new Set<CodeModeSandboxInvokeInput["method"]>([
  "inspect",
  "check",
  "tools",
  "searchTools",
  "describeTool",
  "callTool",
  "resources",
  "searchResources",
  "resourceTemplates",
  "readResource",
  "prompts",
  "searchPrompts",
  "getPrompt",
  "complete",
  "readLogs",
  "readRecovery",
]);

const CODE_MODE_DEBUG_METHODS = new Set<CodeModeSandboxInvokeInput["method"]>([
  "readLogs",
  "readRecovery",
]);

export type CodeModeSandboxResult =
  | { ok: true; value: unknown; logs: CodeModeLogEntry[] }
  | { ok: false; error: string; logs: CodeModeLogEntry[]; stack?: string };

export interface CodeModeSandbox {
  run(input: CodeModeSandboxInput): Promise<CodeModeSandboxResult>;
}

export interface CodeModeReplSession extends CodeModeSandbox {
  dispose(): void;
  isDisposed(): boolean;
}

export class QuickJsCodeModeSandbox implements CodeModeSandbox {
  async run(input: CodeModeSandboxInput): Promise<CodeModeSandboxResult> {
    return await evaluateInQuickJs(input);
  }

  async createSession(): Promise<QuickJsCodeModeReplSession> {
    const QuickJS = await getQuickJS();
    return new QuickJsCodeModeReplSession(QuickJS.newRuntime());
  }
}

export class QuickJsCodeModeReplSession implements CodeModeReplSession {
  #runtime: QuickJSRuntime;
  #context: QuickJSContext;
  #pendingDeferreds = new Set<QuickJSDeferredPromise>();
  #pendingInvokes = new Set<QuickJSDeferredPromise>();
  #platformHost: ReturnType<typeof installCodeModePlatformHost>;
  #capletIds = new Set<string>();
  #persistentNames = new Set<string>();
  #invoke: (input: CodeModeSandboxInvokeInput) => Promise<unknown> = async () => {
    throw new Error("Code Mode invoke bridge is not initialized.");
  };
  #deadlineMs = 0;
  #timeoutMs = 0;
  #logs: CodeModeLogEntry[] = [];
  #disposed = false;
  #running = false;
  #disposeRequested = false;
  #globalNameCheckpoint = new Set<string>();
  #persistDescriptorCheckpoint = "";
  #checkpointToken = randomUUID();

  constructor(runtime: QuickJSRuntime) {
    this.#runtime = runtime;
    this.#runtime.setMemoryLimit(64 * 1024 * 1024);
    this.#runtime.setMaxStackSize(1 * 1024 * 1024);
    this.#context = runtime.newContext();
    this.#installStableBridges();
    this.#platformHost = installCodeModePlatformHost(this.#context, this.#pendingDeferreds, {});
    this.#evalInitSource();
  }

  async run(input: CodeModeSandboxInput): Promise<CodeModeSandboxResult> {
    if (this.#disposed) {
      return { ok: false, error: "Code Mode session is disposed.", logs: [] };
    }
    if (this.#disposeRequested) {
      return { ok: false, error: "Code Mode session is disposed.", logs: [] };
    }
    if (this.#running) {
      return { ok: false, error: "Code Mode session is already running.", logs: [] };
    }
    this.#running = true;
    const timeoutMs = Math.max(100, input.timeoutMs);
    const deadlineMs = Date.now() + timeoutMs;
    this.#runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadlineMs));
    this.#logs = [];
    let shouldDispose = false;
    try {
      this.#refreshInvokeBridge(input.invoke, deadlineMs, timeoutMs);
      const bridgeResult = this.#context.evalCode(
        buildBridgeRefreshSource(input.capletIds, [...this.#capletIds]),
      );
      if (bridgeResult.error) {
        const error = this.#context.dump(bridgeResult.error);
        bridgeResult.error.dispose();
        const result: CodeModeSandboxResult = {
          ok: false,
          error: normalizeError(error, deadlineMs, timeoutMs),
          logs: this.#logs,
          ...optionalStack(stackFromDump(error)),
        };
        shouldDispose = isTimeoutMessage(result.error, timeoutMs);
        return result;
      }
      bridgeResult.value.dispose();
      this.#capletIds = new Set(input.capletIds);
      const cell = buildSessionCellSource(
        input.code,
        input.capletIds,
        [...this.#persistentNames],
        this.#checkpointToken,
      );
      const resetResult = this.#context.evalCode(buildPlatformResetSource());
      if (resetResult.error) {
        const error = this.#context.dump(resetResult.error);
        resetResult.error.dispose();
        const result: CodeModeSandboxResult = {
          ok: false,
          error: `Code Mode session state is corrupted: ${normalizeError(error, deadlineMs, timeoutMs)}`,
          logs: this.#logs,
          ...optionalStack(stackFromDump(error)),
        };
        shouldDispose = true;
        return result;
      }
      resetResult.value.dispose();
      this.#snapshotGlobalNames();
      this.#snapshotPersistDescriptors();
      const result = await evaluateCellInContext({
        code: input.code,
        compiledSource: cell.source,
        context: this.#context,
        runtime: this.#runtime,
        pendingDeferreds: this.#pendingDeferreds,
        pendingInvokes: this.#pendingInvokes,
        deadlineMs,
        timeoutMs,
        logs: this.#logs,
        session: true,
      });
      if (!result.ok && isTimeoutMessage(result.error, timeoutMs)) {
        shouldDispose = true;
        return result;
      }
      const persistentNames = this.#existingPersistentNames(cell.persistentNames);
      for (const name of persistentNames) {
        this.#persistentNames.add(name);
      }
      const platformRestored = this.#restorePlatformAfterRun();
      const persistenceDescriptorsOk = this.#persistentDescriptorsOk(persistentNames);
      const persistentGlobalDescriptorsOk = this.#persistentGlobalDescriptorsOk(persistentNames);
      const hasGlobalNameAdditions = this.#hasGlobalNameAdditions(persistentNames);
      const directPersistAccess = this.#isPersistTainted();
      const persistDescriptorsChanged = this.#persistDescriptorsChanged(persistentNames);
      shouldDispose =
        this.#pendingDeferreds.size > 0 ||
        hasGlobalNameAdditions ||
        directPersistAccess ||
        persistDescriptorsChanged ||
        !this.#isGlobalExtensible() ||
        !persistentGlobalDescriptorsOk ||
        !persistenceDescriptorsOk ||
        !platformRestored;
      if (!shouldDispose) {
        this.#clearPendingDeferreds();
      }
      if (!shouldDispose && !result.ok) {
        shouldDispose = !this.#settleFailedDeclarations(cell.newNames);
      }
      return result;
    } catch (error) {
      const result: CodeModeSandboxResult = {
        ok: false,
        error: normalizeError(error, deadlineMs, timeoutMs),
        logs: this.#logs,
        ...optionalStack(stackFromError(error)),
      };
      shouldDispose = true;
      return result;
    } finally {
      this.#running = false;
      if (!this.#disposed) {
        this.#runtime.setInterruptHandler(() => false);
      }
      if (shouldDispose) {
        this.dispose();
      }
      if (this.#disposeRequested) {
        this.#disposeNow();
      }
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    if (this.#running) {
      this.#disposeRequested = true;
      return;
    }
    this.#disposeNow();
  }

  isDisposed(): boolean {
    return this.#disposed;
  }

  #disposeNow(): void {
    if (this.#disposed) return;
    this.#disposeRequested = false;
    this.#disposed = true;
    this.#platformHost.dispose();
    for (const deferred of this.#pendingDeferreds) {
      if (deferred.alive) {
        deferred.dispose();
      }
    }
    this.#pendingDeferreds.clear();
    this.#pendingInvokes.clear();
    this.#context.dispose();
    this.#runtime.dispose();
  }

  #installStableBridges(): void {
    const logBridge = this.#context.newFunction("__caplets_log", (levelHandle, messageHandle) => {
      this.#logs.push({
        level: logLevel(this.#context.getString(levelHandle)),
        message: this.#context.getString(messageHandle),
        timestamp: new Date().toISOString(),
      });
      return this.#context.undefined;
    });
    this.#context.setProp(this.#context.global, "__caplets_log", logBridge);
    logBridge.dispose();
    const invokeBridge = createInvokeJsonBridge(
      this.#context,
      this.#pendingDeferreds,
      this.#pendingInvokes,
      () => this.#invoke,
      () => this.#deadlineMs,
      () => this.#timeoutMs,
      (capletId) => this.#capletIds.has(capletId),
    );
    this.#context.setProp(this.#context.global, "__caplets_invoke_json", invokeBridge);
    invokeBridge.dispose();
    const activeCapletBridge = this.#context.newFunction(
      "__caplets_is_active_id",
      (capletIdHandle) =>
        this.#capletIds.has(this.#context.getString(capletIdHandle))
          ? this.#context.true
          : this.#context.false,
    );
    this.#context.setProp(this.#context.global, "__caplets_is_active_id", activeCapletBridge);
    activeCapletBridge.dispose();
    const protectInvokeBridge = this.#context.evalCode(
      [
        "Object.defineProperty(globalThis, '__caplets_log', { configurable: false, writable: false, value: globalThis.__caplets_log });",
        "Object.defineProperty(globalThis, '__caplets_invoke_json', { configurable: false, writable: false, value: globalThis.__caplets_invoke_json });",
        "Object.defineProperty(globalThis, '__caplets_is_active_id', { configurable: false, writable: false, value: globalThis.__caplets_is_active_id });",
      ].join("\n"),
    );
    if (protectInvokeBridge.error) {
      const error = this.#context.dump(protectInvokeBridge.error);
      protectInvokeBridge.error.dispose();
      throw new Error(errorMessage(error));
    }
    protectInvokeBridge.value.dispose();
  }

  #evalInitSource(): void {
    const result = this.#context.evalCode(buildSessionInitSource(this.#checkpointToken));
    if (result.error) {
      const error = this.#context.dump(result.error);
      result.error.dispose();
      throw new Error(errorMessage(error));
    }
    result.value.dispose();
  }

  #refreshInvokeBridge(
    invoke: (input: CodeModeSandboxInvokeInput) => Promise<unknown>,
    deadlineMs: number,
    timeoutMs: number,
  ): void {
    this.#invoke = invoke;
    this.#deadlineMs = deadlineMs;
    this.#timeoutMs = timeoutMs;
  }

  #existingPersistentNames(names: string[]): string[] {
    if (names.length === 0 || this.#disposed) return [];
    const result = this.#context.evalCode(
      `globalThis.__caplets_existing_persist_names(${JSON.stringify(this.#checkpointToken)}, ${JSON.stringify(names)})`,
    );
    if (result.error) {
      const error = this.#context.dump(result.error);
      result.error.dispose();
      throw new Error(errorMessage(error));
    }
    const existing = this.#context.dump(result.value) as string[];
    result.value.dispose();
    return existing;
  }

  #clearPendingDeferreds(): void {
    this.#platformHost.dispose();
    for (const deferred of this.#pendingDeferreds) {
      if (deferred.alive) {
        deferred.dispose();
      }
    }
    this.#pendingDeferreds.clear();
  }

  #snapshotGlobalNames(): void {
    if (this.#disposed) {
      return;
    }
    const result = this.#context.evalCode("__caplets_global_keys()");
    if (result.error) {
      result.error.dispose();
      return;
    }
    const names = this.#context.dump(result.value) as string[];
    this.#globalNameCheckpoint = new Set(names.filter((name) => !this.#isInternalGlobalName(name)));
    result.value.dispose();
  }

  #snapshotPersistDescriptors(): void {
    if (this.#disposed) {
      return;
    }
    const result = this.#context.evalCode("__caplets_persist_descriptor_fingerprint()");
    if (result.error) {
      result.error.dispose();
      this.#persistDescriptorCheckpoint = "";
      return;
    }
    this.#persistDescriptorCheckpoint = String(this.#context.dump(result.value));
    result.value.dispose();
  }

  #persistDescriptorsChanged(allowedNames: string[] = []): boolean {
    if (this.#disposed) {
      return false;
    }
    const result = this.#context.evalCode(
      `__caplets_persist_descriptor_fingerprint(${JSON.stringify(allowedNames)})`,
    );
    if (result.error) {
      result.error.dispose();
      return true;
    }
    const fingerprint = String(this.#context.dump(result.value));
    result.value.dispose();
    return (
      fingerprint !==
      filterPersistDescriptorFingerprint(this.#persistDescriptorCheckpoint, allowedNames)
    );
  }

  #hasGlobalNameAdditions(allowedNames: string[] = []): boolean {
    if (this.#disposed) {
      return false;
    }
    const result = this.#context.evalCode("__caplets_global_keys()");
    if (result.error) {
      result.error.dispose();
      return true;
    }
    const names = this.#context.dump(result.value) as string[];
    const allowedTokens = new Set(allowedNames.map((name) => `string:${name}`));
    const hasAdditions = names
      .filter((name) => !this.#isInternalGlobalName(name))
      .filter((name) => !allowedTokens.has(name))
      .some((name) => !this.#globalNameCheckpoint.has(name));
    result.value.dispose();
    return hasAdditions;
  }

  #isGlobalExtensible(): boolean {
    if (this.#disposed) {
      return false;
    }
    const result = this.#context.evalCode("__caplets_is_global_extensible()");
    if (result.error) {
      result.error.dispose();
      return false;
    }
    const isExtensible = this.#context.dump(result.value) === true;
    result.value.dispose();
    return isExtensible;
  }

  #restorePlatformAfterRun(): boolean {
    if (this.#disposed) {
      return false;
    }
    const result = this.#context.evalCode(buildPlatformResetSource());
    if (result.error) {
      result.error.dispose();
      return false;
    }
    result.value.dispose();
    return true;
  }

  #persistentDescriptorsOk(names: string[]): boolean {
    if (names.length === 0 || this.#disposed) {
      return true;
    }
    const result = this.#context.evalCode(
      `__caplets_persist_descriptors_ok(${JSON.stringify(this.#checkpointToken)}, ${JSON.stringify(names)})`,
    );
    if (result.error) {
      result.error.dispose();
      return false;
    }
    const ok = this.#context.dump(result.value) === true;
    result.value.dispose();
    return ok;
  }

  #settleFailedDeclarations(names: string[]): boolean {
    if (names.length === 0 || this.#disposed) {
      return true;
    }
    const result = this.#context.evalCode(
      `__caplets_settle_failed_declarations(${JSON.stringify(this.#checkpointToken)}, ${JSON.stringify(names)})`,
    );
    if (result.error) {
      result.error.dispose();
      return false;
    }
    result.value.dispose();
    return true;
  }

  #isPersistTainted(): boolean {
    if (this.#disposed) {
      return false;
    }
    const result = this.#context.evalCode(
      `__caplets_persist_is_tainted(${JSON.stringify(this.#checkpointToken)})`,
    );
    if (result.error) {
      result.error.dispose();
      return true;
    }
    const tainted = this.#context.dump(result.value) === true;
    result.value.dispose();
    return tainted;
  }

  #persistentGlobalDescriptorsOk(names: string[]): boolean {
    if (names.length === 0 || this.#disposed) {
      return true;
    }
    const result = this.#context.evalCode(
      `__caplets_persist_global_descriptors_ok(${JSON.stringify(this.#checkpointToken)}, ${JSON.stringify(names)})`,
    );
    if (result.error) {
      result.error.dispose();
      return false;
    }
    const ok = this.#context.dump(result.value) === true;
    result.value.dispose();
    return ok;
  }

  #isInternalGlobalName(name: string): boolean {
    return (
      name === "string:__caplets_log" ||
      name === "string:__caplets_invoke_json" ||
      name === "string:__caplets_is_active_id" ||
      name === "string:__caplets_restore_platform" ||
      name === "string:__caplets_global_keys" ||
      name === "string:__caplets_assert_active_id" ||
      name === "string:__caplets_handle" ||
      name === "string:__caplets_persist" ||
      name === "string:__caplets_get_session_scope" ||
      name === "string:__caplets_predeclare" ||
      name === "string:__caplets_initialize_binding" ||
      name === "string:__caplets_initialization_target" ||
      name === "string:__caplets_settle_failed_declarations" ||
      name === "string:__caplets_set_cell_caplets" ||
      name === "string:__caplets_existing_persist_names" ||
      name === "string:__caplets_persist_descriptor_fingerprint" ||
      name === "string:__caplets_persist_descriptors_ok" ||
      name === "string:__caplets_persist_is_tainted" ||
      name === "string:__caplets_persist_global_descriptors_ok" ||
      name === "string:__caplets_get_persist" ||
      name === "string:__caplets_set_persist" ||
      name === "string:__caplets_snapshot_persist" ||
      name === "string:__caplets_checkpoint_value" ||
      name === "string:__caplets_observe_promise" ||
      name === "string:__caplets_json_parse"
    );
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

      try {
        return await evaluateCellInContext({
          code: input.code,
          capletIds: input.capletIds,
          context,
          runtime,
          pendingDeferreds,
          pendingInvokes: pendingDeferreds,
          deadlineMs,
          timeoutMs,
          logs,
          session: false,
        });
      } finally {
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

type EvaluateCellInContextInput = {
  code: string;
  compiledSource?: string;
  capletIds?: string[];
  context: QuickJSContext;
  runtime: QuickJSRuntime;
  pendingDeferreds: Set<QuickJSDeferredPromise>;
  pendingInvokes: Set<QuickJSDeferredPromise>;
  deadlineMs: number;
  timeoutMs: number;
  logs: CodeModeLogEntry[];
  session: boolean;
  afterPendingInvokesDrained?: () => void;
};

async function evaluateCellInContext(
  input: EvaluateCellInContextInput,
): Promise<CodeModeSandboxResult> {
  const observerResult = input.context.evalCode(buildPromiseObserverSource());
  if (observerResult.error) {
    const error = input.context.dump(observerResult.error);
    observerResult.error.dispose();
    return {
      ok: false,
      error: normalizeError(error, input.deadlineMs, input.timeoutMs),
      logs: input.logs,
      ...optionalStack(stackFromDump(error)),
    };
  }
  observerResult.value.dispose();

  const evaluated = input.context.evalCode(
    input.compiledSource ??
      (input.session
        ? buildSessionCellSource(input.code, input.capletIds ?? []).source
        : buildExecutionSource(input.code, input.capletIds ?? [])),
  );
  if (evaluated.error) {
    const error = input.context.dump(evaluated.error);
    evaluated.error.dispose();
    return {
      ok: false,
      error: normalizeError(error, input.deadlineMs, input.timeoutMs),
      logs: input.logs,
      ...optionalStack(stackFromDump(error)),
    };
  }

  const resultName = `__caplets_result_${randomUUID().replace(/-/gu, "_")}`;
  input.context.setProp(input.context.global, resultName, evaluated.value);
  evaluated.value.dispose();

  const stateResult = input.context.evalCode(buildPromiseStateSource(JSON.stringify(resultName)));
  cleanupTemporaryGlobals(input.context, JSON.stringify(resultName));
  if (stateResult.error) {
    const error = input.context.dump(stateResult.error);
    stateResult.error.dispose();
    return {
      ok: false,
      error: normalizeError(error, input.deadlineMs, input.timeoutMs),
      logs: input.logs,
      ...optionalStack(stackFromDump(error)),
    };
  }

  const stateHandle = stateResult.value;
  try {
    if (input.session) {
      if (input.pendingInvokes.size > 0) {
        await drainAsync(
          input.context,
          input.runtime,
          input.pendingInvokes,
          input.deadlineMs,
          input.timeoutMs,
        );
        await drainAsync(
          input.context,
          input.runtime,
          input.pendingDeferreds,
          input.deadlineMs,
          input.timeoutMs,
        );
        await Promise.resolve();
        drainJobs(input.context, input.runtime, input.deadlineMs, input.timeoutMs);
        input.afterPendingInvokesDrained?.();
      } else {
        drainJobs(input.context, input.runtime, input.deadlineMs, input.timeoutMs);
      }
      const earlyResult = readSettledPromiseState(input.context, stateHandle, input.logs);
      if (earlyResult) return earlyResult;
    }
    await drainAsync(
      input.context,
      input.runtime,
      input.pendingDeferreds,
      input.deadlineMs,
      input.timeoutMs,
    );
    const settled = readProp(input.context, stateHandle, "settled") === true;
    if (!settled) {
      return { ok: false, error: timeoutMessage(input.timeoutMs), logs: input.logs };
    }
    return (
      readSettledPromiseState(input.context, stateHandle, input.logs) ?? {
        ok: false,
        error: timeoutMessage(input.timeoutMs),
        logs: input.logs,
      }
    );
  } finally {
    stateHandle.dispose();
  }
}

function cleanupTemporaryGlobals(context: QuickJSContext, ...names: string[]): void {
  if (names.length === 0) {
    return;
  }
  const result = context.evalCode(names.map((name) => `delete globalThis[${name}];`).join("\n"));
  if (result.error) {
    result.error.dispose();
    return;
  }
  result.value.dispose();
}

function readSettledPromiseState(
  context: QuickJSContext,
  stateHandle: QuickJSHandle,
  logs: CodeModeLogEntry[],
): CodeModeSandboxResult | undefined {
  const settled = readProp(context, stateHandle, "settled") === true;
  if (!settled) {
    return undefined;
  }
  const error = readProp(context, stateHandle, "error");
  if (typeof error !== "undefined") {
    return {
      ok: false,
      error: errorMessage(error),
      logs,
    };
  }
  return { ok: true, value: readProp(context, stateHandle, "value"), logs };
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
    deferred.settled.finally(() => {
      pendingDeferreds.delete(deferred);
      if (deferred.alive) {
        deferred.dispose();
      }
    });

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

function createInvokeJsonBridge(
  context: QuickJSContext,
  pendingDeferreds: Set<QuickJSDeferredPromise>,
  pendingInvokes: Set<QuickJSDeferredPromise>,
  invoke: () => (input: CodeModeSandboxInvokeInput) => Promise<unknown>,
  deadlineMs: () => number,
  timeoutMs: () => number,
  isCapletActive: (capletId: string) => boolean,
): QuickJSHandle {
  return context.newFunction("__caplets_invoke_json", (capletHandle, methodHandle, argsHandle) => {
    const capletId = context.getString(capletHandle);
    const method = context.getString(methodHandle);
    const args = context.dump(argsHandle) as unknown[];
    const deferred = context.newPromise();
    pendingDeferreds.add(deferred);
    pendingInvokes.add(deferred);
    deferred.settled.finally(() => {
      pendingDeferreds.delete(deferred);
      pendingInvokes.delete(deferred);
      if (deferred.alive) {
        deferred.dispose();
      }
    });

    const debugMethod = CODE_MODE_DEBUG_METHODS.has(method as CodeModeSandboxInvokeInput["method"]);
    const debugCapletActive = capletId === "debug" && isCapletActive("debug");
    if (
      !isCodeModeSandboxMethod(method) ||
      (capletId === "debug" && !debugMethod && !debugCapletActive) ||
      (capletId !== "debug" && debugMethod)
    ) {
      const errorHandle = context.newError(
        `Method ${method} is not available in this Code Mode session cell.`,
      );
      deferred.reject(errorHandle);
      errorHandle.dispose();
      return deferred.handle;
    }

    if (!(capletId === "debug" && debugMethod) && !isCapletActive(capletId)) {
      const errorHandle = context.newError(
        `Caplet ${capletId} is not available in this Code Mode session cell.`,
      );
      deferred.reject(errorHandle);
      errorHandle.dispose();
      return deferred.handle;
    }

    void invoke()({ capletId, method, args }).then(
      (value) => {
        if (!deferred.alive) {
          return;
        }
        let valueHandle: QuickJSHandle | undefined;
        try {
          const serialized = JSON.stringify(value);
          const parsed = context.evalCode(
            `globalThis.__caplets_json_parse(${JSON.stringify(serialized ?? "null")})`,
          );
          if (parsed.error) {
            const error = context.dump(parsed.error);
            parsed.error.dispose();
            throw new Error(errorMessage(error));
          }
          valueHandle = parsed.value;
          deferred.resolve(valueHandle);
        } catch (error) {
          const errorHandle = context.newError(errorMessage(error));
          deferred.reject(errorHandle);
          errorHandle.dispose();
        } finally {
          valueHandle?.dispose();
        }
      },
      (error) => {
        if (!deferred.alive) {
          return;
        }
        const message =
          Date.now() >= deadlineMs() ? timeoutMessage(timeoutMs()) : errorMessage(error);
        const errorHandle = context.newError(message);
        deferred.reject(errorHandle);
        errorHandle.dispose();
      },
    );
    return deferred.handle;
  });
}

function isCodeModeSandboxMethod(method: string): method is CodeModeSandboxInvokeInput["method"] {
  return CODE_MODE_SANDBOX_METHODS.has(method as CodeModeSandboxInvokeInput["method"]);
}

function filterPersistDescriptorFingerprint(fingerprint: string, allowedNames: string[]): string {
  if (!fingerprint || allowedNames.length === 0) {
    return fingerprint;
  }
  const allowedTokens = new Set(allowedNames.map((name) => `string:${name}`));
  return fingerprint
    .split("|")
    .filter((entry) => {
      const token = entry.startsWith("string:")
        ? entry.slice(0, entry.indexOf(":", "string:".length))
        : entry.startsWith("symbol:")
          ? entry.slice(0, entry.indexOf(":", "symbol:".length))
          : entry;
      return !allowedTokens.has(token);
    })
    .join("|");
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
    "caplets.debug.readRecovery = (input) => __invoke('debug', 'readRecovery', [input]);",
    "(async () => {",
    javascript,
    "})()",
  ].join("\n");
}

function buildSessionInitSource(checkpointToken: string): string {
  return [
    CODE_MODE_PLATFORM_RUNTIME_SOURCE,
    "const __caplets_restore_platform = (() => {",
    "  const defineProperty = Object.defineProperty.bind(Object);",
    "  const defineProperties = Object.defineProperties.bind(Object);",
    "  const getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors.bind(Object);",
    "  const getPrototypeOf = Object.getPrototypeOf.bind(Object);",
    "  const setPrototypeOf = Object.setPrototypeOf.bind(Object);",
    "  const isExtensible = Object.isExtensible.bind(Object);",
    "  const ownKeys = Reflect.ownKeys.bind(Reflect);",
    "  const hasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);",
    "  const arrayPush = Function.prototype.call.bind(Array.prototype.push);",
    "  const globalSymbolIds = new Map();",
    "  let nextGlobalSymbolId = 1;",
    "  const keyToken = (key) => {",
    "    if (typeof key !== 'symbol') return `string:${key}`;",
    "    if (!globalSymbolIds.has(key)) globalSymbolIds.set(key, nextGlobalSymbolId++);",
    "    return `symbol:${globalSymbolIds.get(key)}`;",
    "  };",
    "  const platformGlobals = [];",
    "  const globalPrototypeSnapshot = getPrototypeOf(globalThis);",
    "  const platformExtraObjects = [",
    "    ['AsyncFunction.prototype', getPrototypeOf(async function() {})],",
    "    ['AsyncFunctionConstructor', getPrototypeOf(async function() {}).constructor],",
    "    ['GeneratorFunction.prototype', getPrototypeOf(function*() {})],",
    "    ['GeneratorFunctionConstructor', getPrototypeOf(function*() {}).constructor],",
    "    ['AsyncGeneratorFunction.prototype', getPrototypeOf(async function*() {})],",
    "    ['AsyncGeneratorFunctionConstructor', getPrototypeOf(async function*() {}).constructor],",
    "    ['GeneratorObjectPrototype', getPrototypeOf((function*() {})())],",
    "    ['GeneratorObjectPrototypeParent', getPrototypeOf(getPrototypeOf((function*() {})()))],",
    "    ['AsyncGeneratorObjectPrototype', getPrototypeOf((async function*() {})())],",
    "    ['AsyncGeneratorObjectPrototypeParent', getPrototypeOf(getPrototypeOf((async function*() {})()))],",
    "    ['ArrayIteratorPrototype', getPrototypeOf([][Symbol.iterator]())],",
    "    ['IteratorPrototype', getPrototypeOf(getPrototypeOf([][Symbol.iterator]()))],",
    "    ['StringIteratorPrototype', getPrototypeOf(''[Symbol.iterator]())],",
    "    ['RegExpStringIteratorPrototype', getPrototypeOf(''.matchAll(/(?:)/g))],",
    "    ['RegExpStringIteratorPrototypeParent', getPrototypeOf(getPrototypeOf(''.matchAll(/(?:)/g)))],",
    "    ['MapIteratorPrototype', getPrototypeOf(new Map()[Symbol.iterator]())],",
    "    ['SetIteratorPrototype', getPrototypeOf(new Set()[Symbol.iterator]())],",
    "    ['TypedArrayConstructor', getPrototypeOf(Int8Array)],",
    "    ['TypedArrayPrototype', getPrototypeOf(Int8Array.prototype)],",
    "    ['AsyncFunctionPrototypeParent', getPrototypeOf(getPrototypeOf(async function() {}))],",
    "    ['GeneratorFunctionPrototypeParent', getPrototypeOf(getPrototypeOf(function*() {}))],",
    "    ['AsyncGeneratorFunctionPrototypeParent', getPrototypeOf(getPrototypeOf(async function*() {}))],",
    "  ];",
    "  const platformExtraSnapshot = Object.create(null);",
    "  const platformExtraPrototypeSnapshot = Object.create(null);",
    "  const platformExtraExtensibleSnapshot = Object.create(null);",
    "  const platformGlobalNames = ownKeys(globalThis);",
    "  for (const name of platformGlobalNames) {",
    "    const record = {",
    "      name,",
    "      descriptor: Object.getOwnPropertyDescriptor(globalThis, name),",
    "      value: globalThis[name],",
    "      objectPrototype: undefined,",
    "      properties: undefined,",
    "      prototypeProperties: undefined,",
    "      prototypeChain: undefined,",
    "      extensible: undefined,",
    "      prototypeExtensible: undefined,",
    "    };",
    "    const value = globalThis[name];",
    "    if (value !== globalThis && ((typeof value === 'object' && value !== null) || typeof value === 'function')) {",
    "      record.objectPrototype = getPrototypeOf(value);",
    "      record.properties = getOwnPropertyDescriptors(value);",
    "      record.extensible = isExtensible(value);",
    "      const prototype = value.prototype;",
    "      if ((typeof prototype === 'object' && prototype !== null) || typeof prototype === 'function') {",
    "        record.prototypeChain = getPrototypeOf(prototype);",
    "        record.prototypeProperties = getOwnPropertyDescriptors(prototype);",
    "        record.prototypeExtensible = isExtensible(prototype);",
    "      }",
    "    }",
    "    arrayPush(platformGlobals, record);",
    "  }",
    "  for (const [name, value] of platformExtraObjects) {",
    "    if ((typeof value === 'object' && value !== null) || typeof value === 'function') {",
    "      platformExtraSnapshot[name] = getOwnPropertyDescriptors(value);",
    "      platformExtraPrototypeSnapshot[name] = getPrototypeOf(value);",
    "      platformExtraExtensibleSnapshot[name] = isExtensible(value);",
    "    }",
    "  }",
    "  const globalKeys = () => {",
    "    const keys = ownKeys(globalThis);",
    "    const tokens = [];",
    "    for (let index = 0; index < keys.length; index += 1) {",
    "      const key = keys[index];",
    "      arrayPush(tokens, keyToken(key));",
    "    }",
    "    return tokens;",
    "  };",
    "  const restore = () => {",
    "    if (getPrototypeOf(globalThis) !== globalPrototypeSnapshot) {",
    "      try { setPrototypeOf(globalThis, globalPrototypeSnapshot); } catch { throw new Error('Code Mode global prototype chain is not restorable'); }",
    "    }",
    "    for (const record of platformGlobals) {",
    "      const name = record.name;",
    "      try {",
    "      defineProperty(globalThis, name, record.descriptor);",
    "      const descriptors = record.properties;",
    "      const value = globalThis[name];",
    "      if (descriptors && ((typeof value === 'object' && value !== null) || typeof value === 'function')) {",
    "        if (record.extensible && !isExtensible(value)) throw new Error(`Code Mode platform global ${String(name)} is non-extensible`);",
    "        if (getPrototypeOf(value) !== record.objectPrototype) {",
    "          try { setPrototypeOf(value, record.objectPrototype); } catch { throw new Error(`Code Mode platform global ${String(name)} prototype chain is not restorable`); }",
    "        }",
    "        for (const key of ownKeys(value)) {",
    "          if (!hasOwn(descriptors, key)) {",
    "            try { delete value[key]; } catch {}",
    "            if (hasOwn(value, key)) throw new Error(`Code Mode platform global ${String(name)} has non-restorable property ${String(key)}`);",
    "          }",
    "        }",
    "        defineProperties(value, descriptors);",
    "        const prototypeDescriptors = record.prototypeProperties;",
    "        const prototype = value.prototype;",
    "        if (prototypeDescriptors && ((typeof prototype === 'object' && prototype !== null) || typeof prototype === 'function')) {",
    "          if (record.prototypeExtensible && !isExtensible(prototype)) throw new Error(`Code Mode platform prototype ${String(name)}.prototype is non-extensible`);",
    "          if (getPrototypeOf(prototype) !== record.prototypeChain) {",
    "            try { setPrototypeOf(prototype, record.prototypeChain); } catch { throw new Error(`Code Mode platform prototype ${String(name)}.prototype chain is not restorable`); }",
    "          }",
    "          for (const key of ownKeys(prototype)) {",
    "            if (!hasOwn(prototypeDescriptors, key)) {",
    "              try { delete prototype[key]; } catch {}",
    "              if (hasOwn(prototype, key)) throw new Error(`Code Mode platform prototype ${String(name)}.prototype has non-restorable property ${String(key)}`);",
    "            }",
    "          }",
    "          defineProperties(prototype, prototypeDescriptors);",
    "        }",
    "      }",
    "      } catch (error) {",
    "        throw new Error(`Code Mode platform global ${String(name)} is not restorable: ${String(error && error.message ? error.message : error)}`);",
    "      }",
    "    }",
    "    for (const [name, value] of platformExtraObjects) {",
    "      const descriptors = platformExtraSnapshot[name];",
    "      if (!descriptors || !((typeof value === 'object' && value !== null) || typeof value === 'function')) continue;",
    "      if (platformExtraExtensibleSnapshot[name] && !isExtensible(value)) throw new Error(`Code Mode platform intrinsic ${name} is non-extensible`);",
    "      if (getPrototypeOf(value) !== platformExtraPrototypeSnapshot[name]) {",
    "        try { setPrototypeOf(value, platformExtraPrototypeSnapshot[name]); } catch { throw new Error(`Code Mode platform intrinsic ${name} prototype chain is not restorable`); }",
    "      }",
    "      for (const key of ownKeys(value)) {",
    "        if (!hasOwn(descriptors, key)) {",
    "          try { delete value[key]; } catch {}",
    "          if (hasOwn(value, key)) throw new Error(`Code Mode platform intrinsic ${name} has non-restorable property ${String(key)}`);",
    "        }",
    "      }",
    "      defineProperties(value, descriptors);",
    "    }",
    "  };",
    "  return { restore, globalKeys, isGlobalExtensible: () => isExtensible(globalThis) };",
    "})();",
    "Object.defineProperty(globalThis, '__caplets_restore_platform', { configurable: false, writable: false, value: __caplets_restore_platform.restore });",
    "Object.defineProperty(globalThis, '__caplets_global_keys', { configurable: false, writable: false, value: __caplets_restore_platform.globalKeys });",
    "Object.defineProperty(globalThis, '__caplets_is_global_extensible', { configurable: false, writable: false, value: __caplets_restore_platform.isGlobalExtensible });",
    "Object.defineProperty(globalThis, '__caplets_assert_active_id', { configurable: false, writable: false, value: (capletId) => {",
    "  if (capletId === 'debug' && !__caplets_is_active_id(capletId)) return;",
    "  if (!__caplets_is_active_id(capletId)) throw new Error(`Caplet ${capletId} is not available in this Code Mode session cell.`);",
    "} });",
    "Object.defineProperty(globalThis, '__caplets_handle', { configurable: false, writable: false, value: (capletId) => ({",
    "  id: capletId,",
    "  inspect: () => (__caplets_assert_active_id(capletId), __caplets_invoke_json(capletId, 'inspect', [])),",
    "  check: () => (__caplets_assert_active_id(capletId), __caplets_invoke_json(capletId, 'check', [])),",
    "  tools: (input) => (__caplets_assert_active_id(capletId), __caplets_invoke_json(capletId, 'tools', [input])),",
    "  searchTools: (query, input) => (__caplets_assert_active_id(capletId), __caplets_invoke_json(capletId, 'searchTools', [query, input])),",
    "  describeTool: (name) => (__caplets_assert_active_id(capletId), __caplets_invoke_json(capletId, 'describeTool', [name])),",
    "  callTool: (name, args) => (__caplets_assert_active_id(capletId), __caplets_invoke_json(capletId, 'callTool', [name, args])),",
    "  resources: (input) => (__caplets_assert_active_id(capletId), __caplets_invoke_json(capletId, 'resources', [input])),",
    "  searchResources: (query, input) => (__caplets_assert_active_id(capletId), __caplets_invoke_json(capletId, 'searchResources', [query, input])),",
    "  resourceTemplates: (input) => (__caplets_assert_active_id(capletId), __caplets_invoke_json(capletId, 'resourceTemplates', [input])),",
    "  readResource: (uri) => (__caplets_assert_active_id(capletId), __caplets_invoke_json(capletId, 'readResource', [uri])),",
    "  prompts: (input) => (__caplets_assert_active_id(capletId), __caplets_invoke_json(capletId, 'prompts', [input])),",
    "  searchPrompts: (query, input) => (__caplets_assert_active_id(capletId), __caplets_invoke_json(capletId, 'searchPrompts', [query, input])),",
    "  getPrompt: (name, args) => (__caplets_assert_active_id(capletId), __caplets_invoke_json(capletId, 'getPrompt', [name, args])),",
    "  complete: (input) => (__caplets_assert_active_id(capletId), __caplets_invoke_json(capletId, 'complete', [input])),",
    "}) });",
    "(() => {",
    `  const checkpointToken = ${JSON.stringify(checkpointToken)};`,
    "  const persistBacking = Object.create(null);",
    "  let persistTainted = false;",
    "  const checkpointState = { current: Object.create(null) };",
    "  const ownKeys = Reflect.ownKeys.bind(Reflect);",
    "  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor.bind(Object);",
    "  const defineProperty = Object.defineProperty.bind(Object);",
    "  const getPrototypeOf = Object.getPrototypeOf.bind(Object);",
    "  const reflectGet = Reflect.get.bind(Reflect);",
    "  const reflectSet = Reflect.set.bind(Reflect);",
    "  const reflectDefineProperty = Reflect.defineProperty.bind(Reflect);",
    "  const reflectDeleteProperty = Reflect.deleteProperty.bind(Reflect);",
    "  const reflectSetPrototypeOf = Reflect.setPrototypeOf.bind(Reflect);",
    "  const reflectPreventExtensions = Reflect.preventExtensions.bind(Reflect);",
    "  const reflectGetOwnPropertyDescriptor = Reflect.getOwnPropertyDescriptor.bind(Reflect);",
    "  const reflectOwnKeys = Reflect.ownKeys.bind(Reflect);",
    "  const hasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);",
    "  const objectIds = new WeakMap();",
    "  let nextObjectId = 1;",
    "  const platformBindings = Object.create(null);",
    "  platformBindings.caplets = undefined;",
    "  const isVarLike = (kind) => kind === 'var' || kind === 'function';",
    "  const keyToken = (key) => typeof key === 'symbol' ? `symbol:${String(key)}` : `string:${key}`;",
    "  const valueToken = (value) => {",
    "    const type = typeof value;",
    "    if ((type === 'object' && value !== null) || type === 'function') {",
    "      if (!objectIds.has(value)) objectIds.set(value, nextObjectId++);",
    "      return `${type}:${objectIds.get(value)}`;",
    "    }",
    "    return `${type}:${String(value)}`;",
    "  };",
    "  const descriptorToken = (descriptor) => {",
    "    if (!descriptor) return 'missing';",
    "    return [",
    "      hasOwn(descriptor, 'value') ? 'data' : 'accessor',",
    "      descriptor.writable === true ? 'w' : 'nw',",
    "      descriptor.configurable === true ? 'c' : 'nc',",
    "      descriptor.enumerable === true ? 'e' : 'ne',",
    "      typeof descriptor.get,",
    "      typeof descriptor.set,",
    "    ].join(':');",
    "  };",
    "  const assertToken = (token) => {",
    "    if (token !== checkpointToken) throw new Error('Code Mode persistence checkpoint token is invalid.');",
    "  };",
    "  const readBinding = (name) => {",
    "    if (hasOwn(platformBindings, name)) return platformBindings[name];",
    "    const record = persistBacking[name];",
    "    if (!record || !record.initialized) throw new ReferenceError(`Cannot access '${name}' before initialization`);",
    "    return record.value;",
    "  };",
    "  const writeBinding = (name, value) => {",
    "    if (hasOwn(platformBindings, name)) throw new TypeError(`Cannot assign to read-only binding '${name}'`);",
    "    const record = persistBacking[name];",
    "    if (!record || !record.initialized) throw new ReferenceError(`Cannot access '${name}' before initialization`);",
    "    if (record.kind === 'const') throw new TypeError('Assignment to constant variable.');",
    "    record.value = value;",
    "    return true;",
    "  };",
    "  const initializeBinding = (name, value, kind) => {",
    "    const record = persistBacking[name];",
    "    if (!record) throw new ReferenceError(`${name} is not defined`);",
    "    if (kind === 'function' && isVarLike(record.kind)) {",
    "      record.value = value;",
    "      record.initialized = true;",
    "      return value;",
    "    }",
    "    if (record.kind !== kind || record.initialized) throw new SyntaxError(`Identifier '${name}' has already been declared`);",
    "    record.value = value;",
    "    record.initialized = true;",
    "    return value;",
    "  };",
    "  const exposeBinding = (name, record) => {",
    "    if (hasOwn(globalThis, name)) return;",
    "    const getter = () => readBinding(name);",
    "    const setter = (value) => { writeBinding(name, value); };",
    "    defineProperty(globalThis, name, { configurable: false, enumerable: true, get: getter, set: setter });",
    "    record.globalGetter = getter;",
    "    record.globalSetter = setter;",
    "  };",
    "  const predeclare = (entries) => {",
    "    const planned = new Map();",
    "    for (const entry of entries) {",
    "      if (entry.name === 'caplets' || entry.name === 'globalThis') throw new SyntaxError(`Identifier '${entry.name}' is reserved by Code Mode`);",
    "      const prior = planned.get(entry.name) ?? persistBacking[entry.name];",
    "      if (prior && !(isVarLike(prior.kind) && isVarLike(entry.kind))) {",
    "        throw new SyntaxError(`Identifier '${entry.name}' has already been declared`);",
    "      }",
    "      if (!prior) planned.set(entry.name, { kind: entry.kind });",
    "    }",
    "    for (const entry of entries) {",
    "      if (hasOwn(persistBacking, entry.name)) continue;",
    "      const record = {",
    "        kind: entry.kind,",
    "        initialized: isVarLike(entry.kind),",
    "        value: undefined,",
    "        globalGetter: undefined,",
    "        globalSetter: undefined,",
    "      };",
    "      defineProperty(persistBacking, entry.name, { value: record, writable: true, configurable: true, enumerable: true });",
    "      exposeBinding(entry.name, record);",
    "    }",
    "  };",
    "  const scopeProxy = new Proxy(Object.create(null), {",
    "    has(_target, key) {",
    "      if (key === Symbol.unscopables) return false;",
    "      if (typeof key !== 'string') return false;",
    "      if (hasOwn(platformBindings, key)) return true;",
    "      const record = persistBacking[key];",
    "      return Boolean(record && !record.globalGetter);",
    "    },",
    "    get(_target, key) {",
    "      if (key === Symbol.unscopables) return undefined;",
    "      if (typeof key !== 'string') return undefined;",
    "      return readBinding(key);",
    "    },",
    "    set(_target, key, value) {",
    "      if (typeof key !== 'string') return false;",
    "      return writeBinding(key, value);",
    "    },",
    "  });",
    "  const persistProxy = new Proxy(persistBacking, {",
    "    get(target, key, receiver) { persistTainted = true; return reflectGet(target, key, receiver); },",
    "    set(target, key, value, receiver) { persistTainted = true; return reflectSet(target, key, value, receiver); },",
    "    defineProperty(target, key, descriptor) { persistTainted = true; return reflectDefineProperty(target, key, descriptor); },",
    "    deleteProperty(target, key) { persistTainted = true; return reflectDeleteProperty(target, key); },",
    "    setPrototypeOf(target, prototype) { persistTainted = true; return reflectSetPrototypeOf(target, prototype); },",
    "    preventExtensions(target) { persistTainted = true; return reflectPreventExtensions(target); },",
    "    getOwnPropertyDescriptor(target, key) { persistTainted = true; return reflectGetOwnPropertyDescriptor(target, key); },",
    "    ownKeys(target) { persistTainted = true; return reflectOwnKeys(target); },",
    "    getPrototypeOf(target) { persistTainted = true; return getPrototypeOf(target); },",
    "  });",
    "  Object.defineProperty(globalThis, '__caplets_persist', { configurable: false, writable: false, value: persistProxy });",
    "  Object.defineProperty(globalThis, '__caplets_get_session_scope', { configurable: false, writable: false, value: (token) => { assertToken(token); return scopeProxy; } });",
    "  Object.defineProperty(globalThis, '__caplets_predeclare', { configurable: false, writable: false, value: (token, entries) => { assertToken(token); predeclare(entries); } });",
    "  Object.defineProperty(globalThis, '__caplets_initialize_binding', { configurable: false, writable: false, value: (token, name, value, kind) => { assertToken(token); return initializeBinding(name, value, kind); } });",
    "  Object.defineProperty(globalThis, '__caplets_initialization_target', { configurable: false, writable: false, value: (token, kind) => {",
    "    assertToken(token);",
    "    return new Proxy(Object.create(null), { set(_target, name, value) { if (typeof name !== 'string') return false; initializeBinding(name, value, kind); return true; } });",
    "  } });",
    "  Object.defineProperty(globalThis, '__caplets_settle_failed_declarations', { configurable: false, writable: false, value: (token, names) => {",
    "    assertToken(token);",
    "    for (const name of names) {",
    "      const record = persistBacking[name];",
    "      if (!record || record.initialized) continue;",
    "      record.initialized = true;",
    "      record.value = undefined;",
    "      if (record.kind === 'const' || record.kind === 'class') record.kind = 'let';",
    "    }",
    "  } });",
    "  Object.defineProperty(globalThis, '__caplets_set_cell_caplets', { configurable: false, writable: false, value: (token, value) => { assertToken(token); platformBindings.caplets = value; } });",
    "  Object.defineProperty(globalThis, '__caplets_existing_persist_names', { configurable: false, writable: false, value: (token, names) => { assertToken(token); return names.filter((name) => hasOwn(persistBacking, name)); } });",
    "  Object.defineProperty(globalThis, '__caplets_get_persist', { configurable: false, writable: false, value: (token, name) => { assertToken(token); return readBinding(name); } });",
    "  Object.defineProperty(globalThis, '__caplets_set_persist', { configurable: false, writable: false, value: (token, name, value) => { assertToken(token); const record = persistBacking[name]; if (!record) throw new ReferenceError(`${name} is not defined`); record.value = value; record.initialized = true; return value; } });",
    "  Object.defineProperty(globalThis, '__caplets_persist_is_tainted', { configurable: false, writable: false, value: (token) => { assertToken(token); return persistTainted; } });",
    "  Object.defineProperty(globalThis, '__caplets_persist_global_descriptors_ok', { configurable: false, writable: false, value: (token, names) => {",
    "    assertToken(token);",
    "    for (const name of names) {",
    "      const record = persistBacking[name];",
    "      if (!record || !record.globalGetter) continue;",
    "      const descriptor = getOwnPropertyDescriptor(globalThis, name);",
    "      if (!descriptor || descriptor.get !== record.globalGetter || descriptor.set !== record.globalSetter || descriptor.configurable !== false) return false;",
    "    }",
    "    return true;",
    "  } });",
    "  Object.defineProperty(globalThis, '__caplets_persist_descriptor_fingerprint', { configurable: false, writable: false, value: (allowedNames = []) => {",
    "    const allowed = new Set(allowedNames.map((name) => `string:${name}`));",
    "    const prototype = getPrototypeOf(persistBacking);",
    "    const keys = ownKeys(persistBacking).map((key) => keyToken(key)).filter((token) => !allowed.has(token)).sort();",
    "    return keys.map((token) => {",
    "      const key = token.startsWith('symbol:') ? ownKeys(persistBacking).find((candidate) => keyToken(candidate) === token) : token.slice('string:'.length);",
    "      const descriptor = getOwnPropertyDescriptor(persistBacking, key);",
    "      const value = descriptor && hasOwn(descriptor, 'value') ? valueToken(descriptor.value) : 'accessor';",
    "      return `${token}:${descriptorToken(descriptor)}:${value}`;",
    "    }).concat(`[[Prototype]]:${valueToken(prototype)}`).join('|');",
    "  } });",
    "  Object.defineProperty(globalThis, '__caplets_persist_descriptors_ok', { configurable: false, writable: false, value: (token, names) => {",
    "    assertToken(token);",
    "    if (getPrototypeOf(persistBacking) !== null) return false;",
    "    for (const name of names) {",
    "      const descriptor = getOwnPropertyDescriptor(persistBacking, name);",
    "      if (!descriptor || !hasOwn(descriptor, 'value')) return false;",
    "      if (descriptor.get || descriptor.set || descriptor.writable !== true || descriptor.configurable !== true) return false;",
    "    }",
    "    return true;",
    "  } });",
    "  Object.defineProperty(globalThis, '__caplets_snapshot_persist', { configurable: false, writable: false, value: (token, names) => {",
    "    assertToken(token);",
    "    const next = Object.create(null);",
    "    for (const name of names) {",
    "      try { next[name] = readBinding(name); }",
    "      catch { next[name] = undefined; }",
    "    }",
    "    checkpointState.current = next;",
    "  } });",
    "  Object.defineProperty(globalThis, '__caplets_checkpoint_value', { configurable: false, writable: false, value: (token, name) => {",
    "    assertToken(token);",
    "    return checkpointState.current[name];",
    "  } });",
    "})();",
    "Object.defineProperty(globalThis, '__caplets_json_parse', { configurable: false, writable: false, value: JSON.parse.bind(JSON) });",
  ].join("\n");
}

function buildBridgeRefreshSource(_capletIds: string[], _previousCapletIds: string[] = []): string {
  return "";
}

type PersistentBindingKind = "var" | "let" | "const" | "function" | "class";

type PersistentBindingDeclaration = {
  name: string;
  kind: PersistentBindingKind;
};

type PersistentRewriteRange = {
  start: number;
  end: number;
  body: string;
};

function buildSessionCellSource(
  code: string,
  capletIds: string[],
  existingNames: string[] = [],
  checkpointToken = "",
): { source: string; persistentNames: string[]; newNames: string[]; snapshotNames: string[] } {
  const javascript = ts.transpileModule(code, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    },
  }).outputText;
  const split = splitPersistentDeclarations(javascript, existingNames, checkpointToken);
  const serializedToken = JSON.stringify(checkpointToken);
  return {
    source: [
      `globalThis.__caplets_predeclare(${serializedToken}, ${JSON.stringify(split.declarations)});`,
      "(function (__caplets_scope) {",
      "  with (__caplets_scope) {",
      "    return (async () => {",
      '"use strict";',
      buildPlatformResetSource(),
      buildSessionCapletsSource(capletIds, checkpointToken),
      split.prelude,
      split.body,
      "    })();",
      "  }",
      `})(globalThis.__caplets_get_session_scope(${serializedToken}))`,
    ].join("\n"),
    persistentNames: split.persistentNames,
    newNames: split.newNames,
    snapshotNames: split.persistentNames,
  };
}

function buildPlatformResetSource(): string {
  return "globalThis.__caplets_restore_platform();";
}

function buildSessionCapletsSource(capletIds: string[], checkpointToken: string): string {
  return [
    `globalThis.__caplets_set_cell_caplets(${JSON.stringify(checkpointToken)}, (() => {`,
    "  const handles = {};",
    ...capletIds.map(
      (capletId) =>
        `  handles[${JSON.stringify(capletId)}] = globalThis.__caplets_handle(${JSON.stringify(capletId)});`,
    ),
    "  handles.debug = handles.debug ?? {};",
    "  handles.debug.readLogs = (input) => globalThis.__caplets_invoke_json('debug', 'readLogs', [input]);",
    "  handles.debug.readRecovery = (input) => globalThis.__caplets_invoke_json('debug', 'readRecovery', [input]);",
    "  return handles;",
    "})());",
  ].join("\n");
}

function splitPersistentDeclarations(
  javascript: string,
  existingNames: string[] = [],
  checkpointToken = "",
): {
  prelude: string;
  body: string;
  declarations: PersistentBindingDeclaration[];
  persistentNames: string[];
  newNames: string[];
} {
  const source = ts.createSourceFile(
    "/caplets-code-mode/session-cell.js",
    javascript,
    ts.ScriptTarget.ES2022,
    true,
  );
  const declarations: PersistentBindingDeclaration[] = [];
  const ranges: PersistentRewriteRange[] = [];
  const functionInitializers: string[] = [];
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      const kind = declarationKind(statement.declarationList);
      for (const name of declarationListBindingNames(statement.declarationList)) {
        declarations.push({ name, kind });
      }
      ranges.push({
        start: statement.getFullStart(),
        end: statement.end,
        body:
          kind === "var"
            ? varStatementAssignments(statement.declarationList, source)
            : lexicalDeclarationInitializers(
                statement.declarationList,
                source,
                kind,
                checkpointToken,
              ),
      });
      continue;
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      declarations.push({ name: statement.name.text, kind: "function" });
      functionInitializers.push(
        persistentBindingInitializer(
          statement.name.text,
          `(${statement.getText(source)})`,
          "function",
          checkpointToken,
        ),
      );
      ranges.push({ start: statement.getFullStart(), end: statement.end, body: "" });
      continue;
    }
    if (ts.isClassDeclaration(statement) && statement.name) {
      declarations.push({ name: statement.name.text, kind: "class" });
      ranges.push({
        start: statement.getFullStart(),
        end: statement.end,
        body: persistentBindingInitializer(
          statement.name.text,
          `(${statement.getText(source)})`,
          "class",
          checkpointToken,
        ),
      });
      continue;
    }
    collectPersistentVarRewrites(statement, source, declarations, ranges);
  }
  ranges.sort((left, right) => left.start - right.start);
  let body = "";
  let cursor = 0;
  for (const range of ranges) {
    body += javascript.slice(cursor, range.start);
    body += range.body;
    cursor = range.end;
  }
  body += javascript.slice(cursor);
  const declaredNames = declarations.map(({ name }) => name);
  const persistentNames = [...new Set([...existingNames, ...declaredNames])];
  return {
    prelude: functionInitializers.join("\n"),
    body,
    declarations,
    persistentNames,
    newNames: declaredNames.filter((name) => !existingNames.includes(name)),
  };
}

function declarationKind(declarationList: ts.VariableDeclarationList): "var" | "let" | "const" {
  if (isVarDeclarationList(declarationList)) return "var";
  return (ts.getCombinedNodeFlags(declarationList) & ts.NodeFlags.Const) !== 0 ? "const" : "let";
}

function lexicalDeclarationInitializers(
  declarationList: ts.VariableDeclarationList,
  source: ts.SourceFile,
  kind: "let" | "const",
  checkpointToken: string,
): string {
  return declarationList.declarations
    .map((declaration) => {
      const initializer = declaration.initializer?.getText(source) ?? "void 0";
      if (ts.isIdentifier(declaration.name)) {
        return persistentBindingInitializer(
          declaration.name.text,
          initializer,
          kind,
          checkpointToken,
        );
      }
      return `(${initializationAssignmentTarget(declaration.name, source, kind, checkpointToken)} = ${initializer});`;
    })
    .join("\n");
}

function persistentBindingInitializer(
  name: string,
  initializer: string,
  kind: Exclude<PersistentBindingKind, "var">,
  checkpointToken: string,
): string {
  return `globalThis.__caplets_initialize_binding(${JSON.stringify(checkpointToken)}, ${JSON.stringify(name)}, ${initializer}, ${JSON.stringify(kind)});`;
}

function initializationAssignmentTarget(
  name: ts.BindingName,
  source: ts.SourceFile,
  kind: "let" | "const",
  checkpointToken: string,
): string {
  if (ts.isIdentifier(name)) {
    return `globalThis.__caplets_initialization_target(${JSON.stringify(checkpointToken)}, ${JSON.stringify(kind)})[${JSON.stringify(name.text)}]`;
  }
  if (ts.isObjectBindingPattern(name)) {
    return `{ ${name.elements
      .map((element) => {
        const target = initializationAssignmentTarget(element.name, source, kind, checkpointToken);
        if (element.dotDotDotToken) return `...${target}`;
        const propertyName = element.propertyName?.getText(source) ?? bindingNames(element.name)[0];
        const initializer = element.initializer ? ` = ${element.initializer.getText(source)}` : "";
        return `${propertyName}: ${target}${initializer}`;
      })
      .join(", ")} }`;
  }
  return `[${name.elements
    .map((element) => {
      if (ts.isOmittedExpression(element)) return "";
      const target = initializationAssignmentTarget(element.name, source, kind, checkpointToken);
      const initializer = element.initializer ? ` = ${element.initializer.getText(source)}` : "";
      return `${element.dotDotDotToken ? "..." : ""}${target}${initializer}`;
    })
    .join(", ")}]`;
}

function collectPersistentVarRewrites(
  node: ts.Node,
  source: ts.SourceFile,
  declarations: PersistentBindingDeclaration[],
  ranges: PersistentRewriteRange[],
): void {
  if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
  if (ts.isVariableStatement(node) && isVarDeclarationList(node.declarationList)) {
    for (const name of declarationListBindingNames(node.declarationList)) {
      declarations.push({ name, kind: "var" });
    }
    ranges.push({
      start: node.getFullStart(),
      end: node.end,
      body: varStatementAssignments(node.declarationList, source),
    });
    return;
  }
  if (
    (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
    node.initializer &&
    ts.isVariableDeclarationList(node.initializer) &&
    isVarDeclarationList(node.initializer)
  ) {
    for (const name of declarationListBindingNames(node.initializer)) {
      declarations.push({ name, kind: "var" });
    }
    ranges.push({
      start: node.initializer.getStart(source),
      end: node.initializer.end,
      body: forInitializerAssignment(node.initializer, source),
    });
  }
  ts.forEachChild(node, (child) =>
    collectPersistentVarRewrites(child, source, declarations, ranges),
  );
}

function isVarDeclarationList(declarationList: ts.VariableDeclarationList): boolean {
  return (ts.getCombinedNodeFlags(declarationList) & ts.NodeFlags.BlockScoped) === 0;
}

function declarationListBindingNames(declarationList: ts.VariableDeclarationList): string[] {
  return declarationList.declarations.flatMap((declaration) => bindingNames(declaration.name));
}

function varStatementAssignments(
  declarationList: ts.VariableDeclarationList,
  source: ts.SourceFile,
): string {
  return declarationList.declarations
    .map((declaration) =>
      declaration.initializer
        ? assignmentStatement(declaration.name, declaration.initializer, source)
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

function forInitializerAssignment(
  declarationList: ts.VariableDeclarationList,
  source: ts.SourceFile,
): string {
  const assignments = declarationList.declarations.map((declaration) =>
    declaration.initializer
      ? assignmentExpression(declaration.name, declaration.initializer, source)
      : declaration.name.getText(source),
  );
  return assignments.join(", ");
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) {
    return [name.text];
  }
  return name.elements.flatMap((element) => {
    if (ts.isOmittedExpression(element)) {
      return [];
    }
    return bindingNames(element.name);
  });
}

function assignmentStatement(
  name: ts.BindingName,
  initializer: ts.Expression,
  source: ts.SourceFile,
): string {
  const expression = assignmentExpression(name, initializer, source);
  return ts.isObjectBindingPattern(name) ? `(${expression});` : `${expression};`;
}

function assignmentExpression(
  name: ts.BindingName,
  initializer: ts.Expression,
  source: ts.SourceFile,
): string {
  return `${name.getText(source)} = ${initializer.getText(source)}`;
}

function buildPromiseObserverSource(): string {
  return [
    "(() => {",
    "  const then = Promise.prototype.then;",
    "  const formatError = function(e) {",
    "    if (e && typeof e === 'object' && typeof e.message === 'string') return e.message;",
    "    return String(e);",
    "  };",
    "  try { Object.defineProperty(globalThis, '__caplets_observe_promise', { configurable: false, writable: false, value: function(p) {",
    "    var s = { settled: false, value: void 0, error: void 0 };",
    "    then.call(p, function(value) { s.value = value; s.settled = true; },",
    "                function(error) { s.error = formatError(error); s.settled = true; });",
    "    return s;",
    "  } }); } catch {}",
    "})()",
  ].join("\n");
}

function buildPromiseStateSource(resultName: string): string {
  return [`globalThis.__caplets_observe_promise(globalThis[${resultName}])`].join("\n");
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

function isTimeoutMessage(message: string, timeoutMs: number): boolean {
  return message === timeoutMessage(timeoutMs);
}

function normalizeError(error: unknown, deadlineMs: number, timeoutMs: number): string {
  const message = errorMessage(error);
  return Date.now() >= deadlineMs && /\binterrupted\b/iu.test(message)
    ? timeoutMessage(timeoutMs)
    : message;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return String(error);
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
