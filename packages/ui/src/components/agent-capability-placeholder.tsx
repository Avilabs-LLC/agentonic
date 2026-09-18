import { CardEmptyState } from "@workspace/ui/components/card-empty-state"
import { PlugIcon, WrenchIcon } from "lucide-react"
import { AgentSettingsCard } from "@workspace/ui/components/agent-settings-card"

export function AgentCapabilityPlaceholder({
  kind,
}: {
  kind: "tools" | "connections"
}) {
  const tools = kind === "tools"
  return (
    <AgentSettingsCard
      title={tools ? "Herramientas" : "Conexiones"}
      icon={tools ? <WrenchIcon /> : <PlugIcon />}
      description={
        tools
          ? "Acciones que podrá realizar tu agente."
          : "Cuentas y servicios externos que podrá utilizar tu agente."
      }
    >
      <CardEmptyState title="Próximamente">
        {tools
          ? "La configuración de herramientas estará disponible próximamente."
          : "La configuración de conexiones estará disponible próximamente."}
      </CardEmptyState>
    </AgentSettingsCard>
  )
}
