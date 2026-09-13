import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@workspace/ui/components/card"
import { Button } from "@workspace/ui/components/button"
export function FiltersCard({
  children,
  onClear,
}: {
  children: React.ReactNode
  onClear: () => void
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Filtros</CardTitle>
        <Button variant="ghost" onClick={onClear}>
          Limpiar
        </Button>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {children}
      </CardContent>
    </Card>
  )
}
