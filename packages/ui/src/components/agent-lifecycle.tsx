"use client"
import { formatUtcDateTime } from "@agentonic/contracts/format"
import { useEffect, useId, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  RocketIcon,
  RefreshCwIcon,
  Loader2Icon,
  PackageIcon,
} from "lucide-react"
import {
  approvalLabels,
  deploymentLabels,
  environmentLabels,
  type LifecycleState,
} from "@agentonic/contracts/lifecycle"
import type { FormResult } from "@agentonic/contracts/authoring"
import { AgentSettingsCard } from "@workspace/ui/components/agent-settings-card"
import { CardEmptyState } from "@workspace/ui/components/card-empty-state"
import {
  approvalBadgeVariants,
  deploymentBadgeVariants,
} from "@workspace/ui/lib/badge-status"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { ConsentCheckbox } from "@workspace/ui/components/consent-checkbox"
import { Field, FieldLabel } from "@workspace/ui/components/field"
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@workspace/ui/components/select"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@workspace/ui/components/dialog"
import { notify } from "@workspace/ui/lib/toast"
export function AgentLifecycle({
  state,
  workspaceId,
  submissionId,
  action,
}: {
  state: LifecycleState
  workspaceId: string
  submissionId?: string
  action: (input: unknown) => Promise<FormResult>
}) {
  const router = useRouter(),
    fieldId = useId()
  const [pending, startTransition] = useTransition()
  const [form, setForm] = useState<{
    operation: "renew" | "authorize"
    submissionId: string
    requestId: string
  } | null>(null)
  const [consent, setConsent] = useState(false),
    [budget, setBudget] = useState("0.25"),
    [environment, setEnvironment] = useState<"local" | "azure_staging">(
      "azure_staging"
    ),
    [error, setError] = useState("")
  const submissions = state.submissions.filter(
    (s) => !submissionId || s.id === submissionId
  )
  const deployments = state.deployments.filter(
    (d) => !submissionId || d.submissionId === submissionId
  )
  useEffect(() => {
    const timer = setInterval(() => {
      if (!pending && !form) router.refresh()
    }, 10000)
    return () => clearInterval(timer)
  }, [router, pending, form])
  function run(input: unknown) {
    setError("")
    startTransition(async () => {
      try {
        const result = await action(input)
        if (!result.ok) {
          setError(result.message)
          return
        }
        notify.success(result.message)
        const renewing = form?.operation === "renew"
        setForm(null)
        router.refresh()
        if (renewing) {
          const url = new URL(window.location.href)
          url.searchParams.set("tab", "propuestas")
          router.replace(url.pathname + url.search)
        }
      } catch {
        setError("No se pudo completar la acción. Inténtalo de nuevo.")
      }
    })
  }
  function open(operation: "renew" | "authorize", id: string) {
    setError("")
    setConsent(false)
    setBudget("0.25")
    setForm({ operation, submissionId: id, requestId: crypto.randomUUID() })
  }
  return (
    <div className="space-y-6">
      <AgentSettingsCard
        title="Aprobación y activación"
        icon={<RocketIcon />}
        description="La revisión, la autorización para activar y el despliegue tienen estados independientes."
      >
        {submissions.length === 0 ? (
          <CardEmptyState title="Sin versiones para activar">
            Envía una versión a revisión para poder activarla.
          </CardEmptyState>
        ) : (
          <div className="space-y-5">
            {submissions.map((s) => (
              <div
                key={s.id}
                className="overflow-hidden rounded-lg border bg-muted/20"
              >
                <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
                  <div className="flex items-center gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-md border border-emerald-200 bg-emerald-100 text-emerald-800 shadow-xs dark:border-emerald-400/25 dark:bg-emerald-400/15 dark:text-emerald-300">
                      <PackageIcon className="size-5" aria-hidden="true" />
                    </div>
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">
                        Versión {s.versionNumber}
                      </p>
                      <p className="font-mono text-xs text-muted-foreground">
                        Revisión {s.number}
                      </p>
                    </div>
                  </div>
                  <Badge variant={approvalBadgeVariants[s.reason]}>
                    {approvalLabels[s.reason]}
                  </Badge>
                </div>
                <div className="space-y-3 p-4">
                  {s.reason === "unapproved" && (
                    <p className="text-sm text-muted-foreground">
                      Esta revisión todavía no tiene una aprobación. Consulta
                      los criterios, el progreso y los resultados en{" "}
                      {submissionId ? "Revisiones" : "Propuestas"}. La versión
                      podrá activarse cuando obtenga una aprobación vigente.
                    </p>
                  )}
                  {s.expiresAt && (
                    <p className="text-xs text-muted-foreground">
                      Plazo para activar: {formatUtcDateTime(s.expiresAt)} UTC.
                    </p>
                  )}
                  {s.renewedSubmissionId ? (
                    <p className="text-sm text-muted-foreground">
                      Esta revisión conserva su historial. Ya se abrió una nueva
                      revisión de la misma versión.
                    </p>
                  ) : (
                    <>
                      {s.renewalRequested && (
                        <p className="text-sm">
                          El equipo solicitó renovar la aprobación. Autoriza una
                          nueva evaluación para continuar.
                        </p>
                      )}
                      <div className="flex flex-wrap gap-2">
                        {s.canRequestRenewal && (
                          <Button
                            variant="outline"
                            disabled={pending || s.renewalRequested}
                            onClick={() =>
                              run({
                                operation: "request",
                                payload: { submissionId: s.id },
                              })
                            }
                          >
                            <RefreshCwIcon />
                            {s.renewalRequested
                              ? "Renovación solicitada"
                              : "Solicitar renovación"}
                          </Button>
                        )}
                        {s.canRenew && (
                          <Button
                            variant="outline"
                            disabled={pending}
                            onClick={() => open("renew", s.id)}
                          >
                            <RefreshCwIcon />
                            Renovar aprobación
                          </Button>
                        )}
                        {s.canAuthorize && (
                          <Button
                            disabled={pending}
                            onClick={() => open("authorize", s.id)}
                          >
                            <RocketIcon />
                            Autorizar activación
                          </Button>
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </AgentSettingsCard>
      <AgentSettingsCard
        title="Despliegues de pruebas"
        icon={<RocketIcon />}
        description="Uso privado y de solo lectura. La autorización dura hasta siete días y conserva su propio límite de consumo."
      >
        {!deployments.length ? (
          <CardEmptyState title="Sin despliegues de pruebas">
            El cliente debe autorizar el uso de pruebas y el equipo debe activar
            la versión.
          </CardEmptyState>
        ) : (
          <div className="space-y-5">
            {deployments.map((d) => {
              const status =
                !d.authorized &&
                [
                  "running",
                  "awaiting_activation",
                  "queued",
                  "preparing",
                ].includes(d.status)
                  ? "unauthorized"
                  : d.status === "running" && !d.online
                    ? "offline"
                    : d.status
              return (
                <div
                  key={d.id}
                  className="space-y-3 border-b pb-5 last:border-0 last:pb-0"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                      {environmentLabels[d.environment]}
                    </p>
                    <Badge variant={deploymentBadgeVariants[status] ?? "slate"}>
                      {status === "unauthorized"
                        ? "Autorización no vigente"
                        : deploymentLabels[status]}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Uso y reservas: USD {(d.committedMicrousd / 1e6).toFixed(4)}{" "}
                    de USD {d.budgetUsd.toFixed(2)} · Hasta{" "}
                    {formatUtcDateTime(d.expiresAt)} UTC.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {d.canActivate && (
                      <Button
                        disabled={pending}
                        onClick={() =>
                          run({
                            operation: "activate",
                            payload: { deploymentId: d.id },
                          })
                        }
                      >
                        Activar versión
                      </Button>
                    )}
                    {d.canChat && (
                      <Button
                        variant="outline"
                        onClick={() =>
                          router.push(
                            `/chats?workspace=${workspaceId}&deployment=${d.id}`
                          )
                        }
                      >
                        Abrir chat
                      </Button>
                    )}
                    {d.canStop && (
                      <Button
                        variant="outline"
                        disabled={pending}
                        onClick={() =>
                          run({
                            operation: "stop",
                            payload: { deploymentId: d.id },
                          })
                        }
                      >
                        Detener
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </AgentSettingsCard>
      {!form && error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Dialog
        open={!!form}
        onOpenChange={(open) => {
          if (!pending && !open) setForm(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {form?.operation === "renew"
                ? "Renovar aprobación"
                : "Autorizar activación de pruebas"}
            </DialogTitle>
            <DialogDescription>
              {form?.operation === "renew"
                ? "Se abrirá una nueva revisión de esta misma versión. Se prepararán criterios para que los revises y confirmes antes de evaluar. La aprobación anterior se conserva."
                : "Autoriza el uso privado de esta versión y su conocimiento durante un máximo de siete días. El equipo activará el agente; podrás detenerlo en cualquier momento."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            {form?.operation === "authorize" && (
              <Field>
                <FieldLabel htmlFor={`${fieldId}-environment`}>
                  Lugar de ejecución
                </FieldLabel>
                <Select
                  value={environment}
                  onValueChange={(value) =>
                    setEnvironment(value as typeof environment)
                  }
                >
                  <SelectTrigger id={`${fieldId}-environment`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(["azure_staging", "local"] as const).map((value) => (
                      <SelectItem
                        key={value}
                        value={value}
                        disabled={
                          !state.hosts.some(
                            (h) => h.environment === value && h.available
                          )
                        }
                      >
                        {environmentLabels[value]}
                        {!state.hosts.some(
                          (h) => h.environment === value && h.available
                        )
                          ? " · No disponible"
                          : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor={`${fieldId}-budget`}>
                Límite total autorizado (USD)
              </FieldLabel>
              <Input
                id={`${fieldId}-budget`}
                type="number"
                min="0.05"
                max="1"
                step="0.05"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
            </Field>
            <ConsentCheckbox
              checked={consent}
              onCheckedChange={setConsent}
              disabled={pending}
            >
              {form?.operation === "renew"
                ? "Autorizo la revisión de esta versión y la preparación con IA dentro del límite indicado."
                : "Autorizo las conversaciones de pruebas y la consulta de las fuentes de esta versión dentro del límite indicado."}
            </ConsentCheckbox>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => setForm(null)}
            >
              Cancelar
            </Button>
            <Button
              disabled={
                pending ||
                !consent ||
                Number(budget) < 0.05 ||
                Number(budget) > 1 ||
                !Number.isFinite(Number(budget)) ||
                (form?.operation === "authorize" &&
                  !state.hosts.some(
                    (h) => h.environment === environment && h.available
                  ))
              }
              onClick={() =>
                form &&
                run({
                  operation: form.operation,
                  payload: {
                    submissionId: form.submissionId,
                    requestId: form.requestId,
                    budgetUsd: Number(budget),
                    consent: true,
                    ...(form.operation === "authorize" ? { environment } : {}),
                  },
                })
              }
            >
              {pending && <Loader2Icon className="animate-spin" />}
              {form?.operation === "renew"
                ? "Iniciar renovación"
                : "Autorizar uso de pruebas"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
