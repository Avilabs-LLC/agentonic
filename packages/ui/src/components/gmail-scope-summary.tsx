import { WrenchIcon } from "lucide-react"
import { gmailLabels } from "@agentonic/contracts/gmail"
import type { AgentView } from "@agentonic/contracts/authoring"
import { AgentSettingsCard } from "@workspace/ui/components/agent-settings-card"
export function GmailScopeSummary({
  tools,
}: {
  tools: AgentView["draft"]["requestedAccess"]["tools"]
}) {
  return (
    <AgentSettingsCard
      title="Acceso a Gmail solicitado"
      description="Operaciones incluidas en esta versión y sujetas a los permisos vigentes de la cuenta."
      icon={<WrenchIcon />}
      footer="Las evaluaciones automáticas no acceden al buzón. Esta versión requiere revisión del equipo; los cambios de correo siempre necesitan confirmación del titular."
    >
      {tools.map((g) => (
        <div
          key={g.connectionId}
          className="space-y-3 rounded-lg border bg-muted/20 p-4"
        >
          <p className="text-xs text-muted-foreground">
            Conexión {g.connectionId}
          </p>
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            {g.operations.map((op) => (
              <li key={op}>{gmailLabels[op]}</li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Uso privado de pruebas · Sin tareas desatendidas ni acceso
            compartido al buzón.
          </p>
        </div>
      ))}
    </AgentSettingsCard>
  )
}
