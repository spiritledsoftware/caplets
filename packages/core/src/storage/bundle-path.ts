import { posix } from "node:path";

import { CapletsError } from "../errors";

export function normalizeBundlePath(value: string): string {
  if (typeof value !== "string") {
    throw new CapletsError("CONFIG_INVALID", "Invalid Caplet bundle path.");
  }
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  if (
    !value ||
    value.includes("\0") ||
    normalized === "." ||
    normalized.endsWith("/") ||
    normalized.startsWith("../") ||
    normalized.startsWith("/")
  ) {
    throw new CapletsError("CONFIG_INVALID", `Invalid Caplet bundle path ${value}.`);
  }
  return normalized;
}

export function validateBundlePathSet(paths: readonly string[]): string[] {
  const normalizedPaths: string[] = [];
  const exactPaths = new Set<string>();
  const caseFoldedPaths = new Map<string, string>();
  for (const candidate of paths) {
    const path = normalizeBundlePath(candidate);
    if (exactPaths.has(path)) {
      throw new CapletsError("CONFIG_INVALID", `Duplicate Caplet bundle path ${path}.`);
    }
    const collisionKey = path.normalize("NFC").toLocaleLowerCase("en-US");
    const collidingPath = caseFoldedPaths.get(collisionKey);
    if (collidingPath !== undefined) {
      throw new CapletsError(
        "CONFIG_INVALID",
        `Caplet bundle paths ${collidingPath} and ${path} differ only by case.`,
      );
    }
    exactPaths.add(path);
    caseFoldedPaths.set(collisionKey, path);
    normalizedPaths.push(path);
  }
  return normalizedPaths;
}
