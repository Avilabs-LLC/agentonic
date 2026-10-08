"use client"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { cn } from "cn"

const ALL = "all"

/**
 * A filter that ticks several options, with "all" as a real option (UI
 * contract §4): it is the selection while nothing is chosen, choosing it clears
 * the rest, and choosing an option replaces it. Unchanged picks change nothing.
 */
export function MultiSelectFilter({
  id,
  label,
  allLabel,
  countLabel,
  options,
  selected,
  onChange,
  disabled = false,
  className,
}: {
  id?: string
  /** Accessible name when no visible label points at `id`. */
  label?: string
  allLabel: string
  countLabel: (count: number) => string
  options: { value: string; label: string }[]
  selected: string[]
  onChange: (selected: string[]) => void
  disabled?: boolean
  className?: string
}) {
  const items = [{ value: ALL, label: allLabel }, ...options]
  const shown = selected.length ? selected : [ALL]
  function change(next: string[]) {
    const ids =
      next.includes(ALL) && !shown.includes(ALL)
        ? []
        : next.filter((value) => value !== ALL)
    const same =
      ids.length === selected.length &&
      ids.every((value) => selected.includes(value))
    if (!same) onChange(ids)
  }
  return (
    <Select
      multiple
      items={items}
      value={shown}
      disabled={disabled}
      onValueChange={change}
    >
      <SelectTrigger
        id={id}
        aria-label={label}
        className={cn("w-full", className)}
      >
        <SelectValue>
          {selected.length === 0
            ? allLabel
            : selected.length === 1
              ? options.find((option) => option.value === selected[0])?.label
              : countLabel(selected.length)}
        </SelectValue>
      </SelectTrigger>
      {/* Options wider than the trigger widen the list instead of being
          clipped. */}
      <SelectContent className="w-auto max-w-(--available-width) min-w-(--anchor-width)">
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
