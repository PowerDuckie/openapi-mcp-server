import type { Document } from "@scalar/openapi-types/3.2";
import type {
  Prompt,
  PromptArgument,
  Resource,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";

/* -------------------------------------------------------------------------- */
/* Primitive unions and runtime guards                                        */
/* -------------------------------------------------------------------------- */

/** How the MCP server is exposed to a client. */
export const TRANSPORT_MODES = ["stdio", "web"] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];

/** Where the currently loaded specification came from. */
export const SPEC_SOURCES = [
  "startup-file",
  "upload",
  "paste",
  "runtime",
] as const;
export type SpecSource = (typeof SPEC_SOURCES)[number];

/** Lifecycle state of a managed MCP service. */
export const SERVICE_STATUSES = ["running", "stopped", "error"] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

/**
 * Wire protocol a log entry or session belongs to.
 *
 * `streamable-http` is the transport introduced by the 2025 protocol revision
 * and is preferred for new clients; `sse` remains for backward compatibility
 * with clients pinned to the legacy HTTP+SSE transport.
 */
export const PROTOCOL_HINTS = ["streamable-http", "sse", "stdio"] as const;
export type ProtocolHint = (typeof PROTOCOL_HINTS)[number];

/** Direction of a recorded log entry relative to this process. */
export const LOG_DIRECTIONS = ["request", "response", "internal"] as const;
export type LogDirection = (typeof LOG_DIRECTIONS)[number];

/** Severity used for filtering and colour-coding in the web console. */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** OpenAPI parameter locations supported by the request builder. */
export const PARAMETER_LOCATIONS = [
  "path",
  "query",
  "header",
  "cookie",
] as const;
export type ParameterLocation = (typeof PARAMETER_LOCATIONS)[number];

/** Request body serialization strategies supported by the HTTP executor. */
export const BODY_ENCODINGS = [
  "json",
  "form-urlencoded",
  "multipart",
  "text",
  "binary",
] as const;
export type BodyEncoding = (typeof BODY_ENCODINGS)[number];

function isMember<T extends readonly string[]>(
  allowed: T,
  value: unknown,
): value is T[number] {
  return (
    typeof value === "string" && (allowed as readonly string[]).includes(value)
  );
}

/** Narrow an untrusted value to a {@link SpecSource}. */
export function isSpecSource(value: unknown): value is SpecSource {
  return isMember(SPEC_SOURCES, value);
}

/** Narrow an untrusted value to a {@link ServiceStatus}. */
export function isServiceStatus(value: unknown): value is ServiceStatus {
  return isMember(SERVICE_STATUSES, value);
}

/** Narrow an untrusted value to a {@link ProtocolHint}. */
export function isProtocolHint(value: unknown): value is ProtocolHint {
  return isMember(PROTOCOL_HINTS, value);
}

/** Narrow an untrusted value to a {@link ParameterLocation}. */
export function isParameterLocation(
  value: unknown,
): value is ParameterLocation {
  return isMember(PARAMETER_LOCATIONS, value);
}

/** Narrow an untrusted value to a {@link BodyEncoding}. */
export function isBodyEncoding(value: unknown): value is BodyEncoding {
  return isMember(BODY_ENCODINGS, value);
}

/** True for plain, non-array objects usable as an argument bag. */
export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/* -------------------------------------------------------------------------- */
/* Server configuration                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Options accepted when starting the bundled web console and HTTP transport.
 *
 * Every field is optional except {@link ServerConfig.port} so that embedders can
 * start a usable server with a single value.
 */
