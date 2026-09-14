import { Skeleton } from "@workspace/ui/components/skeleton"
export default function Loading() {
  return (
    <div
      className="mx-auto w-full max-w-4xl space-y-6"
      aria-busy="true"
      aria-label="Cargando prueba"
    >
      <Skeleton className="h-5 w-20" />
      <div className="space-y-3">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-5 w-96 max-w-full" />
      </div>
      <div className="space-y-5 rounded-lg border p-6">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-8 w-32" />
      </div>
      <div className="overflow-hidden rounded-lg border">
        <div className="flex items-center justify-between border-b px-6 py-4">
          <Skeleton className="h-5 w-44" />
          <Skeleton className="h-5 w-24" />
        </div>
        <div className="flex min-h-64 items-center justify-center p-6">
          <Skeleton className="h-5 w-64 max-w-full" />
        </div>
        <div className="space-y-3 border-t p-4 sm:p-6">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="ml-auto h-7 w-28" />
        </div>
      </div>
    </div>
  )
}
