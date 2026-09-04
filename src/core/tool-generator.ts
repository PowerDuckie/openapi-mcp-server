import { type Tool } from "@modelcontextprotocol/sdk/types.js";
import type {
  Document,
  MediaTypeObject,
  OperationObject,
  PathItemObject,
  RequestBodyObject,
} from "@scalar/openapi-types/3.2";
import {
  collectOperationParameters,
  ensureUniqueName,
  extractPathTemplateVariables,
  isPlainObject,
  isReference,
  iterateOperations,
  truncateGeneratedName,
  type NormalizedParameter,
  type SpecWalkIssue,
} from "./spec-utils";
import type { BodyEncoding } from "../types";

export interface InputSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[] | undefined;
  additionalProperties: boolean;
}

export interface ArgumentBinding {
  key: string;
  name: string;
  in: "path" | "query" | "header" | "cookie";
  parameter: NormalizedParameter;
}

export interface OmittedParameter {
  name: string;
  in: string;
  reason: string;
}

export interface ToolBinding {
  toolName: string;
  path: string;
  pathItem: PathItemObject;
  method: string;
  isStandardMethod: boolean;
  operation: OperationObject;
  arguments: ArgumentBinding[];
  bodyKey: string | null;
  bodyEncoding: BodyEncoding | null;
  bodyMediaType: string | null;
  bodyRequired: boolean;
  omittedParameters: OmittedParameter[];
  fullySupported: boolean;
  degradationReasons: string[];
  usageNotes: string[];
}

export interface GeneratedTool {
  tool: Tool;
  binding: ToolBinding;
}

export interface GenerateToolsResult {
  tools: Tool[];
  bindings: ToolBinding[];
  issues: SpecWalkIssue[];
}

const BODY_PREFERENCE: Array<{
  test: (mediaType: string) => boolean;
  encoding: BodyEncoding;
}> = [
  { test: (m) => m === "application/json", encoding: "json" },
  { test: (m) => /^application\/[\w.+-]+\+json$/.test(m), encoding: "json" },
  {
    test: (m) => m === "application/x-www-form-urlencoded",
    encoding: "form-urlencoded",
  },
  { test: (m) => m === "multipart/form-data", encoding: "multipart" },
  { test: (m) => m.startsWith("text/"), encoding: "text" },
  { test: (m) => m === "application/octet-stream", encoding: "binary" },
];

const BODY_KEY = "body";
const FALLBACK_BODY_KEY = "requestBody";

const BODYLESS_METHODS: ReadonlySet<string> = new Set(["get", "head", "trace"]);

const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
  "get",
  "head",
  "options",
  "trace",
  "query",
]);

const IDEMPOTENT_METHODS: ReadonlySet<string> = new Set([
  "get",
  "head",
  "options",
  "trace",
  "put",
  "delete",
  "query",
]);

const MAX_DESCRIPTION_LENGTH = 1_024;

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function stripMediaTypeParameters(mediaType: string): string {
  const semicolon = mediaType.indexOf(";");
  const base = semicolon === -1 ? mediaType : mediaType.slice(0, semicolon);
  return base.trim().toLowerCase();
}

function extractParameterSchema(
  parameter: NormalizedParameter,
): Record<string, unknown> | null {
  if (parameter.schema) return parameter.schema;

  if (parameter.content) {
    const entries = Object.entries(parameter.content).filter(([, media]) =>
      isPlainObject(media),
    );

    const jsonEntry =
      entries.find(([mediaType]) =>
        /json/.test(stripMediaTypeParameters(mediaType)),
      ) ?? entries[0];

    if (!jsonEntry) return null;

    const media = jsonEntry[1] as MediaTypeObject;
    if (isPlainObject(media.schema)) {
      return media.schema as Record<string, unknown>;
    }
  }

  return null;
}

