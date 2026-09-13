import { config } from "@workspace/eslint-config/base"
export default [
  ...config,
  {
    files: ["scripts/**/*.mjs", "scripts/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
      },
    },
  },
]
