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
      this.#snapshotPersistentNames([...this.#persistentNames]);
      let pendingInvokePersistentValuesChanged = false;
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
        afterPendingInvokesDrained: () => {
          pendingInvokePersistentValuesChanged = this.#persistentValuesDivergedFromPersist(
            cell.persistentNames,
          );
          this.#snapshotPersistentNames(cell.persistentNames);
        },
      });
      if (result.ok) {
        for (const name of cell.persistentNames) {
          this.#persistentNames.add(name);
        }
        this.#snapshotPersistentNames(cell.persistentNames);
      } else {
        this.#restorePersistentNames([...this.#persistentNames]);
        this.#rollbackNewPersistentNames(cell.newNames);
      }
      const platformRestored = result.ok ? this.#restorePlatformAfterRun() : true;
      const persistenceDescriptorsOk =
        result.ok && platformRestored ? this.#persistentDescriptorsOk(cell.persistentNames) : true;
      const persistentGlobalDescriptorsOk = this.#persistentGlobalDescriptorsOk(
        result.ok ? cell.persistentNames : [...this.#persistentNames],
      );
      const hasGlobalNameAdditions = this.#hasGlobalNameAdditions(
        result.ok ? cell.persistentNames : [],
      );
      const directPersistAccess = this.#isPersistTainted();
      const persistDescriptorsChanged = this.#persistDescriptorsChanged(
        result.ok ? cell.snapshotNames : [],
      );
      const hasObjectLikePersistentState = this.#hasObjectLikePersistentState();
      shouldDispose = result.ok
        ? pendingInvokePersistentValuesChanged ||
          this.#pendingDeferreds.size > 0 ||
          hasGlobalNameAdditions ||
          directPersistAccess ||
          persistDescriptorsChanged ||
          !this.#isGlobalExtensible() ||
          !persistentGlobalDescriptorsOk ||
          !persistenceDescriptorsOk ||
          !platformRestored
        : isTimeoutMessage(result.error, timeoutMs) ||
          this.#pendingDeferreds.size > 0 ||
          cell.newNames.length > 0 ||
          hasGlobalNameAdditions ||
          directPersistAccess ||
          persistDescriptorsChanged ||
          hasObjectLikePersistentState ||
          !persistentGlobalDescriptorsOk ||
          !this.#isGlobalExtensible();
      if (!shouldDispose) {
        this.#clearPendingDeferreds();
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

  #rollbackNewPersistentNames(names: string[]): void {
    if (names.length === 0 || this.#disposed) {
      return;
    }
    const result = this.#context.evalCode(
      names.map((name) => `(0, eval)(${JSON.stringify(`${name} = undefined;`)});`).join("\n"),
    );
    if (result.error) {
      result.error.dispose();
      return;
    }
    result.value.dispose();
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

  #hasObjectLikePersistentState(): boolean {
    if (this.#disposed || this.#persistentNames.size === 0) {
      return false;
    }
    const result = this.#context.evalCode(
      `__caplets_persist_has_object_like_values(${JSON.stringify(this.#checkpointToken)}, ${JSON.stringify([...this.#persistentNames])})`,
    );
    if (result.error) {
      result.error.dispose();
      return true;
    }
    const hasObjectLike = this.#context.dump(result.value) === true;
    result.value.dispose();
    return hasObjectLike;
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
      name === "string:__caplets_persist_descriptor_fingerprint" ||
      name === "string:__caplets_persist_descriptors_ok" ||
      name === "string:__caplets_persist_is_tainted" ||
      name === "string:__caplets_persist_has_object_like_values" ||
      name === "string:__caplets_persist_global_descriptors_ok" ||
      name === "string:__caplets_get_persist" ||
      name === "string:__caplets_set_persist" ||
      name === "string:__caplets_snapshot_persist" ||
      name === "string:__caplets_checkpoint_value" ||
      name === "string:__caplets_observe_promise" ||
      name === "string:__caplets_json_parse"
    );
  }

  #snapshotPersistentNames(names: string[]): void {
    if (names.length === 0 || this.#disposed) {
      return;
    }
    const result = this.#context.evalCode(
      `globalThis.__caplets_snapshot_persist(${JSON.stringify(this.#checkpointToken)}, ${JSON.stringify(names)});`,
    );
    if (result.error) {
      result.error.dispose();
      return;
    }
    result.value.dispose();
  }

  #persistentValuesDivergedFromPersist(names: string[]): boolean {
    if (this.#disposed || names.length === 0) {
      return false;
    }
    const result = this.#context.evalCode(
      `(${JSON.stringify(names)}).some((name) => !Object.is((0, eval)(name), globalThis.__caplets_get_persist(${JSON.stringify(this.#checkpointToken)}, name)))`,
    );
    if (result.error) {
      result.error.dispose();
      return true;
    }
    try {
      return this.#context.dump(result.value) === true;
    } finally {
      result.value.dispose();
    }
  }

  #restorePersistentNames(names: string[]): void {
    if (names.length === 0 || this.#disposed) {
      return;
    }
    const result = this.#context.evalCode(
      names
        .map((name) =>
          [
            `globalThis.__caplets_set_persist(${JSON.stringify(this.#checkpointToken)}, ${JSON.stringify(name)}, globalThis.__caplets_checkpoint_value(${JSON.stringify(this.#checkpointToken)}, ${JSON.stringify(name)}));`,
            `(0, eval)(${JSON.stringify(`${name} = globalThis.__caplets_checkpoint_value(${JSON.stringify(this.#checkpointToken)}, ${JSON.stringify(name)});`)});`,
          ].join("\n"),
        )
        .join("\n"),
    );
    if (result.error) {
      result.error.dispose();
      return;
    }
    result.value.dispose();
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
    "  Object.defineProperty(globalThis, '__caplets_get_persist', { configurable: false, writable: false, value: (token, name) => {",
    "    assertToken(token);",
    "    return hasOwn(persistBacking, name) ? persistBacking[name] : undefined;",
    "  } });",
    "  Object.defineProperty(globalThis, '__caplets_set_persist', { configurable: false, writable: false, value: (token, name, value) => {",
    "    assertToken(token);",
    "    defineProperty(persistBacking, name, { value, writable: true, configurable: true, enumerable: true });",
    "    return value;",
    "  } });",
    "  Object.defineProperty(globalThis, '__caplets_persist_is_tainted', { configurable: false, writable: false, value: (token) => {",
    "    assertToken(token);",
    "    return persistTainted;",
    "  } });",
    "  Object.defineProperty(globalThis, '__caplets_persist_has_object_like_values', { configurable: false, writable: false, value: (token, names) => {",
    "    assertToken(token);",
    "    for (const name of names) {",
    "      if (!hasOwn(persistBacking, name)) continue;",
    "      const value = persistBacking[name];",
    "      if ((typeof value === 'object' && value !== null) || typeof value === 'function') return true;",
    "    }",
    "    return false;",
    "  } });",
    "  Object.defineProperty(globalThis, '__caplets_persist_global_descriptors_ok', { configurable: false, writable: false, value: (token, names) => {",
    "    assertToken(token);",
    "    for (const name of names) {",
    "      const descriptor = getOwnPropertyDescriptor(globalThis, name);",
    "      if (!descriptor || !hasOwn(descriptor, 'value') || descriptor.writable !== true) return false;",
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
    "      try { next[name] = (0, eval)(name); }",
    "      catch { next[name] = hasOwn(globalThis, name) ? globalThis[name] : hasOwn(persistBacking, name) ? persistBacking[name] : undefined; }",
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
  const split = splitPersistentPrelude(javascript, existingNames, checkpointToken);
  return {
    source: [
      split.prelude,
      "(async () => {",
      '"use strict";',
      buildPlatformResetSource(),
      buildPlatformShadowRestoreSource(existingNames, checkpointToken),
      buildCellCapletsSource(capletIds),
      split.body,
      split.postlude,
      "})()",
    ].join("\n"),
    persistentNames: split.persistentNames,
    newNames: split.newNames,
    snapshotNames: split.snapshotNames,
  };
}

function buildPlatformResetSource(): string {
  return "globalThis.__caplets_restore_platform();";
}

function buildPlatformShadowRestoreSource(
  existingNames: string[],
  checkpointToken: string,
): string {
  return existingNames
    .map(
      (name) =>
        `(0, eval)(${JSON.stringify(`${name} = globalThis.__caplets_get_persist(${JSON.stringify(checkpointToken)}, ${JSON.stringify(name)});`)});`,
    )
    .join("\n");
}

function buildCellCapletsSource(capletIds: string[]): string {
  return [
    "const caplets = {};",
    ...capletIds.map(
      (capletId) =>
        `caplets[${JSON.stringify(capletId)}] = __caplets_handle(${JSON.stringify(capletId)});`,
    ),
    "caplets.debug = caplets.debug ?? {};",
    "caplets.debug.readLogs = (input) => __caplets_invoke_json('debug', 'readLogs', [input]);",
    "caplets.debug.readRecovery = (input) => __caplets_invoke_json('debug', 'readRecovery', [input]);",
  ].join("\n");
}

function splitPersistentPrelude(
  javascript: string,
  existingNames: string[] = [],
  checkpointToken = "",
): {
  prelude: string;
  body: string;
  postlude: string;
  persistentNames: string[];
  newNames: string[];
  snapshotNames: string[];
} {
  const source = ts.createSourceFile(
    "/caplets-code-mode/session-cell.js",
    javascript,
    ts.ScriptTarget.ES2022,
    true,
  );
  const ranges: Array<{ start: number; end: number; prelude: string; body: string }> = [];
  const names = collectPersistentBindingNames(source);
  const lexicalNames = collectTopLevelLexicalBindingNames(source);
  const allNames = [...new Set([...existingNames, ...names])];
  const snapshotNames = allNames.filter((name) => !lexicalNames.has(name));
  const returnTempName = uniqueInternalName("__caplets_return", allNames);
  const postlude = snapshotNames
    .map((name) => persistentBindingPostlude(name, checkpointToken))
    .join("\n");
  for (const statement of source.statements) {
    collectPersistentVarRewriteRanges(statement, source, lexicalNames, ranges);
    collectPersistentReturnRanges(
      statement,
      source,
      snapshotNames,
      ranges,
      returnTempName,
      checkpointToken,
    );
    collectPersistentFinallyRanges(statement, snapshotNames, ranges, checkpointToken);
  }
  ranges.sort((left, right) => left.start - right.start);
  const prelude = [
    ...allNames.map(
      (name) =>
        `var ${name} = globalThis.__caplets_get_persist(${JSON.stringify(checkpointToken)}, ${JSON.stringify(name)});`,
    ),
    ...ranges.map((range) => range.prelude),
  ]
    .filter(Boolean)
    .join("\n");
  let body = "";
  let cursor = 0;
  for (const range of ranges) {
    body += javascript.slice(cursor, range.start);
    body += range.body;
    cursor = range.end;
  }
  body += javascript.slice(cursor);
  if (postlude) {
    body += `\n${postlude}`;
  }
  return {
    prelude,
    body,
    postlude,
    persistentNames: allNames,
    newNames: names.filter((name) => !existingNames.includes(name)),
    snapshotNames,
  };
}

function collectPersistentReturnRanges(
  node: ts.Node,
  source: ts.SourceFile,
  snapshotNames: string[],
  ranges: Array<{ start: number; end: number; prelude: string; body: string }>,
  returnTempName: string,
  checkpointToken: string,
  shadowedNames: ReadonlySet<string> = new Set(),
): void {
  if (snapshotNames.length === 0) {
    return;
  }
  if (ts.isFunctionLike(node) || ts.isClassLike(node)) {
    return;
  }
  const declared = lexicalNamesDeclaredByNode(node);
  const activeShadowedNames =
    declared.size === 0 ? shadowedNames : new Set([...shadowedNames, ...declared]);
  if (ts.isReturnStatement(node)) {
    const expression = node.expression?.getText(source);
    const postludeExpression = snapshotNames
      .filter((name) => !activeShadowedNames.has(name))
      .map((name) => persistentBindingExpression(name, checkpointToken))
      .join(", ");
    ranges.push({
      start: node.getFullStart(),
      end: node.end,
      prelude: "",
      body: returnWithPersistenceExpression(expression, postludeExpression, returnTempName),
    });
    return;
  }
  ts.forEachChild(node, (child) =>
    collectPersistentReturnRanges(
      child,
      source,
      snapshotNames,
      ranges,
      returnTempName,
      checkpointToken,
      activeShadowedNames,
    ),
  );
}

function lexicalNamesDeclaredByNode(node: ts.Node): Set<string> {
  const names = new Set<string>();
  if (ts.isBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
    for (const statement of node.statements) {
      if (ts.isVariableStatement(statement) && !isVarDeclarationList(statement.declarationList)) {
        for (const name of declarationListBindingNames(statement.declarationList)) {
          names.add(name);
        }
      }
      if ((ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
        names.add(statement.name.text);
      }
      if (ts.isFunctionDeclaration(statement) && statement.name) {
        names.add(statement.name.text);
      }
    }
  }
  if (ts.isSwitchStatement(node)) {
    for (const clause of node.caseBlock.clauses) {
      for (const statement of clause.statements) {
        if (ts.isVariableStatement(statement) && !isVarDeclarationList(statement.declarationList)) {
          for (const name of declarationListBindingNames(statement.declarationList)) {
            names.add(name);
          }
        }
        if (
          (ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) &&
          statement.name
        ) {
          names.add(statement.name.text);
        }
        if (ts.isFunctionDeclaration(statement) && statement.name) {
          names.add(statement.name.text);
        }
      }
    }
  }
  if (ts.isCatchClause(node) && node.variableDeclaration) {
    for (const name of bindingNames(node.variableDeclaration.name)) {
      names.add(name);
    }
  }
  if (
    (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
    node.initializer &&
    ts.isVariableDeclarationList(node.initializer) &&
    !isVarDeclarationList(node.initializer)
  ) {
    for (const name of declarationListBindingNames(node.initializer)) {
      names.add(name);
    }
  }
  return names;
}

function returnWithPersistenceExpression(
  expression: string | undefined,
  postludeExpression: string,
  returnTempName: string,
): string {
  if (!postludeExpression) {
    return expression ? `return ${expression};` : "return;";
  }
  return expression
    ? `return (async (${returnTempName}) => { await Promise.resolve(); ${postludeExpression}; return ${returnTempName}; })((${expression}));`
    : `await Promise.resolve();\nreturn void (${postludeExpression});`;
}

function uniqueInternalName(baseName: string, unavailableNames: string[]): string {
  const unavailable = new Set(unavailableNames);
  let name = baseName;
  while (unavailable.has(name)) {
    name = `_${name}`;
  }
  return name;
}

function collectPersistentVarRewriteRanges(
  node: ts.Node,
  source: ts.SourceFile,
  lexicalNames: ReadonlySet<string>,
  ranges: Array<{ start: number; end: number; prelude: string; body: string }>,
): void {
  if (ts.isFunctionLike(node) || ts.isClassLike(node)) {
    return;
  }
  if (ts.isVariableStatement(node) && isVarDeclarationList(node.declarationList)) {
    const names = declarationListBindingNames(node.declarationList);
    if (!names.some((name) => lexicalNames.has(name))) {
      ranges.push({
        start: node.getFullStart(),
        end: node.end,
        prelude: "",
        body: varStatementAssignments(node.declarationList, source),
      });
    }
    return;
  }
  if (
    (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
    node.initializer &&
    ts.isVariableDeclarationList(node.initializer) &&
    isVarDeclarationList(node.initializer)
  ) {
    const names = declarationListBindingNames(node.initializer);
    if (!names.some((name) => lexicalNames.has(name))) {
      ranges.push({
        start: node.initializer.getStart(source),
        end: node.initializer.end,
        prelude: "",
        body: forInitializerAssignment(node.initializer, source),
      });
    }
  }
  ts.forEachChild(node, (child) =>
    collectPersistentVarRewriteRanges(child, source, lexicalNames, ranges),
  );
}

function collectPersistentFinallyRanges(
  node: ts.Node,
  snapshotNames: string[],
  ranges: Array<{ start: number; end: number; prelude: string; body: string }>,
  checkpointToken: string,
  shadowedNames: ReadonlySet<string> = new Set(),
): void {
  if (snapshotNames.length === 0) {
    return;
  }
  if (ts.isFunctionLike(node) || ts.isClassLike(node)) {
    return;
  }
  const declared = lexicalNamesDeclaredByNode(node);
  const activeShadowedNames =
    declared.size === 0 ? shadowedNames : new Set([...shadowedNames, ...declared]);
  if (ts.isTryStatement(node) && node.finallyBlock) {
    const finallyDeclared = lexicalNamesDeclaredByNode(node.finallyBlock);
    const finallyShadowedNames =
      finallyDeclared.size === 0
        ? activeShadowedNames
        : new Set([...activeShadowedNames, ...finallyDeclared]);
    const postlude = snapshotNames
      .filter((name) => !finallyShadowedNames.has(name))
      .map((name) => persistentBindingPostlude(name, checkpointToken))
      .join("\n");
    if (postlude) {
      ranges.push({
        start: node.finallyBlock.end - 1,
        end: node.finallyBlock.end - 1,
        prelude: "",
        body: `\n${postlude}\n`,
      });
    }
  }
  ts.forEachChild(node, (child) =>
    collectPersistentFinallyRanges(
      child,
      snapshotNames,
      ranges,
      checkpointToken,
      activeShadowedNames,
    ),
  );
}

function collectPersistentBindingNames(source: ts.SourceFile): string[] {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.parent === source) {
      names.add(node.name.text);
    }
    if (node !== source && (ts.isFunctionLike(node) || ts.isClassLike(node))) {
      return;
    }
    if (ts.isVariableStatement(node)) {
      collectVarDeclarationListNames(node.declarationList, names);
    }
    if (
      (ts.isForStatement(node) || ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.initializer)
    ) {
      collectVarDeclarationListNames(node.initializer, names);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...names];
}

function collectTopLevelLexicalBindingNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement) && !isVarDeclarationList(statement.declarationList)) {
      for (const name of declarationListBindingNames(statement.declarationList)) {
        names.add(name);
      }
    }
    if ((ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
      names.add(statement.name.text);
    }
  }
  return names;
}

