import { type Tool } from "@modelcontextprotocol/sdk/types.js";
import type {
  Document,
  MediaTypeObject,
  OperationObject,
  RequestBodyObject,
} from "@scalar/openapi-types/3.2";
import {
  collectOperationParameters,
  extractPathTemplateVariables,
  isPlainObject,
  isReference,
  iterateOperations,
  type HttpMethod,
  type NormalizedParameter,
  type SpecWalkIssue,
} from "./spec-utils";

/** JSON Schema fragment describing a tool's arguments. */
export interface InputSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[] | undefined;
  additionalProperties: boolean;
}

/** How the request body is encoded on the wire. */
export type BodyEncoding =
  | "json"
  | "form-urlencoded"
  | "multipart"
  | "text"
  | "binary";

/** Describes where a single tool argument must be placed in the HTTP request. */
export interface ArgumentBinding {
  /** Key used inside the tool's input schema. */
  key: string;
  /** Original parameter name as written in the document. */
  name: string;
  in: "path" | "query" | "header" | "cookie";
  parameter: NormalizedParameter;
}

/** Everything the request builder needs, computed once at generation time. */
export interface ToolBinding {
  toolName: string;
  path: string;
  method: HttpMethod;
  operation: OperationObject;
  /** Argument key -> request location mapping. Order is stable. */
  arguments: ArgumentBinding[];
  /** Input schema key holding the request body, or null when there is none. */
  bodyKey: string | null;
  bodyEncoding: BodyEncoding | null;
  bodyMediaType: string | null;
  bodyRequired: boolean;
  /**
   * True when every input of the operation could be represented faithfully.
   * Degraded tools are still emitted but flagged so the UI can warn users.
   */
  fullySupported: boolean;
  degradationReasons: string[];
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

/**
 * Media types understood by the executor, ordered by preference.
 * The matcher also accepts any `application/*+json` structured syntax suffix.
 */
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

/**
 * Argument key that holds the request body. It is reserved before parameters
 * are processed, so a parameter literally named "body" is renamed instead of
 * shadowing the payload. The request builder must consume `ToolBinding.bodyKey`
 * rather than assuming either constant.
 */
const BODY_KEY = "body";
const FALLBACK_BODY_KEY = "requestBody";

function stripMediaTypeParameters(mediaType: string): string {
  const semicolon = mediaType.indexOf(";");
  const base = semicolon === -1 ? mediaType : mediaType.slice(0, semicolon);
  return base.trim().toLowerCase();
}

/**
 * Resolves the schema of a parameter, handling both the `schema` form and the
 * `content` form. Returns null when nothing usable is present, so the caller can
 * decide whether to fall back or to flag a degradation.
 */
function extractParameterSchema(
  parameter: NormalizedParameter,
): Record<string, unknown> | null {
  if (parameter.schema) return parameter.schema;

  if (parameter.content) {
    // The spec allows exactly one entry; tolerate more by taking the first
    // media type we can actually handle, preferring JSON.
    const entries = Object.entries(parameter.content).filter(([, media]) =>
      isPlainObject(media),
    );

    const jsonEntry =
      entries.find(([mediaType]) =>
        /json/.test(stripMediaTypeParameters(mediaType)),
      ) ?? entries[0];

    // Explicit guard: an empty `content` map leaves nothing to pick.
    if (!jsonEntry) return null;

    const media = jsonEntry[1] as MediaTypeObject;
    if (isPlainObject(media.schema)) {
      return media.schema as Record<string, unknown>;
    }
  }

  return null;
}

/**
 * Recursively removes properties marked `readOnly`, which by definition must not
 * be sent in a request. A visited set guards against cyclic structures produced
 * by dereferencing recursive schemas.
 */
function stripReadOnly(
  schema: unknown,
  visited: WeakSet<object> = new WeakSet(),
): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => stripReadOnly(entry, visited));
  }
  if (!isPlainObject(schema)) return schema;
  if (visited.has(schema)) return schema;
  visited.add(schema);

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && isPlainObject(value)) {
      const properties: Record<string, unknown> = {};
      for (const [propertyName, propertySchema] of Object.entries(value)) {
        if (isPlainObject(propertySchema) && propertySchema.readOnly === true) {
          continue;
        }
        properties[propertyName] = stripReadOnly(propertySchema, visited);
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
      key === "prefixItems"
    ) {
      output[key] = stripReadOnly(value, visited);
      continue;
    }
    output[key] = value;
  }

  // Drop required entries whose property was removed.
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

/**
 * Builds the JSON Schema for one parameter.
 *
 * The original schema is preserved as-is. A `type` is only injected when the
 * document provided nothing at all, because overwriting a composed schema
 * (oneOf/anyOf/allOf/enum) with `type: "string"` would silently corrupt it.
 */
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

  base.description = description;
  return base;
}

/** Picks the best supported media type from a request body object. */
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

/**
 * Generates the input schema plus the binding metadata for a single operation.
 */
