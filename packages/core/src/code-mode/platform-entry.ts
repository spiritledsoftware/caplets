declare function __caplets_log(level: string, message: string): void;

const DISABLED_FETCH_MESSAGE = "fetch is disabled in Code Mode";

function formatLogArg(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatLogLine(args: unknown[]): string {
  return args.map(formatLogArg).join(" ");
}

const platformConsole = {
  log: (...args: unknown[]) => __caplets_log("log", formatLogLine(args)),
  info: (...args: unknown[]) => __caplets_log("info", formatLogLine(args)),
  warn: (...args: unknown[]) => __caplets_log("warn", formatLogLine(args)),
  error: (...args: unknown[]) => __caplets_log("error", formatLogLine(args)),
  debug: (...args: unknown[]) => __caplets_log("debug", formatLogLine(args)),
};

function disabledFetch(): never {
  throw new Error(DISABLED_FETCH_MESSAGE);
}

Object.defineProperties(globalThis, {
  console: {
    value: platformConsole,
    configurable: true,
    enumerable: true,
    writable: true,
  },
  fetch: {
    value: disabledFetch,
    configurable: true,
    enumerable: true,
    writable: true,
  },
});
