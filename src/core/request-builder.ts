
import type { OperationObject, ParameterObject } from "@scalar/openapi-types/3.2";
import { collectOperationParameters } from "./spec-utils";
import type { PathItemObject } from "@scalar/openapi-types/3.2";

function serializeValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(serializeValue).join(",");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export interface BuiltRequest {
  url: string;
  query: Record<string, string>;
  headers: Record<string, string>;
}

export function buildRequest(
  baseUrl: string,
  templatePath: string,
  pathItem: PathItemObject,
  operation: OperationObject,
  args: Record<string, unknown>,
): BuiltRequest {
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error(`Invalid upstream base URL: "${baseUrl}".`);
  }

  const parameters = collectOperationParameters(pathItem, operation);
  const locationMap = new Map<string, ParameterObject["in"]>();
  for (const parameter of parameters) {
    locationMap.set(parameter.name, parameter.in);
  }

  let path = templatePath;
  const query: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const cookies: string[] = [];

  for (const [key, value] of Object.entries(args)) {
    if (key === "body") continue;
    const location = locationMap.get(key);

    if (location === "path" || (!location && path.includes(`{${key}}`))) {
      path = path.replace(`{${key}}`, encodeURIComponent(serializeValue(value)));
      continue;
    }
    if (location === "header") {
      headers[key] = serializeValue(value);
      continue;
    }
    if (location === "cookie") {
      cookies.push(`${encodeURIComponent(key)}=${encodeURIComponent(serializeValue(value))}`);
      continue;
    }
    query[key] = serializeValue(value);
  }

  const missing = path.match(/\{[^}]+\}/g);
  if (missing?.length) {
    throw new Error(`Missing required path parameters: ${missing.join(", ")}.`);
  }

  if (cookies.length > 0) {
    headers.Cookie = cookies.join("; ");
  }

  return {
    url: `${baseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`,
    query,
    headers,
  };
}
