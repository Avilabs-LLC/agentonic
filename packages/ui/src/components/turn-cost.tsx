import { CoinsIcon } from "lucide-react"
import { cn } from "cn"
import { formatUsd } from "@agentonic/contracts/format"
import { modelConfigurationLabel } from "@agentonic/contracts/models"

/** What the conversation had cost when each turn ended: a running total. */
export function runningSpend(turns: { spentMicrousd?: number }[]) {
  let total = 0
  return turns.map((turn) => (total += turn.spentMicrousd ?? 0))
}

/**
 * What a turn cost, under its answer, as Corby shows it in Slack (§82): this
 * turn, the conversation so far once earlier turns cost something, and the
 * model when the message doesn't name it. The amounts come from the provider
 * ledger. A call still holding a reservation has an unknown cost up to that
 * hold, and the line says so.
 */
export function TurnCost({
  spentMicrousd,
  heldMicrousd = 0,
  totalMicrousd,
  model,
  className,
}: {
  spentMicrousd?: number
  heldMicrousd?: number
  totalMicrousd: number
  model?: { model: string; reasoning: string | null }
  className?: string
}) {
  if (spentMicrousd === undefined) return null
  const parts = [
    `${formatUsd(spentMicrousd / 1e6)} este turno${heldMicrousd > 0 ? `, más hasta ${formatUsd(heldMicrousd / 1e6)} sin confirmar` : ""}`,
  ]
  if (totalMicrousd > spentMicrousd)
    parts.push(`${formatUsd(totalMicrousd / 1e6)} en esta conversación`)
  if (model) parts.push(modelConfigurationLabel(model))
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 text-xs text-muted-foreground tabular-nums",
        className
      )}
    >
      <CoinsIcon className="mt-px size-3.5 shrink-0" aria-hidden="true" />
      <span>{parts.join(" · ")}</span>
    </p>
  )
}
