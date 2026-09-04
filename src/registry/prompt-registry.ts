
import type { Document } from "@scalar/openapi-types/3.2";
import type { GeneratedPrompt } from "../types";
import { iterateOperations } from "../core/spec-utils";

export function generatePrompts(spec: Document): GeneratedPrompt[] {
  const prompts: GeneratedPrompt[] = [
    {
      name: "spec_overview",
      description: "Summarize the API scope, conventions, and major capabilities.",
      arguments: [],
    },
  ];

  for (const { path, method, operation } of iterateOperations(spec)) {
    const operationId = String(operation.operationId);
    prompts.push({
      name: `explain_${operationId}`,
      description: `Explain how to use ${operationId}.`,
      arguments: [],
    });
    prompts.push({
      name: `plan_${operationId}`,
      description: `Create an execution plan for ${method.toUpperCase()} ${path}.`,
      arguments: [],
    });
  }

  return prompts;
}
