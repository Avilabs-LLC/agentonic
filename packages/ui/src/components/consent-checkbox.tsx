"use client"
import { Checkbox } from "@base-ui/react/checkbox"
import { CheckIcon } from "lucide-react"
export function ConsentCheckbox({
  checked,
  onCheckedChange,
  disabled = false,
  children,
}: {
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  children?: React.ReactNode
}) {
  return (
    <label className="flex items-start gap-3 text-sm">
      <Checkbox.Root
        name="consent"
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        required
        className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border border-input outline-none focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-primary data-checked:text-primary-foreground"
      >
        <Checkbox.Indicator>
          <CheckIcon className="size-3" />
        </Checkbox.Indicator>
      </Checkbox.Root>
      <span>
        {children ?? (
          <>
            Autorizo al equipo de Agentonic a revisar las instrucciones,
            habilidades y metadatos del conocimiento seleccionado de esta
            versión durante 7 días. Puedo retirar la propuesta para revocar ese
            acceso.
          </>
        )}
      </span>
    </label>
  )
}
