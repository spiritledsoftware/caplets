import { type ChildProcess, spawn } from "node:child_process";
import { watch } from "rolldown";
import cliConfig from "../packages/cli/rolldown.config.ts";
import coreConfig from "../packages/core/rolldown.config.ts";

let child: ChildProcess | null = null;
let starting = false;

function startServer() {
  if (starting) return;
  starting = true;

  if (child) {
    child.kill("SIGTERM");
    child = null;
  }

  child = spawn("node", ["packages/cli/dist/index.js"], {
    stdio: "inherit",
    env: process.env,
  });

  child.on("exit", (code, signal) => {
    if (signal !== "SIGTERM") {
      console.log(`[mcp] server exited: code=${code} signal=${signal}`);
    }
  });

  starting = false;
}

const watcher = watch([coreConfig, cliConfig]);

watcher.on("event", (event) => {
  if (event.code === "START") {
    console.log("[build] rebuilding...");
  }

  if (event.code === "END") {
    console.log("[build] done; restarting MCP server...");
    startServer();
  }

  if (event.code === "ERROR") {
    console.error("[build] failed");
    console.error(event.error);
  }
});

process.on("SIGINT", async () => {
  child?.kill("SIGTERM");
  await watcher.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  child?.kill("SIGTERM");
  await watcher.close();
  process.exit(0);
});
