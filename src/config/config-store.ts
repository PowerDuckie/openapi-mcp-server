import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Restrictive mode for the state file.
 *
 * The persisted state carries the admin API key and upstream base URL, i.e.
 * credentials. The default 0o666 & ~umask usually lands on 0o644, which makes
 * them readable by every local account.
 */
const STATE_FILE_MODE = 0o600;
const STATE_DIR_MODE = 0o700;

const STATE_FILE_NAME = "state.json";
const APP_DIR_NAME = "openapi-mcp";

export interface SaveResult {
  ok: boolean;
  path: string;
  error?: Error;
}

/**
 * Resolves the state file location.
 *
 * Deliberately a function rather than a module-level constant: the previous
 * cwd-relative constant was captured at import time, and when an MCP client
 * spawns this binary over stdio the cwd is the client's own directory (often
 * "/" or a read-only bundle path). That produced a file nobody could find and
 * a config that silently reset on every launch.
 */
export function resolveStateFilePath(): string {
  const explicit = process.env.OPENAPI_MCP_STATE_FILE?.trim();
  if (explicit) return path.resolve(explicit);

  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  const base = xdg
    ? path.resolve(xdg)
    : process.platform === "win32"
      ? path.join(process.env.APPDATA ?? os.homedir(), "")
      : path.join(os.homedir(), ".config");

  return path.join(base, APP_DIR_NAME, STATE_FILE_NAME);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Drops keys that would poison a prototype once the caller merges the result.
 *
 * JSON.parse itself is safe (it creates a plain own property), but callers
 * routinely do Object.assign(defaults, loadState()), and that assignment does
 * hit the __proto__ setter.
 */
function safeReviver(key: string, value: unknown): unknown {
  if (key === "__proto__" || key === "constructor" || key === "prototype") {
    return undefined;
  }
  return value;
}

/**
 * Atomically persists state.
 *
 * Write order is write -> fsync -> close -> rename. Skipping the fsync still
 * gives an atomic *visibility* switch, but on an unclean shutdown the rename
 * metadata can reach disk while the contents are still in page cache, leaving
 * a valid path pointing at a zero-length file — a config that silently wiped
 * itself.
 */
export function saveState(
  obj: Record<string, unknown>,
  stateFilePath: string = resolveStateFilePath(),
): SaveResult {
  const dir = path.dirname(stateFilePath);
  let tempFile: string | undefined;

  try {
    fs.mkdirSync(dir, { recursive: true, mode: STATE_DIR_MODE });

    // Serialise before creating the temp file so a circular or BigInt value
    // throws without leaving anything behind.
    const payload = JSON.stringify(obj, null, 2);

    tempFile = path.join(
      dir,
      `.${path.basename(stateFilePath)}.${process.pid}.${Date.now()}.tmp`,
    );

    const handle = fs.openSync(tempFile, "wx", STATE_FILE_MODE);
    try {
      fs.writeFileSync(handle, payload, "utf8");
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }

    fs.renameSync(tempFile, stateFilePath);
    tempFile = undefined;

    // rename does not touch the permissions of a pre-existing target, so a
    // file created by an older build keeps its loose mode forever unless it is
    // explicitly tightened here.
    try {
      fs.chmodSync(stateFilePath, STATE_FILE_MODE);
    } catch {
      // Best effort: some filesystems (FAT, certain network mounts) reject
      // chmod outright, and that must not fail an otherwise good write.
    }

    return { ok: true, path: stateFilePath };
  } catch (error) {
    console.warn(
      `[config-store] Failed to persist state to ${stateFilePath}: ${describe(error)}`,
    );
    return { ok: false, path: stateFilePath, error: toError(error) };
  } finally {
    // Without this, every failed rename leaves another orphaned .tmp behind.
    if (tempFile) {
      try {
        fs.unlinkSync(tempFile);
      } catch {
        // Nothing further to do; the warning above already reported the cause.
      }
    }
  }
}

/**
 * Moves an unparseable state file aside instead of letting it be overwritten.
 *
 * The old behaviour returned {} on a parse error, and the next saveState then
 * clobbered the damaged file — destroying the only copy of whatever the user
 * had configured before anyone could inspect it.
 */
function quarantine(stateFilePath: string): void {
  const backup = `${stateFilePath}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(stateFilePath, backup);
    console.warn(`[config-store] Moved unreadable state file to ${backup}`);
  } catch (error) {
    console.warn(
      `[config-store] Could not quarantine ${stateFilePath}: ${describe(error)}`,
    );
  }
}

export function loadState(
  stateFilePath: string = resolveStateFilePath(),
): Record<string, unknown> {
  let raw: string;
  try {
    // Read directly rather than existsSync-then-read: the extra stat is both a
    // TOCTOU window and a syscall that ENOENT already reports for free.
    raw = fs.readFileSync(stateFilePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.warn(
        `[config-store] Failed to read state from ${stateFilePath}: ${describe(error)}`,
      );
    }
    return {};
  }

  // An empty file is the normal result of an interrupted legacy write, not
  // corruption worth quarantining.
  if (raw.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, safeReviver);
  } catch (error) {
    console.warn(
      `[config-store] State file is not valid JSON: ${describe(error)}`,
    );
    quarantine(stateFilePath);
    return {};
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.warn("[config-store] State file does not contain a JSON object.");
    quarantine(stateFilePath);
    return {};
  }

  return parsed as Record<string, unknown>;
}

/** Removes the persisted state; used by the "clear spec" admin action. */
export function clearState(
  stateFilePath: string = resolveStateFilePath(),
): SaveResult {
  try {
    fs.rmSync(stateFilePath, { force: true });
    return { ok: true, path: stateFilePath };
  } catch (error) {
    console.warn(
      `[config-store] Failed to clear state at ${stateFilePath}: ${describe(error)}`,
    );
    return { ok: false, path: stateFilePath, error: toError(error) };
  }
}
