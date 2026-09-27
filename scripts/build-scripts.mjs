// Bundles the standalone CLIs shipped in the Docker image:
//   dist/migrate.mjs  -> applies drizzle/ migrations      (node migrate.mjs)
//   dist/job.mjs      -> runs a background job by name     (node job.mjs sync-spend)
import { build } from "esbuild";

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  logLevel: "warning",
  external: ["pg-native", "pino-pretty"],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  define: { "process.env.NEXT_RUNTIME": '"nodejs"' },
};

await build({ ...common, entryPoints: ["scripts/migrate.ts"], outfile: "dist/migrate.mjs" });
await build({ ...common, entryPoints: ["scripts/run-job.ts"], outfile: "dist/job.mjs" });
console.log("Built dist/migrate.mjs and dist/job.mjs");
