import type { MiddlewareHandler } from "hono";

/**
 * Cancels a request body nothing read. A refusal sent before the handler
 * reads the body (401, 404, 400 on a POST/PUT/PATCH) leaves the stream open,
 * and workerd then logs "Can't read from request stream after response has
 * been sent". Cancelling never reads it: a large body is not pulled into
 * memory. Never throws.
 */
export function cancelUnreadBody(req: Request): boolean {
  const b = req.body;
  if (!b || req.bodyUsed || b.locked) return false;
  b.cancel().catch(() => {});
  return true;
}

/**
 * Outermost middleware: after any error response (onError and notFound run
 * inside), the unread request body is cancelled. Successful responses are
 * left alone (a handler may still be streaming its body).
 */
export function cancelUnreadOnRefusal(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (c.res.status >= 400) cancelUnreadBody(c.req.raw);
  };
}
