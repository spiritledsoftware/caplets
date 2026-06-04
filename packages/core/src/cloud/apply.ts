import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";

export type ApplyReceiptInput = {
  projectFingerprint: string;
  filesChanged: string[];
  skipped: string[];
  policyWarnings: string[];
};

export type ApplyReceipt = ApplyReceiptInput & {
  status: "applied";
};

export type ApplyConflict = {
  path: string;
  kind: "content" | "delete_modify" | "binary";
  message?: string;
};

export type RemoteFileChange = {
  path: string;
  baseSha256?: string;
  content: string;
};

export function createApplyReceipt(input: ApplyReceiptInput): ApplyReceipt {
  return { status: "applied", ...input };
}

export function classifyApplyResult(input: {
  conflicts: ApplyConflict[];
}):
  | { status: "applied"; recoverable: false }
  | { status: "apply_conflict"; recoverable: true; conflicts: ApplyConflict[] } {
  if (input.conflicts.length === 0) return { status: "applied", recoverable: false };
  return { status: "apply_conflict", recoverable: true, conflicts: input.conflicts };
}

export function applyRemoteFileChanges(
  projectRoot: string,
  changes: RemoteFileChange[],
): ApplyReceipt | { status: "apply_conflict"; recoverable: true; conflicts: ApplyConflict[] } {
  const root = resolve(projectRoot);
  const realRoot = realpathSync(root);
  const conflicts: ApplyConflict[] = [];
  const writable: Array<{ path: string; absolutePath: string; content: string }> = [];

  for (const change of changes) {
    const absolutePath = resolve(root, change.path);
    if (relative(root, absolutePath).startsWith("..")) {
      conflicts.push({ path: change.path, kind: "content", message: "Path escapes project root." });
      continue;
    }
    if (pathHasSymlink(root, realRoot, absolutePath)) {
      conflicts.push({ path: change.path, kind: "content", message: "Path traverses a symlink." });
      continue;
    }
    const current = existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : "";
    if (change.baseSha256 && sha256(current) !== change.baseSha256) {
      conflicts.push({
        path: change.path,
        kind: "content",
        message: "Local file changed since the remote sandbox base.",
      });
      continue;
    }
    writable.push({ path: change.path, absolutePath, content: change.content });
  }

  if (conflicts.length > 0) {
    return { status: "apply_conflict", recoverable: true, conflicts };
  }

  for (const change of writable) {
    mkdirSync(dirname(change.absolutePath), { recursive: true });
    writeFileSync(change.absolutePath, change.content, "utf8");
  }

  return createApplyReceipt({
    projectFingerprint: sha256(root),
    filesChanged: writable.map((change) => change.path),
    skipped: [],
    policyWarnings: [],
  });
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pathHasSymlink(root: string, realRoot: string, target: string): boolean {
  let current = root;
  for (const part of relative(root, target).split(/[\\/]+/u)) {
    if (!part) continue;
    current = resolve(current, part);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) return true;
    const real = realpathSync(current);
    if (relative(realRoot, real).startsWith("..")) return true;
  }
  return false;
}
