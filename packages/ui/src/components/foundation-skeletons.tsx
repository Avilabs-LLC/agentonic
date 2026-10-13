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
/** Metric tiles: label, value and detail (the agent page). */
export function MetricTilesSkeleton({
  count,
  className,
}: {
  count: number
  className: string
}) {
  return (
    <div className={`grid gap-4 sm:grid-cols-2 ${className}`}>
      {Array.from({ length: count }, (_, i) => (
        <Card key={i}>
          <CardHeader>
            <Skeleton className="h-3 w-32" />
          </CardHeader>
          <CardContent className="space-y-2">
            <Skeleton className="h-5 w-28 rounded-full" />
            <Skeleton className="h-3 w-40" />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
/** Server cards (Despliegues, Vencimientos): an icon and a name, then two
 * metrics side by side, each a label, value and detail. */
export function MetricGroupsSkeleton() {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {Array.from({ length: 2 }, (_, i) => (
        <Card key={i}>
          <CardHeader className="flex items-center gap-2">
            <Skeleton className="size-4 rounded-sm" />
            <Skeleton className="h-4 w-24" />
          </CardHeader>
          <CardContent className="grid divide-y sm:auto-cols-fr sm:grid-flow-col sm:divide-x sm:divide-y-0">
            {Array.from({ length: 2 }, (_, j) => (
              <div
                key={j}
                className="space-y-2 py-3 first:pt-0 last:pb-0 sm:px-4 sm:py-0 sm:first:pl-0 sm:last:pr-0"
              >
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-5 w-28 rounded-full" />
                <Skeleton className="h-3 w-36" />
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
/** A page header with one action at its right end (Equipo, Despliegues,
 * Vencimientos). */
export function PageHeaderWithActionSkeleton({ action }: { action: string }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <PageHeaderSkeleton />
      <Skeleton className={`h-8 ${action}`} />
    </div>
  )
}
// Vencimientos: the header with its Local (desarrollo) button, vm-agents-01's
// two cards and the ten-column deadlines table.
export function ExpirySkeleton() {
  return (
    <div aria-label="Cargando vencimientos" role="status" className="space-y-6">
      <PageHeaderWithActionSkeleton action="w-44" />
      <MetricGroupsSkeleton />
      <TableSkeleton columns={10} />
    </div>
  )
}
export function AccountSkeleton({
  authenticator = false,
}: {
  authenticator?: boolean
}) {
  return (
    <div aria-label="Cargando cuenta" role="status" className="space-y-6">
      <div className="space-y-3">
        <BackRowSkeleton />
        <RecordHeaderSkeleton />
      </div>
      <Card>
        <CardContent className="space-y-6 pt-6">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </CardContent>
      </Card>
      {authenticator && (
        <Card>
          <CardHeader className="space-y-2">
            <Skeleton className="h-6 w-56" />
            <Skeleton className="h-4 w-full" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-8 w-full" />
          </CardContent>
        </Card>
      )}
    </div>
  )
}
export function AdminAccountSkeleton() {
  return <AccountSkeleton authenticator />
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
/** A centered card with fields, for the signed-out account pages (architecture §54). */
export function AuthCardSkeleton({
  fields = 1,
  footer = false,
}: {
  fields?: number
  footer?: boolean
}) {
  return (
    <main
      role="status"
      aria-label="Cargando"
      className="flex min-h-svh items-center justify-center bg-muted/40 p-6"
    >
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-3">
          <Skeleton className="size-10" />
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-full" />
        </CardHeader>
        <CardContent className="space-y-6">
          {Array.from({ length: fields }, (_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-full" />
            </div>
          ))}
          <Skeleton className="h-10 w-full" />
        </CardContent>
        {footer && (
          <CardFooter>
            <Skeleton className="h-4 w-40" />
          </CardFooter>
        )}
      </Card>
    </main>
  )
}
/** Reset request and invitation: one field or message, and a footer link. */
export function AuthCardWithFooterSkeleton() {
  return <AuthCardSkeleton footer />
}
export function PasswordSkeleton() {
  return (
    <div aria-label="Cargando contraseña" role="status" className="space-y-6">
      <div className="space-y-3">
        <BackRowSkeleton />
        <RecordHeaderSkeleton />
      </div>
      <Card className="max-w-md">
        <CardContent className="space-y-6 pt-6">
          {[1, 2].map((i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-8 w-full" />
            </div>
          ))}
          <Skeleton className="h-8 w-40" />
        </CardContent>
      </Card>
    </div>
  )
}
export function MembersSkeleton() {
  return (
    <div aria-label="Cargando miembros" role="status" className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeaderSkeleton />
        <Skeleton className="h-8 w-36" />
      </div>
      <Skeleton className="h-7 w-48" />
      {[3, 5].map((columns) => (
        <Card key={columns}>
          <CardHeader>
            <Skeleton className="h-6 w-40" />
          </CardHeader>
          <CardContent>
            <TableSkeleton columns={columns} />
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
