import type { ParameterLocation } from "@/types";
import type {
  Document,
  OperationObject,
  ParameterObject,
  PathItemObject,
} from "@scalar/openapi-types/3.2";

/**
 * HTTP methods recognized as operations inside a Path Item Object.
 *
 * `query` is included because the 2025 HTTP QUERY method is a first-class
 * operation key in OpenAPI 3.2. Any other key on a path item (summary,
 * description, servers, parameters, $ref, vendor extensions, and the 3.2
 * `additionalOperations` map) must never be treated as a standard operation.
 */
export const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
  "query",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

const HTTP_METHOD_SET: ReadonlySet<string> = new Set<string>(HTTP_METHODS);

/**
 * Path Item keys that are structural metadata rather than operations. Used to
 * avoid emitting spurious issues while walking a path item.
 */
const PATH_ITEM_METADATA_KEYS: ReadonlySet<string> = new Set([
  "$ref",
  "summary",
  "description",
  "servers",
  "parameters",
  "additionalOperations",
]);

/** Parameter locations this library can map onto an HTTP request. */
export const PARAMETER_LOCATIONS = [
  "path",
  "query",
  "header",
  "cookie",
] as const;

const PARAMETER_LOCATION_SET: ReadonlySet<string> = new Set<string>(
  PARAMETER_LOCATIONS,
);

/**
 * Locations that OpenAPI 3.2 defines but this library does not map onto tool
 * arguments. They are recognized explicitly so the operator gets a precise
 * warning instead of a silently dropped parameter.
 */
const KNOWN_UNSUPPORTED_LOCATIONS: ReadonlySet<string> = new Set([
  "querystring",
]);

/**
 * Header names that must never become tool arguments: they are controlled by
 * the transport layer, and letting a model set them breaks the request.
 */
const RESERVED_HEADER_NAMES: ReadonlySet<string> = new Set([
  "accept",
  "content-type",
  "authorization",
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
]);

/**
 * Practical upper bound for a generated identifier. Several MCP clients reject
 * or visually truncate longer tool names, so the generator needs a documented
 * limit to work against.
 */
export const MAX_GENERATED_NAME_LENGTH = 64;

/**
 * A parameter validated to carry the fields this library relies on.
 *
 * The upstream `ParameterObject` type is a union (schema form vs. content
 * form), so it is normalized into a single permissive shape after runtime
 * validation.
 */
export interface NormalizedParameter {
  name: string;
  in: ParameterLocation;
  required: boolean;
  description?: string | undefined;
  deprecated?: boolean | undefined;
  style?: string | undefined;
  explode?: boolean | undefined;
  allowReserved?: boolean | undefined;
  allowEmptyValue?: boolean | undefined;
  /** Present when the parameter uses the `schema` form. */
  schema?: Record<string, unknown> | undefined;
  /** Present when the parameter uses the `content` form. */
  content?: Record<string, unknown> | undefined;
  /** Media type selected from `content`, when the content form is used. */
  contentMediaType?: string | undefined;
  /** True when the transport owns this value and it must not be exposed. */
  reserved?: boolean | undefined;
  /** The original object, kept for callers that need untouched data. */
  raw: ParameterObject;
}

/** A single resolved operation together with its owning path item. */
export interface ResolvedOperation {
  path: string;
  /**
   * Lower-cased HTTP method. Normally a {@link HttpMethod}, but may be any
   * token when it originates from the OpenAPI 3.2 `additionalOperations` map.
   */
  method: string;
  operation: OperationObject;
  pathItem: PathItemObject;
  /** Guaranteed non-empty and unique across the document. */
  operationId: string;
  /** True when the id was synthesized because the document omitted it. */
  operationIdGenerated: boolean;
  /** False when the method came from `additionalOperations`. */
  isStandardMethod: boolean;
}

/**
 * Public alias kept for library consumers. `ResolvedOperation` is the internal
 * name; both refer to the exact same shape.
 */
export type OperationEntry = ResolvedOperation;

