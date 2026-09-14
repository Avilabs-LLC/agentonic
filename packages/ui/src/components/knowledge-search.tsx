"use client"
import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Controller, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import {
  retrievalResult,
  processingErrors,
  type RetrievalResult,
} from "@agentonic/contracts/rag"
import { AgentSettingsCard } from "@workspace/ui/components/agent-settings-card"
import { Field, FieldLabel, FieldError } from "@workspace/ui/components/field"
import { Checkbox } from "@base-ui/react/checkbox"
import { CheckIcon } from "lucide-react"
import { Input } from "@workspace/ui/components/input"
import { Button } from "@workspace/ui/components/button"
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectValue,
  SelectItem,
} from "@workspace/ui/components/select"
import { notify } from "@workspace/ui/lib/toast"
const schema = z.object({
  query: z
    .string()
    .trim()
    .min(1, "Escribe una pregunta.")
    .max(1000, "Usa hasta 1000 caracteres."),
  collection: z.uuid("Selecciona una colección."),
  generateAnswer: z.boolean(),
})
export function KnowledgeRefresh({ active }: { active: boolean }) {
  const router = useRouter()
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => router.refresh(), 10000)
    return () => clearInterval(timer)
  }, [active, router])
  return null
}
export function KnowledgeSearch({
  workspaceId,
  collections,
}: {
  workspaceId: string
  collections: { id: string; name: string }[]
}) {
  const [result, setResult] = useState<RetrievalResult | null>(null),
    [error, setError] = useState("")
  const active = useRef<AbortController | null>(null)
  useEffect(() => () => active.current?.abort(), [])
  const {
    register,
    control,
    handleSubmit,
    formState: { errors, isValid, isSubmitting },
  } = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    mode: "onChange",
    defaultValues: {
      query: "",
      collection: collections[0]?.id ?? "",
      generateAnswer: false,
    },
  })
  async function search(values: z.infer<typeof schema>) {
    const controller = new AbortController()
    active.current?.abort()
    active.current = controller
    setResult(null)
    setError("")
    async function command(input: unknown) {
      const response = await fetch(
        `/api/knowledge/search?workspace=${workspaceId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal: controller.signal,
          cache: "no-store",
        }
      )
      if (!response.ok)
        throw new Error(
          "No se pudo consultar esta colección. Comprueba tus permisos y conexión."
        )
      return response.json()
    }
    try {
      const job = await command({
        operation: "search",
        payload: {
          query: values.query,
          collectionIds: [values.collection],
          generateAnswer: values.generateAnswer,
        },
      })
      for (let attempt = 0; attempt < 60; attempt++) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            controller.signal.removeEventListener("abort", abort)
            resolve()
          }, 1500)
          const abort = () => {
            clearTimeout(timer)
            reject(new Error("cancelled"))
          }
          controller.signal.addEventListener("abort", abort, { once: true })
        })
        const current = retrievalResult.parse(
          await command({ operation: "result", payload: { id: job.id } })
        )
        if (current.status === "succeeded") {
          setResult(current)
          return
        }
        if (["failed", "cancelled", "unavailable"].includes(current.status))
          throw new Error(
            processingErrors[current.error ?? ""] ??
              "La búsqueda dejó de estar disponible. Comprueba los permisos o vuelve a intentarlo."
          )
      }
      throw new Error(
        "La búsqueda sigue pendiente. Comprueba que el servicio de procesamiento esté activo e inténtalo más tarde."
      )
    } catch (reason) {
      if (controller.signal.aborted) return
      const message =
        reason instanceof Error ? reason.message : "No se pudo buscar."
      setError(message)
      notify.destructive(message)
    }
  }
  return (
    <AgentSettingsCard
      title="Probar conocimiento"
      description="Prueba la búsqueda y las respuestas con fuentes de tus documentos listos."
      footer="Voyage procesa la pregunta para buscar. Al generar una respuesta, OpenAI recibe la pregunta y los fragmentos encontrados. Esta prueba no aplica la personalidad ni las herramientas del agente."
    >
      <form
        noValidate
        onSubmit={(event) => void handleSubmit(search)(event)}
        className="space-y-4"
      >
        <fieldset
          disabled={isSubmitting || !collections.length}
          className="grid gap-4 sm:grid-cols-[1fr_2fr]"
        >
          <Field data-invalid={!!errors.collection}>
            <FieldLabel htmlFor="rag-collection">Colección</FieldLabel>
            <Controller
              name="collection"
              control={control}
              render={({ field }) => (
                <Select
                  value={field.value || null}
                  onValueChange={field.onChange}
                  items={collections.map((c) => ({
                    value: c.id,
                    label: c.name,
                  }))}
                >
                  <SelectTrigger id="rag-collection" className="w-full">
                    <SelectValue placeholder="Selecciona una colección" />
                  </SelectTrigger>
                  <SelectContent>
                    {collections.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            <FieldError errors={[errors.collection]} />
          </Field>
          <Field data-invalid={!!errors.query}>
            <FieldLabel htmlFor="rag-query">Pregunta</FieldLabel>
            <Input
              id="rag-query"
              placeholder="¿Qué cubre la garantía?"
              maxLength={1000}
              {...register("query")}
            />
            <FieldError errors={[errors.query]} />
          </Field>
        </fieldset>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Controller
            name="generateAnswer"
            control={control}
            render={({ field }) => (
              <label className="flex items-center gap-2 text-sm">
                <Checkbox.Root
                  className="flex size-4 shrink-0 items-center justify-center rounded-sm border border-input outline-none focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-primary data-checked:text-primary-foreground"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  disabled={isSubmitting}
                >
                  <Checkbox.Indicator>
                    <CheckIcon className="size-3" />
                  </Checkbox.Indicator>
                </Checkbox.Root>
                Generar respuesta con fuentes
              </label>
            )}
          />
          <Button disabled={!isValid || isSubmitting || !collections.length}>
            {isSubmitting ? "Procesando prueba…" : "Probar conocimiento"}
          </Button>
        </div>
      </form>
      {error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error}
        </p>
      )}
      {result && (
        <div aria-live="polite" className="mt-5 divide-y border-t">
          {result.answer && (
            <div className="space-y-2 py-5">
              <p className="font-medium">
                {result.answer.insufficientEvidence
                  ? "Evidencia insuficiente"
                  : "Respuesta con fuentes"}
              </p>
              <p className="text-sm whitespace-pre-wrap">
                {result.answer.text}
              </p>
              <p className="text-xs text-muted-foreground">
                Fuentes:{" "}
                {result.answer.citations
                  .map(
                    (id) =>
                      `[${result.matches.findIndex((m) => m.id === id) + 1}]`
                  )
                  .join(", ") || "Ninguna"}
              </p>
            </div>
          )}
          {!result.matches.length && (
            <p className="py-5 text-sm text-muted-foreground">
              No se encontraron fragmentos en los documentos listos de esta
              colección.
            </p>
          )}
          {result.matches.map((match, index) => (
            <div key={match.id} className="space-y-2 py-5">
              <p className="text-sm font-medium">
                [{index + 1}] {match.title}
                {match.locator.page ? ` · Página ${match.locator.page}` : ""}
              </p>
              <p className="text-xs text-muted-foreground">
                Versión {match.version}
                {match.locator.section ? ` · ${match.locator.section}` : ""}
              </p>
              <p className="text-sm break-words whitespace-pre-wrap text-muted-foreground">
                {match.text}
              </p>
            </div>
          ))}
        </div>
      )}
    </AgentSettingsCard>
  )
}
