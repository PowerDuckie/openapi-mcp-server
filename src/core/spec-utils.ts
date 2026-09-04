import type {
  Document,
  OperationObject,
  ParameterObject,
  PathItemObject,
} from "@scalar/openapi-types/3.2";

/**
 * HTTP methods that are recognized as operations inside a Path Item Object.
 * Any other key on a path item (summary, description, servers, parameters, $ref,
 * vendor extensions) must never be treated as an operation.
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

const HTTP_METHOD_SET = new Set<string>(HTTP_METHODS);

/** Parameter locations defined by the specification. */
export type ParameterLocation = "path" | "query" | "header" | "cookie";

const PARAMETER_LOCATIONS = new Set<string>([
  "path",
  "query",
  "header",
  "cookie",
]);

/**
 * A parameter that has been validated to carry the fields this library relies on.
 * The upstream `ParameterObject` type is a union (schema form vs. content form),
 * so we normalize it into a single permissive shape after runtime validation.
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
  /** The original object, kept for callers that need untouched data. */
  raw: ParameterObject;
}

/** A single resolved operation together with its owning path item. */
export interface ResolvedOperation {
  path: string;
  method: HttpMethod;
  operation: OperationObject;
  pathItem: PathItemObject;
  /** Guaranteed non-empty, unique across the document. */
  operationId: string;
  /** True when the id was synthesized because the document omitted it. */
  operationIdGenerated: boolean;
}

/**
 * Public alias kept for library consumers. `ResolvedOperation` is the internal
 * name; both refer to the exact same shape.
 */
export type OperationEntry = ResolvedOperation;

/** Non-fatal issues collected while walking the document. */
export interface SpecWalkIssue {
  path: string;
  method?: string | undefined;
  code:
    | "invalid-path-item"
    | "invalid-operation"
    | "invalid-parameter"
    | "unresolved-ref"
    | "duplicate-operation-id"
    | "generated-operation-id";
  message: string;
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

/**
 * Normalizes a raw parameter entry. Returns null when the entry is unusable,
 * which happens for unresolved references or missing `name` / `in`.
 */
export function normalizeParameter(
  candidate: unknown,
): NormalizedParameter | null {
  if (!isPlainObject(candidate)) return null;
  if (isReference(candidate)) return null;

  const name = candidate.name;
  const location = candidate.in;
  if (typeof name !== "string" || name.length === 0) return null;
  if (typeof location !== "string" || !PARAMETER_LOCATIONS.has(location)) {
    return null;
  }

  // Path parameters are required by definition; the spec mandates required=true,
  // but tolerant documents omit it, so we force it here rather than trusting input.
  const required = location === "path" ? true : candidate.required === true;

  const normalized: NormalizedParameter = {
    name,
    in: location as ParameterLocation,
    required,
    raw: candidate as ParameterObject,
  };

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
  if (isPlainObject(candidate.schema)) {
    normalized.schema = candidate.schema;
  }
  if (isPlainObject(candidate.content)) {
    normalized.content = candidate.content;
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

/**
 * Effective explode flag. The spec default is true only when style is `form`.
 */
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

  const absorb = (list: unknown, origin: "path-item" | "operation"): void => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      const normalized = normalizeParameter(entry);
      if (!normalized) {
        issues?.push({
          path: context?.path ?? "",
          method: context?.method,
          code: isReference(entry) ? "unresolved-ref" : "invalid-parameter",
          message: `Skipped an unusable ${origin} parameter entry.`,
        });
        continue;
      }
      merged.set(`${normalized.in}:${normalized.name}`, normalized);
    }
  };

  absorb(pathItem?.parameters, "path-item");
  absorb(operation?.parameters, "operation");

  return [...merged.values()];
}

