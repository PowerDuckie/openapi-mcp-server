import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type CallToolResult,
  type GetPromptResult,
  type Prompt,
  type Resource,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Document } from "@scalar/openapi-types/3.2";
import { executeToolCall } from "../core/http-executor";
import { getGeneratedTools } from "../core/tool-generator";
import { generatePrompts, resolvePrompt } from "../registry/prompt-registry";
import { generateResources, readResource } from "../registry/resource-registry";
import type { ExecutionContext, ProtocolHint } from "../types";

/** Returns the active document, or null when no service is running. */
export type SpecProvider = () => Document | null;
/** Returns the upstream execution context for the current call. */
export type ContextProvider = () => ExecutionContext;

export interface BuildMcpServerOptions {
  protocol?: ProtocolHint | undefined;
  /** Advertised server name. Clients may display this to end users. */
  name?: string | undefined;
  /** Advertised server version. */
  version?: string | undefined;
  /**
   * Maximum entries returned by a single list request. Large documents must be
   * paginated, otherwise a single response can exceed what the transport (and
   * some clients) will accept.
   */
  pageSize?: number | undefined;
  /** Human-readable usage hint surfaced through `instructions`. */
  instructions?: string | undefined;
}

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

/**
 * Message used whenever a request arrives while no service is running. This is
 * a legitimate transient state (the operator stopped the service, or replaced
 * the document) rather than a malformed request, so it is reported as an error
 * the client can retry after re-initializing.
 */
const NO_SERVICE_MESSAGE =
  "No MCP service is currently running: the specification was cleared or the service was stopped.";

function requireSpec(specProvider: SpecProvider): Document {
  const spec = specProvider();
  if (!spec) {
    // InternalError rather than InvalidRequest: the request itself was valid,
    // the server-side precondition disappeared mid-session.
    throw new McpError(ErrorCode.InternalError, NO_SERVICE_MESSAGE);
  }
  return spec;
}

/**
 * Slices a list according to an opaque cursor.
 *
 * The cursor encodes a numeric offset. It is deliberately opaque to clients, so
 * the encoding can change later without breaking them. An unparseable cursor is
 * rejected instead of being silently treated as offset zero, which would make a
 * client loop over the first page forever.
 */
function paginate<T>(
  items: readonly T[],
  cursor: string | undefined,
  pageSize: number,
): { page: T[]; nextCursor?: string } {
  let offset = 0;

  if (cursor !== undefined) {
    let decoded: string;
    try {
      decoded = Buffer.from(cursor, "base64url").toString("utf8");
    } catch {
      throw new McpError(ErrorCode.InvalidParams, "The cursor is malformed.");
    }
    const parsed = Number.parseInt(decoded, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > items.length) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "The cursor is no longer valid; restart the listing without a cursor.",
      );
    }
    offset = parsed;
  }

  const page = items.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length;
  if (nextOffset < items.length) {
    return {
      page,
      nextCursor: Buffer.from(String(nextOffset), "utf8").toString("base64url"),
    };
  }
  return { page };
}

function toolErrorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

/**
 * Builds one MCP server instance.
 *
 * A fresh instance is created per transport session so that per-session state
 * (client capabilities, negotiated protocol version, in-flight requests) is
 * never shared. The document itself is read through `specProvider` on every
 * request rather than captured, so a session always reflects the currently
 * running service instead of a stale snapshot.
 */
