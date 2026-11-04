import { driveGrants, gmailGrants, hasWeb } from "@agentonic/contracts/tools"
import { driveLabels } from "@agentonic/contracts/drive"
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
      title="Herramientas solicitadas"
      description="Capacidades incluidas en esta versión y sujetas a sus permisos vigentes."
      icon={<WrenchIcon />}
      footer="La evaluación usa datos sintéticos para probar las herramientas. Las versiones con herramientas requieren revisión del equipo; los cambios de correo y de documentos necesitan confirmación del titular."
    >
      {hasWeb(tools) && (
        <div className="mb-4 space-y-2 rounded-lg border bg-muted/20 p-4">
          <p className="text-sm font-medium">Acceso web</p>
          <p className="text-sm text-muted-foreground">
            Búsqueda y lectura de páginas públicas con fuentes. Sin inicio de
            sesión, formularios ni cambios en sitios web.
          </p>
        </div>
      )}
      {gmailGrants(tools).map((g) => (
        <div
          key={g.connectionId ?? "member-gmail"}
          className="space-y-3 rounded-lg border bg-muted/20 p-4"
        >
          <p className="text-xs text-muted-foreground">
            {g.connectionId
              ? `Conexión ${g.connectionId}`
              : "Cuenta de Gmail de cada persona"}
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
      {driveGrants(tools).map((g) => (
        <div
          key={g.driveConnectionId ?? "member-drive"}
          className="mt-4 space-y-3 rounded-lg border bg-muted/20 p-4"
        >
          <p className="text-sm font-medium">Google Drive</p>
          <p className="text-xs text-muted-foreground">
            {g.driveConnectionId
              ? `Conexión ${g.driveConnectionId}`
              : "Drive de cada persona"}
          </p>
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            {g.operations.map((op) => (
              <li key={op}>{driveLabels[op]}</li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Solo los archivos que el titular eligió y los documentos que el
            agente creó · Uso privado de pruebas.
          </p>
        </div>
      ))}
    </AgentSettingsCard>
  )
}
