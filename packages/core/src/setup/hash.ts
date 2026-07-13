import { createHash } from "node:crypto";
import type { CapletConfig } from "../config";

export function capletSetupContentHash(caplet: CapletConfig): string {
  return createHash("sha256")
    .update(stableJson(stableCapletForHash(caplet)))
    .digest("hex");
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function stableCapletForHash(caplet: CapletConfig): Record<string, unknown> {
  return {
    server: caplet.server,
    name: caplet.name,
    description: caplet.description,
    backend: caplet.backend,
    tags: caplet.tags,
    setup: caplet.setup,
    backendConfig: Object.fromEntries(
      Object.entries(caplet).filter(
        ([key]) =>
          ![
            "server",
            "name",
            "description",
            "backend",
            "tags",
            "setup",
            "body",
            "disabled",
          ].includes(key),
      ),
    ),
  };
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
}