function buildToolForOperation(
  toolName: string,
  path: string,
  method: HttpMethod,
  operation: OperationObject,
  parameters: NormalizedParameter[],
): GeneratedTool {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  const argumentBindings: ArgumentBinding[] = [];
  const degradationReasons: string[] = [];
  const usedKeys = new Set<string>();

  // Reserve the body key up front so a parameter can never shadow it.
  const bodyObject =
    operation.requestBody && !isReference(operation.requestBody)
      ? (operation.requestBody as RequestBodyObject)
      : null;
  const bodySelection = bodyObject ? selectBodyMedia(bodyObject) : null;

  let bodyKey: string | null = null;
  if (bodySelection) {
    bodyKey = BODY_KEY;
    usedKeys.add(BODY_KEY);
  }

  for (const parameter of parameters) {
    // Prefer the plain name; fall back to a location-qualified key on collision
    // so that `query.id` and `header.id` can both be expressed.
    let key = parameter.name;
    if (usedKeys.has(key)) {
      key = `${parameter.in}_${parameter.name}`;
    }
    if (usedKeys.has(key)) {
      let counter = 2;
      let next = `${key}_${counter}`;
      while (usedKeys.has(next)) {
        counter += 1;
        next = `${key}_${counter}`;
      }
      key = next;
    }
    usedKeys.add(key);

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

  // Every path template variable must be satisfiable, otherwise the tool can
  // never produce a valid URL and callers deserve to know.
  const declaredPathParameters = new Set(
    parameters.filter((p) => p.in === "path").map((p) => p.name),
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
      bodySchema = {
        type: "string",
        contentEncoding: "base64",
      };
    } else if (bodySelection.encoding === "text") {
      bodySchema = { type: "string" };
    } else {
      bodySchema = { type: "object", additionalProperties: true };
      degradationReasons.push(
        `Request body for "${bodySelection.mediaType}" has no schema; accepting a free-form object.`,
      );
    }

    const bodyDescription = [
      bodyObject?.description,
      `Request body encoded as ${bodySelection.mediaType}.`,
    ]
      .filter(Boolean)
      .join(" ");
    bodySchema.description = bodyDescription;

    properties[bodyKey] = bodySchema;
    if (bodyObject?.required === true) required.push(bodyKey);
  } else if (bodyObject) {
    const available = isPlainObject(bodyObject.content)
      ? Object.keys(bodyObject.content).join(", ")
      : "none";
    degradationReasons.push(
      `No supported request body media type (available: ${available}).`,
    );
  } else if (isReference(operation.requestBody)) {
    degradationReasons.push(
      "Request body still contains an unresolved $ref and was ignored.",
    );
  }

  // Only lock the object down when the whole surface was mapped. Otherwise the
  // caller would be unable to supply the parts we failed to describe.
  const fullySupported = degradationReasons.length === 0;

  const inputSchema: InputSchema = {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: !fullySupported,
  };

  const descriptionParts = [operation.summary, operation.description].filter(
    (entry): entry is string => typeof entry === "string" && entry.length > 0,
  );
  if (descriptionParts.length === 0) {
    descriptionParts.push(`${method.toUpperCase()} ${path}`);
  }
  if ((operation as { deprecated?: unknown }).deprecated === true) {
    descriptionParts.push("[DEPRECATED]");
  }
  if (!fullySupported) {
    descriptionParts.push(`[PARTIAL SUPPORT] ${degradationReasons.join(" ")}`);
  }

  const tool: Tool = {
    name: toolName,
    description: descriptionParts.join(" — "),
    inputSchema: inputSchema as unknown as Tool["inputSchema"],
  };

  const binding: ToolBinding = {
    toolName,
    path,
    method,
    operation,
    arguments: argumentBindings,
    bodyKey,
    bodyEncoding: bodySelection?.encoding ?? null,
    bodyMediaType: bodySelection?.mediaType ?? null,
    bodyRequired: bodyObject?.required === true,
    fullySupported,
    degradationReasons,
  };

  return { tool, binding };
}

/**
 * Generates tools and their request bindings for the whole document.
 * Never throws on malformed input: unusable fragments are reported via `issues`.
 */
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

    // iterateOperations already guarantees uniqueness, but guard again in case a
    // caller feeds pre-resolved operations from elsewhere.
    let toolName = resolved.operationId;
    if (usedToolNames.has(toolName)) {
      toolName = `${toolName}_${resolved.method}`;
    }
    usedToolNames.add(toolName);

    const generated = buildToolForOperation(
      toolName,
      resolved.path,
      resolved.method,
      resolved.operation,
      parameters,
    );
    tools.push(generated.tool);
    bindings.push(generated.binding);
  }

  return { tools, bindings, issues };
}

/** Backwards-compatible helper returning only the tool list. */
export function generateTools(spec: Document | null | undefined): Tool[] {
  return generateToolsDetailed(spec).tools;
}

/** Builds a lookup table from tool name to binding for the executor. */
export function buildBindingIndex(
  spec: Document | null | undefined,
): Map<string, ToolBinding> {
  const index = new Map<string, ToolBinding>();
  for (const binding of generateToolsDetailed(spec).bindings) {
    index.set(binding.toolName, binding);
  }
  return index;
}

/**
 * Argument keys the generator may claim for the request body. Exported so tests
 * and request builders can assert they never collide with a parameter key.
 */
export const RESERVED_BODY_KEYS = [BODY_KEY, FALLBACK_BODY_KEY] as const;
