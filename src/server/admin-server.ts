import express, { type Express, type RequestHandler } from "express";
import cors, { type CorsOptions } from "cors";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { parseSpecContent } from "../core/openapi-loader";
import { generateToolsDetailed } from "../core/tool-generator";
import { generatePrompts } from "../registry/prompt-registry";
import { generateResources } from "../registry/resource-registry";
import { createAuthMiddleware } from "./auth";
import { saveState, loadState } from "../config/config-store";
import { attachSseRoutes } from "../mcp/transport-sse";
import { ServiceRegistry } from "../runtime/service-registry";
import type {
  AppState,
  ServerConfig,
  ExecutionContext,
  AdminStatus,
  SpecSource,
} from "../types";

/**
 * Locates the bundled web UI relative to this module rather than to
 * `process.cwd()`, because the working directory depends on where the operator
 * invoked the CLI. The candidate list covers both tsup output layouts — the
 * flattened `dist/*.mjs` and the nested `dist/server/*.mjs` — so a change in
 * bundler configuration cannot silently break the UI.
 */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR =
  [
    path.resolve(MODULE_DIR, "webui"),
    path.resolve(MODULE_DIR, "../webui"),
    path.resolve(MODULE_DIR, "../../webui"),
  ].find((candidate) => fs.existsSync(path.join(candidate, "index.html"))) ??
  path.resolve(MODULE_DIR, "webui");

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const JSON_BODY_LIMIT = "20mb";

/** Summary returned after a spec has been accepted and activated. */
interface ApplyResult {
  serviceId: string;
  toolCount: number;
  promptCount: number;
  resourceCount: number;
  degradedTools: string[];
  issues: string[];
}

/** Filename is only a hint; content sniffing decides the real parser. */
function looksLikeYamlName(name: string): boolean {
  return /\.ya?ml$/i.test(name);
}

/**
 * Decides whether the payload should be parsed as YAML first.
 * A JSON document is detected structurally so that a mislabeled upload
 * (for example `spec.yaml` containing JSON) still loads correctly.
 */
function shouldParseAsYaml(raw: string, nameHint?: string): boolean {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return false;
  if (nameHint && looksLikeYamlName(nameHint)) return true;
  return true;
}

type ParsedSpec = Awaited<ReturnType<typeof parseSpecContent>>;

/**
 * Parses a spec, retrying with the alternate syntax before giving up, so a
 * wrong extension never blocks an otherwise valid document. The error from the
 * preferred syntax is surfaced because it is usually the more relevant one.
 */
async function parseWithFallback(
  raw: string,
  preferYaml: boolean,
): Promise<{ spec: ParsedSpec; isYaml: boolean }> {
  try {
    const spec = await parseSpecContent(raw, preferYaml);
    return { spec, isYaml: preferYaml };
  } catch (firstError) {
    try {
      const spec = await parseSpecContent(raw, !preferYaml);
      return { spec, isYaml: !preferYaml };
    } catch {
      throw firstError;
    }
  }
}

/** Stable service id derived from the document identity. */
function computeServiceId(title: string, version: string): string {
  const digest = createHash("sha256")
    .update(`${title}\u0000${version}`)
    .digest("hex")
    .slice(0, 12);
  return `svc_${digest}`;
}

/**
 * CORS policy. The bundled web UI is served from this same origin, so the
 * default is to reject cross-origin requests entirely. Operators opt in
 * explicitly through `allowedOrigins`.
 */
