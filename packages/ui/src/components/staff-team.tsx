"use client"
import { useId, useState } from "react"
import { useRouter } from "next/navigation"
import type { ColumnDef } from "@tanstack/react-table"
import { useForm, useWatch, Controller } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { PlusIcon, UserCheckIcon, UserCogIcon, UserXIcon } from "lucide-react"
import {
  staffInvitationInput,
  staffRoleDescriptions,
  staffRoles,
  type StaffInvitationInput,
  type StaffMember,
  type StaffRole,
  type StaffTeam,
  type StaffUpdateInput,
} from "@agentonic/contracts/access"
import { staffRoleLabels } from "@agentonic/contracts/operations"
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

// Admin's Equipo page (architecture §63): Agentonic's staff, their roles and
// invitations. Every staff member sees the team; administrators also see emails
// and change it, never their own row. The database enforces the same rules.

const header = sortableHeader
const role = (value: string) => staffRoleLabels[value] ?? value

export function StaffTable({
  team,
  update,
}: {
  team: StaffTeam
  update: (input: StaffUpdateInput) => Promise<ActionResult>
}) {
  const router = useRouter()
  const administrator = team.viewer.role === "administrator"
  const run = async (input: StaffUpdateInput) => {
    const result = await update(input)
    if (result.ok) router.refresh()
    return result
  }
  const actions = (person: StaffMember) =>
    person.status === "disabled"
      ? [
          {
            label: "Reactivar",
            icon: <UserCheckIcon aria-hidden="true" />,
            successMessage: `${person.name} puede volver a entrar.`,
            run: () => run({ staffId: person.id, active: true }),
            confirm: {
              title: "Reactivar",
              description: `${person.name} volverá a entrar a Administración como ${role(person.role)}.`,
              confirmLabel: "Reactivar",
            },
          },
        ]
      : [
          ...staffRoles
            .filter((value) => value !== person.role)
            .map((value: StaffRole) => ({
              label: `Cambiar a ${role(value)}`,
              icon: <UserCogIcon aria-hidden="true" />,
              successMessage: `${person.name} ahora es ${role(value)}.`,
              run: () => run({ staffId: person.id, role: value }),
              confirm: {
                title: `Cambiar a ${role(value)}`,
                description: `${person.name} pasará de ${role(person.role)} a ${role(value)}. ${staffRoleDescriptions[value]}`,
                confirmLabel: `Cambiar a ${role(value)}`,
              },
            })),
          {
            label: "Desactivar",
            icon: <UserXIcon aria-hidden="true" />,
            destructive: true,
            successMessage: `${person.name} ya no puede entrar.`,
            run: () => run({ staffId: person.id, active: false }),
            confirm: {
              title: "Desactivar",
              description: `${person.name} dejará de entrar a Administración de inmediato, y se retirarán las invitaciones que haya enviado. Puedes reactivarlo cuando quieras.`,
              confirmLabel: "Desactivar",
            },
          },
        ]
  const columns: ColumnDef<StaffMember>[] = [
    ...(administrator
      ? [
          {
            id: "actions",
            cell: ({ row }: { row: { original: StaffMember } }) =>
              row.original.id === team.viewer.staffId ? null : (
                <DataTableRowActions actions={actions(row.original)} />
              ),
          } satisfies ColumnDef<StaffMember>,
        ]
      : []),
    { accessorKey: "name", header: header("Nombre") },
    ...(administrator
      ? [
          {
            id: "email",
            accessorFn: (row: StaffMember) => row.email ?? "",
            header: header("Correo", "Correo electrónico"),
            cell: ({ row }: { row: { original: StaffMember } }) =>
              row.original.email ?? <Absent>Sin registro</Absent>,
          } satisfies ColumnDef<StaffMember>,
        ]
      : []),
    {
      id: "role",
      accessorFn: (row) => role(row.role),
      header: header("Rol"),
    },
    {
      accessorKey: "since",
      header: header("Desde"),
      cell: ({ row }) => <When value={row.original.since} />,
    },
    {
      accessorKey: "status",
      header: header("Estado"),
      cell: ({ row }) => (
        <StatusIndicator
          appearance="badge"
          state={statusDescriptor("staff", row.original.status)}
        />
      ),
    },
  ]
  return (
    <DataTable
      data={team.staff}
      columns={columns}
      searchKeys={administrator ? ["name", "email"] : ["name"]}
      searchLabel="Buscar en el equipo"
      emptyDescription="El equipo aún no tiene personas."
      getRowId={(row) => row.id}
    />
  )
}

export function InviteStaffDialog({
  invite,
}: {
  invite: (input: StaffInvitationInput) => Promise<ActionResult>
}) {
  const router = useRouter()
  const roleId = useId()
  const [open, setOpen] = useState(false)
  const roles = Object.fromEntries(
    staffRoles.map((value) => [value, role(value)])
  )
  const empty: StaffInvitationInput = { email: "", role: "operator" }
  const {
    control,
    register,
    handleSubmit,
    reset,
    formState: { errors, isValid, isSubmitting },
  } = useForm<StaffInvitationInput>({
    resolver: zodResolver(staffInvitationInput),
    mode: "onChange",
    defaultValues: empty,
  })
  const chosen = useWatch({ control, name: "role" })
  async function submit(input: StaffInvitationInput) {
    try {
      const result = await invite(input)
      if (!result.ok) {
        notify.destructive(result.message)
        return
      }
      notify.success(`Invitación enviada a ${input.email}.`)
      setOpen(false)
      reset(empty)
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
        Invitar al equipo
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invitar al equipo</DialogTitle>
          <DialogDescription>
            Enviaremos un enlace a ese correo para entrar a Administración con
            el rol que elijas. Vence en 7 días y solo vale para ese correo.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(submit)} noValidate>
          <FieldGroup>
            <Field data-invalid={Boolean(errors.email)}>
              <FieldLabel htmlFor="staff-invite-email">
                Correo electrónico
              </FieldLabel>
              <Input
                id="staff-invite-email"
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
                    onValueChange={(value) => {
                      if (value && value !== field.value) field.onChange(value)
                    }}
                  >
                    <SelectTrigger id={roleId} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {staffRoles.map((value) => (
                        <SelectItem key={value} value={value}>
                          {role(value)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <FieldDescription>
                {staffRoleDescriptions[chosen]}
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
                {isSubmitting ? "Enviando…" : "Invitar al equipo"}
              </Button>
            </div>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  )
}