export interface ServerConfig {
  /** TCP port to bind. Must be an integer in the range 0-65535. */
  port: number;
  /** Interface to bind. Defaults to `127.0.0.1` to avoid accidental exposure. */
  host?: string | undefined;
  /** Shared secret required by the admin API and HTTP transport when set. */
  apiKey?: string | undefined;
  /** Path to a specification loaded once at startup. */
  specPath?: string | undefined;
  /** Overrides the upstream base URL derived from `servers[0].url`. */
  baseUrlOverride?: string | undefined;
  /** Headers merged into every upstream request. */
  upstreamHeaders?: Record<string, string> | undefined;
  /** Per-request upstream timeout in milliseconds. */
  requestTimeoutMs?: number | undefined;
  /** Persist the loaded specification across restarts. Defaults to true. */
  persistState?: boolean | undefined;
  /** Location of the persisted state file. */
  stateFilePath?: string | undefined;
  /** Allowed CORS origins. Empty or omitted disables cross-origin access. */
  allowedOrigins?: string[] | undefined;
  /** Maximum number of in-memory log entries retained. */
  maxLogEntries?: number | undefined;
  /** Redact sensitive header values before logging. Defaults to true. */
  redactSensitiveHeaders?: boolean | undefined;
  /** Additional header names to redact, in addition to the built-in list. */
  redactHeaderNames?: string[] | undefined;
  /** Credentials forwarded to the upstream API for every tool call. */
  security?: SecurityContext | undefined;
}

/** Credentials applied to upstream requests. */
export interface SecurityContext {
  /** Sent as `Authorization: Bearer <token>`. */
  bearerToken?: string | undefined;
  /** Sent as `Authorization: Basic <base64>`. */
  basicAuth?: { username: string; password: string } | undefined;
  /** Header-name to value pairs for API-key schemes. */
  apiKeys?: Record<string, string> | undefined;
}

/** Mutable runtime state of the loaded specification. */
export interface AppState {
  spec: Document | null;
  baseUrlOverride?: string | undefined;
  specSource?: SpecSource | undefined;
}

/** Shape of the on-disk state file. All fields are untrusted when read back. */
export interface PersistedState {
  specRaw?: string | undefined;
  specIsYaml?: boolean | undefined;
  baseUrlOverride?: string | undefined;
  /** Schema version, allowing forward-compatible migrations. */
  stateVersion?: number | undefined;
  savedAt?: string | undefined;
}

/** Per-call context handed to the request builder and HTTP executor. */
export interface ExecutionContext {
  baseUrlOverride?: string | undefined;
  upstreamHeaders?: Record<string, string> | undefined;
  requestTimeoutMs?: number | undefined;
  security?: SecurityContext | undefined;
  /** Correlates every log entry produced by one logical tool invocation. */
  correlationId?: string | undefined;
  /** Transport that initiated the call, recorded on emitted log entries. */
  protocol?: ProtocolHint | undefined;
  /** Receives request and response log entries. Must never throw. */
  onLog?: ((entry: RequestLogEntry) => void) | undefined;
  signal?: AbortSignal | undefined;
}

/* -------------------------------------------------------------------------- */
/* Service registry and status                                                */
/* -------------------------------------------------------------------------- */

/** Endpoints a client can use to reach a managed service. */
export interface ServiceEndpointInfo {
  /** Legacy HTTP+SSE stream path. */
  sse: string;
  /** Legacy HTTP+SSE message-post path. */
  messages: string;
  /** Whether the service can also be launched over stdio by the CLI. */
  stdioSupported: boolean;
  /** Streamable HTTP endpoint path, when the transport is mounted. */
  streamableHttp?: string | undefined;
}

/** A specification that has been compiled into a runnable MCP service. */
export interface ManagedServiceRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: ServiceStatus;
  title: string;
  version: string;
  source: SpecSource;
  toolCount: number;
  promptCount: number;
  resourceCount: number;
  endpoint: ServiceEndpointInfo;
  /** Number of tools that could not be fully mapped from the specification. */
  degradedToolCount?: number | undefined;
  /** Upstream base URL in effect for this service. */
  baseUrl?: string | undefined;
  /** Timestamp of the most recent tool invocation. */
  lastCallAt?: string | undefined;
  lastError?: { message: string; at: string } | undefined;
}

/** A problem detected while compiling the specification. */
export interface SpecIssue {
  path: string;
  method?: string | undefined;
  message: string;
  severity?: Exclude<LogLevel, "debug"> | undefined;
}

