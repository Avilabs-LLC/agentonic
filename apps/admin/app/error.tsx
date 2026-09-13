"use client"
import { Button } from "@workspace/ui/components/button"
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="space-y-4 p-8">
      <h1 className="text-2xl font-semibold">No se pudo cargar esta página</h1>
      <p className="text-muted-foreground">
        Inténtalo de nuevo. Si el problema continúa, contacta con tu
        administrador.
      </p>
      <Button onClick={() => reset()}>Reintentar</Button>
    </main>
  )
}
