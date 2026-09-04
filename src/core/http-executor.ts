import axios, { AxiosError, AxiosHeaders } from "axios";
import { randomUUID } from "node:crypto";
import type { Document } from "@scalar/openapi-types/3.2";
import { buildRequest } from "./request-builder";
import { getBindingIndex } from "./tool-generator";
import { findOperationById } from "./spec-utils";
import type { ExecutionContext, LoggedQuery, RequestLogEntry } from "../types";
import { newId } from "./global-utils";

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_CONTENT_BYTES = 10 * 1024 * 1024;
const MAX_RESULT_CHARS = 50_000;
/** Upper bound on a logged body, independent of what is returned to the model. */
const MAX_LOGGED_BODY_CHARS = 8_000;

/**
 * Header names whose values must never reach the log store. The web UI renders
 * logs verbatim, so a leaked credential would be visible in the browser and in
 * any exported log file.
 */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "api-key",
  "x-auth-token",
  "x-access-token",
  "x-csrf-token",
]);

export interface ToolCallResult {
  status: number;
  statusText: string;
  headers: Record<string, unknown>;
  data: unknown;
  truncated: boolean;
  url: string;
  method: string;
  durationMs: number;
  /** Ties the request and response log entries together. */
  correlationId: string;
}

/** Classification of a transport-level failure, used for actionable messages. */
type FailureKind =
  | "timeout"
  | "canceled"
  | "dns"
  | "connection-refused"
  | "tls"
  | "payload-too-large"
  | "unknown";

/**
 * Collapses a `URLSearchParams` into the logged query shape.
 *
 * Repeated keys are legal in a query string — `?tag=a&tag=b` is exactly what an
 * exploded array parameter produces — so a duplicate must widen its entry into
 * an array instead of overwriting the earlier value. The record form cannot
 * preserve the relative order of different keys; order within a single key is
 * retained, which is the part that carries meaning.
 */
function groupQuery(params: URLSearchParams): LoggedQuery {
  const grouped: LoggedQuery = {};
  for (const [key, value] of params.entries()) {
    const existing = grouped[key];
    if (existing === undefined) {
      grouped[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      grouped[key] = [existing, value];
    }
  }
  return grouped;
}

/**
 * Maps an axios failure onto an actionable category.
 *
 * `callerAborted` is not optional sugar. When `timeout` and `signal` are both
 * supplied, axios surfaces a timeout as ECONNABORTED and a signal abort as
 * ERR_CANCELED — but older versions and some adapters report a timeout as
 * ERR_CANCELED too. Without consulting the caller's own signal, a genuine
 * upstream timeout gets reported as "cancelled by the client", which is the
 * exact false signal that cost us an afternoon.
 */
export function classifyFailure(
  error: AxiosError,
  callerAborted = false,
): FailureKind {
  const code = error.code ?? "";
  const name = error.name ?? "";
  const message = error.message ?? "";

  if (code === "ETIMEDOUT" || /timeout/i.test(message)) return "timeout";

  if (
    code === "ERR_CANCELED" ||
    code === "ECONNABORTED" ||
    name === "CanceledError" ||
    name === "AbortError"
  ) {
    // Only the caller's signal can distinguish the two here.
    return callerAborted ? "canceled" : "timeout";
  }

  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EHOSTUNREACH"
  ) {
    return "connection-refused";
  }
  if (
    code.startsWith("ERR_TLS") ||
    code === "CERT_HAS_EXPIRED" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT"
  ) {
    return "tls";
  }
  if (
    code === "ERR_FR_MAX_BODY_LENGTH_EXCEEDED" ||
    (code === "ERR_BAD_RESPONSE" && /maxContentLength/i.test(message))
  ) {
    return "payload-too-large";
  }
  return "unknown";
}

/** Case-insensitive lookup over a plain header record. */
function findHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return findHeader(headers, name) !== undefined;
}

/** Replaces credential values so a log entry can be shown safely. */
function redactHeaders(
  headers: Record<string, string | undefined>,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    output[key] = SENSITIVE_HEADERS.has(key.toLowerCase())
      ? "[redacted]"
      : value;
  }
  return output;
}

function normalizeResponseHeaders(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    output[key] = SENSITIVE_HEADERS.has(key.toLowerCase())
      ? "[redacted]"
      : value;
  }
  return output;
}

/**
 * Serializes a value once and truncates it against the two different limits.
 *
 * The model-facing result and the log entry use different budgets, and
 * stringifying a large payload twice is pure waste on a hot path.
 */
