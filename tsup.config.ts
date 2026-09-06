// tsup.config.ts
import { defineConfig } from "tsup";

export default defineConfig((options) => ({
  // Three entry points for the two consumption modes:
  // - index: the public library surface (importable by developers)
  // - cli:   the standalone binary that boots stdio or web transport
  // - admin: the SaaS-side admin/HTTP server, kept separate so that
  //          library consumers never pull in fastify/multer transitively
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
    "server/admin-server": "src/server/admin-server.ts",
  },

  // Dual output. ESM is the primary target; CJS exists so that consumers
  // still on require() are not locked out.
  format: ["esm", "cjs"],

  // Node 18 is the lowest version with stable fetch/AbortSignal.timeout.
  target: "node18",
  platform: "node",

  // Emit .d.ts / .d.cts alongside the JS bundles.
  dts: {
    resolve: false,
  },

  // Correct extensions per format so that Node's "type": "module"
  // resolution never guesses wrong: .mjs for ESM, .cjs for CJS.
  outExtension({ format }) {
    return { js: format === "esm" ? ".mjs" : ".cjs" };
  },

  sourcemap: false,
  clean: true,
  splitting: false,
  treeshake: true,

  // Do NOT bundle runtime dependencies. Only devDependencies and
  // type-only packages get inlined; everything the user installs
  // stays external so version resolution belongs to them.
  skipNodeModulesBundle: true,
  external: [
    "@modelcontextprotocol/sdk",
    "fastify",
    "@fastify/cors",
    "multer",
    "yaml",
  ],

  // Shim __dirname / import.meta.url so the same source compiles to both
  // formats. Required because admin-server.ts resolves its static WebUI
  // assets relative to the module location.
  shims: true,

  // Keep the CLI executable directly.
  banner({ format }) {
    if (format === "esm") {
      return {
        js: [
          "#!/usr/bin/env node",
          // createRequire lets ESM output load CJS-only deps if needed.
          "import { createRequire as __createRequire } from 'module';",
          "const require = __createRequire(import.meta.url);",
        ].join("\n"),
      };
    }
    return { js: "#!/usr/bin/env node" };
  },

  minify: "terser",
  watch: options.watch,
}));
