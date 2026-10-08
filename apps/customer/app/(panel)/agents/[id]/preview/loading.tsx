import { Skeleton } from "@workspace/ui/components/skeleton"
export default function Loading() {
  return (
    <div
      className="mx-auto w-full max-w-4xl space-y-6"
      aria-busy="true"
      aria-label="Cargando prueba"
    >
      <Skeleton className="h-5 w-20" />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-3">
          <Skeleton className="h-8 w-64 max-w-full" />
          <Skeleton className="h-5 w-96 max-w-full" />
        </div>
        <Skeleton className="h-5 w-32" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4 sm:p-6">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-9 w-36" />
      </div>
      <div className="overflow-hidden rounded-lg border">
        <div className="flex min-h-64 items-center justify-center p-6">
          <Skeleton className="h-5 w-64 max-w-full" />
        </div>
        <div className="border-t p-4 sm:p-6">
          {/* Composer: text box, then attachments, model and send controls. */}
          <div className="relative z-1 space-y-3 rounded-3xl border p-3">
            <Skeleton className="h-8 w-full" />
            <div className="flex items-center justify-between gap-2">
              <Skeleton className="size-8 rounded-full" />
              <div className="flex items-center gap-1.5">
                <Skeleton className="h-8 w-40 rounded-full" />
                <Skeleton className="size-8 rounded-full" />
              </div>
            </div>
          </div>
          <div className="mx-4 -mt-4 rounded-b-2xl bg-muted/60 px-4 pt-6 pb-2.5">
            <Skeleton className="h-3 w-32" />
          </div>
        </div>
      </div>
    </div>
  )
}
