
import type { Document } from "@scalar/openapi-types/3.2";
import type { GeneratedResource } from "../types";
import { iterateOperations } from "../core/spec-utils";

export function generateResources(spec: Document): GeneratedResource[] {
  const operations = Array.from(iterateOperations(spec)).map((item) => ({
    operationId: item.operation.operationId,
    method: item.method,
    path: item.path,
    summary: item.operation.summary ?? null,
  }));

  return [
    {
      uri: "openapi://spec/summary",
      name: "OpenAPI Spec Summary",
      description: "High-level API metadata and counts.",
      mimeType: "application/json",
    },
    {
      uri: "openapi://spec/raw-info",
      name: "OpenAPI Info Object",
      description: "The OpenAPI info metadata.",
      mimeType: "application/json",
    },
    {
      uri: "openapi://catalog/tools",
      name: "Tool Catalog",
      description: "The generated MCP tool catalog.",
      mimeType: "application/json",
    },
    {
      uri: "openapi://catalog/prompts",
      name: "Prompt Catalog",
      description: "The generated MCP prompt catalog.",
      mimeType: "application/json",
    },
    {
      uri: "openapi://catalog/operations",
      name: "Operation Catalog",
      description: JSON.stringify(operations),
      mimeType: "application/json",
    },
  ];
}
