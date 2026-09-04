import type { Document } from "@scalar/openapi-types/3.2";
import type { GeneratedResource, ResourceContentItem } from "../types";
import { generatePrompts } from "./prompt-registry";
import { generateToolsDetailed } from "../core/tool-generator";
import { iterateOperations } from "../core/spec-utils";

export function generateResources(spec: Document): GeneratedResource[] {
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
      uri: "openapi://catalog/resources",
      name: "Resource Catalog",
      description: "The generated MCP resource catalog.",
      mimeType: "application/json",
    },
    {
      uri: "openapi://catalog/operations",
      name: "Operation Catalog",
      description: "The full operation catalog.",
      mimeType: "application/json",
    },
    {
      uri: "openapi://spec/document",
      name: "OpenAPI Document",
      description: "The dereferenced OpenAPI document.",
      mimeType: "application/json",
    },
  ];
}

export function readResource(spec: Document, uri: string): ResourceContentItem | null {
  if (uri === "openapi://spec/summary") {
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(
        {
          title: spec.info?.title ?? null,
          version: spec.info?.version ?? null,
          openapi: spec.openapi,
          servers: spec.servers ?? [],
          operationCount: Array.from(iterateOperations(spec)).length,
        },
        null,
        2,
      ),
    };
  }

  if (uri === "openapi://spec/raw-info") {
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(spec.info ?? {}, null, 2),
    };
  }

  if (uri === "openapi://catalog/tools") {
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(generateToolsDetailed(spec), null, 2),
    };
  }

  if (uri === "openapi://catalog/prompts") {
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({ prompts: generatePrompts(spec) }, null, 2),
    };
  }

  if (uri === "openapi://catalog/resources") {
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify({ resources: generateResources(spec) }, null, 2),
    };
  }

  if (uri === "openapi://catalog/operations") {
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(
        Array.from(iterateOperations(spec)).map((item) => ({
          operationId: item.operationId,
          method: item.method,
          path: item.path,
          summary: item.operation.summary ?? null,
          description: item.operation.description ?? null,
        })),
        null,
        2,
      ),
    };
  }

  if (uri === "openapi://spec/document") {
    return {
      uri,
      mimeType: "application/json",
      text: JSON.stringify(spec, null, 2),
    };
  }

  return null;
}
