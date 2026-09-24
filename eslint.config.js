import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/coverage/**", "**/dist/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-import-type-side-effects": "error",
    },
  },
  { files: ["**/*.{js,mjs,cjs}"], ...tseslint.configs.disableTypeChecked },
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/tst/**"],
              message: "Production code must not depend on test fixtures or replay tooling.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(?!\\.|node:crypto$)",
              message:
                "Core logic depends only on local business modules and deterministic hashing.",
            },
            {
              group: [
                "**/adapters/**",
                "**/api/**",
                "**/dashboard/**",
                "**/plugin/**",
                "**/tools/**",
                "**/tst/**",
              ],
              message: "Core depends on its own contracts; infrastructure is injected at runtime.",
            },
          ],
        },
      ],
    },
  },
  prettier,
);
