import { loadCapletFilesFromMap } from "../caplet-files-bundle";
import { parseConfig, type CapletConfig, type CapletsConfig } from "../config-runtime";
import { planCapletRuntimeRoutes, type CapletRuntimePlan } from "../runtime-plan";
import type { CapletSource } from "./types";

export type CapletSourceReference = {
  path: string;
  exists: boolean;
};

export type ParsedCapletSourceCaplet = {
  id: string;
  parentId: string;
  childId?: string | undefined;
  name: string;
  description: string;
  backend: CapletConfig["backend"];
  sourcePath: string;
  setupRequired: boolean;
  authRequired: boolean;
  projectBindingRequired: boolean;
  runtime: CapletRuntimePlan["runtime"] & {
    route: CapletRuntimePlan["route"];
    setupTarget?: CapletRuntimePlan["setupTarget"] | undefined;
  };
  localReferences: CapletSourceReference[];
  config: CapletConfig;
};

export type CapletSourceParseMessage = {
  path?: string | undefined;
  message: string;
};

export type CapletSourceParseResult = {
  ok: boolean;
  config?: CapletsConfig | undefined;
  resolvedCaplets: ParsedCapletSourceCaplet[];
  warnings: CapletSourceParseMessage[];
  errors: CapletSourceParseMessage[];
};

export async function parseCapletSource(source: CapletSource): Promise<CapletSourceParseResult> {
  const files = await source.listFiles();
  let loaded: ReturnType<typeof loadCapletFilesFromMap>;
  try {
    loaded = loadCapletFilesFromMap({ files });
  } catch (error) {
    return {
      ok: false,
      resolvedCaplets: [],
      warnings: [],
      errors: [{ message: errorMessage(error) }],
    };
  }

  if (!loaded) {
    return {
      ok: false,
      resolvedCaplets: [],
      warnings: [],
      errors: [
        {
          message:
            "Caplet source must include at least one CAPLET.md or top-level Markdown Caplet file.",
        },
      ],
    };
  }

  let config: CapletsConfig;
  try {
    config = parseConfig({ version: 1, ...loaded.config });
  } catch (error) {
    return {
      ok: false,
      resolvedCaplets: [],
      warnings: [],
      errors: [{ message: errorMessage(error) }],
    };
  }

  const configCaplets = capletsFromConfig(config);
  const plansById = new Map(
    planCapletRuntimeRoutes(configCaplets, { deployment: "hosted" }).map((plan) => [plan.id, plan]),
  );
  const caplets = configCaplets.map((caplet) => {
    const plan = plansById.get(caplet.server);
    const sourceMetadata = loaded.metadata?.[caplet.server];
    return {
      id: caplet.server,
      parentId: sourceMetadata?.parentId ?? caplet.server,
      ...(sourceMetadata?.childId ? { childId: sourceMetadata.childId } : {}),
      name: caplet.name,
      description: caplet.description,
      backend: caplet.backend,
      sourcePath: sourceMetadata?.path ?? loaded.paths[caplet.server] ?? "CAPLET.md",
      setupRequired: Boolean(caplet.setup),
      authRequired: authRequired("auth" in caplet ? caplet.auth : undefined),
      projectBindingRequired: plan?.projectBindingRequired ?? false,
      runtime: {
        ...(plan?.runtime ?? {
          features: [],
          featureProvenance: [],
          resources: { class: "standard", cpu: 2, memoryMb: 4096, diskMb: 8192 },
        }),
        route: plan?.route ?? "local_only",
        ...(plan?.setupTarget === undefined ? {} : { setupTarget: plan.setupTarget }),
      },
      localReferences: localReferencePaths(caplet).map((path) => ({ path, exists: false })),
      config: caplet,
    };
  });

  for (const caplet of caplets) {
    for (const reference of caplet.localReferences) {
      reference.exists = Boolean(await source.readFile(reference.path));
    }
  }

  const errors = caplets.flatMap((caplet) =>
    caplet.localReferences
      .filter((reference) => !reference.exists)
      .map((reference) => ({
        path: caplet.sourcePath,
        message: `Referenced file ${reference.path} was not found.`,
      })),
  );

  return {
    ok: errors.length === 0,
    config,
    resolvedCaplets: errors.length === 0 ? caplets : [],
    warnings: [],
    errors,
  };
}

function capletsFromConfig(config: CapletsConfig): CapletConfig[] {
  return [
    ...Object.values(config.mcpServers),
    ...Object.values(config.openapiEndpoints),
    ...Object.values(config.googleDiscoveryApis ?? {}),
    ...Object.values(config.graphqlEndpoints),
    ...Object.values(config.httpApis),
    ...Object.values(config.cliTools),
    ...Object.values(config.capletSets),
  ];
}

function localReferencePaths(caplet: CapletConfig): string[] {
  if (caplet.backend === "openapi") {
    return filterLocalReferences([caplet.specPath]);
  }
  if (caplet.backend === "googleDiscovery") {
    return filterLocalReferences([caplet.discoveryPath]);
  }
  if (caplet.backend === "graphql") {
    return filterLocalReferences([
      caplet.schemaPath,
      ...Object.values(caplet.operations ?? {}).map((operation) => operation.documentPath),
    ]);
  }
  if (caplet.backend === "caplets") {
    return filterLocalReferences([caplet.configPath]);
  }
  return [];
}

function filterLocalReferences(values: Array<string | undefined>): string[] {
  return values.filter(
    (value): value is string =>
      typeof value === "string" &&
      value.length > 0 &&
      !hasEnvReference(value) &&
      !/^[a-z][a-z0-9+.-]*:/iu.test(value),
  );
}

function authRequired(auth: unknown): boolean {
  return auth !== null && typeof auth === "object" && "type" in auth && auth.type !== "none";
}

function hasEnvReference(value: string): boolean {
  return /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$env:[A-Za-z_][A-Za-z0-9_]*/u.test(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
