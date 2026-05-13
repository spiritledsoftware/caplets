export const SERVER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
export const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
export const HTTP_BASE_URL_PATTERN = /^(?![a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*@)[^?#]*$/;
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

type ValidationIssueSink = {
  addIssue(issue: { code: "custom"; path: Array<string>; message: string }): void;
};

export function validateHttpActionHeaders(
  headers: Record<string, unknown>,
  ctx: ValidationIssueSink,
  path: Array<string>,
): void {
  for (const headerName of Object.keys(headers)) {
    const normalized = headerName.toLowerCase();
    if (!HEADER_NAME_PATTERN.test(headerName) || FORBIDDEN_HEADERS.has(normalized)) {
      ctx.addIssue({
        code: "custom",
        path: [...path, headerName],
        message: `header ${headerName} is not allowed`,
      });
    }
  }
}

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

export function isAllowedHttpBaseUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return isAllowedRemoteUrl(value) && !url.username && !url.password && !url.search && !url.hash;
}

export function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
