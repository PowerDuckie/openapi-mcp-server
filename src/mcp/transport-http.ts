// src/mcp/transport-http.ts
import express from "express";
import { randomUUID } from "node:crypto";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  buildMcpServer,
  type ContextProvider,
  type SpecProvider,
} from "./create-server";

/** Endpoint paths mounted by {@link attachMcpRoutes}. */
export const MCP_ROUTES = {
  /** Streamable HTTP endpoint (POST/GET/DELETE). Preferred by modern clients. */
  streamableHttp: "/mcp",
  /** Legacy HTTP+SSE stream endpoint. */
  sse: "/sse",
  /** Legacy HTTP+SSE message endpoint. */
  messages: "/mcp/messages",
} as const;

/** Hard cap on concurrent sessions, protecting the process from exhaustion. */
const DEFAULT_MAX_SESSIONS = 64;
/** Idle sessions are reclaimed after this long without traffic. */
const DEFAULT_SESSION_IDLE_MS = 10 * 60 * 1000;
/** Interval between SSE keep-alive comments, to survive proxy idle timeouts. */
const KEEPALIVE_INTERVAL_MS = 25 * 1000;
/** How often expired sessions are swept. */
const SWEEP_INTERVAL_MS = 30 * 1000;
/** Upper bound on how long closeAll waits for in-flight teardowns. */
const DRAIN_TIMEOUT_MS = 5 * 1000;

export type SessionKind = "streamable-http" | "sse";

/**
 * Why a session was torn down. Left open-ended so internal call sites can
 * record a precise reason without widening a public union every time.
 */
export type SessionCloseReason =
  | "transport-closed"
  | "client-terminated"
  | "client-closed"
  | "stream-error"
  | "connect-failed"
  | "initialize-failed"
  | "keepalive-write-failed"
  | "idle-timeout"
  | "closed-by-operator"
  | "shutdown"
  | (string & {});

/**
 * Lifecycle notice.
 *
 * Deliberately a flat shape rather than a discriminated union: the consumer in
 * the admin server writes every field into a log record, and a union would force
 * a narrowing branch per event type for no behavioural gain. The optional fields
 * are genuinely absent for some events — `session-rejected` fires before any id
 * exists.
 */
export interface McpSessionEvent {
  type:
    | "session-opened"
    | "session-closed"
    | "session-rejected"
    | "session-error";
  kind: SessionKind;
  sessionId?: string | undefined;
  reason?: string | undefined;
}

/** A public, serializable view of one live session. */
export interface McpSessionInfo {
  sessionId: string;
  kind: SessionKind;
  createdAt: string;
  lastActivityAt: string;
  remoteAddress?: string | undefined;
  userAgent?: string | undefined;
}

export interface AttachMcpRoutesOptions {
  /** Supplies the document backing every new session. */
  specProvider: SpecProvider;
  /** Supplies the per-call upstream execution context. */
  contextProvider: ContextProvider;
  /** Applied to every MCP route when provided. */
  routeGuard?: express.RequestHandler | undefined;
  /** Maximum concurrent sessions. Defaults to 64. */
  maxSessions?: number | undefined;
  /** Idle timeout in milliseconds. Defaults to 10 minutes. Zero disables it. */
  sessionIdleMs?: number | undefined;
  /**
   * Origins permitted to open a session. When non-empty, DNS rebinding
   * protection is enabled, which is strongly recommended for any server
   * reachable from a browser.
   */
  allowedOrigins?: string[] | undefined;
  /** Host header values permitted. Pairs with {@link allowedOrigins}. */
  allowedHosts?: string[] | undefined;
  /** Enables the deprecated HTTP+SSE transport. Defaults to true. */
  enableLegacySse?: boolean | undefined;
  /** Receives lifecycle notices. Must never throw. */
  onEvent?: ((event: McpSessionEvent) => void) | undefined;
}