/** Codes attached to non-fatal problems found while walking a document. */
export type SpecWalkIssueCode =
  | "invalid-paths-object"
  | "invalid-path-template"
  | "invalid-path-item"
  | "invalid-operation"
  | "invalid-parameter"
  | "unsupported-parameter-location"
  | "reserved-parameter"
  | "unresolved-ref"
  | "duplicate-operation-id"
  | "generated-operation-id"
  | "truncated-operation-id";

/** Non-fatal issues collected while walking the document. */
export interface SpecWalkIssue {
  path: string;
  method?: string | undefined;
  code: SpecWalkIssueCode;
  message: string;
}

/** Sink that tolerates being absent, so callers never need a temporary array. */
type IssueSink = SpecWalkIssue[] | undefined;

function report(sink: IssueSink, issue: SpecWalkIssue): void {
  sink?.push(issue);
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns true when the value still carries an unresolved JSON Reference. */
export function isReference(value: unknown): boolean {
  return isPlainObject(value) && typeof value.$ref === "string";
}

/**
 * Deterministic, dependency-free 32-bit hash (FNV-1a). Used only to keep
 * truncated identifiers unique and stable across runs; it is never used for
 * anything security relevant.
 */
function stableDigest(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    // 32-bit FNV prime multiplication without overflowing into float space.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0").slice(0, 7);
}

/**
 * Shortens an identifier to {@link MAX_GENERATED_NAME_LENGTH} while preserving
 * uniqueness by appending a hash of the original value.
 */
export function truncateGeneratedName(
  name: string,
  limit: number = MAX_GENERATED_NAME_LENGTH,
): string {
  if (name.length <= limit) return name;
  const digest = stableDigest(name);
  const keep = Math.max(1, limit - digest.length - 1);
  return `${name.slice(0, keep).replace(/_+$/, "")}_${digest}`;
}

/**
 * Extracts the `{name}` template variables from a path template.
 * Duplicates are collapsed; order follows first appearance.
 */
export function extractPathTemplateVariables(pathTemplate: string): string[] {
  const found = new Set<string>();
  const pattern = /\{([^{}/]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(pathTemplate)) !== null) {
    const name = match[1]?.trim();
    if (name) found.add(name);
  }
  return [...found];
}

/** Picks the media type to use for a parameter expressed in `content` form. */
function selectContentMediaType(
  content: Record<string, unknown>,
): string | undefined {
  const keys = Object.keys(content);
  if (keys.length === 0) return undefined;
  // The spec allows exactly one entry; prefer JSON if a tolerant document
  // supplies several.
  const json = keys.find((key) => /\bjson\b/i.test(key));
  return json ?? keys[0];
}

/**
 * Normalizes a raw parameter entry. Returns null when the entry is unusable,
 * which happens for unresolved references, missing `name` / `in`, unsupported
 * locations, or a malformed schema/content combination.
 */
export function normalizeParameter(
  candidate: unknown,
): NormalizedParameter | null {
  if (!isPlainObject(candidate)) return null;
  if (isReference(candidate)) return null;

  const name = candidate.name;
  const location = candidate.in;
  if (typeof name !== "string" || name.trim().length === 0) return null;
  if (typeof location !== "string") return null;
  if (!PARAMETER_LOCATION_SET.has(location)) return null;

  const hasSchema = isPlainObject(candidate.schema);
  const hasContent =
    isPlainObject(candidate.content) &&
    Object.keys(candidate.content as Record<string, unknown>).length > 0;
  // The spec requires exactly one of `schema` or `content`. Accepting both
  // would make the request builder's behaviour depend on evaluation order.
  if (hasSchema && hasContent) return null;

  // Path parameters are required by definition; the spec mandates
  // required=true, but tolerant documents omit it, so it is forced here rather
  // than trusted from input.
  const trimmedName = name.trim();
  const required = location === "path" ? true : candidate.required === true;

  const normalized: NormalizedParameter = {
    name: trimmedName,
    in: location as ParameterLocation,
    required,
    raw: candidate as ParameterObject,
  };

  if (
    location === "header" &&
    RESERVED_HEADER_NAMES.has(trimmedName.toLowerCase())
  ) {
    normalized.reserved = true;
  }

  if (typeof candidate.description === "string") {
    normalized.description = candidate.description;
  }
  if (typeof candidate.deprecated === "boolean") {
    normalized.deprecated = candidate.deprecated;
  }
  if (typeof candidate.style === "string") normalized.style = candidate.style;
  if (typeof candidate.explode === "boolean") {
    normalized.explode = candidate.explode;
  }
  if (typeof candidate.allowReserved === "boolean") {
    normalized.allowReserved = candidate.allowReserved;
  }
  if (typeof candidate.allowEmptyValue === "boolean") {
    normalized.allowEmptyValue = candidate.allowEmptyValue;
  }
  if (hasSchema) {
    normalized.schema = candidate.schema as Record<string, unknown>;
  }
  if (hasContent) {
    const content = candidate.content as Record<string, unknown>;
    normalized.content = content;
    const mediaType = selectContentMediaType(content);
    if (mediaType) normalized.contentMediaType = mediaType;
  }

  return normalized;
}

/**
 * Effective style for a parameter, applying the defaults mandated by the spec
 * when the document does not state one explicitly.
 */
export function effectiveStyle(parameter: NormalizedParameter): string {
  if (parameter.style) return parameter.style;
  switch (parameter.in) {
    case "query":
    case "cookie":
      return "form";
    case "path":
    case "header":
    default:
      return "simple";
  }
}

/** Effective explode flag. The spec default is true only when style is `form`. */
export function effectiveExplode(parameter: NormalizedParameter): boolean {
  if (typeof parameter.explode === "boolean") return parameter.explode;
  return effectiveStyle(parameter) === "form";
}

/**
 * Merges path-item level parameters with operation level parameters.
 *
 * Per the specification the merge key is the pair (name, in), and an operation
 * level entry overrides an inherited one. Entries that cannot be normalized are
 * dropped and reported through `issues` instead of silently corrupting output.
 */
export function collectOperationParameters(
  pathItem: PathItemObject | undefined,
  operation: OperationObject | undefined,
  issues?: SpecWalkIssue[],
  context?: { path: string; method: string },
): NormalizedParameter[] {
  const merged = new Map<string, NormalizedParameter>();
  const contextPath = context?.path ?? "";
  const contextMethod = context?.method;

  const absorb = (list: unknown, origin: "path-item" | "operation"): void => {
    if (list === undefined || list === null) return;
    if (!Array.isArray(list)) {
      report(issues, {
        path: contextPath,
        method: contextMethod,
        code: "invalid-parameter",
        message: `The ${origin} "parameters" field is not an array and was ignored.`,
      });
      return;
    }

    for (const entry of list) {
      const normalized = normalizeParameter(entry);
      if (!normalized) {
        const location = isPlainObject(entry) ? entry.in : undefined;
        if (
          typeof location === "string" &&
          KNOWN_UNSUPPORTED_LOCATIONS.has(location)
        ) {
          report(issues, {
            path: contextPath,
            method: contextMethod,
            code: "unsupported-parameter-location",
            message: `Parameter location "${location}" is not supported and was skipped.`,
          });
          continue;
        }
        report(issues, {
          path: contextPath,
          method: contextMethod,
          code: isReference(entry) ? "unresolved-ref" : "invalid-parameter",
          message: `Skipped an unusable ${origin} parameter entry.`,
        });
        continue;
      }

      if (normalized.reserved) {
        report(issues, {
          path: contextPath,
          method: contextMethod,
          code: "reserved-parameter",
          message: `Header parameter "${normalized.name}" is managed by the transport and will not be exposed as an argument.`,
        });
      }

      merged.set(`${normalized.in}:${normalized.name}`, normalized);
    }
  };

  absorb(pathItem?.parameters, "path-item");
  absorb(operation?.parameters, "operation");

  return [...merged.values()];
}

/**
 * Builds a deterministic, identifier-safe fallback name for an operation that
 * omits `operationId`. The result is stable across runs for the same document,
 * which matters because tool names are persisted by clients.
 */
export function synthesizeOperationId(
  method: string,
  pathTemplate: string,
): string {
  const segments = pathTemplate
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      const templated = segment.match(/^\{(.+)\}$/);
      if (templated) return `by_${templated[1]}`;
      return segment;
    })
    .map((segment) => segment.replace(/[^A-Za-z0-9]+/g, "_"))
    .map((segment) => segment.replace(/^_+|_+$/g, ""))
    .filter(Boolean);

  const safeMethod =
    method
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "call";

  const base = [safeMethod, ...segments].join("_");
  const cleaned = base.replace(/_{2,}/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || `${safeMethod}_root`;
}

