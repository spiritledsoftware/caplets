import { Dirent, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  DeclaredInputListState,
  DeclaredInputReader,
  DeclaredInputState,
} from "./runtime-fingerprint";
import type { CapletSource, CapletSourceFile } from "./types";
import { normalizeCapletSourcePath } from "./types";

export class FilesystemCapletSource implements CapletSource {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async listFiles(): Promise<CapletSourceFile[]> {
    try {
      if (!existsSync(this.root) || !statSync(this.root).isDirectory()) return [];
      return walkFiles(this.root, this.root, realpathSync(this.root), new Set()).sort(
        (left, right) => left.path.localeCompare(right.path),
      );
    } catch {
      return [];
    }
  }

  async readFile(path: string): Promise<CapletSourceFile | undefined> {
    const state = this.readDeclaredInput(path);
    if (state.state !== "present") return undefined;
    const normalized = normalizeCapletSourcePath(path);
    return normalized ? { path: normalized, content: state.content } : undefined;
  }

  declaredInputReader(): DeclaredInputReader {
    return {
      read: (path) => this.readDeclaredInput(path),
      list: (root) => this.listDeclaredInputs(root),
    };
  }

  private readDeclaredInput(path: string): DeclaredInputState {
    const normalized = normalizeCapletSourcePath(path);
    if (!normalized) return { state: "unreadable" };
    const absolute = resolve(this.root, normalized);
    if (!isWithinRoot(this.root, absolute)) return { state: "unreadable" };
    if (!existsSync(absolute)) return { state: "missing", privateKey: normalized };
    try {
      const realRoot = realpathSync(this.root);
      const realPath = realpathSync(absolute);
      if (!isWithinRoot(realRoot, realPath) || !statSync(realPath).isFile()) {
        return { state: "unreadable", privateKey: realPath };
      }
      return {
        state: "present",
        content: readFileSync(realPath, "utf8"),
        privateKey: realPath,
      };
    } catch {
      return { state: "unreadable", privateKey: normalized };
    }
  }

  private listDeclaredInputs(root: string): DeclaredInputListState {
    const normalized = normalizeCapletSourcePath(root);
    if (!normalized) return { state: "unreadable" };
    const absolute = resolve(this.root, normalized);
    if (!isWithinRoot(this.root, absolute)) return { state: "unreadable" };
    if (!existsSync(absolute)) return { state: "missing", privateKey: normalized };
    try {
      const realRoot = realpathSync(this.root);
      const realPath = realpathSync(absolute);
      if (!isWithinRoot(realRoot, realPath) || !statSync(realPath).isDirectory()) {
        return { state: "unreadable", privateKey: realPath };
      }
      return {
        state: "present",
        paths: walkFiles(this.root, absolute, realRoot, new Set())
          .map((file) => file.path)
          .sort(),
        privateKey: realPath,
      };
    } catch {
      return { state: "unreadable", privateKey: normalized };
    }
  }
}

function walkFiles(
  root: string,
  dir: string,
  realRoot: string,
  visitedDirectories: Set<string>,
): CapletSourceFile[] {
  const realDirectory = realpathSync(dir);
  if (!isWithinRoot(realRoot, realDirectory) || visitedDirectories.has(realDirectory)) return [];
  visitedDirectories.add(realDirectory);
  const files: CapletSourceFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort(compareDirents)) {
    const absolute = join(dir, entry.name);
    try {
      const realPath = realpathSync(absolute);
      if (!isWithinRoot(realRoot, realPath)) continue;
      const stat = statSync(realPath);
      if (stat.isDirectory()) {
        files.push(...walkFiles(root, absolute, realRoot, visitedDirectories));
        continue;
      }
      if (!stat.isFile()) continue;
      const normalized = normalizeCapletSourcePath(relative(root, absolute));
      if (normalized) files.push({ path: normalized, content: readFileSync(realPath, "utf8") });
    } catch {
      continue;
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
