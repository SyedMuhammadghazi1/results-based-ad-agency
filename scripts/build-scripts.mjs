// Bundles the standalone CLIs shipped in the Docker image:
//   dist/migrate.mjs  -> applies drizzle/ migrations      (node migrate.mjs)
//   dist/job.mjs      -> runs a background job by name     (node job.mjs sync-spend)
//   dist/rotate-secrets.mjs -> re-encrypts stored secrets with the current key
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
    js: [
      "import { createRequire as __cr } from 'node:module';",
      "import { fileURLToPath as __f2p } from 'node:url';",
      "import { dirname as __dn } from 'node:path';",
      "const require = __cr(import.meta.url);",
      "const __filename = __f2p(import.meta.url);",
      "const __dirname = __dn(__filename);",
    ].join(" "),
  },
  define: { "process.env.NEXT_RUNTIME": '"nodejs"' },
};

await build({ ...common, entryPoints: ["scripts/migrate.ts"], outfile: "dist/migrate.mjs" });
await build({ ...common, entryPoints: ["scripts/run-job.ts"], outfile: "dist/job.mjs" });
await build({
  ...common,
  entryPoints: ["scripts/rotate-secrets.ts"],
  outfile: "dist/rotate-secrets.mjs",
});
console.log("Built dist/migrate.mjs, dist/job.mjs and dist/rotate-secrets.mjs");
