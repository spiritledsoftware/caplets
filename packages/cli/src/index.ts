import { runCli } from "@caplets/core";
import { version as packageVersion } from "../package.json";

async function main() {
  await runCli(process.argv.slice(2), { version: packageVersion });
}

main().catch((error) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exit(1);
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