function trimAtLimits(
  value: unknown,
  limits: readonly [number, number],
): Array<{ value: unknown; truncated: boolean }> {
  if (value === undefined || value === null || typeof value === "number") {
    return limits.map(() => ({ value, truncated: false }));
  }

  let serialized: string | null = null;
  if (typeof value === "string") {
    serialized = value;
  } else if (typeof value === "object") {
    try {
      serialized = JSON.stringify(value);
    } catch {
      // Circular or otherwise unserializable payloads still need a placeholder
      // rather than propagating a throw out of a logging path.
      return limits.map(() => ({
        value: "[unserializable value]",
        truncated: true,
      }));
    }
  }

  if (serialized === null) {
    return limits.map(() => ({ value, truncated: false }));
  }

  const text = serialized;
  return limits.map((limit) =>
    text.length <= limit
      ? { value, truncated: false }
      : { value: `${text.slice(0, limit)}\n...[truncated]`, truncated: true },
  );
}

function trimLargeValue(
  value: unknown,
  limit: number,
): { value: unknown; truncated: boolean } {
  return trimAtLimits(value, [limit, limit])[0] as {
    value: unknown;
    truncated: boolean;
  };
}

function emitLog(
  onLog: ExecutionContext["onLog"],
  entry: RequestLogEntry,
): void {
  try {
    onLog?.(entry);
  } catch {
    // Logging must never break user traffic.
  }
}

/**
 * Normalizes whatever the request builder produced into a `URLSearchParams`.
 *
 * Accepting several shapes keeps this executor decoupled from the builder's
 * internal representation, and `URLSearchParams` is the only form that can
 * faithfully carry repeated keys such as `?tag=a&tag=b`.
 */
function toSearchParams(query: unknown): URLSearchParams {
  if (query instanceof URLSearchParams) return query;

  const params = new URLSearchParams();
  if (!query || typeof query !== "object") return params;

  if (Array.isArray(query)) {
    for (const entry of query) {
      if (Array.isArray(entry) && entry.length === 2) {
        params.append(String(entry[0]), String(entry[1] ?? ""));
      }
    }
    return params;
  }

  for (const [key, value] of Object.entries(query as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null) continue;
        params.append(key, String(item));
      }
      continue;
    }
    params.append(key, String(value));
  }
  return params;
}

/**
 * Serializes the request body according to the media type selected at
 * generation time.
 *
 * Returning the value axios should send, plus the Content-Type it must be sent
 * with, keeps the two decisions from drifting apart — declaring
 * `multipart/form-data` while sending JSON is a silent way to make every upload
 * fail with a 400 that looks like an upstream bug.
 */
function serializeBody(
  body: unknown,
  encoding: string | null | undefined,
): { data: unknown; contentType?: string | undefined } {
  if (body === undefined) return { data: undefined };

  switch (encoding) {
    case "form-urlencoded": {
      const text =
        body && typeof body === "object"
          ? toSearchParams(body).toString()
          : String(body);
      return {
        data: text,
        contentType: "application/x-www-form-urlencoded",
      };
    }

    case "multipart": {
      if (!body || typeof body !== "object") return { data: body };
      const form = new FormData();
      for (const [key, value] of Object.entries(
        body as Record<string, unknown>,
      )) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          for (const item of value) {
            if (item === undefined || item === null) continue;
            form.append(key, String(item));
          }
          continue;
        }
        if (typeof value === "object") {
          // Nested objects have no multipart representation of their own; the
          // specification says to encode them as JSON parts.
          form.append(
            key,
            new Blob([JSON.stringify(value)], { type: "application/json" }),
          );
          continue;
        }
        form.append(key, String(value));
      }
      // The boundary must be generated by the serializer, so the Content-Type
      // header is deliberately left unset here.
      return { data: form };
    }

    case "binary": {
      if (typeof body === "string") {
        // A base64 argument is the only way a JSON tool call can carry bytes.
        try {
          return {
            data: Buffer.from(body, "base64"),
            contentType: "application/octet-stream",
          };
        } catch {
          return { data: body, contentType: "application/octet-stream" };
        }
      }
      return { data: body, contentType: "application/octet-stream" };
    }

    case "text":
      return {
        data: typeof body === "string" ? body : JSON.stringify(body),
        contentType: "text/plain",
      };

    case "json":
    default:
      return { data: body, contentType: "application/json" };
  }
}

/** A loggable stand-in for payloads that are not textual. */
function describeBodyForLog(data: unknown): unknown {
  if (typeof FormData !== "undefined" && data instanceof FormData) {
    return "[multipart form data]";
  }
  if (Buffer.isBuffer(data)) return `[binary, ${data.byteLength} bytes]`;
  return data;
}

