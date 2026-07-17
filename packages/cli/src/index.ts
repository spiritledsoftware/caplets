import { runCli } from "@caplets/core";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { version as packageVersion } from "../package.json";

export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  await runCli(args, { version: packageVersion });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exit(1);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