function stripReadOnly(
  schema: unknown,
  memo: WeakMap<object, unknown> = new WeakMap(),
): unknown {
  if (Array.isArray(schema)) {
    const cached = memo.get(schema);
    if (cached !== undefined) return cached;
    const output: unknown[] = [];
    memo.set(schema, output);
    for (const entry of schema) output.push(stripReadOnly(entry, memo));
    return output;
  }

  if (!isPlainObject(schema)) return schema;

  const cached = memo.get(schema);
  if (cached !== undefined) return cached;

  const output: Record<string, unknown> = {};
  memo.set(schema, output);

  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && isPlainObject(value)) {
      const properties: Record<string, unknown> = {};
      for (const [propertyName, propertySchema] of Object.entries(value)) {
        if (isPlainObject(propertySchema) && propertySchema.readOnly === true) {
          continue;
        }
        properties[propertyName] = stripReadOnly(propertySchema, memo);
      }
      output.properties = properties;
      continue;
    }
    if (
      key === "items" ||
      key === "additionalProperties" ||
      key === "not" ||
      key === "allOf" ||
      key === "anyOf" ||
      key === "oneOf" ||
      key === "prefixItems" ||
      key === "patternProperties" ||
      key === "$defs"
    ) {
      output[key] = stripReadOnly(value, memo);
      continue;
    }
    output[key] = value;
  }

  if (Array.isArray(output.required) && isPlainObject(output.properties)) {
    const properties = output.properties as Record<string, unknown>;
    const filtered = (output.required as unknown[]).filter(
      (entry) => typeof entry === "string" && entry in properties,
    );
    if (filtered.length > 0) output.required = filtered;
    else delete output.required;
  }

  return output;
}

function buildParameterSchema(
  parameter: NormalizedParameter,
): Record<string, unknown> {
  const resolved = extractParameterSchema(parameter);
  const base: Record<string, unknown> = resolved
    ? { ...(stripReadOnly(resolved) as Record<string, unknown>) }
    : { type: "string" };

  const notes: string[] = [];
  if (parameter.description) notes.push(parameter.description);
  notes.push(`Sent as a ${parameter.in} parameter named "${parameter.name}".`);
  if (parameter.deprecated) notes.push("This parameter is deprecated.");

  const existingDescription =
    typeof base.description === "string" ? base.description : undefined;
  const description = existingDescription
    ? [existingDescription, ...notes.slice(parameter.description ? 1 : 0)]
        .filter(Boolean)
        .join(" ")
    : notes.join(" ");

  base.description = truncateText(description, MAX_DESCRIPTION_LENGTH);
  return base;
}

function selectBodyMedia(body: RequestBodyObject): {
  mediaType: string;
  media: MediaTypeObject;
  encoding: BodyEncoding;
} | null {
  if (!isPlainObject(body.content)) return null;

  const candidates = Object.entries(body.content)
    .filter(([, media]) => isPlainObject(media))
    .map(([mediaType, media]) => ({
      mediaType,
      normalized: stripMediaTypeParameters(mediaType),
      media: media as MediaTypeObject,
    }));

  for (const preference of BODY_PREFERENCE) {
    const hit = candidates.find((candidate) =>
      preference.test(candidate.normalized),
    );
    if (hit) {
      return {
        mediaType: hit.mediaType,
        media: hit.media,
        encoding: preference.encoding,
      };
    }
  }
  return null;
}

function buildAnnotations(
  method: string,
  isStandardMethod: boolean,
  title: string,
): NonNullable<Tool["annotations"]> {
  const annotations: NonNullable<Tool["annotations"]> = { title };

  if (!isStandardMethod) {
    annotations.readOnlyHint = false;
    annotations.destructiveHint = true;
    annotations.idempotentHint = false;
    annotations.openWorldHint = true;
    return annotations;
  }

  const readOnly = READ_ONLY_METHODS.has(method);
  annotations.readOnlyHint = readOnly;
  annotations.destructiveHint = readOnly ? false : method === "delete";
  annotations.idempotentHint = IDEMPOTENT_METHODS.has(method);
  annotations.openWorldHint = true;
  return annotations;
}

