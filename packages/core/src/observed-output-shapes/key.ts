import { createHash } from "node:crypto";
import type { CapletConfig } from "../config";
import { schemaHash } from "../schema-hash";
import { stableJsonStringify } from "../stable-json";
import { OBSERVED_OUTPUT_SHAPE_VERSION, type ObservedOutputShapeKey } from "./types";

export function observedOutputShapeStorageKey(key: ObservedOutputShapeKey): string {
  return stableHash(key);
}

export function observedOutputShapeKey(input: {
  scope: ObservedOutputShapeKey["scope"];
  workspaceId?: string | undefined;
  projectFingerprint?: string | undefined;
  caplet: CapletConfig;
  toolName: string;
  toolDescriptor?: unknown;
  outputSchema?: unknown;
}): ObservedOutputShapeKey {
  const toolDescriptorHash = input.toolDescriptor ? stableHash(input.toolDescriptor) : undefined;
  const outputSchemaHash = schemaHash(input.outputSchema) ?? undefined;
  return {
    scope: input.scope,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.projectFingerprint ? { projectFingerprint: input.projectFingerprint } : {}),
    capletId: input.caplet.server,
    backendKind: input.caplet.backend,
    backendFingerprint: backendFingerprint(input.caplet),
    toolName: input.toolName,
    ...(toolDescriptorHash ? { toolDescriptorHash } : {}),
    ...(outputSchemaHash ? { outputSchemaHash } : {}),
    resultVersion: OBSERVED_OUTPUT_SHAPE_VERSION,
  };
}

export function backendFingerprint(caplet: CapletConfig): string {
  return stableHash(nonSecretBackendIdentity(caplet));
}

export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}

function nonSecretBackendIdentity(caplet: CapletConfig): unknown {
  switch (caplet.backend) {
    case "mcp":
      return caplet.transport === "stdio"
        ? {
            backend: caplet.backend,
            server: caplet.server,
            transport: caplet.transport,
            command: caplet.command,
            args: caplet.args,
            cwd: caplet.cwd,
          }
        : {
            backend: caplet.backend,
            server: caplet.server,
            transport: caplet.transport,
            url: caplet.url,
          };
    case "openapi":
      return {
        backend: caplet.backend,
        server: caplet.server,
        specPath: caplet.specPath,
        specUrl: caplet.specUrl,
        baseUrl: caplet.baseUrl,
      };
    case "googleDiscovery":
      return {
        backend: caplet.backend,
        server: caplet.server,
        discoveryPath: caplet.discoveryPath,
        discoveryUrl: caplet.discoveryUrl,
        baseUrl: caplet.baseUrl,
        includeOperations: caplet.includeOperations,
        excludeOperations: caplet.excludeOperations,
      };
    case "graphql":
      return {
        backend: caplet.backend,
        server: caplet.server,
        endpointUrl: caplet.endpointUrl,
        schemaPath: caplet.schemaPath,
        schemaUrl: caplet.schemaUrl,
        introspection: caplet.introspection,
        operations: caplet.operations,
      };
    case "http":
      return {
        backend: caplet.backend,
        server: caplet.server,
        baseUrl: caplet.baseUrl,
        actions: Object.fromEntries(
          Object.entries(caplet.actions).map(([name, action]) => [
            name,
            {
              method: action.method,
              path: action.path,
              query: action.query,
              hasJsonBody: action.jsonBody !== undefined,
            },
          ]),
        ),
      };
    case "cli":
      return {
        backend: caplet.backend,
        server: caplet.server,
        cwd: caplet.cwd,
        actions: Object.fromEntries(
          Object.entries(caplet.actions).map(([name, action]) => [
            name,
            {
              command: action.command,
              args: action.args,
              cwd: action.cwd,
              output: action.output,
            },
          ]),
        ),
      };
    case "caplets":
      return {
        backend: caplet.backend,
        server: caplet.server,
        configPath: caplet.configPath,
        capletsRoot: caplet.capletsRoot,
      };
  }
}
