import type { ConfigurationSnapshot } from "@agentonic/contracts/authoring"
import { gmailLabels } from "@agentonic/contracts/gmail"
import { gmailGrants, hasWeb } from "@agentonic/contracts/tools"

export function ProposalConfigurationSummary({
  snapshot,
}: {
  snapshot?: ConfigurationSnapshot
}) {
  if (!snapshot)
    return (
      <p className="text-sm text-muted-foreground">
        La configuración de esta versión no está disponible.
      </p>
    )

  const { content, requestedAccess } = snapshot
  const connections = gmailGrants(requestedAccess.tools)
  const connectionCount = new Set(connections.map((item) => item.connectionId))
    .size
  return (
    <div className="space-y-5 text-sm">
      <dl className="grid grid-cols-2 gap-4 border-y py-4 sm:grid-cols-4">
        {[
          {
            label: "Habilidades",
            count: content.skills.length,
          },
          {
            label: "Colecciones",
            count: requestedAccess.collectionIds.length,
          },
          {
            label: "Herramientas",
            count: requestedAccess.tools.length,
          },
          { label: "Conexiones", count: connectionCount },
        ].map(({ label, count }) => (
          <div key={label} className="space-y-1">
            <dt className="text-xs text-muted-foreground">
              {label}
            </dt>
            <dd className="text-lg font-semibold tabular-nums">{count}</dd>
          </div>
        ))}
      </dl>
      <section className="space-y-2">
        <h3 className="font-medium">Instrucciones del sistema</h3>
        <p className="max-h-60 overflow-y-auto pr-2 leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
          {content.systemPrompt || "Sin instrucciones."}
        </p>
      </section>
      <section className="space-y-2">
        <h3 className="font-medium">Habilidades</h3>
        <p className="break-words text-muted-foreground">
          {content.skills.length
            ? content.skills.map((skill) => skill.name).join(" · ")
            : "Sin habilidades."}
        </p>
      </section>
      <section className="space-y-2">
        <h3 className="font-medium">Herramientas y conexiones</h3>
        <div className="space-y-2 text-muted-foreground">
          {hasWeb(requestedAccess.tools) && (
            <p>Acceso web · Buscar y leer páginas públicas.</p>
          )}
          {connections.map((connection) => (
            <p key={connection.connectionId}>
              Gmail ·{" "}
              {connection.operations
                .map((operation) => gmailLabels[operation])
                .join(" · ")}
            </p>
          ))}
          {!requestedAccess.tools.length && <p>Sin herramientas.</p>}
          {!connectionCount && <p>Sin conexiones.</p>}
        </div>
      </section>
    </div>
  )
}
