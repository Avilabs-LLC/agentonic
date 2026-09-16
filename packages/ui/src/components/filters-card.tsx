import { FilterXIcon } from "lucide-react"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardAction,
  CardContent,
} from "@workspace/ui/components/card"
import { Button } from "@workspace/ui/components/button"
export function FiltersCard({
  children,
  onClear,
  description = "Acota los registros de la tabla.",
  disabled = false,
}: {
  children: React.ReactNode
  onClear: () => void
  description?: string
  disabled?: boolean
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Filtros</CardTitle>
        <CardDescription>{description}</CardDescription>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            onClick={onClear}
            disabled={disabled}
          >
            <FilterXIcon />
            Limpiar
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {children}
      </CardContent>
    </Card>
  )
}
