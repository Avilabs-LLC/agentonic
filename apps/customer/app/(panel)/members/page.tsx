import { loadMembers } from "@agentonic/server/account"
import { PageHeader } from "@workspace/ui/components/page-header"
import { WorkspacePicker } from "@workspace/ui/components/workspace-picker"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { CardEmptyState } from "@workspace/ui/components/card-empty-state"
import {
  InvitationsTable,
  InviteMemberDialog,
  MembersTable,
} from "@workspace/ui/components/members-panel"
import { customerWorkspace } from "@/lib/workspace"
import { members as page } from "@/lib/navigation"
import { inviteToWorkspace, revokeWorkspaceInvitation } from "./actions"
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string }>
}) {
  const { identity, selected } = await customerWorkspace(searchParams)
  const manager = selected.role === "owner" || selected.role === "admin"
  const data = manager ? await loadMembers(selected.id) : null
  return (
    <div className="space-y-6">
      <PageHeader
        title={page.title}
        description={page.description}
        count={data?.members.length}
        actions={
          data && (
            <InviteMemberDialog
              workspaceId={selected.id}
              workspaceName={selected.name}
              canInviteAdmins={selected.role === "owner"}
              invite={inviteToWorkspace}
            />
          )
        }
      />
      <WorkspacePicker
        workspaces={identity.workspaces}
        selected={selected.id}
        base="/members"
      />
      {data ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Miembros</CardTitle>
              <CardDescription>
                Quién trabaja en {selected.name} y con qué rol.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <MembersTable members={data.members} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Invitaciones</CardTitle>
              <CardDescription>
                Cada invitación vale 7 días y solo para su correo.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <InvitationsTable
                invitations={data.invitations}
                revoke={revokeWorkspaceInvitation.bind(null, selected.id)}
              />
            </CardContent>
          </Card>
        </>
      ) : (
        <CardEmptyState
          title={
            manager
              ? "No se pudieron cargar los miembros"
              : "Solo propietarios y administradores gestionan miembros"
          }
        >
          {manager
            ? "Vuelve a intentarlo en unos minutos."
            : `Pide a un propietario o administrador de ${selected.name} que invite a otras personas.`}
        </CardEmptyState>
      )}
    </div>
  )
}
