import type { ReactNode } from "react"
import { cn } from "cn"

// Framed object icons. Each tone belongs to one surface so no colour repeats:
// emerald for versions in Activación, yellow for the new version and sky for
// the current version in Configuración. Not a status signal (UI contract §9).
const tones = {
  emerald:
    "border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-400/25 dark:bg-emerald-400/15 dark:text-emerald-300",
  yellow:
    "border-yellow-200 bg-yellow-100 text-yellow-800 dark:border-yellow-400/25 dark:bg-yellow-400/15 dark:text-yellow-300",
  sky: "border-sky-200 bg-sky-100 text-sky-800 dark:border-sky-400/25 dark:bg-sky-400/15 dark:text-sky-300",
}

export function IconTile({
  tone,
  children,
}: {
  tone: keyof typeof tones
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-md border shadow-xs [&_svg]:size-5",
        tones[tone]
      )}
    >
      {children}
    </div>
  )
}
