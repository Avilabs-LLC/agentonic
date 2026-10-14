"use client"
import {
  formatUsd,
  formatUtcDateTime,
  formatUtcMinute,
} from "@agentonic/contracts/format"
import {
  customerAvailability,
  customerEnvironmentLabels,
  deploymentDisplayStatus,
} from "@agentonic/contracts/availability"
import { useEffect, useId, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  RocketIcon,
  RefreshCwIcon,
  Loader2Icon,
  PackageIcon,
} from "lucide-react"
import {
  PERIOD_BUDGET,
  approvalLabels,
  deploymentLabels,
  environmentLabels,
  renewalBlockedLabels,
  type LifecycleState,
} from "@agentonic/contracts/lifecycle"
import { iconTones } from "@workspace/ui/components/status-badge"
import { cn } from "cn"
import type { FormResult } from "@agentonic/contracts/authoring"
import { AgentSettingsCard } from "@workspace/ui/components/agent-settings-card"
import { CardEmptyState } from "@workspace/ui/components/card-empty-state"
import { IconTile } from "@workspace/ui/components/icon-tile"
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
  audience,
  now,
}: {
  state: LifecycleState
  workspaceId: string
  submissionId?: string
  action: (input: unknown) => Promise<FormResult>
  // Customers read availability in plain language; staff keep operational terms.
  audience: "customer" | "staff"
  // Server render time, so expiry checks match between server and browser.
  now: string
}) {
  const customer = audience === "customer"
  const places = customer ? customerEnvironmentLabels : environmentLabels
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
    [autoRenew, setAutoRenew] = useState(true),
    [renewalFor, setRenewalFor] = useState<
      (typeof state.deployments)[number] | null
    >(null),
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
  // Approval renewal keeps its review ceiling; a deployment budgets each
  // 30-day period (§59).
  const bounds =
    form?.operation === "authorize"
      ? { min: PERIOD_BUDGET.min, max: PERIOD_BUDGET.max, step: "1" }
      : { min: 0.05, max: 1, step: "0.05" }
  function open(operation: "renew" | "authorize", id: string) {
    setError("")
    setConsent(false)
    setAutoRenew(true)
    setBudget(
      operation === "authorize" ? String(PERIOD_BUDGET.default) : "0.25"
    )
    setForm({ operation, submissionId: id, requestId: crypto.randomUUID() })
  }
  return (
    <div className="space-y-6">
      <AgentSettingsCard
        title="Aprobación y activación"
        icon={<RocketIcon />}
        description={
          customer
            ? "La aprobación, tu autorización de uso y la activación tienen estados independientes."
            : "La revisión, la autorización para activar y el despliegue tienen estados independientes."
        }
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
                    <IconTile tone="emerald">
                      <PackageIcon aria-hidden="true" />
                    </IconTile>
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
                      {customer && s.reason === "valid"
                        ? `Puedes autorizar su uso hasta el ${formatUtcMinute(s.expiresAt)}; el equipo de Agentonic debe activarlo antes de esa fecha.`
                        : customer
                          ? `Plazo para activar: ${formatUtcMinute(s.expiresAt)}.`
                          : `Plazo para activar: ${formatUtcDateTime(s.expiresAt)} UTC.`}
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
        title={customer ? "Uso en pruebas" : "Despliegues de pruebas"}
        icon={<RocketIcon />}
        description="Uso privado y de solo lectura. La autorización dura 30 días y se renueva sola mientras nada cambie; cada período tiene su propio presupuesto."
      >
        {!deployments.length ? (
          customer ? (
            <CardEmptyState title="Sin uso en pruebas">
              Autoriza el uso de una versión aprobada y el equipo de Agentonic
              la activará.
            </CardEmptyState>
          ) : (
            <CardEmptyState title="Sin despliegues de pruebas">
              El cliente debe autorizar el uso de pruebas y el equipo debe
              activar la versión.
            </CardEmptyState>
          )
        ) : (
          <div className="space-y-5">
            {deployments.map((d) => {
              const status = deploymentDisplayStatus(d)
              return (
                <div
                  key={d.id}
                  className="space-y-3 border-b pb-5 last:border-0 last:pb-0"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                      {places[d.environment]}
                    </p>
                    <Badge variant={deploymentBadgeVariants[status] ?? "slate"}>
                      {status === "unauthorized"
                        ? "Autorización no vigente"
                        : deploymentLabels[status]}
                    </Badge>
                  </div>
                  {customer ? (
                    <div className="space-y-1">
                      <p className="text-sm">
                        {customerAvailability(d, state, new Date(now))}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {/* The limit in force this period, which can differ
                            from the budget set for the next one (§80). */}
                        {d.periodBudgetUsd != null
                          ? `Este período: ${formatUsd(d.periodCommittedMicrousd / 1e6)} de ${formatUsd(d.budgetUsd - (d.committedMicrousd - d.periodCommittedMicrousd) / 1e6)}.`
                          : `Consumo: ${formatUsd(d.committedMicrousd / 1e6)} de ${formatUsd(d.budgetUsd)} autorizados.`}
                      </p>
                      <RenewalLine deployment={d} />
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">
                        Uso y reservas: {formatUsd(d.committedMicrousd / 1e6)}{" "}
                        de {formatUsd(d.budgetUsd)} · Hasta{" "}
                        {formatUtcDateTime(d.expiresAt)} UTC.
                      </p>
                      <RenewalLine deployment={d} />
                    </div>
                  )}
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
                    {d.canRenewNow && (
                      <Button
                        variant="outline"
                        disabled={pending}
                        onClick={() =>
                          run({
                            operation: "extend",
                            payload: { deploymentId: d.id },
                          })
                        }
                      >
                        Renovar ahora
                      </Button>
                    )}
                    {d.canChangeRenewal && (
                      <Button
                        variant="outline"
                        disabled={pending}
                        onClick={() => {
                          setError("")
                          setAutoRenew(d.autoRenew)
                          setBudget(
                            String(d.periodBudgetUsd ?? PERIOD_BUDGET.default)
                          )
                          setRenewalFor(d)
                        }}
                      >
                        Ajustar renovación
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
                : "Autoriza el uso privado de esta versión y su conocimiento durante 30 días, con un presupuesto por período. Si nada cambia, la autorización se renueva sola cada 30 días; puedes desactivarlo o detener el agente en cualquier momento. El equipo activará el agente."}
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
                  items={places}
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
                        {places[value]}
                        {!state.hosts.some(
                          (h) => h.environment === value && h.available
                        )
                          ? customer
                            ? " · No disponible por ahora"
                            : " · No disponible"
                          : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor={`${fieldId}-budget`}>
                {form?.operation === "authorize"
                  ? "Presupuesto por período de 30 días (USD)"
                  : "Límite total autorizado (USD)"}
              </FieldLabel>
              <Input
                id={`${fieldId}-budget`}
                type="number"
                min={bounds.min}
                max={bounds.max}
                step={bounds.step}
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
            </Field>
            {form?.operation === "authorize" && (
              <ConsentCheckbox
                checked={autoRenew}
                onCheckedChange={setAutoRenew}
                disabled={pending}
              >
                Renovar automáticamente cada 30 días mientras nada cambie en la
                versión, sus documentos o mis permisos.
              </ConsentCheckbox>
            )}
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
                Number(budget) < bounds.min ||
                Number(budget) > bounds.max ||
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
                    ...(form.operation === "authorize"
                      ? { environment, autoRenew }
                      : {}),
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
      <Dialog
        open={!!renewalFor}
        onOpenChange={(open) => {
          if (!pending && !open) setRenewalFor(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Renovación</DialogTitle>
            <DialogDescription>
              Mientras nada cambie, la autorización se renueva sola 3 días antes
              de terminar, por 30 días más y con este presupuesto. Si lo
              aumentas, el nuevo presupuesto se aplica también al período
              actual; si lo reduces, desde la próxima renovación.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            <ConsentCheckbox
              checked={autoRenew}
              onCheckedChange={setAutoRenew}
              disabled={pending}
            >
              Renovar automáticamente cada 30 días.
            </ConsentCheckbox>
            <Field>
              <FieldLabel htmlFor={`${fieldId}-period-budget`}>
                Presupuesto por período de 30 días (USD)
              </FieldLabel>
              <Input
                id={`${fieldId}-period-budget`}
                type="number"
                min={PERIOD_BUDGET.min}
                max={PERIOD_BUDGET.max}
                step="1"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
            </Field>
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
              onClick={() => setRenewalFor(null)}
            >
              Cancelar
            </Button>
            <Button
              disabled={
                pending ||
                !Number.isFinite(Number(budget)) ||
                Number(budget) < PERIOD_BUDGET.min ||
                Number(budget) > PERIOD_BUDGET.max
              }
              onClick={() => {
                if (!renewalFor) return
                run({
                  operation: "renewal",
                  payload: {
                    deploymentId: renewalFor.id,
                    autoRenew,
                    budgetUsd: Number(budget),
                  },
                })
                setRenewalFor(null)
              }}
            >
              {pending && <Loader2Icon className="animate-spin" />}
              Guardar renovación
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
/** Whether and when a deployment renews, or what stops it (§59). */
export function RenewalLine({
  deployment: d,
}: {
  deployment: LifecycleState["deployments"][number]
}) {
  if (
    !["awaiting_activation", "queued", "preparing", "running"].includes(
      d.status
    )
  )
    return null
  if (d.renewalBlocked)
    return (
      <p className={cn("text-xs", iconTones.warning)}>
        No se renovará:{" "}
        {renewalBlockedLabels[d.renewalBlocked] ?? renewalBlockedLabels.changed}
      </p>
    )
  return (
    <p className="text-xs text-muted-foreground">
      {d.autoRenew && d.renewsAt
        ? `Se renovará automáticamente el ${formatUtcDateTime(d.renewsAt)} UTC por 30 días más${d.periodBudgetUsd != null ? `, con ${formatUsd(d.periodBudgetUsd)} por período` : ""}.`
        : d.autoRenew
          ? "Se renovará automáticamente cada 30 días mientras nada cambie."
          : `No se renovará automáticamente; termina el ${formatUtcDateTime(d.expiresAt)} UTC.`}
    </p>
  )
}
