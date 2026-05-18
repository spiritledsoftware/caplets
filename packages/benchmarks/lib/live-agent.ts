import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";

export const PROCESS_TERMINATION_BEHAVIOR =
  "Timeouts spawn commands into an owned process tree and clean up that tree only. On POSIX, children are started with detached: true to create a new process group, then killed with process.kill(-pid, signal). On Windows, cleanup uses taskkill /pid <child pid> /T /F. This targets only the process tree rooted at the spawned child pid.";

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_KILL_GRACE_MS = 2_000;
export const DEFAULT_OUTPUT_MAX_BYTES = 1024 * 1024;

const SECRET_KEY_PATTERN = /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|AUTH)/i;
const SECRET_VALUE_PLACEHOLDER = "[REDACTED]";

export type RunProcessOptions = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  timeoutMs?: number;
  killGraceMs?: number;
  outputMaxBytes?: number;
  stdin?: string;
  shell?: boolean;
};

export type RunProcessResult = {
  command?: string;
  args?: string[];
  envKeys?: string[];
  cwd?: string | undefined;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  outputMaxBytes?: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  jsonEvents: unknown[];
  [key: string]: unknown;
};

export type LiveAgentRunner = Readonly<{
  name: string;
  detect: (options?: any) => Promise<any> | any;
  run: (options?: any) => Promise<any> | any;
}>;

export function createLiveAgentRunner({
  name,
  detect,
  run,
}: {
  name: string;
  detect: (options?: any) => Promise<any> | any;
  run: (options?: any) => Promise<any> | any;
}): LiveAgentRunner {
  if (!name || typeof name !== "string") {
    throw new TypeError("Live agent runner requires a string name.");
  }
  if (typeof detect !== "function") {
    throw new TypeError(`Live agent runner ${name} requires a detect() function.`);
  }
  if (typeof run !== "function") {
    throw new TypeError(`Live agent runner ${name} requires a run() function.`);
  }
  return Object.freeze({ name, detect, run });
}

export async function runProcess({
  command,
  args = [],
  cwd,
  env = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  killGraceMs = DEFAULT_KILL_GRACE_MS,
  outputMaxBytes = DEFAULT_OUTPUT_MAX_BYTES,
  stdin,
  shell = false,
}: RunProcessOptions): Promise<RunProcessResult> {
  if (!command || typeof command !== "string") {
    throw new TypeError("runProcess requires a command string.");
  }
  if (!Array.isArray(args)) {
    throw new TypeError("runProcess args must be an array.");
  }

  const startedAt = performance.now();
  const childEnv = { ...process.env, ...env };
  const envKeys = Object.keys(env).sort();
  const redactions = secretRedactions(childEnv);
  const stdoutCapture = createOutputCapture(outputMaxBytes, redactions);
  const stderrCapture = createOutputCapture(outputMaxBytes, redactions);
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  let graceTimeout: NodeJS.Timeout | undefined;
  let settled = false;

  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: childEnv,
      shell,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: [stdin == null ? "ignore" : "pipe", "pipe", "pipe"],
    });

    child.on("error", (error) => {
      clearTimeout(timeout);
      clearTimeout(graceTimeout);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdoutCapture.append(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderrCapture.append(chunk);
    });

    if (stdin != null) {
      child.stdin?.end(stdin);
    }

    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        killProcessTree(child, "SIGTERM");
        graceTimeout = setTimeout(() => {
          if (child.exitCode == null && child.signalCode == null) {
            killProcessTree(child, "SIGKILL");
          }
        }, killGraceMs);
      }, timeoutMs);
    }

    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      clearTimeout(graceTimeout);
      if (settled) {
        return;
      }
      settled = true;
      const durationMs = Math.round(performance.now() - startedAt);
      const stdout = stdoutCapture.value();
      const stderr = stderrCapture.value();
      resolve({
        command,
        args,
        envKeys,
        cwd,
        stdout,
        stderr,
        stdoutBytes: stdoutCapture.totalBytes,
        stderrBytes: stderrCapture.totalBytes,
        stdoutTruncated: stdoutCapture.truncated,
        stderrTruncated: stderrCapture.truncated,
        outputMaxBytes,
        exitCode,
        signal,
        timedOut,
        durationMs,
        jsonEvents: parseJsonEvents(stdout),
      });
    });
  });
}

export async function runCommandLine(
  commandLine: string,
  options: Omit<RunProcessOptions, "command" | "args" | "shell"> = {},
): Promise<RunProcessResult> {
  if (!commandLine || typeof commandLine !== "string") {
    throw new TypeError("runCommandLine requires a command line string.");
  }
  return await runProcess({ ...options, command: commandLine, args: [], shell: true });
}