/**
 * Ensures a candidate name is unique within `taken` by appending a numeric
 * suffix, and registers the result. The original name is returned untouched
 * when it is already free.
 */
export function ensureUniqueName(
  candidate: string,
  taken: Set<string>,
): string {
  if (!taken.has(candidate)) {
    taken.add(candidate);
    return candidate;
  }
  let counter = 2;
  let next = `${candidate}_${counter}`;
  while (taken.has(next)) {
    counter += 1;
    next = `${candidate}_${counter}`;
  }
  taken.add(next);
  return next;
}

/** Reads a path item's 3.2 `additionalOperations` map, if present and usable. */
function readAdditionalOperations(
  pathItem: Record<string, unknown>,
): Array<[string, unknown]> {
  const extra = pathItem.additionalOperations;
  if (!isPlainObject(extra)) return [];
  return Object.entries(extra);
}

/**
 * Walks every operation in the document.
 *
 * Guarantees for consumers:
 *  - only operation keys are yielded, never path item metadata;
 *  - OpenAPI 3.2 `additionalOperations` entries are included, flagged via
 *    `isStandardMethod: false`;
 *  - malformed path items and operations are skipped, never thrown on;
 *  - `operationId` is always a non-empty string, unique across the document,
 *    and no longer than {@link MAX_GENERATED_NAME_LENGTH}.
 *
 * Non-fatal problems are appended to `issues` when the caller supplies an array.
 */
