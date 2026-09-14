import { notFound } from "next/navigation"
import { loadWorkspace } from "@agentonic/server/authoring"
import { PageHeader } from "@workspace/ui/components/page-header"
import { WorkspacePicker } from "@workspace/ui/components/workspace-picker"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@workspace/ui/components/card"
import { ResourceCreateForm } from "@workspace/ui/components/resource-create-form"
import { DocumentUpload } from "@workspace/ui/components/document-upload"
import { DocumentTable } from "@workspace/ui/components/document-table"
import { customerWorkspace } from "@/lib/workspace"
import { createCollection, removeDocument } from "../agents/actions"
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
    <>
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
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Nueva colección</CardTitle>
            <CardDescription>
              Las colecciones tienen permisos independientes de los agentes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ResourceCreateForm
              key={selected.id}
              action={createCollection.bind(null, selected.id)}
              disabled={selected.role === "viewer"}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Subir documento</CardTitle>
            <CardDescription>
              Subir un archivo no lo habilita para consultas del agente. El
              procesamiento y la indexación se incorporarán después.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DocumentUpload
              key={selected.id}
              workspaceId={selected.id}
              collections={writable}
            />
          </CardContent>
        </Card>
      </div>
      <DocumentTable
        data={data.documents}
        collections={data.collections}
        workspaceId={selected.id}
        remove={removeDocument.bind(null, selected.id)}
      />
    </>
  )
}
