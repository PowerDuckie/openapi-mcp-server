import fs from "node:fs";
import { load as loadYaml } from "js-yaml";

import { validate, dereference } from "@scalar/openapi-parser";
import type { Document } from "@scalar/openapi-types/3.2";
import { assertUniqueOperationIds } from "./spec-utils";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRaw(rawText: string, isYaml: boolean): unknown {
  if (isYaml) {
    try {
      return loadYaml(rawText);
    } catch (error) {
      throw new Error(
        `Failed to parse YAML: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  try {
    return JSON.parse(rawText);
  } catch (error) {
    throw new Error(
      `Failed to parse JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function validateAndDereference(doc: unknown): Promise<Document> {
  if (!isPlainObject(doc)) {
    throw new Error("The OpenAPI document must be a JSON or YAML object.");
  }
  if (typeof doc.openapi !== "string" || !doc.openapi.trim()) {
    throw new Error(
      'The OpenAPI document must include a non-empty "openapi" field.',
    );
  }
  if (!isPlainObject(doc.info)) {
    throw new Error('The OpenAPI document must include a valid "info" object.');
  }
  if (typeof doc.info.title !== "string" || !doc.info.title.trim()) {
    throw new Error(
      'The OpenAPI document must include a non-empty "info.title" value.',
    );
  }
  if (typeof doc.info.version !== "string" || !doc.info.version.trim()) {
    throw new Error(
      'The OpenAPI document must include a non-empty "info.version" value.',
    );
  }

  const validationResult = await validate(doc);
  if (!validationResult.valid) {
    const errors = (validationResult.errors ?? [])
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      .join("; ");
    throw new Error(
      `The OpenAPI document is invalid: ${errors || "Unknown validation error."}`,
    );
  }

  const dereferenced = await dereference(doc);
  if (dereferenced.errors?.length) {
    const errors = dereferenced.errors
      .map((item) => (typeof item === "string" ? item : JSON.stringify(item)))
      .join("; ");
    throw new Error(`Failed to dereference the OpenAPI document: ${errors}`);
  }

  const schema = dereferenced.schema as Document;
  if (!schema.paths || Object.keys(schema.paths).length === 0) {
    throw new Error("The OpenAPI document does not define any paths.");
  }

  assertUniqueOperationIds(schema);
  return schema;
}

export async function loadOpenApiSpec(filePath: string): Promise<Document> {
  const raw = fs.readFileSync(filePath, "utf8");
  return validateAndDereference(parseRaw(raw, /\.ya?ml$/i.test(filePath)));
}

export async function parseSpecContent(
  rawText: string,
  isYaml: boolean,
): Promise<Document> {
  if (!rawText.trim()) {
    throw new Error("The OpenAPI content is empty.");
  }
  return validateAndDereference(parseRaw(rawText, isYaml));
}
