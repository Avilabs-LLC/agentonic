"use client"
import { useId, useState } from "react"
import { useRouter } from "next/navigation"
import type { ColumnDef } from "@tanstack/react-table"
import { useForm, Controller } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { ArchiveIcon, PlusIcon } from "lucide-react"
import {
  invitationState,
  memberInvitationInput,
  memberRoleLabels,
  type MemberInvitationInput,
  type WorkspaceInvitation,
  type WorkspaceMember,
} from "@agentonic/contracts/access"
import type { ActionResult } from "@agentonic/contracts/identity"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@workspace/ui/components/dialog"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { DataTable } from "@workspace/ui/components/data-table"
import { DataTableRowActions } from "@workspace/ui/components/data-table-row-actions"
import { StatusIndicator } from "@workspace/ui/components/status-badge"
import {
  Absent,
  sortableHeader,
  When,
} from "@workspace/ui/components/table-cells"
import { statusDescriptor } from "@workspace/ui/lib/badge-status"
import { notify } from "@workspace/ui/lib/toast"

// The Miembros page (architecture §54): members and invitations of one
// workspace, for its owners and admins.

const header = sortableHeader
const role = (value: string) => memberRoleLabels[value] ?? value

export function MembersTable({ members }: { members: WorkspaceMember[] }) {
  const columns: ColumnDef<WorkspaceMember>[] = [
    { accessorKey: "displayName", header: header("Nombre") },
    {
      id: "email",
      accessorFn: (row) => row.email ?? "",
      header: header("Correo", "Correo electrónico"),
      cell: ({ row }) => row.original.email ?? <Absent>Sin registro</Absent>,
    },
    {
      id: "role",
      accessorFn: (row) => role(row.role),
      header: header("Rol"),
    },
    {
      accessorKey: "status",
      header: header("Estado"),
      cell: ({ row }) => (
        <StatusIndicator
          appearance="badge"
          state={statusDescriptor("member", row.original.status)}
        />
      ),
    },
  ]
  return (
    <DataTable
      data={members}
      columns={columns}
      searchKeys={["displayName", "email"]}
      searchLabel="Buscar miembros"
      emptyDescription="Este espacio aún no tiene miembros."
      getRowId={(row) => row.id}
    />
  )
}

export function InvitationsTable({
  invitations,
  revoke,
}: {
  invitations: WorkspaceInvitation[]
  revoke: (invitationId: string) => Promise<ActionResult>
}) {
  const router = useRouter()
  const columns: ColumnDef<WorkspaceInvitation>[] = [
    {
      id: "actions",
      cell: ({ row }) => (
        <DataTableRowActions
          actions={[
            {
              label: "Retirar invitación",
              icon: <ArchiveIcon aria-hidden="true" />,
              destructive: true,
              disabled: invitationState(row.original) !== "pending",
              successMessage: "Invitación retirada.",
              run: async () => {
                const result = await revoke(row.original.id)
                if (result.ok) router.refresh()
                return result
              },
              confirm: {
                title: "Retirar invitación",
                description: `El enlace enviado a ${row.original.email} dejará de funcionar. Puedes invitar de nuevo cuando quieras.`,
                confirmLabel: "Retirar invitación",
              },
            },
          ]}
        />
      ),
    },
    { accessorKey: "email", header: header("Correo", "Correo electrónico") },
    {
      id: "role",
      accessorFn: (row) => role(row.role),
      header: header("Rol"),
    },
    {
      accessorKey: "expiresAt",
      header: header("Vence"),
      cell: ({ row }) => <When value={row.original.expiresAt} />,
    },
    {
      id: "state",
      accessorFn: (row) => invitationState(row),
      header: header("Estado"),
      cell: ({ row }) => (
        <StatusIndicator
          appearance="badge"
          state={statusDescriptor("invitation", invitationState(row.original))}
        />
      ),
    },
  ]
  return (
    <DataTable
      data={invitations}
      columns={columns}
      searchKeys={["email"]}
      searchLabel="Buscar invitaciones"
      emptyDescription="No hay invitaciones."
      getRowId={(row) => row.id}
    />
  )
}

export function InviteMemberDialog({
  workspaceId,
  workspaceName,
  canInviteAdmins,
  invite,
}: {
  workspaceId: string
  workspaceName: string
  canInviteAdmins: boolean
  invite: (input: MemberInvitationInput) => Promise<ActionResult>
}) {
  const router = useRouter()
  const roleId = useId()
  const [open, setOpen] = useState(false)
  const roles = Object.fromEntries(
    (canInviteAdmins
      ? (["member", "viewer", "admin"] as const)
      : (["member", "viewer"] as const)
    ).map((value) => [value, memberRoleLabels[value]!])
  )
  const {
    control,
    register,
    handleSubmit,
    reset,
    formState: { errors, isValid, isSubmitting },
  } = useForm<MemberInvitationInput>({
    resolver: zodResolver(memberInvitationInput),
    mode: "onChange",
    defaultValues: { workspaceId, email: "", role: "member" },
  })
  async function submit(input: MemberInvitationInput) {
    try {
      const result = await invite(input)
      if (!result.ok) {
        notify.destructive(result.message)
        return
      }
      notify.success(`Invitación enviada a ${input.email}.`)
      setOpen(false)
      reset({ workspaceId, email: "", role: "member" })
      router.refresh()
    } catch {
      notify.destructive("No se pudo enviar la invitación. Inténtalo de nuevo.")
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!isSubmitting) setOpen(value)
      }}
    >
      <DialogTrigger render={<Button />}>
        <PlusIcon aria-hidden="true" />
        Invitar miembro
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invitar miembro</DialogTitle>
          <DialogDescription>
            Enviaremos un enlace a ese correo para unirse a {workspaceName}.
            Vence en 7 días y solo vale para ese correo.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(submit)} noValidate>
          <FieldGroup>
            <Field data-invalid={Boolean(errors.email)}>
              <FieldLabel htmlFor="invite-email">Correo electrónico</FieldLabel>
              <Input
                id="invite-email"
                type="email"
                autoComplete="off"
                aria-invalid={Boolean(errors.email)}
                {...register("email")}
              />
              <FieldError errors={[errors.email]} />
            </Field>
            <Field>
              <FieldLabel htmlFor={roleId}>Rol</FieldLabel>
              <Controller
                control={control}
                name="role"
                render={({ field }) => (
                  <Select
                    items={roles}
                    value={field.value}
                    onValueChange={(value) => field.onChange(value)}
                  >
                    <SelectTrigger id={roleId} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(roles).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <FieldDescription>
                Un lector consulta; un miembro también crea agentes y
                conocimiento; un administrador además gestiona miembros.
              </FieldDescription>
            </Field>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={isSubmitting}
                onClick={() => setOpen(false)}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={!isValid || isSubmitting}>
                {isSubmitting ? "Enviando…" : "Invitar miembro"}
              </Button>
            </div>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  )
}
