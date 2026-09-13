import { ShieldCheckIcon } from "lucide-react"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
} from "@workspace/ui/components/empty"
export function AccessPending({ admin }: { admin: boolean }) {
  return (
    <Empty className="min-h-72 border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ShieldCheckIcon />
        </EmptyMedia>
        <EmptyTitle>Acceso pendiente</EmptyTitle>
        <EmptyDescription>
          {admin
            ? "Tu cuenta está autenticada, pero no tiene acceso de personal de Agentonic."
            : "Tu cuenta está autenticada. Falta vincularla a un espacio activo."}{" "}
          Solicita la activación a tu administrador.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
