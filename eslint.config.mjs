import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";

/** @type {import('eslint').Linter.Config[]} */
export default [
  // `dist/` is the compiled output and `build/` holds the release staging tree
  // (which embeds its own `dist/` and `node_modules/`); neither is source.
  { ignores: ["dist", "build"] },
  { files: ["**/*.{js,mjs,cjs,ts}"] },
  { files: ["**/*.js"], languageOptions: { sourceType: "commonjs" } },
  { languageOptions: { globals: globals.browser } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  // Build/packaging tooling under `tools/` is plain CommonJS Node scripts: it
  // runs outside the TypeScript program (the release build only needs `node`),
  // so it legitimately uses `require`, `module`, `__dirname` and `Buffer`, and
  // `require()` instead of ESM imports.
  {
    files: ["tools/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      // Several long-standing scripts in `tools/` re-declare Node built-ins
      // (`const process = require("process")`) to keep them readable; the
      // re-declaration is harmless.
      "no-redeclare": "off",
    },
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/no-misused-promises": "warn",
    },
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-expressions": "off",
      // Project convention for an intentionally-unused parameter (e.g. a base-class hook a
      // subclass may override) is a leading underscore, not a disable directive comment placed
      // above it - a directive like that only silences violations on the single line right below
      // it, which breaks the moment Prettier reflows a long signature onto multiple lines.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    },
  },
];
