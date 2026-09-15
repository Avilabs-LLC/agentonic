import { Skeleton } from "@workspace/ui/components/skeleton"
import {
  Card,
  CardContent,
  CardHeader,
  CardAction,
  CardFooter,
} from "@workspace/ui/components/card"
export function PageHeaderSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-9 w-56" />
      <Skeleton className="h-5 w-72 max-w-full" />
    </div>
  )
}
export function RecordHeaderSkeleton({
  indicator,
}: {
  indicator?: "status" | "metadata"
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <PageHeaderSkeleton />
      {indicator && (
        <Skeleton
          className={
            indicator === "status" ? "h-5 w-40 rounded-full" : "h-5 w-32"
          }
        />
      )}
    </div>
  )
}
export function BackRowSkeleton() {
  return <Skeleton className="h-7 w-28" />
}
export function StatCardsSkeleton({ count = 2 }: { count?: number }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {Array.from({ length: count }, (_, i) => (
        <Card key={i}>
          <CardHeader>
            <Skeleton className="h-5 w-36" />
          </CardHeader>
          <CardContent className="space-y-2">
            <Skeleton className="h-6 w-44" />
            <Skeleton className="h-4 w-full" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
export function FiltersCardSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-4 w-64 max-w-full" />
        <CardAction>
          <Skeleton className="h-6 w-20" />
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-8 w-full" />
        </div>
      </CardContent>
    </Card>
  )
}
export function TableSkeleton({ columns = 4 }: { columns?: number }) {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-80 max-w-full" />
      <div className="rounded-xl border p-3">
        {Array.from({ length: 4 }, (_, i) => (
          <div
            key={i}
            className="grid gap-4 py-3"
            style={{ gridTemplateColumns: `repeat(${columns},minmax(0,1fr))` }}
          >
            {Array.from({ length: columns }, (_, j) => (
              <Skeleton key={j} className="h-5 w-full" />
            ))}
          </div>
        ))}
      </div>
      <Skeleton className="ml-auto h-8 w-64 max-w-full" />
    </div>
  )
}
export function DashboardSkeleton({
  customer = false,
}: {
  customer?: boolean
}) {
  return (
    <div aria-label="Cargando" role="status" className="space-y-6">
      <PageHeaderSkeleton />
      {customer ? <TableSkeleton columns={4} /> : <StatCardsSkeleton />}
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-48" />
        </CardHeader>
        <CardContent className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
export function AccountSkeleton() {
  return (
    <div aria-label="Cargando cuenta" role="status" className="space-y-6">
      <div className="space-y-3">
        <BackRowSkeleton />
        <RecordHeaderSkeleton />
      </div>
      <Card>
        <CardContent className="space-y-6 pt-6">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
export function LoginSkeleton() {
  return (
    <main
      role="status"
      aria-label="Cargando acceso"
      className="flex min-h-svh items-center justify-center bg-muted/40 p-6"
    >
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-3">
          <Skeleton className="size-10" />
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-full" />
        </CardHeader>
        <CardContent className="space-y-6">
          {[1, 2].map((i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-full" />
            </div>
          ))}
          <Skeleton className="h-10 w-full" />
        </CardContent>
        <CardFooter>
          <Skeleton className="h-8 w-full" />
        </CardFooter>
      </Card>
    </main>
  )
}
