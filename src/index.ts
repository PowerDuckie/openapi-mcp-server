export { loadOpenApiSpec, parseSpecContent } from "./core/openapi-loader";

export {
  generateTools,
  generateToolsDetailed,
  buildBindingIndex,
} from "./core/tool-generator";
export type {
  ToolBinding,
  GeneratedTool as GeneratedToolWithBinding,
} from "./core/tool-generator";

export { generatePrompts, resolvePrompt } from "./registry/prompt-registry";
export { generateResources, readResource } from "./registry/resource-registry";
export { executeToolCall } from "./core/http-executor";

export {
  iterateOperations,
  collectOperationParameters,
  normalizeParameter,
  synthesizeOperationId,
  ensureUniqueName,
  extractPathTemplateVariables,
  effectiveStyle,
  effectiveExplode,
  findOperationById,
  findDuplicateOperationIds,
  assertUniqueOperationIds,
} from "./core/spec-utils";
export type {
  OperationEntry,
  DuplicateOperationId,
} from "./core/spec-utils";

export { buildRequest } from "./core/request-builder";

export { buildMcpServer } from "./mcp/create-server";
export type { SpecProvider, ContextProvider } from "./mcp/create-server";
export { startStdioServer } from "./mcp/transport-stdio";
export { attachSseRoutes } from "./mcp/transport-http";

export { startAdminServer } from "./server/admin-server";
export { createAuthMiddleware } from "./server/auth";

export type * from "./types";
