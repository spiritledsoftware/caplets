import { CapletsError } from "../errors";
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
}
