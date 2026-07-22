import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { open as openFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { CapletsError } from "./errors";
export {
  capletFileSchema,
  capletJsonSchema,
  loadCapletFilesFromMap,
  parseCapletFileDocument,
} from "./caplet-files-bundle";
export type {
  BestEffortCapletFileLoadResult,
  CapletFileConfig,
  CapletFileLoadResult,
  CapletFileMapInput,
  CapletFileWarning,
  CapletFileFrontmatter,
  ParsedCapletFileDocument,
} from "./caplet-files-bundle";
import {
  buildCapletFileLoadResultFromEntries,
  errorMessage,
  readCapletFileContent,
  validateCapletId,
} from "./caplet-files-bundle";
import type {
  BestEffortCapletFileLoadResult,
  CapletFileConfig,
  CapletFileLoadResult,
  CapletFileWarning,
} from "./caplet-files-bundle";

export const MAX_CAPLET_FILE_BYTES = 128 * 1024;

export function loadCapletFiles(root: string): CapletFileConfig | undefined {
  return loadCapletFilesWithPaths(root)?.config;
}

export function loadCapletFilesWithPaths(root: string): CapletFileLoadResult | undefined {
  if (!existsSync(root)) {
    return undefined;
  }

  return buildCapletFileLoadResultFromEntries(root, discoverCapletFiles(root), (path) =>
    readCapletFile(path),
  );
}

export function loadCapletFilesWithPathsBestEffort(
  root: string,
): BestEffortCapletFileLoadResult | undefined {
  if (!existsSync(root)) {
    return undefined;
  }

  const warnings: CapletFileWarning[] = [];
  return buildCapletFileLoadResultFromEntries(
    root,
    discoverCapletFilesBestEffort(root, warnings),
    (path) => readCapletFile(path),
    warnings,
  );
}

export function discoverCapletFiles(root: string): Array<{ id: string; path: string }> {
  const entries = readdirSync(root, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const candidates: Array<{ id: string; path: string }> = [];
  function addCandidate(id: string, path: string): void {
    validateCapletId(id, path);
    candidates.push({ id, path });
  }

  for (const entry of entries) {
    if (entry.name === "auth" || entry.name === "config.json") {
      continue;
    }

    const path = join(root, entry.name);
    if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      addCandidate(basename(entry.name, extname(entry.name)), path);
      continue;
    }

    if (entry.isDirectory()) {
      const capletPath = join(path, "CAPLET.md");
      if (isRegularFileNoFollow(capletPath)) {
        addCandidate(entry.name, capletPath);
      }
    }
  }

  return candidates;
}

function discoverCapletFilesBestEffort(
  root: string,
  warnings: CapletFileWarning[],
): Array<{ id: string; path: string }> {
  const entries = readdirSync(root, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const byId = new Map<string, { id: string; path: string; isDirectoryCaplet: boolean }>();
  const duplicateIds = new Set<string>();

  function addCandidate(id: string, path: string, isDirectoryCaplet: boolean): void {
    try {
      validateCapletId(id, path);
    } catch (error) {
      warnings.push({
        path,
        message: `Skipping invalid Caplet file at ${path}: ${errorMessage(error)}`,
      });
      return;
    }

    if (duplicateIds.has(id)) {
      warnings.push({
        path,
        message: `Duplicate Caplet ID ${id} under ${root}; skipping duplicate at ${path}`,
      });
      return;
    }

    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { id, path, isDirectoryCaplet });
      return;
    }

    if (isDirectoryCaplet && !existing.isDirectoryCaplet) {
      warnings.push({
        path: existing.path,
        message: `Caplet file at ${existing.path} was shadowed by ${path}`,
      });
      byId.set(id, { id, path, isDirectoryCaplet });
      return;
    }

    if (!isDirectoryCaplet && existing.isDirectoryCaplet) {
      warnings.push({ path, message: `Caplet file at ${path} was shadowed by ${existing.path}` });
      return;
    }

    warnings.push({
      path,
      message: `Duplicate Caplet ID ${id} under ${root}; skipping ${existing.path} and ${path}`,
    });
    byId.delete(id);
    duplicateIds.add(id);
  }

  for (const entry of entries) {
    if (entry.name === "auth" || entry.name === "config.json") {
      continue;
    }

    const path = join(root, entry.name);
    if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      addCandidate(basename(entry.name, extname(entry.name)), path, false);
      continue;
    }

    if (entry.isDirectory()) {
      const capletPath = join(path, "CAPLET.md");
      if (isRegularFileNoFollow(capletPath)) {
        addCandidate(entry.name, capletPath, true);
      }
    }
  }

  return Array.from(byId.values()).map(({ id, path }) => ({ id, path }));
}

export async function readCapletFileText(path: string): Promise<string> {
  const file = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const content = Buffer.allocUnsafe(MAX_CAPLET_FILE_BYTES + 1);
  let offset = 0;
  try {
    if (!(await file.stat()).isFile()) throw invalidCapletFileType(path);
    while (offset < content.byteLength) {
      const { bytesRead } = await file.read(content, offset, content.byteLength - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
  } finally {
    await file.close();
  }
  if (offset > MAX_CAPLET_FILE_BYTES) throw oversizedCapletFile(path);
  return content.subarray(0, offset).toString("utf8");
}

export function readCapletFileTextSync(path: string): string {
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const content = Buffer.allocUnsafe(MAX_CAPLET_FILE_BYTES + 1);
  let offset = 0;
  try {
    if (!fstatSync(file).isFile()) throw invalidCapletFileType(path);
    while (offset < content.byteLength) {
      const bytesRead = readSync(file, content, offset, content.byteLength - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
  } finally {
    closeSync(file);
  }
  if (offset > MAX_CAPLET_FILE_BYTES) throw oversizedCapletFile(path);
  return content.subarray(0, offset).toString("utf8");
}

function readCapletFile(path: string): unknown {
  return readCapletFileContent(
    path,
    readCapletFileTextSync(path),
    dirname(path),
    normalizeLocalPath,
  );
}

function oversizedCapletFile(path: string): CapletsError {
  return new CapletsError(
    "CONFIG_INVALID",
    `Caplet file at ${path} exceeds the ${MAX_CAPLET_FILE_BYTES} byte limit`,
  );
}

function invalidCapletFileType(path: string): CapletsError {
  return new CapletsError("CONFIG_INVALID", `Caplet file at ${path} must be a regular file`);
}

function isRegularFileNoFollow(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function validateCapletFile(path: string): void {
  readCapletFile(path);
}

function normalizeLocalPath(value: string | undefined, baseDir: string): string | undefined {
  if (!value || isAbsolute(value) || hasInterpolationReference(value)) {
    return value;
  }
  return join(baseDir, value);
}

function hasInterpolationReference(value: string): boolean {
  return /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$env:[A-Za-z_][A-Za-z0-9_]*|\$\{vault:[^}]+\}|\$vault:[A-Za-z0-9_-]+/.test(
    value,
  );
}