export interface McpRouteHandle {
  activeSessionCount: () => number;
  /** Sessions mid-handshake, i.e. counted against capacity but not yet listed. */
  pendingSessionCount: () => number;
  listSessions: () => McpSessionInfo[];
  /** Resolves true when the session existed and was closed by this call. */
  closeSession: (
    sessionId: string,
    reason?: SessionCloseReason,
  ) => Promise<boolean>;
  closeAll: () => Promise<void>;
  /** Stops the background sweeper and closes every session. */
  dispose: () => Promise<void>;
}

interface SessionRecord {
  sessionId: string;
  kind: SessionKind;
  transport: Transport;
  server: ReturnType<typeof buildMcpServer>;
  createdAt: number;
  lastActivityAt: number;
  keepAlive?: NodeJS.Timeout | undefined;
  closing: boolean;
  remoteAddress?: string | undefined;
  userAgent?: string | undefined;
}

/** JSON-RPC error payload for failures that occur before a session exists. */
function rpcError(code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: null, error: { code, message } };
}

function readHeader(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    const first = value.find(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim() !== "",
    );
    return first?.trim();
  }
  return undefined;
}

/** Express 5 widens query values; collapse to a single usable string. */
function readQueryValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    const first = value.find(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim() !== "",
    );
    return first?.trim() ?? "";
  }
  return "";
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The SDK is not compiled with `exactOptionalPropertyTypes`, so its transport
 * classes are not structurally assignable to the `Transport` interface under
 * that flag. The mismatch is a declaration-level artifact only: every optional
 * member is genuinely optional at runtime. These helpers isolate the unavoidable
 * widening and narrowing instead of scattering casts everywhere.
 */
function asTransport(value: object): Transport {
  return value as unknown as Transport;
}

function asStreamableTransport(
  value: Transport,
): StreamableHTTPServerTransport {
  return value as unknown as StreamableHTTPServerTransport;
}

function asSseTransport(value: Transport): SSEServerTransport {
  return value as unknown as SSEServerTransport;
}

/**
 * Installs an additional close handler without discarding the existing one.
 *
 * `Server.connect()` assigns its own `onclose`/`onerror` on the transport, so a
 * handler registered before connect is silently overwritten. Assigning after
 * connect fixes that, but a plain assignment would then destroy the SDK's own
 * cleanup — hence the chaining.
 */
function chainOnClose(
  transport: { onclose?: (() => void) | undefined },
  handler: () => void,
): void {
  const previous = transport.onclose;
  transport.onclose = (): void => {
    try {
      previous?.();
    } finally {
      handler();
    }
  };
}

function chainOnError(
  transport: { onerror?: ((error: Error) => void) | undefined },
  handler: (error: Error) => void,
): void {
  const previous = transport.onerror;
  transport.onerror = (error: Error): void => {
    try {
      previous?.(error);
    } finally {
      handler(error);
    }
  };
}

/**
 * Mounts both MCP HTTP transports on the given app.
 *
 * `/mcp` serves the Streamable HTTP transport, which is what current clients
 * negotiate by default. `/sse` plus `/mcp/messages` keep the deprecated
 * HTTP+SSE transport available for pinned clients.
 *
 * The JSON body parser must already be installed on the app: both transports
 * are handed `request.body` rather than re-reading the stream.
 */
