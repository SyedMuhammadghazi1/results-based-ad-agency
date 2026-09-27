import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import tseslint from "typescript-eslint";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["src/app/t.js/**"],
    rules: {},
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "dist/**",
    "build/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "next-env.d.ts",
    "drizzle/**",
  ]),
]);
