import { randomBytes, randomUUID } from "node:crypto";
import type { QuickJSContext, QuickJSDeferredPromise, QuickJSHandle } from "quickjs-emscripten";

type PlatformTimer = {
  deferred: QuickJSDeferredPromise;
  timeout: ReturnType<typeof setTimeout>;
};

const MAX_RANDOM_VALUES_BYTES = 65_536;

export type CodeModePlatformHost = {
  dispose(): void;
};

export type CodeModePlatformHostOptions = Record<string, never>;

export function installCodeModePlatformHost(
  context: QuickJSContext,
  pendingDeferreds: Set<QuickJSDeferredPromise>,
  _options: CodeModePlatformHostOptions,
): CodeModePlatformHost {
  const timers = new Map<number, PlatformTimer>();

  const randomUuidBridge = context.newFunction("__caplets_platform_random_uuid", () => {
    const value = context.newString(randomUUID());
    return value;
  });
  context.setProp(context.global, "__caplets_platform_random_uuid", randomUuidBridge);
  randomUuidBridge.dispose();

  const randomValuesBridge = context.newFunction(
    "__caplets_platform_random_values",
    (lengthHandle) => {
      const length = context.dump(lengthHandle);
      if (!Number.isSafeInteger(length) || length < 0) {
        const error = context.newError("Random byte length must be a non-negative safe integer");
        return error;
      }
      if (length > MAX_RANDOM_VALUES_BYTES) {
        return context.newError("Random byte length cannot exceed 65,536 bytes");
      }
      return numberArrayHandle(context, [...randomBytes(length)]);
    },
  );
  context.setProp(context.global, "__caplets_platform_random_values", randomValuesBridge);
  randomValuesBridge.dispose();

  const sleepBridge = context.newFunction(
    "__caplets_platform_sleep",
    (timerIdHandle, delayHandle) => {
      const timerId = context.dump(timerIdHandle);
      const delayMs = context.dump(delayHandle);
      const deferred = context.newPromise();
      pendingDeferreds.add(deferred);
      deferred.settled.finally(() => pendingDeferreds.delete(deferred));

      const timeout = setTimeout(
        () => {
          timers.delete(timerId);
          resolveTimer(context, deferred, true);
        },
        Math.max(0, Number(delayMs) || 0),
      );

      const existing = timers.get(timerId);
      if (existing) {
        clearTimeout(existing.timeout);
        resolveTimer(context, existing.deferred, false);
      }
      timers.set(timerId, { deferred, timeout });

      return deferred.handle;
    },
  );
  context.setProp(context.global, "__caplets_platform_sleep", sleepBridge);
  sleepBridge.dispose();

  const clearTimerBridge = context.newFunction(
    "__caplets_platform_clear_timer",
    (timerIdHandle) => {
      const timerId = context.dump(timerIdHandle);
      const timer = timers.get(timerId);
      if (!timer) {
        return context.false;
      }
      timers.delete(timerId);
      clearTimeout(timer.timeout);
      resolveTimer(context, timer.deferred, false);
      return context.true;
    },
  );
  context.setProp(context.global, "__caplets_platform_clear_timer", clearTimerBridge);
  clearTimerBridge.dispose();

  return {
    dispose() {
      for (const timer of timers.values()) {
        clearTimeout(timer.timeout);
        resolveTimer(context, timer.deferred, false);
      }
      timers.clear();
    },
  };
}

function numberArrayHandle(context: QuickJSContext, values: number[]): QuickJSHandle {
  const arrayHandle = context.newArray();
  for (let index = 0; index < values.length; index += 1) {
    const valueHandle = context.newNumber(values[index] ?? 0);
    context.setProp(arrayHandle, index, valueHandle);
    valueHandle.dispose();
  }
  return arrayHandle;
}

function resolveTimer(
  context: QuickJSContext,
  deferred: QuickJSDeferredPromise,
  fired: boolean,
): void {
  if (!deferred.alive) {
    return;
  }
  deferred.resolve(fired ? context.true : context.false);
}
