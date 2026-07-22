import { isIP } from "node:net";
import { CapletsError } from "../errors";

export function canonicalizeCurrentHostOrigin(value: string): string {
  if (!isRootOnlyHttpOriginSyntax(value)) throw invalidOrigin();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalidOrigin();
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") throw invalidOrigin();
  if (url.username || url.password) throw invalidOrigin();
  if (
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    value.includes("?") ||
    value.includes("#")
  ) {
    throw invalidOrigin();
  }
  if (url.protocol === "http:" && !isLoopbackCurrentHostHostname(url.hostname)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      "Current Host HTTP origins must use a loopback host.",
    );
  }
  return url.origin;
}

export function isLoopbackCurrentHostHostname(hostname: string): boolean {
  const unwrapped =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (unwrapped.toLowerCase() === "localhost") return true;
  if (isIP(unwrapped) === 6) return unwrapped === "::1";
  if (isIP(unwrapped) !== 4) return false;
  return Number(unwrapped.split(".")[0]) === 127;
}

function isRootOnlyHttpOriginSyntax(value: string): boolean {
  return !/\s/u.test(value) && /^https?:\/\/[^/?#\\]+\/?$/iu.test(value);
}

function invalidOrigin(): CapletsError {
  return new CapletsError(
    "REQUEST_INVALID",
    "Current Host URL must be an HTTP(S) origin without credentials, path, query, or fragment.",
  );
}
