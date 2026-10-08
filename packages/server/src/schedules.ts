import "server-only"
import { randomUUID } from "node:crypto"
import { withIdentity } from "@agentonic/database/client"
import { uuid } from "@agentonic/contracts/identity"
import { scheduleCommand, scheduleState } from "@agentonic/contracts/schedules"
import { requireVerifiedUser } from "./auth"

// Scheduled jobs (architecture §58). The database decides who may create, see
// and run a schedule; this module only carries the verified identity.
async function query(
  workspace: string,
  run: (
    tx: Parameters<Parameters<typeof withIdentity>[2]>[0]
  ) => Promise<Record<string, unknown> | undefined>
) {
  uuid.parse(workspace)
  const user = await requireVerifiedUser("customer")
  return withIdentity(user.authId, workspace, run)
}
export async function loadSchedules(workspace: string, agentId: string) {
  return scheduleState.parse(
    await query(workspace, async (tx) => {
      const rows = await tx.$queryRaw<
        { result: Record<string, unknown> }[]
      >`SELECT agentonic.schedule_state(${uuid.parse(agentId)}::uuid) result`
      return rows[0]?.result
    })
  )
}
export async function runScheduleCommand(workspace: string, input: unknown) {
  const parsed = scheduleCommand.parse(input)
  if (parsed.operation === "state")
    return {
      ok: true,
      state: await loadSchedules(workspace, parsed.payload.agentId),
    }
  const result = await query(workspace, async (tx) => {
    const rows = await tx.$queryRaw<
      { result: Record<string, unknown> }[]
    >`SELECT agentonic.schedule_command(${parsed.operation},${JSON.stringify(parsed.payload)}::jsonb,${randomUUID()}::uuid) result`
    return rows[0]?.result
  })
  if (!result) throw new Error("unavailable")
  return result
}
