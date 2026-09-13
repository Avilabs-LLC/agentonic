import Link from "next/link"
import { Button } from "@workspace/ui/components/button"
export default function NotFound() {
  return (
    <main className="space-y-4 p-8">
      <h1 className="text-2xl font-semibold">Página no encontrada</h1>
      <Button render={<Link href="/" />} nativeButton={false}>
        Ir al inicio
      </Button>
    </main>
  )
}
