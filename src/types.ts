import type { Document } from "@scalar/openapi-types/3.2";
import type { Prompt, Resource } from "@modelcontextprotocol/sdk/types.js";

/** Transport the server exposes to MCP clients. */
export type TransportMode = "stdio" | "web";

/**
 * Where the currently loaded document came from. Surfaced in the admin UI so
 * an operator can tell a boot-time file apart from a runtime upload.
 */
export type SpecSource = "startup-file" | "upload" | "paste" | "runtime";

/** Lifecycle state of a managed service. */
export type ServiceStatus = "running" | "stopped" | "error";

/**
 * Every optional field below is declared as `?: T | undefined` rather than
 * `?: T`. Under `exactOptionalPropertyTypes` the shorter form forbids passing
 * an explicitly undefined value, which would make ordinary object literals
 * built from possibly-absent config fail to typecheck.
 */
export interface ServerConfig {
  port: number;
  host?: string | undefined;
  apiKey?: string | undefined;
  specPath?: string | undefined;
  baseUrlOverride?: string | undefined;
  upstreamHeaders?: Record<string, string> | undefined;
  requestTimeoutMs?: number | undefined;
  persistState?: boolean | undefined;
  stateFilePath?: string | undefined;

  /**
   * Origins permitted to call the admin API from a browser. Empty or omitted
   * means cross-origin requests are rejected; the bundled web UI is served
   * from the same origin and therefore needs no entry here. Use "*" only for
   * local development.
   */
  allowedOrigins?: string[] | undefined;
}

/** Mutable server state for the single active document. */
export interface AppState {
  spec: Document | null;
  baseUrlOverride?: string | undefined;
  specSource?: SpecSource | undefined;
}

/** Per-request context handed to the HTTP executor. */
export interface ExecutionContext {
  baseUrlOverride?: string | undefined;
  upstreamHeaders?: Record<string, string> | undefined;
  requestTimeoutMs?: number | undefined;
  security?:
    | {
        bearerToken?: string | undefined;
        basicAuth?: { username: string; password: string } | undefined;
        apiKeys?: Record<string, string> | undefined;
      }
    | undefined;
}

/** A service instance tracked by the runtime registry. */
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
  endpoint: {
    sse: string;
    messages: string;
    stdioSupported: boolean;
  };
  /**
   * Populated when `status` is "error". Without this the "error" state can
   * never be written with any useful detail attached.
   */
  lastError?: { message: string; at: string } | undefined;
}

/** Snapshot projection consumed by the admin UI. */
export interface AdminStatus {
  specLoaded: boolean;
  specSource: SpecSource | null;
  serviceId: string | null;
  /** True only while a spec is loaded AND its service is running. */
  active: boolean;
  title: string | null;
  version: string | null;
  baseUrl: string | null;
  toolCount: number;
  /** Tools generated with `[PARTIAL SUPPORT]` degradation markers. */
  degradedToolCount: number;
  promptCount: number;
  resourceCount: number;
  activeSessions: number;
  services: ManagedServiceRecord[];
  issues: string[];
}

export interface GeneratedPrompt extends Prompt {
  name: string;
}

export interface GeneratedResource extends Resource {
  uri: string;
}
