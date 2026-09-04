
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Document } from "@scalar/openapi-types/3.2";
import { generateTools } from "../core/tool-generator";
import { generatePrompts } from "../registry/prompt-registry";
import { generateResources } from "../registry/resource-registry";
import { executeToolCall } from "../core/http-executor";
import type { ExecutionContext } from "../types";

export type SpecProvider = () => Document | null;
export type ContextProvider = () => ExecutionContext;

export function buildMcpServer(
  specProvider: SpecProvider,
  contextProvider: ContextProvider = () => ({}),
) {
  const server = new Server(
    { name: "openapi-mcp-production", version: "1.0.0" },
    { capabilities: { tools: {}, prompts: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const spec = specProvider();
    if (!spec) return { tools: [] };
    return { tools: generateTools(spec) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const spec = specProvider();
    if (!spec) {
      return { isError: true, content: [{ type: "text", text: "No OpenAPI specification is currently loaded." }] };
    }

    try {
      const result = await executeToolCall(
        spec,
        request.params.name,
        request.params.arguments as Record<string, unknown> | undefined,
        contextProvider(),
      );
      return { isError: result.status >= 400, content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      };
    }
  });

  const listPrompts = (): ReturnType<typeof generatePrompts> => {
    const spec = specProvider();
    return spec ? generatePrompts(spec) : [];
  };

  const listResources = (): ReturnType<typeof generateResources> => {
    const spec = specProvider();
    return spec ? generateResources(spec) : [];
  };

  return Object.assign(server, { listPrompts, listResources });
}
