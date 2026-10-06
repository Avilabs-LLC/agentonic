import "server-only"
import { withIdentity } from "@agentonic/database/client"
import {
  operationsActivity,
  operationsAgent,
  operationsAgents,
  operationsCosts,
  operationsDeployments,
  operationsReleases,
  operationsWorkspaces,
} from "@agentonic/contracts/operations"
import { requireVerifiedUser } from "./auth"

// The Admin operations screens' reads (architecture §52). Each runs as the
// signed-in staff member in a verified transaction; the database refuses
// anyone else. A failed read returns null and the page reports it.
type Transaction = Parameters<Parameters<typeof withIdentity>[2]>[0]
async function operations<T>(
  read: (tx: Transaction) => Promise<{ result: unknown }[]>,
  parse: (value: unknown) => T
): Promise<T | null> {
  const actor = await requireVerifiedUser("admin")
  try {
    return await withIdentity(actor.authId, null, async (tx) =>
      parse((await read(tx))[0]?.result)
    )
  } catch {
    return null
  }
}
export const loadOperationsAgents = () =>
  operations(
    (tx) => tx.$queryRaw`SELECT agentonic.operations_agents() result`,
    (v) => operationsAgents.parse(v)
  )
// One agent for the Admin agent page (architecture §55): null when the read
// fails, { agent: null } when no such agent exists.
export const loadOperationsAgent = (id: string) =>
  operations(
    (tx) => tx.$queryRaw`SELECT agentonic.operations_agent(${id}::uuid) result`,
    (v) => ({ agent: operationsAgent.nullable().parse(v) })
  )
export const loadOperationsActivity = () =>
  operations(
    (tx) => tx.$queryRaw`SELECT agentonic.operations_activity() result`,
    (v) => operationsActivity.parse(v)
  )
export const loadOperationsWorkspaces = () =>
  operations(
    (tx) => tx.$queryRaw`SELECT agentonic.operations_workspaces() result`,
    (v) => operationsWorkspaces.parse(v)
  )
export const loadOperationsDeployments = () =>
  operations(
    (tx) => tx.$queryRaw`SELECT agentonic.operations_deployments() result`,
    (v) => operationsDeployments.parse(v)
  )
export const loadOperationsCosts = () =>
  operations(
    (tx) => tx.$queryRaw`SELECT agentonic.operations_costs() result`,
    (v) => operationsCosts.parse(v)
  )
export const loadOperationsReleases = () =>
  operations(
    (tx) => tx.$queryRaw`SELECT agentonic.operations_releases() result`,
    (v) => operationsReleases.parse(v)
  )