export function buildMcpServer(
  specProvider: SpecProvider,
  contextProvider: ContextProvider = () => ({}),
  options: BuildMcpServerOptions = {},
) {
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE),
  );

  const server = new Server(
    {
      name: options.name ?? "openapi-mcp",
      version: options.version ?? "1.1.0",
    },
    {
      // `listChanged` is intentionally not advertised: replacing the document
      // terminates existing sessions instead of mutating them in place, so this
      // server never emits list-changed notifications. Advertising a capability
      // it does not honour would make well-behaved clients wait for updates
      // that never arrive.
      capabilities: {
        tools: {},
        prompts: {},
        resources: {},
      },
      ...(options.instructions
        ? { instructions: options.instructions }
        : {
            instructions:
              "Tools are generated from an OpenAPI document. Call tools/list first; " +
              "arguments marked with a location note map to path, query, header or " +
              "cookie parameters. Tools tagged [PARTIAL SUPPORT] could not be mapped " +
              "completely and may require additional free-form arguments.",
          }),
    },
  );

  /* ------------------------------------------------------------------ */
  /* Tools                                                              */
  /* ------------------------------------------------------------------ */

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const spec = specProvider();
    // An empty list is the correct answer here rather than an error: a client
    // that polls after the service stopped should see zero tools, not a fault.
    const all: Tool[] = spec ? getGeneratedTools(spec).tools : [];
    const { page, nextCursor } = paginate(
      all,
      request.params?.cursor,
      pageSize,
    );
    return { tools: page, ...(nextCursor ? { nextCursor } : {}) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const spec = requireSpec(specProvider);
    const name = request.params.name;

    // An unknown tool is a protocol-level mistake, not a failed execution.
    // Reporting it as `isError` content would let the model keep retrying a
    // name that can never resolve.
    const known = getGeneratedTools(spec).bindings.some(
      (binding) => binding.toolName === name,
    );
    if (!known) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool "${name}".`);
    }

    const rawArgs = request.params.arguments;
    if (
      rawArgs !== undefined &&
      (typeof rawArgs !== "object" ||
        rawArgs === null ||
        Array.isArray(rawArgs))
    ) {
      throw new McpError(
        ErrorCode.InvalidParams,
        "Tool arguments must be an object.",
      );
    }

    try {
      const result = await executeToolCall(
        spec,
        name,
        (rawArgs as Record<string, unknown> | undefined) ?? {},
        {
          ...contextProvider(),
          // Propagating the abort signal is what makes client-side
          // cancellation actually release the upstream connection.
          signal: extra.signal,
        },
      );

      const payload = {
        status: result.status,
        url: result.url,
        method: result.method,
        durationMs: result.durationMs,
        truncated: result.truncated,
        headers: result.headers,
        data: result.data,
      };

      let text: string;
      try {
        text = JSON.stringify(payload, null, 2);
      } catch {
        // Circular or otherwise unserializable upstream payloads must not take
        // down the whole call.
        text = JSON.stringify(
          { ...payload, data: "[unserializable response body]" },
          null,
          2,
        );
      }

      return {
        // An upstream 4xx/5xx is a tool execution failure, which MCP models as
        // `isError` on a successful protocol response — the model is expected to
        // read the status and decide what to do.
        isError: result.status >= 400,
        content: [{ type: "text", text }],
      } satisfies CallToolResult;
    } catch (error) {
      if (error instanceof McpError) throw error;
      // Transport-level upstream failures (DNS, TLS, timeout, abort) are
      // execution failures the model can reason about, so they stay in-band.
      return toolErrorResult(
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  /* ------------------------------------------------------------------ */
  /* Prompts                                                            */
  /* ------------------------------------------------------------------ */

  server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    const spec = specProvider();
    const all: Prompt[] = spec ? generatePrompts(spec) : [];
    const { page, nextCursor } = paginate(
      all,
      request.params?.cursor,
      pageSize,
    );
    return { prompts: page, ...(nextCursor ? { nextCursor } : {}) };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const spec = requireSpec(specProvider);
    const name = request.params.name;

    const rawArgs = request.params.arguments;
    const args: Record<string, unknown> =
      rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : {};

    const result: GetPromptResult | null = resolvePrompt(spec, name, args);
    if (!result) {
      // Must be an error: returning a placeholder message would be fed to the
      // model as if it were the requested prompt.
      throw new McpError(ErrorCode.InvalidParams, `Unknown prompt "${name}".`);
    }
    return result;
  });

  /* ------------------------------------------------------------------ */
  /* Resources                                                          */
  /* ------------------------------------------------------------------ */

  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    const spec = specProvider();
    const all: Resource[] = spec ? generateResources(spec) : [];
    const { page, nextCursor } = paginate(
      all,
      request.params?.cursor,
      pageSize,
    );
    return { resources: page, ...(nextCursor ? { nextCursor } : {}) };
  });

  /**
   * Every resource this server exposes has a concrete URI, so there are no
   * templates. The handler is still registered because a client that sees the
   * `resources` capability is entitled to probe this method, and answering with
   * `MethodNotFound` is treated as fatal by some implementations.
   */
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const spec = requireSpec(specProvider);
    const uri = request.params.uri;

    const resource = readResource(spec, uri);
    if (!resource) {
      // Same reasoning as prompts: a synthetic "not found" body would be
      // indistinguishable from real content once it reaches the model.
      throw new McpError(
        ErrorCode.InvalidParams,
        `Unknown resource URI: ${uri}`,
      );
    }

    return { contents: [resource] };
  });

  return server;
}
