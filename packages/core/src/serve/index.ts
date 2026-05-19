import type { CapletsEngineOptions } from "../engine";
import { serveHttp } from "./http";
import { resolveServeOptions, type RawServeOptions, type ServeOptions } from "./options";
import { serveStdio } from "./stdio";

export { serveHttp } from "./http";
export { resolveServeOptions } from "./options";
export type { HttpServeOptions, RawServeOptions, ServeOptions, StdioServeOptions } from "./options";
export { serveStdio } from "./stdio";

export type ServeCapletsOptions = {
  raw: RawServeOptions;
  engine?: CapletsEngineOptions;
  env?: NodeJS.ProcessEnv;
  writeErr?: (value: string) => void;
};

export async function serveCaplets(options: ServeCapletsOptions): Promise<void> {
  const resolved = resolveServeOptions(options.raw, options.env ?? process.env);
  await serveResolvedCaplets(resolved, options.engine, options.writeErr);
}

export async function serveResolvedCaplets(
  resolved: ServeOptions,
  engineOptions: CapletsEngineOptions = {},
  writeErr?: (value: string) => void,
): Promise<void> {
  if (resolved.transport === "stdio") {
    await serveStdio({ ...engineOptions, ...(writeErr ? { writeErr } : {}) });
    return;
  }
  await serveHttp(resolved, { ...engineOptions, ...(writeErr ? { writeErr } : {}) }, writeErr);
}
