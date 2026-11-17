// Minimal lint for TypeScript (clean code review V3, decision D1).
// Recommended rules only; formatting is left to Prettier.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/",
      "**/dist/",
      ".claude/",
      "android/",
      "core/src/autofill/psl-rules.ts",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    linterOptions: { reportUnusedDisableDirectives: "error" },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // `_name` marks a value left out on purpose, e.g. `const { attachments: _, ...rest } = entry`.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  {
    // Tests and vector scripts build malformed data on purpose.
    files: ["**/test/**", "**/scripts/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
