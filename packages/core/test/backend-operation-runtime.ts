import {
  createBackendOperationRuntime,
  type BackendOperationManagers,
  type BackendOperationRuntime,
} from "../src/backend-operation-dispatch";
import { CapletSetManager } from "../src/caplet-sets";
import { CliToolsManager } from "../src/cli-tools";
import { DownstreamManager } from "../src/downstream";
import { GoogleDiscoveryManager } from "../src/google-discovery";
import { GraphQLManager } from "../src/graphql";
import { HttpActionManager } from "../src/http-actions";
import { OpenApiManager } from "../src/openapi";
import type { ServerRegistry } from "../src/registry";

export function testBackendOperationRuntime(
  registry: ServerRegistry,
  overrides: Partial<BackendOperationManagers> = {},
): BackendOperationRuntime {
  return createBackendOperationRuntime({
    mcp: overrides.mcp ?? new DownstreamManager(registry),
    openapi: overrides.openapi ?? new OpenApiManager(registry),
    googleDiscovery: overrides.googleDiscovery ?? new GoogleDiscoveryManager(registry),
    graphql: overrides.graphql ?? new GraphQLManager(registry),
    http: overrides.http ?? new HttpActionManager(registry),
    cli: overrides.cli ?? new CliToolsManager(registry),
    caplets: overrides.caplets ?? new CapletSetManager(registry),
  });
}
