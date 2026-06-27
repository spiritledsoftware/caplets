import { defineMiddleware } from "astro/middleware";
import { applySecurityHeaders } from "./lib/catalog-response";

export const onRequest = defineMiddleware(async (_context, next) => {
  const response = await next();
  applySecurityHeaders(response.headers);
  return response;
});