function buildCorsOptions(config: ServerConfig): CorsOptions {
  const allowed = config.allowedOrigins;
  if (!allowed || allowed.length === 0) {
    return { origin: false };
  }
  if (allowed.includes("*")) {
    return { origin: true };
  }
  const allowSet = new Set(allowed);
  return {
    origin(origin, callback) {
      if (!origin || allowSet.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin is not allowed."));
    },
    credentials: true,
  };
}

/** Normalizes any thrown value into a safe, client-facing message. */
function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function startAdminServer(config: ServerConfig): Promise<Express> {
  const app = express();
  const auth: RequestHandler = createAuthMiddleware(config.apiKey);
  const registry = new ServiceRegistry();
  const persistEnabled = config.persistState !== false;

  const state: AppState = {
    spec: null,
    baseUrlOverride: config.baseUrlOverride,
    specSource: config.specPath ? "startup-file" : "runtime",
  };

  /**
   * Id of the service backed by the currently loaded spec. MCP endpoints only
   * serve traffic while this service is in the `running` state, so the stop and
   * start controls have a real effect instead of only flipping a label.
   */
  let activeServiceId: string | null = null;

  app.disable("x-powered-by");
  app.use(cors(buildCorsOptions(config)));
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // ---------------------------------------------------------------------------
  // Service registry helpers
  // ---------------------------------------------------------------------------

  /**
   * Removes a service record. The registry implementation may expose `remove`,
   * `delete` or only `stop`; all three are tolerated so this file does not break
   * when the registry evolves.
   */
  function removeService(id: string): void {
    const candidate = registry as unknown as {
      remove?: (id: string) => unknown;
      delete?: (id: string) => unknown;
      stop?: (id: string) => unknown;
    };
    if (typeof candidate.remove === "function") {
      candidate.remove(id);
      return;
    }
    if (typeof candidate.delete === "function") {
      candidate.delete(id);
      return;
    }
    candidate.stop?.(id);
  }

  /** True when MCP traffic should currently be served. */
  function isActive(): boolean {
    if (!state.spec || !activeServiceId) return false;
    return registry.get(activeServiceId)?.status === "running";
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  function persist(rawSpecText: string | null, isYaml: boolean): void {
    if (!persistEnabled) return;
    try {
      saveState(
        {
          specRaw: rawSpecText ?? "",
          specIsYaml: isYaml,
          baseUrlOverride: state.baseUrlOverride,
        },
        config.stateFilePath,
      );
    } catch (error) {
      // Persistence is best-effort: never fail a request because of disk issues.
      console.warn("[admin] Failed to persist state:", toMessage(error));
    }
  }

  // ---------------------------------------------------------------------------
  // Spec lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Applies a parsed spec to the running server and refreshes the registry.
   * This is the single write path shared by upload, paste and bootstrap so the
   * three entry points can never drift apart.
   */
  function applySpec(
    spec: ParsedSpec,
    rawText: string,
    isYaml: boolean,
    source: SpecSource,
    writeThrough = true,
  ): ApplyResult {
    const generated = generateToolsDetailed(spec);
    const prompts = generatePrompts(spec);
    const resources = generateResources(spec);

    state.spec = spec;
    state.specSource = source;

    const title = spec.info?.title ?? "Untitled API";
    const version = spec.info?.version ?? "0.0.0";
    const serviceId = computeServiceId(title, version);
    const now = new Date().toISOString();
    const existing = registry.get(serviceId);

    registry.upsert({
      id: serviceId,
      // Preserve the original creation timestamp across reloads.
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      status: "running",
      title,
      version,
      source,
      toolCount: generated.tools.length,
      promptCount: prompts.length,
      resourceCount: resources.length,
      endpoint: {
        sse: "/mcp",
        messages: "/mcp/messages",
        stdioSupported: true,
      },
    });

    // Only one spec can be active at a time in this deployment mode; drop the
    // records of previously loaded documents so the UI never shows stale rows.
    for (const service of registry.list()) {
      if (service.id !== serviceId) removeService(service.id);
    }

    activeServiceId = serviceId;

    if (writeThrough) persist(rawText, isYaml);

    return {
      serviceId,
      toolCount: generated.tools.length,
      promptCount: prompts.length,
      resourceCount: resources.length,
      degradedTools: generated.bindings
        .filter((binding) => !binding.fullySupported)
        .map((binding) => binding.toolName),
      issues: generated.issues.map(
        (issue) =>
          `${issue.method ? `${issue.method.toUpperCase()} ` : ""}${issue.path}: ${issue.message}`,
      ),
    };
  }

  /** Clears the active spec, the persisted copy and the registry record. */
  function clearSpec(): void {
    state.spec = null;
    state.specSource = "runtime";
    if (activeServiceId) {
      removeService(activeServiceId);
      activeServiceId = null;
    }
    for (const service of registry.list()) removeService(service.id);
    persist("", false);
    // Existing MCP sessions no longer have a document to serve. `closeAll` is
    // asynchronous; the result is intentionally not awaited because callers of
    // this function run in a synchronous request context.
    void sse.closeAll();
  }

  /** Startup file wins over persisted state. */
  async function bootstrap(): Promise<void> {
    if (config.specPath) {
      const raw = fs.readFileSync(config.specPath, "utf8");
      const parsed = await parseWithFallback(
        raw,
        shouldParseAsYaml(raw, config.specPath),
      );
      applySpec(parsed.spec, raw, parsed.isYaml, "startup-file", false);
      return;
    }

    if (!persistEnabled) return;

    let saved: ReturnType<typeof loadState>;
    try {
      saved = loadState(config.stateFilePath);
    } catch (error) {
      // A corrupted state file must never prevent the server from starting.
      console.warn(
        "[admin] Failed to read persisted state, starting empty:",
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
        console.warn(
          "[admin] Persisted spec is no longer valid and was discarded:",
          toMessage(error),
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // MCP transport wiring
  // ---------------------------------------------------------------------------

  const contextProvider = (): ExecutionContext => ({
    baseUrlOverride: state.baseUrlOverride,
    upstreamHeaders: config.upstreamHeaders,
    requestTimeoutMs: config.requestTimeoutMs,
  });

  // The spec provider returns null while the service is stopped, which makes the
  // stop control genuinely disable the MCP surface rather than only relabel it.
  const sse = attachSseRoutes(
    app,
    () => (isActive() ? state.spec : null),
    contextProvider,
    config.apiKey ? auth : undefined,
  );

  await bootstrap();

  // ---------------------------------------------------------------------------
  // Status projection
  // ---------------------------------------------------------------------------

  function buildStatus(): AdminStatus {
    const generated = state.spec
      ? generateToolsDetailed(state.spec)
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
      activeSessions: sse.activeSessionCount(),
      services: registry.list(),
      issues: generated.issues.map(
        (issue) =>
          `${issue.method ? `${issue.method.toUpperCase()} ` : ""}${issue.path}: ${issue.message}`,
      ),
    };
  }

  // ---------------------------------------------------------------------------
  // Static web UI
  // ---------------------------------------------------------------------------

  app.use(express.static(STATIC_DIR));
  app.get("/", (_request, response) => {
    response.sendFile(path.join(STATIC_DIR, "index.html"));
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  });

  // ---------------------------------------------------------------------------
  // Spec management API
  // ---------------------------------------------------------------------------

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
      const content = request.body?.content;
      if (typeof content !== "string" || !content.trim()) {
        response
          .status(400)
          .json({ error: "content must be a non-empty string." });
        return;
      }
      // The client hint is respected, but content sniffing still wins for JSON.
      const preferYaml =
        typeof request.body?.isYaml === "boolean"
          ? request.body.isYaml && shouldParseAsYaml(content)
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

  app.post("/api/config/base-url", auth, (request, response) => {
    const value = request.body?.baseUrl;
    if (value === null || value === undefined || value === "") {
      state.baseUrlOverride = undefined;
      persist(null, false);
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
    response.json({ ok: true, ...buildStatus() });
  });

  // ---------------------------------------------------------------------------
  // Catalog API
  // ---------------------------------------------------------------------------

  app.get("/api/status", auth, (_request, response) => {
    response.json(buildStatus());
  });

  app.get("/api/tools", auth, (_request, response) => {
    if (!state.spec) {
      response.json({ tools: [], bindings: [], issues: [] });
      return;
    }
    const generated = generateToolsDetailed(state.spec);
    response.json({
      tools: generated.tools,
      // Expose the support level so the UI can flag partially mapped tools.
      bindings: generated.bindings.map((binding) => ({
        toolName: binding.toolName,
        method: binding.method,
        path: binding.path,
        bodyMediaType: binding.bodyMediaType,
        fullySupported: binding.fullySupported,
        degradationReasons: binding.degradationReasons,
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

  // ---------------------------------------------------------------------------
  // Service lifecycle API
  // ---------------------------------------------------------------------------

  app.get("/api/servers", auth, (_request, response) => {
    response.json({ services: registry.list(), active: isActive() });
  });

  app.post<{ id: string }>(
    "/api/servers/:id/start",
    auth,
    (request, response) => {
      const id = request.params.id;
      const existing = registry.get(id);
      if (!existing) {
        response.status(404).json({ error: "Service not found." });
        return;
      }
      if (!state.spec) {
        response
          .status(409)
          .json({ error: "No specification is loaded; nothing to start." });
        return;
      }
      registry.upsert({
        ...existing,
        status: "running",
        updatedAt: new Date().toISOString(),
      });
      activeServiceId = id;
      response.json({ ok: true, ...buildStatus() });
    },
  );

  app.post<{ id: string }>(
    "/api/servers/:id/stop",
    auth,
    (request, response) => {
      const id = request.params.id;
      const existing = registry.get(id);
      if (!existing) {
        response.status(404).json({ error: "Service not found." });
        return;
      }
      registry.upsert({
        ...existing,
        status: "stopped",
        updatedAt: new Date().toISOString(),
      });
      // Terminate live sessions so clients observe the stop immediately instead
      // of holding a connection that will never answer again.
      void sse.closeAll();
      response.json({ ok: true, ...buildStatus() });
    },
  );

  // ---------------------------------------------------------------------------
  // Web UI fallback
  // ---------------------------------------------------------------------------

  /**
   * Any GET that is not an API or MCP route falls back to the single-page app,
   * so deep links and browser refreshes do not hit the JSON 404 below. Express 5
   * rejects the bare `"*"` string pattern, hence the regular expression.
   */
  app.get(/^\/(?!api\/|mcp).*/, (_request, response) => {
    response.sendFile(path.join(STATIC_DIR, "index.html"));
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

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
      // Multer surfaces payload limits through a code field.
      const code = (error as { code?: string } | null)?.code;
      if (code === "LIMIT_FILE_SIZE") {
        response
          .status(413)
          .json({ error: "The uploaded file exceeds the size limit." });
        return;
      }
      console.error("[admin] Unhandled error:", error);
      response.status(500).json({ error: "Internal server error." });
    },
  );

  // ---------------------------------------------------------------------------
  // Listen
  // ---------------------------------------------------------------------------

  const server = app.listen(config.port, config.host ?? "127.0.0.1");
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
  });

  return app;
}
