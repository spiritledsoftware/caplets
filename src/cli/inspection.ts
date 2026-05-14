import { dirname } from "node:path";
import {
  DEFAULT_AUTH_DIR,
  resolveCapletsRoot,
  resolveConfigPath,
  resolveProjectCapletsRoot,
  resolveProjectConfigPath,
  TRUST_PROJECT_CAPLETS_ENV,
  isTrustedEnvEnabled,
  type CapletConfig,
  type CapletsConfig,
} from "../config.js";
import type { ServerStatus } from "../registry.js";

type CapletListRow = {
  server: string;
  backend: CapletConfig["backend"];
  name: string;
  description: string;
  disabled: boolean;
  status: ServerStatus;
};

type ConfigPaths = {
  userConfig: string;
  projectConfig: string;
  userRoot: string;
  stateRoot: string;
  projectRoot: string;
  authDir: string;
  envConfig: string | null;
  projectCapletsTrusted: boolean;
};

export function listCaplets(
  config: CapletsConfig,
  options: { includeDisabled: boolean },
): CapletListRow[] {
  const rows = allCaplets(config)
    .filter((server) => options.includeDisabled || !server.disabled)
    .map((server) => ({
      server: server.server,
      backend: server.backend,
      name: server.name,
      description: server.description,
      disabled: server.disabled,
      status: initialServerStatus(server),
    }));
  return rows.sort((left, right) => left.server.localeCompare(right.server));
}

function initialServerStatus(server: CapletConfig): ServerStatus {
  return server.disabled ? "disabled" : "not_started";
}

function allCaplets(config: CapletsConfig): CapletConfig[] {
  return [
    ...Object.values(config.mcpServers),
    ...Object.values(config.openapiEndpoints),
    ...Object.values(config.graphqlEndpoints),
    ...Object.values(config.httpApis),
    ...Object.values(config.cliTools),
  ];
}

export function formatCapletList(rows: CapletListRow[]): string {
  if (rows.length === 0) {
    return "No configured Caplets found.\n";
  }

  return `${formatTable([
    ["server", "backend", "status", "name"],
    ...rows.map((row) => [row.server, row.backend, row.status, row.name]),
  ])}\n`;
}

export function resolveCliConfigPaths(
  envConfigPath: string | undefined,
  authDir?: string,
): ConfigPaths {
  const configPath = resolveConfigPath(envConfigPath);
  const effectiveAuthDir = authDir ?? DEFAULT_AUTH_DIR;
  return {
    userConfig: configPath,
    projectConfig: resolveProjectConfigPath(),
    userRoot: resolveCapletsRoot(configPath),
    stateRoot: dirname(effectiveAuthDir),
    projectRoot: resolveProjectCapletsRoot(),
    authDir: effectiveAuthDir,
    envConfig: envConfigPath ?? null,
    projectCapletsTrusted: isTrustedProjectCapletsEnabled(),
  };
}

export function formatConfigPaths(paths: ConfigPaths): string {
  return (
    [
      `userConfig: ${paths.userConfig}`,
      `projectConfig: ${paths.projectConfig}`,
      `userRoot: ${paths.userRoot}`,
      `stateRoot: ${paths.stateRoot}`,
      `projectRoot: ${paths.projectRoot}`,
      `authDir: ${paths.authDir}`,
      `envConfig: ${paths.envConfig ?? "unset"}`,
      `projectCapletsTrusted: ${paths.projectCapletsTrusted}`,
    ].join("\n") + "\n"
  );
}

function isTrustedProjectCapletsEnabled(): boolean {
  return isTrustedEnvEnabled(process.env[TRUST_PROJECT_CAPLETS_ENV]);
}

function formatTable(rows: string[][]): string {
  const firstRow = rows[0];
  if (!firstRow) {
    return "";
  }

  const widths = firstRow.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );

  return rows.map((row) => formatTableRow(row, widths)).join("\n");
}

function formatTableRow(row: string[], widths: number[]): string {
  return row
    .map((value, column) => {
      if (column === row.length - 1) {
        return value;
      }
      return value.padEnd((widths[column] ?? 0) + 2);
    })
    .join("")
    .trimEnd();
}
