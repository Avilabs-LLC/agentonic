"use client"
import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import type { FormResult } from "@agentonic/contracts/authoring"
import { notify } from "@workspace/ui/lib/toast"

/** Opens an open review from Revisiones or the agent page: `openReview`
 * records the staff access the review page needs and returns that page.
 * `pending` and `startTransition` cover every navigation the caller starts. */
export function useOpenReview(
  openReview: (workspaceId: string, submissionId: string) => Promise<FormResult>
) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [error, setError] = useState("")
  function open(workspaceId: string, submissionId: string) {
    if (pending) return
    setOpeningId(submissionId)
    setError("")
    startTransition(async () => {
      try {
        const result = await openReview(workspaceId, submissionId)
        if (!result.ok || !result.href) {
          setError(result.message)
          notify.destructive(result.message)
          return
        }
        notify.success(result.message)
        router.push(result.href)
      } catch {
        const message = "No se pudo abrir la revisión. Inténtalo de nuevo."
        setError(message)
        notify.destructive(message)
      } finally {
        setOpeningId(null)
      }
    })
  }
  return { open, pending, openingId, error, setError, startTransition }
}
