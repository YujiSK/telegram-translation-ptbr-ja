import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      ".wrangler/**",
      "node_modules/**",
      "coverage/**",
      "worker-configuration.d.ts",
    ],
  },
  js.configs.recommended,
  {
    // Type-aware linting is scoped to the actual project sources (governed
    // by tsconfig.json). Config files like this one are linted for syntax
    // only, so they don't need their own tsconfig project.
    files: ["src/**/*.ts", "test/**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.worker,
      },
    },
    rules: {
      // Enforced project-wide — see docs/project-rules.md ("any" and unsafe
      // double-casts are banned).
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // Enforced project-wide — see docs/project-rules.md ("Promises must
      // never be left unhandled").
      "@typescript-eslint/no-floating-promises": "error",
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["test/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.vitest,
      },
    },
  },
  {
    files: ["*.config.js", "*.config.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
);
