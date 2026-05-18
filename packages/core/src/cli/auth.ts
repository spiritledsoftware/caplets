import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  deleteTokenBundle,
  isTokenBundleExpired,
  readTokenBundle,
  runGenericOAuthFlow,
  runOAuthFlow,
  type GenericAuthTarget,
} from "../auth";
import { loadConfig, type GraphQlEndpointConfig, type HttpApiConfig } from "../config";
import { CapletsError, toSafeError } from "../errors";

type AuthTarget = ReturnType<typeof authTargets>[number];
type AuthListFormat = "plain" | "markdown" | "json";

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
    options.writeOut(`Authenticated \`${serverId}\`.\n`);
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
    options.writeOut(`Deleted OAuth credentials for \`${serverId}\`.\n`);
  } else {
    options.writeOut(`No OAuth credentials found for \`${serverId}\`.\n`);
  }
}

export function listAuth(options: {
  authDir?: string;
  configPath?: string;
  writeOut: (value: string) => void;
  format?: AuthListFormat;
}): void {
  const config = loadConfig(options.configPath);
  const servers = authTargets(config).sort((left, right) =>
    left.server.localeCompare(right.server),
  );

  const format = options.format ?? "plain";
  if (format === "json") {
    const rows = servers.map((server) => {
      const bundle = readTokenBundle(server.server, options.authDir);
      const status = !bundle
        ? "missing"
        : isTokenBundleExpired(bundle)
          ? "expired"
          : "authenticated";
      return {
        server: server.server,
        status,
        ...(bundle?.expiresAt ? { expiresAt: bundle.expiresAt } : {}),
        ...(bundle?.scope ? { scope: bundle.scope } : {}),
      };
    });
    options.writeOut(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }
  if (servers.length === 0) {
    options.writeOut(
      format === "markdown"
        ? "## OAuth credentials\n\nNo configured remote OAuth servers found.\n"
        : "No configured remote OAuth servers found.\n",
    );
    return;
  }
  if (format === "markdown") {
    options.writeOut("## OAuth credentials\n\n");
  } else {
    options.writeOut("OAuth credentials\n\n");
  }
  for (const server of servers) {
    const bundle = readTokenBundle(server.server, options.authDir);
    const status = !bundle ? "missing" : isTokenBundleExpired(bundle) ? "expired" : "authenticated";
    const details = [
      bundle?.expiresAt ? `expires ${bundle.expiresAt}` : undefined,
      bundle?.scope ? `scope ${bundle.scope}` : undefined,
    ]
      .filter(Boolean)
      .join("; ");
    if (format === "markdown") {
      options.writeOut(`- \`${server.server}\` — ${status}${details ? ` (${details})` : ""}\n`);
      continue;
    }
    options.writeOut(
      [
        server.server,
        `  Status: ${status}`,
        ...(bundle?.expiresAt ? [`  Expires: ${bundle.expiresAt}`] : []),
        ...(bundle?.scope ? [`  Scope: ${bundle.scope}`] : []),
      ].join("\n"),
    );
    options.writeOut("\n\n");
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
    ...Object.values(config.httpApis)
      .filter((api) => api.auth?.type === "oauth2" || api.auth?.type === "oidc")
      .map(httpAuthTarget),
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

function httpAuthTarget(api: HttpApiConfig): HttpApiConfig & GenericAuthTarget {
  return { ...api };
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