function collectVarDeclarationListNames(
  declarationList: ts.VariableDeclarationList,
  names: Set<string>,
): void {
  const isVar = (ts.getCombinedNodeFlags(declarationList) & ts.NodeFlags.BlockScoped) === 0;
  if (!isVar) {
    return;
  }
  for (const declaration of declarationList.declarations) {
    for (const name of bindingNames(declaration.name)) {
      names.add(name);
    }
  }
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

function persistentBindingPostlude(name: string, checkpointToken: string): string {
  return [
    `globalThis.__caplets_set_persist(${JSON.stringify(checkpointToken)}, ${JSON.stringify(name)}, ${name});`,
    `(0, eval)(${JSON.stringify(`${name} = globalThis.__caplets_get_persist(${JSON.stringify(checkpointToken)}, ${JSON.stringify(name)});`)});`,
  ].join("\n");
}

function persistentBindingExpression(name: string, checkpointToken: string): string {
  return [
    `globalThis.__caplets_set_persist(${JSON.stringify(checkpointToken)}, ${JSON.stringify(name)}, ${name})`,
    `(0, eval)(${JSON.stringify(`${name} = globalThis.__caplets_get_persist(${JSON.stringify(checkpointToken)}, ${JSON.stringify(name)});`)})`,
  ].join(", ");
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
