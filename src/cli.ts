import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadConfig } from "./config.js";
import { CapletsError, toSafeError } from "./errors.js";
import { runOAuthFlow } from "./auth.js";

export async function runCli(args: string[]): Promise<void> {
  const [command, serverId, ...rest] = args;
  if (command !== "auth" || !serverId) {
    throw new CapletsError("REQUEST_INVALID", "Usage: caplets auth <server> [--no-open]");
  }

  const noOpen = rest.includes("--no-open");
  const config = loadConfig(process.env.CAPLETS_CONFIG);
  const server = config.mcpServers[serverId];
  if (!server) {
    throw new CapletsError("SERVER_NOT_FOUND", `Server ${serverId} is not configured`);
  }
  if (server.disabled) {
    throw new CapletsError("SERVER_UNAVAILABLE", `Server ${serverId} is disabled`);
  }
  if (server.transport === "stdio" || server.auth?.type !== "oauth2") {
    throw new CapletsError("REQUEST_INVALID", `Server ${serverId} is not a remote OAuth server`);
  }

  try {
    await runOAuthFlow(server, {
      noOpen,
      ...(noOpen
        ? {
            readManualInput: maybeReadManualInput,
          }
        : {}),
      print: (line) => console.log(line),
    });
    console.log(`Authenticated ${serverId}`);
  } catch (error) {
    console.error(JSON.stringify(toSafeError(error, "AUTH_FAILED"), null, 2));
    process.exitCode = 1;
  }
}

async function maybeReadManualInput(): Promise<string | undefined> {
  if (!input.isTTY) {
    return undefined;
  }
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      "Paste callback URL or authorization code after completing authorization, or press Enter to wait for loopback callback: ",
    );
    return answer.trim() || undefined;
  } finally {
    rl.close();
  }
}