export function parseJsonEvents(stdout: string): unknown[] {
  const text = stdout.trim();
  if (!text) {
    return [];
  }

  const parsed = parseJson(text);
  if (parsed.ok) {
    return Array.isArray(parsed.value) ? parsed.value : [parsed.value];
  }

  const events: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    const candidate = line.trim();
    if (!candidate) {
      continue;
    }
    const lineParsed = parseJson(candidate);
    if (lineParsed.ok) {
      events.push(lineParsed.value);
    }
  }
  return events;
}

export function redactOutput(
  value: unknown,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = {},
): string {
  let redacted = String(value);
  for (const secret of secretRedactions(env)) {
    redacted = redacted.split(secret).join(SECRET_VALUE_PLACEHOLDER);
  }
  redacted = redacted.replace(
    /\bBearer\s+[-._~+/A-Za-z0-9]+=*/gi,
    `Bearer ${SECRET_VALUE_PLACEHOLDER}`,
  );
  redacted = redacted.replace(
    /\b(?:token|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[=:]\s*["']?[^\s"']+/gi,
    (match) => match.replace(/([=:]\s*["']?)[^\s"']+$/u, `$1${SECRET_VALUE_PLACEHOLDER}`),
  );
  return redacted;
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) {
    child.kill(signal);
    return;
  }
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    }).on("error", () => {
      child.kill(signal);
    });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function createOutputCapture(maxBytes: number, redactions: string[]) {
  const chunks: string[] = [];
  const limit = Number.isFinite(maxBytes) && maxBytes >= 0 ? maxBytes : DEFAULT_OUTPUT_MAX_BYTES;
  const redactionLookaheadBytes = redactions.reduce(
    (max: number, secret: string) => Math.max(max, Buffer.byteLength(secret, "utf8")),
    0,
  );
  const rawCaptureLimit = limit + redactionLookaheadBytes + 256;
  let capturedRawBytes = 0;
  return {
    totalBytes: 0,
    truncated: false,
    append(chunk: unknown) {
      const raw = String(chunk);
      const rawBytes = Buffer.byteLength(raw, "utf8");
      this.totalBytes += rawBytes;
      if (capturedRawBytes >= rawCaptureLimit) {
        this.truncated = true;
        return;
      }
      const remaining = rawCaptureLimit - capturedRawBytes;
      if (rawBytes <= remaining) {
        chunks.push(raw);
        capturedRawBytes += rawBytes;
        return;
      }
      const truncatedRaw = truncateUtf8(raw, remaining);
      chunks.push(truncatedRaw);
      capturedRawBytes += Buffer.byteLength(truncatedRaw, "utf8");
      this.truncated = true;
    },
    value() {
      let output = chunks.join("");
      for (const secret of redactions) {
        output = output.split(secret).join(SECRET_VALUE_PLACEHOLDER);
      }
      output = redactOutput(output);
      const truncatedOutput = truncateUtf8(output, limit);
      this.truncated =
        this.truncated ||
        Buffer.byteLength(output, "utf8") > Buffer.byteLength(truncatedOutput, "utf8");
      return sanitizeCappedOutput(truncatedOutput, redactions, limit);
    },
  };
}

function sanitizeCappedOutput(value: string, redactions: string[], limit: number): string {
  let output = value;
  for (let pass = 0; pass < 20; pass += 1) {
    const redacted = redactSecretFragments(output, redactions);
    const capped = truncateUtf8(redacted, limit);
    if (capped === output) {
      return capped;
    }
    output = capped;
  }
  return truncateUtf8(redactSecretFragments(output, redactions), limit);
}

function redactSecretFragments(value: string, secrets: string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length < 8) {
      continue;
    }
    const fragments = secretFragments(secret);
    let replaced = true;
    let passes = 0;
    while (replaced && passes < 100) {
      replaced = false;
      passes += 1;
      for (const fragment of fragments) {
        if (redacted.includes(fragment)) {
          redacted = redacted.split(fragment).join(SECRET_VALUE_PLACEHOLDER);
          replaced = true;
        }
      }
    }
  }
  return redacted;
}

function secretFragments(secret: string): string[] {
  const threshold = 8;
  if (secret.length <= threshold) {
    return [secret];
  }
  const fragments = new Set([secret.slice(0, threshold), secret.slice(-threshold)]);
  const maxFragments = 512;
  const step = Math.max(1, Math.floor((secret.length - threshold) / maxFragments));
  for (let index = 0; index <= secret.length - threshold; index += step) {
    fragments.add(secret.slice(index, index + threshold));
    if (fragments.size >= maxFragments) {
      break;
    }
  }
  return [...fragments];
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    bytes += characterBytes;
    result += character;
  }
  return result;
}

function secretRedactions(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([key, value]) => SECRET_KEY_PATTERN.test(key) && value)
    .map(([, value]) => String(value))
    .filter((value) => value.length >= 3);
}

function parseJson(value: string): { ok: true; value: unknown } | { ok: false; error: unknown } {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch (error) {
    return { ok: false, error };
  }
}
