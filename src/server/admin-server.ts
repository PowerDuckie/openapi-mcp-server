// src/server/admin-server.ts
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
import {
  clearState,
  loadState,
  saveState,
  type SaveResult,
} from "../config/config-store";
import {
  attachMcpRoutes,
  MCP_ROUTES,
  type McpRouteHandle,
} from "../mcp/transport-http";
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
/** Coalescing window for state writes, since each one re-serialises the spec. */
const PERSIST_DEBOUNCE_MS = 250;
/**
 * Bounded receive window. Zero would disable it entirely, which only helps a
 * slowloris: requestTimeout limits how long a client may take to *send* a
 * request and has nothing to do with how long a streaming response may live.
 */
const REQUEST_TIMEOUT_MS = 300_000;

/** Endpoint layout advertised to clients and rendered by the web UI. */
const ENDPOINTS = {
  streamableHttp: MCP_ROUTES.streamableHttp,
  sse: MCP_ROUTES.sse,
  messages: MCP_ROUTES.messages,
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

/**
 * Removes a UTF-8 byte order mark.
 *
 * Editors on Windows routinely emit one. JSON.parse rejects it outright, and
 * because trimStart() does not treat it as whitespace the format sniffer below
 * would also misread the document as YAML — producing a syntax error that says
 * nothing about the real cause.
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Decides which parser to try first.
 *
 * A leading brace or bracket is a reliable JSON signal. Everything else,
 * including a `.yaml` filename, is tried as YAML first — and since YAML is a
 * superset of JSON in practice, guessing wrong is recoverable via the fallback.
 */
function shouldParseAsYaml(raw: string): boolean {
  const trimmed = stripBom(raw).trimStart();
  return !(trimmed.startsWith("{") || trimmed.startsWith("["));
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
 * Derives the service id from the document *contents*, not just its identity.
 *
 * Hashing title+version alone looked attractive for keeping ids stable across
 * reloads, but developers iterate on a specification without ever bumping
 * info.version. That made a materially different document report the same id,
 * which in turn skipped the session invalidation below — leaving connected
 * clients calling tools that no longer exist. Two unrelated documents both
 * titled "API 1.0.0" collided for the same reason.
 */
function computeServiceId(
  title: string,
  version: string,
  rawText: string,
): string {
  const digest = createHash("sha256")
    .update(`${title}\u0000${version}\u0000${rawText}`)
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

/**
 * Memoises prompt and resource generation per document.
 *
 * Unlike getGeneratedTools these registries have no cache of their own, and
 * buildStatus runs on every mutating endpoint plus a three-second poll from the
 * web UI. Regenerating them each time burns CPU on the single event-loop thread
 * for a result that cannot change while the document is identical.
 */
const promptCache = new WeakMap<object, ReturnType<typeof generatePrompts>>();
const resourceCache = new WeakMap<
  object,
  ReturnType<typeof generateResources>
>();

function cachedPrompts(spec: ParsedSpec): ReturnType<typeof generatePrompts> {
  const key = spec as unknown as object;
  const hit = promptCache.get(key);
  if (hit) return hit;
  const value = generatePrompts(spec);
  promptCache.set(key, value);
  return value;
}

function cachedResources(
  spec: ParsedSpec,
): ReturnType<typeof generateResources> {
  const key = spec as unknown as object;
  const hit = resourceCache.get(key);
  if (hit) return hit;
  const value = generateResources(spec);
  resourceCache.set(key, value);
  return value;
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

  /* ---------------------------------------------------------------------- */
  /* Logging                                                                */
  /* ---------------------------------------------------------------------- */

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

  /* ---------------------------------------------------------------------- */
  /* MCP transports                                                         */
  /* ---------------------------------------------------------------------- */

  const contextProvider = (): ExecutionContext => ({
    baseUrlOverride: state.baseUrlOverride,
    upstreamHeaders: config.upstreamHeaders,
    requestTimeoutMs: config.requestTimeoutMs,
    onLog: addLog,
  });

  /**
   * Attached before applySpec/clearSpec are ever invoked.
   *
   * Those helpers are hoisted function declarations that close over `mcp`, so
   * calling one before this line would throw a TDZ ReferenceError far from its
   * actual cause. Keeping the binding above every call site removes the hazard
   * instead of relying on statement order further down.
   */
  const mcp: McpRouteHandle = attachMcpRoutes(app, {
    specProvider: () => (isActive() ? state.spec : null),
    contextProvider,
    ...(config.apiKey ? { routeGuard: auth } : {}),
    ...(config.allowedOrigins?.length
      ? { allowedOrigins: config.allowedOrigins }
      : {}),
    ...(config.allowedHosts?.length
      ? { allowedHosts: config.allowedHosts }
      : {}),
    onEvent(event) {
      addInternalLog(
        event.type,
        event.type !== "session-error",
        undefined,
        // Spread conditionally: several event types genuinely carry no session
        // id or reason, and writing explicit undefined into the log record made
        // the viewer render empty fields for every rejection.
        {
          transport: event.kind,
          ...(event.sessionId ? { sessionId: event.sessionId } : {}),
          ...(event.reason ? { reason: event.reason } : {}),
        },
      );
    },
  });

  async function closeSessions(reason: string): Promise<void> {
    const before = mcp.activeSessionCount();
    if (before === 0) return;
    await mcp.closeAll();
    addInternalLog("sessions-closed", true, undefined, {
      reason,
      closed: before,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Persistence                                                            */
  /* ---------------------------------------------------------------------- */

  let persistTimer: NodeJS.Timeout | undefined;
  let persistPending: { specRaw: string | null; specIsYaml: boolean } | null =
    null;

  function flushState(): void {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = undefined;
    }
    const payload = persistPending;
    persistPending = null;
    if (!payload) return;

    let result: SaveResult;
    try {
      result = saveState(
        {
          // Explicit null rather than undefined: JSON.stringify drops undefined
          // keys, making "no specification" indistinguishable from a truncated
          // state file on the next read.
          specRaw: payload.specRaw,
          specIsYaml: payload.specIsYaml,
          baseUrlOverride: state.baseUrlOverride ?? null,
        },
        config.stateFilePath,
      );
    } catch (error) {
      // saveState reports its own I/O failures through the return value, so
      // reaching here means the payload itself could not be serialised.
      addInternalLog(
        "state-persist-failed",
        false,
        undefined,
        undefined,
        toMessage(error),
      );
      return;
    }

    // saveState swallows I/O errors by design. Without inspecting `ok` a
    // read-only disk produced a silent no-op while the web UI still reported a
    // successful save, and the operator only found out after a restart.
    if (!result.ok) {
      addInternalLog(
        "state-persist-failed",
        false,
        undefined,
        undefined,
        `${result.path}: ${result.error?.message ?? "unknown error"}`,
      );
      return;
    }

    addInternalLog("state-persisted", true, undefined, { path: result.path });
  }

  /**
   * Queues a state write.
   *
   * Coalesced because every write re-serialises the whole specification and
   * fsyncs it. A multi-megabyte document made each base-URL edit a synchronous,
   * event-loop-blocking flush of data that had not changed.
   */
  function queueState(specRaw: string | null, specIsYaml: boolean): void {
    if (!persistEnabled) return;
    persistPending = { specRaw, specIsYaml };
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = undefined;
      flushState();
    }, PERSIST_DEBOUNCE_MS);
    persistTimer.unref?.();
  }

  /** Persists a newly applied document. */
  function persistSpec(rawText: string, isYaml: boolean): void {
    queueState(rawText, isYaml);
  }

  /** Persists configuration changes without disturbing the stored document. */
  function persistConfig(): void {
    queueState(activeSpecRawText || null, activeSpecIsYaml);
  }

  /* ---------------------------------------------------------------------- */
  /* Specification lifecycle                                                */
  /* ---------------------------------------------------------------------- */

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
    const prompts = cachedPrompts(spec);
    const resources = cachedResources(spec);

    const previousServiceId = activeServiceId;

    state.spec = spec;
    state.specSource = source;
    activeSpecRawText = rawText;
    activeSpecIsYaml = isYaml;

    const title = spec.info?.title ?? "Untitled API";
    const version = spec.info?.version ?? "0.0.0";
    const serviceId = computeServiceId(title, version, rawText);
    const now = new Date().toISOString();
    const existing = registry.get(serviceId);

    registry.upsert({
      id: serviceId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      // Reloading an identical document must not silently resurrect a service
      // the operator deliberately stopped.
      status: existing?.status ?? "running",
      title,
      version,
      source,
      toolCount: generated.tools.length,
      promptCount: prompts.length,
      resourceCount: resources.length,
      endpoint: { ...ENDPOINTS },
    });

    // Collect ids first: removing entries while iterating the registry's own
    // list skips elements whenever list() hands back the backing array.
    for (const id of registry.list().map((service) => service.id)) {
      if (id !== serviceId) registry.remove(id);
    }

    activeServiceId = serviceId;
    if (writeThrough) persistSpec(rawText, isYaml);

    // Existing sessions hold a server whose tool list came from the previous
    // document. MCP cannot retroactively rewrite a peer's tool cache mid-session,
    // so replacing the specification must drop them. The rejection is caught
    // here because an unhandled one terminates the process on Node 18.
    if (previousServiceId && previousServiceId !== serviceId) {
      void closeSessions("specification-replaced").catch((error) => {
        addInternalLog(
          "sessions-close-failed",
          false,
          serviceId,
          undefined,
          toMessage(error),
        );
      });
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

  /**
   * Drops the loaded document.
   *
   * Async so the caller can await session teardown: responding 200 while
   * sessions are still live leaves a window in which a connected client can
   * keep invoking tools against a service the operator believes is gone.
   */
  async function clearSpec(): Promise<void> {
    state.spec = null;
    state.specSource = "runtime";
    activeSpecRawText = "";
    activeSpecIsYaml = false;
    activeServiceId = null;
    registry.clear();

    if (persistEnabled) {
      // Remove the file outright rather than storing an empty specRaw, which
      // left a state file full of meaningless keys behind.
      persistPending = null;
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = undefined;
      }
      const result = clearState(config.stateFilePath);
      if (!result.ok) {
        addInternalLog(
          "state-clear-failed",
          false,
          undefined,
          undefined,
          `${result.path}: ${result.error?.message ?? "unknown error"}`,
        );
      }
    }

    await closeSessions("specification-cleared");
    addInternalLog("spec-cleared", true);
  }

  async function bootstrap(): Promise<void> {
    if (config.specPath) {
      // A startup file is an operator-supplied invariant: failing loudly here is
      // correct, because silently starting with no tools looks like a bug.
      const raw = stripBom(await fs.promises.readFile(config.specPath, "utf8"));
      const parsed = await parseWithFallback(raw, shouldParseAsYaml(raw));
      applySpec(parsed.spec, raw, parsed.isYaml, "startup-file", false);
      return;
    }

    if (!persistEnabled) return;

    // loadState is synchronous and reports its own failures, so no try/catch or
    // Awaited<> gymnastics are needed around it.
    const saved: Record<string, unknown> = loadState(config.stateFilePath);

    if (typeof saved.baseUrlOverride === "string" && !state.baseUrlOverride) {
      state.baseUrlOverride = saved.baseUrlOverride;
    }

    if (typeof saved.specRaw === "string" && saved.specRaw.trim()) {
      const raw = stripBom(saved.specRaw);
      try {
        const parsed = await parseWithFallback(
          raw,
          typeof saved.specIsYaml === "boolean"
            ? saved.specIsYaml
            : shouldParseAsYaml(raw),
        );
        applySpec(parsed.spec, raw, parsed.isYaml, "runtime", false);
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

  await bootstrap();

  /* ---------------------------------------------------------------------- */
  /* Status projection                                                      */
  /* ---------------------------------------------------------------------- */

  function buildStatus(): AdminStatus {
    const generated = state.spec
      ? getGeneratedTools(state.spec)
      : { tools: [], bindings: [], issues: [] };
    const prompts = state.spec ? cachedPrompts(state.spec) : [];
    const resources = state.spec ? cachedResources(state.spec) : [];

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
      pendingSessions: mcp.pendingSessionCount(), //Object literal may only specify known properties, and 'pendingSessions' does not exist in type 'AdminStatus'.ts(2353)
      // Surfaced so the web UI can warn that changes will not survive a
      // restart; previously this was silently invisible to the operator.
      persistEnabled,
      authRequired: Boolean(config.apiKey),
      services: registry.list(),
      issues: generated.issues.map(formatIssue),
      lastUpdatedAt: new Date().toISOString(),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Specification endpoints                                                */
  /* ---------------------------------------------------------------------- */

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
        const rawText = stripBom(request.file.buffer.toString("utf8"));
        if (!rawText.trim()) {
          response.status(400).json({ error: "The uploaded file is empty." });
          return;
        }
        const parsed = await parseWithFallback(
          rawText,
          shouldParseAsYaml(rawText),
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

      const raw = stripBom(content);
      const isYamlHint = (request.body as { isYaml?: unknown }).isYaml;
      // An explicit hint wins outright. The sniffer used to veto it, which made
      // the "Force YAML" checkbox a no-op on brace-leading input; the fallback
      // parse already covers a wrong guess, so there is nothing to protect.
      const preferYaml =
        typeof isYamlHint === "boolean" ? isYamlHint : shouldParseAsYaml(raw);

      const parsed = await parseWithFallback(raw, preferYaml);
      const result = applySpec(parsed.spec, raw, parsed.isYaml, "paste");
      response.json({ ok: true, result, ...buildStatus() });
    } catch (error) {
      response.status(400).json({ error: toMessage(error) });
    }
  });

  app.post("/api/spec/clear", auth, async (_request, response) => {
    await clearSpec();
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

  /* ---------------------------------------------------------------------- */
  /* Configuration endpoints                                                */
  /* ---------------------------------------------------------------------- */

  app.post("/api/config/base-url", auth, (request, response) => {
    const value = (request.body as { baseUrl?: unknown } | undefined)?.baseUrl;

    if (value === null || value === undefined || value === "") {
      state.baseUrlOverride = undefined;
      persistConfig();
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
    persistConfig();
    addInternalLog("base-url-updated", true, undefined, { baseUrl: value });
    response.json({ ok: true, ...buildStatus() });
  });

  /* ---------------------------------------------------------------------- */
  /* Inspection endpoints                                                   */
  /* ---------------------------------------------------------------------- */

  app.get("/api/status", auth, (_request, response) => {
    response.json(buildStatus());
  });

  app.get("/api/tools", auth, (_request, response) => {
    if (!state.spec) {
      response.json({ tools: [], bindings: [], issues: [] });
      return;
    }
    // The generated result is cached and shared, and its bindings hold
    // references back into the parsed document. Only derived, acyclic copies may
    // be serialised — res.json() on a raw binding throws on the circular $ref
    // graph.
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
        // Projected because the web UI renders it; omitting it silently blanked
        // the multipart and serialisation notes.
        usageNotes: binding.usageNotes,
        arguments: binding.arguments.map((argument) => ({
          key: argument.key,
          name: argument.name,
          in: argument.in,
          required: argument.parameter.required === true,
        })),
      })),
      issues: generated.issues.map(formatIssue),
    });
  });

  app.get("/api/prompts", auth, (_request, response) => {
    response.json({ prompts: state.spec ? cachedPrompts(state.spec) : [] });
  });

  app.get("/api/resources", auth, (_request, response) => {
    response.json({
      resources: state.spec ? cachedResources(state.spec) : [],
    });
  });

  app.get("/api/servers", auth, (_request, response) => {
    response.json({
      services: registry.list(),
      active: isActive(),
      endpoints: { ...ENDPOINTS },
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Session endpoints                                                      */
  /* ---------------------------------------------------------------------- */

  app.get("/api/sessions", auth, (_request, response) => {
    response.json({
      sessions: mcp.listSessions(),
      total: mcp.activeSessionCount(),
      pending: mcp.pendingSessionCount(),
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

  /* ---------------------------------------------------------------------- */
  /* Logs                                                                   */
  /* ---------------------------------------------------------------------- */

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

  /* ---------------------------------------------------------------------- */
  /* Debugger                                                               */
  /* ---------------------------------------------------------------------- */

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

    // The browser aborting its fetch only tears down this socket. Without
    // propagating that to the executor the upstream request runs to completion,
    // so the web UI's Cancel button had no observable effect and repeated
    // clicks piled requests onto a slow upstream.
    const controller = new AbortController();
    const onClientGone = (): void => controller.abort();
    request.on("close", onClientGone);

    try {
      const result = await executeToolCall(
        state.spec,
        toolName.trim(),
        (args as Record<string, unknown> | undefined) ?? {},
        {
          ...contextProvider(),
          signal: controller.signal,
          onLog(entry) {
            // Merge rather than replace the executor's meta: it carries the
            // built query string, retry count and serialisation decisions, which
            // is precisely what a debug call needs to show. A debug call also
            // travels over no MCP transport, so the protocol hint is cleared to
            // avoid misattributing it in the log viewer.
            addLog({
              ...entry,
              protocol: undefined,
              meta: { ...entry.meta, debug: true },
            });
          },
        },
      );
      response.json({ ok: true, result });
    } catch (error) {
      if (controller.signal.aborted) {
        // The client is already gone; writing a body would throw.
        if (!response.headersSent) response.status(499).end();
        return;
      }
      response.status(400).json({ error: toMessage(error) });
    } finally {
      request.off("close", onClientGone);
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Static assets and fallbacks                                            */
  /* ---------------------------------------------------------------------- */

  // Mounted after the API so that a file accidentally placed in the web UI
  // directory can never shadow an endpoint.
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

  /* ---------------------------------------------------------------------- */
  /* Listener                                                               */
  /* ---------------------------------------------------------------------- */

  const server = createServer(app);

  // Long-lived SSE and streaming responses must not be cut by the default
  // header/keep-alive timeouts. headersTimeout must exceed keepAliveTimeout,
  // otherwise a reused connection can be killed mid-handshake.
  server.keepAliveTimeout = 76_000;
  server.headersTimeout = 80_000;
  server.requestTimeout = REQUEST_TIMEOUT_MS;

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

    // Flush before tearing anything down: a debounced write still sitting in the
    // timer would otherwise be lost on shutdown, which is exactly when the most
    // recent configuration change tends to be queued.
    flushState();

    // Dispose first: it stops the sweeper, clears keep-alive timers and ends
    // open streams, which is what allows the HTTP server to finish closing.
    await mcp.dispose();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
    });
  };

  return { app, server, port: boundPort, close };
}