export function* iterateOperations(
  spec: Document | null | undefined,
  issues?: SpecWalkIssue[],
): Generator<ResolvedOperation> {
  if (!spec) return;
  if (spec.paths === undefined || spec.paths === null) return;
  if (!isPlainObject(spec.paths)) {
    report(issues, {
      path: "",
      code: "invalid-paths-object",
      message: 'The document\'s "paths" field is not an object.',
    });
    return;
  }

  const usedIds = new Set<string>();

  for (const [pathTemplate, rawPathItem] of Object.entries(spec.paths)) {
    // Vendor extensions at the paths level must be ignored.
    if (pathTemplate.startsWith("x-")) continue;

    if (!pathTemplate.startsWith("/")) {
      report(issues, {
        path: pathTemplate,
        code: "invalid-path-template",
        message: 'Path templates must start with "/"; entry was skipped.',
      });
      continue;
    }

    if (!isPlainObject(rawPathItem)) {
      report(issues, {
        path: pathTemplate,
        code: "invalid-path-item",
        message: "Path item is not an object and was skipped.",
      });
      continue;
    }
    if (isReference(rawPathItem)) {
      report(issues, {
        path: pathTemplate,
        code: "unresolved-ref",
        message: "Path item still contains an unresolved $ref and was skipped.",
      });
      continue;
    }

    const pathItem = rawPathItem as PathItemObject;

    const candidates: Array<{
      key: string;
      value: unknown;
      standard: boolean;
    }> = [];

    for (const [key, value] of Object.entries(rawPathItem)) {
      if (key.startsWith("x-")) continue;
      if (PATH_ITEM_METADATA_KEYS.has(key)) continue;
      if (!HTTP_METHOD_SET.has(key.toLowerCase())) continue;
      candidates.push({ key: key.toLowerCase(), value, standard: true });
    }

    for (const [key, value] of readAdditionalOperations(rawPathItem)) {
      const method = key.trim().toLowerCase();
      if (!method) continue;
      // A standard method repeated here would create two tools for one route.
      if (candidates.some((candidate) => candidate.key === method)) continue;
      candidates.push({ key: method, value, standard: false });
    }

    for (const { key: method, value: rawOperation, standard } of candidates) {
      if (!isPlainObject(rawOperation)) {
        report(issues, {
          path: pathTemplate,
          method,
          code: "invalid-operation",
          message: "Operation is not an object and was skipped.",
        });
        continue;
      }
      if (isReference(rawOperation)) {
        report(issues, {
          path: pathTemplate,
          method,
          code: "unresolved-ref",
          message:
            "Operation still contains an unresolved $ref and was skipped.",
        });
        continue;
      }

      const operation = rawOperation as OperationObject;
      const declaredId =
        typeof (operation as { operationId?: unknown }).operationId === "string"
          ? (operation as { operationId: string }).operationId.trim()
          : "";

      let generated = false;
      let candidate = declaredId;
      if (!candidate) {
        candidate = synthesizeOperationId(method, pathTemplate);
        generated = true;
        report(issues, {
          path: pathTemplate,
          method,
          code: "generated-operation-id",
          message: `Missing operationId; generated "${candidate}".`,
        });
      }

      const capped = truncateGeneratedName(candidate);
      if (capped !== candidate) {
        report(issues, {
          path: pathTemplate,
          method,
          code: "truncated-operation-id",
          message: `operationId "${candidate}" exceeded ${MAX_GENERATED_NAME_LENGTH} characters and was shortened to "${capped}".`,
        });
      }

      const operationId = ensureUniqueName(capped, usedIds);
      if (operationId !== capped) {
        report(issues, {
          path: pathTemplate,
          method,
          code: "duplicate-operation-id",
          message: `Duplicate operationId "${capped}"; renamed to "${operationId}".`,
        });
      }

      yield {
        path: pathTemplate,
        method,
        operation,
        pathItem,
        operationId,
        operationIdGenerated: generated,
        isStandardMethod: standard,
      };
    }
  }
}

