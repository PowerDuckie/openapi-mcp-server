import type {
  GetPromptResult,
  Prompt,
  PromptArgument,
} from "@modelcontextprotocol/sdk/types.js";
import type { Document } from "@scalar/openapi-types/3.2";
import type { GeneratedPrompt } from "../types";
import {
  collectOperationParameters,
  iterateOperations,
} from "../core/spec-utils";

/** Upper bound for a generated prompt name, keeping client UIs readable. */
const MAX_PROMPT_NAME_LENGTH = 96;
/** Upper bound for generated descriptions. */
const MAX_DESCRIPTION_LENGTH = 400;
/** Upper bound for the serialized user-supplied arguments echoed into a message. */
const MAX_ARGS_TEXT_LENGTH = 4_000;
/** Defensive cap so a hostile or generated spec cannot exhaust memory. */
const MAX_OPERATIONS = 2_000;

type PromptBuilder = (args: Record<string, unknown>) => GetPromptResult;

interface PromptEntry {
  prompt: GeneratedPrompt;
  build: PromptBuilder;
}

interface PromptIndex {
  ordered: GeneratedPrompt[];
  byName: Map<string, PromptEntry>;
}

/**
 * Cache keyed by the parsed document instance. A new document object is produced
 * every time a specification is applied, so entries become collectable as soon
 * as the old specification is dropped.
 */
const indexCache = new WeakMap<Document, PromptIndex>();

/** Collapse arbitrary identifier text into a safe, stable prompt name segment. */
function sanitizeSegment(raw: string): string {
  const normalized = raw
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "operation";
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/** Build a description from optional spec text with a guaranteed fallback. */
function describe(primary: string | undefined, fallback: string): string {
  const candidate = typeof primary === "string" ? primary.trim() : "";
  return truncate(
    candidate.length > 0 ? candidate : fallback,
    MAX_DESCRIPTION_LENGTH,
  );
}

/**
 * Serialize caller-provided arguments defensively: circular structures, BigInt
 * values and oversized payloads must never crash or flood a prompt response.
 */
function safeSerializeArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "(none)";

  const seen = new WeakSet<object>();
  let serialized: string;
  try {
    serialized = JSON.stringify(
      args,
      (_key, value: unknown) => {
        if (typeof value === "bigint") return value.toString();
        if (typeof value === "function" || typeof value === "symbol") {
          return `[${typeof value}]`;
        }
        if (value && typeof value === "object") {
          if (seen.has(value as object)) return "[Circular]";
          seen.add(value as object);
        }
        return value;
      },
      2,
    );
  } catch {
    return `(unserializable arguments: ${keys.join(", ")})`;
  }

  if (typeof serialized !== "string") return "(none)";
  return truncate(serialized, MAX_ARGS_TEXT_LENGTH);
}

function userMessage(text: string): GetPromptResult["messages"][number] {
  return { role: "user", content: { type: "text", text } };
}

function makeResult(description: string, text: string): GetPromptResult {
  return { description, messages: [userMessage(text)] };
}

/** Reduce spec parameters to unique, well-formed MCP prompt arguments. */
function toPromptArguments(
  parameters: ReturnType<typeof collectOperationParameters>,
): PromptArgument[] {
  const result: PromptArgument[] = [];
  const used = new Set<string>();

  for (const parameter of parameters) {
    const rawName =
      typeof parameter.name === "string" ? parameter.name.trim() : "";
    if (!rawName) continue;

    // Prompt argument names must be unique; disambiguate by location on clash.
    let name = rawName;
    if (used.has(name)) {
      const location = typeof parameter.in === "string" ? parameter.in : "arg";
      name = `${rawName}_${location}`;
      let suffix = 2;
      while (used.has(name)) {
        name = `${rawName}_${location}_${suffix}`;
        suffix += 1;
      }
    }
    used.add(name);

    result.push({
      name,
      description: describe(
        parameter.description,
        `Input for the ${parameter.in ?? "unknown"} parameter "${rawName}".`,
      ),
      // Sample generation must never hard-fail on a missing hint.
      required: false,
    });
  }

  return result;
}

