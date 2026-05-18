import { dirname } from "node:path";
import {
  DEFAULT_AUTH_DIR,
  resolveCapletsRoot,
  resolveConfigPath,
  resolveProjectCapletsRoot,
  resolveProjectConfigPath,
  type CapletConfig,
  type CapletsConfig,
  type ConfigSource,
  type ConfigWithSources,
} from "../config";
import type { ServerStatus } from "../registry";

type CapletListRow = {
  server: string;
  backend: CapletConfig["backend"];
  name: string;
  description: string;
  disabled: boolean;
  status: ServerStatus;
  source: ConfigSource["kind"] | "unknown";
  path: string | null;
  shadows: ConfigSource[];
};

type ConfigPaths = {
  userConfig: string;
  projectConfig: string;
  userRoot: string;
  stateRoot: string;
  projectRoot: string;
  authDir: string;
  envConfig: string | null;
};

export function listCaplets(
  configWithSources: ConfigWithSources,
  options: { includeDisabled: boolean },
): CapletListRow[] {
  const { config, sources, shadows } = configWithSources;
  const rows: CapletListRow[] = allCaplets(config)
    .filter((server) => options.includeDisabled || !server.disabled)
    .map((server) => ({
      server: server.server,
      backend: server.backend,
      name: server.name,
      description: server.description,
      disabled: server.disabled,
      status: initialServerStatus(server),
      source: sources[server.server]?.kind ?? "unknown",
      path: sources[server.server]?.path ?? null,
      shadows: shadows[server.server] ?? [],
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

  const table = formatTable([
    ["server", "backend", "status", "source", "name"],
    ...rows.map((row) => [row.server, row.backend, row.status, row.source, row.name]),
  ]);
  const warnings = rows.flatMap((row) =>
    row.shadows.map(
      (shadow) =>
        `Warning: ${formatSourceKind(row.source)} Caplet ${row.server} shadows ${formatSourceKind(
          shadow.kind,
        )} Caplet at ${shadow.path}`,
    ),
  );

  if (warnings.length === 0) {
    return `${table}\n`;
  }
  return `${table}\n${warnings.join("\n")}\n`;
}

function formatSourceKind(kind: ConfigSource["kind"] | "unknown"): string {
  if (kind.startsWith("project")) {
    return "project";
  }
  if (kind.startsWith("global")) {
    return "global";
  }
  return kind;
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
    ].join("\n") + "\n"
  );
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
