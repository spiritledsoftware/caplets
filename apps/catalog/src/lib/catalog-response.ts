export function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", headers.get("cache-control") ?? "public, max-age=60");
  applySecurityHeaders(headers);
  return new Response(JSON.stringify(data, null, 2), { ...init, headers });
}

export function notFound(message = "Catalog entry not found."): Response {
  return jsonResponse({ ok: false, error: { code: "not_found", message } }, { status: 404 });
}

export function applySecurityHeaders(headers: Headers): Headers {
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "strict-origin-when-cross-origin");
  headers.set("permissions-policy", "interest-cohort=()");
  headers.set(
    "content-security-policy",
    [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "img-src 'self' data: https:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
    ].join("; "),
  );
  return headers;
}
