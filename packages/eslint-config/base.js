import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";
export const config = [
  { ignores: ["**/dist/**", "**/.next/**", "**/.turbo/**", "**/coverage/**", "**/generated/**"] },
  js.configs.recommended, prettier, ...tseslint.configs.recommended,
];
