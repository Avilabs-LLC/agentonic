import type { NextConfig } from "next"
import { customerDevOrigins } from "./dev-origin"

const config: NextConfig = {
  ...customerDevOrigins(
    process.env.NODE_ENV,
    process.env.AGENTONIC_CUSTOMER_DEV_ORIGIN
  ),
  transpilePackages: [
    "@workspace/ui",
    "@agentonic/contracts",
    "@agentonic/server",
    "@agentonic/database",
  ],
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"],
  poweredByHeader: false,
  // Server action arguments can contain passwords and private customer content.
  logging: {
    serverFunctions: false,
    incomingRequests: { ignore: [/\/api\/connections\/google\/callback/] },
  },
}
export default config
