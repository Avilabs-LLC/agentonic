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
import { cn } from "cn"
const configurations: ModelConfiguration[] = modelCatalog.flatMap((m) =>
  (m.levels.length ? m.levels : [null]).map((reasoning) => ({
    model: m.id,
    reasoning,
  }))
)
export function ModelConfigurationSelect({
  id,
  className,
  value,
  onChange,
  options = configurations,
  disabled = false,
}: {
  // With an id, a visible <label htmlFor> names the trigger instead.
  id?: string
  className?: string
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
        id={id}
        aria-label={id ? undefined : "Modelo y nivel de razonamiento"}
        className={cn("max-w-full", className)}
      >
        {/* Every label is stacked invisibly in one grid cell, so the trigger
            and its popup are as wide as the longest option, not the current one. */}
        <span className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)] overflow-hidden text-left">
          {options.map((m) => (
            <span
              key={modelConfigurationKey(m)}
              aria-hidden="true"
              className="invisible col-start-1 row-start-1"
            >
              {modelConfigurationLabel(m)}
            </span>
          ))}
          <SelectValue className="col-start-1 row-start-1 block truncate">
            {modelConfigurationLabel(value)}
          </SelectValue>
        </span>
      </SelectTrigger>
      <SelectContent className="w-auto max-w-(--available-width) min-w-(--anchor-width)">
        {options.map((m) => (
          <SelectItem
            key={modelConfigurationKey(m)}
            value={modelConfigurationKey(m)}
            className="pr-8"
          >
            {modelConfigurationLabel(m)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
