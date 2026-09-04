
import express from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"; 
import { buildMcpServer, type SpecProvider, type ContextProvider } from "./create-server";

export function attachSseRoutes(
  app: express.Express,
  specProvider: SpecProvider,
  contextProvider: ContextProvider,
  routeGuard?: express.RequestHandler,
): { activeSessionCount: () => number; closeAll: () => Promise<void> } {
  const sessions = new Map<string, { transport: SSEServerTransport; server: ReturnType<typeof buildMcpServer> }>();
  const middleware = routeGuard ? [routeGuard] : [];

  app.get("/mcp", ...middleware, async (_request, response) => {
    const server = buildMcpServer(specProvider, contextProvider);
    const transport = new SSEServerTransport("/mcp/messages", response);
    sessions.set(transport.sessionId, { transport, server });

    const cleanup = (): void => {
      sessions.delete(transport.sessionId);
      void server.close();
    };

    response.on("close", cleanup);
    response.on("error", cleanup);

    try {
      await server.connect(transport);
    } catch {
      cleanup();
      if (!response.headersSent) response.status(500).end();
    }
  });

  app.post("/mcp/messages", ...middleware, async (request, response) => {
    const sessionId = String(request.query.sessionId ?? "");
    const session = sessions.get(sessionId);
    if (!session) {
      response.status(400).json({ error: "Unknown or expired sessionId." });
      return;
    }
    await session.transport.handlePostMessage(request, response, request.body);
  });

  return {
    activeSessionCount: () => sessions.size,
    closeAll: async () => {
      await Promise.all(Array.from(sessions.values()).map(({ server }) => server.close().catch(() => undefined)));
      sessions.clear();
    },
  };
}
