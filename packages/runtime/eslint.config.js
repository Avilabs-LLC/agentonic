import { config } from "@workspace/eslint-config/base"
// The runtime runs in a credential-free child process. It may use only the
// shared contracts and zod; provider, database, network and process access
// belong to the broker.
export default [
  ...config,
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            "@agentonic/server",
            "@agentonic/server/*",
            "@agentonic/database",
            "@agentonic/database/*",
            "@agentonic/connectors",
            "@agentonic/connectors/*",
            "@agentonic/worker",
            "@agentonic/worker/*",
            "pg",
            "node:child_process",
            "node:net",
            "node:http",
            "node:https",
            "node:dns",
            "node:tls",
            "node:dgram",
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        "fetch",
        "WebSocket",
        "XMLHttpRequest",
      ],
    },
  },
]
