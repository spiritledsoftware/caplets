import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
  watch,
} from "node:fs";
import { dirname } from "node:path";
import type { DaemonLogEntry, DaemonLogStream, DaemonLogsResult, DaemonPaths } from "./types";

const TAIL_CHUNK_BYTES = 64 * 1024;

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
    let offset = existsSync(file) ? statSync(file).size : 0;
    return watch(file, { persistent: true }, () => {
      const { content, nextOffset } = readFromOffset(file, offset);
      offset = nextOffset;
      for (const line of content.split(/\r?\n/u).filter(Boolean)) options.write({ stream, line });
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
  const lines =
    count < 0 ? readFileSync(path, "utf8").split(/\r?\n/u) : readTailContent(path, count);
  if (lines.at(-1) === "") lines.pop();
  return count < 0 ? lines : lines.slice(-count);
}

function readTailContent(path: string, count: number): string[] {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const chunks: Buffer[] = [];
    let position = size;
    let newlineCount = 0;
    while (position > 0 && newlineCount <= count) {
      const readSize = Math.min(TAIL_CHUNK_BYTES, position);
      position -= readSize;
      const buffer = Buffer.allocUnsafe(readSize);
      const bytesRead = readSync(fd, buffer, 0, readSize, position);
      const chunk = buffer.subarray(0, bytesRead);
      chunks.unshift(chunk);
      for (const byte of chunk) {
        if (byte === 10) newlineCount += 1;
      }
    }
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/u);
  } finally {
    closeSync(fd);
  }
}

function readFromOffset(path: string, offset: number): { content: string; nextOffset: number } {
  if (!existsSync(path)) return { content: "", nextOffset: 0 };
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size <= offset) return { content: "", nextOffset: size };
    const length = size - offset;
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(fd, buffer, 0, length, offset);
    return { content: buffer.subarray(0, bytesRead).toString("utf8"), nextOffset: size };
  } finally {
    closeSync(fd);
  }
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
