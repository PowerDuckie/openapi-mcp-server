import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "src", "webui");
const target = path.join(root, "dist", "webui");

if (!fs.existsSync(source)) {
  console.error(`[copy-webui] Missing source directory: ${source}`);
  process.exit(1);
}

// Copy the contents of src/webui directly into dist/webui, without
// recreating the "src" path segment.
fs.mkdirSync(target, { recursive: true });
fs.cpSync(source, target, { recursive: true });

console.log(`[copy-webui] Copied ${source} -> ${target}`);
