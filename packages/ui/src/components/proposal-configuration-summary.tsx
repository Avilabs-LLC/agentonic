import {
  LibraryBigIcon,
  ListChecksIcon,
  PlugIcon,
  WrenchIcon,
} from "lucide-react"
import type { ConfigurationSnapshot } from "@agentonic/contracts/authoring"
import { gmailLabels } from "@agentonic/contracts/gmail"
import { driveLabels } from "@agentonic/contracts/drive"
import { driveGrants, gmailGrants, hasWeb } from "@agentonic/contracts/tools"
import { MarkdownView } from "@workspace/ui/components/markdown"

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
  const drives = driveGrants(requestedAccess.tools)
  const connectionCount =
    new Set(connections.map((item) => item.connectionId).filter(Boolean)).size +
    new Set(drives.map((item) => item.driveConnectionId).filter(Boolean)).size
  return (
    <div className="space-y-5 text-sm">
      <dl className="grid grid-cols-2 gap-4 border-y py-4 sm:grid-cols-4">
        {[
          {
            label: "Habilidades",
            count: content.skills.length,
            icon: ListChecksIcon,
          },
          {
            label: "Colecciones",
            count: requestedAccess.collectionIds.length,
            icon: LibraryBigIcon,
          },
          {
            label: "Herramientas",
            count: requestedAccess.tools.length,
            icon: WrenchIcon,
          },
          { label: "Conexiones", count: connectionCount, icon: PlugIcon },
        ].map(({ label, count, icon: Icon }) => (
          <div key={label} className="space-y-1">
            <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              {label}
            </dt>
            <dd className="text-lg font-semibold tabular-nums">{count}</dd>
          </div>
        ))}
      </dl>
      <MarkdownView
        label={<h3 className="font-medium">Instrucciones del sistema</h3>}
        markdown={content.systemPrompt}
        paneClassName="max-h-[min(15rem,40dvh)]"
        empty="Sin instrucciones."
      />
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
            <p key={connection.connectionId ?? "member-gmail"}>
              Gmail {connection.connectionId ? "" : "de cada persona"} ·{" "}
              {connection.operations
                .map((operation) => gmailLabels[operation])
                .join(" · ")}
            </p>
          ))}
          {drives.map((drive) => (
            <p key={drive.driveConnectionId ?? "member-drive"}>
              Google Drive {drive.driveConnectionId ? "" : "de cada persona"} ·{" "}
              {drive.operations
                .map((operation) => driveLabels[operation])
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
