import type {
  OperationObject,
  PathItemObject,
} from "@scalar/openapi-types/3.2";
import {
  collectOperationParameters,
  effectiveExplode,
  effectiveStyle,
  type NormalizedParameter,
} from "./spec-utils";
import type { ArgumentBinding, ToolBinding } from "./tool-generator";

/**
 * Headers whose value is owned by the transport or the HTTP layer itself. A
 * document is free to declare them as parameters, but honouring that would let a
 * model rewrite the authenticated identity, break the framing of the request, or
 * defeat the executor's content negotiation, so they are dropped here as a second
 * line of defence behind the generator's `reserved` flag.
 */
const RESERVED_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "expect",
  "authorization",
  "proxy-authorization",
  "proxy-connection",
  "accept-encoding",
  "cookie",
]);

/** A parameter or argument that was deliberately not sent, with the reason. */
export interface DroppedArgument {
  key: string;
  reason: string;
}

export interface BuiltRequest {
  /**
   * Absolute URL without a query string. The query is kept separate so the
   * executor can log it in a structured form and so encoding happens exactly
   * once, inside `query`.
   */
  url: string;
  /**
   * Fully-formed query parameters. `URLSearchParams` is the only shape that can
   * represent the repeated keys produced by an exploded array — the default for
   * query parameters — and it applies percent-encoding once on `toString()`.
   */
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
  /** Reported so the executor can surface silently ignored arguments in a log. */
  dropped: DroppedArgument[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Renders a scalar the way a URL expects it.
 *
 * `JSON.stringify` is deliberately not used as a fallback: a nested value that
 * reaches here means the style rules could not describe it, and emitting a JSON
 * blob would produce a request the upstream cannot parse while looking like it
 * worked. The caller is responsible for rejecting such values instead.
 */
function renderScalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  // Dates are common in hand-written arguments and have an unambiguous wire form.
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Percent-encodes one *component* of a path parameter.
 *
 * Encoding must happen per element, never on the assembled string: the commas,
 * dots and semicolons that separate elements are structural, and encoding them
 * would turn `a,b` into a single value containing a literal comma.
 */
function encodeComponent(value: string): string {
  return encodeURIComponent(value);
}

/** True when a value carries nothing that can be serialized into a request. */
function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/**
 * Serializes a path parameter according to `style` and `explode`.
 *
 * The returned string replaces the whole `{name}` placeholder, including the
 * leading `.` or `;` that the label and matrix styles introduce — those styles
 * own their entire path segment.
 */
function serializePathParameter(
  name: string,
  value: unknown,
  style: string,
  explode: boolean,
): string {
  const encodedName = encodeComponent(name);

  if (Array.isArray(value)) {
    const parts = value
      .filter((entry) => entry !== undefined && entry !== null)
      .map((entry) => encodeComponent(renderScalar(entry)));

    switch (style) {
      case "label":
        return explode ? `.${parts.join(".")}` : `.${parts.join(",")}`;
      case "matrix":
        return explode
          ? parts.map((part) => `;${encodedName}=${part}`).join("")
          : `;${encodedName}=${parts.join(",")}`;
      default:
        return parts.join(",");
    }
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(
      ([, entryValue]) => entryValue !== undefined && entryValue !== null,
    );
    const flat = entries.flatMap(([key, entryValue]) => [
      encodeComponent(key),
      encodeComponent(renderScalar(entryValue)),
    ]);
    const pairs = entries.map(
      ([key, entryValue]) =>
        `${encodeComponent(key)}=${encodeComponent(renderScalar(entryValue))}`,
    );

    switch (style) {
      case "label":
        return explode ? `.${pairs.join(".")}` : `.${flat.join(",")}`;
      case "matrix":
        // An exploded matrix object drops the parameter name: each property
        // becomes its own matrix segment.
        return explode
          ? `;${pairs.join(";")}`
          : `;${encodedName}=${flat.join(",")}`;
      default:
        return explode ? pairs.join(",") : flat.join(",");
    }
  }

  const scalar = encodeComponent(renderScalar(value));
  switch (style) {
    case "label":
      return `.${scalar}`;
    case "matrix":
      return `;${encodedName}=${scalar}`;
    default:
      return scalar;
  }
}

/**
 * Serializes a query parameter into name/value pairs.
 *
 * Pairs are returned undecoded; `URLSearchParams` performs the single encoding
 * pass. Returning a list rather than a string is what makes the exploded forms
 * expressible at all, since they emit the same key more than once.
 */
function serializeQueryParameter(
  name: string,
  value: unknown,
  style: string,
  explode: boolean,
): Array<[string, string]> {
  if (Array.isArray(value)) {
    const parts = value
      .filter((entry) => entry !== undefined && entry !== null)
      .map((entry) => renderScalar(entry));

    // An empty exploded array has no representation at all; emitting `name=`
    // would assert an empty-string element that the caller never supplied.
    if (parts.length === 0) return explode ? [] : [[name, ""]];

    if (explode) return parts.map((part) => [name, part]);
    if (style === "spaceDelimited") return [[name, parts.join(" ")]];
    if (style === "pipeDelimited") return [[name, parts.join("|")]];
    return [[name, parts.join(",")]];
  }

  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(
      ([, entryValue]) => entryValue !== undefined && entryValue !== null,
    );

    if (style === "deepObject") {
      return entries.map(([key, entryValue]) => {
        // Nested containers have no defined deepObject form. Rendering the
        // scalar keeps the failure visible upstream rather than inventing a
        // bracket syntax no server is required to understand.
        return [`${name}[${key}]`, renderScalar(entryValue)] as [
          string,
          string,
        ];
      });
    }

    if (explode) {
      // An exploded form object drops the parameter name entirely.
      return entries.map(
        ([key, entryValue]) =>
          [key, renderScalar(entryValue)] as [string, string],
      );
    }

    const flat = entries.flatMap(([key, entryValue]) => [
      key,
      renderScalar(entryValue),
    ]);
    return [[name, flat.join(",")]];
  }

  return [[name, renderScalar(value)]];
}

/**
 * Serializes a header parameter, which is always `simple` style.
 *
 * Header values are not percent-encoded — that is a URL concept — so the only
 * transformation applied is the structural one.
 */
function serializeHeaderParameter(value: unknown, explode: boolean): string {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => entry !== undefined && entry !== null)
      .map((entry) => renderScalar(entry))
      .join(",");
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(
      ([, entryValue]) => entryValue !== undefined && entryValue !== null,
    );
    return explode
      ? entries.map(([key, v]) => `${key}=${renderScalar(v)}`).join(",")
      : entries.flatMap(([key, v]) => [key, renderScalar(v)]).join(",");
  }
  return renderScalar(value);
}

