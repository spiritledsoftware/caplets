export type CapletSourceFile = {
  path: string;
  content: string;
};

export type CapletSource = {
  listFiles(): Promise<CapletSourceFile[]>;
  readFile(path: string): Promise<CapletSourceFile | undefined>;
};

export function normalizeCapletSourcePath(path: string): string | undefined {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\.\//u, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) {
    return undefined;
  }

  const stack: string[] = [];
  for (const segment of normalized.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (stack.length === 0) {
        return undefined;
      }
      stack.pop();
      continue;
    }
    stack.push(segment);
  }

  return stack.length > 0 ? stack.join("/") : undefined;
}
