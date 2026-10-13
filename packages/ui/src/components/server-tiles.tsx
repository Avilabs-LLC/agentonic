"use client"
import type { ReactNode } from "react"
import { LaptopIcon } from "lucide-react"
import { environmentLabels } from "@agentonic/contracts/lifecycle"
import { statusDescriptor } from "@workspace/ui/lib/badge-status"
import { cn } from "@workspace/ui/lib/utils"
import { iconTones } from "@workspace/ui/components/status-badge"
import { Button } from "@workspace/ui/components/button"
import { CardEmptyState } from "@workspace/ui/components/card-empty-state"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@workspace/ui/components/dialog"

// Servers as metric tiles (Despliegues, Vencimientos; UI contract §9): the
// page shows vm-agents-01 in one row, and Local (desarrollo) opens in a dialog
// from the page header with the same tiles, so each fact keeps one rendering.

export type Environment = "local" | "azure_staging"
export const unregistered = {
  value: "Sin registrar",
  tone: "text-muted-foreground",
}
/** A registration as a tile's value: its label in its state's colour, never
 * a badge; a missing server reads "Sin registrar". */
export function registrationValue(state: string | undefined) {
  if (state === undefined) return unregistered
  const descriptor = statusDescriptor("registration", state)
  return { value: descriptor.label, tone: iconTones[descriptor.variant] }
}
/** One row of four tiles on the page; two per row in the Local dialog. */
export function ServerTilesGrid({
  compact,
  children,
}: {
  compact: boolean
  children: ReactNode
}) {
  return (
    <div
      className={cn("grid gap-4 sm:grid-cols-2", !compact && "xl:grid-cols-4")}
    >
      {children}
    </div>
  )
}
/** The header button and its dialog; an empty state when nothing local is
 * registered. */
export function LocalServersDialog({
  registered,
  description,
  children,
}: {
  registered: boolean
  description: string
  children: ReactNode
}) {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="outline" />}>
        <LaptopIcon aria-hidden="true" />
        {environmentLabels.local}
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{environmentLabels.local}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {registered ? (
          children
        ) : (
          <CardEmptyState title="Sin servidores registrados">
            Instala y registra un servidor local para probar agentes o evaluar
            versiones.
          </CardEmptyState>
        )}
      </DialogContent>
    </Dialog>
  )
}
