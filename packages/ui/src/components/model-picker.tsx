"use client"
import { useState, type ReactNode } from "react"
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ZapIcon,
} from "lucide-react"
import {
  DEFAULT_MODEL_CONFIGURATION,
  modelCatalog,
  modelConfigurationKey,
  reasoningLabels,
  type ModelConfiguration,
} from "@agentonic/contracts/models"
import { Button } from "@workspace/ui/components/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover"
import { Slider as SliderPrimitive } from "@base-ui/react/slider"
import { cn } from "cn"

const everyConfiguration: ModelConfiguration[] = modelCatalog.flatMap((m) =>
  (m.levels.length ? m.levels : [null]).map((reasoning) => ({
    model: m.id,
    reasoning,
  }))
)
const modelName = (id: string) =>
  modelCatalog.find((m) => m.id === id)?.name ?? id
const levelName = (reasoning: ModelConfiguration["reasoning"]) =>
  reasoning ? reasoningLabels[reasoning] : null

/**
 * The composer's model control, after the Codex composer: a pill with the
 * model and its reasoning level, opening on a level slider; the model's name
 * leads to the list of models. Only the given configurations can be chosen.
 */
export function ModelPicker({
  value,
  onChange,
  options = everyConfiguration,
  disabled = false,
  note,
}: {
  value: ModelConfiguration
  onChange: (value: ModelConfiguration) => void
  options?: ModelConfiguration[]
  disabled?: boolean
  /** Shown under the model list, for example why the list is short. */
  note?: ReactNode
}) {
  const [open, setOpen] = useState(false),
    [view, setView] = useState<"levels" | "models">("levels")
  const models = modelCatalog.filter((m) =>
    options.some((o) => o.model === m.id)
  )
  const profile = modelCatalog.find((m) => m.id === value.model)
  // Levels in the catalog's order, limited to the allowed configurations.
  const levels = (profile?.levels.length ? profile.levels : [null]).filter(
    (reasoning) =>
      options.some(
        (o) =>
          modelConfigurationKey(o) ===
          modelConfigurationKey({ model: value.model, reasoning })
      )
  )
  const index = Math.max(0, levels.indexOf(value.reasoning))
  function chooseModel(id: ModelConfiguration["model"]) {
    setView("levels")
    // Pressing the model already chosen changes nothing.
    if (id === value.model) return
    const allowed = options.filter((o) => o.model === id)
    const preferred = modelCatalog.find((m) => m.id === id)?.defaultLevel
    const choice = allowed.find((o) => o.reasoning === preferred) ?? allowed[0]
    if (choice) onChange(choice)
  }
  function chooseLevel(position: number) {
    const reasoning = levels[position]
    if (reasoning === undefined || reasoning === value.reasoning) return
    onChange({ model: value.model, reasoning })
  }
  const level = levelName(value.reasoning)
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setView("levels")
      }}
    >
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            disabled={disabled || !options.length}
            className="h-8 max-w-full min-w-0 gap-1.5 rounded-full px-3 font-normal data-popup-open:bg-muted"
            aria-label={`Modelo: ${modelName(value.model)}${level ? `, razonamiento ${level}` : ""}`}
          />
        }
      >
        <ZapIcon aria-hidden="true" />
        <span className="truncate">{modelName(value.model)}</span>
        {level && (
          <span className="truncate text-muted-foreground">{level}</span>
        )}
        <ChevronDownIcon
          aria-hidden="true"
          className="size-3.5 text-muted-foreground"
        />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={8}
        className="w-80 gap-0 rounded-2xl p-2"
      >
        {view === "levels" ? (
          <div className="space-y-3 p-1">
            {models.length > 1 ? (
              <button
                type="button"
                onClick={() => setView("models")}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                aria-label={`Cambiar modelo. Actual: ${modelName(value.model)}`}
              >
                <ZapIcon className="size-4 text-primary" aria-hidden="true" />
                <span className="flex-1 truncate text-center">
                  {modelName(value.model)}
                  {level && (
                    <span className="text-muted-foreground"> {level}</span>
                  )}
                </span>
                <ChevronRightIcon
                  className="size-4 text-muted-foreground"
                  aria-hidden="true"
                />
              </button>
            ) : (
              <p className="flex items-center gap-2 px-2 py-1.5">
                <ZapIcon className="size-4 text-primary" aria-hidden="true" />
                <span className="flex-1 truncate text-center">
                  {modelName(value.model)}
                  {level && (
                    <span className="text-muted-foreground"> {level}</span>
                  )}
                </span>
                <span className="size-4" aria-hidden="true" />
              </p>
            )}
            {levels.length > 1 ? (
              <LevelSlider
                count={levels.length}
                index={index}
                label={(position) =>
                  levelName(levels[position] ?? null) ?? "Sin razonamiento"
                }
                onChange={chooseLevel}
              />
            ) : (
              <p className="px-2 pb-1 text-center text-xs text-muted-foreground">
                {level
                  ? `Nivel de razonamiento disponible: ${level}.`
                  : "Este modelo no usa niveles de razonamiento."}
              </p>
            )}
            {models.length <= 1 && note && (
              <p className="px-2 pb-1 text-center text-xs text-muted-foreground">
                {note}
              </p>
            )}
          </div>
        ) : (
          <div>
            <p className="px-3 pt-1.5 pb-1 text-sm text-muted-foreground">
              Selecciona un modelo
            </p>
            <div role="radiogroup" aria-label="Modelos">
              {models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={m.id === value.model}
                  onClick={() => chooseModel(m.id)}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{m.name}</span>
                    {m.id === DEFAULT_MODEL_CONFIGURATION.model && (
                      <span className="block text-xs text-muted-foreground">
                        Predeterminado
                      </span>
                    )}
                  </span>
                  <CheckIcon
                    aria-hidden="true"
                    className={cn(
                      "size-4",
                      m.id === value.model ? "opacity-100" : "opacity-0"
                    )}
                  />
                </button>
              ))}
            </div>
            {note && (
              <p className="px-3 pt-2 pb-1.5 text-xs text-muted-foreground">
                {note}
              </p>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

// A Codex-style level slider: a thick track with a dot per level, a filled
// part up to the chosen level and a round thumb. Base UI's slider is used
// directly so the thumb can announce the level by name.
function LevelSlider({
  count,
  index,
  label,
  onChange,
}: {
  count: number
  index: number
  label: (position: number) => string
  onChange: (position: number) => void
}) {
  return (
    <SliderPrimitive.Root
      min={0}
      max={count - 1}
      step={1}
      value={index}
      thumbAlignment="edge"
      onValueChange={(next) =>
        onChange(Array.isArray(next) ? (next[0] ?? 0) : (next as number))
      }
      className="px-1 pb-1"
    >
      <SliderPrimitive.Control className="relative flex h-8 w-full touch-none items-center select-none">
        <SliderPrimitive.Track className="relative h-8 w-full overflow-hidden rounded-full bg-muted">
          <SliderPrimitive.Indicator className="h-full rounded-full bg-primary" />
          {Array.from({ length: count }, (_, position) => (
            <span
              key={position}
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full",
                position <= index
                  ? "bg-primary-foreground/60"
                  : "bg-foreground/25"
              )}
              // The thumb's centre stops half a thumb (0.875rem) from each end.
              style={{
                left: `calc(0.875rem + (100% - 1.75rem) * ${position / (count - 1)})`,
              }}
            />
          ))}
        </SliderPrimitive.Track>
        <SliderPrimitive.Thumb
          aria-label="Nivel de razonamiento"
          getAriaValueText={(_, value) => label(value)}
          className="size-7 rounded-full bg-white shadow-md ring-ring/50 outline-none focus-visible:ring-3"
        />
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}
