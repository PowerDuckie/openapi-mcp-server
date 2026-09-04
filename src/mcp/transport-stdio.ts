import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "./create-server";
import type { Document } from "@scalar/openapi-types/3.2";
import type { ExecutionContext, RequestLogEntry } from "../types";

export interface StdioServerHandle {
  /** Resolves when the peer closes stdin or {@link close} is called. */
  closed: Promise<void>;
  close(): Promise<void>;
}

export interface StartStdioServerOptions {
  /**
   * Install process signal handlers so the transport is shut down cleanly.
   * Defaults to true, which is what a CLI entry point wants; a host embedding
   * this in a larger process should pass false and drive `close()` itself.
   */
  handleSignals?: boolean;
}

/**
 * Redirects stdout-bound console output to stderr for the lifetime of the
 * process.
 *
 * On stdio, stdout is the JSON-RPC framing channel: a single stray line from any
 * module — a dependency's deprecation notice, a leftover debug print — desynchronizes
 * the stream and the client fails with a parse error that looks like a protocol
 * bug rather than a logging mistake. Enforcing the rule here is the only reliable
 * option, because no amount of convention prevents third-party code from writing
 * to stdout.
 */
function divertConsoleToStderr(): () => void {
  const original = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    dir: console.dir,
  };
  const toStderr = (...args: unknown[]): void => {
    console.error(...args);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.debug = toStderr;
  console.dir = toStderr as typeof console.dir;

  return () => {
    console.log = original.log;
    console.info = original.info;
    console.debug = original.debug;
    console.dir = original.dir;
  };
}

/**
 * Serves a single specification over stdio.
 *
 * The specification is captured once: unlike the HTTP transports there is no
 * admin surface able to swap it, and a stdio client holds exactly one session
 * whose tool list it caches after `initialize`.
 */
export async function startStdioServer(
  spec: Document,
  context: ExecutionContext = {},
  options: StartStdioServerOptions = {},
): Promise<StdioServerHandle> {
  const restoreConsole = divertConsoleToStderr();

  // The caller's log sink may well be a console-based one. Wrapping it keeps a
  // logging decision made elsewhere from corrupting the protocol stream, and the
  // wrapper swallows sink errors for the same reason the executor does.
  const upstreamLog = context.onLog;
  const onLog = upstreamLog
    ? (entry: RequestLogEntry): void => {
        try {
          upstreamLog(entry);
        } catch {
          // Logging must never break user traffic.
        }
      }
    : undefined;

  const stdioContext: ExecutionContext = {
    ...context,
    protocol: "stdio",
    ...(onLog ? { onLog } : {}),
  };

  const server = buildMcpServer(
    () => spec,
    () => stdioContext,
    { protocol: "stdio" },
  );

  const transport = new StdioServerTransport();

  let settleClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    settleClosed = resolve;
  });

  let shuttingDown = false;
  const detachSignals: Array<() => void> = [];

  const finish = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const detach of detachSignals) detach();
    restoreConsole();
    settleClosed();
  };

  transport.onerror = (error: Error): void => {
    // Nothing here can be reported to the client — the channel carrying the
    // error is the one that failed — so stderr is the only diagnostic surface.
    console.error("[mcp:stdio] transport error:", error);
  };

  transport.onclose = (): void => {
    finish();
  };

  await server.connect(transport);

  if (options.handleSignals !== false) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = (): void => {
        // Close the transport rather than exiting immediately, so an in-flight
        // response still reaches the client before stdout is torn down.
        void server.close().catch(() => {
          /* already closing */
        });
      };
      process.once(signal, handler);
      detachSignals.push(() => process.removeListener(signal, handler));
    }
  }

  return {
    closed,
    close: async (): Promise<void> => {
      try {
        await server.close();
      } finally {
        finish();
      }
    },
  };
}
