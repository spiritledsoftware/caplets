export const SERVER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
export const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
export const FORBIDDEN_HEADERS = new Set([
  "accept",
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "host",
  "keep-alive",
  "mcp-protocol-version",
  "mcp-session-id",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export function isAllowedRemoteUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === "https:") {
    return true;
  }
  return (
    url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)
  );
}
