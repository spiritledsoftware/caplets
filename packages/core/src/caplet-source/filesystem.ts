import { Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CapletSource, CapletSourceFile } from "./types";
import { normalizeCapletSourcePath } from "./types";

export class FilesystemCapletSource implements CapletSource {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async listFiles(): Promise<CapletSourceFile[]> {
    if (!existsSync(this.root) || !statSync(this.root).isDirectory()) {
      return [];
    }
    return walkFiles(this.root, this.root).sort((left, right) =>
      left.path.localeCompare(right.path),
    );
  }

  async readFile(path: string): Promise<CapletSourceFile | undefined> {
    const normalized = normalizeCapletSourcePath(path);
    if (!normalized) {
      return undefined;
    }
    const absolute = resolve(this.root, normalized);
    if (
      !isWithinRoot(this.root, absolute) ||
      !existsSync(absolute) ||
      !statSync(absolute).isFile()
    ) {
      return undefined;
    }
    return { path: normalized, content: readFileSync(absolute, "utf8") };
  }
}

function walkFiles(root: string, dir: string): CapletSourceFile[] {
  const files: CapletSourceFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort(compareDirents)) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(root, absolute));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const normalized = normalizeCapletSourcePath(relative(root, absolute));
    if (normalized) {
      files.push({ path: normalized, content: readFileSync(absolute, "utf8") });
    }
  }
  return files;
}

function compareDirents(left: Dirent, right: Dirent): number {
  return left.name.localeCompare(right.name);
}

function isWithinRoot(root: string, absolute: string): boolean {
  const rel = relative(root, absolute);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
