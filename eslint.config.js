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
  {
    // Scripts run top to bottom: a const used by code that runs before its line throws.
    files: ["scripts/**/*.mjs"],
    rules: {
      "no-use-before-define": [
        "error",
        { functions: false, classes: true, variables: true },
      ],
    },
  },
]