/**
 * Rejects a header value that could alter the framing of the request.
 *
 * Values here originate from model-supplied arguments, so a CR or LF would be a
 * textbook header-injection vector: it can append arbitrary headers or an entire
 * second request. Control characters are refused outright rather than stripped,
 * because silently mutating a credential-bearing value is worse than failing.
 */
function assertSafeHeaderValue(name: string, value: string): void {
  if (/[\r\n\u0000]/.test(value)) {
    throw new Error(
      `Header parameter "${name}" contains a control character and was rejected.`,
    );
  }
}

function isValidHeaderName(name: string): boolean {
  // RFC 7230 token.
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);
}

export function buildRequest(
  baseUrl: string,
  templatePath: string,
  pathItem: PathItemObject,
  operation: OperationObject,
  args: Record<string, unknown>,
  binding?: ToolBinding,
): BuiltRequest {
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid upstream base URL: "${baseUrl}".`);
  }

  if (
    parsedBaseUrl.protocol !== "http:" &&
    parsedBaseUrl.protocol !== "https:"
  ) {
    throw new Error(
      `Unsupported upstream base URL protocol: "${parsedBaseUrl.protocol}". Only http and https are allowed.`,
    );
  }

  // A server URL that still carries template variables was never resolved
  // against `servers[].variables`; sending it verbatim would request a literal
  // brace-containing host or path.
  if (
    /\{[^}]+\}/.test(parsedBaseUrl.pathname) ||
    /\{/.test(parsedBaseUrl.host)
  ) {
    throw new Error(
      `The upstream base URL "${baseUrl}" still contains unresolved server variables.`,
    );
  }

  const query = new URLSearchParams();
  // Query parameters written into the server URL are part of the upstream
  // contract, so they are preserved instead of being lost when the path is
  // appended.
  for (const [key, value] of parsedBaseUrl.searchParams.entries()) {
    query.append(key, value);
  }

  // Resolving the parameter list is a document-wide walk. When a binding exists
  // it already carries every exposed parameter, so the walk is skipped entirely
  // on the hot path.
  const parameters: NormalizedParameter[] = binding
    ? []
    : collectOperationParameters(pathItem, operation, []);

  const bindingMap = new Map<string, ArgumentBinding>(
    binding?.arguments.map((item) => [item.key, item]) ?? [],
  );

  let path = templatePath;
  const headers: Record<string, string> = {};
  const cookies: string[] = [];
  const dropped: DroppedArgument[] = [];

  const bodyKey = binding ? binding.bodyKey : "body" in args ? "body" : null;

  for (const [key, value] of Object.entries(args)) {
    if (bodyKey !== null && key === bodyKey) continue;

    const bound = bindingMap.get(key);
    const parameter =
      bound?.parameter ?? parameters.find((item) => item.name === key);

    // With a binding present, anything unrecognised is not part of the declared
    // operation. Falling through to the query string would let a caller inject
    // arbitrary parameters into the upstream request, which matters because
    // degraded tools expose `additionalProperties: true`.
    if (!bound && !parameter) {
      dropped.push({
        key,
        reason: "Not a declared parameter of this operation.",
      });
      continue;
    }

    const location = bound?.in ?? parameter?.in ?? "query";
    const targetName = bound?.name ?? parameter?.name ?? key;
    const style = parameter
      ? effectiveStyle(parameter)
      : location === "path" || location === "header"
        ? "simple"
        : "form";
    const explode = parameter ? effectiveExplode(parameter) : style === "form";

    if (location === "path") {
      const placeholder = `{${targetName}}`;
      if (!path.includes(placeholder)) {
        dropped.push({
          key,
          reason: `No "${placeholder}" placeholder exists in the path template.`,
        });
        continue;
      }
      // An empty path parameter would silently address a different resource —
      // `/pets/{id}` collapsing to `/pets/` hits the collection endpoint — so it
      // is treated as a missing argument rather than substituted.
      if (isEmptyValue(value) || (Array.isArray(value) && value.length === 0)) {
        throw new Error(
          `Path parameter "${targetName}" requires a non-empty value.`,
        );
      }
      path = path
        .split(placeholder)
        .join(serializePathParameter(targetName, value, style, explode));
      continue;
    }

    // Beyond the path, an absent value means "do not send this parameter".
    // `allowEmptyValue` is the one case where an explicit empty string is
    // meaningful, and it applies to query parameters only.
    if (value === undefined || value === null) continue;
    if (
      value === "" &&
      !(location === "query" && parameter?.allowEmptyValue === true)
    ) {
      continue;
    }

    if (location === "header") {
      if (RESERVED_HEADERS.has(targetName.toLowerCase())) {
        dropped.push({
          key,
          reason: `Header "${targetName}" is managed by the transport layer.`,
        });
        continue;
      }
      if (!isValidHeaderName(targetName)) {
        dropped.push({
          key,
          reason: `"${targetName}" is not a valid header name.`,
        });
        continue;
      }
      const rendered = serializeHeaderParameter(value, explode);
      assertSafeHeaderValue(targetName, rendered);
      headers[targetName] = rendered;
      continue;
    }

    if (location === "cookie") {
      // Cookie parameters use `form` style; an exploded object becomes one
      // cookie per property.
      if (isPlainObject(value) && explode) {
        for (const [cookieKey, cookieValue] of Object.entries(value)) {
          if (cookieValue === undefined || cookieValue === null) continue;
          cookies.push(
            `${cookieKey}=${encodeComponent(renderScalar(cookieValue))}`,
          );
        }
        continue;
      }
      if (Array.isArray(value) && explode) {
        for (const entry of value) {
          if (entry === undefined || entry === null) continue;
          cookies.push(`${targetName}=${encodeComponent(renderScalar(entry))}`);
        }
        continue;
      }
      for (const [, cookieValue] of serializeQueryParameter(
        targetName,
        value,
        "form",
        false,
      )) {
        cookies.push(`${targetName}=${encodeComponent(cookieValue)}`);
      }
      continue;
    }

    // deepObject is defined for objects only; anything else has no encoding and
    // must not be guessed at.
    if (style === "deepObject" && !isPlainObject(value)) {
      throw new Error(
        `Parameter "${targetName}" uses style "deepObject", which requires an object value.`,
      );
    }

    for (const [pairName, pairValue] of serializeQueryParameter(
      targetName,
      value,
      style,
      explode,
    )) {
      query.append(pairName, pairValue);
    }
  }

  const unresolved = path.match(/\{[^}]+\}/g);
  if (unresolved?.length) {
    throw new Error(
      `Missing required path parameters: ${unresolved.join(", ")}.`,
    );
  }

  if (cookies.length > 0) {
    const cookieHeader = cookies.join("; ");
    assertSafeHeaderValue("Cookie", cookieHeader);
    headers.Cookie = cookieHeader;
  }

  const body = bodyKey !== null ? args[bodyKey] : undefined;

  // Join on origin plus pathname so a query string or fragment on the server URL
  // cannot end up in the middle of the final path.
  const basePath = parsedBaseUrl.pathname.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;

  return {
    url: `${parsedBaseUrl.origin}${basePath}${suffix}`,
    query,
    headers,
    body,
    dropped,
  };
}
