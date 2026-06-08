import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { CapletsError } from "../errors";

export type CloudCapletBundleFile = {
  path: string;
  content: string;
};

export type CloudCapletBundle = {
  files: CloudCapletBundleFile[];
};

const MAX_CLOUD_CAPLET_BUNDLE_BYTES = 2 * 1024 * 1024;
const SKIPPED_DIRECTORY_NAMES = new Set([".git", "node_modules", "auth"]);

export function buildCloudCapletBundle(rootInput: string): CloudCapletBundle {
  const root = resolve(rootInput);
  if (!existsSync(root)) {
    throw new CapletsError("CONFIG_INVALID", `Caplet path does not exist: ${rootInput}`);
  }
  if (!statSync(root).isDirectory()) {
    throw new CapletsError("CONFIG_INVALID", `Caplet path must be a directory: ${rootInput}`);
  }

  const files = collectFiles(root)
    .map((filePath) => ({
      path: relative(root, filePath).split(sep).join("/"),
      content: readFileSync(filePath, "utf8"),
    }))
    .filter((file) => file.path !== "config.json")
    .sort((left, right) => left.path.localeCompare(right.path));

  const totalBytes = files.reduce((total, file) => total + Buffer.byteLength(file.content), 0);
  if (totalBytes > MAX_CLOUD_CAPLET_BUNDLE_BYTES) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Caplet bundle is too large for Cloud upload (${totalBytes} bytes).`,
    );
  }
  if (!files.some((file) => file.path.endsWith(".md") || file.path.endsWith("/CAPLET.md"))) {
    throw new CapletsError("CONFIG_INVALID", `No Caplet files found under ${rootInput}`);
  }

  return { files };
}

function collectFiles(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
      files.push(...collectFiles(path));
      continue;
    }
    if (entry.isFile()) files.push(path);
  }
  return files;
}
