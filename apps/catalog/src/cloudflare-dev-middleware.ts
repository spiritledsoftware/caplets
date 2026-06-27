import type { MiddlewareHandler } from "astro";

export const onRequest: MiddlewareHandler = (_context, next) => next();
