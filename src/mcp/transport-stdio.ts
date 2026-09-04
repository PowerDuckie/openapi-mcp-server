import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "./create-server";
import type { Document } from "@scalar/openapi-types/3.2";
import type { ExecutionContext } from "../types";

/**
 * Serves a single specification over stdio.
 *
 * The transport keeps the process alive by holding stdin open, so this
 * resolves once the connection is established rather than when it ends.
 * Nothing may be written to stdout by other code while this runs: stdout is
 * the JSON-RPC channel, and stray output corrupts the stream. Use stderr for
 * logging.
 */
export async function startStdioServer(
  spec: Document,
  context: ExecutionContext = {},
): Promise<void> {
  const server = buildMcpServer(
    () => spec,
    () => context,
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
