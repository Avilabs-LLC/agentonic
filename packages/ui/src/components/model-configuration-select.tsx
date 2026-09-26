"use client"
import {
  modelCatalog,
  modelConfigurationKey,
  modelConfigurationLabel,
  type ModelConfiguration,
} from "@agentonic/contracts/models"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
const configurations: ModelConfiguration[] = modelCatalog.flatMap((m) =>
  (m.levels.length ? m.levels : [null]).map((reasoning) => ({
    model: m.id,
    reasoning,
  }))
)
export function ModelConfigurationSelect({
  value,
  onChange,
  options = configurations,
  disabled = false,
}: {
  value: ModelConfiguration
  onChange: (value: ModelConfiguration) => void
  options?: ModelConfiguration[]
  disabled?: boolean
}) {
  return (
    <Select
      value={modelConfigurationKey(value)}
      onValueChange={(key) => {
        const choice = options.find((m) => modelConfigurationKey(m) === key)
        if (choice) onChange(choice)
      }}
      disabled={disabled || !options.length}
    >
      <SelectTrigger
        aria-label="Modelo y nivel de razonamiento"
        className="w-auto max-w-full"
      >
        <SelectValue>{modelConfigurationLabel(value)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((m) => (
          <SelectItem
            key={modelConfigurationKey(m)}
            value={modelConfigurationKey(m)}
          >
            {modelConfigurationLabel(m)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
