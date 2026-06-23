/**
 * Node's POSIX filesystem APIs do not treat backslashes as path separators. Tests
 * sometimes emulate Windows daemon operations with POSIX temp directories, which
 * `node:path.win32` renders as drive-less absolute paths such as
 * `\tmp\caplets-...`. On POSIX hosts those strings would otherwise be created as
 * single backslash-named entries in the current working directory.
 */
export function daemonHostPath(path: string): string {
  if (process.platform === "win32") return path;
  if (!path.startsWith("\\") || path.startsWith("\\\\")) return path;
  if (/^[A-Za-z]:/u.test(path)) return path;
  return path.replaceAll("\\", "/");
}
