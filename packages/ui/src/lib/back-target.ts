// "Volver atrás" returns to the page the person came from inside the app
// (UI contract §7). The Navigation API lists only the same-origin entries next
// to the current one, so a page opened directly, in a new tab or after leaving
// the app has none, and the button keeps its link one route level up.
// TypeScript's DOM types do not declare window.navigation yet; this is the
// slice the button uses.
type HistoryEntry = { key: string; index: number; url: string | null }
export type HistoryNavigation = {
  currentEntry: HistoryEntry | null
  entries(): HistoryEntry[]
  traverseTo(key: string): {
    committed: Promise<unknown>
    finished: Promise<unknown>
  }
}

const pathOf = (url: string | null) => (url ? new URL(url).pathname : null)

/** The key of the nearest earlier entry on another page, or null. Entries of
 * the same page (its tabs and filters) are skipped. */
export function backTarget(navigation?: HistoryNavigation | null) {
  const current = navigation?.currentEntry
  const path = pathOf(current?.url ?? null)
  if (!navigation || !current || !path || current.index <= 0) return null
  return (
    navigation
      .entries()
      .slice(0, current.index)
      .reverse()
      .find((entry) => {
        const previous = pathOf(entry.url)
        return previous !== null && previous !== path
      })?.key ?? null
  )
}
