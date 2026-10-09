"use client"
import Link from "next/link"
import { ArrowLeftIcon } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import {
  backTarget,
  type HistoryNavigation,
} from "@workspace/ui/lib/back-target"

/** Returns to the page the person came from in the app, with its filters and
 * tab. `href`, one route level up, serves pages opened directly, in a new tab
 * or after leaving the app, and middle-clicks. */
export function BackRow({ href }: { href: string }) {
  function back(event: React.MouseEvent<HTMLAnchorElement>) {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return
    const navigation = (window as { navigation?: HistoryNavigation }).navigation
    const key = backTarget(navigation)
    if (!navigation || !key) return
    // Next's Link skips its own navigation once this is prevented.
    event.preventDefault()
    const { committed, finished } = navigation.traverseTo(key)
    // Another click can interrupt the traversal; that needs no fallback.
    committed.catch(() => {})
    finished.catch(() => {})
  }
  return (
    <Button
      render={<Link href={href} onClick={back} />}
      nativeButton={false}
      variant="ghost"
      className="-ml-2"
    >
      <ArrowLeftIcon />
      Volver atrás
    </Button>
  )
}
