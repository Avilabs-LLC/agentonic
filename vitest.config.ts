import { defineConfig } from "vitest/config"
import { resolve } from "node:path"
export default defineConfig({
  resolve: {
    alias: {
      "server-only": resolve("tests/server-only.ts"),
      "next/headers": resolve("apps/admin/node_modules/next/headers.js"),
      "next/navigation": resolve("apps/admin/node_modules/next/navigation.js"),
      "@supabase/ssr": resolve(
        "packages/server/node_modules/@supabase/ssr/dist/module/index.js"
      ),
      "@agentonic/database/client": resolve("packages/database/src/client.ts"),
    },
  },
  test: { include: ["tests/**/*.test.ts"], testTimeout: 10_000 },
})
