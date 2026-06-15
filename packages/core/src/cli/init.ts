import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveConfigPath } from "../config";
import { CapletsError } from "../errors";

export function initConfig(options: { path?: string; force?: boolean } = {}): string {
  const path = resolveConfigPath(options.path);
  if (existsSync(path) && !options.force) {
    throw new CapletsError(
      "CONFIG_EXISTS",
      `Caplets config already exists at ${path}; pass --force to overwrite it`,
    );
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${starterConfig()}\n`, {
    mode: 0o600,
    flag: options.force ? "w" : "wx",
  });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best effort on platforms without POSIX permissions.
  }
  return path;
}

export function starterConfig(): string {
  return JSON.stringify(
    {
      $schema: "https://caplets.dev/config.schema.json",
      version: 1,
      defaultSearchLimit: 20,
      maxSearchLimit: 50,
      mcpServers: {
        example: {
          name: "Example MCP Server",
          description: "Replace this with a real MCP server and what agents should use it for.",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-everything"],
          disabled: true,
        },
      },
    },
    null,
    2,
  );
}
