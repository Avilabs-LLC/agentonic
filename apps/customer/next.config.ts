import type { NextConfig } from "next"
const config: NextConfig = {
  transpilePackages: [
    "@workspace/ui",
    "@agentonic/contracts",
    "@agentonic/server",
    "@agentonic/database",
  ],
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"],
  poweredByHeader: false,
  // Server action arguments can contain passwords and private customer content.
  logging: { serverFunctions: false },
}
export default config
