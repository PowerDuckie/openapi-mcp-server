import type { Request, Response, NextFunction, RequestHandler } from "express";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compares two secrets without leaking either their content or their length.
 *
 * `timingSafeEqual` requires equal-length buffers, and guarding that with an
 * early length check would itself expose the key length through response timing.
 * Hashing both sides to a fixed 32 bytes first removes the length signal
 * entirely and keeps every comparison on the same constant-time path.
 */
function safeCompare(left: string, right: string): boolean {
  const digest = (value: string): Buffer =>
    createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(left), digest(right));
}

/** Extracts a bearer token, tolerating the case variations seen in the wild. */
function readBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

function firstHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * Guards the admin API with a shared secret.
 *
 * Passing `undefined` disables the guard, which is the documented default for
 * loopback-only use. An empty or whitespace-only string is rejected instead of
 * being treated as "disabled": that case almost always means an environment
 * variable was set but never populated, and silently serving an unprotected
 * admin API to an operator who believes it is locked down is the worst possible
 * outcome.
 */
export function createAuthMiddleware(apiKey?: string): RequestHandler {
  if (apiKey !== undefined && apiKey.trim().length === 0) {
    throw new Error(
      "The configured API key is empty. Omit it entirely to run without authentication, or supply a non-empty value.",
    );
  }

  const expected = apiKey;

  return (request: Request, response: Response, next: NextFunction): void => {
    if (!expected) return next();

    // A CORS preflight carries no custom headers by design, so requiring the key
    // here would fail the preflight and surface in the browser as an opaque CORS
    // error rather than as an authentication problem. The preflight itself
    // reveals nothing, and the actual request that follows is still checked.
    if (request.method === "OPTIONS") return next();

    // Both header forms are accepted because MCP clients typically only expose a
    // field for `Authorization`, while the bundled web console uses `x-api-key`.
    const presented =
      firstHeaderValue(request.headers["x-api-key"]) ??
      readBearerToken(firstHeaderValue(request.headers.authorization));

    if (!presented || !safeCompare(presented, expected)) {
      response
        .status(401)
        .set("WWW-Authenticate", 'Bearer realm="openapi-mcp"')
        // `no-store` keeps an intermediary from caching the rejection and
        // serving it back once a correct key is supplied.
        .set("Cache-Control", "no-store")
        .json({ error: "Unauthorized" });
      return;
    }

    next();
  };
}
