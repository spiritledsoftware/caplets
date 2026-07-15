import { open } from "node:fs/promises";

const [mode, target] = process.argv.slice(2);
if (!mode || !target) process.exit(2);

let handle;
if (mode === "file") {
  handle = await open(target, "r+");
} else if (mode === "directory") {
  process.chdir(target);
} else {
  process.exit(2);
}

process.stdout.write("READY\n");
const { promise, resolve } = Promise.withResolvers();
const keepAlive = setInterval(() => {}, 10_000);
process.once("SIGTERM", resolve);
await promise;
clearInterval(keepAlive);
await handle?.close();
