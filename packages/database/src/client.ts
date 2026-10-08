import "server-only"
import { readFileSync } from "node:fs"
import { PrismaPg } from "@prisma/adapter-pg"
import { PrismaClient, type Prisma } from "./generated/client"

function createDatabase() {
  const raw = process.env.DATABASE_URL
  const ca = process.env.AGENTONIC_DATABASE_CA_FILE
  const expectedRole = process.env.AGENTONIC_DATABASE_ROLE
  if (
    !raw ||
    !ca ||
    !["agentonic_admin", "agentonic_customer"].includes(expectedRole ?? "")
  ) {
    throw new Error(
      "Restricted application database configuration is required."
    )
  }
  const url = new URL(raw)
  if (decodeURIComponent(url.username).split(".")[0] !== expectedRole) {
    throw new Error("Unexpected database role.")
  }
  const adapter = new PrismaPg(
    {
      host: url.hostname,
      port: Number(url.port || 5432),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)),
      ssl: { rejectUnauthorized: true, ca: readFileSync(ca, "utf8") },
      max: 3,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      application_name: expectedRole,
    },
    { schema: "agentonic" }
  )
  return new PrismaClient({ adapter })
}
const globalDatabase = globalThis as unknown as {
  agentonicDatabase?: PrismaClient
}
function database() {
  globalDatabase.agentonicDatabase ??= createDatabase()
  return globalDatabase.agentonicDatabase
}
export async function withIdentity<T>(
  authUserId: string,
  workspaceId: string | null,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
  verifiedEmail: string | null = null
) {
  return database().$transaction(
    async (tx) => {
      // All context values are reset for EVERY transaction. Never use session-scoped SET.
      await tx.$executeRaw`SELECT set_config('agentonic.auth_user_id', ${authUserId}, true), set_config('agentonic.workspace_id', ${workspaceId ?? ""}, true), set_config('agentonic.verified_email', ${verifiedEmail ?? ""}, true)`
      return operation(tx)
    },
    { maxWait: 5_000, timeout: 10_000 }
  )
}
export type IdentityOverview = {
  user: { id: string; displayName: string } | null
  staff: { id: string; role: string } | null
  workspaces: {
    id: string
    name: string
    kind: string
    timezone: string
    role: string
  }[]
}
export async function identityOverview(
  authUserId: string,
  verifiedEmail: string | null = null
): Promise<IdentityOverview> {
  return withIdentity(
    authUserId,
    null,
    async (tx) => {
      // Keeps the copy managers see in Miembros current; writes only on change.
      await tx.$executeRaw`SELECT agentonic.record_verified_email()`
      const rows = await tx.$queryRaw<
        { overview: IdentityOverview }[]
      >`SELECT agentonic.identity_overview() AS overview`
      if (!rows[0]) throw new Error("Identity discovery failed.")
      return rows[0].overview
    },
    verifiedEmail
  )
}
