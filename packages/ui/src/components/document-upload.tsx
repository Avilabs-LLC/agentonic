"use client"
import { useId, useState } from "react"
import { useRouter } from "next/navigation"
import { Controller, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import {
  documentUploadFailure,
  documentErrors,
} from "@agentonic/contracts/document-errors"
import { Input } from "@workspace/ui/components/input"
import { Button } from "@workspace/ui/components/button"
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "@workspace/ui/components/field"
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@workspace/ui/components/select"
import { notify } from "@workspace/ui/lib/toast"
const uploadSchema = z.object({
  collectionId: z.uuid("Selecciona una colección."),
  file: z
    .custom<FileList>()
    .refine(
      (files) => Boolean(files?.[0]?.size),
      "Selecciona un archivo con contenido."
    )
    .refine(
      (files) => !files?.[0] || files[0].size <= 10485760,
      documentErrors.too_large
    )
    .refine(
      (files) => !files?.[0] || /\.(pdf|txt|md)$/i.test(files[0].name),
      documentErrors.invalid_file
    ),
})
export function DocumentUpload({
  workspaceId,
  collections,
}: {
  workspaceId: string
  collections: { id: string; name: string }[]
}) {
  const id = useId()
  const [error, setError] = useState("")
  const router = useRouter()
  const {
    register,
    control,
    handleSubmit,
    resetField,
    formState: { errors, isValid, isSubmitting },
  } = useForm<z.infer<typeof uploadSchema>>({
    resolver: zodResolver(uploadSchema),
    mode: "onChange",
    defaultValues: { collectionId: "" },
  })
  function fail(message: string) {
    setError(message)
    notify.destructive(message)
  }
  async function upload(data: z.infer<typeof uploadSchema>) {
    setError("")
    const file = data.file[0]!
    if (!collections.some((c) => c.id === data.collectionId)) {
      fail(documentErrors.collection_required)
      return
    }
    try {
      const response = await fetch(
        `/api/documents?${new URLSearchParams({ workspace: workspaceId, collection: data.collectionId })}`,
        {
          method: "POST",
          headers: { "X-File-Name": encodeURIComponent(file.name) },
          body: file,
        }
      )
      const result = await response.json().catch(() => null)
      if (!response.ok || result?.ok !== true) {
        fail(
          documentUploadFailure(
            result?.code,
            response.status,
            response.headers.get("X-Upload-Reference")
          )
        )
        return
      }
      notify.success("Documento subido. Pendiente de procesamiento.")
      resetField("file")
      router.refresh()
    } catch {
      fail(
        "No se pudo conectar. El archivo sigue seleccionado; comprueba la conexión e inténtalo de nuevo."
      )
    }
  }
  return (
    <form onSubmit={handleSubmit(upload)} noValidate className="space-y-4">
      <fieldset
        disabled={isSubmitting || !collections.length}
        className="space-y-4"
      >
        <Field data-invalid={Boolean(errors.collectionId)}>
          <FieldLabel htmlFor={`${id}-collection`}>Colección</FieldLabel>
          <Controller
            name="collectionId"
            control={control}
            render={({ field }) => (
              <Select
                name={field.name}
                value={field.value || null}
                onValueChange={(value) => field.onChange(value ?? "")}
                items={collections.map((c) => ({ value: c.id, label: c.name }))}
              >
                <SelectTrigger
                  id={`${id}-collection`}
                  className="w-full"
                  aria-invalid={Boolean(errors.collectionId)}
                >
                  <SelectValue placeholder="Seleccionar colección" />
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
          <FieldError errors={[errors.collectionId]} />
        </Field>
        <Field data-invalid={Boolean(errors.file)}>
          <FieldLabel htmlFor={`${id}-file`}>Documento</FieldLabel>
          <Input
            id={`${id}-file`}
            type="file"
            accept=".pdf,.txt,.md"
            aria-invalid={Boolean(errors.file)}
            aria-describedby={`${id}-help ${id}-error`}
            {...register("file")}
          />
          <FieldDescription id={`${id}-help`}>
            PDF, texto UTF-8 o Markdown · Hasta 10 MB. El archivo permanecerá
            privado y pendiente de procesamiento.
          </FieldDescription>
          <FieldError id={`${id}-error`} errors={[errors.file]} />
        </Field>
      </fieldset>
      {!collections.length && (
        <p className="text-sm text-muted-foreground">
          Crea una colección para poder subir documentos.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button
        type="submit"
        disabled={isSubmitting || !isValid || !collections.length}
      >
        {isSubmitting ? "Subiendo…" : "Subir documento"}
      </Button>
    </form>
  )
}
