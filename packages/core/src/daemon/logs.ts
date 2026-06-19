import { existsSync, mkdirSync, readFileSync, writeFileSync, watch } from "node:fs";
import { dirname } from "node:path";
import type { DaemonLogEntry, DaemonLogStream, DaemonLogsResult, DaemonPaths } from "./types";

export function readDaemonLogs(
  paths: DaemonPaths,
  options: { stream?: DaemonLogStream; tail?: number } = {},
): DaemonLogsResult {
  const stream = options.stream ?? "all";
  const tail = options.tail ?? 10;
  const streamEntries = selectedStreams(stream).map((selected) =>
    tailLines(paths[selected === "stdout" ? "stdoutLog" : "stderrLog"], tail).map((line) => ({
      stream: selected,
      line,
    })),
  );
  const entries = stream === "all" ? interleaveLogEntries(streamEntries) : streamEntries.flat();
  return { paths: { stdoutLog: paths.stdoutLog, stderrLog: paths.stderrLog }, entries };
}

export async function followDaemonLogs(
  paths: DaemonPaths,
  options: {
    stream?: DaemonLogStream;
    tail?: number;
    write: (
      entry:
        | DaemonLogEntry
        | { type: "metadata"; paths: Pick<DaemonPaths, "stdoutLog" | "stderrLog"> },
    ) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  options.write({
    type: "metadata",
    paths: { stdoutLog: paths.stdoutLog, stderrLog: paths.stderrLog },
  });
  for (const entry of readDaemonLogs(paths, {
    ...(options.stream ? { stream: options.stream } : {}),
    ...(options.tail !== undefined ? { tail: options.tail } : {}),
  }).entries) {
    options.write(entry);
  }
  const watchers = selectedStreams(options.stream ?? "all").map((stream) => {
    const file = paths[stream === "stdout" ? "stdoutLog" : "stderrLog"];
    ensureLogFile(file);
    let offset = existsSync(file) ? readFileSync(file, "utf8").length : 0;
    return watch(file, { persistent: true }, () => {
      const content = existsSync(file) ? readFileSync(file, "utf8") : "";
      const appended = content.slice(offset);
      offset = content.length;
      for (const line of appended.split(/\r?\n/u).filter(Boolean)) options.write({ stream, line });
    });
  });
  await new Promise<void>((resolve) => {
    if (options.signal?.aborted) resolve();
    options.signal?.addEventListener("abort", () => resolve(), { once: true });
  });
  for (const watcher of watchers) watcher.close();
}

export function ensureDaemonLogFiles(paths: DaemonPaths): void {
  ensureLogFile(paths.stdoutLog);
  ensureLogFile(paths.stderrLog);
}

function selectedStreams(stream: DaemonLogStream): Array<"stdout" | "stderr"> {
  return stream === "all" ? ["stdout", "stderr"] : [stream];
}

function tailLines(path: string, count: number): string[] {
  if (count === 0 || !existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return count < 0 ? lines : lines.slice(-count);
}

function interleaveLogEntries(streamEntries: DaemonLogEntry[][]): DaemonLogEntry[] {
  const timestamps = streamEntries.flat().map((entry) => logTimestamp(entry.line));
  if (timestamps.length > 0 && timestamps.every((timestamp) => timestamp !== undefined)) {
    return streamEntries
      .flat()
      .map((entry, index) => ({ entry, index, timestamp: timestamps[index]! }))
      .sort((left, right) => left.timestamp - right.timestamp || left.index - right.index)
      .map(({ entry }) => entry);
  }

  const entries: DaemonLogEntry[] = [];
  const maxLength = Math.max(
    0,
    ...streamEntries.map((entriesForStream) => entriesForStream.length),
  );
  for (let index = 0; index < maxLength; index += 1) {
    for (const entriesForStream of streamEntries) {
      const entry = entriesForStream[index];
      if (entry) entries.push(entry);
    }
  }
  return entries;
}

function logTimestamp(line: string): number | undefined {
  const match = /^(?:\[(?<bracket>[^\]]+)\]|(?<plain>\S+))/u.exec(line);
  const value = match?.groups?.bracket ?? match?.groups?.plain;
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function ensureLogFile(path: string): void {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, "", { mode: 0o600 });
}
