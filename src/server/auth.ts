
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";

function safeCompare(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function createAuthMiddleware(apiKey?: string): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    if (!apiKey) return next();
    const incoming = request.headers["x-api-key"];
    const value = Array.isArray(incoming) ? incoming[0] : incoming;
    if (!value || !safeCompare(value, apiKey)) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };
}