function buildIndex(spec: Document): PromptIndex {
  const ordered: GeneratedPrompt[] = [];
  const byName = new Map<string, PromptEntry>();

  const title = spec.info?.title?.trim() || "Untitled API";
  const version = spec.info?.version?.trim() || "unknown";

  const register = (prompt: Prompt, build: PromptBuilder): void => {
    const generated = prompt as GeneratedPrompt;
    // First registration wins so global prompts cannot be shadowed by a spec.
    if (byName.has(generated.name)) return;
    byName.set(generated.name, { prompt: generated, build });
    ordered.push(generated);
  };

  // Collect operations once; every prompt below reuses this snapshot.
  const operations: Array<{
    path: string;
    method: string;
    operationId: string;
    summary: string;
    description: string | undefined;
    deprecated: boolean;
    args: PromptArgument[];
    parameterHints: string;
  }> = [];

  let truncatedOperations = false;
  for (const entry of iterateOperations(spec)) {
    if (operations.length >= MAX_OPERATIONS) {
      truncatedOperations = true;
      break;
    }
    const method = String(entry.method ?? "get").toUpperCase();
    const parameters = collectOperationParameters(
      entry.pathItem,
      entry.operation,
    );
    const args = toPromptArguments(parameters);
    operations.push({
      path: entry.path,
      method,
      operationId: entry.operationId,
      summary: entry.operation.summary?.trim() || `${method} ${entry.path}`,
      description: entry.operation.description,
      deprecated: entry.operation.deprecated === true,
      args,
      parameterHints:
        parameters.length > 0
          ? parameters
              .map(
                (parameter) =>
                  `- ${parameter.name} (${parameter.in}${parameter.required ? ", required" : ""})`,
              )
              .join("\n")
          : "- (this operation declares no parameters)",
    });
  }

  register(
    {
      name: "spec_overview",
      description: `Summarize the scope, conventions and major capabilities of "${truncate(title, 60)}".`,
      arguments: [],
    },
    () =>
      makeResult(
        "High-level orientation for the loaded API specification.",
        [
          `Summarize the API "${title}" (version "${version}").`,
          `It exposes ${operations.length} callable operation(s)${truncatedOperations ? " (list truncated for size)" : ""}.`,
          "Cover: authentication requirements, the main resource groups, naming conventions,",
          "pagination style, and any caveats a client should know before integrating.",
        ].join("\n"),
      ),
  );

  register(
    {
      name: "integration_guardrails",
      description: "Describe how to call this API safely and incrementally.",
      arguments: [],
    },
    () =>
      makeResult(
        "Conservative integration guidance for the loaded API specification.",
        [
          `Provide conservative integration guidance for "${title}" (version "${version}").`,
          "Address: retry and backoff policy, idempotency of mutating calls, pagination expectations,",
          "rate-limit handling, error-response interpretation, and data-safety or PII considerations.",
          "Prefer read-only verification steps before recommending any destructive call.",
        ].join("\n"),
      ),
  );

  const usedOperationSlugs = new Set<string>();

  for (const operation of operations) {
    // Ensure a stable, collision-free, protocol-safe slug per operation.
    let slug = truncate(
      sanitizeSegment(operation.operationId),
      MAX_PROMPT_NAME_LENGTH - 12,
    ).replace(/…$/, "");
    if (usedOperationSlugs.has(slug)) {
      let suffix = 2;
      while (usedOperationSlugs.has(`${slug}_${suffix}`)) suffix += 1;
      slug = `${slug}_${suffix}`;
    }
    usedOperationSlugs.add(slug);

    const label = `${operation.method} ${operation.path}`;
    const deprecationNote = operation.deprecated
      ? "\nNote: this operation is marked deprecated in the specification; mention safer alternatives if any exist."
      : "";

    register(
      {
        name: `explain_${slug}`,
        description: describe(
          operation.description,
          `Explain how to use ${label}.`,
        ),
        arguments: [],
      },
      () =>
        makeResult(
          `Explanation of ${label}.`,
          [
            `Explain the operation "${operation.operationId}" (${label}).`,
            `Summary: ${operation.summary}`,
            "Describe required inputs, optional inputs, request body rules, authentication needs,",
            "and the likely success and error response shapes.",
            "Parameters:",
            operation.parameterHints,
          ].join("\n") + deprecationNote,
        ),
    );

    register(
      {
        name: `plan_${slug}`,
        description: `Create an execution plan for ${label}.`,
        arguments: [],
      },
      () =>
        makeResult(
          `Execution plan for ${label}.`,
          [
            `Create a step-by-step execution plan for "${operation.operationId}" (${label}).`,
            "List every required parameter, any preconditions or prerequisite calls,",
            "the exact call to make, and how to validate the response before proceeding.",
            "Parameters:",
            operation.parameterHints,
          ].join("\n") + deprecationNote,
        ),
    );

    register(
      {
        name: `sample_${slug}`,
        description: `Generate realistic sample arguments for ${label}.`,
        arguments: operation.args,
      },
      (args) =>
        makeResult(
          `Sample arguments for ${label}.`,
          [
            `Generate realistic sample arguments for "${operation.operationId}" (${label}).`,
            "Use production-like placeholders that satisfy the declared types and formats.",
            "Do not invent real credentials, tokens, or personal data.",
            "Parameters:",
            operation.parameterHints,
            "Values already provided by the caller:",
            safeSerializeArgs(args),
          ].join("\n"),
        ),
    );
  }

  return { ordered, byName };
}

function getIndex(spec: Document): PromptIndex {
  const cached = indexCache.get(spec);
  if (cached) return cached;
  const built = buildIndex(spec);
  indexCache.set(spec, built);
  return built;
}

/** List every prompt exposed for the given specification. */
export function generatePrompts(spec: Document): GeneratedPrompt[] {
  // Return a shallow copy so callers cannot mutate the cached registry.
  return getIndex(spec).ordered.slice();
}

/** Report whether a prompt name is served by this specification. */
export function hasPrompt(spec: Document, name: string): boolean {
  return getIndex(spec).byName.has(name);
}

/**
 * Resolve a prompt by name. Returns null when the prompt is unknown so the
 * transport layer can answer with the correct JSON-RPC error.
 */
export function resolvePrompt(
  spec: Document,
  name: string,
  args: Record<string, unknown> = {},
): GetPromptResult | null {
  if (typeof name !== "string" || name.length === 0) return null;

  const entry = getIndex(spec).byName.get(name);
  if (!entry) return null;

  const safeArgs =
    args && typeof args === "object" && !Array.isArray(args) ? args : {};

  try {
    return entry.build(safeArgs);
  } catch (error) {
    // A malformed spec fragment must degrade to a usable prompt, not a crash.
    const message = error instanceof Error ? error.message : String(error);
    return makeResult(
      entry.prompt.description ?? name,
      `The prompt "${name}" could not be fully rendered from the specification (${message}). Explain what you can from the surrounding API context.`,
    );
  }
}
