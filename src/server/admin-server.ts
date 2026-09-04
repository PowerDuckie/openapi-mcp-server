import express, { type Express, type RequestHandler } from "express";
import cors, { type CorsOptions } from "cors";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { parseSpecContent } from "../core/openapi-loader";
import { executeToolCall } from "../core/http-executor";
import { getGeneratedTools } from "../core/tool-generator";
import { generatePrompts } from "../registry/prompt-registry";
import { generateResources } from "../registry/resource-registry";
import { createAuthMiddleware } from "./auth";
import { loadState, saveState } from "../config/config-store";
import { attachMcpRoutes, type McpRouteHandle } from "../mcp/transport-http";
import { ServiceRegistry } from "../runtime/service-registry";
import type {
  AdminStatus,
  AppState,
  ExecutionContext,
  RequestLogEntry,
  ServerConfig,
  SpecSource,
} from "../types";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * The web UI ships next to the compiled output, but the exact depth differs
 * between a bundled build, a plain `tsc` build and a source-run via tsx. Probe
 * the known layouts once at module load instead of guessing at request time.
 */
const STATIC_DIR =
  [
    path.resolve(MODULE_DIR, "webui"),
    path.resolve(MODULE_DIR, "../webui"),
    path.resolve(MODULE_DIR, "../../webui"),
  ].find((candidate) => fs.existsSync(path.join(candidate, "index.html"))) ??
  path.resolve(MODULE_DIR, "webui");

const INDEX_HTML = path.join(STATIC_DIR, "index.html");

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const JSON_BODY_LIMIT = "20mb";
const DEFAULT_MAX_LOG_ENTRIES = 200;

/** Endpoint layout advertised to clients and rendered by the web UI. */
const ENDPOINTS = {
  streamableHttp: "/mcp",
  sse: "/sse",
  messages: "/mcp/messages",
  stdioSupported: true,
} as const;

interface ApplyResult {
  serviceId: string;
  toolCount: number;
  promptCount: number;
  resourceCount: number;
  degradedTools: string[];
  issues: string[];
}

/** Handle returned to the embedding process so it can shut everything down. */
export interface AdminServerHandle {
  app: Express;
  server: Server;
  /** Actual bound port, which differs from the request when port 0 is used. */
  port: number;
  /** Closes MCP sessions and the HTTP listener. Safe to call more than once. */
  close: () => Promise<void>;
}

/**
 * Express 5 widens route parameter values to `string | string[] | undefined`
 * because path-to-regexp v8 can emit repeated segments, and a RegExp route
 * anywhere in the app relaxes the inferred parameter map for the whole router.
 * Every parameter read must therefore be normalized rather than cast.
 */
function readParam(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(value)) {
    for (const candidate of value) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
  }
  return null;
}

