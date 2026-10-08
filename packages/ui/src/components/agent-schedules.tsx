"use client"
// Scheduled jobs (architecture §58): the agent page's Programaciones tab. A
// schedule sends its instruction to the agent's running version at each due
// time. Owner direction (8 Oct 2026): until a channel such as Slack can ask for
// confirmation, a schedule may pre-authorize one Gmail write per run; the
// person consents to exactly those writes when saving it.
import { useCallback, useEffect, useState } from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { Controller, useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Checkbox } from "@base-ui/react/checkbox"
import {
  CalendarClockIcon,
  CheckIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
  ZapIcon,
} from "lucide-react"
import {
  DEFAULT_MODEL_CONFIGURATION,
  modelConfigurationLabel,
  selectableModels,
} from "@agentonic/contracts/models"
import {
  autonomyLabels,
  cadenceDescription,
  cadenceLabels,
  runReasonLabels,
  scheduleCommandErrors,
  scheduleForm,
  scheduleState,
  scheduleWrites,
  weekdayLabels,
  type Schedule,
  type ScheduleForm,
  type ScheduleState,
} from "@agentonic/contracts/schedules"
import type { ActionResult } from "@agentonic/contracts/identity"
import { AgentSettingsCard } from "@workspace/ui/components/agent-settings-card"
import { Button } from "@workspace/ui/components/button"
import { CardEmptyState } from "@workspace/ui/components/card-empty-state"
import { ConsentCheckbox } from "@workspace/ui/components/consent-checkbox"
import { DataTable } from "@workspace/ui/components/data-table"
import { DataTableRowActions } from "@workspace/ui/components/data-table-row-actions"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { StatusIndicator } from "@workspace/ui/components/status-badge"
import {
  Absent,
  CellButton,
  sortableHeader,
} from "@workspace/ui/components/table-cells"
import { Textarea } from "@workspace/ui/components/textarea"
import { statusDescriptor } from "@workspace/ui/lib/badge-status"
import { notify } from "@workspace/ui/lib/toast"

