import { notFound } from "next/navigation"
import { requireIdentity } from "@agentonic/server/auth"
import { loadTeam } from "@agentonic/server/account"
import { staffRoleLabels } from "@agentonic/contracts/operations"
import { PageHeader } from "@workspace/ui/components/page-header"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import { InvitationsTable } from "@workspace/ui/components/members-panel"
import {
  InviteStaffDialog,
  StaffTable,
} from "@workspace/ui/components/staff-team"
import { team as page } from "@/lib/navigation"
import { inviteToTeam, revokeTeamInvitation, updateTeamMember } from "./actions"
// Agentonic's team (architecture §63). The database decides what each person
// sees and may change; the page only hides what they can't use.
export default async function Page() {
  const identity = await requireIdentity("admin")
  if (!identity.hasAccess) notFound()
  const team = await loadTeam()
  if (!team) throw new Error("No se pudo cargar el equipo.")
  const administrator = team.viewer.role === "administrator"
  return (
    <>
      <PageHeader
        title={page.title}
        description={page.description}
        count={team.staff.filter((person) => person.status === "active").length}
        actions={administrator && <InviteStaffDialog invite={inviteToTeam} />}
      />
      <Card>
        <CardHeader>
          <CardTitle>Equipo</CardTitle>
          <CardDescription>
            Quién entra a este panel y con qué rol. Ver el contenido de un
            cliente sigue requiriendo su permiso en cada revisión.{" "}
            {administrator
              ? "Nadie cambia ni desactiva su propio acceso."
              : "Solo un administrador invita, cambia roles o desactiva personas."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <StaffTable team={team} update={updateTeamMember} />
        </CardContent>
      </Card>
      {team.invitations && (
        <Card>
          <CardHeader>
            <CardTitle>Invitaciones</CardTitle>
            <CardDescription>
              Cada invitación vale 7 días y solo para su correo.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <InvitationsTable
              invitations={team.invitations}
              revoke={revokeTeamInvitation}
              roleLabels={staffRoleLabels}
            />
          </CardContent>
        </Card>
      )}
    </>
  )
}