function newLogId(): string {
  try {
    return randomUUID();
  } catch {
    return `log_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }
}

function looksLikeYamlName(name: string): boolean {
  return /\.ya?ml$/i.test(name);
}

/**
 * Decides which parser to try first. JSON is a subset of YAML in practice, so a
 * leading brace or bracket is a reliable JSON signal; everything else is tried
 * as YAML first and falls back automatically.
 */
function shouldParseAsYaml(raw: string, nameHint?: string): boolean {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return false;
  if (nameHint && looksLikeYamlName(nameHint)) return true;
  return true;
}

type ParsedSpec = Awaited<ReturnType<typeof parseSpecContent>>;

async function parseWithFallback(
  raw: string,
  preferYaml: boolean,
): Promise<{ spec: ParsedSpec; isYaml: boolean }> {
  try {
    return {
      spec: await parseSpecContent(raw, preferYaml),
      isYaml: preferYaml,
    };
  } catch (firstError) {
    try {
      return {
        spec: await parseSpecContent(raw, !preferYaml),
        isYaml: !preferYaml,
      };
    } catch {
      // Report the failure of the more likely format; the fallback error is
      // almost always a misleading syntax complaint about the wrong language.
      throw firstError;
    }
  }
}

/**
 * Derives a stable service id from the document identity so that reloading the
 * same specification keeps the id (and therefore the client-side bookmarks and
 * log correlation) intact across restarts.
 */
function computeServiceId(title: string, version: string): string {
  const digest = createHash("sha256")
    .update(`${title}\u0000${version}`)
    .digest("hex")
    .slice(0, 12);
  return `svc_${digest}`;
}

function buildCorsOptions(config: ServerConfig): CorsOptions {
  const allowed = config.allowedOrigins;
  // Default deny: the admin API can load specifications and issue upstream
  // calls, so it must never be reachable from an arbitrary origin by default.
  if (!allowed || allowed.length === 0) return { origin: false };
  if (allowed.includes("*")) return { origin: true, credentials: false };

  const allowSet = new Set(allowed);
  return {
    origin(origin, callback) {
      // A missing Origin header means a same-origin or non-browser client.
      if (!origin || allowSet.has(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
  };
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatIssue(issue: {
  method?: string | undefined;
  path: string;
  message: string;
}): string {
  const method = issue.method ? `${issue.method.toUpperCase()} ` : "";
  return `${method}${issue.path}: ${issue.message}`;
}

export async function startAdminServer(
  config: ServerConfig,
): Promise<AdminServerHandle> {
  const app = express();
  const auth: RequestHandler = createAuthMiddleware(config.apiKey);
  const registry = new ServiceRegistry();
  const persistEnabled = config.persistState !== false;
  const maxLogEntries = Math.max(
    20,
    config.maxLogEntries ?? DEFAULT_MAX_LOG_ENTRIES,
  );

  const state: AppState = {
    spec: null,
    baseUrlOverride: config.baseUrlOverride,
    specSource: config.specPath ? "startup-file" : "runtime",
  };

  const logEntries: RequestLogEntry[] = [];
  let activeServiceId: string | null = null;
  let activeSpecRawText = "";
  let activeSpecIsYaml = false;
  let closed = false;

  app.disable("x-powered-by");
  app.use(cors(buildCorsOptions(config)));

  // The Streamable HTTP transport consumes an already-parsed body, so the JSON
  // parser must run before the MCP routes are attached.
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  function addLog(entry: RequestLogEntry): void {
    logEntries.unshift({
      ...entry,
      serviceId: entry.serviceId ?? activeServiceId ?? undefined,
    });
    if (logEntries.length > maxLogEntries) {
      logEntries.length = maxLogEntries;
    }
  }

  function addInternalLog(
    event: string,
    success: boolean,
    serviceId?: string,
    extra?: Record<string, unknown>,
    error?: string,
  ): void {
    addLog({
      id: newLogId(),
      at: new Date().toISOString(),
      direction: "internal",
      protocol: undefined,
      success,
      serviceId,
      error,
      meta: { event, ...extra },
    });
  }

  function isActive(): boolean {
    if (!state.spec || !activeServiceId) return false;
    return registry.get(activeServiceId)?.status === "running";
  }

  function persist(rawSpecText: string | null, isYaml: boolean): void {
    if (!persistEnabled) return;
    try {
      saveState(
        {
          specRaw: rawSpecText ?? activeSpecRawText,
          specIsYaml: rawSpecText === null ? activeSpecIsYaml : isYaml,
          baseUrlOverride: state.baseUrlOverride,
        },
        config.stateFilePath,
      );
    } catch (error) {
      // Losing persistence degrades restart behaviour but must not fail the
      // request that triggered it.
      addInternalLog(
        "state-persist-failed",
        false,
        undefined,
        undefined,
        toMessage(error),
      );
    }
  }

  function applySpec(
    spec: ParsedSpec,
    rawText: string,
    isYaml: boolean,
    source: SpecSource,
    writeThrough = true,
  ): ApplyResult {
    // Generate before mutating state so a malformed document cannot leave the
    // server half-configured.
    const generated = getGeneratedTools(spec);
    const prompts = generatePrompts(spec);
    const resources = generateResources(spec);

    const previousServiceId = activeServiceId;

    state.spec = spec;
    state.specSource = source;
    activeSpecRawText = rawText;
    activeSpecIsYaml = isYaml;

    const title = spec.info?.title ?? "Untitled API";
    const version = spec.info?.version ?? "0.0.0";
    const serviceId = computeServiceId(title, version);
    const now = new Date().toISOString();
    const existing = registry.get(serviceId);

    registry.upsert({
      id: serviceId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      status: "running",
      title,
      version,
      source,
      toolCount: generated.tools.length,
      promptCount: prompts.length,
      resourceCount: resources.length,
      endpoint: { ...ENDPOINTS },
    });

    for (const service of registry.list()) {
      if (service.id !== serviceId) registry.remove(service.id);
    }

    activeServiceId = serviceId;
    if (writeThrough) persist(rawText, isYaml);

    // Existing sessions hold a server whose tool list came from the previous
    // document. MCP has no way to retroactively rewrite a peer's tool cache
    // reliably mid-session, so replacing the specification must drop them.
    if (previousServiceId && previousServiceId !== serviceId) {
      void closeSessions("specification-replaced");
    }

    addInternalLog("spec-applied", true, serviceId, {
      source,
      toolCount: generated.tools.length,
      promptCount: prompts.length,
      resourceCount: resources.length,
      degradedToolCount: generated.bindings.filter((b) => !b.fullySupported)
        .length,
    });

    return {
      serviceId,
      toolCount: generated.tools.length,
      promptCount: prompts.length,
      resourceCount: resources.length,
      degradedTools: generated.bindings
        .filter((binding) => !binding.fullySupported)
        .map((binding) => binding.toolName),
      issues: generated.issues.map(formatIssue),
    };
  }

  async function closeSessions(reason: string): Promise<void> {
    const before = mcp.activeSessionCount();
    if (before === 0) return;
    await mcp.closeAll();
    addInternalLog("sessions-closed", true, undefined, {
      reason,
      closed: before,
    });
  }

  function clearSpec(): void {
    state.spec = null;
    state.specSource = "runtime";
    activeSpecRawText = "";
    activeSpecIsYaml = false;
    activeServiceId = null;
    registry.clear();
    persist("", false);
    void closeSessions("specification-cleared");
    addInternalLog("spec-cleared", true);
  }

  async function bootstrap(): Promise<void> {
    if (config.specPath) {
      // A startup file is an operator-supplied invariant: failing loudly here is
      // correct, because silently starting with no tools looks like a bug.
      const raw = await fs.promises.readFile(config.specPath, "utf8");
      const parsed = await parseWithFallback(
        raw,
        shouldParseAsYaml(raw, config.specPath),
      );
      applySpec(parsed.spec, raw, parsed.isYaml, "startup-file", false);
      return;
    }

    if (!persistEnabled) return;

    let saved:
      | Awaited<ReturnType<typeof loadState>>
      | ReturnType<typeof loadState>;
    try {
      saved = loadState(config.stateFilePath);
    } catch (error) {
      addInternalLog(
        "state-load-failed",
        false,
        undefined,
        undefined,
        toMessage(error),
      );
      return;
    }

    if (typeof saved.baseUrlOverride === "string" && !state.baseUrlOverride) {
      state.baseUrlOverride = saved.baseUrlOverride;
    }

    if (typeof saved.specRaw === "string" && saved.specRaw.trim()) {
      try {
        const parsed = await parseWithFallback(
          saved.specRaw,
          Boolean(saved.specIsYaml),
        );
        applySpec(parsed.spec, saved.specRaw, parsed.isYaml, "runtime", false);
      } catch (error) {
        // A corrupt cache must never prevent the admin UI from starting, since
        // the UI is the only way for the operator to fix it.
        addInternalLog(
          "spec-restore-failed",
          false,
          undefined,
          undefined,
          `Persisted specification could not be restored: ${toMessage(error)}`,
        );
      }
    }
  }

  const contextProvider = (): ExecutionContext => ({
    baseUrlOverride: state.baseUrlOverride,
    upstreamHeaders: config.upstreamHeaders,
    requestTimeoutMs: config.requestTimeoutMs,
    onLog: addLog,
  });

  const mcp: McpRouteHandle = attachMcpRoutes(app, {
    specProvider: () => (isActive() ? state.spec : null),
    contextProvider,
    ...(config.apiKey ? { routeGuard: auth } : {}),
    ...(config.allowedOrigins?.length
      ? { allowedOrigins: config.allowedOrigins }
      : {}),
    onEvent(event) {
      //Parameter 'event' implicitly has an 'any' type.ts(7006)
      addInternalLog(event.type, event.type !== "session-error", undefined, {
        transport: event.kind,
        sessionId: event.sessionId,
        reason: event.reason,
      });
    },
  });

  await bootstrap();

  function buildStatus(): AdminStatus {
    const generated = state.spec
      ? getGeneratedTools(state.spec)
      : { tools: [], bindings: [], issues: [] };
    const prompts = state.spec ? generatePrompts(state.spec) : [];
    const resources = state.spec ? generateResources(state.spec) : [];

    return {
      specLoaded: Boolean(state.spec),
      specSource: state.specSource ?? null,
      serviceId: activeServiceId,
      active: isActive(),
      title: state.spec?.info?.title ?? null,
      version: state.spec?.info?.version ?? null,
      baseUrl: state.baseUrlOverride ?? state.spec?.servers?.[0]?.url ?? null,
      toolCount: generated.tools.length,
      degradedToolCount: generated.bindings.filter(
        (binding) => !binding.fullySupported,
      ).length,
      promptCount: prompts.length,
      resourceCount: resources.length,
      activeSessions: mcp.activeSessionCount(),
      services: registry.list(),
      issues: generated.issues.map(formatIssue),
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  });

  app.post(
    "/api/spec/upload",
    auth,
    upload.single("file"),
    async (request, response) => {
      try {
        if (!request.file) {
          response.status(400).json({ error: "No file was uploaded." });
          return;
        }
        const rawText = request.file.buffer.toString("utf8");
        if (!rawText.trim()) {
          response.status(400).json({ error: "The uploaded file is empty." });
          return;
        }
        const parsed = await parseWithFallback(
          rawText,
          shouldParseAsYaml(rawText, request.file.originalname),
        );
        const result = applySpec(parsed.spec, rawText, parsed.isYaml, "upload");
        response.json({ ok: true, result, ...buildStatus() });
      } catch (error) {
        response.status(400).json({ error: toMessage(error) });
      }
    },
  );

  app.post("/api/spec/paste", auth, async (request, response) => {
    try {
      const content = (request.body as { content?: unknown } | undefined)
        ?.content;
      if (typeof content !== "string" || !content.trim()) {
        response
          .status(400)
          .json({ error: "content must be a non-empty string." });
        return;
      }
      const isYamlHint = (request.body as { isYaml?: unknown }).isYaml;
      const preferYaml =
        typeof isYamlHint === "boolean"
          ? isYamlHint && shouldParseAsYaml(content)
          : shouldParseAsYaml(content);

      const parsed = await parseWithFallback(content, preferYaml);
      const result = applySpec(parsed.spec, content, parsed.isYaml, "paste");
      response.json({ ok: true, result, ...buildStatus() });
    } catch (error) {
      response.status(400).json({ error: toMessage(error) });
    }
  });

  app.post("/api/spec/clear", auth, (_request, response) => {
    clearSpec();
    response.json({ ok: true, ...buildStatus() });
  });

  /** Returns the raw document so the web UI can show and re-edit it. */
  app.get("/api/spec/raw", auth, (_request, response) => {
    response.json({
      content: activeSpecRawText,
      isYaml: activeSpecIsYaml,
      source: state.specSource ?? null,
    });
  });

  app.post("/api/config/base-url", auth, (request, response) => {
    const value = (request.body as { baseUrl?: unknown } | undefined)?.baseUrl;

    if (value === null || value === undefined || value === "") {
      state.baseUrlOverride = undefined;
      persist(null, false);
      addInternalLog("base-url-cleared", true);
      response.json({ ok: true, ...buildStatus() });
      return;
    }

    if (typeof value !== "string") {
      response.status(400).json({ error: "baseUrl must be a string or null." });
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(value);
    } catch {
      response.status(400).json({ error: "baseUrl is not a valid URL." });
      return;
    }

    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      response
        .status(400)
        .json({ error: "baseUrl must use the http or https scheme." });
      return;
    }

    state.baseUrlOverride = value;
    persist(null, false);
    addInternalLog("base-url-updated", true, undefined, { baseUrl: value });
    response.json({ ok: true, ...buildStatus() });
  });

  app.get("/api/status", auth, (_request, response) => {
    response.json(buildStatus());
  });

  app.get("/api/tools", auth, (_request, response) => {
    if (!state.spec) {
      response.json({ tools: [], bindings: [], issues: [] });
      return;
    }
    // The generated result is cached and shared; only derived copies are sent.
    const generated = getGeneratedTools(state.spec);
    response.json({
      tools: generated.tools,
      bindings: generated.bindings.map((binding) => ({
        toolName: binding.toolName,
        method: binding.method,
        isStandardMethod: binding.isStandardMethod,
        path: binding.path,
        bodyKey: binding.bodyKey,
        bodyMediaType: binding.bodyMediaType,
        bodyRequired: binding.bodyRequired,
        fullySupported: binding.fullySupported,
        degradationReasons: binding.degradationReasons,
        omittedParameters: binding.omittedParameters,
        arguments: binding.arguments.map((argument) => ({
          key: argument.key,
          name: argument.name,
          in: argument.in,
          required: argument.parameter.required,
        })),
      })),
      issues: generated.issues,
    });
  });

  app.get("/api/prompts", auth, (_request, response) => {
    response.json({ prompts: state.spec ? generatePrompts(state.spec) : [] });
  });

  app.get("/api/resources", auth, (_request, response) => {
    response.json({
      resources: state.spec ? generateResources(state.spec) : [],
    });
  });

  app.get("/api/servers", auth, (_request, response) => {
    response.json({
      services: registry.list(),
      active: isActive(),
      endpoints: { ...ENDPOINTS },
    });
  });

  /** Live transport sessions, used by the web UI to sniff active connections. */
  app.get("/api/sessions", auth, (_request, response) => {
    response.json({
      sessions: mcp.listSessions(),
      total: mcp.activeSessionCount(),
    });
  });

  app.delete("/api/sessions/:id", auth, async (request, response) => {
    const id = readParam(request.params.id);
    if (!id) {
      response.status(400).json({ error: "A session id is required." });
      return;
    }
    const removed = await mcp.closeSession(id, "closed-by-operator");
    if (!removed) {
      response.status(404).json({ error: "Session not found." });
      return;
    }
    response.json({ ok: true, sessions: mcp.listSessions() });
  });

  app.post("/api/servers/:id/start", auth, (request, response) => {
    const id = readParam(request.params.id);
    if (!id) {
      response.status(400).json({ error: "A service id is required." });
      return;
    }
    if (!registry.get(id)) {
      response.status(404).json({ error: "Service not found." });
      return;
    }
    if (!state.spec) {
      response
        .status(409)
        .json({ error: "No specification is loaded; nothing to start." });
      return;
    }

    registry.start(id);
    activeServiceId = id;
    addInternalLog("service-started", true, id);
    response.json({ ok: true, ...buildStatus() });
  });

  app.post("/api/servers/:id/stop", auth, async (request, response) => {
    const id = readParam(request.params.id);
    if (!id) {
      response.status(400).json({ error: "A service id is required." });
      return;
    }
    if (!registry.get(id)) {
      response.status(404).json({ error: "Service not found." });
      return;
    }

    registry.stop(id);
    // Stopping must terminate live sessions, otherwise a connected client keeps
    // issuing tool calls against a service the operator believes is down.
    await closeSessions("service-stopped");
    addInternalLog("service-stopped", true, id);
    response.json({ ok: true, ...buildStatus() });
  });

  app.get("/api/logs", auth, (request, response) => {
    const rawLimit = Number(request.query.limit);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.trunc(rawLimit), 1), maxLogEntries)
      : maxLogEntries;

    const direction = readParam(request.query.direction);
    const filtered = direction
      ? logEntries.filter((entry) => entry.direction === direction)
      : logEntries;

    response.json({
      logs: filtered.slice(0, limit),
      total: filtered.length,
      capacity: maxLogEntries,
    });
  });

  app.post("/api/logs/clear", auth, (_request, response) => {
    logEntries.length = 0;
    response.json({ ok: true, logs: [] });
  });

  app.post("/api/debug/call-tool", auth, async (request, response) => {
    if (!state.spec) {
      response.status(409).json({ error: "No specification is loaded." });
      return;
    }
    if (!isActive()) {
      response.status(409).json({ error: "The MCP service is not running." });
      return;
    }

    const body = (request.body ?? {}) as {
      toolName?: unknown;
      arguments?: unknown;
    };
    const toolName = body.toolName;
    const args = body.arguments;

    if (typeof toolName !== "string" || !toolName.trim()) {
      response
        .status(400)
        .json({ error: "toolName must be a non-empty string." });
      return;
    }
    if (
      args !== undefined &&
      (typeof args !== "object" || args === null || Array.isArray(args))
    ) {
      response
        .status(400)
        .json({ error: "arguments must be an object when provided." });
      return;
    }

    try {
      const result = await executeToolCall(
        state.spec,
        toolName.trim(),
        (args as Record<string, unknown> | undefined) ?? {},
        {
          ...contextProvider(),
          onLog(entry) {
            // A debug call does not travel over an MCP transport, so tagging it
            // with a protocol hint would misattribute it in the log viewer.
            addLog({ ...entry, protocol: undefined, meta: { debug: true } });
          },
        },
      );
      response.json({ ok: true, result });
    } catch (error) {
      response.status(400).json({ error: toMessage(error) });
    }
  });

  // Static assets are mounted after the API so that a file accidentally placed
  // in the web UI directory can never shadow an endpoint.
  app.use(
    express.static(STATIC_DIR, {
      index: false,
      dotfiles: "ignore",
      fallthrough: true,
    }),
  );

  // Single-page-app fallback. The negative lookahead must exclude every backend
  // prefix, including the legacy SSE endpoint, or those routes would receive
  // index.html instead of reaching their handlers.
  app.get(/^\/(?!api\/|mcp|sse).*/, (_request, response, next) => {
    response.sendFile(INDEX_HTML, (error) => {
      if (error) next(error);
    });
  });

  app.use((_request, response) => {
    response.status(404).json({ error: "Not found." });
  });

  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      const code = (error as { code?: string } | null)?.code;
      if (code === "LIMIT_FILE_SIZE") {
        response
          .status(413)
          .json({ error: "The uploaded file exceeds the size limit." });
        return;
      }
      if (code === "LIMIT_FILE_COUNT" || code === "LIMIT_UNEXPECTED_FILE") {
        response
          .status(400)
          .json({ error: 'Exactly one file field named "file" is expected.' });
        return;
      }
      console.error("[admin] Unhandled error:", error);
      if (response.headersSent) {
        response.end();
        return;
      }
      response.status(500).json({ error: "Internal server error." });
    },
  );

  const server = createServer(app);

  // Long-lived SSE and streaming responses must not be cut by the default
  // header/keep-alive timeouts.
  server.keepAliveTimeout = 76_000;
  server.headersTimeout = 80_000;
  server.requestTimeout = 0;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("listening", onListening);
    server.once("error", onError);
    server.listen(config.port, config.host ?? "127.0.0.1");
  });

  const address = server.address();
  const boundPort =
    address && typeof address === "object" ? address.port : config.port;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // Dispose first: it clears keep-alive timers and ends open streams, which
    // is what allows the HTTP server to actually finish closing.
    await mcp.dispose();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
    });
  };

  return { app, server, port: boundPort, close };
}
