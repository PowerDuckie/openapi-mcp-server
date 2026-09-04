
import axios, { AxiosError } from "axios";
import type { Document } from "@scalar/openapi-types/3.2";
import { findOperationById } from "./spec-utils";
import { buildRequest } from "./request-builder";
import type { ExecutionContext } from "../types";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CONTENT_BYTES = 10 * 1024 * 1024;
const MAX_RESULT_CHARS = 50_000;

export interface ToolCallResult {
  status: number;
  headers: Record<string, unknown>;
  data: unknown;
  truncated: boolean;
}

export async function executeToolCall(
  spec: Document,
  operationId: string,
  args: Record<string, unknown> | undefined,
  context: ExecutionContext = {},
): Promise<ToolCallResult> {
  const resolved = findOperationById(spec, operationId);
  if (!resolved) throw new Error(`Operation "${operationId}" was not found.`);

  const baseUrl = context.baseUrlOverride ?? spec.servers?.[0]?.url ?? "";
  if (!baseUrl) throw new Error("No upstream base URL is available.");

  const safeArgs = args ?? {};
  const { url, query, headers } = buildRequest(baseUrl, resolved.path, resolved.pathItem, resolved.operation, safeArgs);

  const body = safeArgs.body;
  const mergedHeaders: Record<string, string> = {
    ...context.upstreamHeaders,
    ...headers,
  };

  if (context.security?.bearerToken) {
    mergedHeaders.Authorization = `Bearer ${context.security.bearerToken}`;
  }
  if (context.security?.basicAuth) {
    const raw = `${context.security.basicAuth.username}:${context.security.basicAuth.password}`;
    mergedHeaders.Authorization = `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
  }
  for (const [name, value] of Object.entries(context.security?.apiKeys ?? {})) {
    if (!mergedHeaders[name]) mergedHeaders[name] = value;
  }

  if (body !== undefined && !mergedHeaders["Content-Type"]) {
    mergedHeaders["Content-Type"] = "application/json";
  }

  try {
    const response = await axios({
      method: resolved.method,
      url,
      params: query,
      data: body,
      headers: mergedHeaders,
      timeout: context.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxContentLength: MAX_CONTENT_BYTES,
      maxBodyLength: MAX_CONTENT_BYTES,
      validateStatus: () => true,
    });

    let data: unknown = response.data;
    let truncated = false;
    if (typeof data === "string" && data.length > MAX_RESULT_CHARS) {
      data = `${data.slice(0, MAX_RESULT_CHARS)}\n...[Response truncated]`;
      truncated = true;
    } else if (data && typeof data === "object") {
      const serialized = JSON.stringify(data);
      if (serialized.length > MAX_RESULT_CHARS) {
        data = `${serialized.slice(0, MAX_RESULT_CHARS)}\n...[Response truncated]`;
        truncated = true;
      }
    }

    return {
      status: response.status,
      headers: response.headers as Record<string, unknown>,
      data,
      truncated,
    };
  } catch (error) {
    const err = error as AxiosError;
    if (err.code === "ECONNABORTED") {
      throw new Error(`The upstream request timed out after ${context.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS}ms.`);
    }
    throw new Error(`Upstream request failed: ${err.message}`);
  }
}
