import { notFound } from "next/navigation"
import { loadWorkspace } from "@agentonic/server/authoring"
import { PageHeader } from "@workspace/ui/components/page-header"
import { WorkspacePicker } from "@workspace/ui/components/workspace-picker"
import { AgentSettingsCard } from "@workspace/ui/components/agent-settings-card"
import { KnowledgeCollections } from "@workspace/ui/components/knowledge-collections"
import { DocumentUpload } from "@workspace/ui/components/document-upload"
import { DocumentTable } from "@workspace/ui/components/document-table"
import {
  KnowledgeSearch,
  KnowledgeRefresh,
} from "@workspace/ui/components/knowledge-search"
import { processDocument } from "./actions"
import { customerWorkspace } from "@/lib/workspace"
import {
  createCollection,
  removeCollection,
  removeDocument,
} from "../agents/actions"
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string }>
}) {
  const { identity, selected } = await customerWorkspace(searchParams)
  const data = await loadWorkspace(selected.id)
  if (!data) notFound()
  const writable = data.collections.filter((c) => c.canCurate)
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <KnowledgeRefresh
        active={
          data.pendingDeletions > 0 ||
          data.documents.some((d) =>
            ["queued", "running"].includes(d.processingStatus)
          )
        }
      />
      <PageHeader
        title="Conocimiento"
        description="Organiza documentos privados y elige qué colecciones propones para tus agentes."
        count={data.documents.length}
      />
      <WorkspacePicker
        workspaces={identity.workspaces}
        selected={selected.id}
        base="/knowledge"
      />
      <KnowledgeCollections
        key={`collections:${selected.id}`}
        collections={data.collections}
        documents={data.documents}
        create={createCollection.bind(null, selected.id)}
        remove={removeCollection.bind(null, selected.id)}
        canCreate={selected.role !== "viewer"}
      />
      <AgentSettingsCard
        title="Subir documento"
        description="Selecciona una colección y añade un archivo a su biblioteca privada."
      >
        <DocumentUpload
          key={selected.id}
          workspaceId={selected.id}
          collections={writable}
        />
      </AgentSettingsCard>
      <AgentSettingsCard
        title="Documentos"
        description="Consulta los archivos de tus colecciones, descárgalos o retíralos cuando lo necesites."
        footer={
          <p>
            Solo los documentos listos participan en la búsqueda de
            conocimiento.
            {data.pendingDeletions > 0 &&
              ` ${data.pendingDeletions} archivo(s) fuera del conocimiento, pendientes de eliminación física.`}
          </p>
        }
      >
        <DocumentTable
          data={data.documents}
          collections={data.collections}
          workspaceId={selected.id}
          remove={removeDocument.bind(null, selected.id)}
          process={processDocument.bind(null, selected.id)}
        />
      </AgentSettingsCard>
      <KnowledgeSearch
        key={`search:${selected.id}:${data.collections.map((c) => c.id).join(",")}:${data.documents.map((d) => `${d.id}:${d.status}`).join(",")}`}
        workspaceId={selected.id}
        collections={data.collections}
      />
    </div>
  )
}