/** Convenience wrapper returning a materialized array. */
export function listOperations(
  spec: Document | null | undefined,
  issues?: SpecWalkIssue[],
): ResolvedOperation[] {
  return [...iterateOperations(spec, issues)];
}

/**
 * Reads the operationId exactly as declared by the document, or an empty
 * string when it is absent or blank.
 */
function declaredOperationId(entry: ResolvedOperation): string {
  const value = (entry.operation as { operationId?: unknown }).operationId;
  return typeof value === "string" ? value.trim() : "";
}

/** Pre-computed lookup structures for one parsed document. */
export interface OperationIndex {
  operations: ResolvedOperation[];
  /** Keyed by the effective id, which is what clients see as the tool name. */
  byOperationId: Map<string, ResolvedOperation>;
  /**
   * Keyed by the id declared in the document. Only unambiguous entries are
   * present: a declared id claimed by several operations, or one that another
   * operation already owns as its effective id, is excluded.
   */
  byDeclaredId: Map<string, ResolvedOperation>;
}

/**
 * Cache keyed by the parsed document instance. A new object is produced each
 * time a specification is applied, so entries become collectable as soon as the
 * previous document is dropped.
 */
const indexCache = new WeakMap<Document, OperationIndex>();

function buildIndex(spec: Document): OperationIndex {
  const operations = listOperations(spec);
  const byOperationId = new Map<string, ResolvedOperation>();
  for (const entry of operations) {
    // iterateOperations already guarantees uniqueness of the effective id.
    byOperationId.set(entry.operationId, entry);
  }

  const declaredCounts = new Map<string, number>();
  for (const entry of operations) {
    const declared = declaredOperationId(entry);
    if (!declared) continue;
    declaredCounts.set(declared, (declaredCounts.get(declared) ?? 0) + 1);
  }

  const byDeclaredId = new Map<string, ResolvedOperation>();
  for (const entry of operations) {
    const declared = declaredOperationId(entry);
    if (!declared) continue;
    if (declaredCounts.get(declared) !== 1) continue;
    // Never let a declared id shadow another operation's effective id.
    if (byOperationId.has(declared)) continue;
    byDeclaredId.set(declared, entry);
  }

  return { operations, byOperationId, byDeclaredId };
}

