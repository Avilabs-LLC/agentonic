"use client"

import { useState } from "react"
import { EllipsisIcon, EyeIcon, Trash2Icon } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import { Badge } from "@workspace/ui/components/badge"
import {
  Item,
  ItemGroup,
  ItemContent,
  ItemActions,
  ItemDescription,
} from "@workspace/ui/components/item"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@workspace/ui/components/dropdown-menu"
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

export type AgentAsset = {
  id: string
  name: string
  description: string
  example?: boolean
}

/** Compact configuration preview; actions edit the local draft, never permissions. */
export function AgentAssetList({
  label,
  rows,
  empty,
  onView,
  onRemove,
  disabled = false,
}: {
  label: string
  rows: AgentAsset[]
  empty: string
  onView: (row: AgentAsset) => void
  onRemove: (row: AgentAsset) => void
  disabled?: boolean
}) {
  const [removing, setRemoving] = useState<AgentAsset | null>(null)
  return (
    <>
      <ItemGroup
        aria-label={label}
        className="max-h-80 gap-0 divide-y overflow-y-auto border-t"
      >
        {rows.map((row) => (
          <Item
            key={row.id}
            role="listitem"
            className="flex-nowrap gap-4 rounded-none border-0 px-0 py-5"
          >
            <ItemContent className="min-w-0 gap-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <p
                  className="min-w-0 truncate text-sm font-medium"
                  title={row.name}
                >
                  {row.name}
                </p>
                <Badge variant={row.example ? "orange" : "violet"}>
                  {row.example ? "Ejemplo" : "Borrador"}
                </Badge>
              </div>
              <ItemDescription className="text-sm break-words">
                {row.description}
              </ItemDescription>
            </ItemContent>
            <ItemActions className="shrink-0">
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={disabled}
                      aria-label={`Acciones de ${row.name}`}
                    />
                  }
                >
                  <EllipsisIcon />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  <DropdownMenuItem onClick={() => onView(row)}>
                    <EyeIcon />
                    Ver detalles
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setRemoving(row)}
                  >
                    <Trash2Icon />
                    {row.example ? "Quitar ejemplo" : "Eliminar habilidad"}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </ItemActions>
          </Item>
        ))}
        {!rows.length && (
          <Item role="listitem" className="rounded-none border-0 px-0 py-6">
            <ItemDescription className="text-sm">{empty}</ItemDescription>
          </Item>
        )}
      </ItemGroup>
      <AlertDialog
        open={!!removing}
        onOpenChange={(open) => {
          if (!open) setRemoving(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {removing?.example
                ? "¿Quitar este ejemplo?"
                : "¿Eliminar esta habilidad del borrador?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.name}.{" "}
              {removing?.example
                ? "Solo se oculta esta muestra de la interfaz. No se elimina ninguna herramienta ni conexión real."
                : "El cambio se aplicará cuando guardes el borrador. Las versiones ya enviadas no cambian."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              variant="destructive"
              disabled={disabled}
              onClick={() => {
                if (removing) onRemove(removing)
                setRemoving(null)
              }}
            >
              {removing?.example ? "Quitar ejemplo" : "Eliminar habilidad"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
