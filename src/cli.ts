
// #!/usr/bin/env node //'#!' can only be used at the start of a file.ts(18026)
import { Command } from "commander";
import { loadOpenApiSpec } from "./core/openapi-loader";
import { startStdioServer } from "./mcp/transport-stdio";
import { startAdminServer } from "./server/admin-server";

const program = new Command();
program.name("openapi-mcp").description("Convert OpenAPI documents into MCP services.").version("1.0.0");

function parseHeaderOption(value: string, previous: Record<string, string>): Record<string, string> {
  const index = value.indexOf(":");
  if (index === -1) throw new Error('Expected "Header-Name: value".');
  const key = value.slice(0, index).trim();
  const headerValue = value.slice(index + 1).trim();
  if (!key) throw new Error("Header name is required.");
  return { ...previous, [key]: headerValue };
}

program
  .command("serve")
  .option("--port <n>", "HTTP port", "3000")
  .option("--host <host>", "HTTP host", "127.0.0.1")
  .option("--transport <mode>", "stdio or web", "web")
  .option("--spec <path>", "OpenAPI document file path")
  .option("--base-url <url>", "Override upstream base URL")
  .option("--api-key <key>", "Admin API key")
  .option("--upstream-header <headerPair>", "Repeatable upstream header", parseHeaderOption, {})
  .option("--timeout <ms>", "Upstream timeout in milliseconds", "30000")
  .option("--no-persist", "Disable state persistence")
  .action(async (options) => {
    if (options.transport === "stdio") {
      if (!options.spec) throw new Error("The --spec option is required in stdio mode.");
      const spec = await loadOpenApiSpec(options.spec);
      await startStdioServer(spec, {
        baseUrlOverride: options.baseUrl,
        upstreamHeaders: options.upstreamHeader,
        requestTimeoutMs: Number(options.timeout),
      });
      return;
    }

    await startAdminServer({
      port: Number(options.port),
      host: options.host,
      apiKey: options.apiKey,
      specPath: options.spec,
      baseUrlOverride: options.baseUrl,
      upstreamHeaders: options.upstreamHeader,
      requestTimeoutMs: Number(options.timeout),
      persistState: options.persist,
    });
  });

program.parseAsync(process.argv).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
