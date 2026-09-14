"use client"

import { useId, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { Trash2Icon } from "lucide-react"
import type { FormResult } from "@agentonic/contracts/authoring"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@workspace/ui/components/tooltip"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@workspace/ui/components/alert-dialog"
import { notify } from "@workspace/ui/lib/toast"

export function CollectionDeleteDialog({
  collection,
  remove,
}: {
  collection: { id: string; name: string; documentCount: number }
  remove: (id: string, confirmationName: string) => Promise<FormResult>
}) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [name, setName] = useState("")
  const [requiresName, setRequiresName] = useState(false)
  const [error, setError] = useState("")
  const locked = useRef(false)
  const inputId = useId()
  const router = useRouter()
  const hasDocuments = collection.documentCount > 0 || requiresName
  const confirmed = !hasDocuments || name === collection.name

  function changeOpen(value: boolean) {
    if (locked.current) return
    setOpen(value)
    setName("")
    setRequiresName(false)
    setError("")
  }
  async function confirm() {
    if (locked.current || !confirmed) return
    locked.current = true
    setPending(true)
    setError("")
    try {
      const result = await remove(collection.id, name)
      if (!result.ok) {
        setRequiresName(
          result.requiresConfirmationName === true || requiresName
        )
        setError(result.message)
        router.refresh()
        return
      }
      notify.success(result.message)
      setOpen(false)
      router.refresh()
    } catch {
      setError("No se pudo eliminar la colección. Inténtalo de nuevo.")
    } finally {
      locked.current = false
      setPending(false)
    }
  }
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              aria-label={`Eliminar colección ${collection.name}`}
              disabled={pending}
              onClick={() => changeOpen(true)}
            />
          }
        >
          <Trash2Icon aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>Eliminar colección</TooltipContent>
      </Tooltip>
      <AlertDialog open={open} onOpenChange={changeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar esta colección?</AlertDialogTitle>
            <AlertDialogDescription className="break-words">
              {hasDocuments
                ? `Se eliminarán «${collection.name}» y todos sus documentos. Los agentes dejarán de acceder a este conocimiento y los archivos se borrarán en segundo plano.`
                : `Se eliminará la colección vacía «${collection.name}».`}{" "}
              Esta acción no se puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {hasDocuments && (
            <div className="space-y-2">
              <Label htmlFor={inputId}>Escribe el nombre de la colección</Label>
              <p className="text-sm font-medium break-words">
                {collection.name}
              </p>
              <Input
                id={inputId}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={120}
                disabled={pending}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending || !confirmed}
              onClick={(event) => {
                event.preventDefault()
                void confirm()
              }}
            >
              {pending ? "Eliminando…" : "Eliminar colección"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
