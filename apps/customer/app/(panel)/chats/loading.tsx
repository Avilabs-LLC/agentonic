import { Skeleton } from "@workspace/ui/components/skeleton"
export default function Loading() {
  return (
    <div
      className="mx-auto w-full max-w-6xl space-y-6"
      aria-label="Cargando conversaciones"
      aria-busy="true"
    >
      <div className="space-y-3">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
        <div className="space-y-6">
          <Skeleton className="h-64 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
        <Skeleton className="min-h-128 w-full rounded-xl" />
      </div>
    </div>
  )
}
