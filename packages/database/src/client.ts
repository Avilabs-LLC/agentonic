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
export async function identityOverview(authUserId: string) {
  const identity = await withIdentity(authUserId, null, async (tx) => {
    const user = await tx.user.findFirst()
    const staff = await tx.platformStaff.findFirst()
    const ids = await tx.$queryRaw<
      { id: string }[]
    >`SELECT agentonic.authorized_workspace_ids() AS id`
    return { user, staff, ids }
  })
  const workspaces = await Promise.all(
    identity.ids.map(({ id }) =>
      withIdentity(authUserId, id, async (tx) => {
        const workspace = await tx.workspace.findUnique({ where: { id } })
        const membership = await tx.workspaceMember.findFirst({
          where: { workspaceId: id },
        })
        return workspace && membership
          ? {
              id,
              name: workspace.name,
              kind: workspace.kind,
              timezone: workspace.timezone,
              role: membership.role,
            }
          : null
      })
    )
  )
  return {
    user: identity.user,
    staff: identity.staff,
    workspaces: workspaces.filter((w) => w !== null),
  }
}
