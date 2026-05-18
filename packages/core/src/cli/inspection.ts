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

type CliOutputFormat = "markdown" | "plain" | "json";

export function formatCapletList(
  rows: CapletListRow[],
  format: Exclude<CliOutputFormat, "json"> = "plain",
): string {
  return format === "markdown" ? formatCapletListMarkdown(rows) : formatCapletListPlain(rows);
}

function formatCapletListMarkdown(rows: CapletListRow[]): string {
  if (rows.length === 0) {
    return "## Configured Caplets\n\nNo configured Caplets found.\n";
  }

  const heading = [
    "## Configured Caplets",
    "",
    `${rows.length} ${rows.length === 1 ? "Caplet" : "Caplets"} shown.`,
    "",
  ];
  const entries = rows.flatMap((row) => [
    `- \`${row.server}\` — ${row.name}`,
    `  - Backend: ${row.backend}`,
    `  - Status: ${row.status}`,
    `  - Source: ${row.source}`,
    ...(row.disabled ? ["  - Disabled: true"] : []),
    ...(row.path ? [`  - Path: ${row.path}`] : []),
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
    return `${[...heading, ...entries].join("\n")}\n`;
  }
  return `${[...heading, ...entries, "", "Warnings:", ...warnings.map((warning) => `- ${warning}`)].join("\n")}\n`;
}

function formatCapletListPlain(rows: CapletListRow[]): string {
  if (rows.length === 0) {
    return "No configured Caplets found.\n";
  }

  const entries = rows
    .map((row) =>
      [
        row.server,
        `  Name: ${row.name}`,
        `  Backend: ${row.backend}`,
        `  Status: ${row.status}`,
        `  Source: ${row.source}`,
        ...(row.disabled ? ["  Disabled: true"] : []),
        ...(row.path ? [`  Path: ${row.path}`] : []),
      ].join("\n"),
    )
    .join("\n\n");
  const warnings = rows.flatMap((row) =>
    row.shadows.map(
      (shadow) =>
        `Warning: ${formatSourceKind(row.source)} Caplet ${row.server} shadows ${formatSourceKind(
          shadow.kind,
        )} Caplet at ${shadow.path}`,
    ),
  );

  if (warnings.length === 0) {
    return `Configured Caplets (${rows.length})\n\n${entries}\n`;
  }
  return `Configured Caplets (${rows.length})\n\n${entries}\n\n${warnings.join("\n")}\n`;
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

export function formatConfigPaths(
  paths: ConfigPaths,
  format: Exclude<CliOutputFormat, "json"> = "plain",
): string {
  if (format === "markdown") {
    return formatConfigPathsMarkdown(paths);
  }
  return formatConfigPathsPlain(paths);
}

function formatConfigPathsMarkdown(paths: ConfigPaths): string {
  return (
    [
      "## Caplets paths",
      "",
      `- User config: ${paths.userConfig}`,
      `- Project config: ${paths.projectConfig}`,
      `- User Caplets root: ${paths.userRoot}`,
      `- State root: ${paths.stateRoot}`,
      `- Project Caplets root: ${paths.projectRoot}`,
      `- Auth directory: ${paths.authDir}`,
      `- CAPLETS_CONFIG: ${paths.envConfig ?? "unset"}`,
    ].join("\n") + "\n"
  );
}

function formatConfigPathsPlain(paths: ConfigPaths): string {
  return (
    [
      "Caplets paths",
      "",
      `User config: ${paths.userConfig}`,
      `Project config: ${paths.projectConfig}`,
      `User root: ${paths.userRoot}`,
      `State root: ${paths.stateRoot}`,
      `Project root: ${paths.projectRoot}`,
      `Auth directory: ${paths.authDir}`,
      `CAPLETS_CONFIG: ${paths.envConfig ?? "unset"}`,
    ].join("\n") + "\n"
  );
}
