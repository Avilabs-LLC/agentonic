import { proposalDescriptor } from "@agentonic/contracts/proposals"
import { BotIcon } from "lucide-react"
import {
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@workspace/ui/components/dialog"

export function ProposalDialogHeader({
  section,
  agentName,
  version,
  revision,
}: {
  section: "Propuesta" | "Criterios" | "Resultados"
  agentName?: string | null
  version?: number | null
  revision?: number | null
}) {
  return (
    <DialogHeader>
      <DialogTitle>{section}</DialogTitle>
      <DialogDescription className="flex items-start gap-2 tabular-nums">
        <BotIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 break-words">
          {agentName ?? "Agente no disponible"} ·{" "}
          {proposalDescriptor(version, revision)}
        </span>
      </DialogDescription>
    </DialogHeader>
  )
}