/**
 * Executes one generated tool against the upstream API.
 *
 * A non-2xx upstream response is returned as data rather than thrown: the model
 * must be able to read the status and body to decide what to do next. Only
 * transport-level failures throw.
 */
export async function executeToolCall(
  spec: Document,
  toolName: string,
  args: Record<string, unknown> | undefined,
  context: ExecutionContext = {},
): Promise<ToolCallResult> {
  const trimmedName = toolName.trim();
  if (!trimmedName) throw new Error("A tool name is required.");

  // The binding index is the authoritative map from tool name to operation and
  // carries the argument placement, so it is consulted first. findOperationById
  // remains as a fallback for callers that pass a raw operationId.
  const binding = getBindingIndex(spec).get(trimmedName);
  const resolved = binding
    ? {
        path: binding.path,
        method: binding.method,
        operation: binding.operation,
        pathItem: binding.pathItem,
      }
    : findOperationById(spec, trimmedName);

  if (!resolved) {
    throw new Error(
      `Tool "${trimmedName}" was not found in the specification.`,
    );
  }

  const baseUrl = context.baseUrlOverride ?? spec.servers?.[0]?.url ?? "";
  if (!baseUrl) {
    throw new Error(
      "No upstream base URL is available: the document declares no servers and no override was configured.",
    );
  }

  const protocol = context.protocol;
  const correlationId = newId();
  const methodUpper = resolved.method.toUpperCase();
  const timeoutMs = Math.max(
    MIN_TIMEOUT_MS,
    context.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  // Fail fast on an already-cancelled call rather than opening a socket.
  //
  // Thrown as an AbortError so callers can branch on `name` instead of matching
  // the message text, which silently breaks the moment the wording changes.
  if (context.signal?.aborted) {
    throw new DOMException(
      "The tool call was cancelled before it was dispatched.",
      "AbortError",
    );
  }

  const built = buildRequest(
    baseUrl,
    resolved.path,
    resolved.pathItem,
    resolved.operation,
    args ?? {},
    binding,
  );

  const startedAt = Date.now();
  const searchParams = toSearchParams(built.query);

  const mergedHeaders: Record<string, string> = {};
  // Operator-configured headers first, so per-request headers derived from the
  // document always win.
  for (const [key, value] of Object.entries(context.upstreamHeaders ?? {})) {
    if (typeof value === "string") mergedHeaders[key] = value;
  }
  for (const [key, value] of Object.entries(built.headers ?? {})) {
    if (typeof value === "string") mergedHeaders[key] = value;
  }

  // Security material is injected here rather than exposed as tool arguments,
  // so a model can neither read nor override the credentials.
  if (context.security?.bearerToken) {
    mergedHeaders.Authorization = `Bearer ${context.security.bearerToken}`;
  } else if (context.security?.basicAuth) {
    const raw = `${context.security.basicAuth.username}:${context.security.basicAuth.password}`;
    mergedHeaders.Authorization = `Basic ${Buffer.from(raw, "utf8").toString(
      "base64",
    )}`;
  }

  for (const [name, value] of Object.entries(context.security?.apiKeys ?? {})) {
    if (!hasHeader(mergedHeaders, name)) mergedHeaders[name] = value;
  }

  const serialized = serializeBody(built.body, binding?.bodyEncoding ?? null);

  if (
    serialized.data !== undefined &&
    !hasHeader(mergedHeaders, "content-type")
  ) {
    // Prefer the exact media type from the document; fall back to what the
    // serializer chose. Multipart intentionally provides neither, because the
    // boundary parameter must be generated during serialization.
    const chosen =
      binding?.bodyEncoding === "multipart"
        ? undefined
        : (binding?.bodyMediaType ?? serialized.contentType);
    if (chosen) mergedHeaders["Content-Type"] = chosen;
  }

  if (!hasHeader(mergedHeaders, "accept")) {
    mergedHeaders.Accept = "application/json, text/plain;q=0.9, */*;q=0.8";
  }

  const loggedRequestBody = trimLargeValue(
    describeBodyForLog(serialized.data),
    MAX_LOGGED_BODY_CHARS,
  );

  emitLog(context.onLog, {
    id: newId(),
    correlationId,
    at: new Date().toISOString(),
    direction: "request",
    protocol,
    toolName: trimmedName,
    operationId: trimmedName,
    method: methodUpper,
    path: resolved.path,
    url: built.url,
    requestHeaders: redactHeaders(mergedHeaders),
    requestQuery: groupQuery(searchParams),
    requestBody: loggedRequestBody.value,
    truncated: loggedRequestBody.truncated,
    meta: { stage: "before-upstream" },
  });

  try {
    const response = await axios({
      // A lowercase custom method (OpenAPI 3.2 additional operations) is passed
      // through unchanged; axios forwards it to the HTTP layer verbatim.
      method: resolved.method,
      url: built.url,
      params: searchParams,
      // The builder already applied the style and explode rules together with
      // percent-encoding. Re-serializing here would double-encode every value.
      paramsSerializer: {
        serialize: (params) =>
          params instanceof URLSearchParams
            ? params.toString()
            : toSearchParams(params).toString(),
      },
      ...(serialized.data !== undefined ? { data: serialized.data } : {}),
      headers: new AxiosHeaders(mergedHeaders),
      timeout: timeoutMs,
      maxContentLength: MAX_CONTENT_BYTES,
      maxBodyLength: MAX_CONTENT_BYTES,
      maxRedirects: 5,
      decompress: true,
      // Read as text and parse manually: axios's own JSON parsing hides the raw
      // payload, which is exactly what an operator needs when a response is
      // malformed.
      responseType: "text",
      transformResponse: [(data: unknown) => data],
      // Any status is a valid answer. Letting axios throw on 4xx would turn an
      // upstream validation error into an opaque transport failure.
      validateStatus: () => true,
      ...(context.signal ? { signal: context.signal } : {}),
    });

    const responseHeaders = normalizeResponseHeaders(response.headers);
    const rawHeaders = response.headers as Record<string, unknown> | undefined;
    const contentType = String(rawHeaders?.["content-type"] ?? "");

    let data: unknown = response.data;
    if (
      typeof data === "string" &&
      data.length > 0 &&
      /\bjson\b/i.test(contentType)
    ) {
      try {
        data = JSON.parse(data);
      } catch {
        // Keep the raw text: a server that mislabels its Content-Type is a real
        // condition the caller should be able to see.
      }
    }

    const [forModel, forLog] = trimAtLimits(data, [
      MAX_RESULT_CHARS,
      MAX_LOGGED_BODY_CHARS,
    ]) as [
      { value: unknown; truncated: boolean },
      { value: unknown; truncated: boolean },
    ];
    const durationMs = Date.now() - startedAt;

    emitLog(context.onLog, {
      id: newId(),
      correlationId,
      at: new Date().toISOString(),
      direction: "response",
      protocol,
      toolName: trimmedName,
      operationId: trimmedName,
      method: methodUpper,
      path: resolved.path,
      url: built.url,
      status: response.status,
      durationMs,
      success: response.status < 400,
      responseHeaders,
      responseBody: forLog.value,
      truncated: forLog.truncated,
    });

    return {
      status: response.status,
      statusText: response.statusText ?? "",
      headers: responseHeaders,
      data: forModel.value,
      truncated: forModel.truncated,
      url: built.url,
      method: methodUpper,
      durationMs,
      correlationId,
    };
  } catch (error) {
    const err = error as AxiosError;
    const durationMs = Date.now() - startedAt;
    // The caller's own signal is the only thing that can prove a cancellation
    // was requested; axios reports a timeout with an overlapping code.
    const kind = classifyFailure(err, context.signal?.aborted === true);

    // Distinct messages matter: "failed" tells the model nothing, while
    // "timed out" or "cancelled" tells it whether retrying is sensible.
    const message = ((): string => {
      switch (kind) {
        case "timeout":
          return `The upstream request timed out after ${timeoutMs}ms.`;
        case "canceled":
          return "The tool call was cancelled by the client.";
        case "dns":
          return `The upstream host could not be resolved: ${err.message}`;
        case "connection-refused":
          return `The upstream connection was refused or reset: ${err.message}`;
        case "tls":
          return `The upstream TLS handshake failed: ${err.message}`;
        case "payload-too-large":
          return `The request or response exceeded the ${MAX_CONTENT_BYTES}-byte limit.`;
        default:
          return `Upstream request failed: ${err.message}`;
      }
    })();

    emitLog(context.onLog, {
      id: newId(),
      correlationId,
      at: new Date().toISOString(),
      direction: "response",
      protocol,
      toolName: trimmedName,
      operationId: trimmedName,
      method: methodUpper,
      path: resolved.path,
      url: built.url,
      durationMs,
      success: false,
      error: message,
      meta: { failureKind: kind, code: err.code },
    });

    // A bare `new Error(message)` erased both the cause and the failure kind,
    // leaving callers to string-match the message to decide between "the client
    // hung up" (nothing to report) and "the upstream timed out" (a real 504).
    const wrapped = new Error(message, { cause: err });
    if (kind === "canceled") wrapped.name = "AbortError";
    (wrapped as Error & { failureKind?: FailureKind }).failureKind = kind;
    throw wrapped;
  }
}
