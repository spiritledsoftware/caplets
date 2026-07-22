import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type RssSample = { type: "rss"; phase: string; rss: number };
type RssReport = {
  type: "report";
  totalBytes: number;
  largestFileBytes: number;
  baselineRss: number;
  peakRss: number;
  thresholdRss: number;
  parserAllowanceBytes: number;
  fixedRuntimeAllowanceBytes: number;
  exportBytes: number;
  stagingEntries: number;
};
type ErrorReport = { type: "error"; error: string };
type ChildMessage = RssSample | RssReport | ErrorReport;

const fixture = fileURLToPath(new URL("./fixtures/admin-bundle-rss-child.ts", import.meta.url));

describe("large Admin Bundle child-process RSS", () => {
  it("keeps parser, source-first SQLite import, and streaming export below one-file bounded RSS", async () => {
    const child = fork(fixture, [], {
      execArgv: ["--expose-gc", "--import", "tsx"],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const samples: RssSample[] = [];
    let report: RssReport | undefined;
    let childError: string | undefined;
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("message", (message: ChildMessage) => {
      if (message.type === "rss") samples.push(message);
      else if (message.type === "report") report = message;
      else childError = message.error;
    });

    const {
      promise: exited,
      resolve: resolveExit,
      reject: rejectExit,
    } = Promise.withResolvers<number | null>();
    child.once("error", rejectExit);
    child.once("exit", resolveExit);
    try {
      const exitCode = await exited;
      expect(childError, childError).toBeUndefined();
      expect(exitCode, stderr).toBe(0);
      expect(report, stderr).toBeDefined();
      const result = report!;
      const sampledPeak = Math.max(...samples.map((sample) => sample.rss));

      expect(samples.some((sample) => sample.phase === "baseline")).toBe(true);
      expect(samples.some((sample) => sample.phase === "parsed")).toBe(true);
      expect(samples.some((sample) => sample.phase === "imported")).toBe(true);
      expect(samples.some((sample) => sample.phase === "exported")).toBe(true);
      expect(sampledPeak).toBe(result.peakRss);
      expect(result.thresholdRss).toBe(
        result.baselineRss +
          result.largestFileBytes +
          result.parserAllowanceBytes +
          result.fixedRuntimeAllowanceBytes,
      );
      expect(result.peakRss).toBeLessThan(result.thresholdRss);
      expect(result.totalBytes).toBeGreaterThan(result.largestFileBytes * 40);
      expect(result.exportBytes).toBeGreaterThan(result.totalBytes);
      expect(result.stagingEntries).toBe(0);

      console.info(
        `[bundle-rss] total=${result.totalBytes} largest=${result.largestFileBytes} ` +
          `baseline=${result.baselineRss} peak=${result.peakRss} threshold=${result.thresholdRss}`,
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 180_000);
});
