"use client"
import {
  FileTextIcon,
  LibraryBigIcon,
  ListChecksIcon,
  PlugIcon,
  WrenchIcon,
} from "lucide-react"
import { SYSTEM_PROMPT_MIN_CHARACTERS } from "@agentonic/contracts/authoring"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"

export type ResourceCountsValue = {
  promptCharacters: number
  skillsCount: number
  collectionsCount: number
  toolsCount: number
  connectionsCount: number
}

const resources = [
  { key: "skillsCount", label: "Habilidades", icon: ListChecksIcon },
  { key: "collectionsCount", label: "Colecciones", icon: LibraryBigIcon },
  {
    key: "toolsCount",
    label: "Herramientas",
    icon: WrenchIcon,
    upcoming: true,
  },
  {
    key: "connectionsCount",
    label: "Conexiones",
    icon: PlugIcon,
    upcoming: true,
  },
] as const

/**
 * The Recursos cell of both agent lists: the saved draft's instruction
 * characters, then skills, collections, tools and connections. Every count
 * sits in a fixed-width slot (five digits for characters, two for the rest),
 * so the icons line up from row to row whatever the numbers' length. The small
 * counts are rarely more than one digit, so their slots and gaps stay tight.
 */
export function ResourceCounts({ value }: { value: ResourceCountsValue }) {
  const ready = value.promptCharacters >= SYSTEM_PROMPT_MIN_CHARACTERS
  const items = [
    {
      key: "promptCharacters",
      icon: FileTextIcon,
      count: value.promptCharacters,
      description: `Instrucciones ${ready ? "listas" : "incompletas"}: ${value.promptCharacters} caracteres`,
      width: "min-w-[5ch]",
      // Keeps the wide characters count apart from the small ones.
      space: "mr-1",
    },
    ...resources.map(({ key, label, icon, ...resource }) => ({
      key,
      icon,
      count: value[key],
      description: `${label}: ${value[key]}${"upcoming" in resource ? " · Próximamente" : ""}`,
      width: "min-w-[2ch]",
      space: "",
    })),
  ]
  return (
    <div className="flex items-center gap-2">
      {items.map(({ key, icon: Icon, count, description, width, space }) => (
        <Tooltip key={key}>
          <TooltipTrigger
            render={<span tabIndex={0} />}
            aria-label={description}
            className={`${space} inline-flex items-center gap-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring`}
          >
            <Icon
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className={`${width} tabular-nums`} aria-hidden="true">
              {count}
            </span>
          </TooltipTrigger>
          <TooltipContent>{description}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}