/** Returns the cached lookup index for a document, building it on first use. */
export function getOperationIndex(
  spec: Document | null | undefined,
): OperationIndex {
  if (!spec) {
    return {
      operations: [],
      byOperationId: new Map(),
      byDeclaredId: new Map(),
    };
  }
  const cached = indexCache.get(spec);
  if (cached) return cached;
  const built = buildIndex(spec);
  indexCache.set(spec, built);
  return built;
}

/**
 * Locates an operation by id, in O(1) after the first call.
 *
 * The effective id produced by {@link iterateOperations} always wins, because
 * that is the name the tool generator exposes and therefore the only value a
 * client can legitimately send. A declared id is consulted only as a fallback,
 * and only when it is unambiguous — otherwise a document mixing declared and
 * synthesized ids could route a call to the wrong endpoint without any error.
 *
 * Returns null instead of throwing: an unknown id is a caller-level condition
 * (bad tool name), not a malformed document.
 */
export function findOperationById(
  spec: Document | null | undefined,
  operationId: string,
): OperationEntry | null {
  if (typeof operationId !== "string") return null;
  const target = operationId.trim();
  if (!target) return null;

  const index = getOperationIndex(spec);
  return (
    index.byOperationId.get(target) ?? index.byDeclaredId.get(target) ?? null
  );
}

/** Describes one operationId claimed by more than one operation. */
export interface DuplicateOperationId {
  operationId: string;
  occurrences: Array<{ method: string; path: string }>;
}

/**
 * Reports every operationId declared more than once. Synthesized ids are
 * excluded because they are derived from method + path and are unique by
 * construction; only author-declared ids can collide.
 *
 * This is a validation helper, not part of the generation path — tool naming
 * already de-duplicates via {@link ensureUniqueName}, so a duplicate id
 * degrades the tool names rather than breaking the server. Use it to warn the
 * operator.
 */
export function findDuplicateOperationIds(
  spec: Document | null | undefined,
): DuplicateOperationId[] {
  const seen = new Map<string, Array<{ method: string; path: string }>>();

  for (const entry of getOperationIndex(spec).operations) {
    const declared = declaredOperationId(entry);
    if (!declared) continue;

    const bucket = seen.get(declared);
    if (bucket) {
      bucket.push({ method: entry.method, path: entry.path });
    } else {
      seen.set(declared, [{ method: entry.method, path: entry.path }]);
    }
  }

  const duplicates: DuplicateOperationId[] = [];
  for (const [operationId, occurrences] of seen) {
    if (occurrences.length > 1) duplicates.push({ operationId, occurrences });
  }
  return duplicates;
}

/**
 * Throws when the document declares the same operationId twice. Kept as a
 * separate strict entry point so library consumers can choose between failing
 * fast at load time and merely surfacing a warning.
 */
export function assertUniqueOperationIds(
  spec: Document | null | undefined,
): void {
  const duplicates = findDuplicateOperationIds(spec);
  if (duplicates.length === 0) return;

  const detail = duplicates
    .map((duplicate) => {
      const where = duplicate.occurrences
        .map((item) => `${item.method.toUpperCase()} ${item.path}`)
        .join(", ");
      return `"${duplicate.operationId}" (${where})`;
    })
    .join("; ");

  throw new Error(`Duplicate operationId values in specification: ${detail}`);
}
