A production-oriented TypeScript library and runtime that converts OpenAPI documents into MCP services.

## Features

- Tools generated from OpenAPI operations
- Prompts generated from API metadata and operations
- Resources generated from the OpenAPI catalog
- HTTP and STDIO MCP transports
- Admin Web UI
- Persistent runtime state
- Stronger validation and safer request execution
- Production-oriented structure for future SaaS evolution

## Install

```bash
npm install
```

## Build

```bash
npm run build
```

## Start web runtime

```bash
npm run start -- serve --port 3000 --host 127.0.0.1
```

## Start STDIO runtime

```bash
node dist/cli.js serve --transport stdio --spec ./openapi.yaml
```

## Demo

```bash
npm run demo
```

## Library usage

```ts
import {
  parseSpecContent,
  generateTools,
  generatePrompts,
  generateResources,
  buildMcpServer,
} from "openapi-mcp-production";
```

## CLI usage

### Web mode

```bash
openapi-mcp serve \
  --transport web \
  --port 3000 \
  --host 127.0.0.1 \
  --api-key your-admin-key
```

### STDIO mode

```bash
openapi-mcp serve \
  --transport stdio \
  --spec ./openapi.yaml \
  --base-url https://api.example.com
```

## Production notes

This version is production-oriented, but you should still add the following for SaaS deployment:

- tenant isolation
- database-backed project registry
- rate limits
- audit logs
- RBAC
- secure secret storage
- upstream host allowlists
- comprehensive test suites
- full OpenAPI parameter serialization coverage
- full requestBody content negotiation support

## Project structure

- `src/core`: spec parsing, operation traversal, tool generation, request building, execution
- `src/mcp`: MCP server creation and transports
- `src/registry`: prompts and resources registries
- `src/runtime`: runtime service registry
- `src/server`: admin HTTP server
- `src/webui`: browser UI
- `src/config`: persistence helpers

## Web UI

The UI supports:

- upload and paste OpenAPI documents
- view tools, prompts, and resources
- inspect runtime services
- stop services
- basic MCP debugging hints
- SSE endpoint discovery
- STDIO tooltip guidance

## Important implementation policy

All source comments are written in American English.
