import { createHash } from "node:crypto";
import { stableJsonStringify } from "./stable-json";

export function schemaHash(schema: unknown | undefined): string | null {
  if (schema === undefined || schema === null) {
    return null;
  }
  const json = stableJsonStringify(schema);
  return `sha256:${createHash("sha256").update(json).digest("hex")}`;
}