function buildToolForOperation(
  toolName: string,
  path: string,
  pathItem: PathItemObject,
  method: string,
  isStandardMethod: boolean,
  operation: OperationObject,
  parameters: NormalizedParameter[],
): GeneratedTool {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  const argumentBindings: ArgumentBinding[] = [];
  const degradationReasons: string[] = [];
  const usageNotes: string[] = [];
  const omittedParameters: OmittedParameter[] = [];
  const usedKeys = new Set<string>();

  const exposedParameters: NormalizedParameter[] = [];
  for (const parameter of parameters) {
    if (parameter.reserved) {
      omittedParameters.push({
        name: parameter.name,
        in: parameter.in,
        reason:
          "Managed by the transport layer; supplied from the server configuration.",
      });
      continue;
    }
    exposedParameters.push(parameter);
  }

  const bodyObject =
    operation.requestBody && !isReference(operation.requestBody)
      ? (operation.requestBody as RequestBodyObject)
      : null;

  const bodyAllowed = !BODYLESS_METHODS.has(method);
  const bodySelection =
    bodyObject && bodyAllowed ? selectBodyMedia(bodyObject) : null;

  if (bodyObject && !bodyAllowed) {
    degradationReasons.push(
      `The document declares a request body for ${method.toUpperCase()}, which cannot carry a payload; it was ignored.`,
    );
  }

  let bodyKey: string | null = null;
  if (bodySelection) {
    const clashes = exposedParameters.some(
      (parameter) => parameter.name === BODY_KEY,
    );
    bodyKey = clashes ? FALLBACK_BODY_KEY : BODY_KEY;
    usedKeys.add(bodyKey);
  }

  for (const parameter of exposedParameters) {
    let key = parameter.name;
    if (usedKeys.has(key)) {
      key = `${parameter.in}_${parameter.name}`;
    }
    key = ensureUniqueName(key, usedKeys);

    if (!parameter.schema && !parameter.content) {
      degradationReasons.push(
        `Parameter "${parameter.name}" (${parameter.in}) has no schema; treated as a string.`,
      );
    }

    properties[key] = buildParameterSchema(parameter);
    if (parameter.required) required.push(key);

    argumentBindings.push({
      key,
      name: parameter.name,
      in: parameter.in,
      parameter,
    });
  }

  const declaredPathParameters = new Set(
    exposedParameters
      .filter((parameter) => parameter.in === "path")
      .map((parameter) => parameter.name),
  );
  for (const variable of extractPathTemplateVariables(path)) {
    if (!declaredPathParameters.has(variable)) {
      degradationReasons.push(
        `Path template variable "{${variable}}" has no matching path parameter definition.`,
      );
    }
  }

  if (bodySelection && bodyKey) {
    const rawSchema = isPlainObject(bodySelection.media.schema)
      ? (stripReadOnly(bodySelection.media.schema) as Record<string, unknown>)
      : null;

    let bodySchema: Record<string, unknown>;
    if (rawSchema) {
      bodySchema = { ...rawSchema };
    } else if (bodySelection.encoding === "binary") {
      bodySchema = { type: "string", contentEncoding: "base64" };
    } else if (bodySelection.encoding === "text") {
      bodySchema = { type: "string" };
    } else {
      bodySchema = { type: "object", additionalProperties: true };
      degradationReasons.push(
        `Request body for "${bodySelection.mediaType}" has no schema; accepting a free-form object.`,
      );
    }

    if (bodySelection.encoding === "multipart") {
      usageNotes.push(
        "Multipart bodies are sent as encoded fields; binary file parts must be supplied as base64 strings.",
      );
    }

    const bodyDescription = [
      bodyObject?.description,
      `Request body encoded as ${bodySelection.mediaType}.`,
    ]
      .filter(Boolean)
      .join(" ");
    bodySchema.description = truncateText(
      bodyDescription,
      MAX_DESCRIPTION_LENGTH,
    );

    properties[bodyKey] = bodySchema;
    if (bodyObject?.required === true) required.push(bodyKey);
  } else if (bodyObject && bodyAllowed) {
    const available = isPlainObject(bodyObject.content)
      ? Object.keys(bodyObject.content).join(", ") || "none"
      : "none";
    degradationReasons.push(
      `No supported request body media type (available: ${available}).`,
    );
  } else if (isReference(operation.requestBody)) {
    degradationReasons.push(
      "Request body still contains an unresolved $ref and was ignored.",
    );
  }

  const fullySupported = degradationReasons.length === 0;

  const inputSchema: InputSchema = {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: !fullySupported,
  };

  const label = `${method.toUpperCase()} ${path}`;
  const descriptionParts = [operation.summary, operation.description].filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim().length > 0,
  );
  if (descriptionParts.length === 0) descriptionParts.push(label);
  if ((operation as { deprecated?: unknown }).deprecated === true) {
    descriptionParts.push("[DEPRECATED]");
  }
  if (!isStandardMethod) {
    descriptionParts.push(`[CUSTOM METHOD ${method.toUpperCase()}]`);
  }
  if (omittedParameters.length > 0) {
    descriptionParts.push(
      `[SERVER-MANAGED: ${omittedParameters.map((entry) => entry.name).join(", ")}]`,
    );
  }
  if (usageNotes.length > 0) {
    descriptionParts.push(`[NOTE] ${usageNotes.join(" ")}`);
  }
  if (!fullySupported) {
    descriptionParts.push(`[PARTIAL SUPPORT] ${degradationReasons.join(" ")}`);
  }

  const tool: Tool = {
    name: toolName,
    description: truncateText(
      descriptionParts.join(" — "),
      MAX_DESCRIPTION_LENGTH,
    ),
    inputSchema: inputSchema as unknown as Tool["inputSchema"],
    annotations: buildAnnotations(
      method,
      isStandardMethod,
      operation.summary?.trim() || label,
    ),
  };

  const binding: ToolBinding = {
    toolName,
    path,
    pathItem,
    method,
    isStandardMethod,
    operation,
    arguments: argumentBindings,
    bodyKey,
    bodyEncoding: bodySelection?.encoding ?? null,
    bodyMediaType: bodySelection?.mediaType ?? null,
    bodyRequired: bodyObject?.required === true && bodySelection !== null,
    omittedParameters,
    fullySupported,
    degradationReasons,
    usageNotes,
  };

  return { tool, binding };
}

