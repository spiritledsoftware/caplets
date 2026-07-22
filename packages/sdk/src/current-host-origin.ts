export function canonicalizeCurrentHostOrigin(value: string | URL): string {
  if (typeof value === "string" && !isRootOnlyHttpOriginSyntax(value)) {
    throw invalidCurrentHostOrigin();
  }
  const raw = typeof value === "string" ? value : value.href;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidCurrentHostOrigin();
  }

  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    raw.includes("?") ||
    raw.includes("#")
  ) {
    throw invalidCurrentHostOrigin();
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new TypeError("Current Host HTTP origins must use a loopback host");
  }
  return url.origin;
}

function isRootOnlyHttpOriginSyntax(value: string): boolean {
  return !/\s/u.test(value) && /^https?:\/\/[^/?#\\]+\/?$/iu.test(value);
}

function isLoopbackHostname(hostname: string): boolean {
  const unwrapped =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (unwrapped.toLowerCase() === "localhost" || unwrapped === "::1") return true;
  const octets = unwrapped.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255) &&
    Number(octets[0]) === 127
  );
}

function invalidCurrentHostOrigin(): TypeError {
  return new TypeError(
    "baseUrl must be an HTTP(S) Current Host origin without credentials, path, query, or fragment",
  );
}