export function attachMcpRoutes(
  app: express.Express,
  options: AttachMcpRoutesOptions,
): McpRouteHandle {
  const { specProvider, contextProvider } = options;

  const sessions = new Map<string, SessionRecord>();
  /**
   * Closures in flight, keyed by session id. A session is removed from
   * `sessions` as soon as teardown begins, so without this map `closeAll` could
   * resolve while sockets are still being drained.
   */
  const closures = new Map<string, Promise<void>>();

  /**
   * Handshakes that have passed admission but have not yet produced a session
   * id. Without counting these, N concurrent initialize requests all observe
   * `sessions.size === 0` and every one of them is admitted, so the effective
   * ceiling becomes N + maxSessions.
   */
  let pending = 0;

  const guard = options.routeGuard ? [options.routeGuard] : [];
  const maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS);
  const idleMs = Math.max(0, options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS);
  const legacyEnabled = options.enableLegacySse !== false;

  // A wildcard entry is meaningless for a host/origin allow-list and would make
  // the guard reject everything, so it is filtered out here.
  const allowedOrigins =
    options.allowedOrigins?.filter(
      (entry) => Boolean(entry) && entry !== "*",
    ) ?? [];
  const configuredHosts = options.allowedHosts?.filter(Boolean) ?? [];

  // Only enable the SDK's host/origin checks when a concrete allow-list exists;
  // enabling them with an empty list would reject every request.
  const dnsProtection = allowedOrigins.length > 0 || configuredHosts.length > 0;

  /**
   * Host allow-list actually handed to the transport.
   *
   * The SDK validates Host *and* Origin whenever protection is on. Enabling
   * protection with only origins configured therefore rejects every request,
   * because the empty host list matches nothing. Deriving the hosts from the
   * configured origins keeps the common "I only listed my web UI origin" case
   * working.
   */
  const allowedHosts =
    configuredHosts.length > 0
      ? configuredHosts
      : allowedOrigins
          .map((origin) => {
            try {
              return new URL(origin).host;
            } catch {
              return "";
            }
          })
          .filter(Boolean);

  const emit = (event: McpSessionEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // Observability must never break traffic.
    }
  };

  function touch(sessionId: string): void {
    const record = sessions.get(sessionId);
    if (record) record.lastActivityAt = Date.now();
  }

  async function destroySession(
    sessionId: string,
    reason: SessionCloseReason,
  ): Promise<boolean> {
    const record = sessions.get(sessionId);
    if (!record || record.closing) return false;

    // Mark and unregister before awaiting: `transport.close()` synchronously
    // fires `onclose`, which re-enters this function for the same session.
    record.closing = true;
    sessions.delete(sessionId);
    if (record.keepAlive) clearInterval(record.keepAlive);

    const closure = (async () => {
      // Close the transport first so the peer sees a clean shutdown, then the
      // server. Both are best-effort: a half-dead socket must not throw here.
      try {
        await record.transport.close();
      } catch {
        // Ignore: the underlying socket may already be gone.
      }
      try {
        await record.server.close();
      } catch {
        // Ignore: closing an already-closed server is not an error condition.
      }
    })();

    closures.set(sessionId, closure);
    try {
      await closure;
    } finally {
      closures.delete(sessionId);
    }

    emit({ type: "session-closed", kind: record.kind, sessionId, reason });
    return true;
  }

  /** Rejects a new session when the spec is unavailable or capacity is reached. */
  function admit(kind: SessionKind, response: express.Response): boolean {
    if (!specProvider()) {
      emit({ type: "session-rejected", kind, reason: "no-active-spec" });
      response
        .status(503)
        .json(
          rpcError(
            -32000,
            "No MCP service is currently running. Load a specification and start the service first.",
          ),
        );
      return false;
    }
    if (sessions.size + pending >= maxSessions) {
      emit({ type: "session-rejected", kind, reason: "capacity" });
      response
        .status(429)
        .json(
          rpcError(
            -32000,
            `Too many concurrent MCP sessions (limit ${maxSessions}).`,
          ),
        );
      return false;
    }
    return true;
  }

  /* ---------------------------------------------------------------------- */
  /* Streamable HTTP transport                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Creates a Streamable HTTP session and hands the current request to it.
   *
   * The session id is minted by the transport while it processes the
   * `initialize` request, which happens inside `handleRequest`, not during
   * `connect`. The registry is therefore populated from the
   * `onsessioninitialized` callback so that no window exists in which a
   * follow-up request could reference an untracked session.
   *
   * Returns true when the handshake completed and the session is registered.
   */
  async function openStreamableSession(
    request: express.Request,
    response: express.Response,
    body: unknown,
  ): Promise<boolean> {
    const server = buildMcpServer(specProvider, contextProvider, {
      protocol: "streamable-http",
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: dnsProtection,
      ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
      ...(allowedOrigins.length > 0 ? { allowedOrigins } : {}),
      onsessioninitialized: (sessionId: string): void => {
        const now = Date.now();
        sessions.set(sessionId, {
          sessionId,
          kind: "streamable-http",
          transport: asTransport(transport),
          server,
          createdAt: now,
          lastActivityAt: now,
          closing: false,
          remoteAddress: request.ip,
          userAgent: readHeader(request.headers["user-agent"]),
        });
        emit({ type: "session-opened", kind: "streamable-http", sessionId });
      },
      onsessionclosed: (sessionId: string): void => {
        void destroySession(sessionId, "client-terminated");
      },
    });

    const rollback = async (): Promise<void> => {
      // Best effort on both: the session may already be half torn down, and a
      // secondary failure must not mask the original error.
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    };

    pending += 1;
    try {
      try {
        await server.connect(asTransport(transport));
      } catch (error) {
        await rollback();
        emit({
          type: "session-error",
          kind: "streamable-http",
          reason: describe(error),
        });
        if (!response.headersSent) {
          response
            .status(500)
            .json(rpcError(-32603, "Failed to initialize the MCP session."));
        }
        return false;
      }

      // Registered only after connect, because connect installs the SDK's own
      // onclose/onerror and would otherwise overwrite these handlers, leaving
      // abruptly dropped sessions in the map until the idle sweeper runs.
      chainOnClose(transport, () => {
        const sessionId = transport.sessionId;
        if (sessionId) void destroySession(sessionId, "transport-closed");
      });

      chainOnError(transport, (error) => {
        emit({
          type: "session-error",
          kind: "streamable-http",
          sessionId: transport.sessionId,
          reason: error.message,
        });
      });

      try {
        // This call performs the initialize handshake and, on success, triggers
        // `onsessioninitialized`, which registers the session.
        await transport.handleRequest(request, response, body);
      } catch (error) {
        const sessionId = transport.sessionId;
        if (sessionId && sessions.has(sessionId)) {
          await destroySession(sessionId, "initialize-failed");
        } else {
          await rollback();
        }
        emit({
          type: "session-error",
          kind: "streamable-http",
          sessionId,
          reason: describe(error),
        });
        if (!response.headersSent) {
          response
            .status(500)
            .json(rpcError(-32603, "Failed to handle the initialize request."));
        }
        return false;
      }

      // A transport that finished the request without minting a session id means
      // the payload was rejected at the protocol level; the transport already
      // wrote the response. Release the server rather than leaking it.
      if (!transport.sessionId) {
        await rollback();
        return false;
      }

      return true;
    } finally {
      pending -= 1;
    }
  }

  const handleStreamable: express.RequestHandler = async (
    request,
    response,
  ) => {
    const sessionId = readHeader(request.headers["mcp-session-id"]);

    try {
      if (sessionId) {
        const record = sessions.get(sessionId);
        if (!record || record.kind !== "streamable-http" || record.closing) {
          response
            .status(404)
            .json(rpcError(-32001, "Unknown or expired MCP session."));
          return;
        }

        // Stamp before and after: a streaming GET can stay open for a long
        // time, and refreshing only on completion would let the idle reaper cut
        // a session that is actively serving a client.
        touch(sessionId);
        await asStreamableTransport(record.transport).handleRequest(
          request,
          response,
          request.body,
        );
        touch(sessionId);
        return;
      }

      // Without a session header, only a well-formed initialize POST may open one.
      if (request.method !== "POST") {
        response
          .status(400)
          .json(
            rpcError(
              -32000,
              "Missing mcp-session-id header. Send an initialize request over POST first, or use the legacy /sse endpoint.",
            ),
          );
        return;
      }

      if (!isInitializeRequest(request.body)) {
        response
          .status(400)
          .json(
            rpcError(
              -32000,
              "Missing mcp-session-id header and the payload is not an initialize request. The session may have expired; re-initialize before retrying.",
            ),
          );
        return;
      }

      if (!admit("streamable-http", response)) return;

      // `openStreamableSession` answers this very request as part of the
      // handshake, so nothing further may touch the response here.
      await openStreamableSession(request, response, request.body);
    } catch (error) {
      emit({
        type: "session-error",
        kind: "streamable-http",
        sessionId,
        reason: describe(error),
      });
      if (!response.headersSent) {
        response
          .status(500)
          .json(
            rpcError(-32603, "Internal error while handling the MCP request."),
          );
      } else {
        // Headers are already out; the only correct action is to stop the stream.
        response.end();
      }
    }
  };

  app.post(MCP_ROUTES.streamableHttp, ...guard, handleStreamable);
  app.get(MCP_ROUTES.streamableHttp, ...guard, handleStreamable);
  // DELETE is how a client explicitly terminates its session; omitting it would
  // leave sessions to expire on the idle timeout instead.
  app.delete(MCP_ROUTES.streamableHttp, ...guard, handleStreamable);

  /* ---------------------------------------------------------------------- */
  /* Legacy HTTP+SSE transport                                              */
  /* ---------------------------------------------------------------------- */

  if (legacyEnabled) {
    app.get(MCP_ROUTES.sse, ...guard, async (request, response) => {
      // Origin is validated manually here: the legacy transport has no built-in
      // DNS rebinding protection. A missing Origin header is allowed through
      // because non-browser clients never send one.
      if (allowedOrigins.length > 0) {
        const origin = readHeader(request.headers.origin);
        if (origin && !allowedOrigins.includes(origin)) {
          emit({ type: "session-rejected", kind: "sse", reason: "origin" });
          response.status(403).json(rpcError(-32000, "Origin is not allowed."));
          return;
        }
      }

      if (!admit("sse", response)) return;

      const server = buildMcpServer(specProvider, contextProvider, {
        protocol: "sse",
      });
      const transport = new SSEServerTransport(MCP_ROUTES.messages, response);
      const sessionId = transport.sessionId;
      const now = Date.now();

      const record: SessionRecord = {
        sessionId,
        kind: "sse",
        transport: asTransport(transport),
        server,
        createdAt: now,
        lastActivityAt: now,
        closing: false,
        remoteAddress: request.ip,
        userAgent: readHeader(request.headers["user-agent"]),
      };
      sessions.set(sessionId, record);

      // Registered immediately: unlike the streamable transport, the SSE stream
      // is the only signal that the peer went away, and the response can be
      // destroyed before connect() resolves.
      response.on(
        "close",
        () => void destroySession(sessionId, "client-closed"),
      );
      response.on(
        "error",
        () => void destroySession(sessionId, "stream-error"),
      );

      try {
        await server.connect(asTransport(transport));
      } catch (error) {
        emit({
          type: "session-error",
          kind: "sse",
          sessionId,
          reason: describe(error),
        });
        await destroySession(sessionId, "connect-failed");
        if (!response.headersSent) {
          response
            .status(500)
            .json(rpcError(-32603, "Failed to initialize the MCP session."));
        }
        return;
      }

      chainOnClose(transport, () => {
        void destroySession(sessionId, "transport-closed");
      });

      chainOnError(transport, (error) => {
        emit({
          type: "session-error",
          kind: "sse",
          sessionId,
          reason: error.message,
        });
      });

      // Started only after connect: the transport writes the SSE preamble during
      // connect, and a keep-alive comment emitted before that would land ahead
      // of the response headers.
      //
      // write() reports back-pressure failures through its callback rather than
      // by throwing, so the callback — not a try/catch — is what detects a dead
      // socket here.
      record.keepAlive = setInterval(() => {
        if (response.writableEnded || response.destroyed) return;
        response.write(": keepalive\n\n", (error) => {
          if (error) void destroySession(sessionId, "keepalive-write-failed");
        });
      }, KEEPALIVE_INTERVAL_MS);
      record.keepAlive.unref?.();

      emit({ type: "session-opened", kind: "sse", sessionId });
    });

    app.post(MCP_ROUTES.messages, ...guard, async (request, response) => {
      const sessionId =
        readQueryValue(request.query.sessionId) ||
        readHeader(request.headers["mcp-session-id"]) ||
        "";

      if (!sessionId) {
        response
          .status(400)
          .json(rpcError(-32000, "A sessionId query parameter is required."));
        return;
      }

      const record = sessions.get(sessionId);
      if (!record || record.kind !== "sse" || record.closing) {
        response
          .status(404)
          .json(rpcError(-32001, "Unknown or expired sessionId."));
        return;
      }

      touch(sessionId);
      try {
        await asSseTransport(record.transport).handlePostMessage(
          request,
          response,
          request.body,
        );
      } catch (error) {
        emit({
          type: "session-error",
          kind: "sse",
          sessionId,
          reason: describe(error),
        });
        if (!response.headersSent) {
          response
            .status(500)
            .json(rpcError(-32603, "Failed to dispatch the MCP message."));
        } else {
          response.end();
        }
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Idle session reaper                                                    */
  /* ---------------------------------------------------------------------- */

  let sweeper: NodeJS.Timeout | undefined;
  if (idleMs > 0) {
    sweeper = setInterval(() => {
      const cutoff = Date.now() - idleMs;
      // Snapshot first: destroySession mutates the map while iterating.
      for (const record of [...sessions.values()]) {
        if (record.lastActivityAt < cutoff) {
          void destroySession(record.sessionId, "idle-timeout");
        }
      }
    }, SWEEP_INTERVAL_MS);
    // Never hold the event loop open on account of the sweeper.
    sweeper.unref?.();
  }

  async function closeAll(): Promise<void> {
    await Promise.all(
      [...sessions.keys()].map((sessionId) =>
        destroySession(sessionId, "shutdown"),
      ),
    );

    // Await teardowns that were already in flight, otherwise the caller can
    // proceed to close the HTTP listener while sockets are still draining.
    //
    // Bounded by a deadline rather than looping until empty: a transport whose
    // close() never settles (a socket stuck in a half-open state does this)
    // would otherwise hang process shutdown forever.
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (closures.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.all([...closures.values()]),
        new Promise((resolve) => setTimeout(resolve, 100).unref?.()),
      ]);
    }
  }

  return {
    activeSessionCount: () => sessions.size,
    pendingSessionCount: () => pending,
    listSessions: () =>
      [...sessions.values()].map((record) => ({
        sessionId: record.sessionId,
        kind: record.kind,
        createdAt: new Date(record.createdAt).toISOString(),
        lastActivityAt: new Date(record.lastActivityAt).toISOString(),
        remoteAddress: record.remoteAddress,
        userAgent: record.userAgent,
      })),
    closeSession: (
      sessionId: string,
      reason: SessionCloseReason = "closed-by-operator",
    ) => destroySession(sessionId, reason),
    closeAll,
    dispose: async () => {
      if (sweeper) clearInterval(sweeper);
      sweeper = undefined;
      await closeAll();
    },
  };
}

/**
 * Backwards-compatible alias for the previous export name.
 *
 * @deprecated Use {@link attachMcpRoutes}. This wrapper keeps the old
 * positional signature working but no longer serves the legacy SSE stream at
 * `GET /mcp`, because that path now belongs to the Streamable HTTP transport.
 * It also drops the sweeper handle, so callers cannot fully shut down; migrate.
 */
export function attachSseRoutes(
  app: express.Express,
  specProvider: SpecProvider,
  contextProvider: ContextProvider,
  routeGuard?: express.RequestHandler,
): { activeSessionCount: () => number; closeAll: () => Promise<void> } {
  const handle = attachMcpRoutes(app, {
    specProvider,
    contextProvider,
    ...(routeGuard ? { routeGuard } : {}),
  });
  return {
    activeSessionCount: handle.activeSessionCount,
    closeAll: handle.closeAll,
  };
}
