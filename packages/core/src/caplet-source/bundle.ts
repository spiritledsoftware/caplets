import { CapletsError } from "../errors";
import type { DeclaredInputReader } from "./runtime-fingerprint";
import type { CapletSource, CapletSourceFile } from "./types";
import { normalizeCapletSourcePath } from "./types";

export class BundleCapletSource implements CapletSource {
  private readonly files: Map<string, CapletSourceFile>;

  constructor(files: CapletSourceFile[]) {
    this.files = new Map();
    for (const file of files) {
      const path = normalizeCapletSourcePath(file.path);
      if (!path) {
        throw new CapletsError("CONFIG_INVALID", `Invalid bundle file path ${file.path}`);
      }
      if (this.files.has(path)) {
        throw new CapletsError("CONFIG_INVALID", `Duplicate bundle file path ${path}`);
      }
      this.files.set(path, { path, content: file.content });
    }
  }

  async listFiles(): Promise<CapletSourceFile[]> {
    return [...this.files.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  async readFile(path: string): Promise<CapletSourceFile | undefined> {
    const normalized = normalizeCapletSourcePath(path);
    if (!normalized) {
      return undefined;
    }
    return this.files.get(normalized);
  }

  declaredInputReader(): DeclaredInputReader {
    return {
      read: (path) => {
        const normalized = normalizeCapletSourcePath(path);
        if (!normalized) return { state: "unreadable" };
        const file = this.files.get(normalized);
        return file
          ? { state: "present", content: file.content, privateKey: normalized }
          : { state: "missing", privateKey: normalized };
      },
      list: (root) => {
        const normalized = normalizeCapletSourcePath(root);
        if (!normalized) return { state: "unreadable" };
        const prefix = `${normalized}/`;
        const paths = [...this.files.keys()].filter((path) => path.startsWith(prefix)).sort();
        return paths.length > 0
          ? { state: "present", paths, privateKey: normalized }
          : { state: "missing", privateKey: normalized };
      },
    };
  }
}
