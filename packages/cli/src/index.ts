import { runCli } from "@caplets/core";
import { version as packageVersion } from "../package.json";

async function main() {
  await runCli(process.argv.slice(2), { version: packageVersion });
}

main().catch(() => {
  process.exit(1);
});