export function generateToolsDetailed(
  spec: Document | null | undefined,
): GenerateToolsResult {
  const issues: SpecWalkIssue[] = [];
  const tools: Tool[] = [];
  const bindings: ToolBinding[] = [];
  const usedToolNames = new Set<string>();

  for (const resolved of iterateOperations(spec, issues)) {
    const parameters = collectOperationParameters(
      resolved.pathItem,
      resolved.operation,
      issues,
      { path: resolved.path, method: resolved.method },
    );

    const toolName = ensureUniqueName(
      truncateGeneratedName(resolved.operationId),
      usedToolNames,
    );

    const generated = buildToolForOperation(
      toolName,
      resolved.path,
      resolved.pathItem,
      resolved.method,
      resolved.isStandardMethod,
      resolved.operation,
      parameters,
    );
    tools.push(generated.tool);
    bindings.push(generated.binding);
  }

  return { tools, bindings, issues };
}

export function generateTools(spec: Document | null | undefined): Tool[] {
  return generateToolsDetailed(spec).tools;
}

export const RESERVED_BODY_KEYS = [BODY_KEY, FALLBACK_BODY_KEY] as const;

const resultCache = new WeakMap<object, GenerateToolsResult>();
const bindingIndexCache = new WeakMap<object, Map<string, ToolBinding>>();

const EMPTY_RESULT: GenerateToolsResult = Object.freeze({
  tools: [],
  bindings: [],
  issues: [],
}) as GenerateToolsResult;

export function getGeneratedTools(
  spec: Document | null | undefined,
): GenerateToolsResult {
  if (!spec) return EMPTY_RESULT;
  const cached = resultCache.get(spec);
  if (cached) return cached;
  const generated = generateToolsDetailed(spec);
  resultCache.set(spec, generated);
  return generated;
}

export function getBindingIndex(
  spec: Document | null | undefined,
): Map<string, ToolBinding> {
  if (!spec) return new Map();
  const cached = bindingIndexCache.get(spec);
  if (cached) return cached;
  const index = new Map<string, ToolBinding>();
  for (const binding of getGeneratedTools(spec).bindings) {
    index.set(binding.toolName, binding);
  }
  bindingIndexCache.set(spec, index);
  return index;
}

export const buildBindingIndex = getBindingIndex;
