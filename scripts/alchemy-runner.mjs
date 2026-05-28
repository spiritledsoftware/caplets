import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";

const runnerPath = fileURLToPath(import.meta.url);
const shimPath = fileURLToPath(new URL("./alchemy-fetch-compat.mjs", import.meta.url));
const alchemyBinPath = fileURLToPath(
  new URL("../node_modules/alchemy/bin/alchemy.js", import.meta.url),
);

export function buildNodeOptions(existingNodeOptions = process.env.NODE_OPTIONS) {
  return [`--import=${shimPath}`, existingNodeOptions].filter(Boolean).join(" ");
}

export async function main(args = process.argv.slice(2)) {
  const child = spawn(process.execPath, [alchemyBinPath, ...args], {
    env: {
      ...process.env,
      NODE_OPTIONS: buildNodeOptions(),
    },
    stdio: "inherit",
  });

  const exitCode = await new Promise((resolve) => {
    child.on("close", (code, signal) => {
      if (signal) {
        resolve(128 + (osConstants.signals[signal] ?? 0));
      } else {
        resolve(code ?? 1);
      }
    });
  });

  process.exitCode = exitCode;
}

if (runnerPath === process.argv[1]) {
  await main();
}
