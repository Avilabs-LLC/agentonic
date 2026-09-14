import Link from "next/link"
import { Button } from "@workspace/ui/components/button"
export function WorkspacePicker({
  workspaces,
  selected,
  base,
}: {
  workspaces: { id: string; name: string }[]
  selected: string
  base: string
}) {
  return (
    <nav aria-label="Seleccionar espacio" className="flex flex-wrap gap-2">
      {workspaces.map((w) => (
        <Button
          key={w.id}
          render={<Link href={`${base}?workspace=${w.id}`} />}
          nativeButton={false}
          variant={w.id === selected ? "secondary" : "outline"}
          size="sm"
        >
          {w.name}
        </Button>
      ))}
    </nav>
  )
}
