"use client"
import { useEffect, useState } from "react"
import { formatCount, formatUtcParts } from "@agentonic/contracts/format"
import { memberRoleLabels } from "@agentonic/contracts/access"
import type { OperationsUser } from "@agentonic/contracts/operations"
import { statusDescriptor } from "@workspace/ui/lib/badge-status"
import { StatusIndicator } from "@workspace/ui/components/status-badge"
import { WorkspaceName } from "@workspace/ui/components/workspace-name"
import { Skeleton } from "@workspace/ui/components/skeleton"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from "@workspace/ui/components/item"

const plural = (n: number, one: string, many: string) =>
  `${formatCount(n)} ${n === 1 ? one : many}`

// Ver usuario in Revisiones: who sent the review and where they belong, read
// when the dialog opens. Metadata only.
export function MemberCardDialog({
  userId,
  name,
  email,
  loadMember,
  onClose,
}: {
  userId: string
  name: string
  email: string | null
  loadMember: (userId: string) => Promise<OperationsUser | null>
  onClose: () => void
}) {
  // undefined while loading, null when the read failed.
  const [card, setCard] = useState<OperationsUser | null | undefined>()
  useEffect(() => {
    let current = true
    loadMember(userId)
      .then((value) => current && setCard(value))
      .catch(() => current && setCard(null))
    return () => {
      current = false
    }
  }, [userId, loadMember])
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{card?.name ?? name}</DialogTitle>
          <DialogDescription>
            {(card ? card.email : email) ?? "Correo no disponible"}
          </DialogDescription>
        </DialogHeader>
        {card === undefined ? (
          <div
            role="status"
            aria-label="Cargando usuario"
            className="space-y-4"
          >
            {[1, 2].map((i) => (
              <div key={i} className="flex items-center justify-between gap-4">
                <div className="space-y-1.5">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-4 w-56" />
                </div>
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
            ))}
          </div>
        ) : card === null ? (
          <p role="alert" className="text-sm text-destructive">
            No se pudo cargar el usuario. Inténtalo de nuevo.
          </p>
        ) : (
          <div className="space-y-4">
            <section aria-labelledby="member-workspaces" className="space-y-1">
              <h3
                id="member-workspaces"
                className="text-xs font-medium text-muted-foreground"
              >
                Espacios de trabajo
              </h3>
              {card.memberships.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No pertenece a ningún espacio de trabajo.
                </p>
              ) : (
                <ItemGroup>
                  {card.memberships.map((m, index) => (
                    <div key={m.workspaceId}>
                      {index > 0 && <ItemSeparator className="my-0" />}
                      <Item size="sm" className="px-0">
                        <ItemContent>
                          <ItemTitle>
                            <WorkspaceName name={m.workspaceName} />
                          </ItemTitle>
                          <ItemDescription className="line-clamp-none">
                            <span className="block">
                              {memberRoleLabels[m.role] ?? m.role} · Desde el{" "}
                              {formatUtcParts(m.joinedAt).date}
                            </span>
                            <span className="block tabular-nums">
                              {plural(m.agents, "agente", "agentes")} ·{" "}
                              {plural(m.reviews, "revisión", "revisiones")}
                            </span>
                          </ItemDescription>
                        </ItemContent>
                        <ItemActions>
                          <StatusIndicator
                            appearance="badge"
                            state={statusDescriptor("member", m.status)}
                          />
                        </ItemActions>
                      </Item>
                    </div>
                  ))}
                </ItemGroup>
              )}
            </section>
            <p className="text-sm text-muted-foreground">
              En Agentonic desde el {formatUtcParts(card.createdAt).date}.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
