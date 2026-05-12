import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  deleteTokenBundle,
  isTokenBundleExpired,
  readTokenBundle,
  runGenericOAuthFlow,
  runOAuthFlow,
  type GenericAuthTarget,
} from "../auth.js";
import { loadConfig, type GraphQlEndpointConfig } from "../config.js";
import { CapletsError, toSafeError } from "../errors.js";

type AuthTarget = ReturnType<typeof authTargets>[number];

export async function loginAuth(
  serverId: string,
  options: {
    configPath?: string;
    noOpen: boolean;
    writeOut: (value: string) => void;
    writeErr: (value: string) => void;
    authDir?: string;
  },
): Promise<void> {
  const config = loadConfig(options.configPath);
  const server = findAuthTarget(serverId, config);
  assertLoginTarget(server, serverId);

  try {
    const flowOptions = {
      noOpen: options.noOpen,
      ...(options.authDir ? { authDir: options.authDir } : {}),
      ...(options.noOpen ? { readManualInput: maybeReadManualInput } : {}),
      print: (line: string) => options.writeOut(`${line}\n`),
    };
    if (server.backend === "mcp") {
      await runOAuthFlow(server, flowOptions);
    } else {
      await runGenericOAuthFlow(server, flowOptions);
    }
    options.writeOut(`Authenticated ${serverId}\n`);
  } catch (error) {
    options.writeErr(`${JSON.stringify(toSafeError(error, "AUTH_FAILED"), null, 2)}\n`);
    process.exitCode = 1;
  }
}

export function logoutAuth(
  serverId: string,
  options: { authDir?: string; configPath?: string; writeOut: (value: string) => void },
): void {
  const target = findAuthTarget(serverId, loadConfig(options.configPath));
  assertLoginTarget(target, serverId);

  if (deleteTokenBundle(serverId, options.authDir)) {
    options.writeOut(`Deleted OAuth credentials for ${serverId}\n`);
  } else {
    options.writeOut(`No OAuth credentials found for ${serverId}\n`);
  }
}

export function listAuth(options: {
  authDir?: string;
  configPath?: string;
  writeOut: (value: string) => void;
}): void {
  const config = loadConfig(options.configPath);
  const servers = authTargets(config).sort((left, right) =>
    left.server.localeCompare(right.server),
  );

  if (servers.length === 0) {
    options.writeOut("No configured remote OAuth servers found.\n");
    return;
  }
  for (const server of servers) {
    const bundle = readTokenBundle(server.server, options.authDir);
    const status = !bundle ? "missing" : isTokenBundleExpired(bundle) ? "expired" : "authenticated";
    options.writeOut(
      [
        server.server,
        status,
        bundle?.expiresAt ? `expires ${bundle.expiresAt}` : undefined,
        bundle?.scope ? `scope ${bundle.scope}` : undefined,
      ]
        .filter(Boolean)
        .join("\t"),
    );
    options.writeOut("\n");
  }
}

function findAuthTarget(serverId: string, config = loadConfig()): AuthTarget | undefined {
  return authTargets(config).find((server) => server.server === serverId);
}

function authTargets(config: ReturnType<typeof loadConfig>) {
  return [
    ...Object.values(config.mcpServers).filter(
      (server) =>
        server.transport !== "stdio" &&
        (server.auth?.type === "oauth2" || server.auth?.type === "oidc"),
    ),
    ...Object.values(config.openapiEndpoints).filter(
      (endpoint) => endpoint.auth?.type === "oauth2" || endpoint.auth?.type === "oidc",
    ),
    ...Object.values(config.graphqlEndpoints)
      .filter((endpoint) => endpoint.auth?.type === "oauth2" || endpoint.auth?.type === "oidc")
      .map(graphQlAuthTarget),
  ];
}

function graphQlAuthTarget(
  endpoint: GraphQlEndpointConfig,
): GraphQlEndpointConfig & GenericAuthTarget {
  return {
    ...endpoint,
    url: endpoint.endpointUrl,
  };
}

function assertLoginTarget(
  target: AuthTarget | undefined,
  serverId: string,
): asserts target is AuthTarget {
  if (!target) {
    throw new CapletsError("SERVER_NOT_FOUND", `Server ${serverId} is not configured for OAuth`);
  }
  if ("disabled" in target && target.disabled) {
    throw new CapletsError("SERVER_UNAVAILABLE", `Server ${serverId} is disabled`);
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