/** Snapshot returned by the admin status endpoint. */
export interface AdminStatus {
  specLoaded: boolean;
  specSource: SpecSource | null;
  serviceId: string | null;
  active: boolean;
  title: string | null;
  version: string | null;
  baseUrl: string | null;
  toolCount: number;
  degradedToolCount: number;
  promptCount: number;
  resourceCount: number;
  activeSessions: number;
  services: ManagedServiceRecord[];
  /** Human-readable issue strings, ready for display. */
  issues: string[];
  lastUpdatedAt: string;
  /** Whether an API key is required to reach the admin API. */
  authRequired?: boolean | undefined;
  /** Process uptime in seconds. */
  uptimeSeconds?: number | undefined;
  /** Library version reported to clients. */
  serverVersion?: string | undefined;
}

/* -------------------------------------------------------------------------- */
/* Generated MCP capabilities                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A prompt generated from the specification.
 *
 * `Prompt` already requires `name`; the alias exists so generated values are
 * distinguishable from prompts supplied by an embedder.
 */
export interface GeneratedPrompt extends Prompt {
  name: string;
  arguments?: PromptArgument[] | undefined;
}

/** A resource generated from the specification. */
export interface GeneratedResource extends Resource {
  uri: string;
  name: string;
}

/** A tool generated from the specification. */
export interface GeneratedTool extends Tool {
  name: string;
}

/** One textual resource body returned by a `resources/read` call. */
export interface ResourceContentItem {
  uri: string;
  mimeType: string;
  text: string;
}

/**
 * Message shape used when assembling prompt results.
 *
 * Only `user` and `assistant` are valid MCP prompt roles; a `system` role would
 * make this type unassignable to the SDK's `GetPromptResult`.
 */
export interface PromptMessageShape {
  role: "user" | "assistant";
  content: {
    type: "text";
    text: string;
  };
}

/**
 * Internal representation of a rendered prompt.
 *
 * @deprecated Build `GetPromptResult` from the SDK directly. Retained so that
 * existing imports keep compiling.
 */
export interface ResolvedPrompt {
  name: string;
  description?: string | undefined;
  messages: PromptMessageShape[];
}

/* -------------------------------------------------------------------------- */
/* Request logging                                                            */
/* -------------------------------------------------------------------------- */

/** Query parameters as recorded, preserving repeated keys. */
export type LoggedQuery = Record<string, string | string[]>;

/** A single entry in the in-memory request log surfaced by the web console. */
export interface RequestLogEntry {
  id: string;
  at: string;
  direction: LogDirection;
  /** Defaults to `info` for successes and `error` for failures when omitted. */
  level?: LogLevel | undefined;
  protocol?: ProtocolHint | undefined;
  /** Ties a request entry to its matching response entry. */
  correlationId?: string | undefined;
  serviceId?: string | undefined;
  sessionId?: string | undefined;
  toolName?: string | undefined;
  operationId?: string | undefined;
  method?: string | undefined;
  path?: string | undefined;
  url?: string | undefined;
  status?: number | undefined;
  durationMs?: number | undefined;
  success?: boolean | undefined;
  requestHeaders?: Record<string, string> | undefined;
  requestQuery?: LoggedQuery | undefined;
  requestBody?: unknown;
  responseHeaders?: Record<string, unknown> | undefined;
  responseBody?: unknown;
  /** Set when a body was shortened to respect the size limit. */
  truncated?: boolean | undefined;
  /** Set when one or more header values were replaced with a placeholder. */
  redacted?: boolean | undefined;
  /** Byte length of the upstream response, before truncation. */
  responseBytes?: number | undefined;
  error?: string | undefined;
  /** Structured detail for internal events such as `spec-applied`. */
  meta?: Record<string, unknown> | undefined;

  requestQueryString?: string | undefined;
}

/** Filter accepted by the log query endpoint. */
export interface LogQueryOptions {
  limit?: number | undefined;
  offset?: number | undefined;
  direction?: LogDirection | undefined;
  level?: LogLevel | undefined;
  toolName?: string | undefined;
  /** Case-insensitive substring match across tool name, URL and error text. */
  search?: string | undefined;
  /** Restrict to failures only. */
  onlyErrors?: boolean | undefined;
}

/** Paged log response. */
export interface LogQueryResult {
  logs: RequestLogEntry[];
  total: number;
  limit: number;
  offset: number;
}
