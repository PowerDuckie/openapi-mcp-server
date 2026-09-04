import { randomUUID } from "node:crypto";

/**
 * Node throws DOMException on AbortSignal and Error subclasses elsewhere, and
 * axios reports its own CanceledError. Matching on `name` covers all three
 * without importing axios internals.
 */
export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "CanceledError";
}


export function newId(): string {
  try {
    return randomUUID();
  } catch {
    return `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}