import fs from "node:fs";
import path from "node:path";

const DEFAULT_STATE_FILE = path.resolve(
  process.cwd(),
  ".openapi-mcp-state.json",
);

export function saveState(
  obj: Record<string, unknown>,
  stateFilePath: string = DEFAULT_STATE_FILE,
): void {
  try {
    const dir = path.dirname(stateFilePath);
    fs.mkdirSync(dir, { recursive: true });
    const tempFile = path.join(
      dir,
      `.${path.basename(stateFilePath)}.${process.pid}.${Date.now()}.tmp`,
    );
    fs.writeFileSync(tempFile, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tempFile, stateFilePath);
  } catch (error) {
    console.warn(
      `[config-store] Failed to persist state: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function loadState(
  stateFilePath: string = DEFAULT_STATE_FILE,
): Record<string, unknown> {
  try {
    if (!fs.existsSync(stateFilePath)) return {};
    const raw = fs.readFileSync(stateFilePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (error) {
    console.warn(
      `[config-store] Failed to load state: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }
}