/**
 * Builds a deterministic, filesystem- and identifier-safe fallback name for an
 * operation that omits `operationId`. The result is stable across runs for the
 * same document, which matters because tool names are persisted by clients.
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

  const base = [method.toLowerCase(), ...segments].join("_");
  const cleaned = base.replace(/_{2,}/g, "_").replace(/^_+|_+$/g, "");
  return cleaned || `${method.toLowerCase()}_root`;
}

/**
 * Ensures a candidate name is unique within `taken` by appending a numeric
 * suffix. The original name is returned untouched when it is already free.
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

/**
 * Walks every operation in the document.
 *
 * Guarantees for consumers:
 *  - only real HTTP methods are yielded;
 *  - malformed path items and operations are skipped, never thrown on;
 *  - `operationId` is always a non-empty string and unique across the document.
 *
 * Non-fatal problems are appended to `issues` when the caller supplies an array.
 */
export function* iterateOperations(
  spec: Document | null | undefined,
  issues?: SpecWalkIssue[],
): Generator<ResolvedOperation> {
  if (!spec || !isPlainObject(spec.paths)) return;

  const usedIds = new Set<string>();

  for (const [pathTemplate, rawPathItem] of Object.entries(spec.paths)) {
    // Vendor extensions at the paths level must be ignored.
    if (pathTemplate.startsWith("x-")) continue;

    if (!isPlainObject(rawPathItem)) {
      issues?.push({
        path: pathTemplate,
        code: "invalid-path-item",
        message: "Path item is not an object and was skipped.",
      });
      continue;
    }
    if (isReference(rawPathItem)) {
      issues?.push({
        path: pathTemplate,
        code: "unresolved-ref",
        message: "Path item still contains an unresolved $ref and was skipped.",
      });
      continue;
    }

    const pathItem = rawPathItem as PathItemObject;

    for (const [key, rawOperation] of Object.entries(rawPathItem)) {
      const method = key.toLowerCase();
      if (!HTTP_METHOD_SET.has(method)) continue;

      if (!isPlainObject(rawOperation)) {
        issues?.push({
          path: pathTemplate,
          method,
          code: "invalid-operation",
          message: "Operation is not an object and was skipped.",
        });
        continue;
      }
      if (isReference(rawOperation)) {
        issues?.push({
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
        issues?.push({
          path: pathTemplate,
          method,
          code: "generated-operation-id",
          message: `Missing operationId; generated "${candidate}".`,
        });
      }

      const operationId = ensureUniqueName(candidate, usedIds);
      if (operationId !== candidate) {
        issues?.push({
          path: pathTemplate,
          method,
          code: "duplicate-operation-id",
          message: `Duplicate operationId "${candidate}"; renamed to "${operationId}".`,
        });
      }

      yield {
        path: pathTemplate,
        method: method as HttpMethod,
        operation,
        pathItem,
        operationId,
        operationIdGenerated: generated,
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

/**
 * Locates an operation by id.
 *
 * A declared id always wins, so a document that spells out `getUser` is never
 * shadowed by another operation whose synthesized id happens to collide. The
 * second pass matches the effective id produced by `iterateOperations`, which
 * covers both synthesized ids and the numeric suffixes added on collision —
 * these are exactly the names the tool generator exposes to clients.
 *
 * Returns null instead of throwing: an unknown id is a caller-level condition
 * (bad tool name), not a malformed document.
 *
 * Note this is a linear scan intended as a convenience for library consumers.
 * Runtime tool dispatch must go through `buildBindingIndex()` instead, which
 * gives O(1) lookup and carries the argument mapping.
 */
export function findOperationById(
  spec: Document | null | undefined,
  operationId: string,
): OperationEntry | null {
  const target = operationId.trim();
  if (!target) return null;

  const operations = listOperations(spec);

  for (const entry of operations) {
    if (declaredOperationId(entry) === target) return entry;
  }

  for (const entry of operations) {
    if (entry.operationId === target) return entry;
  }

  return null;
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
 * already de-duplicates via ensureUniqueName, so a duplicate id degrades the
 * tool names rather than breaking the server. Use this to warn the operator.
 */
export function findDuplicateOperationIds(
  spec: Document | null | undefined,
): DuplicateOperationId[] {
  const seen = new Map<string, Array<{ method: string; path: string }>>();

  for (const entry of iterateOperations(spec)) {
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
 * separate strict entry point so library consumers can choose between
 * failing fast at load time and merely surfacing a warning.
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