async function command(
  workspace: string,
  operation: string,
  payload: Record<string, unknown>
) {
  const response = await fetch(`/api/schedules?workspace=${workspace}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation, payload }),
    cache: "no-store",
  })
  const result = (await response.json()) as Record<string, unknown>
  if (!response.ok)
    throw new Error(String(result.error ?? "No se pudo completar la acción."))
  if (result.ok === false)
    throw new Error(
      scheduleCommandErrors[String(result.code)] ??
        "No se pudo completar la acción."
    )
  return result
}
const configKey = (c: { model: string; reasoning: string | null }) =>
  `${c.model}:${c.reasoning ?? "default"}`
/** A time in the schedule's own timezone: date over time and zone. */
function ZonedTime({ value, zone }: { value: string | null; zone: string }) {
  if (!value) return <Absent>Sin programar</Absent>
  const at = new Date(value)
  const date = new Intl.DateTimeFormat("es-VE", {
    timeZone: zone,
    dateStyle: "short",
  }).format(at)
  const time = new Intl.DateTimeFormat("es-VE", {
    timeZone: zone,
    timeStyle: "short",
  }).format(at)
  return (
    <div className="tabular-nums">
      <p>{date}</p>
      <p className="text-muted-foreground">
        {time} · {zone}
      </p>
    </div>
  )
}
const configurationOptions = (state: ScheduleState) =>
  state.deployment?.models.length
    ? state.deployment.models
    : selectableModels.map((m) => ({ model: m.id, reasoning: m.defaultLevel }))

export function AgentSchedules({
  workspaceId,
  agentId,
  initial,
}: {
  workspaceId: string
  agentId: string
  initial: ScheduleState
}) {
  const [state, setState] = useState(initial)
  const [editing, setEditing] = useState<Schedule | "new" | null>(null)
  const [history, setHistory] = useState<Schedule | null>(null)
  const refresh = useCallback(async () => {
    const result = await command(workspaceId, "state", { agentId })
    setState(scheduleState.parse(result.state))
  }, [workspaceId, agentId])
  // While a run waits or runs, follow it.
  const busy = state.schedules.some((s) =>
    s.runs.some((r) => r.status === "queued" || r.status === "running")
  )
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => void refresh().catch(() => {}), 5000)
    return () => clearInterval(timer)
  }, [busy, refresh])
  async function act(
    operation: string,
    payload: Record<string, unknown>
  ): Promise<ActionResult> {
    try {
      const result = await command(workspaceId, operation, payload)
      await refresh()
      if (operation === "run" && result.status === "skipped")
        return {
          ok: false,
          message: `Ejecución omitida: ${(runReasonLabels[String(result.reason)] ?? "no se pudo ejecutar").toLowerCase()}.`,
        }
      return { ok: true }
    } catch (e) {
      return {
        ok: false,
        message:
          e instanceof Error ? e.message : "No se pudo completar la acción.",
      }
    }
  }
  const columns: ColumnDef<Schedule>[] = [
    {
      accessorKey: "name",
      header: sortableHeader("Nombre"),
      cell: ({ row }) => (
        <CellButton onClick={() => setEditing(row.original)}>
          {row.original.name}
        </CellButton>
      ),
    },
    {
      id: "cadence",
      accessorFn: (s) => cadenceDescription(s),
      header: sortableHeader("Frecuencia"),
    },
    {
      accessorKey: "nextRunAt",
      header: sortableHeader("Próxima", "Próxima ejecución"),
      cell: ({ row }) => (
        <ZonedTime
          value={row.original.nextRunAt}
          zone={row.original.timezone}
        />
      ),
    },
    {
      id: "last",
      accessorFn: (s) => s.runs[0]?.status ?? "",
      header: sortableHeader("Última", "Resultado de la última ejecución"),
      cell: ({ row }) => {
        const run = row.original.runs[0]
        // The outcome opens the run history.
        return run ? (
          <CellButton
            onClick={() => setHistory(row.original)}
            aria-label={`Ver las ejecuciones de ${row.original.name}`}
          >
            <StatusIndicator
              state={statusDescriptor("scheduleRun", run.status)}
            />
          </CellButton>
        ) : (
          <Absent>Sin ejecuciones</Absent>
        )
      },
    },
    {
      id: "autonomy",
      accessorFn: (s) => s.autonomy.map((op) => autonomyLabels[op]).join(", "),
      header: sortableHeader("Automáticas", "Acciones automáticas"),
      cell: ({ row }) =>
        row.original.autonomy.length ? (
          row.original.autonomy.map((op) => autonomyLabels[op]).join(", ")
        ) : (
          <Absent>Ninguna</Absent>
        ),
    },
    {
      accessorKey: "status",
      header: sortableHeader("Estado"),
      cell: ({ row }) => (
        <StatusIndicator
          state={statusDescriptor("schedule", row.original.status)}
          appearance="badge"
        />
      ),
    },
    {
      id: "actions",
      header: () => <span className="sr-only">Acciones</span>,
      cell: ({ row }) => {
        const s = row.original
        return (
          <DataTableRowActions
            actions={[
              {
                label: "Ejecutar ahora",
                icon: <PlayIcon />,
                run: () => act("run", { id: s.id }),
                successMessage:
                  "Ejecución en cola. El resultado aparecerá en su conversación.",
              },
              s.status === "active"
                ? {
                    label: "Pausar",
                    icon: <PauseIcon />,
                    run: () => act("pause", { id: s.id }),
                    successMessage: "Programación en pausa.",
                  }
                : {
                    label: "Reanudar",
                    icon: <PlayIcon />,
                    run: () => act("resume", { id: s.id }),
                    successMessage: "Programación reanudada.",
                  },
              {
                label: "Eliminar",
                icon: <Trash2Icon />,
                destructive: true,
                run: () => act("delete", { id: s.id }),
                successMessage: "Programación eliminada.",
                confirm: {
                  title: "Eliminar programación",
                  description:
                    "No se ejecutará más y se cancelarán las acciones automáticas que aún no hayan empezado. Su historial y conversaciones se conservan.",
                  confirmLabel: "Eliminar programación",
                },
              },
            ]}
          />
        )
      },
    },
  ]
  return (
    <AgentSettingsCard
      title="Programaciones"
      icon={<CalendarClockIcon />}
      description="El agente recibe la instrucción de cada programación a su hora, en una conversación propia que verás en Chats."
      action={
        <Button type="button" onClick={() => setEditing("new")}>
          <PlusIcon aria-hidden="true" />
          Nueva programación
        </Button>
      }
      footer="Las ejecuciones usan la versión en funcionamiento que tú autorizaste y su presupuesto. Si no hay una versión en funcionamiento, se omiten. Las acciones automáticas se ejecutan sin pedirte confirmación, una por ejecución; las demás quedan pendientes en la conversación."
    >
      <div className="space-y-4">
        {!state.deployment && (
          <CardEmptyState title="Sin versión en funcionamiento">
            Las programaciones se omitirán hasta que actives una versión de este
            agente en Activación.
          </CardEmptyState>
        )}
        {state.schedules.length ? (
          <DataTable
            data={state.schedules}
            columns={columns}
            searchKeys={["name", "instruction"]}
            searchLabel="Buscar programaciones"
            getRowId={(s) => s.id}
          />
        ) : (
          <CardEmptyState title="Sin programaciones">
            Crea una para que el agente haga una tarea por su cuenta, por
            ejemplo resumir tu correo cada mañana.
          </CardEmptyState>
        )}
      </div>
      {editing && (
        <ScheduleDialog
          key={editing === "new" ? "new" : editing.id}
          schedule={editing === "new" ? null : editing}
          state={state}
          onClose={() => setEditing(null)}
          onSave={async (values) => {
            const result =
              editing === "new"
                ? await act("create", {
                    ...values,
                    agentId,
                    requestId: crypto.randomUUID(),
                  })
                : await act("update", { ...values, id: editing.id })
            if (result.ok) {
              notify.success(
                editing === "new"
                  ? "Programación creada."
                  : "Programación guardada."
              )
              setEditing(null)
            } else notify.destructive(result.message)
          }}
        />
      )}
      {history && (
        <RunsDialog
          schedule={state.schedules.find((s) => s.id === history.id) ?? history}
          workspaceId={workspaceId}
          onClose={() => setHistory(null)}
        />
      )}
    </AgentSettingsCard>
  )
}

function ScheduleDialog({
  schedule,
  state,
  onClose,
  onSave,
}: {
  schedule: Schedule | null
  state: ScheduleState
  onClose: () => void
  onSave: (values: ScheduleForm) => Promise<void>
}) {
  const options = configurationOptions(state)
  const fallback =
    options.find(
      (o) =>
        configKey(o) ===
        configKey(DEFAULT_MODEL_CONFIGURATION)
    ) ?? options[0]!
  const form = useForm<ScheduleForm>({
    resolver: zodResolver(scheduleForm),
    mode: "onChange",
    defaultValues: schedule
      ? {
          name: schedule.name,
          instruction: schedule.instruction,
          cadence: schedule.cadence,
          timeOfDay: schedule.timeOfDay,
          weekday: schedule.weekday,
          everyHours: schedule.everyHours,
          timezone: schedule.timezone,
          model: schedule.model,
          reasoning: schedule.reasoning,
          autonomy: schedule.autonomy,
          consent: false,
        }
      : {
          name: "",
          instruction: "",
          cadence: "weekdays",
          timeOfDay: "08:00",
          weekday: null,
          everyHours: null,
          timezone: state.timezone,
          model: fallback.model,
          reasoning: fallback.reasoning,
          autonomy: [],
          consent: false,
        },
  })
  const {
    control,
    register,
    handleSubmit,
    setValue,
    formState: { errors, isValid, isSubmitting },
  } = form
  const cadence = useWatch({ control, name: "cadence" })
  const autonomy = useWatch({ control, name: "autonomy" })
  const model = useWatch({ control, name: "model" })
  const reasoning = useWatch({ control, name: "reasoning" })
  const writes = state.deployment?.writes ?? []
  const zones =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : [state.timezone]
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {schedule ? "Editar programación" : "Nueva programación"}
          </DialogTitle>
          <DialogDescription>
            En cada ejecución, el agente recibe tu instrucción como mensaje y
            trabaja sin que nadie esté presente para responder preguntas.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={handleSubmit(async (values) => onSave(values))}
        >
          <Field data-invalid={!!errors.name}>
            <FieldLabel htmlFor="schedule-name">Nombre</FieldLabel>
            <Input id="schedule-name" maxLength={60} {...register("name")} />
            <FieldError errors={[errors.name]} />
          </Field>
          <Field data-invalid={!!errors.instruction}>
            <FieldLabel htmlFor="schedule-instruction">
              Qué debe hacer el agente
            </FieldLabel>
            <Textarea
              id="schedule-instruction"
              maxLength={600}
              placeholder="Por ejemplo: resume los correos sin leer de ayer y envíame el resumen."
              {...register("instruction")}
            />
            <FieldError errors={[errors.instruction]} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field>
              <FieldLabel>Frecuencia</FieldLabel>
              <Controller
                control={control}
                name="cadence"
                render={({ field }) => (
                  <Select
                    items={Object.entries(cadenceLabels).map(
                      ([value, label]) => ({ value, label })
                    )}
                    value={field.value}
                    onValueChange={(value) => {
                      if (!value || value === field.value) return
                      field.onChange(value)
                      setValue("weekday", value === "weekly" ? 1 : null, {
                        shouldValidate: true,
                      })
                      setValue("everyHours", value === "hours" ? 6 : null, {
                        shouldValidate: true,
                      })
                    }}
                  >
                    <SelectTrigger aria-label="Frecuencia">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="w-auto max-w-(--available-width) min-w-(--anchor-width)">
                      {Object.entries(cadenceLabels).map(([value, label]) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
            {cadence === "weekly" && (
              <Field data-invalid={!!errors.weekday}>
                <FieldLabel>Día</FieldLabel>
                <Controller
                  control={control}
                  name="weekday"
                  render={({ field }) => (
                    <Select
                      items={Object.entries(weekdayLabels).map(
                        ([value, label]) => ({ value, label })
                      )}
                      value={String(field.value ?? 1)}
                      onValueChange={(value) => {
                        if (value && Number(value) !== field.value)
                          field.onChange(Number(value))
                      }}
                    >
                      <SelectTrigger aria-label="Día de la semana">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(weekdayLabels).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
              </Field>
            )}
            {cadence === "hours" && (
              <Field data-invalid={!!errors.everyHours}>
                <FieldLabel htmlFor="schedule-hours">Cada (horas)</FieldLabel>
                <Input
                  id="schedule-hours"
                  type="number"
                  min={1}
                  max={24}
                  {...register("everyHours", { valueAsNumber: true })}
                />
                <FieldError errors={[errors.everyHours]} />
              </Field>
            )}
            <Field data-invalid={!!errors.timeOfDay}>
              <FieldLabel htmlFor="schedule-time">
                {cadence === "hours" ? "Desde las" : "Hora"}
              </FieldLabel>
              <Input
                id="schedule-time"
                type="time"
                step={60}
                {...register("timeOfDay")}
              />
              <FieldError errors={[errors.timeOfDay]} />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field data-invalid={!!errors.timezone}>
              <FieldLabel htmlFor="schedule-zone">Zona horaria</FieldLabel>
              <Input
                id="schedule-zone"
                list="schedule-zones"
                {...register("timezone")}
              />
              <datalist id="schedule-zones">
                {zones.map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
              <FieldError errors={[errors.timezone]} />
            </Field>
            <Field data-invalid={!!errors.model}>
              <FieldLabel>Modelo</FieldLabel>
              <Select
                items={options.map((o) => ({
                  value: configKey(o),
                  label: modelConfigurationLabel(o),
                }))}
                value={configKey({ model, reasoning })}
                onValueChange={(value) => {
                  const chosen = options.find(
                    (o) => configKey(o) === value
                  )
                  if (
                    !chosen ||
                    value === configKey({ model, reasoning })
                  )
                    return
                  setValue("model", chosen.model, { shouldValidate: true })
                  setValue("reasoning", chosen.reasoning, {
                    shouldValidate: true,
                  })
                }}
              >
                <SelectTrigger aria-label="Modelo">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="w-auto max-w-(--available-width) min-w-(--anchor-width)">
                  {options.map((o) => (
                    <SelectItem
                      key={configKey(o)}
                      value={configKey(o)}
                    >
                      {modelConfigurationLabel(o)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                {state.deployment
                  ? "Los modelos que superaron la evaluación de la versión en funcionamiento."
                  : "Si la versión que actives no lo admite, se usará su primer modelo."}
              </FieldDescription>
            </Field>
          </div>
          <fieldset className="grid gap-3 rounded-lg border border-dashed p-4">
            <legend className="flex items-center gap-1.5 px-1 text-sm font-medium">
              <ZapIcon className="size-4" aria-hidden="true" />
              Acciones automáticas
            </legend>
            <p className="text-sm text-muted-foreground">
              Elige qué puede hacer el agente sin pedirte confirmación, una
              acción por ejecución y a cualquier destinatario que el agente
              elija. Lo demás queda pendiente en la conversación hasta que lo
              confirmes. Puedes cancelar una acción automática desde la
              conversación mientras no haya empezado.
            </p>
            <Controller
              control={control}
              name="autonomy"
              render={({ field }) => (
                <div className="grid gap-2 sm:grid-cols-2">
                  {scheduleWrites.map((op) => {
                    const granted = writes.includes(op)
                    const checked = field.value.includes(op)
                    return (
                      <label
                        key={op}
                        className="flex items-start gap-3 rounded-lg border p-3 text-sm has-[[data-disabled]]:opacity-60"
                      >
                        <Checkbox.Root
                          checked={checked}
                          disabled={!granted && !checked}
                          onCheckedChange={(value) => {
                            field.onChange(
                              value
                                ? [...field.value, op]
                                : field.value.filter((o) => o !== op)
                            )
                            setValue("consent", false, {
                              shouldValidate: true,
                            })
                          }}
                          className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border data-checked:bg-primary data-checked:text-primary-foreground"
                        >
                          <Checkbox.Indicator>
                            <CheckIcon className="size-3" />
                          </Checkbox.Indicator>
                        </Checkbox.Root>
                        <span>
                          {autonomyLabels[op]}
                          {!granted && (
                            <span className="block text-xs text-muted-foreground">
                              La versión en funcionamiento no tiene este
                              permiso.
                            </span>
                          )}
                        </span>
                      </label>
                    )
                  })}
                </div>
              )}
            />
            {autonomy.length > 0 && (
              <Controller
                control={control}
                name="consent"
                render={({ field }) => (
                  <ConsentCheckbox
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  >
                    Autorizo que esta programación ejecute{" "}
                    {autonomy
                      .map((op) => autonomyLabels[op]?.toLowerCase())
                      .join(", ")}{" "}
                    sin pedirme confirmación, una vez por ejecución.
                  </ConsentCheckbox>
                )}
              />
            )}
            <FieldError errors={[errors.consent]} />
          </fieldset>
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={!isValid || isSubmitting}>
              {isSubmitting
                ? "Guardando…"
                : schedule
                  ? "Guardar programación"
                  : "Crear programación"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RunsDialog({
  schedule,
  workspaceId,
  onClose,
}: {
  schedule: Schedule
  workspaceId: string
  onClose: () => void
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{schedule.name}</DialogTitle>
          <DialogDescription>
            {cadenceDescription(schedule)} · Últimas 10 ejecuciones.
          </DialogDescription>
        </DialogHeader>
        {schedule.runs.length ? (
          <ol className="divide-y">
            {schedule.runs.map((run) => (
              <li
                key={run.id}
                className="flex flex-wrap items-start gap-x-4 gap-y-1 py-3 text-sm"
              >
                <div className="min-w-40">
                  <ZonedTime value={run.createdAt} zone={schedule.timezone} />
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <StatusIndicator
                    state={statusDescriptor("scheduleRun", run.status)}
                  />
                  {run.manual && (
                    <p className="text-muted-foreground">Ejecutada a mano</p>
                  )}
                  {run.reason && (
                    <p className="text-muted-foreground">
                      {runReasonLabels[run.reason] ?? run.reason}
                    </p>
                  )}
                  {run.actions.map((action, n) => (
                    <p key={n} className="text-muted-foreground">
                      {autonomyLabels[action.operation] ?? action.operation} ·{" "}
                      {action.automatic ? "automática" : "pendiente de ti"} ·{" "}
                      {action.status === "succeeded"
                        ? "realizada"
                        : action.status === "pending"
                          ? "sin realizar"
                          : action.status}
                    </p>
                  ))}
                </div>
                {run.conversationId && (
                  <Button
                    variant="link"
                    className="h-auto p-0"
                    nativeButton={false}
                    render={
                      <a
                        href={`/chats?workspace=${workspaceId}&conversation=${run.conversationId}`}
                      />
                    }
                  >
                    Abrir conversación
                  </Button>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <CardEmptyState title="Sin ejecuciones">
            La primera ejecución aparecerá aquí a su hora, o cuando uses
            Ejecutar ahora.
          </CardEmptyState>
        )}
      </DialogContent>
    </Dialog>
  )
}
